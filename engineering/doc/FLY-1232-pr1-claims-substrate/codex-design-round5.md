# Design Review — FLY-1232 plan.md (Round 5)
Date: 2026-07-13
Author: Codex
Status: APPROVED

## Summary

Round 5 resolves both remaining Round 4 inconsistencies. The plan is now internally consistent with the current dispatch/adapter call graph, explicit about its observation-period recovery limits, and complete enough to implement and independently verify without inventing behavior at coding time.

## What's Good (Keep)

- `shadowContext` is now semantic-only across item 9, the Step 4 preamble, and T7; it carries edge/node/attempt context and never a caller-computed ordinal.
- `applyWorkflowShadowBatch` transactionally allocates and returns `launch_ordinal`, assigns a new ordinal to every distinct execution id, and converges only a true same-execution replay. The normative paragraph and B3 cover all three re-entry shapes.
- T1/T2/T7 retain the correct pre-launch atomic boundary: lifecycle events, projections, and `intent_recorded` land together after execution-id allocation and before CommDB pre-registration or `Blueprint.run()`.
- T8 now names both honest recovery gaps—wake-class fine-grained moments and repeated keep-alive T4 completions—while preserving deterministic repair for reconstructible facts.
- The side-effect row is now the sole state audit. `committed_at`, `started_at`, and `abandoned_at` preserve transition timing without inventing a `workflow_run_event` kind or overloading lifecycle vocabulary.
- Subsequent side-effect advances remain inside `applyWorkflowShadowBatch` but update only the ledger state and corresponding timestamp; T1/T2/T7 creation remains atomically coupled to `node_dispatched`.
- B6 and B9 now align cleanly with the implementation contract: there is no alternate state-write surface and no out-of-vocabulary event requirement.
- The previously approved safety structure remains intact: default-off optional injection, dual-evidence `started`, fail-loud/non-blocking shadow errors, active-run uniqueness, claim-backed T9 repair, crash/replay tests, and real-machine flag-ON verification.

## Issues & Recommendations

No blocking issues. Implement the plan as written and preserve the transition table and acceptance matrix as the code-review checklist.

## Verdict

APPROVED — ready to implement
