# Design Review — plan.md (Round 2)

Date: 2026-08-26
Author: Codex
Status: CHANGES REQUESTED

## Summary

本结论严格绑定用户指定且开审时已核验的 blob `7f6b337cfa123092bffd3095165ec10af7d0a725`；评审结束前 HEAD 并发前移到 `329d39b72` 的 v3，后者不属于本次 Round 2 范围。v2 已关闭 Round 1 的大部分问题，但当前仍不宜进入实现：G0 所依赖的即时副作用清单与生产代码不完全一致，且 T7 的执行顺序仍允许已排队副本在关闭后触发 `deadLettered` + osascript meta-alert。现有 fixture 基线可运行：定向 teamlead 7 个文件 76/76 通过、config 28/28 通过；shell harness 在本沙箱被 `tsx` IPC socket 的 `EPERM` 阻断，不是断言失败。

## What's Good (Keep)

- 保留 G0 为明确、可引用的 merge 门：沉默/含糊即 BLOCKED、PR 保持 draft、Codex 工程批准不能替代产品裁定。分支内先写 RED/GREEN 是可逆工作，不必把 founder 回复前移成写测试的前置条件。
- `channelCopy?: true` 只盖在 raw channel copy 上、mailbox 主腿不带标记，是隔离共享队列中副本的正确最小机制；mailbox collapse/delivery identity 与 `LeadAlertNotifier` 的 claims/`lead_events` 去重账本彼此独立，同一 `eventId` 双腿并不会互相吞掉。
- §2.1 正确把 `duplicate` 与永久失败分开，并显式承认 duplicate 不能证明 thread 已存在；`sent` 但无 messageId 的 root-only 降级也终于可见。
- §6 已改用真实 schema：`mailbox.source_ref` 对到账本 `event_id`，保留 `queued_durable` 的既有语义，并把一小时从断言改成观测目标、六小时无自然事件记 INCONCLUSIVE。
- R2 使用 `{ alert: (p) => hub.handle(p) }` 适配器、真 `StateStore`、真 `AutoRepairBot`，同时覆盖一个 `needs_human/ESCALATED` 与一个 `attempted/REPAIRING`，比只断言 rawSink 被调用有意义得多。
- flag truth 描述增加专门的内容断言，旧 shell test 正确降级为回归门；默认值注释、单行 banner 和历史 FLY-1764 守卫也都纳入了文件清单。

## Issues & Recommendations

1. **[HIGH] G0 的“按代码如实列”仍把条件性 repair disposition 写成了确定结果。** `plan.md:18-25` / `research.md:52-63` 把 `tmux_server_lost` 简化成“有 metadata 即 attempted”，但 `AutoRepairBot.ts:162-189` 在 `migrated < casualties` 或 `leadsFailed > 0` 时立即返回 `needs_human`；`swap_pressure_high` 也可返回 `attempted`、`no_action` 或 `needs_human`（`fleet-sensors.ts:358-465`），`infra_bot_down` 缺 job label 时同样 `needs_human`（`:602-650`）。更关键的是，FLY-1456 已把 Bridge account-switch 永久拆掉：`resolveQuotaDaemonBridgeMode().attachAccountSwitch` 固定为 false（`quota-daemon-cutover.ts:9-21`），所以 `plugin.ts:9940-9948` 注入的 `accountSwitchRepair` 在生产为 undefined，`usage_limit` 不会因为“有账号池”进入 attempted；它会走 `needs_human`，且配置了 P-identity/infra-bot 时 @ 的是 owner bot，不是 founder（`AlertChannelHub.ts:516-544`）。此外，未绑定 issue thread 的 `runner_lead_pending_unhandled` 也会 fail-safe 到 ticket，并按 `none_escalate` 当场升级。这里直接决定 founder 接受的副作用与量级，不能用近似清单作为 affirmative consent 的输入。建议把 §0.1/§0.2、research §3.2（以及 HTML 对应文案）改成 disposition/predicate 矩阵：区分 always-attempted、条件 attempted/no_action/needs_human、owner-bot assignment 与 founder mention；量级写成账本支持的“绝大多数/预计范围”，不要声称每个 episode 都 @Annie。R2 的两个阳性用例可保留，但不能拿它们代表所有 ARC kind。

2. **[HIGH] T7 仍不能兑现“关闭后已排队副本不产生 dead-letter/meta-alert”的合同。** 计划明确把 copy guard 放在 aged-out 和 replay-freshness 之后，并保留 cap 不区分来源（`plan.md:49,70-72`）。当前 `drainQueue()` 在解析任何 entry 前先把超过 `queueMax` 的最老文件按 `queue-cap` 计入 `deadLettered`（`LeadAlertNotifier.ts:1233-1241`），随后又在 guard 的计划插入点之前把过期文件按 `aged-out` 计入 `deadLettered`（`:1267-1272`）；Bridge 只要看到 `deadLettered > 0` 就调用 `MetaAlertNotifier.notify`（`plugin.ts:10935-10946`），继而走 osascript。反例很直接：OFF/hub-absent 重启时有 501 个 stamped 文件，最老一个先触发 queue-cap meta-alert；一个超过三天的 stamped 文件则先触发 aged-out meta-alert。R3 只测新鲜、小于 cap 的文件，会假绿。建议在 drain 最前面、cap/aging/permanent-reason 之前先解析并抑制所有 `channelCopy === true` 的 entry（resolver 每轮求值一次即可），然后让未标记队列逐字沿用现有 cap/age 顺序；新增 `queueMax` 溢出和 aged stamped 两个 RED，均要求全部计入 `copySuppressed`、`deadLettered===0`。同时不要直接复用当前 `moveQueueFileToDeadLetter()`：它会把 payload 的整个 lease episode 标成 `dead_lettered`（`:1468-1476,1540-1556`），而这里只关闭第二交付腿；应增加不改 episode terminal state 的 audit-move 路径及对应测试。§7 的 revert 操作也应给出无竞态顺序（先用新 bytes + `=0` drain 掉 stamped backlog，或停 Bridge 后再隔离文件），不能在仍有 producer/drainer 的活目录里笼统地“移走”。

3. **[MEDIUM] 两处测试/类型合同仍会误导实现。** 第一，R3 所说的“meta-alert 未触发”若只 spy `LeadAlertNotifierConfig.metaAlert` 是无效断言：drain 从不直接调用该 sink，聚合 meta-alert 发生在 plugin 的 `shouldReportDeadLetteredDrain()` 分支；应在 `bridge/__tests__/drained-alert-routing.test.ts` 增加 `copySuppressed > 0, deadLettered = 0` 的路由断言，配合上项 cap/age RED 才能证明 osascript 不会响。第二，§2.1 把 `invalid-delivery-style` 列成 `skipped` reason，但当前 `AlertResult.skipped` union 只有 `duplicate | no-channel | no-token | unknown-lead`（`LeadAlertNotifier.ts:619-634`），invalid style 实际返回 `{ deadLettered: true }`（`:893-903`）；从 skipped 列移除即可，无需扩 API。顺便把 R3 用例文字写成“持久化 stamped 文件 → 新 notifier 在 env-off/hub-absent resolution 下 drain”，以便它真正对应所声称的 ON→restart→OFF 合同。

## Verdict

CHANGES REQUESTED — address items above
