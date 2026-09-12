# FLY-2520 账号到期排序 — 调研
Issue: FLY-2520 (https://linear.app/geoforge3d/issue/FLY-2520/切号器-claude-账号候选排序加账号到期日维度retiresat-早于下次-reset-的号优先用光founder-2026-09-11)
日期: 2026-09-11
基于: exploration.md

源码审计：account-store.ts 定义 AccountEntry、严格文件读取及最终 selectNextAccount；account-candidate-selector.ts 负责现场验证、panorama 和 rank；quota-monitor.ts 渲染 panorama；bridge/capacity-snapshot.ts 产生容量账户数据；bridge/hook-payload.ts 校验并渲染 patrol 额度行。

需要在最终选择再次排除已到期账号，防止验证到切号期间跨越退役边界。严格文件读取和候选运行时都应拒绝无效日期，不能让 NaN 静默影响排序。现有 observation 写入使用条目展开，应验证 retirement 被保留。

现有测试族：account-store、account-candidate-selector、quota-monitor、capacity-snapshot、patrol-tick-render。无数据库 schema 变更。
