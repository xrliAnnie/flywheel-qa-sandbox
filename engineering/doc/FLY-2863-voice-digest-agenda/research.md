# FLY-2863 语音播报只播三类、Lead 消化后对话 — 调研
Issue: FLY-2863 (https://linear.app/geoforge3d/issue/FLY-2863/语音v7-播报内容只播三类lead-主动说的-待批-受阻lead-消化后用对话口吻一件一件跟她过内部排队10)
日期: 2026-09-24
基于: exploration.md

> 行号的读取时间是 2026-09-24，涉及四个 checkout：
> main = `flywheel-FLY-2863`（HEAD `637752fcc`），2796、2798、2799 = 各自 worktree 当前的 HEAD
> （`a6477251a`、`64cb70d4e`、`7f639400d`）。未标分支的路径都指 main。
> 这三个分支都还没合入，实现时要按合入后的 SHA 重新核对一遍。

## 1. 三类来源：现有的机器判断在哪里

### 1.1 待批 / 要你答：标题和固定页用的是同一个判定

- 标签表在 `teamlead/src/bridge/stage-utils.ts`：
  - `approve: "待批"`（`:123`，emoji `⏳` 在 `:80`）；
  - `BLOCKED_WORD = "受阻"`（`:139`）；
  - `NEEDS_ANSWER_WORD = "要你答"`（`:158`）；
  - `founderGateAttentionBadge` 会在前面加 `🔔`（`:254-259`）。
- 状态到标签的映射在 `bridge/issue-display.ts`：
  - `deriveFounderGateTitleState()`（`:265-295`）的优先级是：受阻最先，其次 `approved_to_ship` 视为无需关注；
  - 满足 `founderGateActive`、`founderAttention==="ship"`、`stage==="approve"` 三者之一时判为**待批**；
  - `founderAttention==="answer"` 时判为**要你答**；
  - `deriveEffectiveFounderTitleState()`（`:240-262`）在 QA 或评审 hold 时会去掉关注标记。
- 事实来源是 `bridge/founder-attention-facts.ts:70-322` 的 `readFounderAttentionFacts()`，它读三处：
  - gate holder（`StateStore.listAttentionGateFacts`，`StateStore.ts:3425-3496`）；
  - 未结的 `founder_ask`（`listOpenFounderAsks`，`StateStore.ts:11787`）；
  - CommDB 问题（`flywheel-comm/src/db.ts:4426`）。
  - 另外，普通 Runner→Lead 的问题**不算**关注（`founder-attention.ts:1`）。
- 两处汇总：
  - 单张单的汇总在 `bridge/issue-title-state.ts:63-120` 的 `readIssueTitleState()`；
  - 固定页「⚡ 现在要你看」由 `epic-page/attention-sources.ts:229-262` 选取，它调用的是同一个 `readEffectiveFounderAttention`（`founder-attention-facts.ts:29-53`），所以**在待批和要你答上不会和标题不一致**。

### 1.2 受阻：标题有，固定页没有（⚠️ 两边不同源）

- 标题上的受阻来自 `issue-display.ts` 的 `deriveIssueTitleBadge()`（`:161-232`），判定分三种情况：
  - 无 DAG：主会话状态属于 `{failed, terminated, blocked}`（`:129-133`）。其中 `terminated` 如果有 ship 证据，按已完成算（`:167`）；
  - 有 DAG：任一 phase 处于 `blocked`（`:186`）；
  - phase 自身判为 blocked 的条件是状态属于 `{failed, terminated, blocked, rejected}`（`:74-79`）。
- 固定页的 attention validator **拒收** `declared_blocked`、`run_held`、`runner_stopped` 这三种（`epic-page/attention.ts:634-639`）。受阻只会以 `stopped_stuck` 的形式出现在进度行里（`epic-page/rules.ts:344-363`），用的是另一个谓词。

⇒ 本单的「受阻」**只用标题这一个谓词**（`readIssueTitleState` 返回 blocked）。原因有两条：
她在反馈里说的是「每个 thread，如果状态是……受阻」，指的就是标题；另外 issue 要求「与 thread 标题同源」。
固定页不列受阻，这属于固定页自己的范围，本单不修改。

### 1.3 「Lead 主动对她说的话」：唯一的区分是文字前缀

- `bridge/automated-message.ts:1-3` 定义了 `AUTOMATED_MESSAGE_PREFIX = "🤖[自动] "` 和 `DiscordMessageOrigin = "lead_authored" | "automation"`。
- `postDiscordMessageToChannel(..., {origin})`（`discord-utils.ts:184-221`）要求必须传 `origin`；`automation` 会给每一段文字都加上前缀。
- 自动发出的消息包括：thread 状态、回执、告警、站会等（`chat-thread-utils.ts:612/784/1145`、`ChatThreadCreator.ts:389/1150/1183/1508`、`founder-thread-notifier.ts:349`、`disposition-receipt.ts:126` 等）。
- Lead 本人发的消息是 `lead_authored`，不带前缀（`tools.ts:979/1025` 的 `/api/chat-threads/send`、`leadDiscordSend.ts:44`、`discord-send-core.ts:308`、`DirectDiscordOutboundSender.ts:96`）。
- ⚠️ **两类消息的发送者是同一个 bot**，也没有 embed 或 flag 可以区分。
- 已有先例：`bridge/voice-session-poller.ts:12,36-42` 只收 Lead bot 发的消息，并丢掉以 `📻`、`🗣️`、`🤖` 开头的消息。
- ⚠️ 缺口：Claude Discord 插件如果绕开上面这些路径直接发消息，就不会带任何标记。本单把「不带前缀的 Lead bot 消息」当作 Lead 主动说的话，这个缺口会导致**多播**，不会漏播。多播的方向比较安全，但在 QA 里要专门测。

### 1.4 urgent：目前没有统一的概念

目前只有几个分散的字段，都不能直接拿来当「可以插播」的依据：

- EventFilter 的 `priority`（`EventFilter.ts:10-11`），这是给 Lead 看的提示；
- 告警的 `severity`（`alert-kind-copy.ts:478-492`）；
- 固定页 attention kind 的 `priority 0-5`（`attention.ts`），只用于排序。

⇒ 本单需要**新定义一个显式的 urgent**，见 plan §4。

### 1.5 能否一次取回「待批和受阻列表」：现在没有接口

- `POST /api/epic-page/generate`（`epic-page-route.ts:217-364`）按项目取数，不按 Lead，不含受阻，而且会写 generate 回执并调用 Linear，**不适合**每次进房都调一遍。
- `GET /api/sessions?mode=active&leadId=`（`tools.ts:154-252`）只返回原始会话，调用方得自己重算，这就等于另造一套判定，违反 ⛔。
- ⇒ 需要在 Bridge 内新增一个**只读**路由，直接包住 `readFounderAttentionFacts` 和 `readIssueTitleState`（见 plan §2）。

## 2. 模式层与两个引擎：现状和接点

### 2.1 FLY-2796 模式层（底座）

- `voice-core/src/types.ts:375-383` 定义了 `VoiceV1Session`，包含 `open(initialSessionContext)`、`speak(text, kind, {pendingKey, verification})`、`onUtterance`、`injectContext`、`close`。`SpeakKind` 的取值是 `brief|question|readback|heartbeat|cue|control`（`:318`）。
- `voice-core/src/headphone/HeadphoneMode.ts` 的主要行为：
  - 开场是固定句（`:54`、`:62`）；
  - 串行队列用 `enqueue()` 实现；
  - 报平安在 `checkHeartbeat()`，默认间隔 `300_000`（`:5`），固定句是「我还在……」。
- `InboxReader.ts` 负责逐条念：决策类在前（`:101-108`）；没有合格的三段稿就念整段原文，**附件 URL 也会被念出来**（`:140-142`）。
- 收件箱由 Bridge 的 `headphone-collector.ts` 构建：
  - `readableText()`（`:170-189`）会把 content、embed、按钮和附件 URL 全部拼在一起；
  - `plugin.ts:11591-11625` 的来源范围是：general 频道、每个 Lead 的 chat 频道、所有 chat thread；
  - ⛔ **没有**过滤 `🤖[自动]`。
- handoff 的定义在 `voice-core/src/handoff.ts`，实现在 `voice-headphone/src/session.ts:163` 的 `handoffToLead` → Bridge；结果流用 `voice_handoff_results`（2796 plan §7.1 ⑦）。
- ⚠️ 在 2796 分支上，`voice-codex/cli.ts` 还**没有**传入 `createHeadphoneSession`，也就是说模式层还没有接进生产。

### 2.2 FLY-2798 引擎 A

- 开关在 `voice-codex/src/cli.ts:110`（`FLYWHEEL_VOICE_ENGINE=openai-live`）。
- ⚠️ `cli.ts:349-470` 把耳机会话**不分模式**地接进了所有会话，**会议会话也会触发进房播报和收件箱朗读**。这与 founder 的设计点 ⑤ 不一致：会议模式应该只说那个 Lead 自己的事。
- 声线有两处，而且互相独立：
  - Live 前台用 `coreConfig.openaiLive.voice`，取自 `FLYWHEEL_VOICE_OPENAI_LIVE_VOICE`，默认 `marin`（`voice-core/src/config.ts:168-172`），**不读** `projection.realtimeVoice`；
  - 播报器 `CompositeSpeech` 使用 `EdgeTts` 加 ffmpeg 解码（`cli.ts:369-392`），声线是 `announcerVoice`，默认 `zh-CN-XiaoxiaoNeural`（`config.ts:179-185`），并且 `config.ts:276-277` **强制要求**「OpenAI Live announcer must use edge-tts」。
- ⇒ 进房播报、收件箱条目、报平安、「我问下 Lead」、Lead 回话**全部**用晓晓（edge-tts）念，只有前台自己的回答是 marin。这就是她听到两种声音的直接原因。
- 接管播报时，`live-lead-adapter.ts:591-593` 会先挂起 Live 前台（`announcer-takeover`），再调用 `speech.speak`。

### 2.3 FLY-2799 引擎 B

- 声线来自 `projection.realtimeVoice`（`voice-codex/src/cli.ts:417,503`），经 `thread/realtime/start` 的 `voice` 参数传入（`CodexVoiceContainer.ts:677-686`）。**没有 edge-tts**。
- `speak` 的路径是 `CodexProofSpeaker` → `RealtimeTransport.appendSpeech`（`:349-356`）。Lead 回话在 `CodexRoomFrontend.ts:131` 按 `readback` 念。
- `injectContext` 不支持（`CodexVoiceBackend.ts:263-264`）。
- **没有模式层**：该分支基于 main，不含 `HeadphoneMode`、`InboxReader`。进房时说什么全由 prompt 决定：`voice-session-services.ts:265-298` 用 `generateBootstrap()` 生成（`bootstrap-generator.ts:286`，包含 activeSessions、pendingDecisions、gate/runner questions、pendingReports、recentFailures），再由 `voice-session-context.ts:487-537` 拼成 `realtimePrompt`。
  ⇒ **B 在进房时同样存在「把全部状态念出来」的风险**，只是来源换成了 prompt。
- 当前状态：该分支停在 implement 4/5，等 PR 1306 的复审；上一次 QA 部署失败，原因是 `launchctl bootstrap` 返回 EIO（`evidence/slot4-launchd-eio-handoff.md`）。**没有真房跑通的证据。**

## 3. 声线

- 允许的声线在 `teamlead/src/realtime-voices.ts:1-12`，共十个；`ProjectConfig.ts:235` 的 `realtimeVoice`，缺省时投影为 `marin`（`voice-session-services.ts:232`）。
- 线上 `~/.flywheel/projects.json` 里 **17 个 Lead 全部是 `marin`**，包括 raya（`:532`）、flywheel-eng-lead（Tadashi）和 flywheel-product-lead（Honey Lemon）。
- PRD FLY-1850 `prd.md:2441-2458` 记录的是她 2026-08-21 的逐字分配：alloy → Honey Lemon，verse → Tadashi，marin →「主管 Lead」，其余七个「未选」。FLY-2446 `plan.md:215` 规定 C8 映射「由运维写 registry」，但**实际没有写**。
- 另有一张 edge-tts 的 per-Lead 声线表（`ProjectConfig.ts:231 voice`、`voice-core/src/headphone/voice-directory.ts`），属于 FLY-546 的旧耳机 daemon。本单**不使用**它。
- GPT 声线的确定性 TTS：OpenAI 文档写明 `gpt-4o-mini-tts` 支持 13 个内置声线，**包含上面全部十个**（含 marin、cedar），并推荐 marin/cedar，输出格式包括 `pcm`（[TTS guide](https://developers.openai.com/api/docs/guides/text-to-speech)，2026-09-24 检索）。
  ⚠️ 两件事**尚未实测**：Flywheel 的密钥能否调用这个接口，以及它的 marin 和 Live 或 realtime 里的 marin 听起来是否是「同一个人」。这属于实现轮的第一项探针（plan §7 S0）。

## 4. 结论：接点汇总

| 层 | 今天 | 本单要改的接点 |
|---|---|---|
| Bridge 来源 | 收件箱全收，无过滤；待批和受阻没有对外接口 | 新增只读 `GET /api/voice/agenda`；收件箱条目加上 `origin` 分类 |
| Lead 消化 | 没有（Lead 可选写三段稿） | 新增 Lead 侧的 `voice-agenda` 命令，加一份按需读取的 runbook |
| 模式层 | `InboxReader` 逐条念，报平安 5 分钟固定句 | 新增 `AgendaConductor`（队列、urgent、一件的开闭），替换耳机和会议两处的「逐条念」 |
| 引擎 A | 播报器强制 edge-tts；Live 声线来自环境变量 | 播报器换成 GPT 声线 TTS，Live 声线改为读 `realtimeVoice`；会议和耳机分开接线 |
| 引擎 B | 无模式层；prompt 里有全部状态 | 接同一个 `AgendaConductor`；从 prompt 里去掉状态罗列 |
| 配置 | 全部 marin | 写入 C8 的三条映射（需要她确认），其余 Lead 等她选 |
