import { ChildProcess, spawn } from 'child_process';
import http from 'http';
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
// Node's fetch (undici) defaults to a 30s headers timeout. Larger whisper
// models run at roughly real-time on GPU, so a multi-minute clip can easily
// blow past that. Sidecar itself caps audio at 4h, so 15 min is a safe ceiling.
const TRANSCRIBE_FETCH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * No-timeout variant for the async transcription worker. Long audio can take
 * hours on large-v3, and the worker has its own per-job soft timeout + cancel
 * mechanism, so imposing a fetch-level abort would be counterproductive.
 *
 * Built on Node's `http` module instead of `fetch` because undici (which
 * backs fetch) enforces a 5-minute `headersTimeout` that cannot be disabled
 * without installing undici as a direct dep and passing a custom dispatcher.
 * For a loopback call to a trusted sidecar, raw `http` is simpler and has no
 * implicit timers.
 */
export function transcribeAudioFileAsync(
  absolutePath: string,
  signal?: AbortSignal,
): Promise<TranscriptionResult | { error: string }> {
  if (!TRANSCRIPTION_ENABLED) {
    return Promise.resolve({ error: 'transcription disabled' });
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ path: absolutePath });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: TRANSCRIPTION_PORT,
        path: '/transcribe',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode >= 400) {
            resolve({
              error: `sidecar HTTP ${res.statusCode ?? '??'}: ${text.slice(0, 200)}`,
            });
            return;
          }
          try {
            resolve(JSON.parse(text) as TranscriptionResult);
          } catch (err) {
            resolve({
              error: `invalid sidecar response: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        });
      },
    );

    // Disable all implicit timeouts — the sidecar may hold the request open
    // for hours on long audio. Worker-level soft timeout + AbortSignal handle
    // the escape hatches.
    req.setTimeout(0);
    req.socket?.setTimeout?.(0);

    const onAbort = () => {
      req.destroy(new Error('aborted'));
      resolve({ error: 'cancelled' });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => {
      if (signal?.aborted) {
        resolve({ error: 'cancelled' });
      } else {
        resolve({ error: err.message });
      }
    });

    req.write(body);
    req.end();
  });
}

export async function transcribeAudioFile(
  absolutePath: string,
): Promise<TranscriptionResult | null> {
  if (!TRANSCRIPTION_ENABLED) return null;

  try {
    const res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absolutePath }),
      signal: AbortSignal.timeout(TRANSCRIBE_FETCH_TIMEOUT_MS),
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
