import type { App } from '@slack/bolt';

import { logger } from '../../logger.js';
import { loadPiConfig, validatePiConfig } from './config.js';
import { startCronLoops, stopCronLoops } from './cron.js';
import { defaultGithubClient } from './github.js';
import { getGithubToken } from './github-auth.js';
import { registerHandlers } from './handlers.js';
import { ensureScanForPr } from './writeback.js';

export interface ProductInputOptions {
  slackApp: App;
}

export async function initProductInput(opts: ProductInputOptions): Promise<void> {
  const cfg = loadPiConfig();
  if (!cfg.enabled) {
    logger.info('Product Input integration disabled (PI_ENABLED != true)');
    return;
  }

  const errors = validatePiConfig(cfg);
  if (errors.length > 0) {
    logger.warn(
      { errors },
      'Product Input config invalid; integration will not start',
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

  logger.info(
    { repo: cfg.githubRepo, channel: cfg.slackChannel },
    'Product Input integration initialized (auth via gh CLI)',
  );
}

export function shutdownProductInput(): void {
  stopCronLoops();
}
