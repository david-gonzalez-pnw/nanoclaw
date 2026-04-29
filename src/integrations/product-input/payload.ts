import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from '../../group-folder.js';
import { githubLoginFor, loadPiConfig } from './config.js';
import {
  getAnswersForPr,
  getQuestionsForPr,
  type PiAnswerRow,
  type PiQuestionRow,
} from './db.js';

/**
 * Per-PI decision rendered into the JSON payload that the
 * commit-pi-decisions skill reads inside the container.
 */
export interface ResolutionDecision {
  rfcSlug: string;
  piId: string;
  decision: 'accept' | 'override' | 'discuss' | 'defaulted';
  decisionText: string;
  reasoning: string | null;
  decidedBy: string | null; // "@github-login"
  decidedAt: string; // ISO 8601
  how: 'Accepted eng rec' | 'Override' | 'Defaulted' | 'Tie-break' | 'Needs discussion';
}

export interface ResolutionPayload {
  prNumber: number;
  prHeadRef: string;
  /** Container path of the writable repo mount, e.g. `/workspace/extra/<name>`. */
  repoMountPath: string;
  commentUrl: string | null;
  decisions: ResolutionDecision[];
}

/** Build the payload from the DB rows. */
export function buildResolutionPayload(args: {
  prNumber: number;
  prHeadRef: string;
  repoMountPath: string;
  commentUrl: string | null;
}): ResolutionPayload {
  const questions = getQuestionsForPr(args.prNumber);
  const answers = getAnswersForPr(args.prNumber);
  const byKey = new Map<string, PiAnswerRow[]>();
  for (const a of answers) {
    const list = byKey.get(a.pi_key) || [];
    list.push(a);
    byKey.set(a.pi_key, list);
  }

  const decisions: ResolutionDecision[] = [];
  for (const q of questions) {
    const rows = byKey.get(q.pi_key) || [];
    if (rows.length === 0) continue;
    const decision = pickEffective(rows);
    if (!decision) continue;
    decisions.push(toResolutionDecision(q, decision));
  }
  return {
    prNumber: args.prNumber,
    prHeadRef: args.prHeadRef,
    repoMountPath: args.repoMountPath,
    commentUrl: args.commentUrl,
    decisions,
  };
}

/**
 * Write the payload JSON into the group's `pi-resolutions/<PR>.json` so the
 * container skill can read it at `/workspace/group/pi-resolutions/<PR>.json`.
 * Returns the host path written to.
 */
export function writeResolutionPayload(
  groupFolder: string,
  payload: ResolutionPayload,
): string {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const dir = path.join(groupDir, 'pi-resolutions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${payload.prNumber}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

// --- Helpers ---

function pickEffective(rows: PiAnswerRow[]): PiAnswerRow | null {
  // Tiebreak rows are authoritative; otherwise prefer non-defaulted human
  // votes over `system:defaulted` rows; otherwise fall through to the first.
  const tb = rows.find((r) => r.answered_by.startsWith('tiebreak:'));
  if (tb) return tb;
  const human = rows.find(
    (r) => r.answered_by !== 'system:defaulted' && r.decision !== 'defaulted',
  );
  if (human) return human;
  return rows[0] ?? null;
}

function toResolutionDecision(
  q: PiQuestionRow,
  row: PiAnswerRow,
): ResolutionDecision {
  const isTiebreak = row.answered_by.startsWith('tiebreak:');
  const isDefaulted =
    row.answered_by === 'system:defaulted' || row.decision === 'defaulted';

  let how: ResolutionDecision['how'];
  if (isTiebreak) how = 'Tie-break';
  else if (isDefaulted) how = 'Defaulted';
  else if (row.decision === 'accept') how = 'Accepted eng rec';
  else if (row.decision === 'override') how = 'Override';
  else how = 'Needs discussion';

  const decidedBy = isDefaulted
    ? null
    : row.github_login
      ? `@${row.github_login}`
      : (() => {
          const slackId = row.answered_by.replace(/^tiebreak:/, '');
          const login = githubLoginFor(loadPiConfig(), slackId);
          return login ? `@${login}` : null;
        })();

  return {
    rfcSlug: q.rfc_slug,
    piId: q.pi_id,
    decision: (isDefaulted ? 'defaulted' : row.decision) as
      | 'accept'
      | 'override'
      | 'discuss'
      | 'defaulted',
    decisionText: row.answer_text,
    reasoning: row.reasoning,
    decidedBy,
    decidedAt: new Date(row.answered_at).toISOString(),
    how,
  };
}
