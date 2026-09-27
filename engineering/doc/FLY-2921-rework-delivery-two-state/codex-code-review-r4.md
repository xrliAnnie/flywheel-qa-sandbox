# Code Review — FLY-2921 (Round 4)

Status: CHANGES REQUESTED

Reviewed head: `a8d394197f651937aa5c82ea1db93b38aa2328d3`。本轮仅复核 R3 修复及其巡检边界；不重开已关闭事项或已批准的设计决定。

**R3 结论：NOT CLOSED（部分修复）。** 新增回归覆盖的常规队列已修复，但达到 deferral cap 后，同一饥饿问题仍然存在，详见下项。没有另列新的独立问题。

循环退出及资源边界已核对：默认预算 20 下，一轮最多处理 1019 条持续 wait 的行，exclusion set 不会无限增长；本机内存 SQLite 查询确认 `MAX_VARIABLE_NUMBER=32766`，该规模不会触及参数上限。循环结束后仍会进入 exhausted-wake sweep 和 alert materialization。已阅读回归测试源码，未运行测试套件；mutation-check 结果采用用户提供的说明。

1. **MAJOR — R3 遗留：deferral cap 只提高了饥饿阈值，未保证跨轮进展** **[verified by reading code]**

   **证据：** [turn-wake-patrol.ts:120](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:120) 仅在加入 exclusion set 后其大小小于 1000 时执行 `index -= 1`，因此第 1000 条 wait 起重新消耗投递预算。[92 行](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:92) 每轮重新创建该集合，没有跨轮游标；[db.ts:8970](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:8970) 仍按 `created_at, wake_id` 从队首选择，释放 claim 也不改变排序或下轮资格（[db.ts:9107](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:9107)）。

   **失败场景：** 同一 project 累积 1019 条较旧、可 claim 且持续返回 wait 的 `returned_to_lead` wake，后面是一条正常 due wake；使用默认 `maxPerProject=20`。每轮前 999 条免费跳过，第 1000–1019 条耗尽 20 次预算，正常 wake 永远无法被该 patrol 处理。下一轮又重复同一批旧行。这沿用 R3 中允许长期等待 Lead 的状态，只把触发数量从 20 提高到了 1019。

   后续步骤不会自行解除阻塞：exhausted sweep 只读取 `push_count >= 2` 的 sent 行（[db.ts:9502](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:9502)）；no-receipt 告警要求 `state='sent'` 且已有 `first_push_at`（[db.ts:9365](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:9365)）。若上述等待行及后面的正常行均为未推送的 pending，它们既不会被这两个步骤移走，也不会获得该 no-receipt 告警。

   **建议修复：** 保留单轮扫描上限，同时在达到上限后让下一轮从已扫描位置之后继续，例如保存可环回的扫描游标，或采用等价的公平调度；不能每轮从相同队首重新开始。补充 cap 边界的多轮回归：前置 `MAX_DEFERRED_WAKES_PER_PASS + maxPerProject - 1` 条持续 wait 的行，后接正常 due wake，验证后者最终被推送，等待行仍可恢复，后续 sweep／告警也照常执行。现有 [回归测试:177](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/__tests__/turn-wake-patrol.test.ts:177) 只有 3 条等待行，未覆盖该边界。
