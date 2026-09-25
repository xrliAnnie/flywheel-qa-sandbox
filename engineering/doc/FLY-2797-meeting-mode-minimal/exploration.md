# FLY-2797 会议模式最小集 — 探索
Issue: FLY-2797 (https://linear.app/geoforge3d/issue/FLY-2797/语音v3-会议模式最小集引擎无关带议题起会-载入会议上下文-lead-带节奏-说结束就退出-转写进-thread-出纪要-找回)
日期: 2026-09-24
基于: 无

> 本轮只做设计，**不写产品代码、不开实现 PR**。实现要等 FLY-2796（RoomIO 收敛 + 模式层）合入后另开 code run。
> 本机 `linear-api` MCP 返回 401。issue 正文与 Lead 的 G2 裁定取自本次派发注入的 `linear-issue-context`，没有从 Linear 重新读取。
> FLY-2796 / 2798 / 2863 都还没合入 main。本文引用的是它们在 origin 分支上的当前版本，SHA 写在 research.md §0。

## 1. 这一单要回答的问题

一场会要跑通五件事：带议题起会、载入会议上下文、Lead 带节奏、说结束就退出、会后转写进 thread 并出纪要。
每件事都要说清两点：接在 FLY-2796 模式层的哪个接口上；在引擎 A（`gpt-live-1`）和引擎 B（Codex V2 + `gpt-realtime-2.1`）上分别怎么实现。

Lead 本轮追加了两条约束：

1. **声线**（founder 9-24 定）：跟哪个 Lead 开会，就用 PRD 里给这个 Lead 定的声线，⛔ 不用合成音。
2. **话术**（FLY-2863 原则）：用对话口吻，⛔ 不照着文字原样念。

## 2. 现状：骨架都有，只是没接成一条线

| 环节 | 已经有的 | 缺的 |
|---|---|---|
| 起会 | Raya CoS 的 business round 建会议记录（`raya-cos/src/business-round.ts:334-342` → `meeting-artifact.ts:56 prepareMeetingStart`），再调 `flywheel-comm voice-session start --meeting-id`（`voice-session.ts:307-321`）。Bridge 核对 meetingId 与当前会议一致、状态 ∈ {starting, live, interrupted}，并按 `meeting.leadId` 解析 Lead（`voice-session-start.ts:155-189`） | 下发给语音进程的会话信息里**没有议题**：`projectSession` 只带 `meetingId`，没带 `topic`（`voice-session-services.ts:224-253`） |
| 会议上下文 | Raya `meeting-context.ts@f669d1b`（61 行）的规则：meetingId 一致、状态白名单、把 Lead 记忆拼进 instructions、缺声线就用默认 | 规则的前两条 **Bridge 已经在执行**（上一行）。Flywheel 的语音前台 prompt `buildFrontendPrompt(displayName)`（`voice-codex/src/realtime.ts:148-155`）只让它转写和朗读，**没有议题、没有会议规则** |
| 带节奏 | huddle 的 `HuddleSession` / `AddressRouter` / `ConfirmationLadder` 是 Gemini 多 Lead 编排 | 合同 G2-3 裁定：只抽取引擎无关的策略，⛔ 不以多 Lead 编排为基底 |
| 结束 | FLY-2796 的 `ExitProtocol.ts`（找回 Raya 版）：退出条款注入、`SpokenExitGuard` 只认 founder 已持久的原话；会议信号 `voice-signal.json` 的 ended reason 已有 `she-left` / `text-stop` / `voice-stop`（`voice-codex/src/meeting-voice-signal.ts`） | 退出句与匹配规则是**耳机版**（「好，退出语音模式。」且要求整句全等），不能直接用于「先小结再退出」 |
| 转写 | founder 的每句话写进 `<meetingStateDir>/voice-evidence/events.jsonl`（`kind:"realtime_transcript", role:"user"`，`delivery.ts:88-95`），并逐句镜像到语音 thread（`delivery.ts:139-143`） | **Lead 自己说的话没写进 evidence**。thread 里只有她一方的话 |
| 纪要 | `meeting-notes-scheduler`（launchd 每 120s 一次）：每场会建一张 meeting issue；会议归档为 `ended` 后派 note-taker runner（`meeting-notes` skill）出纪要，并投到该 issue 的 thread（R-24b） | 纪要读的是上面那份 evidence。**只要进程不写 `meeting_container_live` 锚点和终止信号，纪要就判为不可信而停下**（`meeting-notes-scheduler.ts:567-686`）。新模式层接进来时，这条合同最容易断 |

## 3. 两个关键发现

### 3.1 纪要调度本身不会提前把 issue 置 Done

合同里提到的「会提前 Done」指的是 huddle 的 `ConclusionPipeline`（`setStatus(...,"Done")` 在 `:88`、`:188`）。
`meeting-notes-scheduler` 自己**不会**把 issue 置 Done：它只建 issue、派 runner，会议 cancelled/missed 时置 Canceled。
note-taker 的 skill 只在 founder_review 拿到明确批准后才结束。

⇒ G2-1 裁的是「⛔ 不调用 landing」，**不影响复用纪要调度**。新的会议模式根本不经过 `ConclusionPipeline`。

⚠️ 但纪要调度会**连带**产出 action items 和互动卡（R-20～R-27 那一套）。这是它现有的行为，本单不新增、不改动、不验收，详见 plan.md §8 Q2。

### 3.2 「不用合成音」与合同 K4、FLY-2798 设计有一处正面冲突

- 引擎 A 的设计（FLY-2798 `plan.md:100,128`）：凡是要照稿念的内容（`brief` / `question`）都走 `announcerId=edge-tts`，并写明「V3 需要确定念完的开场/提问必须用 brief/question」。
- founder 9-24：会议里 ⛔ 合成音。FLY-2863 探索（`exploration.md` §2.1）也把她那句「声音不一样」定位到 edge-tts 上。
- 如果按 2798 那句话做，会议的开场白和带节奏的每一句都会变成 edge-tts 的声音。这正是她抱怨的那个问题。

⇒ 本单的处理（plan.md §4）：开场、推进、小结都是**对话**，不需要逐字保真，所以走 `kind:"control"`，由引擎用该 Lead 的声线自己说。
只有「Lead 的原话必须一字不差传给她」这一种情况才用 `verification:"required"`，而且只能走**同声线**的播报器（由 FLY-2863 提供）。
在同声线播报器就绪之前，这类内容只发到 thread，⛔ 不退回 edge-tts。
这与 2798 的那句写法冲突，需要 Lead 对齐（plan.md §8 Q3）。

## 4. 最小集的边界（Lead G2 裁定，照抄不改）

- **做**：带议题起会 + 载入上下文、Lead 带节奏、说结束就退出（含 R-39：她退房 Lead 也退）、转写进 thread + 要点纪要。
- **不做（第二批）**：约时间与提醒带链接（R-4～R-10）、每场一张 issue + 可互动 HTML + action items 逐条批（R-20～R-27）、R-24 结单时机。
- 另外明确不在本单：R-12 打断（需要 RoomIO 检测、本地停播、引擎侧 turn 取消三件齐，由 V4/V5/V6 验）、R-13 动手前复述（会中不派发动作，见 plan.md §4.4）、R-16 带上上一场纪要、R-2b 时长。
