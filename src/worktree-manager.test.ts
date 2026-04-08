import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { _initTestDatabase } from './db.js';

// Mock config before importing worktree-manager
// vi.mock is hoisted — cannot reference local variables
vi.mock('./config.js', () => {
  const os = require('os');
  const path = require('path');
  const dir = path.join(os.tmpdir(), 'nanoclaw-wt-test');
  return {
    DATA_DIR: dir,
    STORE_DIR: path.join(dir, 'store'),
    WORKTREE_MAX_AGE_MS: 24 * 60 * 60 * 1000,
    ASSISTANT_NAME: 'Andy',
  };
});

import {
  getOrCreateWorktree,
  getWorktreeMap,
  removeWorktrees,
  cleanupStaleWorktrees,
  extendWorktreeRetention,
} from './worktree-manager.js';
import { getWorktrees, upsertWorktree } from './db.js';

const testDataDir = path.join(os.tmpdir(), 'nanoclaw-wt-test');
let testRepoDir: string;

function createTestRepo(): string {
  const dir = path.join(os.tmpdir(), `nanoclaw-test-repo-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: 'pipe',
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('worktree-manager', () => {
  beforeEach(() => {
    _initTestDatabase();
    fs.mkdirSync(testDataDir, { recursive: true });
    testRepoDir = createTestRepo();
  });

  afterEach(() => {
    // Clean up worktrees before deleting repo
    try {
      const worktreesDir = path.join(testDataDir, 'worktrees');
      if (fs.existsSync(worktreesDir)) {
        // Remove worktrees via git first
        const output = execSync('git worktree list --porcelain', {
          cwd: testRepoDir,
          stdio: 'pipe',
        }).toString();
        for (const line of output.split('\n')) {
          if (line.startsWith('worktree ') && !line.includes(testRepoDir)) {
            const wtPath = line.replace('worktree ', '');
            try {
              execSync(
                `git -C ${JSON.stringify(testRepoDir)} worktree remove --force ${JSON.stringify(wtPath)}`,
                {
                  stdio: 'pipe',
                },
              );
            } catch {
              /* ignore */
            }
          }
        }
        fs.rmSync(worktreesDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
    fs.rmSync(testRepoDir, { recursive: true, force: true });
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  it('creates a worktree for a git repo', () => {
    const result = getOrCreateWorktree(
      testRepoDir,
      '1234567890.123456',
      'test-repo',
      'test_group',
    );

    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);

    // Check DB entry
    const entries = getWorktrees('1234567890.123456');
    expect(entries).toHaveLength(1);
    expect(entries[0].branch_name).toBe('nanoclaw/1234567890.123456');
  });

  it('reuses existing worktree on second call', () => {
    const first = getOrCreateWorktree(
      testRepoDir,
      '1234567890.123456',
      'test-repo',
      'test_group',
    );
    const second = getOrCreateWorktree(
      testRepoDir,
      '1234567890.123456',
      'test-repo',
      'test_group',
    );

    expect(first).toBe(second);
    expect(getWorktrees('1234567890.123456')).toHaveLength(1);
  });

  it('creates different worktrees for different threads', () => {
    const wt1 = getOrCreateWorktree(
      testRepoDir,
      '1111111111.111111',
      'test-repo',
      'test_group',
    );
    const wt2 = getOrCreateWorktree(
      testRepoDir,
      '2222222222.222222',
      'test-repo',
      'test_group',
    );

    expect(wt1).not.toBe(wt2);
    expect(wt1).not.toBeNull();
    expect(wt2).not.toBeNull();
  });

  it('returns null for non-git directories', () => {
    const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
    fs.mkdirSync(nonGitDir, { recursive: true });

    const result = getOrCreateWorktree(
      nonGitDir,
      '1234567890.123456',
      'non-git',
      'test_group',
    );

    expect(result).toBeNull();
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  it('getWorktreeMap returns map of repo to worktree paths', () => {
    getOrCreateWorktree(
      testRepoDir,
      '1234567890.123456',
      'test-repo',
      'test_group',
    );

    const map = getWorktreeMap('1234567890.123456');
    expect(map.size).toBe(1);
    expect(map.has(testRepoDir)).toBe(true);
  });

  it('removeWorktrees cleans up worktree and branch', () => {
    getOrCreateWorktree(
      testRepoDir,
      '1234567890.123456',
      'test-repo',
      'test_group',
    );

    expect(getWorktrees('1234567890.123456')).toHaveLength(1);

    removeWorktrees('1234567890.123456');

    expect(getWorktrees('1234567890.123456')).toHaveLength(0);
  });

  it('cleanupStaleWorktrees removes old worktrees', () => {
    getOrCreateWorktree(
      testRepoDir,
      '1234567890.123456',
      'test-repo',
      'test_group',
    );

    // Backdate last_used_at to 2 days ago
    const entries = getWorktrees('1234567890.123456');
    const twoDAysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    upsertWorktree({ ...entries[0], last_used_at: twoDAysAgo });

    const removed = cleanupStaleWorktrees(24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(getWorktrees('1234567890.123456')).toHaveLength(0);
  });

  it('cleanupStaleWorktrees respects retain_until', () => {
    getOrCreateWorktree(
      testRepoDir,
      '1234567890.123456',
      'test-repo',
      'test_group',
    );

    // Backdate last_used_at but set retain_until to future
    const entries = getWorktrees('1234567890.123456');
    const twoDaysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    upsertWorktree({ ...entries[0], last_used_at: twoDaysAgo });
    extendWorktreeRetention('1234567890.123456', 7);

    const removed = cleanupStaleWorktrees(24 * 60 * 60 * 1000);
    expect(removed).toBe(0);
    expect(getWorktrees('1234567890.123456')).toHaveLength(1);
  });
});
