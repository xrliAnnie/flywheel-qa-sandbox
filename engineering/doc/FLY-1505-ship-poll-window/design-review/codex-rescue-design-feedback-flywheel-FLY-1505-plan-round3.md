# Design Review — FLY-1505 plan.md (Round 3)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的两个问题已按正确方向闭环：显式 settled branch 能绕开 equality/duplicate 快捷路径，C7 parser 也已收敛到共享函数并增加生产接缝测试。当前还缺一个 delayed-marker 的 head authority 规则；如果旧 head 的 complete-failed marker 在新一轮批准后才被 boot drain 消费，它可能错误写入或覆盖当前 head 的 C3 标记，从而错误抑制新批准轮次。

## What's Good (Keep)

- C2(c) 不再依赖 loopback，而是在 `expectedStatusFromMarker` 和相等快捷路径之前直接完成 durable side effects，正确覆盖“event 从未插入”和“event id 已插入但 side effects 未完成”两个 crash window。
- C3 成功后才 unlink complete-failed marker；写失败保留最后证据并返回 `transient_failed`，顺序与 fail-close 要求一致。
- `expectedStatusFromMarker(blocked, approved_to_ship)` 仍返回 `approved_to_ship`，即便主流程已由 settled branch 截获，导出映射本身仍与 event-route 语义一致。
- T4 已从纯映射断言升级为磁盘 marker + bound approved session 的 restart 测试，并钉住状态保留、C3 持久化、C7 抑制、marker 消费和写失败重试。
- `shipAttemptFailedSuppressedHead` 共享解析函数、`RewakeSessionProbe` 显式字段及 GatePoller-level 测试关闭了 Round 2 的生产接线漏测；malformed/missing/unknown 全部 fail-open 合理。
- Round 1 的五项修订仍保持完整：DirectEventSink 原始谓词、attempt-bound receipt、runner 变体等待、事实型 best-effort 告警和 FLY-1448 final-tip 硬门均未回归。

## Issues & Recommendations

1. **[HIGH] delayed complete marker 的 head authority 未定义，可能把旧 attempt 重新绑定到当前批准 head，或覆盖当前 head 的真实 C3 标记。** plan.md:118 只写“pr/head/summary 取 marker payload + session row”，没有规定 precedence/mismatch 行为；而 C3 在 `session_params.fly1505_ship_attempt_failed` 里只有一个最新标记槽（plan.md:145-148）。同一 execution 可以按 FLY-945 从 approved(head A) → awaiting_review → approved(head B)：若 A 的 complete POST 已被 Bridge 处理但响应丢失，CLI 会留下磁盘 marker，runner 随后经 Lead 显式恢复完成 B 的新审批；下一次重启才处理 A marker。此时若 reconciler fallback 到 `currentSession.pr_head_sha`，会把 A 的失败错误写成 B 并抑制 B；即便优先用 marker 的 A，也可能覆盖已经存在的 B failure marker，反而取消 B 应有的抑制。`complete.ts:493-551` 已在 marker payload 中捕获事件发生时的 40-char `evidence.headSha`，因此 delayed path 必须以它为事件权威，不能猜当前 row head。建议明确三态：marker head 有效且等于当前 approved head → 正常 `markShipAttemptFailed`；有效但不等 → 作为 stale attempt 消费并记录日志/独立 outcome，**不修改现有 C3、不告警当前 head**；marker head 缺失/无效 → fail-open，不得用当前 head 代填，也不得覆盖已有真实 C3（可保留 unknown 审计，但不能参与 C7）。T4 增加 A-marker/B-current 的重审回归，分别覆盖“B 无标记”和“已有 B 标记”，断言 B 不被新建错误抑制且已有 B 标记不被 A 覆盖。

2. **[MEDIUM] 新 `settled_ship_attempt_failed` outcome 的调用方合同还没有列全，且风险表仍错误声称 reconciler 经 loopback。** `ReconcileOutcome` 当前需要显式加入新 discriminator；boot drain 在 `complete-marker-reconciler.ts:935-943` 只把 `reconciled`、`duplicate_terminal` 和 `settled_merge_block` 计为成功处理。若不同步加入新 kind，marker 虽已删除但 boot 统计会显示未 reconciled，后续调用方也可能把已处理结果当作 absent/fallthrough。请在 C2(c) 明列：更新 outcome union、boot-drain success 集合及所有 exhaustive consumers；T4 对 boot drain 断言 `scanned=1, reconciled=1, quarantined=0`，并可另测 `tryReconcileComplete` 的具体 kind。plan.md:235 也应改为“reconciler 直接调用共享 marker helper，T4 钉住与两 live sink 的 agreement”，不再声称它通过 loopback 复用 event-route。

## Verdict

CHANGES REQUESTED — address items above
