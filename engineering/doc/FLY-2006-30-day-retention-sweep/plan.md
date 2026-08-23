# FLY-2006 14 天全表保留窗清扫 — 实施计划
Issue: FLY-2006 (https://linear.app/geoforge3d/issue/FLY-2006/数据库清理二期-30-天保留窗全表清扫1995-结案解除保护按-1998-纪律清-session-events-等大头)
日期: 2026-08-23
基于: research.md

> 文件夹 slug 与 Linear URL 保留 issue 最初的 “30-day” 历史命名；本计划唯一有效窗口是 14 天。
> 本 generalized implement node 不 dispatch successor/review node。Founder 已于 2026-08-23 通过 Discord
> 原始消息「删」放行 14 天窗外约 289 万行；Lead 裁定当前 HEAD 先过 code review，再以过审 engine
> 重做 inventory：同表族且相对已批 2,893,062 行偏差不超过 ±1% 时可直接 apply，超出则重呈。
> VACUUM 仍须 Lead 为逐库、逐 manifest、逐 rehearsal budget 生成一次性 quiescence ack。Tadashi
> 披露的更早外部 VACUUM 历史另见 research §5.5，不属于本单 evidence。

**目标：** 把 FLY-1998 单 target 工具升级为严格 14 天、两库、全 schema/consumer 分类、
active-lineage fail-closed 的多 target retention sweep，并承载一个 Lead 裁定的 exact HL orphan age
exception；生成 restore-verified 的真实 production inventory，并在精确授权边界内 apply/VACUUM。

**架构：** 保留 `scripts/fly-1998-database-retention-sweep.mjs` 作为唯一 CLI/evidence engine；新增
无 I/O registry 和 consumer gate。小 cohort 使用 exact keys；`session_events` 等大 cohort 使用有界
PK-range + streaming CAS digest shard。每 target 的备份是 transaction-built SQLite snapshot DB。
`mailbox` 只能走 transaction-equivalent `archiveMailboxFamily` 四步事务；ordinary family 显式
`retentionMs=RETENTION_MS`，HL exact exception 显式 `retentionMs=0`；`vacuum` 只消费操作员一次性
quiescence ack。

## 0. 文件职责与兼容边界

| 文件 | 动作 | 职责 |
|---|---|---|
| `scripts/fly-1998-database-retention-sweep.mjs` | 修改 | v1 closed-evidence reader、v2 CLI、inventory/snapshot/apply/vacuum |
| `scripts/lib/fly-2006-retention-registry.mjs` | 新建 | 182 table classification、value policy、cohort mode/delete order |
| `scripts/fly-2006-retention-consumer-gate.mjs` | 新建 | delete-target runtime reader/anti-join coverage gate |
| `scripts/fly-2006-retention-consumer-gate.config.json` | 新建 | 每个 consumer 的 table/value/disposition allowlist |
| `scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs` | 新建 | 新/漏 consumer fail-closed tests |
| `.github/workflows/ci.yml` | 修改 | hand-enumerate consumer gate test 与 production-source scan |
| `scripts/__tests__/ci-structure.test.sh` | 修改 | pin 新 CI steps，防止 gate 静默掉线 |
| `packages/teamlead/src/__tests__/fly-1998-database-retention-sweep.test.ts` | 保留/修改 | v1 closed evidence 与一期 predicate regression |
| `packages/teamlead/src/__tests__/fly-2006-database-retention-sweep.test.ts` | 新建 | v2 多表、两库、shard、archive、resume、vacuum fixture |
| `packages/flywheel-comm/src/__tests__/fly-2006-mailbox-archive-parity.test.ts` | 新建 | sweep replica 与 runtime archiveFamily parity |
| `scripts/fly1645-receipt-residue-gate.config.json` | 修改 | 登记新 registry/CLI 的 relay-state audit surface |
| `engineering/doc/FLY-2006-30-day-retention-sweep/*` | 更新 | 设计、证据摘要与 durable progress |
| `CLAUDE.md` | PR 最后 commit 修改 | FLY-2006 milestone、本 runner 边界与外部 VACUUM 披露 |

legacy v1 identity 固定为 `issue=FLY-1998`、`schemaVersion=1`、script SHA-256
`163996daa030d636bf7de8064693ea3990d124414731add8d84f94564a7d4c8c`。新 CLI 只允许验证/读取已有
complete v1 evidence，不继续未完成 v1 apply。v2 使用 `issue=FLY-2006`、`schemaVersion=2` 与
`~/.flywheel/maintenance/fly-2006/<run-id>`；两个 evidence roots 互不迁移、不重写。

## 1. Task 1 — RED/GREEN：reader 与 anti-join consumer gate

**Files:** 新建 consumer gate/config/test；读取 production runtime source，不改 reader behavior。

1. RED：fixture source 新增 `NOT EXISTS (... FROM session_events ...)`，但 config 未登记，gate 必须报
   `unclassified_retention_consumer`；普通 schema DDL/test 文件不算 production reader。
2. RED：当前三条负向 authority 必须映射为 protect：
   `lead_events.session_zombie_detected`、`session_events.founder_thread_notified`、
   `session_events.post_ship_finalization_completed`/attributed execution fallback。
3. RED：扫描 `mailbox_log` readers，`archived` 必须永久保护；`processed|disposed|migration_snapshot`
   只有 matching live mailbox 不存在、row_json 非 authority 才可进入 candidate。
4. RED：未登记 reader 只通过 `mailbox_message_projection` view 读取/anti-join mailbox 时仍必须失败。
   gate 解析受控 schema DDL 的 view→base-table lineage；CTE 继续解析其 body 中的 base relation，不能
   用 alias/view 名逃过 classification。
5. 实现 gate：production reader 中每个 delete-target 或其 view lineage SQL reference 必须命中 exact
   `file + relation + baseTable + usage + disposition`；新 file/usage/view 或 stale config entry 都失败。
6. 把 audit 结果写入 config，不用通配 pattern 覆盖未来 consumer。运行测试和实际 gate，GREEN 后
   commit：`test(FLY-2006): classify retention consumers`。

## 2. Task 2 — RED/GREEN：registry、14 天边界、全 schema classification

**Files:** registry、FLY-2006 test、FLY-1645 config。

1. RED：research §4.4 的 TeamLead `18+36+103=157`、CommDB `7+18=25` exact names 恰好覆盖；
   future/missing/overlap table 全部抛稳定错误。
2. RED：所有 protected-authority names 不与 target 相交；`runner_declared_states` 与
   `mailbox_identity` 是 protected-current；unknown enum 返回 `oldProtectedUnknown`。
3. RED：ISO/SQLite text、epoch seconds/ms、invalid、NULL、恰等 cutoff、cutoff 前 1ms；只有最后一项
   old，manifest 字段必须为 `cutoff14`。
4. RED：`mailbox.kind IS NULL AND mailbox.type='question'` 必须保护；message class 使用 `type`，只有
   report 使用 `kind='report'`。覆盖 production 当前完整 type vocabulary。
5. RED：只有 `from_agent='voice-honeylemon-fly1911' AND relay_state='terminal_disposed'` 两字段同时
   exact-match 才返回 `leadExactExceptionCandidate`，不检查 age；相同 sender/open、其他 sender/
   terminal_disposed、prefix/LIKE 相似值全部保护。registry 不暴露通用 ignore-age 配置。
6. 实现 immutable registry/纯函数，`RETENTION_MS=14*24*60*60*1000`；在 FLY-1645 allowlist 登记
   新文件。运行 focused tests 与 `node scripts/fly1645-receipt-residue-gate.mjs --main-only`。
7. GREEN 后 commit：`feat(FLY-2006): define safe retention registry`。

## 3. Task 3 — RED/GREEN：active snapshot 与有界 cohort representation

**Files:** registry、main script、FLY-2006 test。

1. RED：old running session、active/held run、run 中 done execution、running CommDB session 与同 issue
   rows 均进入 activeProtected；payload exact match 使用 `json_tree`，非 JSON/无法关联则保护。
2. RED：candidate `<=20,000` 产生 `exact-keys`；超过 ceiling 且 monotonic integer PK 产生
   `range-digest`，每 shard `rowCount<=50,000`，manifest 不出现完整 PK array。
3. RED：shard 内 frozen row missing/replaced、active set growth、CAS field drift 都改变 count/digest并
   fail closed；inventory 后新进入 cutoff 的 candidate 不属于 sealed frozen keys、留给下一轮，且
   protected/recent row 变化不被 DELETE。
4. 实现 active snapshot ordered count/digest；每 target 五段 partition 总和相等。
5. 实现 streaming canonical SHA-256 shard；as-of 现盘 2,779,792 个 old session_events 的 receipt files ceiling
   `<=120`。fixture 断言 manifest/evidence file count bound。
6. GREEN + node check + Biome 后 commit：`feat(FLY-2006): freeze bounded active-aware cohorts`。

## 4. Task 4 — RED/GREEN：SQLite snapshot DB 与 legacy evidence reader

**Files:** main script、v1/v2 tests。

1. RED：高基数 fixture 禁止 `.mode insert` 文本；每 target 产生独立 0600 SQLite snapshot DB，source
   row stream 在 destination 单事务写入。
2. RED：backup API restore 到 scratch 后，DDL、quick_check、count、canonical digest 全等；tamper/
   symlink/permission/schema drift 拒绝；apply 不做第二次逐行 restore。
3. RED：真实已发布 v1 manifest/complete receipt fixture 使用固定 legacy script digest可读取；v1 partial
   apply 拒绝继续；v2 只接受新 issue/root/version/current script digest。
4. RED：即使 v2 已归档 v1 `fly1995.mailbox.baselineIds`，closed v1 evidence 仍仅凭自身 seal、fixed
   legacy digest 与 complete receipt 验证通过；reader 不对变化后的 live DB 重跑 baseline assertion。
5. 实现 v1/v2 discriminated reader、snapshot builder/restore verifier；零候选不建假 snapshot。
6. GREEN 后 commit：`feat(FLY-2006): snapshot cohorts with bounded SQLite evidence`。

## 5. Task 5 — RED/GREEN：逐 target policy 与 mailbox family archive

**Files:** registry、main script、FLY-2006 test、consumer config。

1. RED fixture 包含 FLY-1995 skipped row、HIGH finding 三条 anti-join哨兵、settled/unsettled lead event、
   FLY-1998 narrative/authority run event、terminal protocol/human-decision mailbox、old log/outbox/wake。
2. RED：FLY-1995 exact cohort 走普通 `session_events` allowlist；不允许 issue/cohort exception。
3. RED：mailbox family 任一 member recent/leased/open/authority 则整 family 保留；eligible family apply
   必须通过 sweep 内 transaction-equivalent `archiveMailboxFamily`：写 archived snapshot → GC intent
   （如需）→ identity NULL→time CAS → 删除 mailbox。ordinary 传 `retentionMs=RETENTION_MS`；recent HL
   exact exception 传 `retentionMs=0` 并实际返回 archived，不得落到 default 72h `not_due`。重投同
   deterministic delivery id 返回 archived/idempotent，不抛 missing row。
4. RED：HL exception fixture 含当前形状的 recent `question/report` 单成员 family，inventory/dry-run/
   snapshot/restore/apply receipt 均计入；三个 near-miss 与 identity/family drift 全部拒绝。candidate count
   来自实时 exact predicate，不把当前 census 42 硬编码成 production assertion。
5. RED：同一 content-ref family fixture 分别调用 sweep replica 与 runtime `archiveFamily`；比较
   deterministic archived event/subject、GC intent、canonical row_json、identity CAS 与最终 live 状态，
   防任一实现漂移。
6. RED：`mailbox_log.event='archived'` 永久保护；其他 log 只有无 live mailbox、非 authority、consumer
   gate允许才删。
7. 只允许逐名 bypass `workflow_run_event_no_delete` 和 `mailbox_log_no_delete`；测试冻结原 trigger SQL，
   每事务恢复。其他 no-delete trigger 一律拒绝。
8. GREEN 后 commit：`feat(FLY-2006): inventory safe history across both databases`。

## 6. Task 6 — RED/GREEN：两库 apply、resume、integrity

**Files:** main script、registry、FLY-2006 test。

1. RED：teamlead shard 已 commit、comm 后 shard injection failure 写 partial；resume 要求 receipt/cohort
   state一致。receipt 有而 rows 仍在、无 receipt 而 cohort 缺失、CAS drift 都拒绝。
2. RED：fixture 预置无关 FK orphan；apply 后 canonical fingerprint 不变通过，新增/删除/漂移失败。
3. 实现单库单 shard transaction + commit 后 sealed receipt；small exact-key batch `<=200`，range shard
   `<=50,000`。receipt 只写 shard bounds/count/digest，不写 50k keys。
4. complete receipt 要求逐 target candidate=deleted、recent/protected sentinels 仍在、trigger/schema/FK
   不漂移、两库 quick/integrity 唯一 `ok`，并绑定 Founder gate audit。
5. focused suite 连跑两次验证 idempotent resume，GREEN 后 commit：
   `feat(FLY-2006): apply sealed cohorts across both databases`。

### 6.1 Founder Discord 授权审计契约（2026-08-23 追加）

Founder 本次放行载体是 Discord 原始消息，不是 CommDB gate response；不得把 Discord
`message_id` 冒充 `questionId`。`founderGateAudit` 采用唯一受支持的诚实来源
`source='discord-message'`，并强制封存 `channelId`、`messageId`、`authorId`、`respondedAt` 与
`responseDigest`。CLI 使用逐字段显式参数；缺字段、未知 source、非 snowflake id、非法时间或非
SHA-256 digest 一律在任何 DB 写入前拒绝。apply receipt 原样写入该结构，resume 必须逐字段一致。
该 receipt 只证明 operator 提供的 provenance 被完整封存并在 resume 时未漂移；engine 不访问 Discord，
因此不把它宣称为 cryptographic/independent proof。真实授权由 Discord 原消息坐标与 Lead relay 链外部
复核。

RED 先证明旧 `questionId` shape 无法承载并会拒绝真实 Discord audit，同时覆盖 tamper/缺字段；GREEN
只扩展 audit parser/validator/receipt binding，不泛化未出现的第二种 source。当前真实凭据由 Lead
转达并可回查：channel `1541073702186258442`、message `1541125058393804890`、author
`1138241636057481306`、timestamp `2026-08-23T16:40:46.640Z`、原文单字「删」的 UTF-8 SHA-256
`8d3ba65b9421278e2b38e296d2b5d936be4bad3583e6729f03516c68935aa367`；relay mailbox id
`0f15a64a-1ac7-4993-9026-01cd917265f2` 只作为转达链，不替代 Founder 原始消息身份。

## 7. Task 7 — RED/GREEN：quiescence-bound vacuum

**Files:** main script、FLY-2006 test。

1. RED：缺 complete apply、缺/重复使用/空的 `--quiescence-ack`、writer lock、空间 `<2*db+1GiB`、
   schema/FK drift、SQLITE_BUSY、矛盾 started marker 均拒绝。
2. RED：大 payload fixture 中 `vacuum --database teamlead|comm` 实际缩小 main file；started/complete
   receipt 记录 before/after bytes、page/freelist、identity、duration、integrity/FK。
3. 实现一次一库的 vacuum。工具验证操作员 ack 存在性/一次性使用，receipt 只写 token digest；不把
   它称为 cryptographic proof，不 stop/start/restart。`--max-duration-ms` 是 operator 必填输入，绑定
   ack 与 sealed Task 8 rehearsal summary digest；工具要求它不小于 summary 实测 duration。Task 7
   fixtures 只测试 binding，不冻结 placeholder 数字。记录 main/WAL before/after bytes；超预算写
   degraded outcome。
4. Lead 问题 `086fc0a6-ad23-49fd-acca-5cf801bc26a1` 已确认当前没有正式 proof surface。其披露的
   production online VACUUM 是无 FLY-2006 receipt 的外部历史操作，不计入本 runner evidence。
5. GREEN 后 commit：`feat(FLY-2006): compact only under acknowledged quiescence`。

## 8. Task 8 — 隔离 rehearsal 与真实 production inventory

1. 用 SQLite backup API 生成两库一致副本，不能裸 `cp` 活 WAL；校验 source/backup quick_check/count。
2. 副本完整执行 inventory → restore snapshots → apply(fake gate audit) → integrity/FK → vacuum。逐 target
   dry-run count=deleted count；recent/active/authority/anti-join rows仍在；文件缩小；规模/receipt ceiling
   通过。把 post-delete per-DB vacuum duration 写入 rehearsal summary，作为未来 operator ack budget 的
   唯一工程输入。
3. 代码审查通过前，真实 production 只运行 v2 inventory：

```bash
node scripts/fly-1998-database-retention-sweep.mjs inventory \
  --teamlead-db /Users/xiaorongli/.flywheel/teamlead.db \
  --comm-db /Users/xiaorongli/.flywheel/comm/flywheel/comm.db \
  --evidence-dir /Users/xiaorongli/.flywheel/maintenance/fly-2006/<UTC-run-id> \
  --health-url http://127.0.0.1:9876/health
```

4. 验证非零 target restoreVerified、182 classification、consumer gate、quick_check、file count bound；
   向 Tadashi report exact counts/bytes/digest，并明确当时尚未 production cleanup mutation，同时单列
   research §5.5 的外部 operator VACUUM。

## 9. Task 9 — 全仓 gate、Codex review 与 PR

1. 修改 `.github/workflows/ci.yml`，像 FLY-1645 precedent 一样 hand-enumerate：
   `node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs` 与实际 consumer gate invocation；
   同步更新 `ci-structure.test.sh` pin。先本地运行这两步、consumer gate、FLY-1645 main-only gate，再跑：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

2. 检查 `git diff --check`、evidence 未入 git、无 secret/payload/local snapshot 泄漏，更新 progress。
3. `stage set code_review`；按 Codex author 协议注册 `review_code` gate/request，CHANGES 修复后开新 gate，
   直到 APPROVED；advisory 用 report channel 转发。
4. code review APPROVED 后以完全相同 engine 重新 production inventory。若 table family 不变且总量相对
   Founder 已批 2,893,062 行偏差 `<=1%`，用 §6.1 的真实 Discord audit 对该 sealed manifest apply；否则
   重新呈 Founder。apply 必须 target candidate=deleted 逐字相等、两库 integrity ok、receipt complete。
5. 向 Lead 请求逐库 quiescence ack，ack 必须绑定 manifest/rehearsal/max-duration；分别 VACUUM 并封存
   before/after bytes、duration 与 integrity receipt。不得自行生成 token，不 stop/start/restart 服务。
6. push branch，开 base `main` PR；描述 exact gates、production inventory/apply/vacuum digest/count/bytes；
   同时披露 research §5.5 的更早外部 operator VACUUM，不把它混入本单 evidence。独立 QA 后续复核 receipt。
7. doc-flow 不建 status/archive 子目录；PR 最后 commit 更新 `CLAUDE.md` milestone 与最终 handoff。
8. `node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>`。不请求 ship approval、
   不 merge、不投 restart ticket；本单生产 mutation 仅限 Founder/Lead 已明确放行且封存 receipt 的
   retention apply 与逐库 acknowledged VACUUM。

## 10. 需求到证据映射

| 需求 | 证据 |
|---|---|
| 14 天窗内全保留 | cutoff/invalid boundary tests + five-way partition |
| HL 42 条 age exception 且不扩面 | exact two-field fixture + three near-miss guards + archive snapshot/receipt |
| active/在飞保护 | cross-DB active digest + old-active fixtures + apply CAS |
| 审批/凭证/裁定排除 | exact protected table/type/value registry |
| anti-join/idempotency 不翻转 | consumer gate + 三条 R1 regression + unknown consumer failure |
| 全表盘点 | research exact `157+25` names + schema set equality |
| as-of 2,779,792 个 old session_events 可扩展 | range-digest ceiling + `<=120` receipt files + isolated benchmark |
| 逐表快照可恢复 | transaction-built SQLite snapshot + backup restore proof |
| mailbox invariant | archiveFamily 四步事务 + deterministic replay regression |
| dry-run 与实删一致/幂等 | shard counts/digests = receipts；partial/resume/CAS tests |
| 两库 integrity/物理缩小 | unchanged FK fingerprint + integrity + vacuum receipts |
| Founder 才真删 | Discord 原始授权 + <=1%/同表族 Lead 裁定 + sealed manifest + provenance receipt |
| Founder 授权来源不造假 | Discord source 判别字段 + CLI/parser/tamper/resume tests；记录 provenance，不宣称独立证明 |

## 11. Production 执行与 handoff（2026-08-23）

- exact-head code review R4 APPROVED 后，isolated rehearsal 以 2,892,153/2,892,153 行、16 个非零
  restore-verified target、两库 integrity `ok` 通过；summary SHA-256 为
  `7d20b68d903694a725f20cadbcf89521bda26dfc107114fde6403387018d1a8f`。
- production manifest SHA-256
  `5742fe9a5439b0e6f069eca83ec8bcba7744cf1a5aecc48e24bec08dc1b5eeb2` 封存
  2,892,154 candidates；相对 Founder 已批数少 908 行（−0.0314%）、table family 不变。apply receipt
  SHA-256 `37d4c503e1164bf94c66e1a7293b4f00416145d932408380662d43d0fd9c86cb` 证明
  2,892,154/2,892,154 逐表一致、两库 integrity `ok`，同参 replay 幂等。
- teamlead VACUUM 已完成：main 1,707,659,264→277,483,520 bytes，WAL 305,522,752→4,152 bytes，
  1,358ms，integrity `ok`；receipt SHA-256
  `9d4785477b60b03b080539c91650bef8b66401c4c942c6a94a131de68cf8bd06`。
- 12:00 PT updater 并未形成 fleet-wide 零 holder 窗（1 秒观测最低 5），故 comm VACUUM fail-closed
  改期。Lead 允许的独立 checkpoint 已首试 34ms 回收 WAL 510,908,872→0 bytes，receipt SHA-256
  `11f4f4382329a0fc0984eba8c954556829639406501a5fc9cb22b2043f8898ad`；comm main file 仍为
  509,288,448 bytes，后验 quick/integrity `ok`、Bridge healthy。
- `pending-op`：comm VACUUM ack 仍未消费且无 started marker。Lead 将向 Founder 另提约 2 分钟舰队全停
  维护窗，打包 bootout、bridge log rotation 与 comm VACUUM；本 PR/runner 不 kill/restart、不请求 ship、
  不把 checkpoint 冒充 VACUUM。独立 QA 复核 receipts 后再由维护窗执行者消费一次性 ack。
