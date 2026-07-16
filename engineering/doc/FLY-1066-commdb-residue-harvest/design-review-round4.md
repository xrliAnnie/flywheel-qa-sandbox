# Design Review — plan.md (FLY-1066) (Round 4)

Date: 2026-07-16
Author: Codex
Status: APPROVED

## Summary

Round 3 的两项 supporting-doc 残留均已闭环：`research.md` 现在准确表达最终 revival 与显式 QA-loss 契约，`exploration.md` 也正确画出 full-harvest global tail 和 scheduled-run 单行路径的分流。结合 Round 3 已确认技术内容闭合的 `plan.md`，当前设计在可行性、fail-closed 安全、竞态防护、flag 兼容、测试与上线前置门方面已足够完整，可以进入实现。

## What's Good (Keep)

- `research.md` §3.4 现在准确记录三列主键与 `INSERT OR IGNORE` 的约束，并明确 `recovery`、`residue_harvest` 都是可复活的 machine-proven clear，`lead` 永不复活；不再把关键语义留到实现阶段决定。
- revival 契约与计划测试一致：更晚的 `firstDetectedAtMs` 复用原 row、转回 NEW 并全量重置通知/ack/page/clearing/attempts，避免同 ID replay 后永久静音。
- `research.md` §5 已明确 `applyTransition` 不携带 QA-loss；M2 只有在 transition 成功后才显式调用 qa-only 的 `onQaPhaseTerminated` 同型 hook，是否 respawn 继续由 FLY-1050 守卫链决定。
- terminated archive 仍准确锚定 `archiveIssueThreadIfNoOtherActive(..., { allowStatuses: ["terminated"] })`，并保留 completed-only helper 的禁止误用说明。
- `exploration.md` Mermaid 现在有完整的 boot/heartbeat → full-harvest orchestrator → 全部 per-project faces ①②③ → global-once face④ tail 入边，正确表达 M3 的执行依赖。
- scheduled-run 409 明确只进入 `ghostReconcileOne` 的单 session 面③判据，且标注不进入 full pass，不会误触 M1 或全局 M3。
- 既有硬安全边界未被削弱：删除/终态化只接受 proven-dead；alive/indeterminate、live `awaiting_review` 与合法 parked session 始终 keep；24h/30min 年龄护栏和逐候选双账重验继续 fail-closed。

## Issues & Recommendations

1. No blocking issues found.

## Verdict

APPROVED — ready to implement
