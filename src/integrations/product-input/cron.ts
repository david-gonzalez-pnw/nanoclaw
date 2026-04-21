import { logger } from '../../logger.js';
import { runScan, runWriteback, type WritebackDeps } from './writeback.js';

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const WRITEBACK_INTERVAL_MS = 15 * 60 * 1000;
const WRITEBACK_OFFSET_MS = 30 * 1000;

let scanTimer: ReturnType<typeof setTimeout> | null = null;
let writebackTimer: ReturnType<typeof setTimeout> | null = null;

export function startCronLoops(deps: WritebackDeps): void {
  if (scanTimer || writebackTimer) {
    logger.debug('Product Input cron loops already running');
    return;
  }

  const tickScan = async () => {
    try {
      await runScan(deps);
    } catch (err) {
      logger.error({ err }, 'Product Input scan tick failed');
    } finally {
      scanTimer = setTimeout(tickScan, SCAN_INTERVAL_MS);
    }
  };

  const tickWriteback = async () => {
    try {
      await runWriteback(deps);
    } catch (err) {
      logger.error({ err }, 'Product Input writeback tick failed');
    } finally {
      writebackTimer = setTimeout(tickWriteback, WRITEBACK_INTERVAL_MS);
    }
  };

  // First scan immediately; writeback after 30s stagger.
  scanTimer = setTimeout(tickScan, 5_000);
  writebackTimer = setTimeout(tickWriteback, WRITEBACK_OFFSET_MS + 5_000);
  logger.info('Product Input cron loops started');
}

export function stopCronLoops(): void {
  if (scanTimer) clearTimeout(scanTimer);
  if (writebackTimer) clearTimeout(writebackTimer);
  scanTimer = null;
  writebackTimer = null;
}
