# FLY-2247 barge-in 成熟方案对比 — 探索
Issue: FLY-2247 (https://linear.app/geoforge3d/issue/FLY-2247/raya语音-barge-in-成熟方案-research平台自带-turn-detection-silero-vad-llm-判意图)
日期: 2026-09-01
基于: 无(上游输入为 founder 2026-09-01 18:41/18:44 PT 直令、FLY-2178 exploration/research/rework-vad-research、raya `origin/fly-2178-2205-integration-c907f5dc-v2`)

> 成色标记:✅ = 本单亲手核过原件(文件+行号或命令输出);📖 = 引自上游文档、未复核;⬜ = 未知,需探针。

---

## 0. 本单是什么

founder 2026-09-01 18:41/18:44 PT 直令:FLY-2178 走到 attempt 18,检测层仍是自研规则栈;她判断「自研能量/密度规则可能方向性错误」,要求先 research 成熟方案,并考虑用大模型判意图。

交付物 = **对比建议文档**(非代码)。三条路各答四问:误触抑制能力(呼吸/噪声)、打断生效延迟、接入现有链路的改动面、成本。结论必须给明确建议,供她拍板 FLY-2178 检测层去留。

**边界(明确不在本单)**:FLY-2178 attempt-18 的传输层帧膨胀修复。本单不改任何代码。

## 1. founder 直觉指向的东西是什么(先把靶子摆清楚)

当前检测层 = `apps/voice/src/pipeline/BargeGate.ts`(raya `cac1d1c`)。它在 WebRTC VAD mode 3 的逐帧判决之上,叠了一层手调规则:✅

| 常数 | 值 | 作用 |
|---|---|---|
| `FRAME_MS` | 20 | 定帧 |
| `MIN_VOICED_DENSITY_NUMERATOR/DENOMINATOR` | 7/10 | 滑窗内有声帧密度门 |
| `HESITATION_DECISION_MS` | 800 | 犹豫窗长度 |
| `MIN_COHERENT_VOICED_RUN_MS` | 80 | 一段"有声连续段"的最短长度 |
| `MIN_HESITATION_ANCHOR_RUN_MS` | 240 | 犹豫模式里必须有的"锚段" |
| `sustainMs`(配置) | 350 | 持续语音门 |

加上 `hasCoherentHesitationPattern()`:要求犹豫窗里 **≥2 段** 有声连续段且其中 **≥1 段 ≥240ms**。

这六组常数没有一个来自外部基准,全部是逐轮 QA 反馈调出来的。attempt 10→18 的 addendum 文件名本身就是证据:轮数在涨,常数在增。这正是 founder 说的"方向性错误"——**判别力被放在规则里,而不是放在模型里**。

⇒ 本单要回答的不是"这些常数怎么调",而是"这层规则应不应该存在、被什么替代"。

## 2. 三条路的问题空间

founder 给的三条路,**不在同一层**。先分层再比,否则会拿苹果比橘子:

```mermaid
graph LR
  A[她的声音] --> B[Discord 能量门]
  B --> C{谁判"她在插话"}
  C -->|路1| D[平台 server VAD<br/>24k 上游音频]
  C -->|路2| E[本地 Silero VAD<br/>Discord 解码后]
  C -->|路3| F[ASR partial + 小 LLM<br/>转写之后]
  D & E & F --> G[止声执行器<br/>本地 Downlink flush]
  G --> H[条目命运仲裁<br/>user final 转写]
```

- 路 1 / 路 2 都在**声学层**,争的是"谁的 VAD 更准、更早"。
- 路 3 在**语义层**,它的输入必须等转写,天然晚一个数量级。
- 三条路都**不负责止声**——止声只能是本地动作(§4)。

## 3. 一个必须先说清的结构事实:我们不直接对接 OpenAI Realtime

founder 的 issue 标题写「OpenAI Realtime」,但 Raya 的语音链路是: ✅

```
Discord ── raya apps/voice ── codex app-server (JSON-RPC)
                                   └── thread/realtime/* ── OpenAI Realtime WS
```

Raya 发得出去的只有四个方法(`apps/voice/src/codex/RealtimeTransport.ts`):`thread/realtime/start | appendAudio | appendSpeech | appendText`。`start` 的参数是 `{threadId, transport, outputModality, voice, version, prompt}` —— **没有任何 session/turn_detection 透传位**。

⇒ 路 1 不是"要不要启用平台 turn detection"的选择题。真实问题是:**Codex 替我们配了什么、我们看不看得见**。研究结论见 research.md §1,它把路 1 的形状整个改了。

## 4. 不可外包的那一段(三条路都绕不开)

`apps/voice/src/pipeline/Downlink.ts`:播放侧的 `FrameQueue` **无上界**;`downlinkTargetFrames=5`(100ms)只是播放流目标深度,不是队列上界。📖(FLY-2178 research,Codex R1-8 更正)

⇒ 哪怕服务端 0ms 停止生成,她耳朵里还在播我们已经收下的那一段。**任何方案都必须保留一个本地 flush 动作**(`Downlink.interruptVoice()`,attempt-18 已实现 ✅)。

这条决定了本单结论的形状:**三条路只在决定"谁喊停",不决定"谁止声"。** 拿"平台原生能替我们做完"当理由删掉本地执行器,是错的。

## 5. 待 founder 的决策点(放 plan.md,不阻塞本单)

- D1:采纳「平台信号 + 简化本地门 + Silero」的组合,还是先只做最小的平台信号接入?
- D2:引入 Silero(新增 ONNX/原生依赖)是否可接受?
- D3:「假打断后原位续念」(成熟栈的默认行为)要不要作为 Raya 默认?
