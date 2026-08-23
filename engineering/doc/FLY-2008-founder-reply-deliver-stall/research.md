# FLY-2008 gate-poller 单段 70 秒挂死事件循环 — 调研

Issue: FLY-2008 (https://linear.app/geoforge3d/issue/FLY-2008/容量bug-gate-pollerfounder-reply-deliver-单段-70-秒挂死事件循环-黑匣子-1342z-实捕1995)
日期: 2026-08-23
基于: exploration.md

> 测量环境与时刻:全部数据采自 2026-08-23 13:57–14:05Z 的生产现网(发作进行中)。
> 生产库只读访问(`mode=ro`);索引/改写实验在 `VACUUM INTO` 出的副本上做,生产零写入。
> ⚠️ 保质期:本文的行数/耗时/thread 数是**当日测量值**,会随数据清扫(FLY-1998)与业务量漂移;
> 结论性的「查询计划形态」(SCAN vs SEARCH)只依赖 schema 与查询文本,不随数据漂移。

## 1. 证据源

| 证据 | 位置 | 说明 |
|---|---|---|
| episode 账本 | `~/.flywheel/diagnostics/event-loop-episodes.jsonl`(698 行) | FLY-1995 黑匣子;每条含 max_ms/ELU/long_wall_spans/profile 文件名 |
| CPU profiles | `~/.flywheel/diagnostics/loop-profiles/`(保留最近 ~20 份) | issue 引用的 13:40–13:42Z 三份已被轮转掉;但同签名 episode 持续新铸,13:44Z 起的多份仍在,含 `founder-reply-deliver` 64–73s span 的 4 份 |
| 生产 comm DB | `~/.flywheel/comm/flywheel/comm.db` | 506MB;mailbox 49,780 行(ACKED 46,995 / DEAD 2,459 / LEASED 310 / QUEUED 12),mailbox_log 115,066 行(251MB),mailbox_identity 102,915 行 |
| 生产 StateStore | `~/.flywheel/teamlead.db` | **1.7GB**;session_events 表 798MB + 索引 ~520MB;sessions 2,439 行(非终态 183);lead_events 88,494 行 |
| 代码 | `packages/teamlead/src/bridge/{gate-poller,lead-inbox-loop,founder-reply-deliverer}.ts`,`packages/flywheel-comm/src/{mailbox-queue,db}.ts` | 现行 main(worktree flywheel-FLY-2008 基于 5940f4220) |

## 2. cpuprofile 热点定位(issue scope ①)

分析方法:按 callFrame 聚合 self time 与 inclusive time(脚本临时,~654 samples/35s 窗口)。多份 profile 交叉验证,取 `13:54:03/max12432`(含 64s founder-reply-deliver span)为代表:

### 2.1 inclusive 排行(35s 窗口)

| 占比 | 帧 | 定性 |
|---|---|---|
| 44.2% | `sqliteTransaction`(better-sqlite3) | 同步 SQL 总闸 |
| 41.8% | `tick @ bridge/lead-inbox-loop.ts` | **CPU 支配路径** |
| 34.4% | `processTimers` / 28.4% `listOnTimeout` | 到期定时器批量串联(机制 2) |
| 28.5% | `releaseExpiredLegacyPushClaims @ mailbox-queue` | 全表 SCAN(§3.1) |
| 12.9% | `claimBridgeProtocol @ mailbox-queue` | 全表 SCAN + TEMP B-TREE(§3.2) |
| 6.9% | `readFileUtf8` | 同步读文件(次要) |
| 5.3% | `emitFounderReplyDeliveryForThread @ founder-reply-deliverer` | deliver pass 自身 |
| 3.8% | `CommDB` 构造(`openReadonly` 506MB 库) | deliver pass per-Lead 重开 |
| 3.7% | `getPendingQuestions @ db.ts` | view 全扫(§3.3) |
| 2.4% | `commDbFactory @ founder-reply-deliverer` | 同上 |
| ~5% | codex-daemon-client / CodexTmuxAdapter | runner 管理(不属本单) |

self time 由 better-sqlite3 原生 `get`/`all`/`run` 支配(多份 profile 合计 55–60%)——CPU 真正烧在同步 SQL 里。

### 2.2 关键推论

1. **founder-reply-deliver 的 70s wall 里,自身 CPU 只占 ~15%**(5.3+3.8+3.7+2.4%);支配项是 LeadInboxLoop 的同步 SQL(机制 1)与 117 次串行 Discord GET 的 wall(机制 3)。它是「受害者 + 次要加害者」。
2. **单段 5–12s 阻塞 ≠ 单条慢 SQL**。单条最重查询实测仅 ~22ms(§3);连续段由 `listOnTimeout` 在一个 macro turn 里串联执行堆积的到期回调形成(`processTimers` 34–56% inclusive 佐证)。这解释了 max_ms(5–12s)与 span(70s)的量级差。

## 3. 全表扫描逐条定罪(生产库只读 EXPLAIN QUERY PLAN)

`mailbox` 表现有 partial index 是按精确谓词建的(如 `mailbox_claim_bridge ... WHERE carrier='inbox' AND state='QUEUED' AND recipient_kind='bridge'`)。肇事查询都带 **OR 谓词**,SQLite 的 partial-index 定理证明器无法从 `(state='QUEUED' OR (state='LEASED' AND ...))` 推出任何单一索引的 WHERE 成立 ⇒ 回落全表 SCAN。

### 3.1 `releaseExpiredLegacyPushClaims`(mailbox-queue.ts:1269)— LeadInboxLoop 每 tick 调用

```sql
UPDATE mailbox SET recipient_kind='lead'
WHERE to_agent=? AND type='instruction' AND carrier='inbox'
  AND recipient_kind <> 'lead' AND batch_id IS NULL
  AND (state='QUEUED' OR (state='LEASED' AND claimed_by='legacy-push'))
```
EQP: **`SCAN mailbox`**。实测(SELECT 等价谓词,100 次均值):**~22ms/call**。

> 🔴 **更正(对抗评审 BLOCKER,已亲核实锤)**:本节初稿写「后续两条命中 `mailbox_lease_expiry`,无罪」——**对第二条(`SELECT id ... ORDER BY seq LIMIT ?`)是错的**。错因=探针形态:我用字面量(`<= 'now' ... LIMIT 10`)测 EQP 得 SEARCH;生产 bound 形态(`<= ? ... LIMIT ?`)实测是 **`SCAN mailbox`,35ms/call**(rowid-order LIMIT 陷阱:`ORDER BY seq`=rowid 序,planner 偏好免排序全表扫)。第三条(remaining 探测,无 ORDER BY)确实命中索引。修法与守卫见 plan §3.1 A2b。**教训:EQP 探针必须与生产语句同形(bound parameters),字面量替身会得到不同计划。**

### 3.2 `claimBridgeProtocol`(mailbox-queue.ts:2233)— LeadInboxLoop 每 tick 循环调用直到空

```sql
SELECT * FROM mailbox
WHERE recipient_kind='bridge' AND carrier='inbox'
  AND from_agent=? AND msg_class='protocol'
  AND (next_retry_at IS NULL OR next_retry_at <= ?)
  AND (state='QUEUED' OR (state='LEASED' AND (claimed_by IS NULL OR claimed_by=? OR claim_expires_at < ?)))
ORDER BY priority, seq LIMIT 1
```
EQP: **`SCAN mailbox` + `USE TEMP B-TREE FOR ORDER BY`**。实测 **~22ms/call**。
注:现有 `mailbox_claim_bridge`(QUEUED)与 `mailbox_bridge_reclaim`(LEASED)两个 partial index **正是为这两个 OR 分支准备的**,只是 OR 合写让它们全部失效。

### 3.3 `getPendingQuestions`(db.ts:2645)— gate-poller 每 3s × 每 Lead + deliver pass 每 60s × 每 Lead

`mailbox_message_projection` 是 mailbox 上的 VIEW;查询 `to_agent=? AND type='question'` + NOT EXISTS 无对应索引。
EQP: SCAN(view 展开)。实测 **~20–30ms/call**。
NOT EXISTS 侧现有 `mailbox_unique_response ON mailbox(ref_id) WHERE type='response'` 可作 covering index——只缺 question 侧索引。

### 3.4 `countDeliverable`(mailbox-queue.ts:707)— LeadInboxLoop 每次调度(`nextDelayMs`)调用

```sql
... WHERE carrier='inbox' AND state='QUEUED' AND (... ) AND (? IS NULL OR to_agent = ?)
```
EQP: **`SCAN mailbox`**。bound-param OR(`? IS NULL OR to_agent=?`)在 prepare 时无法特化 ⇒ planner 永远选不了 to_agent 索引。

### 3.5 频率账(为什么 22ms 能吃满一颗核)

- LeadInboxLoop:`ACTIVE_LEAD_INBOX_INTERVAL_MS = 1_000`(有活 session 即 active;当前非终态 session 183 个)× 全舰 ~14 Lead loop;
- 每 tick 同步链:`recordTickStarted` → `acquireOrRenewOwner` → `reconcileExpiredLeases` → **releaseExpiredLegacyPushClaims(22ms SCAN)** → **claimBridgeProtocol(22ms SCAN,循环至空)** → `claimLeadBatchQueue` → … → **countDeliverable(22ms SCAN)**;
- 仅三条 SCAN 就 ≈ 66ms × 14 Lead × 1Hz ≈ **0.9 秒 CPU / 秒**,循环饱和 ⇒ 定时器堆积 ⇒ 机制 2 的串联段。gate-poller(3s)每 Lead 的 getPendingQuestions 再加一层。

## 4. 修复形态验证(在 506MB 生产副本上,非生产)

| 修复 | 改动 | EQP 后形态 | 实测 |
|---|---|---|---|
| A1 `claimBridgeProtocol` | 拆 OR 为 QUEUED / LEASED-reclaim 两条 SELECT(各取 top-1 再合并),**零 schema 改动** | 各自 `SEARCH ... mailbox_claim_bridge / mailbox_bridge_reclaim (from_agent=?)` | 22ms → **0.01ms** |
| A2 legacy-push 收编 UPDATE | 新 partial index `mailbox_legacy_adopt ON mailbox(to_agent) WHERE carrier='inbox' AND type='instruction' AND batch_id IS NULL AND recipient_kind <> 'lead'`(谓词**不含 state 项**——含 `state IN (...)` 的版本证明器推不出、仍 SCAN,已实测排除) | `SEARCH ... mailbox_legacy_adopt (to_agent=?)`(索引命中行 1,065) | 22ms → **0.03ms** |
| A3 `getPendingQuestions` | 新 partial index `mailbox_questions_by_recipient ON mailbox(to_agent, created_at) WHERE type='question'` | `SEARCH (to_agent=?)` + NOT EXISTS 走现有 `mailbox_unique_response` COVERING | SCAN → SEARCH |
| A4 `countDeliverable` | 拆成带/不带 toAgent 两条 prepared;新 partial index `mailbox_deliverable_by_agent ON mailbox(to_agent) WHERE carrier='inbox' AND state='QUEUED'` | 带 agent:`SEARCH (to_agent=?)`;不带:SCAN 小 partial index(当前 12 行) | SCAN(49,780 行)→ SEARCH |

partial index 维护成本:三个新索引的谓词命中行数分别为 1,065 / question 行数 / 12(当日),写放大可忽略。

## 5. founder-reply-deliver 的结构问题(cpuprofile 之外的代码事实)

`gate-poller.ts:2114 founderReplyDeliverPass`(每 20 tick ≈ 60s,`await` 在 `poll()` 主链):

1. **per-Lead 重开 506MB 库**:`for project → for lead` 内 `CommDB.openReadonly(dbPath)` + `getPendingQuestions` + `close`——同一 project 的多个 Lead 重复开同一个库(profile 中 CommDB 构造 3.8% + commDbFactory 2.4%)。
2. **per-Lead 重扫 StateStore**:`listNonTerminalSessions()`(183 行)× per-session `getChatThreadByIssue`(teamlead.db 1.7GB)每 Lead 各来一遍。
3. **117 个活 thread × 串行 Discord GET**(`emitFounderReplyDeliveryForThread` 每 thread 至少 1 次 `fetch`,GET_TIMEOUT 有界):~0.5s/个 ≈ 60–70s wall,与实测 span 64–73s 吻合。**cadence 60s < 用时 70s ⇒ 连续运行**。
4. **拖死整个 tick**:pass 被 inline `await` ⇒ 70s 内 question-relay、founder-reaction-approval、stale-approved-ship 等全部 rider 停摆——founder 密集回帖窗口「没人送话」的直接机制。
5. gate-poller `poll()` 有 `this.polling` 重入闩,不会自我叠加;但 5 个 sub-cadence pass 共用 `tickCount % N === 1` 的同一触发 tick,全挤在同一个 tick 里。

## 6. 旁证:本节点自身撞上活症状

设计节点开工时两次 `flywheel-comm stage set` 均报 `This operation was aborted`(CLI 2s 超时假失败,记忆库已有配方)——Bridge `/health` 正被同一机制饿死。与 HL/Cass 的外部实测(/health 8–33s)一致。

## 7. 不做什么(边界)

- **数据减肥**(mailbox 46,995 ACKED、mailbox_log 251MB、teamlead.db session_events 798MB)→ FLY-1998 清扫工具已 pending ship,解耦;本单修完查询计划后对表大小不再敏感。
- **Discord GET 并行化** → rate-limit 风险,wall 长不是病、阻塞才是;预算分片足够。
- **黑匣子仪表本身**(FLY-1995)零改动——它是验收的尺子。
- **心跳/监视器链路**(FLY-1613)零改动——心跳断联归零是相关性验收,不动那侧代码。

## 9. 机制演进定案(2026-08-23 14:0x–14:2xZ,Lead/Cass/HL 圆桌,权威链=Linear comment 树主评 aa494bf8)

本文 §1–§7 是设计节点开工时(13:57–14:05Z)的侦查快照。随后 Lead 侧圆桌用全天账本 + 活体秒级采样 + 代码收据把机制图景推进了数步,**以下为定案,覆盖前文相应表述**:

1. **定性升级:慢性病,非 founder 窗口事件**。黑匣子全天(07:01–13:5xZ)**696 段坏段,逐小时 93–109 段完全平坦,与 founder 活动无关**——issue 原文与本文 §1 的「founder 密集窗口」framing 只是初次抓拍的调制项,不是成因。span 谱系:`gate-poller.tick` n=2276 **max=158s**(主凶);`founder-reply-deliver` n=107 max=145s(全天每 ~4 分钟一轮、每轮 60–145s,不依赖 founder 活动 = 每轮都做无界工作);`heartbeat.check` n=50 max=73.8s;patrol 家族 26–76s。本文 §2–§5 的机制归因(LeadInboxLoop 全表扫描为 CPU 支配项 + deliver pass 117 thread 串行 GET)与全天账本相容,继续成立。
2. **心跳冻结与事件循环脱钩(A/B 拆成两病)**。HL 秒级采样实测:冻结窗内 Bridge HTTP 快、ELU 0.41(循环健康)心跳照冻 ⇒「循环挂 ⇒ 心跳陪葬」作为机制被证伪(本文 §1 引 issue 的该假设作废)。中途的「teamlead.db 写者锁车队」假设也已被代码收据杀死(全仓写事务=同步 transaction,持锁必挂循环,与健康块矛盾)。
3. **B 病定案(代码收据)**:重启幸存会话的 adapter 轮询链随旧进程死亡,心跳由 HeartbeatService **代写**(`HeartbeatService.ts:1257-1275`,FLY-623);冻结四具全部出生于 07:01Z 重启前,活跃体(有链)不受影响——**可证伪点:活跃体永不冻**。告警触发=`probeSessionLiveness` 返回 `indeterminate`(verdict switch;`minutesSince` 只打印从不比较,**「阈值/周期拉开」缓解被撤回令作废**)。`indeterminate` 三源:lookup error / probe 不明值 / **:909-911 catch 裸吞异常**——同源判定证据在产生一刻被毁,故 B 第一刀=该 catch 结构化取证。
4. **量的纪律**:9 次/天(去重 episode)vs 696 段/天(坏段)单位不可比,不得作同源先验;未去重探针失败数由第一刀埋点产出。
5. **验收改口径**:分档判读(归零/降而非零/无变化三档各有语义)+ **心跳间隔分布按活跃体/停驻代写族分开报**(停驻族分布测的是扫描器周期,修好 A 后变好看≠runner 变好);弃「告警归零」。

## 8-bis. 评审通道更正(自我修正留档)

本节点早先报告「Codex 5/5 profile 烧穿至 8/26」是**坏仪器结论**:per-runner CODEX_HOME 快照未随全局 `codex-profile use` 切换(它写 `~/.codex`,本 runner 的 codex 读自己的 home)——五次探的是同一账号,故 reset 时刻相同。经仓库版 `bin/flywheel-codex-profile use personal` + JWT email 验证 + `QUOTA_OK` 实测修复。Antigravity 评审按 founder 8-22 禁令作废(文件已改名 `HISTORICAL-NOT-CITED`),design gate 以真 Codex 轮为准,Claude 对抗评审保留为补充。

## 10-pre. 对抗评审更正汇总(除 §3.1 BLOCKER 外)

- **§3.4 频率账更正**:`countDeliverable` 不是「每次调度都跑」——`nextDelayMs` 先短路 `hasLiveSession()`(183 个活 session 下多数 active lead 不落到它),它主要以 idle lead 的 30s 节奏跑;仍是 SCAN、仍值得修,但频率贡献低于初稿估计。
- **§3.5 清点补漏**:`claimQueueBatch` 头查询(mailbox-queue.ts:1148-1175)今天在生产是裸 SCAN + TEMP B-TREE,健康态每 tick 都跑;事发窗 cpuprofile 低估它(拥堵时 frozen-batch 探测先短路——**测量窗偏差**)。A4 索引落地后顺带治好,plan §5.1 守卫钉住。
- **§5-1 数字更正**:founder-reply pass 的「pending questions 12 条」量错了谓词(12=QUEUED 行数);`getPendingQuestions` 实测 418 行,pass 内排除 report 380 + review-gate 2 后**有效 ~36 问/8 会话**。
- **§5-1 大头更正**:deliverer 每 thread 经 `deps.commDbFactory` 默认值开 **writer** CommDB(migrations + `purgeExpired`;生产 37,611 行超 72h retention 的 ACKED ⇒ 每次 open 都有归档写活干)——这才是 pass 自身 CPU 的主项,gate-poller 层的 openReadonly 是小头。

## 10. 会过期的结论

| 结论 | as-of | 重核命令 |
|---|---|---|
| mailbox 49,780 行 / comm.db 506MB | 2026-08-23 | `sqlite3 "file:$HOME/.flywheel/comm/flywheel/comm.db?mode=ro" 'SELECT COUNT(*) FROM mailbox'` |
| 活 thread 117 个 | 2026-08-23 | research 附录 §1 的 JOIN 查询 |
| 单条 SCAN ~22ms | 2026-08-23(506MB 时) | §3 各 SELECT 等价计时;FLY-1998 清扫后会变小(病灶仍在,只是更隐蔽) |
| 发作进行中 | 2026-08-23 14:00Z | `tail ~/.flywheel/diagnostics/event-loop-episodes.jsonl` |
| 现有 partial index 清单 | 2026-08-23 | `sqlite3 ... "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='mailbox'"` |
