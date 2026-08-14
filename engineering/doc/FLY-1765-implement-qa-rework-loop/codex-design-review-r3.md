# Design Review — plan.md (FLY-1765) (Round 3)
Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的三个 blocker 已被实质关闭：两腿式 park 结算现在匹配真实 land 顺序；受控 close 已具备 mandatory mutation-time authority fence；research/exploration 对 land authority、FLY-1269 resident controller 和失败边界的主线也已修正。方案整体与现有架构兼容，终态免疫、FLY-1731 gate authority 和既有退避/告警约束均得以保留。

但在实现前仍有一个会直接破坏 park 结算的事件幂等键缺口，以及 evidence chain 中两处事实矛盾。尤其是前者：现有 admission 已为同一 activation 写入 `engine-park-clear:<activationId>`，而 park event appender 遇到重复 `event_id` 会直接返回旧行且不核对 payload。计划若把新的 deterministic `park_cleared` 也按 activation 单独定键，可能静默复用 open 之前的 clear，导致 open 仍是最新 generation，CommDB/evidence 永远不清。因此本轮结论仍为 CHANGES REQUESTED。

## What's Good (Keep)

- 保留 §2.2 的两腿式事务内 helper。源码中的真实顺序确为 `landExecutor.finalize` → `runResumablePostShipFinalization` → `finalizeWorkflowPhaseRoles`/`closeRunner({finalizeDone:true})` → `completeWorkflowLandNode`；“仍为 `ship_parked` 时完整结算、已合法进入不可逆终态时只清 ledger”准确覆盖了这两种顺序，同时避免重写 terminal timestamp/revision。
- 保留 production-order test 14。它穿过 `executeLandOperation`/finalizer 再进入 land completion，并同时断言 StateStore latest event、CommDB projection、current park evidence 和 session terminal state，比单独调用 helper 的测试更能防止接线顺序回归。
- 保留 §3 的五元组 fence `{requestId, ownerId, generation, routeRevision, executionId}`、mandatory `closeRunner.authorityCheck`，以及 pre/post phase-shutdown、pre-kill 的重复检查。30 秒 phase shutdown 与 30 秒 lease 并存时，以 fencing token 而非 wall-clock expiry 判权，既不会系统性误杀当前 owner，也能让 generation takeover 使旧 callback 在下一检查点失败。
- 保留 stale-owner `releaseRetryable` 失败后交给新 owner 收敛的规则；不要把 authority loss 误记成 delivery failure 或错误地进入 hold。
- 保留 `land + creates_pr + needs_review` 的窄 predicate、`terminal_no_gate` receipt、不开放终态复活边、runner_ship 隔离和 FLY-1269 真机回归 stop-release 门槛。这些均符合既有模式和 founder 的无新 flag 约束。

## Issues & Recommendations

1. **为 settlement `park_cleared` 明确定义“每个 open generation 唯一”的 event ID；不能只说 deterministic。**

   **为什么重要：** `appendWorkflowEngineParkEventTx` 在 `StateStore.ts:12136-12152` 发现相同 `event_id` 时直接返回旧 event，不验证 event type、generation 或 activation tuple。与此同时，generalized admission 已在 `StateStore.ts:23608-23618` 为 activation 写入 `engine-park-clear:${activationId}`，而 completion 随后会在 `StateStore.ts:26614-26625` 为同一 activation 写入 open。实际序列可以是 `admission clear(A) → completion open(A) → terminal settlement clear(A)`。若新 helper 复用按 activation 命名的 clear ID，第三步会静默命中第一步，未产生高于 open 的 generation；CommDB 也只接受更高 generation 的投影，因此 latest park 仍为 open。attempt N+1 的 wake/re-park 环会稳定触发这一形态。

   **建议修复：** 在计划中钉死 canonical identity，以被结算的 open row/generation 为基础，例如 `engine-park-settle:<executionId>:<openGeneration>`（或等价的 open-event stable ID），而不是仅用 activation ID；同一 open 不应因 `cause` 不同生成多个 clear。完整结算腿、terminal ledger-only 腿和 replacement 事务内 supersession 都复用同一规则。若该 ID 已存在，应校验其 run/execution/node/attempt/activation/open-generation/reason tuple 与预期完全一致，否则 fail closed，不可像通用 appender 一样把 payload 冲突当幂等成功。测试应从真实序列开始：先存在 admission clear，再产生 completion open，再 settlement；断言新增一个更高 generation 的 clear、CommDB/evidence 被清、重放不新增 event。另加 attempt N+1 再次 open/clear，证明每个 open generation 各自唯一。

2. **清理 evidence chain 中仍与已接受结论矛盾的表述。**

   **为什么重要：** `exploration.md:53` 仍称 #795 后 gate authority “变成 `engine_terminal`”，但 `resolveWorkflowGateAuthority` 对 land manifest 的 early return 是 `mode: "land"`，research §2 和 v3 plan 已按此修正。`research.md:45` 又称 receipt 表明“engine handoff”，而受影响路径实际 receipt 是 `terminal_no_gate`；它只记录未打开 gate，不能作为 handoff 证据。两处都位于本 issue 的完整 evidence chain，会让实现者重新选择 Round 1 已证伪的 predicate 或误改 FLY-1731 receipt 语义。计划头仍标为“v2（折入 R1）”，也未反映本轮已折入 R2 的版本状态。

   **建议修复：** 把 exploration 的该句改为 land authority 进入 generalized completion 的 else branch；把 research 的 receipt 描述改为“`terminal_no_gate` 如实记录未开 gate，rework 可达性缺口来自 session 被投影为 completed”，不要称 engine handoff。同步更新 plan 版本/修订说明，使 Round 3 文档集合自洽。完成后做一次针对 `engine_terminal`、`engine handoff`、`unverified` 和旧 contingency 措辞的定向扫描，保留只适用于其他路径的合法命中并明确其范围。

## Verdict

CHANGES REQUESTED — address items above
