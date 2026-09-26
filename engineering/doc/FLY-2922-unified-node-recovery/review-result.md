# FLY-2922 设计评审与交接 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-26
基于: plan.md

## 有效评审结果

有效 reviewVerdict=APPROVED，reviewerVerdict=APPROVED。
- questionId: d9ab4f85-f464-4fee-9c09-7af6295b0c9a
- requestId: 16c59728-a305-411a-9cfd-7db7c803987e
- 计划提交: c4d40fbed；后续仅增加交接/验证记录，获批计划正文保持不变。
- plan.md SHA-256: 7de9bef9d44818fa2a689a98dc517087154cafbe568126e6cb2aeb4edf11a1c5
- plan.md 开头的“待 R4”是送审时状态；以本条有效评审回执和 progress.md 为当前状态，不为改标签改动已审内容。

## 非阻塞 Follow-ups（交给 Lead 处置）

以下为评审 advisories，不是新一轮阻塞，不声称已实施解决：

### root-initial-pinned-start-semantics (MEDIUM)

The R3 fix correctly stops root nodes from reading the unlaunched old body's HEAD, and the start authority is now frozen. However, when RunDispatcher receives a pinned startPoint it skips continuityComputer (run-dispatcher.ts:1576 only runs when !req.startPoint), so it no longer passes continuityInherit (branch/prNumber/prUrl). Blueprint's BRANCH CONTINUITY prompt (Blueprint.ts:2445) then disappears. Worse, the engine dispatcher sets shareParentBranch=true for every phase role (workflow-engine-dispatcher.ts:3066), and Blueprint.ts:1407-1414 enters the takeover branch when design has startPoint!==undefined && continuityInherit===undefined (implement/qa only need startPoint). That branch takes over the per-issue expected worktree and errors on any drift. A normal first root launch has startPoint undefined and never hits this, so the recovery path is no longer 'the same selection rule' as the original start. Fix: when the frozen result came from continuity/resume, pass the matching continuityInherit/progressResume (or give RunDispatcher an explicit frozen StartAuthority input that keeps the original semantics); when it came from the default base, specify whether startPoint may be left unset or how takeover is avoided. Add a root_initial regression with an existing origin branch/PR and with a registered worktree left behind by the old body, asserting the Blueprint context matches a normal first launch.

### pre-admission-producer-land-scope (MEDIUM)

The scope condition 'node pending, no activation admission/launch commit' also covers land intents. In the land branch of consume (workflow-engine-dispatcher.ts about 2380-2447), a land intent stays intent_recorded for many ticks while the operation advances. landExecutor, recordWorkflowLandPartial (engine_land_partial_*) and completeWorkflowLandNode (engine_land_completion_*) can all throw, and land never has an activation binding or marker/window. Under the default transient bucket in §3.6, 3 occurrences spanning rollbackMs would mark the land node failed, hold the run and possibly abandon the intent, even though the land_operation may already be partial with external steps such as merge done. The land recovery in §3.4 only specifies the operation held→partial CAS, so a run whose operation is not held after §3.6 holds it has no matching recovery branch and can be left with no exit. Explicitly exclude engine-owned executor nodes (land/gate) from §3.6 and hand them to the existing land_held/recordWorkflowLandPartial protocol, or define land-specific classification and a recovery branch consistent with §3.4; add a negative control where land throws repeatedly.

### pre-admission-fence-inapplicable (MEDIUM)

§3.6 asks the server to obtain an exact launch cancellation fence and positive no-start evidence from marker/window before escalating. The existing cancellation fence (StateStore.ts about 40600-40700) requires node.state==='admitted' plus an activation binding; otherwise it returns node_execution_not_admitted / execution_binding_mismatch. A pending intent that failed before admission has no binding, no launch owner and no window. Implemented literally, the new producer can never obtain the fence, and failures revert to silent stalls. Before admission a launch cannot happen at all (launch owner acquisition comes after admitGeneralizedWorkflowExecution), so the no-start proof should be defined as an in-transaction recheck: latest ordinal + intent_recorded + node pending + no binding + no workflow_launch_owner row. Or explicitly add a pre-admission fence variant. Do not reuse the admitted-only API.

### tests_not_run (LOW)

This round is still design documents only, and the worktree still has no node_modules, so no vitest suite was run. The conclusions come from static reading of the frozen source. I confirmed: WorkflowStartReservationRow has no base SHA; RunDispatcher's startPoint/resume/continuity selection order; how Blueprint uses continuityInherit/takeover; that commitWorkflowTransitionTx's idempotent replay comes before the priorEdges guard (consistent with the §3.5 decision-edge semantics); the completion disposition at 64239 and the ship-ready entry search at 73048; and the cancellation fence preconditions. The R3 HIGH root-start-lineage-head-unresolvable and the MEDIUM decision-edge-consumer-audit are addressed in the design text; pre-admission-consume-failure-no-episode now has a producer, with the scope/fence advisories above.

## 交接边界

设计文档与 founder HTML 已提交。九单及新增反例的行为验证属于后续实现/QA；本节点未改业务代码、未运行全套测试、未部署、未自行派发后继。图形渲染按任务允许的降级方式保留本地 Mermaid 图源及明显占位，细节见 delivery-evidence.md。
学习记录按允许的 memory 更新路径写入单条 update note；未直接改写共享 role/project memory 索引。
