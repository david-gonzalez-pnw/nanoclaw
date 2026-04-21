import { ChildProcess, spawn } from 'child_process';
import path from 'path';

import {
  TRANSCRIPTION_DEVICE,
  TRANSCRIPTION_ENABLED,
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_PORT,
  TRANSCRIPTION_STARTUP_TIMEOUT,
} from './config.js';
import { logger } from './logger.js';

// We spawn the Python sidecar as a child process and talk to it over localhost
// HTTP. The sidecar keeps a faster-whisper model resident in GPU memory so
// per-request latency is ~realtime/30 on an RTX 5090. Spawning Python per
// request would add ~40s model-load cost every time; not acceptable.

const SIDECAR_DIR = path.resolve(process.cwd(), 'transcription-service');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'start.sh');
const HEALTH_URL = `http://127.0.0.1:${TRANSCRIPTION_PORT}/health`;
const TRANSCRIBE_URL = `http://127.0.0.1:${TRANSCRIPTION_PORT}/transcribe`;

let child: ChildProcess | undefined;
let readyPromise: Promise<boolean> | undefined;

export interface TranscriptionResult {
  text: string;
  duration: number;
  language: string;
}

export function isTranscriptionEnabled(): boolean {
  return TRANSCRIPTION_ENABLED;
}

/**
 * Spawn the Python sidecar. Resolves true when /health reports ready, false
 * on timeout or spawn failure. Safe to call multiple times — returns the
 * existing promise if startup is already in progress.
 */
export function startTranscriptionService(): Promise<boolean> {
  if (!TRANSCRIPTION_ENABLED) return Promise.resolve(false);
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    try {
      child = spawn(SIDECAR_SCRIPT, [], {
        cwd: SIDECAR_DIR,
        env: {
          ...process.env,
          WHISPER_PORT: String(TRANSCRIPTION_PORT),
          WHISPER_MODEL: TRANSCRIPTION_MODEL,
          WHISPER_DEVICE: TRANSCRIPTION_DEVICE,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to spawn transcription sidecar');
      return false;
    }

    child.stderr?.on('data', (buf: Buffer) => {
      // Sidecar logs (pino-equivalent) — forward at debug to keep them visible
      // without flooding info. Look for error patterns explicitly.
      const line = buf.toString().trimEnd();
      if (!line) return;
      if (/error|traceback|fail/i.test(line)) {
        logger.warn({ source: 'transcription' }, line);
      } else {
        logger.debug({ source: 'transcription' }, line);
      }
    });

    child.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'Transcription sidecar exited');
      child = undefined;
      readyPromise = undefined;
    });

    // Poll /health until ready or timeout.
    const deadline = Date.now() + TRANSCRIPTION_STARTUP_TIMEOUT;
    while (Date.now() < deadline) {
      if (!child || child.exitCode !== null) {
        logger.warn('Transcription sidecar exited during startup');
        return false;
      }
      try {
        const res = await fetch(HEALTH_URL);
        if (res.ok) {
          const body = (await res.json()) as { ready: boolean };
          if (body.ready) {
            logger.info(
              { model: TRANSCRIPTION_MODEL, device: TRANSCRIPTION_DEVICE },
              'Transcription sidecar ready',
            );
            return true;
          }
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    logger.warn('Transcription sidecar failed to become ready before timeout');
    return false;
  })();

  return readyPromise;
}

export async function stopTranscriptionService(): Promise<void> {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const c = child;
    if (!c) return resolve();
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      resolve();
    }, 5000);
    c.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Transcribe an audio file at an absolute host path.
 * Returns null if the sidecar is disabled, not ready, or the request fails —
 * callers should degrade gracefully (e.g. pass a placeholder to the agent).
 */
export async function transcribeAudioFile(
  absolutePath: string,
): Promise<TranscriptionResult | null> {
  if (!TRANSCRIPTION_ENABLED) return null;

  try {
    const res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absolutePath }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn(
        { status: res.status, body: body.slice(0, 500) },
        'Transcription request failed',
      );
      return null;
    }

    const data = (await res.json()) as TranscriptionResult;
    return data;
  } catch (err) {
    logger.warn({ err }, 'Transcription request error');
    return null;
  }
}
