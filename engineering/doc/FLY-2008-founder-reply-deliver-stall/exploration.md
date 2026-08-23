# FLY-2008 gate-poller 单段 70 秒挂死事件循环 — 探索

Issue: FLY-2008 (https://linear.app/geoforge3d/issue/FLY-2008/容量bug-gate-pollerfounder-reply-deliver-单段-70-秒挂死事件循环-黑匣子-1342z-实捕1995)
日期: 2026-08-23
基于: 无

> ⚠️ **演进标注(2026-08-23 14:2xZ)**:本文是设计节点开工时的探索快照。其后 Lead 圆桌用全天账本把定性从「founder 窗口事件」升级为**慢性病**(696 段/天、逐小时平坦、与 founder 活动无关),并把心跳冻结定案为**独立的 B 病**(HeartbeatService 对重启幸存会话代写心跳 + 判官同体;与事件循环脱钩)。最终机制与两病结构见 research.md §9 与 plan.md §0;本文 §1 的 founder-窗口 framing 与「心跳断联是循环挂死下游」假设**均已被证据修正**,保留原文仅作演进留档。

## 1. 问题陈述

FLY-1995 的黑匣子(event-loop 归因仪表)上线后首次实捕:founder 密集批卡/回帖窗口(13:29–13:42Z)内,Bridge 事件循环出现成段挂死:

- `gate-poller.founder-reply-deliver` 单个 wall span 达 **70,287ms**(70 秒),ELU 0.94;
- `gate-poller.tick` 反复出现 5–6 秒 span,ELU 0.87–0.999;
- 外部症状同步:`/health` 8.32s/33.75s 成段发作、HL 外发消息被 routing guard 拦截的时刻正落在发作段内;
- HL 观测「心跳一天真断 11 次(runner 活着但心跳失联)」疑似同一机制下游(issue 中标注为假设)。

FLY-1995 修掉了孤儿提问无界重扫(旧病灶),本单是黑匣子暴露的**第二病灶**。

## 2. 现场still-hot:发作在本节点开工时仍在进行

本设计节点开工时(2026-08-23 13:57Z 前后),黑匣子仍在持续捕获同签名 episode——最近 5 个 `founder-reply-deliver` span 全部落在 64–73 秒区间,cadence ~60s ⇒ **该 pass 实际上在连续不断地跑**:

| started_at (Z) | founder-reply-deliver span | ELU | max loop delay |
|---|---|---|---|
| 13:44:49 | 64,446ms | 0.60 | 5,154ms |
| 13:48:13 | 68,880ms | 0.84 | 6,857ms |
| 13:54:03 | 64,321ms | 0.63 | **12,431ms** |
| 13:57:28 | 72,782ms | 0.72 | 5,800ms |
| 14:00:43 | 66,667ms | 0.86 | 6,803ms |

这意味着 issue 描述的不是一次性事故,而是**当前常态**;也意味着 before 基线证据充足(episodes.jsonl + 留存 cpuprofile),验收可以直接用同一把尺。

## 3. 初步定性:三个相互纠缠的机制

用留存 cpuprofile(13:54:03/max12432 等多份交叉验证)+ 生产库只读实测,初步拆出三层(详细证据见 research.md):

### 机制 1 — CPU 支配项不在 founder-reply-deliver 本身,而在 LeadInboxLoop 的同步 SQL 全表扫描

多份 profile 一致:inclusive CPU 前列是 `lead-inbox-loop.tick`(41.8–49.4%),内含 `mailbox-queue.releaseExpiredLegacyPushClaims`(28.5–54.4%)与 `claimBridgeProtocol`(12.9–26.5%);self time 由 better-sqlite3 原生 `get`/`all`/`run` 支配(合计 ~58%)。这两条查询在 506MB / 49,780 行的 `mailbox` 表上都是 **全表 SCAN**(OR 谓词让 SQLite 用不上现有 partial index),单次 ~22ms;LeadInboxLoop 活跃间隔 1s × 全舰 ~14 个 Lead × 每 tick 多条 ⇒ 每秒近 1 秒 CPU 的基线负载,把事件循环填满。

### 机制 2 — 5–12 秒「单段」阻塞的形成:到期定时器批量串联

单条 SQL 只有 ~22ms,却出现 5–12 秒连续阻塞(max_ms)。机制:循环被塞住时,14 个 Lead loop 的 1s 定时器 + gate-poller 3s 定时器持续到期堆积;阻塞一结束,Node 的 `processTimers`/`listOnTimeout` 在**同一个 macro turn** 里连续执行全部到期回调,每个回调的同步 SQL 前缀(几十~几百 ms)串联成下一个 5–12 秒连续段 → 自我延续。profile 佐证:`processTimers` inclusive 34–56%,`listOnTimeout` 28%。/health、心跳写入、routing guard 全在这些段里陪葬。

### 机制 3 — founder-reply-deliver 的 70 秒 wall:串行 Discord HTTP × 117 个活 thread,且挂在 poll() 主链上

`founderReplyDeliverPass` 对每个活 issue thread 串行发一次 Discord GET(当前活 thread 实测 117 个),~0.5s/个 ≈ 60–70s wall——与实测 span 64–73s 吻合。它被 `await` 在 gate-poller `poll()` 主链上 ⇒ 整个 tick 被拖 70 秒,期间 question-relay、founder-reaction-approval 等所有 rider 停摆(founder 密集回帖窗口没人送话的直接机制)。pass 自身还有 ~15% 的同步 CPU:每 pass × 每 Lead 重新 `CommDB.openReadonly`(打开 506MB 库)+ `getPendingQuestions`(view 上全扫)+ `listNonTerminalSessions`(183 行,teamlead.db 1.7GB)× per-session `getChatThreadByIssue`。同时它也是机制 1/2 的受害者:每次 HTTP await 恢复都要排队等几秒的同步块。

## 4. 方案空间

### 方向 A:修查询计划(root cure,最便宜)
把三处全表扫描变成索引命中。已在生产库副本上逐条 EXPLAIN QUERY PLAN + 计时验证(见 research.md §4):
- `claimBridgeProtocol` 拆 OR → 命中**现有** partial index,零 schema 改动,22ms→0.01ms;
- legacy-push 收编 UPDATE → 新增小 partial index(命中行 1,065),22ms→0.03ms;
- `getPendingQuestions` → 新增 question partial index + 复用现有 response 唯一索引;
- `countDeliverable`(每次调度后都跑)→ 拆 bound-param OR + 新增小 partial index。

### 方向 B:founder-reply-deliver 时间片化(有界化)
- 单 pass 预算化:每个 sub-cadence 只处理预算内的 thread 数(持久游标轮转),单片同步段 ≤ tick 预算;
- 每 pass 每 project 只开一次 readonly CommDB(现在是 per Lead 重开 506MB 库);`listNonTerminalSessions` 每 pass 一次并缓存;
- 保留 inline await(保序、免重入),分片后单次占用自然变短。

### 方向 C:让出点(防御)
gate-poller per-lead 循环之间 `await setImmediate()`,把 5–6 秒连续段切成 per-lead 小段。机制 1 修复后这层是保险,不是主治。

### 被否掉的方向
- **Discord GET 并行化**:能压 wall 但撞 rate limit,且 wall 长本身不是病(阻塞才是);预算分片已够。→ 拒绝。
- **把 deliver pass 挪到独立 timer/worker**:与「zero new periodic timer」的既有纪律冲突,重入/顺序问题引入新风险;分片方案在现有 cadence 内解决同样的问题。→ 拒绝。
- **mailbox / session_events 数据减肥**(mailbox 46,995 行 ACKED 死重、mailbox_log 251MB、teamlead.db session_events 798MB):是真问题但归 FLY-1998(全库老旧数据一次性安全清扫工具,已 pending ship);本单修查询计划后对表大小不再敏感,两单解耦。→ 移交,不在本单做。

## 5. 关联

- parent FLY-1954(容量);FLY-1995(仪表来源 + 旧病灶,修复已 merge #927);FLY-1613(监视器误报账——HL 已撤回『假阳性』定性);FLY-1998(数据清扫,解决表膨胀本身)。
- 心跳断联归零是**相关性验收**(issue 原文即标注假设),不承诺因果证明。

## 6. 结论

采用 A + B + C 组合:A 是 root cure(CPU 支配项),B 治 70 秒 wall 与 tick 停摆,C 是一行级防御。详细证据 → research.md,实施方案 → plan.md。
