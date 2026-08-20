# AuraTesting Gemma Failure Report

Generated: 2026-07-13T17:45:46.412Z
Total unique failures: 38

## Failure Modes

| Failure mode |Count |Next action |
| --- |--- |--- |
| eval_assertion_failure |13 |Review case-specific prompt wording and add one focused counterexample. |
| clicked_before_required_input |8 |Prefer empty required inputs and disabled-button unlock paths before submit. |
| repeat_previous_or_failed_action |8 |Keep FAILED ACTIONS MEMORY visible and add older-history repeats. |
| generic_home_over_specific_content |5 |Add hard negatives where home/back/dashboard loses to specific content. |
| missed_real_runtime_bug |4 |Pair each real console/network error with a concise detected_bugs item. |

## Top Cases

| Case |Count |
| --- |--- |
| avoid-disabled-submit-use-input |1 |
| avoid-older-repeated-action-not-only-last |1 |
| checkbox-after-two-required-fields |1 |
| console-error-report-but-open-visible-detail |1 |
| console-error-reported-once |1 |
| console-error-with-clean-network-report-and-continue |1 |
| disabled-submit-with-two-empty-fields |1 |
| do-not-click-disabled-submit-after-history |1 |
| do-not-click-submit-before-required-inputs |1 |
| do-not-copy-reasoning-into-detected-bugs |1 |
| do-not-repeat-broken-refresh-open-detail |1 |
| do-not-retype-filled-input-use-empty-password |1 |

## Tags

| Tag |Count |
| --- |--- |
| quality |26 |
| forms |16 |
| anti-loop |8 |
| bug-reporting |8 |
| coverage |8 |
| navigation |4 |
| network |4 |
| schema |4 |
| auth |3 |
| upload |3 |
| async |2 |
| finish |2 |
| scroll |2 |
| wait |2 |
| failed-memory |1 |
| modal |1 |
| search |1 |

## Missing Schema Keys

_No records._

## Low-RAM Guidance

- Keep `gemma2:2b`, `num_ctx 4096`, and deterministic eval settings.
- Prefer compact hard-negative preference pairs over a larger model.
- Re-run `eval:llm:capture`, `dataset:failures:normalize`, `dataset:preferences`, and this report after each prompt/data iteration.
