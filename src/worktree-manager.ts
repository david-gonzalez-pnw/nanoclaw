/**
 * Worktree Manager for NanoClaw
 * Creates, reuses, and cleans up per-thread git worktrees for isolated code changes.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, WORKTREE_MAX_AGE_MS } from './config.js';
import {
  deleteWorktree,
  getExpiredWorktrees,
  getWorktrees,
  setRetainUntil,
  upsertWorktree,
  WorktreeEntry,
} from './db.js';
import { logger } from './logger.js';

const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');

function sanitizeThreadTs(threadTs: string): string {
  return threadTs.replace(/\./g, '-');
}

function isGitRepo(dirPath: string): boolean {
  try {
    const gitDir = path.join(dirPath, '.git');
    return fs.existsSync(gitDir);
  } catch {
    return false;
  }
}

function branchExists(repoPath: string, branchName: string): boolean {
  try {
    execSync(
      `git -C ${JSON.stringify(repoPath)} rev-parse --verify ${JSON.stringify(branchName)}`,
      {
        stdio: 'pipe',
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Get or create a git worktree for a specific thread and repo.
 * Returns the host path of the worktree directory.
 */
export function getOrCreateWorktree(
  repoHostPath: string,
  threadTs: string,
  containerPath: string,
  groupFolder: string,
): string | null {
  if (!isGitRepo(repoHostPath)) {
    logger.debug({ repoHostPath }, 'Not a git repo, skipping worktree');
    return null;
  }

  const branchName = `nanoclaw/${threadTs}`;
  const sanitized = sanitizeThreadTs(threadTs);
  const repoBasename = path.basename(repoHostPath);
  const worktreeDir = path.join(WORKTREES_DIR, sanitized, repoBasename);

  // Check DB for existing worktree
  const existing = getWorktrees(threadTs).find(
    (w) => w.repo_host_path === repoHostPath,
  );

  if (existing && fs.existsSync(existing.worktree_host_path)) {
    // Update last_used_at
    upsertWorktree({
      ...existing,
      last_used_at: new Date().toISOString(),
    });
    logger.debug({ threadTs, repo: repoBasename }, 'Reusing existing worktree');
    return existing.worktree_host_path;
  }

  // Create the worktree
  try {
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

    if (branchExists(repoHostPath, branchName)) {
      // Branch exists (restart recovery or re-creation) — attach to it
      // Remove stale worktree reference first if it exists
      try {
        execSync(
          `git -C ${JSON.stringify(repoHostPath)} worktree remove --force ${JSON.stringify(worktreeDir)}`,
          { stdio: 'pipe' },
        );
      } catch {
        // Worktree reference may not exist
      }
      execSync(
        `git -C ${JSON.stringify(repoHostPath)} worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(branchName)}`,
        { stdio: 'pipe' },
      );
    } else {
      // Create new branch
      execSync(
        `git -C ${JSON.stringify(repoHostPath)} worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(worktreeDir)}`,
        { stdio: 'pipe' },
      );
    }

    const now = new Date().toISOString();
    upsertWorktree({
      thread_ts: threadTs,
      repo_host_path: repoHostPath,
      worktree_host_path: worktreeDir,
      branch_name: branchName,
      container_path: containerPath,
      group_folder: groupFolder,
      created_at: now,
      last_used_at: now,
      retain_until: null,
    });

    logger.info(
      { threadTs, repo: repoBasename, worktreeDir, branchName },
      'Created git worktree',
    );
    return worktreeDir;
  } catch (err) {
    logger.error(
      { threadTs, repoHostPath, err },
      'Failed to create git worktree',
    );
    return null;
  }
}

/**
 * Get a map of original repo paths to worktree paths for a thread.
 */
export function getWorktreeMap(threadTs: string): Map<string, string> {
  const entries = getWorktrees(threadTs);
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (fs.existsSync(entry.worktree_host_path)) {
      map.set(entry.repo_host_path, entry.worktree_host_path);
    }
  }
  return map;
}

/**
 * Remove all worktrees for a thread and delete associated branches.
 */
export function removeWorktrees(threadTs: string): void {
  const entries = getWorktrees(threadTs);
  for (const entry of entries) {
    removeSingleWorktree(entry);
  }
}

function removeSingleWorktree(entry: WorktreeEntry): void {
  try {
    // Remove git worktree
    if (fs.existsSync(entry.worktree_host_path)) {
      execSync(
        `git -C ${JSON.stringify(entry.repo_host_path)} worktree remove --force ${JSON.stringify(entry.worktree_host_path)}`,
        { stdio: 'pipe' },
      );
    }
  } catch (err) {
    logger.warn(
      { threadTs: entry.thread_ts, worktree: entry.worktree_host_path, err },
      'Failed to git worktree remove, cleaning up manually',
    );
    // Manual cleanup if git command fails
    try {
      fs.rmSync(entry.worktree_host_path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // Delete the branch
  try {
    execSync(
      `git -C ${JSON.stringify(entry.repo_host_path)} branch -D ${JSON.stringify(entry.branch_name)}`,
      { stdio: 'pipe' },
    );
  } catch {
    // Branch may already be deleted
  }

  // Remove DB entry
  deleteWorktree(entry.thread_ts, entry.repo_host_path);

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

  logger.info(
    { threadTs: entry.thread_ts, repo: path.basename(entry.repo_host_path) },
    'Removed worktree',
  );
}

/**
 * Clean up worktrees older than maxAgeMs, respecting retain_until.
 */
export function cleanupStaleWorktrees(
  maxAgeMs: number = WORKTREE_MAX_AGE_MS,
): number {
  const expired = getExpiredWorktrees(maxAgeMs);
  if (expired.length === 0) return 0;

  logger.info({ count: expired.length }, 'Cleaning up stale worktrees');
  for (const entry of expired) {
    removeSingleWorktree(entry);
  }
  return expired.length;
}

/**
 * Extend retention for all worktrees of a thread.
 */
export function extendWorktreeRetention(threadTs: string, days: number): void {
  const retainUntil = new Date(
    Date.now() + days * 24 * 60 * 60 * 1000,
  ).toISOString();
  setRetainUntil(threadTs, retainUntil);
  logger.info({ threadTs, retainUntil }, 'Extended worktree retention');
}
