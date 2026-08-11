# FLY-1614 交棒简化与单次播报 — 设计修正
Issue: FLY-1614 (https://linear.app/geoforge3d/issue/FLY-1614/巡检场景1-节点完成下一棒交接无死线无自播报-turn-beltfounder-gate-停滞只能靠-lead-查表发现今晚-3)
日期: 2026-08-11
基于: plan.md

## Founder 原话(2026-08-11 01:18 PT)

> 【第 1 层:引擎交棒不丢】do we really need 交棒协调器 ? I anwt the sytem to be simple. Not mean you cannot add 交棒协调器 , but you ust be very careful to add new things plz
>
> 【第 2 层:等棒自动喊人】ok ensure we just send it once, I do not want to get into flood msg again

## 简化结论

不建新的「交棒协调器」运行机器。`runner_ship` 仍必须在 founder approval 同一事务里落 durable delivery intent,否则批准提交后 Bridge crash 会永久丢失交棒动作;但 intent 的 drain、退避和 Lead 告警全部骑在现有 `WorkflowEngineDispatcher` 的 1 秒 reconcile 与现有 `workflow_alert_outbox` 上。实现只保留一个无 timer、无进程、无独立生命周期的 carrier delivery handler,由既有 engine tick 调用。

结构性不能删除的最小器官只有三项:

1. `workflow_carrier_delivery`:跨 StateStore/CommDB 的 crash recovery source of truth;既有 `workflow_run_event` 是 append-only 事实,没有 claim/state/lease,不能安全承担可重放 effect。
2. CommDB sourced `grantTurn` 的 activation bundle + StateStore epoch projection:既有 belt 单行不含完整消费凭据,缺任一边都会重现「DB 说授予、runner 仍看不到」的分裂。
3. exact target wake fence / receipt:既有 mailbox 发送会在重启时重放,没有 durable event identity 就无法证明不重复唤醒或不唤醒已终态 attempt。

## 废弃的概念

- 废弃独立 `WorkflowShipCarrierCoordinator` 组件、独立 scheduler、独立 watchdog 的命名与生命周期。
- 不新增中央 deadline engine;交棒 drain 继续使用 `WorkflowEngineDispatcher.reconcile()`。
- 不复制告警发送器;耗尽告警继续写既有 `workflow_alert_outbox`。
- 不把 gate carrier 伪装成新的 generalized node attempt,也不铸 submission credential。

## 保留的器官及既有机器归属

| 器官 | 归属 | 原因 |
|---|---|---|
| approval 同事务 intent | `StateStore.applyWorkflowSourceEvent` | 唯一能消除 approval commit 后 crash 空窗的位置 |
| carrier delivery 状态推进 | `WorkflowEngineDispatcher.reconcile()` | 复用既有 boot/tick/串行化/日志循环 |
| TURN full bundle | `CommDB.grantTurn` | 复用既有 source replay、belt、activation 原子事务 |
| epoch 投影 | `workflow_carrier_delivery` 专列 | carrier 不属于 `workflow_execution_binding`,不能复用其 FK |
| Lead severe 告警 | `workflow_alert_outbox` | 复用既有 claim/retry/delivery receipt |
| wait 自动喊人 | `flywheel-comm turn` + `turn_wait_ledger` | 所有 vendor/节点共用的轮询入口 |

## 单次播报硬合同

同一次交棒等待事件的身份固定为 `(waiting_execution_id, holder_execution_id, epoch)`,幂等键固定为 `turn-wait:<waitingExecId>:<holderExecId>:<epoch>`。`turn` 在一个 CommDB 事务内 insert-or-verify 该 question 与 `turn_wait_ledger.asked_at`;无论并发轮询、进程 crash、Bridge/runner 重启或 mailbox replay,该 event identity 全生命周期最多产生一条 Lead message。发送失败保留 retryable ledger,但重试仍使用同一个 question id,绝不新建消息。

验收必须包含一条先红的 replay 测试:第一次超时轮询写入 question 后,关闭并重开 CommDB,对同一 `(waiter, holder, epoch)` 再执行多次 `turn`;断言 Lead mailbox/question 行始终只有一条,question id 不变。

## 对实施顺序的修正

1. 把已写的 carrier 类重构为 existing engine tick 的无生命周期 handler。
2. 完成 spawn/carrier 的 full-bundle grant 与 exact terminal fence。
3. 先写 replay-red 测试,再实现 `turn_wait_ledger` 单次 Lead 播报。
4. 其余 receipt、自校验、re-drive 继续按 `plan.md`,但不得新增 scheduler 或第二套 alert transport。
