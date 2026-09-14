# FLY-2508 更新器与 beta 线对齐 — 实施记录
Issue: FLY-2508 (https://linear.app/geoforge3d/issue/FLY-2508/1143b3a-更新器与-beta-线对齐本机-updater-部署的-main-commit-与-beta-铸版的)
日期: 2026-09-13
基于: plan.md

## Scope and authority

Approved plan blob: `62a4e3086f3a00c4e039bfe1b9d1a59acde6b2ff`, unchanged.
Lead question rulings `7d702556-8be4-484a-9ad7-11e8908034de` and
`def75a6d-b21d-4145-a845-27fd4e2ef48b` authorize independent implementation before
PR #1156 merges. Only actual B3 helper wiring must await that merge.
No B3 helper copy/stub, production configuration, takeover, beta publication, deployment, or main merge has been performed.

## Implemented evidence

| Requirement | Implementation and executable evidence |
| --- | --- |
| Config source policy and default | `beta-release-config.ts`; config package 819 tests passed after expected red; ConfigLoader uses shared parser |
| Canonical project config refresh | `beta-release-config-source.test.ts`: 5 passed; default, local policy, invalid policy and sanitized output |
| Frozen source origin | Nullable additive migration and required reserve origin; direct store tests 2 passed after expected red; existing StateStore beta tests 6 passed, including reopen |
| Ancestry guard | `onDefaultBranch`: identical/ahead, behind/diverged/base mismatch, malformed schema and HTTP errors; GitHub suite 15 passed after expected red |
| Scheduler source and failure paths | 20 tests passed; missing/uninjected/invalid source, off-branch and GitHub failures; no HEAD fallback, cooldown recovery, active policy freeze |
| Rollback identity | Same scheduler fixture proves covered_by_newer settles without same-source alignment, while published does satisfy same-source equality |
| Management source label | Current-config enum projection and strict validator; fixed browser labels; 12 management/DOM/contract tests passed after expected red; HTML injection guards |
| Runbook | Existing FLY-2393 runbook extended with config semantics, takeover prerequisite, real receipt distinction and binary/config rollback |

## Verification limits

- `pnpm lint`: exit 0, 16 warnings.
- `pnpm -r build`: exit 0.
- Exact `pnpm test:packages:run`: exit 1, stopped in config with 3 timeout failures
  (drift-scan boolean census, 5000ms; two fly1981-final-ledgers scans, 15000ms).
  Config summary: 816 passed / 3 failed. This is **not** an aggregate green result.
- Diagnostic two-file rerun: 37 passed / 1 failed; auxiliary-tunings scan still timed out at 15000ms.
  No timeout or unrelated code was changed.
- Separate complete teamlead suite: exit 1 after 522.23s; 14 failed / 1001 passed files,
  26 failed / 13587 passed / 7 skipped tests; one unhandled error:
  `[vitest-worker]: Timeout calling "onTaskUpdate"`.
  Failures include timeouts, the FLY-2339 <1000ms performance assertion (1291ms),
  account CLI child failures and a chat-thread route failure.
  This suite is not green. Beta scheduler, source-config, transport, store and management DOM tests passed.
  Full failure details remain in `/tmp/fly2508-teamlead-full.log`; unrelated failures have not been changed.
- Screenshot unavailable: local headless Chrome exited 134; browser MCP refused under approval-policy never.
  DOM tests are executable markup evidence, not visual acceptance.
- No new shell test files were added.
- Review, exact-head CI and PR handoff have not been completed.

Logs for this execution are under `/tmp/fly2508-*.log`; the progress cursor names active process handles.
These are local diagnostic artifacts, not production evidence.

## Remaining completion requirements

**Superseded sequencing (Lead instruction `8e2111e8-ca3a-4fab-9ab5-9dbb3d9d54d6`, 2026-09-13):**
Proceed with the current independent implementation through local checks, PR, code review,
exact-head CI and needs_review without waiting for #1156 and without calling park.
B3 真 helper 接线待 #1156 合入后由 Lead 开 rework 接续。
The actual branch contains an optional scheduler reader injection, with missing-reader
fail-closed coverage; `createBetaReleaseRuntime` does not yet inject a reader. There is
no copied/stub B3 helper. Consequently production local_deployed_sha selection currently
stays in beta_source_unavailable. This PR does not establish real beta alignment.
The previously listed helper assembly/test requirement below belongs to that later rework;
the approved plan remains pinned and unchanged. Lead owns tracking the dependency.

1. Confirm #1156 merged, sync origin/main while holding TURN, inject its real readLocalDeployedSha helper.
2. Prove runtime assembly using a temporary deployed-sha file; complete any resulting integration fixes and relevant checks.
3. Resolve/report aggregate and visual limitations through the required workflow; obtain final code review and exact-head CI.
4. Commit the issue milestone last, open PR, report evidence, and use `complete --route needs_review --pr <number>`.
5. Subsequent QA owns real beta acceptance after deployment and operational takeover; this implementation record does not claim it.
   A covered_by_newer receipt cannot serve as same-source acceptance.

## Lead verification disposition and non-timeout follow-up

Ruling `bc3ce1f4-e0b6-45d7-aab7-4f985bb4b645`: preserve local aggregate/teamlead failure receipts, do not fix unrelated code; final-head CI adjudicates. DOM evidence is accepted for code review; real browser visual acceptance belongs to QA. Finish the following checks, then park until #1156 merges.

- Chat-thread non-JSON response: exact failing case passes in isolation (1 passed / 59 skipped); its test and tools.ts query router are unchanged from origin/main and do not render the modified management view.
- Account CLI child failures: both exact failing cases pass in isolation (2 passed / 9 skipped); claude-runner and the account integration test have no diff from origin/main.
- FLY-2339 1291ms performance failure: exact assertion passes in isolation (1 passed / 8 skipped); delivery operations/projector/watch, StateStore.ts and flywheel-comm are unchanged from origin/main.

These targeted results support the Lead's host-contention/timing disposition, not a retroactive aggregate pass. Logs: `/tmp/fly2508-chat-recheck.log`, `/tmp/fly2508-cli-recheck.log`, `/tmp/fly2508-perf-recheck.log`.
