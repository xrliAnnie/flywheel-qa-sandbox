# Design Review — FLY-1771 plan.md (Round 2)

Date: 2026-08-14
Author: Codex
Status: APPROVED

## Summary

Round 1 的三项阻塞均已实质关闭：catch-up 语义现在与公式一致，12 小时测试成为非空且能抓漏拍的连续链断言，生产验收也改为有明确观察窗的 per-chain 证据。方案继续复用现有 GatePoller、mailbox 三态和 durable journal，只改两个生产文件且不增加 timer、flag、schema 或配置，已具备实施条件。

## What's Good (Keep)

- §0 把真实语义裁定为“每 slot 至多一拍；首次观察到未服务的当前 slot 时 catch up”，不再误称严格 edge-trigger cron。矩阵 #12/#14、风险 R6 与 RED-3 均围绕同一合同：05:30 重启/roster re-entry 立即发一拍，正常结算后 06:00 回边界。
- 新 due 公式仍正确保留 FLY-1687 的 settlement 保护：02:00 拍到 05:37 才结算时，05:38 因 `anchorMs >= currentSlotStart` 跳过，06:00 才发；`absent_identity` redrive、live `QUEUED/LEASED` cap、live/archived `ACKED/DEAD` 语义均未被重排。
- RED-1 现在同时锁住四个独立性质：剔除 genesis 后恰好 12 拍、相邻 `scheduled_at` 恰差一个 interval、slot 对齐、每拍 drift 在 0..60s。漏拍、重复拍或只发少量样本都不能靠 modulo 断言蒙混过关。
- production acceptance 已按 `(lead_id, session_key)` 单链取证，要求持续非空 roster、固定 interval、无重启观察窗，并用至少 6 对相邻 scheduled slots + drift 上界证明连续六小时；mid-slot catch-up 会重开观察窗，不再与稳态累积漂移混淆。
- `scheduled_at` 继续只是 `HookPayload` optional 字段，既有 `generated_at` 作为 actual；`formatPatrolTick`、两条 runtime renderer、eventId 链式 dedup、journal-winner dispatch 和失败告警均保持原合同，blast radius 合理。

## Issues & Recommendations

1. **[LOW，非阻塞] 矩阵 #9 的“首拍即对齐整点”可再加一个条件。** 若 legacy 行的 `generated_at` floor 后已属于当前 slot，确实会等下一边界；若 Bridge 在更晚的未服务 slot 中途部署/重启，则按 §0/#12 会先发一次 catch-up。建议实施时把 #9 用例固定为“legacy basis 与 current slot 相同”，或把文字改成“fallback 后遵循 §0 catch-up 规则”。§0、#12 和 RED-3 已足够明确，因此这不阻塞实施。

## Verdict

APPROVED — ready to implement
