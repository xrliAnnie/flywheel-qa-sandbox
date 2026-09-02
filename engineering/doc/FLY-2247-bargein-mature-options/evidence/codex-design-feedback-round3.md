VERDICT: CHANGES_REQUESTED

## Round-2 findings disposition

- **H1' -> PARTIAL** — `plan.md` §4 已正确把“服务端是否实际取消”(A)与 `speech_started` 通知是否可靠且够快(B)拆开，并在 A=是/B=是时明确给出 `BargeGate` 可删、A=是/B=否时给出保留。但两个会直接影响 founder 去留决定的问题仍未闭合：
  1. §1 :13-17 仍说去留“取决于一件事”A，并把 A=是直接归纳成“它可以删”；这与 §4 :97 的 A=是/B=否时“留”正面冲突。当前 headline 仍会给 founder 一个不同于矩阵的答案。
  2. §4 :98 把 A=否/B=任意合成一格并断言本地层是“唯一的判官”，并不是一个成立的 per-cell verdict。[OpenAI Realtime client-events 合同](https://platform.openai.com/docs/api-reference/realtime-client-events)明确允许 `interrupt_response:false` 时 response 继续、同时 VAD events 仍照常发出；Codex 的 `InputAudioSpeechStarted` 也独立转成 `thread/realtime/itemAdded`。因此 A=否/B=是时，R1 本身就是一个可靠、快速的平台检测信号；当前 `BargeGate` 和 R1 都缺少停止服务端生成的能力，真正共同缺的是 R6 的显式 cancel。拿到 cancel 后是否还留 `BargeGate`，取决于平台事件的误触质量(P1(c))，不能仅由 A/B 推出“留且必须投”。应把这一格单列，或把准确性条件显式纳入判据。

  所以 rev 3 已经开始直接回答 founder 的问题，但答案尚不自洽：§1 与 §4 会给出不同结论，且 A=否/B=是这一格仍没有证据足够的去留结论。

- **H2' -> RESOLVED** — `plan.md` R6 已撤回“只暴露 `interrupt_response` 就把决定权还给本地/唯一治本杠杆”的说法，并把显式 `response.cancel` 加进取得本地判定权的必要控制面。`codex-oss` HEAD `49025589` 的 `RealtimeOutboundMessage` 只有 `response.create`、没有 `response.cancel`；app-server 协议只暴露 realtime start/appendAudio/appendText/appendSpeech/stop。装机 `codex-cli 0.152.1` 生成的 experimental JSON schema 也没有 cancel request 或 VAD 参数。二进制中的 `response.cancel` 字符串命中来自服务端 `response.cancelled` notification，不是客户端发送通道。[官方合同](https://platform.openai.com/docs/api-reference/realtime-client-events)同时确认显式 `response.cancel` 才是客户端取消进行中 response 的事件。

- **H3' -> PARTIAL** — `plan.md` R5、§4、D3 与 `research.md` §2.1 已按真实源码收窄：`Speaker.suspendInbox()` 要求 `pendingKey.startsWith("inbox:")`；`settleFalseTrigger()` 只设置 `position="front"`/`resumeReady=true`，不推进 `resumeFrom`；`resumeFrom` 只在另一条未确认投递路径中由 transcript coverage 更新。因此“仅覆盖 inbox 条目、近似续接而非精确原位、普通 realtime 轮次无恢复 handle”是准确的。但 `research.md:119` 仍建议把赌注“全押在恢复语义上”，`:240` 仍断言“检测器允许错，错的代价被恢复语义吃掉”；两处都把已经证实的 inbox-only 机制重新泛化到了普通对话。它们会让 founder 误以为平台误掐已有通用兜底，需与 §2.1 同步收窄。

## New findings

### HIGH — R6 又在相反方向过度纠正，把可独立交付的 VAD 参数调优错误地写成与 cancel 的全有或全无绑定

`plan.md:68-71` 写“两件一起要，少一件就别提”，D4 :117 也要求必须同时取得 VAD 参数/`interrupt_response` 配置和 `response.cancel`；但 `plan.md:75` 自己又承认只取得参数也有价值。后一句才符合官方合同：保持 `interrupt_response:true` 的同时调高 `server_vad.threshold` 可以独立降低平台 VAD 的触发敏感度，`prefix_padding_ms` 也可以独立调节保留的前导音频；二者都无需先关闭自动取消，也无需显式 cancel。

`response.cancel` 的硬依赖只存在于“把 `interrupt_response` 关掉、把最终取消决定交给本地检测器”这条分支。把它扩大成所有参数支持的原子前置条件，会让 founder 在上游只能先交付参数调优、暂时不能透传 cancel 时错误地拒绝一个确有价值且不拆掉现有停口机制的改进。R6/D4 应拆成两层：VAD threshold/prefix 调优可独立接受；只有启用 `interrupt_response:false`/本地判官模式时，才必须与 `response.cancel` 成对交付并验收。
