# FLY-543 通用可插拔 voice skill — 实施计划（修订版 r2）

Issue: FLY-543 (https://linear.app/geoforge3d/issue/FLY-543/voice-核心通用可插拔-voice-skill全-lead-共用realtime-后端)
日期: 2026-07-06
基于: research.md r2（+ exploration.md §7 决定记录）

> **r2 修订说明**：初版 plan（whisper 本地管线默认后端 + push-to-talk POC）经 Codex
> design review 2 轮 APPROVED 后，Annie 收紧 round-1 范围（exploration §7）——本版按
> **双后端形态**重写：**Edge TTS（播报面）+ Gemini Live（对话面）+ 可插拔接口**。
> 本地模型（whisper/CosyVoice/Qwen）与独立 STT 全 defer。初版 review 通过的横切合同
> （安全边界/取消/argv 卫生/延迟口径/类型完备）**全部继承**，逐项标注。

## 0. 目标与非目标

**目标**（= round-1 全部范围）：
1. `packages/voice-core` 新包：speech-in/speech-out 双维度的可插拔接口
   （AnnouncerSession / ConversationSession / BrainAdapter / capability flags，§3 定稿）。
2. **EdgeTtsBackend**（播报面）：Lead「说」——读报告 / 早晚会播报。只出声，不听。
3. **GeminiLiveBackend**（对话面）：完整「跟 Lead 语音对话」——realtime 语音进+出，
   自带 ASR（round-1 因此无独立 STT），brain 经 ask_lead tool 接入。
4. POC CLI 两条命令：`say`（播报闭环）+ `talk`（对话闭环），Annie 本机跑通。
5. 真人 mic zh-en 混说 eval set（~20 句）在 Gemini Live 出基线；Edge TTS 中英混文本
   朗读可懂度检查。

**POC 安全边界（继承初版，硬约束）**：POC 的脑 = **只读「Lead persona 近似」**——
`claude -p` **零工具**运行（禁用形态以 spike 实测为准），只对话不执行任何动作。语音里说
"approve/ship/merge"只得到口头回应。**动作能力的语音路由**（完整 Lead 规则栈 + 审批
guard + 高危 transcript 确认门）显式 defer 到用例/bridge issue。理由不变：claude-lead.sh
完整启动栈无法由 identity.md 单文件诚实复刻。
（**初版的 ConfirmedTranscriptGate 随动作路由一起 defer**：它防的是「STT 误识别高危指令
被执行」，round-1 脑零工具、结构性无此路径；且实时对话流里逐句键盘确认会毁掉 Gemini
对话体验。设计已留档（初版 plan git 历史），动作路由 issue 落地时为必备件。）

**非目标**：Discord voice bridge（FLY-544）、产品用例（HL PRD）、声线克隆（FLY-547）、
transcript→Linear pipeline（FLY-548，但落盘它要的 JSONL）、本地模型（whisper/CosyVoice/
Qwen，defer 到测试轮；CosyVoice 只留接口位）、独立 STT（云端也不做；若细化中发现某
非-Gemini 路径确需 → flag Lead，不自加）、OpenAI Realtime adapter（接口容纳、实现
follow-up）、动作能力语音执行（见安全边界）。

## 1. 架构总览

```mermaid
flowchart LR
    subgraph 播报面["announce 面（Lead 说）"]
        TXT[Lead 文本<br/>报告/播报] --> AS[AnnouncerSession]
        AS --> ET[EdgeTtsBackend<br/>edge-tts 云端]
        ET --> SPK1[afplay 播放]
    end
    subgraph 对话面["converse 面（跟 Lead 语音对话）"]
        MIC[mic 采音<br/>ffmpeg avfoundation<br/>16kHz PCM 持续流] --> CS[ConversationSession]
        CS <--> GL[GeminiLiveBackend<br/>@google/genai ws<br/>ASR+VAD+打断内建]
        GL -->|ask_lead tool| BA[BrainAdapter<br/>claude -p 零工具·只读 persona<br/>脑在 repo]
        GL --> SPK2[ffplay 流播<br/>24kHz PCM]
    end
    AS --> TR[TranscriptSink<br/>JSONL → FLY-548]
    CS --> TR
```

分层职责：
- **AnnouncerSession / ConversationSession**：speech-out 面与 speech-in+out 面，
  后端按 capability 实现其一或其二（Edge TTS 只 announce；Gemini 只 converse，round-1）。
- **BrainAdapter**：只对话面需要；与后端正交（换后端不换脑接线）。
- **TranscriptSink**：共用层，两个面同一份 JSONL 审计记录。
- **AudioIO**：POC = 本机 mic/speaker；FLY-544 的 Discord 48kHz Opus 接同一格式协商位。

## 2. 包结构（新包 packages/voice-core）

```
packages/voice-core/
├── package.json              # name: flywheel-voice-core, type: module, bin: flywheel-voice-poc
│                             # deps: @google/genai（round-1 唯一新 npm 依赖）
├── tsconfig.json             # 对齐 token-usage（tsc → dist/）
├── src/
│   ├── index.ts              # 公共导出
│   ├── types.ts              # §3 全部接口/事件/能力类型 + VoiceError
│   ├── config.ts             # VoiceCoreConfig（env FLYWHEEL_VOICE_* + 参数，路径零硬编码）
│   ├── transcript.ts         # TranscriptSink 接口 + JsonlTranscriptSink
│   ├── backends/
│   │   ├── registry.ts       # id → factory；按能力面解析默认（announce→edge-tts，converse→gemini-live）
│   │   ├── edge-tts/
│   │   │   ├── EdgeTtsBackend.ts     # announce 面实现
│   │   │   └── EdgeTtsEngine.ts      # 子进程封装（0600 临时文件传文本）；TtsEngine 接口
│   │   │                             #（AzureTts 兜底留接口位，不实现）
│   │   └── gemini-live/
│   │       ├── GeminiLiveBackend.ts  # converse 面实现；capabilities 按 config.model 派生
│   │       └── GeminiLiveSession.ts  # ws 会话：事件映射/resume/ask_lead tool/打断
│   ├── brain/
│   │   ├── BrainAdapter.ts   # 接口
│   │   └── HeadlessClaudeBrain.ts    # claude -p 零工具（--resume 优先，历史回注 fallback）
│   ├── audio/
│   │   ├── MicCapture.ts     # ffmpeg avfoundation → 16kHz mono PCM 流；mute 开关
│   │   ├── StreamPlayer.ts   # ffplay 流播（24kHz PCM）；interrupt = kill+重开
│   │   └── FilePlayer.ts     # afplay（mp3 文件，播报面）；interrupt = SIGTERM
│   └── cli.ts                # flywheel-voice-poc say / talk
└── src/__tests__/            # vitest；子进程/ws 全部可注入 mock（ExecFileFn 注入，同 FLY-494 形态）
```

## 3. 接口定稿（types.ts 的合同）

```ts
export type AudioFormat = { encoding: "pcm16" | "wav" | "mp3"; sampleRateHz: number; channels: 1 | 2 };
export type Turn = { role: "user" | "assistant"; text: string; ts: string };
export type ResumeHandle = { backendId: string; payload: unknown };
export type ToolResult = { callId: string; output: string };
export type ScheduleHint = "silent" | "when_idle" | "interrupt";

export class VoiceError extends Error {
  constructor(
    public readonly code:
      | "unsupported" | "component-missing" | "subprocess-failed"
      | "timeout" | "cancelled" | "backend-protocol",
    message: string,
    public readonly cause?: unknown,
  ) { super(message); }
}

export interface VoiceBackendCapabilities {
  announce: boolean;                   // 提供 AnnouncerSession（speech-out only）
  converse: boolean;                   // 提供 ConversationSession（speech-in+out）
  bargeIn: boolean;
  toolCallScheduling: "none" | "basic" | "scheduled";
  transcriptGranularity: "final-only" | "partial";
  supportsResume: boolean;
  sessionLimits?: { connectionSec?: number; audioSec?: number };
  voiceCloning: boolean;               // FLY-547 预留
  audioOut: AudioFormat[];
  audioIn?: AudioFormat[];             // converse=false 可缺省
}

export interface AnnouncerOptions {
  voice?: string;                      // 后端命名空间内声线 id（edge-tts: zh-CN-XiaoxiaoNeural 默认）
  transcriptSink?: TranscriptSink;
}
export interface ConversationOptions {
  brain: BrainAdapter;
  voice?: string;
  systemHint?: string;                 // 语音语体提示（短句/口语/no-markdown）
  transcriptSink?: TranscriptSink;
  resumeHandle?: ResumeHandle;         // resume 在创建期注入（Gemini connect-time handle）；
                                       // supportsResume=false 且给了 handle → VoiceError("unsupported")
}

export interface VoiceBackend {
  readonly id: "edge-tts" | "gemini-live" | "openai-realtime" | "cosyvoice" | (string & {});
  readonly capabilities: VoiceBackendCapabilities;   // Gemini：按 config 钉住的 model 派生
  createAnnouncer?(opts: AnnouncerOptions): Promise<AnnouncerSession>;      // announce=true 必须提供
  createConversation?(opts: ConversationOptions): Promise<ConversationSession>; // converse=true 必须提供
}
// registry 合同：capability 与 factory 不一致（宣告 true 但方法缺失）→ 注册时 fail-fast

export interface SpeakResult {
  ttsFirstByteMs: number;              // TTS 首字节
  playbackStartMs: number;             // 用户真正听到声音（诚实口径）
  durationMs: number;
}

export interface AnnouncerSession {
  readonly sessionId: string;          // crypto.randomUUID
  speak(text: string, opts?: { signal?: AbortSignal }): Promise<SpeakResult>;
  // 串行队列：speak 排队逐条播；signal abort / interrupt() 中止当前 + 清队列
  interrupt(): void;
  close(): Promise<void>;
}

export type ConversationEventMap = {
  "speech-started": [];                // 用户开口（后端 VAD）
  "speech-stopped": [];
  "transcript": [{ role: "user" | "assistant"; text: string; final: boolean }];
  "response-started": [];
  "response-audio": [chunk: Buffer, format: AudioFormat];
  "response-done": [];
  "response-cancelled": [];            // 打断后必发；此后该轮不得再发 assistant transcript
  "tool-call": [{ callId: string; name: string; args: unknown }];
  "session-expiring": [{ inSec: number }];   // Gemini goAway.timeLeft 映射
  "error": [VoiceError];
};

export interface ConversationSession {
  readonly sessionId: string;
  sendAudio(frame: Buffer, format: AudioFormat): void;
  interrupt(): void;                   // 透传后端原生打断
  injectToolResult(r: ToolResult, sched?: ScheduleHint): void;  // 后端不支持调度位则忽略 hint
  on<E extends keyof ConversationEventMap>(
    e: E, h: (...a: ConversationEventMap[E]) => void,
  ): () => void;                       // 返回退订函数
  close(): Promise<ResumeHandle | undefined>;  // 返回最新 resume handle（若支持）
}

export interface BrainAdapter {
  respond(
    turn: { text: string; history: Turn[] },
    opts: { signal: AbortSignal },     // 取消一等公民
  ): AsyncIterable<string>;
}

export interface TtsEngine {           // announce 面内部小可插拔（edge-tts ↔ Azure 兜底）
  synthesize(text: string, voice: string, opts: { signal: AbortSignal }):
    Promise<{ audio: Buffer; format: AudioFormat; ttsFirstByteMs: number }>;
}

export interface TranscriptSink {
  append(entry: TranscriptEntry): void;              // 失败显式 throw，不静默吞
}
export type TranscriptEntry = {
  ts: string; sessionId: string; backendId: string;
  face: "announce" | "converse";
  role: "user" | "assistant"; text: string; final: boolean;
};
```

**取消合同（继承初版，按新形态落位）**：
- **announce 面**：speak 的 signal abort / interrupt() → 杀 afplay + 清队列 + 若 TTS 子
  进程在跑一并杀；speak reject VoiceError("cancelled")。
- **converse 面（两条路径分开约定——serverContent.interrupted 是服务端**输出**信号，
  不是客户端可发的指令）**：
  - **自然 barge-in**（用户开口，Gemini 服务端 VAD 打断生成）：收到服务端 interrupted
    信号 → 杀 ffplay 停播 + 发 "response-cancelled" + 该轮不再发 assistant transcript +
    处理伴随的 toolCallCancellation（abort 进行中的 ask_lead）。
  - **手动 interrupt()**（CLI 按键）：**本地抑制语义**——杀 ffplay + 丢弃该轮后续
    response-audio/transcript + 发 "response-cancelled" + abort 进行中的 ask_lead；
    **不声称服务端取消**（Live API 无直接的客户端取消指令；若 S0.2 spike 发现可用的
    interrupting 输入形态如 activity 信号，再升级为真透传并补记本档）。
- brain：ask_lead 执行中若会话关闭/打断/收到 toolCallCancellation → abort signal →
  杀 claude 子进程。
- 被取消的子进程必须实际终止（测试断言 kill 被调用）。

**子进程 argv 卫生（继承，硬规则）**：可执行路径与 flags 允许进 argv；**用户/assistant
文本、prompt 一律不进 argv**。edge-tts 用 --file + 0600 私有临时文件；claude -p 用 stdin。
测试断言 mock argv 无文本内容。GEMINI_API_KEY 只经 env 给 SDK，不落日志。

**其余硬性合同**：失败显式（edge-tts 30s / claude 120s 超时，全可配；ws 断连 →
VoiceError("backend-protocol")）；路径全配置、缺失 fail-fast + 安装指引；vendor-neutral
（上层只 import types + registry）。

## 4. 实施步骤（TDD：每步先测后码）

### Phase 0 — spike（先降不确定性）
- **S0.1 claude -p spike：✅ 已完成**（真机实测记录在 evidence/spike-phase0.md，由被回收
  的首个 implement 会话产出——spike 内容与新旧计划无关、直接沿用）。结论定稿：
  **零工具 = 「--tools "" --strict-mcp-config」两个都要**（只禁内建工具时项目 .mcp.json
  的 MCP servers 仍会加载）；--append-system-prompt-file persona 生效；**--resume 保留
  persona 语境**（但工具禁用 flags 须每轮重传）；prompt 走 stdin 不进 argv；流式 =
  stream-json + include-partial-messages + verbose、只取 text_delta；voice-context 提示
  须写明「你没有任何工具，别输出代码块假装执行」（spike 观察到零工具时模型会假装跑命令）。
- **S0.1b mic 采音 spike：✅ 已完成**（同 evidence）：avfoundation 设备 :0 = MacBook Pro
  Microphone（另有 DJI MIC MINI 外置 mic 可选），16kHz mono 实录成功。
- **S0.2 Gemini Live 连通性 spike（待做）**：GEMINI_API_KEY + @google/genai 最小 ws 会话
  （文本入→音频出即可），确认 model 名、输入/输出格式、transcription 配置、resume
  handle 字段形状。产出：钉住的 model 名 + SDK 版本 + 文档快照记 evidence/
  （能力漂移可追溯，初版 review R2 注意点）。
- **S0.3 接口复审点**：S0.2 结论回照 §3，需改则一次性修订并补记本档，然后
  **冻结 types.ts**。此后改接口 = 回 design。
  （注：首个 implement 会话曾按**旧接口合同**建过 packages/voice-core 脚手架，未提交；
  因接口已改为 announce/converse 双面形态，该脚手架已归档出 worktree，implement 按本
  计划 §3 重建，勿找回旧版。）

### Phase 1 — 接口 + 播报面（Edge TTS）
1. **脚手架**：包骨架 + types.ts（§3 全量）+ config.ts + registry。测试：config 缺路径
   fail-fast、env 覆盖、registry 未知 id fail-fast、**capability 与 factory 不一致
   fail-fast**、按面解析默认后端。
2. **EdgeTtsEngine**：子进程封装（文本经 0600 临时文件 → mp3 Buffer + ttsFirstByteMs，
   signal 支持）。测试：mock ExecFileFn 验参数/超时/非零退出/abort kill；argv 卫生断言；
   限速/网络失败显式报错。
3. **EdgeTtsBackend + AnnouncerSession**：speak 串行队列 + FilePlayer（afplay）+
   playbackStartMs 记录 + transcript(face=announce) 落盘 + 取消合同。测试：队列顺序、
   mid-speak interrupt（杀 afplay + 清队列 + cancelled）、SpeakResult 三指标。
4. **POC-A（播报闭环真机）**：`flywheel-voice-poc say --stdin`（管道读报告文本）/
   `say --file <path>` —— **文本只经 stdin/文件进入，不设位置参数**（顶层 CLI 与子进程
   同守 argv 卫生合同：播报内容就是报告/简报正文，进程表不可见）。测试：CLI 解析层断言
   任何路径下子进程 argv 与本进程 argv 均不含文本内容。真机验收记 evidence/
   poc-announce.md：一段真实早会式播报（中英混文本）+ 三指标数字 + founder 可听的 mp3
   样本留档。

### Phase 2 — 对话面（Gemini Live）
5. **HeadlessClaudeBrain**（参数已由 S0.1 定稿）：「--tools "" --strict-mcp-config」+
   stdin prompt + identity.md persona + voice-context 提示（含「语音指令不会被执行、
   没有任何工具、别输出代码块假装执行」声明）；**所有轮（含首轮）统一走
   stream-json + include-partial-messages + verbose**，只取 text_delta，session_id 从
   stream 事件里捕获缓存（spike 已证 stream-json 事件带 session_id——首轮无需退化成
   非流式 json，单一解析路径 + 首轮延迟不打折）；续轮 --resume 且**重传工具禁用 flags**；
   fallback 历史回注；abort 杀子进程。测试：mock 子进程、首轮 stream 解析 + session_id
   捕获、identity 缺失 fail-fast、abort kill、argv 卫生、resume flags 重传断言。
6. **GeminiLiveSession**：ws 事件 → 统一事件词表映射；ask_lead tool 声明（brain 接线，
   按 S0.2 确认的调度能力宣告 scheduled/basic 两形态）；resume（createConversation
   ({resumeHandle}) → connect-time 配置；newHandle 滚动；close() 返回最新；goAway →
   session-expiring）；打断按 §3 取消合同**双路径**实现（barge-in = 服务端 interrupted
   信号映射；手动 = 本地抑制）；**toolCallCancellation 处理**（SDK 实有此消息：服务端
   撤销已发出的 tool call → abort 进行中的 ask_lead brain 调用，不回注结果）。测试
   （本包测试重心）：mock ws 事件序列全覆盖（transcript 双侧/response 生命周期/
   tool-call 往返/tool-call 撤销 abort/**barge-in 与手动 interrupt 两路径**各自的
   停播+cancelled+无后续 transcript/expiring/断连 error）、scheduled 与 basic 两路径、
   resume 注入形状。
7. **MicCapture + StreamPlayer**：ffmpeg 采音流（16kHz mono PCM，mute 键）+ ffplay 流播
   （24kHz）。测试：mock 子进程生命周期、mute 停发帧、interrupt kill+重开。
8. **POC-B（对话闭环真机）**：`flywheel-voice-poc talk --lead <LEAD_ID> --project <dir>`。
   真机验收记 evidence/poc-converse.md：真 mic 中英混说 ≥3 轮往返（含 ≥1 次 ask_lead
   工具往返、≥1 次真人打断、≥1 次 resume 续连）+ 延迟数字（用户停话→首音
   playbackStart 口径）+ transcript JSONL 完整。
9. **zh-en eval set**：~/fly342-voice-lab/eval-sentences.txt 扩到 ~20 句（混说/专名/
   否定/数字），真 mic 对 Gemini Live 逐句实测（user transcript 准确性 = ASR 质量代理
   指标）+ Edge TTS 读同批句子的可懂度主观分。结果落 evidence/eval-*.md ——
   这是 FLY-883/342 共同点名的行动项，给 Annie 后续拍本地模型测试轮供数。

## 5. 验收标准（证据驱动）

| # | 标准 | 证据 |
|---|------|------|
| A1 | vitest 全绿 + 全仓 lint 干净 | CI |
| A2 | POC-A 播报闭环：中英混文本真机播报，三指标（ttsFirstByte/playbackStart/duration）落档 | evidence/poc-announce.md + mp3 样本 |
| A3 | POC-B 对话闭环：真 mic ≥3 轮 + 工具往返 + 打断 + resume 各 ≥1 次 | evidence/poc-converse.md + JSONL |
| A4 | eval set ~20 句：Gemini ASR 基线 + Edge TTS 可懂度 | evidence/eval-*.md |
| A5 | 可插拔实证：registry 按面解析 + capability/factory 一致性 fail-fast + 假后端单测 | 单测 |
| A6 | 失败路径：组件缺失/超时/子进程崩溃/ws 断连/取消全显式（VoiceError code 正确） | 单测 |
| A7 | argv 卫生：mock argv 断言无文本/prompt；GEMINI_API_KEY 不落日志 | 单测 |
| A8 | 取消合同：两个面各自语义 + 子进程实际终止 | 单测 |

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| edge-tts 限速/无 SLA/商用灰色 | TtsEngine 可插拔 + 显式错误；Azure 兜底接口位（不实现）；产品化前复核 |
| Gemini preview SKU/价格/能力漂移 | model 钉 config、capabilities 派生、S0.2 证据留档（文档快照+SDK 版本） |
| Gemini 会话短命（~10min） | resume 创建期注入 + session-expiring 事件；POC-B 验收含真机续连 |
| claude -p --resume 不保系统提示 / 零工具形态不确定 | S0.1 spike；fallback 历史回注；S0.3 复审点兜底 |
| zh-en 混说 ASR 质量未知 | 步骤 9 eval 拿数字；不达标升级 Lead（本地模型测试轮提前/换 model） |
| 持续开麦隐私面 | POC 本机 + mute 键；产品阶段（544）按披露/同意要求做 |
| GEMINI_API_KEY 未到位 | Phase 1（播报面）零依赖先行，Phase 2 等 key；两面独立可验收 |

## 7. 明确不做（防 scope 蔓延）

Discord voice/DAVE（544）· 用例编排与产品体验（HL PRD）· 声线克隆（547）· transcript
总结落 Linear（548）· 本地模型 whisper/CosyVoice/Qwen（defer 测试轮；CosyVoice 只留
接口位）· 独立 STT（云端也不做；发现确需 → flag Lead）· OpenAI Realtime 实现（接口位
已留）· 动作能力的语音执行 + ConfirmedTranscriptGate（随动作路由 defer，设计留档）·
Bridge/StateStore 改动（零触碰）· skill 全局分发（POC 验过再发）。
