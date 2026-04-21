#!/usr/bin/env bash
# Launch the transcription sidecar with CUDA libs on LD_LIBRARY_PATH.
# Node's transcription.ts spawns this — do not invoke directly except for debugging.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if [ ! -d .venv ]; then
  echo "venv missing, run ./setup.sh first" >&2
  exit 1
fi

SP=".venv/lib/python3.12/site-packages"
export LD_LIBRARY_PATH="$HERE/$SP/nvidia/cublas/lib:$HERE/$SP/nvidia/cudnn/lib:$HERE/$SP/nvidia/cuda_nvrtc/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

exec .venv/bin/python server.py
