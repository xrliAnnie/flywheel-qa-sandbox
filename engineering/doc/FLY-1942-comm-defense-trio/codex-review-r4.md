# Design Review — plan.md (Round 4)

Date: 2026-09-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

在 Lead 限定的两个 Round 3 HIGH 中，R3 #2 已关闭：v4 对未引用 heredoc 的 expansion edge 与 `eval` argv 都给出了正确合同和 RED 用例。R3 #1 只关闭了“失败后继续运行”的部分，但现有生产启动顺序会在 restore 尝试之前启动并 drain gateway，因此仍不能保证空 registry 从未接收流量。

## What's Good (Keep)

- **R3 #2 已关闭。** heredoc 预处理现在保留 delimiter 是否 quoted；未引用 body 无论 consumer 都先扫描 `$()`、反引号和 process substitution，引用 body 只在代码消费者下递归（`engineering/doc/FLY-1942-comm-defense-trio/plan.md:238`）。`eval` 也明确改为拼接全部 argv 后递归，而非错误地按 stdin 建模（`:244`）。
- 两个原始反例已加入 MUST_BLOCK，RED-first 清单和完整门禁同步从 84+6/51+6 更新为 84+8/51+6（`plan.md:253-257,305,321`），足以防止实现时把这两条语义再次丢掉。
- **R3 #1 的磁盘分支本身正确。** missing ledger 写失败时空启动没有旧数据可丢；non-missing ledger 写失败时保留原文件并抛错，避免 reply-in-thread wiring 自己从空状态继续 mutation（`plan.md:211`）。

## Issues & Recommendations

1. **HIGH — R3 #1 尚未关闭：计划引用的现有 runtime 顺序会在 restore 失败前接收流量，“随后 stop”并不等于“gateway 未启动”。** v4 声称 non-missing restore persist 失败时“不带着空内存接流量”，并要求测试断言 gateway 未启动（`plan.md:211,304`）；但两个现有 runtime 都先 `await gateway.start()`，之后才 `await replyInThread.start()`，失败时只是再 stop（`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1848-1855`；`packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts:821-829`）。`gateway.start()` 会安装 handler 并等待 inbound source 完整启动（`packages/teamlead/src/lead-backends/codex/CodexDiscordGateway.ts:182-188`），而 source 在有持久 cursor 时会在 `start()` 返回前立即 drain backlog（`packages/teamlead/src/lead-backends/codex/RestPollDiscordInboundSource.ts:168-197`）。ownership 又是在取得 socket 与 ingress lock 后才调用 gateway start（`packages/teamlead/src/lead-backends/codex/CodexDiscordRuntimeOwnership.ts:171-215`），所以 mailbox readiness 不会封住该窗口。一个 backlog 中的新 roundtable mention 可在 registry 仍为空时被 durable ingest；随后 restore persist 才失败并 stop gateway，已经接收或排队的 input 仍可能触发 `onTopicEngaged`，从空 registry 持久化 snapshot 并覆盖 A/B。建议把启动拆成明确的两阶段：① `replyInThread.restoreState()` 只做 parse → normalize → persist → commit，必须在 `gateway.start()` 前成功；② gateway 安装 handler并启动 source 后，再 `replyInThread.activateSource()` 执行 restored `addChannel`/discovery，从而保留现有“handler 先于 dynamic drain”合同。故障测试必须钉生产 wrapper 的调用顺序，并断言 non-missing restore persist 失败时 `gateway.start` 从未被调用，而不只是最终调用了 `gateway.stop`。

## Advisory (non-gating)

无。本轮按 Engineering Lead 裁定，仅确认上述两个 Round 3 HIGH，未扩展评审范围。

## Verdict

CHANGES REQUESTED — R3 #1 remains open; R3 #2 is closed
