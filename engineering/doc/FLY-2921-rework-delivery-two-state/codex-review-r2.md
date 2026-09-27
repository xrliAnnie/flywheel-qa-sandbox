# Design Review — plan.md (Round 2)

Date: 2026-09-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

已复核提交 `74b67f3eea474f205106279d17c11736be1edb6b` 的计划修订，并对照源码基线 `d52df7841cb7f7844ee83e37159987840a4c50ac`：C4.7 可以关闭 R1 #1。R1 #2 已补齐准入前的状态转换，但仍缺少阻止旧执行体随后准入/启动的持久围栏，因此保留一项 MAJOR。此次仅审查两项修订及其直接影响，未修改主仓、未运行测试，也未重新打开已接受的兄弟单边界。

## What's Good (Keep)

- C4.7 在最终冻结事务读取 live attempt 后判断返工归属，覆盖独立的 `three_stage_turn_stuck` 入口；复用 C4.4 的归属判断，非返工策略保持原有行为。
- 新增真实 CommDB + watch 回归，同时验证 20 分钟不冻 run、未知持续两小时交还 Lead，以及非返工 TURN 对照组，能够直接验证 R1 #1。
- C2 b 明确区分准入前与准入后，限定 request claim、路由、执行体和 launch ordinal，并增加完整重投链路及准入先胜的竞争测试；这些约束应保留。

## Issues & Recommendations

1. **MAJOR — C2 b 的准入前事务只写 `abandoned`，尚未安装阻止后续准入/启动的取消围栏（R1 #2 未完全关闭）。**

   **问题与影响：** 新事务确认“此刻没有 binding / launch owner / session”，然后提交 ledger 的 `abandoned`，再进入换体核心；计划没有要求这两部分处于同一原子事务，也没有写入启动路径实际读取的取消围栏。在放弃事务已提交、换体尚未提交的窗口，旧执行体仍占有原节点的 `pending` 预留：迟到的旧准入调用仍可创建 binding 和 launch owner。这样，`launch_abandoned` 就不再足以证明该执行体不会启动。随后既有 admitted 取消流程又要求 ledger 为 `intent_recorded`，无法直接修复“已准入但 ledger 已 abandoned”的组合；继续把该 ledger 当死亡证明换体，则违反零双体不变式。当前新增测试仅明确覆盖“准入先胜”，没有覆盖相反顺序。

   **基线证据：** `packages/teamlead/src/StateStore.ts:47238-47255` 按节点预留判断准入，`47300-47328` 将节点改为 admitted 并创建 binding，没有把 dispatch ledger 的 `abandoned` 当拒绝条件。`41724-41736` 的 `recoverOrAcquireWorkflowLaunch` 检查的是 `workflow_launch_cancellation`，无 owner 时可在 `41807-41825` 创建 owner。最终 `fencedCommitWorkflowLaunch` 在 `42807-42825` 检查 cancellation 和当前 writer；writer 查询 `62635-62665` 同样不读取 ledger 的 abandoned 状态。基线取消协议在 `41035-41040` 持久化 cancellation；后续 `beginUnlaunchedWorkflowCancellation`（`40969-40983`）和 rollback（`41184-41198`）均要求 ledger 仍为 `intent_recorded`。因此，ledger CAS 不能替代取消围栏。

   **建议：** 在准入前窄事务中，将精确执行体的持久取消围栏与 `intent_recorded → abandoned`、attempt 结算一起提交，并让准入事务在创建 binding/凭据前拒绝该取消身份；已有 launch acquire/commit 可继续使用现成 cancellation 检查。另一种可行方案是明确把放弃与共享换体核心合成同一事务，使旧预留和旧意图一起失效，而不是留下可单独提交的中间状态。补测两个顺序：准入先胜时放弃被拒；放弃先胜时，刻意延后换体并重放旧准入/launch 请求，必须零旧启动、零可用旧凭据，再验证恢复后只有新执行体收到当前路由内容。

## Verdict

CHANGES REQUESTED — address items above
