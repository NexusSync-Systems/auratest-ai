# AuraTesting Gemma Adapter

This adapter is isolated from other local AI training work. Keep all tester-specific prompts, evals, datasets, and model files under this directory.

## Low-RAM Policy

Use `gemma2:2b` for this Mac unless a larger model is explicitly requested.

Current low-RAM settings:

- `FROM gemma2:2b`
- `num_ctx 4096`
- `num_predict 384`
- short `system-prompt.txt`
- runtime sanitization in `agent.js` handles safety-critical corrections

Do not switch this adapter to `gemma2:9b` on a low-RAM machine.

## Commands

```bash
npm run adapter:gemma:create
npm run eval:llm:offline -- --strict
npm run eval:llm -- --model auauratesting-gemma --tag quality --timeout-ms 30000 --verbose
npm run eval:llm:capture
npm run dataset:failures:normalize
npm run dataset:failures:report
npm run dataset:sanitizer:coverage
npm run dataset:preferences
npm run dataset:sft
npm run dataset:candidates
npm run finetune:mlx:prepare
```

## Files

- `Modelfile`: Ollama adapter model definition.
- `system-prompt.txt`: short eval/runtime-compatible system prompt.
- `eval-cases.jsonl`: gold eval cases.
- `data/auratest-gemma-sft.jsonl`: supervised fine-tuning records.
- `data/training-candidates.jsonl`: mined review candidates from local sessions/generated scripts.
- `model-failures.jsonl`: captured rejected model outputs for preference training.
- `data/failure-report.md`: aggregate failure-mode report for the local adapter.
- `data/sanitizer-coverage.md`: report of which captured failures are already repaired by runtime sanitization.
- `data/auratest-gemma-preferences.jsonl`: chosen/rejected preference records.
- `data/training-candidates-summary.json`: aggregate failure-mode counts.
- `finetune/`: optional MLX LoRA fine-tuning workflow for Mac.

## Current 2B Limitation

The 2B model is fast enough for this Mac, but it still fails some quality eval cases by itself. Product quality is protected by `sanitizeActionResponse()` in `agent.js`, while this adapter dataset is the source for future fine-tuning or further local prompt iterations.

## Optional Fine-Tuning

Prepare local MLX data without installing anything:

```bash
npm run finetune:mlx:prepare
```

Do not run `npm run finetune:mlx:train:lowram` until you are ready to install `mlx-lm`, download the base model, and watch memory pressure.
