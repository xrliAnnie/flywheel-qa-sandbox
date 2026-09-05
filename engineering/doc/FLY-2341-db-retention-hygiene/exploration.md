# FLY-2341 终态数据库冷热分层 — 探索
Issue: FLY-2341 (https://linear.app/geoforge3d/issue/FLY-2341/引擎db-卫生-数据库无保留策略终态行只增不减teamleaddb-598mb-commdb-639mb让维护扫描随历史线性变慢)
日期: 2026-09-04
基于: 无

## 1. 问题不是“再加一个索引”

2026-09-04 20:26Z 对生产库只读复核：`teamlead.db` 已到 627,765,248 bytes，
`session_events=366,840`、`workflow_run_event=120,382`、`lead_events=68,684`、
`workflow_alert_outbox=13,832`；workflow run 中 `completed|terminated|canceled|cancelled=521`，
`active|held=38`。`workflow_delivery_attempt=4,290`，只有 112 条仍 live，4,178 条已经 settled 或
superseded。七天窗外、且父 session/run 已终态的 `session_events` 与 `workflow_run_event` 分别至少
98,963 与 102,742 行。

同一时间点的 `dbstat` 显示，`session_events` 表及其索引约 267 MiB，`lead_events` 表及其索引约
131 MiB，`workflow_run_event` 表及其索引约 72 MiB，`workflow_alert_outbox` 约 20 MiB。即使
FLY-2339 把三段 delivery-contract 扫描改成 O(1)/有界，只要这些 hot 表继续永久增长，其他维护、
迁移与巡检仍会随历史负债变慢。

20:17Z 的只读 CommDB 快照为 670,281,728 bytes。里面 `mailbox=20,417`，其中
`ACKED|DEAD=20,098`；但真正的大头已经不是 live mailbox，而是永久留在 hot schema 的
`mailbox_log=144,121`（约 331 MiB）和 `mailbox_identity=152,541`（表+三个 unique index 约
96 MiB），另有 8 月 29 日一次性生成、没有正式 runtime 合同的 `mailbox_archive=66,272`
（约 127 MiB）。129,765 个 identity 已标为 archived；其中 82,190 个有 FLY-1572 canonical
`event='archived'` snapshot，47,575 个只有 migration identity history，不能凭空补造 mailbox row。

## 2. 已有资产与缺口

- FLY-2006 已提供 14 天一次性 retention engine、sealed inventory/apply/VACUUM、active-lineage
  fail-close 与安全 narrative allowlist。它证明了候选和删序，但目标是一次性 DELETE，不是
  runtime 冷热分层；也不会阻止历史重新增长。
- `MailboxQueue.archiveDueFamilies()` 已按 `acked_at|dead_at` 索引、游标和 `LIMIT` 每分钟最多归档
  5 个 family，并严格执行 FLY-1572：先写 matching archived log、再 CAS identity、最后 DELETE
  mailbox。缺口是默认只保留 72 小时，且 archived log/identity 永久 hot。
- delivery-contract 的 terminal projection 已带时间窗；FLY-2339 正在独立修其三段扫描算法。
  本单不修改那三段算法、不改 EventLoopGuard 阈值，也不借数据清理掩盖扫描复杂度。

## 3. 方案比较

### A. 再跑一次 FLY-2006（否决）

能短期降体积，但几天后同类表继续单调增长；且 CommDB 的 identity/log 仍保留在 hot 表。

### B. 同库 compact cold table + hot 表有界迁移（采用）

TeamLead 使用一个 `workflow_terminal_archive`，按 `(source_table, source_identity)` 保存原行 JSON、
原时间与归档时间；只迁 FLY-2006 已证明没有 current authority reader 的终态 narrative/settled 行。
CommDB 使用一个 `mailbox_terminal_archive`，每个 message identity 合并保存 identity、canonical mailbox
snapshot（可能为 NULL）与完整 log JSON。hot 表的多个索引不再承载七天以前的历史；确需幂等判断或
`message-status` 时只按 exact id/delivery id 回查 cold 表。

归档和删除在同一个 SQLite transaction 中完成，DELETE trigger 必须看到逐字段匹配的 cold evidence；
因此“归档成功但 hot 删除失败”会整体回滚。VACUUM 独立由 operator 显式执行，绝不放进 heartbeat。

### C. 独立 archive.db / 立即上 Postgres partition（本单否决）

跨 SQLite 文件没有与当前 WAL 形状等价的单事务原子性，会扩大 crash-recovery 面；现在引入远端
repository abstraction 也违反 YAGNI。单一 cold table 已把日期切口固定为 `source_created_at` /
`archived_at`；未来迁 Postgres 时可直接把 cold table 映射成按日期分区，不需要本单先做 sharding。

## 4. 锁定边界

Lead 对问题 `4aa99bc9-4db1-4cec-908a-80f957b276b5` 的裁定：

1. CommDB 只新增一个 canonical cold table、一个 exact-id fallback reader、一个 bounded archiver、
   一个 restore script；不增加通用查询层。
2. identity/log 只有超过固定七天窗且 cold row 已存在时才离开 hot 表；legacy identity-only 行仍只
   保存 identity，不伪造 mailbox snapshot。
3. runtime 归档每次最多 N 行并沿用已有 maintenance tick；不新增 timer、不做同步全表扫描。
4. VACUUM 是单独显式命令；一次性操作先在 529 隔离房对 20:17Z CommDB 快照与同刻 TeamLead
   backup 演练，记录两库体积及 projector/watch/operations 三段前后耗时。
5. 实现节点不触碰生产 DELETE/VACUUM；生产执行要由 Lead/Founder 看过 sealed 数字后另行决定。

## 5. 成功形状

- 七天前的安全终态行持续从 hot 表迁入 cold 表，单 tick 有硬上限且 query plan 命中时间索引；
- FLY-1572 的 archive-before-delete 负控继续拒绝裸 DELETE，重放归档幂等；
- archived message 的 re-enqueue、lane claim、settlement/message-status 与 carrier exact lookup 语义不变；
- restore 把 cold row 逐字段恢复成原 hot identity/log/mailbox，演练后 source/cold counts 与 digest 回到
  归档前状态；
- 单独 VACUUM 后，529 快照的 hot 表与索引体积下降；PR 写明实际数字和没有执行的生产步骤；
- 两次隔离采样证明第二次 maintenance 不会把七天窗内或 active/held/current authority 行误归档。
