"""NanoClaw transcription sidecar.

Long-running HTTP server that keeps a faster-whisper model resident in GPU
memory. Node spawns this at startup and POSTs file paths for transcription.

Endpoints:
  GET  /health       -> {"ready": bool}
  POST /transcribe   -> {"path": "..."} -> {"text", "duration", "language"}

Env:
  WHISPER_MODEL   (default: large-v3-turbo)
  WHISPER_DEVICE  (default: cuda)
  WHISPER_COMPUTE (default: float16)
  WHISPER_PORT    (default: 3003)
"""

import json
import logging
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("transcribe")

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")
PORT = int(os.environ.get("WHISPER_PORT", "3003"))

MAX_DURATION_SEC = 4 * 60 * 60
MAX_FILE_BYTES = 500 * 1024 * 1024

_model = None
_model_lock = threading.Lock()
_ready = threading.Event()


def load_model() -> None:
    global _model
    log.info("Loading %s on %s (%s)", MODEL_NAME, DEVICE, COMPUTE_TYPE)
    t0 = time.time()
    _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    log.info("Model loaded in %.1fs", time.time() - t0)
    _ready.set()


def transcribe(path: str, initial_prompt: str | None = None) -> dict:
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    size = os.path.getsize(path)
    if size > MAX_FILE_BYTES:
        raise ValueError(f"file too large: {size} bytes (max {MAX_FILE_BYTES})")

    with _model_lock:
        t0 = time.time()
        # VAD tuned to keep short utterances (default threshold=0.5 /
        # min_silence=2000ms clips single-syllable words at phrase boundaries).
        segments, info = _model.transcribe(
            path,
            beam_size=5,
            initial_prompt=initial_prompt,
            vad_filter=True,
            vad_parameters={
                "threshold": 0.3,
                "min_silence_duration_ms": 500,
            },
        )
        if info.duration > MAX_DURATION_SEC:
            raise ValueError(
                f"audio too long: {info.duration:.0f}s (max {MAX_DURATION_SEC}s)"
            )
        # One line per segment. faster-whisper segments on natural pauses,
        # which usually correlate with sentence or speaker-change boundaries.
        # True speaker diarization (pyannote) is a TODO — see CLAUDE notes.
        text = "\n".join(seg.text.strip() for seg in segments if seg.text.strip())
        elapsed = time.time() - t0
        log.info(
            "transcribed %.1fs audio in %.1fs (%.1fx realtime) lang=%s",
            info.duration, elapsed, info.duration / max(elapsed, 0.001), info.language,
        )
        return {
            "text": text,
            "duration": info.duration,
            "language": info.language,
            "language_probability": info.language_probability,
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet default access log
        return

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ready": _ready.is_set(), "model": MODEL_NAME})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        if not _ready.is_set():
            self._json(503, {"error": "model not ready"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        path = body.get("path")
        prompt = body.get("prompt")
        if not isinstance(path, str) or not path:
            self._json(400, {"error": "missing path"})
            return
        try:
            result = transcribe(path, initial_prompt=prompt)
            self._json(200, result)
        except FileNotFoundError:
            self._json(404, {"error": "file not found"})
        except ValueError as e:
            self._json(413, {"error": str(e)})
        except Exception as e:  # faster-whisper / CTranslate2 errors
            log.exception("transcription failed")
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main() -> None:
    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log.info("listening on 127.0.0.1:%d", PORT)

    def shutdown(*_):
        log.info("shutting down")
        # server.shutdown() blocks waiting for serve_forever to exit, but
        # the signal handler runs on the same thread as serve_forever —
        # so call it from a worker thread to avoid deadlock.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    server.serve_forever()
    log.info("stopped")


if __name__ == "__main__":
    main()
