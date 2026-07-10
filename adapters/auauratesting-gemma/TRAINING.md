# AuraTesting Gemma Training Notes

## Current Strategy

Stay on `gemma2:2b` for low-RAM Mac usage. Do not use `gemma2:9b` unless explicitly approved.

Quality is improved through three layers:

1. Gold eval/SFT examples in `eval-cases.jsonl`.
2. Preference pairs in `model-failures.jsonl` and `data/auratest-gemma-preferences.jsonl`.
3. Runtime protection in `agent.js` via `sanitizeActionResponse()`.

## Current Datasets

- Current eval cases: 32
- SFT: `data/auratest-gemma-sft.jsonl` (32 records)
- Captured failures: `model-failures.jsonl` (27 unique records)
- Preference: `data/auratest-gemma-preferences.jsonl` (27 records)
- Review candidates: `data/training-candidates.jsonl`

The current preference set is based on real failures from `auauratesting-gemma` on the quality eval subset.
Latest deterministic quality eval: 12/18 assertion checks passed with `gemma2:2b`.
Latest sanitizer coverage: 27/27 captured failures recovered by `sanitizeActionResponse()`.

## Known 2B Failure Modes

- Picks generic home/back links instead of specific content links.
- Sometimes tries combined actions such as `type|click`.
- Sometimes omits `detected_bugs` for real network failures.
- Can repeat an older tested action, not just the immediately previous action.

## Low-RAM Next Steps

1. Keep `num_ctx` at 4096 or lower.
2. Add more compact preference pairs rather than longer Modelfile examples.
3. Periodically run:

```bash
npm run eval:llm:capture
npm run dataset:failures:normalize
npm run dataset:failures:report
npm run dataset:sanitizer:coverage
npm run dataset:preferences
```

4. Use `npm run eval:llm -- --model auauratesting-gemma --tag quality --timeout-ms 30000 --verbose` for read-only quality checks.
5. Use the runtime sanitizer as the product safety layer until a real fine-tuned adapter is available.

## Optional MLX LoRA Fine-Tune

Prepare data:

```bash
npm run finetune:mlx:prepare
```

This creates `finetune/mlx-data/train.jsonl`, `valid.jsonl`, and `test.jsonl`.

Training is intentionally separate:

```bash
npm run finetune:mlx:train:lowram
```

Run it only after installing `mlx-lm` in a local virtual environment and confirming the Mac has enough free memory. Stop if memory pressure becomes red, swap grows aggressively, or the machine becomes unresponsive.

Do not replace the current runtime-protected `auauratesting-gemma` flow unless the fine-tuned adapter beats the current eval baseline.
