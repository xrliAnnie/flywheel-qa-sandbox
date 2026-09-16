# FLY-2612 Linear 父关系编辑 — 验证记录
Issue: FLY-2612 (https://linear.app/geoforge3d/issue/FLY-2612/raya工程修复-补齐-linear-工具修改已有-issue-的父-epic并读回验证)
日期: 2026-09-15
基于: plan.md

## 当前证据
- Frozen install completed; first test attempt could not load sibling dist and is not behavioral red evidence.
- Baseline `pnpm -r build`: exit 0.
- Behavioral red: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/linear-reparent.test.ts`: 32 failed / 2 passed, 34 tests. Failures show ignored parentId, missing returned parent, unvalidated parent input, and misleading success after upstream errors. One fixture expected scoped legacy writes to be allowed; investigation proved existing global middleware already denies them, so the fixture is corrected to preserve that restriction.
- Joint regression: existing create/list/exact-read suites passed 95 tests; new suite passed 33/34 with only the known legacy token fixture expectation failing. That expectation was corrected without widening permissions.
- Added project UUID regression: same project name with different UUIDs initially resolved instead of rejecting (1 red); exact lookup now fetches project UUID and ancestry compares canonical identities.
- Pre-sync focused implementation run: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/linear-reparent.test.ts src/bridge/linear-reparent-scope.test.ts` — 2 files, 35 tests passed, exit 0.
- Broader route regression: `linear-reparent`, real scope helper, exact lookup, create and list suites — 5 files, 130 tests passed, exit 0.
- `pnpm lint`: exit 0, 22 existing repository warnings and no errors.
- `pnpm -r build`: exit 0 both before and after syncing `origin/main`.
- Full package gate ran to natural completion and retained its red aggregate. Its first `claude-runner` attempt completed 50 files with 1341 passed and 2 skipped, and its first `teamlead` attempt completed 1227 files with 15570 passed and 7 skipped. Both had zero assertion failures and only the documented `onTaskUpdate` RPC timeout, satisfying the authorized `PACKAGE_GATE_RECEIPT` exception. Automatic retries then exposed host-contention-only timeouts/tails in five unrelated files; all later packages passed. The receipt was emitted at `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-LpR3SB/summary.json`; aggregate process exit was 1 and is not represented as green.
- Per Lead instruction, the failed retry files were not absorbed into this change and the full suite was not rerun. Each file was executed once in isolation with a fresh `TMPDIR`: observation performance 1/1 passed (backlog max 30.90 ms); Epic residual plugin wiring 2/2 passed; Epic materialization 7/7 passed; read-deny sentinel 2/2 passed. The fresh-TMPDIR `codex-memory-seed` run completed but its tool transcript was truncated during runner context compaction, so no new exit-code claim is made; the immediately preceding isolated run of that same file passed 26/26.
- The branch was four commits behind and merged `origin/main` exactly once at merge commit `03f92bbdf`, without conflicts. After that merge, the five focused/regression files again passed 130/130; lint and full build again exited 0.
- The final code-review verdict and exact-head CI are intentionally external structured receipts bound to the final pushed SHA. This document is not amended after those gates, because doing so would create a different unreviewed head.

## Standard HTTP contract for sandbox QA
Use the existing Bridge master-token route; never read or supply a Linear API key. Substitute sandbox identifiers and the registered projectName into this body:

```json
{"issueId":"FLY-SANDBOX-CHILD","parentId":"FLY-SANDBOX-TARGET","projectName":"flywheel"}
```

PATCH `/api/linear/update-issue`; then GET `/api/linear/issue?query=<sandbox-child>&projectName=flywheel`. Both return the original identity and actual native parent `{id,identifier}`. Explicit `parentId:null` detaches; omission does not change parent. Parent-changing requests require valid projectName and existing master authority; scoped credentials remain rejected. Target must exist in the same scope, team and project; cyclic chains fail before mutation.

Repeat the same request after reconnecting/restarting the sandbox service. Check that issue UUID/identifier, contents, comments and history remain on the original issue and that no replacement was created. A write/read-back error with `mutationMayHaveSucceeded:true` requires another read before deciding whether to retry; it is not proof that Linear rolled back.

## Production boundary
Lead ruled that FLY-2608 has already been moved manually and explicitly prohibited production Linear writes in this phase. This runner has made no live issue move, deployment, restart, merge or QA dispatch. Independent QA must validate standard tool availability on sandbox data under the issue's Lead-authored QA criteria. Unit fixtures are not proof of live Linear history preservation or deployed Raya tool availability.

## Lead QA criteria (question 3d746a87-0893-4d38-ad43-9a1e52b0ade3)
1. PATCH accepts parentId; existing target, same team/project via real scope helpers; cross-team/project, self/cycle explicit 4xx; only explicit null detaches.
2. Exact read returns parent {id,identifier}, null when absent.
3. Red/green route, scope, cycle, detach and read-back tests; scope validation cannot be mocked away. Our HTTP tests exercise real scope helpers.
4. QA sandbox issue only: move/detach/repeat, original identifier/description/comments/history retained; no live issue move.
5. Existing shared Bridge Linear tool (lead-actions) must move/read parent; no private client, second credential path or expanded cross-project access.
6. Exact-head CI green; QA does not move head; normal publish-only ship report.
