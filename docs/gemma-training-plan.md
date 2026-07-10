# Gemma Local Agent Training Plan

Adapter workspace: `adapters/auauratesting-gemma/`

Keep all eval data, SFT exports, candidate mining outputs, and the Ollama Modelfile for this tester inside that adapter directory. This prevents accidental mixing with training data for other local AI projects.

Low-RAM Mac constraint: keep this adapter on `gemma2:2b` unless the user explicitly asks otherwise. Prefer shorter prompts, smaller `num_ctx`, runtime guardrails, and curated examples over larger local models.

This project uses a local LLM as a JSON-only Playwright QA agent. The first training target is not broader language quality; it is reliable action selection and strict output shape.

## Current Failure Modes

1. Invalid navigation targets
   - Bad: `{"action":"navigate","target":2}`
   - Good: use `click` for `data-qa-id` numbers, or `navigate` only with full `http...` URLs.

2. Repeated action loops
   - The model repeats `click target=9` or alternates scroll actions after history says the action failed.
   - The model must inspect history and failed action memory before choosing.

3. False bug reports
   - The model copies its reasoning into `detected_bugs`.
   - If console logs and network errors are clean, `detected_bugs` must be `[]`.

4. Weak form strategy
   - Inputs should usually be tested before unrelated buttons when visible.
   - Use edge-case values from the prompt when supplied.

5. Non-JSON or schema drift
   - The app expects exactly one JSON object with:
     `reasoning`, `action`, `target`, `value`, `detected_bugs`.

## Workflow

1. Run the local eval suite against expected answers:

```bash
npm run eval:llm:offline
```

2. Run the same cases against the isolated Ollama adapter model:

```bash
npm run adapter:gemma:create
npm run eval:llm -- --model auauratesting-gemma
```

3. Improve `adapters/auauratesting-gemma/Modelfile` examples and prompts until the model passes the eval suite.

4. Export corrected eval examples into SFT-style JSONL:

```bash
npm run dataset:sft
```

5. Only after the eval suite is stable, expand the dataset with corrected examples from sessions and generated scripts.

6. Mine local sessions and generated scripts for review candidates:

```bash
npm run dataset:candidates
```

Default outputs now stay under:

- `adapters/auauratesting-gemma/data/auratest-gemma-sft.jsonl`
- `adapters/auauratesting-gemma/data/training-candidates.jsonl`
- `adapters/auauratesting-gemma/data/training-candidates-summary.json`

## Scoring Targets

For a usable local agent, the model should reach:

- `valid_json`: 100%
- `schema_ok`: 100%
- `target_ok`: 100%
- `no_repeat`: at least 95%
- `bug_precision`: at least 95%
