# FLY-2307 launch episode 收口 — 调研
Issue: FLY-2307 (https://linear.app/geoforge3d/issue/FLY-2307/病根-ship-完成后-launch-投递契约-episode-停在-received-永不关闭反复升级到-severe-告警而活早已干完)
日期: 2026-09-03
基于: exploration.md

## 结论

当前分支已经具有所需生产行为，来源是先于本单进入分支、但尚未部署的 FLY-2278 收口代码。FLY-2307 不需要再写一套 terminal guard 或迁移；需要把现场独有的「episode `run_id` 为 NULL、execution binding 不存在、session 已清理、run 已 completed」形状钉进现有 projector 回归测试，防止未来删除 `contract_ref_json.runId` fallback 时重发幽灵告警。当前 schema 的 binding 是 immutable；不存在可能表示 dispatch-intent mint 后从未 admission，不能表述成 binding 被删除。

## 现场账本对照

2026-09-03 查询 `/Users/xiaorongli/.flywheel/teamlead.db` 的只读结果：

- open `family='launch'` episode 共 7 条。
- 其中 6 条停在 `received`，episode `run_id` 全为 NULL；对应 run 全为 `completed`，对应 land operation 全为 `completed`。
- FLY-2270 attempt 的 `contract_ref_json` 是：

```json
{"table":"workflow_execution_binding","pk":"57385f0f-2914-4016-972c-106703f1cb81","runId":"f2c728be-6a70-47c8-895f-0df112367e68"}
```

- FLY-2270 的 `workflow_execution_binding` 和 `sessions` 行均不存在；`workflow_run_node` 仍为 `done`，run 为 `completed`。其中 session 可被清理，immutable binding 则更可能从未创建。
- 唯一带 episode `run_id` 的 open launch 条目停在 `granted` 且 run 仍 active，属于 FLY-2115，不是本单形状。

## 版本分界

- 生产 `/Users/xiaorongli/.flywheel/deployed-sha`：`31da17817c25ea1953e562c410f53f0d044a46d5`。
- 当前分支 HEAD：`3fcb03f56`。
- `069013b25`（FLY-2278，2026-09-03 12:29 -07:00）已经加入两层收口：
  1. `session_started` 业务事件投影 `consumed_at` 后立即 settle launch attempt；
  2. `DeliveryProjector` 在 source row 不存在时依次用 authoritative source、`contract_ref_json.runId`、既有 episode attribution 找 owning run，terminal run 则以 `run_terminal` settle。
- maintenance loop 的顺序是 baseline → projector → watch → operations。因此 current HEAD 的 terminal settle 在 watch 新开/升级 episode 之前发生。

## 当前 HEAD 对现场副本的执行证据

用 SQLite backup 创建 live StateStore 副本，只在副本上用 current HEAD 执行真实 `DeliveryProjector.runPass()`，随后执行 `DeliveryContractWatch.runPass()`：

```text
before: true
afterProjector: false
afterWatch: false
targetUnboundAlerts: []
```

副本中 FLY-2270 最终行：

```text
settlement_reason = run_terminal
episode.run_id    = NULL
episode.stage     = received
closed_at         = 2026-09-04T02:00:00.000Z
closed_reason     = terminal:settled:run_terminal
```

`episode.run_id` 不需要回填才能安全收口；attempt 自身的 durable `contract_ref_json.runId` 已提供 owning-run authority。直接把 terminal runId 传给 watch 反而可能在 projector 异常时把噪音从 unbound 队列改发到 run-bound outbox，不能作为单独修复。

注：副本 projector 使用空 CommDB，因此同时收敛了大量与本单无关的 comm-source residue；上面的断言只按 FLY-2270 exact attempt id 取数，不把全局 `advanced` 数量当作本单证据。

## 测试覆盖差口

`fly2248-r6-projector-recovery.test.ts` 已有 “settles a native launch obligation when its owning run completes”：

- 已证明 active→completed 后 projector settle、episode close、下一轮 watch `observed=0`；
- 但 test 保留了 `workflow_execution_binding`，projector 总能走 authoritative source lookup；
- 它未证明 binding 从未创建、session 清理后仍会使用 `contract_ref_json.runId`；
- episode 在 test 中最初是 run-bound，也未覆盖现场 NULL attribution。

最小补强是扩展这条现有 test：直接构造 dispatch-intent 已 mint、但 binding 从未创建的 durable launch attempt；先创建再清理 session，把 node 标为 done，并让 terminal-run watch 自然创建 `run_id=NULL` episode，同时断言 attempt contract ref 仍带 runId。随后运行 projector→watch 和 settlement 断言。

## 方案比较

| 方案 | 结果 | 决定 |
|---|---|---|
| watch 对 completed run 也写 episode `run_id` | 只改变告警路由，不自动消除噪音；可能产生 run-bound severe | 不采用 |
| watch 再实现一份 terminal-run settle/guard | 与 projector 重复状态写入和顺序契约，增加竞争面 | 不采用 |
| schema migration 回填 episode `run_id` | 无需回填即可由 attempt ref 收口；增加生产写账本风险 | 不采用 |
| 补 exact cleanup-shape regression | 锁住已存在的最小生产修复，无新依赖、无新分支 | 采用 |

## 风险与验证

- 测试若只改 episode `run_id`，仍可能偷偷靠 binding 通过；必须从未创建 binding 并断言确实不存在。
- 测试若只有 binding absent，仍可能未覆盖 unbound episode；必须让 watch 自然创建 `run_id=NULL` episode 并回读。
- negative control 应临时移除 projector 的 `ref.runId` fallback，确认该 test 留下 live attempt/open episode；随后逐字恢复生产文件并重新跑绿。
- active-run control 继续由相邻现有 test 覆盖，确保真正的 launch obligation 不被提前 settle。
