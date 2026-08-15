# Design Review — FLY-1716 plan.md (Round 8)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

r8 已正确完成 Round 7 的结构性修订：B 的 standalone keyed claim 保持闭环，actionId/pointer 机械从实现面删除，override 风险在主体章节按证据重写，FLY-1764 的广播删除也经当前源码与 #836 diff 证实。剩余问题已很窄，但仍会影响实现结论：native 实验的 winner 判据没有要求实际在 70–80% 区间触发，且 active plan 仍残留“死开关”和已删除 pointer/high-water 机械的矛盾文字。

## What's Good (Keep)

- 保留 fresh `CLAUDE_CONFIG_DIR`/session、固定 binary/model/account/prefix/load、每个行为 cell 至少两次 fresh-session 重复的实验隔离纪律。
- 保留 E2 settings diff、E3a setting-only、E3b env-only、E3c conditional combo 的拆分；这已经能区分 setting 与 env 的效果。
- 保留 winner 必须先进入 plan amendment、写清 exact key/value/scope/version/rollout/rollback/tests 后才能推广的门，Runner 不再有权把一次黑盒结果直接推到 fleet。
- 保留对 override 的真实语义：它在 enforced 路径条件有效，但不能构成可靠保证；删除延后到实验留证之后，并有 before/after child-env、版本和 revert 条件。
- 保留简化后的 keyed ledger：`(gen,newSessionId)` 的 `absent | pending | completed` 足以提供 replay 幂等，manual `/clear` 的 adopt/write-back/bootstrap 不依赖 rider 或 action ledger。
- Knife C 的结论已被源码验证：#836 删除了 `FleetSensors.broadcastLoadShed()`、`notifyLead/listLeadIds` deps 和 plugin wiring；sentinel 将额外 deps 注入后断言 `notifyLead` 从未被调用。当前保留的 `notifyLeadInstruction` 只供 `ServerLossCoordinator` 的明确收件人通知，不是 all-Leads fan-out。
- V1 已改用真实可生产的 adoption 证据，V5 也正确限定为 active executable/config/test surface，历史研究与 review 留档无需被错误清除。

## Issues & Recommendations

1. **[HIGH] native experiment 的“winner”仍未绑定需求中的实际 70–80% 触发区间。** 当前成功条件只要求发生 compact + ctx drop；一个在 55%、65% 或 90% 触发的配置也会被判 winner。E3b 的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=140000` 也不能直接等同于“200k 的 70% 触发点”：research §2.1 已说明 threshold 是 effective window 再减 summary buffer，因此真实触发通常会低于 140k。请把 authority 判据补为：用 transcript usage/同一整数口径记录 compact 前最后占用，只有在模型真实 window 的 70%–80% 内发生 threshold compact 才是 winner；区间外结果单独记 `works_outside_target`，不得自动进入推广 amendment，除非 founder 另行接受。每次成功证据还应包含 debug/telemetry 中的 threshold source/enforced 或明确缺少 reactive/prompt-too-long 事件；仅 pane + transcript 很难证明计划要求的“不是 reactive 先行”。允许 E3b 根据首轮实测校准 window，但每个尝试值必须预先记录，不能事后挑结果。

2. **[MEDIUM] active plan 仍有两处与 r8 决策直接冲突的旧文字。** §0 刀 A 的解释和 §1 目标仍称 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 为“死开关”，而 §3.1 已正确证明它是“条件有效但不可作为保证的 test override”；统一改成后者。§7 的“重复/乱序 clear”风险行仍写 `completed 重放锁内修复 pointer + durable high-water seq`，但 §2.3 已明确两者删除；应改为 keyed completed pure no-op + upstream first-execution serial assumption + gen fence。否则实现 Runner 会面对互斥指令，可能把刚删除的 orphan machinery 加回来。

3. **[MEDIUM] E4 的成本上限仍是占位符，不是已定义的预算。** `≤$上限由 Runner 报 Lead 后定` 会让“第一步实验矩阵”在 1M cell 前等待一个未列入验收的临时决策。请二选一：现在钉死数值美元/token 上限；或把协议明确为 E1–E3 完成后提交 cost estimate，Lead 未在本轮给出数值批准则 E4 自动记 `inconclusive_budget_not_approved`、不阻塞 B/override 删除的既定分支。无论哪种，都应把该分支写进 V6，避免 Runner 自定花费或把未运行的 E4 报作通过。

## Verdict

CHANGES REQUESTED — address items above
