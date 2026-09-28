# Design Review — plan.md (Round 1)

Date / Author: 2026-09-25 / Codex / Status: CHANGES REQUESTED

## Summary

订阅认证 + 房间进程 WebRTC 的方向可行，但本版还不能直接进入实施。四项 HIGH 问题分别涉及：解除静音的事件晚于音频、插话未清掉已入播放器的旧音频、现有朗读回执失去全部完成条件，以及同一 thread 重连时通知没有服务端 generation 标识。这些会直接影响句首播放、插话验收、Lead 回复朗读和断线恢复。

评审基线：工作树代码 HEAD `55bfdea8ca90e53cf7d917569aad484b2b59e389`；FLY-2884 上游证据固定于 `148e53fe0869e4a1d757a593003620eec34e301b`；Codex 协议核对本地 `rust-v0.156.1` / `rust-v0.157.0`。磁盘计划相对提交新增了 §9 Lead 同意记录及对应引用，已纳入评审，不再将声线、记忆拆分或试听归属作为待批准事项。

已读取 onboarding 文档、三个 probe JSONL、probe2.mjs、上游 bridge 原型及被改动接口的调用方。下文区分源码事实、已有探测事实和据此推导的设计风险。只执行了只读检查及已有 JSONL 的时序计算（成功退出）；未运行项目测试、新 live probe 或操作 529 房。当前环境禁止执行 `ps`，因此没有现场进程环境验证，也未读取凭据内容。本次仅写本反馈文件。

路径约定：`plan.md`、`evidence/...` 指 `engineering/doc/FLY-2885-webrtc-voice-connection/` 内文件；`C156:` 指 `/Users/xiaorongli/Dev/codex-oss` 的 `rust-v0.156.1` 固定版本源码。

## What's Good (Keep)

- 显式钉住 `version: v3`、模型、声线，并由 SDP 和 WebRTC 连通共同决定可用，符合这条传输路径的实际需求；现有源码和短探测支持先保持 0.156.1，无需为本单升级舰队。
- 保留现有 PCM 上行、单说话人归属和 pre-roll，只替换传输末端，范围合理。默认门延迟确为 24 帧；当前插话确实走换代；单房间用户归属也有实际实现，计划没有凭空假设这些现状。证据：`packages/voice-codex/src/pipeline/UplinkSpeechGate.ts:129-150`、`packages/voice-codex/src/codex/CodexVoiceBackend.ts:307-339,480-502`。
- 临时 home 只链接明确的订阅凭据源、不执行 login/logout，并保留子进程环境白名单，是合适的边界。应保留删除 home 不损伤凭据源的测试，以及认证/额度失败时不换模型或引擎的规则。
- `liveVoice` 与旧引擎声线分离、共享房间选项默认维持 PCM、记忆确定性拆分且超预算拒绝，均应保留。不要为了修复以下问题引入历史回放、多人混音或新的通用进程监管框架。

## Issues & Recommendations

1. **HIGH — T5 把迟到的文本事件当作新回答的音频起点，会吞掉新回答句首；超时解除还会重新放出旧回答。**

   **证据：** `plan.md:117-125` 规定等新 assistant `turn.created` 才解除静音，并将此前每个 RTP 包替换为静音。已有 probe-2 在 `7845.2 ms` 收到首个有声包，直到 `8760.5 ms` 才收到 assistant `turn.created`，相差 **915.3 ms**；probe-3 对应为 `8321.8 / 9289.7 ms`，相差 **967.9 ms**。见 `evidence/probe-run2-prompt48kb.jsonl:17-19`、`evidence/probe-run3-initialitems.jsonl:18-20`。这是普通回答探测，并非已经执行过插话测试；但它直接证明该事件不是即时音频边界。

   **影响：** 将已观测到的事件顺序用于 Muted 状态，新回答开始后的近一秒也会被消音，破坏句首完整性并拉长实际可听延迟。`plan.md:118-119` 的 2 秒/15 秒解除条件不能证明旧回答已结束；转写迟到、缺失或用户长时间讲话时，会把旧句重新放出来。`plan.md:125` 仅在本代从未见过任何 turn 事件时降级，也没有覆盖“前几轮正常，当前轮缺事件”。这些是播放控制问题，不能全部归入 §8 的模型措辞边界。

   **建议：** 在实施前确定并用证据验证旧/新音频的划分与解除协议。若依赖迟到事件，需要明确如何保留新回答头帧及其延迟代价；不能仅改一个等待时长。缺失事件的处理应逐次插话生效，超时不能自动授权播放仍未判清归属的旧音频；无法安全恢复时可以有界地结束本场。增加音频先于事件约 1 秒、当前轮事件缺失、转写延迟超过 2 秒、用户讲话超过 15 秒的测试，并验证首句完整与旧句不恢复。

2. **HIGH — T4/T5 只替换未来 RTP，未迁移已有的播放器清队列契约。**

   **证据：** `plan.md:102-105,123` 允许流中保留至多 25 个包，并用同一个资源持续播放；静音定义仅替换后续收到的包。当前 `packages/voice-codex/src/discord-room.ts:379-380` 的 `cancelAllSpeech()` 只调用 `mouth`。T4 关闭 `WaitingMouth` 后，这条调用不能清理新的 Opus 流。现有 `packages/voice-codex/src/audio.ts:377-392` 专门通过替换资源、销毁旧流清掉播放器已有音频；`packages/voice-codex/src/__tests__/codex-room.test.ts:851-928` 验证的也是实际消费到的帧，而非 cancel 回调次数。

   **影响：** 进入 Muted 后，之前入流的旧回答仍会播放。仅应用层允许的积压就可达 500 ms，另有门判定和播放器缓冲；当前方案无法由“未来包变静音”推出立即本地截断或房内 ≤1 秒停止。换代时也可能播放旧代残留。

   **建议：** 明确 `OpusDownlink.mute/cancel/close` 对应用队列及播放器资源的同步处置，接入 `DiscordVoiceRoom.cancelAllSpeech()`；插话、换代和失去 lease 均需停止旧输出。可以复用现有替换资源的做法，不必增加一套队列框架。同时迁移 `WaitingMouth` 的 lease 检查（`audio.ts:395-402`）。测试在 10/25 包积压、播放器已取走部分帧时插话，断言此后消费不到旧回答，随后新回答首包正常播放。

3. **HIGH — T4 移除逐 item 输出后，`CodexProofSpeaker` 没有可执行的 v3 回执方案。**

   **证据：** `plan.md:105` 删除 `openAudio` 逐项输出；`plan.md:229,232` 仅声称部分朗读变成 `unconfirmed`、绑定存在兜底，却没有相应改动契约。当前 `packages/voice-codex/src/codex/CodexProofSpeaker.ts:154-208` 必须先绑定 assistant item id，再接收同 id 的最终转写和播放提交；`packages/voice-codex/src/codex/CodexVoiceBackend.ts:797-825` 从逐项 `output.done` 唯一地提供这条播放提交路径。固定版本的 app-server 转写只含 thread、role 和文本，不含 item id（`C156:codex-rs/app-server/src/bespoke_event_handling.rs:515-560`）；当前 transport 的 assistant id 又依赖 `itemAdded` 更新的 `lastItemByRole`（`packages/voice-codex/src/codex/RealtimeTransport.ts:488-531,730-753`）。

   **影响：** 照目前列出的改动执行，旧回执完成条件消失；这不仅是模型偶尔改写导致无法逐字确认。没有新绑定和播放完成路径时，请求会等待默认 30 秒，返回 `speech_proof_timeout`、`transport: none`（`CodexProofSpeaker.ts:11,308-333`），前端据此返回 `failed`，不是计划所描述的普通 `unconfirmed`（`packages/voice-codex/src/codex/CodexRoomFrontend.ts:131-143`）。Lead 回复朗读与后续分块会受影响。

   **建议：** 把 `CodexProofSpeaker.ts` 明确列入任务，规定请求/分块/generation 与 v3 turn 的绑定依据、何时能宣称音频已提交、何时只能给出未知或中断。不能把任意一次能量活动、时间邻近或 appendSpeech RPC 成功当成该请求已播放的证据。说明 mute、trim、换代、丢失 turn 事件和迟到旧转写如何结算；不能证明逐字时保留诚实的未确认结果。补入现有 `packages/voice-codex/src/__tests__/codex-speak.test.ts`，覆盖正常朗读、多块、插话及无法关联的回执。

4. **HIGH — T7 的“旧代所有回调已有 generation 隔离”不成立；忽略 stop 失败后重开同一 thread 有串代窗口。**

   **证据：** `plan.md:154` 忽略旧代 stop 错误后继续开新代。现有 `packages/voice-codex/src/codex/RealtimeTransport.ts:261-267` 给同一 RPC 对象注册常驻监听；通知入口只检查 thread id（`:444-446`），`closed/error` 在 active 状态过滤之前处理（`:465-483`），`onError` 不带 generation（`:253`）。固定版本的 error/closed 通知确实只有 thread id 与 message/reason，没有 realtime generation（`C156:codex-rs/app-server/src/bespoke_event_handling.rs:619-636`）。现有 cancel 明确同时等待 stop 响应和 closed 通知（`RealtimeTransport.ts:423-434`）。错误的下游当前直接终结会话（`packages/voice-codex/src/codex/CodexVoiceBackend.ts:678-694`、`CodexRoomFrontend.ts:197-199`）。

   **影响：** 旧 stop 超时或错误后，新 transport 已监听同一 thread，随后到达的旧 closed/error 可被新 opening 当成自己的失败；旧监听也会继续处理新代 error。本地给回调填新 generation 无法证明收到的通知属于新代。另有 20 秒重连总超时与 offer/answer 的异步步骤，计划尚未规定超时后如何取消仍在进行的操作并关闭临时腿。

   **建议：** 写清同一 thread 复用所需的可观测关闭屏障，保留关闭确认；无法确认旧会话结束时走干净结束，不能忽略后继续复用。退休监听需要解除或统一路由，error 与 closed 都要受生命周期控制；lost/error/closed 合并成一次换代。新腿从创建起就归当前尝试持有，超时/关闭要取消后续启动、释放临时腿，不能仅用 Promise 超时拒绝。增加 stop 超时、迟到 closed/error/SDP、双重故障通知及 ICE/answer 等待中关闭的定向测试。

5. **MEDIUM — orphan 清扫缺少 owner 写入顺序、PID 获取接口和确认退出后的删除条件。**

   **证据：** `plan.md:159` 只说打开时写包含 `childPid` 的 owner，再终止匹配进程并删 root。当前 `packages/voice-codex/src/codex/CodexVoiceContainer.ts:55-75` 的进程接口没有 PID；真实 spawn 位于 `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1442-1489`，返回接口也不暴露 PID。`packages/teamlead/src/lead-backends/codex/CodexLeadProcess.ts:315-335` 在 spawn 后还会等待 initialize，因此在 `start()` 完成后才写 owner 会留下未记录阶段。守护进程已有 root 生命周期锁（`packages/voice-codex/src/cli.ts:177-207`），清扫应明确位于获得此锁之后。

   **影响：** daemon 在 spawn 与记录之间退出、owner 部分写入、子进程已经消失、TERM 尚未退出等情况都没有确定结果。按“判不准就不动”，某些空 root 永久遗留；若只发送信号就删除 root，又会丢失还活着进程的清扫依据。

   **建议：** 给出最小生命周期表：创建 root/准备记录 → spawn 时取得身份 → 原子发布 owner → 确认子进程退出 → 删除 root；说明 spawn 与持久化之间仍存在的窗口如何处理。仅为 voice 暴露所需的 PID/退出观察接口，列明实际改动文件。区分已证明进程不存在和身份无法判断，明确不完整 owner 的处置；复用已有 TERM→KILL 和退出确认，不要新增通用 supervisor。测试在这些阶段中断及陈旧 PID/已退出子进程。

6. **MEDIUM — T9 未规定缺失 `liveVoice` 的旧投影如何迁移，影响面包含旧引擎恢复。**

   **证据：** `plan.md:171` 要求投影解析校验新枚举，但没有规定旧磁盘/HTTP 投影缺字段的行为。`packages/voice-codex/src/projection.ts:14-53` 是共享解析器；所有新会话均调用它（`packages/voice-codex/src/cli.ts:340-346`），恢复也调用它，解析失败会将待恢复 journal 标为 abandoned（`packages/voice-codex/src/recovery.ts:12-23,39-59`）。现存投影只有 `realtimeVoice`。

   **影响：** 这是尚未闭合的迁移契约，而非声称实现已经写错：如果照现有 `realtimeVoice` 的必填校验方式新增字段，升级后旧引擎的历史投影也会拒绝恢复，与“不影响 openai-realtime”冲突。

   **建议：** 明确兼容没有新字段的既存投影，并把已批准的 `cove` 缺省放在正确的规范化/引擎消费边界；显式非法值仍拒绝，也不回退到 `realtimeVoice`。除 projection 测试外，增加缺少 liveVoice 的旧引擎 `session-state.test.ts` / `recovery.test.ts` 夹具，验证恢复行为不变。

7. **MEDIUM — T10 仅改 wrapper 的 key 检查，仍会把 `.env` 中的 API key 传入 voice 进程。**

   **证据：** `scripts/flywheel-voice-wrapper.sh:59-67` 使用 `set -a` 加载整个环境文件。`plan.md:177` 只改变后面的准入检查；`:176` 到 Node 的配置加载阶段才删除变量。这不能推出 `plan.md:196` 声称的 codex 路径“不读、不传 key”，也没有覆盖正式 wrapper 与 QA 专用启动器的差异。

   **影响：** 即使最终 app-server 白名单正确，正式 voice 进程仍会带着 key 被启动。QA 启动器不注入 key 的证据不能替代这个入口的环境验证。

   **建议：** 在 codex 分支启动 Node 之前移除 `OPENAI_API_KEY` / `CODEX_API_KEY`，并用捕获 exec 子进程环境的 wrapper 测试验证；旧引擎分支继续正常读取、传递并校验自己的 key。若共享 `.env` 仍整体加载，应将“不读任何环节”的文字收窄为实际保证的“不要求、不使用、不传给语音及其 Codex 子进程”，不要留下与实现冲突的负向断言。

8. **MEDIUM — QA-3a 的恢复成功状态与清理断言互相冲突，回归清单也漏了直接相关的来源排除测试。**

   **证据：** `plan.md:217` 要求断腿后恢复、继续问答，随后却要求 Bridge 终态、所有 container 为空、session-state 无活动会话。成功恢复仍然需要当前 container 和活动会话。`plan.md:202-211` 没有列出来源排除的现有验证：`packages/voice-codex/src/__tests__/codex-handoff-transcript.test.ts:148-182` 和 `packages/teamlead/src/bridge/__tests__/voice-session-poller.test.ts:196-284`。此外 T8 写的 `bridge/__tests__/voice-session-context*.test.ts` 路径不对，实际文件为 `packages/teamlead/src/__tests__/voice-session-context.test.ts`。

   **影响：** QA-3a 按原文无法同时通过，或会把正确恢复判成残留；“无锁”也不能误要求仍运行的 daemon 放掉其合法 `voice.lock`。全局 `pgrep -f` 不能区分本次容器与舰队其他 Codex。声称 FLY-2799 三项全绿却没有执行来源排除的具体测试，证据不完整。

   **建议：** 将 QA-3a 分成恢复阶段（恰好一个当前代、当前 lease 合法、可继续问答、旧腿关闭）及获准结束本场后的清理阶段；QA-3b 直接检查终态。进程/目录检查绑定本次 root 和记录的子进程身份。补齐上述直接相关回归、问题 3/6 所列调用方测试并修正路径；保留不跑全套、不未经 Lead 允许拆房的边界。

9. **LOW — T3 的“v3 下 sdp 先到”与固定版本源码及本单探测不符。**

   **证据：** `plan.md:96` 作此断言；`C156:codex-rs/core/src/realtime_conversation.rs:1616-1637` 先发送 started，再发送 SDP。probe-2 为 started `2107.6 ms`、SDP `2107.9 ms`（`evidence/probe-run2-prompt48kb.jsonl:8-9`）；probe-3 也是同序（`evidence/probe-run3-initialitems.jsonl:9-10`）。

   **影响及建议：** 以 SDP + connected 作为媒体就绪条件可以保留，但理由不能建立在错误时序上。更正说明，明确收到 started 时仍校验 v3，并测试预期顺序及异步错误；不要因“started 不是必要条件”而忽略已收到的版本不匹配。

## Verdict

**CHANGES REQUESTED**

先闭合问题 1–4 的音频和生命周期契约，再补齐清扫、兼容、启动环境与验收细节即可重审。当前证据支持 WebRTC/订阅方案本身，但不足以支持本版关于完整句首、插话取消、朗读回执和安全换代的承诺。
