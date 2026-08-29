# Design Review — FLY-1189 plan.md (Round 4)

Date: 2026-07-11
Author: Codex
Status: APPROVED

## Summary

Round 4 已关闭 Round 3 的唯一阻塞项：S7 现在明确接受 close-runner 与 detection reconcile 的两种合法并发顺序，并把真正的真机判据收敛为“close 后可靠 RESOLVED + 零重复通知”。该写法与 PR-C @ `98c2108c` 的 close、CLEARING、recovery 和持久化语义一致，也与 driver、证据报告和 out-of-scope 合同保持一致；计划可进入实现。

## What's Good (Keep)

- S7 继续使用独立 T7，并在 grace 前将精确 episode 置为 ACKED，避免误用已经 ESCALATED、按设计不会进入 CLEARING 的旧 target。
- Branch A 的证据链正确：close 成功，`detection episode(s) marked CLEARING` 日志证明更新确实命中，随后同一 episode 由 recovery 收口为 `RESOLVED/resolved_via=recovery`，全程零新增通知。
- Branch B 正确覆盖真实竞态：session 先变 terminal，reconcile 可在 close 内部多个 await 期间抢先 recovery；此时后续 CLEARING update 命中 0 行且没有 CLEARING 日志，但同一精确 episode 已在 close 窗口内 `RESOLVED/resolved_via=recovery`。将其记录为 `recovery_preempted_clearing` 而非 FAIL，消除了 Round 3 指出的假失败。
- “刚完成 reconcile 后立即 close”只用于提高 Branch A 的可观测概率，同时保留 Branch B 为合法结果；核心 PASS 判据不再依赖不可原子观察的中间态。
- TTL rebound 仍诚实限定为现有 C5 单测 spot-check；缺少“cleanup started but not terminal”真机入口继续作为 qa-report reachability finding，没有通过 DB 注入伪造 E2E。
- Phase A 顺序、S7 专节、证据三件套及 out-of-scope 表述均与新分支模型一致，没有引入跨 phase 或 teardown 生命周期冲突。

## Issues & Recommendations

1. **无阻塞问题。** 非阻塞实施提醒：当前 production reconcile 在无状态变化时没有稳定的“tick completed”日志，因此 driver 对“刚完成 reconcile”的锚定应保留为 best-effort bias，并记录实际使用的 cadence/log 证据；不要把该锚本身升级成额外 PASS 门槛。计划当前的 branch-aware 硬判据已经不依赖它，因此不影响批准。

## Verdict

APPROVED — ready to implement
