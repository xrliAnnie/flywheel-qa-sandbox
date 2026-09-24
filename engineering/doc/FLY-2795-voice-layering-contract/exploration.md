# FLY-2795 语音 V1 分层与引擎接口 — 探索

Issue: FLY-2795 (https://linear.app/geoforge3d/issue/FLY-2795/语音v1-分层与引擎接口耳机会议模式引擎无关-对话引擎-ab-的接口合同-现有代码与-9-月初-raya-语音代码盘点找回清单)
日期: 2026-09-22
基于: 无（本单是 V1 首篇；上游依据为 FLY-2786 讨论页与调研、PRD FLY-1850 / FLY-1851）

> 本单**不写实现代码、不改生产、不改语音配置、不开语音会话、不重启服务**。
> 全文的事实分四档，逐条标注：**代码实测**（本仓/Raya 仓 file:line）、**生产留痕实测**（带会话 id）、
> **合同层核实**（协议/二进制符号存在，但未证生产可用）、**未验证**。

---

## 0. 一句话

founder 问的是「耳机模式、会议模式和 A/B 两个引擎，是同一套代码还是各做一套」。
本单的答案是：**三层切法成立，但三层的切线都要从 Lead 初判往旁边挪** ——

1. **房间层不是一块，是两套 package 级的栈 —— 而且抽象层级不同。**
   voice-codex 那套是**完整房间实现**（进房 `discord-room.ts:200`、身份断言 `:195`、收音 `:363`、
   放音 `:272`、presence `:239-260`）；voice-bridge 那套里 `VoiceRoomRuntime.ts:21-96`
   **只是回调路由器 + `SessionSlot`**（文件头 `:1-15` 自述），**不进房、不验身份、不放音** ——
   物理连接在 CLI/wiring、耳朵在 `roomEars.ts:42`，且 `roomEars.ts:53-58` **把说话人身份丢掉了**
   （`routeFrame` 只收 `(frame, format)`）。两者只共用 `BotRegistry`/`DiscordDeps`。
   voice-codex 那套被引擎 A 的输出格式塑形（放音口 `playSpeech(speechId, pcm24Mono)`）。
   ⇒ 「A/B 共用房间层」成立，但**先要决定共用哪一套，并且必须有人负责把两套收敛**（plan.md 闸 G1）。
2. **引擎抽象已经存在，只是只覆盖了 5 个引擎里的 2 个。** `packages/voice-core/src/types.ts:151-263`
   已有 `VoiceBackend` / `AnnouncerSession` / `ConversationSession` 三个接口和一个 registry；
   edge-tts 与 gemini-live 实现了它，**Codex realtime、OpenAI realtime、ElevenLabs 三个都没有**。
   ⇒ 本单**不发明新接口，扩这一套**。
3. **模式层不是零，但两个模式缺的东西完全不同。**
   **耳机**：规则层（`packages/voice-core/src/headphone/*`）今天**已经是引擎无关的纯逻辑**，筛选、用嘴批、退出都在；
   缺 ① 唯一的音频面是桌面 dry-run（`voice-headphone/src/null-audio-io.ts:1-7` 自己写着 VC 音频路径未实现）
   ② **进来播报**没有 ③ **存活信号**没有。
   **会议**：`voice-bridge/src/huddle/*` 有**即时起会 + 会中编排 + 会后 landing 三段代码**，
   ⛔ **但产品闭环没有成立** —— PRD FLY-1851 的预约/提醒/link（R-4–R-10）、时长（R-2b）、互动 HTML（R-22/R-27）、
   逐条 action item 互动（R-23）、repo 归档（R-25）、会后读转写的 note taker（R-21 §41）全都没有；
   而且现有 landing 在**她逐条批 action items 之前**就把立项 issue 置 Done（`ConclusionPipeline.ts:1-15`），
   与 **R-24 直接冲突**；控制口（`sendText`）还绑死 gemini。逐条见 research.md §3.5 红框。

⇒ 所以本单的交付不是「确认 Lead 初判」，而是**把切线画在正确的位置**，并给出「refactor 旧代码、不重写」的逐模块落点 ——
其中一部分旧代码在 **Flywheel 本仓**（不是 Raya 仓），这一点 issue 正文没有预料到，是本单的主要更正。

🔴 **2026-09-23 06:17Z founder 又定了一件事：引擎 A 用 GPT Live。**
A 的前台改成公开的 **`gpt-live-1`**（`wss://api.openai.com/v1/live/sessions`，`session.start` + `delegation.type=client`），
B 继续 **Codex 0.156.1 V2 + `gpt-realtime-2.1`**。
这条对本单的接口合同有一个**直接后果**：Live **自带 client delegation**
（委托事件带 `delegation.id`，应用按同一 id 用 `session.commentary.append` 回送）
⇒ **`handoffToLead` 在 A 上用这一对事件当接缝，⛔ 不要再另造函数工具** ——
但 ⛔ **它不等于 `handoffToLead` 本身**：delegation 是「模型 → 应用」的 inbound 请求 + 相关句柄
（原始事件只有 `{id,type,target}`，不含任务文本），outbound 的 intent 仍由模式层从已持久已归属的
utterance 构造、经真正的 Lead carrier 派发；`session.commentary.append` 只负责把结果说出来，不是业务 commit（research.md §4.1 ③）。
模型与端点在合同里做成**配置项**（research.md §4.2b）。
事实来源：FLY-2799 `engineering/doc/FLY-2799-codex-voice-container/gpt-live-handoff.md`＠`15fe2c875`「给 FLY-2798 用」（单场本机实测；⛔ 未接真实房间、未接真实 Lead）。

⚠️ 另有一条贯穿全局的事实：**`handoffToLead(intent)` 今天还不是一个接口**。
她说的每一句话都被整句塞进 Lead 邮箱、由 Lead 一整轮去想，这正是 2026-09-23 03:05Z 那场实测里
38s / 18s 延迟的成因本身（FLY-2786 `exploration.md:2.1`）。

## 1. founder 到底在问什么

> founder 2026-09-23 05:09Z：耳机模式、会议模式和 A/B 两个引擎是同一套代码还是各做一套，要先想清楚再开工。

这句话里有两个正交的问题，必须分开答，合在一起答一定错：

| | 问题 | 本单的答案形态 |
|---|---|---|
| Q-a | **模式**（耳机 / 会议）之间要不要共用代码 | 共用「怎么把话送出去、怎么收回来」，**不共用**「什么时候该说什么话」 |
| Q-b | **引擎**（A / B）之间要不要共用代码 | 共用房间层与模式层，引擎本身两个适配器；**接口由模式层的需要定义，不由引擎能力定义** |

⚠️ 第二条是本单最容易做反的地方。
如果接口按「引擎 A 今天能做什么」来画，B 接不进来；
如果按「两个引擎能力的交集」来画，模式层要的东西（比如「念这一段指定文字」）会被砍掉。
⇒ **接口按模式层的需求定义，引擎适配器负责把缺的那部分补上或明确报 unavailable。**

---

## 2. 模式层到底要哪些动作（从 PRD 反推，不从代码反推）

这一节是接口合同的**需求来源**。逐条只引 PRD 里她本人已定的条款。

### 2.1 耳机模式（PRD FLY-1850）

| 能力 | PRD 依据 | 它需要引擎提供什么 |
|---|---|---|
| **进来播报** | `prd.md:731-745` §5.1「她进入语音模式那一刻」把积压的问题与汇报一次性给她；「**他是一定要主动开口的**」 | **`speak(text)`** —— 文字是模式层生成的，引擎只负责出声 |
| **念什么、念多少** | `prd.md:747-761` §5.2「进来的那一层 = 全部 / 出声的那一层 = 筛过的」 | 同上；筛在模式层做，引擎不参与 |
| **新消息主动念** | `prd.md:731-745` §5.1「就像现在用 Discord 一样：有新消息才处理」 | **`speak(text)`** + 一个「现在能不能插话」的状态 |
| **存活信号** | `prd.md:775-819` §5.4「通道无法自查时，沉默必须被主动打破」；量级锚点「一小时」（**体感阈值，非配置值**，§6.2 仍留空） | **`speak(text, kind='heartbeat')`** —— kind 存在的第一个硬理由：存活信号必须能被降级/压制而不影响正文 |
| **筛选** | `prd.md:762-774` §5.3「给机制，不给标准」：起点不筛 → 她随口说一句「这个不用告诉我」→ 它记住 → 下次少一点 | **`onUtterance`** —— 要给到足以在模式层认出意图的原始信息（逐字文本 + `final` + 说话人归属）。⚠️ **认意图的是模式层，不是引擎**（见 §2.3 第 3 条） |
| **用嘴批 ship** | `prd.md:959-968` §5.7 她 2026-08-20 02:28 PT 明确答 **yes**；阶梯为「先落书面回执 → 校验绑定 → 校验 founder 身份 → 才写；沉默不算同意」 | **`onUtterance` + `handoffToLead`** + 一条**必须念出原文并等确认**的回路（见 2.3） |
| **退出** | `prd.md:731-745`（进入/退出语音模式是模式层的状态机）；会话生命周期已由 FLY-2701 定义 | **会话起止** |
| **复述兜底** | `prd.md:830+` §5.6 收窄到一格：**动手前念专名和编号** | `speak(text, kind='readback')` + 必须拿到「念完了」的回执 |

### 2.2 会议模式（PRD FLY-1851）

| 能力 | PRD 依据 | 它需要引擎提供什么 |
|---|---|---|
| **起会** | `prd.md:561-576` R-4/R-5/R-8/R-10：她发起并提前安排；到点各自进房；**只有她没进来时**提醒她一嘴；提醒必须带 link | **会话起止**。⚠️ FLY-2701 的 `voice_schedules` 只提供了**预约/启停的基础设施**，**没有**和会议模式的提醒/link 产品路径接起来 ⇒ ⛔ 不能写成「已覆盖」 |
| **会议上下文** | `prd.md:561-576` R-9「会前她先说个大概要聊什么；Lead 视议题决定准不准备」；R-16「把 meeting notes 带上当下一场的 context」 | **会话起止时的上下文注入**（引擎 A：进 prompt；引擎 B：进 thread baseInstructions） |
| **带节奏** | `prd.md:577+` R-11「Lead 主动带节奏，参照人类正常开会的互动感」 | **`speak(text)` 的主动权在模式层**，不能只在「她说完之后」才有机会出声 |
| **插话/被插话** | R-12「她一插话，Lead 立刻停」 | **三件齐，不是一个 `stopSpeaking()`**：`roomDetectsBargeIn` + `localPlaybackCancel`（均归 RoomIO）+ `turnCancelOrSuppress`（引擎适配器对被取消那一轮建立持久 fence）。只做前两件旧答案会再冒出来（research.md §4.3） |
| **复述兜底** | R-13 与耳机侧同口径：**只有专名和编号，动手前念一遍** | 同 2.1 |
| **结束** | `prd.md:655-663` R-15 她说「结束了」并退房 → Lead **也退出，不留在房里等**（R-39，她 2026-08-21 18:51Z）；R-17 结束时可以口头总结 | **会话起止** + `speak` |
| **纪要** | `prd.md:664-710` R-21（已被 §41 修订：note taker **不在场，会后读转写**）、R-22 可互动 HTML、R-24b 发在那条 issue 的 thread | **不需要引擎**：吃的是转写留痕，会后由 runner 做。⇒ **纪要不进引擎接口** |

### 2.3 从 PRD 直接得出的三条接口硬要求

1. **`speak` 必须带 kind。** 存活信号（§5.4）、复述（§5.6/R-13）、正文播报（§5.1）三者的
   可打断性、可压制性、是否必须留回执**都不一样**，一个无参数的 `speak(text)` 撑不住。
2. **`speak` 必须有可观测的分阶段回执。** 复述兜底和用嘴批 ship 的阶梯（§5.7「先落书面回执」）
   需要知道「这一句走到哪一步了」。
   ⛔ **但任何本地状态都不等于「她听见了」** —— 今天引擎 A 的 `confirmed`
   （`voice-codex/src/session.ts:457-466`）只表示**本地 PCM 已写给播放器**，证据名就叫
   `realtime_playback_submitted`；`WaitingMouth`（`audio.ts:216-228`）写完最后一帧就 resolve、**不等 drain**
   ⇒ 连「播放队列已排空」都不是，更不证明 Discord 远端交付或人耳。
   ⇒ 合同要定的是**可观测阶段**（内容被证明 / 已 submitted / 失败），播放尾部只有 `audibleTail()` 的**估算**，
   ⛔ 不许把任何一档命名成「她听见了」。
3. **`onUtterance` 必须交出足以让模式层认出意图的原始信息。** §5.3 的收敛机制（「这个不用告诉我」）
   和 §5.7 的用嘴批都要在一句口语里认出动作 —— 但**认意图的是模式层，不是引擎**
   （换引擎不该影响「芝麻关门」「确认/不批」认不认得）。
   ⇒ 引擎必须给：**逐字文本 + `final` + 说话人归属**；归不上时给 `attribution:"unknown"` 而不是自己丢。
   （§5.3 明写「那个『说一声』的动作必须便宜 —— 她在开车」⇒ 不能要求她做复杂操作，
   但这约束的是模式层的识别策略，不是引擎接口。）

---

## 3. 三层切法：Lead 初判 vs 本单核实

### 3.1 Lead 初判（issue 正文）

1. 房间层 = 现有通用 `packages/voice-codex`，A/B 共用，不重做
2. 对话引擎 = A（OpenAI 实时前台 + 后台 Lead）/ B（Codex 实时语音容器）两个适配器
3. 模式层 = 与引擎无关，只通过接口用引擎

### 3.2 本单的核实结论（依据逐条见 research.md §3）

| 初判 | 核实结果 |
|---|---|
| 「房间层 = `packages/voice-codex`」 | **要改。今天有两套房间层。** ① `voice-codex/src/discord-room.ts`（进房 `:200`、身份断言 `:195`、收音 `:363`、放音 `:272`、presence `:239-260`、收听健康 `:647`）；② `voice-bridge` 的一套：`roomEars.ts:42 wireRoomEars`（物理耳朵）+ `VoiceRoomRuntime.ts:21-96`（**只是回调路由器 + SessionSlot，本身不进房、不验身份、不放音**，文件头 `:1-15` 自述）+ `SessionSlot.ts:32-67`。**②的路由面是引擎无关的**（`routeFrame(frame, format)` 只吞 `Buffer` + 不透明 `format`，gemini 与 eleven 共用），⚠️ 但 `roomEars.ts:53-58` **把说话人身份丢掉了**（userId 只出现在 `onError`），⇒ 它今天满足不了本单的归属要求；**①被引擎 A 塑形**：放音口是 `playSpeech(speechId, pcm24Mono)`（`discord-room.ts:272`），24k mono 正是 OpenAI realtime 的输出格式。⇒ V1 要定的是**哪一套当底座**，而不是默认①（见 §3.4） |
| 「A/B 共用房间层，不重做」 | **成立。** 且 ① 对引擎 A 的编译期依赖只有一个类型名 `RealtimeAudioOwner`（`discord-room.ts:17` import，定义在 `realtime.ts:57-61`），内容是纯数据形状 `{utteranceId, ownerUserId, ownerName}`，**没有 OpenAI 协议语义**。⇒ 把这个类型挪到房间层自己的文件里，①的接缝就干净了。Raya 仓 `apps/voice` 里那套平行房间层（`DiscordAdapter`/`VoiceRoom`/`Downlink`/`Uplink`）⇒ 全判「**不要**」，⛔ 不能三套并存 |
| 「对话引擎 = 两个适配器」 | **成立，但接口已经有了。** `packages/voice-core/src/types.ts:151-164` `VoiceBackend`、`:178-184` `AnnouncerSession`、`:212-247` `ConversationSession`、`:56-70` `VoiceBackendCapabilities`、registry `backends/registry.ts:27-53`。⚠️ `factory.ts:102-116` 今天只注册了 **edge-tts** 和 **gemini-live**；`voice-codex/src/realtime.ts:221 RealtimeFrontend`（OpenAI）**没有 `implements`**，被一个本地结构型 `FrontendLike`（`session.ts:34-40`）消费；ElevenLabs 同样没有。⇒ **V1 的接口合同 = 扩 `ConversationSession`，不是发明新的** |
| 「模式层与引擎无关」 | **原则成立，现状比初判好。** 耳机模式的规则层今天已经在 `packages/voice-core/src/headphone/` 并且引擎无关：主动念 `turn-machine.ts:228,:276`、筛选 `tap-filter.ts:33`、用嘴批全套阶梯 `turn-machine.ts:21-30,:87-95`（**receipt-first，沉默不算同意**）、退出 `turn-machine.ts:39,:583-588` + `phrases.ts:15`。⚠️ **缺三格**：唯一的 `HeadphoneIO` 实现是桌面 dry-run（`voice-headphone/src/null-audio-io.ts:1-7,:55`，经 edge-tts 念到 Mac 扬声器）、**进来播报没有**、**存活信号没有**（等待音床 `voice-codex/src/audio.ts:100,:173,:177` 只在 voice-codex 房里）。会议模式在 `voice-bridge/src/huddle/*` 有**三段代码**（起会 `GlawCommand.ts`、上下文 `FeedPipeline.ts:39`、带节奏 `HuddleSession.ts:1211,:312,:383`、结束 `:984`、landing `ConclusionPipeline.ts:96`），⛔ **但不等于 PRD FLY-1851 的闭环已成立**（预约/提醒/互动 HTML/逐条 action item/归档五段未覆盖，且 landing 会提前 Done，见 research.md §3.5 红框）；**控制口是 `sendText` ⇒ 绑死 gemini**（`HuddleSession.ts:1105-1119`） |
| 「B 依赖 Codex 能否塞文字让它先开口，由 V5 实测」 | **RPC 存在，行为待证 —— 两条候选路径都还不是「已验证能出声」。** `appendSpeech`（意图：逐字念）与 `appendText(role:"developer")`（意图：给文本项）。⚠️ 上游 FLY-2446 `exploration.md:1.3` 明写 **`appendText` 只往会话里加一条文本项、不触发 response**，且 v2 上 `role=developer` 的行为**未验**；Raya `runtime.ts:595-599` 那个调用点**只证明有人这样调过，不证明它让模型开了口**（当时 app-server 侧 `create_response:true` 才是触发源）。⇒ **V5 第一步要测的不是「有没有这个 API」**（本机 0.154.0 二进制的方法枚举里有，as-of 2026-09-22），**而是三件**：① 生产能不能跑通（FLY-2655 2026-09-22 实测收不到回话）② `appendSpeech` 的逐字保真率 ③ `appendText(developer)` 到底会不会触发出声。详见 research.md §1 |

### 3.3 修正后的分层（本单定稿）

```
┌─────────────────────────────────────────────────────────────┐
│  模式层  耳机 / 会议        —— 引擎无关，从 Raya 旧代码找回    │
│  进来播报 · 新消息主动念 · 存活信号 · 筛选 · 用嘴批 · 退出      │
│  起会 · 会议上下文 · 带节奏 · 结束                             │
└──────────────┬──────────────────────────┬───────────────────┘
               │ VoiceEngine 接口          │ LeadHandoff 接口
               │ speak / onUtterance       │ handoffToLead
               │ 会话起止                   │
┌──────────────┴───────────────┐          │
│  对话引擎（两个适配器）         │          │
│  A: OpenAI Realtime 前台      │          ▼
│     + 后台 Lead               │      Lead 本体（现有 mailbox / Bridge 通路）
│  B: Codex 实时语音容器         │
│     （装当前 Lead 的 memory）   │
└──────────────┬───────────────┘
               │ RoomIO 接口（收音帧 / 放音帧 / 在房状态）
┌──────────────┴──────────────────────────────────────────────┐
│  房间层  进 Discord 语音房 · 收音（含 DAVE 解密）· 放音 · presence │
│  A/B 共用，不重做 —— 但需先把引擎 A 从 voice-codex 里拆出去       │
└─────────────────────────────────────────────────────────────┘
```

**与初判的实质差别有三条**：
1. 多了一条 `RoomIO` 的显式接口，且**要先在两套房间层里选一套**（见 §3.4）；
2. 引擎接口**不新建**，扩 `packages/voice-core` 已有的 `VoiceBackend` / `ConversationSession`；
3. 模式层的「找回」有**两个来源**：Raya 仓 `apps/voice@f669d1b`，以及 **Flywheel 本仓已有的 `voice-core/src/headphone/*` 与 `voice-bridge/src/huddle/*`**。issue 正文只提了前者。

### 3.4 房间层选哪一套 —— 本单给判断，不替 V2/V3 拍板

| | ① `voice-codex/src/discord-room.ts` | ② `voice-bridge/src/VoiceRoomRuntime.ts` + `roomEars.ts` |
|---|---|---|
| 引擎无关？ | 接近（只差一个类型名的位置） | **是**（已被 gemini 与 eleven 两个引擎共用，`eleven/ElevenSession.ts:57-62`） |
| 今天在生产跑吗 | **是**（launchd `com.flywheel.voice`，rg 模式） | **否**（`com.flywheel.voice-bridge` 未加载） |
| DAVE | 解密在 `@discordjs/voice` + `@snazzah/davey` 里；仓内只有诊断解析（`voice-bridge/src/bots/discordWiring.ts:277-322`，策略 `:159-170`，版本钉 `:210`），voice-codex 经 `discord-room.ts:647 receiveDiagnostic` 消费 | 同一份诊断解析（就住在 voice-bridge 里） |
| 收听健康状态机 | `voice-core/src/receive-health.ts:1-23`（含 `"dave_decrypt"` 原因）+ `voice-codex/src/receive-health.ts` | 无等价物 |
| 放音口形状 | `playSpeech(speechId, pcm24Mono)`（`:272`）—— 被 24k mono 塑形 | `Buffer` + 不透明 `format` |
| 等待音床（存活信号的现成载体） | **有**（`voice-codex/src/audio.ts:100 WaitingMouth`、`:173 setWaiting`、`:177 setBedEnabled`） | 无（只有提示音 `voice-bridge/src/audio/defaultCues.ts:73-92`） |

⇒ **本单的建议（不是裁定）**：以 **① 为底座**（它在生产跑、有收听健康、有等待音床），
把 `RealtimeAudioOwner` 挪出 `realtime.ts`、把 `playSpeech` 的 `pcm24Mono` 换成带 `format` 的通用帧，
再把 ② 的 `SessionSlot` 单会话互斥语义（`SessionSlot.ts:32-67`）并进来。
⛔ 本单**不删** ②，也不宣布它作废 —— 它是 `/gemini`、`/eleven` 今天的载体，作废与否不在本单范围。

---

## 4. 三个必须先说清楚的边界

### 4.1 `handoffToLead` 不是今天那条路的改名

今天「她说一句话 → Lead 回一句话」走的是：转写 → 镜像进 thread → `chat-ingest` 写 Raya 邮箱 →
Bridge 收件循环 → Raya **一整轮 Codex turn**（与她所有其他工作串行）→ 文字回 thread →
Bridge 3s 轮询 → 语音进程 4s 轮询 → 切段合成 → 播出。
实测 2026-09-23 03:05Z 会话 `c1b4b972`：说完到听到第一个字 **≈38s / ≈18s**（FLY-2786 `exploration.md:2.1`）。

⇒ **`handoffToLead(intent)` 只承载「要动手的事」**（开单、批 ship、改优先级），
它是**异步的、可以慢**；「她说了什么、要它答一句」的回路**不走这条**，由引擎自己答。
把这两件事合成一条路，正是今天慢的成因。

⚠️ 这条**部分推翻 founder 2026-09-08 的 F2/F3**（「每句进 mailbox 由 Lead 答」）与
FLY-2655 的裁定（「Realtime 只做 STT/TTS，不得独立回答」）。
**本单不替她拍这一板** —— FLY-2786 的讨论页第 10 区块已经把这一问交给她；
本单只做到「接口两条路分开画」，哪条路默认开着由她定。

### 4.2 「引擎 B 装当前 Lead 的 memory」是接口的一个参数，不是 B 独有的能力

9 月初那版是 `thread/start` 时把 `IDENTITY.md + MEMORY.md` 作为 `baseInstructions`
（Raya `apps/voice/src/codex/CodexLeg.ts:118-134@f669d1b`）。
引擎 A 也有同一个位置（Realtime 会话的 instructions）。
⇒ 合同里叫 **`initialSessionContext`**（开场注入），A/B 都要实现；差别只在**容量与更新时机**，不在有没有。
⚠️ 它与运行中的 `injectContext` 是**两件事** —— 后者 `types.ts:223-231` 明写必须永不触发出声、且不写 transcript sink（research.md §4.1 ⑤）。

### 4.3 纪要不进引擎接口

PRD FLY-1851 §41 已把 note taker 改成「不在场，会后读转写」。
⇒ 纪要只依赖**转写留痕**（今天已有：`~/.flywheel/voice/sessions/<id>/events.jsonl`），
不依赖引擎接口。V1 合同里只保证「转写留痕的 schema 对 A/B 一致」，不定义纪要 API。

---

## 5. 本单交付与不做什么

**交付**（落在 research.md / plan.md）：
1. 接口合同一页：`speak(text, kind, {verification})`、`onUtterance`、`handoffToLead(intent)`、会话起止、`initialSessionContext` + `injectContext`；A、B 逐项怎么实现。
2. 盘点表两张：现有通用代码逐项 file:line；Raya `apps/voice@f669d1b` 每模块判「找回到模式层 / 找回到引擎 B / 不要」。
3. V2–V6 实现范围更新（FLY-2796..2800）。

**不做**：不写实现代码；不改生产、配置、服务；不开语音会话；不替 founder 拍「前台能不能自己回答」那一板。
