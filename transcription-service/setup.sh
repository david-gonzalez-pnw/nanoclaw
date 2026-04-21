#!/usr/bin/env bash
# Create .venv for the transcription sidecar and install dependencies.
# Uses `uv` if available (installs it if not), since python3-venv may be missing.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if ! command -v uv >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    echo "Installing uv (Python package manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

if [ ! -d .venv ]; then
  echo "Creating .venv with uv..."
  uv venv .venv --python 3.12
fi

echo "Installing requirements..."
uv pip install --python .venv/bin/python -r requirements.txt

echo "Done. Model will auto-download on first /transcribe call."
