# Design Review — FLY-1392 design-v2.md (Round 5)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2.4 已关闭 Round 4 的两个直接问题。generation-scoped resend/outbox id 是单一模型；T3 sender 改查 alert episode/not_before 而不再读取已清空的 root deadline；未投递 reminder 不消耗 cap；能力级验收也改成 at-most-one + paired-null，旧 XOR gate 已退出。

全设计目前只剩一个阻断项：cutover 仍写 `resend_round=COALESCE(resend_round,0)`，但幸存代码中的 `resend_round` 在 child **物化**时递增，而 v2.4 的新 authority 是 reminder **实际 delivered** 次数。旧值不能直接沿用为 `delivered_rounds`，否则迁移时已有但未投递的 child 仍会错误消耗 cap，恰好重新引入本轮要消除的问题。需要补一段字段迁移与未来 delivery UOW 合同；其余 Founder、category-agnostic、carrier、saga、disposal、activation、risk 和 sequencing 均可保留。

## What's Good (Keep)

- resend/outbox id 已统一为 `<root>#r<logicalRound>@<episode>` 与 `unprocessed:<root>@<episode>`，固定-id resurrection 与 generation 冲突被彻底移除。
- T3 sender 的 authority 现在是 current episode + `alert.not_before` + root non-terminal，准确匹配幸存 T3 admission 会清空 `next_unprocessed_at` 的事实。
- logical round、materialized child 和 delivered round 已概念分离；supersede 未投递 child 不消耗 cap，新 episode 可从相同 logical round 重建。
- terminal acceptance 与 schema contract 完全一致，覆盖三种合法态和三类非法态。
- 前四轮已经闭合的 Founder 单行、Bridge pure conveyor、默认覆盖、telemetry P3、external carrier、两库 reconciler、authorized settle、audit、capacity gate 与 flip-last 没有回退。

## Issues & Recommendations

1. **旧 `resend_round` 到新 `delivered_rounds` 的迁移与未来原子更新尚未定义。**

   **Issue:** §4 的 activation cohort 仍执行 `resend_round=COALESCE(resend_round,0)`（`design-v2.md:180`），随后却声明 root authority 改为只在 reminder 真投递后生效的 `delivered_rounds`（`:186`）。当前实现是在 due advance 物化 child 的同一事务立刻把 root `resend_round` 加一（`db.ts:3382-3419`），child 此时可能尚未被 LeadInboxLoop 投递；因此旧 root 值表示 materialized count，不是 delivered count。现存无 episode 的 legacy child/outbox 如何归入第一代 activation 也未写明。未来路径同样只说“真投递后生效”，尚未规定 child delivered、root delivered count 和下一窗口三者的事务边界。

   **Why it matters:** 直接 COALESCE/复制旧值会让一个已物化但未送达的 r1 在首次 v2.4 activation 后占掉一次 cap，下一次从 r2 开始并提前 T3。若未来 adapter receipt 后先 mark child、再另事务更新 root，crash 又会造成 reminder 已送达却永远不计数/不设下一窗，或重试重复计数。这是 cap 与“完整窗口”正确性的 authority seam。

   **Suggested fix:** 在 schema/activation 合同中新增明确的 root `delivered_rounds`（或正式重定义字段，但不要复用未经重算的旧值）。首次迁移按 durable child delivery evidence 回填：只统计该 root 下 `delivered_at IS NOT NULL` 且确属成功 reminder effect 的 distinct logical rounds；无 episode 的旧 child 归入 `legacy/v1` generation，已投递者计数，未投递者在 activation 时 supersede，旧 pending outbox按当前 episode规则取消/重建。删除 §4 的旧 `resend_round=COALESCE(...)`，改成该证据派生算法。未来 LeadInboxLoop 在确认 resend child adapter durable receipt时，以同一 comm.db 事务完成 child delivered/consumed、root `delivered_rounds` 的幂等 CAS 增量和 `next_unprocessed_at = delivered_at + priorityWindow`；同一 child 重放不得重复计数。补 migration fixture（旧 r1 已物化未投递、旧 r1 已投递、r1/r2 混合）及该事务三个 crash seam，断言 cap 和最终 T3 精确。

## Verdict

CHANGES REQUESTED
