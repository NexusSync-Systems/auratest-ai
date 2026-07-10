#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ADAPTER_DIR="$ROOT_DIR/adapters/auauratesting-gemma"
DATA_DIR="$ADAPTER_DIR/finetune/mlx-data"
OUTPUT_DIR="${OUTPUT_DIR:-$ADAPTER_DIR/finetune/output/lowram-lora}"
VENV_PYTHON="$ADAPTER_DIR/finetune/.venv/bin/python"

MODEL_ID="${MODEL_ID:-mlx-community/gemma-2-2b-it-4bit}"
TEST_BATCHES="${TEST_BATCHES:--1}"
MAX_SEQ_LENGTH="${MAX_SEQ_LENGTH:-2048}"

PYTHON_BIN="${PYTHON_BIN:-python}"
if [ -x "$VENV_PYTHON" ]; then
  PYTHON_BIN="$VENV_PYTHON"
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "python was not found. Run adapters/auauratesting-gemma/finetune/setup-mlx-venv.sh first." >&2
  exit 1
fi

if [ ! -d "$OUTPUT_DIR" ]; then
  echo "Missing adapter output $OUTPUT_DIR. Run train-lowram.sh first." >&2
  exit 1
fi

"$PYTHON_BIN" -m mlx_lm lora \
  --model "$MODEL_ID" \
  --data "$DATA_DIR" \
  --adapter-path "$OUTPUT_DIR" \
  --test \
  --test-batches "$TEST_BATCHES" \
  --max-seq-length "$MAX_SEQ_LENGTH"
