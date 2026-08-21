# Design Review — plan.md FLY-1940 (Round 3)

Date: 2026-08-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 closes the four Round-2 design defects at the semantic level: daemon-aware quiescence, receipt-only carrier promotion, exact/crash-convergent needs-lead replacement, and a bounded global closeout budget now have clear owners and tests. Source verification found two remaining runtime gaps in the spawn and one-second reconcile windows, plus one exact boundary inconsistency, so implementation should wait for these small but load-bearing amendments.

## What's Good (Keep)

- Keep `probeCodexDaemonLiveness` and the production verdict order. Sharing deterministic socket/process-group identity with the reaper and making inconclusive evidence return `unknown` is the right fail-closed quiescence model.
- Keep the real-wrapper regressions, especially failed reap followed by CommDB deletion while the daemon remains live. That test closes the unsafe fake-`hasHostProcess` loophole from Round 2.
- Keep receipt-only delivery promotion. Deleting both carrier promotions—the immediate send-success branch and the replay-time `wake_already_sent` branch—and using activation/execution/epoch at `onReceipt` gives `wake_delivered` one honest meaning.
- Keep the unchanged T0/T1 push budget, stable grant timestamps, single 30/60-minute stall owner, typed TURN doorbell, and same-PR deletion of the obsolete delivery paths.
- Keep `expectedNeedsLeadRequestId` inside the StateStore precondition and idempotency payload. Persisting the exact old TURN/wake cleanup identity before committing, then using exact wake cancellation plus `deleteTurnIfCurrent`, is a sound cross-database saga.
- Keep endpoint replay plus an existing patrol as idempotent cleanup redrivers, with `canDeliver` as the outbox backstop. The wrong-request, post-commit-crash, and concurrent-`grantTurn` tests cover the important race boundaries.
- Keep the independent `closeout_attempt_count` and `first_closeout_attempt_at`, the closeout-only increment site, explicit reset owners, post-increment alert buckets, and same-PR 6-C/6-A rule. This now closes Facet 6 without coupling unrelated land retries to closeout exhaustion.
- Keep the Round-2 gate-retirement/TURN-CAS/writer-fence changes, corrected dependency baseline, net-deletion commitments, and full acceptance matrix; re-review found no new blocker in those areas.

## Issues & Recommendations

1. **`onDaemonPid` still fires too late to close the actual spawn window.** The plan says persisting at `onDaemonPid` eliminates spawn-to-ready ambiguity (`plan.md:32,38`), but `CodexDaemonGoalRuntime.startSession` calls the callback only after `await this.spawnDaemon(...)` returns (`codex-daemon-goal-runtime.ts:279-307`). `spawnCodexDaemon` creates the child at `codex-daemon-runtime.ts:494-524` and does not return until the socket appears at `:657-669`. A Bridge crash in that interval leaves a detached child with neither persisted process-group identity nor a socket yet; after it binds, the two-fact reaper cannot prove its group. During the same pre-bind interval, the new socket-first liveness probe can report socket absence and allow the existing `pgrep`-based host check to produce a false `dead`. Persistence failures are also currently swallowed, which permits an unowned daemon to continue. **Suggested fix:** add an awaited or synchronous spawn-identity hook inside `spawnCodexDaemon`, immediately after `spawnFn` returns and before the first await/socket poll. Persist the detached group identity there; if persistence fails, kill and verify the partial spawn before rejecting. For non-destructive probing, a persisted group that is alive or indeterminate while the socket is absent must yield `unknown`; `absent` requires both no socket listener and no live persisted group. Test a deliberately paused spawn before socket creation, Bridge crash/terminate in that interval, persistence failure, and subsequent real-wrapper/reaper convergence—not merely “before thread ready” after the socket already exists.

2. **The chosen `awaiting_receipt` lease policy creates an unbounded one-second hot loop.** The dispatcher reconciles every second (`workflow-engine-dispatcher.ts:266-280`), and both delivery scans select `turn_granted` rows whenever `next_retry_at` is null (`StateStore.ts:25837-25857,42745-42765`). Releasing ownership on every neutral carrier pass (`plan.md:69`) therefore causes a fresh generation and `carrier_delivery_claimed` event each second (`StateStore.ts:42828-42856`), after repeating session checks, git worktree probes, activation, TURN replay, and wake-ledger lookup. Rework has the same due-row problem and still lacks an explicitly neutral post-send outcome; its mandated “every pass” liveness classification (`plan.md:72`) would likewise run host/tmux probes at engine-tick frequency. In addition, the current carrier drain counts every new outcome other than `busy`/`settled`/`wake_delivered` as held (`workflow-ship-carrier-coordinator.ts:194-216`). **Suggested fix:** define `awaiting_receipt` for both coordinators and park it durably with owner/lease cleared plus a bounded `next_retry_at`, without changing hold count, failure accounting, stable grant timestamps, or last error. Choose an explicit liveness-recheck cadence and interpret “every pass” as every due pass; TURN receipt projection must bypass that schedule and promote immediately. Exempt the neutral outcome from held/delivered metrics. Add a 180-second simulated one-second dispatcher test that proves bounded claims, events, git/liveness probes, and TURN grants across restart while a late ACK still projects immediately.

3. **The 48-hour terminal boundary contradicts its acceptance test.** Fix 6-C says `now - first_closeout_attempt_at > 48h` (`plan.md:174`), while the test says the operation holds “at 48h” (`:179`). At exactly 48 hours those contracts disagree. **Suggested fix:** use `>= 48h` if the stated at-boundary behavior is intended, or change the test to the first instant greater than 48 hours; add boundary cases for 48h−1ms/48h and attempts 12/13. Also update the plan masthead from R2 to R3 so the reviewed revision is unambiguous.

## Verdict

CHANGES REQUESTED — address items above
