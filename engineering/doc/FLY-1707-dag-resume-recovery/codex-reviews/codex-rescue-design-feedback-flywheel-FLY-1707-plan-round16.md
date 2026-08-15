# Design Review — plan.md (FLY-1707 E5) (Round 16)

Date: 2026-08-15
Author: Codex
Status: APPROVED

## Summary

Both Round 15 blockers are now closed with source-aligned, implementable contracts. The delta preserves `held` as a human terminal state, adds an exact durable operator acknowledgement surface, and makes loop history genuinely monotonic without introducing a new table, timer, flag, or lifecycle path.

## What's Good (Keep)

- `escalationAck` has a bounded request shape and is required only for the loop-limit held form; the existing needs-lead and land-head-mismatch forms remain field-absent and byte-compatible.
- Admission now binds the acknowledgement to the run's current/latest immutable hold authority and verifies the referenced event payload and digest in the same transaction. The stale historical-escalation hole is explicitly negative-tested.
- Co-writing the exact ack into `operator_rework_requested` and `authority_context_json/digest` gives the human decision durable provenance without widening the existing `qa|founder` schema enum.
- Including the ack in replay/conflict comparison correctly separates acked, unacked, and changed-decision requests, including response-loss replay.
- One canonical iteration projection now counts both `loop_iteration` and `loop_limit_escalated` receipts for the same edge and is shared by loop-reentry canonicalization and transition commit.
- The multi-cycle test and per-consumer mutations are non-vacuous: they prove `max+1`, `max+2`, and `max+3` progression on the same run with monotonic node attempts.
- The design remains consistent with FLY-1770. No automation crosses `held`; only an explicit loopback, master-authenticated, durably acknowledged operator rework can reactivate the run.

## Issues & Recommendations

1. **No blocking issues.** Keep the current-hold query fail-closed and the shared iteration projection as single production helpers so their closed authority/counting rules cannot drift between call sites.

## Verdict

APPROVED — ready to implement
