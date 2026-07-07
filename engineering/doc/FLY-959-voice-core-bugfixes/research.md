# FLY-959 voice-core 已知 bug 修复 — 调研

Issue: FLY-959 (https://linear.app/geoforge3d/issue/FLY-959/voice-voice-core-已知-bug-修复-mic-默认设备-session-过期不重连-ask-lead-缺-schema)
日期: 2026-07-07
基于: exploration.md

Lead 批注"易题、文档从轻"——本文只钉死实现要依赖的技术事实,不复述 exploration 的选项论证。

## 1. ffmpeg avfoundation `":default"`(bug 1)

- avfoundation 输入语法 `-i "<video>:<audio>"`,audio 位可以是索引或具名 `default`;
  `default` 走 `[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio]`(ffmpeg
  `avfoundation.m`),即 macOS 系统默认输入设备。
- **本机真机探针(2026-07-07)**:`-i ":default" -loglevel debug` 打印
  `audio device 'DJI MIC MINI' opened`(系统默认 = DJI,index 2);对照 `-i ":0"` 打开
  MacBook Pro Microphone。结论成立,见 exploration §2。
- 采样率/声道:MicCapture 已带 `-ar 16000 -ac 1` 重采样,设备原生 48kHz/stereo(DJI)
  或 mono(内置麦)都被归一为 16kHz mono s16le,**换默认设备不影响下游 PCM 合同**。
- 失败模式:设备名错/权限拒绝时 ffmpeg 立刻退出、stdout 无数据;当前 `MicCapture.start()`
  不监听 exit/stderr —— 错误信息升级要挂在 spawn handle 的 stderr/exit 上(`process.ts`
  的 `ProcessHandle` 已暴露 `onStderr`/`onExit`,`EdgeTtsEngine` 有现成用法)。

## 2. Gemini Live session resumption 合同(bug 2)

`@google/genai` (js-genai) Live API,context7 核对 + 543 真机证据:

- `live.connect({ model, config, callbacks })`,`config.sessionResumption:
  SessionResumptionConfig` —— 空 `{}` 即启用(服务端开始推 update);带
  `{ handle }` 即恢复旧会话。现有 `genaiConnector.ts:52-54` 已实现这两态。
- 服务端消息:`sessionResumptionUpdate.newHandle`(handle 滚动更新,connector 已映射
  `resumption-update`)、`goAway.timeLeft`(即将断开,connector 已映射 `go-away`,
  backend 已映射 `session-expiring`)。
- backend 合同(mock 已测,`gemini-live.test.ts`):`GeminiLiveSession.close()` 返回
  `ResumeHandle { backendId, payload }`;`createConversation({ resumeHandle })` 校验
  backendId 后把 payload 传给 `connect.resumeHandle`。**缺口只在 cli.ts 从不调用。**
- goAway 语义:`timeLeft` 是留给客户端迁移的窗口(543 观察 ~50s)。所以"收到
  session-expiring → close() 取 handle → 带 handle 重连"在窗口内完成即可;A3 备选
  路径(不等 close,直接用最近一次 resumption-update 的 handle 开新连接)留给真机
  回归时按需切换。
- 重连 = 重新 `connect()`,config(tools/systemInstruction/transcription)每次全量重传,
  现有 connector 天然满足。
- `LiveServerSessionResumptionUpdate.resumable?: boolean` 存在但 connector 未读——非
  本 issue 必需,不加。

## 3. functionDeclarations schema(bug 3)

- js-genai `config.tools: ToolListUnion`,函数声明形状
  `{ functionDeclarations: [{ name, description, parameters }] }`,`parameters` 接受
  JSON-schema 风格对象(`type: "OBJECT"` 字符串字面量即可,无需 import Type enum——
  QA 对照实验用的就是裸 JSON,`gemini-raw-debug-messages.json` 证明服务端接受且模型
  正确发起 `toolCall.functionCalls[{name, args:{question}, id}]`)。
- 无 schema 声明的真机行为(543 证据):模型要么不调用直接编造,要么自称"连接出问题"
  ——**mock transport 结构性测不到**(mock 直接注入 tool-call 事件,跳过模型决策)。
- 回填:`session.sendToolResponse({ functionResponses: [{ id, name, response: { output } }] })`
  —— `name` 必须匹配调用;现 connector 硬编码 `"ask_lead"`(`genaiConnector.ts:97`),
  按 callId→name 映射回填即正确化(单工具下行为不变,是防御性顺手修)。

## 4. 可用模型现状(bug 4)

`client.models.list()` 真实快照(2026-07-06,`evidence/real-live-models-list.json`),
支持 `bidiGenerateContent` 的全部 5 个:

| 模型 | 备注 |
|------|------|
| `gemini-2.5-flash-native-audio-latest` | native-audio 架构,alias;未在本仓验证 |
| `gemini-2.5-flash-native-audio-preview-09-2025` / `-12-2025` | 同上,pinned |
| **`gemini-3.1-flash-live-preview`** | **543 真机 E2E 两次独立跑全通过(ASR/音频/tool-call)→ 新默认** |
| `gemini-3.5-live-translate-preview` | 翻译特化,不适用 |

- 旧默认 `gemini-live-2.5-flash-preview` 已 404(真实 API 错误:`not found for API
  version v1beta, or is not supported for bidiGenerateContent`),错误经 `onclose(reason)`
  到达而非 `onerror`(A4 已证)——"model not found"指引要挂在 connector 的 onclose
  reason 映射上。
- implement 动手前用真 key 重跑 `models.list()` 复核(evidence 快照才 1 天,低风险)。

## 5. 测试接缝盘点(TDD 落点)

| 单元 | 接缝 | 现有基础 |
|------|------|----------|
| MicCapture 默认 device / 失败指引 | 注入 `ProcessRunner`(`fakes.ts` 有 FakeProcessRunner) | `audio.test.ts` 已测 args 组装 |
| TalkSessionRotator | mock `GeminiLiveTransport`(`gemini-live.test.ts` 的 FakeConn 模式)驱动 go-away/resumption-update | backend resume 合同已测,rotator 只测轮换编排 |
| tool 声明穿透 | mock transport 断言 `connect(params).tools` 收到完整声明 | `conn.params` 断言模式现成(`gemini-live.test.ts:262`) |
| config 新默认 | 纯函数 `resolveConfig` | `config.test.ts` 现成模式 |
| genaiConnector 真 SDK 路径 | **不可单测(mock 测不出 = 543 教训)** → 真机回归协议(exploration §5) | `evidence/` 记录模板 |

## 6. 风险与开放问题

- **R1 preview 模型再下线**:接受;缓解 = onclose 指引 + `FLYWHEEL_VOICE_GEMINI_MODEL`
  逃生口 + evidence 快照可追溯。
- **R2 goAway 窗口内 close() 拿不到 handle**(理论):A3 备选路径写进 plan,真机回归时
  按需启用。
- **R3 resume 后服务端 VAD/transcription 状态**:Gemini 文档语义 resume 恢复会话上下文;
  真机回归第 2 条验收(resume 后再问一句有回答)直接覆盖。
- 无其他开放问题——4 个根因全有真机证据,不确定性集中在"修完后真机复测"本身。
