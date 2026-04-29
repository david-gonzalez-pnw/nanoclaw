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
import { runCommitPiDecisions } from './finalize-runner.js';
import { shortRfcName } from './parser.js';
import {
  buildPrNotificationBlocks,
  buildResolutionAnnouncement,
  buildTiebreakAnnouncement,
  postSlackMessage,
} from './slack-ui.js';
import {
  displayNameFor,
  loadPiConfig,
  renderSlaPingMentions,
} from './config.js';
import { githubLoginForSlackUser } from './team.js';

// Label names + Slack channel + GitHub repo are pulled from config so the
// integration can target any repo+channel without code edits. Helper aliases
// keep the call-sites readable.
const labels = () => {
  const c = loadPiConfig();
  return {
    required: c.labelRequired,
    pending: c.labelPending,
    resolved: c.labelResolved,
  };
};
const slackChannel = () => loadPiConfig().slackChannel;
const githubRepo = () => loadPiConfig().githubRepo;
const SLA_48H_MS = 48 * 3600 * 1000;
const SLA_72H_MS = 72 * 3600 * 1000;

export interface WritebackDeps {
  slack: WebClient;
  github: GithubClient;
}

// --- Scan: find required PRs, post notification, swap label ---

export async function runScan(deps: WritebackDeps): Promise<void> {
  const pendingPrs = await listPendingPrs(deps.github, labels().required);
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
    channel: slackChannel(),
    text,
    blocks,
  });
  if (!ts) return null;

  replaceQuestionsForPr(prNumber, pis);
  upsertPiPrState(prNumber, { thread_ts: ts, notified_at: Date.now() });

  try {
    await swapLabels(
      deps.github,
      prNumber,
      labels().required,
      labels().pending,
    );
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
  if (!state || !state.notified_at) return;

  // Post-resolution catch-up: a PR can be GitHub-resolved (comment posted +
  // label swapped + resolved_at set) but still owe a Slack announcement
  // and/or an RFC-files commit. Each follow-up step is idempotent and
  // advances state by one phase per tick.
  if (state.resolved_at && !state.slack_announced_at) {
    await announcePostResolution(deps, state);
    return;
  }
  if (state.resolved_at && !state.rfc_committed_at) {
    if (isCommitDecisionsEnabled()) {
      await commitDecisionsToRfc(deps, state);
    }
    return;
  }
  if (state.resolved_at) return; // fully closed

  const questions = getQuestionsForPr(prNumber);
  const answers = getAnswersForPr(prNumber);
  const ageMs = Date.now() - state.notified_at;

  // SLA: 48h warning
  if (ageMs >= SLA_48H_MS && ageMs < SLA_72H_MS && !state.sla_48h_warned_at) {
    await postSlackMessage(deps.slack, {
      channel: slackChannel(),
      thread_ts: state.thread_ts || undefined,
      text: `${renderSlaPingMentions(loadPiConfig())} — 24h left before eng recommendations carry automatically for PR #${prNumber}.`,
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
        channel: slackChannel(),
        thread_ts: state.thread_ts || undefined,
        text: `${renderSlaPingMentions(loadPiConfig())} — PR #${prNumber} has blocking PIs past 72h with no answers. Please sync.`,
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
      prUrl: `https://github.com/${githubRepo()}/pull/${prNumber}`,
      question: q,
      votes,
    });
    const ts = await postSlackMessage(deps.slack, {
      channel: slackChannel(),
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

  // All PIs resolved — post the PR comment, swap labels, then announce in Slack.
  const comment = renderResolvedComment(prNumber, questions, finalByPi);

  // Dedup: skip the GH post if an existing "## Product Input resolved" comment
  // is already there (rare but defensive). Mark resolved so the Slack-announce
  // branch picks up on the next tick using the existing comment URL.
  const existingComments = await listIssueComments(deps.github, prNumber);
  const existingResolved = existingComments.find((c) =>
    c.body.trim().startsWith('## Product Input resolved'),
  );
  if (existingResolved) {
    logger.info({ prNumber }, 'Resolved comment already on PR, marking state');
    upsertPiPrState(prNumber, { resolved_at: Date.now() });
    return;
  }

  const posted = await postIssueComment(deps.github, prNumber, comment);
  if (!posted.ok) return;

  try {
    await swapLabels(
      deps.github,
      prNumber,
      labels().pending,
      labels().resolved,
    );
  } catch (err) {
    logger.warn(
      { err, prNumber },
      'Label swap to resolved failed; comment is posted',
    );
  }
  upsertPiPrState(prNumber, { resolved_at: Date.now() });
  logger.info(
    { prNumber, commentUrl: posted.html_url },
    'PR resolved and written back',
  );

  // Immediately try the Slack announcement — same tick, fresh URL in hand.
  // Failures aren't fatal; the post-resolution catch-up branch will retry.
  const refreshed = getPiPrState(prNumber);
  if (refreshed) {
    await announcePostResolution(deps, refreshed, posted.html_url);
  }
  // Phase 2: lock decisions into the RFC files. Runs in a separate
  // container; failures fall through to the catch-up branch on the next
  // tick rather than rolling back the resolved state. Gated by
  // PI_COMMIT_DECISIONS so the skill stays opt-in until the user
  // explicitly enables it.
  if (isCommitDecisionsEnabled()) {
    const refreshed2 = getPiPrState(prNumber);
    if (refreshed2 && refreshed2.slack_announced_at) {
      await commitDecisionsToRfc(deps, refreshed2);
    }
  }
}

function isCommitDecisionsEnabled(): boolean {
  return loadPiConfig().commitDecisionsEnabled;
}

/**
 * Post the closing announcement to the original PR notification thread.
 * Idempotent: marks `slack_announced_at` only on success. Re-fetches the
 * comment URL from GitHub when one isn't passed in (catch-up path for PRs
 * resolved before this code shipped).
 */
async function announcePostResolution(
  deps: WritebackDeps,
  state: import('./db.js').PiPrStateRow,
  knownCommentUrl?: string,
): Promise<void> {
  const prNumber = state.pr_number;
  const prUrl = `https://github.com/${githubRepo()}/pull/${prNumber}`;

  let commentUrl: string | null = knownCommentUrl ?? null;
  if (!commentUrl) {
    const comments = await listIssueComments(deps.github, prNumber);
    const ours = comments
      .filter((c) => c.body.trim().startsWith('## Product Input resolved'))
      .pop(); // most-recent if there are somehow multiple
    commentUrl = ours?.html_url ?? null;
    if (!commentUrl) {
      logger.warn(
        { prNumber },
        'Could not find resolution comment on GitHub for Slack announce; falling back to PR url',
      );
    }
  }

  const summary = summarizeAnswers(getAnswersForPr(prNumber));
  const ageHours = state.notified_at
    ? (Date.now() - state.notified_at) / 3600 / 1000
    : 0;

  const announcement = buildResolutionAnnouncement({
    prNumber,
    prUrl,
    commentUrl,
    summary,
    ageHours,
  });

  const ts = await postSlackMessage(deps.slack, {
    channel: slackChannel(),
    thread_ts: state.thread_ts || undefined,
    text: announcement.text,
    blocks: announcement.blocks,
  });
  if (!ts) {
    logger.warn(
      { prNumber },
      'Slack resolution announcement failed; will retry on next writeback tick',
    );
    return;
  }
  upsertPiPrState(prNumber, { slack_announced_at: Date.now() });
  logger.info(
    { prNumber, slackTs: ts },
    'Posted PI resolution announcement to Slack',
  );
}

/**
 * Phase 2: spawn a one-shot container to lock decisions into the RFC files
 * via the `commit-pi-decisions` skill. Idempotent — sets `rfc_committed_at`
 * (and `rfc_commit_sha`) on success; failures leave them null so the
 * writeback loop retries on the next tick.
 *
 * On a merge-conflict or push-rejected outcome, posts a fallback message
 * to the original PR notification thread tagging the author so they can
 * apply the decisions manually.
 */
async function commitDecisionsToRfc(
  deps: WritebackDeps,
  state: import('./db.js').PiPrStateRow,
): Promise<void> {
  const prNumber = state.pr_number;
  // Find the comment URL: re-use what's on GH (we may have lost it after
  // a process restart — the announcement branch already does this lookup
  // pattern so we mirror it).
  let commentUrl: string | null = null;
  try {
    const comments = await listIssueComments(deps.github, prNumber);
    const ours = comments
      .filter((c) => c.body.trim().startsWith('## Product Input resolved'))
      .pop();
    commentUrl = ours?.html_url ?? null;
  } catch {
    /* ignore — payload tolerates a null commentUrl */
  }

  const result = await runCommitPiDecisions({
    github: deps.github,
    prNumber,
    commentUrl,
  });

  if (result.ok) {
    upsertPiPrState(prNumber, {
      rfc_committed_at: Date.now(),
      rfc_commit_sha: result.sha ?? null,
    });
    logger.info(
      {
        prNumber,
        sha: result.sha,
        applied: result.applied,
        skipped: result.skipped,
        reason: result.reason,
      },
      'Locked PI decisions into RFC files',
    );
    return;
  }

  logger.warn(
    { prNumber, reason: result.reason, details: result.details },
    'Failed to commit PI decisions to RFC files; will retry next tick',
  );

  // Surface conflict/push-rejection cases to the PR notification thread.
  if (
    state.thread_ts &&
    (result.reason === 'merge-conflict' || result.reason === 'push-rejected')
  ) {
    const detail = result.details
      ? `\n\`\`\`\n${result.details.slice(0, 1500)}\n\`\`\``
      : '';
    await postSlackMessage(deps.slack, {
      channel: slackChannel(),
      thread_ts: state.thread_ts,
      text: `⚠️ Couldn't auto-commit Product Input decisions for PR #${prNumber} (${result.reason}). Author: please apply the decision blocks manually from the resolved comment.${detail}`,
    });
  }
}

function summarizeAnswers(
  rows: PiAnswerRow[],
): import('./slack-ui.js').ResolutionSummary {
  // Reduce to one effective decision per pi_key. Tiebreak rows trump
  // everything; otherwise prefer non-defaulted human votes; otherwise
  // accept whatever's there.
  const byKey = new Map<string, PiAnswerRow>();
  for (const r of rows) {
    const existing = byKey.get(r.pi_key);
    if (!existing) {
      byKey.set(r.pi_key, r);
      continue;
    }
    const existingTb = existing.answered_by.startsWith('tiebreak:');
    const newTb = r.answered_by.startsWith('tiebreak:');
    if (newTb && !existingTb) {
      byKey.set(r.pi_key, r);
      continue;
    }
    if (!newTb && existingTb) continue;
    if (existing.decision === 'defaulted' && r.decision !== 'defaulted') {
      byKey.set(r.pi_key, r);
    }
  }

  let accepted = 0,
    override = 0,
    defaulted = 0,
    tiebreak = 0,
    discuss = 0;
  for (const r of byKey.values()) {
    if (r.answered_by.startsWith('tiebreak:')) tiebreak++;
    else if (r.decision === 'accept') accepted++;
    else if (r.decision === 'override') override++;
    else if (r.decision === 'defaulted') defaulted++;
    else if (r.decision === 'discuss') discuss++;
  }
  return {
    total: byKey.size,
    accepted,
    override,
    defaulted,
    tiebreak,
    discuss,
  };
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
          displayNameFor(loadPiConfig(), primary.answered_by) ||
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
