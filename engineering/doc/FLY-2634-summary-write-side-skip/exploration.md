# FLY-2634 summary 写侧省量 — 探索
Issue: FLY-2634 (https://linear.app/geoforge3d/issue/FLY-2634/summary写侧省量-无实质变化不生成周期摘要避免唤醒-lead-只为交空报告)
日期: 2026-09-16
基于: 无

## 0. 一句话

每个 6 小时 slot，Bridge 无条件给全部 11 个 producer Lead 投 `summary_due`，10–11 个 Lead 因此被唤醒一整轮，其中只有 3–5 个真的有东西可交；剩下的要么沉默（唤醒白花），要么写一份「窗口本身为空」的摘要（Raya 还要读）。根因是第一拍没有任何「这个项目在本 period 有没有被观测到变化」的门，而 Bridge 手里其实已经有足够的证据来判断。

## 1. 现状审计（全部本机实核，2026-09-16 16:50–17:10 UTC，只读快照）

### 1.1 钟与名单：无活动门控 —— 证实

`packages/teamlead/src/bridge/summary-absorption-rider.ts` `runSummaryDueFirstBeat`：
- 每 slot 第一拍，`listSummaryDueRows(slotStart)` 为空 ⇒ `resolveSummaryProducers(projects, granularity)` 取全部有 summary 职责的 Lead ⇒ 一个事务写 N 行 `summary_due` ⇒ 逐行 `inspectDeliveryState` 为 `absent_identity` 就 `enqueueLeadEvent`。
- 全过程唯一的输入是名册与 gh 账本（`last_delivered`），**没有任何「本 period 该项目有没有事」的判断**。

Lead 侧文本（`hook-payload.ts` `formatSummaryDue` 第 3 条、`lead-rules-base/summary-inflow.md` "The due signal"）说「没有新事实与判断可以不交（PRD §6.3）」，但这个决策发生在 Lead 已被叫醒、读完整套规则和上下文之后 —— **成本已经花掉**。FLY-2382 计划 §5 L6 明确否决了「本轮无更新」回执通路，理由是「沉默是一等信号」；这条在当时是对的，但它只解决了「不催」，没解决「不叫」。

### 1.2 生产数据：唤醒与交付的差额（`~/.flywheel/teamlead.db` 只读副本）

最近 7 天 27 个 slot：

| 指标 | 每 slot | 说明 |
|---|---|---|
| `summary_due` 行 | 11 | 名册固定 11 人 |
| 实际投递（`delivered_at` 非空） | 10–11 | 即被唤醒的 Lead 数 |
| 实际交付的 summary PR | 3–5 | `summary_slot_settled.delivered_count` |
| Raya `summary_absorption_round` | 1（自 09-15 Raya 激活起） | 09-15 前 `resolveRaya` 为空、slot 走 DEGRADED 日志；之后每个已结算 slot 一轮（5 轮 / 6 slot） |

按 Lead 看（7 天 27 slot）：flywheel-eng-lead / flywheel-product-lead 27/27 被投递且几乎每轮交；geoforge3d product-lead 27/27 被投递、**每轮都交**；ops-lead / sub-lead 多数轮交；belle / joycon / mufasa / rafiki / reflection / tidal-echo-content 26–27 次被投递、7 天里各交 0–2 次。

也就是说每天 4 个 slot × 约 7 个「叫了没事」的 Lead ≈ **每天 24–32 次纯浪费的 Lead 完整工作轮**（每轮都要重新装载 Lead 规则与记忆上下文）。

### 1.3 摘要内容样本：空窗口 + 自指 —— 证实 founder 的观察

Raya 仓 `xrliAnnie/raya` 最近 200 张 PR 里 144 张是 summary PR。抽读 geoforge3d product-lead：
- #145（09-15 05:00→11:00 PT）：开头 "**The window itself is empty.** Active sessions 0, pending runner questions 0, `origin/main` still `c2f40de4` (08-29) … The only repo event in it was my own summary PR #142"。
- #159（09-15 23:00→09-16 05:00 PT）："a fifth consecutive period with nothing of its own" ，正文是「Raya 审了我上一份摘要并给出两处订正」。

这正是 issue 描述的自激循环：摘要 PR 本身 → Raya 审阅/提问 → 下一轮把「被审阅」当作本期事实再写一份。内容质量不低，但它不是项目变化。

对照：flywheel-eng-lead #157 同一 period，是真实增量（5 张 ship 卡、班车事故、磁盘线）。joycon-lead #161 是 FLY-2633 一次性基线（`period` 为零长度快照点 `2026-09-16T16:32:29.486Z/2026-09-16T16:32:29.486Z`），由 Raya 的一条 Discord 消息触发、走 `flywheel-comm summary` 直接交付，**与 `summary_due` 无关**。

### 1.4 Bridge 已经能观测到的「有没有事」证据 —— 三个来源，都在进程内可读

**来源 A：StateStore `lead_events`（按 `lead_id`）。** 最近 48 小时，除 `summary_due` 外：
- flywheel-eng-lead：runner_question 1589、stage_changed 516、workflow_engine_escalation 260、gate_question 246、session_started 151、founder_reply 46、epic_intake 16 …
- flywheel-product-lead：runner_question 47、patrol_tick 41、founder_reply 27 …
- **product-lead / ops-lead / mufasa / rafiki / reflection / joycon / belle / sub / tidal-echo-content：零行。**

**（审计数据，v3 不作为来源）StateStore `sessions`（按 `project_name`）。** 最近 7 天有 Runner 会话的项目只有 flywheel（447 行）；其余六个项目零行 —— 与来源 A 的 `session_started` 零行一致。

**来源 C：每项目 CommDB `mailbox`（`~/.flywheel/comm/<project>/comm.db`，按 `to_agent`）。** 72 小时内投给静默 Lead 的消息，`from_agent` 只有三类：
- `bridge`（`summary_due`、`ack_batch`）—— 机制本身；
- `discord:<botUserId>`（`source_kind=discord_chat`）—— 其它 Lead bot 在共享频道的发言。核对 `projects.json` 的 `botUserId`：`1542068543645024257` 是 Raya、`1516205086890786917` 是 Aunt Cass、`1516207680836866219` 是 Tadashi、`1523215538820612206` 是 Honey Lemon。product-lead 72 小时收到 Raya 10 条、Tadashi 7 条、Honey Lemon 5 条 —— **就是 1.3 里那场关于摘要的互审**；
- `founder`（`source_kind=discord_chat`）—— founder 本人在 Discord 对该 Lead 说话。72 小时内只有 belle-lead 收到 5 条（09-15 16:36Z 前）；flywheel 三个 Lead 收到 233/36/16 条。

结论：**「founder 亲自说了话、Runner 动了、Bridge 给这个 Lead 推了业务事件」三件事，静默项目 48–72 小时里一件都没有；它们唯一收到的是钟本身和 bot 之间关于摘要的对话。** 这三个来源足以区分「有事」与「没事」，且都不需要新 daemon、不需要调 LLM。

### 1.5 时间戳格式（写探针时必须处理的事实）

| 表.列 | 格式 | 样例 |
|---|---|---|
| `lead_events.created_at` | `YYYY-MM-DD HH:MM:SS`（UTC，无 `Z`） | `2026-09-16 12:00:07`（与 mailbox 的 `2026-09-16T12:00:07.000Z` 同一瞬间） |
| `sessions.started_at` | 主要 `YYYY-MM-DD HH:MM:SS.sss`（UTC）；少量 19 位 | `2026-09-16 16:48:51.600` |
| `sessions.last_activity_at` | 三种混用：19 位、23 位、24 位 ISO `Z` | `2026-09-16T14:05:16.176Z` / `2026-09-16 16:49:32` |
| `mailbox.created_at` | ISO 8601 `Z` | `2026-09-16T12:00:07.000Z` |

窗口比较必须先把三种写法归一到 epoch 毫秒，不能用字符串比较。

### 1.6 Raya 读侧的成本结构

Raya 每 slot 收一轮 `summary_absorption_round`，逐 PR review / merge / 追问 / memory provenance（FLY-2619 v2 呈现组）。读侧成本与**交付的 PR 数**成正比，与「未交名单」长度基本无关。所以 geoforge3d 类「空窗口摘要」是 writer 与 reader 双端浪费；growth 类「叫醒后沉默」只浪费 writer。两种都要治，治法在写侧同一处。

另外：一个 slot 若 0 张 PR 交付、也没有投递故障，Raya 仍会收到一轮事件并被唤醒做 begin/record/finalize —— 这也是「唤醒只为交空报告」，只是主角换成 Raya。

### 1.7 已有机制里可以直接复用的东西

- GatePoller rider 单飞（`createSummaryAbsorptionPass`）—— 门就挂在第一拍里，不加定时器。
- `StateStore.appendSummaryDueRows` 已是单事务；`listSummaryDueRows` 按 slot 精确匹配。
- `summary_slot_settled` 冻结行 + `classifyRound` —— 三分法（delivered / undelivered / unknown）已在，只差第四态。
- `CommDB.openReadonly(commDbPathForProject(project))` —— patrol orphan sweeper 已经这样按项目只读打开 CommDB（`plugin.ts`），探针照抄。
- 管理台 flag 注册表（`packages/config/src/feature-flags/registry.ts`）—— 可以给门加一个 kill-switch，回滚不用重部署。
- 一次性基线（FLY-2633）走 Raya 消息 + `flywheel-comm summary` 自定义 period，本单不碰它。

## 2. 问题定义

1. **第一拍没有证据门**：名册 = 应叫名单，把「有职责」等同于「本轮有事」。
2. **「可以不交」的判断落在了错误的一侧**：让 Lead 在被唤醒后判断，等于永远先付钱再决定要不要买。
3. **机制流量没有被排除在「活动」之外**：摘要 PR、Raya 的审阅提问、`summary_due` 本身，在 Lead 眼里都是「本期发生的事」，于是产生自激。
4. **结算只有三态**：`delivered / undelivered / unknown` 之外没有「有依据的无变化跳过」，所以任何写侧省量都会被记成「未交」，进而污染 Raya 的轮报与告警。

## 3. 方案空间

### 3.1 方案 A（建议）· 第一拍加「观测到变化」门，四态结算，空轮不叫 Raya

- 第一拍对每个 producer 跑一次**活动探针**（窗口 = 本 slot 的 period，即 `[slotStart − cadence, slotStart)`）。v3 四本账（v1 曾含 `sessions` 表，Codex R2 证明其三列都可后写、`rowid` 会被 VACUUM 重编号，已放弃）：
  - A：该 Lead 的 `lead_events`，按显式分类表——业务事件（含阻塞检测，逐条）计、机制噪音与按类型的周期提醒不计、未知类型默认计；
  - C：该项目 CommDB `mailbox`（只读热表）投给该 Lead 的 founder 消息，以及其它 Lead bot `<@该 Lead>` 的派活消息（Lead 裁定）；Raya 的追问不计；
  - D：该项目 Linear 绑定范围内 issue 的新建 / state / parent / priority 变化（Lead 裁定；本机只有 flywheel 绑定）。
  - A 的游标是上一判定行自身的 seq（计数与写行同事务），C 的游标是 `sqlite_sequence` 分配序号 + 库实例标识；晚到的行下一轮补计；无游标、实例变更、序号回退、窗口不连续或超出热表保留期 ⇒ `unknown`（plan §2.1）。
- 结果三态：`active`（任一源命中）、`quiet`（全部来源可读、可证明完整且全为零）、`unknown`（任一源不可读）。**只有 `quiet` 才跳过**；`unknown` 与 `active` 都照旧投 `summary_due`。
- `quiet` 写一行 `summary_due_skipped` 到 `lead_events`（同事务、同 slot 身份、永不投递），带证据摘要；`active/unknown` 的 `summary_due` payload 附上探针摘要，Lead 一眼看到「本窗口观测：业务事件 12 · founder/派活消息 1 · Linear 变动 3」。
- 结算把 skipped 单列：`skipped_no_activity` 不进 `absent` / `undelivered`，不触发告警；Raya 轮事件的 `producers[]` 带 `disposition`。
- 若冻结结果里**没有任何交付、没有任何投递故障或未知**，不给 Raya 建轮（记 `raya_round: not_issued`），Raya 不被叫醒。
- 加一个 `bridge_global` kill-switch flag，关掉即回到今天的行为。

优点：零新进程、零新 LLM 调用、全部复用 rider/StateStore/CommDB/flag；证据可回放（每一行都记着判断依据）；未知不会被写成无变化。

### 3.2 方案 B · Lead 侧 `flywheel-comm summary --no-change` 回执 —— 否决

Lead 仍然要被唤醒才能回一句「无变化」，writer 成本一分不少；这正是 issue 明确说不要的「仅为回一句无更新而启动完整 LLM 工作轮」。FLY-2382 L6 的否决理由仍成立。

### 3.3 方案 C · 改 cadence 或按项目关职责 —— 否决

Founder 明令：不改六小时节拍来掩盖问题、不硬编码只允许某项目汇报。按项目关也无法自动在「静默转活跃」时恢复。

### 3.4 方案 D · 让 Raya 侧过滤空摘要 —— 否决

Writer 端的 token 已花；Raya 过滤只省 reader 端，而且要 Raya 再读一遍才知道是空的。

### 3.5 方案 E · 再加 git / Linear 探针 —— Linear 已按 Lead 裁定加入（v3），git 本版不做

「founder 直接 push 项目仓」在本版看不见（Lead 裁定继续排除）；「founder 直接改 Linear」由 v3 的来源 D 覆盖（仅限有 Linear 绑定的项目）。但今天的 Lead 若没被任何事叫醒，同样不会知道 git 直推；`summary_due` 事实上被当成了非 flywheel 项目的「巡逻」入口，而这正是 founder 要停掉的用法。探针接口按来源列表设计，将来加 git 源只是多一个 collector，不改结算；Linear 源已在 plan §2.2 D（零命中记 unavailable，绑定项目本版不 quiet）。

## 4. 边界与不做

- 不新建 cron / daemon / launchd；不改 cadence；不改 Raya 的呈现合同（FLY-2619）与读回执（merge）。
- 不给任何 Lead 永久免除职责；`quiet` 是逐 slot、逐 Lead 的判断，下一 slot 重新探。
- 不动一次性基线（FLY-2633）与 `flywheel-comm summary` 命令本身。
- 不回填历史 slot；已交付的空摘要 PR 不删不改。
- 不在本单解决「Lead 被叫醒后仍复述旧状态」的文风问题，只在规则文本里加一句「只写增量」。

## 5. 待 Lead / founder 的点（都不阻塞）

1. **产品边界确认（最小问题）**：founder 直接改 Linear / 直接 push 项目仓、既不经 Discord 也不起 Runner 的变化，本版不会触发唤醒（Lead 本来也不会知道）。默认按「接受，作为已知边界」推进。
2. bot 之间在共享频道的对话本版不算「有事」，但 Lead 已裁定（ask ca00b87c）：`<@该 Lead>` 的派活消息当 slot 就算；Raya 的审阅追问仍不算（自激防线）。
