# FLY-2136 mailbox 死信扫描热循环 — 探索

Issue: FLY-2136 (https://linear.app/geoforge3d/issue/FLY-2136/urgentbridge-稳定-mailbox-死信扫描热循环饿死事件循环每-tick-全表重扫-66-万终态行事务内)
日期: 2026-08-28
基于: 无(上游证据为 FLY-2058 exploration.md §4.5 @ 9b375d22d,本文档对其做了独立复核并修正一处归因)

## 1. 一句话

Bridge 主线程每秒一次对 comm.db mailbox 表跑一套**无索引可用的死信扫描查询**,成本随终态行(ACKED/DEAD)数量线性恶化;终态行**没有任何 Bridge 内归档机制**、单调累积到 6.6 万行时,单次扫描实测 2.4 秒,把事件循环磨成 p99 25–30s,最终触发 EventLoopGuard 自杀(FLY-2133)。

## 2. 病灶解剖(全部一手复核,非转述)

### 2.1 热路径结构

```
LeadInboxLoop (每项目第一个 Lead,active 间隔 1_000ms — lead-inbox-loop.ts:29)
  └─ admit() (lead-inbox-runtime.ts:329)
       ├─ runnerLane.tick() (runner-mailbox-lane.ts:235)
       │    ├─ reconcileExpiredLeases(maxTerminalRows=100)   — QUEUED 行,量小,索引可用,非病灶
       │    ├─ scanAndInsertDeadLetterNotices(maxRecipients=100) — ★ 主病灶
       │    └─ claim/deliver 循环
       ├─ reconcileDeadLetterAlertIntents → listUncoveredLeadDeadLetters — ★ 次病灶(同族)
       └─ drainDeadLetterAlerts
```

### 2.2 无索引查询清单(EXPLAIN QUERY PLAN 实测,活体库)

`scanAndInsertDeadLetterNotices`(mailbox-queue.ts:1938)每 tick、每 recipient(≤100)执行:

| 查询 | 实测 plan | 66K 行时代价 |
|---|---|---|
| recipients:`WHERE recipient_kind='runner' AND state='DEAD' GROUP BY to_agent`(×2 含 wrap) | `SCAN mailbox USING INDEX mailbox_archive_dead` + `TEMP B-TREE FOR GROUP BY` | 扫全部 DEAD 行 ×2/tick |
| latestNotice:`WHERE type='dead_letter_notice' AND source_kind='dead_letter' AND source_ref=? ORDER BY seq DESC LIMIT 1` | **`SCAN mailbox`(裸全表反扫)** | 无通知行的 recipient = 反扫整表;×100 recipient/tick |
| aggregate:`WHERE state='DEAD' AND to_agent=? AND seq>?` | `SEARCH ... INTEGER PRIMARY KEY (rowid>?)` | cursor=0 时≈全表;×100/tick |
| summaries:同上 + `ORDER BY seq LIMIT 20` | 同上 | 同上 |

`listUncoveredLeadDeadLetters`(mailbox-queue.ts:2100,由 reconcileDeadLetterAlertIntents 每 tick 调)结构同族:全 DEAD 行 GROUP BY + per-recipient 聚合。

现有索引里唯一沾边的 `mailbox_archive_dead ON mailbox(dead_at) WHERE state='DEAD'` 列是 `dead_at`,对上面所有按 `to_agent`/`source_ref`/`seq` 的谓词**一个都用不上**。

### 2.3 定量复现(阳性对照,设计期已做)

合成 63_007 ACKED + 3_212 DEAD(50 个 runner recipient,复刻发作规模),生产 schema,忠实重放单 tick 查询序列(bench-66k.cjs):

| | recipQuery | latestNotice | aggregate | summaries | uncovered | **合计/tick** |
|---|---|---|---|---|---|---|
| 修前(现网索引) | 1.2ms | 665.9ms | 832.0ms | 909.9ms | 3.2ms | **2412ms** |
| 修后(+2 partial index) | 0.4ms | 0.7ms | 2.0ms | 2.9ms | 1.5ms | **7.5ms** |

**单 tick 2.4s > 1s tick 间隔 ⇒ 扫描背靠背连跑,主线程被永久占满** —— 与活体 profile(主线程 CPU ~87%、62.9% 在 scan 事务)和 /health p99 25–30.7s(FLY-2031)完全吻合。当前活体库只有 434 行时同一序列仅 0.57ms —— 证明成本纯随表大小线性,病灶=「终态行累积 × 无索引扫描」的乘积。

### 2.4 raw profile 复核(bridge-live.cpuprofile,4679 样本,自行解析)

| inclusive 占比 | 归属 |
|---|---|
| 62.9% | `scanAndInsertDeadLetterNotices` 事务回调(其中 62.4% 为 better-sqlite3 原生查询) |
| 5.4% | `listUncoveredLeadDeadLetters` |
| 19.8% | `CodexTmuxAdapter`:isWaiting 12.2% + tick 7.6% —— 全部落在 `listGateMarkersForExecution` |
| 1.3% | `hasPendingQuestionsFrom`(QUEUED 索引可用,非本单) |

### 2.5 ★ 归因修正:「事务内 readFileSync(content_ref)」不成立

Issue 与 FLY-2058 exploration §4.5 断言「同步事务内含 readFileSync(content_ref),profile 里 17.6% readFileUtf8 即来源于此」。**一手复核推翻此条**:

1. 源码与部署 dist 均无此调用:`readFileSync` 在 mailbox-queue 里只出现于 `archiveFamily`(在事务**外**,dist:1763)与 `drainContentRefGc`(dist:1855),而这两个函数 Bridge tick 路径**根本不跑**(见 §2.6);
2. 活体库 `content_ref IS NOT NULL` 行数 = **0**;
3. raw profile 里全部 readFileUtf8 样本(301+310+216 hits = 17.7%)的调用栈都在 `CodexTmuxAdapter.tick / isWaiting → listGateMarkersForExecution`,与 mailbox 无关。

真身:`listGateMarkersForExecution`(gate-marker.ts:168)每次调用 readdir + **逐个 readFileSync+JSON.parse 整个 marker 目录**。实测 `~/.flywheel/state/codex-gates/` 现存 **7926 个 .json、共 250MB** —— 每次 isWaiting()/tick()(每 1–5s)同步读 250MB。与 mailbox 同一病型:终态残留不清 + 每轮全量重扫。

### 2.6 终态行为什么会积到 6.6 万(R1 评审后修正版)

归档机制存在(`archiveDueFamilies`,72h retention,写 mailbox_log + 删行),且 **CommDB 构造器默认 `archiveOnOpen=true`**(db.ts:1071)—— Bridge 每次开 CommDB 会跑一次 `purgeExpired()`(一批 ≤10 family)。但活体库 mailbox_log 最后一次 archived 事件停在 **2026-08-23T17:46Z**,而此后每日两次班车重启都照常开 CommDB —— **开库归档在跑,却一行都归不动**。成因与 archiveDueFamilies 的候选窗形状吻合:它每次只看「最老的 maxFamilies×4 个终态候选」,含未答 question / 存活成员 / oversized 的 family 返回 `not_due` 却持续占坑,前排被钉满后,后面所有可归档 family 永久饥饿(无跨 pass 游标)。叠加「每次开库只有一批、无周期性重跑」,吞吐也追不上 ~4.4K 行/天的铸行速率。本席观测 15 分钟内 DEAD 5→42 —— 累积在此刻仍在进行,不修必然复发。

### 2.7 时间线悬案(如实记录,不下结论)

2026-08-29T01:15Z(取证读到 3212 DEAD + 63007 ACKED)与 01:24Z(本席读到 434 行)之间,约 6.5 万行被**带外批量 DELETE**:freelist 41_333/124_338 页证实大删除刚发生,但 mailbox_log 无任何 archived 事件、bridge 日志无 purge 记录 ⇒ 不是走 archiveFamily,出处未确认(推测为当晚救火手动清库)。影响:主引信当下已被人工拆除一次,但§2.6 的累积机制原封不动 —— 本单修的是机制,不是这一次的存量。

## 3. 与关联 issue 的边界

- **FLY-2058**(病灶发现/取证 + guard 机制):本文档只消费其 profile,不动 guard;其 §4.5 的 readFileSync 归因由本文档 §2.5 修正。
- **FLY-2133**(自杀连环):本单拆「扫描越来越慢→p99 越阈值」这条引信;git 同步链的离散 60s+ 嫌疑仍归 FLY-2058 T1。
- **FLY-2123**(租约死信语义):**不改任何死信判定/投递/租约语义** —— 为什么消息死、死了怎么通知,原样;本单只改扫描的物理成本与节奏、终态行的常驻时长。
- gate marker 残留(7926 个文件)的**清扫**是新发现,不在本单私自扩权 —— 只做读侧缓存止血,残留清理报 Lead 另立。

## 4. 修法方向(交给 research/plan 展开)

按 issue 给的形状,四刀,全部最小手术:

1. **两个 partial index**(纯物理,零语义):`(recipient_kind, to_agent, seq) WHERE state='DEAD' AND carrier='inbox'` + `(source_ref, seq) WHERE type='dead_letter_notice' AND source_kind='dead_letter'` —— §2.3 实测 323×。
2. **死信扫描节流**:通知本身有 30min rate window(deadLetterWindowMs),1s 粒度毫无意义 —— scan + alert-intents 降到 ~30s 一次(env 可调)。索引 + 节流 = 双保险(未来行数异常再涨也饿不死循环)。
3. **Bridge 内周期归档**:把已有的 `archiveDueFamilies`(72h retention 不变)挂进 Bridge 慢节奏跑,终态行常驻上限 ≈ 3 天流量,不再无界。
4. **顺手**:`listGateMarkersForExecution` 加 per-file stat 缓存(mtime+size 未变不重读),250MB/次 → readdir+stat;不删文件、不改 marker 语义。

## 5. 验收形状(issue 第 4 条)

- 设计期阳性对照已完成(§2.3):66K 行 2412ms → 7.5ms。
- 实现期:vitest 断言 EQP 用上新索引 + 66K 合成行基准回归 + 节流/归档行为测试 + 真 Bridge 起停回归(issue 硬要求)。
- 部署后:同等行数下复测 /health p99(FLY-2058 基线 25–30.7s)与 profile 占比 —— 依赖部署班车窗口(FLY-1959 merge 与部署解耦)。
