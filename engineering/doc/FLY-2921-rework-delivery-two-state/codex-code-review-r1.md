# Code Review — FLY-2921 (Round 1)

Status: CHANGES REQUESTED

Reviewed head: `e604d2c7aa2af83114ea957fc5a9b9ae2fe0f822`，基线 `352beecbd`。按指定实现范围对照 R4 plan 和 implementation notes 审查，接受 FLY-2919 未合入时的已批准 fallback。以下 3 项均为 **[verified by reading code]**；未运行测试，未修改实现文件。

1. **MAJOR — 返工 TURN wake 仍能通过通用 freeze 路径把整条 run 置为 `held`**

   **证据：** [turn-wake.ts:20](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/delivery-contract/sources/turn-wake.ts:20) 将 `sent`、未 ACK、`push_count >= 2` 的 wake 识别为 `three_stage_turn_stuck`；[watch.ts:263](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/delivery-contract/watch.ts:263) 不区分 rework purpose，直接调用 `freezeWorkflowDelivery`。阈值为 [policy.ts:13](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/delivery-contract/policy.ts:13) 的 20 分钟；最终 [StateStore.ts:57469](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:57469) 无 rework 豁免地执行 `UPDATE workflow_run SET status = 'held'`。

   **失败场景：** 返工 wake 已推送两次但未签收，session 仍记为 `running`，heartbeat/activity/outbound 信号过期。`shouldFreeze` 接受这种“账面存活、活性无法确认”的组合。20 分钟后 watch 冻结 run；协调器随后在 [workflow-rework-coordinator.ts:1030](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/workflow-rework-coordinator.ts:1030) 只释放 claim，无法继续执行已批准的未知活性计时及 delivery 交还流程。新增的 `holdUndeliverableTx` 分流拦不到这条入口。这是 `turn_wake`，不属于计划排除的 `phase_wake` 边界。

   **建议修复：** 在 freeze 的事务入口复核 projected rework wake 身份，将其交回 rework coordinator，禁止生成 run 级 freeze；保留协调器既定的等待、告警及交还策略。补覆盖真实 rework TURN wake 两次推送、无 ACK、活性未知超过 20 分钟的回归。

2. **MAJOR — Lead 重投已准入的停滞替身后，取消失败会永久 defer，无法重新交还 Lead**

   **证据：** [workflow-rework-coordinator.ts:848](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/workflow-rework-coordinator.ts:848) 的 C2(b) 对 `engine:hold_resume` + 已准入 `intent_recorded` 无条件走 30 秒 defer，绕过下面的超时失败计数。[workflow-engine-dispatcher.ts:1742](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:1742) 遇到残留 launch marker、窗口身份不完整或外部证据未知时只调用 escalation 并继续。该 escalation 的 UID 在 [StateStore.ts:41525](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:41525) 按 run/node/attempt/execution 固定；[StateStore.ts:41564](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:41564) 发现旧事件便返回，早于失败预算结算。

   **失败场景：** 替身准入后崩溃，ledger 留在 `intent_recorded`，且 marker 残留。首次由普通 stall 分支耗尽预算交还 Lead；Lead resume 关闭旧门、清零预算、保留同一执行体。此后 coordinator 永远 defer，dispatcher 永远命中旧 escalation 的幂等返回。即便此前没有 escalation，也至多再计一次失败。run 保持 active，却既无进展，也不会重新生成 `returned_to_lead` 门。

   **建议修复：** 给 C2(b) 的取消等待加有界失败结算，超过启动阈值后按当前 route/claim 消耗预算并交还 Lead；不能把一次性的 dispatcher 审计去重当作持续重试预算。仍须等到精确取消/回滚证明才换体。补测同一执行体在 Lead resume 前后持续无法完成 cancellation 的完整 tick 链路。

3. **MAJOR — `/rework` 拒绝新请求时会提交旧返工的清理与关门操作**

   **证据：** [StateStore.ts:54318](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:54318) 起先撤销旧 activation 凭据、将旧 target 置为 `superseded`、作废 verification path，并在 [StateStore.ts:54361](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:54361) 关闭旧 Lead 门。之后 [StateStore.ts:54424](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:54424) 的 actor-history 校验以及 base 校验仍可能以 `result = { ok: false }; return` 拒绝。事务包装 [StateStore.ts:53874](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:53874) 仅在抛异常时回滚，正常 return 会提交上述修改。

   **失败场景：** active run 有一条 `returned_to_lead` 返工，Lead 用 `/rework` 改投 snapshot 内合法、但从未执行过的另一个 dispatch 节点。目标解析成功，旧返工先被清理关门，随后因 `target_actor_history_missing` 拒绝；新 request 没有创建，旧 request 仍为 `returned_to_lead`，但凭据、节点预留和恢复门已失效。用户收到失败响应，却丢失了原来可恢复的状态。`base_revision_unavailable` 等后置拒绝同样受影响。

   **建议修复：** 将所有可能拒绝的新请求校验移到清理前；凡清理后的拒绝均抛出 `OperatorReworkRejected`，确保整笔事务回滚。补测 `/rework` 返回失败后，旧 delivery、凭据、node、verification path 和 hold 均保持原样。
