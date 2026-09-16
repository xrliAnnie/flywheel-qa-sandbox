# FLY-2597 thread title「要你答」+ 固定页「待你看」同源 — 探索
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597/founder-视图单一真相-thread-title-加要你答状态founder-需回复时机器点亮founder-回帖即熄-epic)
日期: 2026-09-15
基于: 无

## 0. 一句话

给 `[FLY-XX]` thread 标题再加一个机器维护的状态词「要你答」,与既有「待批」共用同一台轮转机器、同一份状态源;Epic 固定页的「待你看」块改为只列此刻标题带「要你答」或「待批」的 thread,从同一份状态派生——founder 只需扫标题就知道哪些 thread 是"要 ship 了"、哪些是"真的卡在我这儿",不再维护第二份人肉真相。

## 1. founder 原话与问题定义

> 我只想点进去看两种 thread:一种是最后要 ship 了,我看 ship report 决定要不要 ship;另一种是它真的有问题需要我去决定。前者已经有「待批」title 了。后者怎么 highlight?最简单应该是在 thread title 上也 update 一个状态。放 HTML 里会 maintain two sources of truth,容易 out of sync。Epic 本身还是可以做整体 status update。最后要 generic 一个 behavior 出来,所有 Lead 都这么做。 (2026-09-15 21:58Z,22:40Z 回「开」)

拆成三个可验证的诉求:

1. **标题上再多一个词**:「要你答」。点亮/熄灭都由机器判,Lead 不手改 Discord thread 名。
2. **一份状态,两张脸**:标题和固定页「待你看」块读同一份派生状态;伪造状态,两边同步变。
3. **通用**:对所有项目、所有 Lead 生效;规则里不再要求 Lead 定时手写进展。

## 2. 现状审计(全部本机实核,2026-09-15,基于 main `5ad7b9853`)

### 2.1 标题轮转机器(FLY-560 / FLY-907)—— 已有「待批」,已有一个 🔔 叠加层

- 状态词表在 `packages/teamlead/src/bridge/stage-utils.ts`:`STAGE_WORD.approve = "待批"`,配 `STAGE_EMOJI.approve = "⏳"`。另有两个跨阶段(cross-cutting)徽章:`🔴受阻`(BLOCKED)、`⚠️重连中`(RECONNECTING)。
- 已存在一个「founder 注意」叠加层:`FOUNDER_GATE_ATTENTION_EMOJI = "🔔"`,`founderGateAttentionBadge(primary)` 渲染成 `🔔 ⏳待批`。`splitStatusEmoji()` 只在 🔔 后跟空格再跟一个已知主徽章时才把 🔔 视作受管前缀。
- 派生在 `issue-display.ts`(纯函数)+ `issue-display-refresher.ts`(I/O):
  - `deriveFounderGateTitleState()` 只接一个布尔 `founderGateActive`;
  - refresher 里 `founderGateActive = isWorkflowApprovalGateCurrent(activeWorkflowRun)` —— **只看 DAG run 的当前节点是不是审批门节点**(`workflowApprovalGate(manifest).node`,land 工作流是 `approval_gate`,generic 工作流是 `terminal_gate`);
  - 再被 `isQaHeld` / `isReviewHeld`(FLY-579/827 的 founder 静音谓词)压掉。
- 触发:每个生命周期事件 `enqueue(issueId)`(Layer-1,按 issue 合并到最新)+ GatePoller 每 60 tick × 3s ≈ **3 分钟**一次 `runSweep()`(Layer-2,keyset 游标,每次最多 10 个非终态 issue 轮转刷新,50 个候选比对指纹)。一个「轮转周期」= `ceil(非终态 issue 数 / 10) × 3min`。
- 写入:`ChatThreadCreator.stampStageEmojiResult()` 走每 thread 合并写队列,Discord 限 2 次改名 / 10 分钟。指纹 `display_fingerprint` 只在全部启用面都 changed/noop 后持久化。

**结论:标题今天只会为「ship 审批门」点亮 🔔;legacy `gate founder_review` / `gate brainstorm`、Lead 转进 thread 的问题、runner 的 `[ASK]`,标题一律不亮。**

### 2.2 Epic 固定页「⚡ 现在要你看」—— 已是机器采集,但源比标题宽

- 页面块在 `packages/teamlead/src/epic-page/render-html.ts::renderAttention()`,标题文案「⚡ 现在要你看 · N 件」(founder 说的「待你看」就是它;FLY-2593 里程碑也这么叫)。
- 数据 = `attention.v1` 扩展(FLY-2140):`attention-sources.ts::readAttentionSources()` 读三源:
  | 源 | 来自 | kind |
  |---|---|---|
  | gates | StateStore `workflow_gate_holder`(仅 `gate_node_id='founder_gate'` 的当前持有者) | `ship`(authority land/runner_ship)或 `founder_gate`(engine_terminal) |
  | questions | CommDB `mailbox` 未回答 question(`listAttentionQuestions`) | checkpoint `approve_to_ship→ship`、`founder_review/brainstorm→founder_gate`;其余 **正文匹配 `@founder` 正则→`question`,否则→`lead_question`** |
  | founder_review | Linear 标签(`fetchLinearFounderReviewAttention`) | `founder_named` |
- 受众切分在 `attention-presentation.ts::isFounderAttention()`:只有 `ship / founder_gate / question` 三种进「现在要你看」;`lead_question`、`founder_named` 进折叠的 Lead 面板。
- 页面刷新:事件驱动(`REFRESH_REASONS`:session_started/completed、run_started、lead_note_changed…)+ 5s 去抖 + 周期 scan;每次都全量重读三源。

**结论:页面与标题今天是两套派生。** 具体差异:

| 情形 | 标题 | 固定页「现在要你看」 |
|---|---|---|
| DAG ship 门(approve_to_ship holder) | 🔔 ⏳待批 | 列(ship) |
| DAG generic 终点 founder 门(engine_terminal) | 🔔 ⏳待批 | 列(founder_gate「在等你按一下」) |
| legacy `gate founder_review` / `gate brainstorm`(mailbox) | 不亮(显示当前 stage) | 列(founder_gate) |
| runner `[ASK]` 正文含 `@founder` | 不亮 | 列(question)—— **文本猜测** |
| runner `[ASK]` 不含 `@founder` | 不亮 | 不列(Lead 面板) |
| Lead 在 thread 里问 founder 一个决定 | 不亮 | 不列(无任何机器记录) |
| founder 回帖后 | 不变(直到门被答) | 不变(直到门被答) |

### 2.3 founder-bound gate 词表(条件 1 的边界)

- `flywheel-comm gate <checkpoint>`:`approve_to_ship`(ship 卡,FLY-2427 起只能 founder 在 Discord 卡上答)、`founder_review`(需 committed artifact evidence,fail-close)、`brainstorm`、`question`(Lead 答)、`review_design/review_code`(Codex 评审传输,`isReviewGateCheckpoint` 明确排除 founder)。
- DAG 车道:门以 `workflow_gate_holder` 行存在,`gate_node_id='founder_gate'`,靠 `authority_mode` 区分 ship(`land`/`runner_ship`)与 generic 终点审批(`engine_terminal`)。
- ⇒ 「approve_to_ship 以外、需要 founder 回答的 gate」= mailbox checkpoint ∈ {`founder_review`, `brainstorm`}(无 holder 的 legacy 车道)。`gate question` 是问 Lead 的,不算。DAG `engine_terminal` 门归入哪一档见 §5 决策 2。

### 2.4 founder 回帖入口(熄灭条件的事实源)

- `founder-reply-deliverer.ts` + GatePoller `founderReplyDeliverPass()`:每个 pass 为**每个有 chat thread 的非终态 session** 建一个扫描任务(有 pending question 的 thread 每 pass 必扫;零 question 的 thread 按预算轮扫),用 Discord REST 读 `after=cursor` 的消息。
- founder 身份判定:`msg.author.id === DISCORD_OWNER_USER_ID && !bot`(第 440 行)。每条 founder 消息 `ingestDiscordChat()` 写入 CommDB mailbox(`type='discord_chat'`,`from_agent='founder'`,收件人 = Lead),再交 Lead;ship 卡/founder_review 的回复会被分类并写受信 response。
- ⇒ 「founder 本人在该 thread 回帖」在 Bridge 里已经有唯一一处判定点;熄灭可以挂在这里,不需要新扫描器。

### 2.5 Lead → thread 发送面(条件 3 的落点)

- `POST /api/chat-threads/send`(`tools.ts:711`),body `{issueId|issueIdentifier, channelId, leadId, projectName, text, replyTo?}`;鉴权 `TEAMLEAD_API_TOKEN`;返回 `{threadId, messageIds, created}`。规则(department-lead-rules.md §Runner Question Handling)要求 Lead 收到 `[ASK]` 后用它把问题转进 thread(`💬 <ID> Runner 在问:…`)。
- 发送后 Bridge **不记录任何持久标记**(只记 bot 发送用于归档判定)。没有字段能表达「这条是在等 founder 决定」。

### 2.6 规则文件里「Lead 定时手写进展」的现状

- `lead-rules-base/` 全文检索:**没有任何条款要求 Lead 定时手写 Epic 页判断或 thread 进展**。
- 相关但不同的两样东西:
  - Epic 页「💬 判断」卡(FLY-2485 `flywheel-comm lead-note set`)—— 可选、无节奏要求;FLY-2593 刚把「机器意见历史」移到页脚。
  - `summary-inflow.md`(FLY-2030/2382)—— Raya 回流的周期 summary PR,**founder 本人定的机制**,由 `[summary_due]` 事件驱动,只对 `FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1` 的 Lead 装载。
- ⇒ 本单在规则上能做的是「不新增 + 加一条负向规则」,是否停用 summary duty 归 Lead/founder 裁(§5 决策 1)。

### 2.7 顺带发现(不归本单修,记录在案)

- 固定页 `question` 类靠 `@founder` 正则,正是 founder 反对的「文本猜测」;它同时决定 founder 受众,今天没有任何机器可审计的替代。
- 标题的 🔔 与页面的 `attention` 两处各自实现了「holds 压掉 founder 面」——页面侧没有 `isReviewHeld` 抑制,标题侧有。同源后只保留一处。

## 3. 目标状态(founder 视角)

标题只可能出现两种「要你」词,互斥,「待批」优先:

| 词 | 含义 | 谁点亮 | 谁熄灭 |
|---|---|---|---|
| `🔔 ⏳待批` | ship report 已出,等你决定要不要 ship | 现有机器(ship 门当前持有者),**不改** | 现有机器(门被答/作废) |
| `🔔要你答` | 有人在等你一个决定,不是 ship | ① runner 开了 founder-bound 非 ship 门;② runner 的 `[ASK]`/gate 被 Lead 转进 thread 并标记需 founder 答;③ Lead 自己在 thread 里向 founder 要决定(带机器可判标记) | founder 本人在该 thread 回帖(作者 id = founder);或该门/问题已被回答 |

固定页「⚡ 现在要你看」= 此刻标题带这两个词的 thread 列表(issue 号 + 一句话 + Discord 链接),按 待批 → 要你答 排序;Epic 级 计数(跑完/在跑/没开始)保留不动。

## 4. 方案选项

### A(推荐)一份纯派生 + 一张 Lead 标记表,两张脸都调它

- 新增纯函数模块 `founder-attention.ts`(放 `packages/teamlead/src/bridge/`,零 I/O):输入一个 issue 的事实(当前 ship 门持有者、engine_terminal 门、mailbox 未答 founder-bound 门、Lead 标记行 + 其关联问题是否仍 pending、holds),输出 `{ level: "ship" | "answer" | null, sources[] }`。
- 事实读取用一个薄 reader(`readFounderAttentionFacts(store, commDb, issueId)`),标题 refresher 与 Epic 页 `attention-sources.ts` 都调它;页面按 project 批量,标题按 issue 单个,但**同一函数、同一 SQL**。
- Lead 标记 = StateStore 新表 `founder_ask`(见 research §3),由 `POST /api/chat-threads/send` 的可选字段 `founderAsk` 写入(先写表再发 Discord,消息 id 回填);熄灭由 founder-reply-deliverer 的 founder 判定点调用 `store.settleFounderAsksByThread()`。
- 标题新增跨阶段徽章 `🔔要你答`(常量与 🔴受阻 同一族);`deriveFounderGateTitleState` 改吃 `level` 而不是布尔。
- 页面:`attention.v1` 的 founder 受众改为「level != null 的 issue」,`question` kind 不再由正则产生。

### B Lead 标记写成 CommDB mailbox question(收件人 founder)—— 否决

mailbox 的 `recipient_kind CHECK IN ('lead','runner','bridge')`,改 CHECK 要重建表;`getPendingQuestions(leadId)`、relay、pending CLI、dwell、retention 等十几处消费者要逐个排除新 kind;founder 回帖也得伪造一条 response 行。风险面远大于一张 Bridge 自己的表。

### C Lead 直接 PATCH thread 名 —— 否决

issue「不做」明列;且绕过合并写队列会与轮转机器互踩(2/10min 限额)。

### D 保留两套派生,加一致性巡检 —— 否决

还是两份真相,巡检只能事后报警,不解决 out of sync。

## 5. 关键决策与默认假设(已用 ask `1183f4e8` 非阻塞报 Lead,回复前按默认走)

1. **「Lead 定时手写进展停用」落到哪条规则**:默认不动 `summary-inflow.md`(founder 定的 Raya 机制),只在 `department-lead-rules.md` / `runner-patrol-rules.md` 加负向规则:进度与「待你看」不手写进 Epic 页或 thread 标题,由机器派生;lead-note 保持可选。
2. **DAG generic 终点 founder 门(engine_terminal)显示哪个词**:默认维持今天的 `🔔 ⏳待批`(issue 说不改待批语义);页面上它继续列在「待批」档。
3. **`@founder` 正则是否保留为点亮条件**:默认删除。runner `[ASK]` 只有被 Lead 用 `founderAsk` 标记转进 thread 后才亮;未标记的留在 Lead 面板。这是「机器可判、可审计」的直接推论。

## 6. 边界(本单不做)

- 不改「待批」的既有点亮/熄灭语义,不改 Layer-2 轮转节奏与 Discord 改名限额。
- 不引入第二份需要人维护的状态表;Lead 不手工 PATCH thread 名。
- 不动 Raya summary 回流机制(除非 Lead 明示)。
- 不做 Linear 标签源(`founder_named`)的语义调整,它继续留在 Lead 面板。
- 不动 `isQaHeld/isReviewHeld` 对 ship 的静音;「要你答」不受 holds 压制(Lead 在任何阶段都可以问 founder)。

## 7. 待 research 回答的问题

1. 新徽章 `🔔要你答` 与既有 `🔔 ⏳待批` 在 `splitStatusEmoji` 语法里能否共存、无歧义地剥离/重盖。
2. `attention.v1` 的严格校验(`assertAttention`)能否接纳一个新的 statestore 表源,还是要升 `attention.v2`。
3. founder_ask 表结构、retention 登记、与关联 runner 问题「已答」的机器判据。
4. founder-reply-deliverer 里挂熄灭钩子的确切位置与失败语义(不能因熄灭失败卡住 cursor)。
5. 测试夹具:refresher 测试如何伪造门/标记;固定页测试如何伪造同一状态并断言两边同步。
6. 真机 QA:529 台架的 thread 上如何触发三条件与 founder 回帖(不用 founder 本人身份)。
