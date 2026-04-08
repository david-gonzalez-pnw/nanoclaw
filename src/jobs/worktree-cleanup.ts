/**
 * Bree Worker Thread Job: Worktree Cleanup
 * Runs in an isolated worker thread to avoid blocking the main event loop.
 * Queries for expired worktrees and removes them via git commands.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

const execAsync = promisify(exec);

interface WorktreeRow {
  thread_ts: string;
  repo_host_path: string;
  worktree_host_path: string;
  branch_name: string;
  container_path: string;
  group_folder: string;
  created_at: string;
  last_used_at: string;
  retain_until: string | null;
}

async function removeSingleWorktree(
  entry: WorktreeRow,
  db: Database.Database,
): Promise<void> {
  // Remove git worktree
  if (fs.existsSync(entry.worktree_host_path)) {
    try {
      await execAsync(
        `git -C ${JSON.stringify(entry.repo_host_path)} worktree remove --force ${JSON.stringify(entry.worktree_host_path)}`,
      );
    } catch {
      // Manual cleanup if git command fails
      fs.rmSync(entry.worktree_host_path, { recursive: true, force: true });
    }
  }

  // Delete branch
  try {
    await execAsync(
      `git -C ${JSON.stringify(entry.repo_host_path)} branch -D ${JSON.stringify(entry.branch_name)}`,
    );
  } catch {
    // Branch may already be deleted
  }

  // Remove DB entry
  db.prepare(
    'DELETE FROM worktrees WHERE thread_ts = ? AND repo_host_path = ?',
  ).run(entry.thread_ts, entry.repo_host_path);

  // Clean up empty parent directory
  const parentDir = path.dirname(entry.worktree_host_path);
  try {
    const remaining = fs.readdirSync(parentDir);
    if (remaining.length === 0) {
      fs.rmdirSync(parentDir);
    }
  } catch {
    // ignore
  }
}

async function run(): Promise<void> {
  const dbPath = (workerData as { dbPath: string }).dbPath;
  const maxAgeMs = (workerData as { maxAgeMs: number }).maxAgeMs;

  const db = new Database(dbPath);
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const now = new Date().toISOString();

  const expired = db
    .prepare(
      `SELECT * FROM worktrees
       WHERE last_used_at < ?
       AND (retain_until IS NULL OR retain_until < ?)`,
    )
    .all(cutoff, now) as WorktreeRow[];

  if (expired.length === 0) {
    parentPort?.postMessage({ type: 'done', removed: 0 });
    db.close();
    return;
  }

  let removed = 0;
  for (const entry of expired) {
    try {
      await removeSingleWorktree(entry, db);
      removed++;
    } catch (err) {
      parentPort?.postMessage({
        type: 'error',
        message: `Failed to remove worktree ${entry.worktree_host_path}: ${err}`,
      });
    }
  }

  parentPort?.postMessage({ type: 'done', removed });
  db.close();
}

run().catch((err) => {
  parentPort?.postMessage({ type: 'error', message: String(err) });
});
