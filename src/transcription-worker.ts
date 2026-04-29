import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  claimNextTranscriptionJob,
  isTranscriptionCancelRequested,
  recoverStuckTranscriptionJobs,
  updateTranscriptionJob,
  type TranscriptionJobRow,
} from './db.js';
import { logger } from './logger.js';
import { transcribeAudioFileAsync } from './transcription.js';
import type { NewMessage } from './types.js';

const execFileP = promisify(execFile);

const POLL_INTERVAL_MS = 2_000;
const PLACEHOLDER_UPDATE_INTERVAL_MS = 60_000;

// Per-job soft timeout: max(5 min, 3× audio duration, capped at 4h).
// If ffprobe can't read duration, we fall back to the 4h cap directly.
const MIN_JOB_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export interface TranscriptionWorkerDeps {
  /** Invoked when a transcription finishes (success or fallback) to inject
   *  the synthesized message into the normal inbound pipeline. */
  onTranscribed: (jid: string, msg: NewMessage) => void;
  /** Optional: update a Slack thread placeholder with progress/status text.
   *  Worker degrades gracefully if omitted. */
  updatePlaceholder?: (
    jid: string,
    threadTs: string | null,
    text: string,
  ) => Promise<void>;
}

let running = false;
let stopRequested = false;

export function startTranscriptionWorker(deps: TranscriptionWorkerDeps): void {
  if (running) {
    logger.debug('Transcription worker already running');
    return;
  }
  const recovered = recoverStuckTranscriptionJobs();
  if (recovered > 0) {
    logger.info(
      { recovered },
      'Transcription worker: re-queued orphaned running jobs',
    );
  }
  running = true;
  stopRequested = false;
  logger.info('Transcription worker started');
  loop(deps).catch((err) => {
    logger.error({ err }, 'Transcription worker crashed');
    running = false;
  });
}

export function stopTranscriptionWorker(): void {
  stopRequested = true;
}

async function loop(deps: TranscriptionWorkerDeps): Promise<void> {
  while (!stopRequested) {
    const job = claimNextTranscriptionJob();
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    try {
      await processJob(job, deps);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'Transcription job handler threw');
      finishJob(job, deps, {
        status: 'failed',
        transcript: null,
        errorNote: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  running = false;
}

async function processJob(
  job: TranscriptionJobRow,
  deps: TranscriptionWorkerDeps,
): Promise<void> {
  logger.info(
    { jobId: job.id, chatJid: job.chat_jid, file: job.file_name },
    'Transcription job started',
  );

  const durationSec = await probeDuration(job.file_host_path);
  const jobTimeoutMs = computeJobTimeout(durationSec);

  if (durationSec != null) {
    updateTranscriptionJob(job.id, { duration_seconds: durationSec });
    job.duration_seconds = durationSec;
  }

  await safePlaceholder(
    deps,
    job,
    progressMessage({ elapsedMs: 0, durationSec, stage: 'starting' }),
  );

  const controller = new AbortController();
  const startedAt = Date.now();

  const timeoutTimer = setTimeout(() => {
    logger.warn(
      { jobId: job.id, durationSec, jobTimeoutMs },
      'Transcription job exceeded soft timeout; aborting',
    );
    controller.abort();
  }, jobTimeoutMs);

  const cancelPoller = setInterval(() => {
    if (isTranscriptionCancelRequested(job.id)) {
      logger.info({ jobId: job.id }, 'Cancel requested; aborting transcription');
      controller.abort();
    }
  }, 2_000);

  const progressTimer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    safePlaceholder(
      deps,
      job,
      progressMessage({ elapsedMs, durationSec, stage: 'running' }),
    ).catch(() => {});
  }, PLACEHOLDER_UPDATE_INTERVAL_MS);

  try {
    const result = await transcribeAudioFileAsync(
      job.file_host_path,
      controller.signal,
    );

    clearInterval(progressTimer);
    clearInterval(cancelPoller);
    clearTimeout(timeoutTimer);

    if ('error' in result) {
      const cancelled = isTranscriptionCancelRequested(job.id);
      const aborted = controller.signal.aborted;
      const timedOut = aborted && !cancelled;
      if (cancelled) {
        finishJob(job, deps, {
          status: 'cancelled',
          transcript: null,
          errorNote: 'cancelled by user',
        });
      } else if (timedOut) {
        finishJob(job, deps, {
          status: 'failed',
          transcript: null,
          errorNote: `timed out after ${formatDuration(jobTimeoutMs)}`,
        });
      } else {
        finishJob(job, deps, {
          status: 'failed',
          transcript: null,
          errorNote: result.error,
        });
      }
      return;
    }

    finishJob(job, deps, {
      status: 'completed',
      transcript: result.text,
      errorNote: null,
    });
  } finally {
    clearInterval(progressTimer);
    clearInterval(cancelPoller);
    clearTimeout(timeoutTimer);
  }
}

function finishJob(
  job: TranscriptionJobRow,
  deps: TranscriptionWorkerDeps,
  outcome: {
    status: 'completed' | 'failed' | 'cancelled';
    transcript: string | null;
    errorNote: string | null;
  },
): void {
  updateTranscriptionJob(job.id, {
    status: outcome.status,
    transcript: outcome.transcript,
    error: outcome.errorNote,
    completed_at: Date.now(),
  });

  const voiceBlock = renderVoiceBlock(outcome, job);
  const content = job.original_text
    ? `${job.original_text}\n${voiceBlock}`
    : voiceBlock;

  const msg: NewMessage = {
    id: job.message_ts,
    chat_jid: job.chat_jid,
    sender: job.sender,
    sender_name: job.sender_name,
    content,
    timestamp: job.timestamp_iso,
    is_from_me: false,
    is_bot_message: false,
    thread_ts: job.thread_ts || undefined,
  };

  try {
    deps.onTranscribed(job.chat_jid, msg);
  } catch (err) {
    logger.error(
      { err, jobId: job.id },
      'onTranscribed callback threw; message not delivered',
    );
  }

  logger.info(
    {
      jobId: job.id,
      status: outcome.status,
      textLen: outcome.transcript?.length ?? 0,
      errorNote: outcome.errorNote,
    },
    'Transcription job finished',
  );
}

function renderVoiceBlock(
  outcome: {
    status: 'completed' | 'failed' | 'cancelled';
    transcript: string | null;
    errorNote: string | null;
  },
  job: TranscriptionJobRow,
): string {
  if (outcome.status === 'completed' && outcome.transcript) {
    return `[Voice: ${outcome.transcript}]`;
  }
  const label = job.file_name ? ` (${job.file_name})` : '';
  if (outcome.status === 'cancelled') {
    return `[Voice Message${label} — transcription cancelled]`;
  }
  return `[Voice Message${label} — transcription failed: ${outcome.errorNote || 'unknown error'}]`;
}

async function probeDuration(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : null;
  } catch (err) {
    logger.debug(
      { err, path },
      'ffprobe failed; using default job timeout',
    );
    return null;
  }
}

function computeJobTimeout(durationSec: number | null): number {
  if (durationSec == null) return MAX_JOB_TIMEOUT_MS;
  const triple = durationSec * 3 * 1000;
  return Math.min(MAX_JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, triple));
}

async function safePlaceholder(
  deps: TranscriptionWorkerDeps,
  job: TranscriptionJobRow,
  text: string,
): Promise<void> {
  if (!deps.updatePlaceholder) return;
  try {
    await deps.updatePlaceholder(job.chat_jid, job.thread_ts, text);
  } catch (err) {
    logger.debug({ err, jobId: job.id }, 'Placeholder update failed');
  }
}

function progressMessage(args: {
  elapsedMs: number;
  durationSec: number | null;
  stage: 'starting' | 'running';
}): string {
  const elapsed = formatDuration(args.elapsedMs);
  if (args.stage === 'starting') {
    const dur = args.durationSec
      ? ` (audio ~${formatDuration(args.durationSec * 1000)})`
      : '';
    return `⏳ Transcribing audio${dur}…`;
  }
  const dur = args.durationSec
    ? ` of ~${formatDuration(args.durationSec * 1000)}`
    : '';
  return `⏳ Still transcribing audio${dur} — ${elapsed} elapsed…`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return s ? `${min}m ${s}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${hr}h ${m}m` : `${hr}h`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
