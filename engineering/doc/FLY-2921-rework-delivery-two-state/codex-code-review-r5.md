# Code Review — FLY-2921 (Round 5)

Status: APPROVED

Reviewed head: `3065f4b5c047364836c99a642c4eb1bfe6bf90ae`。本轮仅复核 forward scan 修复及相关边界，接受每轮遍历 due rows 的既定取舍。

**R3／R4 饥饿问题：CLOSED。** [turn-wake-patrol.ts:92](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:92) 在每次成功 claim 后、各处理分支之前推进 cursor；[112 行](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:112) 对 wait 释放 claim 并退还预算。原 exclusion set 和 deferral cap 已移除，长期等待行不会再于某个数量阈值重新耗尽预算。

边界复核结果：

- **顺序与退出：** [db.ts:8957](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:8957) 的严格比较与 `ORDER BY created_at, wake_id` 一致；相同 created_at 的行由唯一 wake_id 区分。有限队列中，wait、cancel、损坏 envelope 和已投递行均不会被本轮再次 claim；参数数量不随等待行数增长。
- **中途变为可处理的行：** 本轮使用固定 `nowMs`；lease 中途到期，或此前跳过的行随后变为可处理状态时，可留待下一轮。cursor 每轮重新初始化，下一轮以新时间从队首检查，不会永久遗漏这些行。
- **后续处理：** [turn-wake-patrol.ts:171](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:171) 的 exhausted-wake sweep、后续告警及 receipt 投影仍使用各自查询，不继承 cursor；本次修改未改变其过滤条件或预算。

**新增 findings：无。** 本轮范围内未发现新的 BLOCKER／MAJOR 或其他需修复问题。

以上为 **[verified by reading code]**。已阅读 25 条 wait／预算 3 的两轮回归，以及 CommDB 同时间戳顺序和 cursor 校验测试；未运行测试套件。mutation-check 结果采用用户提供的说明。
