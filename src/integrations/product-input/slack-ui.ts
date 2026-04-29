import type { WebClient } from '@slack/web-api';
import type { View } from '@slack/types';

import { logger } from '../../logger.js';
import {
  displayNameFor,
  loadPiConfig,
  renderSlaPingMentions,
} from './config.js';
import type { ParsedPi, PiAnswerRow, PiQuestionRow } from './db.js';
import { shortRfcName, toSlackMrkdwn, truncate } from './parser.js';

const MAX_SECTION_CHARS = 2800;

export interface PrNotificationInput {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prBody?: string | null;
  pis: ParsedPi[];
}

export function buildPrNotificationBlocks(input: PrNotificationInput): {
  blocks: unknown[];
  text: string;
} {
  const { prNumber, prTitle, prUrl, prBody, pis } = input;
  const total = pis.length;
  const deadline = new Date(Date.now() + 72 * 3600 * 1000).toLocaleDateString(
    'en-US',
    { weekday: 'short', month: 'short', day: 'numeric' },
  );

  const byRfc = new Map<string, ParsedPi[]>();
  for (const pi of pis) {
    const rfc = shortRfcName(pi.rfcName);
    const list = byRfc.get(rfc) || [];
    list.push(pi);
    byRfc.set(rfc, list);
  }

  const rfcSections: string[] = [];
  for (const [rfc, ps] of byRfc) {
    const header = `*${ps.length} question${ps.length === 1 ? '' : 's'} — ${rfc}*`;
    const items = ps.map((p) => `• ${p.id}: ${p.title}`).join('\n');
    rfcSections.push(`${header}\n${items}`);
  }

  const cfg = loadPiConfig();
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔵 *${cfg.featureName} needed — <${prUrl}|PR #${prNumber}>*\n*${prTitle}*`,
      },
    },
  ];

  const summary = summarizePrBody(prBody);
  if (summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*SUMMARY*\n${summary}` },
    });
  }

  for (const chunk of chunkText(rfcSections.join('\n\n'), MAX_SECTION_CHARS)) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  }

  const slaPings = renderSlaPingMentions(cfg);
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${total} questions · Deadline: *${deadline}*${slaPings ? ' · ' + slaPings : ''}`,
      },
    ],
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '📋 Answer questions →',
          emoji: true,
        },
        style: 'primary',
        action_id: 'pi_open_form',
        value: String(prNumber),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔗 View PR', emoji: true },
        url: prUrl,
        action_id: 'pi_view_pr',
      },
    ],
  });

  return {
    blocks,
    text: `${cfg.featureName} needed — PR #${prNumber}: ${total} questions for ${deadline}`,
  };
}

function summarizePrBody(body: string | null | undefined): string | null {
  if (!body) return null;
  // Strip HTML comments (GitHub PR template scaffolding).
  let cleaned = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!cleaned) return null;
  // Prefer the first non-heading paragraph so we skip "## Summary" style headers
  // and surface the actual prose.
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^#{1,6}\s/.test(p));
  if (paragraphs.length > 0) cleaned = paragraphs[0];
  return toSlackMrkdwn(truncate(cleaned, 600));
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cutAt = remaining.lastIndexOf('\n\n', maxLen);
    const boundary = cutAt > 0 ? cutAt : maxLen;
    out.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) out.push(remaining);
  return out;
}

export interface PiModalInput {
  pi: ParsedPi;
  index: number;
  total: number;
  prNumber: number;
  sessionKey: string;
  isTiebreak?: boolean;
}

export function buildPIModal(input: PiModalInput): View {
  const { pi, index, total, prNumber, sessionKey, isTiebreak } = input;
  const filled = Math.min(index + 1, 12);
  const empty = Math.max(total - index - 1, 0);
  const dots = '●'.repeat(filled) + '○'.repeat(empty);
  const progress = dots.length > 20 ? `${index + 1}/${total}` : dots;
  const isLast = index === total - 1;
  const rfc = shortRfcName(pi.rfcName);
  const title = isTiebreak
    ? `PR #${prNumber} · Tie-break`
    : `PR #${prNumber} · Q${index + 1} of ${total}`;

  return {
    type: 'modal',
    callback_id: isTiebreak ? 'pi_tiebreak_submit' : 'pi_answer_submit',
    title: { type: 'plain_text', text: title },
    submit: {
      type: 'plain_text',
      text: isTiebreak ? 'Resolve tie ✓' : isLast ? 'Submit all ✓' : 'Next →',
    },
    close: { type: 'plain_text', text: 'Save & close' },
    private_metadata: JSON.stringify({ sessionKey, piIndex: index }),
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${progress}  *${pi.id} — ${pi.title}*  ·  _${rfc}_`,
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*CONTEXT*\n${truncate(toSlackMrkdwn(pi.context), 800)}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*❓ QUESTION*\n${toSlackMrkdwn(pi.question)}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*💡 ENG RECOMMENDATION*\n${toSlackMrkdwn(pi.engRec)}`,
        },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'decision',
        label: { type: 'plain_text', text: 'Your decision' },
        element: {
          type: 'radio_buttons',
          action_id: 'decision_value',
          options: [
            {
              text: { type: 'mrkdwn', text: '👍  *Accept eng recommendation*' },
              value: 'accept',
            },
            {
              text: {
                type: 'mrkdwn',
                text: '✍️  *Propose an alternative*  _(describe below)_',
              },
              value: 'override',
            },
            {
              text: {
                type: 'mrkdwn',
                text: '💬  *Needs discussion*  _(flag for sync)_',
              },
              value: 'discuss',
            },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'alternative',
        optional: true,
        label: {
          type: 'plain_text',
          text: 'Alternative answer or reasoning (required if overriding):',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'alternative_value',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Your proposed answer and why...',
          },
        },
      },
    ],
  };
}

export function buildCompletionModal(
  prNumber: number,
  answered: number,
  discussed: number,
): View {
  let summary = `*Recorded ${answered} decision${answered !== 1 ? 's' : ''} for PR #${prNumber}.*`;
  if (discussed > 0) {
    summary += `\n\n⚠️ ${discussed} question${discussed !== 1 ? 's' : ''} flagged for discussion — check <#${loadPiConfig().slackChannel}>.`;
  }
  summary += `\n\n<https://github.com/${loadPiConfig().githubRepo}/pull/${prNumber}|View PR #${prNumber}>`;

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Done! 🎉' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }],
  };
}

export interface AnswerSummaryInput {
  prNumber: number;
  userId: string;
  pis: ParsedPi[];
  answers: Record<string, { decision: string; reasoning?: string | null }>;
}

export function buildAnswerSummaryText(input: AnswerSummaryInput): string {
  const { prNumber, userId, pis, answers } = input;
  const answeredCount = pis.filter((pi) => {
    const a = answers[`${pi.rfcName}:${pi.id}`];
    return a && a.decision !== 'discuss';
  }).length;

  const lines = pis.map((pi) => {
    const a = answers[`${pi.rfcName}:${pi.id}`];
    const label = `${pi.id} _(${shortRfcName(pi.rfcName)})_`;
    if (!a) return `${label}: ⏭️ skipped`;
    if (a.decision === 'accept') return `${label}: ✅ accepted eng rec`;
    if (a.decision === 'override')
      return `${label}: ✍️ override — ${a.reasoning || ''}`;
    if (a.decision === 'discuss') return `${label}: 💬 flagged for discussion`;
    return `${label}: unknown`;
  });

  return [
    `✅ *<@${userId}> answered ${answeredCount}/${pis.length} questions for <https://github.com/${loadPiConfig().githubRepo}/pull/${prNumber}|PR #${prNumber}>*`,
    '',
    lines.join('\n'),
  ].join('\n');
}

export interface TiebreakAnnouncementInput {
  prNumber: number;
  prUrl: string;
  question: PiQuestionRow;
  votes: PiAnswerRow[];
}

export function buildTiebreakAnnouncement(input: TiebreakAnnouncementInput): {
  blocks: unknown[];
  text: string;
} {
  const { prNumber, prUrl, question, votes } = input;
  const rfc = shortRfcName(question.rfc_slug);

  const cfg = loadPiConfig();
  const voteLines = votes
    .filter((v) => !v.answered_by.startsWith('tiebreak:'))
    .map((v) => {
      const who = displayNameFor(cfg, v.answered_by)
        ? `<@${v.answered_by}>`
        : v.answered_by;
      if (v.decision === 'accept') return `  • ${who}: ✅ accepted eng rec`;
      if (v.decision === 'override')
        return `  • ${who}: ✍️ override — _${v.reasoning || ''}_`;
      if (v.decision === 'discuss') return `  • ${who}: 💬 needs discussion`;
      return `  • ${who}: ${v.decision}`;
    })
    .join('\n');

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⚖️ *Tie break needed — <${prUrl}|PR #${prNumber}> · ${question.pi_id}* _(${rfc})_`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*QUESTION*\n${truncate(toSlackMrkdwn(question.question || ''), 1200)}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*💡 ENG RECOMMENDATION*\n${truncate(toSlackMrkdwn(question.eng_rec), 1200)}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Votes so far:*\n${voteLines}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Discuss in this thread. Anyone on the team can click _Resolve tie_ when the group lands on an outcome.',
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Resolve tie →', emoji: true },
          style: 'primary',
          action_id: 'pi_resolve_tie',
          value: JSON.stringify({
            prNumber,
            piKey: `${question.rfc_slug}:${question.pi_id}`,
          }),
        },
      ],
    },
  ];

  return {
    blocks,
    text: `Tie break needed — PR #${prNumber} ${question.pi_id}`,
  };
}

export interface ResolutionSummary {
  total: number;
  accepted: number;
  override: number;
  defaulted: number;
  tiebreak: number;
  discuss: number;
}

export interface ResolutionAnnouncementInput {
  prNumber: number;
  prUrl: string;
  commentUrl: string | null;
  summary: ResolutionSummary;
  ageHours: number;
}

export function buildResolutionAnnouncement(
  input: ResolutionAnnouncementInput,
): { blocks: unknown[]; text: string } {
  const { prNumber, prUrl, commentUrl, summary, ageHours } = input;

  const headerLink = `<${prUrl}|PR #${prNumber}>`;
  const elapsed = formatElapsed(ageHours);
  const headline = `✅ *Product Input closed — ${headerLink}*\n${summary.total}/${summary.total} decisions recorded · ${elapsed} elapsed`;

  const counts = [
    `:white_check_mark: ${summary.accepted} accepted`,
    `:pencil2: ${summary.override} override`,
    `:hourglass: ${summary.defaulted} defaulted`,
    `:scales: ${summary.tiebreak} tie-break`,
  ].join('  ');
  const discussLine =
    summary.discuss > 0
      ? `\n:speech_balloon: ${summary.discuss} still flagged for discussion (not blocking resolution)`
      : '';

  const linkLine = commentUrl
    ? `→ <${commentUrl}|See the decision table on GitHub>`
    : `→ <${prUrl}|See the PR>`;

  const footers: string[] = [];
  if (summary.defaulted > 0) {
    footers.push(
      '_Defaulted PIs took the engineering recommendation after the 72h SLA elapsed with no human input._',
    );
  }
  if (summary.discuss > 0) {
    footers.push(
      '_Discussion-flagged PIs were resolved by majority vote or eng-rec default; the discussion threads remain open if the team wants to revisit._',
    );
  }
  const footer = footers.length > 0 ? `\n\n${footers.join('\n\n')}` : '';

  const text = `${headline}\n${counts}${discussLine}\n\n${linkLine}${footer}`;

  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

function formatElapsed(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours - days * 24);
  return rem ? `${days}d ${rem}h` : `${days}d`;
}

export async function postSlackMessage(
  client: WebClient,
  args: {
    channel: string;
    text: string;
    blocks?: unknown[];
    thread_ts?: string;
  },
): Promise<string | null> {
  try {
    const res = await client.chat.postMessage({
      channel: args.channel,
      text: args.text,
      blocks: args.blocks as never,
      thread_ts: args.thread_ts,
    });
    return (res.ts as string | undefined) || null;
  } catch (err) {
    logger.error(
      { err, channel: args.channel },
      'Failed to post Slack message',
    );
    return null;
  }
}
