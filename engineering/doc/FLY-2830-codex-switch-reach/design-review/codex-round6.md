# Design Review — plan.md (Round 6)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮严格只复核 Round 5 的两项。第 1 项已经完整解决：进程内记录先于磁盘写更新，路由按 vendor 合并内存与磁盘的较新值，磁盘失败不阻断刷新且有覆盖页面行为的端到端测试。

第 2 项解决了 Round 5 指出的 Codex subscription `status:"none"` 和 Claude detail 时间丢失，但“四个数据源时间”的固定映射遗漏了页面上的 Codex 兑换卡。该格使用 `resetCreditsObservedAt`，而观察者允许主 quota `observedAt` 前进、兑换卡继续沿用旧值与旧时间。若把它归到 `codexQuotaAt`，仍会静默把切号前卡数据判成已刷新。因此还有一个限定范围内的阻断项。

## What's Good (Keep)

- Trigger 在 durable write 前同步更新 `latestSwitchRecord`；accounts-page 路由逐 vendor 取内存与磁盘较新记录，再计算全局最近切号。磁盘写失败时刷新照常启动，页面仍能从内存标旧格（§6.5:181–184）。
- 对应测试明确覆盖“磁盘写失败 + 刷新尚未完成”，同时断言路由仍标注且刷新确实被调用（§6.5:193）。Round 5 item 1 已关闭。
- Freshness 不再依赖 display cell 是否保留时间，而是从 store-derived row metadata 读取；Codex subscription 明确包含 `status:"none"` 的 `observedAt`，Claude tier/card 明确改用 `detailObservedAt`（§6.5:185–190）。
- 两个 mutation-sensitive 对照已写入：post-switch `status:"none"` 不标；本轮未读、没有 post-switch observation 则继续标。Claude tier 也有独立 detail-time 测试（§6.5:193）。这些正面关闭了 Round 5 item 2 的原始反例。

## Issues & Recommendations (numbered: issue, why, fix)

1. **四时间映射遗漏 Codex 兑换卡自己的 `resetCreditsObservedAt`，该格仍可能静默显示切号前数据。**

   **Why:** §6.5 只定义 `codexQuotaAt = account.observedAt` 并把“配额相关格”统一映射到它（§6.5:185–190）。但 Codex 观察者在本轮 quota 成功、RPC 未暴露 reset credits 时，会让主 `observedAt` 前进，同时沿用上一轮的 `resetCredits` 和 `resetCreditsObservedAt`（`codex-accounts-observer.ts:389–412`）。Capacity snapshot 专门保留这个独立时间（`capacity-snapshot.ts:368–379`），现有页面的兑换卡 cell 也正是用它判断 staleness（`account-quota-view.ts:939–960, 974–986, 1030–1036`）。反例：切号时刻 T1；本轮 quota 在 T2 成功，但 reset credits 未暴露，卡值与时间仍是 T0。按计划映射，`codexQuotaAt=T2>T1`，页面会把 T0 的兑换卡当成已刷新，违反本节核心合同。

   **Fix:** 把四时间改为五时间，新增 `codexResetCreditsAt = codex-accounts.json.resetCreditsObservedAt ?? observedAt`，并把 Codex「兑换卡」格固定映射到它；其余 Codex quota 格继续映射 `codexQuotaAt`。补 mutation-sensitive 测试：切号后 quota `observedAt` 前进，但 reset credits 沿用切号前值/时间时，只标兑换卡格；当 `resetCreditsObservedAt` 也晚于切号时该标注消失。这样不会重引入 lane 状态，只是使用 store 已有的真实来源时间。

## Advisory

无。本轮未复核或重开上述两项之外的设计。

## Verdict

CHANGES REQUESTED

Round 5 item 1 已解决，item 2 的原始两个反例也已解决；补齐 Codex 兑换卡的独立来源时间和对照测试后，本轮范围即可通过。
