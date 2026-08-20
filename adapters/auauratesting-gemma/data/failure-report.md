# AuraTesting Gemma Failure Report

Generated: 2026-07-13T12:09:22.229Z
Total unique failures: 44

## Failure Modes

| Failure mode |Count |Next action |
| --- |--- |--- |
| schema_or_shape_error |10 |Add short JSON-shape examples and keep eval temperature at 0. |
| clicked_before_required_input |8 |Prefer empty required inputs and disabled-button unlock paths before submit. |
| eval_assertion_failure |6 |Review case-specific prompt wording and add one focused counterexample. |
| repeat_previous_or_failed_action |6 |Keep FAILED ACTIONS MEMORY visible and add older-history repeats. |
| generic_home_over_specific_content |5 |Add hard negatives where home/back/dashboard loses to specific content. |
| missed_real_runtime_bug |5 |Pair each real console/network error with a concise detected_bugs item. |
| combined_or_wrong_form_action |1 |Review examples for this mode and add one focused canonical case. |
| false_positive_bug_report |1 |Add clean-log examples with detected_bugs=[]. |
| repeat_older_action |1 |Train against repeats from any previous step, not only the last step. |
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
| checkbox-after-two-required-fields |1 |

## Tags

| Tag |Count |
| --- |--- |
| quality |35 |
| forms |19 |
| bug-reporting |9 |
| auth |6 |
| anti-loop |5 |
| navigation |5 |
| finish |4 |
| upload |4 |
| coverage |3 |
| network |3 |
| schema |2 |
| async |1 |
| failed-memory |1 |
| precision |1 |
| scroll |1 |
| wait |1 |

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
