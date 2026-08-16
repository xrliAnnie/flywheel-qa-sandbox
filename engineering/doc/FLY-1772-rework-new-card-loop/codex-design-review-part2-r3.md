# Design Review — plan.md Part 2 (Round 3)

Date: 2026-08-15
Author: Codex
Status: APPROVED

## Summary

Round 2 的唯一 HIGH 已闭合：replacement identity 现在会在 predecessor/start-point 门之前解析，并由 request/route/delivery/intent 的完整绑定同时授权 founder feedback 与 `base_revision` startPoint。结合前两轮已收敛的 schema、deferred hint、alert identity 和 effective-target 审计，Part 2 已具备在当前架构上安全实施的完整合同。

## What's Good (Keep)

- replacement context 的建立时点正确前移；根 design 不再依赖不存在的入边或 attempt-1 start reservation，直接消除了 `engine_predecessor_unavailable` 的结构性断点。
- `request.base_revision` 与 coordinator wake 路径 `workflow-rework-coordinator.ts:391-394` 使用同一 durable authority，design/implement/qa 的 wake 与 replacement 不会采用两套不同的代码基线。
- request run、latest route target/attempt/preferred execution、delivery route revision 与当前 intent 的全绑定校验可由现有 getter 和持久化字段完成；失败精确 throw，避免 stale/cross-run request 把 feedback 或 startPoint 注入错误 execution。
- §15.8 的根 design 无入边 + dead actor + 真实 `materializeWorkflowReworkReplacement` 是非空洞回归，能够同时证明 materialization identity、startPoint、feedback carrier 与 dispatcher 启动，而不是仅验证一个伪造 receipt。
- 普通非-rework dispatch 保持原 predecessor/startPoint 行为，qa_fail 的 `phaseFixContext` 也继续独立；修复范围与 FLY-1655 terminal-land、FLY-1466 no-new-flags 边界一致。

## Issues & Recommendations

1. **[NON-BLOCKING]** 实现时把“完整绑定”收成一个单一 helper/predicate，并在测试中逐字段变异 request run、route revision、target node/attempt、preferred execution 和 delivery state；每一种都应在 admission/start 之前 fail-closed。这样可防止正文中的完整合同在实现时被缩减成只校验 request id。

## Verdict

APPROVED
