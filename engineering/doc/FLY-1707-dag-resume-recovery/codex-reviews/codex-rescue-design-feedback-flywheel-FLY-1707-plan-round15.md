# Design Review — plan.md (FLY-1707 E5) (Round 15)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

The Lead-directed product decision is sound and does not conflict with FLY-1770: a loop-limit hold remains a human terminal state, and only an explicit authenticated operator decision may reopen it. The delta correctly keeps the same run and existing rework machinery, but it does not yet define an enforceable acknowledgement authority or a counter projection that actually preserves iteration history after the first escalation.

## What's Good (Keep)

- The live gap is source-confirmed: `loop_limit_escalated` atomically holds the run, while `openOperatorRework` currently admits held runs only through the needs-lead and terminal-land `pr_head_mismatch` predicates.
- Reusing `openOperatorRework` is the simplest recovery shape. It preserves the run, existing node-attempt rows, route/delivery machinery, and operator supersession behavior instead of introducing another lifecycle path.
- Requiring a durable human acknowledgement is consistent with held-as-human-terminal. This is an explicit master-authenticated decision surface, not an automated resume or silent pass-through.
- The positive/negative acceptance split is correct, and preserving byte behavior for the two existing held forms is an important compatibility constraint.
- The D9 cross-reference keeps resume admission correctly limited to active runs; this delta belongs in operator rework, not the resume protocol.

## Issues & Recommendations

1. **`escalation_ack` is not yet an executable authority or idempotency contract.** The current route parses only `targetNodeId`, `feedback`, and `clientRequestId` (`runs-route.ts:816-834`); `openOperatorRework` has no ack input and its replay comparator checks only target, feedback, and principal (`StateStore.ts:25082-25146`); the immutable `operator_rework_requested` payload likewise carries no hold receipt or acknowledgement (`:25594-25612`). “Latest hold receipt” is also not a defined closed query, so a stale historical `loop_limit_escalated` could be mistaken for the cause of a later unrelated hold. Finally, `workflow_rework_request.authority` currently accepts only `qa|founder` (`:16965-16977`), making “authority = operator + escalation_ack” ambiguous. **Fix:** define one optional API/input field such as `escalationAck: { holdEventUid, holdReceiptDigest, decision }`, required only for the new held form. In the same transaction, require the referenced immutable event to be the current/latest hold authority for this run, verify its `loop_limit_escalated` payload and digest, and co-write the exact ack projection into `operator_rework_requested` plus `authority_context_json/digest`. Include it in replay/conflict comparison so acked and unacked requests can never alias. Specify whether `operator` is an authority-context value using the existing compatibility column or a real schema literal; if the latter, include the closed-union migration and consumer audit. Add stale-old-loop-receipt, wrong-run/edge/digest, changed decision, response-loss replay, and missing-ack negatives while keeping the existing two held forms field-absent and byte-unchanged.

2. **The promised continuous loop count is not preserved by merely staying in the same run.** Both production counters currently compute `COUNT(*)` over only `kind='loop_iteration'` (`StateStore.ts:29891-29899` and `:30393-30400`). The over-limit attempt writes only `loop_limit_escalated` with `loopIteration=N` and returns before appending `loop_iteration` (`:30402-30449`). Therefore, after an acknowledged reopen, the next QA failure is labeled N again rather than N+1; repeated human continuations preserve rows but not the loop guard's logical history. **Fix:** define one canonical iteration projection shared by loop-reentry canonicalization and transition commit that includes both successful `loop_iteration` and over-limit `loop_limit_escalated` receipts for the same edge (or an equivalently durable monotonic projection). Test `1..max → escalation max+1 → acked rework → escalation max+2`, then a second ack producing `max+3`; mutate either consumer back to the old count and require the test to fail. Also assert the same run ID and monotonically increasing node attempts throughout.

## Verdict

CHANGES REQUESTED — address items above
