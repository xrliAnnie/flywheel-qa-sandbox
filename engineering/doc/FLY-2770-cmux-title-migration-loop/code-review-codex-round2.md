# Code Review — FLY-2770 PR #1283 (Round 2)

Date: 2026-09-22
Reviewer: Codex
Head: 185d158dbf3366448a80203c7252443e6cf59e9f
Status: CHANGES REQUESTED

## Summary

The two HIGH findings and the LOW finding from Round 1 are correctly fixed. Both delayed automatic-refresh bodies re-check the maintenance marker immediately before invoking the sync/cmux boundary, and the new race test would fail if either re-check were removed. `_restored_migration_pending` is now genuinely tri-state, reuses the probe's already-observed surface, and propagates uncertainty without destructive fallback: adoption requires probe rc=0, recovery maps rc=2 to `evidence=inconclusive` and decision-row-0 quarantine, the final close guard rejects every nonzero probe result, and ops rebuild records rc=2 without calling adoption or the follow-up create path. The mutating `--refresh` comments are also corrected.

The reported lint and test results were not re-run, as requested. Static review and shell syntax checks found no Bash 3.2, quoting, `local`-scope, subshell-state, `set -u`, or rc-propagation defect in those fixes. One Round-1 MEDIUM remains incomplete: migration-stall cleanup is still branch-local rather than tied to the receipt lifecycle, and the new test does not cover two of the three new reset guards or receipt commit/removal.

## Findings

1. **Migration-stall state still outlives receipts committed or removed outside prepared reconciliation — MEDIUM**

   - **File:** `scripts/flywheel-cmux-sync.sh:8250`, `scripts/flywheel-cmux-sync.sh:8304`, `scripts/flywheel-cmux-sync.sh:8806`, `scripts/flywheel-cmux-sync.sh:9008`, `scripts/flywheel-cmux-sync.sh:9238`; `scripts/test-cmux-sync.sh:12797`; `engineering/doc/milestones/FLY-2770.md:90`
   - **Evidence:** [verified by reading code] The new clears at lines 9053, 9071, and 9154 cover three observed-title arms inside `reconcile_prepared_ledger`, but migration evidence can leave the `prepared` lifecycle without revisiting any of them. For example, a failed `complete_title_migration` records a migration row at line 9140; later in the same additive pass, `reconcile_workspace_titles` can call the same helper at line 8806 and commit the receipt at line 8250 or 8304, with no migration clear. Future prepared reconciliation enumerates only `prepared` rows, so it can never reach the success clear at line 9150 for that now-committed tuple. Likewise, prepared-loser and stale-generation cleanup remove receipts at lines 8067 and 9238 without clearing their stall keys. The milestone's claim that receipt GC no longer leaves orphan rows is therefore not true. The new test exercises only the foreign-drift/default case that reaches line 9154; deleting the `__ABSENT__` clear at line 9053 or the `__NULL__|__PROVISIONAL__|__DEFAULT__` clear at line 9071 still leaves it green, and it never asserts cleanup after successful convergence or receipt removal.
   - **Failure scenario:** A transient rename failure creates an aged migration counter. A later caller successfully commits the same receipt, or a loser/stale-generation path removes it. The orphan counter remains indefinitely, contributes toward the 1 MiB prepared-stall state limit, and can eventually make `_prepared_stall_state_valid` reject the file and freeze all stall observations. If the same tuple is reused, its old count can also produce a premature stuck alert from non-consecutive evidence.
   - **Suggested fix:** Centralize migration-key cleanup at the lifecycle boundaries: clear it after every successful prepared-to-committed transition in `complete_title_migration`, and clear all prepared-stall keys for a tuple/ref whenever its receipt is removed (including prepared-loser and stale-generation paths). Treat cleanup failure as an explicit warning without pretending the already-completed ledger transition rolled back. Add table-driven tests for absent, provisional/default, and foreign drift, plus tests that seed a migration key and then commit through a caller other than `reconcile_prepared_ledger` and remove through a receipt-GC path; each should assert the key is gone. Update the milestone claim accordingly.

## Verdict

**CHANGES REQUESTED.** The authority-critical HIGH fixes are sound, and static call-graph review confirms rc=2 cannot reach a close. The migration-stall fix is nevertheless incomplete at receipt lifecycle boundaries, leaving durable orphan state and test blind spots from the prior MEDIUM finding.
