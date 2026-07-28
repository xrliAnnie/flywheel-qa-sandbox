# Design Review — FLY-1505 plan.md (Round 6)

Date: 2026-07-27
Author: Codex
Status: APPROVED

## Summary

All three Round 5 findings are resolved against the current source contracts: the carrier types now compose, the no-COOL_ID fallback is part of the tested runner protocol, and T8 is correctly sequenced and included in the authoritative final-tip gate. The plan is feasible, complete enough for implementation, and preserves the approval/FSM safety boundaries without adding an unsafe recovery edge.

## What's Good (Keep)

- `settleShipAttemptFailed` now accepts the real DirectEventSink `string | null | undefined` head shape, while the marker path narrows untrusted index-signature fields before calling it.
- The null-head T8 case pins sentinel normalization at the actual carrier boundary rather than relying on a synthetic `undefined` case.
- The COOL_ID capture-failure instruction is now inside the authoritative prompt text and explicitly forbids consulting older receipts; C5 pins the fallback.
- T8 expresses repeat behavior through helper-observable values (`attempt_count` and `firstAttemptForHead`) while sink tests own alert-callback assertions.
- The RED/GREEN ordering now puts the shared helper truth table before its consumers, and the §5 FLY-1448 hard gate explicitly reruns T2–T8.
- The three-state attempt-head authority, stale A/B protection, unknown-head no-overwrite rule, direct reconciler settlement, write-before-unlink crash behavior, and boot-drain accounting remain coherent.
- The C7 same-head suppression remains narrowly scoped to the automatic stale-approved pass; explicit recovery wakes and `verify-approval` authority are unchanged.
- The 25-minute regression mapping remains honest and sufficient for prompt-driven behavior: the cross-file time-budget contract prevents the premature window, while sink/restart tests prove a premature blocked emission cannot void approval.

## Issues & Recommendations

1. **[LOW, non-blocking] Synchronize the risk-table summary with the authoritative hard gate.** Section 5 correctly says to rerun T2–T8 on FLY-1448's final tip, but the Section 7 FLY-1448 risk row still says T2–T7. Change that one summary reference to T2–T8 during implementation/document cleanup. The explicit hard gate is already correct, so this does not block implementation.

## Verdict

APPROVED — ready to implement
