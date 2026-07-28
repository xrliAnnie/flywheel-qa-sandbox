# FLY-1505 Ship 轮询后续风险 — 调研
Issue: FLY-1505
日期: 2026-07-28
基于: qa-report.md

## 本轮不阻塞的后续项

以下三项已经由 QA 复核，按 Lead 裁定不折入 FLY-1505 当前修复范围，留作后续建单输入：

1. **在飞 ship attempt 仍可能被 FLY-799 自动重唤醒。** 本单把 Runner 等待窗口从约 10 分钟延长到约 20–35 分钟，但轮询期间不会刷新 `last_activity_at`；因此 FLY-799 的暴露期从约 5 分钟放大到约 30 分钟。后续修法二选一：把存在在飞 ship attempt 的会话排除出 stale-approved pass，或在 ship 起步时刷新一次 `last_activity_at`。
2. **已识别但仍 queued 的 GitHub Actions run 没有总等待上限。** `timeout-minutes` 只约束 job 执行，不约束排队时间；后续应给 queued 状态增加从 `:cool:` comment 起算的动态 workflow budget 加传输缓冲。
3. **被拒绝的 stale/unknown attempt 缺少耐久可见性。** 当前会保护现批准不被旧 attempt 污染，但对 stale/unknown outcome 的成功响应和 marker 消费没有单独 breadcrumb/告警；后续应补明确的 rejection receipt 或耐久告警。
