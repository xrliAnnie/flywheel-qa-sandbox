# Design Review — plan.md (Round 3)

Date: 2026-07-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

R3 已实质关闭 Round 2 的全部 4 项：shutdown 具备不可跳过的收尸阶段，背压与 payload 大小解耦，/eleven finalizer/no-show/retry 有了明确路径，barge-in/token/export/dispose 合同也已统一。当前只剩 2 个 fail-closed 语义需要补齐：landing deadline 必须阻止 late completion 继续产生外部副作用，以及 buffered context 必须以 terminal success 而非 stdin drain 作为消费确认边界。

## What's Good (Keep)

- R2 #1 的核心已关闭：`plan.md:201-216` 把 shutdown 分成停止 intake、有界 landing、不可跳过的并行 `closeAll()`，并要求 hard timer 先 `forceKillAll()` 再退出；summary/Linear 永挂与多 child 的 fake-timer 测试也已进入计划。
- R2 #2 的大 payload/backpressure 问题已关闭：`plan.md:154-162` 明确单条 payload 分块、遵循 Node drain，64KB 只计算 drain 期间尚未交给 Writable 的新增应用队列；单个大 frame 不再误判 wedged。
- `appendContext()` 现在有 256KB 明确上限和 `{accepted}` 回压，Feed adapter 在拒绝时 HOLD cursor，context-drained 后 retry（`plan.md:101-111,258-263`），方向与 FeedPipeline 的无损/可见 lag 语义一致。
- R2 #3 的 /eleven 生命周期主体已关闭：stop CAS、停止 ears/shim、关闭 WS、同步停嘴、interrupt barrier、journal freeze、reason 分支、landing、finally close/release 的顺序完整（`plan.md:287-300`）。
- no-show 已绑定现有 /gemini presence classification + initial probe，并与 10 分钟 assemble window 对齐；retry 也获得 durable pending 文件和 boot reconciliation，而不是只写一句“可重跑”（`plan.md:301-308`）。
- R2 #4a–d 均已准确修复：mouth 同 tick 先停、token env 两端硬钉一致、public `src/index.ts` 纳入 Phase A、dispose 拆成 EOF grace 与 TERM grace（`plan.md:89-90,112-115,264-267,317-323,340-343`）。
- Phase A/B/C 边界、byte-compat 哨兵和最终 completion gate 保持清晰，没有因本轮修复扩大 /gemini 产品 scope。

## Issues & Recommendations

1. **[BLOCKER] 8 秒 landing deadline 目前仍只是“停止等待”，没有定义 cancellation/late-result fence；超时任务可能随后继续写 Linear、写 receipt 或报成功。** Plan `plan.md:204-216` 要求 deadline 后“不再等模型或 Linear”、unfinished landing 不报成功，但当前调用面不支持这个保证：`BridgeLinearClient.request()` 的 fetch 没有 AbortSignal/timeout（FLY-545 `BridgeLinearClient.ts:109-124`），现有 `AssistantLanding.run()` 会在每个 await 返回后继续写 receipt、发下一段 transcript、close issue 并返回 success（main `AssistantLanding.ts:199-308`）。如果实现只用 Promise.race，slow-but-eventually-success 的 summary/comment 会在 Phase 3 甚至进程重启后继续推进；若 comment 已被服务端提交但 client 在 deadline 时放弃，boot reconciliation 又可能因 receipt 尚未写而重复发 summary。永不 resolve 的 fake 不能覆盖这个 unknown-outcome 窗口。**建议修复：**给 landing budget 一个 AbortController + generation/finalizing token；resident summary 和 BridgeLinearClient fetch 都接 signal，AssistantLanding 在每个 await/每个外部写之前后检查 deadline，aborted 后绝不再发下一步、写 success receipt 或渲染成功 TIV。deadline 路径只原子写 durable pending state，不再尝试第二次 Linear。pending 状态需区分 `not_started` 与 `mutation_outcome_unknown`；对已发出但结果未知的 comment/close，startup reconciliation 必须先用 deterministic marker/idempotency key 确认是否已落，再决定续发，不能盲重试。补两条测试：comment 在 deadline 后才 resolve 不得 late-success/close；comment 服务端已提交但 client 超时/重启时 reconciliation 不重复 comment。

2. **[BLOCKER] context 的“已消费”确认点仍放在 stdin drain，mid-turn crash/interrupt 后 Feed cursor 已前移但事实可能没有进入可恢复 session；同时 `context-drained` 不在声明的事件 union。** `plan.md:103-111` 写真实轮把缓存写入/drain 成功后即发 context-drained，而 resident 的 crash 合同明确允许 frame 已写、轮中 child 随后退出并让 respond 抛错（`:131-138`）。Writable drain 只证明 bytes 交给子进程，不证明 Claude terminal result 已确认该 turn、session persistence 已保存 context。若此时清缓存并触发 Feed retry，已 accepted 的 entries 的 cursor 早已前移，fresh/resume 失败时它们无法重注入，违背“事实绝不静默丢”。此外 `ResidentBrainEvent` 目前只列 state/lifetime-expiry/respawned（`:96-99`），但 API/测试/545 wiring 都依赖未声明的 `context-drained`（`:110,227,261`），计划自身类型不一致；manager 的伪接口 `:166-169` 也遗漏后文硬依赖的 `forceKillAll()`。**建议修复：**pending context 在 wire drain 后仍保留为当前 turn 的 unacked snapshot；只有正常 terminal result 才清除并 emit `{type:"context-drained"}`。interrupted/error/crash/timeout 一律保留供下一真实 turn 重注入；给每个 context entry 带稳定 seq/id，使“服务端其实已收但本地未 ack”时的保守重投可识别去重（宁可显式重复，不可静默丢）。把 `context-drained` 加入 ResidentBrainEvent，把 `forceKillAll(): void` 加入 manager 公共合同，并补 frame 已 drain→SIGKILL/interrupt→下一轮仍携带同 context→正常 result 后才 retry/cursor catch-up 的测试。

## Verdict

CHANGES REQUESTED — address items above
