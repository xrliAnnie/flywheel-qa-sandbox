# FLY-1764 大喇叭(lead_events 推送通道)整体重设计 — QA 报告

Issue: FLY-1764 (https://linear.app/geoforge3d/issue/FLY-1764/机制-大喇叭lead-events-推送通道整体重设计-先聊清设计再动手告警该投给谁要不要专用通道与邮局的关系)
日期: 2026-08-14
基于: plan.md / research.md / exploration.md / FLY-1764-design.html

## 0. 结论

**PASS**(1 条 LOW advisory,不阻塞)。

本单是 **Generic 设计讨论单,零产品代码**。交付物 = 三份技术文档 + 一份 founder 互动图解 HTML。
因此 QA 的对象不是「运行时行为对不对」,而是:

1. 这份设计**赖以成立的事实**在真代码/真生产库里是不是真的(设计文档的唯一价值就在这里);
2. founder 交付物**真的能用**(打得开、批注真能存、真能导出);
3. 交付物有没有**如实标出边界**、有没有回答 founder 真正问的三个问题。

三项均通过。被测 head = `ee58b1ea` = PR #836 head(报告与 progress 落账后 head 见 §7)。

## 1. 被测范围与 Discord 能力判定

- 分支 vs `origin/main` diff:**608 行全部在 `engineering/doc/FLY-1764-lead-events-redesign/`**,`packages/` / `scripts/` / config 零改动(`git diff --stat origin/main...HEAD` 实测)。
- ⇒ **无任何 Discord surface**(不改 send / relay / render / founder 交互 / roundtable / 跨 Lead 协调),按 QA 合同**明确豁免 529 QA Room 的 N-to-N 真机跑**,不是省略。
  替代的真实检查 = 逐条事实核验(§2)+ founder HTML 真浏览器行为验证(§3)。
- 运行时零影响:本 PR 合入后生产行为逐字不变(没有可执行代码被改)。

## 2. 事实核验账(独立复核,非复述作者结论)

方法:不看作者的引用,自己按 file:line 打开代码、自己查生产库。共 **27 条**载重论断,**全部 CONFIRMED**。

### 2.1 「lead_events 今天不是投递通道」(research §1)

| # | 论断 | 核验结果 |
|---|---|---|
| 1 | `deliveryAckEnabled()` 硬返回 false | ✅ `bridge/lead-event-ack-policy.ts:8-12` 返回类型就是字面量 `false` |
| 2 | `ackPolicyForLeadEvent()` 无条件 return null | ✅ 同文件 :20-32,三个入参全 `void` 掉后 `return null` |
| 3 | `runLegacyCutover` 启动 cutover 未接线 | ✅ 全仓 grep:仅 `lead-inbox-runtime.ts:61/586` 定义与调用点,**非测试构造处零传入**(plugin.ts 完全不提该名字) |
| 4 | `getUndeliveredLeadEventsForReconcile` 零非测试调用方 | ✅ 全仓 grep:定义在 `StateStore.ts:14011`,其余 5 处命中全在 `__tests__/` |
| 5 | 建表位置 + UNIQUE 去重锁 | ✅ `StateStore.ts:2978` CREATE TABLE;`:3016` `idx_lead_events_dedup ON lead_events(lead_id,event_id)`;`appendLeadEvent` 在 `:10450`(逐字命中) |

### 2.2 「大喇叭物理位置只有一处,且绕开 lead_events」(research §2)

| # | 论断 | 核验结果 |
|---|---|---|
| 6 | `broadcastLoadShed()` 遍历全部 leadId 逐个 notify | ✅ `fleet-sensors.ts:366-386`,dedupeId 逐字 = `swap-broadcast:${episodeId}:${leadId}` |
| 7 | 受众 = 所有 project × 所有 lead | ✅ `bridge/plugin.ts:9428` `listLeadIds: () => [...leadProjectByAgentId.keys()]`,该 Map 在 `:9341-9344` 遍历 `projects` × `p.leads` 构建 —— 字面「见者有份」 |
| 8 | 落地 = `notifyLeadInstruction` → 各项目 comm.db,72h TTL 硬编码 | ✅ `plugin.ts:9345-9366` → `insertInstruction`;TTL 在 `flywheel-comm/src/db.ts:2178` 硬编码 `72*60*60*1000`(引用行号逐字命中) |
| 9 | 告警腿与广播腿在同一到期点**双发** | ✅ `fleet-sensors.ts:345-354`:先 `this.deps.alert(...)`,再独立 `await this.broadcastLoadShed(...)` |

**关键数据实证(生产库只读,2026-08-14 02:xx 查)** —— 我自己重跑,不采信作者数字:

```
flywheel: 5   geoforge3d: 3   growth: 3   tidal-echo: 3   joycon-typeless: 1   personal-assistant: 1
= 16 个收件 Lead / 6 个项目          (~/.flywheel/comm/*/comm.db, id LIKE 'swap-broadcast:%')
```

**逐项目、逐数字与文档完全一致**。总行数 48 = 16 Lead × 3 个 episode;同期 `lead_events` 里 `swap_pressure_high` 恰好 3 条 —— 「1 条事件 → 16 份邮箱行」实锤。

### 2.3 「load-shed 动作已机制化,广播只是 FYI」(research §4 / plan §1.2)

| # | 论断 | 核验结果 |
|---|---|---|
| 10 | ARC = 可逆 pressure-hold + per-Lead notify,水位回落自动解除 | ✅ `fleet-sensors.ts:10` 注释逐字;`:13` "watermark falls below LOW → hold lifted + quiet resolve" |
| 11 | 广播文案的两个动作请求 | ✅ `loadShedText` `:531-543` 逐字:「请降载:暂缓新任务、考虑收掉可暂停的 runner」+ `holdClause` `:515-525`「pressure-hold 已于压力确认时刻置位(新 runner 派发已暂停)…自动解除」 |
| 12 | **全仓无任何 Lead rule/prompt 依赖 `[fleet-alert]` / `swap-broadcast` 执行控制动作** | ✅ 全仓 grep(排除 node_modules/dist):`[fleet-alert]` 只有两个**生产者**(`fleet-sensors.ts:542`、`server-loss.ts:452`),`packages/teamlead/lead-rules-base/` 内 `fleet-alert` / `load-shed` / `降载` **零命中** —— 消费侧确实是空的,砍掉不会让任何 Lead 少做一个动作 |

### 2.4 「专用告警频道已存在」(plan §1.1)

| # | 论断 | 核验结果 |
|---|---|---|
| 13 | unified 频道优先,fleet 身份必落 unified | ✅ `LeadAlertNotifier.ts:1484-1492` `resolveChannel` 第一分支即 `unifiedAlert.channelId` |
| 14 | 告警队列 cap = 500 条 / 3 天,超出/超龄进 dead-letter | ✅ `DEFAULT_QUEUE_MAX = 500`(:676)、`DEFAULT_QUEUE_MAX_AGE_MS = 259_200_000 // 3 days`(:677);cap 淘汰 `:1165-1172`、超龄淘汰 `:1193-1199`,均 `moveQueueFileToDeadLetter` |
| 15 | unified 每分钟根消息配额溢出 → 入队而非丢弃 | ✅ `:938-955` `rateLimiter.tryAcquire` 失败 → `enqueue(payload,"rate-limited")` → 返回 `queued_durable` |
| 16 | **部署 gate ①**:fleet 假身份 `leadId='swap'` 在 unified 缺位时**不回退到任何 Lead,直接 dead-letter** | ✅ `fleetIdentityDeliverable()` `:826-836` 要求 unified channel **且** 可解析 sender token;`alert()` `:838-855` 不满足即 `deadLetter(payload,"unknown-lead")` —— 这条「不修好告警腿就砍广播 = 把糟糕双路变脆弱单路」的前提是真的 |

### 2.5 邮局双消费者 / 刷屏机制(research §5)

| # | 论断 | 核验结果 |
|---|---|---|
| 17 | 腿 B 读的是**投影视图**,查询**不带 state 过滤** | ✅ `db.ts:3335-3349` `getPendingPushInstructions` 读 `mailbox_message_projection`,条件只有 `type/read_at/delivered_at/expires_at` —— **DEAD/ACKED 物理行照样被返回**(FLY-1748 根因成立) |
| 18 | `markInstructionDelivered` 只从 QUEUED 迁移 | ✅ `db.ts:3351-3358` `WHERE id=? AND type='instruction' AND state='QUEUED'` |
| 19 | 由此「首投后重新满足 push 查询」 | ✅ 视图定义 `mailbox-schema.ts:145-147`:`delivered_at = CASE WHEN state='LEASED' THEN claim_expires_at WHEN state='ACKED' THEN acked_at END`;`read_at = CASE WHEN state='ACKED' THEN acked_at END` ⇒ 行一旦被腿 A 判 DEAD,两列同时变 NULL → **每次 poll 都重新命中**。文档描述的机制**逐环成立** |
| 20 | 腿 B 1 秒一 poll | ✅ `inbox-mcp/src/index.ts` `POLL_INTERVAL_MS = 1000` |

### 2.6 实现拆单的精确刀口(plan §4)—— 这部分最容易写飘,逐条查了

| # | 论断 | 核验结果 |
|---|---|---|
| 21 | `RepairOutcome` 今天是**二值** union | ✅ `AutoRepairBot.ts:27` `"attempted" \| "needs_human"` —— 加第三个成员确实不会自动报错 |
| 22 | `AlertChannelHub` 的 `repair.outcome` 消费点 = `:489 / :549 / :555 / :866` | ✅ **四个行号逐字命中**;其中 `:549` 是 `repair.outcome === "attempted" ? "attempted" : "needs_human"` —— 新增 `no_action` 会被**静默映射成 needs_human 并 @ founder**,plan 警告的正是这个真洞 |
| 23 | 今天不存在 `MONITORING` 票据状态 | ✅ 全仓非测试代码 `MONITORING` **零命中** |
| 24 | 若不显式处理,`MONITORING` 会掉进 `NEW` 的 unclaimed fallback | ✅ `ticket-escalation.ts:88-118`:非 RESOLVED/ESCALATED 且非 REPAIRING/ACK 的状态直落末尾 `if (ownerConfigured && age > policy.unclaimedMs) return "escalate"` —— **5 分钟就升级**,而不是 30 分钟。plan 要求的显式分支是必要的,不是防御性辞令 |
| 25 | swap 升级窗 = 30 分钟;默认 unclaimed = 5 分钟 | ✅ `policyForKind` `:57-65` swap `timeoutMs = 30 min`(env `FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN` 可覆盖)+ `retryOnReconcile:false`;`DEFAULT_TICKET_ESCALATION_POLICY` `unclaimedMs=300_000`。founder HTML 写的「最坏 30 分钟升级到你」成立 |
| 26 | `swapPressureRepair` 三条分支今天全 `attempted` + 全调 `broadcastLoadShed` | ✅ `fleet-sensors.ts:463-503` 逐字:`sensorHoldMatches` / `monitorMatches` / 兜底三条都 `outcome:"attempted"`,detail 里都写了「已补发降载广播」——砍腿后这三句叙述确实会变成假话,plan 的收口要求成立 |
| 27 | cutover 用 `commDbRootDir()` 全盘扫描、保留两个 env 覆盖 | ✅ `bridge/commdb-path.ts:19-23`:`FLYWHEEL_COMM_ROOT` → `FLYWHEEL_COMM_DIR` → `~/.flywheel/comm`。**且我实测磁盘上确有 `sub` / `qaproj` / `proj` 等目录**,「不得只枚举当前 Bridge projects 配置」是有真实落点的要求,不是空话 |

### 2.7 已写代码盘点(plan §3)

| 论断 | 核验结果 |
|---|---|
| PR #829 = 42 行产品代码 | ✅ `gh pr view 829`:`db.ts` **+25/-17 = 42**,其余是 doc + 测试。状态 OPEN |
| PR #834 = 40 文件 / +2837 | ✅ `gh pr view 834`:**40 files,+2837/-101**,逐字命中。状态 OPEN |
| `legacy-swap-broadcast-retirement.sh` / `retractLoadShedBroadcasts` **不在 main** | ✅ 本分支(= origin/main + 文档)全仓 grep **零命中**,脚本文件不存在。「只可提取思路,不可当现成能力」是诚实的 |

### 2.8 流量普查复核(research §6)

我在 2026-08-14 08:xx 重跑 48h 窗口(作者约 00:xx 跑的),`lead_events` 总行 81434(作者 81306,自然增长)。

- **载重结论独立成立**:全窗口**每一个** event_type 的 `COUNT(DISTINCT lead_id)` 都 ≤ 2,唯一例外是 `mailbox_dead_letter` = 16 —— 而它是「每个 Lead 收自己的死信」,不是一条事件扇出。⇒「见者有份的广播只有 fleet broadcast 一族」**成立**。
- 计数差异(如 `workflow_engine_escalation` 1558 → 684)是滚动窗口早段老化所致,**收件 Lead 数逐行一致**,不影响任何结论。
- 文档表格只列了 9 类,我复核的是**全量**(另有 `gate_question` 91 / `session_started` 89 / `review_advisory_pass` 68 等)—— 这些遗漏项全部 ≤2 Lead,**不改变结论**,但文档未声明该表是节选。

## 3. Founder 交付物真机验证(Claude-in-Chrome,真浏览器)

被测:`FLY-1764-design.html`(58,460 bytes),经本地 http 起服后在真 Chrome 打开。

| 检查 | 结果 |
|---|---|
| 打得开、无外部依赖 | ✅ 零 `http(s)://` 外链;2 张 Mermaid 图已**预渲染成内联 SVG**,无 mermaid fence 残留 |
| 模板陷阱(`{{...}}` 占位、假样板句) | ✅ `grep -c '{{'` = **0**;`report-template.html` 残件已在 `7edfd471` 删除 |
| Apple 浅色主题 | ✅ 实测 `getComputedStyle(body).backgroundColor` = `rgb(245,245,247)` = `#f5f5f7`;无 `prefers-color-scheme` 分支 |
| 每节评论框 | ✅ 7 个 `<textarea data-key="s0..s6">`,对应 7 个小节 |
| **批注真的能存**(真键盘输入 → 真刷新) | ✅ 在 s0 真打字 `QA-PROBE-1764 persistence check` → 整页 reload → **原文仍在**,localStorage key `fly1764-comments:v1:s0` |
| 实时汇总 + 导出 | ✅ 刷新后底部「📋 你的全部批注」自动出现 `【0 一句话结论】QA-PROBE-1764 persistence check`,配「复制全部批注」按钮 |
| 跨路径不丢批注 | ✅ `7edfd471` 已把 PREFIX 从 `location.pathname` 改成固定 `v1:` —— 我的测试恰好是从 `http://127.0.0.1` 打开的(与 Annie 可能用的 `file://` 不同源路径),旧写法会丢,新写法不丢 |

**产品可用性判断(不只是技术正确)**:7 节结构 = 结论 / 事实 / **三问三答** / 提案后的世界 / 1748-1749 取舍 / **三个拍板点** / 诚实边界 —— 逐条对上了 founder 8-13 晚提的三个问题和「1748/1749 怎么办」,并且每个答案都用她自己的原话起头。语言是产品语言不是工程黑话(把「上下文窗口」「owner」「必达/最新值」都做了通俗解释)。**§5 明确列出需要她拍板的三个点**,这是这份讨论稿真正的交付面。

**plan ↔ founder HTML 一致性**:最后两个 commit(`ee58b1ea` / `7edfd471`)专门把 review 新增的 `no_action` scope 与「配额溢出」诚实代价同步进了 HTML,两边**不存在漂移**。

## 4. 数字抽查(founder 可见的每个数字都查了)

| HTML 里的数字 | 核验 |
|---|---|
| 「复制成 16 份 / 6 个项目」 | ✅ 生产库实测逐项目一致 |
| 「PR #829 = 42 行」「PR #834 = 2837 行」 | ✅ gh 实测一致 |
| 「最多存 500 条 / 3 天」 | ✅ 代码常量一致 |
| 「最坏 30 分钟升级到你」 | ✅ `policyForKind` swap = 30 min |
| 「调研结论(21 个业界来源)」 | ✅ `/tmp/dr-final-1751.md` 实测 **21 个唯一 URL** |
| 「Codex design review 3 轮 APPROVED」 | ✅ 与 commit 历史 + plan 内 R1-1..R1-5 / R2-1..R2-2 引用一致 |
| 「事件账本里 16 个休眠列」 | ⚠️ **见 §5 advisory** |

## 5. Advisory(LOW,不阻塞)

**A-1 · 休眠列数目与表宽度不准(founder 可见)**

- 出处:`research.md §1`「27 列」「16 个 ack_* 列」;`plan.md §5`「16 个休眠 ack 列」;**`FLY-1764-design.html §6`「不顺手清理事件账本里 16 个休眠列」**。
- 实测(`StateStore.ts:2978-3007` 建表 + 生产库 `PRAGMA table_info(lead_events)` 双向核对):
  - 总列数 = **28**(文档写 27);
  - 严格 `ack_*` 前缀列 = **10**(`ack_required / ack_policy / ack_protocol_version / ack_deadline_at / ack_token_valid_until / ack_token_consumed_at / ack_owner_lead_id / ack_owner_epoch / ack_retired_at / ack_retired_reason`);算上 `acked_at` = 11;
  - 若按「整套休眠的投递/ACK 记账列」宽口径(再含 `delivered_at / delivery_attempts / last_delivery_error / dead_letter_pending_at / dead_lettered_at / ingress_disposed_at / pending_delivery_reason / page_claim_token / page_claim_lease_expires_at / routing_snapshot`)= **20**。
  - **16 在任何一种数法下都对不上。**
- 影响:**零**。这句话出现在「本设计**不做**什么」的排除项里,没有任何结论依赖它;设计的取舍、刀口、验收全不受影响。
- 但它是 **founder 可见文本里的一个可证伪数字**,建议改成「10 个 `ack_*` 休眠列(连同整套休眠投递记账列共 20)」或直接写「一批休眠列」。三个文件各改一处,纯文案。
- 我没有代改(QA 只写报告)。建议:**不阻塞本单 ship,由实现单顺手带走**,或 Lead 决定是否要求作者现在改一行再合。

## 6. 我没测什么(诚实边界)

- **没有跑 529 QA Room 的真 Discord N-to-N** —— 本 PR 零可执行代码改动,不存在任何 Discord surface(§1 已证)。这是**豁免**不是遗漏。
- **没有验证「设计提案将来实现出来会不会好用」** —— 这超出本单范围(本单红线就是「先聊清设计,不写代码」)。我验的是:提案赖以成立的每条事实是真的、提案的实现刀口指向的代码位置是真的、founder 能真的读到并批注它。
- **没有替 Annie 判断设计对不对** —— 三个拍板点(α/β 合同、owner 缺席 SLA、拆单节奏)是给她的,不是 QA 能代答的。
- **单元测试/构建**:未新增未改动,CI 由 PR #836 的 9/9 job 覆盖(全绿,实测)。本单没有值得我另跑的产品测试面。
- **计数差异归因**:§2.8 里 `workflow_engine_escalation` 的 1558→684 我归因为滚动窗口老化,**这是推断不是实测**(我没有作者当时那一刻的快照)。载重结论(收件 Lead 数)是我自己全量重跑的实测。

## 7. 门与 head

| 门 | 结果 |
|---|---|
| PR #836 状态 | OPEN,**非 draft**,`mergeable=MERGEABLE` / `mergeStateStatus=CLEAN` |
| CI | **9/9 全绿**(CI OK / NPM payload / Quick Gate / Script Tests / Unit ×5) |
| 产品代码改动 | **零**(608 行全在 `engineering/doc/FLY-1764-*`) |
| 被核验 head | `ee58b1ea04130ae84c016140bcdb4d929d2cb27b`(= PASS 前 `git fetch` 复核过的 PR head) |
| 本报告与 progress 落账后 head | 见 verdict summary(报告提交后推送,与 PR head 对齐后再发 verdict) |

## 8. 判定

**PASS** —— 设计提案的每一条载重事实独立复核为真(27/27),founder 交付物真机可用且与技术稿无漂移,边界如实标注,零产品代码风险。唯一 advisory(休眠列计数)属文案级、零结论影响,已在 §5 点名交给 Lead 处置。
