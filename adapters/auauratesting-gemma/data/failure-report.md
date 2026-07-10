# AuraTesting Gemma Failure Report

Generated: 2026-07-10T05:05:35.746Z
Total unique failures: 27

## Failure Modes

| Failure mode |Count |Next action |
| --- |--- |--- |
| schema_or_shape_error |9 |Add short JSON-shape examples and keep eval temperature at 0. |
| eval_assertion_failure |4 |Review case-specific prompt wording and add one focused counterexample. |
| generic_home_over_specific_content |4 |Add hard negatives where home/back/dashboard loses to specific content. |
| clicked_before_required_input |3 |Prefer empty required inputs and disabled-button unlock paths before submit. |
| missed_real_runtime_bug |3 |Pair each real console/network error with a concise detected_bugs item. |
| combined_or_wrong_form_action |1 |Review examples for this mode and add one focused canonical case. |
| repeat_older_action |1 |Train against repeats from any previous step, not only the last step. |
| repeat_previous_or_failed_action |1 |Keep FAILED ACTIONS MEMORY visible and add older-history repeats. |
| submit_or_wrong_click_before_inputs |1 |Add multi-step form cases showing one action per turn. |

## Top Cases

| Case |Count |
| --- |--- |
| do-not-click-submit-before-required-inputs |3 |
| finish-when-goal-complete-and-clean |3 |
| login-fill-password-after-email |3 |
| prefer-specific-content-over-home |3 |
| avoid-disabled-submit-use-input |2 |
| network-500-report-and-retry |2 |
| report-network-error-but-continue-with-local-click |2 |
| required-checkbox-before-submit |2 |
| upload-file-input-before-submit |2 |
| article-after-scroll |1 |
| avoid-older-repeated-action-not-only-last |1 |
| console-error-with-clean-network-report-and-continue |1 |

## Tags

| Tag |Count |
| --- |--- |
| quality |22 |
| forms |12 |
| auth |5 |
| bug-reporting |5 |
| finish |3 |
| coverage |2 |
| navigation |2 |
| network |2 |
| upload |2 |

## Missing Schema Keys

| Missing key |Count |
| --- |--- |
| detected_bugs |9 |
| action |2 |
| target |2 |
| value |1 |

## Low-RAM Guidance

- Keep `gemma2:2b`, `num_ctx 4096`, and deterministic eval settings.
- Prefer compact hard-negative preference pairs over a larger model.
- Re-run `eval:llm:capture`, `dataset:failures:normalize`, `dataset:preferences`, and this report after each prompt/data iteration.
