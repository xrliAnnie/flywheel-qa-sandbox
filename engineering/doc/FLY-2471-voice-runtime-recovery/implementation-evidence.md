# FLY-2471 语音运行恢复 — 实施验证
Issue: FLY-2471 (https://linear.app/geoforge3d/issue/FLY-2471)
日期: 2026-09-10
基于: plan.md

## Baseline

- Locked dependency installation: pnpm install --frozen-lockfile, exit 0.
- Before behavior edits: pnpm -r build, exit 0; log /tmp/FLY-2471-baseline-build.log.
- Runtime and provisioner baseline: 2 files, 15 tests passed; log /tmp/FLY-2471-baseline.log. These are baseline results, not implementation acceptance.
- Design round 1 requested changes on abort-drops-root-receipt. Revised plan commit 8765c8f54 preserves guarded successful receipts before cancellation and shares status cooldown across changing failure reasons. Round 2 request 7e0c42e7-b584-4134-92b3-02e6e88ca83e, gate 8b1b8ad5-8891-4b60-a2d1-015db8bf5f33 remains pending at this entry.

## Host gate exception and QA criteria

Lead ruling on question 5fa812be-6ceb-46b9-b261-0ef684bcf9d6 authorizes running `pnpm test:packages:run --exclude '**/tmux-viewer.macos.test.ts'` as the host gate exception. This test opens real Terminal.app and is forbidden on this shared host.

The PR description must carry this exemption. QA must not rerun this test and must not fail acceptance solely because it is excluded. The unmodified full package gate is not claimed verified. All other required package tests, lint, build, and any new shell tests remain required. No production/Discord/visual proof is claimed from unit tests.

## Remaining implementation evidence

TDD receipts, final gate results, code review, PR and completion receipt are pending. No behavior edits have been made at this entry.

## Provisioning batch

R3 design APPROVED: request 70f91fb4-2364-481c-a8a6-1b670e1aefba, gate bda5f703-63ef-4ad4-a928-29273f5e45bf. Approved implementation plan at 6fbe41ca1. Lead requested a documentation-only seven-advisory addendum under instruction 94bc78ca-125b-4ca3-83e8-ca656ade7c6d; no advisory features were added.

TDD receipts (all /tmp/FLY-2471-* logs):
- tdd-runtime-throw-red: registry_drift rejects tick (1 failed / 3 passed); green 4/4.
- tdd-runtime-timeout-red: tick still unfinished at 30 seconds (1 failed / 4 passed); green 5/5.
- tdd-cursor-red: aborted cursor proceeds instead of rejecting; green 13/13, including stale takeover to desired.
- tdd-abort-paths-red: eight expected failures (pre-aborted claim, three mutation receipts, four effect rejection paths); green 21/21.
- tdd-cleanup-red: interrupted cleanup proceeds rather than stopping; no further effect after abort now verified.
- tdd-services-red: actual provisioning fetch has no AbortSignal; wiring green.
- tdd-services-green: runtime/provisioner/services 3 files, 28/28 passed.

Known deferred cleanup-notice replay and sequential scan latency remain as recorded in the Lead addendum. Full final gates and code review remain pending.

## Poll status batch

- tdd-backoff-red: alternating errors emitted every poll; green verifies exact 30/60/120/240/300-second spacing and continued polling.
- tdd-reset-reporter-red: success failed to reset cooldown and reporter rejection aborted the tick (2 failures); green verifies per-session reset and reporter isolation.
- tdd-prune-red: missing/unleased sessions retained cooldown (2 failures); green 10/10 runtime tests.
- Additional regression verification: genuine cursor failures with absent/nonaborted signal still terminalize; a database reopen resumes a salvaged root without reposting; newer epoch rejects old receipt; route pre-claim error remains 503.
- focused.log: 42 tests / 4 files passed, then services-final.log: 2/2 including real services-to-router error propagation (43 current focused cases).
- pnpm lint: exit 0 with existing warnings, /tmp/FLY-2471-lint.log.
- pnpm -r build: exit 0, /tmp/FLY-2471-build.log.
- Authorized package test gate is running; no new scripts/__tests__/*.test.sh files added.

## Full package gate and review-route receipts

The authorized full package command exited 1: claude-runner test/codex-tui-nudge-support.test.ts:187 expected probe CLI exit 0 but received 130. That package reported 1255 passed, 1 failed, 2 skipped. Original log: /tmp/FLY-2471-packages.log.

Single-file verification on this branch passed 4/4 (/tmp/FLY-2471-probe-repro.log). Clean detached main d964e9fca also passed 4/4 (/tmp/FLY-2471-main-probe.log); its tracked status was clean. The temporary baseline worktree was removed after verification. This does not establish a deterministic pre-existing failure: suspected concurrent/environment flake only. Lead ruling 92aad4c5-1831-47fb-abb7-6e8849f8d7d6 permits code review/PR with original failed full-gate receipt, single-file receipts and the separately run remaining five packages, provided scope tests have no failures. No second actual test rerun, unrelated fixes or extra exclusions. Exact PR CI is authoritative.

The five packages not reached by the stopped full command are being run separately: edge-worker, teamlead, release-contract, voice-codex, voice-bridge; /tmp/FLY-2471-remaining.log. Aggregate result is still pending at this entry.

Local codex:rescue was invoked read-only but failed to initialize its thread with sandbox-exec sandbox_apply Operation not permitted, exit 71 (/tmp/FLY-2471-rescue.log). Lead ruling ad830524-fbb5-4da6-b212-70ed401bb6f2 confirms the injected request-review cross-family route is the required code review receipt; local rescue is not mandatory and no sandbox bypass/raw codex fallback is allowed. Record one line in the PR; register formal review only after final evidence/HEAD, and do not push while that review runs.

## Final local verification disposition

All package commands have now terminated; none remain running.

| Receipt | Result |
| --- | --- |
| Authorized full packages command | exit 1 at claude-runner probe: 1255 passed, 1 failed, 2 skipped |
| Probe standalone / clean main standalone | 4/4 and 4/4 passed |
| Remaining edge-worker | 1321 passed, 14 skipped |
| Remaining voice-bridge | 649 passed |
| Remaining teamlead full | 13080 passed, 3 failed, 7 skipped; plus onTaskUpdate RPC timeout |
| Remaining release-contract | 24 passed |
| Remaining voice-codex | 122 passed |
| Three failed TeamLead files, one targeted batch | 68 passed, 1 failed: claude-profile-cli public use school command still fails; StructuredInboxRouter and bridge pass |

Teamlead full failures: StructuredInboxRouter pre-ready chokidar error/cleanup hook timeout; bridge alert_unreachable_config timeout; claude-profile-cli integration command failure. Original split log is /tmp/FLY-2471-remaining.log; targeted log /tmp/FLY-2471-teamlead-repro.log; last package log /tmp/FLY-2471-last-packages.log. All scoped voice tests passed in focused and full runs.

Lead ruling 831603b3-442b-43cc-9b89-3c9a061d7f6b attributes these unrelated failures to host contention from nine concurrent full-suite runners and authorizes proceeding to code review/PR, with no further local full reruns or unrelated fixes. This is the Lead's disposition, not a claim that local full tests passed. PR wording: 本地全量红=宿主并发争用,范围外. Exact-head CI remains authoritative. Preserve the still-failed targeted profile case as well as targeted green cases.

Lead ruling ad830524 authorizes formal cross-family request-review despite unavailable local rescue. GUI test exclusion and QA prohibition above remain binding. QA should assess provisioning timeout recovery, guarded receipt replay/epoch boundaries, and status cooldown/reset against the PR's exact HEAD. No migration, real Discord proof, merge, deployment or QA dispatch was performed by implement.
