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

## 2026-09-27 沙箱重开的 scoped review（execution c228b8e1）

本 Bridge 评审门 requestId `3043249d-c594-4d8e-8566-0557d38bcbbd`，plan blob `24413428775c482bdcd16cabcbfa9d5f619acf77`，reviewer gpt-6-astra/xhigh（服务端指定，match=yes）。第 1 轮 APPROVED：thread `01a0e61d-ff71-7912-a009-c45b22957acb`，turn `01a0e61e-04b2-7612-8571-5183b02a9744`。新增设计缺陷 0；保留既有非阻塞建议 1 MEDIUM（shared-materializer-preconditions：替身预算显式恢复语义仍需交接说明）/ 2 LOW（sibling-contract-unpinned、tests-not-run）。只批准设计，不批准实现完整性、行为验收或部署。

Codex 反馈全文：

### Design Review — plan.md (Round 1)

Date: 2026-09-27
Author: Codex
Status: APPROVED

#### Summary

以当前 HEAD `6aa6e2bc7609188fbe6f7550041bcf913363b58d` 为基线完成限定范围复核：原计划结合 `design-correction.md` 的优先覆盖后，仍可在当前 StateStore 事务、派发账本及 dispatcher/coordinator 架构上实施，未发现新的设计阻塞项。返工的目标合同是 `pending + 新 preferred actor + 同 request 的新 route revision + rework_replacement:<requestId>`；active 返工投递失败归 FLY-2921，历史 held 恢复归 FLY-2922，原计划相冲突的旧状态及故障生产端表述不得作为实施要求。本结论仅批准设计，不批准当前实现的完整性、行为验收或部署，既有非阻塞 advisories 不升级为阻塞。

#### What's Good (Keep)

- **审阅对象可复核。** 已读根目录及 `packages/CLAUDE.md`、产品架构规范、exploration、research、补充合同和历次评审记录；`packages/teamlead/CLAUDE.md` 不存在。当前 plan SHA-256 为 `7de9bef9d44818fa2a689a98dc517087154cafbe568126e6cb2aeb4edf11a1c5`，与已批准正文一致；补充合同 blob 为 `3ecbe57194f7e675b011b339e481e801a730d68a`，也与此前 scoped approval 一致。
- **真正的派发与恢复状态同事务。** `StateStore.ts:92304` 的 allocator 仍返回 ordinal，同时写 dispatch ledger 和 launch delivery；当前 `recoverWorkflowNode`（`StateStore.ts:63008` 附近）展示了计划所需的事务接入位置，保存持久回执、关闭精确 source hold、激活 run 并复活 carrier。计划要求的 `recoverCurrentWorkflowNodeTx` 是拟议职责名，不是必须已经存在的同名 API；当前服务入口 `bridge/workflow-node-recovery.ts:148`、HTTP stage/apply（`bridge/runs-route.ts:501`、`:557`）与之相容。
- **FLY-2921 的消费者依赖已进入本分支。** 合并提交 `b3b7df787d5608e72fd76d3a53ef2bbc9c7ba311` 的第二父提交为 `5357dd5cebeb8ecd638d213822fedcda8e24cc8e`。dispatcher 的目标围栏与上下文读取均要求 `pending`（`bridge/workflow-engine-dispatcher.ts:2791`、`:2822`），启动写回也要求 `pending`（`StateStore.ts:46806`）；coordinator 通过精确 replacement intent 识别正在启动的替身（`StateStore.ts:46179`、`bridge/workflow-rework-coordinator.ts:817`）。因此此前“新 writer 遇到旧 replacement_pending consumer”的前置风险，在这个 checkout 已有对应消费端基础；这不是远端 main 已合并或生产已部署的证明。
- **补充合同的故障归属能映射到现有实现接口。** `recordWorkflowPreAdmissionFailure` 已排除 land/gate（`StateStore.ts:65040`），对 pending/latest intent 在事务内核对无 binding、activation、owner、completion（`:65055`），并排除 `rework_replacement:` 及已登记的返工目标（`:65072`）。replacement 准入回滚采用非 hold 事件 `rework_replacement_launch_rolled_back`（`:42112`）。这为既有 `pre-admission-producer-land-scope`、`pre-admission-fence-inapplicable`、`preadmission-producer-rework-carveout` 建议提供了静态处理证据，也支持将原计划 §5 的返工回滚行按补充合同解释。
- **共同物化与上下文预检具有具体落点。** 自动替身与历史 held 恢复可以共用 `materializeReworkReplacementCoreTx`（`StateStore.ts:45592`）；历史恢复适配器接受 held run、returned_to_lead delivery 和精确 route/actor（`:62919`），并写共同 materialized receipt。`engine:operator_recovery` 已被退休证明消费者识别（`:44377`），不会仅因新增来源字符串丢失证明。stage/apply 与 dispatcher 复用 `getWorkflowReworkReplacementContextPreflight`（`:44217`、`:62708`；`bridge/workflow-node-recovery.ts:246`；`bridge/workflow-engine-dispatcher.ts:2835`），为此前上下文预检 advisory 提供了对应证据。
- **起点、lineage 与业务决定没有被简化成“改 pending 即成功”。** 已有共享 `resolveWorkflowStartPolicy`、真实 git HEAD resolver 和 `resolveWorkflowDispatchLineage`；root 初始恢复还携带 `initialPolicy` 到 RunDispatcher（`bridge/workflow-engine-dispatcher.ts:3375`、`bridge/run-dispatcher.ts:1540`），保留 resume/continuity 元数据。业务继续写带 `origin=hold_decision_resume` 的 edge（`StateStore.ts:61294`），completion disposition 与 ship-ready 读取显式跳过它（`:69643`、`:78876`）。这些支持方案可实施；root 默认起点及残留 worktree 的 Blueprint 行为仍须按既有 advisory 做行为验证。
- **权限和生命周期边界清晰且有现成接入点。** master/loopback/confirm-token 的正式恢复门、enrolled 专用失败提交、独立 run termination、quota target CAS 和 terminal/orphan-only watch 清理都能在当前模块中定位。人工 pause、gate probe 和已完成 source 的决定继续保留独立语义，避免把活体或已完成节点送进物理替换守卫；land 旧 full-resume 入口的权限收敛仍是明确的实施义务，不能因设计获批而视作已经完成。计划 §7 命令中列出的 18 个测试文件均存在。

#### Issues & Recommendations

本轮新增设计缺陷：0。以下仅保留已有非阻塞建议及验证边界，不重开已关闭事项。

1. **MEDIUM — shared-materializer-preconditions（既有，部分已有静态处理证据）**：共同事务内核及 held/returned_to_lead 适配已经存在，但替身预算的显式恢复语义仍需在交接中说清。当前内核达到三次预算会拒绝（`packages/teamlead/src/StateStore.ts:45655`），计数包含 `engine:operator_recovery`，仅在 `engine:hold_resume` 后重新起算（`:47223`）；因此不能仅凭“已抽共同方法”宣称历史建议全部关闭。建议保留此前预算 follow-up，明确显式 operator 恢复是否计数、何种授权可重新起算，并按既有矩阵验证预算耗尽及再次失败的出口。本轮没有把这一已接受风险升级为新阻塞，也不据此审查实现质量。
2. **LOW — sibling-contract-unpinned（既有）**：补充合同仍引用远端 C2/C4/C6，且第 14 行描述的是旧 consumer，容易被后续接手者当成当前源码。当前分支已同步 2921，影响是证据定位和交接清晰度，而非新的设计不可行性。建议下一次交接记录明确引用本轮 HEAD、上述合并父提交及 `design-correction.md:21–27` 的覆盖优先级，继续把 §3.6/§5 的 active replacement 失败交给 2921；发布集成仍须确保这些消费者先于或随 2922 writer 可用，不以本地 ancestry 推断生产状态。
3. **LOW — tests-not-run（既有验证边界）**：本轮未运行 Vitest、build 或生产验证；根目录及 teamlead 目录均无 node_modules。源码和测试文件存在只能证明接口、路径和测试入口可落地，不能证明九单、真实 admission、并发、重启、预算及旧 land 权限路径已经通过。建议实现/QA 继续逐文件执行原 §7 与补充矩阵，保存公共入口至 consumer 的证据，并单列未执行或受环境限制的检查；本轮不复用旧日志作为当前 HEAD 的测试结果。

#### Verdict

APPROVED — ready to implement

## 2026-09-28 沙箱再派发的 scoped review（execution aa6823a0，run 6a122f01）

本 Bridge 评审门 requestId `70ebb784-ed3c-4674-81e1-6e9e2b5d0dfc`，plan blob `24413428775c482bdcd16cabcbfa9d5f619acf77`（与前两次批准相同，计划正文未改），reviewer gpt-6-astra/xhigh（服务端指定，review-round match=yes）。第 1 轮 APPROVED：thread `01a0e6db-bc35-77e1-a255-4c614a0f3bf7`，turn `01a0e6db-bf76-7e71-b718-152f001ec787`；审阅基线 HEAD `cbd39c96f`，相对上次批准头仅本目录的证据/进度文件有差异，packages/scripts 树完全相同。新增设计缺陷 0；保留 1 MEDIUM（shared-materializer-preconditions）/ 2 LOW（sibling-contract-unpinned、tests-not-run）为非阻塞 Follow-ups。`await-codex-gate design` 经 Bridge 校验通过。只批准设计，不批准实现完整性、行为验收或部署。

Codex 反馈全文：

### Design Review — plan.md (Round 1)

Date: 2026-09-28
Author: Codex
Status: APPROVED

#### Summary

针对 Bridge request `70ebb784`，以当前 HEAD `cbd39c96f3dea7b6a7f338e4179a1a58a01d5e77` 完成限定范围设计复审。`plan.md` 结合 `design-correction.md:21–27` 的优先覆盖后，仍可沿当前 StateStore 事务、派发账本、dispatcher 和 rework coordinator 实施。新增设计缺陷 **0**；保留上次沙箱审阅的非阻塞 Follow-ups，不重开已关闭事项。

本轮独立验证了审阅对象和源码：plan blob 为 `24413428775c482bdcd16cabcbfa9d5f619acf77`，补充合同 blob 为 `3ecbe57194f7e675b011b339e481e801a730d68a`。相较上次批准头 `6aa6e2bc7609188fbe6f7550041bcf913363b58d`，当前 HEAD 只改变本目录的 `delivery-evidence.md`、`progress.md`、`review-result.md`；`packages` tree 均为 `826d2e1f34841da2321f3600ec874e135d765349`，`scripts` tree 均为 `f7675c174f584bbb5f5284784e93ea81c39f7e2b`。因此不存在新增源码差异推翻既有结论；以下同时给出本轮直接读取当前源码的核验依据。

已阅读根目录及 `packages/CLAUDE.md`、产品体验规范，以及 exploration、research、plan、补充合同、历次评审、implementation-evidence 和 watch-consumer-sweep。相关 teamlead/flywheel-comm 子树没有额外 CLAUDE.md。本结论只批准设计可实施性，不认定 WIP 实现完整、测试通过或可部署；历史实现日志未作为当前 HEAD 的行为验证。

#### What's Good (Keep)

- **恢复成功有真实事务承诺。** `packages/teamlead/src/StateStore.ts:92304` 的 allocator 返回 ordinal，并写 dispatch ledger 与 launch delivery。当前 `recoverWorkflowNode`（`:62998`）提供持久 receipt、精确 hold UID 结算、run 激活和 carrier revive 的事务接入点；`:62627` 重验 preflight，`:62767` 拒绝其他 active run。计划要求完整 tuple 查询 ledger ID、幂等重放及 stale 请求拒绝，符合现有结构。`recoverCurrentWorkflowNodeTx` 是计划职责名，不应因当前方法名称不同判为缺失接口。
- **公开权限门和操作语义可以复用。** `bridge/runs-route.ts:453` 的 master/loopback 检查、`:501` 的 stage 和 `:557` 的 apply 接入 `prepareWorkflowNodeRecovery`（`bridge/workflow-node-recovery.ts:148`），并绑定 canonical/confirm token；重复成功请求读取持久 receipt。state-only、gate probe、已记录业务决定与物理替换分别保留真实语义，能避免对活体 pause 或已完成 source 套用死体替换守卫。land 旧 full-resume 门的收敛仍按计划作为实施义务保留，不能从设计批准推断其已经完成。
- **FLY-2921 的写入与消费合同在当前源码有对应基础。** dispatcher 围栏和 replacement context 均要求 `pending`、精确 actor/request/route（`bridge/workflow-engine-dispatcher.ts:2791`、`:2822`）；启动写回检查相同状态（`StateStore.ts:46808`），coordinator 识别已存在的替身派发（`bridge/workflow-rework-coordinator.ts:817`）。共同物化内核 `StateStore.ts:45593` 和历史 held 适配器 `:62919` 接受各自权限/CAS，后者使用 held + returned_to_lead。stage/apply 与 dispatcher 复用 replacement context preflight（`bridge/workflow-node-recovery.ts:246`、`StateStore.ts:62708`、`bridge/workflow-engine-dispatcher.ts:2835`）。这些支持此前消费者依赖、共用方法和上下文预检建议的静态处理状态，不能外推为生产集成已完成。
- **故障归属保持单一。** `StateStore.ts:65040` 排除 land/gate，`:65055` 用 pending/latest intent 加无 binding、activation、owner、completion 的事务内证据判断准入前未启动，`:65072` 排除 `rework_replacement:` 和已登记返工目标。原计划 §3.6/§5 的旧文字须继续按补充合同解释：active replacement 失败归 2921；历史 held 和非 replacement 故障归 2922。当前源码没有新增反证要求重开此前对应 advisories。
- **派发后的消费条件已纳入设计。** `workflow-dispatch-lineage.ts` 解析精确替换链；`bridge/workflow-node-recovery.ts` 区分 root 未启动与真实 execution HEAD，`bridge/workflow-start-policy.ts` 共用启动选择规则。dispatcher 在 `:3375` 传递冻结的 initialPolicy，RunDispatcher 在 `:1540` 接收 recoveryStartPolicy，保留 resume/continuity 元数据的接入点。业务继续 edge 的 completion disposition 与 ship-ready 读取显式跳过 `hold_decision_resume`（`StateStore.ts:69643`、`:78876`）。真实 git、Blueprint 残留 worktree、连续替换及实际 admission 验证仍须按原矩阵完成。
- **失败、关闭和额度边界有可实施落点。** enrolled failure 的独立事务在 `StateStore.ts:70266`，HTTP 早分流在 `bridge/event-route.ts:1904`；成功路径仍在 transition 后投影 session（`StateStore.ts:71059`、`:71085`）。close-runner 的 enrolled done 分流与 execution-only 回执位于 `bridge/close-runner.ts:539`、`:460`，显式 run terminate 仍独立。quota settlement 使用同事务 target CAS（`StateStore.ts:66698`、`bridge/codex-quota-store.ts:1035`），旧 terminate 有服务端拒绝位置（`StateStore.ts:54438`）；watch 清理仅选择达到 TTL 的 terminal/orphan（`:65298`）。保留计划中的并发、迟到完成、崩溃重放及公共入口到 consumer 验收，不能仅凭这些方法存在认定整单完成。

#### Issues & Recommendations

本轮没有 NEW 设计缺陷。以下三项均为 **retained prior follow-up**，保持非阻塞；已关闭或已有静态处理证据的其他建议不重新列为问题。

1. **MEDIUM — shared-materializer-preconditions — retained prior follow-up（部分已有静态处理证据）**

   共同内核和 held/returned_to_lead 适配器已经存在，但显式 operator 恢复与替身预算的语义仍应保留交接说明。`packages/teamlead/src/StateStore.ts:45655` 达到三次预算会拒绝；`:47223` 的计数包括 `engine:operator_recovery`，只从最近 `engine:hold_resume` 后重新起算。预算耗尽的历史 held 目标可能因此无法直接再派，不能仅以抽取共用方法宣称旧建议全部关闭。建议沿用既有 follow-up，明确显式恢复是否计入预算、何种授权允许重新起算，并验证预算耗尽及再次失败的出口。这与上次批准时的源码相同，不升级为新增阻塞，也不作为本轮实现完整性评判。

2. **LOW — sibling-contract-unpinned — retained prior follow-up**

   `design-correction.md:14–17` 仍是旧分支状态描述，C2/C4/C6 引用未固定版本。当前 consumer 已使用 pending，后续接手者若按旧描述实施，容易误读两单的集成边界。建议在后续交接记录中固定所依赖合同的 commit/blob、实际集成提交和 `:21–27` 的覆盖优先级，并明确 §3.6/§5 的 active replacement 归属。当前已核实源码基础可用，不因此要求改动本次冻结计划，也不将本地源码等同于 main 或生产部署状态。

3. **LOW — tests-not-run — retained prior follow-up（验证边界）**

   本轮逐项确认 §7 命令列出的 **18 个测试文件全部存在**。根目录、`packages/teamlead`、`packages/flywheel-comm` 均没有 `node_modules`，本轮未运行 Vitest、build 或生产验证，未安装依赖。测试文件和接口存在只能支持方案可落地，不能证明九单、真实 HEAD/admission、quota 竞争、land 权限门或重启行为已经通过。建议实现/QA 按原 §7 和补充矩阵逐文件运行，保存当前提交的公共入口到派发消费者证据；watch-consumer-sweep 仅覆盖历史 watch slice，外部插件 fork/cache 的整单 sweep 仍不得报告为零引用。

#### Verdict

APPROVED — ready to implement
