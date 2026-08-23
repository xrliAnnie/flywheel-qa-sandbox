# FLY-1998 数据库保留窗清扫 — 探索
Issue: FLY-1998 (https://linear.app/geoforge3d/issue/FLY-1998/数据库清理-全库老旧数据清扫commdbteamleaddb-超龄历史数据按保留窗清一轮founder-直令马上开始1995)
日期: 2026-08-22
基于: 无

## 1. 目标与决策

Founder 的假设是：生产 `comm.db` / `teamlead.db` 积累了过多历史数据，Bridge 读取因此变慢；应先清库，再执行 FLY-1986 的空窗压测。本单交付一次性、可审计、可恢复的保留窗 surgery，不建设长期 janitor，不做分区、索引优化或 `VACUUM`。

生产只读审计证明，“老”并不等于“可删”：多张表的行本身是幂等 fence、结算证据或 fail-closed authority。R2 选择安全性优先：只删除已经逐类证明为叙事审计、且外部副作用由其它 durable state 防重的 `workflow_run_event`；`comm.db` 本轮只盘点和测量，安全 cohort 为零时不得为了覆盖两库而删除 authority/provenance 数据。

## 2. FLY-1995 的机器边界

FLY-1995 的权威清单是 `engineering/doc/FLY-1995-bridge-health-stall/cleanup-exclusion-manifest.md`（FLY-1995 commit `09b64bf7f`）。它明确拥有两块数据：

1. `comm.db.mailbox` 的 session-less orphan question，由 zombie gate hygiene 走 `terminal_disposed` 收口。历史日志 census 46 已漂到 50，不能作为稳定 cohort；已确认 voice backlog 谓词当前命中 42 行，另须排除 `resolved_via='fly1995_sessionless_ask'` 的 forensic-window 行；
2. `teamlead.db.session_events` 中精确 2,638,046 行风暴 cohort：`event_type='issue_thread_infra_notify_skipped'`、`source='bridge.founder-thread-notifier'`、`2026-08-01 22:00:00 <= ts < 2026-08-05 04:00:00`。

本单使用双重排除：目标 descriptor 只能出现 `workflow_run_event`，并在 inventory/apply 都断言其与 forbidden tables `{session_events, dead_letter_alerts, mailbox, mailbox_log, mailbox_identity, sessions}` 交集为空；同时按上述 manifest 的完整谓词只读计算 sentinel count/有界 membership fingerprint，写进 dry-run/apply receipt。不得把过期的“46”当 authority，也不得只按 event type 近似排除。

## 3. 候选方案

### 3.1 广泛按年龄清 session/mailbox 历史（否决）

- `mailbox_identity` 被 schema 定义为永久 replay fence；已 archive identity 要依赖 `mailbox_log.archived` snapshot，删除后 `inspectDeliveryState` 会 fail-closed。
- `mailbox_log` 的 `migrated_history` / `migration_snapshot` / `archived` 是恢复和 settlement 证据；`processed` / `disposed` 也参与 durable delivery provenance；唯一表面安全的 `progress` 当前为 0 行。
- `teamlead.db.sessions` 的“存在/不存在”被 writer liveness、carrier terminality、lane authority 等读者当成正负证据；约 53 张表还以 execution id 建立关联。
- `comm.db.sessions` 的正确终结路径是 `CommDB.finalizeSession()`，会同时 retire question、清 receipt wake、删 shutdown control，并要求正向 tmux-death 证明；裸删历史行会绕过这一协议。

因此 session、live mailbox、mailbox archive/provenance 本轮全部列为 protected，不删。

### 3.2 整库复制后一次 `VACUUM`（否决）

整库备份不满足“每张被清表 `.mode insert`”证据。两库 `auto_vacuum=0`，现在 `VACUUM` 会拿长排它锁，且最大 2.8M 行主体仍归 FLY-1995；此时 compact 收益顺序错误。报告应展示 rows/freelist 与 latency，并诚实注明 main file bytes 可能不变。

### 3.3 manifest-bound 两段式 surgery（选择）

- `inventory`：固定 UTC cutoff，只读盘点两库，冻结精确 PK 清单；每个非零 cohort 用 SQLite `.mode insert` 导出，算 digest 并在 scratch DB 恢复验证；采 20 次有上限的 `/health` baseline。
- `apply`：只使用 manifest 内的 PK；新过窗数据不加入。每批 `BEGIN IMMEDIATE` 后重跑完整 CAS 谓词，临时撤销/原样恢复 append-only trigger，异常回滚当前批；采后测 20 次。
- `rotate-log`：独立动作，只在 canonical Bridge launchd job 已 booted out 且 rename 前即时复核零 open FD 时轮转；工具不 stop/start/restart 服务。

## 4. 实际保留窗与 deletion allowlist

| 数据 | 保留窗 | 本轮动作 |
|---|---:|---|
| `workflow_run_event` 四类 narrative kind，parent 已终态 | 14 天 | manifest-bound 删除 |
| `dead_letter_alerts.state='accepted'` | 14 天提案 | 本轮 protected；它是 live dead-letter cursor/dedupe ledger，删除后 Bridge 会重建 |
| 两库 `sessions` | 30 天提案 | 本轮 protected；authority 语义未满足安全删除证明 |
| `mailbox` / `mailbox_log` / `mailbox_identity` | 14/30 天提案 | 本轮 protected；settlement/recovery/replay 证据不可删 |
| 其它 outbox/wake/receipt/history | 无 | protected；不能以年龄替代终态证明 |

四类 narrative allowlist：

- `rework_delivery_claimed`
- `rework_delivery_released`
- `workflow_engine_alert_enqueued`
- `workflow_engine_alert_posted`

对应 side effect 的 authority 分别在 `workflow_rework_delivery` 状态机和唯一 `workflow_alert_outbox.escalation_uid`。DELETE predicate 还必须正向证明 backing row 存在：rework generation 不小于 event generation；alert outbox 为 settled `sent|failed`。authority 缺失即保留。满足后重放最多补回 audit event，不会重复 claim/release 或重复发 alert。任何未列出的 kind 都保留，尤其保留 termination、credential rotation、ship-ready、stalled alert、gate/loop/edge/runner 等 authority fence。

## 5. 安全与诚实报告

- timestamp 一律用 `julianday(column)` 比较；`NULL`/解析失败 fail-close 保留，禁止混合 TEXT 格式字典序比较。
- 生产 inventory 由 readonly handle + `PRAGMA query_only=1` + exact statement log 证明无写；不能用活跃 WAL/SHM 的 byte hash 冒充只读证明。byte invariance 仅用于隔离 fixture。
- `/health` 每轮 20 次串行 bounded request；保留 status/duration/error，报告成功率、p50/p95/max。当前 probe 已出现 5 秒无响应，失败样本不得隐藏。
- 当前安全 deletion cohort 只约 14,068 行，远小于 FLY-1995 的主体；本轮不承诺显著缩小 1.6 GiB 文件，也不预设性能一定改善。
- `/tmp/flywheel-bridge.log` 当前约 63 MiB 且被多个 Node FD 持有；严禁 live truncate/copytruncate，以免旧 offset 写出 NUL 空洞。

## 6. 会过期的结论

| 结论（as-of 2026-08-22） | 过期条件 | 权威重核 |
|---|---|---|
| `teamlead.db` 约 1.6 GiB、`comm.db` 约 499 MiB | 任一库继续写 | inventory measurement |
| 四类旧终态 narrative event 共 14,068 行 | cutoff/run status 变化 | frozen manifest PK list |
| `dead_letter_alerts` 有 active cursor/dedupe reader，不能作为本轮 deletion cohort | reader/writer 协议变化 | `listDeadLetterAlertCursors` + reconcile reader audit |
| `mailbox_log.progress` 0 行，其余种类均 protected | schema/writer/reader 变化 | code audit + inventory |
| FLY-1995 两块表为 `session_events` / `mailbox`，权威清单 commit `09b64bf7f` | FLY-1995 设计变化 | cleanup exclusion manifest；目标表交集仍须为零且完整谓词 sentinel 不变 |
| Bridge log 有 holder | 服务窗口变化 | launchctl + rename 前即时 `lsof` |
