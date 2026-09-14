# FLY-2541 B3 reader 接线 — 实施记录
Issue: FLY-2541 (https://linear.app/geoforge3d/issue/FLY-2541)
日期: 2026-09-14
基于: plan.md

## Implemented

Design gate 84546393-d54d-443d-9a4e-fb3348414d94 / request
328de69c-51ab-4052-95ff-20a658aa5f50 returned effective APPROVED.
Reviewed plan content was committed unchanged in 4cc1145bf.
Implementation commit: 60b5c0d2b.

Runtime uses the real FLY-2390 readLocalDeployedSha helper, with the injected
env path passed through at each read. Undefined preserves the helper's existing
process-env/home default; production passes process.env. All local-policy tests
explicitly name a temporary file, so missing/invalid tests cannot read host state.

Scheduler checks the reader only for a new local-source lane, after owner=bridge
and before assertDrained/bind. Missing/uninjected/invalid source prevents activation.
Existing in-flight reconciliation remains before this guard. Due-time reads and
default-branch compare remain in place. Unbound cooldown remains process-local;
successful activation after recovery starts a full interval with no backfill.

Runbook names the deployed-runtime prerequisite and the same Bridge process B3
probe. That authenticated GET appends verdict history and is reserved for authorized
operations. It documents legacy rollback, activation delay and real-beta receipts.
The current FLY-2541 issue requires state green/hold; old FLY-2508 acceptance of
soak_insufficient is not treated as completion here. No soak policy changed.

## Verification

- Scheduler TDD: 3 expected failures / 17 passed before guard; 20 passed after guard
  and recovery assertions (/tmp/fly2541-scheduler-red.log, scheduler-green.log).
- Runtime TDD: 3 failed / 3 passed before wiring; 6 passed after wiring.
  Real temporary files cover initial and due-time failures, reread, frozen SHA/origin,
  compare input and no HEAD fallback. GitHub responses are fixtures, not real beta.
- Combined focused verification: 3 files / 29 passed, exit 0
  (/tmp/fly2541-focused.log).
- pnpm lint: exit 0, 18 warnings (/tmp/fly2541-lint.log).
- pnpm -r build: exit 0 (/tmp/fly2541-build.log).
- Independent subagent read-only scheduler/runbook review: no blocking findings;
  endpoint/query/evidence fields checked against implementation.
- No new scripts/__tests__/*.test.sh files.
- Package aggregate: Lead ruling 04c6c437-e0f9-4492-9319-9b19c21d0b11 authorized
  `pnpm test:packages:run --exclude '**/tmux-viewer.macos.test.ts'`.
  非精确命令、GUI 用例已排除、原因 sandbox_apply 不可用.
  Result exit 1: config 824 passed / 1 failed; stopped at
  fly1981-final-ledgers.test.ts, "freezes the exact five Batch 6 retirement ledgers",
  15000ms timeout. Test unchanged from base. Log /tmp/fly2541-packages.log.
  This is a failed aggregate; downstream packages were not all reached.
  Lead directs retaining the red receipt, one isolated check and exact-head Linux
  CI adjudication, without rerunning the aggregate. Isolated exact case passed:
  1 passed / 10 skipped, exit 0 (/tmp/fly2541-config-isolated.log).
  This isolation does not turn the aggregate green.

## Remaining gates and QA handoff

Draft PR #1182 is open. Code review a611c36d-b800-4996-86d5-409c20cf1780
returned APPROVED at 265e94a4a, with non-blocking unbound-observation persistence
and default-path test advisories. Final-head review/CI remain required after documentation updates. No deployment, owner/config activation,
beta publishing or production B3 query was performed.
Authorized QA must record the real beta version, Actions URL, published/no_change
receipt, occurrence source SHA/origin, publishedSourceCommit and B3 state/evidence.
All attribution SHA values must match, with commit relationship evidence.
Require green/hold without no_deployment_evidence/not_currently_deployed;
beta_source_unavailable must disappear. covered_by_newer and fixtures cannot
satisfy this acceptance. Implement completion must not claim whole-issue QA acceptance.
