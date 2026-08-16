# Design Review — plan.md Part 2 (Round 4)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

两项增量方向都正确：返工 attempt 必须重新取得当前 PR binding，且 advisory hint 的失败绝不能吞掉已判定的 reject。不过 §13.6′ 对 `tpl_code` 的实际 binding 铸造入口描述不完整，并承诺了一个当前架构不可达的 D1-α 告警，因此尚不能按现文实施和验收。

## What's Good (Keep)

- “latest attempt 才是 current binding”这一根因判断准确：`currentWorkflowPrBindingRows` 以 `workflow_run_node.MAX(attempt)` 收窄，再按 exact attempt join binding；返工开新 attempt 后旧 binding 确实退出 current window。
- 对 design / implement / qa 全目标、每一轮都要求机器铸造，并在 e2e 中禁止手工 `INSERT`，是正确且非空洞的验收边界；`recordWorkflowNodePrBindingTx` 的 `currentMax > attempt` fence 也确实允许同 head 写入更高 attempt。
- §13.2 的 fail-loud 分界合理：只有在 reject decision 已经成立之后，target-only 解析/映射失败才可降级为无 hint；现有 `decision_classification_failed`、reject durable write、Part 1 D3/D4 均保持原语义。异常注入后仍写 reject、继续 kickback、零 hint 的测试应保留。

## Issues & Recommendations

1. **[HIGH] §13.6′ 把 `tpl_code` 的实际 QA→gate 铸造路径误写成 completion/prBinding 单一路径。** `code.yaml` 的 `qa_pass` 是 `qa_verdict` decision，不是 `commitEnrolledCompletion`；生产入口在 `bridge/workflow-decision-routes.ts:228-334` 解析 `gateEntryBinding`，随后由 `StateStore.submitWorkflowDecisionByCredential` 在 `:29716-29743` 调 `recordWorkflowGateEntryBindingTx`，写到 credential 所属的 exact QA attempt。现有 Part 1 整环测试还在 `StateStore.founder-kickback-newcard-loop.test.ts:152-176` 直接手工传入 `gateEntryBinding`，所以仅扩展这类 Store 测试会把真正缺失的生产 producer 绕过去，形成假绿。建议把 §13.6′ 和文件表改成“两条 gate-entry mint seam”：completion 路径与 decision 路径；对真实 `tpl_code` 明确要求从 `/workflow/decision` 生产路由驱动 QA PASS，证明最新 QA attempt 的 worktree binding 与 producer PR identity 能让 `resolveGateEntryBinding` 产出 binding，并由 Store 写到该 attempt。失败复现可以先定位根因，但不能继续把 decision seam 留在嫌疑面之外。

2. **[HIGH] “铸造被压掉时由 Part 1 D1-α 看见”的验收在当前时序上不可达。** `commitWorkflowTransitionTx` 在 `StateStore.ts:30366-30375` 先做 land binding 校验并返回 `land_head_unavailable`；gate node、holder 和卡片要到 `:30882-30911` 才创建。D1-α 则只枚举既存 materialization holder，并且只在一次 materialize 失败后告警，因此这个负例没有 holder，也不可能产生 `gate_materialization_stuck`。建议采用更小且诚实的合同：删除 D1-α 断言，将负例定义为 decision/transition 调用方收到明确 409/typed `land_head_unavailable`、凭据可重试且零 gate/holder mutation；若 Lead 的 HARD 约束还要求 durable Lead 告警，则必须在 transition refusal 的可观测调用层新增独立、按稳定 uid 幂等的 outbox 告警及测试，不能声称 Part 1 已覆盖。

## Verdict

CHANGES REQUESTED
