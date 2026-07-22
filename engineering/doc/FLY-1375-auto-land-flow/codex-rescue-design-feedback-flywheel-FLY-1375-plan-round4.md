# Design Review — plan.md (Round 4)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已正确解决 Round 3 的三个原始问题：first-class gate holder 是合适的 authority model，新 template IDs 避免了隐式 fleet cutover，flag-off 也已有可执行的双恢复路径。但把 holder 对照现有 founder ingress 全链后，仍有两个实现合同未闭环：reaction/text/write/deferred 目前都会先按 QA session status 拒绝请求，导致计划承诺的 teardown-survival 实际不可达；founder reject/feedback 也没有 holder 或 DAG 的后续状态。修正这两点后，整体方案即可进入实现。

## What's Good (Keep)

- `workflow_gate_holder` keyed by `(run, gate_node, attempt, head)`，并与物理 QA session lifecycle 解耦，是 Round 3 lifecycle race 的正确根治方式；QA execution 仅保留 attribution 也符合 authority 最小化。
- holder + deterministic question intent 与 QA PASS/gate transition 同 StateStore transaction 出生，消除了 `gate_opened` 已提交但无人拥有 materialization 的窗口。
- holder 自身的 `materializing → awaiting_review → approved|superseded` 状态、current-card-only authorization 和 teardown 两窗口测试，给批准路径提供了清晰的 durable invariant。
- land templates 改用 `tpl_eng_*_land_v1` 等全新 IDs，现有 category bindings 零变更；E2E 用 explicit override，cutover 另行显式 rebind，完全符合当前 publication/selection 模型。
- flag-off 恢复已区分“误关后恢复同一 operation”和“止血期间坚持人工 1338 流程”，不再把 operator 指向必然返回 503 的入口。
- 前三轮已确认的 operation fencing、Actions run correlation、resumable finalization、consumer migration 和 legacy observable-behavior sentinels均被保留。

## Issues & Recommendations

1. **[阻塞] first-class holder 尚未接入真实 founder approval ingress；QA teardown 后 holder 虽存活，✅ 仍会在写入前被现有 session guards 丢掉。**

   为什么重要：当前 reaction handler 明确要求 `session.status === "awaiting_review"`，并从 session 读取 `review_question_id`/head/card binding（`packages/teamlead/src/bridge/approval-signal/founder-reaction-approval-handler.ts:84-107`）；text handler 的 initial narrow 与慢分类后的 TOCTOU recheck 也都要求同一 session 状态（`founder-ship-approval-handler.ts:208-222,486-505`）。即使绕过这两层，共享 writer 仍在写 CommDB response/source event 前拒绝非 `awaiting_review|approved_to_ship` session（`write-gate-response.ts:252-280`），deferred rebind 又用同一 session binding 判断 gate 是否仍 alive（`deferred-approval.ts:537-579`）。这些正是 Round 4 计划允许 QA teardown 后变成 `completed|failed|blocked` 的位置。故当前改动表只列 `write-gate-response.ts` 且仅描述“第二窗口修复”还不够：`workflow_gate_holder` 可以保持 authority，却没有任何生产入口能消费 founder 的 ✅。这直接违反目标 ①和新增的第二个 teardown-window 测试，而不是一个后续优化。

   建议修复：在计划中定义一个 engine-only `GateAuthorityView/Adapter`（按 question id 解析唯一 current `workflow_gate_holder`，并校验 holder state、head、current card、founder attribution）；reaction、text、direct/consent writer、deferred rebind 和 card authority 在 engine-owned land variant 上统一读它，legacy 分支继续逐字读取 session。至少把 `founder-reaction-approval-handler.ts`、`founder-ship-approval-handler.ts`、`write-gate-response.ts`、`deferred-approval.ts` 及其 GatePoller/plugin wiring 列入 PR-2 改动面。测试不能只直接调用 StateStore projector：必须从“QA 已 teardown + founder 在已绑定 card 上点 ✅”开始，穿过 reaction poller → CommDB response/source → holder `approved` + claim + same land operation；text reply和 response-loss/deferred rebind各补一条 parity test。

2. **[阻塞] first-class holder/DAG 没有 founder reject/feedback 的收敛路径，会把已回答的 gate 永久卡住。**

   为什么重要：当前 founder text flow 把非批准决定写为 `{approved:false, feedback}`（`founder-ship-approval-handler.ts:515-519`），现有合同是“response durable + feedback wake intent”（同文件的 `DeferralSupport.queueFeedbackWake`，`130-141`）。但 engine-owned QA 被 `PhaseOrchestrator.onQaResult` 直接排除（`packages/teamlead/src/bridge/phase-orchestrator.ts:1178-1183`），而 QA PASS 已把 node 标成 done、submission credential 也已消费；所以旧的“唤醒 QA，再发 qa_result FAIL 进入 fix-loop”不能驱动 engine run。新 holder FSM 又只有 `approved|superseded`，计划未说明 reject 后谁将 holder supersede、谁把 current gate node推进到新的 Implement/QA attempt。结果是 CommDB question 已 answered、不再被 pending poller扫描，holder 却停在 `awaiting_review`，run 永久失去可达边。

   建议修复：为 land variant 明确定义 founder feedback transition。推荐将可信 reject 也写成 durable source event；StateStore 单 tx 把 current holder标为 `superseded(reason=founder_feedback)`、退休 question/card、使旧 head 的 approval authority 不可再用，并从 `approval_gate` 经 land-variant-only `founder_feedback_kickback` edge/loop 激活新的 Implement attempt，后续 QA PASS 创建新 attempt/head holder。若本单明确不自动处理 feedback，至少必须把 run置为 durable `held` + escalation，而不能留下 answered-but-awaiting holder；但这会是相对现有 three-stage feedback loop 的行为降级，应在非目标和验收中显式声明。补 crash tests：feedback response/source 已 durable 但 StateStore 未 apply、feedback transition 后新 dispatch 前重启、旧 card 在新 holder 出生后无法批准。

3. **[低] 三处残留表述仍指向被 Round 4 淘汰的模型，容易让实现按错对象落地。**

   为什么重要：流程图仍写 `holder=QA execution→awaiting_review`（计划第 114 行），D7 仍要求解析“唯一 gate-holder execution”（第 90 行），PR-3 切分仍写 `land seed(新 revision,不切默认 binding)`（第 156 行）。前两处与 first-class holder 冲突，后一处与“全新 template IDs/revision 1”冲突。

   建议修复：流程图改成 `workflow_gate_holder(source_execution=QA)`；D7 明确 engine run 解析 current holder record、legacy run 解析现有 session authority，两者进入同一 worker authorization result；PR-3 改成“new template IDs at revision 1, existing bindings unchanged”。

## Verdict

CHANGES REQUESTED — address items above
