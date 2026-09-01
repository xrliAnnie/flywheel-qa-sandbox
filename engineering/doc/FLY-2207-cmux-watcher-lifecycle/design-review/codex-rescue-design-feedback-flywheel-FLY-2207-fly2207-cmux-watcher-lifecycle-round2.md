# Design Review — plan.md FLY-2207 cmux-watcher-lifecycle (Round 2)

Date: 2026-08-31
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 adopts all seven requested architectural directions and is substantially safer and smaller: patrol no longer unloads the label on the stalled path, planned parks are fenced twice, failed recovery remains retryable, and founder escalation gets a branch-independent identity. The plan is buildable, but four execution/test contracts remain incomplete; most importantly, the unchanged post-kickstart probe can still reject a healthy replacement because of the exact same same-argv watchdog residue that caused the incident.

## What's Good (Keep)

- Keep the split between tuple-bound `kickstart -k` for a loaded/stalled job and `--rebuild` for an absent job. Preserving the updater's no-argument bootout/bootstrap deploy path while deleting patrol's shutdown/census/straggler-killer machinery is the right scope boundary.
- Keep park classification ahead of `!job.ok`, plus the shell-side marker recheck immediately before bootstrap. The sensor/mutation double fence and race-injection test directly close the maintenance-piercing failure.
- Keep the existing success-only `recoveryEpisodes` latch. The specified fail-first/succeed-second/success-latched test preserves retryability instead of recreating a one-shot door.
- Keep heartbeat activation before `watch_main`, the fixed timeout ceiling, the cross-branch `unhealthyGeneration`, the full-union routing updates, and removal of the proposed `/health` component.
- Keep FLY-913's decision matrix byte-for-byte unchanged and make all default lifecycle QA hermetic; real host drills remain optional and founder-authorized through the existing audited bypass.

## Issues & Recommendations

1. **[HIGH] The unchanged post-kickstart probe still treats the incident's watchdog residue as health authority, and its new window is shorter than the allowed residue lifetime.** Plan lines 85-90 retain the existing probe and census count, with `FLYWHEEL_CMUX_WATCHER_PROBE_TRIES=60`. The current probe (`scripts/lib/restart-cmux-watcher.sh:222-256`) requires `new_count == 1`, while `cmux_watcher_process_pids` deliberately matches the same-argv Bash watchdog. Sixty probes at the existing 0.5s interval cover only 30s, but T1 permits a call timeout of exactly 60s and the existing kill grace adds 1s. Therefore a verified new lease owner and matching heartbeat can coexist with the old watchdog for roughly 61s, causing `probe_failed` even though the label and replacement watcher are healthy. Make the new lease owner tuple/process incarnation plus matching heartbeat PID authoritative for the kickstart probe; treat additional census candidates as diagnostic only. Add a deterministic test where the replacement owner/heartbeat are valid while an old same-argv candidate remains beyond 30s. This deletes a false veto and needs no new knob.

2. **[HIGH] `unhealthyGeneration` is undefined for a cold Bridge start into an already-unhealthy watcher, and the critical clear/preserve rules are not fully tested.** Plan lines 132-139 say the generation begins on a `healthy/park -> unhealthy` transition. A Bridge that starts while the label is already absent has no prior healthy/park observation; a literal implementation can recover repeatedly yet never start the 600s founder-escalation clock. Define the rule as: whenever the current verdict is one of the four tracked unhealthy branches and `unhealthyGeneration` is null, create it, including the first patrol observation after process startup; preserve it through every non-healthy/non-park transitional verdict; clear it only on verified healthy or either park verdict. Extend T3 tests with (a) cold boot directly into `job_absent`, (b) unhealthy -> `owner_starting` -> `owner_missing` preserving the original key/time, and (c) park clearing the generation before a later unhealthy generation starts a fresh clock.

3. **[HIGH] T5.4 does not yet define a hermetic or relevant backfill proof.** The existing 529 room recipe is a Bridge/Runner fixture, not a cmux-watcher isolation fixture: `scripts/test-deploy.sh` sets `TEST_PROJECT_NAME=test-slot-N` and `FLYWHEEL_STATE_DIR`, but it does not relocate `HOME`; `flywheel-cmux-sync.sh` resolves many durable files from `$HOME`, uses the fixed `/tmp` lease unless explicitly overridden, and needs explicit tmux/cmux socket isolation. Also, watcher startup backfills dead-window runners through cold-start `sync_additive_bootstrap` (`watch_main`, lines 11627-11640); `consume_pending_reopen_sweep` is conditional on an app socket-generation change and is not the lifecycle path under test. Enumerate the exact isolated HOME/state/lease/heartbeat/maintenance/event/tmux/cmux seams, use 529 only to produce a runner fixture if useful, and assert creation by the startup additive reconcile with no pending reopen generation. If that composition is cumbersome, extend the existing `scripts/test-cmux-sync.sh` hermetic fixture instead of claiming the stock 529 recipe covers it. For T5.1, separately assert the rendered plist's KeepAlive/Throttle contract; a PATH stub cannot itself prove launchd scheduling.

4. **[MEDIUM] The timeout-clamp test list covers only `FLYWHEEL_CMUX_CALL_TIMEOUT`, despite the normative change applying to both CALL and PING.** Plan lines 56-59 clamp `CMUX_PING_TIMEOUT_SECONDS` and `CMUX_CALL_TIMEOUT_SECONDS`, but line 68 specifies only `FLYWHEEL_CMUX_CALL_TIMEOUT=900`. Add a table-driven test for both variables, including `60` accepted and an over-limit value falling back to the respective default with the expected WARN. This also locks the bound used by the watchdog/probe lifetime analysis above.

Existing baseline verification remains green: `restart-cmux-watcher.test.sh` 17/17, restart-guard 282/282, and cmux-autostart flags 6/6. Those tests exercise the current implementation; the new Round 2 cases above are still required before implementation can claim the revised contracts.

## Verdict

CHANGES REQUESTED — address the four items above; no architectural expansion is needed.
