# FLY-967 会议模式 A(纯 Gemini Live 语音助理) — 调研
Issue: FLY-967 (https://linear.app/geoforge3d/issue/FLY-967/voicea-会议模式-a-纯-gemini-live-语音助理自带工具会议简报与-545b-真机对比定方向)
日期: 2026-07-07
基于: exploration.md(brainstorm gate 已批,Tadashi 2026-07-07:7 条全过 + 2 条口径补充)

> 目标:把 exploration 的 8 个决策落到可实施的技术事实上。每条结论标注证据来源
> (in-repo 代码 / 真机验证 / 官方文档),in-repo 证据 > 文档。

## 1. Gemini Live API 能力核实(D6)

### 1.1 模型与模态

- **pin 模型 = `gemini-3.1-flash-live-preview`**(voice-core `config.ts:37` 现 default,
  FLY-959 修 404 后钉的)。官方定位:低延迟对话、多模态、function calling + Search grounding
  ([model 页](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview))。
  **543 talk 已在这个模型上真机跑通 AUDIO 模态 speech-to-speech + ask_lead 工具**——这是最强
  证据,A 的 v1 就 pin 它(config `FLYWHEEL_VOICE_GEMINI_MODEL` 可换,零代码)。
- AUDIO 响应模态 = voice-core **现行为**(`genaiConnector.ts:49` `responseModalities: [Modality.AUDIO]`);
  输出 24kHz mono PCM16(`genaiConnector.ts:153`),输入 16kHz PCM(`:98`)。
- `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` 是 LiveConnectConfig 一等公民
  (js-genai SDK 核实),选声线 = 一个 config 字段;`languageCode` 同层。v1 实现阶段试听选一个
  中文自然的预置声线,config `assistant.voice` 可换。
- `systemInstruction: ContentUnion` 一等公民 —— 简报注入的落点,connect 时传入。

### 1.2 会话时限与续接

- 官方口径:**audio-only session 上限 15 分钟**;更长会话走 session resumption
  ([capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities))。
- voice-core 已内建应对:`TalkSessionRotator`(FLY-959)—— goAway(`session-expiring`)驱动
  close→取 ResumeHandle→resumed 重连,亚秒级换轨、上下文保留。**A 直接复用,零新工作**。
  会议 >15min = rotator 自然续,transcript 不断。

### 1.3 Function calling:同步 only(重要约束)

- 官方:3.1 live 模型 **async function calling 尚不支持,同步 only** —— 模型发出 toolCall 后
  **不继续说话,直到收到 tool response**([capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities))。
- voice-core 已按此建模:`factory.ts:69` `asyncFunctionCalling ?? false`(safe default)→
  `toolCallScheduling: "basic"`。543 的 ask_lead 就在同步模式下真机工作。
- **对 A 的含义**:慢工具(ask_lead 的 claude -p,秒级)= 模型静默等待。缓解(§15 静默 ≤3s
  纪律):tool-call 事件一到,AssistantSpeaker 本地即播预置 earcon;>2s 未回再播一条预合成的
  「我查一下」短 clip(一次性预合成、文件缓存,不引入运行时 TTS 依赖)。lookup_issue /
  board_snapshot 是 Bridge 本地 HTTP(<300ms 量级),earcon 足够。
- ScheduleHint(`injectToolResult` 的 when_idle)在同步模型上无效果但无害(voice-core 已兼容)。

### 1.4 长 systemInstruction

- 简报预算(exploration D3)定为**总 ≤8k chars**(board 快照 ~1.5k + 相关 issue ~2k + 最近
  决策 ~1.5k + 文档要点 ~3k)。Live connect 的 context 窗口远大于此(3.1 系列 ≥128k tokens);
  真正的约束是「口语对话里模型能有效引用多少」——S-A1 spike 顺带验注入后模型能答 board 问题。

## 2. voice-core 现状核实(复用面)

| 能力 | 状态 | 证据 |
|------|------|------|
| AUDIO 模态 speech-to-speech | ✅ 现行为 | `genaiConnector.ts`,543 talk 真机 |
| `response-audio`(24k PCM 流式)/`response-cancelled`(服务端 VAD 打断) | ✅ | `types.ts` ConversationEventMap |
| `sendAudio`(16k PCM in) | ✅ | 同上 |
| ask_lead tool + BrainAdapter | ✅(FLY-959 修好 schema) | `GeminiLiveBackend.ts:45` |
| 会话续接(goAway→resume) | ✅ | `TalkSessionRotator.ts` |
| transcript JSONL(双向,input/output transcription) | ✅ | `transcript.ts` |
| `extraTools: LiveToolSpec[]` 分发 | ✅ 545 分支已实现(P1 commit 35becd9b,含 extra-tools.test.ts);**依赖不变**,545 PR-1 落地后 rebase 消费 | 545 分支 |
| `systemInstruction` 外部注入 | 需核实:`ConversationOptions.systemHint` 现有;简报是否走 systemHint 拼接或新字段,implement 时按 545 PR-1 落地后的实际签名对齐(倾向:新增可选 `systemPreamble?: string`,缺省不设 = 字节兼容) | `types.ts:ConversationOptions` |

**voice-core 需要的增量 ≈ 0-1 个可选字段**(systemPreamble),其余全是 545 PR-1 已计划的扩展。

> **补记(2026-07-07,545 S1 坐实)**:Gemini Live 当前**全系模型不支持 TEXT 响应模态**
> (服务端拒绝;545 分支 evidence/s1-gemini-text-modality.md)。对 A **无影响**——A 本就
> AUDIO 模态(现行为);extraTools 依赖不变(545 P1 已实现)。影响的是对比框架:B 降级
> audio 直出,A/B 延迟同源(见 exploration §1/§7 校准)。

## 3. 545 PR-1 依赖面(精确清单,盯排期用)

A 的 implement 需要 545 PR-1 的这些交付物(545 plan §2/§3):

1. `packages/voice-bridge` 包骨架 + `config.ts`(huddle 配置块、fail-fast)
2. `BotRegistry`(多 client 生命周期,clientReady 门 — FLY-960 首坑内建)
3. `EarsReceiver`(人类过滤、speaking-start 去重、48k→16k、断连 rejoin)
4. `resample.ts`(纯函数;A 加一个 24k mono→48k stereo 方向,同文件)
5. launchd 部署件 + 单实例守卫(daemon 唯一,A/B 同进程)
6. voice-core TEXT 模态 + **extraTools 合同**(A 用 extraTools,不用 TEXT)
7. bot 身份(orchestrator + 耳朵,pool claim)

**不依赖** 545 PR-2(HuddleSession/MeetCommand/ConclusionPipeline/Bridge 新路由)。A 与 545
PR-2 可并行 implement;两条 Bridge 路由(comment / issue query)谁先落谁建(§6)。
若 545 PR-1 排期滑:A 的 plan 阶段照常完成;真滑到阻塞时升级 Tadashi 决策(exploration §6)。

## 4. 播放管线技术选型(A 的新增主体之一)

```
response-audio(24k mono s16le,流式 chunk)
  → upsample ×2(24k→48k,整数倍,线性内插或样本复制;纯函数)
  → mono→stereo(声道复制)
  → PassThrough stream → createAudioResource(stream, { inputType: StreamType.Raw })
  → AudioPlayer(@discordjs/voice 0.19.2,编码 opusscript / @discordjs/opus 可选加速)
  → orchestrator bot VoiceConnection.subscribe
```

- `StreamType.Raw` 约定 = 48kHz 16-bit **stereo** PCM —— 与重采样输出严格对齐(@discordjs/voice
  文档口径;545 已 pin 的依赖,无新依赖)。
- **流式衔接**:`response-audio` 是持续 chunk 流,推进 PassThrough;turn 结束(`response-done`)
  end 流;下一 turn 新开 resource(AudioPlayer 串行播)。避免每 chunk 一个 resource(爆音)。
- **barge-in(A 侧语义)**:Gemini 服务端 VAD 原生打断 → voice-core 发 `response-cancelled` →
  AssistantSpeaker **立即** destroy 当前 stream + `player.stop()` + 丢弃后续本 turn 迟到 chunk
  (turn 序号闸)。PRD <100ms 口径 = 从 response-cancelled 事件到停播动作。
  注意:她开口 → Gemini 检测 → interrupted 下发有一段网络往返,**体感打断延迟 = 服务端 VAD
  延迟 + 半 RTT + 本地停播**;S-A1 spike 实测这个数字(对比维度「打断跟手不跟手」的硬数)。
- **无回声风险**:EarsReceiver 只订阅人类成员(bot 过滤,545 P3),orchestrator bot 自己的
  播音不会被喂回 Gemini。
- **buffer 上限**:模型吐音频快于实时播放,PassThrough 设 highWaterMark 上限 + 计数告警,
  防打断时清不干净/内存涨(单测覆盖)。

## 5. 简报引擎数据源核实(D3)

| 块 | 路由/来源 | 现状核实 |
|----|----------|---------|
| board 快照 | `GET /api/linear/issues?slim=1&projectName=…&state=…` | ✅ 存在(`plugin.ts:2238`);支持 project/state/labels/limit/slim;FLY-371 projectName binding |
| 最近决策 | 同一路由 `state=Done`(近 N 条标题+identifier) | ✅ 同上;「一句话」= slim 标题即可,v1 不做摘要 LLM |
| 相关 issue | `/talk [topic]` 参数 → 对 board 快照本地关键词过滤 | ✅ 零新路由(v1 就近取材,exploration D4 边界) |
| PRD/文档要点 | `assistant.briefing.docs[]` 配置的 repo 相对路径,直接读文件 + 截断 | 新增(纯文件读,无路由);路径必须限制在 projectRoot 内(路径穿越校验) |

- **缓存**:`~/.flywheel/voice-briefing-<projectName>.cache.json`(原子写 tmp+rename);daemon
  定时刷新(默认 600s,可配);`/talk` 时读缓存内存拼接 = 零等待;陈旧 >30min → 照常开 +
  TIV 提示。缓存文件含 generatedAt,简报文本自带「截至 HH:MM」行。
- **auth**:BridgeLinearClient 同 545(Bearer FLYWHEEL_API_TOKEN,来自 ~/.flywheel/.env,
  token 不进 argv/日志)。

## 6. 落地路由核实(D5)

- `POST /api/linear/create-issue` ✅ 已存在(545 P7 也用它)—— /talk 启动建立项 issue 直接用。
- `POST /api/linear/comment` + `GET /api/linear/issue?query=` = **545 PR-2 计划新增**(545 plan
  P12)。A 的 PR 与 545 PR-2 谁先合谁建这两条路由,**路由签名照 545 plan §5.3/P12 逐字对齐**
  (auth/501/参数校验/not-found 语义),后落的一方 no-op(实现前 grep 确认)。防两边形状漂移:
  A 的 plan 引用 545 plan 的同一段合同,不另定义。
- `update-issue`(关 issue 用)✅ 已存在(`plugin.ts:2170`)。

## 7. FLY-546 语音批准第三信号源(gate 口径补充⑤)

- 546 exploration D5:语音批准 = **同一 gate 机制加第三个信号源(voice)**,fail-closed +
  readback 精确匹配 + 默认 OFF;Annie 已拍「真批准、测过即默认开」。
- **对 A 的含义**:v1 A 不自造任何批准通道 —— b/c 档动作一律 readback + 现有 founder gate
  (与 545 同款 ConfirmationLadder 语义,A 只有单助理所以更简单:口头 readback + TIV 收据,
  执行永远在 gate 侧)。546 的 voice 信号源上线后 A/B **自动继承**(它挂在 gate 机制上,
  不挂在某个会议模式上),A 侧零代码预留。

## 8. 延迟预算(A 的核心指标,S-A1 spike 校准)

| 段 | 估算 | 依据 |
|----|------|------|
| 耳朵收音→16k PCM 喂入 | ~0(流式) | 960 spike 实测管线 |
| Gemini 服务端 VAD/语义端点判定 | 300-600ms | 545 research §8 同源估算 |
| 端点→首个 response-audio chunk | **300-700ms(native audio 直出,无 TTS 一跳)** | 模型官方定位「低延迟对话」;S-A1 实测定数 |
| 重采样+opus 编码+Discord 播出 | 50-150ms | 本地纯计算 + jitter buffer |
| **全链首音(她停话→听到声)** | **0.7-1.4s 预估,目标 ≤800ms 好/≤1.2s 可** | §15 口径;**对比 B 的 1.3-2.0s(worst)** |

- S-A1 spike(implement P0)口径:她(或 QA 真人)停话时间戳 → orchestrator bot 出声时间戳,
  真机 ≥10 轮取分布;同场记打断延迟(开口→停播)。这两个数字就是 A 的存在证明。
- 若 S-A1 全链首音 >2s(与 B 无差异)→ 停,报 Tadashi(A 的价值主张不成立,对比实验白做)。

> **545 S1 实测基线(2026-07-07,同一 Gemini AUDIO 管线;引 545 分支
> evidence/s1-gemini-text-modality.md)**:首个 response-audio chunk **797-1017ms**(高于上表
> 300-700ms 估算);B 全链首音实测 **0.9-1.3s**。对 A 的含义:①上表「对比 B 的 1.3-2.0s
> (worst)」已过时——TEXT 模态全系不支持、B 降级为同款 audio 直出,两边首音链路同源,延迟
> 不再是 A 的主要差异点(对比主轴改为「脑子」,见 exploration §1/§7);②A 的 ≤1.2s 达标线
> 仍成立但偏紧,S-A1 以 0.9-1.3s 为预期带校准。

## 9. 风险回填(exploration §6 更新)

| 风险 | 更新 |
|------|------|
| native audio 工具支持有坑 | **坐实为「同步 only」约束**(§1.3),非坑而是已知行为;earcon/预合成 filler 缓解;543 已在此模式跑通 |
| 15min 会话上限 | rotator 现成(§1.2),降为零风险 |
| 简报注入过长 | 8k chars 预算 + S-A1 验「注入后答 board 问题」 |
| 545 PR-1 滑期 | 依赖面已精确到 7 项(§3);滑期升级 Tadashi |
| Gemini 声线中文口音 | speechConfig 一等公民(§1.1),实现期试听 3-5 个预置声线选型,可配 |
| 24k→48k 重采样质量 | 整数倍 ×2 + 声道复制,纯函数单测;S-A1 真机听感验收 |

## 10. 结论(给 plan 的输入)

1. 架构照 exploration §3 成立,无技术否决项;voice-core 增量 ≈ 1 个可选字段。
2. A 的实现主体 = `AssistantSpeaker`(§4 管线)+ `BriefingEngine`(§5)+ `AssistantSession`
  (轻量状态机)+ `/talk` 命令 + 3 工具接线 + 轻量落地;全部落 `packages/voice-bridge/src/assistant/`。
3. 同步 function calling 是唯一新发现的产品级约束,earcon+预合成 filler 兜(§1.3)。
4. 两条 Bridge 路由与 545 PR-2「谁先落谁建」,合同引用 545 plan 同段,不另定义(§6)。
5. S-A1 spike 先行,两个数字(首音/打断)定 A 的生死(§8)。

Sources: [Gemini 3.1 Flash Live Preview 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) · [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) · js-genai SDK(Context7 `/googleapis/js-genai`:LiveConnectConfig 字段面)
