# Design Review — plan.md (Round 1)

Date: 2026-08-26
Author: Codex
Status: CHANGES REQUESTED

## Summary

诊断主链与当前代码一致，默认打开既有 copy leg 也在现有架构内可实现；但计划低估了 Hub 重开后立即恢复的 ARC/founder mention 行为，并且 `hub absent` guard 与 `=0` 回滚都没有覆盖已经持久化的 channel-copy 队列。当前 founder gate、回滚和生产验收因此还不足以安全实施；本轮已完成源码核对，但 checkout 未安装 `vitest`，定向测试无法作为本轮批准证据。

## What's Good (Keep)

- exploration 的因果链与当前实现吻合：`deliverTicket()` 先走 owner mailbox，只有 copy 回调为真才调用 raw sink；Hub 本身没有被关闭或损坏。
- mailbox 的 `delivery_id`/`source_ref` 与 `LeadAlertNotifier` 的 `alert_claims`、`lead_events`、delivery receipt 是独立账本；相同 `eventId` 同时走两腿不会因为 mailbox 写入而互相去重吞掉。
- 保留 mailbox 为 primary、copy 失败不反向否定 durable primary 的边界正确，`hubEnabled=false` 时禁止新 copy 也能挡住“无 Hub 环境首次启动即逐条 dead-letter”的新增风险。
- 三态解析、guard 优先级、逐字 boot 文案、FULL-UNION sweep，以及 Router → 真 StateStore/Hub → `alert_threads` 的阳性/阴性对照，都是有价值的测试方向。
- 明示这会反转 FLY-1764 founder 默认值，并保留历史正文、追加 superseding 注记，审计方式合理。

## Issues & Recommendations

1. **Founder 裁定包漏掉了生产 Hub 的即时副作用，而且当前流程不是 affirmative gate。** `plugin.ts:10210-10248` 在 Hub 存在时始终注入 `AutoRepairBot`；`AlertChannelHub.ts:468-582` 在开 thread 当场运行它，而 `AutoRepairBot.ts:108-127,221-227` 对绝大多数非可自动修复 kind 立即返回 `needs_human`，Hub 随即在 thread 中真实 @founder，并把 ticket 置为 `ESCALATED`。这不只是计划写的“5 分钟无人认领后 T2”及三个 `none_escalate` kind；还会恢复 `swapPressureRepair`、infra-bot kickstart、可能的 account-switch enqueue，以及 `reconcile()` 的后续 retry。把它称为纯“观察副本”会让 founder 在错误的副作用清单上作决定。另 §0.1 只规定“否决则停”，没有在 RED 前要求 founder 明确接受，沉默可能被当作授权。建议先按真实代码重写 §0.1/风险表：列明即时 needs-human mentions、自动动作、reconcile retry 和估算量；新增 G0，要求 founder 对 A/A2 及完整副作用清单作出可引用的明确接受，未回复/含糊均为 BLOCKED，Codex design approval 不替代该产品裁定。R2 还应使用生产形状的 `AutoRepairBot`，至少证明一个普通 human-by-design kind 会即时升级、一个可修 kind 会执行/重试既有 ARC。

2. **`hub absent` guard 和两种回滚都没有 fence 已入队的 copy，故“逐字回到 mailbox only”不成立。** `LeadAlertNotifier.enqueue()` 把完整 payload 写进共享 `alert-queue`；`drainQueue()` 不读取 `FLYWHEEL_ALERT_COPY_TO_CHANNEL`，也不知道该文件来自 observation copy。于是 copy 在 ON 时因限速/Discord 抖动排队后，即使改成 `=0`、revert PR、或重启时 Hub 已缺失，旧文件仍会被投到 Discord；有 Hub 时 `attachDeliveredAlertLifecycles()` 继续开 thread/触发 ARC，无统一配置时则可能转成 `unknown-lead`/`no-channel` dead-letter，再触发 meta-alert。共享 cap 500 还会淘汰最老文件，且无法区分 copy 与其他必须告警，不能把 cap 写成无损“兜底”。建议二选一并写成明确合同：(a) 给 queued copy 加可持久化 provenance，并在 drain-time 以当前 route/hub resolution 做 fail-open-to-mailbox 的 suppression/fence，单独计数且不触发 delivery-failure meta-alert；或 (b) 明确承认 `=0`/revert 只停止新 copy、旧 backlog 最多继续 3 天，并让 founder 接受这一非即时回滚。无论选哪条，都补 RED：ON 产生 rate-limited queue → restart 后 OFF；ON 排队 → restart 后 hub absent；以及普通非-copy 队列文件不被误删/误抑制。

3. **copy 结果的 dedup/观测合同未定义，当前 T2 会制造真假混合的失败日志。** `LeadAlertNotifier.alert()` 可在 claims reader、atomic claimer 或 `lead_events` 三处返回 `{skipped:"duplicate"}`（`LeadAlertNotifier.ts:929-983`）；这可能表示正常重放已被前一次送达覆盖，也可能是只有 claim、没有 thread 的 ambiguous attempt。计划把所有 `skipped` 都记为 `channel copy not delivered`，却又在生产验收要求该日志窗口为空/逐条解释，没有规定 duplicate 的健康判据；同时 `{sent:true}` 但缺 `messageId` 会被视为成功，实际 Hub 不会开 thread。建议给结果建立显式表：`sent+channelId+messageId`、`queued`、`duplicate-with-proof`、ambiguous duplicate、permanent dead-letter、root-only sent 各自如何记录和验收；至少增加 duplicate 与 sent-without-messageId 的 RED，避免正常去重制造日志风暴，也避免 root-only 被误报为全链成功。若现有结果类型无法证明 duplicate 已送达，日志必须诚实标为 ambiguous，不能把它同时当作验收失败和正常成功。

4. **部署后验收无法按当前文字机械复核。** comm mailbox 没有 `event_id` 列；`enqueueInfraAlert()` 写的是 `source_ref=payload.eventId`（`lead-inbox-runtime.ts:494-526`），所以“同一 event_id 在 mailbox”缺少可执行查询。`alert_delivery_receipts` 的 queued copy 在 drain 成功后也不会改写成 `sent`，只能保留首次 `queued_durable`；这点计划虽口头允许，但应写进查询判定。另“83~307 episode/天”不能推出任意部署后一小时必有事件，安静一小时会造成假失败。建议以“部署后第一条实际出现的 ticket mailbox 行”为触发点：用 `source_ref` 取 event id，再给出对 `alert_delivery_receipts.event_id` 和 `alert_threads.event_id` 的逐字 SQL/时间窗，queued 情形等待既有 drain SLA；将一小时改为观测目标而非正确性断言，并规定最长等待及无人产生真实事件时的 `INCONCLUSIVE` 处理。

5. **TDD/文档一致性仍有假 RED 和未覆盖承诺。** `scripts/__tests__/check-flag-truth.test.sh` 只验证 env 名称的分类，不检查 `NON_FLAG_ALLOWLIST` 描述文本；T4 写错、漏改甚至仍写 default-off 都会继续绿，因此 R3 不是 RED，只是回归 gate。计划也承诺 boot 每次“恰一行”，但没有测试 emission count；同时 `infra-event-router.ts:140` 与 `infra-alert-wiring.ts:49` 的当前注释仍写 default-off，T1/T2/T3/T4/T5 清单没有要求同步。建议把 R3 如实标成现有 regression gate，另加一条 truth/default 一致性断言或明确以代码 review 校验；把 boot 行生成收敛为一个纯函数并测试 ON/env-off/hub-absent 每种只返回一行；同步更新两处 current-code 注释。R2 的真 Hub 接线还需明确使用 `{ alert: (p) => hub.handle(p) }` 适配器，因为 `AlertChannelHub` 本身没有 `alert()` 方法。

## Verdict

CHANGES REQUESTED — address items above
