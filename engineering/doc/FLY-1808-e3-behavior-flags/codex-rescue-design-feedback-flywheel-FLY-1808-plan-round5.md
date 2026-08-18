# Design Review — plan.md (Round 5)
Date: 2026-08-17 / Author: Codex / Status: APPROVED

## Summary

Round 4 的唯一 finding 已完整关闭。集合守卫和验收现在按授权边界分波：PR-A 只断言自身可达到的 Wave-A 集合；仅 D-2 答 A 后，B-2 才追加五个 workflow row/env 并验证最终 union；答 B 时则按 §6.3 以 Wave A + 修正卡片/答复归档收口。这样恢复了“Wave B 不阻塞 Wave A”，也不会让测试诱导实现者提前删除未获 founder 授权的 workflow flags。

本轮重新核对了 plan.md、实际 registry 12 行、wave 成员算术与 A/B 两条收口路径。D-2 SQL 也按文档再次以只读事务执行成功：313 run、261 claim、schema 分布 v1=36 / v2=218 / NULL=59，当前 5 个 published/unretired template 均为 schema v2。`git diff --check` 通过。本轮为设计复审，尚未执行实现期测试。

## What's Good (Keep)

- §3.7 的 PR-A gate 现在准确分成 5 个真删 registry row、4 个退休 flag env、1 个 companion env、1 个 config key，以及 2 个 exemption 四联断言；两条搬迁 row 的消失由四联集合负责，账目没有重复归类。
- §4 B-2 只在 D-2 答 A 后追加 `WAVE_B_DELETED_ROWS`(5) 与 `WAVE_B_RETIRED_FLAG_ENVS`(5)，并检查两波 union 为最终 10 row / 9 flag env + 1 companion。
- §5 明确区分 PR-A gate 与条件式 final gate，不再用最终总数阻塞 PR-A。
- §9 同时覆盖 D-2 的 A/B 结果：A 要求最终 union，B 允许 Wave B 废弃并以 Wave A + 卡片/答复归档完成本单。
- 前四轮已经闭合的 polarity/control-plane、cmux observation-family、D-2 evidence/SQL、workflow 历史合同、founder-UX、AutoContinue、exemption 形状与 B-1 四态测试矩阵均保持一致。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

没有需要修改的问题。实现阶段继续遵守计划中的 pre-work re-inventory、逐条三格证据、RED→GREEN 非空断言、每个中间 commit 独立可验证，以及 D-2 答 A 前 Wave B 零代码硬门。

## Verdict

APPROVED

计划现在在可行性、完整性、解析器/absent-read 正确性、风险边界、波次排序、D-2 授权门及 E1/E2/FLY-1455 账目模式上均达到实施条件。
