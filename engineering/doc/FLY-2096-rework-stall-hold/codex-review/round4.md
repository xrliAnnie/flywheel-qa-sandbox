# Design Review — plan.md (Round 4)
Date: 2026-09-03
Author: Codex
Status: APPROVED

## Summary

Rev5 resolves the remaining cross-tree fixture mismatch. The shared fixture now proves the launch event was consumed using behavior present on both trees, while settlement and live-selector exclusion are asserted only on main, where FLY-2278 introduced them. The old-tree positive controls can therefore reach the intended 60-minute hold and completion-rejection tripwires without unrelated launch-contract failures.

The complete plan is feasible, correctly sequenced, bounded in blast radius, and consistent with the existing delivery-attempt and workflow-transition patterns. No blocking correctness, safety, testability, or scope issues remain.

## What's Good (Keep)

- Keep the shared rework-attempt locator and its exact-one-row assertion. It handles the old versionless attempt and main's revision-2 remint without weakening either tree's fixture guards.
- Keep `insertEvent(session_started)` as the real launch-consumption path. The shared `consumed_at` assertion matches both trees; the main-only `settlement_reason === "settled"` and live-list exclusion guards correctly capture behavior added by FLY-2278.
- Keep the two independently named positive-control cases and independent stores. Their fixture guards now precede the actual tripwires without consuming them.
- Keep the real `CommDB(":memory:")`, the alive/absent control ordering, and the scoped episode/alert queries. These isolate the target rework attempt from legitimate launch and gate-holder contract activity.
- Keep the M3 RED→GREEN sequence: capture the pre-change ghost episode and warning, add settlement in the same completion transaction, then prove the completed attempt is no longer live while the unfinished control still alerts.
- Keep both M3 completion-path tests, the no-attempt compatibility test, and the pre-completion null-settlement guard. Together they cover the verification, chaining, additive-rollout, and premature-settlement failure modes.
- Keep `settleWorkflowDeliveryAttemptIfPresentTx` immediately after each successful rework-delivery `completed` CAS, using the delivery row's `route_revision`, `reason: "settled"`, and the caller's `now`. The selector targets the current reminted attempt, and subsequent projector passes cannot apply a conflicting `run_terminal` settlement because settled attempts are excluded from the unsettled/live sets.
- Keep M2 as deletion-only and retain the historical prefix consumer, hold shape, and FLY-2278 retirement guard. This respects the repository's “只删不加” constraint.
- Keep the separate production deployment gates, non-intervention boundary for existing rows, and revised rollback wording. They accurately distinguish retired hold behavior from this PR's new completion settlement.

## Issues & Recommendations

No changes requested. Preserve the documented RED-before-GREEN evidence order and exact-head CI gate during implementation.

## Verdict

APPROVED — ready to implement
