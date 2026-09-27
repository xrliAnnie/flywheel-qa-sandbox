# Code Review — FLY-2921 (Round 2)

Status: CHANGES REQUESTED

审查基线：`352beecbd..32b601f77`，包括 R1 修复 `7c979fa51`。审查期间 HEAD 更新为 `cc9f859fa`，仅格式化测试，指定范围内的生产代码未变。R1 三项均已关闭；完整实现 diff 的补充复查发现下述 1 项 MAJOR。接受 implementation.md 中 Lead 批准的 FLY-2919 fallback 及设计决定。

以下结论均为 **[verified by reading code]**。已阅读新增回归测试，未运行测试；mutation-check 结果采用用户提供的说明。

**R1 逐项结论**

1. **R1-1：CLOSED。** [StateStore.ts:57349](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:57349) 在 `freezeRunTx` 的写入之前复核 rework ownership，并返回 `rework_wake_owned_by_coordinator`；非 rework 仍进入原 freeze 判定。回归覆盖 rework 无写入及 non-rework 仍冻结的对照，原来的 run 级 `held` 入口已封住。

2. **R1-2：CLOSED。** [workflow-rework-coordinator.ts:877](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/workflow-rework-coordinator.ts:877) 从 Lead-resume route 的 `created_at` 计算等待时间；超过 launch-stall threshold 后，以 `replacement_launch_stalled:awaiting_cancellation` 进入既有失败预算，耗尽后重新交还 Lead。该路径不会绕过 death proof 换体，dispatcher 的事件去重也不再造成永久 defer。

3. **R1-3：CLOSED。** [StateStore.ts:54383](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:54383) 起，旧返工清理后的各拒绝分支均抛出 `OperatorReworkRejected`；[StateStore.ts:53874](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:53874) 在事务回滚后才转换为拒绝结果。原来可提交清理、关门等部分修改的正常返回已消除；新增回归检查拒绝前后全表快照一致。

上述三处修复未发现新的已确认 BLOCKER/MAJOR。

**新增发现**

1. **MAJOR — Lead resume 的跨库崩溃窗口会永久取消仍需重投的 wake**

   **证据：** Lead resume 在 [StateStore.ts:59309](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:59309) 将 delivery 复位为 `pending`。协调器先在 [workflow-rework-coordinator.ts:1696](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/workflow-rework-coordinator.ts:1696) 调用 `rearmReworkWake`，之后才在该文件 [1723 行](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/workflow-rework-coordinator.ts:1723) 推进为 `turn_granted`。前一步已独立提交 CommDB，把 wake 的 `push_count` 清零并清空 claim、`last_push_result`（[db.ts:4257](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:4257)），使其立即可被 patrol claim。

   此时 [StateStore.ts:78608](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:78608) 只把 `turn_granted` 视为 active obligation；同一 activation 对应的 `pending` 会在 [78625 行](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/StateStore.ts:78625) 返回 `cancel/rework_obligation_settled`。[turn-wake-patrol.ts:96](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/teamlead/src/bridge/turn-wake-patrol.ts:96) 据此持久化取消。后续 `resumeTurnWakeHold` 对 `cancelled` 只返回 noop（[db.ts:4242](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/db.ts:4242)）；同 wake ID 的 enqueue 也只做幂等返回，投递最终报 `wake_cancelled`（[wake.ts:217](/Users/xiaorongli/Dev/flywheel-FLY-2921/packages/flywheel-comm/src/wake.ts:217)）。

   **失败场景：** 原 wake 两次推送未签收，delivery 已交还 Lead。Lead resume 后，bridge 在 CommDB rearm 提交完成、StateStore 推进之前崩溃。重启时 patrol 先处理这个 `push_count=0` 的 wake，将仍为 `pending` 的有效返工误判为已结束并取消。协调器随后恢复也无法唤醒同一 actor；再次 Lead resume 仍复用同一 wake ID，只会再次遇到 cancelled noop。即使 actor 已恢复正常，这条重投恢复路径也无法工作。耗尽 wake 的另一条巡检分支有取消原因白名单，但 rearm 已清零 push count，因此不受该保护。

   **建议修复：** 对身份和节点预留仍有效、可恢复的 `pending`／`returned_to_lead` rework，patrol 应返回 `wait`，保留 completed／superseded 等真正终结场景的取消语义；同时调整或加固 rearm 与 StateStore 推进的顺序，使中途崩溃可恢复，避免无条件复活已取消 wake。补充真实 StateStore＋CommDB 回归：在 rearm 提交后、推进前注入崩溃，执行 patrol，再恢复协调器，验证同一 wake ID／epoch 仍可成功重投。
