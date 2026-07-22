# FLY-1424 ship 就绪通知发射器 — Codex design review 记录
Issue: FLY-1424 (https://linear.app/geoforge3d/issue/FLY-1424/enginebug1-founder-gate-变-ready-零宣告-接ship-就绪通知发射器谁-emit-emit-给谁-怎么判)
日期: 2026-07-22
基于: plan.md

**最终裁定:APPROVED(第 8 轮,effort xhigh,persistent thread 019f88fd)**

| 轮 | 裁定 | 发现 | 关键项 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 7(2 BLOCKER) | Heartbeat 重投已死(FLY-1393)→ per-path durable facts;stalled 无「已处理」事实 → handledGuard;v2 模板事实纠错 → 收窄 v1 工程;notifier union;alert 原子性;pass 隔离/backfill;类型+registry 先行 |
| R2 | CHANGES REQUESTED | 6(3 BLOCKER) | 双臂控制流独立;delivery_failed 计入 pending 谓词;backoff 先过滤再限流 + pass 后置;handledGuard tri-state 只读;canonical queue id + journal 重建;registry/原子 API/文档漂移 |
| R3 | CHANGES REQUESTED | 4(2 BLOCKER) | 全集扫描 + per-path eligibility(backoff 只冻 founder 臂);REMIND_MS 改 readonly;sqliteTimestampToIso 共享 builder;probe budget 测试 |
| R4 | CHANGES REQUESTED | 3(1 BLOCKER) | ship_ready_handled_observed durable 收敛 fact;500 护栏 = warn-only 不截断;retry map 生命周期 |
| R5 | CHANGES REQUESTED | 2(2 BLOCKER) | handled 带原因(pr_merged/founder_approved 分流 + probe 竞态二次读);per-key UNKNOWN retry map |
| R6 | CHANGES REQUESTED | 2(2 BLOCKER) | 公平调度规则冻结(neverRawProbed 优先 + lastRawProbeAt ASC,防 phase-lock);batch manager lifecycle seam |
| R7 | CHANGES REQUESTED | 1(1 BLOCKER) | batch 内 per-key 故障隔离 + 成功空批 ≠ 查询失败 |
| R8 | **APPROVED** | 0 | — |

全部 25 项发现均采纳并折入 plan.md(修订标记 R5 版头 + 各分块内 Codex R{n} #{m} 溯源)。
反馈原文:/tmp/codex-rescue-design-feedback-flywheel-FLY-1424-plan-round{1..8}.md(temp,已摘要于此)。
