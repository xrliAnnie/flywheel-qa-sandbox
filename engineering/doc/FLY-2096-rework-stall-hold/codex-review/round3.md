# Design Review — plan.md (Round 3)
Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Rev4 resolves both Round 2 findings for rework-attempt versioning and alert isolation. The common rework locator is valid on both trees, main-only version assertions are correctly separated, and all M1-b/M3 episode and alert counts are now scoped to the target attempt. The gate-holder contract created by `qa_pass` is also correctly documented as unrelated live work.

One cross-tree fixture guard remains invalid: `session_started` consumes the launch attempt on both trees, but only FLY-2278 settles it and removes settled rows from `listLiveWorkflowDeliveryAttempts()`. As written, the old-tree fixture still fails before either intended positive-control tripwire.

## What's Good (Keep)

- Keep the target rework-attempt locator based on family, physical table/key, and unsuperseded status. It selects the versionless generation-1 row on `069013b25^` and the revision-2 remint on main without weakening the current-tree version assertion.
- Keep the main-only `contract_ref_json.routeRevision === 2` guard and the shared path/delivery revision-2 guards.
- Keep all episode/outbox assertions scoped by target `attempt_id` and exact `delivery_contract_stalled:<attempt_id>:` prefix. This correctly isolates the rework behavior from launch and gate-holder contracts.
- Keep the explicit gate-holder note and the post-completion assertions that check only the target rework attempt, its closed episode, and non-increasing rework-scoped alert count.
- Keep the real `session_started` event. It is the correct production-shaped way to prove launch consumption and it settles the launch attempt on main before M1-b/M3 watch passes.
- Keep M3's same-transaction `IfPresent` calls with the delivery's route revision and `reason: "settled"`; the projector will not later try to settle the same attempt because settled attempts leave the unsettled/live selectors.
- Keep the revised deployment and rollback language; the two deployment gates and the return-to-current-behavior rollback statement are now unambiguous.

## Issues & Recommendations

1. **[HIGH] The shared launch-attempt “not live” assertion still uses behavior introduced by FLY-2278.**

   Why it matters: on `069013b25^`, `StateStore.insertEvent()` handles `session_started` by writing `consumed_at` only; it does not call `settleWorkflowDeliveryAttemptTx`. That call was added in commit `069013b25`. The old tree's `listLiveWorkflowDeliveryAttempts()` also filters only `superseded_by_attempt_id IS NULL`, whereas FLY-2278 added the `settlement_reason IS NULL` predicate. Therefore M1-a step 4's hard assertion that the launch attempt has left `listLiveWorkflowDeliveryAttempts()` is guaranteed to fail on the old tree, before the two intended stall-clock tripwires execute. The §1 claim that consumption and settlement are the same on both trees is incorrect.

   Suggested fix: in the two-tree fixture, assert that `insertEvent(...)` succeeds and that the launch attempt's `consumed_at` is non-null; do not require it to leave `listLiveWorkflowDeliveryAttempts()`. In the main-only/M3 sections, additionally assert `settlement_reason === "settled"` and absence from the current live selector before running the watch. Update §1 and M1-a step 4 to say that consumption is common to both trees while settlement/live-list exclusion is main-only. The old positive-control path does not run `DeliveryContractWatch`, and a consumed launch attempt has no overdue stage deadline, so retaining the old-tree row does not contaminate either intended tripwire.

## Verdict

CHANGES REQUESTED — address item above
