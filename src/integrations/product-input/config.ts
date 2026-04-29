import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';

export interface PiTeamMember {
  slackUserId: string;
  githubLogin: string;
  displayName: string;
}

export interface PiTeamConfig {
  members: PiTeamMember[];
  /** Slack user IDs to @-mention on 48h SLA warning + 72h sync request. */
  slaPingTargets: string[];
}

export interface PiConfig {
  enabled: boolean;
  /** "owner/name" — the GitHub repo to watch and write back to. */
  githubRepo: string;
  /** Slack channel ID (not name) where notifications and announcements are posted. */
  slackChannel: string;
  labelRequired: string;
  labelPending: string;
  labelResolved: string;
  /** Path under the repo where RFC files live, e.g. "docs/rfcs". */
  rfcDir: string;
  /** Display name used in user-facing copy ("Product Input needed…"). */
  featureName: string;
  /** Registered group whose container_config mounts the watched repo writable. */
  finalizeGroup: string;
  commitDecisionsEnabled: boolean;
  team: PiTeamConfig;
  teamFilePath: string;
}

const ENV_KEYS = [
  'PI_ENABLED',
  'PI_GITHUB_REPO',
  'PI_SLACK_CHANNEL',
  'PI_LABEL_REQUIRED',
  'PI_LABEL_PENDING',
  'PI_LABEL_RESOLVED',
  'PI_RFC_DIR',
  'PI_FEATURE_NAME',
  'PI_FINALIZE_GROUP',
  'PI_COMMIT_DECISIONS',
  'PI_TEAM_FILE',
] as const;

let cached: PiConfig | null = null;

/**
 * Load and cache the integration config. All install-specific values
 * (repo, channel, team, labels) come from `.env` plus an external team
 * file. Nothing here is hardcoded to one organisation, so this code can
 * live unmodified in any fork that follows the documented PI conventions.
 */
export function loadPiConfig(): PiConfig {
  if (cached) return cached;
  const env = readEnvFile([...ENV_KEYS]);
  const get = (key: string): string | undefined =>
    process.env[key] || env[key] || undefined;

  const teamFilePath =
    get('PI_TEAM_FILE') ||
    path.join(os.homedir(), '.config', 'nanoclaw', 'pi-team.json');

  cached = {
    enabled: get('PI_ENABLED') === 'true',
    githubRepo: get('PI_GITHUB_REPO') || '',
    slackChannel: get('PI_SLACK_CHANNEL') || '',
    labelRequired: get('PI_LABEL_REQUIRED') || 'product-input-required',
    labelPending: get('PI_LABEL_PENDING') || 'product-input-pending',
    labelResolved: get('PI_LABEL_RESOLVED') || 'product-input-resolved',
    rfcDir: get('PI_RFC_DIR') || 'docs/rfcs',
    featureName: get('PI_FEATURE_NAME') || 'Product Input',
    finalizeGroup: get('PI_FINALIZE_GROUP') || '',
    commitDecisionsEnabled: get('PI_COMMIT_DECISIONS') === 'true',
    team: loadTeamFile(teamFilePath),
    teamFilePath,
  };
  return cached;
}

/** For tests + when the user edits .env at runtime. */
export function clearPiConfigCache(): void {
  cached = null;
}

/**
 * Validate that the minimum required values are present. Returns a list
 * of human-readable errors, empty if config is usable.
 */
export function validatePiConfig(cfg: PiConfig): string[] {
  const errs: string[] = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.githubRepo)) {
    errs.push(
      `PI_GITHUB_REPO must be set to "owner/name" (got "${cfg.githubRepo}")`,
    );
  }
  if (!cfg.slackChannel) {
    errs.push('PI_SLACK_CHANNEL must be set to a Slack channel ID');
  }
  if (cfg.team.members.length === 0) {
    errs.push(
      `Team file at ${cfg.teamFilePath} has no members; create it as { members: [...], slaPingTargets: [...] }`,
    );
  }
  return errs;
}

export function githubLoginFor(
  cfg: PiConfig,
  slackUserId: string,
): string | undefined {
  return cfg.team.members.find((m) => m.slackUserId === slackUserId)
    ?.githubLogin;
}

export function isTeamMember(cfg: PiConfig, slackUserId: string): boolean {
  return cfg.team.members.some((m) => m.slackUserId === slackUserId);
}

export function displayNameFor(
  cfg: PiConfig,
  slackUserId: string,
): string | undefined {
  return cfg.team.members.find((m) => m.slackUserId === slackUserId)
    ?.displayName;
}

/** Render the SLA-ping mention string ("<@U…> <@U…>"). */
export function renderSlaPingMentions(cfg: PiConfig): string {
  return cfg.team.slaPingTargets.map((id) => `<@${id}>`).join(' ');
}

// --- Helpers ---

function loadTeamFile(filePath: string): PiTeamConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err, filePath }, 'PI: failed to read team file');
    }
    return { members: [], slaPingTargets: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err, filePath }, 'PI: team file is not valid JSON');
    return { members: [], slaPingTargets: [] };
  }
  const obj = parsed as {
    members?: unknown;
    slaPingTargets?: unknown;
  };
  const members: PiTeamMember[] = Array.isArray(obj.members)
    ? obj.members.filter(
        (m): m is PiTeamMember =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as PiTeamMember).slackUserId === 'string' &&
          typeof (m as PiTeamMember).githubLogin === 'string' &&
          typeof (m as PiTeamMember).displayName === 'string',
      )
    : [];
  const slaPingTargets: string[] = Array.isArray(obj.slaPingTargets)
    ? obj.slaPingTargets.filter((s): s is string => typeof s === 'string')
    : [];
  return { members, slaPingTargets };
}
