# Code Review — FLY-2921 (Round 3)

Status: CHANGES REQUESTED

审查指定 head `c026b8043` 的修复 `5f97ebe84` 及相邻恢复路径。当前 HEAD 的后续变化仅涉及文档和测试，受审生产代码一致。R2 问题已关闭，但新增的长期 `wait` 会触发下述 1 项 MAJOR。未重新讨论已批准的设计或 FLY-2919 fallback。

以下结论均为 **[verified by reading code]**。已阅读回归测试源码，未运行测试；mutation-check 结果采用用户提供的说明。

**R2 结论：CLOSED**

[StateStore.ts:78635](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:78635) 仅对 `pending`／`returned_to_lead` 且最新 route revision、actor、node、attempt 均匹配的 delivery 返回 `wait`。[turn-wake-patrol.ts:106](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:106) 释放 claim，不取消或推送该 wake，消除了 R2 的跨库崩溃取消窗口。[回归测试:6645](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/__tests__/StateStore.workflow-rework.test.ts:6645) 覆盖真实 CommDB rearm、patrol 保留、同 receipt 幂等重放及 grant 后恢复 `deliver`。

边界检查仍有效：completed、终态 node、身份不匹配的目标先被拒绝；`wake_delivered` 不进入新增 wait 分支。replacement 会更新 node 的 execution ID 和 route，旧 wake 不再匹配；独立 retirement 投影仍直接取消旧 wake（[db.ts:6122](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:6122)）。Lead 未 resume 时保留其恢复入口符合设计，但 patrol 必须能够继续处理其他任务。

**新增发现**

1. **MAJOR — 长期等待 Lead 的 wake 可耗尽每轮扫描额度，永久阻挡同 project 的其他 wake 重试**

   **证据：** [turn-wake-patrol.ts:69](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:69) 默认 `maxPerProject=20`；[86 行](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:86) 每轮重新创建 `deferredWakeIds`，紧接着的循环把每次 claim（包括 `wait`）都计入这 20 次额度。[db.ts:8961](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:8961) 始终按 `created_at, wake_id` 选取最旧的可重试行；[db.ts:9102](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:9102) 释放 claim 只清空 token／lease，不改变下轮资格或排序。新增 guard 因而允许同一批 returned wake 无限占用每轮额度。

   **失败场景：** 同一 project 累积 20 条较旧、`push_count < 2` 的有效 `returned_to_lead` wake，Lead 长期未再 resume。这类行可由 rearm 清零后崩溃、恢复时持续无法通过 worktree 检查而再次耗尽预算产生（[workflow-rework-coordinator.ts:1339](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/workflow-rework-coordinator.ts:1339)、[StateStore.ts:46483](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:46483)），期间 node 和 route 仍保持预留。每轮 patrol 都 claim 同样的 20 条、全部 wait，然后结束；第 21 条及之后的正常 TURN wake 即使已到重试时间，也永远得不到该 patrol 的推送。每轮的临时排除集合只能避免轮内重复，不能保证跨轮进展。现有“越过 waiting wake”测试仅使用 1 条 wait 和 5 次额度，未覆盖额度被填满的情况。

   **建议修复：** 保留本次 wait 语义，同时让扫描能够越过等待行：例如将 wait 与实际投递额度分开，或使用能跨轮推进的公平扫描游标，避免每轮总从同一批旧行开始。补充至少两轮的回归：前置 `maxPerProject` 条持续 wait 的 returned wake，后接一条可投递 wake，验证后者会被处理，前者仍保持可恢复且不被推送或取消。
