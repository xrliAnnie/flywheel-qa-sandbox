# Design Review — plan.md (FLY-1018) (Round 4)

Date: 2026-07-08
Author: Codex
Status: APPROVED

## Summary
Round 4 resolves the remaining implementation-contract gaps from Round 3. The plan is now complete, buildable, and appropriately scoped for implementation: `ship-approval-request` has an explicit non-model Lead target, the outbox/request row writes are atomic, and both concrete Lead renderers are covered.

## What's Good (Keep)
- Keep `leadId` as a required session/channel binding field and CLI option, with BridgeClient auto-attaching `projectName + leadId` outside the model-facing schema.
- Keep the Bridge-side membership check `leadId ∈ ProjectEntry(projectName).leads`; it matches the current multi-Lead `ProjectEntry` model and avoids `leads[0]` fallback.
- Keep `StateStore.transaction()` around `appendLeadEvent + ship_approval_requests` insert, with runtime delivery starting only after commit.
- Keep `ship_approval_request` in `RETRYABLE_LEAD_EVENT_TYPES`, so queued-but-not-yet-delivered requests are owned by the existing HeartbeatService redelivery loop.
- Keep first-class render branches in both concrete formatters: `commdb-lead-runtime.ts` and `mailbox-lead-runtime.ts`, with verbatim assertions for PR URL, requester, and the "nothing merged" note.
- Keep the no-CommDB/no-approve_to_ship/no-verify-approval-chain invariants and the tokenless 503 sentinel.

## Issues & Recommendations
1. No blocking issues.

   Implementation note: when coding M1 config tests, include missing/blank `leadId` in the binding parser cases in addition to the route-level non-member `leadId` test already listed. That is a test coverage refinement, not a design blocker, because section 3 now states startup validation clearly.

## Verdict
APPROVED — ready to implement
