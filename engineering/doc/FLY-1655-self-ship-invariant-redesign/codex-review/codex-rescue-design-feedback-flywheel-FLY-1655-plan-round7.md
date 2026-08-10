# FLY-1655 terminal-land 设计复审 R2 — APPROVED

Issue: FLY-1655
日期: 2026-08-09
Plan commit: `1f8bd2a0`
Question: `6d840ff0-03f5-4ccb-9d21-82e9e8932b6c`

Review verdict: **APPROVED**。

折入三条 non-blocking advisory：claimless head 在 mutation 前返回 typed refusal；`ship_workflow_pending` 进入现有 land partial event/alert；真机验收覆盖 code claim-backed 与 generic claimless 两条。
