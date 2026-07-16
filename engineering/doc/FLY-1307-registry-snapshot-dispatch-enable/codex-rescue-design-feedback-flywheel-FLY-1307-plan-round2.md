# Design Review — FLY-1307 plan.md (Round 2)

Date: 2026-07-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的七项 HIGH 都被实质采纳：transition 原子性、engine ownership、通用 decision、v1 typed snapshot、TURN run 归属和 USE-time ship gate 的方向现已与伞单及真实源码基本对齐。当前仍有四个实现阻塞点，来自修订之间的新组合矛盾——v2 fail-closed 被误写成 legacy fallback、PR-7 对 PR-7.5 形成反向依赖、materializer 缺少可持久恢复的 head/base 契约，以及 terminal gate 尚未映射到唯一权威调用面；另有一组 research/文字一致性问题需要同步清掉。

## What's Good (Keep)

- `commitWorkflowTransitionTx` 已把 completion/claim、credential consume、唯一选边、loop/attempt、events、projection 和 dispatch intent 收进同一 StateStore 事务，并明确 advance/reconcile 只能重放已持久化 transition；这关闭了 Round 1 最核心的半推进与双选边窗口（`plan.md:70-84`）。
- `engine_owned` 与 `claims_read_enrolled` 已正确解耦，belt 入口和三类在飞部署矩阵也明确列出；v1/v2 typed snapshot union、共享 strict parser 与 successor `StartRequest` 等价字段覆盖了 C→D 的真实边界（`plan.md:59-68,107-117,155-163`）。
- `/workflow/decision` 的 QA 硬编码事实已在 plan/research 中如实记录，engine-owned 路径不再调用 `onQaResult`，同时保留 legacy QA 字节兼容（`plan.md:86-95`; `research.md:55-59`）。
- loop 四要素、max-limit escalate、非法边 fail-closed 均未被重开；新的 transaction/barrier、review、deployment、TURN 与 ship-claims 矩阵覆盖方向正确（`plan.md:97-152`）。
- TURN 修订已从“有 source row”提升为 run-attributed authority：target_run_id、binding 校验、receipt 同事务 run event，以及四层 PR-8 hard gate 均与现有 CommDB/projector 缺口吻合（`plan.md:130-139,229-239`）。
- PR-7.5 选择复用既有 `intent_recorded→launch_committed→started|abandoned` 词汇而不重建 SQLite CHECK，是合理的低风险方向；docs_v1 也终于有 write/delete、路径、编码、大小和重复项的封闭输入轮廓（`plan.md:169-192`）。
- scope 和治理裁定仍保持：PR-7.5 独立、三片全落才关 D、不翻生产 flags、claims_read 前置不偷渡、FLY-1306/§3.3 non-goals 不进入本单。

## Issues & Recommendations

1. **[HIGH] 统一 flag 段把 v2 candidate 的缺旗行为写成 legacy fallback，直接违背已批准的 C fail-closed 门序。** `plan.md:203-209` 对 v1/v2 共用一句“任一不满足 ⇒ 精确 legacy 路径”，但 FLY-1281 的已批准契约明确区分：无 candidate 或 v1 candidate 才返回 null 走 legacy；一旦命中 v2 candidate，缺 `generalized ∧ claims_write` 必须拒绝且零副作用，绝不降级（FLY-1281 `plan.md:31-33,45-48`）。把新的 `template_dispatch/claims_read` 缺失也解释成 fallback，会让显式/绑定的 v2 workflow 静默跑成另一套 legacy workflow，并削弱 C 已批准的 fail-closed 性质。**建议修复：** 在 §4.1 写出 candidate-kind 真值表：无 candidate ⇒ legacy；v1 candidate 且 `template_dispatch=OFF` ⇒ legacy（保持 D 之前字节行为）；v1 candidate 在 dispatch 已请求但 claims 前置缺失 ⇒ fail-closed reject；v2 candidate 缺任何必需 flag（template_dispatch/claims_write/claims_read/generalized）⇒ fail-closed reject + 零副作用；engine-owned 事后缺旗 ⇒ hold。将 §4.3 flag 矩阵分别断言“legacy”与“reject”，不能只断言零 side effects。

2. **[HIGH] PR-7 的 review canonicalization 读取 PR-7.5 才创建的 materialized-head authority，当前切片形成反向依赖环。** 总览仍声明 PR-7 → PR-7.5（`plan.md:31-38`），但 PR-7 工作项要求从“PR-7.5 ledger 当前 accepted output”解析 review subject，并在 PR-7 验收中跑 review 正负、旧 materialized head 测试（`:86-95,148-152`）。现有 ledger 没有 materialized head 字段/API，源码也没有 materialized-head authority；因此 PR-7 无法在不预做 PR-7.5 schema/API 的情况下完成这些验收，而 PR-7.5 又声明依赖 PR-7。**建议修复：** 明确一个单向边界：PR-7 定义 `MaterializedHeadAuthority` port + `materialized_head_unavailable` fail-closed 行为，使用 fake 做 family/predicate/同厂商/transition 单测；PR-7.5 交付 durable provider 并承接真实 head、stale head、response-loss 的 integration tests。或者把 materialization receipt schema/API 前移到 PR-7、PR-7.5 只实现 git side effect。同步调整 §1 依赖图和 §2.3/§3 验收归属，避免两个 PR 都声称拥有同一 positive E2E。

3. **[HIGH] materializer 状态词虽已选定，但 durable identity/evidence 仍无法落到现有 DDL，`same output = same head` 也缺少 base-head 与 crash adoption 契约。** 当前 `workflow_side_effect_ledger` 只有 `(run,node,attempt,kind,launch_ordinal,execution_id,state,reason,timestamps)`，没有 output digest、base head、materialized head 或 remote-push evidence（`StateStore.ts:15978-15995,16165-16184`）；现有 transition API 还把 `kind='dispatch'`/真实 execution_id 写死（`:16447-16535`）。`plan.md:182-186` 说 intent 钉 digest、`launch_committed` marker=head、fence identity 含 output_digest，却没有规定这些值存哪、`execution_id/launch_ordinal` 在 materialize 行中的语义，以及 review/founder 如何从重启后的 StateStore 权威读取 head。更重要的是 write/delete 是相对 base 的 delta：只凭 output digest 不能决定 tree/head；git commit 后、ledger/marker 前崩溃也可能重建出第二个 commit。**建议修复：** 钉死一种持久形状（推荐 append-only `workflow_materialization_receipt`，或 side-effect ledger 的加性 nullable evidence 列），至少保存 effect/fence id、output_id+digest、server-derived repo/ref、**base_head**、tree/commit head、push-confirmed remote head；说明 ledger `execution_id` 是否改作 materialization effect id以及不会污染现有 execution-attribution 查询。定义 marker/ref adoption：intent 后以 deterministic ref/trailer 找到已产生 commit，校验 base+tree+digest 后原子采用为 `launch_committed`；remote ref 等于该 head 才进入 `started`。同时在 `docs_v1` 处明确选择：保持 manifest 外层 `output.schema='json_v1'`、在 payload 内用 docs_v1 discriminator，还是扩展 closed `WorkflowOutputContract`/snapshot parser/seed/`submitWorkflowNodeOutput`（当前四处只接受并落库 `json_v1`，见 `workflow-template.ts:48-50,695-716`; `workflow-run-snapshot.ts:290-304`; `StateStore.ts:14313-14412`）。不能把这个选择留给实现者。

4. **[HIGH] `ship_claims` USE-time 原则已写对，但没有定义 predicate→claim authority 映射和覆盖全部终局写点的唯一调用 seam。** `plan.md:119-128` 只说“逐项解释”并在任何 completed/Done/merge 前执行；现实中 `resolveWorkflowDecisionClaim` 需要明确的 nodeId、decisionKind、subjectKind/digest，而 `design_review_approved` 与 `codex_approved` 同属 `review_verdict`，若不检查 exact expected predicate 会误消费另一种 pass。生产终局也不止一个写点：现有 `merge-ship-gate.computeAuthoritativeShipDecision` 明确服务 DirectEventSink、event-route、W2、marker reconciler，`finalizeRecoveredMerge` 还直接写 completed（`merge-ship-gate.ts:1-13,198-291`），另有 close/finalize/reconcile 面；product-v1 无 PR 时还没有被命名的 run-level terminal driver。仅靠“任何之前”不能证明不存在 bypass。**建议修复：** 给出封闭映射表：`qa_passed → qa node/current attempt/qa_verdict/exact qa_passed/PR head`；`design_review_approved → review node/current attempt/review_verdict/exact design_review_approved/current materialized head`；`founder_approved → run-level founder_decision/exact founder_approved/同一 authoritative head`。再命名一个 composite authoritative seam（legacy decision 原样 + engine-owned additive result），列出并测试所有 status/Done/merge/finalize caller；product-v1 明确由哪个 founder-source/projector/advance 入口触发 run terminal CAS。反例测试应逐一绕每个 caller，而不是只测 resolver 本身。

5. **[MEDIUM] research.md 仍保留两条与本轮修订相反的审计结论，另有两个会让机械实现/测试分叉的未收敛措辞。** `research.md:38-40` 仍称 ledger 是 `intent→committed→done` 且 materialize kind 待落地，与同文件 `:84-89` 的正确说明冲突；`:79-80` 仍说 D 沿用 `claims_read_enrolled`、不新增 marker，与 plan 的 `engine_owned` 正相反。plan 又把 marker 写成 `engine_owned ... 或等价 typed 列`（`plan.md:62-64`），而 R1/本轮摘要已明确选择 column；registry sentinel 的“three-stage-phases 不再含角色字面量”（`:53-55`）也会误伤必须保留在该文件的 `DEFAULT_PHASE_DISPATCH` role keys。**建议修复：** 删除 research 旧句并以 engine-owned/现有 ledger 状态重写 A.2/B.3；plan 只保留确定的 `engine_owned INTEGER NOT NULL DEFAULT 0`；把 drift sentinel 限定为 badge/isPhaseRole/completion-role 的重复实现或 forbidden imports，明确豁免 dispatch table 的 design/implement/qa keys。

## Verdict

CHANGES REQUESTED — address items above
