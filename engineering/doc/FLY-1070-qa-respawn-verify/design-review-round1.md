# FLY-1070 替身 QA 设计评审 Round 1 — 评审记录
Issue: FLY-1070 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md

Author: Codex
Status: CHANGES REQUESTED

## Summary
The verification plan is directionally strong and mostly matches PR #528 head `5da5fd18`: the core code anchors, F1-F7/F9 test mapping, no-F8-fixtures claim, dual action-router mounts, cap=3, escape hatch, and F10 “no Done consult” reasoning all check out against source. I would not send this to Implement unchanged, because two harness-spec gaps can create either impossible fixtures or flaky/false-negative E2E results.

## What's Good (Keep)
- The verdict table is explicit about PASS vs FAIL vs expected F10 FAIL-partial, and it preserves the substitute-QA boundary: no source edits, no push to `flywheel-FLY-1050`, no production DB writes, no ship.
- The plan correctly insists on module-driven isolation during OOM recovery while still using real dist, StateStore/CommDB, express routers, PhaseOrchestrator, DirectEventSink, event-route, and crash-reaper wiring.
- The mandatory controls are present: cap=3 fail-closed, escape-hatch `FLYWHEEL_THREE_STAGE_QA_RESPAWN=0`, and stranded-pass hardening not gated by that escape hatch.
- Source checks confirm the major code facts: `DEAD_QA_STATUSES={completed,failed,terminated}`, `QA_RESPAWN_MAX=3`, `qaRespawnEnabled()`, `hasProgressedPastImplement` criteria, `isMergeBlocked` as a truthy `merge_block_reason` check, and `/actions` plus `/api/actions` both pass the phase orchestrator holder.
- The F8 gap claim is accurate: the head test tree has F1-F7/F9 coverage but no F8-named fixtures; independent F8 behavior verification is the right QA response.

## Issues & Recommendations
1. **F8c is not constructible as written with a real StateStore.**  
   Why it matters: plan.md §2b says the F8 harness uses a “tmp dir true StateStore” and then asks for an `issue_id=NULL` StateStore-side matrix. At PR head, `StateStore.sessions.issue_id` is `TEXT NOT NULL`, while the CommDB `sessions.issue_id` is nullable. That means F8a can cover the CommDB-only `issue_id=NULL` orphan, but F8c cannot create a null `issue_id` row through real StateStore. The “query exception fail-closed” subcase also needs explicit fault injection; normal tmp StateStore fixtures will not naturally produce it.  
   Suggested fix: split F8 construction into two buckets: CommDB-backed shapes (`issue_id=NULL` orphan lives only in F8a) and StateStore-backed shapes (empty string, wrong issue/project, main-role dead row). For the query-exception path, explicitly allow a dependency-level throwing seam or a deliberately closed/corrupt scratch store, and state which assertion belongs to that injected fault case.

2. **The E2E route assertions need deterministic waiting for fire-and-forget hooks.**  
   Why it matters: the real terminate route calls `reconcileQaLoss(...).then(reconcileTurnBelt(...))` with `void`; the HTTP response returns before the respawn chain completes. The crash-reaper plugin callback is also fire-and-forget. E1/E2/E3/E5/E6 can falsely fail or race unless the harness polls an observable state after the route/reaper call. Existing head tests already use `vi.waitFor` for the action-router shape, which confirms this is a real timing property, not a theoretical concern.  
   Suggested fix: add a harness rule for every fire-and-forget surface: after `/api/actions`, `/actions`, and crash-reaper callback paths, wait/poll with a bounded timeout for `startDispatcher.start`, CommDB turn holder/epoch, thread-note/alert records, and belt side effects before asserting. Also specify that negative assertions wait for the same bounded quiet window.

3. **The real-vs-fake boundary for F8/F10 harnesses needs one more sentence to avoid false confidence.**  
   Why it matters: §4 says “true StateStore/CommDB” and §2b/§3 include shapes that are partly direct behavior tests, partly code audit, and partly injected-fault tests. That is fine for QA, but the current wording can make Implement claim full real-store coverage for cases that are actually seam-injected or audit-only.  
   Suggested fix: in the evidence table, label each F8/F10 subcase as `real-store`, `CommDB-only`, `fault-injected`, or `code-audit`. Require the final report to preserve those labels so the PASS evidence is provenance-honest.

## Verdict
CHANGES REQUESTED — address items above
