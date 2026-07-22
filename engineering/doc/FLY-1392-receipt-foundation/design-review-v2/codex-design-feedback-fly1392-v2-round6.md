# Design Review — FLY-1392 design-v2.md (Round 6)

Date: 2026-07-21
Author: Codex
Status: APPROVED

## Summary

draft v2.5 已关闭 Round 5 的唯一阻断项，并且没有引入新的合同冲突。设计现在明确区分旧实现的 `resend_round`（reminder child 物化计数）与新模型的 `delivered_rounds`（实际 durable delivery 计数），给出了可迁移、可重放、可故障注入验证的首次回填算法和未来投递事务边界。

按全文复核结果，设计继续满足 Founder 五项绑定裁定：Bridge 无条件纯传送；对外只有“Lead 是否处理”这一层收据；所有真实 Lead delivery 默认覆盖且与类别无关；豁免仅允许非真实投递的 `internal_mirror`；默认翻转置于完整能力验证之后。现存代码锚点也支持本次修正：`db.ts:3382-3419` 的确在 child 物化时递增旧轮次，`db.ts:3440-3454` 的确在 T3 入 outbox 后清空 root deadline，因此 v2.5 对 cap 和 outbox sender 的重新定义与实际幸存器官相符。

## What's Good (Keep)

- §4 明确禁止直接沿用旧 `resend_round`，按 `delivered_at IS NOT NULL` 的成功 reminder effect、以 distinct logical round 回填 `delivered_rounds`，避免把“已物化但未投递”误算为已消耗 cap。
- legacy 无 episode 数据被统一归入 `legacy/v1` generation：已投递 reminder 计数，未投递 child 被 supersede，旧 pending outbox 按新 episode 规则取消/重建；这与 generation-scoped id 模型完整闭合。
- 未来由 LeadInboxLoop 在 adapter durable receipt 后，于单个 `comm.db` 事务内完成 child delivered/consumed、按 child id 幂等记一轮、以及 root 下一完整窗口初始化。该边界正确覆盖重放与部分写风险。
- resend cap 只统计真实投递轮；未投递 reminder 被 episode supersede 不消耗 cap，新 episode 从同一 logical round 重建。`<root>#r<logicalRound>@<episode>` 与 `unprocessed:<root>@<episode>` 两套 id 规则互不冲突。
- T3 sender 只校验 current episode、`not_before` 和 root 非终态，不错误依赖已被清空的 `root.next_unprocessed_at`；flag-off/off-on 的零副作用和整窗恢复语义保持可测。
- 迁移 fixture 覆盖 legacy r1 未投递、r1 已投递和 r1+r2 混合；投递事务覆盖三个 crash seam，并要求精确断言 cap 与最终 exactly-once T3，验收标准足以防止实现偷换语义。
- 其余此前收敛的关键合同仍保持一致：canonical receipt 单行、external carrier 两库 saga、authorized settle/disposed 双终态、端到端去类型化、仅 `internal_mirror` 可豁免，以及 S1–S5 的 dormant-first/flip-last 顺序。

## Issues & Recommendations

无阻断问题。

实现时应把 §4 的 legacy 三组 migration fixture、child-id 幂等记账和三个事务 crash seam 作为对应切片的合入 gate；这些是本次批准所依赖的核心可执行合同，而不是可延后的测试补充。

## Verdict

APPROVED — ready to proceed
