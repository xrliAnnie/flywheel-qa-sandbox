# Design Review — plan.md FLY-1940 (Round 5)

Date: 2026-08-21
Author: Codex
Status: APPROVED

## Summary

Round 5 closes both remaining implementation-defining gaps: daemon ownership now has one fail-closed pre-socket persistence path, and receipt-wait reconciliation has a concrete, testable cadence and work bound. Re-review against the current spawn, delivery-scan, TURN-wake, and dispatcher seams found the full six-facet plan feasible, correctly sequenced, and ready to implement.

## What's Good (Keep)

- Keep the single throwing `onSpawnIdentity(pgid)` contract inside `spawnCodexDaemon`, synchronously after `spawnFn` and before the first await. It closes the real spawn-to-socket ownership window identified in the current `CodexDaemonGoalRuntime.startSession` ordering.
- Keep persistence failure on the existing failed-spawn kill/verify path. Refactoring that cleanup for earlier use preserves its lock ordering, process-group kill, bounded wait, and socket-death proof without creating a second reaper.
- Keep the explicit same-PR deletion of the post-await, error-swallowing `onDaemonPid` path. The Fix 5-A text and PR-1 hard gate now name the same sole ownership mechanism and satisfy the new-path-deletes-old-path rule.
- Keep the pre-socket/pre-bind tests: paused spawn, Bridge crash/terminate, persistence failure, and real wrapper/reaper convergence cover the load-bearing window rather than the later thread-ready milestone.
- Keep the daemon-aware quiescence verdict order. Live or indeterminate persisted groups veto `dead`; only proven listener/group absence combined with the existing tmux/host absence evidence permits death.
- Keep the shared three-minute `awaiting_receipt` default for rework and carrier, aligned with TURN-wake T1. The existing `next_retry_at` filters make this directly implementable without a schema rebuild or per-second claim churn.
- Keep the neutral due-pass contract: clear owner/lease, preserve hold and failure accounting, preserve stable grant timestamps and TURN identity, advance only `next_retry_at`, and let a valid receipt bypass the schedule immediately.
- Keep the quantitative 180-second regression. The concrete claim/event/probe ceilings and exactly-one-TURN-grant assertion make restart behavior and the exact due boundary objectively reviewable.
- Keep the exact closeout thresholds, QA-head invariant, structured writer fence, founder-review retirement predicates, CAS-only TURN cleanup, exact needs-lead replacement saga, terminal start-replay classification, net-deletion list, and acceptance-to-test matrix. No acceptance criterion was dropped, and the five dependency SHAs in §0 remain ancestors of this checkout's HEAD.

## Issues & Recommendations

1. **No blocking issues.** As a PR-level guardrail, single-source the three-minute configuration used by the two coordinators and TURN-wake T1 so an environment override cannot split their cadence. The exactly-one-TURN-grant test should force due replay to reuse the persisted epoch/wake identity rather than merely relying on a second `grantTurn` call being idempotent; both points are consistent with the approved plan and require no design revision.

## Verdict

APPROVED — ready to implement
