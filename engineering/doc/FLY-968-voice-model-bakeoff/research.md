# FLY-968 实时语音模型选型横评 — 调研

Issue: FLY-968 (https://linear.app/geoforge3d/issue/FLY-968/voiceresearch-实时语音模型选型横评-openai-realtime-vs-gemini-live-vs-其他-multi)
日期: 2026-07-07
基于: exploration.md

> **本文档定位**：design 阶段的文档级调研——固化先验、给每个先验标证据等级、圈出
> implement 阶段必须真机验证的命题清单。**横评的最终数字以 implement 阶段的 spike
> 实测为准**（真机验证优先于文档转述，issue 原则）。
>
> 过程说明：原计划三个并行子 agent 深扫，全部撞账号 session limit（2026-07-07 ~13:00 PT）；
> 改为主会话直接定向核查最载重的事实（官方文档 WebFetch + 定向搜索），Track 3 深度受限、
> 已如实标注证据等级。

## 0. 证据等级图例

| 级 | 含义 |
|----|------|
| E1 | 本项目真机实测（S1 spike / FLY-960 / voice-core evidence） |
| E2 | 官方文档，2026-07-07 当日 fetch 原文 |
| E3 | FLY-883 Deep Research（2026-07-05，带引用） |
| E4 | 社区/二手来源（论坛、评测文章），待官方或真机复核 |
| E5 | 训练先验，必须真机验证 |

## 1. TL;DR（先验层面的初步图景）

1. **Annie 问②的核心命题基本成立（E2）**：OpenAI Realtime 官方文档明确支持
   `output_modalities: ["text"]`（原话 "set to [\"text\"] if you want text without
   audio"）→ **545 原 B 设计（text → per-Lead edge-tts）在 OpenAI 上文档级复活**，
   且是单 session、任意声线、不受内置声线数限制。待真机：现役 gpt-realtime 系模型
   实际接受该配置 + 语音入→首 text token 延迟 + 叠 edge-tts 的全链首音是否 ≤1.2s。
2. **Annie 问①（multi-Gemini-Live）配额上不是问题（E4→待真机）**：Tier 1 = 50 并发
   Live 连接，3 session 远在配额内。真正的未知是**编排**（谁答谁 unmute、未点名者
   闭嘴的可靠性）和**成本放大系数**（all-listen ≈ N× 音频输入计费）。
3. Gemini 声线弹药比 issue 预估多（E2）：native-audio 可用**全部 30 个 TTS prebuilt
   voices**（非 8-10 个），中文（cmn）在 91+ 支持语言内，自动语言检测。
4. **dark horse 初判（E4）**：ElevenLabs Agents（编排平台、脑可外接、海量声线、
   $0.08/min）最像「R5 自拼管线的托管版」；xAI Grok Voice **兼容 OpenAI Realtime
   API 规范**（我们写好 openai backend 后近零成本可指向它）；Qwen3.5-Omni-Realtime
   有工具调用+声线克隆+OpenAI 兼容接口（中文最强先验）。Nova Sonic 无中文（仅 5 欧语）
   →基本出局。
5. 迁移成本量级（E1，代码审计）：voice-core 的可插拔设计已预留 `"openai-realtime"`
   backend id，接口合同零改动；加 OpenAI 后端 ≈ 照 gemini 后端三文件模式
   （transport seam 73 行 + connector 206 行 + adapter 319 行）做事件映射 + 测试。

## 2. Track 1 — Multiple Gemini Live sessions（问①先验）

### 2.1 并发配额

- **Tier 1 = 50 并发 Live 连接；Tier 2 报告可达 1000**（E4：Google AI 论坛 + Firebase
  AI Logic limits 页结构佐证；ai.google.dev rate-limits 主页未列 Live 并发项）。
  3-5 条并发 session 的量级**远低于配额**，T1-a 的风险从「会不会被拒」降为「验证即可」。
- 来源：discuss.ai.google.dev t/94634（"Tier 2 project still limited to 50 concurrent
  connections"——注意该帖同时反映 tier 升级后配额未生效的运维坑）；
  firebase.google.com/docs/ai-logic/live-api/limits-and-specs。

### 2.2 声线

- **30 个 prebuilt TTS voices 全部可用于 native-audio Live 模型**（E2，
  ai.google.dev/gemini-api/docs/speech-generation + live-guide 原话 "Native audio
  output models support any of the voices available for our Text-to-Speech (TTS)
  models"）。中文 = "Chinese, Mandarin"（BCP-47 `cmn`），模型自动检测输入语言。
- voice 在 `speechConfig` 于**连接时设定**，per-session 一声线（E2）；未见 mid-session
  换声线机制 → 多声线仍需多 session（或 text 路线）。
- 每 Lead 挑一个声线的可选面足够宽（30 选 N），**中文听感质量待真机逐个筛**（E5）。

### 2.3 编排原语（「谁答谁 unmute」的 API 弹药，E2）

- **文本注入**：gemini-3.1-flash-live-preview 上 `send_client_content` **仅限连接时
  seeding 初始上下文**；会话中的增量文本走 `send_realtime_input`。gemini-2.5 系则全程
  支持 `send_client_content`。→ 「gated + transcript 补喂」路线在两代模型上都有原语，
  但**具体行为（补喂会不会触发模型回答）是 spike 命题**。
- **手动 VAD**：可禁自动 VAD、用 `activityStart`/`activityEnd` 手动划 turn 边界 →
  编排层可以精确控制「这段音频算不算对你说的」。
- **proactive audio**：模型可**主动决定不回**（输入与己无关时）——但 **仅 gemini-2.5
  系 + v1alpha**（E2）；3.1 live 线不可用。这正是 all-listen 编排想要的原生机制，
  可惜在现役低延迟模型上缺位 → all-listen 在 3.1 上只能靠 system prompt 约束
  （「没点你名保持沉默」的服从性 = **spike 最大的行为未知**，E5）。
- 会话时限（E2，与 883 一致）：音频-only 15min（+视频 2min）、128k context、
  resumption + context compression 可无限续。多 session 把重连工程 ×N。

### 2.4 成本模型草表（E3 单价，spike 实测 token 数后定稿）

按 883 单价（$0.005/min 音频入、$0.018/min 音频出，3.1 flash live preview 口径）,
60 分钟 3-Lead 会议、Lead 合计说 ~20 分钟：

| 策略 | 音频输入 | 音频输出 | 估算/会议小时 | 相对单 session |
|------|---------|---------|--------------|----------------|
| 单 session（967 A 形态） | 60min × $0.005 = $0.30 | 20min × $0.018 = $0.36 | **~$0.66** | 1× |
| all-listen ×3 | 3×60×$0.005 = $0.90 | 20×$0.018 = $0.36 | **~$1.26** | ~1.9× |
| gated + 文本补喂 ×3 | ~1×音频 + 文本token（美分级） | 同上 | **~$0.7-0.8** | ~1.1-1.2× |

注意：all-listen 的输出侧按「只有被点名者答」假设只算 1 份；若压制失败、多 session
抢答，输出成本与体验一起崩——又回到编排服从性这个核心未知。T1 判据「成本 ≤2× 单
session」在 gated 策略下先验可达，all-listen 踩线（~1.9×）。

## 3. Track 2 — OpenAI Realtime（问②主候选先验）

### 3.1 text-out（本 track 核心，E2）

- 官方 realtime-conversations 指南（developers.openai.com，2026-07-07 fetch）：
  session 可配 `output_modalities: ["text"]`，原话 **"Lock the output to audio (set
  to [\"text\"] if you want text without audio)"**；且 `response.create` 支持
  **per-response** 的 `output_modalities` 覆盖。
- → 架构含义：**一条 session 当耳朵+turn 管理**，text 出 → TurnRouter 按 speaker
  标签分发 per-Lead edge-tts —— 545 plan 的 D1-B 原设计逐字复活，只换供应商。
  且 per-response 覆盖意味着**同一 session 可以混用**：常规轮 text-out（edge-tts 分
  声线），特殊轮 audio-out（如 filler/ack 用模型原生低延迟嘴）——设计空间比 Gemini
  版 B 更大。
- 待真机（E5）：①现役模型（gpt-realtime / gpt-realtime-2）真接受 text-only（文档 ≠
  服务端行为，S1 之鉴）；②语音入→首 text token 延迟 + 叠 edge-tts（本机实测
  1.25-2.12s 全合成——**这是全链达标的最大风险项**，可能需要流式 TTS 或 edge-tts
  分句流水）全链首音 vs §15 的 ≤1.2s 带。

### 3.2 声线与锁定语义（E2）

- 10 个内置声线：alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin,
  cedar（官方推荐 marin/cedar）。
- **"Once the model has emitted audio in a session, the `voice` cannot be modified
  for that session."**（官方原话）→ R4（单 session mid-session 换声线）**文档级死**；
  但 text-only session 永不 emit audio，锁定条款对 B 线无影响。
- 多 session 各配一声线（OpenAI 版 R3）：10 声线 < Gemini 30，中文听感待真机（E5）。

### 3.3 价格（E4→E2 增量核对）

- gpt-realtime-2：**$32/1M 音频输入（cached $0.40/1M）+ $64/1M 音频输出**；
  换算 ≈ $0.0192/min 入（1 token/100ms）+ $0.0768/min 出（1 token/50ms）。
  与 883 数字一致（gpt-realtime 较 4o-realtime 降价 20% 后的口径）。
- **text-out 模式的成本结构显著更优**：音频输入照付，但输出走 text token（远低于
  audio token）+ edge-tts 免费 → B 线复活的同时把最贵的 audio-out 项砍掉。spike
  实测 token 消耗后出对照表。
- 60min/session 上限（E3）—— /meet 一场会一条连接，免 Gemini 的 15min resumption 税。

### 3.4 其余基础面（E3 为主，spike 补听感）

- function calling：原生、支持长时异步不打断会话流、支持远程 MCP（E3）。
- 输入转写：session 内置输入音频转写（模型可选 whisper/gpt-4o-transcribe 系，E5 需
  核对现役列表）；中英混说质量无公开 benchmark（E3，三家皆然）→ 沿用 545 S1 的中文
  问话样本 + 中英混说句子实测。
- barge-in：VAD 检测新语音自动 cancel + 客户端 truncate，语义文档化最强（E3）。

### 3.5 迁移成本量级（Tadashi 增补问题，E1 代码审计）

- voice-core `VoiceBackend.id` 联合类型**已预留 `"openai-realtime"`**；registry/
  capabilities/ConversationSession 事件词汇表（transcript/audio/turn-complete/
  tool-call/interrupted/resumption）与 OpenAI 事件模型可一一映射
  （conversation.item.* / response.output_audio.delta / response.done /
  response.function_call_arguments / speech_started→cancel）。
- 工作量 = 新增 `backends/openai/` 三件套（transport seam ≈70 行 + connector ≈200 行
  + adapter ≈320 行，照 gemini 模式）+ mock-transport 行为测试 + 真机连通 spike。
  接口合同**零改动**；若走 text-out 路线，另需 545 plan 里本就设计过的
  「response-text 事件」小扩展（原为 Gemini TEXT 准备，retarget 到 OpenAI）。
- 量级结论：**与 545 PR-1 的 voice-core TEXT 扩展同档，不是重写**——「换后端要多久」
  的诚实回答是「一个 backend 目录 + 一轮真机 spike」，非架构性迁移。

## 4. Track 3 — 其他玩家浅扫（E4 为主，深度受限如实标注）

| 厂商 | 形态 | text-out | 声线 | 价格 | 工具 | 中文 | 初判 |
|------|------|----------|------|------|------|------|------|
| **ElevenLabs Agents** | 编排平台（STT→LLM→TTS），**LLM 可自带**（server integration） | 天然（LLM 层文本可得） | 海量声线库 + 克隆（业界最强弹药） | $0.08/min（burst $0.16），静默 >10s 打 95% 折；LLM 计费另算 | 平台层支持 | TTS 多语言含中文 | **真 dark horse**：per-Lead 声线 + 脑外接（= R5 托管版）正中我们需求；未知 = 延迟与 Discord 自定义音频管道的接入摩擦（它主打电话/Widget 场景） |
| **Amazon Nova Sonic** | 单模型 s2s（Bedrock） | 未知 | 有限（男/女声 × 5 语言） | ~$0.015/min（Nova 2 Sonic，便宜） | 支持 | **仅 EN/FR/IT/DE/ES —— 无中文** | **基本出局**（中英混说第一权重直接不满足）；无 AWS key，不再深挖 |
| **Hume EVI 3** | speech-LM（情绪原生） | 未知 | voice-by-description（自然语言描述声线——per-Lead 声线的另类路径） | 订阅制，Pro 超量 $0.06/min | 文档未明 | 未知 | 情绪卖点权重低；voice-by-description 有想象力但生态薄、无 key → 文档级备查，不推深挖 |
| **xAI Grok Voice Agent API** | 单模型 s2s，**兼容 OpenAI Realtime API 规范** + LiveKit 插件 | 待验（若真兼容 OpenAI 规范则应有） | 数十语言、TTS 5 声线线 | 待核 | 支持 + 实时 X 数据 | 待验 | **战略意义 = 兼容层**：我们写好 openai backend 后，xAI 是近零成本的第二供应商；本身不必单独深挖 |
| **Qwen3.5-Omni-Realtime**（DashScope） | 单模型 s2s，WebSocket/WebRTC，OpenAI 兼容接口 | 待验 | 有 + **声线克隆 API** | 待核（国产价格通常低） | **支持 function calling** | **先验最强**（Qwen 系中文） | 中文极限优化 + 克隆的后备路线（接棒 883 的 CosyVoice 战略位，但是托管形态）；有新加坡/美东 region，合规可控 → 值得列入 follow-up 观察名单 |

浅扫结论（初判，implement 阶段可修正）：**没有需要立刻改变主航道的 dark horse**，但
ElevenLabs Agents 值得一次真机小时级评估（有 key），xAI 作为 OpenAI 兼容第二供应商记录
在案，Qwen-Omni 作中文后备观察项。

## 5. 给 plan 的真机验证命题清单（按价值排序）

| # | 命题 | 先验 | 判据 |
|---|------|------|------|
| V1 | 现役 gpt-realtime 系接受 output_modalities:["text"] 并稳定 text 出 | E2 强（文档明确） | 3 轮真语音入、全部 text 出、零 audio 帧 |
| V2 | OpenAI 语音入→首 text token 延迟；+edge-tts 全链首音 | E5 | 全链 ≤1.2s 可接受带（§15）；>1.5s = B-on-OpenAI 破 |
| V3 | 3× Gemini Live 并发 session 各配不同声线连通 | E4 强 | 3 条同时 Ready、声线互异、无限流错误 |
| V4 | all-listen 下 system prompt 压制未点名 session 的服从率 | E5 弱（最大行为未知） | 10 轮点名对话，未点名 session 出声 ≤1 次 |
| V5 | gated + send_realtime_input 文本补喂：补喂不触发抢答、被点名后能引用补喂内容 | E5 | 补喂 5 段后点名提问，答案引用补喂事实且无中途出声 |
| V6 | 3 并发下被点名者首 audio chunk 仍在 0.8-1.2s 带 | E1 单 session 已证 | ≤1.2s |
| V7 | token 级成本实测 → §2.4 表定稿 | E3 单价 | 表格误差 <30% |
| V8 | OpenAI 10 声线中文听感 + Gemini 30 声线中挑 per-Lead 候选 | E5 | 每家 ≥3 个可用中文声线（主观 3 分制，founder 终审） |
| V9 | OpenAI function calling + 输入转写中英混说最小样本 | E3 | 1 次真 tool call 往返 + 混说句转写可辨认 |
| V10 | ElevenLabs Agents 小时级评估（自带 LLM 模式 + 延迟） | E4 | 能否外接脑 + 首音数字 + Discord 接入摩擦定性 |

不真机（文档级即可）：Nova Sonic（无中文出局）、Hume（无 key、权重低）、xAI/Qwen
（记录在案，follow-up 决定）。

## 6. 已知风险与诚实盲区

1. **文档 ≠ 服务端**（S1 之鉴）：V1 没跑通之前，「B 线复活」只是先验。
2. **edge-tts 非流式**是 B-on-OpenAI 全链延迟的最大敌人（本机 1.25-2.12s 全合成）；
   spike 要顺带测「分句流水 / 首句短答」缓解策略，或评估流式 TTS 替代（这属于缓解
   评估，不扩 scope 到选型换 TTS）。
3. Tier 1=50 并发是论坛口径（E4），spike 第一步就是用真 key 验证。
4. 三家均无公开 zh-en 混说 benchmark（E3 定论）——本研究不试图补齐学术空白，只做
   「我们的会议话术样本」小样本实测。
5. Track 3 因 session limit 只到 E4 深度；若 implement 阶段发现 ElevenLabs 值得升级
   为主候选，应开独立 follow-up issue 而非在本 issue 内扩 scope。
