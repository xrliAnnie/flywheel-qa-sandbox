# FLY-2602 effort 验证记录
Issue: FLY-2602 (https://linear.app/geoforge3d/issue/FLY-2602)
日期: 2026-09-16
基于: research.md

## Before implementation
- Locked dependency install: passed.
- `pnpm -r build`: passed, log `/tmp/FLY-2602-baseline-build.log`.
- CLI/recovery/summary migration baseline: 46/46 passed after build, log `/tmp/FLY-2602-baseline-tests-built.log`. Earlier concurrent run had two missing compiled-validator errors while build was unfinished; it is not a behavior regression.
- Actual restart source preflight experiment: passed, log `/tmp/FLY-2602-preflight-experiment.log`. Extends the existing shell fixture in /tmp without changing implementation: effort-only edit passes with receipt unchanged; identity mutation still fails projection mismatch; stale-dist control still fails and mapped source validation passes.
- Live template read-only API: `/api/workflow/templates/:id`, 200 for code/simple_code/eng_heavy. Metadata and manifests preserved in `published-template-baseline.json`; contains no credentials. This evidence establishes founder ownership and old implementation pins, not activation of the proposed change.

## Pending
Aggregate package gate, effective code review, final-head CI and handoff. Production restart and post-deploy API/high-effort evidence remain Lead-owned.

## Lead host update 2026-09-16 01:01Z
Instruction 750325dc-5f48-4bff-839c-6290812ae4e2 reports item C configuration complete: Raya effort high, receipt untouched, source verify-activation ok:true, backup 20260916T010053Z. Runner subsequently read the exact raya/raya row and confirmed effort=high without mutation. Restart/TUI/log and next shuttle proof are separate from this config claim. Remaining implementation is A/B; no receipt writer. The founder-authorized post-landing emergency restart remains Lead-owned.

## Implementation evidence
- Effective design review R3 APPROVED: question 9e11bc73-2432-49b0-9c83-1d8069db25e7, request 2185cf78-7adc-4fcc-9320-726f75cb71e6. Advisories reported to Lead via e824d6e3-6a90-47ea-9420-ed9b8c028550.
- Implementation commit 1756d5d5e: one-time immutable publication migration after FLY-2121; prior founder customizations/ownership retained; supported old Astra-medium implement profile alone changes to Sol-xhigh. Configuration edit was performed independently by Lead, not this commit.
- Astra red: 2 assertions fail, 11 pass before policy edit (`/tmp/FLY-2602-design-red.log`); green: all 13 pass including actual runtime percentage authority.
- Publication red: 2 assertions fail against a no-op entry point (`/tmp/FLY-2602-migration-red-behavior.log`); backup-write guard red: 1 fails, 10 pass before correcting failure-audit writes.
- Final migration suite: 13 pass (`/tmp/FLY-2602-snapshot-green2.log`), covering real HTTP publication reads, unchanged custom fields/history, persisted backup and restart, frozen materialized run snapshot, one-time receipt, CAS/validation/publication/audit failures and inactive/custom profile guards.
- Existing catalog regression: 12 pass; design split: 13 pass (`/tmp/FLY-2602-focused-green.log`). The later disk/snapshot migration suite supersedes its earlier 11-test count.
- Actual source restart preflight shell: passes with effort-only edit and unchanged receipt; identity edit rejected (`/tmp/FLY-2602-preflight-green.log`).
- `pnpm lint`: exit 0 (existing warnings); `pnpm -r build`: exit 0. Logs `/tmp/FLY-2602-lint.log`, `/tmp/FLY-2602-build.log`.
- Aggregate `pnpm test:packages:run` is in progress at documentation commit, log `/tmp/FLY-2602-package-gate.log`. A temporary pnpm wrapper appends `--exclude '**/tmux-viewer.macos.test.ts'` only to flywheel-core's test:run to respect the project prohibition on opening the founder's Terminal.app. The aggregate has not yet been claimed green; its final receipt and exact-head CI are handoff gates.

## CI regression corrections
- First PR head cf618eb6d6b45e8ece723a3b06d33a5f82a90d1a: CI run 35043507521 completed with failures only in teamlead shards 2/4 and 3/4. Job logs identify stale Astra-design xhigh assertions in workflow-menu, workflow-menu-routes, workflow-menu-policy and runs-route.dag-entry. All other jobs passed; this run is not a green CI claim.
- Updated only design expectations to high, retaining implementation xhigh expectations. Menu/model-split regression: 49/49 passed (`/tmp/FLY-2602-menu-regression-green.log`); policy/actual DAG entry regression: 73/73 passed (`/tmp/FLY-2602-ci-regression-green.log`).
- `pnpm lint` passed after those test edits (`/tmp/FLY-2602-lint-tests.log`). New pushed head requires fresh CI and effective code review.
