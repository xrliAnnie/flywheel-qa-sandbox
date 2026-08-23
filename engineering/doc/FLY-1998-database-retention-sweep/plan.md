# FLY-1998 数据库保留窗清扫 — 实施计划
Issue: FLY-1998 (https://linear.app/geoforge3d/issue/FLY-1998/数据库清理-全库老旧数据清扫commdbteamleaddb-超龄历史数据按保留窗清一轮founder-直令马上开始1995)
日期: 2026-08-22
基于: research.md

## 0. 交付结论

新增默认只读、manifest-bound 的一次性 operator 工具 `scripts/fly-1998-database-retention-sweep.mjs`。实际 deletion surface 只包括 `teamlead.db.workflow_run_event` 的四类 narrative event。`dead_letter_alerts` 是 live cursor/dedupe ledger，`comm.db` 与两库 session 也只有 authority/provenance reader；本轮全部只盘点/测量，不以 unsafe deletion 换表面覆盖率。

PR 只交脚本、测试、文档，不执行生产 DELETE、log rotate、launchctl mutation 或 restart。独立 QA 才能在批准窗口消费 manifest。

## 1. CLI 合同

```text
node scripts/fly-1998-database-retention-sweep.mjs inventory \
  --teamlead-db ~/.flywheel/teamlead.db \
  --comm-db ~/.flywheel/comm/flywheel/comm.db \
  --evidence-dir ~/.flywheel/maintenance/fly-1998/<run-id> \
  --health-url http://127.0.0.1:9876/health

node scripts/fly-1998-database-retention-sweep.mjs apply \
  --manifest <.../manifest.json>

node scripts/fly-1998-database-retention-sweep.mjs rotate-log \
  --manifest <.../manifest.json> \
  --bridge-log /tmp/flywheel-bridge.log
```

- production CLI 只接受两个 canonical DB realpath（`~/.flywheel/teamlead.db` 与 `~/.flywheel/comm/flywheel/comm.db`）；fixture path 仅通过 exported test API 注入。health URL 只允许无 credentials/query/hash 的 `http://127.0.0.1:<port>/health`；evidence dir 必须是 canonical `~/.flywheel/maintenance/fly-1998/` 下的新子目录；log path 必须是 canonical `/private/tmp/flywheel-bridge.log`。
- 未知/缺失参数、symlink/非 regular file、路径越界、schema/trigger 漂移、snapshot restore 失败、unknown manifest version 均非零退出。
- `inventory` 要求 evidence dir 不存在；以 `0700` 创建并拒绝宽权限 parent。snapshot/manifest/receipt 全部禁止覆盖或跟随 symlink；JSON/sidecar 先写同目录 0600 temp + fsync，再以 exclusive hard-link 让完整 inode 原子出现。JSON 主文件内置 digest 并另写 `.sha256` companion，companion crash 窗由已验证主文件自动补回，不静默跳过。
- `apply` 不接受 DB path/cutoff override；只能读取 manifest 绑定的 realpath/dev/inode、cutoff、exact PK list、script/snapshot/schema/trigger digest。
- `rotate-log` 必须看到 successful/complete apply receipt；由已获 founder 单次授权的独立 window operator/updater 先 bootout canonical Bridge launchd job；rename 前即时 `lsof` 为零。脚本与 implement/QA runner 都不 stop/start 服务。
- stdout 只输出路径、counts、bytes、duration/status；绝不输出 mailbox content、payload、row JSON 或 secret。

## 2. Cohort descriptor

descriptor 是编译期常量，并在 inventory/apply 断言目标表与 FLY-1995/protected forbidden set 无交集。

### 2.1 `teamlead.db.workflow_run_event`

```sql
e.id IN (<manifest batch ids>)
AND e.kind IN (
  'rework_delivery_claimed',
  'rework_delivery_released',
  'workflow_engine_alert_enqueued',
  'workflow_engine_alert_posted'
)
AND julianday(e.at) IS NOT NULL
AND julianday(e.at) < julianday(:cutoff14)
AND EXISTS (
  SELECT 1 FROM workflow_run r
  WHERE r.run_id=e.run_id
    AND r.status IN ('completed','terminated','canceled','cancelled')
)
AND (
  (e.kind IN ('rework_delivery_claimed','rework_delivery_released')
   AND json_valid(e.payload)
   AND json_type(e.payload,'$.requestId')='text'
   AND json_type(e.payload,'$.generation')='integer'
   AND EXISTS (
     SELECT 1 FROM workflow_rework_delivery d
     WHERE d.request_id=json_extract(e.payload,'$.requestId')
       AND d.generation >= CAST(json_extract(e.payload,'$.generation') AS INTEGER)
   ))
  OR
  (e.kind='workflow_engine_alert_enqueued'
   AND substr(e.event_uid,1,length('alert_enqueued:'))='alert_enqueued:'
   AND length(e.event_uid) > length('alert_enqueued:')
   AND EXISTS (
     SELECT 1 FROM workflow_alert_outbox o
     WHERE o.escalation_uid=substr(e.event_uid,length('alert_enqueued:')+1)
       AND o.state IN ('sent','failed')
   ))
  OR
  (e.kind='workflow_engine_alert_posted'
   AND substr(e.event_uid,1,length('alert_posted:'))='alert_posted:'
   AND length(e.event_uid) > length('alert_posted:')
   AND EXISTS (
     SELECT 1 FROM workflow_alert_outbox o
     WHERE o.escalation_uid=substr(e.event_uid,length('alert_posted:')+1)
       AND o.state='sent'
   ))
)
```

cutoff 是 inventory 启动时冻结的 UTC ISO instant；不使用 raw TEXT comparison。active/held/missing parent、recent/unparseable timestamp、缺失/未 settled backing authority、任何 allowlist 外 kind 永不删除。

### 2.2 `teamlead.db.dead_letter_alerts`（protected）

不生成 deletion descriptor。accepted rows 由 `listDeadLetterAlertCursors()` 读取为 per-recipient watermark，删除后 reconcile 会以确定性 event id 重建 `pending` 再 settle 回 accepted；这既不回收稳定空间，还会短暂占住 recipient pending slot。

### 2.3 protected measurements

只读统计、绝不成为 DELETE descriptor：

- `teamlead.db.session_events`（包括 FLY-1995 精确风暴 cohort）；
- `teamlead.db.dead_letter_alerts`；
- 两库 `sessions`；
- `comm.db.mailbox`、`mailbox_log`、`mailbox_identity`；
- workflow/receipt/alert/wake/outbox/turn 的非终态和 authority tables。

descriptor startup assertion：`targets ∩ {'session_events','dead_letter_alerts','sessions','mailbox','mailbox_log','mailbox_identity'} = ∅`。这条机器 gate 不依赖任何单一、可能随处置阶段变化的 marker。

此外按 FLY-1995 `cleanup-exclusion-manifest.md` commit `09b64bf7f` 生成 exclusion receipt：

- mailbox 未处置 voice cohort：`type='question' AND checkpoint IS NULL AND from_agent='voice-honeylemon-fly1911' AND relay_state!='terminal_disposed'`，并 anti-join response；
- mailbox forensic cohort：`type='question' AND resolved_via='fly1995_sessionless_ask'`；
- session-events cohort：完整 `event_type + source + [ts start, ts end)` 谓词，当前 2,638,046 行。

mailbox 记录现场 ordered PK digest/count，不硬编码过期的 46-qid census；manifest 两类 baseline id 在 apply 后仍须存在于 base table，两类 current union count 不得缩小，允许同一 id 由未处置 voice cohort 移入 forensic cohort。`session_events` 用同一完整谓词的 count/min/max/sum/modular fingerprint 证明 cohort 不变，避免 2.6M-row `ORDER BY id` TEMP B-TREE。由于本单目标与两张基表整表不相交，这既容忍 FLY-1995 合法 guarded UPDATE，也是零 DELETE 撞车的可核证 sentinel。

## 3. Frozen manifest 与 snapshot

manifest schema v1 至少包含：

- issue/script version + script SHA-256；
- inventory start/end UTC、cutoff14；
- system sqlite3 与 better-sqlite3 engine version（均须 ≥3.42.0），以及两边 `julianday(cutoff14) IS NOT NULL` preflight；
- DB realpath/dev/inode、schema SQL hash、target trigger name/SQL/hash；
- 每个 target 的 ordered exact PK array、PK digest、candidate/protected count；
- FLY-1995 authority manifest commit/path、三项完整 exclusion predicate 的 before ordered PK digest/count；
- 每个非零 target 的 `.mode insert` path、0600 mode、row count、SHA-256、scratch restore result；
- production readonly statement receipt（statement id + SQL hash）、`query_only=1`；before/after `data_version` 只命名为 concurrent-writer observation，不冒充本连接只读证明；
- 两库/大表/log `/health` before measurements。

snapshot export 用 manifest-sorted exact PK 的 200-row 分块 SELECT 驱动（不是重新扫描“当前候选”，也不在 query-only DB 建 temp table）；numeric/text PK 经过严格类型与 SQL-literal round-trip 测试。apply 同样只使用 manifest PK。新过窗行永不加入。crash resume 要求 batch receipt 与 PK absence 一致；已 receipt 的 batch 仍计入 manifest-total deleted；无 receipt 的 missing PK 或存在但 CAS 漂移都 fail-close。最终 complete receipt 以 path/hash/committed-batch 数显式 supersede 历史 partial marker。

snapshot/manifest 是敏感生产 evidence，可能含 workflow payload 与内部 identifier；只保存在 canonical `0700/0600` 本机目录，不得复制进 PR、founder HTML 或 Discord attachment。

## 4. TDD 实现顺序

1. **RED — read-only/manifest**：WAL fixture 覆盖 readonly/query_only statement receipt、mixed timestamp、exact PK freeze、未知 kind与 FLY-1995 forbidden table；生产 proof 不断言 byte invariance，isolated fixture 才断言 main/WAL/SHM hash 不变。
2. **GREEN — inventory**：strict args/path/schema checks、两库 measurements、20 bounded health samples、`.mode insert` + scratch restore、manifest/hash/0600 evidence。
3. **RED/GREEN — apply**：manifest validation、200-row stable batches、full CAS、trigger-in-transaction、250ms busy timeout + BEGIN-only 5 retries、<5s transaction budget、fsync-safe receipt。
4. **RED/GREEN — rotation**：launchd-job-present/open-FD refusal、rename 前 holder race、safe 3-generation rename、inode/new-file/post-holder verification。
5. **REFACTOR**：descriptor 数据化但不做通用 retention framework；SQL identifier 只来自 compile-time allowlist。driver-executed values 全部 bind 参数化；SQLite CLI snapshot 的 PK literal 由唯一 encoder 生成并做 text-PK injection/round-trip 测试。

测试文件为 `packages/teamlead/src/__tests__/fly-1998-database-retention-sweep.test.ts`；process-level fake health server 使用异步 child，避免 `spawnSync` 阻塞同进程 server。

## 5. 测试矩阵

| 面 | 必测 |
|---|---|
| inventory | readonly + query_only statement receipt；fixture byte/hash invariant；production-style concurrent `data_version` 变化不误报写入 |
| timestamp | SQLite 与 ISO 两种合法格式均按 `julianday`；invalid/NULL 保留 |
| SQLite floor | system CLI 与 driver engine 均拒绝 `<3.42.0`；cutoff 在任一 engine 不可解析都 fail-close，不得报告“零候选” |
| manifest | evidence dir/file symlink与复用拒绝；exclusive-create+0600+fsync；exact PK array+digest；inventory 后新过窗行不删；tamper/script/schema/DB identity不符拒绝 |
| snapshot | 每个非零 target `.mode insert` 0600；chunked exact-PK export与恶意 text PK转义；scratch quick_check/count/PK digest；tamper 拒绝 apply |
| narrative events | 四类 old+terminal+backed 删除；active/held/recent/unparseable/authority缺失保留；generic audit可再生但 side-effect state不变 |
| authority fences | termination、credential rotation、ship-ready、stalled alert、gate/loop/edge/runner及未知 kind 全保留 |
| dead letters | accepted/pending/recent/unparseable 全保留；cursor/dedupe reader 仍可正常重建 intent |
| FLY-1995 | authority manifest三项完整谓词；descriptor forbidden-table gate；`session_events` 和 live `mailbox` sentinel digest零变化 |
| mailbox identity | archived identity + snapshot fixture仍可 `inspectDeliveryState`；所有 mailbox lineage 表零删除 |
| sessions | 两库 old terminal rows 仅计数且仍存在，证明本轮不裸删 authority |
| CAS race | manifest 后 parent 变 active/held或 row 变 kind/time；batch rollback，行和 trigger 同在 |
| batch/lock | >200 行多批；只在 BEGIN busy 重试≤5；事务内 busy/timeout直接 rollback；partial receipt真实且成功 resume 被 final receipt supersede；deleted 为 manifest total |
| health | before/after各20，body不保存；timeout/http error保留且汇总不伪 PASS |
| log | launchd present拒绝；manifest port/open FD/pre-rename race拒绝；mutation 前 durable started marker；partial 后 rerun拒绝；safe rotation后 old/new inode、0600、generation正确 |

## 6. apply 与恢复合同

每批：

1. 从 frozen manifest 取下 200 个 PK；
2. `busy_timeout=250`，`BEGIN IMMEDIATE` 仅 busy 时最多 5 次 bounded backoff；
3. 事务内对精确 PK 重跑完整 CAS，集合必须完全相等；
4. 核对并暂撤 `workflow_run_event_no_delete`；参数化 DELETE，验证 `changes=batch.length`；按 frozen SQL 原样恢复 trigger；
5. 任一步异常或事务预算达到 5 秒前无法完成则 rollback；事务内不自动重试；
6. commit 后核对 trigger hash、目标 PK absence、protected sentinel，写 batch receipt；
7. 前批已 commit、后批失败则 stop + `partial`，不声称全局回滚。每批都可从同表 snapshot 在隔离副本恢复。

snapshot 先在 scratch DB 自动 restore。独立 QA 再在生产一致副本演练 restore；脚本绝不自动覆盖 production。

## 7. measurement 与 log rotation

inventory/apply 后都记录：两库 main/WAL/SHM bytes、page_count/freelist/page_size；大表 total/candidate/protected；20 次串行 bounded `/health` 的 status/duration/error、success ratio、p50/p95/max。无 `VACUUM`；报告直接说明 file bytes 可能不变，也不从 20 点样本推断唯一因果。

`rotate-log` 顺序：验证 complete apply receipt → window authority 已执行 `launchctl bootout gui/$(id -u)/com.flywheel.bridge`，且 `launchctl print` 证明 job absent、manifest health URL 的实际端口已释放 → canonical regular non-symlink path → rename 前即时 `lsof` 零 holder → durable `rotation-started` marker（original + generations pre-image）→ `.2→.3/.1→.2/current→.1` → 原路径创建 0600 空文件 → 验证 `.1` inode等于原 inode、新 inode不同且 size=0 → rotated inode 再查无 holder → receipt。started marker 存在但 final receipt 不存在时，rerun 先保持 job absent/port free：若 current 为新 0-byte inode、`.1` 精确匹配原 inode且全代际零 holder，只补发 `recoveredFromStartedMarker=true` receipt，绝不再 rename；其它形态 fail-close，由 window authority 按 marker pre-image 做人工 offline restore，禁止删 marker/盲重跑。工具不 copytruncate，不执行 bootout/restart。

rotation receipt 后，**同一 window authority** 必须在离开窗口前运行 `bash scripts/install-bridge-launchd.sh` 恢复 KeepAlive job，再运行 `launchctl kickstart -k gui/$(id -u)/com.flywheel.bridge`，最后执行 bounded `/health` 并验证 `launchctl print` 为 loaded + KeepAlive。implement/QA runner 不执行这些 lifecycle 命令；缺恢复 receipt 时整个 log step 不得标 complete。

## 8. 独立 QA 与验收映射

| 验收硬项 | implement 证据 | 独立 QA 证据 |
|---|---|---|
| 每表删前 `.mode insert` | snapshot path/count/hash/restore_verified | 隔离一致副本再次导入与 PK digest |
| 只动超龄终态 | positive kind allowlist + julianday + frozen cutoff + parent CAS | active/held/recent/invalid/fence sentinels全在 |
| CAS/分批/回滚 | batch receipt、changes exact、trigger同事务、failure injection | race/partial/recovery复演 |
| 两库前后大小/大表/health20 | before/after measurement + raw samples | 核对样本数、失败不隐藏、结论不夸因果 |
| FLY-1995 零撞车 | commit `09b64bf7f` 完整谓词 receipt + forbidden-table machine gate | voice/forensic/session-events 三项 digest unchanged |
| comm.db 安全 | protected measurements，零 DELETE descriptor | mailbox identity settlement检查通过 |
| log 一次轮转 | fail-close rotation command与receipt；明确 window authority | founder-authorized bootout receipt + holder/inode/new path + install/kickstart/KeepAlive/health restore receipt |
| FLY-1986 排序 | handoff 明示 cleanup/QA在先 | apply+verification完成后才放行压测 |

## 9. Full-repo verification 与交付

实现后执行 owning test、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。随后按 Codex author 协议发起 code review，修到 `reviewVerdict=APPROVED`；开 PR 后以 `complete --route needs_review --pr <N>` 交接。implement node 不请求 ship approval，不 merge，不部署，不投 restart ticket。

## 10. 会过期的依赖

| 计划依赖（as-of 2026-08-22） | apply 前重核 |
|---|---|
| schema/trigger/statement allowlist | inventory + apply hash；漂移 fail-close |
| FLY-1995 表边界 | target/forbidden intersection machine gate + live worktree |
| reader audit对四类 kind 的结论 | code head变化即用 `git log -S` + 全仓 use-site重审 |
| retention cutoff/candidate | 新 inventory 生成，不手改 manifest |
| health URL、launchd job、log holder | inventory/apply/rotate 当刻现场探针 |
| compact 顺序 | FLY-1995 完成后另评估，不从本计划继承 |
