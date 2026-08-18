# Design Review — plan.md (Round 4)
Date: 2026-08-17 / Author: Codex / Status: CHANGES REQUESTED

## Summary

Round 4 已把 Round 3 的三项要求全部落进实际文档。plan.md §6.1 的 SQL 与当前 `teamlead.db` schema 一致，本轮按文档逐字只读执行成功，结果仍是 313 run、261 claim、schema 分布 v1=36 / v2=218 / NULL=59，以及 5 个 current-published、unretired、schema-v2 template；schema drift 也已改为 fail-closed。B-1 现在逐 flag 覆盖 absent/`0`/`1`/invalid、registry effective、raw-write，并为 claims-read 钉住三层来源与优先级。research.md #11/#12、plan.md §3.5/§3.6/§5 对显式 `FLAG_EXEMPTIONS` object 与 named sets 的口径也已一致。

但本轮发现一个新的波次排序缺口：§3.7 是 PR-A 的收尾门，却要求只有 PR-B 才能达到的最终 10-row/9-env 集合；§4 同时又明确说 B-2 才把守卫“扩到全 10 条”。按当前文字，PR-A 在 D-2 尚未答复时无法让集合守卫通过，直接推翻 §2 的“Wave B 不阻塞 Wave A”。§9 也把最终全量集合写成无条件验收，因此 D-2 若答 B、Wave B 按 §6.3 废弃时，本单无法按自己声明的验收收口。

本轮执行了 plan/research/source 核读、生产数据库只读 SQL、registry 成员核对和 `git diff --check`；这是设计复审，未运行尚未实现的代码测试。

## What's Good (Keep)

- 保留新的 D-2 SQL 原文与 fail-closed schema-drift 规则；查询现已可复现且不会允许 relay 临场改写证据。
- 保留 B-1 完整四态矩阵和 claims-read 三层 precedence 测试；B-2 的“显式 `0` inert”RED 不需改动。
- 保留 research.md #11/#12 的显式 `FLAG_EXEMPTIONS` object 处置，17 项 `QA_AND_INVOCATION_SEAMS` 数组保持不动。
- 保留最终全量 named-set 结构：10 个真删 registry row、9 个退休 flag env、1 个 companion env、1 个独立 config key、2 个 exemption 四联断言。问题只在这些集合需要按 wave 分阶段断言，而不是集合成员本身。
- Round 2 已闭合的 polarity/control-plane、cmux observation-family、founder-UX、AutoContinue、legacy epoch/enrollment 合同均保持成立，无需重开。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[HIGH] PR-A 集合守卫错误地要求 Wave-B 最终态，破坏了独立波次与 D-2 gate。**

   **Why it matters:** plan.md:26-29 规定 PR-A 只有 7 个 Wave-A 条目，Wave B 的 5 个 workflow flag 在 D-2 答 A 前零代码且不得阻塞 Wave A。但 plan.md:94-100 的“PR-A 收尾”要求 10 个真删 registry row 与 9 个退休 flag env 全部完成；其中 5 个 registry row 和 5 个 env 正是未授权的 Wave B。当前源码也确认 12 个 registry row 仍全部存在。plan.md:113 又写 B-2 才“集合守卫扩到全 10 条”，与 §3.7 自相矛盾。

   PR-A 实际可达到的集合应是：5 个 Wave-A 真删 registry row（#6-#10）、4 个 Wave-A 退休 flag env（#6、#8、#9、#10）、1 个 companion env、1 个 config key，以及 2 个搬迁 env 的四联断言；两条搬迁的 registry row 也会消失，但由四联集合单独负责。只有 D-2 答 A 并完成 B-2 后，真删集合才增加 5 个 workflow row/env，达到最终 10 row / 9 flag env。若 D-2 答 B，最终全量集合按设计永远不应出现。

   **Suggested fix:** 把 guard 明确拆为命名的 wave 集合：

   - §3.7/PR-A 只断言 `WAVE_A_DELETED_ROWS`（5）、`WAVE_A_RETIRED_FLAG_ENVS`（4）、companion（1）、config key（1）和 moves（2）。
   - §4/B-2 在答 A 后追加 `WAVE_B_DELETED_ROWS`（5）与 `WAVE_B_RETIRED_FLAG_ENVS`（5），并断言两个 wave 的 union 恰为最终 10/9+1。
   - §5 同时列 PR-A gate 与条件式 final gate，不再声称 PR-A §3.7 已是最终集合。
   - §9 改成条件验收：Wave A 集合永远必过；仅 D-2 答 A 时要求最终 union，答 B 时以 Wave A + 修正卡片/答复归档收口，和 §6.3 对齐。

   这样既保持所有 named-set 防漏能力，也不会为了让 PR-A 变绿而提前删除未获 founder 授权的 workflow flags。

## Verdict

CHANGES REQUESTED

Round 3 的三项 finding 已全部关闭。剩余改动只需把集合守卫与验收按 Wave A / 条件式 Wave B 分层；完成后不需要重开任何行为固化或处置方向。
