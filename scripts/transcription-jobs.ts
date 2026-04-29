#!/usr/bin/env node
/**
 * Operator script for the async transcription queue.
 *
 *   npx tsx scripts/transcription-jobs.ts list
 *   npx tsx scripts/transcription-jobs.ts cancel <id>
 *
 * Cancelling sets cancel_requested=1; the running worker will abort the
 * in-flight sidecar request within a couple seconds and post a fallback
 * "[Voice Message — transcription cancelled]" into the thread. If the job was
 * still pending it transitions straight to cancelled on the next poll.
 */
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve(
  process.cwd(),
  'store',
  'messages.db',
);

function fmtAge(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return s ? `${min}m${s}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

function list(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, chat_jid, file_name, file_bytes, status, created_at, started_at, cancel_requested
       FROM transcription_jobs ORDER BY id DESC LIMIT 30`,
    )
    .all() as Array<{
    id: number;
    chat_jid: string;
    file_name: string | null;
    file_bytes: number | null;
    status: string;
    created_at: number;
    started_at: number | null;
    cancel_requested: number;
  }>;

  if (rows.length === 0) {
    console.log('No transcription jobs.');
    return;
  }

  const now = Date.now();
  console.log(
    'ID'.padEnd(5),
    'status'.padEnd(11),
    'age'.padEnd(8),
    'running'.padEnd(8),
    'MB'.padEnd(7),
    'chat'.padEnd(22),
    'file',
  );
  for (const r of rows) {
    const age = fmtAge(now - r.created_at);
    const running = r.started_at ? fmtAge(now - r.started_at) : '-';
    const mb = r.file_bytes ? (r.file_bytes / 1024 / 1024).toFixed(1) : '-';
    const flag = r.cancel_requested ? '*' : '';
    console.log(
      String(r.id).padEnd(5),
      (r.status + flag).padEnd(11),
      age.padEnd(8),
      running.padEnd(8),
      mb.padEnd(7),
      r.chat_jid.padEnd(22),
      r.file_name || '',
    );
  }
  if (rows.some((r) => r.cancel_requested)) {
    console.log('\n* = cancel requested');
  }
}

function cancel(db: Database.Database, id: number): void {
  const res = db
    .prepare(
      `UPDATE transcription_jobs SET cancel_requested = 1
       WHERE id = ? AND status IN ('pending', 'running')`,
    )
    .run(id);
  if (res.changes > 0) {
    console.log(`Cancel requested for job ${id}. Worker will abort within ~2s.`);
  } else {
    console.log(`No active job with id ${id}.`);
  }
}

function main(): void {
  const [, , cmd, arg] = process.argv;
  const db = new Database(DB_PATH, { readonly: cmd === 'list' });
  if (cmd === 'list' || !cmd) {
    list(db);
  } else if (cmd === 'cancel') {
    const id = parseInt(arg || '', 10);
    if (!id) {
      console.error('Usage: transcription-jobs.ts cancel <id>');
      process.exit(2);
    }
    cancel(db, id);
  } else {
    console.error('Usage: transcription-jobs.ts [list|cancel <id>]');
    process.exit(2);
  }
}

main();
