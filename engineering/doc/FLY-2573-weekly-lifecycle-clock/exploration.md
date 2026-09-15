# FLY-2573 weekly lifecycle 时间夹具 — 探索
Issue: FLY-2573 (https://linear.app/geoforge3d/issue/FLY-2573/ci假红-db-maintenance-weekly-lifecycle-测试跨秒就假红假-stat-在读取时才取-date)
日期: 2026-09-14
基于: 无

## 目标和边界
消除 weekly lifecycle 假 stat 在读取时取 date 导致的跨秒假红。仅修改测试，生产 scripts/db-maintenance.sh 保持逐字不变；不加重试、sleep 或多数表决。

## 当前证据
基线 f022a0a7e。scripts/__tests__/db-maintenance.test.sh:111 在 GNU fallback 中运行 date +%s。生产函数实际名为 marker_current，先取 now，再 stat；mtime <= now 是正确的守卫。现有测试仅断言 rc=0、收据 3 条和出现 skip。
当前工作树无 FLY-2573 文档；implement TURN epoch=1 已授予，inbox 无指令。按注入 DOC-FLOW 建立计划并请求设计审查。
