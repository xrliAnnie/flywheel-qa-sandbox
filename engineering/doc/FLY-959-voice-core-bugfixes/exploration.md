# FLY-959 voice-core 已知 bug 修复 — 探索

Issue: FLY-959 (https://linear.app/geoforge3d/issue/FLY-959/voice-voice-core-已知-bug-修复-mic-默认设备-session-过期不重连-ask-lead-缺-schema)
日期: 2026-07-07
基于: 无(上游证据 = `packages/voice-core/evidence/poc-converse.md`,FLY-543 真机 QA)

## 1. 问题定义

FLY-543(voice-core 双面语音 skill)真机 QA 抓到 4 处 bug,全部有真机证据、根因已定位
(`packages/voice-core/evidence/poc-converse.md`)。FLY-959 = voice 4 单元之 ①,只修这
4 处 + 补真机回归——543 的直接教训是 **mock 测不出这类 bug**(工具声明缺 schema、
设备索引错位、真实 session 过期,全都只在真 API / 真硬件下暴露)。

| # | Bug | 位置 | 根因 | 证据 |
|---|-----|------|------|------|
| 1 | mic 默认设备错 | `MicCapture.ts:43` | 写死 avfoundation `":0"`(= 设备枚举第 0 位 = 笔记本内置麦),不是 macOS 系统默认输入;注释"default audio device"是错的 | QA 现场:Annie 说话系统全程无反应;`--device ":2"`(DJI)修法已现场验证 |
| 2 | talk session ~50s 过期不重连 | `cli.ts:183-185` (`runTalk`) | `session-expiring` 只打 stderr 警告;`close()` 返回的 resume handle 从未被用于重连 | 原始会话日志两次 `[session expiring in ~50s]` 后会话死掉;backend 的 resume 合同本身已有 mock 测试覆盖(`gemini-live.test.ts:262`) |
| 3 | ask_lead 工具缺 schema | `genaiConnector.ts:56-59` | `functionDeclarations: [{ name: "ask_lead" }]` 无 `description`/`parameters` → 真模型要么瞎编(说 FLY-543 是肯尼亚航空公司)要么卡壳 | QA 对照实验:补标准 JSON schema 后同一会话工具调用立即成功(`gemini-raw-debug-messages.json`) |
| 4 | 默认模型名 404 | `config.ts:35` | `DEFAULT_GEMINI_MODEL = "gemini-live-2.5-flash-preview"` 已被 Google 下线,真 API 报 `not found for API version v1beta` | `client.models.list()` 真实返回 5 个 bidiGenerateContent 模型,该名不在其中(`real-live-models-list.json`) |

## 2. 本次设计阶段新增探针(2026-07-07,本机)

为 bug 1 的修法做了决定性验证(只读探针,未改代码):

- `ffmpeg -f avfoundation -list_devices` → `[0] MacBook Pro Microphone / [1] LG UltraFine / [2] DJI MIC MINI`,与 QA 证据一致;`system_profiler SPAudioDataType` 确认系统默认输入 = DJI MIC MINI。
- **`ffmpeg -f avfoundation -i ":default"` 真机录音成功**,`-loglevel debug` 打印
  `audio device 'DJI MIC MINI' opened` —— avfoundation 的具名 `default` 设备**真的跟随
  macOS 系统默认输入**(ffmpeg 源码 `avfoundation.m` 走
  `[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio]`)。
- 对照:`-i ":0"` 打开的是 MacBook Pro Microphone(mono)。

结论:`":default"` 是 bug 1 的正解,零枚举逻辑、零新依赖。

## 3. 逐 bug 修复选项与推荐

### Bug 1 — mic 默认设备

| 选项 | 内容 | 评价 |
|------|------|------|
| **A(推荐)** | `MicCapture` 默认 device 由 `":0"` 改 `":default"`;config 新增 `micDevice`(env `FLYWHEEL_VOICE_MIC_DEVICE`),CLI `--device` 仍最高优先;mic 启动失败时把 `ffmpeg -list_devices` 的设备清单打进错误信息 | 已真机验证跟随系统默认;改动最小;显式可配三层齐全(CLI > env > default) |
| B | 启动时自己枚举设备 + 解析系统默认(system_profiler / CoreAudio binding)再换算成索引 | 复杂、脆(要 parse 人类可读输出或加 native 依赖),avfoundation 已内建同等能力 |
| C | 保持 `":0"`,只加显式配置 | 不满足 issue 要求的"跟随系统默认" |

### Bug 2 — session 过期自动续期

| 选项 | 内容 | 评价 |
|------|------|------|
| **A(推荐)** | CLI 层 session 轮换,抽成可单测的小单元(`TalkSessionRotator`,cli.ts 同包新模块):收到 `session-expiring` → `close()` 拿 `ResumeHandle` → `createConversation({ resumeHandle })` → 事件处理器与 mic 帧指向新 session | backend 已测合同(`close()` 返 handle / connect 传 handle)原样复用,零 backend 改动;轮换逻辑可用 mock transport 单测 |
| B | `GeminiLiveSession` 内部透明重连(session 自己持 transport 重连) | 动已测合同、session 身份/turn 状态要跨连接迁移,侵入大;POC 阶段不值 |
| C | 过期时提示用户重启 | 不是"自动续期",不满足验收(跑超 50s 不断) |

选项 A 细节边界(设计定死,防实现歧义):
- 触发:`session-expiring`(= 服务端 goAway)。**意外断连(error)不在本 issue 自动重连范围**——保持现状打 error,避免把"网断了无限重试"这种新行为夹带进来;记为 follow-up。
- 轮换单飞:轮换进行中再收到 expiring/事件,不重入(标志位)。
- 无 handle 降级:`close()` 返回 `undefined`(从未收到 resumption-update)时,开**全新** session(丢上下文但不断线),stderr 说明。
- mic 不重启:轮换间隙(亚秒级)到达的帧丢弃——mic 持续采集,只是 `sendAudio` 的目标 session 在换。
- `StreamPlayer` 复用,不重建。
- 轮换成功打一行 `[session resumed]`(QA 回归的观察点)。

### Bug 3 — ask_lead 工具 schema

| 选项 | 内容 | 评价 |
|------|------|------|
| **A(推荐)** | transport 接口 `LiveConnectParams.toolNames: string[]` → `tools: LiveToolDeclaration[]`(`{ name, description, parameters }`);ask_lead 的完整声明定义在 `GeminiLiveBackend`(工具语义本来就属于 backend),`genaiConnector` 变纯管道原样传 SDK | schema 与工具定义同处一文件;connector 不再硬编码业务语义;transport.ts 是 gemini 目录内部接口,消费者只有 backend + connector + mock 测试,改动可控 |
| B | 只在 genaiConnector 里给 ask_lead 硬编码 schema | diff 最小,但工具语义散在 connector,且 connector 里已有的 `sendToolResponse` 硬编码 `name: "ask_lead"` 的坏味道被进一步固化 |

schema 形状用 QA 对照实验**已验证可用**的那份(`poc-converse.md`):
```ts
{
  name: "ask_lead",
  description: "Ask the Lead (the project brain) a question about the project — issues, status, decisions, code. Always call this instead of guessing whenever the user asks about project matters.",
  parameters: {
    type: "OBJECT",
    properties: { question: { type: "STRING", description: "The user's question, in their own words." } },
    required: ["question"],
  },
}
```
顺带修 connector 的 `sendToolResponse` 硬编码 `name: "ask_lead"` → 按 callId 记录 call 的
真实 name 回填(同文件 5 行内的小修,防未来第二个工具静默错名)。

### Bug 4 — 默认模型名

| 选项 | 内容 | 评价 |
|------|------|------|
| **A(推荐)** | `DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview"` | 真实列表里唯一被**本仓真机 E2E 完整证过**的型号(两次独立跑:ASR + 音频回复 + 补 schema 后 tool-call 全通过);QA 证据 2026-07-06,漂移风险最低 |
| B | `gemini-2.5-flash-native-audio-latest` | `-latest` alias 抗下线/改名,但 native-audio 是另一条架构(native 而非 half-cascade),tool 行为未在本仓验证过;冒第二次踩坑风险 |
| C | 运行时 `models.list()` 动态选第一个 bidi 模型 | 行为不可预测、每次连接多一次 RTT;能力漂移应显式追(evidence 快照)而非静默吸收 |

配套:连接错误信息升级——`genaiConnector` 把"model not found"类 close reason 映射成
带指引的错误(提示 `FLYWHEEL_VOICE_GEMINI_MODEL` 可覆盖 + 用 `models.list()` 核对),
下次 Google 再下线模型时用户 30 秒内能自救。preview 模型仍可能再被下线 = 接受的已知
风险(FLY-958 树后续单元继续用真机回归兜底)。implement 阶段动手前用真 key 重跑一次
`client.models.list()` 复核该名仍在。

## 4. Scope 边界(不做什么)

- **不碰 Discord VC 收音**——那是 voice ② STT spike(与本单元并行)的事;543 QA 验通的是本机 mic,别混(FLY-958 proposal 原话)。
- **不做 standalone STT / whisper**(543 就 defer 了)。
- **不做意外断连重试 / 指数退避**——只做 goAway 驱动的续期;网络级 resilience 是后续单元。
- **不重构 cli.ts / backend 架构**——只抽出轮换所需的最小可测单元。
- **不改 announce 面(edge-tts)**——4 个 bug 全在 converse 面。

## 5. 验收标准(真机回归协议,mock 不算数)

1. **真麦克风**:不带 `--device` 起 `talk`,验证 ffmpeg 实际 opened 的设备 = 系统默认(当前机器 = DJI MIC MINI);说话产生 user transcript。
2. **跑超 50s 不断**:会话跨过至少一次 `session-expiring`,观察到 `[session resumed]`,之后对话仍工作(resume 后再问一句、有回答)。
3. **ask_lead 真回到 Lead**:语音问真项目问题(如 "what is FLY-543 about?"),真发生 tool-call 事件 → `HeadlessClaudeBrain`(真 `claude -p`)真回答 → 语音播出,不再瞎编。
4. **真连接**:默认配置(不设 `FLYWHEEL_VOICE_GEMINI_MODEL`)连接成功,无 404。

单测同步补齐(TDD):MicCapture 默认 device 断言、rotator 轮换/单飞/无 handle 降级、
tool 声明穿透 transport、config 新默认模型 + micDevice 解析。真 key 来源沿用 543 的
`NANOBANANA_GEMINI_API_KEY` 借用方案(值不进任何 comm/Discord 消息)。

## 6. 假设清单

- A1: 借用 key 在 implement/QA 阶段仍可用、`gemini-3.1-flash-live-preview` 仍在 list(动手前复核)。
- A2: `":default"` 的行为在 Annie 机器上与本 worktree 探针一致(同一台机器,成立)。
- A3: goAway 后旧连接仍有足够窗口完成 `close()` 取 handle(Gemini 文档语义:goAway.timeLeft 就是留给客户端做迁移的);若真机发现 close 太慢,rotator 改用"已收到的最新 resumption-update handle"直接开新连接,不等 close 返回——两条路径 plan 里都写。
- A4: 模型 404 类错误在 SDK 层表现为 onclose(带 reason)而非 onerror(543 证据如此);实现时以真机为准适配。
