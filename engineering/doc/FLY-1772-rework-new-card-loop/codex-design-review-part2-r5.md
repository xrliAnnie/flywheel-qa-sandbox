# Design Review — plan.md Part 2 (Round 5)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

R4-1 已正确收敛：计划现在覆盖 `tpl_code` 的真实 decision mint seam、completion seam，并用生产 `/workflow/decision` 路由防止手工 `gateEntryBinding` 造成假绿。R4-2 已去掉不可达的 D1-α 声明，但新增 durable alert 尚未定义可抗回滚/crash 的 producer 事务和 payload-constancy 合同，因此仍需一轮小幅修订。

## What's Good (Keep)

- §13.6′ 现在准确指出 `qa_pass` 的生产入口：`resolveGateEntryBinding` → `submitWorkflowDecisionByCredential` → `recordWorkflowGateEntryBindingTx`，并保留 completion 作为第二条合法 seam。
- §15.7 要求从真实 `/workflow/decision` 驱动 QA PASS，同时明确禁止扩展 `StateStore.founder-kickback-newcard-loop.test.ts:152-176` 的手工 binding 注入形态；这是有效的 anti-vacuous-green 边界。
- 负例改成 typed 409、credential 未消费可重试、零 gate/holder mutation，和当前事务行为一致；stable per-attempt uid、severe、Lead-only 的告警方向也合理。

## Issues & Recommendations

1. **[HIGH] 新 `land_head_unavailable` outbox 还没有可抗事务回滚和 crash 的精确 producer 合同。** 真正能观察拒绝且已经脱离失败事务的位置有两个：`commitEnrolledCompletion` 的 catch（`StateStore.ts:29383-29411`）和 `submitWorkflowDecisionByCredential` 的 catch（`:29868-29899`）。若在 `commitWorkflowTransitionTx` 或其外层失败事务内 enqueue，告警会随 transition 回滚；若沿现状先用 `appendWorkflowRunEventChecked` 单独提交 refusal event、再另启事务写 outbox，则两次提交之间 crash 会留下“已记录 refusal、无告警”的永久缺口，单次请求不满足 durable fail-loud。建议在两个 catch 共用一个 post-rollback helper，并在**同一个新事务**中完成 checked refusal event、`enqueueWorkflowEngineAlertTx` 和 `alert_enqueued` receipt，再返回原 typed refusal；completion 与 decision 两条 seam 都要有 crash/replay 测试，且断言 credential/completion 主事务仍未消费、零 gate/holder mutation。

2. **[MEDIUM] 新告警缺少编译与幂等所需的 payload 合同，且 §13.6′ 仍残留一处旧事实。** `WorkflowEngineAlertPayload.metadata.workflowEngine.disposition` 是闭合 union（`StateStore.ts:41500-41532`），§14 没有声明新增字面量；同时 `enqueueWorkflowEngineAlertTx` 对同 uid 要求 `payload_json` 逐字节相同（`:25651-25663`），但 Lead identity 可能在重试间漂移，required `executionId` 也可能随同 attempt 的 actor replacement 改变。仅写“payload 静态”不足以避免 `workflow_alert_uid_conflict`。建议明确 disposition（如 `land_head_unavailable`）、共享 payload builder、existing-outbox 同 run 快路与冲突重读规则，并测试重启重放、Lead identity 漂移及同 attempt replacement actor；§14 同步列出 union/helper/catch 位点。另将 §13.6′:306 的“binding 铸造只发生在 completion 路径”改成“两条 gate-entry seam”，否则它与紧随其后的 R4-1 定义直接矛盾。

## Verdict

CHANGES REQUESTED
