# Design Review — plan.md (Round 2)

Date / Author: 2026-09-25 / Codex / Status: CHANGES REQUESTED

## Summary

WebRTC + 订阅认证方向仍然可行。R1 九项中，七项的设计修订可以关闭；R1-1 的解除静音、R1-3 的朗读回执绑定仍未闭合。此外，v2 提交误删了完整 T8 上下文装配任务，这是新的 HIGH 问题。本轮共 **3 HIGH、1 LOW**；LOW 是进程退出证据的措辞修正，不要求恢复 owner/PID 方案。

评审基线：计划提交 `be93dd63e4a206725e8604e523ef6897eeb2f1d3`；工作树 HEAD `115bc1b781ebe188ce2f55096fde9a6ade14198a`。已执行 diff，磁盘 plan.md 与指定提交一致。FLY-2884 证据固定于 `148e53fe0869e4a1d757a593003620eec34e301b`；Codex 固定源码为本地 clone 的 `rust-v0.156.1`（`81e8e29b2956dfe9b092c63953a9ed282781e77c`），并对照 `rust-v0.157.0`。

已读取项目约定、exploration/research、source-facts、三场 probe 与 probe2.mjs、父进程退出实验、FLY-2884 原型及计划/调研、FLY-2799 设计，并核对题列源码和接口消费者。执行了只读 Git/源码检查、既有 JSONL/逐帧数据解析，以及计划状态机的离线反例重放；重放退出码为 0。未运行项目测试套件、live probe 或操作 529 房。凭据只检查了文件元数据：当前默认源为本用户拥有的 0600 普通文件；没有读取其内容。只写本反馈文件，工作区已有展示文件改动保留。

下文 `plan.md` / `evidence/` 指 `engineering/doc/FLY-2885-webrtc-voice-connection/`；`V:` 指 `packages/voice-codex/src/`；`TL:` 指 `packages/teamlead/src/`；`C156:` 指上述固定 tag 下的 `codex-rs/`；`P2884:` 指上述固定上游提交的 `engineering/doc/FLY-2884-discord-webrtc-voice/`。行号均对应实际读取内容。

R1 逐项核验：

| R1 | 本轮状态 | 核验依据 |
|---|---|---|
| 1 迟到事件与解除静音 | **未关闭** | 不再等待 assistant created、取消 15 s 强放是正确改进；但用户证据仍是观察有效边界的前置条件，见问题 1。 |
| 2 下行清队列与 lease | **设计关闭** | `plan.md:104-108,234` 明确资源替换、cancelAllSpeech、换代/租约 cut 和积压消费测试；与 `V:audio.ts:377-402`、`V:discord-room.ts:379-380` 的迁移要求相符。 |
| 3 v3 朗读回执 | **未关闭** | T5b 补了任务、缺事件失败及定向测试，但 first-after-RPC 和任意有声包仍不足以证明本次朗读，见问题 2。 |
| 4 重连串代与超时资源归属 | **设计关闭** | `plan.md:97,181-190,238` 已明确唯一通知路由、closed 屏障、失败终场、故障合并及尝试拥有 AbortController/腿。保留这些条件，不恢复“忽略 stop 失败后继续开”。 |
| 5 orphan 清扫 | **简化方案可接受** | `plan.md:191-193` 在锁后清扫且跳过 cwd 忙目录；固定源码进一步支持 EOF 后有界退出。原先 owner/PID 写入窗口已随该方案删除而消失；措辞校准见 LOW 问题 4。 |
| 6 旧 liveVoice 投影 | **设计关闭** | `plan.md:197-200,240` 明确可缺省、显式非法值拒绝及恢复测试；匹配共享解析器 `V:projection.ts:14-53`。 |
| 7 wrapper 环境 | **设计关闭** | `plan.md:204-207,225,241` 明确 exec 前 unset 两把 key，并保留旧引擎分支；解决了 `scripts/flywheel-voice-wrapper.sh:59-72` 整体加载 .env 的问题。 |
| 8 QA 状态与回归覆盖 | **设计关闭** | `plan.md:239-250` 修正测试路径，补来源排除用例，并分离恢复、杀子进程终场和获准后的收尾；检查范围绑定本场。T8 正文本身另有新问题 3。 |
| 9 started / SDP 顺序 | **设计关闭** | `plan.md:91-93,233` 与 `C156:core/src/realtime_conversation.rs:1616-1637`、probe-2 第 8-9 行、probe-3 第 9-10 行一致。 |

这里的“设计关闭”不表示实现或 QA 已通过。

## What's Good (Keep)

- 保留 PCM 上行、单说话人、白名单与 pre-roll，仅替换末端传输，并把新门行为限制在 opus 模式，范围合理。实际门公式在 `V:pipeline/UplinkSpeechGate.ts:129-150` 得到 24 帧；当前插话在 `V:codex/CodexVoiceBackend.ts:307-366` 确实重启连接，归属回退在 `:480-502` 确实使用 sole room user。
- `cut()` 复用已有资源替换模式；重连采用可观测关闭屏障和有界尝试；这些修订比仅给回调补本地 generation 更可靠。
- 认证改动保留固定二进制、白名单环境、只建软链及删除不伤源文件的检查；不再传 voiceProfile 即可复用现有 spawn，默认 secret wash 不需要改。证据：`V:codex/CodexVoiceContainer.ts:218-252`、`TL:lead-backends/codex/codex-lead-runtime.ts:1430-1462`。
- `liveVoice` 与旧声线分离、投影可选、新房间模式默认 PCM、QA 各阶段检查本场资源，均应保留。无需重开 Lead 已批准的声线/上下文方向，也无需新增通用 supervisor、历史回放或多人混音。

## Issues & Recommendations

1. **HIGH — T5 仍会错过事件到达之前的静音边界，不能保证新回答句首完整。〔R1-1 未关闭〕**

   **问题与证据：** `plan.md:124-133` 先等用户证据进入 Armed，再等连续十个无声包；没有保留已过去的边界及其后的有声包。`plan.md:116` 关于截断到新回答之间“必有约 1 s 静音”的说法也不是现有协议保证。

   `[verified by executing]` 对 P2884 的 s3 既有记录做离线重放：`P2884:evidence/s3/bridge.jsonl:255` 在 **69,394 ms** 记录插话 speaking_start；最早用户证据是 `:261` 的 app-server 用户 delta，**70,747 ms**，数据通道 user created 更晚（`:264`，70,870 ms）。同场 `frames-bridge.json.gz` 的 down 数组在 **70,174.6–70,555.3 ms** 有 19 个低能量包，随后恢复有声；下一段十包静音直到 **71,838.9 ms** 才满足。假设本地 cut 在 69,600 ms，逐条执行计划规则，首次恢复有声播放为 **71,983.2 ms**，间隙后的 **54 个有声包**已经被消音（采用该场 RMS 阈值 300；用 probe 的 400 阈值也丢 53 包）。这是对既有音频时间线的设计重放，cut 时刻是假设，不冒充已实现的 B 房间实测，也不靠它单独判定每包所属 turn。

   更直接的允许时序反例：cut=0；旧音频到 800 ms；静音 800–1,800 ms；新回答 1,800–2,600 ms；当前轮 DC user 事件缺失，app-server 用户 delta 在 2,200 ms 才到。该序列甚至满足计划假设的一秒静音，也属于 `plan.md:235` 要覆盖的“用户转写晚于 2 s”。按计划重放，**新回答 40 个包全部被静音**，直到回答结束后才解除；3 s 误判兜底无法挽救已经丢弃的句首。

   **为什么重要：** R1 的根因是事件与音频的不同步；把 assistant 事件换成 user 事件并未消除它。连续 200 ms 低能量只能证明一个音频间隙，不能独立证明旧轮结束或句子边界。新回答首帧和可听延迟仍无保证。

   **建议：** 明确从 cut 开始如何保存/识别边界，以及证据跨过边界才到时如何处置后续音频。若需要有界保留并重放句首，写清时长、归属依据和延迟预算；若无法安全划分，定义有界失败/恢复结果，不能把任意后续停顿当作已经保住句首。补入上述迟到用户证据反例、s3 时间线、双方事件缺失、同一回答内 200 ms 停顿，并断言实际播放包序列。误判分支允许续播旧内容可以保留，但“低能量间隙”不要写成已证明的“句间停顿”。

2. **HIGH — T5b 的 first-after-RPC 绑定仍可能借用自然回答，播放证明也未绑定到该 turn。〔R1-3 未关闭〕**

   **问题与证据：** `plan.md:145-151` 以 appendSpeech RPC 成功后的第一个 assistant turn.created 绑定请求，再用 RPC 成功至 turn.done 之间任意一个未静音有声包判断 submitted。这仍然是在用到达顺序和时间窗口建立因果关系，与同节“不用时间邻近/能量活动当证据”的声明冲突。

   `[verified by reading code]` `C156:app-server/src/request_processors/turn_processor.rs:1339-1361` 在提交 `Op::RealtimeConversationSpeech` 后就返回空成功响应；`C156:core/src/realtime_conversation.rs:1059-1081` 再把文本送入输出队列。响应没有服务端 turn id，也不是该段朗读已经开始的确认。当前上层允许自然回答期间提出朗读：`V:session.ts:373-380` 只检查 pendingSpeech/live，没有检查自然回答状态；`V:codex/CodexProofSpeaker.ts:235-254` 只排斥另一条 pending 朗读。

   现有 probe-2 的自然回答首个有声包在 **7,845.1 ms**，assistant created 到 **8,760.5 ms** 才到（`evidence/probe-run2-prompt48kb.jsonl:17-19`）。因此可构造：在这段窗口内发送新朗读并收到 RPC 成功，下一条 assistant created 仍是已在说的自然回答；它对应的 user created 早已到达，T5b 的“绑定前先见 user 则拒绝”不会挡住。随后自然回答的声音与 done 就会被结算给这次请求。此处是基于已观测延迟和现有调用条件的反例，probe 本身并未做这次并发 appendSpeech。

   **为什么重要：** 常见结果是错绑后提前返回 speech_not_equivalent，真正朗读随后出声却不再有对应 pending；重复措辞时还可能误给当前 pendingKey 成功。即便 turn 绑定正确，一个时间窗口内的有声包仍可能来自前轮，或本块其余音频被 trim；“无 cut”不覆盖 `plan.md:107` 的裁队列。前端会把 completed 直接映射成 confirmed（`V:codex/CodexRoomFrontend.ts:131-143`）。串行朗读只能隔离 appendSpeech 请求之间的重叠，不能隔离自然回答。

   **建议：** 在发请求前建立 pending，明确自然回答尚在途/事件迟到时的准入或 busy 行为；给出可验证的请求→turn→该 turn 音频提交关系。无法建立关系时维持未确认/失败，不能把“第一个到达”升级为 proof。定义部分提交、trim、事件先于 RPC 响应及前块尾音重叠时的结算规则。补测：自然回答音频先到、appendSpeech 成功后才到旧 created；旧音频与新块 done 同处窗口；等价的旧转写；裁队列；真正多块朗读。无需新增通用回执框架，但必须闭合这些既有消费者依赖的语义。

3. **HIGH — v2 误删完整 T8，Bridge 到容器的上下文迁移已没有实施契约。〔本轮新增〕**

   **问题与证据：** `[verified by executing]` `git diff be93dd63e^ be93dd63e -- engineering/doc/FLY-2885-webrtc-voice-connection/plan.md` 明确删除了原 T8 的全部内容：快照 v2、`realtime: {prompt, initialItems}`、确定性分段、32,000 字节/128 items 上限、15,500 o200k prompt 预算、v3 协议文案及 assertContext 校验。当前 `plan.md:190-195` 从 T7 直接进入 T9，只有 `:239,258,272` 仍引用不存在的 T8；`:272` 甚至声称两个上限已写在该节。

   `[verified by reading code]` 当前 Bridge 将全部记忆放入 baseInstructions，再把它整体作为 realtimePrompt 的前缀（`TL:bridge/voice-session-context.ts:510-540`），仍按 32,768 token 总预算校验（`:575-605`）。容器接口只有 manifest version 1 与 realtimePrompt（`V:codex/CodexVoiceContainer.ts:38-52`），assertContext 明确要求 `realtimePrompt.startsWith(baseInstructions)`（`:350-375`），启动只传该 prompt（`:679-687`）。这不是仅需补回一个标题：记忆拆分后上述前缀不变量不再成立。probe-1 第 12-13 行已实际记录 16,384-token 上限拒绝，research.md:34-57 说明了真实 Lead 规模为什么需要拆分。

   **为什么重要：** 仅按剩余任务实施，会继续发送可能超限的旧 prompt，或在引入拆分后被本地 context_invalid 拒绝；T3 的 initialItems 没有定义来源。R1 已认可的上下文方案不能靠 research 和实施者猜测补齐。

   **建议：** 恢复已批准的 T8 正文，保持 baseInstructions 给 backing thread、实时 prompt/items 分开预算且不截断。明确 Bridge 响应、CodexVoiceContextSnapshot、manifest/digest/measurements、assertContext 和 realtime/start 的端到端字段及版本迁移；v3 文案替换 [BACKEND]，T5 插话说明也在此落地。除 builder 的 Raya/Honey 规模夹具外，在已有 container/transport 定向测试中证明同一快照经过校验后把完整 prompt/items 发到 start，并验证预算边界及超限拒绝。无需重新询问 Lead 已批准的取舍。

4. **LOW — 父进程退出实验只证明 initialize 场景的 1 秒结果，应引用实际 EOF 退出上界。〔不阻塞简化方向〕**

   **问题与证据：** `plan.md:191-193` 从“父进程 SIGKILL 后 1 s 内退出”推导旧目录必属已死进程。`evidence/orphan-parent-kill.mjs:4-6` 只在 initialize 首次输出后杀父进程，没有活动 thread/realtime。固定源码确实提供更强、但不同的依据：`C156:app-server-transport/src/transport/stdio.rs:125-133` 在 EOF 启动 shutdown watchdog，`:168-180` 的兜底是 **45 秒**；正常流程还会 drain background tasks / shutdown threads（`C156:app-server/src/lib.rs:1305-1314`）。

   **为什么重要：** 获取 daemon 锁只能证明旧 daemon 已退出，旧子进程可能仍在短暂收尾。计划现有 lsof busy 分支正好覆盖这个窗口，故没有理由恢复原 owner/PID 设计；但不能把 initialize-only 的实测提升为所有会话的 1 秒硬保证。

   **建议：** 将表述改为“该初始化实验 1 s 内退出；固定版本在观察到 EOF 后有进程退出兜底，启动清扫可能遇到仍在收尾的 root 并跳过”。引用上述源码，并在 busy 测试覆盖这个正常窗口；lsof 不可用/检查失败应保留目录并记证据，不能当作确认空闲。

## Verdict

**CHANGES REQUESTED**

修复三个 HIGH：补回 T8，闭合迟到用户证据下的静音恢复，以及请求/turn/音频提交的朗读绑定。保留已关闭的七项 R1 修订，不重开已批准的架构与 Lead 裁定。现有证据支持订阅 WebRTC 的可行性，但还不支持 v2 关于句首完整和可信朗读回执的保证。
