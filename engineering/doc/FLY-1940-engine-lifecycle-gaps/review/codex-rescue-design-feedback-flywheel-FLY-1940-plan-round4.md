# Design Review — plan.md FLY-1940 (Round 4)

Date: 2026-08-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 resolves the three Round-3 defects at the semantic level: daemon identity is captured before socket polling, both coordinators durably park while awaiting receipt, and the closeout boundary is now exact. The design remains feasible and otherwise complete, but the document still leaves the requested delivery recheck cadence undefined and retains an obsolete `onDaemonPid` hard gate that contradicts the new fail-closed spawn path; those two implementation-defining inconsistencies should be corrected before coding.

## What's Good (Keep)

- Keep the synchronous spawn-identity hook inside `spawnCodexDaemon`, before its first await. The current source spawns at `codex-daemon-runtime.ts:494-524` but does not return until the socket poll at `:657-669`, so this is the right architectural seam for shrinking the ownership gap.
- Keep fail-closed persistence: if the identity write fails, the partial detached group must be killed and verified before spawn rejects. The existing failed-spawn kill/verify/lock-order machinery at `codex-daemon-runtime.ts:618-655` can be refactored for this without inventing a second reaper.
- Keep the group-aware liveness verdict. A live or indeterminate persisted group with no socket must veto `dead`; requiring both listener absence and group absence closes the pre-bind and failed-reap false-death cases.
- Keep the real production-wrapper regressions for pre-socket pause, failed reap followed by CommDB deletion, and post-reap death. They test the actual proof composition rather than a permissive injected host-process fake.
- Keep `awaiting_receipt` as a neutral, durable park for both rework and carrier. The existing delivery scans already honor `next_retry_at` (`StateStore.ts:25837-25857, 42745-42765`), so this avoids the one-second dispatcher hot loop without a schema rebuild.
- Keep receipt projection independent of the due schedule, preservation of the original TURN identity/stable grant clocks, no hold or failure-budget charge, and explicit carrier-metric exclusion. These choices preserve one honest meaning for `wake_delivered`.
- Keep the exact finalization boundary: post-increment count `>= 13` or elapsed time `>= 48h`, with the four pinned edge cases. This now agrees with the intended terminal behavior.
- Keep the prior exact QA-head invariant, structured writer fence, founder-review retirement allowlists, two-category CAS-only TURN cleanup, exact needs-lead replacement saga, terminal start-replay classification, durable closeout budget, net-deletion commitments, and acceptance matrix. Re-review found no new blocker in those areas, and the five dependency SHAs named in §0 are ancestors of this checkout's HEAD.

## Issues & Recommendations

1. **The PR-1 contract still points at the obsolete, unsafe `onDaemonPid` path.** Fix 5-A correctly requires a new synchronous hook inside `spawnCodexDaemon` (`plan.md:32`), but the PR matrix still names “`daemonPid onDaemonPid` 即写” and a generic spawn-to-ready test (`plan.md:217`). In current code, `CodexDaemonGoalRuntime.startSession` invokes `onDaemonPid` only after `await this.spawnDaemon(...)` and swallows callback failures (`codex-daemon-goal-runtime.ts:279-307`), which is exactly the path Round 4 is replacing. Leaving that hard-gate cell—and no explicit same-PR removal of the post-await callback—creates two competing ownership paths and violates the plan's new-path-deletes-old-path red line. **Suggested fix:** define one throwing `onSpawnIdentity(pgid)`-style contract passed into `spawnCodexDaemon`, synchronously atomic-merge the identity into `session.json`, and route callback failure through the existing failed-spawn kill/verify cleanup. Explicitly delete or refactor the post-await/swallowing `onDaemonPid` invocation in the same PR, and update PR-1's hard gate and test wording to the pre-socket/pre-bind window.

2. **`awaiting_receipt` still has no explicit recheck interval or quantitative bound.** The plan says only “bounded `next_retry_at`” and “every due pass” (`plan.md:71-75`). With a one-second dispatcher (`workflow-engine-dispatcher.ts:266-280`) and an existing TURN-wake T1 default of three minutes (`turn-wake-patrol.ts:26-29`), the chosen interval controls dead-recipient recovery cost, restart behavior, and whether the 180-second test has one claim or many; “bounded” can be satisfied by materially different implementations. This was the explicit cadence decision requested in Round 3, not merely a test-shape request. **Suggested fix:** choose and name one fixed/env-bounded default for both coordinators—three minutes aligned with the existing T1 is the simplest option, unless a faster liveness SLA is intended—and state that every neutral due pass advances `next_retry_at` from the current due pass without touching stable grant time. Make the 180-second simulation assert concrete maxima for claims, claim events, git/liveness probes, and TURN-grant calls, including the exact due boundary and Bridge restart; retain immediate ACK projection at any point before that boundary.

## Verdict

CHANGES REQUESTED — address items above
