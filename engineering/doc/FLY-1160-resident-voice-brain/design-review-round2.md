# Design Review — plan.md (Round 2)

Date: 2026-07-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的 8 项问题均已被实质采纳：r2 修正了 Gemini 模态、final-echo/process seam、turn 状态机、/glaw silent context 与文本嘴、BrainPort 边界、/eleven 生命周期、安全 flags 和跨分支完成门，核心架构现在可行且明显更接近可实施状态。仍有 4 个运行时合同需要在实现前闭合，主要集中在 daemon 强制退出时的收尸保证、长会 context/backpressure、/eleven finalizer 的 quiesce/no-show/retry，以及几处会直接改变行为的接口时序。

## What's Good (Keep)

- R1 #1 已正确关闭：`plan.md:44-51,210-213` 保留当前真机支持的 Gemini AUDIO 模态，只消费 input transcription，并明确丢弃 Gemini response audio/output transcript；新增三条回归哨兵与 FLY-545 证据一致。
- R1 #2 已正确关闭：共享 parser 标注 event kind，resident 采用 delta-only + no-delta final fallback（`plan.md:57-66`）；真实 init→delta→assistant-final→result 序列进入测试。ProcessHandle 也不再假设 one-shot seam 足以承载常驻 stdin。
- R1 #3 已正确关闭：turnId、single-flight、interrupt terminal barrier、3s/2s grace、非零 watchdog、轮中 crash 不自动 replay、首轮无 sessionId fallback、lifetime 只发事件等语义均写清（`plan.md:111-136`），避免了半句双播和 core 越权 landing。
- R1 #4 已正确关闭：FeedPipeline 保持一等合同，resident 增加 buffered `appendContext()`；PCM-only GeminiTurnMouth 被明确替换为句级、串行、可 stop 的文本嘴（`plan.md:214-225`）。
- R1 #5/#7 已正确关闭：BrainPort 默认关闭、全端点鉴权、loopback、有限 body、稳定错误码、disconnect/supersede interrupt、health 不泄 key；安全 CLI flags 内置不可覆盖，free-form extraArgs 已移除，容量错误码也准确。
- R1 #6 已大体关闭：/eleven Lead persona、daemon UUID 先 bind、metadata 一致性 gate、五路 exactly-once finalizer、journal-direct degradation 和无条件 brain/slot teardown 都进入合同（`plan.md:234-256`）。
- R1 #8 已正确关闭：Phase A 文件面、显式 post-A rebase、两分支 must-preserve 列表、逐分支验证及“A 只是 milestone，不结单”均已写入（`plan.md:258-274`）。
- QA 增加了 final-echo 真链复验、mid-turn SIGKILL、两条消费者真实落地与零孤儿证据；延迟口径仍保持克制。

## Issues & Recommendations

1. **[BLOCKER] daemon 的现有 10s/12s 强制退出预算仍可跳过 minutes finalizer 和 `closeAll()`，与“零孤儿”铁律冲突。** R2 要求 SIGTERM/SIGINT 进入 `closeAll()`（`plan.md:178-182`），同时把 daemon shutdown 纳入 /eleven 的完整 finalizer（`:245-251`）。但 545/1006 当前 `cli.ts` 都把 runtime teardown 放在 10 秒 `Promise.race` 内，`main()` 在 runtime.close resolve 后直接 `process.exit(0)`，12 秒再硬退（FLY-545 `cli.ts:480-507`；FLY-1006 `cli.ts:228-256`）。同一 session 生成纪要再写 Linear 本身就可能超过 10 秒；race 超时不会取消内部 promise，随后 `process.exit` 可在 resident child 尚未 SIGKILL、receipt 尚未写完时退出，造成孤儿或假成功。**建议修复：**把 shutdown 写成明确的两阶段预算合同：先停止接新请求/新 turn、立即停嘴并冻结 journal；active meeting 的 artifact landing 只能使用独立且有界的 budget（超时即 journal-direct degraded/留 open，不再等待模型或 Linear）；然后在不可跳过的 `finally` 中并行 `manager.closeAll()`，确认每个 PID exit 后 runtime.close 才可 resolve。外层 hard timer 触发时也必须先调用同步可达的 `forceKillAll(SIGKILL)` 再 `process.exit(1)`，不能只是离开 Promise.race。给“summary 永挂”“Linear 永挂”“4 个 child 同时退出”加 fake-timer 测试，断言 deadline 后所有 PID 均退出且未完成 landing 不报成功。

2. **[BLOCKER] `appendContext()` 的无界缓存与 64KB write-queue 熔断会在长 multi-lead 会中形成确定性的 respawn loop，FeedPipeline cursor 也没有恢复触发。** Plan `:102-104,219-222` 让非 addressed Lead 的所有 feed 先在内存缓存，等它下一次真实 turn 才一次写入；与此同时 `:140-145` 把 64KB 以上 pending write 判成 wedged 并 kill+respawn。Node stdin 的 `write(false)` 是正常 highWaterMark 背压，不等于 child 卡死；一个长会累积的单条 context+turn frame 本身就可能超过 64KB。更严重的是 `appendContext(): void` 一旦返回，现有 FeedPipeline cursor 就前移；若实现丢弃/截断缓存，事实会静默丢失；若在满时 throw，下一次真实 respond 消费缓存后也没有合同要求调用 `feed.retry()`，cursor 会永久停在旧 entry。**建议修复：**把“单条 wire payload 大小”“Writable 内部 buffer”“尚未写出的应用队列”分开：大 frame 分块写，`write(false)` 后等待 drain，64KB cap 只计算 drain 期间又到达、尚未交给 Writable 的后续数据，不能按当前 payload 大小杀进程。为 pending context 定义明确 budget 和无损/显式降级策略；推荐 `appendContext(): {accepted:boolean}` 或满时 throw 保持 Feed cursor，并在真实 turn 成功 drain context 后发 `context-drained`/调用 `feed.retry()`。若必须压缩旧 context，要保留带时间戳的 durable journal + 明确 truncation/summary marker，绝不静默丢。补一个 >64KB 非 addressed backlog→handoff 的测试，证明无 respawn loop、cursor 最终追平且 context 要么完整到达、要么可见降级。

3. **[BLOCKER] /eleven 的 exactly-once finalizer 仍缺“先静默链路再做终轮”的顺序、no-show 信号来源和真正可调用的 retry 入口。** 当前 ElevenSession 一 connect 就从 invoked 进 live，只订阅 ears speaking/frame/barge-in；没有 founder voice-presence/no-show seam（`ElevenSession.ts:86-113,143-195`）。R2 虽把 no-show 列为第五路（`plan.md:245-251`），却没指定复用 `assistant/wiring.ts` 的 founder presence、初始 presence probe、timer 值或 timer 解除条件，因此这条退出路径目前不可实现。manual stop/WS close 又可能发生在 shim 正通过 BrainPort 跑一个 turn 时；若 finalizer 直接“freeze journal → 同 brain 终轮”，旧请求的 disconnect-interrupt/supersede 可与 minutes turn 互相取消。最后，comment 失败后 session/brain 被无条件关闭且 activeSession 清空；receipt 只能保证再次调用 landing 时幂等，但计划没有 `/eleven land <issue>`、startup reconciler 或 durable retry job，故“可重跑续发”没有调用入口。**建议修复：**规定 finalizer 的严格顺序：CAS 进入 finalizing → 停止接收 ears/新 shim turn并关闭 WS → 立即 stop mouth/cue → interrupt 当前 brain turn 并 await barrier → 冻结 journal → 按 reason 分支生成 minutes/abort receipt → landing → finally close brain/slot。明确 no-show 复用哪一个 voiceState/presence adapter、初始缓存探测、超时值及 founder join 后 disarm；start failure 不跑 minutes，只走 abort-close。选择一个可执行 retry 面（例如 durable `pending-landing.json` + daemon startup reconciliation，或明确的 `/eleven land <issue>`），并说明如何从 journal 重建 degraded minutes而不需要已关闭的 brain。测试 active-turn manual stop、WS close during turn、founder already present、真正 no-show、comment/close hang 及进程重启后的 retry。

4. **[HIGH] 四处小合同仍互相矛盾，按字面实现会破坏 barge-in、配置或公共导出。** (a) `plan.md:223-225` 写 `await brain.interrupt() + mouth.stop()`；现有 mouth 的红线是 `stop()` 同步清音（`LeadSpeaker.ts:139-150`），若先等最多 3 秒 barrier，founder barge-in 后仍会听到旧回答。应明确 `mouth.stop()` **先同步执行**，再异步 await interrupt barrier，且下一 brain turn 才等待该 barrier。(b) daemon 支持任意 `huddle.brain.tokenEnv`（`:164-167,280`），shim 却硬读 `FLYWHEEL_BRAIN_PORT_TOKEN`（`:252-255,283`）；自定义 tokenEnv 会使两端拿不同 secret。要么把 tokenEnv 固定并验证只能是该名字，要么给 shim 一个 token-env-name 配置并使用同一解析值。(c) Phase A “精确文件清单”遗漏 `packages/voice-core/src/index.ts`；当前 public package surface 显式逐项导出 brain/parser，若不改 index，545/1006 无法从 `flywheel-voice-core` 导入新组件，同时旧 `parseStreamLine` re-export 也会断。(d) `killGraceMs` 在 options 中定义为 SIGTERM→SIGKILL（`:89`），`dispose()` 注释却写 EOF→killGrace→SIGTERM→SIGKILL（`:106`），缺少 EOF graceful wait 与 TERM wait 两段的准确预算。**建议修复：**把这四项逐字统一，并各加一个哨兵：barge-in 当 tick 即 stop、custom tokenEnv 双端一致、package-root import 编译通过、EOF 正常退/EOF 不退后 TERM/TERM 不退后 KILL 的 fake-timer 顺序。

## Verdict

CHANGES REQUESTED — address items above
