# Design Review — FLY-1502 plan.md (Round 8)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 8 closes the migration-domain blocker: the external receipt predicate and exemption authority now match the real legacy states. One blocker remains in 0009: the SQL block labeled executable and normative is still incomplete and directly accepts states that the surrounding contract says must fail.

## What's Good (Keep)

- The receipt-obligation predicate is now complete SQL, including `carrier='external'` and `receipt_exempt_reason IS NULL` (`plan.md:337-341`).
- The exemption authority is correctly the current `lead_inbox.receipt_exempt_reason` column; append-only audit rows are evidence, not current state.
- Domain fixtures now include negative carrier and exemption cases constructed through real APIs (`plan.md:349-353`). Together with source scoping, disposed-row handling, quarantine blocking, and the complement assertion, R7-2 is resolved.
- The agent update guard now rejects generation advancement with an unchanged binding tuple and applies strict JSON key/type/value validation (`plan.md:82-105`).
- The processing-attempt INSERT guard correctly rejects terminal/pre-settled/pre-digested new rows (`plan.md:106-111`).
- The fresh-staging-only upgrade policy is directionally correct and appropriate for this one-shot cutover.
- All previously closed runtime, reconciliation, rollback, promotion, authority, and journal contracts remain intact.

## Issues & Recommendations

1. **BLOCKER — the normative 0009 SQL still differs from its claimed invariants and from the stated upgrade policy.**

   The displayed `agents_binding_insert_guard` still contains the old presence-only JSON checks (`plan.md:70-81`). The plan says the strict clause is omitted and will be expanded in the future migration file (`plan.md:120-121`), but the same section labels the displayed block “executable SQL, normative.” Executing that block accepts an inserted binding with numeric `host_epoch`, empty `session_id`, string PID, object `pid_start`, and an extra key. The update guard rejects that shape, so the database can insert a row that an unrelated later heartbeat UPDATE cannot touch.

   The populated-0008 rejection is likewise prose only (`plan.md:127-132`): no assertion appears in the normative migration SQL. Because SQLite triggers are not retroactive, applying the displayed block to a generation-1 agent leaves both new binding columns null and succeeds. This also conflicts with the stale statement that existing/malformed rows are backfilled to null (`plan.md:189-198`).

   The processing transition guard still leaves two invalid timestamp states open (`plan.md:112-118`). It permits a running row to acquire non-null `settled_at`, and permits `running→failed/crashed` while `settled_at` remains null. Both contradict the meaning of a running versus settled processing attempt and the existing settlement callers, which always supply `settledAt`. A direct SQLite execution of the displayed SQL accepted both cases.

   **Suggested fix:** make the code block genuinely complete and single-authoritative: expand the strict JSON clause in the INSERT trigger and include executable populated-0008 rejection SQL in the 0009 body. Remove the stale null-backfill wording or qualify it to generation-0 rows. Extend `pa_digest_transition_guard` so `outcome='running'` requires `settled_at IS NULL` and all three terminal outcomes require `settled_at IS NOT NULL`; retain the succeeded/non-null-digest and failed/crashed/null-digest split. Then execute the exact displayed block—not a future stronger file—against the entire direct-SQL matrix, including loose INSERT JSON, populated-0008 migration, running-with-settled-at, and failed/crashed-without-settled-at.

## Verdict

CHANGES REQUESTED — address items above
