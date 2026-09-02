VERDICT: CHANGES_REQUESTED

## HIGH

### H1 — `plan.md` §4 分支 B 的“平台 AND 本地 Silero”在当前 Codex 合同下不成立

- 攻击的 claim: `plan.md:58-75`，尤其是 `plan.md:64` 的“平台喊停 AND 本地 Silero 过门才止声”，以及据此给 founder 的“检测层从判官降为兜底”结论。
- `research.md:15-46` 已正确证明 Codex 固定发送 `server_vad + interrupt_response:true`。OpenAI Realtime 的合同是：VAD start 一发生，`interrupt_response:true` 就自动取消正在生成的 response；Raya 收到 `thread/realtime/itemAdded` 时，取消已经发生。官方合同见 [OpenAI Realtime API reference](https://developers.openai.com/api/reference/resources/realtime) 的 `interrupt_response` 定义。
- 因而本地 Silero 最多能决定是否立刻 flush Raya 的播放队列，不能否决服务端取消生成，也不能把整条 stop path 变成真正的双信号 AND。即使 Raya 不 flush，服务端也已不再产生新音频，队列耗尽后仍会停；误触仍然发生，只是本地听感不同。
- 这会改变 founder 的决策树：若 P1 证明平台 VAD 对呼吸误触，真实选择不是现文档的“平台 AND Silero”，而是明确接受“平台总会先取消 + 本地恢复”，或把“暴露/关闭 `interrupt_response`、暴露 VAD 参数”作为 Codex 上游控制面路线比较。未修正前，文档没有可靠回答 FLY-2178 检测层是否还能当判官。

### H2 — `research.md` §1.4 / `plan.md` R2 所称“平台已完成听感上下文截断”与源码及 API item 语义不符

- 攻击的 claim: `research.md:83-91` 的“`audio_end_ms` 是已播出的毫秒、平台侧已闭环”，以及 `plan.md:33-36` 的“平台已做三件事中的前两件，只剩本地 flush”。
- `codex-rs/core/src/realtime_conversation.rs:2151-2176` 并不是无条件 truncate。它先取 assistant `output_audio_state`，再要求 `speech_started.item_id` 为空或等于该 assistant audio item id。OpenAI 官方合同明确规定 `input_audio_buffer.speech_started.item_id` 是稍后将创建的 **user message item id**，而 `conversation.item.truncate.item_id` 必须是 **assistant message item id**；见 [OpenAI Realtime API reference](https://developers.openai.com/api/reference/resources/realtime)。正常事件携带 user item id，因此该相等判断不会通过，静态源码不能支持“会自动发 truncate”的结论。
- 即使走到发送分支，`realtime_conversation.rs:2317-2339` 的 `audio_end_ms` 只是 Codex 已收到的 assistant audio frame 时长累计。Codex 没有 Raya/Discord 的播放进度反馈，而 `Downlink` 又有本地积压，所以它不是 `research.md:88` 所写的“已播出的毫秒”。官方 truncate 合同恰恰要求用客户端实际播放位置同步服务端上下文。
- 这是会污染后续会话上下文的正确性缺口，不是注释精度问题。建议文档必须把“truncate 是否发送、item id 是否正确、audio_end_ms 是否等于实际可听位置”列为未闭环项，并在推荐中保留一个把真实 playout position 反馈给 Realtime 会话的职责；不能据此宣称平台已经做完前两件事。

### H3 — `research.md` 的成熟栈对照漏掉了当前 LiveKit 的专用 adaptive interruption detector，导致 R3 的主要归纳失效

- 攻击的 claim: `research.md:157-172` 的“LiveKit 停口触发就是 Silero、整条规则只有 0.5s、假打断不靠更聪明的检测器”，以及 `plan.md:38-44` 据此得出的“Silero + 单阈值就是成熟方案”。
- 当前 LiveKit 官方文档明确把 `interruption.mode="adaptive"` 作为可用时的推荐默认：它使用 context-aware barge-in audio model 区分真实插话与 backchannel acknowledgments；纯 `"vad"` 才是退化路径。参见 [LiveKit Turn handling options](https://docs.livekit.io/reference/agents/turn-handling-options/) 和 [Turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning/)。这正面否定了“成熟栈不靠更聪明的检测器、判别力全在 Silero VAD”的归纳。
- 这也是文档缺失的第四类方案：专用低延迟 audio interruption/backchannel classifier，既不是通用 VAD，也不是等待 ASR 后再调文本 LLM。founder 要的是成熟路线，而该路线直接对应“呼吸/附和不应打断”的问题。文档必须比较其可获得性、部署/许可、时延、Raya/Codex 接入约束，或给出有证据的排除理由，之后才能把 FLY-2178 的本地检测层收敛到 Silero + 单阈值。

## MEDIUM

### M1 — `plan.md` R4 对 route 3 的方向性判断合理，但“≥1.2s / 超 300ms 四倍”没有被现有证据证明

- 攻击的 claim: `plan.md:46-49`、`research.md:120-128`。
- 文档有 `user final = 1–3s` 的旧观测，却没有测 time-to-first-partial；final 的延迟不能作为 partial 的下界。`gpt-5-nano ~200–400ms` 也只是未附探针的量级，不能与 final 观测拼出“总计必然 ≥1.2s”。诚实边界 §6 没有把这项标为推断。
- 更关键的是文档引用的验收式是 `audibleStopAt - gateYieldedAt < 300ms`。若 route 3 的 `gateYieldedAt` 定义在 ASR/分类完成之后，该式完全排除了检测等待时间，不能用来证明 route 3 违反 300ms。要比较三路，必须增加统一的 `speechOnsetAt -> audibleStopAt`（或首个输入音频帧到最后可听帧）预算，并实测 first-partial + classifier + local flush。
- 在没有这些数据前，“不要把串行 ASR + LLM 放进硬 stop path”仍是稳健建议，但应基于额外网络/模型依赖和无法保证硬时限来表述，不能把 `≥1.2s` 写成已证实事实。

### M2 — `plan.md` R1 把平台信号描述为“比我们的链路更早”，因果顺序写反了

- 攻击的 claim: `plan.md:26-31`，尤其是 `plan.md:30`；同类表述见 `research.md:114,124`。
- Raya 的本地 WebRTC/Silero 检测器在 Discord 解码后的本机帧上运行；平台 VAD 只有在同一音频先经 `appendAudio`、app-server 和 OpenAI WS 后才能产生 `speech_started`，通知再沿反向链路回到 Raya。平台可能因为门槛更短而最终更早触发 stop，但不能仅凭“24k 上游音频”断言它在链路位置上更早。
- P1 应直接对齐同一 `speechOnsetAt` 比较本地 gate 与 `itemAdded` 到达时间；在数据出来前，R1 的收益应限定为“额外的成熟 VAD 信号 + 已有服务端取消事实”，而不是“更早”。

### M3 — `plan.md` D4 把“当前不可达”扩大成“semantic_vad 不适合打断”，证据边界不足

- 攻击的 claim: `research.md:48-59` 和 `plan.md:84`。
- “当前 Codex 0.152.1 无公开透传位、安装二进制无 `semantic_vad`”得到静态证据支持；这足以得出“Raya 今天不能选择它”。但“semantic VAD 只判断说完、不参与开口打断”并不能推出 `speech_started`/interrupt 不存在：当前 OpenAI 官方 schema 仍为 Semantic VAD 暴露 `interrupt_response`，其定义仍是在 VAD start 时取消 response。
- “社区报告 speech_started 不再发、interrupt_response 失效”没有给出链接、版本、样本或官方确认，却被用来给 D4 下永久性的“不推”结论。应把可达性与适用性分开：保留“当前不可达”，把行为风险降为待验证假设，或用版本绑定的一手证据支持排除。

## LOW

### L1 — 三项指定的静态基础事实均已复核通过，不是本轮拒绝原因

- `research.md` §1.1：`codex-oss` HEAD `49025589` 的 `methods_v2.rs:94-105` 确实固定 `near_field + server_vad + interrupt_response:true + create_response:true + silence_duration_ms:500`。
- `research.md` §1.2：该 checkout 的 `TurnDetectionType` 只有 `ServerVad`；安装的 `codex-cli 0.152.1` 中 `semantic_vad` 为 0 命中，且从该安装二进制生成的 experimental app-server JSON schema 没有 turn-detection/semantic-vad start 参数。故“当前 Raya 公共接入面不可达”成立。
- `research.md` §1.3：`bespoke_event_handling.rs:420-432` 确实把 `InputAudioSpeechStarted` 发成 `thread/realtime/itemAdded`；Raya 快照 `RealtimeTransport.ts:277-357` 没有该 method 分支，未知通知会无事件地退出 handler。故“服务端已转发而 Raya 当前丢弃”成立。

