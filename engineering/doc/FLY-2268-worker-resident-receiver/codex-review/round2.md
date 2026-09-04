# Design Review — plan.md (Round 2)

Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已正确闭合 receiver 候选集/初次武装、drain 与 completion 原子提交、expiry canonical identity、`phaseKeepAlive` 主要消费者以及 shutdown exact-request 合同，且没有重开 Lead 已裁定的 M3 架构。当前仍有三个会破坏升级或重启验收的阻断点：legacy snapshot 的第二层 digest 仍不兼容、异步备份无法按所写方式嵌入同步 CommDB 构造迁移、reown 使用的单数 binding getter 不支持同一 actor 的多 activation；turn barrier 也尚未落到一个真正可等待的通知链路，因此暂不宜进入实现。

## What's Good (Keep)

- R1#1 的修正方向正确：receiver 资格不再依赖 `sessions.phase_keep_alive`，初次 arm 绑定 `waitForWorkflowLaunchOutcome`，registration 竞态由 `pending_registration` rider 收敛；这与现有 launch receipt 边界相符。
- R1#3 已把 challenge CAS 放进 `commitEnrolledCompletion` 的主事务，并在 event route 先剥离 `drainReceipt`；这消除了 receipt 已消费而 completion 未提交的崩溃窗，同时保留现有 completion 幂等快路径。
- R1#6/#7 的 consumer 与 identity 清单基本完整：prompt 改读 `ctx.sessionRole`、lifecycle 去 role、expiry digest 绑定 run/execution/activation/node/attempt/revision，并为 poison collision 规定 fail-loud。
- R5#3/#5 仍然闭合：shutdown exact read、退出时 ACK 全部 pending、failed set-once settlement、caller sweep，以及新 belt 首次 generation=1 均有明确测试合同。
- resident hold revision、expiry 四段 saga、Claude pane ACK、drain 七个负例和任意节点名通用性守卫均保持父单机制，没有新增表、flag 或告警前缀。
- M3-1 先于 M3-2、回滚时先退 Bridge/runtime 再恢复 CommDB 的总体顺序正确；下面的问题修正后仍可保留这个两阶段边界。

## Issues & Recommendations

1. **[BLOCKER] legacy 非空 `phaseRole` 仍会被未放行的 `capabilityDigest` 比较拒绝，A3(j) 的测试值本身也不是合法旧 snapshot。** §8.4 只放行直接的 `phaseRole` 字段比较，却要求 digest 继续严格；现有 digest 对象本身包含 `phaseRole: ctx.phaseKeepAlive?.role ?? null`。新 context 删除 role 后会算出 `null`，因此旧 snapshot 以 `implement` 等值计算并持久化的 digest 必然与新 context 不同，仍会在 reown 时报 immutable snapshot drift。A3(j) 所写的 `phaseRole='x'` 又会先被当前 parser 拒绝，无法覆盖这个真实路径。建议保留算法和键集合，但在 recovery verifier 中用 snapshot 已校验的 legacy `phaseRole` 只重建 digest 输入；该值不得参与 loop eligibility。测试改用合法旧值（至少 `implement`），分别证明字段 mismatch 被单项忽略、legacy digest 相等、loop 资格只来自 authoritative activation + pinned snapshot。证据：`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:27,116`；`engineering/doc/FLY-2268-worker-resident-receiver/research.md:290-294`；`packages/claude-runner/src/CodexTmuxAdapter.ts:316-324,413-426,920-935`。

2. **[BLOCKER] 所写的 migration preflight 无法调用并等待现有 `backupCommDb`，而“Bridge 未服务即无并发写”的冻结假设不成立。** `CommDB` 构造器与 `applyMigrations()` 是同步路径，并在同步 `BEGIN IMMEDIATE` 中执行；`backupCommDb` 返回 `Promise<string>` 且内部 `await source.backup(...)`。把它“接进构造器”会得到一个未等待的 Promise，不能在备份及 `quick_check` 完成后再重建；若把构造器整体改 async，则当前大量 `new CommDB(...)` caller 都需要迁移。并且 runner、CLI、gateway 都能直接打开并写同一 CommDB，停 Bridge 并不能冻结 backup→rebuild 间隙，回滚到该备份会丢掉间隙内已提交写。建议把备份做成 M3-1 启动前的显式、可等待 deployment preflight：冻结所有 CommDB writers，`await backupCommDb`、校验并持久记录 receipt 后，才允许唯一 migration owner 打开新 schema；或明确引入 async open factory 并完成所有 production caller sweep。恢复步骤也应包含 sidecar 清理、原子替换、恢复后 `quick_check`，而不只是占位式 `cp`。证据：`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:64-67,105-115,135`；`engineering/doc/FLY-2268-worker-resident-receiver/research.md:296-297`；`packages/flywheel-comm/src/db.ts:1043-1085`；`packages/flywheel-comm/src/mailbox-migration.ts:1287-1317`；`packages/claude-runner/src/CodexTmuxAdapter.ts:2280-2303`；`packages/flywheel-comm/src/commands/complete.ts:265`；`packages/teamlead/src/lead-backends/codex/gateway/gateway-main.ts:566-586`。

3. **[BLOCKER] reown 指定的 `getWorkflowExecutionBinding(executionId)` 在本计划要求的第二次 park/wake 后会返回 `undefined`。** binding 表以 activation 为主键，同一 physical execution 每次 wake/replacement 都会追加 immutable binding；当前单数 getter明确在行数不等于 1 时 fail-closed 返回 `undefined`。因此同一 execution 完成 spawn→wake 后，§8.4 会把它误当成“无 binding”，丢掉 loop eligibility，直接破坏 revision 1→2 后的 mid-grace restart/adopt。建议：resident adopt 优先用 `workflow_resident_hold.activation_id` 调 exact `getWorkflowActivation` 并逐字段核对 hold；其他 active reown 使用现有 `resolveCurrentWorkflowActivation`，对 `ambiguous` 明确 fail-closed，不能退化成 non-loop。receiver eligibility 同样应按 current/exact activation 判定。新增同一 execution 同时有 spawn 与 wake 两条 binding、在 r=2 resident 中重启的回放。证据：`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:23,27`；`engineering/doc/FLY-2268-worker-resident-receiver/research.md:293-294`；`packages/teamlead/src/StateStore.ts:29101-29112,29229-29260,32180-32194,32515-32577`。

4. **[HIGH] “awaited turn barrier” 还没有对应当前同步 notification API 的可执行接入方案。** 现有 `CodexDaemonEvents.onNotification` 返回 `void`，`handleFrame` 和 `runGoalToTerminal` 都同步调用它；仅把 callback 写成 `async` 会丢弃 Promise，terminal settlement、phase hold 或下一次 wake 仍可越过失败中的 CommDB 写。计划还把 `TURN_BARRIER_RETRY_MS` 归在 teamlead 的 resident/supervisor 文件，而实际边界循环位于 `flywheel-claude-runner`，后者不能反向依赖 teamlead。建议在 runner 内明确一条按 notification 顺序串行的 barrier queue/latched failure，并在 terminal settlement、`enterPhaseHold`、`reactivateWake`、任何新 `startTurn` 及最终 return 前统一 await；60 秒总预算耗尽后从该 await 点抛 `GoalRunError(..., 'setup_failed')`。reown 的 `thread/read` 结果也应有严格 parser，而不是直接从 `unknown` 猜最后一 turn。用真实 `handleFrame → onNotification` 路径测试延迟/拒绝 Promise，证明 hold、push、下一 turn 与 terminal 均未提前发生。证据：`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:23,37,131`；`engineering/doc/FLY-2268-worker-resident-receiver/research.md:280-284`；`packages/claude-runner/src/codex-daemon-client.ts:196-202,248-310,840-856,1007-1024,1243-1269,1486-1593`；`packages/claude-runner/package.json:21-32`；`packages/teamlead/package.json:54-66`。

5. **[MEDIUM] Round-2 的机器守卫文字仍彼此矛盾，按字面无法实现。** A7(d) 已正确改为本单 construction-site allowlist，但 §5.9 仍要求“全仓恰好三个”；A7(e) 又声称相关源码不能出现 `RESIDENT_GRACE_MS` 以外的期限值，而同一计划明确要求 `RECEIVER_STALL_MS`、heartbeat interval 和 turn-barrier timeout，§5.9 的期限 allowlist 还漏了后两者。建议删除旧的全仓断言，并把期限守卫改成逐文件 named-constant allowlist：禁止 raw duration literals 与 `process.env`，允许且只允许 §1 列出的四个常量出现在其真实 owner 文件。证据：`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:29,37,129`；`engineering/doc/FLY-2268-worker-resident-receiver/research.md:318-319`；`packages/teamlead/src/__tests__/fly2248-mechanism-guards.test.ts:25-52`。

6. **[LOW] authoritative 文本仍残留已撤销的 R1 机制名和一个未登记事件，容易让实现分叉。** M3-2 的落点段仍逐字列出 `'<legacy>'` sentinel 和 capabilityDigest key replacement，M3-1 顺序又把 shutdown rebuild 写了两次；§8 虽声明覆盖，执行清单仍不应保留相反动作。另有 `turn_barrier_failed` 只出现在 research，未列入 §1 的 run/session event kinds，也没有 UID/owner；若它只是诊断应复用现有日志，若确需持久事件则先在稳定标识中定义且不得新增 alert surface。建议清掉这些 stale/重复项，使 plan 本身无需依赖读者人工套用 override。证据：`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:53,66,86`；`engineering/doc/FLY-2268-worker-resident-receiver/research.md:281,290-294`。

## Verdict

CHANGES REQUESTED — address items above
