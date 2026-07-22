# Design Review — FLY-1392 design-v2.md (Round 4)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2.3 已真正关闭 Round 3 的 terminal schema、跨库 orphan reconciliation 和 external carrier queue lifecycle 三项问题；episode fencing 也识别了正确的风险面。但该段新增合同内部仍不一致：它同时要求 generation 进入 outbox id、又要求固定 id 原地 rearm，并让 sender 检查 T3 入队后会被清成 NULL 的 root deadline。照字面实现会导致旧 episode outbox 永远过不了 current-generation 校验，或 T3 永远不发送。另一个关联缺口是未投递就被 supersede 的 resend child 仍会占用 `resend_round`/cap，造成少提醒一次便提前升级。

这些是局部状态机修正，不需要改动 v2.3 的 Founder 拓扑、category-agnostic 默认、carrier 分层、disposal authority、activation episode 或 S1–S5 顺序。修正后即可批准。

## What's Good (Keep)

- terminal contract 已明确为 at-most-one，并加入 timestamp/evidence paired-null CHECK、migration validation 与应用 CAS；pending/processed/disposed 三态现在可落地。
- external schema 给出 NOT NULL/default/backfill，transport accept 同事务写 delivered/consumed/disposition，并枚举所有公开 claim/count/retry surface；重复承运与 active-loop 空转风险已闭合。
- `delivery_pending` 不再允许盲 TTL 删除；journal accepted/absent/unreadable 三分支分别 finalize、tombstone、quarantine，保住了跨库 crash seam 的 authority。
- flag-off 仍保持 Bridge 无条件 pure conveyor，且明确暂停未投递 resend 与 outbox drain；方向正确。
- telemetry/progress、priority、handle idempotency、Founder 单行、causal settle、capacity gate 与 flip-last 顺序均保持前轮已通过的合同，没有回退。

## Issues & Recommendations

1. **episode-fenced resend/outbox 合同存在三处互相冲突的状态语义。**

   **Issue:** §4 一方面规定 resend/outbox 的 activation generation 纳入幂等 id（`design-v2.md:183-185`），另一方面又要求 pending outbox 用 `not_before` 原地 rearm并强调不能“撞死固定 `unprocessed:<rootId>` id”（`:186`）。若 generation 在 id 中，旧 generation row 不能同时成为 current generation；若保留固定 id，generation 就不能靠 id 表达。sender 又被要求检查 root `next_unprocessed_at <= now`（`:187`），但幸存 T3 路径在 outbox 入队时明确把该字段清为 NULL（`db.ts:3440-3454`），SQL 三值逻辑下该 alert 永远不满足发送条件。最后，root 在插入 resend child 时就递增 `resend_round`（`db.ts:3382-3419`）；re-enable supersede 一个从未投递的 r1 后，§4 的 `COALESCE` 保留 round=1，下一次直接发 r2并更早触顶，未发生的 reminder effect 消耗了 cap。

   **Why it matters:** 这会让逃生阀恢复后出现两种相反故障：应升级的 T3 永远沉默，或 Lead 实际只见一次 reminder 就按两次计算提前升级。两者都破坏“never miss”和 bounded escalation 的可预测性；现有两个新增测试若不明确 round/outbox authority，也可能只验证时间而漏掉状态错误。

   **Suggested fix:** 选择并写死一种 id 模型。推荐 generation-scoped ids：`<root>#r<logicalRound>@<episode>` 与 `unprocessed:<root>@<episode>`；旧 generation 未 effect 的 row可 supersede/cancel，新 episode 到期时创建自己的唯一 row，不存在固定-id resurrection。outbox sender 校验 `alert.episode = currentEpisode ∧ alert.not_before <= now ∧ root 非终态`，不要依赖已在 T3 admission 时清空的 `root.next_unprocessed_at`。resend cap 必须计**已实际 delivered 的 reminder round**，不是仅 materialized child；supersede 未投递 child 后，新 episode 应从相同 logical round 重建，已投递 round 才保留。若选择固定 outbox id，则 generation 必须是可 CAS 更新的列并定义同一 row 的 rearm state machine，不能再声称 generation 在 id 中。扩充两条现有测试，断言具体 id/generation、delivered reminder count、cap 和最终恰一次 T3。

2. **能力级验收仍残留被正文废除的 literal XOR 表述。**

   **Issue:** §2.2c 已正确声明“不是字面 XOR”，但 §7 验收 4 仍写 `processed XOR disposed`（`design-v2.md:89,211`）。作为实现 gate，这可能重新引导测试要求 pending 行恰有一个终态，或只测试双终态而漏掉 paired-null 半写约束。

   **Why it matters:** 本文是唯一 design authority；schema contract 与 capability acceptance 对同一不变式使用相反表达，会让最终 harness 无法证明实现遵循的究竟是哪一个契约。

   **Suggested fix:** 将验收 4 改为“terminal at-most-one + paired-null constraints”，逐项列出 pending、processed-only、disposed-only 合法，both-non-null、processed half-write、disposed half-write 非法；完全删除 XOR 字样。

## Verdict

CHANGES REQUESTED
