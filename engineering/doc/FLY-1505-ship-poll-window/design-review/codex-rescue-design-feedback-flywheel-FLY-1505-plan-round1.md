# Design Review — FLY-1505 plan.md (Round 1)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案的主方向正确且能在现有架构内落地：延长 prompt 合同，同时在服务端保住 `approved_to_ship`，并保持 `verify-approval` 与 FSM 安全不变量不变。reconciler 经 loopback 重放后按保留状态验收的设计也是一致的；但当前计划会漏掉真实绑定会话的 DirectEventSink 路径，并且没有处理 receipt 代际关联和现有 stale-approved 自动 re-wake，因此还不能进入 Implement。

## What's Good (Keep)

- C1 + C2 的“双层防御”合理：prompt 修复新 spawn，服务端 deflection 兜住在飞旧协议 runner 和未来文本漂移。只改 prompt 不足以处理本次事故类型。
- 不放宽 `verify-approval`、不新增 `blocked → approved_to_ship` FSM 回边、也不在 CLI 重复实现 StateStore 权威判断，边界选择正确。`verify-approval.ts:559-583` 的 status/head 校验应保持原样。
- event-route 已有 `existingSession` / `isPostApproveShip`，DirectEventSink 已有 `preExistingSession`，reconciler 已拿到 `currentStatus`；就这三个 deflection 判断本身而言，“零新查询”可实现。
- `expectedStatusFromMarker(blocked, "approved_to_ship")` 改为 `approved_to_ship` 与 reconciler 的真实控制流一致：它通过 loopback `/events` 重放，再重读 session 状态，不能只相信 HTTP 2xx。
- `session_params` marker、sink-agreement 测试、旧 prompt PIN 更新和 cross-file workflow-budget 测试都符合现有模式。把“25 分钟 job”映射为“窗口预算静态合同 + 错误 blocked emission 不能作废批准”的测试是诚实且足够的，不需要伪造 25 分钟墙钟测试。
- 保留 `session_failed` / `goal_blocked` 的既有语义是合理的明确非目标；源码中该路径独立于 `session_completed route=blocked`。

## Issues & Recommendations

1. **[HIGH] C2(b) 复用的 `isPostApproveShip` 会排除本次最需要保护的真实绑定会话。** `DirectEventSink.ts:626-628` 的现有变量实际是 `status === "approved_to_ship" && !desPhase2Bound`；只要有 `review_question_id` 就为 false。这一收窄是 FLY-191/208 为 qid-less evidence-gap 路径刻意加的保护，而 plan.md:99 却要求直接复用它。结果是带真实批准绑定的 session 仍会落到 `DirectEventSink.ts:749`，被写成 `blocked`。建议新增语义独立的原始谓词，例如 `isApprovedToShip = preExistingSession?.status === "approved_to_ship"`，仅用于 FLY-1505 deflection；保留现有窄化谓词供 needs_review/auto_approve evidence-gap 分支使用。T3 必须创建带真实 `review_question_id` 的 approved session，并同时加一个未绑定兼容用例，防止测试只覆盖容易通过的 legacy 形态。

2. **[HIGH] 显式失败早停没有绑定本次 `:cool:` attempt，会把旧 receipt 当作当前失败。** plan.md:58 查询的是 PR 上最后一条任意 `flywheel-ship-receipt`；workflow 明明在 started/success/failure 三种 receipt 中都写了 `trigger_comment_id`（`.github/workflows/ship-on-comment.yml:55,170,202`）。同一 head 重试时，如果新 workflow 仍在排队、尚未写 started receipt，上一轮的 `status=failure` 会让 runner 立刻误报 SHIP-FAILED。建议把发 `:cool:` 的步骤改成可捕获返回 comment id 的 GitHub API 调用，并只接受 `trigger_comment_id=<本次 id>` 且 head 与当前批准 head 一致的 receipt；当前 attempt 尚无 receipt 时继续等待，不得回退读取旧 attempt。增加“同 PR/同 head 存在旧 failure、当前 trigger 尚无 started”以及“当前 trigger failure”两个 prompt/解析回归场景。

3. **[HIGH] 保留 `approved_to_ship` 会触发现有 stale-approved watchdog，当前计划对 runner 生命周期的描述不成立。** `stale-approved-ship-reconciler.ts:49-59` 会把闲置的 bound `approved_to_ship` 视为候选；`gate-poller.ts:3818-3862` 默认每 5 分钟重新发送 `approval_wake`，而 wake 文本会让 runner 再跑 verify 并 ship。也就是说 deflection 后并非“告警 Lead、等 Lead 唤醒”，live runner 可能自动反复发 `:cool:`，与 plan.md:64/192 的恢复协议冲突；`ask --report` 本身也是 fire-and-forget，并不是一个可等待的 recovery gate。三阶段 keep-alive 角色还要求在 phase boundary 显式 `park`/TURN 交接，通用的 “STAY” 不够精确。计划需要明确一种闭环并加测试：推荐让当前-head 的 `fly1505_ship_attempt_failed` marker 暂停 stale approval re-wake，改由 durable Lead recovery 明确唤醒；同时定义 marker 在人工同-head retry、head 变化和成功 merge 时如何清除/失效。至少测试“deflected current head 不自动 approval-rewake”“普通 stranded approval 仍会 re-wake”“phaseKeepAlive 失败后会 park，resident Codex/Claude 各自按真实 transport 等待”。

4. **[MEDIUM] 告警、去重和测试合同目前有几处不可兑现的表述。** C4 复用的 precedent 明确是 best-effort 且 catch 后吞掉异常（`auto-qa-coordinator.ts:907-930`），所以 plan.md:169/192 的“告警必达 Lead”不成立；对旧协议 runner 的服务端 deflection 也无法证明它已经等了 40 分钟，C4 文案不应声称“在 {window} 分钟窗口内未合入”。请改成事实型告警：“收到 approved_to_ship 后的 blocked completion，状态已保留”，并把可靠恢复建立在 durable marker/report/outbox 上，而不是 best-effort alert。另请明确 T2 的“重复 POST”使用新的 `event_id`；event-route 在 `event-route.ts:1008-1022` 会对同一 event id 直接返回 duplicate，同 id 不可能把 `attempt_count` 增到 2。还应规范化缺失 `head_sha` 的比较，避免 unknown-head 重放破坏 once-per-head 语义。

5. **[MEDIUM] FLY-1448 接缝与 cross-file 测试还需要更严格的实施门。** 当前 checkout 能看到 `ship_parked` 等已落地底座，但本地没有 held PR 的 tip，因此“只有文本冲突、没有语义冲突”不是由本轮源码可证明的结论；FLY-1448 正好改 wake/park/外部权威收敛，而问题 3 也落在该接缝。计划应把“在 FLY-1448 最终 tip 上重新审计 event-route、GatePoller/stale-approved、phase park 和 `ship_parked` 投影，并重跑 T2-T6”列为硬实施门，而非只写 rebase 冲突处理。C5 也建议锚定 `jobs.ship.timeout-minutes` 并断言唯一命中，避免未来增加其他 job timeout 后窄正则误读第一处；同时说明常数 `margin=5` 是最低合同，而当前 40 对 30 的实际余量是 10 分钟。

## Verdict

CHANGES REQUESTED — address items above
