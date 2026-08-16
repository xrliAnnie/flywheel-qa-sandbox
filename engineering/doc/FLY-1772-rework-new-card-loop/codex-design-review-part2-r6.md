# Design Review — plan.md Part 2 (Round 6)

Date: 2026-08-15
Author: Codex
Status: APPROVED

## Summary

R5 的两项问题均已关闭。双 mint seam、生产路由 e2e、post-rollback 原子告警事务以及同 uid payload 恒定合同现在与当前架构一致，Part 2 可按此实施。

## What's Good (Keep)

- §13.6′ 的事实段与合同已统一为 decision/completion 两条 gate-entry seam；`tpl_code` 明确走真实 `/workflow/decision`，并禁止手工注入 `gateEntryBinding` 绕过生产 producer。
- 两个真实 refusal catch 共用 post-rollback helper，并把 checked refusal event、outbox 与 alert receipt 放在同一新事务；这既避免失败主事务回滚告警，也消除了 refusal/outbox 分段提交的 crash gap。
- 原 typed 409、credential/completion 可重试以及零 gate/holder mutation 均被保留，符合 FLY-1655 fail-closed land invariant。
- `land_head_unavailable` disposition、稳定 per-attempt uid、首次 identity 固化、existing-outbox same-run 快路和冲突重读组成了完整的 payload-constancy/idempotency 合同；restart、Lead 漂移和 replacement actor 测试覆盖了关键重放面。
- §14、§15.7 与 §18 已同步相同的 producer、union 和测试范围，没有再留下文档/实现入口分叉。

## Issues & Recommendations

1. 无阻断问题。非阻断实现建议：在 helper 单测中额外钉死只有 exact `transitionReason === "land_head_unavailable"` 才产生该 severe alert，并断言首次 enqueue 选定的 required `metadata.workflowEngine.executionId` 在同-attempt replacement 重放中保持 first-write immutable；这与现有合同一致，不要求再改计划。

## Verdict

APPROVED
