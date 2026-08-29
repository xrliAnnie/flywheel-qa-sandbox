# Design Review — prd.md (Round 3)

Date: 2026-07-08
Author: Codex
Status: APPROVED

## Summary

R3 closes the R2 blockers. The PRD now has a buildable MVP boundary, a replayable materialized workflow snapshot, a workflow-aware ship-gate evidence model that does not reuse the legacy `qa_required/auto_qa_record` contract incorrectly, and an explicit kickback loop trigger. I would hand this to implementation with the two non-blocking implementation notes below.

## What's Good (Keep)

- **Materialized snapshot is now sufficient for runtime independence from project YAML.** §6 stores normalized nodes, resolved edges, skip decisions, overrides, loop counters, current node/edge state, and treats template/registry hashes as audit-only (`engineering/doc/FLY-1020-workflow-templates/prd.md:186`, `engineering/doc/FLY-1020-workflow-templates/prd.md:192`). The copy-forward contract covers handoff, QA loop wake/spawn, retry successors, and an issue-level authority copy for startup/finalizer paths (`engineering/doc/FLY-1020-workflow-templates/prd.md:204`). This addresses the per-execution `session_params` limitation (`packages/teamlead/src/StateStore.ts:3168`, `packages/teamlead/src/StateStore.ts:3202`) and the fact that handoff/retry create new executions (`packages/teamlead/src/bridge/phase-orchestrator.ts:1426`, `packages/teamlead/src/bridge/actions.ts:840`).
- **The ship-gate model no longer deadlocks.** §7 correctly stops trying to make templated internal QA satisfy the legacy Auto-QA gate. The new branch only applies when an execution has `workflow_snapshot`; otherwise legacy `qa_required/auto_qa_record` behavior is unchanged (`engineering/doc/FLY-1020-workflow-templates/prd.md:220`). That matches the current source: legacy `evaluateQaShipGate` requires a passed `auto_qa_record` for `qa_required=1` (`packages/flywheel-comm/src/ship-eligibility.ts:114`, `packages/flywheel-comm/src/ship-eligibility.ts:185`), while current three-stage QA PASS only records the phase verdict and proceeds to the QA phase's ship path (`packages/teamlead/src/bridge/phase-orchestrator.ts:929`).
- **Product skip-QA is now on the right seam.** It no longer depends on `onMainAwaitingReview`, which is main-only in both coordinator and sinks (`packages/teamlead/src/bridge/auto-qa-coordinator.ts:306`, `packages/teamlead/src/DirectEventSink.ts:755`, `packages/teamlead/src/bridge/event-route.ts:2015`). Entry-time `workflow_qa_exempt=1` is the correct shape (`engineering/doc/FLY-1020-workflow-templates/prd.md:238`).
- **The three control planes are now orthogonal.** §7.4 cleanly separates template enable/kill-switch, independent Auto-QA spawn policy, and ship-gate enforcement (`engineering/doc/FLY-1020-workflow-templates/prd.md:242`). This avoids the R2 ambiguity where `FLYWHEEL_AUTO_QA=0` might have silently changed workflow shape.
- **Kickback coverage is complete enough.** §5.1 now names `founder_feedback_kickback` and preserves the critical guards: keep-alive only, QA in `awaiting_review`, runner-driven review evidence, gate response recorded, bypass the recorded PASS guard, route to implement, and QA does not edit code (`engineering/doc/FLY-1020-workflow-templates/prd.md:155`). Those match the current orchestrator guards (`packages/teamlead/src/bridge/phase-orchestrator.ts:804`, `packages/teamlead/src/bridge/phase-orchestrator.ts:817`, `packages/teamlead/src/bridge/phase-orchestrator.ts:860`) and Blueprint prompt (`packages/edge-worker/src/Blueprint.ts:1028`).
- **Sequencing is now dependency-correct.** §13 moves the ship-gate evidence model ahead of orchestrator migration, so the state fields and gate semantics are known before the workflow interpreter starts emitting them (`engineering/doc/FLY-1020-workflow-templates/prd.md:323`).

## Non-Blocking Implementation Notes

1. **Make the `workflow_qa_passed` head source authoritative.**  
   The right seam is the PASS branch in `phase-orchestrator.ts`, but that branch currently does not capture a head (`packages/teamlead/src/bridge/phase-orchestrator.ts:929`). `qa-result` can carry `prHeadSha`, defaulting to the QA runner's git HEAD (`packages/flywheel-comm/src/commands/qa-result.ts:41`, `packages/flywheel-comm/src/commands/qa-result.ts:119`), but the implementation should either capture the QA phase head server-side via the existing `capturePhaseHeadSha` effect, or validate the reported `prHeadSha` against a captured head before writing `workflow_qa_passed`. Fail closed if the head is missing/invalid. The later `evaluateShipEligibility` comparison should be against the same `prHead` it already receives for merge/ship eligibility (`packages/flywheel-comm/src/ship-eligibility.ts:266`).

2. **Add a workflow-run discriminator to the issue-level snapshot.**  
   §6 says the authority copy is issue-keyed (`engineering/doc/FLY-1020-workflow-templates/prd.md:206`). That is fine for the current one-active-workflow invariant, but implementation should include a `workflow_run_id` or `root_execution_id`/generation in the issue-level record and in execution copies. That prevents stale events from an older workflow attempt on the same issue from accidentally consulting the newest issue-level snapshot during reconcile.

3. **Keep the sentinel tests concrete.**  
   The acceptance criteria are good; make them executable with at least these cases: no snapshot legacy ship gate unchanged, templated eng PASS writes head-bound `workflow_qa_passed`, head drift invalidates it, product skip-QA never calls `onMainAwaitingReview`, `FLYWHEEL_AUTO_QA=0` does not remove internal QA nodes, template kill-switch does not change legacy Auto-QA, canonical YAML deletion after entry does not strand an active workflow, and founder-feedback kickback follows the existing guarded path.

## Verdict

APPROVED — ready to implement with the notes above.
