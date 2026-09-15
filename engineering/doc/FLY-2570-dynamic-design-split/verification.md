# FLY-2570 动态设计分流 — 验证记录
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-15
基于: implementation.md

## Current gate state

Lead response `c9acedb6-b811-4848-936c-c848d5c04e1b` instructed immediate closeout of session 27130, acceptance of the teamlead first-attempt receipt with host RPC contention disclosed, and immediate non-draft PR/review. The session was stopped with Ctrl-C and returned terminal exit 0; that shell status is **not aggregate green**. No gate 5 was started. Exact-head CI is the aggregate of record.

Gate 4 retained receipts are in `verification-artifacts/`. Ten packages passed. Claude-runner completed 50/50 files, 1340 passed, 0 failed, 2 skipped on both attempts, each with only onTaskUpdate RPC timeout. Teamlead first attempt completed 1116/1116 files, 14424 passed, 0 failed, 7 skipped, with only onTaskUpdate RPC timeout. Its internal retry was interrupted under the Lead ruling. The partial summary has no finishedAt and does not cover the five remaining packages; it is not a complete PACKAGE_GATE_RECEIPT. Earlier full-run failures remain disclosed-not-waived below.

- Root lint: exit 0, 18 existing warnings (`/tmp/fly2570-review-lint.log`); later CLI guard passed focused Biome.
- Root recursive build: exit 0, including gate 4 build; teamlead also rebuilt after review corrections.
- Four whole admission/menu/dispatch/HTTP suites: 127 passed, 2 existing skips (`/tmp/fly2570-review-regression.log`).
- Complete operator shell, SQL comparison shell, CI shell enumeration and retention consumer gate passed. Detailed TDD evidence is in implementation.md.
- Effective final code review and exact-head CI remain pending. No QA handoff or production activation is claimed.

## Retention and persistence

No schema migration or new table. Existing assignment event is written at run/node admission by StateStore.createWorkflowRun with no execution_id, and replay finds it by run/node. SQL filtering uses that identity; duplicate assignments are ambiguous. `terminal-row-archive.ts` WORKFLOW_EVENT_TYPES and `scripts/lib/fly-2006-retention-engine.mjs` workflowRunEvent both only admit rework_delivery_claimed/released and workflow_engine_alert_enqueued/posted to cleanup. design_model_arm_assigned remains durable outside both lists. The existing static consumer gate excludes .sql sources; its green alone is not the retention proof, the inspected allowlists are.

Task 2 file-backed StateStore close/reopen tests establish saved policy replay while current ratio changes. Task 3 restores the same ratio/version and validates failed writes leave bytes unchanged, live-holder exclusion, dead-holder recovery, Fable locked reread and verification rollback. Detailed red/green receipts remain in implementation.md.

## Pending

Per the latest Lead ruling, proceed directly to non-draft PR and final-head review. Exact-head CI must cover all packages, including the five not reached by the interrupted gate 4. Wait for CI and effective APPROVED, report and complete --route needs_review. No QA dispatch, merge, production configuration change or restart.

## First aggregate failures and correction

The first gate's claude-runner result is red: 2 test cases failed, 1336 passed, 4 skipped (reporter failed=6 counts failing parent tasks as well as test cases). This is not an RPC-only failure and is not accepted as aggregate green.

1. New QA-only cleanup sites require the mechanical kill-path inventory update. Regenerated inventory changes only two entries (12 lines): Fable concurrency child cleanup and the operator orphan-recovery child kill. Focused inventory test passes.
2. The unchanged real-tmux identity test births its server under a hardcoded PATH preferring `/opt/homebrew/bin/tmux` (3.7c), while this runner's original PATH resolves `/usr/local/bin/tmux` (3.5a) for the next command. Both binaries/versions were read live. Original focused rerun reproduces `server exited unexpectedly` at new-window; running the same unmodified tests with `PATH="/opt/homebrew/bin:$PATH"` gives 6/6 across real-tmux and inventory. Log: `/tmp/fly2570-runner-path-recheck.log`. No production code, assertions, skip conditions or host configuration changed.

The original aggregate later finished red. Preserve original receipt `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-cjWJ8U/summary.json` as red. Final gate remains pending.

Early review is registered against f65313a99: gate d14d923e-845b-4586-9f23-e4c3ee2e91e5, request a464246f-af20-403a-8137-8a11fcfd6c6d. Final head must receive its own effective review and CI evidence after all changes/docs/milestone.


## Review correction verification

See implementation.md Code review R2 corrective work for the actual admission defect, frozen-key replay fix and red/green evidence. Final focused regression: 127 passed, 2 existing skipped (four files), `/tmp/fly2570-review-regression.log`. New selection replay consumes the existing durable design_model_arm_assigned event through StateStore.listWorkflowRunEvents; it uses the same retention class as existing dispatch replay. The source scanner only enumerates direct SQL, so this method-level consumer is explicitly documented here rather than adding a stale scanner entry. Both cleanup allowlists exclude this event; `/tmp/fly2570-review-retention.log` remains ok:true/errors:[] after the changes.

Updated `pnpm lint` passed (exit 0, 18 existing warnings; `/tmp/fly2570-review-lint.log`) and teamlead build passed (exit 0; `/tmp/fly2570-review-build-final.log`). Full package verification remains pending as detailed below. Next review must cover the final corrected head and keep it frozen until verdict.

## First gate closed; corrected gate active

Original gate cjWJ8U finished 2026-09-15T07:06:26.335Z, exit 1: 15/17 packages passed; claude-runner and teamlead failed. Teamlead had 8 failed / 14412 passed / 7 skipped cases, all failures in the two unchanged real-tmux suites. With the same consistent PATH as the corrected gate, those unmodified suites pass 11/11 (`/tmp/fly2570-teamlead-tmux-recheck.log`), confirming the same host binary mismatch. Original receipt remains red and is diagnostic only: source fixes landed while it was still running.

Corrected full gate: session 97315, `/tmp/fly2570-packages-corrected.log`, receipt `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-csfOhG/summary.json`. Started at code containing f37b0176a. Its claude-runner package has passed completely (1340 passed, failed=0); remaining packages are still running.

Final input audit also reproduced `show --config --codex-percent` silently treating an option as a path and displaying fallback. Added one argument guard and regression assertion, within the approved strict-CLI contract. `/tmp/fly2570-cli-option-test-red.log` fails on exit 0; `/tmp/fly2570-cli-option-test-green.log` passes the complete shell suite including concurrency/orphan/runbook tests. Focused Biome passed. This later change only rejects malformed CLI arguments; no package source changed after the corrected gate started. Final exact-head CI remains required.


## Isolated temporary-directory verification

The corrected gate csfOhG subsequently failed one unchanged config test, `runner-config-writer.test.ts > refuses a symlinked config path`, before its assertion: `symlinkSync` raised EEXIST at `fly709-writer-link-60027-11.yaml`. `lstat` proves this symlink was created on 2026-09-11T07:33:48.316Z, days before this run. The test uses process.pid plus a reset sequence and leaves this symlink behind, so PID reuse collides with old test artifacts. No files belonging to other runs were removed.

The entire unmodified suite passes 21/21 under a fresh TMPDIR (`/tmp/fly2570-config-temp-proof.log`). This focused recovery does not make the corrected aggregate green. A complete final gate was started with both `PATH="/opt/homebrew/bin:$PATH"` and a unique TMPDIR at `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/fly2570-final.76D5FB`; session 35023, `/tmp/fly2570-packages-isolated.log`. No test assertion, skip condition, package-gate rule, or production behavior was changed for these environment recoveries.


## Subsequent aggregate failures and bounded recovery

Gate csfOhG finished at 2026-09-15T08:13:05.066Z with exit 1: 15/17 packages passed. In addition to the config stale-symlink failure, teamlead had one failed test (`founder-routing-response-route`, response body `not found` was not JSON), 14423 passed, 7 skipped, and one onTaskUpdate RPC error. It is not an eligible RPC-only receipt.

Gate obZGlw is still running but already red: quota-probe, lifecycle-closeout, lead-actions-runner-integration and tmux-environment-scrub logged failures. The new long TMPDIR caused a concrete Unix socket `listen EINVAL` at the MCP child broker path. Other failures include a quota synchronization assertion with subsequent timeouts and a closeout liveness assertion; these are preserved as failures, without assuming a shared root cause.

Unmodified suites under a short unique `/tmp/f2570.XXXXXX` root and consistent tmux PATH passed: founder-routing-response-route, quota-probe, lead-actions-runner-integration, tmux-environment-scrub (32/32, `/tmp/fly2570-short-root-proof.log`) and the complete lifecycle-closeout suite (59/59, `/tmp/fly2570-closeout-proof.log`). These focused passes do not make either aggregate green. Package-gate already sets VITEST_MAX_FORKS=1; the next complete run will retain that setting, use a short unique TMPDIR, and start only after existing aggregate processes finish to avoid overlap.

## Gate 3 terminal correction

Gate obZGlw finished 2026-09-15T08:42:14.445Z, exit 1: 16/17 packages passed; teamlead had 29 failed, 14395 passed, 7 skipped, 9 failed files, and 5 errors (four long-socket EINVAL and one onTaskUpdate). This supersedes the historical running status above. Its failure is retained and not waived.

## Replacement execution CI inventory repair

Exact-head CI run 34959360441 on 4204ff847 failed Quick Gate at ci-structure.test.sh: script-tests-3 inventory/order drift. The same command failed locally before repair. The operator test was registered in ci.yml but absent from the strict expected inventory. Added only its expected step name; no production code or workflow behavior changed.

Lead ruling 3d47bcee-230e-4d4f-be1f-7ed21ba76291 authorizes immediate repair despite the pending old review, one commit/push and one fresh review registration, then freeze. The progress cursor is included in this same commit to honor that explicit one-commit limit.

Fresh verification passed: ci-structure; ci-shell-suite-enumeration (319 shell suites, 62 Node suites); check-workflow-startup (7 workflows); workflow-startup Node tests (4 passed); kill-path inventory (5 passed); pnpm lint (exit 0, 18 existing warnings); pnpm -r build (exit 0). Lint/build logs: /tmp/fly2570-ci-repair-lint.log and /tmp/fly2570-ci-repair-build.log. No host full package run was started. The next head still requires effective code-review APPROVED and exact-head CI; this focused recovery does not make run 34959360441 green.
