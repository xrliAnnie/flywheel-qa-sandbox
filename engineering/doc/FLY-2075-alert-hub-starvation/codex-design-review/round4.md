# Design Review — plan.md (Round 4)

Date: 2026-08-26
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已实质性关闭 Round 3 的大部分问题：Router/Hub 状态种子、retry 单调进展、cap-owner 定义、删除 inventory、无读者部署门与回滚授权方向都正确，方案仍可在现架构内实现。但“旧 payload 不会重新显示 ESCALATED”目前只保护了 Hub 账本，没有保护先于 Hub 渲染的 Discord 根消息；同时 C8 尚未进入 affirmative G0，类型 RED、真实 Discord 零 mention 与部署验收选择仍存在假绿。因此本轮仍需修改。

## What's Good (Keep)

- 当前 plan blob 已核为 `a8c951717e91ab6d2712fdfd67e6a2edf1690f8e`，且本轮按 Round 3 的 8 项 ledger 做了窄范围复核，没有重开 founder 已定方向。
- P3/P4 已补齐 Router 的 `ESCALATED` 预置和 Hub 的 `repair_status=pending` 初值；新 ticket 账本强制 `NEW`、repair status 初始为 NULL，这部分实现合同明确且可测。
- P5/T6 让安全闸拒绝消耗 attempt budget，并让 null/非法 `first_seen_at` fail closed；正常与损坏输入都不再形成无限 retry。
- cap-owner 已被定义为纯 owner handoff，删除 T2 承诺；FLY-2076 的部署证据或本次窗口 waiver 也被提升为班车前硬门，回滚重新启用 founder paging 的风险已明确授权化。
- QA1082、runbook-gap、fleet-ticket-enrich、kind-contract 和 escalation lifecycle 的旧语义引用已进入 inventory；ARC 各分支的条件说明与 `AutoRepairBot`、FLY-1456 quota cutover 源码一致。
- 本轮聚焦基线验证通过：teamlead 9 files / 189 tests，config flag-truth 28 tests；工作树保持干净。

## Issues & Recommendations

1. **HIGH — 旧 payload 仍会在 Discord 根消息显示 `ESCALATED`，T5 只修了 Hub 账本。** `AlertChannelHub.handle()`（`AlertChannelHub.ts:346-360`）先调用 `notifier.alert(payload)` 发根消息，之后才 `openOrReplaceThread()`；`LeadAlertNotifier.formatContent()`（`:1935-1943`）仍直接渲染 `payload.ticket.status`。queue drain 更早在 `LeadAlertNotifier.ts:1348-1366` 发根消息，随后才由 `attachDeliveredAlertLifecycles()` 回接 Hub。因此旧 queue payload 的账本会被 T5 强制为 `NEW`，但根消息仍先显示 `ESCALATED`，且 Hub 没有一次初始 NEW 编辑；R1-⑤只断言账本会假绿，§5 step 0 的“旧回放不会种回 ESCALATED”也不成立。**修复：**必须在统一频道的初始根消息渲染层同样不信任 payload status（最简单是 initial ticket header 恒渲染 `NEW`，后续状态只由 Hub edit），并把 `LeadAlertNotifier.ts` 纳入改动。测试要走真实路径：live `Hub.handle(old payload)` 断言 POST body + 账本均 NEW；再做 notifier enqueue/磁盘 JSON → `drainQueue()` → `attachDeliveredAlertLifecycles()`，断言真实根 POST、账本和 thread 全程无 `ESCALATED`，不能用手填 payload 直接调用 Hub 冒充 queue replay。

2. **HIGH — 选择保留无 Hub fail-loud 是可实施的产品决定，但其 blast radius 尚未真正进入 founder 门，新增 boot 合同也没有 RED。** §0.2 已新增 C8，然而 §0.3 line 64 仍要求 founder 只接受 C1–C7；这意味着逐事件 dead-letter/meta-alert、QA 房行为变化可以在未被 affirmative 接受时 merge。并且 R7 只证明今天已有的 notifier dead-letter 行为，完全不覆盖 T7d 新增的红灯 log 与 boot `alert_unreachable_config` 通知。`MetaAlertNotifier` debounce 是进程内的，所谓“一次”准确含义是每次 Bridge boot 一次，重启会再次通知。**修复：**G0 改为明确接受 C1–C8，并引用 no-Hub 的 dead-letter/desktop blast；若 cap-owner 仍允许 G0 前改判，也把最终选择写入同一证据。为 T7d 增加真 RED，锁定 Hub 缺失/repair chain 缺失时恰一条红灯和每 boot 一次 meta-alert、Hub 正常时零红灯；R7 保留为既有 fail-loud 对照。

3. **MEDIUM — `@ts-expect-error` 类型 RED 不会被计划中的 build 执行。** `packages/teamlead/tsconfig.json:10` 明确排除 `**/*.test.ts`，而 `pnpm --filter flywheel-teamlead build` 只是运行该 tsconfig 的 `tsc`；Vitest 也不做 TypeScript 类型检查。因此把负类型断言放在 `infra-alert-wiring.test.ts` 再声称“纳入 `pnpm -r build`”仍是假 RED。**修复：**增加一个专用 type-test tsconfig/命令，显式包含该 fixture，并把命令列入自验；或者删除类型 RED 的宣称，只保留已经真实为红的 distinct legacy `ticketSink` runtime sentinel。不要保留一个没有 runner 会执行的 `@ts-expect-error`。

4. **MEDIUM — §5 的 E 查询仍不能机械保证选到 ticket。** “只有 ticket 类才会开工单”与源码不符：`infra-alert-wiring.ts:185-186` 明确不给 issue-progress kind enrichment，但 `infra-event-router.ts:124-127,217` 会把未绑定 issue thread 的 progress event fail-safe 到 raw sink；`AlertChannelHub.handle()` 对所有非 informational payload 都会开 `alert_threads` 行，此类行的 `ticket_status` 为 NULL。当前查询可能先选到它并在 step 4 假失败。**修复：**step 3 至少增加 `AND ticket_status IS NOT NULL`（并统一 T0 为 SQLite UTC 可比较格式）；再 join receipt。把文案改为“带非空 ticket lifecycle 的首行”，不要声称 alert_threads 天然排除 issue-progress。

5. **MEDIUM — R8 当前 harness 看不到 thread 内容，无法证明“零 founder mention”。** `qa-fly-1082-fleet-alerts-e2e.mjs:702-744` 只 re-fetch 根频道 `/channels/${CHANNEL}/messages`；自动 founder page 位于每个 alert thread，更新 zombie 状态断言并不会检查 thread message content、Discord `mentions` 或 post options。**修复：**包装真实 `discordOps.postToThread` 记录 content/options，同时按 StateStore 的 `thread_id` re-fetch 每个 thread 的消息；把 founder id 固定为隔离假 snowflake，并断言正文无该 `<@id>`、返回 message 的 `mentions` 也不含它。这样才是可附 PR 的真实 Discord 负向证据。

6. **MEDIUM — 删除行为后仍保留多处相反的源码合同，plan 自身对 reconcile `needs_human` 也前后矛盾。** §0.1 P5 正确规定 reconcile refusal 会 bump + 发无 mention 帖、ticket 留在 `REPAIRING`，但 line 38 又写“任何 needs_human 不发帖、ticket 留 NEW”。此外计划声明不改 `AutoRepairBot.ts`，但其 `RepairResult.detail`、`canAttempt()`、`HUMAN_ONLY_REASON` 和 default branch 注释（`:38-40,73-74,98-101,225-226`）仍承诺 Hub 加 `@Annie`/自动升级；`LeadAlertNotifier.ts:289-293`、`ticket-owner-map.ts:14,73` 与 StateStore 的 T2 注释也继续描述已删除行为。**修复：**加入 comment-only contract cleanup（不改 AutoRepairBot 返回值、StateStore schema 或保留的方法）：区分 enqueue-time needs_human（NEW、无帖，cap-owner 例外）和 reconcile-time refusal（REPAIRING、计数、无 mention 帖），删除所有“Hub 自动 @Annie / directly ESCALATED / T2 unclaimed fallback”陈述。若 cap-owner 已定案，删掉“Lead 仍可在 G0 前删除”的条件句，避免实现范围继续漂移。

## Verdict

CHANGES REQUESTED — address items above
