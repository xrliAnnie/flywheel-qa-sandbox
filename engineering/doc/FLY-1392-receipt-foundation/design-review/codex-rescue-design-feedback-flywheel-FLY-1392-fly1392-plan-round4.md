# Design Review — FLY-1392 plan.md (Round 4)

Date: 2026-07-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

draft v4 已正确关闭 Round 3 的两项 blocking finding：model-lane owner 现在有正值状态、只在真实 delivery 后启动未处理窗口；CLEARING TTL 也被拆成共享且无 page/fleet 副作用的 maintenance pass，同时保留 kind-scoped escalation。完整复核后仍有 1 个 blocking liveness 缺口：普通 `gate_question` / `runner_question` 的首次 `next_unprocessed_at` 没有初始化合同，升级库里的既有 delivered 行也没有 bootstrap，因此“未答门应被催”的正向链路不会启动。

## What's Good (Keep)

- `routing_state='model_pending'` 与 NULL-safe selector 双重关闭了 SQLite `NULL NOT IN (...)` 静默漏选；owner transfer 同事务清 root due，单 owner 合同现在完整。
- model-lane 的 `next_unprocessed_at` 只在 transport-success 的 `markConsumed(disposition='delivered')` 事务内设置，未送达与未处理两条轴不再串线。
- create → delivery → WINDOW → r1 → cap → single outbox 的 real-DB 测试，以及 adapter 永久失败不进入 unprocessed 轴的负测，能直接证明修订后的 liveness。
- 共享 CLEARING TTL maintenance 保留 target-global mute，但不携带 page/fleet effect；receipt/legacy 两个 C3 pass 仍按互斥 kind 集合隔离，方向正确。
- 同 targetKey 的 legacy CLEARING + receipt NEW 组合测试和 00/01/10/11 flag matrix 覆盖了 fresh mute、TTL rebound、receipt 恢复及 legacy 零 page，足以防止 Round 3 的跨 cohort 永久静音回归。
- 先扣 push budget、composite UOW、typed provenance、root-only resend、outbox source revalidation、flag-first sentinel 等前几轮已闭合合同在 v4 中均保持一致。

## Issues & Recommendations

1. **[Blocking — Unprocessed-axis liveness] 非 model 的首次处理窗口没有任何初始化路径，升级库中的既有 delivered 行也会永久留在轴外。** §6.1 的 selector 要求 `next_unprocessed_at <= now`（plan:194-199），但全计划对该列的赋值只有三类：model-lane transport-success（plan:52）、F-4 rebind promotion deadline（plan:136），以及已经发出一轮 resend 后重置下一轮窗口（plan:198）。§3.3 明确要求 processed 的普通 `gate_question` / `runner_question`（非 ship）在首次 delivery 时没有设置 `next_unprocessed_at`；而 additive migration 后，既有 delivered/consumed 行的该列也全部为 NULL。结果是未答 gate 永远无法通过 selector，直接违反验收 #4 的阳性对照和“delivered 后完整窗口再催”的合同。**建议：**把首次 deadline 写成逐类型的统一 delivery 合同：所有要求 processed、`resend_of IS NULL`、非 ship 的新行，在把 delivery fact 落库的同一事务内以 `COALESCE(next_unprocessed_at, delivered_at + typeWindow)` 初始化；model-lane 只是该规则的一种，不应是唯一一种。再明确 flag-on 的一次性、可重启 bootstrap：先运行 provenance derivation，再对仍未 processed 的既有 eligible delivered rows 赋完整窗口；为避免启用瞬间历史风暴，建议从 durable activation/bootstrap time 起算，而不是让旧 `delivered_at` 立即过期（若产品选择只覆盖启用后 cohort，也必须显式持久化 cutoff 并写进 Known Limitation）。flag=0 不得执行 backfill。增加 real-DB 测试覆盖：(a) 新 gate delivery 后才开始完整窗口；(b) transport 延迟不侵蚀窗口；(c) 旧库 answered gate 先 derive、零催；(d) 旧库 unanswered gate bootstrap 后到期进入 r1；(e) bootstrap crash/restart 幂等且不产生启动风暴。

## Verdict

CHANGES REQUESTED — address items above
