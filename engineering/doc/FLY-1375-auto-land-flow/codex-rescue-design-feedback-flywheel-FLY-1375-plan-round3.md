# Design Review — plan.md (Round 3)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已完整吸收 Round 2 的五项要求：gate materialization、founder source convergence、finalization consumer migration、v1 双 variant 与 Actions correlation 都已进入可实施的架构形态，前两轮的大部分风险可以关闭。但按当前源码再推演后，仍有两个阻塞性合同不成立：QA holder 在 gate 打开后没有计划所述的 dead-exec 重派路径，且 teardown 可以把它覆盖成不可逆终态；现有 seed import 也会自动发布并切换同 template 的 current revision，无法做到“新增 revision 但不切 binding”。另有一处 flag-off 运维路径自相矛盾。

## What's Good (Keep)

- D2 已从跨库“原子写”改为 `(run, gate_node, attempt, head)` keyed staged convergence，并为 question、card 和 founder source 第二窗口分别给出 durable identity、receipt 与 repair；方向正确。
- canonical ship-authority 改为 QA execution，避免了 Round 2 中 implement execution 已经不可逆 `completed` 的直接 FSM 冲突；`can_request_ship_approval` 与 `can_ship` 拆分也符合最小权限。
- D3 为 sanctioned workflow 增加 comment-id-to-run receipt，只增强审计 correlation，不改变 permission、CI、SHA-pinned merge 与 squash 语义；这使失败判断终于有确切 Actions run 事实。
- D5 的 `merge_confirmed` / `finalization_running|partial` / `finalization_completed` 三事实拆分及 reader 迁移矩阵覆盖了当前所有生产读点；旧 once-claim 不再被误当 completion。
- v1 dual-variant parser、真实旧 snapshot digest fixture、flag/snapshot 行为矩阵和 default-OFF 三段交付，显著降低了 parser 与 live legacy 路径的回归风险。
- PR-1 skeleton、PR-2 capability、PR-3 activation 的顺序合理；每个 PR 保留 legacy observable-behavior sentinel 是正确的发布纪律。

## Issues & Recommendations

1. **[阻塞] QA holder 的生命周期仍存在未封口的 race；计划所称“dead-exec 重派并重建 gate”在现有 ledger 上不会发生。**

   为什么重要：QA PASS 的同一 StateStore transition 会先把 QA node 写成 `done`，再创建 `gate_opened`（`packages/teamlead/src/StateStore.ts:17925-17932,17976-17992`）。dead-exec reconciler 只扫描 `node.state === "running"` 的 execution（`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:430-455`），所以 gate 打开后 QA execution 若死亡，不会按风险项 5 所述被重新 dispatch；即便 gate 前发生替换，现有 rollback 也保持同一 logical attempt，只更换 physical execution（`packages/teamlead/src/StateStore.ts:16524-16537,16776-16788`）。与此同时，agent 的 teardown signal 会无条件把 session status 写成 `completed|failed|blocked`（`StateStore.ts:15682-15708`），可以在 staged materializer 将 holder 设为 `awaiting_review` 之前或之后覆盖它。于是一个正常 PASS 已 durable、gate 已打开的 run 可能永久停在 materialization escalation；旧 gate 既不会自动 supersede，也没有新 attempt 可以重建。这不是单靠“验证 holder 非终态”能解决的 fail-closed 检查，而是 authority owner 本身没有恢复路径。

   建议修复：把 approval authority 从 QA 进程的可变 session status 中解耦。首选建立 first-class `workflow_gate_holder`，以 gate identity 绑定 QA execution/head/question/card，并用自身的 `materializing → awaiting_review → approved|superseded` 状态供 verifier 与 ship decision 读取；QA session 只提供来源归属，死亡不抹掉已提交的 QA/gate authority。若坚持复用 session row，则必须在 QA decision transition 的同一 StateStore transaction 中预留 deterministic question intent 并转入 review 状态，同时修改 enrolled teardown 投影，使 physical teardown 不会覆盖 current gate holder，并提供专门的 gate-holder recovery（不能声称复用只扫描 running node 的 dead-exec）。新增两个必测窗口：`qa_pass/gate_opened committed → materializer first tick` 即 teardown，以及 `session_bound → founder response` 即 teardown。同步改写风险项 5，明确真实 attempt/execution 语义。

2. **[阻塞] “land seed 作为新 template revision，但默认 binding 不切换”与当前 seed publication/selection 模型矛盾。**

   为什么重要：`importWorkflowTemplateSeed` 发现同一 `template_id` 内容变化时，不只是插入 revision；它还立即写 publication 并把 `workflow_template.current_published_revision` 更新为新 revision（`packages/teamlead/src/StateStore.ts:13270-13316`）。category binding 只保存 `template_id`，不 pin revision（`StateStore.ts:13332-13361`），而 preflight/materialization 总是读取该 template 的 `current_published_revision`（`packages/teamlead/src/workflow-template-selection.ts:42-55`; `StateStore.ts:13447-13468`）。因此 PR-3 若给现有 engineering template ID 导入 land revision，所有现有 binding 已经被实质切到 land；在 flag 默认 OFF 时，新 dispatch 还会按 D8 fail-loud 拒绝，正好违反“不切默认 binding”的安全承诺。

   建议修复：PR-3 最简单且最小风险的做法是为 land variants 使用新的 template IDs（例如 parallel `*_land_v1` templates，初始 revision 1），不改任何现有 binding；真机 E2E 通过显式 template override 选择它们，后续 cutover 才显式 rebind。若必须保留同 template ID 的 revision 历史，则本单需新增 revision-pinned binding/selection 与独立 publish-vs-activate 语义，并把相应 StateStore、route、selection 与 migration 纳入改动面；不能依赖当前 boot seed importer。

3. **[高] flag-off matrix 给出的人工恢复动作不可执行。**

   为什么重要：D8 说 land snapshot 在 QA 前/后关闭 flag 时，escalation 指向“人工 land 入口”（计划第 101-102 行）；同一矩阵又规定 flag OFF 时该 endpoint 返回 503 且不写 intent（第 104 行）。值班人照 escalation/runbook 操作只会得到 503，无法恢复卡在 approval gate 的 run。

   建议修复：明确唯一运维合同。可选：(a) escalation/runbook 要求先显式重新开启 `FLYWHEEL_LAND_NODE`，确认 worker healthy 后再调用 endpoint；或 (b) 拆出独立、默认 OFF 的 break-glass flag，并保留 worker 内完整 founder/head/claim re-authorization。补一条 flag-off held run 的 operator recovery E2E，证明步骤能从 503/held 收敛到同一 operation，而不是再造旁路。

## Verdict

CHANGES REQUESTED — address items above
