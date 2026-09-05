# FLY-2337 死信终态补充闭环 — 设计纠偏
Issue: FLY-2337 (https://linear.app/geoforge3d/issue/FLY-2337/引擎urgent-发给终态体的死信不得把活-run-打-heldundeliverable-hold-降级为告警bridge-重启)
日期: 2026-09-04
基于: plan.md

## 触发证据

合并最新 `origin/main` 后，Lead 用生产库副本确认两条 response 型 DEAD mail
`38663338` / `9cc50a43` 仍会进入普通 mailbox reroute，最终撞
`UNIQUE constraint failed: mailbox.ref_id`。与它们绑定的既有 `hold_resume`
operation 已带 live `target_activation_id`，因此也会在 maintenance hold lane 重放同一条不支持的
response reroute，并一直停在 staged。

同一轮审查还发现 RunnerMailboxLane 对 founder-gate response、当前 design manifest、unknown
recipient 三类「拒绝标 DEAD」分支只保活、不冻结 run，却没有 durable warning。

## 锁定纠偏

1. DEAD response 不参与 successor resolution，也不创建 child mailbox row。StateStore 以
   `response_reroute_unsupported` settle attempt，并把 episode 关闭为
   `terminal:settled:response_reroute_unsupported`；同一事务写一条
   `delivery_response_closed:*` guidance warning，明确要求需要时发送新 instruction。
2. maintenance hold lane 在处理已 staged 的 response reroute 前读取物理 mailbox 类型；若为 DEAD
   response，执行同一 terminalization，随后把原 `hold_resume` 从 staged 推进 applied/projected。
   原 DEAD row 的 `dead_reason`、`superseded_by` 与 `ref_id` 不改写。
3. MailboxQueue 对 terminalization refusal 返回有界的 source evidence；RunnerMailboxLane 用确定性
   identity `terminalization_refused:<sourceId>` 写一条 Lead `dead_letter_notice`。重复 tick 与归档后
   replay 都由永久 `mailbox_identity` 去重；已知 recipient 走 owning Lead，unknown recipient 走
   project fallback Lead。

## 生产副本验证

2026-09-04 21:31 PT 对 live DB 做 SQLite read-only backup 后，仅在 `/tmp` 副本运行当前编译产物：

- untouched 副本：held runs `12 → 12 → 12`；open undeliverable episodes `22 → 18 → 18`；
  `38663338` / `9cc50a43` 的 hold-resume 均由 staged 变 projected，且两条 episode 均以上述
  closed reason 收口；没有 UNIQUE 错误。
- 按 QA appendix 同时移除四条 incident fence event 与匹配 alert row 的 pre-incident 副本：held
  runs `12 → 12 → 12`；open episodes `22 → 17 → 17`；第二次 fresh-Store tick 新增事件与告警均为
  0。与 QA 较早快照的 `24 → 19` 等价；live 数据在本轮前已自行关闭/清理两个 episode，故绝对
  baseline 已从 24 演进到 22。
- untouched 副本的 staged 总数为 `8 → 5`，其中 QA 指定的两条 response operation 均已
  projected；较早 `8 → 4` 快照中的 FLY-2266 operation 此时因 production run 已 completed 而不再
  eligible。这是 live-state 演进，不是 response closure 回归。

所有 production 文件只读；验证副本未回写 live DB。
