# FLY-1998 数据库保留窗清扫 — 调研
Issue: FLY-1998 (https://linear.app/geoforge3d/issue/FLY-1998/数据库清理-全库老旧数据清扫commdbteamleaddb-超龄历史数据按保留窗清一轮founder-直令马上开始1995)
日期: 2026-08-22
基于: exploration.md

## 1. 生产只读盘点

### 1.1 文件与页分布

| 库/表 | 当前物理量 | 结论 |
|---|---:|---|
| `teamlead.db` | 约 1.6 GiB | 最大主体仍是 FLY-1995 的 `session_events` |
| `session_events` + indexes | 约 1.34 GiB / 2,815,082 行 | 本单整表排除 |
| `workflow_run_event` + indexes | 约 67.4 MiB / 113,752 行 | 仅四类 narrative kind 可删 |
| `teamlead.db.sessions` | 约 7.2 MiB | authority 语义复杂，本轮保护 |
| `comm.db` | 约 499 MiB | 主体为 mailbox lineage/provenance |
| `mailbox_log` + indexes | 约 292 MiB | archived snapshot 与永久 identity 成对，不能按年龄删 |
| `mailbox_identity` + indexes | 约 71 MiB | schema 明示永久，不能删 |

两库 `auto_vacuum=0`。删除后 main file bytes 不会自动缩小；即时观测应以 row count、page/freelist 和 `/health` 为主。物理 compact 等 FLY-1995 大 cohort 清完再单独评估。

### 1.2 安全 cohort

`workflow_run_event` 只允许以下四类，且必须同时满足 `julianday(at)` 可解析、早于 frozen 14-day cutoff、parent status 为 `completed|terminated|canceled|cancelled`：

| kind | 当前候选 | durable authority / 重放结果 |
|---|---:|---|
| `rework_delivery_claimed` | 4,565 | backing delivery row 存在且 generation ≥ event generation；重放不会重领 |
| `rework_delivery_released` | 4,530 | 同一 backing row/generation 已记录 release；重放不会重复释放 |
| `workflow_engine_alert_enqueued` | 2,469 | matching unique outbox 存在且 settled `sent|failed`；至多重补 audit |
| `workflow_engine_alert_posted` | 2,504 | matching outbox 为 `sent`；重放不再 post |
| 合计 | 14,068 | 删除的仅是 narrative copy，不是 side-effect fence |

R1 code review 补出的 reader 证明否决了 `dead_letter_alerts` 删除：`listDeadLetterAlertCursors()` 从 accepted rows 的 `MAX(through_dead_seq)` 生成 live cursor，reconcile tick 又以确定性 event id 重建缺失 intent。删除 accepted row 既不回收稳定空间，还会短暂重建 `pending` 并压住同 recipient 的其它 intent。因此该表整表只测量、零删除。

### 1.3 `workflow_run_event` reader 审计

对仓库中全部 `workflow_run_event` SQL/UID/kind use site 做了逐项审计，分为：exact/prefix UID authority read、kind reader、generic diagnostics、append dedup。四个 allowlist literal 只出现在 writer/audit 路径；它们的外部副作用另有 durable state 防重。实现不会只信 kind：rework payload 必须是合法 JSON，含 string `requestId` 与 integer `generation`，并有 `workflow_rework_delivery.request_id` 且当前 generation 不小于事件 generation；alert event UID 必须具有 canonical prefix，且 suffix 对应 `workflow_alert_outbox.escalation_uid` 的 settled row。当前 14,068 行全部有 backing authority；将来缺任一条件的行 fail-close 保留。

以下类别即使 parent 已终态也不能删：

- operator termination：例如 `run_terminated_by_operator`；
- output/submission credential repair rotation；
- ship-ready stalled/handled observation；
- `rework_activation_stalled_alerted`（发送前直接查 event UID）；
- gate、loop、edge、runner、land/ship、alert escalation 的其它 exact/prefix UID fence；
- 未知/新 kind。实现使用正 allowlist，schema/code 新增 kind 默认保留。

generic `appendWorkflowRunEventCheckedTx` 仍可能在业务调用被重放时补回已删 narrative event；这是允许的 audit 再生，不会重复外部动作。测试必须证明已知 fence 全部存活，并证明 allowlist 外任意 kind 不删。

## 2. 为什么其它候选不删

### 2.1 mailbox lineage

`MailboxQueue.archiveFamily()` 会把 full mailbox row 写入 `mailbox_log.archived`，再标记永久 `mailbox_identity.archived_at` 并删除 live row。`inspectDeliveryState()` 对 archived identity 要求 snapshot 存在；删 `archived` row 会确定性抛出 “archived mailbox identity has no snapshot”。因此：

- `mailbox_identity` 永久保留；
- `mailbox_log.archived` 与它绑定，永久保留；
- `migrated_history` / `migration_snapshot` 是迁移恢复证据，保留；
- `processed` / `disposed` 是 delivery provenance，保留；
- `progress` 当前 0 行；未来出现也须重新 reader 审计，不凭名字自动删；
- live `mailbox` 完全不动，从而与 FLY-1995 orphan question 整表分离。

### 2.2 sessions 是 authority，不只是历史

`teamlead.db.sessions` 的缺失被多条路径解释为 `writer_liveness_unknown`、`carrier_not_terminal` 或缺少正向 execution evidence；仓库约 53 张表还以 execution id 建立关联。没有完整、测试化的 reader/referrer 分类前，30-day raw DELETE 不安全。

`comm.db.sessions` 应通过 `CommDB.finalizeSession()` 终结：它同步 retire questions、prune receipt wakes、删除 shutdown controls，并要求正向 tmux death。离线按 age 裸删会绕过 companion mutations。由于它们体量小且不是当前 1.6 GiB 主体，本单全量保护，报告只给 terminal/old/protected counts。

### 2.3 其它“陈年 backlog”

`receipt_alert_outbox` 现有约 7,772 行都仍 pending；`runner_phase_wakes` 有 pending/started；TURN/runner declared state、mailbox queued/leased/open/protected 都可能代表未结算工作。年龄不能替代终态证明，全部保留并在 report 披露。

## 3. snapshot、manifest 与恢复证明

每张非零 deletion cohort 生成独立 `*.sql`：

1. 系统 `sqlite3 -readonly` 执行 `.mode insert <table>` + manifest-sorted PK 的分块精确 SELECT；每块最多 200 个 `IN` literal，numeric PK 只接受 safe integer，text PK 由单一 SQL-literal encoder 转义并 round-trip 测试，不创建 temp table；敏感 stdout 通过 child stdout FD 直接写 `0600` 文件，不进入 Runner transcript；
2. inventory 要求 evidence dir 尚不存在，以 `0700` 创建并拒绝既有宽权限 parent；snapshot/manifest/receipt 都 exclusive-create 为 `0600`、拒绝 symlink/覆盖并在 seal 前 `fsync`。JSON/sidecar 先写同目录 0600 temp，再以 exclusive hard-link 让完整 inode 原子出现；JSON 主文件带内部 digest，`.sha256` companion 若在两文件 crash 窗缺失会由已验证主文件重新生成，不静默降级；manifest 记录 table、ordered exact PK list、PK digest、row count、SQL SHA-256、cutoff、predicate version、源库 realpath/dev/inode、schema/trigger hash；
3. 删除前创建 scratch DB，执行当前 `CREATE TABLE` SQL并导入 snapshot，要求 `quick_check='ok'`、count 和 ordered PK digest 一致；
4. apply 验证 script/manifest/snapshot/schema/trigger/DB identity，并只消费 manifest PK；新过窗行绝不加入；
5. 生产恢复不自动执行。QA 在隔离一致副本导入 snapshot，证明可恢复；若生产需恢复，另走 operator 授权。

evidence 内含 workflow payload/operational identifiers，按敏感生产证据处理：不得复制进 PR、founder HTML 或 Discord attachment，只在本机 `0700/0600` 路径由授权 operator/QA 读取。

production CLI 的路径不是通用手术入口：DB realpath 固定为本单两库，evidence 只可落在 canonical `~/.flywheel/maintenance/fly-1998/` 新目录，health 只探 `127.0.0.1` 的 `/health`，log 只认 macOS realpath `/private/tmp/flywheel-bridge.log`。fixture/command seams 只由 exported test API 注入，不能由 production argv/env 绕过。

manifest 本身是候选集合，不只是 digest。crash resume 以 batch receipt 判断：有 receipt 且 PK 消失视为已完成并计入 manifest-total deleted；无 receipt/异常消失 fail-close；仍存在但 CAS predicate 不再成立 fail-close。前次 partial marker 保留为历史证据，最终 complete receipt 反向绑定其 path/hash/committed-batch 数，避免两个状态文件语义冲突。

### 3.1 FLY-1995 exclusion receipt

权威来源固定为 FLY-1995 `cleanup-exclusion-manifest.md` commit `09b64bf7f`，但实际行集必须现场计算：

- mailbox：记录未处置 voice backlog 完整谓词的 ordered `id` digest/count（当前 42），并另记 `type='question' AND resolved_via='fly1995_sessionless_ask'` 的 forensic-window digest/count；不把已漂移的 46/50 日志 census当 PK 集；
- session events：用完整四项 predicate 在 SQLite 内计算 count/min/max/sum/modular fingerprint（当前 2,638,046），避免对 live DB 构造 2.6M-entry TEMP B-TREE；不能只排 `event_type` 或近似时间窗；
- target descriptor 与这两张表整表不相交。mailbox sentinel 采用 transition-aware proof：inventory 两类 row 的 baseline id 在 apply 后必须仍存在于 base table，未处置 voice 与 forensic 两类 union 只能持平或增长，允许 FLY-1995 把同一 id 从前者合法移到后者；`session_events` 精确 cohort membership/digest 仍必须不变。这样证明本单零碰撞，也不因对方正常 guarded UPDATE 重做 20-sample baseline。若 baseline mailbox id 消失或 session-events membership 漂移，则 fail-close。

## 4. 生产只读证据

活库的 main/WAL/SHM 会被其它 writer 和 read-mark 更新，前后 byte hash 不可能归因于本工具。因此生产 inventory 的证据是：

- SQLite 以 `readonly: true, fileMustExist: true` 打开；
- 立即执行 `PRAGMA query_only=ON` 并验证为 1；
- 代码只允许静态 SELECT/PRAGMA allowlist，receipt 记录每个 statement id 与 SQL hash；
- 记录 inventory 前后 `PRAGMA data_version`、目标 count 和 DB file measurements；data_version 变化只标记 concurrent write，不把它归为本工具写入；
- isolated WAL fixture 才断言 main/WAL/SHM bytes/hash invariance。

`.mode insert` export 使用 SQLite CLI 的 `-readonly`，并在 stdin script 中先发 `PRAGMA query_only=ON`，随后按 manifest 排序连续执行分块 SELECT。任何非 SELECT/安全 PRAGMA statement id 都在 inventory 模式拒绝；不用 temp table，避免 query-only 下隐式写临时库。

## 5. apply 事务合同

- batch size 200；`busy_timeout=250ms`。
- 只在 `BEGIN IMMEDIATE` 返回 `SQLITE_BUSY` 时指数退避重试，最多 5 次；事务开始后不重试业务 SQL，直接 rollback/fail-close。
- 每批预算小于其它 consumer 的 5 秒 lock window；超预算回滚并停止。
- `BEGIN IMMEDIATE` 后，对 manifest 中本批精确 PK 重跑 kind/parent-status/parseable-age CAS；集合必须完全相等。
- 同事务核对、暂撤 `workflow_run_event_no_delete` trigger，参数化 DELETE，验证 `changes=batch.length`，按 manifest SQL 原样 CREATE trigger；任一步失败则 row 和 trigger 一起回滚。
- commit 后复核 trigger hash，并追加 fsync-safe receipt。前批已提交、后批失败要报告 partial，不能声称全局回滚。

## 6. 测量与 log rotation

inventory/apply 后均记录两库 main/WAL/SHM bytes、page_count/freelist/page_size、大表 total/candidate/protected counts；`/health` 各 20 次串行 GET，每次 bounded timeout，保留 status/duration/error，汇总 success ratio、p50/p95/max，不保存 response body。

log rotation 不能只查一次 `lsof`：

1. `launchctl print gui/$UID/com.flywheel.bridge` 必须证明 canonical job 不存在（已由有 authority 的窗口 bootout）；工具不执行 bootout；
2. 验证目标为 canonical regular non-symlink path；
3. 从 manifest health URL 解析实际 port，rename 前即时 `lsof` 再查所有代际零 holder；`lsof` 缺失、报错或任何 holder 均 fail-close；
4. mutation 前先落 durable `rotation-started` marker；marker 存在而 final receipt 不存在时禁止再次轮转，要求人工按 inode evidence 恢复；随后 rename 为 `.1`（旧 `.1/.2` 后移），在原路径创建 `0600` 空文件；
5. 验证 rotated inode 等于原 inode、new path inode 不同且 size 0，再复核 rotated inode 无 holder并写 receipt。

本项目 shared log helper 明确不适合 launchd `StandardOutPath` 的长驻 FD；因此采用停机窗 hand-rolled rotation，绝不用 truncate/copytruncate。

canonical deployment 正常必有 KeepAlive launchd job；job absent 不是常态，而是受控 availability window 的结果。窗口 authority（独立 operator/updater，需已有 founder 单次授权；implement/QA runner 无权）先执行 `launchctl bootout gui/$(id -u)/com.flywheel.bridge` 并验证端口释放。若 mutation 后仅 post-check/receipt 写失败，保持 job absent，修复 holder/inconclusive probe 后重跑同一命令：工具只有在 current 为新 0-byte inode、`.1` 精确等于 started marker 的原 inode、全代际零 holder 时才补发 `recoveredFromStartedMarker=true` receipt，绝不再 rename。若 inode 形态不匹配，禁止删 marker/盲重跑；按 marker 中 original + `.1/.2/.3` 的 pre-image 证据升级人工 offline restore。拿到 final receipt 后才运行 `bash scripts/install-bridge-launchd.sh` 恢复 KeepAlive job，再执行 `launchctl kickstart -k gui/$(id -u)/com.flywheel.bridge` 与 bounded `/health` 验证。任一恢复检查失败都升级窗口事故；rotation 工具本身不执行这些 lifecycle 命令。

## 7. 会过期的结论

| 结论（as-of 2026-08-22） | 权威重核 |
|---|---|
| 候选 counts/bytes | 每次 inventory 的 frozen PK manifest |
| trigger/schema/statement allowlist | inventory + apply hash；漂移 fail-close |
| 四类 kind 无 authority reader | code change时 `git log -S` + 全仓 reader audit，不能依赖旧行号 |
| FLY-1995 exclusion | commit `09b64bf7f` 清单完整谓词 + descriptor forbidden-table assertion + before/after sentinel digest |
| `/health` baseline | 当次 20 samples，不复用本文数字 |
| log 可否轮转 | 当刻 launchctl 与 rename 前即时 `lsof` |
