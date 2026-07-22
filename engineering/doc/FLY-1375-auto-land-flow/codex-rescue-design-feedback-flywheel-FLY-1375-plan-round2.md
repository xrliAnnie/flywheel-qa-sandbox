# Design Review — plan.md (Round 2)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质采纳 Round 1 的七项要求：land 的执行 fencing、finalization 可续跑化、stale Codex 安全边界、legacy 入口授权、v1-only scope 与分阶段激活方向都正确，原先七项不再原样重开。但对新增 D2/D5/D8 再按当前源码推演后，仍有五个实现级合同未闭环；其中 canonical implement execution 已经是不可逆终态、gate materialization 的跨存储“原子性”不可成立，会使 founder approval 链在落地时直接断掉。

## What's Good (Keep)

- D4 不再把 `workflow_run_event` 当执行锁，而是引入 `(issue, project, pr, approved_head)` keyed operation + owner/lease/generation fencing；这正是有外部副作用节点需要的执行模型。
- `:cool:` 已明确降格为 at-least-once trigger，并保留 workflow concurrency、permission gate、CI battery 与 SHA-pinned squash merge；不再追求 GitHub comment 的伪 exactly-once。
- D5 正确识别并替换现有 once-claim 的 crash hole，要求 structured outcome、per-step receipt、postcondition re-read，且把 all-session closeout 移到 worktree 删除之前。
- D6 对 stale session 的验收已与 FLY-1269 对齐：absent/dead_pin 可收，live-but-stale/indeterminate 不强杀而是 partial + escalation。
- D7 把 HTTP 入口改成 `202 + operation_id` 的 intent writer，并在 worker 内重验 founder/head/QA/Codex/CI authority；API token 不再被误当成 ship authority。
- v2/product 已明确退出本单，PR-1 不激活、flag 默认 OFF、每个 PR 都带 legacy sentinel，显著缩小了上线爆炸半径。
- `computeAuthoritativeShipDecision`、GitHub `headRefOid` / `mergeCommitOid` 与 `ClosureReport` 已被放回正确的 authority / evidence 边界。

## Issues & Recommendations

1. **[阻塞] D2 选定的 implement ship-authority execution 在 gate 打开前已经是不可逆 `completed`，无法再推到 `awaiting_review`。**

   为什么重要：engine-owned implement 调用 `complete --route needs_review` 后，`commitEnrolledCompletion` 会先提交 `implement_done`，随后 `projectGeneralizedCompletionTx` 无条件把该 execution 的 session status 写成 `completed` 并盖 terminal timestamp（`packages/teamlead/src/StateStore.ts:17109-17153,17228-17281`）。FSM 明确规定 `completed: []`，所以 `applyTransition(completed → awaiting_review)` 必然拒绝（`packages/core/src/workflow-fsm.ts:120-181`; `packages/teamlead/src/applyTransition.ts:42-64`）。GatePoller 也只处理 `running|awaiting_review|approved_to_ship`，会直接忽略 completed holder（`packages/teamlead/src/bridge/gate-poller.ts:440-444,2439-2452`）。因此“materializer 把 implement execution 推到 awaiting_review”在现架构上不可执行，也不能用直接 upsert 绕过 terminal immunity。

   建议修复：先选定一个 FSM 可达的 authority 模型并写进计划。可选方案是：(a) engine-v1 implement 完成后进入新的非终态 `implementation_done`，QA PASS 后 materializer 再合法转入 `awaiting_review`；(b) 改用仍非终态的 QA execution，并明确把 PR/head/Codex-review authority 绑定到它；或 (c) 建 first-class engine ship-authority record，并重构 verifier 不再依赖 session status。无论选哪条，都要补 `implement_done → QA → gate_opened → awaiting_review → approved_to_ship` 的真实 FSM 集成测试，不能只测 question/binding。

2. **[阻塞] “原子创建 CommDB question + StateStore binding + Discord card”跨越两个数据库和外部 API，当前 D2 没有可实现的 crash protocol；approval source 与 status flip 之间还有第二个窗口。**

   为什么重要：现有 question writer 每次生成随机 UUID，只在 CommDB 内写一行（`packages/flywheel-comm/src/commands/gate.ts:107-140`; `packages/flywheel-comm/src/db.ts:765-825`）；review binding 则是另一个 StateStore 写（`packages/teamlead/src/StateStore.ts:4346-4377`）。Discord 路径更明确是先 POST，成功后才把 `(question, head) → gateMessageId` 写入 StateStore，再写 notify marker（`packages/teamlead/src/bridge/gate-poller.ts:2523-2644`）。因此任何“全原子”实现都不存在：question 后崩溃会重建重复 question，Discord POST 后崩溃会重发 card，仅写“中途重启测试”而没有 durable step identity 不能解决。

   founder approval 也有独立窗口：trusted response + `workflow_source_event` 先在 CommDB transaction 中提交，之后才运行 StateStore post-write hook 把 session 改成 `approved_to_ship`（`packages/teamlead/src/bridge/approval-signal/write-gate-response.ts:368-450`）。进程若在两者之间退出，projector 仍可投影 claim/激活 land，而 `verifyApproval` 会因 holder 仍是 `awaiting_review` fail；D3 当前把所有 precondition failure 直接变成 held，而不是恢复这个已获授权但尚未投影完整的状态。

   建议修复：把 gate materialization 改写为 durable staged convergence，而非“原子”：以 `(run, gate node, attempt, head)` 为 identity，至少记录 `question_intent/question_written/session_bound/card_posted/card_bound/completed`。CommDB 必须支持 caller-supplied deterministic question id 或 insert-or-verify digest，重启才能找回同一 question；Discord card 明确建模 at-least-once，并保证只有 current bound card 可授权。founder source 的 StateStore apply 应在一个 StateStore transaction 内完成 holder status projection + founder claim + land intent，或提供自动 post-write repair；land 对“response 已 durable、status projection 未完成”应 retry/reconcile，不能立即 held。补齐每两个阶段之间的 crash 测试，尤其是 `source_write_success → approved_to_ship hook` 窗口。

3. **[阻塞] D5 替换 `post_ship_finalization_claim` 时没有迁移其全部生产读点；不拆分事实语义会造成重新 spawn、错误 UI 或过早 `run completed`。**

   为什么重要：该 event 目前不只是 finalization dedupe。Heartbeat 用它授权自动回收 parked phases（`packages/teamlead/src/HeartbeatService.ts:2271-2309`）；PhaseOrchestrator 用它防止已 merge issue 再 spawn Implement（`packages/teamlead/src/bridge/phase-orchestrator.ts:410-423` 与 `plugin.ts:8403-8410`）；issue display 用它显示 shipped/final 状态（`packages/teamlead/src/bridge/issue-display-refresher.ts:390-412,667-679`）；workflow shadow startup repair 则看到它就直接 finalize run（`packages/teamlead/src/bridge/workflow-shadow-writer.ts:550-568,678-690`）；StateStore 还有 run-attributed claim 查询（`packages/teamlead/src/StateStore.ts:19994-20010`），external-merge reconcile 会据此跳过。更新稿的文件表只列 `post-ship-finalization.ts`，尚未定义这些 reader 在 `claimed/running/partial/completed` 下分别读什么。特别是继续把 claim 当 T9 completion 会违反本稿“全部 postcondition 确认后才 run_completed”的新红线。

   建议修复：在 D5 加一张 consumer migration matrix，并把上述文件加入改动面。至少拆开三个 durable facts：`merge_confirmed`（禁止再 spawn、允许进入 cleanup）、`finalization_partial/running`（继续 reconcile + 显示收尾中/异常）、`finalization_completed`（允许 terminal badge、shadow/run completed）。旧 `post_ship_finalization_claim` 可以保留为兼容 evidence，但不得再同时表示 started 与 completed。还要定义已有 claim rows 的启动 backfill：把“旧 claim 且 postconditions 不全”的 live legacy issue 建成 partial operation 并续跑，而不是继续跳过。D8 的 byte-compat 边界也应改成“legacy trigger/approval/Blueprint 不变”；finalization 的恢复与顺序是有意改变的，不能同时宣称内部 bytes 不变。

4. **[阻塞] schema-v1 被原地改形状，与 PR-1“不改 seed”及旧 snapshot digest 严格校验不兼容；flag matrix 只有测试项，没有行为定义。**

   为什么重要：当前 v1 validator 对 root keys 做严格 exact check，只接受 `terminal_gate`，node type 也只接受 design/implement/qa/gate（`packages/teamlead/src/workflow-template.ts:224-271,430-443`）；bundled seeds 每次加载都会立即过该 validator（同文件 `1085-1115`）。PR-1 若把 v1 改成必需 `approval_gate + terminal_node`，却按计划到 PR-3 才改 seed，PR-1 自身就无法加载现有 seeds。更严重的是旧 run snapshot 会再次调用 live v1 validator，并对 normalized body 重算 snapshot digest（`packages/teamlead/src/workflow-run-snapshot.ts:270-310,450-473`）；新增 required capability `can_request_ship_approval` 或 engine-executed 字段也会因 strict capability/execution keys 让旧 snapshot 失效（同文件 `229-266,326-382`）。flag=OFF 无法修复 parser 级不兼容。

   建议修复：不要无版本地替换 v1 shape。引入可判别的新 manifest revision/schema，或让 parser 明确支持 `legacy terminal_gate` 与 `land approval_gate+terminal_node` 两种不可混用的 v1 variant；旧 snapshot 必须按原字节 vocabulary 解析并保持 digest，新 capability/engine marker 只能在新 variant 必需。PR-1 必须用未改 seeds 和真实旧 snapshot fixture 验证。D8 还要写出 matrix 的期望结果，而非只说“测试”：旧 snapshot 继续旧 seam；land snapshot 在 flag 被关时 fail-closed 停在何处、是否 escalation；flag OFF 时是否拒绝 materialize land seed；endpoint 是 503 不写 intent，还是写 held operation。PR-3 在 flag 默认 OFF 时导入 land seed的选择/版本策略也必须明确。

5. **[高] 当前 sanctioned workflow 没有足够字段把 engine 的 `:cool:` comment id 精确关联到 Actions run；D3 的 failure-conclusion 判定还不可实现。**

   为什么重要：workflow 的启动评论只写 branch 与短 head，不写触发 comment id 或 Actions run id（`.github/workflows/ship-on-comment.yml:84-94`）；只有通过 `pr-info` 后的失败评论才包含 run URL（同文件 `166-177`），成功评论也不带 run id（`145-157`）。在 at-least-once 双评论、两个 queued run 或 pr-info/permission 早失败场景中，Bridge 仅凭“PR、actor、时间、head”无法证明哪个 conclusion 对应自己记录的 comment id。计划又要求 `ship-on-comment.yml` 逐字不变，并且改动面没有该文件，所以“按关联到本次 comment/head 的 Actions conclusion 判定”缺少事实来源。

   建议修复：允许一个仅增加审计 correlation、不改变 permission/CI/merge 语义的 workflow 改动，并把文件列入 PR-2：在最早可执行步骤发布或持久化 `{trigger_comment_id, run_id/run_url, full_head_sha}` receipt，后续 success/failure 都引用同一 identity。land 以自己 POST 返回的 comment id 等待该 receipt，再查询确切 run conclusion；早期 permission/draft/fork failure 也要有终态 receipt。测试双 `:cool:`、一个失败一个运行/成功、以及 receipt 前 crash，证明不会因别的 run 失败而错误 held。

## Verdict

CHANGES REQUESTED — address items above
