# Design Review — plan.md (Round 3)

Date: 2026-08-26
Author: Codex
Status: CHANGES REQUESTED

## Summary

频道单车道、删除 mailbox ticket 腿并同时删除 Hub 自动 @founder 的方向在现有架构上可实现，诊断也与源码一致；affirmative G0、同 PR/同部署以及 flag 墓碑都是正确约束。但当前计划漏掉两处会破坏 `NEW`/`repair_status=NULL` 合同的生产状态种子，也没有为 Hub 缺席时的唯一车道定义 fail-closed 行为，删除清单、RED 与部署验收仍有可导致假绿或运行时断裂的缺口。因此本轮不能批准实施。

## What's Good (Keep)

- exploration.md 的因果链与代码一致：FLY-1764 的 `ticketSink` 是主腿，只有 `copyTicketToChannel() === true` 才调用 Hub；Hub 本身并未坏掉。
- 将频道切换与所有 Hub 自动 founder paging/自动 `ESCALATED` 删除放在同一 PR、同一次部署，并用 affirmative G0 阻止含糊或无回复时发版，保留。
- 删除双投后，同一 `eventId` 不再同时进入 mailbox 与频道；notifier claims、20/min 限速、durable queue drain 后回接 Hub 的现有机制没有新增去重冲突。
- `plugin.ts:5150/7419/7491` 的三个定向 `enqueueInfraAlert` 消费者与 Router ticket 腿分离；保留 `formatInfraAlertMailboxContent` 即可不受 T1–T3 影响。
- 将 `FLYWHEEL_ALERT_COPY_TO_CHANNEL` 从 `NON_FLAG_ALLOWLIST` 移入 `RETIRED_FLAGS`、`retiredBy: "FLY-2075"` 是符合现有 truth governance 的删除方式。
- Router → 真 `AlertChannelHub` → 真 in-memory `StateStore` 的端到端测试可用现有 fixture 搭建。本轮基线执行的 teamlead 聚焦测试为 8 files / 114 tests 通过，config flag-truth 为 28 tests 通过；shell harness 因受限环境中的 tsx IPC `EPERM` 未完成，未作为通过证据。

## Issues & Recommendations

1. **HIGH — `NEW` / `repair_status = NULL` 的核心状态合同按清单实现后仍会失败。** `infra-alert-wiring.ts:208-215` 在 Hub 之前仍用 `escalatesAtEnqueue()` 把 `none_escalate` kind 预置为 `ESCALATED`，而 `AlertChannelHub.ts:431` 只要注入了 `autoRepairBot` 就先写 `repair_status = "pending"`。T2 未删除前者，T5 也未修改后者，所以 `zombie_session_backlog` 仍会开成 `ESCALATED`，`review_advisory_pass` 等非 ARC kind 在删除 `needs_human` 写入后会永久留在 `pending`，R1 和部署验收都无法变绿。**修复：**T2 明确让所有新 ticket seed 为 `NEW` 并删除 `escalatesAtEnqueue` 的生产用途；T5 初始 `repairStatus` 置 `null`，只在真实 `attempted` / `no_action` 结果后写状态。同步覆盖 `fleet-ticket-enrich.test.ts`、`kind-contract.test.ts`；`none_escalate` 若不再承载任何行为，应折叠或至少改名/改注释，不能继续宣称“直接 ESCALATED”。

2. **HIGH — Hub 缺席时，旧的“只在 Hub 存在时 copy” guard 在单车道设计里不够，而且 v3 没有替代合同。** `plugin.ts:10208-10340` 在没有 unified channel 或 repair chain 时令 `alertHub` 为 `undefined`、`rawSink` 退化为 `LeadAlertNotifier`；新 Router 会把唯一 ticket 腿直接送到该 notifier。`LeadAlertNotifier.ts:905-924` 会把无 projects.json Lead 的 fleet ticket 逐条 `unknown-lead` dead-letter，`deadLetter():844-872` 又逐条触发 `alert_dead_lettered`，最终进入 `MetaAlertNotifier` 的 `osascript`（进程重启后 debounce 也重置）；现有 `LeadAlertNotifier.fleet-identity.test.ts:129-134` 正在锁定这个行为。简单“Hub absent 就 skip”又会静默丢掉唯一车道。**修复：**计划和 G0 必须二选一并明确 blast radius：要么把 unified channel + resolvable repair chain 变成 channel-only Router 的硬部署前置，在任何 ticket producer/timer 启动前一次性 fail closed；要么取得 founder 对一个明确的无 Hub 例外 fallback 的批准。增加 plugin 级无 Hub 测试，证明代表性 fleet ticket 不会形成逐事件 dead-letter/meta-alert 风暴，也不会伪报投递成功。

3. **HIGH — 删除 inventory 不完整，会留下真实 QA harness 的运行时断裂。** `scripts/qa-fly-1082-fleet-alerts-e2e.mjs:95,209-218` 动态导入 `runbook-gap.js` 并传 `onTicketEscalated`，且 `:657-697` 明确断言 zombie 直接 `ESCALATED`；T7 删除文件、T5 删除 dep 后该真实 Discord E2E 将无法运行。它还被 `qa-fly-1193-debounce-e2e.mjs:13-15` 作为覆盖依据引用。另有 `fleet-ticket-enrich.test.ts:119-125` 和 `kind-contract.test.ts:275-292` 固定旧语义，R2 清单没有覆盖。**修复：**把这些文件加入 T7/R2/R6：将 QA1082 改成 channel-only、零自动 page、zombie `NEW` 的真实链路，或显式退休脚本并更新所有入站引用；同时删除/改写所有 `escalatesAtEnqueue` 断言。

4. **MEDIUM — 保留 cap-owner assignment 可以成立，但当前文案与状态语义不成立，且计划仍把决定留到实现期。** `formatAccountCapOwnerAssignment()`（`infra-notify.ts:69-80`）承诺“重试 2 次或 5 分钟，T2”，而本计划删除整个 T2；结合问题 1，当前实现还会留下误导性的 `repair_status=pending`。把它作为 owner handoff、@ cap owner、ticket 保持 `NEW` 是自洽的，但它不是 ACK，也不应承诺自动升级。**修复：**G0 前明确裁定保留或删除，不能以“若 Tadashi 认为”留给实现者；若保留，改文案/注释/测试为纯认领通知，删除 T2 承诺，并断言零 founder mention、`NEW`、`repair_status=NULL`。

5. **MEDIUM — 删除 `escalate` 后的 retry 状态机仍有可重复发帖乃至无限重试的输入。** `ticket-escalation.ts:81-111` 把缺失/非法 `first_seen_at` 解释为 age=0；计划又让 reconcile 的 `needs_human` 结果既不增加 `attempt_count`、不转状态，只发一条安全闸帖。正常时间戳下它会每个 reconcile tick 重发直到 timeout；缺失/非法时间戳下则永远返回 `retry`。**修复：**为 retry 定义单调进展：缺失/非法 first-seen 必须 fail closed 为 `none`（并有一次日志），安全闸拒绝只能发一次或转到明确的非重试可见状态；新增 null/malformed timestamp 和连续两次 reconcile 测试。耗尽后停在 `REPAIRING`/`MONITORING` 是 founder 已知选择，不应再自动升级。

6. **MEDIUM — R1 中至少两项不是今天代码上的真实 RED。** `createInfraAlertSink()` 当前令 `ticketSink ?? rawSink`，所以只删除 fixture 的 `ticketSink`/`copyTicketToChannel` 再断言 ticket → raw，今天就会通过；“传入即 TS 错”只有在实际跑 typecheck 且用正确的 `// @ts-expect-error`/type test 时才会 RED。**修复：**运行时 RED 应注入一个与 raw 不同的 legacy `ticketSink`（必要时仅在测试里 cast）并断言它被忽略、raw 恰一次；类型 RED 用 `@ts-expect-error` 并纳入 `pnpm -r build`。保留真实 Hub E2E，它在今天会因 founder mention、`ESCALATED` 和 `pending` 确实变红。

7. **MEDIUM — 部署验收的 E 选择不是机械的 ticket 选择，会产生假失败/假绿。** §5 第 3 步的 `alert_delivery_receipts` 查询只排除 `dead_letter_alert:*`，可能先选到 informational 或 issue-progress event；这些事件本来就不一定有 `alert_threads` 行。此外 queued receipt 不会在 drain 后改写成 `sent`，只能结合后续 thread 行判断。**修复：**从 `alert_threads where opened_at > T0` 选首个新 ticket E，再按 `event_id` join receipt；或先从有 event type 的来源按 `classifyInfraEvent=ticket` 过滤。部署前还应重新检查/排空旧 queue，或证明其中没有 `ticket.status=ESCALATED`，避免旧 payload 在 drain attach 时重新种入自动状态。

8. **MEDIUM — “2076 先行或 founder 接受窗口”目前是文字建议，不是部署时可复核的门。** G0 对 C2 的 affirmative 接受很好，但 merge 与下一班部署之间 FLY-2076 状态可能漂移；只引用早先批准不能证明切换时已有自动 reader。回滚还会同时恢复 Hub 自动 @founder，属于显著产品副作用。**修复：**在 `approve_to_ship`/发布清单加入二选一证据：FLY-2076 sentry 的已部署 build/health 加一次真实频道 mention→wake/ACK 回执，或 founder 明确逐字接受本次部署的无读者窗口；缺任一证据即不部署。回滚步骤也应明确标红“会恢复自动 founder paging”，并要求同等级授权。

## Verdict

CHANGES REQUESTED — address items above
