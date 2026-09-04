# FLY-2313 pending closeout 收账解耦 — 设计修正
Issue: FLY-2313 (https://linear.app/geoforge3d/issue/FLY-2313/病根-closeout-只在杀窗成功时才收-commdb-账而-pending-占位窗口按设计永远杀不掉-merge-后-thread)
日期: 2026-09-03
基于: plan.md

## 为什么修正

Code review R1 的 blocking finding
`commdb-terminal-status-is-not-death-proof` 证实，原计划把两个不同结论混成了一个：

1. terminal CommDB 行可以结束 gate/ask 等通信义务；
2. `sessions` 身份行可以删除。

`completed | timeout | failed` 加 `ended_at` 只支持第一个结论。它不证明进程已经死亡；特别是
`:pending` 常态可能是 pane 已退出但 app-server 仍活。`CommDB.finalizeSession()` 除了退休通信义务，
还会删除 `sessions` 行中的唯一 tmux target。若在 kill 失败、probe indeterminate 时调用它，下一次
closeout 会把这次删除误读成 `alreadyGone`，并永久失去后续清理活进程的目标。

Lead 在问题 gate `25ee5d2e-701f-456b-8975-e6ed3bc4c8ff` 推翻此前关于这一点的裁定，并授权本
设计修正。已通过的 `plan.md` 保持冻结，不回写。

## 修正后的硬不变量

**死亡未被证明时，不许删除 `sessions` 行。**

- `killTmuxWindow().killed === true`：沿用完整 finalizer，退休通信义务并删除身份行；正常 JSON
  合同不变。
- 非 pending target 的 probe 明确返回 `absent | dead_pin`：这是正向死亡证据，可以走完整
  finalizer。finalizer 前的现有 authority 复查仍保留。
- 只有 terminal CommDB evidence、probe 为 `indeterminate`，或 target 为 `:pending`：只退休
  gate/aged ask/receipt wake/shutdown-control 等通信收尾义务，`deletedSessionCount = 0`，保留
  `sessions.tmux_window` 身份。明确 `alive` 仍然否决全部 finalization。
- ledger-only transaction 同时复查 terminal lifecycle evidence，并以调用前取得的 exact
  `tmux_window` 做 CAS；任一 evidence/target 已改变时 fail closed，不退休通信义务。CAS 只防漂移，
  不把 TURN-free 或名字当作死亡证明。
- `closeRunner` 仍返回 `closed:false, physicalGone:false`；post-ship 可凭
  `commDbFinalized:true` 完成通信 closeout，而 lifecycle 的下一 tick 仍能从保留的 session 行看到
  pending target，不会因删除行误报 `alreadyGone`。

## 有界改动

- `packages/flywheel-comm/src/db.ts`：增加保留身份的通信 finalization transaction 与 exact-target
  CAS；完整 `finalizeSession()` 合同不变。
- `packages/flywheel-comm/src/__tests__/db.fly1238.test.ts`：先红后绿证明 gate 退休、身份/target 保留及
  target-changed 零写。
- `packages/teamlead/src/bridge/commdb-session-prune.ts` 及其测试：增加有类型的 ledger-only wrapper。
- `packages/teamlead/src/bridge/close-runner.ts` 及其测试：按是否有正向死亡证据选择完整或 ledger-only
  finalizer；保留 authority、archive、physicalGone 与 typed-cause 边界。

不增加表、守护、开关或重试策略；不修 pending 身份为何未注册；不修改 post-ship/post-merge 的行为。
reviewer 的 durable-marker MEDIUM 不另建新状态：本轮直接保留权威 session/target 行，避免产生需要
marker 才能解释的删除。

## 存量生产样本的验收结论

Lead 在 2026-09-04 提供了三条未被手工改写的存量样本：FLY-2152（timeout）、FLY-2166
（completed）、FLY-2169（completed）。三者的 PR 已于 2026-08-30 merge，Linear 已 Done，
CommDB target 仍为 `runner-flywheel:pending`，land operation 均停在
`partial | issue_closeout_incomplete:cause=unknown`。

本修正落地后，对三者再次调用同一正规 `close_runner(done=true)` 会进入相同的 ledger-only
路径：terminal evidence 与 exact pending target 在事务内复核通过，通信义务被退休；但结果仍为
`closed:false, physicalGone:false`，`sessions` 身份行仍保留。由于本单按批准边界不修改
post-merge 的 non-strict physical-gone 判据，现有 land operation 不会仅凭这次改动自行收敛；重试时
至少会从 `cause=unknown` 改为可诊断的 `cause=window_identity_pending`。

这三条存量需要另一张有界 remediation：先物化/恢复可验证的真实 target，或以其他正向证据证明
进程已死亡，再由完整 finalizer 删除身份行并完成 land closeout。不能把 pending 名字、terminal status
或 founder 清理意图当成死亡证明，本单也不加入手工硬拨。
