# FLY-2337 死信终结不冻结活 Run — 探索
Issue: FLY-2337 (https://linear.app/geoforge3d/issue/FLY-2337/引擎urgent-发给终态体的死信不得把活-run-打-heldundeliverable-hold-降级为告警bridge-重启)
日期: 2026-09-04
基于: 无

## 问题边界

发给已终态 execution 的 runner mailbox 信件会被 mailbox lane 标成 `DEAD`。当前 delivery-contract maintenance 仍把这类行投影成未结 delivery attempt，打开 `undeliverable` episode，并在找不到后继时调用 hold writer，把仍在工作的 `workflow_run` 从 `active` 改成 `held`。Bridge 每次重启后的 maintenance tick 会重新观察存量 DEAD 行，因此同一死信能够反复冻结活 run。

本单一次交付三个行为：

1. 收件 execution 已终态时，物理 mailbox 行以 `recipient_terminal` 终结，delivery attempt 同步结算；只保留既有 dead-letter 告警，不再写 run hold。
2. maintenance 重扫 `DEAD/recipient_terminal` 与 `DEAD/lease_expired_unacked` 时，将其视为终态，重复扫描不再打开 episode 或铸造 hold。
3. operator cancel 遇到任意既有 DEAD mailbox 行时按幂等成功处理；启动 reconcile 只恢复满足明确保护条件的存量错误 hold，并写事件留痕。

## 锁定范围

- 不修改 authority、approval、claim 表。
- 不改变 rework/carrier/phase-wake/turn-wake 的正常 reroute 规则。
- 不改变仍有活收件人的 mailbox 投递、重试和 reroute 语义。
- 不新增 timer；继续搭载现有 delivery projector/watch/operations maintenance 顺序。
- 不新增第二条告警。runner mailbox DEAD 已由 `LeadInboxRuntime` 的 dead-letter intent/outbox 产生一条告警；delivery-contract 只负责终结投影，不再附加 operator-required 告警。

## 假设

- `recipient_terminal` 与 `lease_expired_unacked` 是本单 forward/restart 路径唯一允许直接终结的 DEAD 原因；其他 DEAD 原因保持原有诊断路径。
- 已 DEAD 行上的 cancel 不应改写 `dead_reason`、`dead_at` 或 supersession 字段；“成功”表示目标已经终结。
- 一次性 reconcile 的输入是旧 `delivery_reroute_operator_required` / `delivery_undeliverable_no_recipient` run hold。它只在 run 当前为 `held`、不存在 `held|needs_lead` rework delivery、不存在 held carrier，且至少有 `running|review` node 时恢复为 `active`。
- reconcile 必须结算相关 legacy delivery attempts、关闭 open episodes，并用确定性 event uid 留痕，避免下一 maintenance tick 再冻结。

## 验收映射

| 验收 | 直接证据 |
|---|---|
| 发信给终态 execution 不冻结 run | 单包集成测试：mailbox 变 DEAD、attempt 已结算、run 保持 active、无 operator-required hold |
| 告警一条 | 复用 dead-letter alert 测试：同一 DEAD 行只生成/投递一个 alert intent；workflow alert outbox 不新增 hold 告警 |
| 重启 baseline 重扫零新 hold | 同一 projector/watch/operations pass 连跑两次，第二次事件和告警计数不增长 |
| cancel DEAD 落地 | flywheel-comm 单包测试：预先 DEAD 的行返回幂等成功且字节语义不变；DeliveryOperations 可继续投影 staged cancel |
| 真库四形状 | FLY-2332/2324 的 `review` 节点形状、FLY-2259 的多轮 `review`、FLY-2146 的 `running` 节点进入参数化 reconcile fixture |
