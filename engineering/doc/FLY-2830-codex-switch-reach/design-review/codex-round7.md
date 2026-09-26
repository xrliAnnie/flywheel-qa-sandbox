# Design Review — plan.md (Round 7)
Date: 2026-09-25
Author: Codex
Status: APPROVED

## Summary

本轮严格只复核 Round 6 的唯一意见。§6.5 已新增 `codexResetCreditsAt = resetCreditsObservedAt ?? observedAt`，明确只映射到页面现有 Codex 兑换卡格（`creditsCell`），并加入正反两态的 mutation-sensitive 测试。该设计与现有 snapshot 和 view 的真实时间来源一致，没有发现本次编辑引入的回归。

## What's Good (Keep)

- `codexResetCreditsAt` 的定义与现有 capacity projection 完全一致：projection 已使用 `reading.resetCreditsObservedAt ?? reading.observedAt`，不会把主 quota 的新时间错误借给沿用的旧卡数据（§6.5:185–188；`capacity-snapshot.ts:368–379`）。
- 固定映射明确把该时间只用于现有 `creditsCell`。现有页面的 Codex 兑换卡正是从 `resetCredits` 渲染，并以 `resetCreditsObservedAt` 计算 freshness；没有额外余额格需要再建一条时间线（`account-quota-view.ts:939–960, 974–986, 1030–1036`）。
- 测试准确覆盖 Round 6 反例：quota `observedAt` 已前进、卡值和卡时间仍来自切号前时，只标兑换卡格；`resetCreditsObservedAt` 前进到切号后时标注消失（§6.5:194）。这两个断言会在错误地重新映射到 `codexQuotaAt` 时失败。
- 修正只增加一个已有 store 字段的来源时间，没有恢复 refresh-lane 状态、增加页面格或扩大 §6.5 的职责。

## Issues & Recommendations (numbered: issue, why, fix)

无。

## Advisory

无。本轮未复核或重开 Round 6 唯一意见之外的设计。

## Verdict

APPROVED

Round 6 的唯一阻断项已解决；本轮授权范围通过。
