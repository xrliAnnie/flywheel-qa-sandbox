# FLY-2797 会议模式最小集 — 调研
Issue: FLY-2797 (https://linear.app/geoforge3d/issue/FLY-2797/语音v3-会议模式最小集引擎无关带议题起会-载入会议上下文-lead-带节奏-说结束就退出-转写进-thread-出纪要-找回)
日期: 2026-09-24
基于: exploration.md

## 0. 依赖基线（都没合入 main，实现开工时必须重新钉住）

| 依赖 | 版本 | 本单要用的东西 |
|---|---|---|
| FLY-2795 合同 | `313befcfa` plan.md §4 V3、research.md §4 | 五项接口、K1–K6、capability 准入矩阵 |
| FLY-2796 模式层 + RoomIO | `origin/flywheel-FLY-2796@a6477251a`（初稿）；R1 评审时已前进到 `513e5c82d`，下文接口与 `513e5c82d` 核对一致 | `VoiceV1Session`（`voice-core/src/types.ts` 新增段）、`RoomIO`（`room-io.ts`）、`ExitProtocol.ts`、`FakeV1Session.ts`、`DurableTranscriptSink`、`handoff.ts` |
| FLY-2798 引擎 A | `origin/flywheel-FLY-2798@64cb70d4e` | `GptLiveBackend` / `CompositeSpeech`；§4 方法映射；§6.2 两张脸分工 |
| FLY-2799 引擎 B | `origin/flywheel-FLY-2799@7f639400d` | B-1～B-4 实测问题；`gpt-live-handoff.md` |
| FLY-2863 播报三类 + Lead 消化 | 本机工作树 `~/Dev/flywheel-FLY-2863@cbb1cf244`，**origin 上还没有这个分支**，设计进度 2/5 | 只引用它 `exploration.md` 里已经写下的原则：声线只从 `realtimeVoice` 取、在耳机和会议模式禁用 edge-tts、内容由 Lead 消化后用对话口吻说 |
| Raya 找回源 | `~/.flywheel/raya/code@f669d1b` `apps/voice/src/meeting-context.ts`（61 行） | 已逐行读过，见 §2 |

⛔ 2796 合入前，下文所有「2796 提供 X」都是**消费提案**。合入后按实际导出核一遍，对不上的退回 Lead，不私自补第二套。

## 1. 2796 模式层给会议模式留的接口（逐个核过源码）

| 接口 | 形状（2796 分支） | 会议模式怎么用 |
|---|---|---|
| `VoiceV1Session.open(initialSessionContext)` | 空字符串直接抛错 | 开场一次性注入会议上下文 |
| `speak(text, kind, {pendingKey, verification})` → `SpeakReceipt` | kind ∈ brief/question/readback/heartbeat/cue/control；回执是 rejected / failed / completed 三选一的判别联合，身份字段 `pendingKey` + `requestDigest` | 开场、推进、小结一律用 `control`；Lead 原话用 `brief` + `required`（§3） |
| `onUtterance(listener)` → `VoiceUtterance` | 继承自 `DurableTranscriptEntry`，带 `transcriptId` / `utteranceId` / `generation` / `attribution: known\|unknown` / `role` / `final` | 用于结束口令判断、转写收集 |
| `injectContext(text)` | 运行中静默注入 | 会议最小集**不依赖它**（§3.3） |
| `RoomIO.onPresence` → `{founderPresent, humanCount}` | 精确判断 founder 在不在房间 | R-15 / R-39：她离开就结束 |
| `RoomIO.audibleTail()` | `{estimated:true, remainingMs, drained}` | 小结说完后等尾音（**估算**）排空再退房 |
| `ExitProtocol.ts` | `composeStartInstructions` 注入退出条款并做 8192 上限检查；`SpokenExitGuard` 只认同一 session / generation 下 founder 已持久、已归属的 final 原话 | 找回并加一个会议变体（§4） |
| `DurableTranscriptSink.appendDurable` → `TranscriptDurabilityReceipt` | 可等待、可回读，写失败显式抛错 | 会议转写的唯一底座 |
| 会话锁 | 2796 plan §3.2 写明 `/glaw` 这类会议映射为 `mode=meeting`，共用 `voice_sessions` 的房间行和 lease | 会议不另开会话状态机（K5） |

## 2. Raya `meeting-context.ts` 逐条处置

| 行 | 规则 | 处置 |
|---|---|---|
| `:26-27` | 没有 voice-mode request 或没有 meetingId → `null` | 由 Bridge 投影的 `mode` 决定，不再读 Raya 私有文件 |
| `:28-31` | request 的 meetingId 必须等于当前会议 | **Bridge 已执行**（`voice-session-start.ts:171-176`）。模式层再核一遍：投影里的 `meetingId` 与 session 行一致，否则拒绝开会 |
| `:32-36` | 状态白名单 starting / live / interrupted | **Bridge 已执行**（同上）。模式层不重复读文件 |
| `:37-44` | `loadLeadRegistry` + `assembleMeetingInstructions` | **换 loader**：Lead 身份与声线来自 Bridge 投影（`resolveLeadByAgentIdAcrossRegistry`），⛔ 不读 Raya roster |
| `:45-47,:58` | 把可用 Lead 记忆文件清单拼进 `baseInstructions` | **不搬到模式层**。记忆怎么装进引擎是引擎适配器的事：A 的前台拿「已筛选 memory」（2798 plan §4），B 的 `CodexLeg` 用 IDENTITY + MEMORY 拼 baseInstructions（合同 V5）。模式层只交一段 `meetingSection`，由适配器拼接 |
| `:57` | `voice: profile.voice ?? defaultVoice` | **改成严格**：会议声线 = `lead.realtimeVoice`，缺失时**不静默回退**（§5） |

⇒ 真正要找回的只有「会议段落怎么拼」这一件，外加两条已由 Bridge 执行的校验。61 行里大部分是 Raya 私有 loader，不搬。

## 3. 两个引擎在会议里的能力（按接口逐格）

| 能力 | 引擎 A：`gpt-live-1` | 引擎 B：Codex V2 + `gpt-realtime-2.1` | 会议模式在不成立时怎么办 |
|---|---|---|---|
| 开场注入上下文 | `session.start` 的初始指令。**上下文、声线、委托模式在开会时就固定，会中改不了**（OpenAI 官方 voice-websockets 文档）；预算按 token（2798 plan §4） | 2799 plan §3.1 `buildVoiceSessionContext`：身份与动作边界 → 完整 memory → 当前状态 → 模式/议题 → 退出规则，固定顺序；最终 prompt 预算 131072 UTF-8 bytes 且 32768 个估计 token，**已取消 8192 码点闸** | 超限 ⇒ `context_too_large`，拒绝开会；⛔ 不静默截断 |
| `speak(control)` 能否让它开口 | ✅ `session.commentary.append` 能触发开口（FLY-2799 单场实测） | 2799 plan §4：control 把**已列出的意图**映射成确定的中文引导句，经 `appendSpeech`、`verification=none` 说出；未列出的意图返回 unsupported，不偷偷用未验证的 `appendText` | 意图不支持 ⇒ 开场靠会议块里的「先开口」加原生开口（Codex v2 开会后会主动打招呼，FLY-1850 PRD 实测 16:10:41）；15s 仍无开口 ⇒ 记 `meeting_opening_silent` 并发文字提示 |
| 声线 | `session.audio.output.voice` 开会时固定。官方文档只示例了 `marin`，**alloy / verse 能不能用未验** | `voice` ∈ Realtime v2 的十个音色，alloy / verse / marin 都在 | 不支持该 Lead 的声线 ⇒ 按 K6 报「语音不可用」；⛔ 不换别的声线，⛔ 不退回 edge-tts |
| 说话人归属 | Live 转写不带说话人，要靠 RoomIO 的发言事件关联（2798 §5） | Codex 转写不带 `ownerUserId`（合同 B-3） | 归属为 unknown 的「结束了」**不能**直接触发退出（K3），由前台追问确认。她离开房间这条路不依赖归属 |
| 静默 `injectContext` | `session.thinking.append`，是否真静默待 2798 实测 | 未验 | 会议最小集不调用它；2798 在 A 上注入「任务状态」时由它自己负责 |
| Lead 原话逐字播报 | 2798 设计里走 `CompositeSpeech`（edge-tts）。**会议里禁用** | 没有现成的逐字路径（`appendSpeech` 是求模型复述，合同 B-2） | 等 FLY-2863 的同声线播报器；就绪前原话只发 thread，前台用对话口吻说一句「Lead 回了，我发在 thread 里」 |

## 4. 纪要链路对输入的要求（区分 writer 校验与 selector 行为）

**selector**（`selectMeetingTranscript`，`meeting-notes-scheduler.ts:567-686`）判为可信需要：

1. 会议归档 `status=ended` 且有 `endedAt`（Raya CoS 的 business round 在语音状态 ended 后归档）。
2. 终止信号能被 `parseTerminalSignal`（`:540-555`）解析：state 为 **ended 或 interrupted**，schemaVersion、meetingId、canonical `at`、合法 bootId 都对。⚠️ selector **不校验** ended reason。reason 白名单 {she-left, text-stop, voice-stop} 是 **writer** `writeMeetingVoiceSignal`（`meeting-voice-signal.ts:55-59`）校验的。
3. evidence 里有本场 `meetingId` 的 `meeting_container_live` 锚点；锚点到终止之间不能再出现 `meeting_container_starting` 或第二个 live（否则 `container_continuity_unproven`）；有多个 live 时只取最后一个可信片段，并披露 `excluded_previous_container_span`。
4. 可信时间窗里的畸形行 ⇒ 整体不可信；时间戳恰好落在锚点或终止时刻的行会被排除并披露 `excluded_ambiguous_boundary`。
5. `realtime_transcript` 行：`role` 是任意字符串（**assistant 也收**）、`text` 非空；`generation` **可以缺省**，出现时必须是整数（`:660-662`）。

⚠️ **selector 只收「已有」的行**：少写一条 assistant 行，照样返回 `trusted=true`。所以「完整」要由写入侧保证（plan.md §4.5 的收尾屏障），selector 保证不了。

⇒ 新模式层必须**原样保留**这组 evidence 的写入（`voice-codex/src/cli.ts:301-331` 的生命周期事件与信号），并且**补上 assistant 一方的转写**。今天只写 founder 一方（`delivery.ts:88-95`），纪要里只看得到她一个人在说话。

## 5. 声线的来源（founder 9-24 + PRD）

- 会议声线字段是 `LeadConfig.realtimeVoice`（`teamlead/src/ProjectConfig.ts:235`），和 edge-tts 用的 `voice` 字段是两回事。
- PRD 里给 Lead 定的声线在 FLY-1850 `prd.md:2066-2076` 和 `:2441-2458`（founder 2026-08-21 原话表）：
  **alloy → Honey Lemon · verse → Tadashi · marin → 主管 Lead**，其余七个「未选」（⛔ 不等于「不合适」）。
  规则是「音色跟 Lead 本人的性别和人设对上」。
- 今天的投影在缺失时静默给 `marin`（`voice-session-services.ts:232`）。对会议来说，这意味着另一个 Lead 会用主管 Lead 的声音说话，违背「跟哪个 Lead 聊就用哪个 Lead 的声线」。
  ⇒ 会议模式改成严格：缺失就拒绝开会并说明原因（plan.md §8 Q1）。
- ⚠️ **更严重的是字段非空但错配**。R1 评审只读核验 `~/.flywheel/projects.json`：17 个 Lead 的 `realtimeVoice` **全部是 marin**，Honey Lemon 也是（FLY-2598 激活时缺失一律设成 marin）。所以运行时的「非空」检查挡不住错配，必须靠部署前置对齐，并用现有的 `voiceModes.meeting` 做准入（plan.md §5）。

## 6. 话术原则（FLY-2863，只引用已写下的部分）

- ⛔ 不照稿念：开场、推进、小结都由引擎按会议规则用自己的话说。模式层只给**意图**（`control`），不给台词。
- 一件一件来：她说「这个可以了」就进下一项。**「够不够清楚」由她判断**（R-18），系统不设机器判据。
- 需要一字不差的只有「Lead 的原话」，而且必须用同一个声线。FLY-2863 选的是 X3：Lead 本体消化后写出要说的话，模式层用 Lead 的声线原样念。会议复用这条，不另造。
