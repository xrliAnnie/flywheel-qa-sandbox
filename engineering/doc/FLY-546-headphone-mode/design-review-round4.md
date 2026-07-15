# Design Review — FLY-546 plan.md (Round 4)

Date: 2026-07-07
Author: Codex
Status: APPROVED

## Summary
Round 4 closes the Round 3 blockers. The kill-switch approval path remains fail-closed, and the revised `disconnect_grace` contract now has clear precedence, persistence shape, resume behavior, and real-VC acceptance coverage.

## What's Good (Keep)
- The plan intro now correctly states exploration §9 overrides §8 where they conflict, so the founder-ruling precedence is explicit.
- The approval guard chain is still safe: missing `apiToken` returns 503 before route body use, wrong/missing Bearer returns 401, only `FLYWHEEL_VOICE_APPROVAL=0` disables voice approval, then the global founder auto-approve kill-switch and binding/receipt guards apply.
- The mid-approval disconnect rule is now fail-closed at the right moment: leaving while `previousState=awaiting_approval_confirm` immediately invalidates that approval attempt, and a later reconnect cannot turn the stale readback into a write.
- The `disconnect_grace` state now has an explicit persisted shape and a deterministic resume contract. Replaying the per-state entry prompt is acceptable because the contract forbids duplicate completion and duplicate side effects.
- B4-2.1 now validates the real risky surface: FLY-545 presence bridge behavior for 59s reconnect, 61s exit with core recap and resumable queue snapshot, and mid-approval leave with CommDB proof of no response.
- The voice config ruling is scoped correctly: all production Leads get differentiated default `leads[].voice` entries at ship time, while final voice choices remain product decisions and future changes are one-line config edits.

## Issues & Recommendations
1. No blocking issues found.
   Why it matters: the prior blockers were approval leakage after disconnect, missing main-exit E2E coverage, ambiguous resume state, and stale flag wording. The current plan addresses all four directly in B1-3, B3-2.5, B4-2.1, and the intro.
   Suggested fix: proceed to implementation with these rows treated as acceptance criteria.

2. Non-blocking implementation note: make the `disconnect_grace` persisted state a typed union.
   Why it matters: the FSM row is intentionally broad (`任意(≠sending)`), while `currentItemId` and `itemPhase` only make sense for item-bound states. States like idle or verbal-exit confirmation may not have the same payload shape.
   Suggested fix: encode this as an explicit union, for example `item_bound` vs `no_current_item`, and keep `awaiting_approval_confirm` as a separate invalidated-approval branch. This is an implementation clarity point, not a design blocker.

3. Non-blocking QA note: keep the old verbal exit as supplemental only.
   Why it matters: `芝麻关门+确认` remains useful and covered, but the founder-ruling main path is now VC leave plus 60s grace.
   Suggested fix: do not let implementation or QA evidence substitute the optional verbal-exit check for the B4-2.1 presence three-case evidence.

## Verdict
APPROVED — ready to implement
