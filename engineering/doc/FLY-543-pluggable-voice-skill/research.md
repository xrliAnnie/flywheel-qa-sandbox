# FLY-543 通用可插拔 voice skill — 调研（修订版 r2）

Issue: FLY-543 (https://linear.app/geoforge3d/issue/FLY-543/voice-核心通用可插拔-voice-skill全-lead-共用realtime-后端)
日期: 2026-07-06
基于: exploration.md（含 §7 决定记录：Annie 拍板 round-1 = Edge TTS + Gemini Live 双后端）

> **r2 修订说明**：初版 research 围绕「whisper 本地管线为默认后端」展开；Annie 收紧
> round-1 范围后（exploration §7），本档按**双后端形态**重写：Edge TTS（只说，播报面）+
> Gemini Live（完整语音对话面）。本地模型/独立 STT 相关调研结论保留在初版 git 历史与
> FLY-342 文档里，此处不再展开。

## 1. 本机资产核实（2026-07-06 实测）

round-1 用到的（全部就位，POC 零下载）：

| 资产 | 路径/形态 | 状态 |
|------|-----------|------|
| edge-tts 7.2.8 | ~/fly342-voice-lab/.venv/bin/python -m edge_tts | ✅ import 实测 ok；FLY-342 实测首包 0.66s、founder ear-test「很不错」 |
| ffmpeg（avfoundation 采音 + ffplay 流播） | 系统 PATH（FLY-342 链路已用） | ✅ |
| afplay | macOS 自带 | ✅ |
| eval 句子底稿 | ~/fly342-voice-lab/eval-sentences.txt | ✅（zh-en 混说 eval set 起点） |

**不再用于 round-1**（defer，资产保留）：whisper.cpp 及模型、CosyVoice 栈（lab 里都在，
之后的本地模型测试轮再用）。

## 2. Monorepo 落点规范（对照 packages/token-usage 实样）

- 新包 **packages/voice-core**，命名 flywheel-voice-core；`"type": "module"`、tsc build →
  dist/、vitest（test = vitest run）、biome lint（仓库统一）、`files: ["dist"]`。
- CLI 入口走 package.json `bin`（flywheel-voice-poc → dist/cli.js），与
  flywheel-token-report 同形态。
- 外部进程（edge-tts / ffmpeg / ffplay / afplay / claude）经 child_process 调用，路径
  全部走**配置注入**（env / config 参数），不硬编码 lab 路径。
- Gemini Live 走官方 **@google/genai** SDK（ws）——这是 round-1 唯一新 npm 依赖。
- 不进 Bridge/plugin.ts、不碰 StateStore：FLY-543 是独立库 + POC CLI，**不需要 Bridge
  重启部署**，风险档位低。

## 3. Lead 身份注入机制（BrainAdapter 的事实依据）

claude-lead.sh 实读（packages/teamlead/scripts/claude-lead.sh:574-601, 1656-1842）：

- Lead 身份 = `${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md`（FLY-26 起为首选；agent.md
  向后兼容 fallback）；行为规则 = lead-rules-base/*.md 按 role 分层经
  `--append-system-prompt-file` 注入。
- ⇒ **POC BrainAdapter（headless 形态）**：`claude -p` + identity.md persona +
  voice-context 提示，**零工具只读**（安全边界详见 plan §0）。完整 Lead 启动栈
  （--agent + bypassPermissions + 全规则层）无法由单文件诚实复刻 —— POC 是
  「Lead persona 近似」，动作能力语音路由 defer。
- `claude -p --resume <session-id>` 可续 headless 会话（spike 验证项）；fallback =
  对话历史回注。

## 4. 双后端 API 级事实（接口设计的输入）

### 4.1 Edge TTS（播报面，speech-out only）

- **形态**：微软 Edge 浏览器「大声朗读」的非官方接口，edge-tts Python 包封装；**免密、
  免费**。文本 → mp3（也可 opus/webm）音频流 + word boundary 元数据。
- **声线**：预置声线表（`edge-tts --list-voices`）；中文常用 zh-CN-XiaoxiaoNeural
  （FLY-342 founder ear-test 认可）；中英混文本单声线可读（Xiaoxiao 系读英文可接受，
  eval 里验）。产品方向「每 Lead 一个专属声音」= 预置声线先分配（FLY-342 结论），
  接口上 voice 参数已承载。
- **三 caveat（FLY-342 §2a 定档）**：非官方接口可能限速/变动；无 SLA；商用灰色。
  ⇒ TtsEngine 抽象内可换 **Azure Speech**（同微软声线体系、付费有 SLA，¥/字符计价）
  作兜底，round-1 只留接口位不实现。
- **调用卫生**：文本经 `--file <0600 临时文件>` 传入（不进 argv——进程表泄露面）；
  失败（网络/限速）显式报错不静默。
- **成本**：$0（Azure 兜底启用才产生费用）。

### 4.2 Gemini Live（对话面，speech-in + speech-out）

数字截至 2026-07-05/06（FLY-883 dr-report + Codex R2 核对过的 Google 官方文档），
实施前复核：

- **模型**：gemini-live-2.5-flash-native-audio / gemini-3.1-flash-live-preview（低延迟线）。
  **model 必须钉在 config、capabilities 按 model 派生**（async function calling 在部分
  Live 模型尚不支持——不许硬编码 "scheduled"）。
- **音频**：入 16-bit PCM 16kHz（可重采样协商）；出 24kHz PCM。服务端 VAD + 原生打断。
- **ASR 内建**：语音输入直接被模型理解，**round-1 因此不需要独立 STT**；user 侧文字走
  input transcription、assistant 侧走 output audio transcription（native-audio 直接输出
  仅 AUDIO 模态）→ transcript 两侧都拿得到。**SDK 核对（@google/genai，2026-07-06 经
  Context7 查官方 api-report）**：LiveConnectConfig 确有 inputAudioTranscription +
  outputAudioTranscription + sessionResumption + tools + abortSignal 字段；
  LiveServerMessage 确有 goAway / sessionResumptionUpdate / toolCall /
  **toolCallCancellation**（服务端可撤销已发出的 tool call——adapter 必须把它接进取消
  合同：撤销时 abort 进行中的 ask_lead）。
- **工具调用**：function calling 支持；非阻塞函数声明 + FunctionResponseScheduling
  （SILENT/WHEN_IDLE/INTERRUPT）仅在模型支持时可用 → adapter 按 model 宣告
  "scheduled" 或降级 "basic"。**脑接线 = brain 暴露为 ask_lead tool**。
- **会话生命周期**：连接 ~10min / 纯音频会话 15min；**session resumption handle 在
  connect 时配置**（sessionResumptionUpdate.newHandle 滚动更新，token 有效期 **~2h**）；
  goAway.timeLeft 预告断线。⇒ resume 是接口一等公民、挂在创建期。
- **成本**：~$0.005/min 输入 + $0.018/min 输出（3.1 flash live preview 价）≈ **$10–21/月
  @每天 2×15min**（FLY-883）。API key 经 env（GEMINI_API_KEY），不进代码。
- **SDK**：@google/genai（官方 JS SDK，Live API ws 支持）。

### 4.3 设计推论

1. **speech-in / speech-out 是独立能力维度**：Edge TTS 后端只有 speech-out。把「播报」
   和「对话」拆成两个会话面（AnnouncerSession / ConversationSession），后端按能力实现
   其一或其二 —— 比强迫所有后端实现完整对话接口诚实（Edge TTS 假实现 sendAudio 就是
   假抽象）。
2. **resume 挂创建期**（Gemini connect-time handle），close() 返回最新 handle。
3. **取消是一等公民**：播报可打断（杀播放+丢队列）；对话打断走 Gemini 原生语义。
4. **transcript 是共用层职责**：两个面都发同一词表的 transcript 事件，JSONL 落盘喂
   FLY-548。
5. **音频格式协商放 connect/create 阶段**：后端声明 in/out 格式，AudioIO 层重采样——
   为 FLY-544 Discord 48kHz Opus 预留同一协商位。

## 5. 接口草案（TS，落 packages/voice-core；plan.md 定稿）

```ts
// 能力按「面」声明 —— speech-in/out 独立维度
interface VoiceBackendCapabilities {
  announce: boolean;                   // 有 AnnouncerSession（speech-out only 面）
  converse: boolean;                   // 有 ConversationSession（speech-in+out 面）
  bargeIn: boolean;
  toolCallScheduling: "none" | "basic" | "scheduled";
  transcriptGranularity: "final-only" | "partial";
  supportsResume: boolean;
  sessionLimits?: { connectionSec?: number; audioSec?: number };
  voiceCloning: boolean;               // FLY-547 预留
  audioOut: AudioFormat[]; audioIn?: AudioFormat[];
}

interface VoiceBackend {
  readonly id: string;                 // "edge-tts" | "gemini-live" | ...
  readonly capabilities: VoiceBackendCapabilities;
  createAnnouncer?(opts: AnnouncerOptions): Promise<AnnouncerSession>;
  createConversation?(opts: ConversationOptions): Promise<ConversationSession>;
}

interface AnnouncerSession {           // 播报面：Lead「说」
  speak(text: string, opts?: { signal?: AbortSignal }): Promise<SpeakResult>;
  interrupt(): void;                   // 停当前播报 + 清队列
  close(): Promise<void>;
}

interface ConversationSession {        // 对话面：完整语音往返
  sendAudio(frame: Buffer, format: AudioFormat): void;
  interrupt(): void;
  injectToolResult(r: ToolResult, sched?: ScheduleHint): void;
  on(event, handler): () => void;      // 统一事件词表（transcript/response-*/tool-call/…）
  close(): Promise<ResumeHandle | undefined>;
}

interface BrainAdapter {               // 只对话面需要；对话后端把它暴露成 ask_lead tool
  respond(turn: { text: string; history: Turn[] }, opts: { signal: AbortSignal }): AsyncIterable<string>;
}
```

（VoiceError/TranscriptSink/事件词表/取消合同等硬性合同沿用初版 review 通过的定稿，
plan.md §3 全量给出。）

## 6. POC 音频 I/O（macOS 本机）

- **播报播放**：afplay（mp3 文件，edge-tts 原生输出）。打断 = SIGTERM。
- **对话采音**：ffmpeg avfoundation → 16kHz mono PCM 流 → Gemini ws。**持续开麦**
  （Gemini 服务端 VAD 管断句/打断），CLI 提供 mute 键；不再需要 push-to-talk 断句。
- **对话播放**：Gemini 出 24kHz PCM 流 → ffplay（-f s16le -ar 24000 -nodisp）流式播放
  （afplay 只能放文件，不适合流）。打断分两路径（plan §3 取消合同）：自然 barge-in =
  服务端 interrupted **输出信号**（非客户端指令）→ 杀 ffplay 重开；手动 interrupt =
  本地抑制（杀 ffplay + 丢弃该轮后续输出），不声称服务端取消。

## 7. 风险登记（plan 要带的）

1. edge-tts 限速/无 SLA/商用灰色 → TtsEngine 可插拔 + 显式错误；Azure 兜底接口位。
2. Gemini Live preview SKU/价格波动、能力随 model 漂移 → model 钉 config、能力派生、
   文档/SDK 版本证据留档（Codex R2 注意点）。
3. Gemini 会话短命（~10min）→ resume 创建期注入 + goAway → session-expiring 事件；
   POC 必须真机验一次续连。
4. zh-en 混说质量未知 → eval set（~20 句）在 Gemini Live 真机跑基线；Edge TTS 侧验
   中英混文本朗读可懂度。
5. claude -p --resume 行为需 spike（同初版）。
6. 持续开麦的隐私面 → POC 本机 + CLI 有 mute；产品阶段（544）按 FLY-883 §7 的披露/
   同意要求做。
