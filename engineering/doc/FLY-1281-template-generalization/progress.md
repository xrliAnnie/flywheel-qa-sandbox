---
issue: FLY-1281
phase: qa
phaseCursor: 7/7
updated: 2026-07-15T23:58:00.000Z
nextStep: QA FAIL (1 HIGH) — implement phase must fix Blueprint capability isolation; QA parked awaiting re-test
chunks: []
pointers: {}
---

# FLY-1281 progress
**phase**: qa (7/7)
**next**: QA FAIL — awaiting implement fix, then re-verify

QA verdict at head 18fca9f28: **FAIL (1 HIGH)**.
Initial PASS was WITHDRAWN — my testing never probed the generated Runner prompt.

BLOCKING (HIGH): generalized no-write/no-ship node still receives the legacy
APPROVE GATE / MERGE AUTHORITY / verify-approval / needs_review / :cool:
instructions when checkpoints are enabled (flywheel production has
brainstorm + approve_to_ship ON). Root cause: the FLY-47 checkpoint loop in
packages/edge-worker/src/Blueprint.ts skips those gates for isQaRunner only —
there is no isGeneralizedExecution skip.
Committed RED regression test: Blueprint.generalized-workflow.test.ts >
"suppresses brainstorm/approve_to_ship gates for a generalized node when
checkpoints are enabled".

Also from Codex round 2 (not independently reproduced, for implementer):
2 MEDIUM in runs-route.ts (selected_by owning-Lead check rides the legacy
BRIDGE_DEPT_SCOPE_REJECT kill-switch; committed-launch-proven-dead permanently
holds instead of the R9/R10 delivery-attempt CAS repair).

Verified good: 180/180 own tests, CI green, E2E 14/14 reproduced, mutation
verification 4/4. See qa/qa-report.md + qa/qa-verification.json.
