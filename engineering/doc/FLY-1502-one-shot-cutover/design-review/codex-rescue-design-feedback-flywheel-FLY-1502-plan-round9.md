# Design Review — FLY-1502 plan.md (Round 9)

Date: 2026-07-28
Author: Codex
Status: APPROVED

## Summary

The Round-8 blocker is resolved. The displayed 0009 block is now a complete, single-authoritative migration that executes against the real 0001–0008 schema, enforces the stated binding and processing-receipt transitions, and atomically rejects the prohibited populated-0008 path.

## What's Good (Keep)

- The INSERT and UPDATE binding guards now use the same complete JSON contract: exact five-key shape, per-key types, non-empty identities, positive integer PID, and frozen text `pid_start` (`plan.md:76-117`).
- Generation transitions are mechanically restricted to same-generation non-binding updates or generation+1 with a changed, valid, non-null binding tuple.
- `pa_receipt_insert_guard` and `pa_digest_transition_guard` now form a total lifecycle: running rows have neither timestamp nor digest; succeeded rows require both; failed/crashed rows require a timestamp and no digest; settled rows are immutable (`plan.md:118-132`).
- The populated-0008 guard is executable migration SQL, and the temporary guard table is removed on success (`plan.md:68-75`).
- The fresh-staging-only policy and host-recovery wording are now consistent; the stale generic backfill statement is gone (`plan.md:134-146`, `203-217`).
- Verification against the repository's actual eight migrations succeeded: the exact displayed 0009 SQL added the two agent columns and `processing_attempts.proposal_digest`, then left no guard table behind.
- A generation-1 populated 0008 database was rejected inside the migration transaction with no partial columns or guard table left after rollback.
- The direct SQL matrix accepted the valid provision/register, binding-advance, succeeded-settlement, and failed-settlement paths, while rejecting loose JSON, unchanged-binding advancement, pre-digested inserts, succeeded-without-digest, running-with-`settled_at`, terminal-without-`settled_at`, and post-settlement mutation.

## Issues & Recommendations

None.

## Verdict

APPROVED — ready to implement
