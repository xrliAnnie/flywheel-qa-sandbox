# FLY-2037 去掉 reviewer 全局 slot — 探索
Issue: FLY-2037 (https://linear.app/geoforge3d/issue/FLY-2037/bridgereview-去掉全局-reviewer-slot-上限founder-直令废-reviewrequestcoordinator)
日期: 2026-08-24
基于: 无

## 1. 问题与目标

`ReviewRequestCoordinator` 当前把所有 execution 的跨家族 review job 放进一个固定为 2 的全局并发池。这个限制不是 request↔gate 绑定、fail-close、boot redrive 或同 execution 顺序执行所必需的正确性条件，却会让第三个及之后的独立 execution 在 review 门前等待。

Founder 已明确要求直接去掉这个上限。因此本单的目标是：不同 execution 的 review job 到达后立即并发运行；同一 execution 的 job 仍按提交顺序串行。

## 2. 已核实的现状

- `ReviewCoordinatorDeps.maxConcurrent?: number` 只服务全局 slot。
- 构造器默认 `maxConcurrent ?? 2`；`plugin.ts` 生产构造没有传值，因此生产固定为 2。
- `active`、`waiters`、`acquireSlot()`、`releaseSlot()` 共同实现全局等待队列。
- `execChains: Map<string, Promise<void>>` 独立实现 per-execution 串行，不依赖全局 slot。
- `stop()` 当前既设置 `stopped`，又排空全局 slot waiters；删掉全局等待队列后只需保留 `stopped`。
- 现有测试只有一条直接钉住 slot waiter 排空；没有直接钉住“第三个独立 execution 必须立即开始”或“同 execution 继续串行”。

## 3. 方案选择

按 Ponytail decision ladder，停在“删除不需要的代码”这一层：

1. 不新增 env/config 旋钮；Founder 已否决保留上限的方向。
2. 不把 2 调成更大数字；这仍然保留了同一种全局闸。
3. 不新增 429、重试或容量 admission；review job 失败已有 fail-close 与同 requestId retry，容量治理留给 FLY-2007 后续。
4. 不删除整个 `ReviewRequestCoordinator`；它仍负责可信绑定、持久化、fail-close、outbox、boot redrive 与 per-execution 顺序。
5. 仅删除全局 slot 状态和等待逻辑，让既有 per-execution chain 直接调用 `runJob()`。

## 4. 明确假设与边界

- “去掉全局 reviewer slot 上限”表示没有隐藏默认值，也没有可配置上限。
- 不同 execution 之间不再由 coordinator 排队；宿主资源容量不是本单的新职责。
- 同一 execution 的第二个 job 仍等待第一个 job 完成，包括 boot redrive 与正常 accept 两条入口。
- `stop()` 后已在运行的 reviewer 由既有 child shutdown 机制处理；尚未从同 execution chain 开始的 job不再启动。
- gate 绑定、外部回答竞态、head 冻结/复核、reviewer 失败、权威写入和 outbox 语义不改变。

## 5. 验收信号

- 三个不同 execution 的 review round 在前两个未完成时，第三个也已经开始。
- 同一 execution 的两个 review round 不重叠。
- slot 字段、waiters、acquire/release 方法、`maxConcurrent` seam 与对应注释/测试全部消失。
- focused suite、TeamLead package suite、全仓 lint/build/package test 全绿；任何宿主环境基线例外都单独核实并如实披露。

## 6. 会过期的结论

| 结论 | as-of | 重核方式 |
|---|---|---|
| 生产构造未传 `maxConcurrent`，实际固定为 2 | 2026-08-24 `88c3df6b9` | `rg -n "maxConcurrent|new ReviewRequestCoordinator" packages/teamlead/src/bridge` |
| per-execution chain 与全局 slot 是可分离的两层 | 2026-08-24 `88c3df6b9` | 阅读 `review-request-coordinator.ts` 的 `enqueue()` |
| slot 专属测试仅一条 | 2026-08-24 `88c3df6b9` | `rg -n "slot|waiters|maxConcurrent" packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts` |
