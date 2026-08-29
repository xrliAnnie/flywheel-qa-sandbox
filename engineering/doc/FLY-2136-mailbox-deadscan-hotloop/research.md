# FLY-2136 mailbox 死信扫描热循环 — 调研

Issue: FLY-2136 (https://linear.app/geoforge3d/issue/FLY-2136/urgentbridge-稳定-mailbox-死信扫描热循环饿死事件循环每-tick-全表重扫-66-万终态行事务内)
日期: 2026-08-28
基于: exploration.md

## 1. 目的

exploration.md 已确证病灶与修法方向(四刀)。本调研逐刀核实**落点、既有机制、约束与风险**,产出 plan 可直接执行的事实清单。

## 2. 刀 1:partial index —— 落点与迁移路径

### 2.1 两个索引定义

```sql
CREATE INDEX IF NOT EXISTS mailbox_dead_scan
  ON mailbox(recipient_kind, to_agent, seq)
  WHERE state = 'DEAD' AND carrier = 'inbox';
CREATE INDEX IF NOT EXISTS mailbox_dead_notice_lookup
  ON mailbox(source_ref, seq)
  WHERE type = 'dead_letter_notice' AND source_kind = 'dead_letter';
```

覆盖验证(66K 合成库 EQP 实测,exploration §2.3):
- recipients / aggregate:`COVERING INDEX mailbox_dead_scan`(GROUP BY 无 temp B-tree);
- latestNotice:`INDEX mailbox_dead_notice_lookup (source_ref=?)`,ORDER BY seq DESC LIMIT 1 单点探;
- listUncoveredLeadDeadLetters recipients/aggregate:`INDEX mailbox_dead_scan (recipient_kind=?)`(`dead_reason IS NOT ...` 为回表过滤,只触 DEAD 行,可接受);
- summaries:索引定位 + LIMIT 20 回表,可接受。

SQLite partial-index 可用性:两条查询都显式携带索引 WHERE 子句的全部谓词(`state='DEAD' AND carrier='inbox'` / `type='dead_letter_notice' AND source_kind='dead_letter'`),规划器可证蕴含 ⇒ 必然可选。

### 2.2 落点(新库 + 存量库一次覆盖)

- **新库**:`packages/flywheel-comm/src/mailbox-schema.ts` `MAILBOX_CORE_SCHEMA` 索引段(现有 `mailbox_archive_dead` 之后)。
- **存量库**:`ensureMailboxQueueSchema()`(mailbox-queue.ts:307)—— 该函数是**所有连接的统一升级门**:`MailboxQueue` 自有连接(:429-430)、外部连接包装(:410)、以及 **CommDB 构造(db.ts:1057)** 都会经过;内部已有 `CREATE INDEX IF NOT EXISTS mailbox_lease_expiry` 先例(:333),照抄形状。幂等,WeakSet 每连接只跑一次。
- 建索引成本:66K 行一次性 ~百 ms 级,发生在连接建立时,可接受;此后 INSERT/UPDATE 只在行进出 DEAD 态或插入 notice 时维护这两个 partial index,增量成本可忽略。
- **先例**:FLY-2008 干过同一件事(为热路径语句配索引 + `mailbox-query-plans.fly2008.test.ts` 断言 EQP),但漏掉了死信扫描这组语句 —— 本单补齐,测试照同一 pattern 新增 `mailbox-query-plans.fly2136.test.ts`(`expectUses` / `expectNoBareMailboxScan` helper 直接复用其写法)。

### 2.3 明确不做

不改 `scanAndInsertDeadLetterNotices` / `listUncoveredLeadDeadLetters` 的任何查询文本与控制流(rate-limit 顺序、cursor 轮转、uncoveredRemaining 语义原样)——纯物理层修复,现有 `mailbox-queue-capabilities.test.ts` 全量行为测试原样通过即是语义不变的证明。注意该文件 :1449 有对源码结构的字面断言(`source.indexOf("\tscanAndInsertDeadLetterNotices(")`),不动函数签名即不受影响。

## 3. 刀 2:死信扫描节流 —— 落点与语义边界

### 3.1 现状

- `LeadInboxLoop` active 间隔 **1s**(`ACTIVE_LEAD_INBOX_INTERVAL_MS = 1_000`,lead-inbox-loop.ts:29),idle 30s;有活跃 session 时基本恒为 1s。
- 每个项目 leadIndex===0 的 loop 在 `admit()` 里每 tick 跑:`runnerLane.tick()`(内含 scan)→ `reconcileDeadLetterAlertIntents`(内含 listUncovered)→ `drainDeadLetterAlerts`。
- 死信**通知**本身有 `deadLetterWindowMs = 1_800_000`(30min)的 per-recipient rate window —— 1s 粒度的扫描对语义毫无贡献,纯烧 CPU。

### 3.2 方案

`MailboxQueueConfig` 加一项 `deadLetterScanIntervalMs`(默认 **30_000**,env `FLYWHEEL_MAILBOX_DEADSCAN_INTERVAL_MS`,沿用 `boundedInteger` 模式,界 1_000..3_600_000):
- `RunnerMailboxLane` 持 `lastDeadScanAtMs`,tick 内仅当 `now - last >= interval` 才跑 `scanAndInsertDeadLetterNotices`;
- `LeadInboxRuntime` 持 per-project `lastDeadAlertReconcileAtMs`,同节奏才跑 `reconcileDeadLetterAlertIntents`;
- **`reconcileExpiredLeases` 与 claim/deliver 循环保持每 tick**(投递与租约回收有实时性要求,且量小、索引可用);
- **`drainDeadLetterAlerts` 保持每 tick**(它只投递已铸 intent,查 teamlead.db,profile 无占比;零投递延迟变化,最保守)。

语义影响定量:新死信的**首次**通知/告警最多晚 30s;后续节奏由 30min window 决定,不变。issue 边界「不改死信判定/投递语义」成立 —— 判定(什么时候变 DEAD)在 reconcile/recordFailure 路径,原样;投递(通知怎么发)原样;只有扫描发现的粒度从 1s 变 30s。

### 3.3 为什么索引之外还要节流

单独有索引已把 66K 行的 tick 成本压到 7.5ms;节流是**第二道保险**:未来任何一族查询回归(新语句忘配索引、行数异常增长到百万级)时,伤害频率被钉死在 1/30 —— 防复发的纵深,而不是替代修复。

## 4. 刀 3:Bridge 内周期归档 —— 既有机制核实

### 4.1 可直接复用的既有实现

`MailboxQueue.archiveDueFamilies({now, retentionMs?, maxFamilies?, maxFamilyBytes?})`(mailbox-queue.ts:2612):
- 默认 retention 72h、maxFamilies 10、maxFamilyBytes 2MB;候选查询走现有 `mailbox_archive_acked` / `mailbox_archive_dead` 索引,cheap;
- 逐 family:快照(содержit content_ref 时 `readFileSync` —— **在事务外**,live 库 content_ref=0 实际不触)→ 事务内写 `mailbox_log('archived')` + `mailbox_identity.archived_at` + 删行;SQLITE_BUSY 单独退出置 `busy` 标志,不炸 tick;
- open question(question 未答/protected)家族返回 `not_due` 自动跳过 —— 只归档真正终态的 family,语义安全性已内建;
- `drainContentRefGc({now, limit=10})` 同样有界。
- CLI `cleanup-messages` 是现在唯一调用方,幂等共存,无冲突。

### 4.2 挂点与参数

挂 `LeadInboxRuntime.admit()` 的 leadIndex===0 分支(与死信节流同一位置,per-project 已天然隔离),`lastArchiveAtMs` 节流:
- 间隔 env `FLYWHEEL_MAILBOX_ARCHIVE_INTERVAL_MS`,默认 **60_000**;
- 每 pass `archiveDueFamilies({now})`(维持默认 10 families/2MB)后接 `drainContentRefGc({now})`;
- 吞吐核算:10 families/min = 14_400/天,近期铸行速率 ~4.4K/天(120K seq / 27 天)⇒ 稳态可追平;若冷启动积压 66K,约 4.6 天温和排干 —— 期间索引保证扫描无痛,不需要激进大批次(避免 2MB×N 的 JSON canonicalize 同步大块)。
- 单 pass 最坏同步成本 ≈ 10 family × 2MB JSON ≈ 可控百 ms 级,60s 一次 duty cycle <1%;且这是**把终态行永久移出热表**换来的一次性成本。

### 4.3 归档 vs「清理」

issue 第 3 条说「归档清理」:本单选**归档**(mailbox_log 留全量 JSON 快照,mailbox_identity 留 tombstone)而非裸 DELETE —— 与当晚救火的带外 DELETE(exploration §2.7)相反,保审计链;这正是既有 archiveFamily 的设计,零新机制。

## 5. 刀 4:gate marker 读缓存(顺手项)

### 5.1 现状核实

`listGateMarkersForExecution(dir, executionId)`(gate-marker.ts:168):readdirSync + **对目录内每个 .json readFileSync+JSON.parse**,按 executionId 过滤。调用方:CodexTmuxAdapter `isWaiting()`(budget 检查,随 runGoalToTerminal 高频)与 marker 监视 `tick()`(pollIntervalMs=5s/execution)。目录 `~/.flywheel/state/codex-gates/` 实测 **7926 files / 250MB** ⇒ 每次调用同步读 250MB,profile 17.7%。

### 5.2 方案:per-file stat 缓存(纯读侧,零语义)

gate-marker.ts 模块级 `Map<path, {mtimeMs, size, marker: GateMarker | null}>`:
- 每次 list:readdirSync → 逐文件 statSync;`mtimeMs+size` 与缓存一致 → 用缓存值(含 parse 失败的 null),否则 readFileSync+parse+回填;list 结束后删除缓存中已不存在的 path(防泄漏);
- 250MB 读 → 一次 readdir + N 次 stat(冷缓存首轮仍全读一次,此后近零);
- **一致性**:marker 应答(answeredAt)会改文件 ⇒ mtime/size 变 ⇒ 缓存失效,跨进程安全。理论缝隙「同 ms 内等长改写」对 gate marker 的写形状(增 answeredAt 字段,长度必变)不成立;
- 不删文件、不动 5s poll 间隔、不改任何 marker 语义。7926 个残留 marker 的**清扫**报 Lead 另立 issue(读缓存后残留只费一次冷读 + stat,已不在热路径)。

## 6. QA 路径核实

- vitest 落点:`packages/flywheel-comm/src/__tests__/`(query-plans 新文件照 fly2008 pattern;schema 测试 `mailbox-queue-schema.test.ts`/`mailbox-schema.test.ts` 补索引存在断言;`gate-marker.test.ts` 补缓存行为);`packages/teamlead/src/bridge/__tests__/runner-mailbox-lane.test.ts`(节流,fake clock 注入 opts.now 已支持)与 `lead-inbox-runtime.test.ts`(reconcile 节流 + 归档 pass)。
- 66K 基准:vitest 内合成行复测(阈值宽松化防 CI 抖动:断言修后 total < 200ms,而实测 7.5ms,66K 行修前 2412ms —— 数量级隔离足够稳)。
- 真 Bridge 起停(issue 硬要求):`scripts/run-bridge.ts` + `scripts/bridge-liveness-probe.sh` 已存在,QA 阶段以隔离 FLYWHEEL_HOME + 种子 comm.db 起真 Bridge,/health 探活断言,停干净。
- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(注意 memory:该命令失败即停,teamlead 包缺席要人工核对包清单)。

## 7. 风险清单

| 风险 | 评级 | 处置 |
|---|---|---|
| 新索引改变其他语句的 plan 选择 | 低 | partial index 谓词极窄(仅 DEAD/notice 行),不与 QUEUED/LEASED 热语句竞争;fly2008+fly2136 两套 EQP 测试互为回归 |
| 归档 pass 与并发写者(Lead CLI/runner)SQLITE_BUSY | 低 | archiveDueFamilies 已内建 busy 退让;busy_timeout=5000 既有 |
| 节流让「死信风暴」发现变慢 | 低 | 上限 30s,通知 rate window 本就 30min;env 可调回 |
| stat 缓存跨进程失效缝隙 | 极低 | mtime+size 双键;marker 写形状必变长;残留清扫另立 issue 后此风险整体消失 |
| 存量库建索引瞬时锁 | 低 | 连接建立时一次 ~百 ms,ensureMailboxQueueSchema 本就在 .immediate() 事务里做 DDL |
