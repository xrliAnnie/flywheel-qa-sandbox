# Design Review — plan.md Part 2 (Round 1)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Part 2 的主方向可构建：保留单条 founder loop、复用 route revision 改道、继续使用 durable outbox，均符合当前架构与 FLY-1466/FLY-1655 边界。但计划尚未覆盖四个会破坏 E1/E2 的生产链路：全局 schema 放宽会解除机器 loop 护栏，deferred reject 会丢失 target，fresh replacement 取不到 founder feedback，且每轮告警点目前拿不到 Lead identity；因此还不能进入实现。

## What's Good (Keep)

- 保留 `founder_gate → implement` 唯一 loop 边，再用现有 route-revision 层选择 design/implement/qa；这与 `StateStore.ts:30328-30342` 的 find-first 选边合同一致，避免改动 FLY-1765 核心转移机。
- 明确保留旧 frozen manifest 上的 founder-authority exemption，并继续要求 QA loop 为 `3/escalate`；旧 run 不因开始记录 `loop_iteration` 而突然 held 的兼容意图正确。
- 每轮 alert 使用包含 run/iteration 的稳定 uid，且强调 payload constancy、Lead-only、零新 timer/flag，符合 Part 1 的 outbox 幂等纪律与 FLY-1466。
- 测试计划覆盖真实 compiled `tpl_code`、同 head QA rework、新卡换代、纯批准回归及 operator target=qa，验收边界总体清楚。

## Issues & Recommendations

1. **[HIGH] “成对可选”被定义成所有 loop 都可无上限，实际会解除 QA/review 等机器自转护栏。** `workflow-template.ts:587-637` 与 `:1173-1229` 是通用 manifest validator，不只服务 `tpl_code`；按 §12.1 修改后，任意 `qa_fail`/`review_fail` loop 都可省略两键。§12.3 再加 `typeof loop.max_iterations === "number"` 守卫，会令这些非 founder loop 在运行时也永不 escalate，直接违反 §11“QA-FAIL cap 不动”。建议把语义约束写进两套 validator：只有 `loop_when === "founder_feedback_kickback"` 可缺席整对；`qa_fail`/`review_fail` 必须保留正整数 + `escalate`。engine 也应对意外的无界非-founder loop fail-closed，而不是把它解释为合法无限循环；补 custom manifest 阴性测试，而不只测 code menu。

2. **[HIGH] 计划中的 producer 并非所有 founder-feedback ingress 的 choke point，classifier target 也没有现成载体到达 writer。** 当前 `founder-ship-approval-classifier.ts:127-132` 的 reject verdict 只返回 reason，`text-approval-source.ts:113-134` 又只把 kind/reason 投成 `ApprovalSignal`，而 `approval-signal/types.ts:29-48` 根本没有 rework target 字段。更关键的是 held 窗口的 reject 会在 `founder-ship-approval-handler.ts:466-503` 被 durable defer，之后由 `deferred-approval.ts:626-666` 直接调用共享 writer；`FounderDeferredApproval`/`founder_deferred_approval` 目前只保存 decision 与原文，没有 target/hint。于是 founder 在 held 时说“给 QA 打返工”会在 rebind 后无 hint，静默回落 implement。建议定义一份共享、不可变的 `FounderReworkHint`：贯穿 classifier verdict → text signal → live writer，并把已解释的 target/scope/policy/interpretedBy/reason 与 deferred row 同事务持久化，rebind 时原样传给 `writeGateResponseAndRunPostWrite`。同时把 `text-approval-source.ts`、`approval-signal/types.ts`、`deferred-approval.ts` 和 deferred schema/migration 列入变更清单，并加 live/deferred 两条同文输入对照及 writer-call matrix 测试。

3. **[HIGH] §13.3 仅放宽 `node.type` 不能修好 fresh-dispatch；当前 rework transition 根本不会被该查询命中。** `commitWorkflowTransitionTx` 在 rework 时令 `successorExecutionId` 为 undefined（`StateStore.ts:30616-30621`），但 dispatcher 只通过 `edge_traversed.payload.successorExecutionId === intent.execution_id` 找 transition（`workflow-engine-dispatcher.ts:2122-2132`）。proven-dead fresh replacement 的 identity 实际在 side-effect reason `rework_replacement:${requestId}`（`StateStore.ts:22191-22209`、dispatcher `:2253-2257`），所以把 `node.type === "implement"` 改成 outcome 判断后，`transitionPayload` 仍是 undefined，design/qa/implement replacement 都收不到原文。“发现即修”不是可执行设计。建议明确实现：从 fenced `reworkReplacementRequestId` 读取 `workflow_rework_request.founder_feedback_verbatim`，并用 latest route 的 run/node/attempt/revision 对当前 intent 做绑定校验后注入；普通非-rework dispatch 保持现状。测试必须真实走 replacement materialization，不可伪造带 `successorExecutionId` 的 edge receipt。

4. **[HIGH] 每轮 alert 的 StateStore 事务点没有计划所称的 identity 输入。** projector 的 `resolveAlertIdentity` 目前只在 `applyWorkflowSourceEvent` 抛 terminal error 后用于 deadletter（`founder-approval-projector.ts:154-193`）；正常 applied path 在 `:143-151` 只传 source event 字段。对应的 `WorkflowSourceEventInput`（`StateStore.ts:41772-41779`）没有 `alertIdentity`，founder-feedback apply 在 `StateStore.ts:32149-32209` 调 transition 时也未传 identity。因此 §12.3 无法构造合法 `WorkflowEngineAlertPayload`。建议在计划中明确 producer-to-StateStore API：对可绑定的正常 founder event 在 projector apply 前解析一次 identity，并把它传入 `WorkflowSourceEventInput`（或等价的受校验参数），再由 apply site用于 round alert；测试从真实 projector drain 起步，证明第 4 轮产生含 leadId/leadResolution 的 outbox，而不是直接调用 StateStore 私有路径。还需定义 identity resolver 异常/缺席时的非阻断处置，避免“仅提醒”反过来 pin founder kickback。

5. **[MEDIUM] qa route 的核心改道可行，但审计与文件落点还不够诚实、精确。** `StateStore.ts:32170-32197` 能为 qa 找到历史 actor，并由 `appendWorkflowReworkRouteRevision` 将默认 implement reservation 原子换成 qa reservation；这条主链成立。不过随后 `source_feedback` 事件仍在 `:32216-32227` 写 `transition.targetNodeId/targetAttempt`，即改道后的 qa/design 动作仍会被记录为默认 implement；应改写为 effective route target/attempt，或明确重命名字段并要求消费者只读 `rework_route_interpreted`。另外告警 disposition union 实际在 `StateStore.ts:41485-41532`，不是计划反复引用的 `:40878-40921`；卡文案落点应明确为 `bridge/gate-materializer.ts:91`，不要保留“materializer 文案族”占位。同步修正变更清单和测试断言。

## Verdict

CHANGES REQUESTED
