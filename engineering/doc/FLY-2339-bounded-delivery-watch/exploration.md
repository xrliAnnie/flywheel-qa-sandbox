# FLY-2339 有界投递监看 — 探索

Issue: FLY-2339 (https://linear.app/geoforge3d/issue/FLY-2339/引擎urgent-2331-之后-eventloopguard-第二层凶手维护-tick-里同步跑的-delivery)
日期: 2026-09-04
基于: 无

## 1. 现象与已知边界

Bridge `0c947b1` 启动约 6 分钟后，EventLoopGuard 记录 `stall_age_ms=62687`、`last_sync_op="delivery-contract:watch"` 并以 exit 137 自杀。此前同日 59 次归因均为 child；本次是同步操作 marker 首次直接命中。约束明确排除调高 loop-guard 阈值与新增告警层，目标是让 delivery-contract 维护本身单次有界。

## 2. 当前热路径

`packages/teamlead/src/bridge/plugin.ts` 的 detached maintenance tick 对每个项目依次同步执行：

1. `DeliveryProjector.runPass`
2. `DeliveryContractWatch.runPass`
3. `DeliveryOperations.runPass`

三段都运行在 Bridge 主线程。`watch.runPass` 先全量读取 CommDB mailbox 与 turn-wake 投影，再全量读取 StateStore 的 live delivery attempts；每个 attempt 还会做若干点查与状态观察。

当前最强嫌疑是 `CommDB.listRunnerDeliveryProjectionRows()`：生产 flywheel `comm.db` 已约 639 MB，该 SQL 对每一条候选 mailbox 行执行两个按 `to_agent` 相关的聚合子查询（`COUNT(DISTINCT batch_id)` 与 `MIN(delivered_at)`）。是否正是 62 秒主因仍需用生产快照逐查询计时证明，不能只凭源码形状下结论。

## 3. 需要回答的问题

- 生产 `teamlead.db` 与 flywheel `comm.db` 各相关表有多少行、live/terminal 分布如何？
- `watch.runPass` 的真实总耗时是多少？时间集中在哪个 SQL/表？
- projector 与 operations 是否也存在全量扫描，需怎样用同一套小预算分片？
- cursor 必须怎样定义，才能在 bounded pass 间公平推进，同时不遗漏 active source、terminal 收敛或超时升级？
- 单次工作量上限如何由测试直接证明，而不是靠脆弱的墙钟断言？

## 4. 实施假设（调研后可收窄，不可静默扩大）

- 使用现有 SQLite/TypeScript 能力，不新增依赖。
- 优先给现有查询增加明确 `LIMIT`/cursor 与匹配索引，再让三段共享很小的每-pass 行预算；不引入 worker 线程，除非生产快照证明单条有索引查询仍无法在数百毫秒内完成。
- 语义保持不变：投影、watch 超时/冻结、reroute/settle 的最终结果仍需在后续 pass 收敛；只改变每次 tick 的工作切片。
- 生产验证只在一致性快照上运行；不让基准写入在线数据库。

## 5. 非目标

- 不改 `FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS`。
- 不新增告警或 delivery-contract 状态。
- 不借本单重写 FLY-2248/FLY-2278 的投递语义。
- 不部署或合并；部署后日志观察由后续独立 QA/发布流程完成。
