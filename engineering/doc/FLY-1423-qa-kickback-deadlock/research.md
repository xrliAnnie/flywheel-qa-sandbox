# FLY-1423 qa-fail 踢回锁死 — 调研

Issue: FLY-1423 (https://linear.app/geoforge3d/issue/FLY-1423/enginebug4-qa-fail-踢回锁死-attempt2-admit-幽灵-exec-terminal-complete-硬)
日期: 2026-07-22
基于: exploration.md

## 1. 代码触点地图（全部实读核对，行号为本分支现状）

### 1.1 踢回 → attempt2 创建（图层，事务内）

* `StateStore.commitWorkflowTransitionTx`（StateStore.ts:18319）：qa_fail → 走 `qa_retry` 边，`loop_iteration` 计数（COUNT loop_iteration events + 1，18482-18490）；**超 `max_iterations`（3）→ run `held` + `loop_limit_escalated` 事件**（18491-18534，已有，无需动）。未超 → 建 implement attempt2 node（state pending/…）+ dispatch outbox 行（`intent_recorded`）+ `edge_traversed` 事件。
* `WorkflowEngineDispatcher.reconcile()`（workflow-engine-dispatcher.ts:214）每 1s tick 消费 outbox；`consume()`（:678）顺序：
  1. 找 transition/predecessor（:823-874）→ `phaseFixContext = { round, qaSummary }`（:879-889，**踢回 fix 上下文已设计好**，随 spawn 带入）；
  2. `resolvePredecessorHead` → startPoint（:900-914）；
  3. **`admitGeneralizedWorkflowExecution`（:967）——先写**：node state=`admitted` + `workflow_execution_binding` + `workflow_execution_runtime` 三张表（StateStore.ts:15876-15915）；
  4. `recoverOrAcquireWorkflowLaunch`（:997）→ acquired；
  5. **`startDispatcher.start()`（:1131）——在这里抛** `Run already in progress for issue <X> role implement`；
  6. consume 抛错 → reconcile 记 held、下一 tick 重来。**无告警、无回滚、无次数上限**（对 start 抛错；只有 probe_unknown 3 连才告警 :519-554）。

### 1.2 互斥点（进程内存态）

* `RunDispatcher.start`（run-dispatcher.ts:1177）：`inflight` map，key = `issueId + role`（:1192）。同 key 已有 entry 且 executionId 不同 → 抛（:1202-1206）。
* **释放只有一处**：`Blueprint.run()` promise `.finally(() => this.inflight.delete(key))`（:1585-1587）。parked keep-alive runner 的 promise 不 settle → 槽位占死。
* Bridge 重启 → inflight 清空（无重建逻辑）；但 husk tmux 仍活，spawn 会撞**窗口/linked-session 命名**：window label = `buildWindowLabel(displayId, runnerName, issueTitle)`（Blueprint.ts:2523），**不含 exec-id/attempt 去重** → cmux linked session `cmux-<window_name>`（tmux-lookup.ts:89）同名冲突。同 role 并存不可行的第二证据（第一证据：内存足迹，FLY-751）。

### 1.3 evict 的现成机制（不用发明新东西）

* `closeRunner`（close-runner.ts）：**status=completed ∈ AUTO_CLOSE_STATES** → 杀 tmux window + cmux linked session + Terminal viewer tab + finalize CommDB + reap MCP，**幂等**（无 tmux target / 已不在 → 也返回 success）。
* **同类先例 = FLY-1204 `closeParked`**（plugin.ts:5999-6014）：回收泄漏的 three-stage keep-alive phase session，`closeRunner({ executorType: "phase", finalizeDone: true, reason: … })`，**不带 archive**（phase session 共享父 issue thread，thread 归 post-ship finalization 管）。evict 逐字复用这个形态，只换 reason。
* 更早先例：PhaseOrchestrator 在 handoff 时用 `finalizeDone` 关 design phase session（close-runner.ts:75-84 注释）。engine 内部自动关 superseded husk 与这两个先例同类（Bridge-internal lifecycle executor 行为，非 Lead/founder action 面，不涉 FLY-175 consent 面——它们走的就是同一条内部调用，不经 `/api/actions/*`）。
* tmux 关闭 → pane-died 全局 hook（FLY-110）→ AgentSessionManager 清理 → Blueprint.run() promise settle（生产典型 ~30-45s）→ inflight 释放。引擎 1s tick 天然容忍这个延迟（held 若干 tick 后放行）。
* 接线形态：`WorkflowEngineDispatcher` 已有注入式 executor 先例 —— `landExecutor`（plugin.ts:5265 定义、:5414 注入）。evictor 照抄这个形态。

### 1.4 complete 拒收面（Bridge + CLI 两侧）

* Bridge：`POST /events` `session_completed` + `source=flywheel-comm` → `commitEnrolledCompletion`（event-route.ts:668；StateStore.ts:17763）。语义矩阵现状：
  * 同 attempt 已有 receipt + **digest 相同** → `ok idempotentReplay`（含 `projectGeneralizedCompletionTx` 投影重放）→ 200。**Bridge 重启 marker 补投（FLY-172 boot drain 走 loopback /events）落在这格,安全。**
  * 同 attempt 已有 receipt + **digest 不同** → `completion_conflict` → **409**（event-route.ts:686-696）。**1415/1364 撞的就是这格**——不区分「踢回后 fix 重报」和「真双写」。
  * 无 receipt + 本 attempt node 行的 execution 被换 → `stale_execution_superseded` → **200 settled**（event-route.ts:678-685）。注意它查的是**同 attempt** 的 node 行,踢回场景（attempt1 行原封不动、新开 attempt2 行）**不会**落进这格。
  * `route_mismatch` / `missing_output`（retryable）/ `transition_refused` → 409。
* CLI：`complete.ts:263-309` —— 对**任何** non-ok（含确定性 409）盲重试 4 次（ATTEMPT_COUNT）→ 写 marker → exit 1；complete-marker-reconciler 再补投 → 还是 409 → quarantine（`[complete-reconciler] generalized completion conflict quarantined`，生产 log 实证）+ advisory。**runner 与引擎从此互不知情。**

### 1.5 幽灵的不可见性（回收面缺口）

* dead-exec sweep：只扫 `node.state === "running"`（workflow-engine-dispatcher.ts:444）。
* `rollbackDeadWorkflowNodeExecution`：要求 `node.state === "running"` + session terminal（StateStore.ts:17241-17266）。`admitted` + sessions 零行的幽灵两条都不满足 → **不存在任何回收/告警通道**。
* dead-exec 绊线（watch）表：watch 建立在「已 launch 过的 exec 死亡」语境,同样覆盖不到 pre-launch。

### 1.6 告警基建（可直接复用）

* `store.enqueueWorkflowEngineAlert`（dispatcher :529 用法先例）→ `workflow_alert_outbox` → `reconcileWorkflowEngineAlerts`（:351）claim-before-send → `alertSink`（Discord 所属 Lead）。escalationUid 幂等去重。`resolveRunAlertIdentity` 已注入。

## 2. 设计裁定依据（研究结论）

1. **evict-then-spawn 可行且零新机制**：闭合链 = 判定（DB 证据：同 run 同 node 更低 attempt + receipt 在案 + session terminal）→ `closeRunner`（幂等，FLY-1204 形态）→ pane-died → promise settle → inflight 释放 → 既有 spawn（带 phaseFixContext）。Bridge 重启分支同样被覆盖：判定不依赖 inflight map（引擎本来也看不见它），依赖 DB + closeRunner 幂等性——husk tmux 活着就关掉，命名冲突源随之消失。
2. **wake-rebind 否决成立**：runner 中途换 execution 身份牵动 credentials（launchGateToken/output/submission credential 全绑 exec）、comm.db 身份、watchdog/cmux 命名、FLYWHEEL_EXEC_ID env——全新风险面 vs phaseFixContext+分支文档已兜住上下文损失。
3. **complete 矩阵补格的落点**：`commitEnrolledCompletion` 在 `completion_conflict` 之前加一个判定：existing receipt 属于本 binding attempt、digest 不同、且 `listWorkflowRunNodes(run, node)` 存在 attempt > binding.attempt → 新结果 `stale_resubmission`（非冲突、不推进 DAG、200 + 告警）。**不推进**是刻意的：单写入者原则（呼应 FLY-1427 终态覆盖保护），stale exec 的内容不能越过 attempt2 的 credential/authority 体系直接落账。
4. **CLI 409 不该盲重试**：确定性 4xx 重试 4 次纯属空转 + 制造 quarantine 噪音；保留 5xx/网络错的重试。同时 Bridge 对新语义返回 200（带 `settled` 字段），CLI 天然通过——CLI 修改只是止血深度防御。
5. **绊线（unlaunched-admission watchdog）挂进 reconcile 既有节奏**：扫 `intent_recorded` 超龄（DB 有 created_at）∧ node=`admitted` ∧ sessions 零行 → `enqueueWorkflowEngineAlert`（uid 去重报一次）。与 FLY-1425（qa credential 未消费看门狗）同族共基建（alert outbox），条目独立交付。
6. **回滚通道**：镜像 `rollbackDeadWorkflowNodeExecution` 但作用于 `admitted` 态（清 binding/runtime/credential 行、side-effect → `abandoned`、node 行删除或标 rolled_back、审计事件）。供绊线自动执行（可自愈原因除外）+ 为 FLY-1416 类手动杠杆预留内部原语。
7. **maxIterations 耗尽已有 held+escalated**（StateStore.ts:18491-18534），本修不触碰。

## 3. 风险与开放点（进 plan 的约束）

* **R1 evict 误杀**：判定必须 fail-closed——五条件全查（同 run、同 node、attempt 更低、receipt 在案、session status terminal）；qa/design 节点、非 engine-owned run、首次 dispatch（attempt=1）一律不进 evict 路径。活工人（无 receipt 或非 terminal）绝不关，走告警。
* **R2 evict 与 FLY-1427 写路径交集**：closeRunner 对 completed session 不做 status transition（AUTO_CLOSE 直接 teardown）——不产生第二写入者；plan 中列 reverse-compat 断言。
* **R3 时序**：evict 是 async（~30-45s settle），engine 在此期间持续 held——正常。valve：同 reason held 计数超阈值（或 intent_recorded 超龄）→ 告警,避免 evict 卡死时重演无限静默。
* **R4 `stale_resubmission` 的告警载荷**：issue、node、旧/新 attempt、两侧 digest、resubmission 的 commit 证据摘要（payload.evidence 已带 commitCount/commitMessages）——Lead 一眼能判断「拿它当 fix 收编（手动驱动 attempt2 快速收敛）还是丢弃」。
* **R5 幂等边界**：`stale_resubmission` 本身要幂等（同一 stale exec 重复报 → 同一 uid 告警只发一次,响应稳定 200）。
