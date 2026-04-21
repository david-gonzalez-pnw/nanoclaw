import type { App } from '@slack/bolt';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import { startCronLoops, stopCronLoops } from './cron.js';
import { defaultGithubClient } from './github.js';
import { getGithubToken } from './github-auth.js';
import { registerHandlers } from './handlers.js';
import { ensureScanForPr } from './writeback.js';

export interface Product InputPiOptions {
  slackApp: App;
}

export async function initProductInput(opts: Product InputPiOptions): Promise<void> {
  const env = readEnvFile(['PI_ENABLED']);
  const enabled =
    (process.env.PI_ENABLED || env.PI_ENABLED) === 'true';
  if (!enabled) {
    logger.info(
      'Product Input integration disabled (PI_ENABLED != true)',
    );
    return;
  }

  // Smoke-check gh auth at startup so we fail fast if the CLI isn't logged in.
  const token = await getGithubToken();
  if (!token) {
    logger.warn(
      'Product Input: `gh auth token` returned nothing — run `gh auth login` and retry',
    );
    return;
  }

  const github = defaultGithubClient;
  const deps = { slack: opts.slackApp.client, github };

  registerHandlers(opts.slackApp, {
    github,
    ensureScan: (prNumber: number) => ensureScanForPr(deps, prNumber),
  });
  startCronLoops(deps);

  logger.info('Product Input integration initialized (auth via gh CLI)');
}

export function shutdownProductInput(): void {
  stopCronLoops();
}
