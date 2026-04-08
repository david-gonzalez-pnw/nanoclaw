/**
 * Job Scheduler for NanoClaw
 * Uses Bree to run background jobs in worker threads.
 * Jobs don't block the main event loop.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import Bree from 'bree';

import { WORKTREE_CLEANUP_CRON, WORKTREE_MAX_AGE_MS } from './config.js';
import { getDatabasePath } from './db.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let bree: Bree | null = null;

export function startJobScheduler(): void {
  if (bree) {
    logger.warn('Job scheduler already running');
    return;
  }

  const dbPath = getDatabasePath();

  bree = new Bree({
    root: false, // We provide absolute paths to job files
    jobs: [
      {
        name: 'worktree-cleanup',
        // Bree runs .js files in worker threads — point to compiled output
        path: path.join(__dirname, 'jobs', 'worktree-cleanup.js'),
        cron: WORKTREE_CLEANUP_CRON,
        worker: {
          workerData: { dbPath, maxAgeMs: WORKTREE_MAX_AGE_MS },
        },
      },
    ],
    errorHandler: (error, data) => {
      logger.error({ error, job: data?.name }, 'Bree job error');
    },
    workerMessageHandler: (data) => {
      const msg = data.message as
        | { type?: string; removed?: number; message?: string }
        | undefined;
      if (msg?.type === 'done') {
        if (msg.removed && msg.removed > 0) {
          logger.info(
            { job: data.name, removed: msg.removed },
            'Worktree cleanup completed',
          );
        }
      } else if (msg?.type === 'error') {
        logger.warn(
          { job: data.name, message: msg.message },
          'Worktree cleanup warning',
        );
      }
    },
  });

  bree.start();
  logger.info({ cron: WORKTREE_CLEANUP_CRON }, 'Job scheduler started');
}

export async function stopJobScheduler(): Promise<void> {
  if (!bree) return;
  await bree.stop();
  bree = null;
  logger.info('Job scheduler stopped');
}
