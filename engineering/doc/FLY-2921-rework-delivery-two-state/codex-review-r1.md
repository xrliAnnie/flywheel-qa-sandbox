# Design Review — plan.md (Round 1)

Date: 2026-09-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

五态收敛、delivery 作用域恢复门和替身事务的总体方向可行，计划也已覆盖此前关闭的死亡证明、准入前身份、wake 复位 `busy` 和巡检游标问题。仍有两处需要补齐：独立的 TURN 停滞冻结路径会绕过 C4；Lead 重投未准入替身时，计划依赖的取消原语无法接受该节点状态。此次以 `d52df7841cb7f7844ee83e37159987840a4c50ac` 做静态源码核验，未修改主仓、未运行测试，也未复查生产数据或后续实现。

## What's Good (Keep)

- 将投递失败与 run 状态分离，复用已有 hold 恢复协议；保留目标预留，避免重投时失去准入条件。
- 换体事务使用 owner/generation、路由与执行体身份围栏；2919 合入前限制死亡证据来源，明确保留已接受的 fail-closed 边界。
- 保持 wake 身份，补齐复位幂等性及全部调用方的 `busy` 分支；换体、重投事件 UID 按路由版本区分。
- 迁移同时修旧迁移跳过条件，held run 不额外生成第二扇门；回滚要求停服、旧 CHECK 重建及往返验证，边界交代清楚。
- 交卷校验使用服务端 head，区分确定无产品变更与 diff 无法核验，并要求事务回滚后的拒绝审计和真实 event-route 回归。

## Issues & Recommendations

以下源码位置均属于上述固定基线。

1. **BLOCKER — C4 漏掉 `three_stage_turn_stuck → freezeWorkflowDelivery`，返工仍会冻结整条 run。**

   **触发与影响：** 返工 wake 已成功推送，巡检完成第二次推送，但仍未收到 ACK；会话账面保持 `running`，心跳/活动时间缺失或过旧、没有近期出站消息。首次推送满 20 分钟后，投递合同会走独立的冻结分支，将 run 置为 `held`。这不经过 `holdUndeliverableTx`，所以 C4.3 删除返工 `stateNativeUndeliverable` 条件、C4.4 排除返工 undeliverable 都拦不住。协调器随后按 C2.1 对非 active run 只释放，C2.5 预定的两小时交还 Lead 也无法继续，违反 §6.1 不变式 2。

   **证据：** `packages/teamlead/src/bridge/delivery-contract/sources/turn-wake.ts:20-29` 对 `sent + push_count >= 2 + acked_at IS NULL` 返回 `three_stage_turn_stuck`，没有排除 `workflow_rework`；`packages/teamlead/src/bridge/delivery-contract/watch.ts:268-306` 将该形状直接交给 `freezeWorkflowDelivery`；`packages/teamlead/src/bridge/delivery-contract/policy.ts:13` 的阈值为 20 分钟；`packages/teamlead/src/bridge/hold-writers.ts:11-19` 在会话账面活跃且活动活性不是 `alive` 时允许冻结；`packages/teamlead/src/StateStore.ts:57055-57068` 写入 run held 和该 hold 事件。这里的活性来自活动时间与消息（`packages/teamlead/src/bridge/delivery-contract/liveness.ts:15-27`），并非协调器的受信进程证据。

   **建议：** C4 显式覆盖 TURN 停滞冻结入口，并在 StateStore 的最终冻结写入前增加返工归属守卫。复用 C4.4 的精确 wake/activation/request 归属判定，将返工 wake 留给协调器处理；保留非返工 TURN 与其他家族的既有策略。已发且活着继续等待，未知按 C2.5 计时告警及交还，不增加新的截止策略。§8 增加真实 CommDB + delivery-contract watch 回归：两次推送、无 ACK、账面 running、活动证据未知/过旧，跨过 20 分钟仍无 run 级 hold；未知持续两小时后由协调器结算 `returned_to_lead`，run 仍 active。仅 grep 返工函数中的 held 写入无法发现这个通用入口。

2. **MAJOR — C2 第 3 步 b 复用的启动取消围栏不支持准入前替身，缺少到 `abandoned` 的实际转换。**

   **触发与影响：** 替身 dispatch intent 已持久化，但被额度或容量挡在准入前，节点仍 `pending`、没有 execution binding；按动作表 e 耗尽后交还 Lead，再由 hold resume 追加路由版本。当前设计会优先命中 b，要求取消旧 intent、等待 `abandoned` 后再换体。然而基线取消围栏和回滚均拒绝这个状态，后台未启动对账也跳过它。因此不能靠所写的“现有启动取消围栏”完成重投：继续等待不会自动产生证明，计失败则再次交还；若让调度器直接启动旧 intent，又偏离了 b 要求的先取消再铸体流程。准入前身份识别本身已解决，此处是识别成功后的动作前置条件缺口。

   **证据：** `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:3181-3190` 在创建绑定前执行额度暂停/准入拒绝；`packages/teamlead/src/StateStore.ts:40946-40967` 的 `beginUnlaunchedWorkflowCancellation` 要求节点 `admitted` 且已有绑定，否则返回 `node_execution_not_admitted` 或 `execution_binding_mismatch`；`packages/teamlead/src/StateStore.ts:41130-41151` 的 `rollbackUnlaunchedWorkflowAdmission` 有相同要求；`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:1841-1849` 的后台恢复先跳过非 admitted 或无绑定节点。C4.1/C4.2 只修改 replacement 准入后的处理，没有补这个入口。

   **建议：** 将 b 拆成准入前与准入后两条明确路径。准入前增加窄事务：持有返工认领，复核精确 run/node/attempt/execution、路由版本及当前 `intent_recorded`，确认尚无准入/启动所有者与外部启动义务后，原子安装阻止后续准入/启动的取消围栏并将旧 intent 置 `abandoned`，随后复用现有换体核心；并发准入胜出时转入既有 admitted 取消流程。也可采用更简单的“尚未冻结 launch envelope 时保留该 intent、按新路由生成内容”方案，但必须明确其证明与竞争条件，不能继续假设现成原语支持 pending。§8 增加完整链路：准入前阻塞 → 耗尽 → Lead 重投 → 旧 intent 确定结算/安全复用 → 解除阻塞后唯一执行体收到当前路由内容；同时覆盖取消与准入竞争。

## Verdict

CHANGES REQUESTED — address items above
