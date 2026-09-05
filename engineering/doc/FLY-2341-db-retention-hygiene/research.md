# FLY-2341 终态数据库冷热分层 — 调研
Issue: FLY-2341 (https://linear.app/geoforge3d/issue/FLY-2341/引擎db-卫生-数据库无保留策略终态行只增不减teamleaddb-598mb-commdb-639mb让维护扫描随历史线性变慢)
日期: 2026-09-04
基于: exploration.md

## 1. 现有实现可以复用什么

### TeamLeadDB

`scripts/lib/fly-2006-retention-engine.mjs` 已经把“可删的历史叙事”和“仍是权威的状态”分开，但审查发现
它原先误把 `external_merge_suspect` 当 narrative。该事件是 rogue merge 告警的 durable once-only claim，
不能从 `session_events` 或 `lead_events` 搬走；本单同时从旧 operator allowlist 和新 runtime allowlist 删除它。
其余可复用部分是：

- `session_events` 只处理已终态 session、时间窗外、且不属于当前 active workflow lineage 的事件；active
  snapshot 必须合并 TeamLead live sessions、active/held workflow runs 与 nodes、以及所有 CommDB running
  sessions 的 execution/issue id，并对 payload 中的精确 scalar lineage fail-close；
- `workflow_run_event` 只处理 FLY-2006 已验证的
  `rework_delivery_claimed|rework_delivery_released|workflow_engine_alert_enqueued|workflow_engine_alert_posted`；
- `lead_events` 只处理已 settlement、没有 delivery/legacy child reference 的 narrative event；
- 删除前有 active-lineage fail-close，VACUUM 与逻辑清理分离。

本单不扩大到 workflow authority/event cursor、未 settlement 的 delivery attempt、仍被 foreign key
引用的 alert/receipt 行。生产实测里大批 `rework_activation_stalled_alerted` 与
`workflow_engine_escalation` 仍参与告警去重/追踪；仅凭“父 run 已终态”不足以证明可搬走。

FLY-2006 的缺点是 operator-only 全量 inventory/apply，而且物理 DELETE 后不能从库内直接恢复。
因此本单复用它的 eligibility policy，不复用其全量执行形状。

### CommDB

`MailboxQueue.archiveDueFamilies()` 已有正确的有界候选扫描：按 `acked_at|dead_at` 索引和游标，候选
带 `LIMIT`，每分钟最多处理 5 个 family。`archiveFamily()` 的 FLY-1572 transaction 按顺序：

1. 对 mailbox row 生成 canonical JSON（含 content-ref bytes/digest）；
2. 写 `mailbox_log(event='archived')`；
3. 将 `mailbox_identity.archived_at` 从 NULL CAS 成时间戳；
4. 删除 mailbox row；DELETE trigger 验证 identity 和 archived snapshot 完全匹配；
5. transaction 成功后才异步处理 content-ref GC。

因此 mailbox row 的第一段归档协议不需要重写，只需把默认 retention 从 72 小时统一为固定七天，
再把七天以前的 archived identity/log compact 到一个 canonical cold row。

## 2. 热读者与兼容合同

CommDB 的历史 identity 不是纯日志。下列 exact lookup 依赖它判断“从未见过”与“见过但已归档”：

| 调用点 | 当前 hot lookup | cold fallback 后的语义 |
| --- | --- | --- |
| `enqueue()` | id/delivery_id identity | 已归档仍返回 `outcome='archived'`，禁止重插 |
| `claimDiscordLane()` | id/delivery_id identity | 已归档仍返回 `lane='archived'` |
| `inspectDeliveryState()` | identity + archived log | 从 cold snapshot 返回 terminal；identity-only 返回 torn/unknown，不伪造状态 |
| `getIdentityCarrier()` | identity + archived log | 从 cold snapshot 取 carrier；identity-only 返回 `unknown_archived` |
| `archiveFamily()` missing row | identity.archived_at | cold row 存在时仍幂等 |

另有两类非 exact-id 读者必须单独处理：`getFounderReviewFamily()` 按 `mailbox_log.subject_id` 取完整问题
family，因此 cold table 保存 `subject_id` 并建索引，reader 在 hot miss 后回查 cold；
`resumeMailboxInflightHold()` 按 `mailbox_log.event_id` 读取 `event='progress'` 的一次性恢复 receipt，因此
拥有 progress receipt 的 identity/log 整体保持 hot，不进入 compactor。receipt teardown 只读取仍有 live
mailbox 的 log，不会碰到 cold 候选。至此生产 `mailbox_log` direct readers 已逐一分类。

其余调用都按 exact id 或 delivery id 查，不需要通用 repository abstraction。新增一个内部 lookup，先
读 hot identity，miss 才按 cold table 的 unique id/delivery_id 查，即可覆盖兼容面。

TeamLead 侧不引入 cold fallback 到维护扫描。只归档已证明没有 current authority reader 的白名单行；
恢复是 operator 路径。这样不会把 FLY-2339 的三段 projector/watch/operations 查询改造成冷热 UNION，
也不会扩大本单与其算法修复的冲突面。

## 3. 数据模型与删除护栏

### `workflow_terminal_archive`

一行对应一个被迁出的 TeamLead row：

- `source_table` + `source_identity` 为主键；
- `source_created_at` 和 `archived_at` 为日期切口；
- `row_json` 保存原始逐字段 JSON；
- `row_sha256` 让 operator restore 在写回前验证 payload 未损坏。

只建 `(source_table, source_created_at)` 索引。runtime 候选仍从 source table 的 eligibility/time index
读取，`ORDER BY created_at/ts, primary-key LIMIT N`；每 tick 最多处理固定 N 行，一行一条
`INSERT OR IGNORE archive` + guarded DELETE，同一 immediate transaction。重复执行要么归档一次，
要么看到相同 digest 后幂等；同 key 不同 digest 必须 fail-close。

### `mailbox_terminal_archive`

一行对应一个 message identity：

- `id` 主键，`delivery_id` unique；
- `terminal_at`、`archived_at`；
- `id`、`delivery_id`、`insert_projection_hash` 逐字段保存；`mailbox_json` 可空；`logs_json` 为原始 log
  数组；`subject_id` 支持 founder-review family cold lookup；
- payload digest 保护 restore 和幂等重跑。

现有 legacy `mailbox_archive` 不继续写，也不作为 canonical 权威。对历史 archived identity：有
canonical archived log 时带它及该 identity 的全部 logs 搬入 cold；没有 mailbox snapshot 的
47,575 条只写 identity + logs，`mailbox_json=NULL`，绝不从旧表猜测或补造。

两个现有 permanent DELETE trigger 改为“默认拒绝；仅当同一 id/delivery id 的 cold row 内容与 OLD
逐字段/逐条 log 完全匹配时允许”。归档 transaction 先写 cold evidence，后删 hot logs/identity；任一
trigger 验证失败，整批回滚。cold table 自身禁止 UPDATE/DELETE。restore 只把逐字段验证后的 cold
payload 复制回 hot 表，不删除 cold evidence；因此无需临时授权表，重跑可幂等，归档证据也不会因
一次恢复演练而消失。

## 4. 时间窗与执行预算

TeamLead 和 Comm identity/log cold compaction 使用固定 `7 * 24 * 60 * 60_000`；既有 mailbox family
archive 保持 72 小时，不让 terminal mailbox 多留在 hot。两者都不暴露 retention/batch knob。生产既有
TeamLead 时间有 SQLite `datetime('now')` 和 ISO-8601 两种格式，因此 eligibility/index 一律用
`julianday(column)`；无法解析的时间或 JSON payload 均 fail-close 留在 hot。唯一新增运行时开关
`database_archive` 是 project-scoped、default-on flag，只停止新 cold compactor，不改变保留窗/批量，
也不停止既有 mailbox family archive 与 content-ref GC；flag store 不可读时 fail-close。所有 runtime
查询必须同时具备：

- 明确的 `terminal_at <= cutoff` 或 `julianday(created_at) < julianday(cutoff)`；
- 主状态/父终态 predicate；
- `ORDER BY time, stable identity LIMIT ?`；
- 对应的 partial/composite index；
- `EXPLAIN QUERY PLAN` 测试拒绝 source-table full scan。

TeamLead 复用 `HeartbeatService` 已有 detached、single-flight maintenance callback，不新增 timer；Comm
复用 `lead-inbox-runtime` 每分钟 archive cadence。单 tick 的固定预算先取 TeamLead 100 rows、Comm 25
identities；两者遇 `SQLITE_BUSY` 都结束本 tick，不 busy-loop。VACUUM 只存在于显式 operator 命令。

## 5. 一次性 rehearsal 与可逆性

实现节点只操作隔离副本：

1. 用 SQLite online backup 取得 TeamLeadDB snapshot；CommDB 使用 Lead 指定的
   `comm-mailbox-archive-20260904T201735Z.db`，复制后再写；
2. 对两库记录 bytes/page_count/freelist_count、hot/cold/总行数与目标索引；same-file cold archive 在
   VACUUM 前不承诺净字节下降，结果必须同时报告 hot 降幅、cold 增量和数据库总 bytes；
3. 在同一 snapshot 上分别多轮计时 delivery-contract projector/watch/operations maintenance pass，记录
   median/p95；不把 FLY-2339 的算法改动混进结果；
4. 用 bounded loop 跑到无候选，每 batch 保持 runtime 同样的 N，并在 batch 间 yield；
5. 第二次采样证明归档为 0，七天内、active/held 和非白名单 authority 行不变；
6. 显式 VACUUM 后重测体积与三段 pass；
7. 从 cold 随机恢复至少一个完整 Comm family 和每个 TeamLead source table 各一行，比较逐字段 digest，
   再重新归档，证明 replay 与 rollback；
8. 产出机器可读 JSON 和 PR 摘要。生产库仍不执行 DELETE/VACUUM。

“连续两小时零 loop-guard stall”和“两次生产采样/七天曲线”需要部署后的观察窗口，本 implementation
PR 只能提供隔离 rehearsal、runtime metrics/logging 与 rollout runbook，不能伪造生产验收。

## 6. 主要风险与负控

- **误删 authority**：白名单之外一律不归档；active/held/current-lineage 和 child-reference 测试锁住。
- **归档证据不完整**：先写 cold、trigger 对比、同 transaction；裸 DELETE 测试必须失败。
- **legacy identity-only 被伪造**：cold snapshot nullable，status/carrier 降级语义明确。
- **有界任务退化成全表扫描**：索引 + query-plan 测试 + batch hard cap；不使用 OFFSET；rehearsal 另报
  最大 batch wall time、候选 drain 速率与当前历史 backlog/growth rate，证明任务不会永久追不上写入。
- **cold table 自身继续增长**：本地 SQLite 先换取 hot-path 有界；same-file 总历史不会凭空消失。未来
  cloud DB 以 `source_created_at` / `terminal_at` 直接映射日期分区与外部冷存储，本单不提前做 adapter。
- **restore 覆盖新 hot state**：若 hot id/delivery_id 已存在且 digest 不同则 fail-close；cold evidence
  保留不删，匹配的重复恢复才幂等。
- **VACUUM 卡 heartbeat**：runtime API 不暴露 VACUUM；operator script 单独子命令且只接受显式路径。
