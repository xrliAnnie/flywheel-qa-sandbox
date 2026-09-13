# FLY-2517 换体后旧唤醒退役 — 调研
Issue: FLY-2517 (https://linear.app/geoforge3d/issue/FLY-2517/病根-引擎-proven-dead-replacement-换体后仍向旧体投-phase-wakerework-wake20-分钟后判)
日期: 2026-09-11
基于: exploration.md

## 结论

需要把“旧逻辑唤醒已退役”作为跨数据库可重放的事实投递。换体事务内建立精确旧 activation 的退役记录并结清已有投影；CommDB 收到记录后关闭父 outbox 与物理 phase wake，入口按同一记录拒绝迟到信重新排队。hold 写入前依据 StateStore 重查，历史 hold 通过现有操作员 resume 协议关闭。

只清 `runner_phase_wakes` 或只看替身 session.status 都不够。前者存在投影延迟和迟到入队，后者无法证明它承担了哪一轮返工。

## 审计基线与证据边界

2026-09-11，worktree HEAD `ca869ad6d`；包含 FLY-2504 提交 `bece7de15`。本轮只读代码，未检查生产数据库；事故具体时刻来自注入 issue。没有把历史应急 SQL 当作本次实现方案。并行 source 审计已完成，主节点复核关键 SQL、投影及 Codex claim 消费者。

## 文件与真实调用链

| 文件 / 位置 | 事实 | 设计含义 |
|---|---|---|
| `packages/teamlead/src/StateStore.ts:34895` `materializeWorkflowReworkReplacement` | 写 next route，旧 credentials 撤销，新 dispatch，dead watch / replacement event 同事务 | 在同事务记录旧 activation 退役 |
| `StateStore.ts:34657` `convergeWorkflowReworkWriterReplacement` | generic rollback 已提交时，按 rollback / watch / launch 三方证据推进 next route | 必须覆盖第二个换体入口 |
| `StateStore.ts:34126,34252` activation / activation turn | binding 与 turn 表不可变，精确保留旧 execution、request、node、attempt、epoch | 旧身份可由持久记录构造，不从 wake 文案解析 |
| `bridge/workflow-rework-coordinator.ts:607,803` | activationId=`activation:${requestId}`；逻辑 wakeId 绑定 request、activation、epoch | 共用一个 wakeId 构造函数，避免另写格式 |
| `bridge/plugin.ts:12202` | `deliverDurableTurnWake` metadata 含 kind、wakeId、activationId、epoch | 属于 workflow_rework 的窄入口可识别 |
| `packages/flywheel-comm/src/wake.ts:193` | 先持久化 turn_wake_outbox，后 async transport write | 父 outbox 和迟到回调都要收敛 |
| `flywheel-comm/src/db.ts:251,312` | turn_wake_outbox 是逻辑源；runner_phase_wakes 是物理消息源，PK 不同 | 不把 logical wakeId 当 message_id |
| `db.ts:4628,4774` | enqueue 与 resident receiver admission 最终共用入队 seam | 退役检查置于数据库写入事务，不只放 watcher 外层 |
| `db.ts:5380,5404` | 已有 terminal disposal 使用 finished 而不写 started_at | 兼容保持三态枚举，新增独立退役引用，不能复用真实 receipt |
| `bridge/delivery-contract/projector.ts:172,237,400` | phase 源 started_at 才投影 received/consumed；后续 unsettled pass 把 finished 结清 | 当前最终会结清，但有分页和巡检时序间隙 |
| `bridge/delivery-contract/watch.ts:212` | 未 started + terminal recipient → undeliverable，不看换体事实 | watch 前置退役检查，并保留最终事务检查 |
| `bridge/delivery-operations.ts:529,575` | 取源旧 execution 后解析 successor / liveness / hold | retirement 优先，禁止向已接替的替身重发旧信 |
| `StateStore.ts:44916,45025` | `holdUndeliverableTx → finalizeUndeliverableHoldTx` 才是真 hold writer | issue 历史函数名不是当前 writer |
| `StateStore.ts:44372` | `recordWorkflowDeliveryRerouteOperatorRequired` 已拒绝 runHeld=true | 不在此函数改成全 family 非 holding |
| `StateStore.ts:43127` | settlement 原子写 attempt.reason 并关闭 episode | 复用 exact attempt settlement，无需伪造 superseded child |
| `StateStore.ts:47052,47077` | 非 mailbox 已 settled 源会 hold_changed，phase_wake cancel 硬拒绝 | 仅删除硬拒绝不能修复恢复路径 |
| `bridge/hold-shape-registry.ts:12` | phase_wake requiredDecision 只有 reroute_to | list 与执行共享“可退役关闭”能力判定 |
| `StateStore.ts:47548` | projectWorkflowHoldResume 只有无其他 run hold 才恢复 active | 保留其他暂停原因，不能全局 status=active |
| `packages/claude-runner/src/codex-phase-lifecycle.ts:541` | markWakeStarted 把 finished 也当成功 | observe 缓存后退役的竞态可再次 startTurn |
| `packages/claude-runner/src/codex-daemon-client.ts:1155` | markWakeStarted 返回后立即 startTurn | 返回 typed disposed，调用方必须停止本次激活 |

## 身份链

物理 message_id → metadata 中的 `workflow_rework` + wakeId / activationId / epoch → 同 comm 根的 turn_wake_outbox 精确行 → StateStore 不可变 binding / activation_turn → request 的旧 route 与 successor route + replacement receipt。

这条链每一步都比较 execution、project、issue/run、node、attempt；epoch 必须为正安全整数。不能拆 `root_id` 或冒号字符串作为权限证明。新 typed identity 放在投影的 contract_ref_json；旧 source 通过原 metadata + 父 outbox 精确 hydration，缺损只报告，不猜测或批量丢弃。

## 需要处理的事务边界

1. StateStore 事务回调正常 return 会提交已执行 SQL。所有身份验证必须先于写入；写阶段 CAS 失败必须 throw。
2. StateStore 与 CommDB 是两个数据库；使用 durable outbox（持久待办记录）使 effect 可重放，不用跨库事务幻想。
3. source 物理记录可能尚未到达；仅扫描现有 physical ID 会漏掉未来迟到副本。
4. 退役记录不能随旧物理源一起剪枝，否则晚到消息失去拒绝依据。
5. 已始发 RPC 无法撤回；退役赢得 claim 之前可保证零 startTurn，claim 已赢得之后仍由 TURN / credential 围栏保护业务副作用。

## 已有测试模式及需要补齐的断言

- `teamlead/src/__tests__/fly2278-undeliverable-hold.test.ts`：假时钟、真实 store、完整 episode / liveness / hold。
- `fly2278-hold-cancel.test.ts`：hold canonical digest、重复 clientRequestId、并存 hold、source state 变化。
- `fly2278-comm-reroute-flow.test.ts`：两库 operation staged / applied / projected 与重启重放。
- `fly2248-r6-projector-recovery.test.ts`、`fly2339-bounded-delivery-maintenance.test.ts`：投影重启与分页预算。
- `fly2504-rework-replacement-receipt.test.ts`、`StateStore.workflow-rework.test.ts`：真实 replacement / convergence fixture，不能直接 SQL 假造完成。
- `flywheel-comm/src/__tests__/db.fly2248-delivery-reroute.test.ts`、`db.fly2268.test.ts`、`receipt-wake-state-machine.test.ts`：入队、finished、claim、父源 ack。
- `claude-runner/test/codex-phase-lifecycle.test.ts`、`codex-daemon-client.test.ts`：observe → retire → start 的竞态及正常重放。

## 待 Lead 边界反馈

非阻塞问题 `a1aa3413-1dbd-4025-83bd-7d8c57caaabc`：确认与子单 B 的边界。Lead 已回复同意方向，并明确把 FLY-2518 两项并入：stage reroute rejected 时持久失败并解除操作占用；对应任务已完成的 target 返回 no-op 并关闭 episode。补充审计：`runs-route.ts:411-540` 是 master + loopback + confirmation token 入口；`StateStore.ts:47422` 的 failed 方法当前只更新行不写事件；`workflow_node_completion` 有精确 activation / execution / node / attempt 完成回执。三项邻单边界见 plan §7.1。
