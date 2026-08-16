# Design Review — plan.md (FLY-1772) (Round 2)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

新版方案在统一 supersede writer、void 失败原子告警、精确 Discord 线程证据和真实前门回归上明显更完整，整体架构可以基于现有 holder、outbox 与 GatePoller 实现。当前仍有几个实现阻断项：D3 的落账顺序在计划内部自相矛盾，D4 的轮询既不具备总量边界/公平性，旧卡文字回复还可能被现有 fallback 误绑到新 gate；因此本轮尚未达到 implement-ready。

## What's Good (Keep)

- 五个生产 supersede writer（包括 `operatorReworkWorkflowRun`）收口到 tx-local helper，并记录 `superseded_from_state`；writer-matrix sentinel 能防止第六个旁路 writer 悄悄出现。
- void pass 只接受 immutable binding 或 exact `founder_thread_notified.gateMessageId`，不再猜当前 issue thread；404、第五次失败及 run event/outbox 的事务边界也定义得清楚。
- void pass 前置、跨重启只承诺收敛，以及 old-pending/new-holder coexistence 的测试方向，正确处理了 Discord 副作用不存在全局事务顺序的现实。
- materializer 同时归一 `{ok:false}` 和 throw，并删除进程级连续失败 Map；这比 R1 的原方案更符合已有 durable outbox 模式。
- D4 保持 Lead-only、founder 零回执，并要求前门 E2E 经过真实 reaction handler 与 CommDB guard，而不是伪造 source event，测试边界正确。
- D3 增加 run 的 issue/project 精确绑定并复用 `resolveWorkflowRunAlertIdentity`；这关闭了把 founder 告警挂到错误 workflow run 的身份漏洞。

## Issues & Recommendations

1. **D3 的“fallback durable-accept 先于 deadletter”目前无法按计划实现。** §4.1 明确规定 `recordWorkflowSourceDeadletter` 先执行 `INSERT OR IGNORE`，run 不可绑定时返回 `{deadlettered, alertEnqueued:false}`；§4.2 又先调用该 recorder，然后声称 fallback `accepted:false` 时“不 deadletter”。现有 recorder 本身也是立即插入并保存（`StateStore.ts:32466-32482`），所以 §7.4 的“fallback 拒绝 → 无 deadletter”测试会与 §4.1 的实现合同直接冲突。建议在任何写入前先做 read-only payload/run binding 分类：精确绑定的 founder row 走单事务 `deadletter + outbox + run event`；不可绑定的 row 先 `await alertFallback`，只有 `accepted:true` 后才调用不带 `founderOrigin` 的 legacy recorder 并推进 cursor。补测 fallback 拒绝/throw 后 deadletter 表确实为空，并明确 `workflow source run unavailable`（当前属于 retryable，`founder-approval-projector.ts:68-71`）何时才可转入该 terminal fallback。

2. **async projector 的启动接线仍有 TDZ 与重入窗口。** `startWorkflowSourceProjector` 会立即 drain（`founder-approval-projector.ts:172-179`），但当前 plugin 在 4238 启动 projector，`routedAlertSinkHolder` 到 6944、`leadAlertNotifier` 到 7704 才声明；仅把访问放进 closure 并不能让启动期调用变成 `accepted:false`，启动库里已有不可绑定 founder row 时仍会触发 temporal-dead-zone `ReferenceError`。同时把 drain 改成 Promise 后，原 `setInterval(drain, 5s)` 会允许慢 fallback 重叠处理同一 cursor。建议把一个只含 `current?: AlertSink` 的 holder 声明移到 projector 启动之前，启动期 callback 只读该 holder（不要直接引用后声明的 notifier），sink 就绪后再赋值；`startWorkflowSourceProjector` 增加 single-flight/coalescing 和顶层 rejection containment。增加“boot 首次 drain 即遇 poison row”及“fallback 慢于 interval 仍不并发”的测试。

3. **D4 reaction watch 的 `LIMIT 10` 既不是总量有界，也不公平。** 该 callback 每个 GatePoller tick 都运行（`gate-poller.ts:635-643`），生产 interval 是 3 秒（`plugin.ts:7420-7428`）。一个 48 小时内始终没有 reaction 的卡会被拉约 57,600 次；10 张卡最多约 576,000 个 GET，而 `updated_at DESC LIMIT 10` 会反复选中同一批最新卡，使第 11 张及更老的未告警卡可能一直饥饿到超出 48 小时。建议仍复用现有 tick、不开 timer/env，但增加固定常量 cadence 与可公平推进的 durable `last_checked_at/next_check_at`（或等价 cursor），按“最早到期”取 10 条并在无 reaction 时也推进检查账本；测试不仅断言单 tick 截断，还要断言 11+ 张卡最终全部被观察且模拟 48 小时的 GET 总量有硬上界。另请把“任何 reaction”收窄为本单定义的 `✅`，因为现有 `ReactionFetcher` 是按单个 emoji 拉 reactors 的 API。

4. **旧卡 REPLY 仍可能真正操作新 gate，违反“旧卡永不接受操作”。** 计划 §5.2 只在消息“未被 current pending gate 吸收”时告警，并承诺 narrowing 零变化；但现有 deliverer 在旧卡 reference 无法命中 current binding 后，会执行 `cardGate ?? sole shipGate`（`founder-reply-deliverer.ts:601-630`）。因此当新卡已出现且只有一个 current ship gate 时，founder 在旧卡下回复 `ship` 可被 Tier-2 当作新 gate 的批准，而不是仅仅被静默丢弃。建议让 exact superseded-card reference 在 `messageGate` fallback 之前具有最高优先级：durable enqueue `voided_card_input:{question_id}` 成功后将该输入处置为 old-card misuse，绝不调用 `tryFounderShipApproval` 或写 current gate；告警失败则 pin/retry。新增一条真实测试：新 gate awaiting_review + REPLY 引用旧 `card_message_id` + 内容 `ship`，断言新旧 question 均无 response/source event、只有一条 Lead 告警且 founder 零消息。

5. **D1 stall 告警还没有满足“恒定 payload + 真实仍卡住”的条件。** materialization 期间 holder 可被 founder feedback/operator rework supersede；当前 materializer 的异步阶段会因此返回失败或 throw，若直接使用 tick 开始时的 aged holder 就会对已经消失的 holder 发假告警。并且 §3.1 同时声称 payload 是恒定身份函数、body 又包含本次 `reason`，还包含可能随 Lead 归属变化的 resolver 结果；盲吞 `workflow_alert_uid_conflict` 会掩盖同 UID 不同 run/payload，而该异常正是 `StateStore.ts:25628-25640` 的完整性保护。建议失败后重新读取并确认同一 `question_id/run/head` 仍处于未完成 materializable 状态且 run active，再考虑告警；要么让 payload 完全静态（reason 只写日志），要么先查既有 outbox 并把首次快照作为唯一 payload。冲突只能在重新读取既有行并验证同一 run/语义后视为已入队，不能一律吞掉。补测 materialize await 期间 supersede/complete、连续两次不同 reason、以及 Lead identity 漂移。

6. **需要把新 alert schema 与 helper 的 mutation fence 写进实施合同。** `WorkflowEngineAlertPayload.metadata.workflowEngine.disposition` 是闭合 union（`StateStore.ts:40878-40921`），目前没有 `gate_materialization_stuck`、`card_void_stuck`、`founder_input_deadletter` 或 `voided_card_input`；计划的文件清单/测试也没有说明新增或复用哪个 disposition。D4 reaction/text 共享同一 UID，还必须共享一个逐字节相同、与 ingress kind 无关的 payload builder。另一个小但重要的 fencing 点是：现有 founder_feedback writer 按 exact question 更新并要求 `getRowsModified() === 1`，而新 helper 签名只有 `{runId, gateNodeId?}`；请让 helper 支持 exact `questionId/fromState` scope、返回更新行/计数，并保留 founder 路径的 exactly-one 断言。把新 disposition、共享 builder 和 helper row-count 测试加入 §6/§7。

## Verdict

CHANGES REQUESTED — address items above
