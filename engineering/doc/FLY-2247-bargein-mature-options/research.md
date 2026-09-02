# FLY-2247 barge-in 成熟方案对比 — 调研
Issue: FLY-2247 (https://linear.app/geoforge3d/issue/FLY-2247/raya语音-barge-in-成熟方案-research平台自带-turn-detection-silero-vad-llm-判意图)
日期: 2026-09-01
基于: exploration.md

> 世界标记:[codex-oss] = `~/Dev/codex-oss` HEAD `49025589`;[bin] = 装机 `codex-cli 0.152.1`(`~/.codex-mufasa/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex`);[raya] = raya `origin/fly-2178-2205-integration-c907f5dc-v2` 头 `cac1d1c`(attempt-18);[2178] = `engineering/doc/FLY-2178-bargein-redesign/`。
> 成色:✅ = 本单亲手核过(附命令/行号);📖 = 引自上游文档未复核;⬜ = 未验,需探针。

---

## 1. 结论先行:路 1 的形状跟 issue 假设的不一样

issue 把路 1 写成「要不要启用平台自带 turn detection、semantic_vad 当前可用性」。三条实测把这题改了:

### 1.1 平台 turn detection **已经开着**,而且不可配置 ✅

Codex 在建 OpenAI Realtime v2 session 时硬编码:

```
[codex-oss] codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v2.rs:94-105
    noise_reduction: Some(SessionNoiseReduction { type: NoiseReductionType::NearField }),
    transcription:   Some(SessionInputAudioTranscription { model: "gpt-4o-mini-transcribe" }),  // :37
    turn_detection:  Some(SessionTurnDetection {
        type:                ServerVad,
        interrupt_response:  true,
        create_response:     true,
        silence_duration_ms: 500,
    }),
```

`threshold` 与 `prefix_padding_ms` **未传** ⇒ 走 OpenAI 默认(社区通行配置为 `threshold 0.5 / prefix_padding_ms 300`)。

装机二进制交叉核对 ✅(`strings -a <bin> | grep -c`):

| 字符串 | 命中数 |
|---|---|
| `server_vad` | 2 |
| `semantic_vad` | **0** |
| `interrupt_response` | 2 |
| `silence_duration_ms` | 2 |
| `near_field` | 2 |
| `input_audio_buffer.speech_started` | 1 |
| `conversation.item.truncate` | 1 |
| `thread/realtime/itemAdded` | 3 |

⇒ **`interrupt_response: true` 意味着服务端在听到她开口时就会中止自己这一轮生成** —— 这就是 [2178] 里 S4/S5 探针量到的 150–217ms 停口(📖 n=2,codex 0.148/0.149,突发注入)。它不是"待接入的能力",是**一直在跑的既成事实**。

### 1.2 `semantic_vad` 今天不可达 ✅

```
[codex-oss] .../realtime_websocket/protocol.rs:190-194
    pub(super) enum TurnDetectionType {
        ServerVad,
    }
```

枚举只有一个变体;类型是 `pub(super)`,无 config、无 CLI flag、无 `thread/realtime/start` 透传位。装机二进制 `semantic_vad` 0 命中。

⇒ **可达性(已证)**:Raya 今天选不了它 —— 无 config、无 CLI flag、无 `thread/realtime/start` 透传位,装机二进制 0 命中。

⇒ **适用性(未证,别当结论用)**:官方 schema 里 semantic VAD **仍然暴露 `interrupt_response`**,其定义仍是「VAD start 时取消 response」,所以「semantic VAD 只判说完、不参与打断」**推不出**「它下面 `speech_started`/打断就不存在」。另有社区报告称开了 semantic_vad 后 `speech_started` 不再发出、`interrupt_response` 失效 —— **我没有版本、样本或官方确认**,这是**待验证假设,不是排除理由**。⇒ D4 的措辞已按此收窄。

### 1.3 服务端的开口边沿**已经在推给我们,而 Raya 把它扔了** ✅ ← 本单最重要的发现

```
[codex-oss] codex-rs/app-server/src/bespoke_event_handling.rs:420-432
    RealtimeEvent::InputAudioSpeechStarted(event) => {
        ... ServerNotification::ThreadRealtimeItemAdded({
              thread_id, item: { "type": "input_audio_buffer.speech_started", "item_id": ... }
            })
    }
```

而 Raya 侧只认五个 method:

```
[raya] apps/voice/src/codex/RealtimeTransport.ts:288/296/308/317/334-335
    thread/realtime/started | error | closed | outputAudio/delta | transcript/delta | transcript/done
```

`thread/realtime/itemAdded` 落不到任何分支 ⇒ **静默丢弃**(handleNotification 落空返回,📖 [2178] research §2.4 已指出该形状,本单核到了被丢的那条通知**具体是什么**)。

⇒ 路 1 的接入成本 **不是**"集成一个新平台能力",而是"给一个已经在线上的通知加一个 case"。

⚠️ 但**接上通知**和**让它触发 flush** 是两件事,必须分开(plan R1a / R1b):前者纯观测、零风险;后者是行为改变,在"平台事件对呼吸误触多不多"测出来之前接上去,等于把一个未验证的误触直接升级成可听打断。

### 1.4 ⛔ 更正:平台**没有**替我们纠正听感上下文(round-1 评审推翻了我的初判)✅

我最初读到下面这段就断言「平台已闭环」。这个断言是**错的**,更正如下:

```
[codex-oss] codex-rs/core/src/realtime_conversation.rs:2151-2176
    RealtimeEvent::InputAudioSpeechStarted(event) =>
        if let Some(state) = output_audio_state.take()
           && event.item_id.as_deref().is_none_or(|id| id == state.item_id)   // ← 这个判等
        { 发 conversation.item.truncate { item_id: state.item_id, audio_end_ms: state.audio_end_ms } }
```

两处硬事实让这条分支在正常情况下**走不到**:

| 事实 | 出处 |
|---|---|
| `speech_started.item_id` 是「**说话停止后将要创建的 user message item** 的 id」;而 `conversation.item.truncate` 明文规定「**只有 assistant message item 可以被截断**」 | OpenAI Realtime API reference(两处原文) ✅ |
| Codex **确实解析并带上了** 这个 item_id(`protocol_v2.rs:49-56` 把它读进 `Option<String>`) ⇒ 它不是 `None`,于是 `is_none_or` 退化为 `Some(user_item_id) == assistant_item_id` ⇒ **false ⇒ 不发 truncate** | `protocol_v2.rs:49-56`;`protocol.rs:379-381` ✅ |
| 即便走到发送分支,`audio_end_ms` 也只是 `update_output_audio_state()` 对 **Codex 已收到的 assistant 音频帧时长的累加**(`realtime_conversation.rs:2317-2339`),**不是客户端实际播出的位置** —— Codex 收不到 Raya/Discord 的播放进度,而我们的 `Downlink` 还有无上界积压 | 同上 ✅ |

⇒ **更正后的结论**:成熟栈要做的三件事(停生成 / 纠正听感上下文 / 清播放缓冲),平台只做了**第一件**。
第二件(把她**实际听到哪儿**同步回会话)**没有人在做**,而且 —— **只有我们知道真实播放位置**,平台结构上不可能知道。
第三件仍然只能是我们。⇒ 这不是注释精度问题,是会污染后续会话上下文的正确性缺口(模型以为自己讲完了、她其实只听到一半)。已作为未闭环项列入 §6 与 plan.md。

⚠️ 我们今天也**发不出** truncate:`RealtimeTransport` 只能发 `start / appendAudio / appendSpeech / appendText`(§1.5)。⇒ 这一项要么走上游控制面,要么显式接受为已知缺口。

### 1.5 ⚠️ 关键推论:平台**已经是判官**,而且我们否决不了它 ✅

`interrupt_response: true` 的合同是:**服务端 VAD 一判定"开口",就取消正在生成的 response** —— 这一步在我们收到 `itemAdded` 通知**之前**就已经发生。

⇒ 三条推论,每条都改变了决策:

1. **今天,每一次她的呼吸过了 Discord 门又过了 OpenAI VAD,平台就已经把 Raya 的这一轮掐掉了** —— 与 FLY-2178 的本地检测层做得好不好**无关**。我们既否决不了,现在连看都看不见。
2. ⛔ 「平台喊停 AND 本地 VAD 过门才止声」这种**双信号取与**的设计**不成立**:本地层无权否决服务端的取消,它最多决定「本地播放队列什么时候冲掉」。不冲,队列耗尽后照样静音,只是慢一点、听感不同。
3. ⇒ 若 P1 证实平台 VAD 对呼吸也误触,真实选项**不是**「加个本地层把它否掉」,而是二选一:**(a)** 接受平台会误掐,靠恢复语义兜 —— ⚠️ 但它**只兜 inbox 念读条目**(§2.1),普通对话轮次仍然没有兜底;**(b)** 走**上游控制面**,按台阶推:先要 `server_vad.threshold`(无前置,但它是拿**漏检**换误触抑制);再要 `response.cancel` 透传(**也无前置**,不拆现有 fallback);最后才是 `interrupt_response` 可配(**必须先有 cancel**,§1.6)。

### 1.6 ⚠️ 上游控制面的缺口:**没有 `response.cancel` 通道**(round-2 评审指出,已复核)✅

| 事实 | 出处 |
|---|---|
| Codex 的 `RealtimeOutboundMessage` 枚举**只有** `input_audio_buffer.append` / `input_audio.append` / `conversation.handoff.append` / `delegation.context.append` / `session.context.append` / `session.close` / **`response.create`** / `session.update` / `conversation.item.create` —— **没有 `response.cancel`** | `protocol.rs:51-84` ✅ |
| ⇒ 今天**唯一**能中止 Raya 一轮生成的东西,就是服务端 VAD 触发的那次自动取消(`interrupt_response: true`) | 推论 |

⚠️ **这约束了上游请求的顺序,但不是把它们绑成原子包**(rev 6 更正):
- 若只要到「`interrupt_response` 可关」而没有 cancel,关掉它 = **拆掉唯一现成的停口机制而没有替代**(官方合同下 `interrupt_response: false` 时正在进行的 response 会**继续跑完**)⇒ 这个方向确实有硬依赖。
- **但反方向没有依赖**:官方合同下 `response.cancel` 取消默认 conversation 里正在进行的 response,**没有可取消的 response 时只返回 error、session 不受影响** ⇒ **保持 `interrupt_response: true` 的同时单独透传 cancel,不拆任何现有 fallback**,还能让本地层在平台漏检 / 检得慢时先停生成。
⇒ 因此上游请求是**三个可独立验收的台阶**(plan R6-1 / R6-2 / R6-3),不是一个原子包。

📌 顺带:Codex 发 `conversation.item.truncate` 时是用 `writer.send_payload(json!{...})` 裸发的(`realtime_conversation.rs:2160-2172`),**绕过了这个枚举** ⇒ 枚举里没有,不等于线上发不出;但那是 Codex 内部的路径,**Raya 够不着**。

---

## 2. 当前自研层的实际形状 ✅

| 件 | 位置 | 内容 |
|---|---|---|
| 帧级判据 | `pipeline/WebRtcSpeechDetector.ts` | `webrtcvad` 原生 addon,mode 3(最激进档),48k 立体声→单声道,固定 20ms/960 样本帧 |
| 规则层 | `pipeline/BargeGate.ts` | 6 组手调常数:`sustainMs 350` / 密度 `7/10` 滑窗 / `HESITATION_DECISION_MS 800` / `MIN_COHERENT_VOICED_RUN_MS 80` / `MIN_HESITATION_ANCHOR_RUN_MS 240` / `hasCoherentHesitationPattern` 要求 ≥2 段且 ≥1 段 ≥240ms |
| 止声执行器 | `pipeline/Downlink.ts:98 interruptVoice()` | 替换本地播放 resource,冲掉旧队列 |
| 仲裁 | `inbox/InboxReader.ts` + user final 转写 | 真打断 / 假触发,条目命运 |

### 2.1 ⚠️ 恢复语义的**真实覆盖面**比我 rev 2 写的窄(round-2 评审指出,已复核)✅

| 事实 | 出处 |
|---|---|
| `Speaker.suspendInbox()` **显式要求 `pendingKey.startsWith("inbox:")`**,否则直接返回 false ⇒ 整套 suspend/恢复机制**只覆盖 inbox 念读条目** | `speech/Speaker.ts:237-248` ✅ |
| 假触发落定走 `settleFalseTrigger()` ⇒ `state.position = "front"; state.resumeReady = true` —— 它把条目**重新排到队首**,并**不在这条路径上推进 `resumeFrom`**(`resumeFrom` 由此前的投递证据 `advanceResume()` 按转写覆盖度推进) | `inbox/InboxReader.ts:980-1005, 709-719` ✅ |
| **普通 realtime 对话轮次**既没有可重注的源文本,也没有 response resume handle ⇒ 它被误掐了就是**没了** | transport 面(§1.5)+ 上两行 ✅ |

⇒ **更正**:「假打断原位续念」是一条**窄机制** —— 它能把**已知的 inbox 条目**重新念(带此前覆盖度的近似续接),**不能**对任意被平台掐掉的 Raya 发言做原位恢复。

⇒ 对结论的影响:founder 的原始灾难场景(FLY-2031 r2,5 条念读条目被打死 3 条)**正好落在它覆盖的范围内** —— 所以 R5 对**那个**问题仍然是最强的一招。但**不能**把它写成「平台误掐的风险已被兜住」:普通对话轮次的误掐**目前无解**,只能靠降低误掐率(R6)。

返工前的失败点(📖 [2178] `evidence/rework-vad-research.md`):旧 `BargeGate` 把**网络到达抖动**当语音连续性(`MAX_CONTINUITY_GAP_MS=40ms` 在常见 55ms 抖动下反复清零),6 次样本 4 次 >1s、最慢 2351ms;并把 ≈ -45.21 dBFS 的呼吸底噪计作有效语音。attempt-18 用定帧 + WebRTC VAD 修掉了这两条,但**把判别力搬进了上面那 6 组常数**。

---

## 3. 三路对比(founder 四问)

### 3.1 误触抑制能力(呼吸 / 环境噪声)

| 路 | 判别机制 | 对呼吸的抑制 | 可调性 |
|---|---|---|---|
| **1 平台 server VAD** | OpenAI 服务端 VAD + `near_field` 降噪,跑在 24kHz 上游音频上 | 平台级、真实场景训练;`near_field` 专为近场麦克风的呼吸/口水音设计。**但仍是概率阈值型,不是语义**;对呼吸的实际反应 ⬜ 未测 | **零**(硬编码在 Codex 里,连 `threshold` 都没暴露) |
| **2 Silero VAD** | 神经网络 VAD,6000+ 语言语料训练;MIT ✅ | 明显优于 WebRTC VAD(后者是 2011 年的 GMM,mode 3 已是最激进档,再无余量) | 高:阈值、min_speech、min_silence 都在我们手里 |
| **3 快模型判意图** | 语义:ASR partial → 小 LLM 分「真插话 / 附和」 | **理论上最强**(唯一能把「嗯/对/哈哈」跟「你等一下」分开的层) | 高(prompt 可改) |

⚠️ 三条路串在 **Discord 自己的能量门**下游:呼吸若过不了 Discord 的 `speaking.start`,后面谁也收不到包;过了,则三条路各自再判一次。这是 [2178] r2 灾难的原始放大器,任何一路都不解决它——只是不再直接把它当判决。📖

### 3.2 打断生效延迟

| 路 | 判定延迟 | 备注 |
|---|---|---|
| **1** | 📖 150–217ms(S4/S5,n=2,旧版本 + 突发注入,**必须重测**) | = 服务端判定 + WS 一跳 + app-server 转发。她实测过的「不打断,排队不丢」与之矛盾,[2178] 未裁决 ⬜ |
| **2** | 推理 <1ms/帧 ✅;**判定门槛才是延迟主项**(现 350ms;LiveKit 默认 500ms) | Silero v5 要 512 样本 @16kHz = **32ms 定帧**,我们现在是 20ms@48k ⇒ 需重采样+重组帧,+≤32ms 对齐抖动 |
| **3** | 🔶 **推断 ≥1s 量级**(未实测) | 我**只有 user final 1–3s 的旧观测** 📖,**没有量过 time-to-first-partial** —— final 的延迟不是 partial 的下界。`gpt-5-nano ~200–400ms TTFT` 也是量级估计,无探针。⇒ **「≥1.2s」是我推出来的,不是测出来的**,已按此改写 |

**⚠️ 验收尺子本身要换。** [2178] QA 的主判据是 `audibleStopAt - gateYieldedAt < 300ms` 📖 —— 它量的是**判决之后**的止声时延,**把"判决花了多久"整段排除在外**。用它去否定路 3 是不成立的:路 3 的 `gateYieldedAt` 定义在分类完成之后,那个式子它照样能过。

⇒ 三路要能横向比,必须换成**统一预算**:`speechOnsetAt → audibleStopAt`(她第一帧真语音 → 最后一帧可听音频),`speechOnsetAt` 由离线标注的音频真值给定,三条路共用。P1/P2 要按这把尺子出数(见 §6)。

⇒ 在拿到 first-partial 实测之前,对路 3 的稳健表述是:**「把串行 ASR + 网络 LLM 放进硬实时停口路径,引入了一个没有时限保证的外部依赖(限流/超时/额度),而现有证据不支持它能进 300ms 级预算」** —— 而**不是**「已证实 ≥1.2s」。

### 3.3 接入现有链路的改动面

| 路 | 改动面 | 规模 |
|---|---|---|
| **1** | **分两步**(plan R1a / R1b):**R1a** = `RealtimeTransport.ts` 加 `thread/realtime/itemAdded` 分支 + evidence 事件,**不触发任何动作**;**R1b** = 再把它接成 `Downlink.interruptVoice()` 的触发器,**路由按 B×C 定** | **最小**。零新依赖、零原生模块、零阈值、零音频路径改动(R16 硬门不受影响)。⚠️ R1a 纯观测无风险;R1b 是行为改变 |
| **2** | 换 `WebRtcSpeechDetector` 实现;新增 onnxruntime-node + Silero ONNX 模型(~2MB 模型 + 平台相关运行时二进制);新增 48k→16k 重采样;`BargeGate` 可大幅简化 | **中**。主要风险是原生依赖在 Node 25 / arm64 上的干净安装(attempt-18 已趟过一次 `webrtcvad` 的 node-gyp,📖 有先例) |
| **3** | 新增一条 LLM 调用路径 + partial 转写订阅 + 超时兜底 + 新的失败模式(限流/超时/额度) | **大**,且收益落在仲裁层——那层我们已经有免费判据(§3.5) |

### 3.4 成本

| 路 | 成本 |
|---|---|
| **1** | **$0**。已含在既有 realtime session 里,不新增任何计费 |
| **2** | **$0** 现金。代价 = 一个原生依赖 + 可忽略的 CPU(<1ms/帧,单线程) |
| **3** | 现金极低:gpt-5-nano $0.05/MTok 入、$0.40/MTok 出 ✅ ⇒ 每次仲裁 ~200 tok 入 / 5 tok 出 ≈ **$0.00001**,一天 100 次 ≈ $0.001。**成本从来不是路 3 的问题,延迟才是** |

### 3.5 路 3 的收益已经被免费拿走了一大半 📖

[2178] r2 数据:10 次触发中 5 真 5 假,**真的 5 次全部有 founder-attributed user final,假的 5 次全部没有 —— 10/10 完美对齐**。⇒ 「真打断 vs 假触发」这个仲裁,**裸转写的有无就够了**,不需要 LLM。

小模型唯一比裸转写强的场景:**有转写、但内容是附和词**(「嗯」「对」「哈哈」)。这一类:
- 数量级小(r2 里 0 例);
- 纯字符串词表(≤20 词)就能覆盖绝大多数,**零延迟零成本**;
- 真需要语义时再上小模型,是个**可后置的增量**,不是本单的主线。

---

## 4. 成熟栈横向对照(⛔ round-1 评审推翻了我这一节的原始归纳)✅

我原来写的是「成熟栈的规则就是一个 0.5s 阈值,判别力全在通用 VAD 里」。**这条归纳是错的 —— 它描述的是 LiveKit 的退化路径,不是它今天推荐的默认。** 更正:

| 栈 | 停口触发 | 关键默认值 | 假打断怎么办 |
|---|---|---|---|
| **LiveKit Agents** | `interruption.mode` 两档:<br>**`"adaptive"` = 今天推荐的默认** —— **context-aware barge-in 模型**,专门区分真插话与 backchannel 附和;<br>`"vad"` = 纯 Silero,**退化路径** | `min_interruption_duration` **0.5s**(vad 档)<br>`backchannel_boundary`(Python)防止真更正/改主意被 adaptive 误丢<br>⚠️ adaptive 需要「turn detector 模型 + 支持 **aligned transcripts** 的 STT」 | `false_interruption_timeout` **2.0s** 内无转写 ⇒ `agent_false_interruption` ⇒ **从原位置续念**(`resume_false_interruption` 默认 True) |
| **Pipecat** | VAD(Silero) | — | 打断必须<b>同时清掉已排队的播放</b>,只 cancel 生成不够 |
| **Pipecat smart-turn v2/v3** | — | v3 CPU 推理 12ms | 它判的是「**说完了**」(轮次结束),不是「开始插话」 |
| **OpenAI Realtime** | `server_vad` → `speech_started`,`interrupt_response` 即刻取消 response | `threshold 0.5 / prefix_padding 300ms / silence 500ms`(Codex 只覆写了最后一项) | `semantic_vad` 判轮次**结束**;它下面 `interrupt_response` 仍然存在(§1.2) |

### 4.1 ⇒ 这里冒出来的**第四条路**:专用 barge-in / backchannel 分类器

它既不是通用 VAD(路 2),也不是「等转写再调文本 LLM」(路 3),而是一个**低延迟的音频域小模型**,直接判「这是真插话还是附和」。它正对着 founder 关心的那个问题(呼吸/附和不该打断)。

| 维度 | 评估 | 成色 |
|---|---|---|
| 误触抑制 | **原理上是三/四条里唯一对"附和"有判别力、又不用等转写的** | ✅(LiveKit 官方文档把它列为推荐默认) |
| 延迟 | ⬜ **官方文档未公开** adaptive 的时延数字 | ⬜ |
| 可获得性 | ⚠️ **LiveKit 的实现绑在 LiveKit Agents 框架里**;文档未公开权重、许可、是否可离线部署 | ⬜ |
| 接 Raya 的硬约束 | ⚠️ adaptive 明文要求「turn detector 模型 + **支持 aligned transcripts 的 STT**」。Raya 的 STT 在 Codex 内部(`gpt-4o-mini-transcribe`),我们只拿得到 `transcript/delta`,**拿不到对齐时间戳** ⇒ **今天接不上**,除非自建 STT 或换栈 | ✅(§1.5 transport 面 + LiveKit 文档双向确认) |
| 同族替代 | Pipecat `smart-turn` 是同类思路的**开权重**模型(HF 可下,v3 CPU 12ms),但它训练目标是**轮次结束**,不是 barge-in 判别 ⇒ 不能直接改用 | ✅ |

⇒ **裁决:方向上最对,今天接不上。** 不是因为它不好,是因为它要的输入(aligned transcript)我们的链路给不出来。**列为路线图选项,不是本轮候选**;若将来 Raya 自建 STT 或换 voice 栈,它应该是首选检测层。**⛔ 不能拿它当"不做路 2"的理由** —— 它今天不可用。

### 4.2 修正后仍然成立的两条共同点

1. **语义层不进硬实时停口路径**。LiveKit 的 `min_interruption_words` 要 STT,只用来决定「这次打断要不要**继续**」;smart-turn / semantic_vad 都在轮次结束侧。⇒ 路 3 的定位判断不变。
2. **假打断靠「原位续念」兜底**。这一条三个栈一致,而且是 LiveKit 的**默认开**。在成熟栈里它意味着「检测器允许错,错的代价被恢复语义吃掉」。
   ⚠️ **移植到 Raya 要打折**:我们的恢复**只覆盖 inbox 念读条目**(§2.1),`Speaker.suspendInbox()` 有 `pendingKey.startsWith("inbox:")` 硬门;**普通对话轮次的误掐没有兜底**。⇒ 我们**没有资格**像 LiveKit 那样把检测器的容错度放得那么松。

⚠️ **不再成立的**:「成熟栈把规则砍到一个阈值就够了」。真相是它们**换了更强的检测器**(adaptive 模型),把纯阈值留作退化路径。⇒ 砍掉我们那 5 组手调常数仍然对(它们没有外部依据),但砍完之后**必须换更强的帧级判据**,不能只剩一个裸阈值 —— 这把 R3 的两个动作从"可分先后"变成了"必须成对"。

## 5. 会过期的结论 / 未验项

| 项 | as-of | 怎么重核 |
|---|---|---|
| Codex 硬编码 `server_vad + interrupt_response:true`,无 semantic_vad | [codex-oss] `49025589` + [bin] 0.152.1 字符串 | 升级 codex 后重跑 §1.1 的 `strings -c` 表 + 重读 `methods_v2.rs` |
| `itemAdded` 被 Raya 静默丢弃 | [raya] `cac1d1c` | 读 `RealtimeTransport.ts:288-350` |
| **truncate 分支走不到 / `audio_end_ms` ≠ 播出位置** | [codex-oss] `49025589` + OpenAI 官方 schema | 静态证据强(§1.4),但**未在运行时观测**;P1 裸录里若真出现 truncate,本条即被推翻 |
| 服务端停口 150–217ms | 📖 codex 0.148/0.149,2026-08-19,n=2,突发注入 | **P1** |
| speech_started 对呼吸的反应 | ⬜ 从未测 | **P1** |
| **平台 VAD 与本地 gate 谁先触发** | ⬜ 从未测(我原先断言"平台更早"是错的,见 §3.1) | **P1**,同一 `speechOnsetAt` 基准 |
| **路 3 的 time-to-first-partial** | ⬜ 从未测(`≥1.2s` 是推断) | **P3** |
| Downlink 积压真实上界 | ⬜ | **P2** |
| LiveKit adaptive 的时延 / 许可 / 可离线部署 | ⬜ 官方文档未公开 | 需读源码或问 LiveKit;§4.1 已按"接不上"处理,与时延无关 |
| 「semantic_vad 下 speech_started 不再发」 | ⬜ 社区报告,无版本/样本/官方确认 | 待验证假设,**不作为排除理由** |
| 「打断(v2):不打断,排队不丢」 | 📖 她 2026-08 中旬实测,与 S4/S5 矛盾,[2178] 未裁决 | P1 一并裁决 |
| gpt-5-nano / Haiku 4.5 价格 | 2026-09-01 官方定价页 | 重取定价页 |

### 5.1 未闭环缺口(不是"过期",是从来没人做)

- **她实际听到哪儿,没有任何一方同步回会话。** 平台结构上不可能知道(§1.4),我们知道但**发不出去**(transport 无 truncate 方法)。⇒ 打断后模型的听感上下文是错的。要么走上游控制面,要么显式接受。

---

## 6. 建议的探针(不在本单执行,排期归 Lead)

**统一尺子(三路共用)**:`speechOnsetAt → audibleStopAt`。`speechOnsetAt` 用离线标注的音频真值,不是任何检测器的输出 —— 否则每条路都在给自己打分。

- **P1(决定性)**:真房重叠场景,在 `AppServerClient.onNotification` 裸录全部通知流。判据:
  (a) `itemAdded{input_audio_buffer.speech_started}` 是否到达、相对 `speechOnsetAt` 的时延;
  (b) 服务端 `outputAudio/delta` 是否随之停止、停多久(验证 `interrupt_response` 的实际行为);
  (c) **呼吸误触** —— 分两档,别混为一谈:
      · **c-min(现成、零成本)**:重放 [2178] 已有的 `fingerprint-evidence/1-breath-overlap.wav`(**仓里只有这一个呼吸样本**),回答一个是/否:那次真实灾难里的呼吸,平台 VAD 会不会触发。⇒ **只能裁决这一个已知失败样本**;
      · **c-full(需要新素材)**:采 N 段真实呼吸/环境 + N 段真实开口,**同一段音频同时喂平台链路与 `BargeGate`**,得到两条可比的误触率/漏检率。
      ⚠️ **只有 c-full 够格支持「删掉整层」**。只跑 c-min 时,去留矩阵的「删」那一格**不能触发**;c-min 能得出的最强结论是反向的那一半 —— 「平台也误触 ⇒ 它不比我们强」;
  (d) 同一轮里记录**本地 gate 的触发时刻**,和 (a) 比,裁决「谁先」(我原先的断言是错的);
  (e) 是否出现 `conversation.item.truncate`(证伪 §1.4)。
  台架 = [2178] / FLY-2031 的 QA bot 探针增量场景,无需新基建 📖。
- **P2**:同一单调时钟量 `speech_started 到达 → 本地最后一帧可听音频`,得出播放队列积压真实上界。
- **P3(只在 founder 想保留路 3 时才做)**:量 user `transcript/delta` 的 time-to-first-partial。这是路 3 唯一的真实下界,现在**没有人量过**。

> **判据设计的要害**:(c) 是唯一能证伪「平台 VAD 比我们准」的一条;(b) 是唯一能证实/证伪「平台已经是判官」(§1.5)的一条 —— 而 §1.5 若成立,FLY-2178 检测层的定位就**不由它自己的质量决定**。
