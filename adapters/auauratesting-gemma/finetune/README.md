# AuraTesting Gemma MLX Fine-Tune

This folder prepares a low-RAM LoRA fine-tune path for the isolated `auauratesting-gemma` adapter.

## Status

Prepared, not automatically trained.

The current production-safe setup is still:

1. `gemma2:2b` through Ollama.
2. Adapter prompt and eval datasets in `adapters/auauratesting-gemma/`.
3. Runtime protection through `sanitizeActionResponse()`.

Known captured model failures are currently covered by the runtime sanitizer. Fine-tuning should only be used if it beats the current eval baseline.

## Prepare Data

```bash
npm run finetune:mlx:prepare
```

This writes:

- `mlx-data/train.jsonl`
- `mlx-data/valid.jsonl`
- `mlx-data/test.jsonl`

The files use chat-style JSONL records:

```json
{"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
```

## Install MLX

Install only when ready to run the experiment:

```bash
npm run finetune:mlx:setup
```

The setup script pins `mlx-lm==0.29.1` with `transformers<5`, which was verified with Python 3.11 on this machine.

This may use network and disk space.

## Low-RAM Training

```bash
bash adapters/auauratesting-gemma/finetune/train-lowram.sh
```

The script intentionally uses conservative defaults:

- small batch size
- short iteration count
- low LoRA layer count
- low learning rate
- gradient checkpointing
- checkpoint saving during the run
- Gemma 2 2B family, not 9B

Before trusting the result, run:

```bash
npm run eval:llm:offline -- --strict
npm run eval:llm -- --model auauratesting-gemma --tag quality --timeout-ms 30000 --verbose
```

Then compare against the current baseline documented in `../TRAINING.md`.

## Stop Conditions

Stop the training attempt if:

- memory pressure becomes red,
- swap grows aggressively,
- the Mac becomes unresponsive,
- loss becomes `nan`,
- the fine-tuned adapter does not beat the current eval baseline.
