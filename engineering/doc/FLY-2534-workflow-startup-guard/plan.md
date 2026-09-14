# FLY-2534 Workflow 启动守卫 — 实施计划
Issue: FLY-2534 (https://linear.app/geoforge3d/issue/FLY-2534)
日期: 2026-09-13
基于: research.md

## Design gate

Draft; implementation requires APPROVED review_design. Do not modify this document after its review blob is pinned.

## Bounded implementation

1. Add a failing regression exercising actual actionlint against the current beta workflow; assert that the historical job-env runner context fails. Move TRUSTED_BETA_ROOT initialization to an early shell step writing the same RUNNER_TEMP/beta-receiver path to GITHUB_ENV. Verify later steps consume the path, including receipt generation, and existing release structure/admission contracts stay green.
2. Add a small executable workflow validation entry point over all tracked .github/workflows/*.yml and *.yaml (a superset of changed PR workflows; no diff/classifier bypass). Run pinned actionlint 1.7.12 with shellcheck/pyflakes disabled. Preserve queue:max via an exact diagnostic exception plus explicit validation of concurrency queue values/cancel semantics. Fail on parser errors, missing/empty jobs, invalid contexts, unknown workflow keys, and validator failures. Never execute the target workflow or obtain publish credentials.
3. Install the pinned validator and invoke the entry point in always-on Quick Gate, which CI OK already requires to succeed. Add literal enumeration of new tests. Test positive workflows and mutations for historical illegal context, malformed YAML, missing jobs, misspelled jobs/on keys, invalid queue settings, and removal/skipping/continue-on-error of CI wiring. Validate both .yml and .yaml discovery and no changed-file dependency.
4. Run focused tests and all required gates: pnpm lint, pnpm -r build, pnpm test:packages:run, every new scripts/__tests__/*.test.sh. Record full-suite failures separately; do not broaden repair scope without evidence. Register exact-head code review through the injected request-review protocol, resolve blocking findings and re-review new heads. Confirm exact-head GitHub CI including Quick Gate and CI OK.
5. Keep progress durable; write implementation evidence and milestone (literal last commit before opening PR). Open PR, report receipts to Lead, and complete --route needs_review --pr NUMBER. Do not merge, deploy, or dispatch QA.

## Acceptance and boundaries

- Original workflow startup context failure is detected before fix and absent after fix.
- Required CI rejects an invalid workflow, even with documentation-only classifier output; valid workflows pass.
- FIFO queue max, shared group, admission, trusted receiver and frozen source semantics remain unchanged.
- Published actionlint compatibility exception is narrow and tested; it is not a general syntax-ignore policy.
- Static validator proves syntax/context eligibility; a real beta schedule/release on main is QA/ship evidence and cannot be claimed from local tests. If live beta startup proof is required before merge, obtain a safe isolated smoke route from Lead rather than dispatching a production publisher.

## Rollback

Revert this change to restore previous CI wiring; that also restores the known beta startup defect. No data/schema changes or restart required.
