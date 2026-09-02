VERDICT: CHANGES_REQUESTED

## Round-4 findings disposition

- **H1'-a -> RESOLVED** — `plan.md` §1 的三职责拆分现与实现相符：Raya 的 `Downlink.interruptVoice()` 只清本地播放状态；Codex 在 session 中独立硬编码 `interrupt_response:true`；`InputAudioSpeechStarted` 又经 app-server 独立投成 `thread/realtime/itemAdded`。`BargeGate` 的去留因此只是在“本地 flush / 恢复由谁触发”这一职责上竞争。§1 与 §4 现在都由 B+C 回答去留，没有再由 A 推出删层。

- **H1'-b -> RESOLVED** — A=否并不让 `BargeGate` 自动成为唯一触发器；官方合同也明确 `interrupt_response:false` 时 VAD 事件仍可发出。§4 已正确把 A 的直接后果限定为“是否缺显式 cancel”，并把 B×C 三格分别写成：B=是/C=是删；B=是/C=否留作本地第二把关；B=否留作可用触发器。按各格写明的前提，这三个 keep/delete 方向成立；其中删除格也已加上 `c-full` 硬门。

- **H3'-a -> RESOLVED** — `research.md:242-243` 现已把“成熟栈可由恢复语义吸收检测错误”与 Raya 的真实覆盖面分开，并明确 Raya 只恢复 inbox 念读、普通对话无兜底；这与 `Speaker.suspendInbox()` 的 `pendingKey.startsWith("inbox:")` 硬门一致。`plan.md` R5、§1、§4 与 D3 也一致。

- **round-3 新 HIGH（R6 全有或全无）-> RESOLVED** — R6a 已从 cancel 控制面拆出：暴露 `threshold` / `prefix_padding_ms` 可在保持 `interrupt_response:true` 时独立交付。`codex-oss` `49025589` 的 `SessionTurnDetection` 确实没有这两个字段，`RealtimeOutboundMessage` 也没有 `response.cancel`；安装版 0.152.1 的字符串结果同样是 `prefix_padding_ms=0`、客户端 `"response.cancel"=0`。R6b 内部仍有一处新的反方向过纠正，见下方新 finding。

- **round-4 新 HIGH 1（R1 观测与动作绑定）-> PARTIAL** — `plan.md` R1a/R1b、D1 与 `research.md` §1.3 已正确把纯观测和行为接线拆开，C 未测前不再让平台事件直接 flush；但 `research.md:191` 的路线 1 改动面仍写成 `onUserSpeechStarted` 直接接 `Downlink.interruptVoice()`，与 rev 5 的规范相反。另且 Raya 已有 `startDebugRealtimeTap()` 直接订阅 `AppServerClient.onNotification`、记录所有 `thread/realtime/*` 的时间和 kind，正是 `research.md:274` 指定的 P1 裸录入口；所以 `plan.md:53,123` 所称“不落 R1a 就测不了 B/C”也不成立。若 R1a 的目的其实是长期结构化 evidence，而非 P1 的必要探针，应据此重写 D1 的“无条件必做”理由。

- **round-4 新 HIGH 2（D2 旧轴 + P1(c) 不足）-> PARTIAL** — `research.md:277-280` 已把 c-min/c-full 分开，并规定只有同音频双路比较的 c-full 可以支持删层；这一半已解决。但 `plan.md:132` 的 D2 仍是 rev 4 原文：只列“服务端真的取消吗 / 通知可靠吗”，并仍称这两项决定检测层去留，既漏 C 又把 A 带回去留决策。`plan.md:193` 声称 D2 已改为“B+C 决定去留、A 决定 cancel”不符合当前 blob。（`founder-design.html` 已是正确版本，正说明这里是 `plan.md` 漏同步。）

## New findings

### HIGH — R6a 把 `prefix_padding_ms` 错当成降低呼吸误触的控制面

`plan.md:85,89,94,134` 把 `threshold` 与 `prefix_padding_ms` 并列为能“直接降低平台误触率”的独立改进。官方 [`server_vad` 合同](https://platform.openai.com/docs/api-reference/realtime-client-events) 中，`threshold` 才是 VAD 激活阈值；`prefix_padding_ms` 只决定检测到语音后向前包含多少毫秒音频，不参与“是否检测到语音”的判决，因此不会阻止呼吸触发 `speech_started` 或 `interrupt_response`。

这会改变 founder 的 D4 上游请求：为本问题优先暴露的应是 `threshold`；`prefix_padding_ms` 只有在另有上下文截取需求时才有独立价值。且调高 `threshold` 是用漏检/软声灵敏度换误触抑制，不是无条件“风险最低”；每次调参后必须用 c-full 同时重测误触率与漏检率，再重新给 B/C 赋值。

### HIGH — R6b 的“必须成对”只证明了一个方向，仍会让 founder 错拒可独立交付的 cancel 通道

`plan.md:90-94,134` 与 `research.md:121,130` 把 `interrupt_response` 可配和 `response.cancel` 透传定义成绝不能拆开的原子包；但其论证只证明了“**不能先关自动取消而没有显式 cancel**”，没有证明反方向。

OpenAI 的 [`response.cancel` 客户端事件合同](https://platform.openai.com/docs/api-reference/realtime-client-events) 明确允许取消默认 conversation 中正在进行的 response；无 response 可取消时只返回 error，session 不受影响。因此先独立透传 `response.cancel`、同时继续保持 `interrupt_response:true`，不会拆掉现有 fallback，还能让 `BargeGate` 在平台 VAD 检出较慢或漏检时先停生成。当前 Codex 源码/0.152.1 二进制只证明这条通道今天缺失，不支持“它必须等到 `interrupt_response` 可配后才有价值”。

这也使 `plan.md:94` 的适用格不完整：cancel-only 在 B=否时可独立有价值；而若 B=是/C=否且 R6a 调阈值后仍无法把误触降到可接受水平，才可能需要“关自动取消 + 本地判定后 cancel”这对能力来让本地层真正否决误掐。应把 R6 改成三个可验收台阶：R6a 参数；独立的 cancel 透传；最后才是以 cancel 已存在为前置的 `interrupt_response` 可配/关闭。
