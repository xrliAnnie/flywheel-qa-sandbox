# Design Review — plan.md Part 2 (Round 2)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮已实质关闭 R1-1、R1-2、R1-4、R1-5：机器 loop 护栏、live/deferred hint 载体、正常 projector identity 输送及 effective-target 审计都已形成可实现且可验证的合同。R1-3 的 feedback 来源与 request/route fencing 也已改对，但 design 目标的真实 fresh-replacement 仍会在 dispatcher 的 predecessor/start-point 检查处失败，因此 E2 的完整矩阵尚不可构建。

## What's Good (Keep)

- loop schema 现在按 `loop_when` 区分语义：只有 `founder_feedback_kickback` 可省略 pair，`qa_fail`/`review_fail` 仍在两套通用 validator 中强制正整数 + `escalate`；再加非-founder 非法状态 fail-closed，正确保护了 custom manifest 与 frozen manifest 两侧。
- `FounderReworkHint` 贯穿 classifier verdict、`ApprovalSignal`、live writer 和 durable deferred row，并要求 rebind 原样重放；这覆盖了现有 held deferral 与 convergence park，不再把「给 QA 返工」静默降级为 implement。
- round alert 的 identity 改由真实 projector applied path 在事务前解析并传入受校验的 `WorkflowSourceEventInput`；resolver 失败不阻断 kickback，符合“alert-only、never block”的裁定。
- qa route revision 的白名单形态与 `StateStore.ts:32170-32197` 的历史 actor/新 attempt 计算相容；`source_feedback` 改写 effective target/attempt 后，审计也与实际 route 一致。
- replacement feedback 改从 fenced `rework_replacement:${requestId}` 读取 immutable request，而不是伪造 `successorExecutionId`；真实 materialization 测试要求和普通 dispatch 零变化边界都应保留。

## Issues & Recommendations

1. **[HIGH] design 目标的 fresh replacement 仍无法通过 dispatcher 的 predecessor/start-point 门，§15.8 的真实矩阵会在注入后、启动前失败。** `materializeWorkflowReworkReplacement` 会把新 execution 写进同一 design attempt，并追加 `execution_dead_rolled_back`/新 route revision（`StateStore.ts:22191-22271`）。dispatcher 虽可沿 rollback 从新 execution 找回旧 design execution，但根 design 没有入边，所以 `edge_traversed.successorExecutionId` 查询找不到 transition（`workflow-engine-dispatcher.ts:2120-2151`）；原始 start reservation 又是 attempt 1，而 rework design 是新 attempt，`startRetryExecutionId` 也不成立（`:2153-2167`）。因此 `isRootDesignFirstAttempt` 为 false，`:2199-2205` 必然抛 `engine_predecessor_unavailable`。建议把 §13.3 扩成一个在 predecessor 解析前建立的、request/route/delivery/intent 全绑定的 replacement context：除提供 `founder_feedback_verbatim` 外，也为 phase replacement 提供受校验的 `request.base_revision` 作为 rework start point（coordinator wake 已在 `workflow-rework-coordinator.ts:391-394` 使用同一锚），或明确另一条等价的 durable start-point authority。补一条非空洞测试：根 design 无入边、旧 actor 判死、真实 materialize replacement，断言 dispatcher 以 base revision 启动且收到逐字 feedback；qa replacement 对照继续保留。

## Verdict

CHANGES REQUESTED
