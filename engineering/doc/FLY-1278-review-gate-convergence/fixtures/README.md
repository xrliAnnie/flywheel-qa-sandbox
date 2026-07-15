# FLY-1278 fixtures — FLY-1251 生产现场原始数据

Issue: FLY-1278 (https://linear.app/geoforge3d/issue/FLY-1278/fix-跨家族审查门在-lead-已裁决的非阻塞项上死循环-审稿人反复重提被-overrule-的优化建议强制门永不收敛fly-1251)
日期: 2026-07-15
基于: research.md

`fly-1251-rounds-6-9.json` — 2026-07-15 从生产 `~/.flywheel/teamlead.db` 逐字节导出（`sqlite3 -json`），
FLY-1251（execution `bb9cb377-9cc8-48d3-aff0-7d1cb83a6195`）code review R6-R9 四轮完整 job 行：
request_id / execution_id / issue_id / review_type / round / status / verdict / frozen_head_sha / created_at / **findings_json 原文**。

- 每轮 verdict=CHANGES_REQUESTED，findings 恰一条、severity=MEDIUM（同一条 30s docs-only metadata lease 优化建议）。
- 文件 sha256（导出时刻）: `ccc985af7072d392aac34178ad544b2120ae43b6abc5207d8e903065a138447f`
- 用途：plan.md §4「FLY-1251 真实回归 fixture」（Lead 直令）的 machine-replay 数据源——
  implement 阶段把本文件复制/引用为测试 fixture，**不得从 prose 摘要重构**。
