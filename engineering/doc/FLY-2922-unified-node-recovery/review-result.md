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

## 2026-09-26 重开：FLY-2921 合同补充的 scoped review

有效 reviewVerdict=APPROVED，reviewerVerdict=APPROVED；gate `0f29f815-f140-4e68-ac08-073a9a996389`，request `b5e92e5c-ce11-4f40-ab94-35d74af3e4c9`。审阅内容为 `af2178f24` 的 design-correction.md（blob `3ecbe57194f7e675b011b339e481e801a730d68a`）；原计划未修改。原 Follow-ups 继续保留。

新增 4 MEDIUM / 4 LOW 均为非阻塞 advisories，未据此重开设计或宣称已解决。已报告 Lead，durable report `3f7025a4-f051-4fc4-8889-88f8e3d426a9`（即时 doorbell 超时，报告持久入队）。以下完整保留供实现/集成处置。

### preadmission-producer-rework-carveout (MEDIUM)

§3.6 的准入前失败 producer 没有明确排除 rework_replacement:* 意图（Lead 合同不变式 6）

FLY-2921 plan §6.1 不变式 6（origin/flywheel-FLY-2921 d12124f39）要求：2922 的 §3.6「准入前失败 → run_recovery_required + run held」必须排除 reason 以 rework_replacement: 开头的意图，这类意图交给 coordinator 按投递失败计数。已批准的 plan.md §3.6（第 195 行）仍把 engine_rework_replacement_context_invalid 列为「当次登记」的结构性错误。本补充的精确覆盖清单（第 21–27 行）没有点名 §3.6，只有第 5 条用一句总括「active 的返工 replacement 走 2921」，第 38 行的负控也只测投递失败。照 §3.6 字面实现会出现两种后果：一是 2922 的 producer 重新把返工失败变成 run held，违反不变式 2；二是和 2921 coordinator 的 replacement_launch_stalled 计数形成双重归属。建议：在覆盖清单里明确修改 §3.6，reason 以 rework_replacement: 开头的意图，无论错误码是什么都不进入 2922 producer；同时加一行负控：rework_replacement 意图在准入前抛错或被 fence 拦下时，run 保持 active，没有 run_recovery_required，由 coordinator 计数。

### merge-order-dependency-unstated (MEDIUM)

2922 写 pending 依赖 2921 先合入，但文档没把这个合入顺序写成硬约束，对旧消费者的拒绝方式也写得不准确

第 14 行说旧 dispatcher 会用 engine_rework_replacement_context_invalid 拒绝，这不准确。更早的 fence 在 workflow-engine-dispatcher.ts:2483–2493：deliveryState !== 'replacement_pending' 时只记日志 engine_rework_target_launch_fenced 然后 return false，不会抛错。按 §3.6，return false 属于忙碌、不算故障，所以意图会一直停在 intent_recorded，形成没有 episode 的静默卡死。与此同时，当前 coordinator（workflow-rework-coordinator.ts:629–640）看到 pending 且替身还没有 session 时，会走 releaseRetryable('actor_session_missing')，经 settleWorkflowReworkFailure 最终把 run 打成 needs_lead/held。第 17 行和第 27 行的「后合者同步」允许任意合入顺序，但 2922 先合时，第 33/38 行的验收不做 2921 的活就过不了（dispatcher fence、coordinator、markWorkflowReplacementStartedTx 按 §6.1 都归 2921）。建议二选一写进文档：(a) 2922 的返工恢复切片以 2921 已合入为硬前置；(b) 2921 合入前，2922 遇到返工目标一律返回精确 409（例如 rework_target_owned_by_2921），不 mint，对应不变式 4 的「或拒绝并指向它」。同时把第 14 行的拒绝方式改准确。

### shared-materializer-preconditions (MEDIUM)

「共用物化方法」的前置条件与历史 held run 的场景不兼容，替身预算的交互也没写

第 3 条和第 5 条要求历史 held 的死目标用共用物化方法和协议认可的替身来源（engine:proven_dead_replacement）。但 2921 C2 的 replaceWorkflowReworkActor 有三个前置条件：coordinator 持有 owner+generation 认领、delivery ∈ {pending, turn_granted, wake_delivered}、run active。历史 held run 的 run 是 held，2921 迁移后 delivery 是 returned_to_lead，coordinator 在 run 非 active 时也不认领，所以这三条都满足不了。文档没说明是抽出事务内核并由 2922 的权限做 CAS，还是另开一个变体。另有两点：2921 的换体预算按「最近一次 engine:hold_resume 之后、interpreted_by 为替身来源的行数」计算，operator 的显式恢复如果计为 proven_dead_replacement，可能被预算拒绝，或者恢复后下一次自动换体立刻超限；另外 StateStore.ts:43073 的 writer 迁移消费者一旦看到 interpreted_by=engine:proven_dead_replacement，就要求存在匹配的 rework_replacement_materialized 事件，且 payload 带 requestId/deadExecutionId/newExecutionId/routeRevision/launchOrdinal，否则静默跳过。建议写明 2922 调用的事务内核、它自己的前置 CAS（run held + returned_to_lead/历史态 + 精确 tuple），以及预算是否重置，并在验收里断言 writer 迁移和 materialized 事件齐全。

### rework-replacement-context-not-preflighted (MEDIUM)

stage/apply 没有预检 dispatcher 的返工替身上下文谓词，可能铸出永远启动不了的派发却返回 200

第 4 条只要求消费端做校验。dispatcher 的 replacementContext（workflow-engine-dispatcher.ts:2511–2575）还要求 base_revision 必须是 40 位十六进制、buildWorkflowReworkContext 成功、内容不超过 WORKFLOW_AGENT_CONTENT_BUDGET、lead authority_context 一致。而 StateStore.ts:68319–68323 引擎创建的返工请求可能回落为 base_revision='unavailable'。这类历史请求一旦走 2922 的 redispatch_current，会拿到 HTTP 200 dispatch_recorded，但替身会被确定性拒绝，之后要么被 2921 反复换体直到 returned_to_lead，要么进入 §3.6 循环，正好是 plan §8 列出的「只写出账本、consumer 拒收」最大风险。建议 stage 和 apply 复用同一个只读谓词做预检，不满足就返回精确 409（例如 rework_replacement_context_unlaunchable），零 mint，并加一个 base_revision 非 40 位十六进制的负控夹具。

### section5-row-not-overridden (LOW)

覆盖清单漏了 plan §5 的「replacement 回滚再额外 delivery held」行

2921 不变式 7 点名的四处包括 plan.md §5 第 220 行。该行把 replacement 回滚改成「统一 episode」，这与 2921 C4.1 冲突：replacement 回滚归 2921，写非 hold 事件 rework_replacement_launch_rolled_back，run 保持 active。第 16 行的「当前核对」提到了 C4，但第 1 条的精确覆盖只列了 §2/§3.4/§7/research。建议补进覆盖清单：§5 该行只适用于非 replacement 绑定。

### alive-rearm-route-source-unspecified (LOW)

活体同 actor 重投时新 route revision 的 interpreted_by 没有规定

2921 用 engine:hold_resume 标记 Lead 重投并重置换体预算，isReworkReplacementLaunching 只认两种替身来源。第 6 条保留同 actor 重臂，但没说新 revision 用哪个 interpreted_by。建议明确用 engine:hold_resume（或 2921 认可的等价来源），避免预算不重置，也避免被误判为替身启动中。

### sibling-contract-unpinned (LOW)

引用的 FLY-2921 合同没有固定提交，且对方计划仍是 draft

origin/flywheel-FLY-2921 的 plan.md 状态是 draft，progress 为 design 4/6，只有参考评审、没有有效评审。本补充引用 C2/C4/C6 时没有固定 commit 或 blob（当前是 d12124f39）。建议写上所依据的 2921 plan 提交和 blob，并加一条规则：2921 有效评审改动了 §6.1 不变式时，本补充需要重新对齐。

### tests_not_run (LOW)

本轮没有运行测试

worktree 没有 node_modules（根目录和 packages/teamlead 都没有），而本补充只改了文档，没有改代码，所以本轮没跑任何 vitest。结论来自静态核对：dispatcher 2483–2493 的 launch fence 与 2511–2524 的上下文校验、coordinator 580–640、StateStore 43055–43095 的替身 writer 迁移消费者、markWorkflowReplacementStartedTx、68319–68323 的 base_revision 回落值，以及 origin/flywheel-FLY-2921 plan §C2/C4/C6/§6.1 原文。另确认 plan.md 自 c4d40fbed 起未变，SHA-256 为 7de9bef9…a1c5，本补充的 blob 为 3ecbe57194f7e675b011b339e481e801a730d68a。
