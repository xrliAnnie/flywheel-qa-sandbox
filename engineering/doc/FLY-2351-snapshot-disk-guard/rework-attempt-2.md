# FLY-2351 快照消费者返工 — 实施记录
Issue: FLY-2351
日期: 2026-09-09
基于: plan.md

Lead instruction `1e9c9469-5c83-4717-8531-f700d587e3a9` bounds this rework to QA FAIL claim 967 at `afc4eaee641587e5a16a17858c46e42b2d09d06e`: fix the duplicate evidence-directory creation and sequential snapshot acquisition. Keep the 2GB default, one push, one new review round; a new HIGH must be reported rather than expanded into another repair round. No production database copies for verification.

## BLOCKING-1 complete locally

- Removed the rehearsal's duplicate `mkdirSync(evidenceDir)`. Inventory remains the single directory creator.
- Replaced the source-regex rehearsal test with execution of `executeFly2006Rehearsal` against synthetic StateStore/MailboxQueue databases, through inventory, apply, and both VACUUM operations. Synthetic bloat is dropped before invocation; assertions verify successful sealed output and both databases shrinking.
- The exported rehearsal function forwards the engine's existing `allowFixtureSchema` option for synthetic schemas; the CLI never sets it. Production schema validation remains enabled.
- Expected RED: `EEXIST` at engine line 1020. Reintroduced the duplicate mkdir after completing the test and verified the same RED; restored the fix and ran the full retention suite, 25/25 PASS. Snapshot helper suite: 7/7 PASS.
- Test runtime: Node 22.23.2 at `/private/tmp/fly2351-node22.fNjX2U/node-v22.23.2-darwin-arm64/bin/node`. Default Node 25 cannot load the installed Node 22 better-sqlite3 binary; that initial ABI failure was not counted as behavioral RED.

## BLOCKING-2 implemented; full gates running

Cycle-time now acquires each database inside its existing per-source collection boundary. It extracts the small result and hash, awaits finally release, then acquires the next database. Acquisition/budget failures populate that source's existing error/status fields and do not prevent the remaining sources or report from being processed. Three executable synthetic-SQLite tests cover success, teamlead refusal, and comm refusal, including acquire/release ordering and cross-source execution-ID matching.

Lead response to `75253571-36f7-4294-8c8a-89c41f3b5b79` explicitly authorized per-database rehearsal with the other source as strictly read-only guard context. Inventory/apply still binds both database identities and derives cross-database active-owner guards. Only the selected database contributes deletion targets; apply opens the other database readonly. The selected database is pinned in the sealed manifest. Normal production authority, cross-database targets, and VACUUM of the guard context are rejected for such a manifest. Normal dual-database production retention behavior remains unchanged.

The managed orchestration awaits acquire/use/release for teamlead before starting comm. All inventory cohort databases and temporary restore probes now live inside the managed owner directory and are removed with it. Durable output contains only the sealed summary and its checksum. The summary retains top-level `vacuumDurationsMs` for the existing vacuum-summary consumer; detailed evidence is nested under `databases`. A capacity failure yields `status=partial`, a per-database finding, and CLI exit 1 after processing both databases; it cannot appear as complete.

The default remains exactly 2,000,000,000 bytes. Each guard scans actual live files, then reserves scratch for its operation: inventory reserves up to two selected-source sizes for cohort and restore copies; apply and VACUUM reserve one selected-source size. Guard-context file sizes are excluded. These conservative reservations can refuse a rehearsal even when its initial acquisition fits; the refusal is visible for that database and the other database is still attempted. No cap override or configuration knob was added.

Executable managed tests use real snapshot creation, real budget checking, and real finally cleanup with isolated roots. Host disk/process probes are injected, so these are fixture tests, not production-host acceptance. Both-small and one 2GB sparse source cases pass; the latter rejects before copying and still completes comm. The prior B1 end-to-end fixture and existing retention tests also pass (29 total before final negative guards). Cycle-time/helper suites pass 55/55. Initial expected REDs and synthetic host-probe limitations are recorded in `/tmp/fly2351-b2-*.log` for this session; no production database was opened or copied.

Fresh fetch after the complete retry confirmed `origin/main` still equals merge-base `7aec153676b7f8cc9b5d1c32aab09d9d048d64e1`; no rebase is needed. Final lint, recursive build, 55 script tests and 377 patrol assertions passed.

The first whole-package attempt exited 1 after the Claude Runner `onTaskUpdate` RPC timeout (45 files / 1105 passed / 2 skipped, zero failed assertions); later workspaces did not run. The single permitted complete retry also exited 1: Claude Runner passed without the error, all remaining assertions passed, and TeamLead finished 891 files / 12087 passed / 6 skipped with one identical unhandled RPC timeout. The local complete gate is **NON-GREEN**. No third whole-package run, timeout change, or code change was made to hide this.

Lead response `f218fdb4-aec1-4377-b981-14a1c00e7b3e` permits substituting exact-head CI 14/14 after the sole retry when only the Claude Runner RPC artifact remains. Since the identical second artifact occurred in TeamLead instead, question gate `f3e19388-bb79-4e99-b5ab-6633b92f1f44` explicitly confirmed the same ruling for TeamLead: no further rerun, state the non-green local gate in the PR, perform one push and one exact-head review, and require exact-head CI 14/14 before needs_review. No push while review is running. Prior head CI cannot satisfy the new head gate.
