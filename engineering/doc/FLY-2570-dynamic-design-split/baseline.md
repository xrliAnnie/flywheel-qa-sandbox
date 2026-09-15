# FLY-2570 动态设计分流 — 基线验证
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-14
基于: plan.md

## 设计评审等待期间的基线证据

Source HEAD: 5eacc41b5 (only design documents since 6af2b8990).

- Initial comparison shell test failed before assertions: ERR_MODULE_NOT_FOUND for locked zod dependency in teamlead/src/ship-judgment/epic-history.ts.
- pnpm install --frozen-lockfile: exit 0, no lockfile edits. Initial bin warnings were for workspace dist artifacts not yet built.
- pnpm -r build: exit 0; log /tmp/fly2570-baseline-build.log.
- bash scripts/__tests__/fly2403-design-model-comparison.test.sh: exit 0, PASS four deterministic read-only arm metrics; log /tmp/fly2570-baseline-report.log.
- No behavior changes yet; this is baseline proof, not feature acceptance or aggregate suite green.

## Retention evidence

scripts/fly-1998-database-retention-sweep.mjs WORKFLOW_EVENT_PREDICATE and scripts/lib/fly-2006-retention-engine.mjs workflowRunEvent policy only delete rework_delivery_claimed, rework_delivery_released, workflow_engine_alert_enqueued and workflow_engine_alert_posted. design_model_arm_assigned is outside both allowlists. Existing event retention therefore supports saved configuration version replay.

## Implementation reminders

- New shell test must be explicitly enumerated in .github/workflows/ci.yml beside FLY-2403 shell test; ci-shell-suite-enumeration.test.sh enforces it.
- progress CLI rewrites its Markdown body; preserve narrative evidence in dedicated docs. Its phase argument must match stage-derived phase (design while design_review).
- Design gate b6c4947a-4e6f-4781-80f1-1ec4854e050e; accepted request be386671-b0ea-42d8-9cfd-bdea387578d8. Only effective APPROVED authorizes implementation.
