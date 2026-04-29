import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { runContainerAgent } from '../../container-runner.js';
import { getAllRegisteredGroups } from '../../db.js';
import { logger } from '../../logger.js';
import { loadPiConfig } from './config.js';
import type { GithubClient } from './github.js';
import { getPr } from './github.js';
import {
  buildResolutionPayload,
  writeResolutionPayload,
} from './payload.js';

export interface FinalizeResult {
  ok: boolean;
  sha?: string | null;
  applied?: number;
  skipped?: number;
  reason?: string;
  details?: string;
}

const RESULT_LINE_RE = /\{\s*"type"\s*:\s*"pi-finalize-result"[\s\S]*?\}/m;

/**
 * Spawn a one-shot container agent to run the `commit-pi-decisions` skill
 * for the given PR. The agent edits the RFC files in place, commits, and
 * pushes to the PR's head branch. Returns the parsed result line emitted
 * by the skill on stdout.
 *
 * Picks a registered group whose folder matches `PI_FINALIZE_GROUP`. That
 * group must have a writable mount of the watched repo configured.
 */
export async function runCommitPiDecisions(args: {
  github: GithubClient;
  prNumber: number;
  commentUrl: string | null;
}): Promise<FinalizeResult> {
  const { prNumber, commentUrl, github } = args;
  const cfg = loadPiConfig();

  // Feature gate: skill writes to a real PR branch, so opt-in only.
  if (!cfg.commitDecisionsEnabled) {
    return {
      ok: false,
      reason: 'commit-decisions-disabled',
      details:
        'Set PI_COMMIT_DECISIONS=true in .env to enable RFC commit-back. Until then, the GitHub comment + Slack announcement remain the resolution record.',
    };
  }

  // 1. Resolve which group to spawn under (must have the watched repo
  // mounted writable).
  const targetFolder = cfg.finalizeGroup;
  if (!targetFolder) {
    return {
      ok: false,
      reason: 'no-finalize-group-configured',
      details:
        'PI_FINALIZE_GROUP is not set. Point it at a registered group that mounts the watched repo writable.',
    };
  }
  const groups = getAllRegisteredGroups();
  const groupEntry = Object.entries(groups).find(
    ([, g]) => g.folder === targetFolder,
  );
  if (!groupEntry) {
    return {
      ok: false,
      reason: 'no-finalize-group',
      details: `No registered group with folder "${targetFolder}". Set PI_FINALIZE_GROUP to a group that mounts the watched repo writable.`,
    };
  }
  const [chatJid, group] = groupEntry;

  // 2. Look up the PR's head ref so the skill can checkout the right branch.
  const pr = await getPr(github, prNumber);
  const prHeadRef = (pr as { head?: { ref?: string } } | null)?.head?.ref;
  if (!pr || !prHeadRef) {
    return {
      ok: false,
      reason: 'pr-fetch-failed',
      details: `Could not fetch head ref for PR #${prNumber}`,
    };
  }
  if (pr.state === 'closed') {
    // PR closed/merged — nothing to commit to. Treat as a no-op success so
    // the writeback loop stops retrying.
    return {
      ok: true,
      sha: null,
      applied: 0,
      skipped: 0,
      reason: 'pr-closed',
    };
  }

  // 3. Resolve the repo mount path inside the container by inspecting the
  //    group's container_config additionalMounts. The mount whose host path
  //    matches the cwd of the watched repo (or the first writable mount)
  //    becomes /workspace/extra/<containerPath>.
  const mounts = group.containerConfig?.additionalMounts || [];
  const writableMounts = mounts.filter((m) => m.readonly !== true);
  if (writableMounts.length === 0) {
    return {
      ok: false,
      reason: 'no-writable-mount',
      details: `Group "${targetFolder}" has no writable additionalMounts; nothing to edit.`,
    };
  }
  // Prefer a mount whose containerPath matches the repo name (last "/"
  // segment of cfg.githubRepo). Fall back to the first writable mount.
  const repoName = cfg.githubRepo.split('/').pop() || '';
  const chosenMount =
    writableMounts.find(
      (m) => (m.containerPath || repoName).split('/').pop() === repoName,
    ) || writableMounts[0];
  const containerPathSegment =
    chosenMount.containerPath ||
    chosenMount.hostPath.split('/').pop() ||
    repoName;
  const repoMountPath = `/workspace/extra/${containerPathSegment.replace(/^\//, '')}`;

  // 4. Build + write the resolution payload into the group's folder so the
  //    container sees it at /workspace/group/pi-resolutions/<PR>.json.
  const payload = buildResolutionPayload({
    prNumber,
    prHeadRef,
    repoMountPath,
    commentUrl,
  });
  if (payload.decisions.length === 0) {
    return {
      ok: true,
      sha: null,
      applied: 0,
      skipped: 0,
      reason: 'no-decisions-to-commit',
    };
  }
  const payloadPath = writeResolutionPayload(group.folder, payload);
  logger.info(
    { prNumber, payloadPath, decisions: payload.decisions.length },
    'Wrote PI resolution payload',
  );

  // 5. Spawn the container with a prompt that invokes the skill.
  const prompt = [
    `Use the commit-pi-decisions skill to lock in the resolved Product Input decisions for PR ${prNumber}.`,
    `The resolution payload is at /workspace/group/pi-resolutions/${prNumber}.json.`,
    `The watched repo is mounted writable at ${repoMountPath}. The PR's head branch is "${prHeadRef}" — check it out there before editing.`,
    `Follow the skill exactly: edit each RFC's PI block, commit with the prescribed message, push to origin, and emit a single pi-finalize-result JSON line as your last output.`,
  ].join('\n');

  const synthThreadId = `pi-finalize-${prNumber}`;
  let lastResult: string | null = null;

  // The container's agent-runner sits in an IPC poll loop after emitting
  // its result, waiting for follow-up messages until IDLE_TIMEOUT (30 min).
  // For our one-shot, that's a long wait. Write the `_close` sentinel as
  // soon as we capture a non-empty result so the container exits promptly.
  const closeSentinelDir = path.join(
    DATA_DIR,
    'ipc',
    group.folder,
    'threads',
    synthThreadId.replace(/\./g, '-'),
    'input',
  );
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      try {
        fs.mkdirSync(closeSentinelDir, { recursive: true });
        fs.writeFileSync(path.join(closeSentinelDir, '_close'), '');
        logger.debug({ prNumber }, 'Wrote close sentinel for finalize container');
      } catch (err) {
        logger.warn({ err, prNumber }, 'Failed to write close sentinel');
      }
    }, 5000);
  };

  try {
    const out = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: undefined,
        groupFolder: group.folder,
        chatJid,
        isMain: group.isMain === true,
        isScheduledTask: true,
        threadId: synthThreadId,
      },
      () => {
        /* no host-side process tracking needed */
      },
      async (streamed) => {
        if (streamed.result) {
          lastResult = streamed.result;
          scheduleClose();
        }
        if (streamed.status === 'success') scheduleClose();
      },
    );
    if (closeTimer) clearTimeout(closeTimer);
    if (out.status === 'error') {
      return {
        ok: false,
        reason: 'container-error',
        details: out.error || 'unknown',
      };
    }
    if (out.result) lastResult = out.result;
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn-failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. Parse the result line. The skill emits one JSON object on stdout.
  if (!lastResult) {
    return {
      ok: false,
      reason: 'no-result-emitted',
      details: 'Container exited cleanly but never emitted a pi-finalize-result line',
    };
  }
  const match = lastResult.match(RESULT_LINE_RE);
  if (!match) {
    return {
      ok: false,
      reason: 'unparseable-result',
      details: lastResult.slice(0, 500),
    };
  }
  try {
    const parsed = JSON.parse(match[0]) as FinalizeResult & { type?: string };
    return parsed;
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-result-json',
      details: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Best-effort cleanup of the payload file. The skill should also
    // delete it on success; this is the safety net.
    try {
      fs.unlinkSync(payloadPath);
    } catch {
      /* ignore */
    }
  }
}
