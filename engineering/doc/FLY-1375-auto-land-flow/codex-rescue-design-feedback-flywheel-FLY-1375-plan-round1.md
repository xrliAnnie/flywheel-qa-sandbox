# Design Review — plan.md (Round 1)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

把 merge 与收尾扳机移出 Runner、建成 engine-executed `land` 节点，方向正确且可以落在现有架构上；继续走 sanctioned `:cool:` workflow、复用 issue-level closeout、以 GitHub 的 head-bound MERGED 事实为准，也都应保留。但当前计划对现有 finalization 的恢复能力、land 副作用的执行所有权、founder gate 的真实持有者，以及 stale Codex phase 的关闭合同有几处关键误判；按现稿实施会出现「已经 merge，却因一次 Bridge 崩溃永久不再收尾」或错误标记 `run_completed` 的风险。

## What's Good (Keep)

- `land` 作为引擎内执行、无 Runner session 的第三种节点形态是合理边界：机械且会关闭其他 session 的动作不应由可自噬的 agent node 承担。
- merge 继续通过 `.github/workflows/ship-on-comment.yml` 的权限检查、CI battery 与 head-SHA-pinned squash merge，而不是裸调 `gh pr merge`；workflow 还用 per-PR concurrency 串行处理评论（`.github/workflows/ship-on-comment.yml:13-15,34-83,119-151`）。
- 使用 GitHub 返回的 `headRefOid` / `mergeCommitOid` 证明“哪个 head 被 merge”，而不是信任 Runner 写的 `land-status.json`，与现有 external-merge reconcile 的证据模型一致（`packages/teamlead/src/bridge/external-merge-reconcile.ts:73-123,462-509`）。
- 复用 `closeoutIssue({ disposition: "shipped" })` 而不是裸调 close-runner endpoint 是对的；现有 collector 会覆盖 issue aliases、auto-QA 与 launch claims，且 shipped closeout 已使用 `issueTerminalOverride` + `skipLifecycleGuard`（`packages/teamlead/src/bridge/lifecycle-closeout.ts:130-199,1239-1251,1344-1386`）。
- 验收项覆盖了 stale/awaiting-review、坏 worktree、全 session 与 thread 可见性；生产 `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH` 目前默认关闭，确实给 DAG 迁移提供了隔离边界（`packages/config/src/feature-flags/registry.ts:2923-2944`）。
- 保留 external-merge reconcile、Done/thread reconcile 与 sweep 作为异步兜底，而不是把 land 当成唯一正确性来源，这个防御层次应保留。

## Issues & Recommendations

1. **[阻塞] `runPostShipFinalization` 不是可恢复的幂等状态机，现有 once-claim 反而会永久截断重试。**

   为什么重要：该函数明确 `Promise<void>` 且 never throws；它在任何 teardown 之前先写 `post-ship-finalization-${executionId}`，之后所有重复调用直接 return（`packages/teamlead/src/bridge/post-ship-finalization.ts:408-486`）。后续 closeout blocked、archive 失败或 Linear Done 超时都只记日志并返回 void（同文件 `608-648,692-748`），但 external-merge reconciler 又会主动跳过已有 claim 的 session（`packages/teamlead/src/bridge/external-merge-reconcile.ts:624-636`）。因此 Bridge 在 claim 后、任一步完成前崩溃时，所谓“下一次 finalization pass”实际上不会再发生；land 重启后若仅看到调用返回并写 `land_finalized`，会产生假成功。现有执行顺序也不是计划宣称的“全部 session 关闭后再删 worktree”：它先删 worktree，再调用 issue-level closeout（`post-ship-finalization.ts:565-648`）。

   建议修复：先把 finalization 改为 durable、可续跑的分阶段操作，再让 land 调用。操作记录至少应有 `claimed/running/partial/completed`、owner/lease/generation，以及 tmux/phase close、all-session closeout、worktree/branch、archive、Linear Done 的独立 receipt；每一步只在可验证后置条件成立后完成。函数返回结构化结果（包括 `ClosureReport.outcome`、未完成项、是否可重试），`land_finalized` 与 `run_completed` 只能在全部强制 postcondition 被重新读取确认后写入。把 issue-level closeout/“所有 worktree consumer 已 gone”的确认放在 worktree 删除之前，或明确证明剩余 node 不使用该 worktree。现有 per-step 原语可以继续复用，但不能把一次 `insertEvent` 当成恢复协议。

2. **[阻塞] `workflow_run_event` receipt 不能提供 land 外部副作用的独占执行权；dead-exec 机制也无法直接复用。**

   为什么重要：当前 side-effect ledger 只允许 `dispatch|materialize`，non-terminal 查询只消费 `dispatch`（`packages/teamlead/src/StateStore.ts:19299-19324,19901-19936`）；dispatcher 也只循环 dispatch intent（`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:205-255`）。现有 dead-exec recovery 只识别带 `execution_id` 的 `running` agent node，再依靠 session/tmux liveness 换 execution（同文件 `413-608`），而 land 按设计没有 session/execution。普通 run-event receipt 只能去重“结果记录”，不能阻止 source projector、HTTP 重跑与 reconcile 在重启/竞态下同时执行 comment、archive 或 closeout；当前 agent launch 的真正 fencing 是独立的 owner lease/generation 协议（同文件 `867-925`）。

   `:cool:` 也存在不可消除的外部原子窗口：评论成功后、receipt 落库前崩溃，PR 仍 OPEN 且 Actions 仍在跑，重启会再次评论。workflow 的 concurrency 与 SHA-pinned merge 能防双 merge，但不能证明“不会发第二条评论”；仅 poll PR state 也无法区分 workflow 正在运行与已经失败。

   建议修复：为 engine effect 增加 durable operation/lease/fencing（可以扩展 ledger，也可以建 issue/head keyed `land_operation`），由一个 owner 在有效 generation 下推进，stale owner 才可被接管。把 `:cool:` 明确建模为 **at-least-once trigger**，测试 crash-before-comment、comment-success-before-receipt、workflow-running、workflow-failed 与 merged-before-receipt；不要承诺 exactly-once comment。记录并关联 GitHub comment/Actions run，或定义可靠的“已有该 head 的 ship workflow 正在/已执行”观察规则；poll failure 必须基于关联到本次 comment/head 的 Actions conclusion，而不是只看 PR 仍 OPEN。

3. **[阻塞] founder gate 与 merge authority 的真实持有者没有闭环；计划所写的 QA 行为当前不存在。**

   为什么重要：generalized runner 当前在 `can_ship !== true` 时被明确告知“Do not request ship approval”，并且所有 generalized/QA execution 都跳过 `approve_to_ship` checkpoint（`packages/edge-worker/src/Blueprint.ts:1520-1539,2075-2088`）；QA registry 也没有 `can_ship` 或 `approval_gate_holder`，只有 implement 与无 execution 的 gate node 声明 gate holder（`packages/config/src/node-type-registry.ts:72-109`）。QA verdict 会在同一事务里直接把 QA node 推进到内部 `founder_gate`，但现有实现只写一个 `gate_opened` run event（`packages/teamlead/src/StateStore.ts:17920-18015`）；全仓搜索没有找到该事件的运行时消费者去创建/bind CommDB `approve_to_ship` question 或 founder card。

   同时，计划把 `computeShipDecision` 描述成“六轴 + engine claims”并不准确：它只调用 legacy `evaluateShipEligibility`；真正叠加 authoritative head 与 engine claims 的入口是 `computeAuthoritativeShipDecision`（`packages/teamlead/src/bridge/merge-ship-gate.ts:64-86,263-374`）。legacy verifier 还必须拿到一个真实 session execution：其 bound question 必须来自该 execution，session 必须处于 `approved_to_ship`，并带匹配的 `pr_head_sha` / PR / worktree（`packages/flywheel-comm/src/commands/verify-approval.ts:284-370,374-490,510-541`）。land 自身没有这样的 session。

   建议修复：在计划中定义一个 first-class gate materialization 合同，而不只改 prompt：谁是 canonical ship-authority execution、何时原子创建 CommDB question + review binding + thread card、何时把该 session 推到 `awaiting_review/approved_to_ship`、source event 如何把同一 question/execution/head 带回 workflow ledger。若 QA 只负责请求批准而不负责 merge，应拆出 `can_request_ship_approval`，不要用 `can_ship` 同时表达两种权限。land 必须从 durable binding 解出这个唯一 execution，并调用/重构 `computeAuthoritativeShipDecision`；issue 或“最新 session”启发式一律 fail closed。需要覆盖 stale/superseded gate、QA retry 后新 head、Bridge 在 gate materialization 中途重启的测试。

4. **[阻塞] “stale controller lease 也一定收掉”与现有 resident Codex 安全合同直接冲突。**

   为什么重要：`prepareCodexPhaseShutdown` 对 stale heartbeat + live pane 明确返回 `phase_shutdown_controller_lease_stale_live_pane`，30 秒无 ACK 但 pane 仍 live 时也必须 blocked；注释明确说明强杀可能 orphan daemon（`packages/teamlead/src/bridge/codex-phase-shutdown.ts:191-212,292-327`）。`closeRunner` 会原样把这个 blocked 结果返回，不会因 `issueTerminalOverride` 越过它（`packages/teamlead/src/bridge/close-runner.ts:430-454`）。所以 lifecycle closeout 能越过 `awaiting_review` 等 FSM eligibility，但不能越过 resident-controller liveness safety。计划一面说这个协议“不动”，一面把“故意造 stale controller lease 后 session gone”列为验收，二者不可同时成立；给普通 session 发 mailbox hint 并等待 30 秒也不会改变该 Codex 分支。

   建议修复：先明确验收中的 `lease_stale` 是“pane 已确认 absent/dead_pin”还是“live-but-stale controller”。前者现有路径已支持；后者若仍要求零人工关闭，必须单独设计安全的 daemon/TUI ownership transfer 或 terminal shutdown 协议，并更新 FLY-1269 authority matrix，不能简单 timeout 后 force-kill。若不改该安全合同，则产品语义应改为 land `held/partial + escalation`，而不是宣称全收；相应 E2E 也要分别覆盖 absent、indeterminate、live-stale、ACK success/timeout。

5. **[阻塞] 显式 legacy `/api/lifecycle/land` 没有可复用的 durable 身份、receipt 或完整授权边界。**

   为什么重要：计划把 land receipts 存为 `workflow_run_event`，但 legacy issue 没有 engine-owned `run_id/node/attempt`，因此无法与 DAG 路径真正共用同一恢复状态机。现有 `/api/lifecycle` mount 只有 API-token middleware（`packages/teamlead/src/bridge/plugin.ts:1983-1997`）；把路径加入 reserved metadata 并不会自动获得 founder-consent enforcement，因为 resolver 只处理 action-router/close mounts（`packages/teamlead/src/bridge/founder-consent/reserved-endpoints.ts:300-345`）。参数只有 issue + optional PR 也无法 fail-closed 地选择多个 session/PR 中哪个 head 获得 founder 授权。

   建议修复：让 DAG 与 HTTP 都先创建/取得同一个 issue + project + PR + approved-head keyed `land_operation`，endpoint 只持久化 intent 并返回 `202 + operation_id`，由 fenced worker 推进；重复请求返回同一 operation。请求必须 canonicalize issue UUID/identifier，解析唯一 gate-holder execution 与 PR/head，并对显式 PR/head mismatch 拒绝。自动与 legacy 两条入口都要在 worker 内重新执行 founder attribution、bound-question/head、QA/Codex/CI/engine-claims（适用时）验证，不能把 reserved registry 或 API token 当作 ship authority；另提供查询状态与安全重跑语义。

6. **[高] v2/product 是否进入本单不能留到实现时决定，且当前 merge/finalization 合同并不适用于它。**

   为什么重要：当前 schema-v2 明确“无 PR merge tail”，在 founder source 到达 terminal gate 后直接完成 run（`packages/teamlead/src/StateStore.ts:18937-18974`）。`computeShipDecision` / `verify-approval` 则需要真实 PR、worktree 与 `approved_to_ship` session。把所有 product/ops/research 模板都加同一个 land 并声称“merge 段自动跳过”，会把“没有 PR”误当成“PR 已 MERGED”，也会把当前 `terminal_gate` 的 approval-gate 语义和新 terminal-node 语义混在一起；validator 目前明确要求 `terminal_gate.node` 是无出边 gate（`packages/teamlead/src/workflow-template.ts:430-443,489-525,821-834,893-945`）。

   建议修复：本单按 issue 目标先严格限定 schema-v1 engineering templates，v2 保持现状；若 FLY-1396 强制形状一致，则另行定义无 merge 的 `closeout`/terminal executor 合同与自己的 eligibility/postconditions，不要复用“PR 已 merged”的 land 语义。schema-v1 也应把 `approval_gate` 与 `terminal_node` 分成两个明确字段（或版本化 manifest），并定义 founder source transaction 如何原子地从无 execution 的 gate 写入 land intent；不要只把 `terminal_gate.node` 改指 land。

7. **[高] 三个 PR 的激活顺序和 kill-switch 不能保证安全的中间态。**

   为什么重要：PR-1 计划在“假定 PR 已 merged”时直接 finalization，同时已让 founder approval 推进 land；但 PR-2 才加入 merge 驱动与真正的 GitHub 证据。这会制造一个能在 PR 仍 OPEN 时执行 destructive cleanup 的中间版本。再加上计划将 `FLYWHEEL_LAND_NODE` 设为 engine-run 默认 ON，seed/snapshot 一旦固化 land，运行中把 flag 关掉也不能自然“退回旧 founder_gate terminal + runner seam”；而 QA prompt 是否退役又是另一条动态分支。生产 dispatch 默认 OFF 只能保护当前 legacy 流量，不能证明候选 engine run、测试环境或显式 endpoint 安全。

   建议修复：PR-1 只落 schema/ledger/executor skeleton 与测试，不改 seed、不从 founder source 激活、不调用 finalization；新 flag 先默认 OFF。PR-2 原子落 gate materialization、authoritative eligibility、`:cool:` driver、resumable finalization 与 cleanup protocol，仍保持 OFF。PR-3 才加入口、runbook、全链 E2E 并启用模板。每个 PR 都要带 legacy reverse-compat 哨兵，不要推迟到 PR-3。计划中补一张 flag/snapshot matrix，至少覆盖旧 snapshot、新 land snapshot、flag 在 QA 前/QA 后/founder approval 后关闭，以及 endpoint 在 flag 关闭时的行为；只有完整状态机真机通过后才考虑 default ON。

## Verdict

CHANGES REQUESTED — address items above
