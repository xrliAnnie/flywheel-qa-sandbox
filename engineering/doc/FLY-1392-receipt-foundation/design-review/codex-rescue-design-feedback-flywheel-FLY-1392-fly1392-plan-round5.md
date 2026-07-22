# Design Review — FLY-1392 plan.md (Round 5)

Date: 2026-07-20
Author: Codex
Status: APPROVED

## Summary

draft v5 已完整关闭 Round 4 的首次窗口 liveness 缺口：统一 delivery 合同覆盖所有要求 processed 的非 ship canonical 行，并把 deadline 初始化与 delivery fact 放在同一事务。存量 bootstrap 采用 derive-first、持久 activation time、完整窗口和 flag-off 零 backfill，既保住已答门不催，也避免旧 `delivered_at` 在启用时制造即时风暴；结合前四轮已闭合的原子性、单 owner、wake budget/outbox 和 kind-scoped escalation 合同，计划已可进入实现。

## What's Good (Keep)

- §2.1 不再把 model lane 当特例：ordinary `gate_question`、`runner_question`、model owner 与 hub-root 都服从同一 per-type delivery 初始化合同。
- `COALESCE(next_unprocessed_at, delivered_at + typeWindow)` 与 delivery fact 同事务，保证 transport 延迟不侵蚀 Lead 的完整处理窗口，也不会让未送达行串入未处理轴。
- `resend_of IS NULL`、非 ship、合同表 allowlist 三重边界与 §6.1 selector 对齐；新类型仍默认不催，D-6/D-7 与蓝图 §2.4 均保持不变。
- bootstrap 先做 provenance derivation，再处理仍未 processed 的 eligible delivered rows；已答且 evidence 合法的旧行不会被重发。
- durable activation time 使 restart 使用同一时间锚，避免重复启动窗口；flag=0 明确不 backfill，保住 reverse-compat sentinel。
- 五个 real-DB 测试覆盖新投递、延迟投递、旧库已答/未答、bootstrap crash/restart，足以让本轮修订在实现时可直接验真。
- Round 3 的 model-owner delivery liveness 与 cross-cohort CLEARING maintenance 修复在 v5 中保持完整，没有被 bootstrap 改动重新打开。

## Issues & Recommendations

1. **[Non-blocking implementation guard]** 实现 bootstrap 时，应按 §2.1 的统一初始化合同在同一幂等 UOW 中同时执行 `next_unprocessed_at = COALESCE(next_unprocessed_at, activationAt + typeWindow)` 与 `resend_round = COALESCE(resend_round, 0)`；否则旧库新增列的 NULL round 无法可靠进入 r1。计划中的 real-DB 测试 (d)/(e) 已足以作为该细节的验收门，因此不阻塞设计批准。

## Verdict

APPROVED — ready to implement
