# FLY-2307 launch episode 收口 — 探索
Issue: FLY-2307 (https://linear.app/geoforge3d/issue/FLY-2307/病根-ship-完成后-launch-投递契约-episode-停在-received-永不关闭反复升级到-severe-告警而活早已干完)
日期: 2026-09-03
基于: 无

## 问题

`family='launch'` 的 delivery-contract attempt 已经进入 `received`，但对应 workflow run 和 land operation 都已经完成。watch 仍为它创建 `closed_at IS NULL` 的 episode，并在 30 分钟后 warning、90 分钟后 severe。执行体的 session 已清理，因此这些告警不代表待处理工作。

现场样本 FLY-2270：

- run `f2c728be-6a70-47c8-895f-0df112367e68` 是 `completed`；land operation 是 `completed`；land node 是 `done`。
- launch attempt 的 `contract_ref_json.runId` 仍是该 run，`pk` 仍是 land execution `57385f0f-2914-4016-972c-106703f1cb81`。
- 现场观测时 `workflow_execution_binding` 和 `sessions` 中均找不到该 execution，但 `workflow_run_node` 仍可证明 execution 属于该 terminal run。当前 schema 的 binding 是 immutable，因此只能断言它不存在，不能推断它曾被清理；它也可能在 dispatch-intent mint 后从未完成 admission。
- open episode 的 `run_id` 是 NULL，因而走 durable unbound Lead-inbox 告警路径。

同一形状不是单例：现场所有 open/received launch episode 都是 NULL `run_id`，对应 run 均已完成。

## 当前代码路径

1. launch admission 在 `workflow_delivery_attempt.contract_ref_json` 写入 `{table:'workflow_execution_binding', pk:<execution>, runId:<run>}`。
2. `DeliveryProjector` 每个 maintenance tick 先运行；它应该用 source row、`contract_ref_json.runId` 或既有 episode attribution 找到 owning run，并在 run terminal 时 settle attempt、关闭 open episode。
3. `DeliveryContractWatch` 后运行；它只把仍为 `active` 的 candidate run 传给 `observeWorkflowDeliveryContract`。如果 projector 未先 settle，terminal run 会被降成 `runId=null`，watch 创建 unbound episode 并继续升级。
4. 当前分支已经包含 FLY-2278 的 terminal-run projector fallback 和 `session_started` 时即时 settle。生产 `deployed-sha` 仍是 `31da17817`，早于该修复；当前 HEAD 是 `3fcb03f56`。

## 必须成立的结果

- completed/terminated run 名下的 launch attempt 在 watch 前被 settle，已有 open episode 被关闭为 terminal settlement。
- binding 从未创建或 session 已被清理都不能阻止收口；durable `contract_ref_json.runId` 是 authoritative fallback。
- 同一 tick 的 watch 不得为该 attempt 新开 warning/severe，也不得调用 unbound alert route。
- active run 的真正 launch stall 仍保持现有监控行为。
- 不修改生产数据库，不新增依赖，不扩展 delivery family 或 alert schema。

## 假设与边界

- 本单修复代码账本生命周期，不负责部署，也不直接清理现场 7 条 episode；部署后的 projector convergence 承担历史收口。
- `workflow_run.status in ('completed','terminated')` 是本路径现有 terminal 定义；本单不重定义 run 状态机。
- 如果当前 HEAD 已满足完整现场形状，按 Ponytail/YAGNI 不再叠加重复生产分支，只补精确回归覆盖和可执行证据。
- FLY-2115 那条 active/granted launch episode 属于另一问题，不纳入本单。

## 待调研

- 用当前 HEAD 对 live DB 副本运行真实 projector→watch 顺序，确认历史 NULL-run episode 会闭合且不会新增告警。
- 现有 launch terminal 测试是否覆盖 binding/session 已清理的现场形状。
- 若现有代码仍漏收口，再选择最小改动：优先复用 `contract_ref_json.runId`，不增加新表、迁移或 helper。
