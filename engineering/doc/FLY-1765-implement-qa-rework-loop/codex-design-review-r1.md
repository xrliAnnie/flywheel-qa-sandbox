# Design Review — plan.md (FLY-1765) (Round 1)
Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向上同意“正常路径保持可唤醒的停驻体、部署窗残局走 replacement，且不开放终态复活边”。但当前计划不能直接实施：Fix 1 的核心判定在现有 authority classifier 下不可达，因而不会修复当前 `tpl_code`；Fix 2 则会把刚被 liveness probe 证明仍存活的 actor 送进只允许 proven-dead 的 FLY-1718 replacement 事务，写出虚假的死亡证据。park 结算还混淆了 StateStore 台账与 CommDB/`closeRunner` 外部回收边界，未把所有终态写点及 replacement 崩溃窗闭合。结论为 `CHANGES REQUESTED`。

## What's Good (Keep)

- exploration/research 的生产 DB、回归窗口和调用链证据扎实，问题定位到 FLY-1655 后 completion projection 与 FLY-939 wake gate 的冲突是可信的。
- 保持 `completed` 终态免疫、不新增 env flag、优先复用 `ship_parked`、park outbox 和既有 replacement/backoff，符合当前架构和 founder 的降复杂度约束。
- 将 `runner_ship_gate_wait` 与新 rework park reason 分离、保留 QA 一把过阴性对照、部署窗兼容演练和真机返工演练，这些验收维度应保留。
- attempt N+1 再次 completion 后重新停驻的总体生命周期方向正确；现有 `ship_parked → running` wake 边和 Codex phase keep-alive 都可复用。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **Fix 1 的 `engine_terminal && creates_pr` 条件不可达，且 receipt 预期也不符合当前实现。**

   **Why it matters:** `resolveWorkflowGateAuthority` 先把任何 terminal-land manifest 判成 `mode: "land"`（`workflow-run-snapshot.ts:173-175`）；非 land 时，只要任一 node 有 `creates_pr`，该 node 就进入 ship-capable candidates（`:176-184`），因此不可能同时得到 `mode: "engine_terminal"`。当前 compiled menu 的源码测试逐个断言 authority 都是 `land`（`workflow-menu.test.ts:293-305`），terminal-land fixture 也明确展示 `creates_pr: true` 的执行节点配 `mode: "land"`（`workflow-run-snapshot.test.ts:361-380`）。所以计划 §2.1/测试 1 的条件会成为 no-op，真实 `tpl_code` implement 仍投 `completed`。此外，`workflowCompletionDispositionForContext` 在 gate 未打开时固定返回 `terminal_no_gate`（`StateStore.ts:28299-28316`）；现有 implement→QA 测试正是 `ship_parked` 加 `completionDisposition: "terminal_no_gate"`（`StateStore.workflow-engine-transition.test.ts:469-518`），不是计划声称的 `engine_gate_handoff`。

   **Suggested fix:** 先重写 §2.1 的语义 predicate，使其命中真实 compiled `tpl_code` 的 `land` authority，同时继续排除 `runner_ship`、`no_code`、design/QA 和非 engine-owned/非 epoch-1 路径；不要用不可达的 synthetic `engine_terminal` fixture。把 receipt 约束改为保持当前 `terminal_no_gate`，并以真实 menu 编译出的 snapshot 做首个红测。补一条 FLY-1731 sentinel：land-mode 的 implement 即使为 `ship_parked`，在 founder gate 前后也不能被选为 gate holder、present/consume approval 或取得 carrier authority；authority 必须仍由 pinned land/gate holder 决定。

2. **Fix 2 把“存活但状态终结”的 actor 错标为 proven-dead，违反 FLY-1718 replacement 的安全前提。**

   **Why it matters:** coordinator 先运行 `classifyPhaseActorReentry`；只有 registered 或 persisted probe 返回 `alive` 才进入 `wake`（`phase-actor-reentry.ts:30-66`），随后才调用 `activateActorForWake`（`workflow-rework-coordinator.ts:383-416`）。因此这里的 `state_not_revivable:completed` 代表“actor 刚被证明还活着，但 StateStore 状态不可复活”，并不代表 dead。`materializeWorkflowReworkReplacement` 的接口和事务明确要求 `deadExecutionId` / “proven-dead”（`StateStore.ts:21691-21711`），还会写 `workflow_dead_execution_watch`、`execution_dead_rolled_back` 以及 `livenessEvidence: { liveness: "dead" }`（`:21933-21973`）。按计划直跳 `replacement_pending` 会伪造死亡账、撤旧体权限并可能让旧新两体并存，破坏 FLY-1462/FLY-939 的单写者与终态免疫边界。

   **Suggested fix:** 对 terminal-but-live 部署窗残局设计“受控 supersession”，不能复用 proven-dead 分支冒充死亡。最小方案是：在 rework claim/identity fence 下调用现有 Codex phase shutdown/`closeRunner`，失败或 authority 丢失则释放并重试；只有确认原 actor/host 已不存在后，让下一次 reconcile 通过现有 classifier 自然进入 `replace`。这样若进程已关但 delivery 转移前 Bridge crash，重放仍会从持久 liveness 证据收敛到既有 replacement。若不能用现成 close chokepoint，则需单独写清一个带诚实 receipt、CAS、崩溃恢复和单写者证明的 supersession 设计，而不是复用 `execution_dead_rolled_back`。测试必须覆盖 close 失败、close 后/状态迁移前 crash、claim/identity 丢失，以及“actor 仍活时绝不写 dead rollback”。

3. **park 结算契约与现有 schema/FSM 不一致，也没有枚举全部 run-terminal 写点。**

   **Why it matters:** `workflow_engine_park_outbox.event` 只允许 `park_opened | park_cleared`（`StateStore.ts:4160-4172`、`:12136-12177`），不存在计划 §2.2/测试 4 的 `park_closed`。直接把 session 投成 `completed` 还必须与现有 generalized projection 一样维护 `terminal_at` 和 `lifecycle_revision`（`:26628-26643`），计划只写了前者。当前终态写点并非一个 chokepoint：至少包括 operator terminate（`:24481-24701`）、no-code completion（`:28895-28924`）、两个 founder/source-terminal 分支（`:31982-32013`、`:32097-32123`）、legacy ledger finalize（`:34328-34334`）、runner-ship completion（`:37942-37969`）和 land completion（`:39158-39189`）；另有 engine-owned=0 的 shadow terminate（`:18578`，应明确判定为不相关而非遗漏）。“在全部路径调用”目前没有可执行的接线清单，也没有 idempotent replay 规则。

   **Suggested fix:** 在计划中列出上述 writer matrix，说明哪些可产生 `rework_reachable_wait`、哪些必须接同一 transaction-local helper、哪些因 invariant 明确排除。helper 应以 run/execution/node/attempt/activation 和最新 open generation 做 CAS，只在 session 仍为 `ship_parked` 时投 `completed`，同事务写 `terminal_at`、bump lifecycle revision 并追加 deterministic `park_cleared`；重放必须无副作用，且不得匹配 `runner_ship_gate_wait`。测试逐个覆盖相关 `completed`/`terminated` writer、重复调用、状态/activation 已变、park 已清和 runner_ship 阴性，而不是只测两个抽象终态。

4. **计划把 StateStore 事务与异步物理回收混成一步，replacement 后置 hook 还留下不可恢复的 crash gap。**

   **Why it matters:** `phaseShutdownRequestId` 只是 `closeRunner` 完成 phase shutdown 后写入的审计 payload（`close-runner.ts:450-495`），不是 StateStore 内可“排队”的 durable queue。`runner_shutdown_controls` 位于 CommDB，`requestLandCleanupOpportunities` 会异步跨库写请求并等待 ack（`land-cleanup-opportunity.ts:12-60`）；post-ship finalizer 才通过 `closeRunner({ finalizeDone: true })` 回收包括 `ship_parked` 在内的 phase sessions（`post-ship-finalization.ts:432-487`）。因此 §2.2 所称“事务内排队拆体”按现有边界无法成立。另一个缺口是计划把 superseded park settlement 放在 dispatcher 的 `materializeWorkflowReworkReplacement` 返回之后：若 replacement 已提交而 Bridge 在 hook 前 crash，materialize 重放可能直接 idempotent return，旧 park/session 将永久遗留。

   **Suggested fix:** 把“账面结算”和“物理回收”拆成两个有持久恢复语义的阶段。正常 land/ship 路径应明确复用现有可重放 post-ship finalizer/land cleanup；operator termination 则遵守其 quiescence 前置条件。若 replacement 合法发生，旧 session settlement 与 `park_cleared` 必须并入 `materializeWorkflowReworkReplacement` 的同一 StateStore transaction，或由一个能从 durable state 每轮重算的 consumer 收敛，不能只做一次 dispatcher 后置调用。给跨库清理定义 retry/告警和 crash-restart 测试，不要宣称单个 StateStore 事务能原子提交 CommDB/进程关闭。

5. **R1 在当前代码中已有明确实现证据，且计划描述的失败收敛并不成立。**

   **Why it matters:** 当前 Blueprint 对 shared-branch Codex design/implement/QA 注入 `phaseKeepAlive`（`Blueprint.ts:1595-1621`），Codex adapter 启动 `CodexPhaseLifecycleController`（`CodexTmuxAdapter.ts:515-540`），goal loop 在 `complete` 后进入 durable phase hold 而不是退出（`codex-daemon-client.ts:790-846`、`:1049-1069`）；implement prompt 也明确说明 controller 保持存活并等待后续 QA FIX（`Blueprint.ts:1956-1965`）。真机验证仍必要，但这不是一个尚无代码依据、可以临场追加 daemon 功能的 open contingency。更重要的是，若体“活着但不消费 mailbox”，activation 可先成功投 `running`，后续 delivery 失败会继续看到 alive，最终仍可能经现有 5 次 retry 落 `needs_lead`；它不会自动变成 proven-dead replacement。计划 §7 R1 的“不再挂死”保证不真实。

   **Suggested fix:** 删除自动启用 daemon 改动的 contingency，把 R1 改成对 FLY-1269 既有 resident controller 的定向回归与真机验收：completion 后 goal=paused/hold 已确认、watcher 活、稳定 wake id 被消费、TURN 授权、同 thread 重启工作、attempt N+1 再次进入 hold。真机若与源码契约不符，应停止发布并另开经过评审的最小 delta，不在本单无边界扩 scope。验收同时明确：任何 alive-but-nonconsuming 情形均为 FAIL，不得声称 Fix 2 会自动兜底。

## Verdict

CHANGES REQUESTED — address items above
