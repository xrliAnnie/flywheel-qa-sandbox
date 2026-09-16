# FLY-2609 T1 底稿 — Raya 真实产出清单（采自实际数据，未编造）

Issue: FLY-2609 (https://linear.app/geoforge3d/issue/FLY-2609/raya产品设计-重新定义主动汇报后台记录与给-annie-看的对话分开)
日期: 2026-09-15
基于: exploration.md、research.md、Lead 第 1 轮审阅意见

---

## 0. 这份文件是什么

Lead 的要求：T1 那一轮交给 Annie 的主体必须是**一张逐条的表**，左列是 Raya 一天真实产生的每一类东西，右列三选一（后台 / 值得主动告诉她 / 等她问再说），**每行先填好我的建议默认值**，她只改不同意的那几行。

并且明令：**⛔ 不许凭想象编类目。** 所以本文先把类目的**证据来源**钉死，再给默认值。

## 1. 数据来源（全部本机实读，2026-09-15）

| 来源 | 路径 | 覆盖 |
|---|---|---|
| Raya 轮次账本 | `~/Dev/raya-lead-workspace/state/summary-merge-receipts.jsonl` | 46 行 |
| 今天三轮的落盘目录 | `state/round-2026-09-15T12/`、`T18/`、`round-2026-09-16T00/` | 3 轮 |
| 她实际发到 #raya 的三条原文 | 各轮 `report.txt` | 3 条 |
| 她实际追加到工程 thread 的原文 | 各轮 `issue-route-receipts.json` | 4 条 |
| 追问原文 | `round-2026-09-16T00/question149.json` 等 | 8 条 question 行 |

## 2. A 类 · 后台账本行（按 `type` 实际计数）

| `type` | 今天条数 | 是什么 |
|---|---|---|
| `round` | 3 | 本轮打算看哪些 PR 的快照（任何外部动作前先写） |
| `review` | 10 | 看过某个 PR |
| `absorption` | 9 | 吸收了某条摘要 |
| `absorption_pending` | 1 | 吸收未完成 |
| `merge_blocked` | 3 | merge 被官方命令拒绝 |
| `question` | 8 | 去问某个 Lead 的问题（含 posting / posted 两态） |
| `memory` | 2 | 写进 MEMORY.md |
| `report_attempt` / `report` | 3 / 3 | 发 #raya 的那条汇报 |
| `issue_report` | 4 | 追加到工程 thread 的记录 |

> A 类本来就是后台账本，**整族默认「后台」**，表里作为一行呈现即可，不逐条问 Annie。

## 3. B 类 · 她实际收到的那三条消息里，到底有哪些成分

逐条从三份 `report.txt` 原文里拆出来的，**每条都能指回原句**：

| # | 成分 | 原文证据（节选） |
|---|---|---|
| B1 | 时间 + 统计头 | 「下午 5:13（PDT…），我处理了晚到的这一轮：review 3 个 PR（Flywheel、GeoForge3D），吸收 0 条（0 个项目），成功送达追问 0 条」 |
| B2 | PR 号列表 | 「PR：#140、#141、#142」 |
| B3 | roundId 全串 | 「roundId：summary-absorption:2026-09-15T12:00:00.000Z」 |
| B4 | **Raya 自己的判断** | 「我不同意把瓶颈只归成"等你按卡"——合入冲突、部署是否生效同样决定成果能否用上」「我不会把零任务解读成一切正常」 |
| B5 | 跨项目事实观察 | 「GeoForge3D 最新摘要纠正了旧阻塞判断，但"配置文件已存在"仍不等于产品/代码任务已恢复派工」 |
| B6 | 对账结果 | 「已合摘要与 MEMORY 对账无新增缺漏」 |
| B7 | 机制故障说明 | 「merge 仍被官方命令拒绝」「push 失败」「MEMORY 本轮未改」 |
| B8 | **整段英文报错原文** | 「REFUSED: no cross-department channel configured — "roundtable" is unavailable (set FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS, or pin it via FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES=roundtable:&lt;id&gt; …)」 |
| B9 | 缺交名单 | 「本轮 3/11 份已交;未交:ops-lead、mufasa-lead、rafiki-lead、reflection-lead、joycon-lead、belle-lead、sub-lead、tidal-echo-content-lead」 |
| B10 | 队列深度 | 「快照中仍有 118 个未读 summary PR，本轮没有清队列」 |
| B11 | 待澄清标记 | 「#23 的判断冲突仍待澄清」「#149 有一处判断待澄清」 |
| B12 | 记下了她的偏好 | 「你的沟通偏好已记入本地记忆；同步仍失败」 |

**观察**：三条消息里，B4 + B5 加起来大约占 15%，其余 85% 是 B1/B2/B3/B6/B7/B8/B9 —— 过程量、机器标识、运维报错。这条比例就是 Annie 说的「roundId、统计数和报错串取代内容」的量化形态。

## 4. C 类 · 追加到工程 thread 的 4 条

内容实测是 B 的**压缩重复** + 一句指回 #raya：

> 「本轮 review #143–145 共 3 个未读 PR；补吸收 9 条历史已合摘要、覆盖 6 项目，新 merge 0，追问送达 0。官方 merge 因 canonical Raya recipient identity 缺失被拒；roundtable 未配置…详细可见报告已发 #raya，message 1549573284205568111。roundId：…」

落点：FLY-2131 thread（`1549573426547658793`）、FLY-2382 thread（`1549573438937767977`）—— **正是 Annie 说的那两个工程 thread**。

## 5. 🔴 2026-09-15 她的回话把轴换了 —— §5 以下全部按新轴重写

第 1 轮她没有回答「T1 你有定见还是我来发挥」，而是**直接给了定见**，并且换掉了判据本身。

### 5.1 她的原话（照搬，不改写）

> **她负责的工作主要分两部分：**
> **1. 日常代码与进度跟进**：每 6 个小时（或者更频繁的周期），她需要去看一下所有其他 lead 最近新做了什么，理解大家手头的工作，并把相对应的 PR 合并进去。这部分没问题。
> 她每次去同步这些内容并合并 PR 时，**都可以开一个新的 thread 并在里面更新最新状态**。我不一定每个 thread 都会看，但希望她能在那边同步。**PR 合并完之后，把那个 thread archive 掉就行**；除非中间出现问题需要问我，或者我有问题要问她，才需要把 thread 留着。
> **2. 耳机/语音模式下的统管**：只有在进入耳机模式（开启语音模式）时，她才需要帮我去统管所有在做的事情，跟我汇报当前发生了什么、哪些事情需要我的 action。**如果没开耳机模式、只是在文字这边，她不需要去统管所有人的工作**，只要阶段性地（比如每 6 个小时）了解一下大家的进展就可以了。

> 我并不需要它一直给我发这个汇报，**这个汇报只有在耳机模式下才需要发给我。如果在平常的文字区，它完全不需要发这些东西。** 至于耳机模式下的汇报内容，我们之后可以再慢慢聊。发给我的信息可以再**节制、简洁**一点，没必要把所有的信息都一股脑地发给我。

> 比如他每 6 个小时跑一轮，可以开几个 thread，然后在里面去 update，记录：
> • **现在有什么新的 report**
> • **他有没有读懂发生了什么**
> • **有没有问题需要问那些 lead**
> • **他有没有去 ship**
> 他可以开不同的 thread 来记录这些事情。**我不一定会去看，但还是希望能有一个 track record 在那边。**
> 主要是因为我们刚开始做这个东西，**我希望很多进展能保持 visible，这样如果发现问题，我就可以及时参与、调整**。等之后更加成熟了，可能会把这个做得更偏后台一点。

### 5.2 轴换了什么（这条是本单最关键的一次转向）

| | 第 1 轮我们假设的轴 | **她给的轴** |
|---|---|---|
| 开口条件 | 这条判断重不重要（方案 A） | **在哪个模式** |
| 文字模式 | 有重要判断才说 | **完全不主动汇报**，只开 thread 留痕 |
| 耳机模式 | （没设计） | **这时才统管全局**，报「现在发生了什么、哪些要她 action」 |

⇒ **方案 A 的「有没有一条跨项目判断要交换」不再是开口条件，作废。**

### 5.3 她顺手回答了我第 1 轮问的「漏报怎么兜」

我问的三个选项里，她选了 (b) 并给了理由：**兜底就是这些 thread**。

> 「我不一定会去看，但还是希望能有一个 track record 在那边……希望很多进展能保持 visible，这样如果发现问题，我就可以及时参与、调整。」

⚠️ **这句是设计约束，不是背景。** 所以**不要**把文字模式设计成「完全静默的后台」—— 留痕是刻意的、当前阶段的要求；「成熟后再更偏后台」是她给的未来方向，不是现在。**这一件不用再问她。**

### 5.4 三档重画

| 档 | 含义 |
|---|---|
| **后台账本** | 只落文件/DB，Discord 上不出现 |
| **thread 留痕** | 写进当轮 thread，她**不一定看**，但必须在那儿 |
| **耳机模式才汇报** | 文字模式绝不主动发；进语音模式时才统管播报 |

> 注意：第三档不再是「等她问再说」。文字模式下她**不需要**Raya 统管，所以那类内容的归宿是语音模式，不是"她问我才答"。

### 5.5 T1 表 —— 我的建议默认值（按新三档）

左列全部来自 §2/§3/§4 的真实数据，**零编造**。

| 行 | 内容（真实来源） | 我的默认 | 为什么 |
|---|---|---|---|
| A | 全部后台账本行（round / review / absorption / merge_blocked / question / memory / report…10 种 type） | 后台账本 | 本来就是账本，她从不需要看 |
| B1 | 时间 + 统计头（review N 个 / 吸收 N 条 / 覆盖 N 项目） | thread 留痕 | 是 track record 的一部分，但不推给她 |
| B2 | PR 号列表 | thread 留痕 | 留痕要可追，放 thread 里正好 |
| B3 | roundId | 后台账本 | 机器幂等键，留痕不需要人读它 |
| B4 | **Raya 自己的判断** | thread 留痕 + **耳机模式才汇报** | 对应她点名的「他有没有读懂发生了什么」 |
| B5 | 跨项目事实观察 | thread 留痕 | 对应「现在有什么新的 report」 |
| B6 | 对账无异常 | 后台账本 | 无异常时零信息量 |
| B7 | 机制故障说明（merge 被拒 / push 失败） | thread 留痕 + 告警给工程 | 她说「发现问题我可以及时参与」——**故障恰恰要 visible** |
| B8 | 英文报错原文 | 后台账本 | 绝不进她视线；thread 里写一句人话即可 |
| B9 | 缺交名单（谁没交） | thread 留痕（降级为一行） | 运维信号；不再逐字强制、不再进主频道 |
| B10 | 队列深度（118 个未读） | thread 留痕 | 属「现在有什么新的 report」 |
| B11 | 待澄清标记 / 要问 Lead 的问题 | thread 留痕 | 对应她点名的「有没有问题需要问那些 lead」 |
| B12 | 「我记下了你的偏好」 | 后台账本 | 确认性回话；风格归 FLY-2610 |
| C | 合 PR / merge 的结果 | thread 留痕 | 对应她点名的「他有没有去 ship」 |
| D | **要 Annie 本人决定的事** | 文字模式：thread 留着不 archive + 走 FLY-2597「要你答」；耳机模式：当场报 | 她的两个例外之一 |
| E | 每轮汇总发 #raya 主频道 | **取消** | 她原话：「在平常的文字区，它完全不需要发这些东西」 |

**她的动作 = 改她不同意的那几行。**

### 5.6 她点名的 thread 四类内容 → 逐条落位（不改写她的措辞）

| 她的原话 | 对应上表 |
|---|---|
| 现在有什么新的 report | B5 + B10 |
| 他有没有读懂发生了什么 | B4 |
| 有没有问题需要问那些 lead | B11 |
| 他有没有去 ship | C |

### 5.7 thread 生命周期（她给的，进 PRD 当硬要求）

1. 每轮同步 + 合 PR 时**开一个新 thread**，过程 update 写在里面；
2. **PR 合完就 archive**；
3. 只有两种情况留着：① 中间有问题要问她 ② 她有问题要问 Raya。

### 5.8 ✅ thread 的开与关 —— 现成能力，不需要新造（已更正）

> 🔴 **更正记录**：本节初版结论是「今天不存在非 issue 的自由 thread，所以每轮开新 thread 只有三条路」。
> **那个结论是错的。** 错因是我只查了 Flywheel 的 `packages/teamlead/src/bridge/tools.ts` 三条 HTTP 路由，
> 就把它们的**入参校验**当成了**系统能力边界**。Lead 指出「拿本仓源码去断另一个系统的能力」是这套系统里
> 最容易犯的错之一，复查后确认他是对的。原先列的 (a)(b)(c) 三条路是伪选项，作废。

**复查后的事实（全部本机实核）：**

| 能力 | 真实要求 | 证据 |
|---|---|---|
| 开 thread | 只要 `channelId` + 根 `messageId` + bot token，`POST /channels/{id}/messages/{mid}/threads`。**与 Linear 单无关** | `RoundtableThreadManager.ts:649`、`AlertChannelHub.ts:79`、`flag-retirement-production.ts:466`，另 Raya 仓 `apps/brain/src/meeting.ts:1207` |
| archive thread | `archiveChatThread(threadId, botToken)` → `PATCH /channels/{threadId} {archived:true}`。**只吃 threadId** | `chat-thread-utils.ts:138` |
| 自动归档 | Discord 原生 `auto_archive_duration`，roundtable 已在用 | `RoundtableThreadManager.createThreadFromMessage(msg, archiveMinutes)` |

**⇒ Flywheel 生产里已经存在至少三处「不绑 Linear 单」的 thread**（告警中心、roundtable、flag 退役），
Raya 仓的会议模式是第四处。**「绑单」只是 `/api/chat-threads/{create,send,archive}` 这三条路由的入参要求，
不是能力边界。**

⇒ 她要的「每轮开新 thread + 合完 archive」**不需要新造能力**。剩下的是产品选择（开在哪个频道、怎么命名、
要不要跟单关联），**归 T3（场所）**，不单独排轮次。

**两条要分清的路径（不要混为一谈）：**

| | 谁 | 走哪条 | 证据 |
|---|---|---|---|
| 发 #raya 那三条轮报 | Raya 作为 Flywheel 的 Codex Lead | Flywheel 的 Lead 发送面 | Bridge `/health` 的 `w2_delivery_loop` 里有 `{project_name:"raya", lead_id:"raya"}` |
| 追加到 FLY-2131 / FLY-2382 两个工程 thread | 同上 | Flywheel `/api/chat-threads/send`（**绑单的那条**） | `issue-route-receipts.json` 的回包形状 `{threadId, messageIds, created}` 与该路由返回值一致 |
| 会议模式建 thread | Raya 仓的 brain 应用（另一套 launchd 部署） | 她自己的 bot token 直连 Discord REST | `apps/brain/src/meeting.ts:1207` |

⚠️ **Raya 仓那套的部署状态要诚实标注**：`~/.flywheel/raya/deploy-receipt.json` 当前是
`"outcome": "rolled_back"`、`"failure": "preflight-rc:1:rolled-back"`，且 `schemaVersion: 1`
（`summary-inflow.md` 规定只有 `schemaVersion:2` + `carrier:standard-lead` 的回执才算上线证据）。
⇒ **不能声称 Raya 仓那条路径当前在生产可用。** 但这不影响上面的结论——Flywheel 侧那三处非 issue thread
本来就在生产跑。

## 6. 耳机/语音模式 —— 本轮不设计，但先核清它今天是什么

她说「耳机模式的汇报内容之后再慢慢聊」，Lead 也明令本轮不设计。但边界要核清，**按真实实现写**：

| 事实 | 出处 | 成色 |
|---|---|---|
| 耳机模式 = Discord 语音房 ↔ Codex realtime(v2) 的常驻语音管线 | FLY-2074 `exploration.md` §1.3 | 已实核 |
| realtime 版本 = v2（选 v2 = 明知放弃「打断」换连接稳定） | FLY-1850 §6.5 / FLY-1851 §30，她本人 2026-08-20 拍的 | ✅ 她拍的 |
| FLY-2074 状态 = implement 6/6，`nextStep` 仍是跑完 gates + 冻头重审 | `engineering/doc/FLY-2074-raya-voice-pipeline/progress.md` | **尚未收口，不能当成已上线** |

### 6.1 🔴 耳机模式的汇报语义**已经有定稿 PRD**，本单不得重开

`product/doc/FLY-1850-headphone-voice-relay/prd.md` **v1.0（可交付定稿）** §5.1–5.4 已定：

| 项 | 已定的内容 |
|---|---|
| 主动性 | **它一定主动开口**，不是被动等她问 |
| 触发点 | **她进入语音模式那一刻** —— 一进去就把积压的一次性给她 |
| 搬什么 | Lead 要问她的所有问题 + 要汇报的所有内容，自动转一份给主管 |
| 播报形式 | 「现在是什么情况」+「**哪些事情需要你做决定**」 |
| 进 / 出两层 | **进来的那一层 = 全部；出声的那一层 = 筛过的**（合成一句就读错） |
| 筛的标准 | **给机制不给标准**：起点不筛 → 她随口说「这个不用告诉我」→ 它记住 → 慢慢收敛 |
| 沉默语义 | **沉默必须被主动打破**（通道无法自查时，「静」和「死」同形） |

⇒ 本单对耳机模式的唯一增量 = 她这次新加的一句：**「更节制、简洁，不要一股脑全发」**，记为待细化项，交后续轮次。

### 6.2 🔴 与 FLY-1850 的一处旧合同冲突，必须显式处理

FLY-1850 PRD §5.2 写着：

> **⇒ 耳机里的规矩和文字那边【不一样】**：文字那边「**只报走偏的**」(A-PRD §10)，耳机里一开始全给。

而她 2026-09-15 说的是：文字那边**完全不主动汇报**，只留痕。

**这是收紧，不是推翻**：「只报走偏的」→「一条都不主动报，全部改为 thread 留痕」。
⇒ PRD 里必须逐条写明这条迁移，**不假装 FLY-1850 §5.2 关于文字侧的那半句仍然成立**；耳机侧的 §5.1–5.4 则原样保留。

## 7. 冲突清单更新（替换 exploration.md §3 的处置列）

| 旧合同条款 | 与新轴的关系 | 处置 |
|---|---|---|
| 每轮必报（rider `notification_context` 逐字注入） | **直接冲突** | 废；文字模式零主动汇报 |
| 必附缺交名单、逐字不许改写 | **直接冲突** | 移出 founder 面，降级为 thread 里一行 |
| `IDENTITY.md` §Visible reporting「post a report in your own #raya channel」 | **直接冲突** | 改为写进当轮 thread，不发 #raya |
| `IDENTITY.md`「空轮静默」 | 被新轴覆盖 | 文字模式下本就不发，该条自然成立 |
| FLY-1850 §5.2「文字那边只报走偏的」 | **收紧** | 显式迁移，见 §6.2 |
| FLY-1850 §5.1–5.4 耳机侧 | 不冲突 | **原样保留，本单不重开** |
| FLY-162 issue token 分流 | 不冲突 | 保留；但内容改为 thread 留痕，不再是主频道汇总的回声 |
| Judgment 必填（`summaries/README.md`） | 不冲突 | 保留；它是「他有没有读懂发生了什么」的原料 |
| 6h cadence | 她原话确认「这部分没问题」 | **不动**（issue 亦明令） |

## 8. 兄弟单边界（避免重叠）

| 单 | 管什么 | 与本单的界 |
|---|---|---|
| FLY-2607 | Epic：Annie 使用反馈统一收件 | 父单 |
| FLY-2608 | 工程修复：thread 里的提问必须送达 Raya 并原地回复 | **双向可用的实现归它**；本单只定语义 |
| **FLY-2609（本单）** | **什么时候说、说哪一类、发到哪** | —— |
| FLY-2610 | 日常对话先直接回答、少术语 | **措辞风格归它** |
| FLY-1850 | 耳机模式汇报语义 | **已定稿，本单不重开**；只记「更节制简洁」这一增量 |
| FLY-2597 | 通用「要你答」/「待你看」机器视图 | **复用**，不另造 |
