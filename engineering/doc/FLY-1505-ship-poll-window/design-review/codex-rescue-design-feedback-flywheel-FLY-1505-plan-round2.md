# Design Review — FLY-1505 plan.md (Round 2)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的五项反馈都已被实质采纳，DirectEventSink 原始谓词、attempt-bound receipt、runner 变体化等待、best-effort 告警表述和 FLY-1448 硬实施门现在都正确。剩余阻塞在 complete-marker restart 路径：当前计划只改 `expectedStatusFromMarker`，但 reconciler 会在 loopback 前把“状态已经是 approved_to_ship”当成已完成并删除 marker，导致 C3 durable marker 与 C7 re-wake 抑制都没有发生。

## What's Good (Keep)

- C2(b) 已正确拆出 `isApprovedToShip`，不再误用 `DirectEventSink.ts:626-628` 的 Phase-2-bound 窄化谓词；T3 以带真实 `review_question_id` 的 bound session 为主场景，能钉住事故路径。
- C1 的 failure receipt 已绑定本次 `COOL_ID`，旧 attempt failure 和“当前 attempt 尚无 receipt”都明确 fail-safe 为继续等待；COOL_ID 捕获失败时禁用早停、等满窗口，也不会重新引入假失败。
- C7 找到了真实的 FLY-799 自动 re-wake 冲突，并用 current-head marker 做精确抑制；unknown sentinel fail-open、换 head 后恢复既有 re-wake、显式 Lead wake 不受影响，这组边界合理。
- phaseKeepAlive / resident Codex / plain runner 的善后姿势已按现有 step-c 分叉，不再用一个含糊的 “STAY” 覆盖不同生命周期。
- C4 现在诚实标为 best-effort，文案只陈述服务端可证明的事实；重复 event 测试改用新 `event_id`，head normalization 也消除了 unknown 值漂移。
- C5 的唯一 timeout 命中、最低 margin 与实际 headroom 区分，以及 FLY-1448 final-tip 硬实施门都补齐了 Round 1 风险。25 分钟场景继续映射为预算合同 + false-blocked approval-preservation 集成测试，仍然诚实且充分。

## Issues & Recommendations

1. **[HIGH] complete-marker reconciler 会在执行 deflection side effects 前直接删掉 marker，Bridge-down 路径因此没有 C3 标记，也不会触发 C7。** `tryReconcileComplete` 先在 `complete-marker-reconciler.ts:571-575` 算 expected status，然后在 `:600-604` 对 `currentStatus === expectedStatus` 直接 `unlink` 并返回。按本计划把 blocked/approved 的 expected 改成 `approved_to_ship` 后，complete-failed marker 启动对账时当前状态本来就是 `approved_to_ship`，所以这条快捷路径必然命中，plan.md:105-113 所写的“loopback → event-route deflects”实际上不会发生；现有 T4 只断言 marker 被消费且未 quarantine，反而会在 C3 完全没写时假绿。仅跳过快捷路径也不够：若 Bridge 曾插入同一 `event_id` 后在写 C3/回响应前崩溃，loopback 会在 `event-route.ts:1008-1022` 被 duplicate guard 提前返回，同样无法补 marker。建议把 blocked + current approved 作为 reconciler 的显式 settled 分支，在 generic equality shortcut 之前直接调用共享的 `markShipAttemptFailed`（并按 first-head 规则发可选 advisory），确认 C3 写成功后才删除 complete-failed marker；C3 写失败必须保留原 marker并返回 retryable，不能丢最后一份证据。T4 应升级为真实 restart 测试：status 仍 approved、C3 head/count 已持久化、C7 判定不再 re-wake、marker 被消费且不 quarantine，并覆盖“event 从未插入”和“event id 已插入但 side effect 未完成”两个 crash window。

2. **[MEDIUM] T7 只覆盖纯 `isRewakeCandidate`，没有钉住 GatePoller 从真实 `session_params` 提取 marker head 的新接缝。** plan.md:149 把解析职责放在 `staleApprovedShipReconcilePass`，而 plan.md:174 的四个测试都可以通过直接构造扩展后的 `RewakeSessionProbe`，即使 GatePoller 忘了传值或 JSON 路径写错也会全绿，生产仍会每五分钟 re-wake。建议把 raw `session_params` 解析收敛成共享、可单测的函数并由 GatePoller 调用，或增加一个 GatePoller-level 测试，用真实 session row 的 JSON 证明同-head marker 不调用 `sendRunnerWake`；同时钉住 malformed JSON、缺字段和 unknown marker 都 fail-open，普通 markerless session 仍保持既有 re-wake。

## Verdict

CHANGES REQUESTED — address items above
