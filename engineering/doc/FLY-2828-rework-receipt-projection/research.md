# FLY-2828 返工回执投影停摆 — 调研

Issue: FLY-2828 (https://linear.app/geoforge3d/issue/FLY-2828/病根-返工回执投影停摆体已-ack-但-receipt-projected-at-永不写入-delivery-卡-awaiting)
日期: 2026-09-24
基于: exploration.md

## 1. 调研目标

exploration 已经把根因钉到行。本篇回答 plan 需要的六个「怎么改才不会再坏」的问题：

1. 「完成即回执」内联投影放在哪一行、依赖哪些既有校验、幂等键是什么。
2. 投影循环的隔离形状：哪些 `retry` 原因是终态、哪些是瞬态，怎样不让终态收据永久占窗。
3. 新告警车道的键、去重、投递对象。
4. 两道门共用谓词的精确定义，以及 `active` path 的处理。
5. CommDB 加列迁移的既有模式。
6. 回归测试落在哪些现成夹具上。

## 2. 「完成即回执」的接缝

### 2.1 入口与顺序

`StateStore.commitEnrolledCompletion`（`StateStore.ts:61672`）：

* 带 activation 上下文时（生产路径），`generalizedExecutionContextForActivation(activationId)` 解析 binding，并校验 `binding.execution_id / run_id / node_id / attempt` 与 runner 提交的一致（61734-61752），再用 `getWorkflowActivationTurn` 校验 `turn.execution_id / issue_id / epoch`（61753-61761）。
* 不带 activation 上下文时（单 activation 的 legacy execution）走 `generalizedExecutionContext(executionId)`；`getWorkflowExecutionBinding` 在多 activation 时返回 `undefined`（FLY-1423），所以返工 activation（同一 execution 的第二个 binding）**只能走带 activation 的路径**。
* 主事务 `this.db.transaction(() => …)` 从 62150 开始；顺序是 `classifyCurrentWorkflowWriterTx`（要求节点 `pending|admitted|running`）→ 各类完成校验 → `commitWorkflowTransitionTx`（62346）→ `projectGeneralizedCompletionTx`（62368）。
* **内联投影必须放在 `commitWorkflowTransitionTx` 之前**，因为 transition 内部（64400）以 `state='active' AND current_node_id=? AND current_attempt=?` 查 verification path；放在后面就等于没投影。

### 2.2 投影动作与幂等键

复用 `recordWorkflowReworkWakeReceipt` 的事务体逻辑，但改成一个 `…Tx` 内部方法，由两个入口调用：

| 入口 | ackedAt | epoch | alertIdentity |
|------|---------|-------|---------------|
| 巡检 `onReceipt`（现有） | CommDB `acked_at` | 收据行 `epoch` | `resolveWorkflowRunAlertIdentity(...)` |
| `commitEnrolledCompletion`（新） | `now`（完成时刻） | `getWorkflowActivationTurn(activation).epoch` | `input.alertIdentity`（完成入口本来就带） |

幂等键 = 既有事件 uid `rework_wake_receipt:<activation_id>:<epoch>`（`StateStore.ts:42549`）。两个入口谁先谁后都成立：

* 完成先到：delivery `awaiting_receipt→wake_delivered`、path `pending→active`、节点 `admitted→running`，然后同事务内 transition 把 path 收成 `completed`/chained、delivery `wake_delivered→completed`。稍后巡检收据到场：delivery 已是 `completed` → `idempotentReplay:true` → `receipt_projected_at` 写入。**不再有毒行。**
* 巡检先到（今天的正常路径）：与现在完全一样。

### 2.3 完成即回执的资格谓词（fail-closed）

只在以下全部成立时内联投影，否则跳过并让完成照常走（不新增拒绝理由）：

* `binding.rework_request_id` 非空；
* `delivery.state === 'awaiting_receipt'`；
* `delivery.route_revision === latestRoute.revision`；
* `latestRoute.preferred_actor_execution_id === binding.execution_id`；
* `turn` 存在且 `turn.execution_id === binding.execution_id`；
* 节点 `state === 'admitted'` 且 `execution_id === binding.execution_id`。

`turn_granted`（TURN 已发但 wake 未推）不纳入：体在没收到 wake 的情况下不可能完成返工 activation；真出现就是别的 bug，让现有路径暴露它。

### 2.4 为什么不改 `projectGeneralizedCompletionTx:59049` 加 CAS

那一行是所有节点类型的完成写点，加 `WHERE state IN ('admitted','running')` 会把「完成但节点已被 superseded/failed」的既有语义改掉（那是 FLY-1940 之外的合同）。本单只补返工一族的缺口，不动通用写点。

## 3. 投影循环隔离

### 3.1 `retry` 原因分类（按 `recordWorkflowReworkWakeReceipt` 现有返回值）

| reason | 触发条件 | 分类 | 处置 |
|--------|----------|------|------|
| `rework_wake_receipt_identity_conflict` | route revision 已推进 / preferred actor 换人 / turn epoch 不符 | **终态** | 标 `not_applicable`（写 `receipt_projected_at` + 原因），一条日志 |
| `rework_wake_receipt_not_ready` 且 delivery ∈ `held\|needs_lead\|replacement_pending` | delivery 已离开可接收态；恢复必换 revision（52416/53057 `SET route_revision=?, state='pending'`）→ 之后必成 identity_conflict | **终态** | 同上 |
| `rework_wake_receipt_not_ready` 且 delivery ∈ `pending\|turn_granted` | ack 抢在 coordinator 写 `awaiting_receipt` 之前（理论窗口） | 瞬态 | retry，计数 |
| `rework_wake_receipt_not_found` | binding/request/route/delivery/run 任一缺失 | 瞬态（StateStore 可能落后） | retry，计数 |
| `rework_wake_receipt_race` | 同事务并发 | 瞬态 | retry，计数 |
| `invalid_rework_wake_receipt` | 入参不合法（alertIdentity 解析失败等） | 瞬态 | retry，计数 |
| 异常（含 `not_admitted_on_receipt`） | 节点非 `admitted`（已 running/done/superseded） | 本单修后：`running` → 视为已投影（跳过节点 UPDATE）；`done` 且 delivery 仍 `awaiting_receipt` → 只可能是修复前的遗留，归 **终态-需人工**（quarantine + 告警） | 见 3.3 |

`held` 是否真的终态：`held` 只有两条出路，`→ replacement_pending`（43100，换 actor）和 `→ needs_lead`（44098）；`needs_lead` 恢复走 52416/53057 换 revision。没有「同 revision、同 actor 回到 awaiting_receipt」的路径。所以旧 ack 对该 delivery 永远无效。

### 3.2 排序与窗口

在 `turn_wake_outbox` 加两列：`projection_attempts INTEGER NOT NULL DEFAULT 0`、`projection_last_error TEXT`。

* `listUnprojectedTurnWakeReceipts` 改为 `ORDER BY projection_attempts, acked_at, wake_id`，并排除 `projection_attempts >= QUARANTINE_AFTER`（建议 20，约 20 分钟）。新鲜收据永远排在反复失败者前面；反复失败者到阈值后退出窗口。
* `markTurnWakeReceiptProjected(wakeId, at, disposition)` 增加 disposition（`projected|not_applicable`），写 `projection_last_error`；返回 `false` 时打日志（`[turn-wake] receipt projection mark failed for <wake>`）。
* 新增 `recordTurnWakeReceiptProjectionAttempt(wakeId, reason)`：`projection_attempts += 1, projection_last_error = reason`。

### 3.3 循环形状

```
for receipt of list(limit):
  try { outcome = await onReceipt(receipt) }
  catch (e) { outcome = { kind: "retry", reason: "exception:" + e.message } }
  switch outcome.kind:
    projected / not_applicable → mark(...); if (!marked) warn(wake_id)
    retry → recordAttempt(wake_id, reason); warn(`[turn-wake] receipt projection retry for ${wake_id}: ${reason} (attempt n)`)
```

`onReceipt` 的返回类型从 `"projected"|"not_applicable"|"retry"` 改成带 reason 的判别联合，让 patrol 层能打出「为什么 retry」。`!activation || !run` 分支必须带 reason 返回。

## 4. 可见告警

* 复用 `materializeTurnWakeNoReceiptAlerts` 的形状新增 `materializeTurnWakeUnprojectedReceiptAlerts({nowMs, alertAfterMs})`：条件 `state='acked' AND receipt_projected_at IS NULL AND acked_at <= now - alertAfterMs AND projection_alerted_at IS NULL`；leadId 取法与现有一致（`sessions.lead_id` / `session_receipt_lineage`）；question id `turn-wake-projection-alert:<wake_id>`；写 `projection_alerted_at, projection_alert_question_id`（新增两列，不复用 `alerted_at`，因为那一列的语义与 `state='sent'` 绑死）。
* `alertAfterMs` 默认 15 分钟（正常投影 ≤ 6 分钟；留 2× 余量）。
* quarantine 到阈值时不等 15 分钟，立即物化（`wakeIds` 过滤，与现有 `failedPointerWakeIds` 的用法相同）。
* 一条收据一生只告警一次；投影成功后不再补「恢复」消息（Lead 看 question 状态即可；避免 12552 条那种噪音）。

## 5. 两道门

### 5.1 谓词

新增 `StateStore.findOpenWorkflowReworkForRun(runId): { requestId, source: 'delivery'|'verification_path', state } | undefined`，SQL 即现有 Lead 门的 UNION（50563-50573），但 verification_path 只算 `pending`，`active` 单独返回 `source:'verification_path_active'`。

### 5.2 两道门的判定

| 门 | delivery 未结算 | path `pending` | path `active` |
|----|-----------------|----------------|----------------|
| Lead 返工 `openOperatorRework` | 拒 `rework_already_open` | 拒 `rework_already_open` | 拒 `rework_already_open`（现状；Lead 手工返工不走 superseding） |
| founder 打回 `openPendingCarryoverFounderFeedbackTx` | 拒（现状） | **改为拒**（新） | 放行（现状；`supersedingRework` 语义） |

理由写进代码注释：`pending` 的 path 表示返工的体还没开始（wake 未回执），此时再开一条返工必然与 `rework_target_reserved` 相撞；`active` 的 path 是 founder 打回的合法 superseding 对象。

修好 §2 之后 `pending` 卡死本身就不会再发生，两道门的差异只剩「active 期间谁能开新返工」，这是既有设计，不动。

## 6. CommDB 迁移模式

`db.ts:1670-1678`：`PRAGMA table_info(turn_wake_outbox)` 检查列名，缺则 `ALTER TABLE … ADD COLUMN`。新增四列照抄。建表 DDL（db.ts:280-306）同步加列，保证新库与迁移后的旧库形状一致。CommDB 是 `better-sqlite3`（同步），无 `save()`。

## 7. 部署形态

Bridge 从 `packages/flywheel-comm/dist` 消费 `CommDB`（`dist/db.js:5486` 与源码逐字相同），改 db.ts 后需 `pnpm --filter flywheel-comm build`；这是既有发布流程的一部分，本单不改发布。

## 8. 测试夹具

| 需求（issue §6） | 夹具 | 形状 |
|------------------|------|------|
| 积压 > 窗口 | `turn-wake-patrol.test.ts`（CommDB 临时库 + `enqueueTurnWake` + `ackTurnWakes` + `drainTurnWakeOutbox({maxPerProject, onReceipt})`） | 塞 25 条 acked；`onReceipt` 对前 2 条永远 retry；断言 25 条在两轮内全部访问过（attempts 排序），后 23 条投影成功 |
| 队首永久失败 | 同上 | 前 1 条返回 `not_applicable`/抛异常，断言后续仍被访问、`projection_attempts` 递增、到阈值退出窗口并产生 1 条 question |
| 无日志分支 | 同上 + `vi.spyOn(console,'warn')` | 每个 retry 都有含 wake_id 的 warn；`markTurnWakeReceiptProjected` 返回 false 时有 warn |
| 两道门（delivery 清、path 未清） | `StateStore.workflow-rework.test.ts` / `StateStore.founder-kickback-newcard-loop.test.ts` | 造 delivery `completed` + path `pending`：`openOperatorRework` 拒；founder 打回拒（新）；path `active`：founder 放行 |
| 完成先于回执 | `workflow-rework.e2e.test.ts:1040-1140` 反转顺序 | `commitEnrolledCompletion` 先；断言 path 已 `active→completed`、delivery `completed`、节点 `done`、随后 `recordWorkflowReworkWakeReceipt` 返回 `idempotentReplay:true` |
| 节点已 running 时回执 | `StateStore.workflow-rework.test.ts:2706` 附近 | 先把节点置 running，再投影：`ok:true`，不抛 |

## 9. 不在本单范围（记给 Lead）

* `onReconcilePatrolTick` 里 `drainTurnWakeOutbox` 之后的五步（`reconcileWorkflowTurnLedgers` 等）自 9-23 03:20Z 起每轮被跳过；本单修好后自动恢复，但积压效应需另核（建议 Lead 另开单）。
* 线上 30 条积压：修复上线后，9 条节点仍 `admitted` 的会正常投影；12 条 delivery 已 `completed` 的以 idempotentReplay 投影；其余（节点 `done` 且 delivery `awaiting_receipt`、run 多为 terminated）由新循环 quarantine + 告警，交 Lead 按 FLY-2640/B 的手法结算或忽略（run 已终止的可直接标 `not_applicable`——plan 里给一次性判据）。
* 通用完成写点 59049 的 CAS 语义不动。
