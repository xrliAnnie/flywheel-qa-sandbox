VERDICT: CHANGES_REQUESTED

## Round-1 findings disposition

- H1 -> RESOLVED — `plan.md` §1、§4 分支 B 与 :85 已明确撤回“平台 AND 本地 Silero”，承认 `interrupt_response:true` 发生后本地只能处置播放队列、不能否决服务端取消。
- H2 -> RESOLVED — `research.md` §1.4 现已把 `speech_started.item_id`（future user item）与 `OutputAudioState.item_id`（assistant item）的恒不相等、`audio_end_ms` 仅累加 Codex 已收帧时长、以及 Raya 无真实播放游标三件事写清；`plan.md` D5 也将其列为未闭环缺口。
- H3 -> RESOLVED — `research.md` §4/§4.1 与 `plan.md` §2 已加入 LiveKit adaptive 这条第四路线，撤回“成熟栈只剩一个阈值”的归纳，并因 Raya 没有 aligned transcripts 将其排除出当前候选。
- M1 -> RESOLVED — `research.md` §3.2 将 `>=1.2s` 降为未实测推断，改用 `speechOnsetAt -> audibleStopAt` 的统一尺子并增加 P3；`plan.md` R4 也不再拿 final 延迟冒充 partial 下界。
- M2 -> RESOLVED — `plan.md` §6 :108 与 `research.md` P1(d) 已承认平台链路更靠后，把谁在绝对时间先触发留给同基准探针，而非继续作因果断言。
- M3 -> RESOLVED — `research.md` §1.2 已严格拆开“今天不可达”（源码/二进制已证）与“是否适合打断”（未证），`plan.md` D4 也不再以社区报告否定 `semantic_vad`。

## New findings

### HIGH — `plan.md` §1/§4 没有真正回答“FLY-2178 的检测层留还是删”，且分支 C 使用了错误的分支条件

`plan.md:71` 说“不整层删”，却把它改称“止声执行器 + 恢复信号源”；按 `research.md` §2 自己的拆分，前者是 `Downlink.interruptVoice()`，后者是 `InboxReader`/`Speaker` 的恢复状态机，二者都不是 `BargeGate` + WebRTC/Silero 这层**检测器**。在分支 A/B 中，R1 的平台事件才是触发信号，当前文字没有给本地检测器留下一个经证据证明的决策职责；保留 R2/R5 不能推出“检测层不删”。反过来，分支 C 仅因 `speech_started` 通知“不到达/不稳定”就“退回本地为主”也不成立：通知通道失效不等于 OpenAI 停止按 `interrupt_response:true` 取消 response，本地仍可能没有否决权。决策树必须分别以“服务端是否实际取消”和“通知是否可靠”为条件，并对实际检测器逐支给出留/删答案；否则 founder 会被引导去保留一个文档实际已不再依赖的检测层。

### HIGH — `plan.md` R6 把“可关闭自动取消”写成了“把取消决定权还给我们”，但缺少本地判定后的服务端 cancel 控制面

`plan.md:63-65` 只要求暴露 `interrupt_response`、`threshold`、`prefix_padding_ms`，随后断言这会把“掐不掐”的决定权还给 Raya。官方合同恰好相反：`interrupt_response:false` 时正在进行的 response 会继续，而且 response 尚在进行时自动 `create_response` 可能失败。当前 Codex `RealtimeOutboundMessage` 只有 `response.create`、没有 `response.cancel`；`ThreadRealtimeStartParams` 与 Raya `RealtimeTransport` 也只有 start/appendAudio/appendText/appendSpeech，没有取消正在生成 response 的请求。调 threshold 只能继续让平台当一个可调的判官；若要让本地检测器当判官，上游请求还必须包含一个经过本地确认后可调用的 realtime response cancel（并与 D5 的 truncate/听感上下文控制区分）。按现稿执行 R6 会关闭唯一现成的服务端取消，却没有替代 true-barge 的生成终止路径，因此“唯一治本杠杆”的结论不成立。

### HIGH — `plan.md` R5/§4/D1-D3 把 inbox 重注机制过度泛化成可兜住任意平台误掐的“原位续念”

`plan.md:58-61`、`:90`、`:98-100` 将 R5 升为最高优先级、分支 B 下“唯一防线”，并用“从原位置续念”描述能力；但同稿 D5 与 `research.md` §1.4/§5.1 已承认系统没有可靠的实际播放位置。Raya 快照也显示 B3 是窄的 inbox 机制：`Speaker.suspendInbox()` 只接受 `inbox:` job；`InboxReader.settleFalseTrigger()` 只把条目置为 `front/resumeReady`，不推进 `resumeFrom`，所以当前假触发重注通常从已知条目开头重念；普通 realtime 对话既没有可重注的源文本，也没有 response resume handle。故 R5 可以作为“已知 inbox 条目可重新注入”的恢复策略，却不能声称对平台取消的任意 Raya 发言做原位恢复，更不能据此把普通对话的误掐风险写成已被唯一防线兜住。该范围必须在最高优先级建议和 founder 决策树中显式收窄。
