# FLY-1925 patrol_tick 名册加「圈」维度 — 运行时设计审查 R2
Issue: FLY-1925 (https://linear.app/geoforge3d/issue/FLY-1925/巡检tick-patrol-tick-名册加圈维度每-run-附当前节点棒持有者开圈状态-让有人在等不存在的圈直接印成红灯founder)
日期: 2026-08-20
基于: runtime-design-review-round1.md

## 结论

`APPROVED`。R1 HIGH 已解决:圈账查询只在某 Lead 确实 mint tick 时发生,
非 mint 的 60 秒 rider pass 不读圈账。

## Advisories 处置

| finding | 级别 | 处置 |
|---|---|---|
| w-self-scoped-to-roster-execs | MEDIUM | 接纳:初始 snapshot 与 fingerprint 重验都将当前 TURN holder union 进 executionIds,即使 holder 不在 roster;T0/T2 覆盖 |
| s1-no-liveness-check-on-bound-actor | LOW | 记录为 v1 已知漏检:S1 只认 durable attempt state,不引入 tmux/roster 活性推断;符合「不判断圈开着但卡住」边界 |
| zero-run-red-no-terminal-run-exemption | MEDIUM | 延续 R1 裁定:保留账面不自洽红灯并诚实写成记录账龄;若生产噪声出现,后续以独立 reason/light 处理 |

审查问题:`0ef1c1d5-7739-4552-a958-b526fcb0da2f`。
