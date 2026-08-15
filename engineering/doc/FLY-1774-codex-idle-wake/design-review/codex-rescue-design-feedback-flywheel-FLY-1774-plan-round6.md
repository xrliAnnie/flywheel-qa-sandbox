# Design Review — FLY-1774 plan.md (Round 6)

Date: 2026-08-14
Author: Codex
Status: APPROVED

## Summary

Round 5 的四项均已闭合，更新后的方案在当前架构上可实现：phase capability 现在有 fail-loud、单调、可断言的 producer，doorbell mutation 与所有生产 terminal status writer 共享同一 SQLite lifecycle fence，sessions migration 也覆盖 fresh、current 与古老 rebuild 起点。计划已具备 implement-node 所需的耐久身份、并发、回滚和 legacy rollout 边界，未发现新的阻断项。

## What's Good (Keep)

- Phase capability 注册的失败语义已按权限收窄：非-phase caller 保持既有 best-effort，`ctx.phaseKeepAlive` 则必须在 runtime/controller 创建前成功完成 migration/register，并断言同一 session 行为 `phase_keep_alive=1 AND status='running'`；这与当前 `CodexTmuxAdapter.execute()` 的调用顺序兼容（`packages/claude-runner/src/CodexTmuxAdapter.ts:462-540,1513-1539`）。
- `MAX(existing, excluded)` 把 capability 定义为 execution-scoped monotonic fact；dispatcher pre-register、CLI、Claude/Tmux 等默认 0 caller 不会降级已确认的 phase execution，新增的 0→1、1→0-negative 与 terminal-row-negative 测试足以约束 ON CONFLICT 行为。
- Terminal fencing 已覆盖两个真实生产 writer：adapter 的 `updateSessionStatusIfRunning()` 与 Bridge `terminal-commdb-sync` 使用的 `markSessionTerminalStatus()`；两者保留各自 CAS 语义，同时通过同一事务 primitive bulk-finish pending/started `doorbell:` wakes。该设计正确补足了现有 pending-only `disposeRunnerPhaseWakeForTerminal()` 的能力缺口，并保持 mailbox 零 settlement。
- Fence 使用闭集 `status='running'`，两种竞态顺序都有确定收敛结果；对 pending/started、terminal-sync-first、重复 terminalize 和 controller `finishWake()` 幂等的测试覆盖完整。
- Migration 已落到真实的 `CommDB.applyMigrations()` seam，而非 mailbox-only upgrader；DDL、fresh schema、FLY-1066 sessions rebuild/ADD 顺序、duplicate-column 并发容忍和最终列存在断言均已定死。三种起点的升级矩阵能防止旧表 rebuild 丢列，并验证非-phase caller 的行为不变。
- Legacy rollout 现在自洽：不伪造在途 execution 的 capability，不做不可信 backfill；列值 0 时 batch/sweep 两条 doorbell 腿都 fail-closed，Fix A 仍独立生效，完整能力从 next-spawn execution 起启用。该边界没有把当前坏状态包装成已修复，也没有引入额外迁移机制。
- R4 的 durable `coveredDoorbellAttemptIds`、mixed-attempt grouping、stale-envelope convergence、queue-enabled 零 ACK、单一 hold-loop 注入者、无 direct RPC、Fix D supervision 与真实 lease-redelivery QA 继续保持一致。

## Issues & Recommendations

1. 无阻断项。实现时按计划保留三组关键 negative tests：phase 注册失败不得启动 runtime/controller；任一 terminal writer 先赢后不得留下 non-finished doorbell；古老 sessions fixture rebuild 后必须保留 `phase_keep_alive` 且旧行值为 0。

## Verdict

APPROVED — ready to implement
