# Code Review — FLY-2770 PR #1283 (Round 1)

Date: 2026-09-22
Reviewer: Codex
Head: 2838e85d3f01c15ed98383b2c66c29b2db325f02
Status: CHANGES REQUESTED

## Summary

The implementation matches most of the approved v3 design: C1 keeps placeholder authority behind a unique UUID-bound receipt and exact-byte guard; four-field legacy receipts remain excluded unless they later pass the pre-existing birth-proven UUID upgrade; the C3 admission tables preserve QA teardown, foreign ops-claim, `--once`/`--reaper`/`--watch`, and `--converge-runners` boundaries; and the C2 kinds are present in both allowlists. The supplied lint/test/CI results were treated as reported facts and were not re-run.

Static review found two HIGH correctness/authority defects, one MEDIUM stall-state/test defect, and one LOW contract-comment defect. In particular, the new C1b predicate is not fail-closed when its redundant observation fails, and the automatic restart refresh can execute after a maintenance marker appears during its built-in delay.

## Findings

1. **Delayed automatic refresh can cross a newly-created maintenance marker — HIGH**

   - **File:** `scripts/restart-services.sh:2705`, `scripts/restart-services.sh:2711`, `scripts/restart-services.sh:2726`; `scripts/test-cmux-sync.sh:12571`
   - **Evidence:** [verified by reading code] `trigger_cmux_refresh` checks the marker once at function entry, then schedules the mutating `--refresh` for five seconds later and `refresh-surfaces` for ten seconds later. Neither background body re-checks the marker after its sleep. The test replaces `sleep` with a no-op and covers only a marker that already exists before the function is called, so it cannot detect the real scheduling race.
   - **Failure scenario:** A Lead restart calls `trigger_cmux_refresh` while the fleet is unparked. During the next five seconds the founder creates the maintenance marker. The resident watcher yields, but the already-scheduled `--refresh` now acquires the lease; its dedicated C3 admission arm intentionally ignores the marker, so it may close restored workspaces and rename/commit rows in a fleet that is parked at the time of mutation. The ten-second `refresh-surfaces` job has the same stale admission decision.
   - **Suggested fix:** Re-check `-e || -L` inside both background jobs after their sleeps and immediately before any sync/cmux call. Preferably make the automatic refresh an explicit marker-aware admission mode so the check happens after lease acquisition as well. Extend T12 so the sleep seam creates the marker during the delay and assert that neither `--refresh` nor `--list-lead-refs`/`refresh-surfaces` runs.

2. **C1b treats an inconclusive second surface read as permission to resume W1p recovery — HIGH**

   - **File:** `scripts/flywheel-cmux-sync.sh:7381`, `scripts/flywheel-cmux-sync.sh:7383`, `scripts/flywheel-cmux-sync.sh:7414`, `scripts/flywheel-cmux-sync.sh:7451`, `scripts/flywheel-cmux-sync.sh:7803`
   - **Evidence:** [verified by reading code] `_restored_candidate_probe` already reads the surface at line 7414. `_restored_migration_pending` then reads the same surface again at line 7383 and returns `1` for both “not pending” and read failure. The caller uses `helper && return 1`, so that failure is interpreted as a conclusive negative and the probe continues as a valid restored candidate. The direct ops caller at line 12560 has the same boolean collapse and falls back to restored adoption on uncertainty.
   - **Failure scenario:** The first surface read succeeds with `Terminal 66`, while each redundant second read fails (for example, alternating/transient cmux IPC failure). Adoption can mint a W1p marker; recovery can classify its fingerprint as stable and take row 13; and the final close guard repeats the same fail-open pattern, allowing the UUID to be dropped and the workspace to be closed at lines 7687–7712. That recreates the destructive loop C1b exists to prevent. In `--rebuild-views`, the same observation pattern can choose adoption/close/recreate instead of the new migration path.
   - **Suggested fix:** Make `_restored_migration_pending` tri-state: `0=pending`, `1=conclusively not pending`, `2=inconclusive`. Pass the surface already read by `_restored_candidate_probe` instead of re-reading it; map receipt/surface read failures to `2`, and make both probe and ops callers preserve state on `2`. Add a sequence test where the first surface observation succeeds and the helper observation fails; assert zero marker, zero ledger advance, and zero close.

3. **Migration-stall evidence survives interrupted conditions and its escalation is untested — MEDIUM**

   - **File:** `scripts/flywheel-cmux-sync.sh:9025`, `scripts/flywheel-cmux-sync.sh:9043`, `scripts/flywheel-cmux-sync.sh:9113`, `scripts/flywheel-cmux-sync.sh:9123`, `scripts/flywheel-cmux-sync.sh:9125`; `scripts/test-cmux-sync.sh:12398`
   - **Evidence:** [verified by reading code] The new `migration` counter is cleared only when the `"$title"` arm succeeds or immediately before alerting. The absent, provisional/default, and foreign-drift arms clear other counter kinds but never clear `migration`; removing the ledger row also leaves that record behind. The new loop test runs only three immediate rounds and asserts log suppression/state preservation, so the threshold/alert code at lines 9113–9120 can be deleted without a test failing.
   - **Failure scenario:** A row accumulates four migration deferrals, then becomes absent or changes to a foreign workspace title. Its migration evidence remains. If that tuple later returns to the named-workspace state, one isolated failure can hit the threshold and emit a “stuck” alert even though the deferrals were not consecutive. If the receipt is GC'd, the orphan record remains indefinitely and contributes toward the 1 MiB state-file cap, eventually freezing all prepared-stall observations as malformed/oversized.
   - **Suggested fix:** Clear the `migration` key whenever the row leaves the named-workspace migration condition and whenever its receipt is removed. Add a focused test with zero minimum age and a low threshold that proves interruption resets the count, exactly one alert is emitted at the true threshold, the receipt is preserved, and successful convergence clears the key.

4. **Two `--refresh` contract comments still claim the path is tmux-only — LOW**

   - **File:** `scripts/flywheel-cmux-sync.sh:4`, `scripts/restart-services.sh:2710`
   - **Evidence:** [verified by reading code] The top-level command synopsis still says `--refresh` is “tmux-only” and needs no cmux socket, and the restart path labels its scheduled call “tmux-only refresh.” The implementation and updated help correctly state that it can close restored workspaces and rename/commit title migrations.
   - **Failure scenario:** An operator or later maintainer relies on the source-level contract and invokes/restructures this path as read-only, bypassing the marker/lease reasoning that C3 now requires.
   - **Suggested fix:** Update both comments to the same mutating contract used by `refresh_linked_sessions`, the dispatcher, and `--help`.

## Verdict

**CHANGES REQUESTED.** The principal authority partitions are otherwise correctly scoped, but the delayed automatic refresh can mutate after the fleet becomes parked, and C1b converts an inconclusive redundant read into the destructive restored-adoption path. Fix findings 1 and 2 before merge; also reset and test the new migration-stall evidence and correct the remaining command-contract comments.
