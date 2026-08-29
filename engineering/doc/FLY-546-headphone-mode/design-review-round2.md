# Design Review — FLY-546 plan.md (Round 2)

Date: 2026-07-07
Author: Codex
Status: APPROVED

## Summary
Round 2 closes the five Round 1 blockers in a way that is feasible with the current architecture and consistent with the existing approval-signal/Bridge patterns. I re-read the updated plan and spot-checked the claimed seams in source; the remaining notes are implementation cleanup, not approval blockers.

## What's Good (Keep)
- The voice ship-approval path now fails closed on missing `apiToken`, keeps wrong/missing Bearer at 401, and makes daemon startup fail fast when voice approval is enabled without a Bridge token.
- The recovery ledger is now materially durable: per-channel snowflake cursors, startup/reconnect backfill, atomic state persistence, corrupt-state fail-loud behavior, and side-effect IDs are all explicitly planned and tested.
- The FSM now matches PRD §17: `ship_gate` uses the same announce→ask path, approval requires explicit `APPROVE_INTENT` plus readback plus `CONFIRM`, and silence/unclear never writes approval.
- The new `/api/voice/scope` contract correctly removes daemon-side guessing for lead/system bot IDs and scope channels, including the fallback bot source used by gate-poller.
- The context contract is now typed (`issue_thread | lead_channel | unknown`) and avoids overloading 404s, with `getChatThreadByThreadId` plus phase side-table compatibility called out.
- The plan preserves v1 discipline: FIFO ordering, exact phrase matching, no NLP classifier, no dependency on unfinished FLY-545 work until the five-interface adapter milestone.

## Issues & Recommendations
1. No blocking issues found.
   Why it matters: the Round 1 defects were around founder authority, durable delivery, PRD semantics, tap coverage, and context ambiguity. Each now has a concrete plan step plus tests.
   Suggested fix: proceed to implementation with these items treated as acceptance criteria, not optional polish.

2. Clean up minor route/auth wording before implementation.
   Why it matters: the architecture paragraph still says Bridge has three `/api/voice/*` endpoints, while the plan now defines four (`scope`, `context`, `gate-binding`, `ship-approval`). Also, the byte-compat redline still says flag-off `ship-approval` returns 403, but the new tokenless guard means missing `apiToken` should return 503 before flag evaluation. Finally, current `plugin.ts` installs `express.json()` globally before route mounting, so "503 before any body processing" is not literally true unless the route is mounted before JSON parsing or auth is moved ahead of parsing for this route.
   Suggested fix: update the plan text to say four endpoints, clarify response precedence (`api_token_required` 503 before `disabled_by_flag` 403), and either implement auth-before-json for this route or soften the phrase to "before any route body use." This is non-blocking because the approval write still fails closed.

3. Treat the side-effect idempotency claim as a strict implementation detail.
   Why it matters: a local `sentMessageId`/`receiptMessageId` ledger suppresses repeats only after the ID has been persisted. If Discord accepts a send and the process crashes before persisting the returned ID, a restart cannot infer that from local state alone.
   Suggested fix: when implementing B2-2, add deterministic outbound idempotency markers in Discord messages or a restart scan by marker/item ID before retrying. That makes the plan's "never resend reply/receipt/approval" claim true across the hardest crash window.

## Verdict
APPROVED — ready to implement
