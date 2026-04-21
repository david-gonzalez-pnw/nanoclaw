import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from '../../logger.js';

const execFileP = promisify(execFile);

let cachedToken: string | null = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

/**
 * Get a GitHub token from the `gh` CLI. Cached for 5 min to avoid spawning
 * a subprocess on every API call. Pass `forceRefresh: true` after a 401 to
 * pick up a token the user may have just refreshed.
 */
export async function getGithubToken(
  forceRefresh = false,
): Promise<string | null> {
  if (!forceRefresh && cachedToken && Date.now() - cachedAt < CACHE_MS) {
    return cachedToken;
  }
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token']);
    const token = stdout.trim();
    if (!token) return null;
    cachedToken = token;
    cachedAt = Date.now();
    return token;
  } catch (err) {
    logger.error(
      { err },
      'Failed to get GitHub token from `gh auth token` — is gh CLI installed and logged in?',
    );
    return null;
  }
}
