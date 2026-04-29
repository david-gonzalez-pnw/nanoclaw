import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from '../../config.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(path.join(STORE_DIR, 'messages.db'));
  }
  return db;
}

// --- Sessions (wizard progress) ---

export interface PiSessionData {
  prNumber: number;
  userId: string;
  pis: ParsedPi[];
  currentIndex: number;
  answers: Record<string, PiSessionAnswer>;
  startedAt: number;
  completedAt?: number;
  anchorTs?: string;
  channelId?: string;
  isTiebreak?: boolean;
  tiebreakPiKey?: string;
}

export interface PiSessionAnswer {
  decision: PiDecision;
  piId: string;
  rfcName: string;
  answer: string;
  reasoning: string | null;
  answeredBy: string;
  answeredAt: number;
}

export type PiDecision = 'accept' | 'override' | 'discuss';

export interface ParsedPi {
  id: string;
  title: string;
  context: string;
  question: string;
  engRec: string;
  blocking: 'yes' | 'no';
  rfcName: string;
}

export function loadPiSession(key: string): PiSessionData | null {
  const row = getDb()
    .prepare(`SELECT data FROM pi_sessions WHERE key = ? AND expires_at > ?`)
    .get(key, Date.now()) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as PiSessionData) : null;
}

export function savePiSession(
  key: string,
  data: PiSessionData,
  ttlMs = 24 * 60 * 60 * 1000,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pi_sessions (key, data, expires_at) VALUES (?, ?, ?)`,
    )
    .run(key, JSON.stringify(data), Date.now() + ttlMs);
}

export function deletePiSession(key: string): void {
  getDb().prepare(`DELETE FROM pi_sessions WHERE key = ?`).run(key);
}

export function deleteExpiredPiSessions(): number {
  const res = getDb()
    .prepare(`DELETE FROM pi_sessions WHERE expires_at <= ?`)
    .run(Date.now());
  return res.changes;
}

// --- PR state ---

export interface PiPrStateRow {
  pr_number: number;
  thread_ts: string | null;
  notified_at: number | null;
  sla_48h_warned_at: number | null;
  blocking_sync_requested_at: number | null;
  resolved_at: number | null;
  slack_announced_at: number | null;
  rfc_committed_at: number | null;
  rfc_commit_sha: string | null;
}

export function getPiPrState(prNumber: number): PiPrStateRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM pi_pr_state WHERE pr_number = ?`)
    .get(prNumber) as PiPrStateRow | undefined;
}

export function upsertPiPrState(
  prNumber: number,
  updates: Partial<Omit<PiPrStateRow, 'pr_number'>>,
): void {
  const existing = getPiPrState(prNumber);
  const merged: PiPrStateRow = {
    pr_number: prNumber,
    thread_ts: existing?.thread_ts ?? null,
    notified_at: existing?.notified_at ?? null,
    sla_48h_warned_at: existing?.sla_48h_warned_at ?? null,
    blocking_sync_requested_at: existing?.blocking_sync_requested_at ?? null,
    resolved_at: existing?.resolved_at ?? null,
    slack_announced_at: existing?.slack_announced_at ?? null,
    rfc_committed_at: existing?.rfc_committed_at ?? null,
    rfc_commit_sha: existing?.rfc_commit_sha ?? null,
    ...updates,
  };
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pi_pr_state
       (pr_number, thread_ts, notified_at, sla_48h_warned_at, blocking_sync_requested_at, resolved_at, slack_announced_at, rfc_committed_at, rfc_commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merged.pr_number,
      merged.thread_ts,
      merged.notified_at,
      merged.sla_48h_warned_at,
      merged.blocking_sync_requested_at,
      merged.resolved_at,
      merged.slack_announced_at,
      merged.rfc_committed_at,
      merged.rfc_commit_sha,
    );
}

export function getUnresolvedPrs(): PiPrStateRow[] {
  // Picks up: (a) PRs not yet resolved on GitHub, (b) PRs resolved but
  // not yet announced in Slack, (c) PRs announced but not yet committed
  // back to the RFC files. Each writeback tick advances state by one phase.
  return getDb()
    .prepare(
      `SELECT * FROM pi_pr_state
       WHERE notified_at IS NOT NULL
         AND (resolved_at IS NULL
              OR slack_announced_at IS NULL
              OR rfc_committed_at IS NULL)`,
    )
    .all() as PiPrStateRow[];
}

export function getAllPiPrState(): PiPrStateRow[] {
  return getDb().prepare(`SELECT * FROM pi_pr_state`).all() as PiPrStateRow[];
}

export function deletePiPrState(prNumber: number): void {
  const database = getDb();
  const txn = database.transaction((pr: number) => {
    database.prepare(`DELETE FROM pi_answers WHERE pr_number = ?`).run(pr);
    database.prepare(`DELETE FROM pi_questions WHERE pr_number = ?`).run(pr);
    database.prepare(`DELETE FROM pi_tiebreaks WHERE pr_number = ?`).run(pr);
    database.prepare(`DELETE FROM pi_pr_state WHERE pr_number = ?`).run(pr);
  });
  txn(prNumber);
}

// --- Questions ---

export interface PiQuestionRow {
  pr_number: number;
  pi_key: string;
  pi_id: string;
  rfc_slug: string;
  title: string | null;
  context: string | null;
  question: string | null;
  eng_rec: string;
  blocking: number;
}

export function replaceQuestionsForPr(prNumber: number, pis: ParsedPi[]): void {
  const database = getDb();
  const txn = database.transaction(() => {
    database
      .prepare(`DELETE FROM pi_questions WHERE pr_number = ?`)
      .run(prNumber);
    const insert = database.prepare(
      `INSERT INTO pi_questions (pr_number, pi_key, pi_id, rfc_slug, title, context, question, eng_rec, blocking)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const pi of pis) {
      insert.run(
        prNumber,
        `${pi.rfcName}:${pi.id}`,
        pi.id,
        pi.rfcName,
        pi.title,
        pi.context,
        pi.question,
        pi.engRec,
        pi.blocking === 'yes' ? 1 : 0,
      );
    }
  });
  txn();
}

export function getQuestionsForPr(prNumber: number): PiQuestionRow[] {
  return getDb()
    .prepare(`SELECT * FROM pi_questions WHERE pr_number = ?`)
    .all(prNumber) as PiQuestionRow[];
}

// --- Answers ---

export interface PiAnswerRow {
  pr_number: number;
  pi_key: string;
  answered_by: string;
  decision: string;
  answer_text: string;
  reasoning: string | null;
  github_login: string | null;
  answered_at: number;
}

export function insertAnswer(row: PiAnswerRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pi_answers
       (pr_number, pi_key, answered_by, decision, answer_text, reasoning, github_login, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.pr_number,
      row.pi_key,
      row.answered_by,
      row.decision,
      row.answer_text,
      row.reasoning,
      row.github_login,
      row.answered_at,
    );
}

export function getAnswersForPr(prNumber: number): PiAnswerRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM pi_answers WHERE pr_number = ? ORDER BY answered_at`,
    )
    .all(prNumber) as PiAnswerRow[];
}

// --- Tiebreaks ---

export interface PiTiebreakRow {
  pr_number: number;
  pi_key: string;
  announcement_ts: string;
  detected_at: number;
  resolved_at: number | null;
}

export function getTiebreak(
  prNumber: number,
  piKey: string,
): PiTiebreakRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM pi_tiebreaks WHERE pr_number = ? AND pi_key = ?`)
    .get(prNumber, piKey) as PiTiebreakRow | undefined;
}

export function insertTiebreak(row: PiTiebreakRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pi_tiebreaks
       (pr_number, pi_key, announcement_ts, detected_at, resolved_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      row.pr_number,
      row.pi_key,
      row.announcement_ts,
      row.detected_at,
      row.resolved_at,
    );
}

export function resolveTiebreak(prNumber: number, piKey: string): void {
  getDb()
    .prepare(
      `UPDATE pi_tiebreaks SET resolved_at = ? WHERE pr_number = ? AND pi_key = ?`,
    )
    .run(Date.now(), prNumber, piKey);
}
