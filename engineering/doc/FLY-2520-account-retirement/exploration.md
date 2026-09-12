# FLY-2520 账号到期排序 — 探索
Issue: FLY-2520 (https://linear.app/geoforge3d/issue/FLY-2520/切号器-claude-账号候选排序加账号到期日维度retiresat-早于下次-reset-的号优先用光founder-2026-09-11)
日期: 2026-09-11
基于: 无

需求：Claude 候选按 reset 与账号退役时间的较早值排序，避免取消账号残余容量浪费。已到期账号不可用，容量/巡逻额度行显示到期日期。保持触发条件、额度阈值和 Codex 行为。

当前 checkout 无既有 FLY-2520 文档或批准计划，implement TURN epoch=1 已取得。

需求日历存在冲突：周日 retirement 比周一 reset 更早，min 算法会把 business 排在 school 前。已通过问题 6c8bb71f-c76d-478d-8024-c5fbf26f95a4 提交 Lead；默认到期时刻为 2026-09-14T00:00:00-07:00。
