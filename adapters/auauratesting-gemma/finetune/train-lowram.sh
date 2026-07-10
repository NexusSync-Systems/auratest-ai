#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ADAPTER_DIR="$ROOT_DIR/adapters/auauratesting-gemma"
DATA_DIR="$ADAPTER_DIR/finetune/mlx-data"
OUTPUT_DIR="${OUTPUT_DIR:-$ADAPTER_DIR/finetune/output/lowram-lora}"
VENV_PYTHON="$ADAPTER_DIR/finetune/.venv/bin/python"

MODEL_ID="${MODEL_ID:-mlx-community/gemma-2-2b-it-4bit}"
ITERS="${ITERS:-40}"
BATCH_SIZE="${BATCH_SIZE:-1}"
LORA_LAYERS="${LORA_LAYERS:-8}"
LEARNING_RATE="${LEARNING_RATE:-5e-6}"
STEPS_PER_REPORT="${STEPS_PER_REPORT:-5}"
STEPS_PER_EVAL="${STEPS_PER_EVAL:-10}"
MAX_SEQ_LENGTH="${MAX_SEQ_LENGTH:-2048}"
SAVE_EVERY="${SAVE_EVERY:-20}"

PYTHON_BIN="${PYTHON_BIN:-python}"
if [ -x "$VENV_PYTHON" ]; then
  PYTHON_BIN="$VENV_PYTHON"
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "python was not found. Run adapters/auauratesting-gemma/finetune/setup-mlx-venv.sh first." >&2
  exit 1
fi

if [ ! -f "$DATA_DIR/train.jsonl" ]; then
  echo "Missing $DATA_DIR/train.jsonl. Run: npm run finetune:mlx:prepare" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "Starting low-RAM MLX LoRA training"
echo "  model:       $MODEL_ID"
echo "  data:        $DATA_DIR"
echo "  output:      $OUTPUT_DIR"
echo "  iters:       $ITERS"
echo "  batch size:  $BATCH_SIZE"
echo "  lora layers: $LORA_LAYERS"

"$PYTHON_BIN" -m mlx_lm lora \
  --model "$MODEL_ID" \
  --train \
  --data "$DATA_DIR" \
  --adapter-path "$OUTPUT_DIR" \
  --iters "$ITERS" \
  --batch-size "$BATCH_SIZE" \
  --num-layers "$LORA_LAYERS" \
  --learning-rate "$LEARNING_RATE" \
  --steps-per-report "$STEPS_PER_REPORT" \
  --steps-per-eval "$STEPS_PER_EVAL" \
  --max-seq-length "$MAX_SEQ_LENGTH" \
  --save-every "$SAVE_EVERY" \
  --grad-checkpoint
