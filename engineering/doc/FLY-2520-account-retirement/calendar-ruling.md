# FLY-2520 账号到期排序 — 调研
Issue: FLY-2520 (https://linear.app/geoforge3d/issue/FLY-2520)
日期: 2026-09-11
基于: plan.md

Lead answer to question 6c8bb71f-c76d-478d-8024-c5fbf26f95a4:

- 唯一排序规则为 min(nextResetAt, retiresAt) 升序，同刻按名字；不设 school 优先特例。
- business 到期时刻采用 2026-09-14T00:00:00-07:00。
- school 周一 09:00 PT reset，business 同日 00:00 PT 到期，shopping 周二 reset：business, school, shopping。
- school reset 早于 business 到期：school, business, shopping。
- 到期已过排除，与 credential 过期同分支。
- Lead 已向 founder 说明口述顺序与公式矛盾，如有变更会再转达。
- 宿主 claude-accounts.json 和 quota monitor 重启由 Lead/QA 在交付后处理，implement 不改生产配置。

This resolves the pending calendar question without modifying the pinned design-review plan.
