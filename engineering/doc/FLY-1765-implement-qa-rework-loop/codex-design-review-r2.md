# Design Review — plan.md (FLY-1765) (Round 2)
Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 已实质关闭 Round 1 的五个方向性问题：真实 `land` predicate、`terminal_no_gate` receipt、FLY-1731 authority sentinel、受控收体后再走 proven-dead replacement、replacement 同事务清 park，以及 FLY-1269 resident-controller 验收边界都已改正。本轮没有恢复已关闭的旧 finding；但沿新方案的真实调用顺序继续核对后，发现两个新的实现级阻塞：(1) land finalizer 会在 `completeWorkflowLandNode` 之前先把 implement session 变成 `completed`，而 helper 只接受 `ship_parked`，因此最终 `park_cleared` 不会落账；(2) controlled `closeRunner` 尚未把 rework owner/generation 接进现成的 mutation-time `authorityCheck`，30 秒 claim 与最长 30 秒 phase-shutdown 也没有续租/过期语义。另需同步 research.md 中仍与 v2 和源码相冲突的旧结论。结论仍为 `CHANGES REQUESTED`。

## What's Good (Keep)

- R1-1 已关闭：Fix 1 改为真实 compiled `tpl_code` 使用的 `mode: "land"`，首个红测要求使用真实 menu snapshot；receipt 保持 `terminal_no_gate`，并增加 parked implement 永不取得 holder/carrier/approval authority 的 FLY-1731 sentinel。
- R1-2 的核心安全问题已关闭：不再把 live terminal actor 伪装成 dead；先受控关闭、下一轮由 registered/persisted/host probe 给出真实死亡证据，再复用 FLY-1718 materialize，是正确方向。
- R1-3/R1-4 的台账词汇、writer matrix、activation/generation CAS、lifecycle revision、runner_ship reason 隔离，以及把 superseded park 清算并入 `materializeWorkflowReworkReplacement` 同一事务，均应保留。
- generalized implement 的 phase-role 接线本身成立：dispatcher 对 phase node 传 `sessionRole=implement` 和 `shareParentBranch=true`（`workflow-engine-dispatcher.ts:2454-2465`），Blueprint 持久化 `chatThreadRole=implement`（`Blueprint.ts:998-1003`），所以 `getPhaseSessionsForIssue`/post-ship finalizer 能发现它。
- R1-5 已关闭：计划把 FLY-1269 当既有能力做定向真机回归，并把 alive-but-nonconsuming 明确定义为停发条件，不再扩 daemon scope 或声称 Fix 2 自动兜底。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **真实 land 顺序会让 `settleReworkParksForRunTx` 错过最终 open park。**

   **Why it matters:** 计划 §2.2 规定 helper “仅当 session 仍 `ship_parked`”才投 `completed` 并写 `park_cleared`（plan.md:55-56），同时把 land writer 的 helper 定位成 finalizer 后的兜底（`:62`）。实际顺序相反于该假设：dispatcher 先 `await landExecutor(...)`，只有它返回 completed 后才调用 `completeWorkflowLandNode`（`workflow-engine-dispatcher.ts:2039-2092`）；land executor 在返回前先执行 `deps.finalize`（`land-executor.ts:431-475`）；该 finalize 进入 `runResumablePostShipFinalization`，其中 `finalizeWorkflowPhaseRoles` 对 `ship_parked` implement 调 `closeRunner({finalizeDone:true})`（`post-ship-finalization.ts:721-738`、`:445-487`），先经 FSM 把 session 改成 `completed`。随后 `completeWorkflowLandNode` 才运行 helper，此时“仅接受 ship_parked”的 CAS 必然 no-op。`closeRunner`/FSM 不会追加 `workflow_engine_park_outbox.park_cleared`；而 `getCurrentWorkflowEngineParkEvidence` 只核 current activation 和最新 event，不检查 session status（`StateStore.ts:12223-12252`），所以 StateStore/CommDB 仍会保留 exact-current 的 open park，违反 §6 对“无残留 park”的验收并可能继续授权 park veto/wake evidence。

   **Suggested fix:** 把 helper 的“状态结算”和“park ledger 结算”拆开但仍留在一个 StateStore 事务：若 exact run/node/attempt/activation/latest-open-generation 的 session 是 `ship_parked`，执行现有 completed + terminal stamp + lifecycle bump + clear；若它已被现有 finalizer合法投成不可逆终态（至少 `completed`），不重写状态/时间戳/revision，但仍对同一 exact activation 追加 deterministic `park_cleared`；activation/identity 已变化、session 仍是 active 非停驻态或 reason 非 `rework_reachable_wait` 才 fail closed/no-op。相应修改测试 4 中笼统的“状态已变 no-op”，增加“finalizer 已先 completed → ledger-only clear”；测试 13 必须按生产顺序跑 `executeLandOperation/finalize → completeWorkflowLandNode`，最终同时断言 StateStore 最新 event=`park_cleared`、CommDB projection=`cleared`、`getCurrentWorkflowEngineParkEvidence` 为空。也可选择让 post-ship finalizer显式清 ledger，但必须写清持久重放与失败恢复，不能依赖其当前 `closeRunner` 自动完成。

2. **controlled supersession 只有“持有 claim”的叙述，尚未形成 mutation-time fence。**

   **Why it matters:** coordinator 当前 claim 默认只有 30 秒（`workflow-rework-coordinator.ts:213-235`、`:285-291`），而 resident Codex phase shutdown 的默认 ack timeout 本身也是 30 秒（`codex-phase-shutdown.ts:23-25`、`:158-169`），还未计入前置 probe/worktree 检查和后续清理。`closeRunner.authorityCheck` 是 optional；未传时只依赖 caller 的一次前置判断，而传入后才会在 phase shutdown 前后、MCP reap、cmux/tmux kill 等慢边界 fail closed（`close-runner.ts:140-148`、`:405-477`、`:574-669`）。v2 §3 只说“在本次 rework claim 内”调用 closeRunner（plan.md:84-89），改动清单也只写 effects 注入（`:101-102`），没有定义 authority callback、claim takeover/route revision 变化时的谓词，也没有处理 shutdown 等待期间 lease 到期。这样 stale generation 仍可在失去 delivery authority 后继续关闭 actor；反过来，如果 callback 直接要求 lease 未过期，30 秒 shutdown 后又会系统性在 post-shutdown check 失败。

   **Suggested fix:** 在计划中明确 effects seam 接收稳定的 `{requestId, ownerId, generation, routeRevision, executionId}`，并把 `closeRunner.authorityCheck` 接到 fresh StateStore predicate：delivery 仍为本 owner/generation、允许状态、同 route revision，route/target 仍绑定该 exact actor，run 仍 active。明确 lease 策略：要么在进入慢 close 前用 owner/generation CAS 续到覆盖 phase-shutdown + kill 的有界期限，并在 callback 中要求未过期；要么明确采用“最新 generation fencing token”语义并证明 takeover 会使旧 callback 立即失败，不能只写“within claim”。测试补 owner/generation 被抢、route/target 改绑、run 判终，以及 authority 分别在 pre-phase-shutdown、post-phase-shutdown、pre-kill 丢失时不再执行后续破坏性动作；stale owner 的 `releaseRetryable` 失败必须交给新 owner 收敛，不能写一次错误 hold。现有 `closeRunner` 已提供检查点，无需新 watcher/state machine。

3. **research.md 仍保留与 v2/源码相冲突的旧证据链。**

   **Why it matters:** 用户把 research.md 定义为完整 code-level evidence chain，plan 又声明“基于 research.md”。虽然 §4-C 已正确改成 controlled close，但 research §2 仍遗漏 terminal-land 的先行 `mode:"land"` 返回，并把 1655 后生产 snapshot 解释成 `engine_terminal`（research.md:28-45）；§4-A′ 仍以 `engine_gate_handoff` 为 predicate、声称 mailbox reachability 未证实且 Fix 2 自动兜底（`:62-67`）；FLY-1612 表仍写“terminal 分支去 replacement”（`:55`）；§4-D 仍允许真机失败时把 daemon 改动并入本单（`:77-78`）。这些内容直接否定 v2 已接受的 R1-1/R1-2/R1-5 修正，会让实现者从同一 evidence chain 得出两套互斥方案。

   **Suggested fix:** 同步 research §2、§3 FLY-1612 行、§4-A′/D 和结论：写明 land early return、真实 predicate=`land + creates_pr + needs_review`、受影响 receipt=`terminal_no_gate`、terminal-live 先 controlled close 后非终 retry、FLY-1269 已提供 resident mailbox loop，真机不符则停发另立 delta。保留 §4-C 当前 proven-dead 边界。此项是文档一致性修复，不要求扩大代码范围。

## Verdict

CHANGES REQUESTED — address items above
