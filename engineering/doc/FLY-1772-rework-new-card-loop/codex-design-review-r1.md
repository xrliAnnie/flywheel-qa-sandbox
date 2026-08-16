# Design Review — plan.md (FLY-1772) (Round 1)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向可行：新 holder/materializer、Discord PATCH、workflow alert outbox 和现有 GatePoller tick 足以承载这次改动，也保持了 FLY-1655/1765/1731 的边界。当前计划仍没有覆盖实际旧卡输入的前门丢弃，并漏掉一个生产 supersede writer；另有几处失败/崩溃窗口会使“作废或告警恰一次”的承诺失真，因此尚不能进入实现。

## What's Good (Keep)

- 保持“一轮打回 = 一张新卡”，没有复活旧 holder、没有向 founder 发送点错卡回执，也没有打开终态复活边。
- 复用 `workflow_alert_outbox`、`workflowGateMaterializeTick`、`editDiscordMessageInChannel` 和既有 holder 状态机；零新 timer、零新 env/flag，范围与 founder 的简化要求一致。
- D3 对“可绑定既存 run 的 source deadletter”选择 deadletter + outbox 同一 StateStore 事务，方向正确；`escalation_uid` 与恒定 payload 的冲突约束也被注意到。
- 用真实 compiled `tpl_code` 把 founder kickback、FLY-1765 rework、QA retest、gate 重入、新卡批准和 land 串成一条回归，是本单最有价值的验收护栏。
- D2 使用 holder 行作 durable intent，Discord 成功后重复编辑天然幂等，404 在已知精确 thread 上可视为目标态已达成。

## Issues & Recommendations

1. **D3 没覆盖事故最关键的“source event 生成前”旧卡输入，验收中的“任何旧卡输入都有 Lead 告警”仍不成立。** `GateAuthorityView` 只返回 current holder，reaction handler 也只扫描 pending/current `awaiting_review` gate；superseded/`terminal_disposed` 旧卡因此通常不会进入 `writeGateResponseAndRunPostWrite`。即使走到 CommDB，`insertFounderApprovalResponseWithSource` 在 question 非 answerable 时直接返回 `false`，不会写 `workflow_source_event`（`db.ts:1855-1876`），projector/D3 自然无从看见。计划 §2.2 的阴性 b 直接伪造 source event 调 apply，只覆盖“后门”，绕过了真实前门。**建议：**在能观察到 founder signal 的 canonical ingress 增加 Lead-only、durable、message/question-bound 的 wrong-card alert（不回复 founder）；reaction 需要在既有 GatePoller tick 上有界检查已作废卡，text/reply 需在引用旧 `gateMessageId` 被 current-gate narrowing 拒绝时落同一类 alert。测试必须通过真实 reaction/text handler 和 CommDB guard，断言零 response、零 source receipt、founder 零消息、Lead outbox 恰一条，而不是手工注入 `applyWorkflowSourceEvent`。

2. **D2 的 supersede writer matrix 漏了生产 `operator_rework` 路径。** 除计划列出的四处外，`operatorReworkWorkflowRun` 在 `StateStore.ts:25510-25517` 也会把 materializing/awaiting/approved holder 写成 `superseded`，reason=`operator_rework`。它一旦被漏掉，之后的 `new_gate_attempt` UPDATE 只匹配非终 holder，不会再把这张旧卡补成 `pending`，卡面会永久保持可操作外观。**建议：**把五处生产 supersede 全部收口到一个 transaction-local helper，统一写 state/reason/void intent；为 `operator_rework` 定义确定性作废文案，并增加 operator rework 有卡/无卡测试。用全仓 UPDATE 扫描作为 writer-matrix sentinel，避免以后新增第六处又漏接。

3. **D1-α 没明确处理 materializer 的正常失败返回，而且进程级连续失败 Map 会在重启时重新静默。** `materializeWorkflowGateHolder()` 不只会 throw，还会返回 `{ok:false, reason}`（例如 missing message id、binding conflict、materialization incomplete）；当前 `plugin.ts:7220-7257` await 后完全忽略返回值。若实现只在 catch 里计数，这些失败仍永不告警。即使两类都计数，Bridge 每次重启都会清空 `consecutiveFailures`，频繁重启可无限推迟 severe alert。**建议：**显式把 throw 与 `ok:false` 归一成失败。更简单且更可靠的方案是去掉 Map：holder 已超龄 10 分钟后，任一失败就 ensure 同一个 durable outbox UID，outbox 自己负责跨重启恰一次；若坚持三次门槛，则必须把计数持久化。测试同时覆盖 returned-false、throw、Bridge restart，并固定完整 payload（包括 `leadId`/`leadResolution`/`executionId`/新增 disposition），不能只断言 issue/question/head 四个字段。

4. **void 第五次失败与 `card_void_stuck` 告警没有被明确放在同一事务，存在永久漏报窗口。** 若 `advanceWorkflowGateCardVoid` 先把行改成 `failed`，随后再调用公开 `enqueueWorkflowEngineAlert`，两者之间 crash 后 sweep 不再捞该行，告警永远不会补。条件 UPDATE 只能防状态覆盖，不能闭合这个窗口。**建议：**让 transaction-local helper 在同一 StateStore transaction 内完成 pending attempts CAS、第五次 `pending→failed`、`enqueueWorkflowEngineAlertTx` 和确定性 run event；保存失败则整组重放。增加“failed 状态提交前/告警 enqueue 前 crash”重放测试，以及两个 worker 同时报告第五次失败时仍只落一条 outbox 的测试。

5. **fallback thread 上的 404 不能证明原卡已删除，且 tick 尾部顺序不支持计划声称的展示时序。** `getChatThreadByIssue(issue, currentLead.chatChannel)` 是猜测的当前 thread；Lead/channel 换代后，对错误 channel/message 组合也可能得到 404，此时标 `done` 会把真实旧卡留在原 thread。精确 `(question, head)→threadId/messageId` binding 才有资格把 404 当目标态。另因 void sweep 被放在 materialization 尾部，重启/积压时新卡可能先发出、旧卡后编辑，不能声称“出新卡时旧卡已是作废态”。**建议：**优先使用 immutable binding；binding 缺失时从同一 `founder_thread_notified` audit 的 exact `gateMessageId` 恢复 thread，仍无法证明时失败重试/告警，绝不把 guessed-thread 404 当 done。每 tick 先跑 bounded void pass 再 materialize，并增加“启动时旧 pending + 新 holder 同时存在”及 Lead/channel 换代 404 测试；若不要求严格先后，需删除 §8 的强保证表述。

6. **D3 的 malformed/unresolvable-run fallback 不是 durable，并与当前 plugin 启动顺序/异步 API 不匹配。** projector 是同步 drain，且在 `plugin.ts:4238` 启动并立即 drain；`routedAlertSinkHolder`、`leadAlertNotifier` 和 routed sink 分别到约 6944/7704/9240 才可用。计划的 `alertFallback(payload): void` 实际要调用返回 Promise 的 notifier：fire-and-forget 失败后 cursor 仍会前进；若 deadletter 已插入后 fallback throw/crash，下次 drain 先看到 deadletter 并 skip，告警同样永久丢失。这与 D3 的 durable 承诺冲突。**建议：**优先复用已有 `resolveWorkflowRunAlertIdentity`，并在 StateStore 内校验 run 的 project/issue 与 source payload 精确绑定，不能只接受“某个既存 run_id”。对无可绑定 run 的 founder row，要么接一个真正 durable 的通用 Lead alert outbox 并在同一可恢复协议里落账，要么把 projector 改为 async、等待 sink ready/accepted 后才终结 deadletter；同时把 projector wiring 移到 alert sink ready 之后或使用显式 readiness gate。增加 deadletter commit 后、fallback accepted 前 crash 的重启测试。

## Verdict

CHANGES REQUESTED — address items above
