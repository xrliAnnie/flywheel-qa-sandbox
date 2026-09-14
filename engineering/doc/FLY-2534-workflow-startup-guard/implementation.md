# FLY-2534 Workflow 启动守卫 — 实现验证
Issue: FLY-2534 (https://linear.app/geoforge3d/issue/FLY-2534)
日期: 2026-09-13
基于: plan.md

## Change and gates

Design review c33aa2a0-c11a-42e9-be98-00ab5e4c3460, request 5924287c-0efc-4664-9909-0a985035e5a0: APPROVED. Plan blob remains unchanged. Advisories reported to Lead in 645f98bc-82bf-4faa-bce3-168be534b788.

Implementation 61aa36d79 moves the invalid job env path into a preceding GITHUB_ENV initialization step, preserving RUNNER_TEMP/beta-receiver for all four consumers. All scheduling, admission, frozen checkout, publish, and receipt steps retain their behavior.

Quick Gate installs SHA-256-verified actionlint 1.7.12 and runs scripts/check-workflow-startup.mjs across every tracked workflow. The script rejects missing/wrong validator versions, empty jobs and invalid YAML, validates every top/job concurrency queue, and invokes semantic actionlint checks. The sole exception is the exact queue-key diagnostic from this older validator; queue:max cancellation is independently checked. Shellcheck and pyflakes are disabled because this gate targets workflow startup semantics, not embedded program linting.

## TDD and focused evidence

- New test first failed on beta line 91: context runner is not allowed in job env. After the minimal initialization fix, it passed.
- Guard fixture test failed before the checker existed, then passed with positive .yaml/job queue controls and malformed YAML, missing/empty jobs, unknown on/jobs, illegal context, invalid top/job queue and cancellation negative controls.
- CI wiring test failed before the Quick Gate step existed, then passed with removal/conditional/continue-on-error mutations. Missing/wrong validator binaries fail closed.
- Receiver initialization test executes the actual shell step with a temporary path containing spaces, verifies GITHUB_ENV output and all four consumers.
- node --test scripts/__tests__/workflow-startup.test.mjs scripts/__tests__/beta-workflow-structure.test.mjs: 9/9 PASS.
- node scripts/check-workflow-startup.mjs: 7 workflows PASS.
- bash scripts/__tests__/ci-structure.test.sh: PASS.
- bash scripts/__tests__/ci-shell-suite-enumeration.test.sh: PASS, including new literal Node suite.
- bash scripts/__tests__/release-workflows-structure.test.sh: 23 PASS, 0 FAIL.
- No new .test.sh suite; new suite is .test.mjs in Quick Gate after validator installation.

## Full repository results

- pnpm lint: exit 0, existing warnings and one literal GitHub-expression fixture warning; no formatting errors.
- pnpm -r build: exit 0.
- pnpm test:packages:run: exit 1. config: 2 failed / 51 passed files, 2 failed / 816 passed tests. drift-scan.test.ts boolean census timed out at 5000ms; fly1981-final-ledgers.test.ts Batch 6 ledger test timed out at 15000ms. Recursive first-failure stopped the aggregate. This is not a full-suite PASS.
- Both named config test files pass in a focused rerun: 38/38, exit 0. This does not change the aggregate failure.
- Baseline aggregate also failed: Comm had 6 failures (3 timeouts, 3 missing compiled TeamLead validator failures while baseline build was concurrent) and [vitest-worker]: Timeout calling "onTaskUpdate". That run is separate evidence and not a clean pre-change baseline.

Logs in this execution: /tmp/fly2534-tdd-red.log, /tmp/fly2534-tdd-green.log, /tmp/fly2534-guard-red.log, /tmp/fly2534-wiring-red.log, /tmp/fly2534-focused.log, /tmp/fly2534-final-{lint,build,packages}.log. No unrelated package repair attempted.

## Remaining handoff evidence

Code review request ee646906-2b4d-4209-bfe5-bde805c8cdce (450f708a-8b55-4b68-8910-3b3faf9a948b) registered on 90f7bc7d8. Later head changes require fresh review. PR/exact-head CI and final review receipts belong in the final Lead report. Static validation is not a beta release execution; no production dispatch, publish, deploy, or merge was performed. Inspect branch-push startup failure records as supplemental evidence; absence alone does not prove a real beta job ran.

PR: https://github.com/xrliAnnie/flywheel/pull/1170. Code gate returned APPROVED round 2 with reviewedHeadSha 0fb685da6c2f18b01284963d2748f16f1895322b (request 69e53bd1-e2f8-4a8a-a32c-e7c1d2a52204). GitHub CI run 34787808890 started jobs and its FLY-2534 startup guard step passed. The other CI jobs were still running at this documentation update; final exact-head CI/review receipts will be reported through Comm after this metadata update. Low advisories are deferred to Lead except filling the milestone PR number.
