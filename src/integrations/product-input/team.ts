/**
 * Compatibility shim for callers that imported team helpers directly.
 * The source of truth is `config.ts`. This file simply re-exports thin
 * helpers so the diff to the rest of the integration stays small.
 *
 * No install-specific identifiers live in source — repo, channel, team
 * mapping, and SLA ping targets all come from `.env` and the external
 * team file at `$PI_TEAM_FILE` (default ~/.config/nanoclaw/pi-team.json).
 */
import {
  displayNameFor,
  githubLoginFor,
  isTeamMember as configIsTeamMember,
  loadPiConfig,
} from './config.js';

export function githubLoginForSlackUser(userId: string): string | undefined {
  return githubLoginFor(loadPiConfig(), userId);
}

export function isTeamMember(userId: string): boolean {
  return configIsTeamMember(loadPiConfig(), userId);
}

export function displayNameForSlackUser(userId: string): string | undefined {
  return displayNameFor(loadPiConfig(), userId);
}
