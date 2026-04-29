import { logger } from '../../logger.js';
import { loadPiConfig } from './config.js';
import type { ParsedPi } from './db.js';
import { getGithubToken } from './github-auth.js';
import { parsePIs } from './parser.js';

const USER_AGENT = 'nanoclaw-product-input/1.0';

function repo(): string {
  return loadPiConfig().githubRepo;
}

export interface GithubClient {
  getToken: (forceRefresh?: boolean) => Promise<string | null>;
}

export const defaultGithubClient: GithubClient = {
  getToken: (forceRefresh = false) => getGithubToken(forceRefresh),
};

async function authedFetch(
  client: GithubClient,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const token = await client.getToken();
  if (!token) {
    return new Response('no github token', { status: 401 });
  }
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
  };
  const res = await fetch(url, { ...init, headers });
  if (res.status !== 401) return res;

  // One retry with a fresh token in case the cached one expired.
  const fresh = await client.getToken(true);
  if (!fresh || fresh === token) return res;
  return fetch(url, {
    ...init,
    headers: { ...headers, Authorization: `Bearer ${fresh}` },
  });
}

export async function githubFetch(
  client: GithubClient,
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return authedFetch(client, `https://api.github.com/${path}`, init);
}

export async function listPendingPrs(
  client: GithubClient,
  label: string,
): Promise<GithubPrSummary[]> {
  const res = await githubFetch(
    client,
    `search/issues?q=repo:${repo()}+type:pr+label:${encodeURIComponent(label)}+state:open&per_page=30`,
  );
  if (!res.ok) {
    logger.error(
      { status: res.status, label },
      'GitHub search for pending PRs failed',
    );
    return [];
  }
  const data = (await res.json()) as { items?: GithubPrSummary[] };
  return data.items || [];
}

export interface GithubPrSummary {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  created_at: string;
  body?: string | null;
}

export async function getPr(
  client: GithubClient,
  prNumber: number,
): Promise<GithubPrSummary | null> {
  const res = await githubFetch(client, `repos/${repo()}/pulls/${prNumber}`);
  if (!res.ok) return null;
  const data = (await res.json()) as GithubPrSummary & { merged?: boolean };
  return data;
}

export async function fetchPIsForPR(
  client: GithubClient,
  prNumber: number,
): Promise<ParsedPi[] | null> {
  const filesRes = await githubFetch(
    client,
    `repos/${repo()}/pulls/${prNumber}/files`,
  );
  if (!filesRes.ok) {
    logger.error(
      { status: filesRes.status, prNumber },
      'GitHub PR files API failed',
    );
    return null;
  }
  const files = (await filesRes.json()) as Array<{
    filename: string;
    raw_url: string;
  }>;

  const rfcDir = loadPiConfig().rfcDir.replace(/\/$/, '') + '/';
  const rfcFiles = files.filter(
    (f) =>
      f.filename.startsWith(rfcDir) &&
      f.filename.endsWith('.md') &&
      !f.filename.includes('/shipped/'),
  );

  const allPis: ParsedPi[] = [];
  for (const file of rfcFiles) {
    const rawUrl = toRawContentUrl(file.raw_url);
    const contentRes = await authedFetch(client, rawUrl, { method: 'GET' });
    if (!contentRes.ok) {
      logger.warn(
        { filename: file.filename, status: contentRes.status },
        'Failed to fetch RFC content',
      );
      continue;
    }
    const markdown = await contentRes.text();
    const rfcSlug = file.filename.split('/').pop()!.replace(/\.md$/, '');
    const pis = parsePIs(markdown, rfcSlug);
    allPis.push(...pis);
  }

  return allPis;
}

// github.com/{owner}/{repo}/raw/{sha}/{encoded_path}
// → raw.githubusercontent.com/{owner}/{repo}/{sha}/{decoded_path}
export function toRawContentUrl(rawUrl: string): string {
  const m = rawUrl.match(/github\.com\/([^/]+\/[^/]+)\/raw\/([^/]+)\/(.+)/);
  if (!m) return rawUrl;
  const [, repoSlug, sha, encodedPath] = m;
  return `https://raw.githubusercontent.com/${repoSlug}/${sha}/${decodeURIComponent(encodedPath)}`;
}

export async function swapLabels(
  client: GithubClient,
  prNumber: number,
  removeLabel: string,
  addLabel: string,
): Promise<void> {
  await githubFetch(
    client,
    `repos/${repo()}/issues/${prNumber}/labels/${encodeURIComponent(removeLabel)}`,
    'DELETE',
  );
  await githubFetch(
    client,
    `repos/${repo()}/issues/${prNumber}/labels`,
    'POST',
    { labels: [addLabel] },
  );
}

export interface PostIssueCommentResult {
  ok: boolean;
  html_url?: string;
  id?: number;
}

export async function postIssueComment(
  client: GithubClient,
  prNumber: number,
  body: string,
): Promise<PostIssueCommentResult> {
  const res = await githubFetch(
    client,
    `repos/${repo()}/issues/${prNumber}/comments`,
    'POST',
    { body },
  );
  if (!res.ok) {
    logger.error({ status: res.status, prNumber }, 'Failed to post PR comment');
    return { ok: false };
  }
  const data = (await res.json()) as { id?: number; html_url?: string };
  return { ok: true, html_url: data.html_url, id: data.id };
}

export interface IssueCommentRow {
  body: string;
  html_url: string;
  id: number;
  user?: { login?: string };
}

export async function listIssueComments(
  client: GithubClient,
  prNumber: number,
): Promise<IssueCommentRow[]> {
  const res = await githubFetch(
    client,
    `repos/${repo()}/issues/${prNumber}/comments?per_page=100`,
  );
  if (!res.ok) return [];
  return (await res.json()) as IssueCommentRow[];
}
