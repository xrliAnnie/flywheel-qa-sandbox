# FLY-2541 B3 reader 接线 — 探索
Issue: FLY-2541 (https://linear.app/geoforge3d/issue/FLY-2541)
日期: 2026-09-14
基于: 无

本单继续 FLY-2508 的真实 reader 装配，不改变其 source policy、compare、冻结 occurrence 和失败语义。当前 HEAD 14866f7e5 已包含 FLY-2390 #1156；真实 helper 位于 release-readiness/subject.ts。runtime 未注入 localDeployedSha，导致 local 策略到期失败。

首次接管目前先 bind 再等到期读取，reader 缺席也会建立 activatedAt。补首次激活守卫，保留在途恢复。真实 beta 验收必须使用真实 published/no_change receipt 和 B3 attribution，不能用 covered_by_newer 或 mock 替代。实现节点不部署、接管、派发 QA 或发布 beta。
