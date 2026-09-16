# FLY-2612 Linear 父关系编辑 — 实施计划
Issue: FLY-2612 (https://linear.app/geoforge3d/issue/FLY-2612/raya工程修复-补齐-linear-工具修改已有-issue-的父-epic并读回验证)
日期: 2026-09-15
基于: 无

Lead ruling on question 772040ce-8a99-4a73-b4b8-bb9f0f78f329: simple_code, plan_only, issue description is approved scope; no design review. This supersedes injected full-doc defaults.

## Approved behavior
PATCH /api/linear/update-issue accepts parentId: nonblank identifier/UUID moves the existing issue; explicitly passed null detaches; omission preserves existing behavior. Reuse existing master-only parent-write authorization and projectName binding. Validate source and target scope with existing linear-scope helpers; require same team and same actual project, reject unknown parent, cross-team/project, self/cyclic relation. Forward canonical parent UUID (or explicit null) to updateIssue; never create a replacement issue. Mutation failure cannot return success. Fresh read-back must prove requested parent and original identity; errors after mutation must indicate possible completed write, not silently succeed or automatically roll back.

Exact GET returns actual parent {id, identifier} or null from Linear, not request echo. No new credentials, private Raya client, or expanded scoped-token capability.

## TDD steps
1. Add red HTTP tests in packages/teamlead/src/__tests__/linear-reparent.test.ts for forwarding, explicit detach versus omission, auth/scope rejection, nonexistent/cyclic targets, mutation failures, read-back and repeat requests preserving identity. Use mock SDK with mutable issue state and real HTTP route.
2. Add exact parent read tests to linear-comment-and-lookup.test.ts; extend packages/teamlead/src/bridge/linear-query.ts query and mapping, without changing list behavior.
3. Minimal implementation in bridge/plugin.ts; use small bridge/linear-reparent.ts helper if necessary for bounded ancestry validation. No unrelated API cleanup.
4. Focused verification: VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/linear-reparent.test.ts src/__tests__/linear-comment-and-lookup.test.ts src/__tests__/create-issue.test.ts src/__tests__/linear-issues.test.ts. Record actual red/green evidence.
5. Run pnpm lint, pnpm -r build, pnpm test:packages:run (aggregate green or permitted complete PACKAGE_GATE_RECEIPT). No DB schema migration; verify restart/replay via reconstructed fixture server and repeat requests. No new shell test unless implementation requires one.
6. Commit, request exact-head code review through injected gate/request-review, resolve blockers; milestone file engineering/doc/milestones/FLY-2612.md as literal last commit before PR. Push feature branch, open PR, verify exact-head CI, report and complete --route needs_review --pr <actual number>. No QA dispatch, merge or deploy.

## QA / production boundary
Lead says FLY-2608 was already manually reparented; implement must not touch production Linear or move any live issue. QA verifies with sandbox issue under criteria Lead will add to Linear. Preserve original task's standard-tool real parent, idempotency, identity/history and permission acceptance checks in QA handoff. Code/PR/CI do not prove deployment or Raya production capability. Reverting code does not automatically reverse any business parent change.
