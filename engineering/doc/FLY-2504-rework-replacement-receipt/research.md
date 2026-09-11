# FLY-2504 返工换体后替身未收返工内容即完成 — 调研

Issue: FLY-2504 (https://linear.app/geoforge3d/issue/FLY-2504/病根-返工换体后替身未收到返工内容即在同头-complete引擎照单接受-node-completed-空转一轮-qarework)
日期: 2026-09-10
基于: exploration.md

所有路径相对仓库根。`SS` = `packages/teamlead/src/StateStore.ts`,`DISP` = `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts`,`COORD` = `packages/teamlead/src/bridge/workflow-rework-coordinator.ts`,`PLUGIN` = `packages/teamlead/src/bridge/plugin.ts`。

## 1. 返工送达状态机(`workflow_rework_delivery`)

### 1.1 表与关系

- 建表 `SS:26348-26364`;行类型 `SS:72653-72673`。主键 `request_id`,一请求一行。
- `route_revision` 指向不可变的 `workflow_rework_route_revision`(`SS:26331-26345`),那里才有 `target_node_id / target_attempt / preferred_actor_execution_id`。**送达行本身不存 execution_id**;换体 = 追加 revision N+1 并把送达行的 `route_revision` 指过去。
- `state` CHECK:`pending, turn_granted, awaiting_receipt, wake_delivered, replacement_pending, completed, held, needs_lead`(`SS:26354-26355`)。
- 时钟(granted/sent/received/consumed)不在本表,投影到 `workflow_delivery_attempt`(`SS:25203-25222`),经 `projectWorkflowDeliveryClockTx`(`SS:42973-43018`)。
- 返工内容不在本表:`workflow_rework_request`(`SS:26290-26328`,不可变)存 `authority / authority_context_json / founder_feedback_verbatim / lead_feedback / founder_quote_json / base_revision`。QA authority 的 `authority_context_json` 由 `SS:55997-56010` 组成,只含 `{authority, outcome, sourceNodeId, sourceAttempt, sourceExecutionId, edgeId, targetNodeId, targetAttempt, baseRevision}`。QA 判决正文在 QA 执行体的 `workflow_decision` 事件 `payload.summary`(`DISP:2964-2978` `qaFixSummary` 读它)。

### 1.2 转移表

| 从 | 到 | 方法 | 事件 |
|---|---|---|---|
| pending | turn_granted | `advanceWorkflowReworkDelivery`(`COORD:801-808`;矩阵 `SS:36352-36367`) | `rework_delivery_turn_granted` |
| turn_granted | awaiting_receipt | 同上(`COORD:829-838`),`next_retry_at = now+3min`,投影 `sent_at` | `rework_delivery_awaiting_receipt` |
| awaiting_receipt | wake_delivered | `recordWorkflowReworkWakeReceipt`(`SS:34368-34516`),投影 `received_at`,节点 admitted→running,验证路径 pending→active | `rework_delivery_wake_delivered` |
| pending/turn_granted/awaiting_receipt/wake_delivered | replacement_pending | `COORD:459-480` `markReplacementPending`(actor 终态 `:495-500` 或 reentry 判 replace `:542-544`) | `rework_delivery_replacement_pending` |
| replacement_pending | replacement_pending(revision+1) | `materializeWorkflowReworkReplacement`(`SS:34908-35309`;送达行更新 `:35133-35147`) | `execution_dead_rolled_back` / `rework_replacement_materialized` / `rework_replacement` |
| 任意活态 | replacement_pending(revision+1) | `convergeWorkflowReworkWriterReplacement`(`SS:34652-34900`,通用死体回滚先 launch 时的收敛) | `rework_writer_replacement_converged` |
| **replacement_pending** | **wake_delivered** | **`markWorkflowReworkReplacementLaunched`(`SS:35428-35554`;SQL `:35484-35497`;投影 sent_at + received_at `:35502-35517`;验证路径→active `:35518-35523`)** | `rework_replacement_launched`(`:35527`) |
| replacement_pending | held | 未 launch 的 admission 回滚 `SS:32181-32192` | `unlaunched_admission_rolled_back` |
| wake_delivered | completed | `commitWorkflowTransitionTx` 到闸 `SS:56360-56364` / 链式 `SS:56451-56455`;CAS 要求 `state='wake_delivered'` 否则抛 invariant | `rework_verification_completed` / `_chained` / `_superseded` |

`advanceWorkflowReworkDelivery` 的允许矩阵里 `replacement_pending` 只能去 `completed`(`SS:36351-36367`)。

### 1.3 谁把 replacement_pending 搬走、节奏多快

- 协调器对 `replacement_pending` **拒绝 claim**(`SS:35599-35612`,`delivery_settled`);dispatcher 的返工扫描列表刻意不含它(`DISP:861-870`)。
- 搬走它的是 dispatcher 两跳:同 tick `DISP:1015-1031` 调 `materializeWorkflowReworkReplacement`(仍是 replacement_pending,但 revision 指向新执行体、生成 `dispatch` 副作用 `reason='rework_replacement:<requestId>'`);后续 1 秒 tick(`DISP:314-327`)消费该意图,`markStarted`(`DISP:2070-2122`)→ `markWorkflowReworkReplacementLaunched` → `wake_delivered`。
- 「每 3 分钟」是 `WORKFLOW_DELIVERY_RECEIPT_REPROBE_MS = 3*60_000`(`SS:367`),用于 `awaiting_receipt / wake_delivered` 行的回执探测退避,**不是**替身送达的节奏。issue 里「等下一轮 claim」的假设不成立:没有组件会给已 launch 的替身送内容。

### 1.4 回执是什么

- 回执 = runner 跑 `flywheel-comm turn --exec-id <id>` 得到 `yours`(`packages/flywheel-comm/src/commands/turn.ts:2-13, 172-185`),在 CommDB `turn_wake_outbox` 打 `acked_at`。
- Bridge 侧 `drainTurnWakeOutbox`(`packages/teamlead/src/bridge/turn-wake-patrol.ts:133-142`)在 reconcile patrol tick(`PLUGIN:10898, 11020`,GatePoller 每 20 个 poll tick ≈ 60 秒,`gate-poller.ts:319, 608-609`)把回执投影到 StateStore:`purpose === "workflow_rework"` → `recordWorkflowReworkWakeReceipt`(`PLUGIN:11115-11147`)。
- **含义**:wake 模式下 `wake_delivered` 落后真实回执最多约 60 秒。替身模式没有回执,launch 标记直接写 `wake_delivered`。

## 2. 替身 launch 信封怎么组成

- 意图识别:`intent.reason` 以 `rework_replacement:` 开头 → `reworkReplacementRequestId`(`DISP:2335-2339`)。
- `replacementContext`(`DISP:2340-2421`):校验 request/route/delivery 与意图一致、`delivery.state === "replacement_pending"`、`base_revision` 为 40 位 sha,否则 **launch 前**抛 `engine_rework_replacement_context_invalid`。只有 `authority === "lead"` 解析 `authority_context_json` 组 `leadAttribution`;`founder` 取 `founder_feedback_verbatim`;**qa / engine 只返回 `requestId + startPoint`**。
- `contextualAgentContent`(`DISP:2545-2549`):`leadAttributionContent` 或 `founderFeedback` 才拼段;否则 = 裸 `agentContent`(role 文件)。
- `phaseFixContext`(`DISP:2514-2524`,渲染在 `Blueprint.ts:1996-2001`)要求 `transitionPayload.outcome === "qa_fail"` 且有 `transition.execution_id`;替身回滚走 `DISP:2455-2468` 落在原 launch 的 transition 上,拿不到 qa_fail 边,所以 QA 摘要也没进信封。
- 信封正文:`Blueprint.ts:1647-1666` → `prepareWorkflowIssueDelivery`(`SS:31301`,payload `{activationId, sourceKind, body, bodyDigest}` `:31458-31473`),`body = issueDescription`;提交时写 `issue_delivery`(`:31558-31570`)。提示词 = `Implement <issue>: <title>\n\n<description>`(`Blueprint.ts:1867`)+ `## Agent Role` = `workflowAgentContent`(`Blueprint.ts:2790-2794`,来自 `DISP:2880`)。
- `markStarted`(`DISP:2070-2122`)在 `start()` 返回之后调 `markWorkflowReworkReplacementLaunched`,只传 `executionId / now / alertIdentity`,**没有任何「信封带了什么」的证据**;失败即 `throw engine_rework_replacement_launch_<reason>`。
- 注意 `markWorkflowReworkReplacementLaunched` 用 `getWorkflowExecutionBinding(executionId)`(单绑定键);FLY-2352 已指出一个执行体可有多条 binding,当前 activation 才权威。新铸替身只有一条 replacement binding,本单不改这一点但要在 plan 里点名。

## 3. complete 接受路径上的守卫

- CLI:`packages/flywheel-comm/src/commands/complete.ts` `POST /events`(`:511`),payload 含 `decision.route`、`evidence.headSha`、`workflowActivation {activationId, runId, nodeId, attempt, turnEpoch}`(`:363-373, 451-459`)。4 次重试 1/2/4 秒(`:73-75`);非 429 的 4xx 且 `retryable !== true` 即 break(`:566-573`);随后**一律**写 fail-close marker 并 exit 1(`:590-603`)。`consume_pending_mail` 有专用文案(`:559-564, 606-646`)但同样写 marker。
- Bridge:`event-route.ts:649` → `:800-1355` → `store.commitEnrolledCompletion`(`:1263-1276`)。拒绝映射:`:1318-1328` 409 `{error:"workflow_completion_rejected", reason, detail?, retryable?}`。
- `commitEnrolledCompletion`(`SS:52181`):activation 校验(`:52241-52261`)、`not_enrolled`(`:52271`)、事务内 `classifyCurrentWorkflowWriterTx`(`:52649-52662`)、然后 `commitWorkflowTransitionTx`(`:52834-52847`)。
- `commitWorkflowTransitionTx`(`SS:55265`):`engine_run_not_active`(`:55402-55406`)、`node_attempt_not_current`(`:55467-55481`)、`transition_conflict`(`:55482-55499`)、唯一出边(`:55501-55514`)、active 验证路径查询(`:55551-55561`)。
- **结论**:整条路径零处读 `workflow_rework_delivery`(agent 逐文件 grep 确认;`event-route.ts` 无 `rework` 字样)。唯一读送达状态的是 dispatcher 替身 launch 上下文(`DISP:2361`)。
- 四个调用 `commitWorkflowTransitionTx` 的入口:`commitEnrolledCompletion`(`SS:52181`)、`submitWorkflowDecisionByCredential`(`:54576`)、`commitWorkflowLoopReentryRequest`(`:55104`)、`applyWorkflowSourceEvent`(`:57969`)。守卫放在 `commitWorkflowTransitionTx` 内可一次覆盖四个入口,且 fly2096 测试夹具直接驱动它。
- marker 回放(`complete-marker-reconciler.ts`):409 且 `detail.transitionReason` 以 `engine_invariant:` 开头 → `held_for_lead`(`:1040-1099`);其他非 429 的 4xx → marker 隔离(`:1100-1111`)。

## 4. 测试夹具地图

- `packages/teamlead/src/__tests__/fly2096-rework-stall-hold.test.ts`:`seedLaunchedReplacement()`(`:223-389`)是**现成的替身夹具**——死 session、`replacement_pending` 送达行、`materializeWorkflowReworkReplacement`、`admitGeneralizedWorkflowExecution({activationMode:"replacement", reworkRequestId})`、`upsertSession(running)`、`markWorkflowReworkReplacementLaunched`(`:348-358`,断言 `:381-387`)。`completeQa()`(`:494-507`)直接调 `commitWorkflowTransitionTx`。「accepts the replacement completion after 96 minutes」(`:535-557`)是正向模板。**FLY-2504 的 RED:fork 它在 launch 标记前停下,然后 completeQa —— 今天返回 ok:true 且送达行原样。**
- `packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts`:替身流 `:2558-2688`(mock `reconcileWorkflowRework` 返回 `replacement_pending`,断言 `fake.start` 一次、送达 `wake_delivered`、告警 `["rework_pane_loss_handoff","rework_stall_recovered"]`)。可在此断言 `fake.start` 收到的 `workflowAgentContent`。
- `packages/teamlead/src/bridge/__tests__/workflow-rework.e2e.test.ts`:真 git worktree + 真协调器 + stub effects(`:237-312`,捕获 `wakes[]`);替身两种模拟(`:705-748` dispatcher + fake start;`:875-909` rollback + converge)。
- `packages/teamlead/src/bridge/__tests__/workflow-rework-coordinator.test.ts`:纯单测,`makeHarness()`(`:131-404`);wake 文案在 `effects.wakeActor` 参数里可断言。
- `packages/flywheel-comm/src/__tests__/`:complete 命令测试族(实现时 `ls | grep complete`),需要 409 响应桩。
- CI:`packages/teamlead/package.json` `test:run = vitest run`,三分片(`.github/workflows/ci.yml:160-165`)。跑 core 包时必须 `--exclude test/tmux-viewer.macos.test.ts`(会开真 Terminal.app)。

## 5. 前案约束(必须保持)

- FLY-2278(`engineering/doc/FLY-2278-freeze-hold-reroute-settle/plan.md:26-68`):0 新表 / 0 新列 / 0 新旋钮 / 0 新告警层;hold shape 注册表 19 条不增不减;`contract_ref` 按 `routeRevision` 版本化,旧代事件不能推进新代。
- FLY-2096(`engineering/doc/FLY-2096-rework-stall-hold/plan.md:179-200`):送达 `completed` 的 CAS 必须同事务 settle `workflow_delivery_attempt`;rework 家族不加 `consumed_at` 时钟;不引入新 hold 形状。
- FLY-2352(`engineering/doc/FLY-2352-codex-reown-capability-drift/plan.md:11-51`):一个执行体可有多条 binding,只有当前 activation 权威;fail-closed 而非猜。
- 本单遵守:不加列、不加 flag、不加 hold 形状;新增仅限事件 kind 一个(`rework_completion_refused`)、`rework_replacement_launched` payload 追加字段、409 reason 一个。

## 6. 数字

| 项 | 值 | 出处 |
|---|---|---|
| 替身 launch → complete | 76 秒 | seq 367→368 |
| 回执探测退避 | 3 分钟 | `SS:367` |
| dispatcher tick | 1 秒 | `DISP:314-327` |
| 回执投影延迟(wake 模式) | ≤ 约 60 秒 | `gate-poller.ts:319, 608-609` |
| QA 摘要截断 | 1000 字符 | `DISP:2975` |
| founder 反馈截断 | 4000 字符 | `DISP:2533` |
