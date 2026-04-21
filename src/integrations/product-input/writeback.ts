import type { WebClient } from '@slack/web-api';

import { logger } from '../../logger.js';
import {
  deleteExpiredPiSessions,
  deletePiPrState,
  getAllPiPrState,
  getAnswersForPr,
  getPiPrState,
  getQuestionsForPr,
  getTiebreak,
  getUnresolvedPrs,
  insertAnswer,
  insertTiebreak,
  replaceQuestionsForPr,
  upsertPiPrState,
  type PiAnswerRow,
  type PiQuestionRow,
} from './db.js';
import {
  fetchPIsForPR,
  getPr,
  listIssueComments,
  listPendingPrs,
  postIssueComment,
  swapLabels,
  type GithubClient,
} from './github.js';
import { shortRfcName } from './parser.js';
import {
  buildPrNotificationBlocks,
  buildTiebreakAnnouncement,
  postSlackMessage,
} from './slack-ui.js';
import {
  GITHUB_REPO,
  SLACK_PI_CHANNEL,
  TEAM,
  githubLoginForSlackUser,
} from './team.js';

const LABEL_REQUIRED = 'product-input-required';
const LABEL_PENDING = 'product-input-pending';
const LABEL_RESOLVED = 'product-input-resolved';
const SLA_48H_MS = 48 * 3600 * 1000;
const SLA_72H_MS = 72 * 3600 * 1000;

export interface WritebackDeps {
  slack: WebClient;
  github: GithubClient;
}

// --- Scan: find required PRs, post notification, swap label ---

export async function runScan(deps: WritebackDeps): Promise<void> {
  const pendingPrs = await listPendingPrs(deps.github, LABEL_REQUIRED);
  for (const pr of pendingPrs) {
    try {
      // search/issues omits PR body for PR results — fetch the full PR for a
      // reliable summary. Cheap enough at a 15-min cadence.
      const full = await getPr(deps.github, pr.number);
      await notifyPr(
        deps,
        pr.number,
        pr.title,
        pr.html_url,
        full?.body ?? pr.body ?? null,
      );
    } catch (err) {
      logger.error({ err, prNumber: pr.number }, 'notifyPr failed');
    }
  }

  // Refresh pi_questions for PRs still in-flight so mid-flight RFC edits
  // are reflected in the writeback loop's next pass.
  const inflight = getUnresolvedPrs();
  for (const row of inflight) {
    if (!row.notified_at) continue;
    try {
      const pis = await fetchPIsForPR(deps.github, row.pr_number);
      if (pis) replaceQuestionsForPr(row.pr_number, pis);
    } catch (err) {
      logger.warn(
        { err, prNumber: row.pr_number },
        'Refresh pi_questions failed',
      );
    }
  }
}

async function notifyPr(
  deps: WritebackDeps,
  prNumber: number,
  prTitle: string,
  prUrl: string,
  prBody: string | null,
): Promise<string | null> {
  const existing = getPiPrState(prNumber);
  if (existing?.notified_at) return existing.thread_ts;

  const pis = await fetchPIsForPR(deps.github, prNumber);
  if (!pis || pis.length === 0) {
    logger.warn({ prNumber }, 'Skipping PR: no PIs found');
    return null;
  }

  const { blocks, text } = buildPrNotificationBlocks({
    prNumber,
    prTitle,
    prUrl,
    prBody,
    pis,
  });

  const ts = await postSlackMessage(deps.slack, {
    channel: SLACK_PI_CHANNEL,
    text,
    blocks,
  });
  if (!ts) return null;

  replaceQuestionsForPr(prNumber, pis);
  upsertPiPrState(prNumber, { thread_ts: ts, notified_at: Date.now() });

  try {
    await swapLabels(deps.github, prNumber, LABEL_REQUIRED, LABEL_PENDING);
  } catch (err) {
    logger.error(
      { err, prNumber },
      'Label swap failed; notification stays, manual cleanup may be needed',
    );
  }

  logger.info({ prNumber, ts }, 'Posted PI notification');
  return ts;
}

// On-demand scan for /pi-answer when no notification exists yet.
export async function ensureScanForPr(
  deps: WritebackDeps,
  prNumber: number,
): Promise<string | null> {
  const existing = getPiPrState(prNumber);
  if (existing?.thread_ts) return existing.thread_ts;

  const pr = await getPr(deps.github, prNumber);
  if (!pr) return null;
  return notifyPr(deps, prNumber, pr.title, pr.html_url, pr.body ?? null);
}

// --- Writeback: aggregate votes, post tie-breaks, resolve PRs ---

export async function runWriteback(deps: WritebackDeps): Promise<void> {
  const unresolved = getUnresolvedPrs();
  for (const row of unresolved) {
    try {
      await processPr(deps, row.pr_number);
    } catch (err) {
      logger.error({ err, prNumber: row.pr_number }, 'processPr failed');
    }
  }

  // Cleanup: if a PR is no longer open (closed/merged), drop state.
  const allState = getAllPiPrState();
  for (const row of allState) {
    if (row.resolved_at) continue;
    const pr = await getPr(deps.github, row.pr_number);
    if (pr && pr.state === 'closed') {
      logger.info(
        { prNumber: row.pr_number },
        'PR is closed/merged — cleaning up PI state',
      );
      deletePiPrState(row.pr_number);
    }
  }

  deleteExpiredPiSessions();
}

async function processPr(deps: WritebackDeps, prNumber: number): Promise<void> {
  const state = getPiPrState(prNumber);
  if (!state || !state.notified_at || state.resolved_at) return;

  const questions = getQuestionsForPr(prNumber);
  const answers = getAnswersForPr(prNumber);
  const ageMs = Date.now() - state.notified_at;

  // SLA: 48h warning
  if (ageMs >= SLA_48H_MS && ageMs < SLA_72H_MS && !state.sla_48h_warned_at) {
    await postSlackMessage(deps.slack, {
      channel: SLACK_PI_CHANNEL,
      thread_ts: state.thread_ts || undefined,
      text: `<@U0ANLGKAD96> <@U0AMVRJLVE0> — 24h left before eng recommendations carry automatically for PR #${prNumber}.`,
    });
    upsertPiPrState(prNumber, { sla_48h_warned_at: Date.now() });
  }

  // Per-PI resolution analysis
  const answersByPi = groupBy(answers, (a) => a.pi_key);

  // 72h default: fill in eng-rec defaults for non-blocking unanswered PIs
  if (ageMs >= SLA_72H_MS) {
    for (const q of questions) {
      const theseAnswers = answersByPi.get(q.pi_key) || [];
      if (theseAnswers.length > 0) continue;
      if (q.blocking === 1) continue; // blocking stays unresolved → sync request below
      insertAnswer({
        pr_number: prNumber,
        pi_key: q.pi_key,
        answered_by: 'system:defaulted',
        decision: 'defaulted',
        answer_text: q.eng_rec,
        reasoning: null,
        github_login: null,
        answered_at: Date.now(),
      });
    }

    // Any blocking PIs unanswered → request a sync (once)
    const stillBlockingUnanswered = questions.some((q) => {
      if (q.blocking !== 1) return false;
      const theseAnswers = (
        groupBy(getAnswersForPr(prNumber), (a) => a.pi_key).get(q.pi_key) || []
      ).filter((a) => !a.answered_by.startsWith('tiebreak:'));
      return theseAnswers.length === 0;
    });
    if (stillBlockingUnanswered && !state.blocking_sync_requested_at) {
      await postSlackMessage(deps.slack, {
        channel: SLACK_PI_CHANNEL,
        thread_ts: state.thread_ts || undefined,
        text: `<@U0ANLGKAD96> <@U0AMVRJLVE0> — PR #${prNumber} has blocking PIs past 72h with no answers. Please sync.`,
      });
      upsertPiPrState(prNumber, { blocking_sync_requested_at: Date.now() });
    }
  }

  // Re-read answers (in case defaults just ran)
  const freshAnswers = getAnswersForPr(prNumber);
  const freshByPi = groupBy(freshAnswers, (a) => a.pi_key);

  // Detect ties, post announcements
  for (const q of questions) {
    const votes = freshByPi.get(q.pi_key) || [];
    if (votes.length < 2) continue;
    const existingTb = getTiebreak(prNumber, q.pi_key);
    if (existingTb) continue; // already announced
    if (hasTiebreakRow(votes)) continue; // already resolved via tiebreak row
    if (votesAgree(votes)) continue;

    const { blocks, text } = buildTiebreakAnnouncement({
      prNumber,
      prUrl: `https://github.com/${GITHUB_REPO}/pull/${prNumber}`,
      question: q,
      votes,
    });
    const ts = await postSlackMessage(deps.slack, {
      channel: SLACK_PI_CHANNEL,
      text,
      blocks,
    });
    if (ts) {
      insertTiebreak({
        pr_number: prNumber,
        pi_key: q.pi_key,
        announcement_ts: ts,
        detected_at: Date.now(),
        resolved_at: null,
      });
    }
  }

  // Determine final state: every question resolved?
  const finalByPi = groupBy(getAnswersForPr(prNumber), (a) => a.pi_key);
  const unresolvedPis: PiQuestionRow[] = [];
  for (const q of questions) {
    const votes = finalByPi.get(q.pi_key) || [];
    if (votes.length === 0) {
      unresolvedPis.push(q);
      continue;
    }
    if (hasTiebreakRow(votes)) continue; // tiebreak is authoritative
    if (!votesAgree(votes)) {
      unresolvedPis.push(q); // tie, not yet broken
      continue;
    }
    // Agreement: if decision is 'discuss' and no newer non-discuss vote exists, stay unresolved
    const finalDecision = effectiveDecision(votes);
    if (finalDecision === 'discuss') unresolvedPis.push(q);
  }

  if (unresolvedPis.length > 0) return;

  // All PIs resolved — post the PR comment, swap labels.
  const comment = renderResolvedComment(prNumber, questions, finalByPi);

  // Dedup: skip if an identical "## Product Input resolved" comment already exists.
  const existingComments = await listIssueComments(deps.github, prNumber);
  if (
    existingComments.some((c) =>
      c.body.trim().startsWith('## Product Input resolved'),
    )
  ) {
    logger.info({ prNumber }, 'Resolved comment already on PR, marking state');
    upsertPiPrState(prNumber, { resolved_at: Date.now() });
    return;
  }

  const posted = await postIssueComment(deps.github, prNumber, comment);
  if (!posted) return;

  try {
    await swapLabels(deps.github, prNumber, LABEL_PENDING, LABEL_RESOLVED);
  } catch (err) {
    logger.warn(
      { err, prNumber },
      'Label swap to resolved failed; comment is posted',
    );
  }
  upsertPiPrState(prNumber, { resolved_at: Date.now() });
  logger.info({ prNumber }, 'PR resolved and written back');
}

// --- Helpers ---

function groupBy<T, K>(items: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const list = m.get(k) || [];
    list.push(item);
    m.set(k, list);
  }
  return m;
}

function hasTiebreakRow(votes: PiAnswerRow[]): boolean {
  return votes.some((v) => v.answered_by.startsWith('tiebreak:'));
}

function votesAgree(votes: PiAnswerRow[]): boolean {
  const nonTie = votes.filter((v) => !v.answered_by.startsWith('tiebreak:'));
  if (nonTie.length === 0) return true;
  const decisions = new Set(nonTie.map((v) => v.decision));
  if (decisions.size > 1) return false;
  // Override votes must share the same reasoning text to count as agreement.
  if ([...decisions][0] === 'override') {
    const reasonings = new Set(nonTie.map((v) => (v.reasoning || '').trim()));
    return reasonings.size === 1;
  }
  return true;
}

function effectiveDecision(votes: PiAnswerRow[]): string {
  // Prefer tiebreak if present, else the (agreed) decision of the others.
  const tb = votes.find((v) => v.answered_by.startsWith('tiebreak:'));
  if (tb) return tb.decision;
  const defaulted = votes.find((v) => v.answered_by === 'system:defaulted');
  if (defaulted) return defaulted.decision;
  return votes[0]?.decision || 'unknown';
}

function renderResolvedComment(
  prNumber: number,
  questions: PiQuestionRow[],
  answersByPi: Map<string, PiAnswerRow[]>,
): string {
  const total = questions.length;
  const header = `## Product Input resolved — ${total}/${total}\n\n`;
  const tableHeader = `| PI | RFC | Decision | Decided by | How | Reasoning |\n|---|---|---|---|---|---|\n`;

  const rows = questions.map((q) => {
    const votes = answersByPi.get(q.pi_key) || [];
    const rfc = shortRfcName(q.rfc_slug);
    const tb = votes.find((v) => v.answered_by.startsWith('tiebreak:'));
    const defaulted = votes.find((v) => v.answered_by === 'system:defaulted');
    const primary =
      tb ||
      defaulted ||
      votes.filter((v) => !v.answered_by.startsWith('tiebreak:'))[0];
    if (!primary) {
      return `| ${q.pi_id} | ${rfc} | — | — | (unresolved) | — |`;
    }

    const how = tb
      ? 'Tie-break'
      : defaulted
        ? 'Defaulted'
        : primary.decision === 'accept'
          ? 'Accepted eng rec'
          : primary.decision === 'override'
            ? 'Override'
            : 'Needs discussion';

    const decidedBy = tb
      ? githubAt(tb.github_login) ||
        `@${tb.answered_by.replace('tiebreak:', '')}`
      : defaulted
        ? '—'
        : githubAt(primary.github_login) ||
          TEAM[primary.answered_by]?.displayName ||
          primary.answered_by;

    const decision =
      primary.decision === 'accept'
        ? escapePipe(q.eng_rec)
        : primary.decision === 'override' || tb?.decision === 'override'
          ? escapePipe(primary.answer_text)
          : primary.decision === 'defaulted'
            ? escapePipe(q.eng_rec)
            : escapePipe(primary.answer_text);

    const reasoning =
      primary.decision === 'override' && primary.reasoning
        ? escapePipe(primary.reasoning)
        : defaulted
          ? 'No response within 72h'
          : '—';

    return `| ${q.pi_id} | ${rfc} | ${decision} | ${decidedBy} | ${how} | ${reasoning} |`;
  });

  const voteTrail = buildVoteTrail(questions, answersByPi);
  return `${header}${tableHeader}${rows.join('\n')}${voteTrail}`;
}

function buildVoteTrail(
  questions: PiQuestionRow[],
  answersByPi: Map<string, PiAnswerRow[]>,
): string {
  const lines: string[] = [];
  let hasTrail = false;
  for (const q of questions) {
    const votes = (answersByPi.get(q.pi_key) || []).filter(
      (v) => v.answered_by !== 'system:defaulted',
    );
    if (votes.length < 2) continue;
    hasTrail = true;
    const voters = votes.map((v) => {
      const who = v.answered_by.startsWith('tiebreak:')
        ? `${githubAt(v.github_login) || v.answered_by.replace('tiebreak:', '')} (tie-break)`
        : githubAt(v.github_login) || v.answered_by;
      return `${who}: ${v.decision}${v.reasoning ? ` — ${escapePipe(v.reasoning)}` : ''}`;
    });
    lines.push(`- **${q.pi_id}**: ${voters.join('; ')}`);
  }
  if (!hasTrail) return '';
  return `\n\n<details><summary>Vote trail</summary>\n\n${lines.join('\n')}\n</details>`;
}

function githubAt(login: string | null): string | null {
  if (!login) return null;
  return `@${login}`;
}

function escapePipe(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Unused export guard — keeps githubLoginForSlackUser importable if needed later.
void githubLoginForSlackUser;
