VERDICT: CHANGES_REQUESTED

## Round-3 findings disposition

- **H1'-a -> RESOLVED** — `plan.md` §1 已把即时止声、本地/服务端停生成、触发信号三个职责拆开；`BargeGate` 的去留明确只由平台事件能否胜任触发器(B、C)决定，不再由轴 A 推出。这与 §4 的 B x C 矩阵一致。Raya 的 `Downlink.interruptVoice()` 确实只处理本地播放队列；Codex 的 `interrupt_response:true` 与 `InputAudioSpeechStarted -> thread/realtime/itemAdded` 也分别位于服务端取消和通知两条独立路径。

- **H1'-b -> RESOLVED** — §4 已把 A 从去留矩阵中移出，并正确说明 A=否时无论选平台事件还是 `BargeGate`，当前 Raya 都缺少停止服务端生成的通道；此时缺的是 R6b 的显式 cancel，不是另一套检测器。B x C 三格在各自前提成立时的留/删方向本身成立。

- **H3'-a -> PARTIAL** — `research.md:119` 已明确恢复只兜 inbox、普通对话无兜底；但 `research.md:240` 与 rev 3 完全相同，仍把“假打断靠原位续念”泛化成三个栈共同结论，并断言“检测器允许错，错的代价被恢复语义吃掉”。对 Raya，这仍与 `Speaker.suspendInbox()` 的 `pendingKey.startsWith("inbox:")` 硬门及同文 §2.1 冲突。作者在 `plan.md:177` 声称“两处均已同步收窄”不符合当前 blob。

- **round-3 新 HIGH（R6 全有或全无）-> RESOLVED** — R6/D4 已正确拆为可独立交付、保持 `interrupt_response:true` 的 R6a，以及必须把 `interrupt_response` 可配与 `response.cancel` 透传成对交付的 R6b。`codex-oss` `49025589` 的 `SessionTurnDetection` 仍只硬编码 `server_vad`/`interrupt_response:true`，`RealtimeOutboundMessage` 无 `response.cancel`；0.152.1 安装版 experimental schema 同样没有 VAD 参数或 cancel 请求。依赖边界现已准确。

## New findings

### HIGH — R1 仍把“观测平台事件”和“让它立即 flush”绑成一个无条件动作，无法执行 B=是/C=否这一格

§4 `plan.md:109` 在平台事件误触更多时要求保留 `BargeGate` 作为本地 flush 的第二把关；但 R1 `:47-51` 仍定义为收到平台事件就“立刻冲本地队列”，`research.md:189` 也仍把回调直接接到 `Downlink.interruptVoice()`。一旦 R1 已立即 flush，`BargeGate` 事后就不可能再收紧这次本地止声。D1 `plan.md:126` 又要求在 C 尚未测量前无条件先落 R1，因此可能先把尚未验证的呼吸误触直接升级成可听打断。

这会改变 founder 的首批交付决定，不是实现细节。应把“接收并记录 `speech_started`（所有格都做，供 P1 观测）”与“把该事件接成 flush/恢复触发器（按 B x C 结果选择）”拆开，或明确每格的路由合同；在 C 未通过前不能把后者写成无条件必做。

### HIGH — founder 决策表仍沿用旧的 A x B 规则，而且现有 P1(c) 不能给新的 C 轴赋值

§1/§4 已说去留由 B、C 决定、与 A 无关；但 D2 `plan.md:127` 仍说 P1 的“服务端真的取消吗 / 通知可靠吗”这两个问题决定检测层去留和 R3，也就是仍把 A、B 当决策输入并漏掉 C。与此同时，C 被定义成“平台对呼吸的误触率 <= BargeGate”，而 P1(c) `research.md:274` 只对一个 `1-breath-overlap.wav` 问一次“是否触发平台 VAD”，没有样本集/重复次数，也没有同基准的两路误触率比较；它最多验证这个已知 fingerprint，不能支持按“误触率”删除整层。

因此正文矩阵虽已自洽，founder 实际看到的拍板项仍会用错轴，且探针按现合同跑完也不足以把结果放进 C=是/否。D2 应改成 B+C 决定去留、A 决定 cancel 控制面；P1(c) 则需与 C 的判据对齐（若只想裁决该单一灾难样本，就把 C 和结论同步收窄到该 fingerprint，而不是声称误触率比较）。
