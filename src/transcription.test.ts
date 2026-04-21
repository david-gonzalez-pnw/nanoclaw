import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  TRANSCRIPTION_ENABLED: true,
  TRANSCRIPTION_PORT: 13003,
  TRANSCRIPTION_MODEL: 'tiny',
  TRANSCRIPTION_DEVICE: 'cpu',
  TRANSCRIPTION_STARTUP_TIMEOUT: 5000,
}));

// Mock child_process.spawn — tests don't launch the real sidecar.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

import {
  transcribeAudioFile,
  isTranscriptionEnabled,
  startTranscriptionService,
} from './transcription.js';

describe('transcription', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    spawnMock.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('transcribeAudioFile', () => {
    it('returns the transcript when the sidecar responds 200', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ text: 'hello world', duration: 1.5, language: 'en' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ) as any,
      );

      const result = await transcribeAudioFile('/tmp/audio.m4a');

      expect(result).toEqual({
        text: 'hello world',
        duration: 1.5,
        language: 'en',
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:13003/transcribe',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/tmp/audio.m4a' }),
        }),
      );
    });

    it('returns null when the sidecar returns non-200', async () => {
      fetchSpy.mockResolvedValue(
        new Response('server error', { status: 500 }) as any,
      );

      const result = await transcribeAudioFile('/tmp/audio.m4a');

      expect(result).toBeNull();
    });

    it('returns null when fetch throws (sidecar unreachable)', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await transcribeAudioFile('/tmp/audio.m4a');

      expect(result).toBeNull();
    });
  });

  describe('isTranscriptionEnabled', () => {
    it('reflects the config flag', () => {
      expect(isTranscriptionEnabled()).toBe(true);
    });
  });

  describe('startTranscriptionService', () => {
    it('resolves true when /health eventually reports ready', async () => {
      const fakeChild = {
        stderr: { on: vi.fn() },
        on: vi.fn(),
        exitCode: null,
        kill: vi.fn(),
      };
      spawnMock.mockReturnValue(fakeChild);
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ready: true, model: 'tiny' }), {
          status: 200,
        }) as any,
      );

      const ready = await startTranscriptionService();

      expect(ready).toBe(true);
      expect(spawnMock).toHaveBeenCalled();
    });

    it('returns the same promise on concurrent calls (singleton)', async () => {
      const fakeChild = {
        stderr: { on: vi.fn() },
        on: vi.fn(),
        exitCode: null,
        kill: vi.fn(),
      };
      spawnMock.mockReturnValue(fakeChild);
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ ready: true, model: 'tiny' }), {
          status: 200,
        }) as any,
      );

      const a = startTranscriptionService();
      const b = startTranscriptionService();
      expect(a).toBe(b);
      await a;
    });
  });
});
