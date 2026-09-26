# FLY-2920 B — stall observation evidence

Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md §B、research.md

Implementation evidence from the shared Implement checkout on 2026-09-26. This is scoped local evidence, not CI, QA, production, or ship proof. Parent owns commits, review, and workflow delivery.

## Implemented contract

- `BridgeEventLoopGuard.ts`: removes worker SIGKILL and terminal state. `reportedBeat` prevents repeated evidence collection for an unchanged heartbeat while the sampling interval continues. A changed heartbeat clears the marker and records one recovery; a subsequent stall records again. Existing freeze grace, bounded/redacted process evidence, marker-first attribution, parent rotation, and worker shutdown remain.
- `plugin.ts`: only the associated loop-guard comment and startup log change. Production monitor wiring remains enabled.
- `bridge-exit-marker.ts`: both branches use `Bridge 非正常退出 — 复活对账中`; matching prior stall evidence states `曾观察到卡顿，退出原因未证实`. PID/boot generation selection, timestamp bounds, and episode/idempotency keys are unchanged.
- Production-source child harness now survives two real blocking operations, records `[stall,recovery,stall,recovery]`, then exits cleanly. The fixture's bounded process-group cleanup remains test-only. Existing collector redaction/failure, grace, and SIGSTOP/SIGCONT tests remain.
- Kill inventory removes exactly `BridgeEventLoopGuard.ts:process.kill(process.pid, "SIGKILL");#1`; every other entry remains. FLY-1560 retains monitor existence and lexical enforcement, with obsolete crash wording updated.
- Adjacent `attribution-probe.mts` now expects survival, selects `production observation:`, and reads Vitest JSON to assert exactly two selected cases actually passed. This prevents a renamed selector from producing a skipped-test green. Default remains 20 rounds; `LOOP_GUARD_PROBE_ROUNDS=1` permits a bounded local probe.

## Red before production changes

Command:

```sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/bridge-event-loop-guard.test.ts src/bridge/__tests__/bridge-exit-marker.test.ts --maxWorkers=1 --minWorkers=1
```

Actual result: **2 files failed; 6 failed, 29 passed / 35 tests**; exit 1. The new recovery case received only `[stall]`, both non-testMode child cases actually exited `{code:null,signal:SIGKILL}`, and three alert assertions received the old suicide title. These failures occurred before the production changes.

## Green and retained guards

| Command | Result | Local log |
|---|---|---|
| `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/bridge-event-loop-guard.test.ts src/bridge/__tests__/bridge-exit-marker.test.ts src/bridge/__tests__/fly1560-teardown-guard.test.ts --maxWorkers=1 --minWorkers=1` | Final run: 3 files, 42 tests passed (19 + 16 + 7), exit 0 | `/tmp/fly2920-B-final.log` |
| `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/bridge-child-process-census.test.ts --maxWorkers=1 --minWorkers=1` | 1 file, 1 test passed, exit 0; census fixture unchanged | `/tmp/fly2920-B-census.log` |
| `pnpm --filter flywheel-claude-runner exec vitest run test/kill-path-inventory.test.ts --maxWorkers=1 --minWorkers=1` | Retry: 1 file, 5 tests passed, exit 0. Initial parallel run reached the existing 15s deadline in two scans (3 passed); no guard/timeout change. Retry scans took 5.962s and 9.989s. | `/tmp/fly2920-B-inventory-retry.log`; first run `/tmp/fly2920-B-inventory.log` |
| `bash scripts/__tests__/bridge-liveness-probe.test.sh` | 31 scenarios passed, 0 failed, exit 0. Existing hermetic down/page-latch/recovery/new-episode assertions retained. | `/tmp/fly2920-B-liveness.log` |
| `pnpm exec biome check` with all eleven changed B TS/CJS/MJS/MTS/JSON paths explicitly enumerated | 11 files checked; no fixes/errors after formatting | Tool output |
| `LOOP_GUARD_PROBE_ROUNDS=1 pnpm exec tsx packages/teamlead/src/__tests__/fixtures/loop-guard/attribution-probe.mts` | **Unverified host-only attribution**, exit 2: `/bin/ps` unavailable. Correctly refuses fallback green; does not claim real `sleep` attribution. | `/tmp/fly2920-B-attribution-probe.log` |

`ps` denial does not skip the production survival cases: both still run and assert the unknown/null collector fallback. Real-worker injected collector tests assert marker/child attribution and redaction. The dedicated host probe must be rerun on a host that permits process inspection to claim real-child attribution.

## Isolated real HTTP acceptance

`bridge-stall-liveness.test.ts` starts `createBridgeApp` in an isolated child with an in-memory StateStore and a loopback ephemeral port. The fixture uses the exact current worker source with `testMode:false`; it blocks the main thread until a temporary resume file appears (15s emergency bound), so `/health` cannot run. The actual external probe shell performs real curl requests with a shortened 100ms timeout; only its clock and post sink are test seams. All probe state, output, and forensic records live in temporary files. Recovery occurs in the same PID, followed by IPC-requested clean fixture shutdown. No production service command or live database is used.

Command:

```sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/bridge-stall-liveness.test.ts --maxWorkers=1 --minWorkers=1
```

Final strengthened run: **1 file, 1 test passed**, exit 0, 18.59s including fixture startup (`/tmp/fly2920-B-http-final.log`). It asserts curl results `[0,28,28,28,28]`, no recovery before the resume marker, exactly one down page, exactly one all-clear after two healthy probes, unchanged PID, and exactly one stall/recovery forensic pair. Initial real HTTP run also passed (`/tmp/fly2920-B-http.log`).

## Self-review

The worker source has no process signal or replacement kill path. Duplicate sampling returns before heavy collection. Recovery clears both reported heartbeat and saved snapshot. Production enablement is unchanged; full plugin diff contains only the agreed comment/log hunks. Tests retain log rotation, evidence redaction, collector failure distinction, same-generation exit attribution, and monitor existence. Permanent stalls now require the external alert and authorized manual recovery path; no automatic restart is introduced.

## Retained FLY-2331 guard consumer

The exact consumer sweep also retained `scripts/__tests__/fly2331-bridge-async-child.test.sh` and its built-artifact fixture `scripts/fixtures/fly2331-guard-arm.mjs`. The shell no longer treats SIGKILL as success: asynchronous child execution must retain its heartbeat denominator and emit no stall; synchronous execution must finish with exit 0 and zero in-operation heartbeats, then produce exactly one attributed-generation stall/recovery pair. Child stdout completion, the fake git call, process-group timeout reaping (2/2), and detached reaping (1/1) remain required. The fixture waits at most 5s for recovery and always stops its guard/timer. Script isolation uses explicit state, sync-op, and log paths, without assigning HOME. Build failures now print the captured compiler output.

Command for both RED and GREEN (the script builds claude-runner and teamlead first):

```sh
FLY2331_ACCEPTANCE_SLEEP_SECONDS=2 FLY2331_GUARD_STALL_MS=300 FLY2331_MIN_HEARTBEATS=1 bash scripts/__tests__/fly2331-bridge-async-child.test.sh
```

RED after successful builds, before fixture changes: exit 1, `blocking mutant unexpectedly survived the guard` at fixture line 31 (`/tmp/fly2920-B-fly2331-red.log`). Earlier compiler preflight failures are not RED evidence: the B helper now explicitly rejects a missing first forensic record to satisfy strict array indexing; the parent fixed a separate C narrowed-union error.

GREEN: exit 0 after fresh claude-runner and teamlead builds; `PASS fly2331 async=4s sync-observed=3s async-heartbeats=2 sync-heartbeats=0 evidence=stall+recovery group=2/2 reap=1/1` (`/tmp/fly2920-B-fly2331-green.log`). `bash -n` passed for the shell; Biome passed the fixture; `git diff --check` passed.

## Consumer selection and final batch checks

`consumers-B.json` records the full-path, file-name, parent-directory, and module-stem search matches with individual retained/excluded dispositions. The scoped `vitest related` command selected three related files and passed all 36 tests (`/tmp/fly2920-B-related.log`); lexical census/teardown/inventory guards were retained separately above. `bash scripts/__tests__/flywheel-log-rotate.test.sh` passed 14 checks (`/tmp/fly2920-B-rotate.log`). Repository `pnpm lint` passed with 25 warnings (`/tmp/fly2920-lint-BC.log`); no warning cleanup was included. Both specification and code-quality reviews passed, including the later shell consumer follow-up. These local results are not full CI or host QA evidence.
