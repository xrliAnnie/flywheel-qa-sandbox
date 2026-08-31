# FLY-2136 mailbox 死信扫描热循环 — 实施计划

Issue: FLY-2136 (https://linear.app/geoforge3d/issue/FLY-2136/urgentbridge-稳定-mailbox-死信扫描热循环饿死事件循环每-tick-全表重扫-66-万终态行事务内)
日期: 2026-08-28
基于: research.md

**Status**: draft
**分支**: `flywheel-FLY-2136`(现 worktree),PR base = `main`

## 0. 摘要

四刀最小手术,拆掉「终态行累积 × 无索引扫描」这条自杀引信:

| # | 刀 | 层 | 语义变化 | 实测/预期收益 |
|---|---|---|---|---|
| 1 | 两个 partial index | 物理 | 零 | 66K 行 tick 2412ms → 7.5ms(323×,设计期实测) |
| 2 | 死信扫描节流 30s | 节奏 | 首次通知最坏 `ceil(收件人数/100)×30s`(≤100 收件人时即 30s) | 伤害频率 1/30(防复发纵深) |
| 3 | Bridge 内周期归档 + 候选窗 ring cursor | 容量 | 零(归档判定/事务不变,只改候选枚举顺序与调度) | 终态行常驻趋于 ~72h 流量;钉住的 not_due family 不再遮挡后排(前进保证) |
| 4 | gate-marker 两层缓存(目录门 + per-file stat) | 物理 | 零 | 每次 250MB 同步读 → 目录未变时 1 次 stat(实测验收) |

死信**判定/投递语义一律不动**(FLY-2123 边界)。

## 1. 改动清单(file-by-file)

### 刀 1 — 索引

**`packages/flywheel-comm/src/mailbox-schema.ts`**(`MAILBOX_CORE_SCHEMA`,`mailbox_archive_dead` 之后追加):

```sql
CREATE INDEX IF NOT EXISTS mailbox_dead_scan
  ON mailbox(recipient_kind, to_agent, seq)
  WHERE state = 'DEAD' AND carrier = 'inbox';
CREATE INDEX IF NOT EXISTS mailbox_dead_notice_lookup
  ON mailbox(source_ref, seq)
  WHERE type = 'dead_letter_notice' AND source_kind = 'dead_letter';
```

**`packages/flywheel-comm/src/mailbox-queue.ts`** `ensureMailboxQueueSchema()`:在既有 `mailbox_lease_expiry` 的 `CREATE INDEX IF NOT EXISTS`(:333)后,以同样方式补这两条 —— 存量库(所有连接路径:MailboxQueue 自有/包装连接、CommDB db.ts:1057)一次覆盖。

**不改**任何查询文本、控制流、函数签名(含 capabilities 测试 :1449 的源码结构字面断言依赖)。

### 刀 2 — 节流

**`packages/teamlead/src/bridge/mailbox-queue-config.ts`**:`MailboxQueueConfig` 增 `deadLetterScanIntervalMs`;`resolveMailboxQueueConfig` 增 `boundedInteger(env, "FLYWHEEL_MAILBOX_DEADSCAN_INTERVAL_MS", 30_000, 1_000, 3_600_000, warn)`;`DEFAULT_MAILBOX_QUEUE_CONFIG` 增默认 30_000。

**`packages/teamlead/src/bridge/runner-mailbox-lane.ts`**:`RunnerMailboxLane` 增私有 `lastDeadScanAtMs = 0`;tick 内 `scanAndInsertDeadLetterNotices` 调用包进 `if (now - lastDeadScanAtMs >= queueConfig.deadLetterScanIntervalMs)`,执行后回写时间戳(用已注入的 `this.now()`,可测)。`reconcileExpiredLeases`、claim/deliver 循环**保持每 tick**。

**`packages/teamlead/src/bridge/lead-inbox-runtime.ts`**:per-project `lastDeadAlertReconcileAtMs`(Map),同 knob 同节奏包 `reconcileDeadLetterAlertIntents`;`drainDeadLetterAlerts` **保持每 tick**(零投递延迟变化)。

**最坏发现延迟的诚实语义**(R1 #3):两套扫描各有 100 recipients/次的页宽 + ring cursor 轮转,distinct DEAD recipients > 100 时,第 N 页要等第 N 个 interval ⇒ 最坏首次发现延迟 = `ceil(distinctDeadRecipients/100) × 30s`,**不是**恒 30s。不做 page-overflow continuation(区分「翻页未尽」与「rateLimited/unroutable」需要改扫描返回语义,且 100+ 个 distinct 死信收件人本身已是舰队级灾难,分钟级通知延迟可接受 —— 通知本就有 30min rate window;只删不加)。此语义写入验收,并加 101+ recipients 测试断言第二次扫描覆盖第二页。

### 刀 3 — 归档(R1 评审后修订:前进保证 + 尝试级节流 + 预算实测)

**背景事实修正**(R1 #2,已核实 db.ts:1026/1071):CommDB 默认 `archiveOnOpen=true`,Bridge 每次开 CommDB 已跑一批归档 —— 但活体库自 8/23 起零 archived 事件、期间每日两次重启照常开库 ⇒ **候选窗被 not_due family 钉死是活体现象**。所以刀 3 有两半:周期性重跑 + 候选窗前进保证。

**(a) `packages/flywheel-comm/src/mailbox-queue.ts` `archiveDueFamilies` 增加 in-process ring cursor**(照抄本类既有 `runnerDeadNoticeScanAfterAgent` / `deadAlertScanCursor` 先例,不落盘、不加表):
- 两个游标:`archiveAckedScanCursor?: {terminalAt: string; seq: number}`、`archiveDeadScanCursor?: {...}`;
- 候选查询从「最老 candidateLimit 条」改为「keyset 游标之后的 candidateLimit 条,取尽则 wrap 回头」(现有两条候选 SQL 各加 `(acked_at > ? OR (acked_at = ? AND seq > ?))` 分支与 wrap 查询,ORDER BY 不变,继续走 `mailbox_archive_acked/dead` 索引);
- 每 pass 结束把游标推进到最后一个**被检查**的候选 ⇒ 被钉住的 not_due family 不再永久遮挡后面的可归档 family;进程重启游标归零,只损失位置不损失正确性。
- **受益范围如实声明**(R2 #3):前进保证只来自**同一长期存活 `MailboxQueue` 实例上的重复 pass**(即 LeadInboxRuntime 的周期归档);CLI `cleanup-messages` 每次新建实例、只调一次,不跨 pass 保留游标,**不受益**(也无需为它加循环 —— 生产修复的受益者是 Bridge 周期 queue)。adversarial 测试必须**复用同一 queue 实例**断言跨 pass 前进。
- 语义不变:归档判定(`not_due`/`oversized`/`invalid_content_ref`)与事务写法原样。

**(b) `packages/teamlead/src/bridge/lead-inbox-runtime.ts`**:`admit()` leadIndex===0 分支末尾增归档 pass,per-project `lastArchiveAttemptAtMs` **尝试级**节流(R1 #1:时间戳在**尝试开始时**推进,失败同样等满 interval,杜绝 warn 每秒热循环):

```ts
// 间隔 env FLYWHEEL_MAILBOX_ARCHIVE_INTERVAL_MS(默认 60_000,boundedInteger 10_000..86_400_000)
if (now - lastAttempt >= archiveIntervalMs) {
  lastAttempt = now;                       // ← 先推进,attempt-level throttle
  try {
    const iso = new Date().toISOString();
    queue.archiveDueFamilies({ now: iso }); // maxFamilies 沿用默认 10(见预算实测)
    queue.drainContentRefGc({ now: iso });  // 默认 limit 10
  } catch (error) { /* console.warn,不炸 tick,不反噬投递主路径 */ }
}
```

knob 放 `mailbox-queue-config.ts`(`archiveIntervalMs`)与刀 2 同一 config 面。

**(c) 每-pass 主线程预算实测**(R1 #1:2MB 是 per-family 上限,单 pass 最坏 10×2MB=20MB JSON canonicalize,「可控百 ms」必须变成测出来的数):实现期在 vitest 里造 near-cap(接近 2MB)family × 10 的 pass,实测 wall time 并写入验收(预算门:单 pass < 1s;实际 family 中位数远小于 cap,常态预期 <50ms)。若实测超门,降 `maxFamilies` 显式传参 —— 用测量选参,不用未量化默认。

### 刀 4 — gate-marker 缓存(R1 评审后修订:两层缓存 + 实测预算)

R1 #5 实测:8K 文件仅 statSync 一轮仍要 18.8–33.4ms/次 —— 单层 per-file stat 缓存不足以支撑「占比归零」的说法。已核实**写契约**:主 marker 目录的全部变更都经 `writeGateMarker`(temp + `renameSync`,创建与 answeredAt 改写同路)或 `rmSync` 删除 —— **无任何 in-place 写**(`ask/` 子目录的 in-place 写对本函数不可见,non-recursive)⇒ 任何变更必然更新目录 mtime,目录级失效是安全的。

**`packages/flywheel-comm/src/gate-marker.ts`** `listGateMarkersForExecution` 两层缓存,**按目录身份隔离**(R2 #2:这是多目录 API,缓存必须 `Map<resolvedDir, {dirMtimeMs, parsedMarkers, fileCache}>` —— 模块级单份 last-mtime 会在两目录 mtime 巧合相同时把 A 目录的 marker 返回给 B,静默跨执行域错误;per-file key 用完整 path;目录不存在时清除该 dir entry):
1. **目录门**:statSync(dir) 的 `mtimeMs` 与该 dir entry 一致 ⇒ 目录未变 ⇒ 直接用该 entry 的全量解析结果过滤 executionId 返回(warm pass ≈ 1 次 stat,微秒级);
2. **per-file 层**(该目录 mtime 变了才进入):readdirSync → 逐 .json statSync,`mtimeMs+size` 命中用缓存(含 parse 失败的 null),未命中 readFileSync+parse+回填;结尾清除该 entry 中已消失 path 的缓存项。
每个文件的 stat/read/parse 包在**同一 try/catch** 内(readdir 与 stat 之间文件可能被并发删除,单文件失败只跳过该文件,不炸整次 list)。`readGateMarker`/写路径不动;不删文件、不改 poll 间隔。测试补一条:两个目录 mtime 相同、交替 list,结果各自隔离。

**实测验收**(R1 #5):vitest 造 8K 合成 marker 文件 —— 目录未变的 warm pass < 5ms;目录变更后的增量 pass(1 个新文件)< 100ms;行为断言(改写 answeredAt 后必见新值、删除后不再出现、坏 JSON 跳过)不变。

### 里程碑(PR 最后一 commit)

`engineering/doc/milestones/FLY-2136.md` 新建(单写者合同,**不碰 CLAUDE.md**);本 doc 文件夹随分支合入。

## 2. TDD 顺序(RED → GREEN)

1. **`packages/flywheel-comm/src/__tests__/mailbox-query-plans.fly2136.test.ts`**(新,照 fly2008 pattern,复用 `expectUses`/`expectNoBareMailboxScan` 写法):对 §1 刀 1 的四条语句(recipients/latestNotice/aggregate/listUncovered-recipients)断言 EQP 用 `mailbox_dead_scan`/`mailbox_dead_notice_lookup` 且无 bare `SCAN mailbox`、无 `TEMP B-TREE FOR GROUP BY` —— 先 RED(现 schema 必挂)。
2. **schema 测试**:`mailbox-queue-schema.test.ts` 补「存量库(仅 CORE 表无新索引)经 `ensureMailboxQueueSchema` 后两索引存在」;`mailbox-schema.test.ts` 补新库存在断言。
3. **66K 基准回归**(并入 fly2136 query-plans 文件):合成 63_007 ACKED + 3_212 DEAD/50 recipients,跑真 `MailboxQueue.scanAndInsertDeadLetterNotices` + `listUncoveredLeadDeadLetters` 各一轮,断言合计 wall time < 500ms(实测 7.5ms,与修前 2412ms 数量级隔离,CI 抖动安全);行数用常量,注释标注 FLY-2058 取证来源。
4. **`runner-mailbox-lane.test.ts`**:fake `now` 推进 —— 同一 lane 连续 tick,30s 内 `scanAndInsertDeadLetterNotices` 只被调一次(spy 计数),跨过 30s 再调;投递/租约路径每 tick 照跑;**101+ distinct DEAD recipients:第二次扫描覆盖第二页**(ring cursor 语义,R1 #3)。
5. **归档前进保证(R1 #2,adversarial)**:`mailbox-queue-capabilities.test.ts` 或 fly2136 新文件 —— 造 `candidateLimit`(40)个以上被钉住的 not_due family(含未答 question 成员)排在 1 个可归档 family 之前,重复调用 `archiveDueFamilies`,断言可归档 family 在有限 pass 内被归档(ring cursor 生效);wrap 行为断言(游标到尾后回头)。
6. **`lead-inbox-runtime.test.ts`**:reconcileDeadLetterAlertIntents 节流同型断言;归档 pass —— 种子超 72h ACKED family,推进假时钟过 archiveIntervalMs,断言 mailbox 行删除 + `mailbox_log('archived')` + `mailbox_identity.archived_at`;**归档持续抛错:连续多 tick 只尝试一次/interval(attempt-level throttle,R1 #1),且投递每 tick 照常**。
7. **归档预算正控(R1 #1)**:near-cap(≈2MB)family × 10 的单 pass wall time 实测,断言 < 1s,数值写进验收记录。
8. **`gate-marker.test.ts`**:目录未变 warm pass 用缓存(fs spy 断言零 readFile);改写 answeredAt(temp+rename)后必见新值;删除后缓存项清除;坏 JSON 跳过;**8K 合成文件 bench:warm pass < 5ms、单文件增量 pass < 100ms**(R1 #5)。
9. GREEN 后全量:`mailbox-queue-capabilities.test.ts` 等既有行为测试**零修改**通过 = 语义不变证明(注:刀 3(a) 只改候选枚举顺序,归档判定与事务不变 —— 若个别既有测试隐含依赖「最老优先」枚举顺序,按语义等价原则逐条评估,不放宽任何行为断言)。

## 3. 全仓门 + 真 Bridge 回归(issue 硬要求)

1. `pnpm lint`(biome 全仓)+ `pnpm -r build`(topo)+ `pnpm test:packages:run`(⚠️ 该命令失败即停,须核对 teamlead 包确实跑到 —— MEMORY 已知坑)。
2. 真 Bridge 起停(R1 #4 修订 —— 显式隔离,断言解析 JSON 而非 exit code):
   - **种子脚本入库**:`scripts/qa/fly2136-seed-66k.cjs`(由设计期 bench 脚本整理而来,随分支提交)造 63_007 ACKED + 3_212 DEAD 的隔离 comm.db;
   - **隔离面**(⚠️ `FLYWHEEL_HOME` **不**控制 comm.db —— `commDbRootDir()` 只认 `FLYWHEEL_COMM_ROOT`/`FLYWHEEL_COMM_DIR`,commdb-path.ts:19-27;R2 #1 补两处默认落真 `~/.flywheel` 的状态):显式设 `FLYWHEEL_COMM_DIR=<scratch>`、`TEAMLEAD_DB_PATH=<scratch>/teamlead.db`、**`FLYWHEEL_STATE_DIR=<scratch>`(diagnostics)、`FLYWHEEL_LEAD_LEASE_DB=<scratch>/lead-lease.db`、`FLYWHEEL_LEAD_EPISODE_DB=<scratch>/lease-episodes.db`(LeaseAuditOutbox.materialize 在首个 rider tick 就会建库,plugin.ts:10766-10775)、`FLYWHEEL_ALERT_QUEUE_DIR=<scratch>/alert-queue`、`FLYWHEEL_ALERT_DEADLETTER_DIR=<scratch>/alert-deadletter`、`FLYWHEEL_CLAIMS_DB=<scratch>/claims.db`(防测试 alert 落生产队列被 live Bridge cross-pickup,lead-alert-helpers.ts:40-55)**、最小 `FLYWHEEL_PROJECTS` 配置、非生产 `TEAMLEAD_PORT`(如 19876)与对应 `BRIDGE_URL`、`FLYWHEEL_PROBE_STATE_FILE=<scratch>`,并禁用外部通知路由(Discord/Linear token 置空);
   - **执行凭据非空**(R2 #1:`EventLoopAttribution` 启动时 p99/max 为 `null`、首窗要 30s;`null < 500` 在 jq 里为 true ⇒ 直接比较会假绿):起 `scripts/run-bridge.ts`(记录 PID,trap 保证只杀本进程)→ ① 先轮询种子 comm.db 的 `loop_heartbeat.last_success_at`,证明含 `runnerLane.tick()` 的首轮 lead admit 真实完成;② 等首个 30s event-loop 窗口滚动;③ `curl /health` **解析 JSON**:先断言 `.ok == true` 且 `p99_ms/max_ms | type == "number"`,再断言二者 < 500 —— 不得依赖 `bridge-liveness-probe.sh` 的 exit code(它 down/degraded 也返 0,:208-228)→ 干净停进程;
   - **修前对照的诚实口径**(R2 #1):单次启动不构成持续 1s cadence 饿死 —— 修前基线收窄为「同款种子下复现至少一次 >500ms 的主线程 stall(单轮扫描实测 2.4s)」,持续饿死的复现留给部署后哨兵。
3. Codex code review(`codex:rescue`)循环至 approved。

## 4. 部署后阳性对照(issue 第 4 条,依赖部署班车)

- merge 后**不投重启票**(FLY-1959,部署走 00:00/12:00 班车);
- 部署后由 FLY-2031 哨兵/health 复测:同等负载窗口 p99 对比基线 25–30.7s,预期回落到 ms 级;可选 USR1+CDP 复采 profile 验证 scan 占比 62.9% → ~0(手法已在 FLY-2058 固化);
- 终态行常驻数观测:`SELECT state, COUNT(*)` 应在 72h 后进入稳态(≈3 天流量)。

## 5. 边界与不做(诚实清单)

- **不改**死信判定/投递/租约语义(FLY-2123);**不动** EventLoopGuard/取证机制(FLY-2058)与 git 同步链嫌疑(其 T1 分辨);
- issue 第 2 条「readFileSync 移出事务」**落空为无此病灶**:事务内无 readFileSync(exploration §2.5 三重证据),真身是 gate-marker 全量重读,已由刀 4 覆盖;
- gate marker 7926 个残留文件的**清扫**不在本单 —— 读缓存后已出热路径,清扫连同「谁在铸残留」报 Tadashi 另立;
- 当晚 01:15–01:24Z 的 6.5 万行带外 DELETE 出处未确认(exploration §2.7),不在本单追;刀 3 的归档幂等、留审计,与任何外部清库共存无害;
- CodexTmuxAdapter 5s poll 间隔本身不动(降频真身是去掉每轮 250MB 读,不是改周期)。

## 6. 验收清单

- [ ] 4 条热语句 EQP 全部走新索引,无 bare SCAN / TEMP B-TREE(vitest 固化)
- [ ] 66K 合成行单轮扫描 < 500ms(实测预期 ~8ms)
- [ ] 30s 节流与归档 pass 行为测试绿;既有 capabilities 测试零修改绿
- [ ] 归档前进保证 adversarial 测试绿(40+ 钉住 family 不再遮挡后排);归档失败 attempt-level 节流测试绿
- [ ] 归档 near-cap 单 pass 实测 < 1s;gate-marker 8K warm pass < 5ms / 增量 < 100ms
- [ ] 101+ recipients 翻页测试绿;最坏发现延迟语义(`ceil(n/100)×interval`)已写入本节
- [ ] gate-marker 二次 list 不重读未变文件
- [ ] `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` 全绿(核对 teamlead 包实际执行)
- [ ] 66K 种子 + 真 Bridge 起停 + /health 健康
- [ ] Codex review approved;PR 末 commit 带 milestone 文件
