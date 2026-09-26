# Design Review — plan.md (Round 5)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮只复核重写后的 §6.5 对 Round 4 三项意见的处理。删除 refresh-lane 持久状态后，旧轮 completion 覆盖新轮、重启后假 `running`、aggregate lane outcome 误报等问题均已消失；reader、纯 renderer、严格校验和转义边界也已闭合。

仍有两个由新方案直接暴露的窄缺口：记录写失败时页面没有当前进程内的 switch-time fallback，会在刷新完成前或刷新同时失败时静默显示旧数；此外，计划假定每个机器结果的 `QuotaCell.observedAt` 都保留了对应 observation time，但现有 view 的若干合法负结果会经过 `missingCell()` 丢掉这个时间，导致“已刷新”被永久误报为“尚未读到”（或实现若按 `source` 过滤则漏标真正未刷新）。因此 verdict 仍为 CHANGES REQUESTED。

## What's Good (Keep)

- 不再持久化 `running/ok/failed`，只由 trigger 在刷新前写每 vendor 的最近切号时间。刷新 completion 不再写文件，Round 4 issue 1 的 stale-writer 与重启假状态已被结构性消解（§6.5:172–181）。
- 页面取两个 vendor 中较新的切号时刻，逐数据源比较时间；Codex quota、Codex subscription、Claude usage、Claude detail 不再共享一个 aggregate outcome，null 也有明确文案。Round 4 issue 2 的正确方向已落实（§6.5:183–185）。
- 横幅只陈述时间和未刷新格数，不再把“request 已写”说成“全量刷新完成”，也不猜失败原因。
- 文件没有自由文本；reader 限制普通文件、4 KiB、未知键、safe integer、canonical ISO 与未来时间，路由捕获全部读取错误并把可选值传给纯 renderer。派生文本统一走现有 `escapeHtml`，Round 4 issue 3 已基本解决（§6.5:181–187）。
- 测试清单覆盖写前顺序、写失败仍刷新、损坏文件、纯页面降级、逐格新旧/null、Codex quota 与 subscription 不同步、Vercel 排除及横幅计数。

## Issues & Recommendations (numbered: issue, why, fix)

1. **记录写失败会让本次切号在页面上完全不可见，与“旧数绝不静默”硬要求冲突。**

   **Why:** §6.5 要求先写记录，写失败只记日志并继续刷新（§6.5:174–182）；页面在 reader 返回 null 时明确“不标注，页面照常”（§6.5:183）。反例：旧记录为 T0，T1 切号时 rename/permission 失败，Bridge refresh 仍在跑或随后也失败。页面只看到 T0（或没有记录），原有读数虽早于 T1，却不会带任何“切号后尚未刷新”标记。这正是 Lead 禁止的静默窗口，而且计划中的“写失败不阻断刷新”测试不会发现页面违约。

   **Fix:** 保留删法，但让 trigger 在调用 durable writer 前同步更新一个进程内 `latestSwitchRecord`；accounts-page 路由取 `max(inMemory, readSwitchRecord())`。磁盘写失败仍不阻断刷新，也不让页面依赖文件成功；可后台有限重试持久化，但不必恢复 lane 状态。补端到端测试：T1 写文件失败、刷新尚未完成时，路由仍把 T1 传给 renderer并标旧格；同时断言刷新确实被调用。若 Bridge 随后重启且持久化仍失败，只能按磁盘故障降级并留高信号日志，但同一进程内不应静默。

2. **“每格使用自己的 `QuotaCell.observedAt`”目前不是现有 view 的真实不变量，合法的机器负结果会丢时间。**

   **Why:** `QuotaCell` 能携带时间，但 `missingCell()` 固定返回 `source:"missing", observedAt:null`（`account-quota-view.ts:279–302`）。Codex subscription 的 `status:"none"` 在 store 中要求 `observedAt` 非空，证明机器已成功读到“无有效订阅”（`codex-subscription-store.ts:95–109`）；然而 `codexNextChargeCell()` 对该分支返回 `missingCell("读不到（无有效订阅）")`，把该时间丢掉（`account-quota-view.ts:651–700`）。同类问题也可能发生在机器本轮已观察、但具体 pct/detail 字段为空的分支。按 §6.5 的 null 规则，这些格会在每次切号后永久显示“尚未读到”，横幅的 N 也不再是事实；若实现只对 `source:"machine"` 的格套规则，则真正失败后变成 `missing` 的格反而可能漏标。另有现成差异：Claude `subscriptionTier` 当前以 snapshot `generatedAt` 建 cell，而 §6.5 要求 detail-backed 字段使用 `detailObservedAt`。

   **Fix:** 在计划中明确 freshness 使用“数据源/尝试的 observation time”，不能依赖 display 是否有值。可选其一：

   - 给 row 增加四个经验证的 channel timestamp（Codex quota、Codex subscription、Claude usage、Claude detail），renderer 按 channel 标对应格；或
   - 保证所有机器结果（包括 `none`、无字段、明确失败）都构造保留正确 observation time 的 `QuotaCell`，必要时扩展 cell 以区分“机器已读到负结果”和“从未/本轮未读”。

   同时把 Claude detail-backed cell 的时间改为 `detailObservedAt`。补两个 mutation-sensitive 测试：切号后 Codex subscription 返回 `none` 且其 `observedAt > lastSwitchAt`，该格不标未刷新；本轮 subscription 未读/失败且没有 post-switch observation 时，该格继续标注。这样才能证明 null 的含义确实是“尚未刷新”，而不是 projection 丢失元数据。

## Advisory

无。本轮没有复核或重开 §6.5 之外的设计。

## Verdict

CHANGES REQUESTED

Round 4 的三个原始问题已被大幅简化并基本解决；补上写失败时的内存 switch-time fallback，并把机器负结果的 observation time 贯穿到页面后，这一节即可通过。
