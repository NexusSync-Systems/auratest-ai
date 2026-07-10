#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VENV_DIR="$ROOT_DIR/adapters/auauratesting-gemma/finetune/.venv"
PYTHON_BIN="${PYTHON_BIN:-python3.11}"
MLX_LM_VERSION="${MLX_LM_VERSION:-0.29.1}"
TRANSFORMERS_SPEC="${TRANSFORMERS_SPEC:-transformers<5}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "$PYTHON_BIN was not found. Install Python 3.11 first or set PYTHON_BIN=/path/to/python." >&2
  exit 1
fi

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install -U pip
"$VENV_DIR/bin/python" -m pip install "mlx-lm==$MLX_LM_VERSION" "$TRANSFORMERS_SPEC"

echo "MLX fine-tune venv is ready: $VENV_DIR"
echo "Verify with: $VENV_DIR/bin/python -m mlx_lm lora --help"
