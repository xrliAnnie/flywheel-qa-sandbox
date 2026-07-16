# Design Review — plan.md (FLY-1066 dual-layer) (Round 2)

Date: 2026-07-16
Author: Codex
Status: APPROVED

## Summary

Round 1 的 7 项问题均已被实质性解决，且新版计划与当前源码中的 DirectEventSink 旁路、FLY-907 enqueue-only 契约、CommDB last-writer-wins、终态 reader 集合及 residue maintenance 接线相符。双层方案现在具备清晰的写入优先级、失败隔离、迁移门控和交互验收，可以进入实现；以下仅有非阻塞的文档/实现细化建议。

## What's Good (Keep)

- A2 不再假设 `applyTransition` 是唯一咽喉，而是确定列出并测试五个生产写入面；这与 `DirectEventSink.ts:102-108,647,758-785,1036-1088`、`complete-marker-reconciler.ts:731-758` 的实际旁路吻合。
- enqueue/drain 分离满足 `applyTransition.ts:19-27,71-80` 的微秒级 hook 契约；per-project single-flight、drain 前重读 StateStore、`finally` close 和分段故障测试共同把 transition latency 与 CommDB 锁竞争隔离开。
- A1 用独立的 `markSessionTerminalStatus` 表达 StateStore 权威 mark，并将 adapter 尾写改为 `status='running'` CAS；四个交错测试覆盖了源码中 `updateSessionStatus` 无条件覆盖和 `INSERT OR REPLACE` 的真实竞态。
- reader 修订完整：`getRecentTerminalSessions` 与 `countTerminalSessions` 同步扩容，terminal-mcp 的 cap/count/liveness 矩阵也纳入验收；同时明确不扩 `cleanupStaleSessions`，保住 failed/blocked 活窗口的 preserve 语义。
- B1 已从 boot-only 修成 boot + maintenance 两入口，并处理 boot probe 去重；新增 failed/blocked 集合受 harvest flag 控制，旧 completed/timeout boot prune 保持无条件，D2 已有明确答案。
- migration 不再只依赖“事务很快”的假设：fresh/migrated 两条 schema 路径、双进程锁竞争、超时回滚与下次重试均有验收，且 A1 明确先于 A2 启用。
- A3 收敛为现有 cleanup 的审计/pin gate，避免在没有具名缺口时增加删除路径；实施顺序与 owner-matrix 边界也合理。

## Issues & Recommendations

1. **[LOW, non-blocking] 清理几处仍保留第一版术语的文档矛盾。** `plan.md:9` 仍把方案概括成“FSM 转移咽喉”，`plan.md:27` 的分工表仍写旧的 `updateSessionStatus`；`research.md:149-150` 仍说扩现有原语签名；`exploration.md:111-116` 仍把 A3 描述为条件性新增 unregister，`exploration.md:167` 仍声称 applyTransition hook 覆盖全漏斗。这些不会阻止按新版 A1/A2 实现，但会让后续 implementer/PR reviewer 读到两个不同合同。建议统一为“五写入面 + `markSessionTerminalStatus` + A3 audit-only”，并删除 applyTransition 全覆盖的旧论断。

2. **[LOW, non-blocking] 把 bounded/coalesced queue 的边界行为写成一个小契约。** `plan.md:79-87` 已给出正确架构，但尚未指定容量、满队列策略、同一执行从 failed→blocked（或 retry→failed）的 latest-wins 规则，以及 Bridge close 时是 bounded drain 还是显式丢弃。建议 key 明写为 `(projectName, executionId)`、pending item 采用最新目标覆盖；满队列不得抛回调用面，必须计数/告警并由 Layer 2 兜底；补一条 status-flap 和一条 overflow 哨兵即可，避免实现时各自猜语义。

3. **[LOW, non-blocking] 精确表述 kill-switch 与 warm-migration 降级范围。** `FLYWHEEL_TERMINAL_COMMDB_SYNC=0` 只恢复“五个写入面零 enqueue”；A1 的 CHECK/reader/CAS 仍会生效，因此不要把它描述成整个票的 byte-compatible rollback。对 warm migration 因瞬时锁失败而禁用的 project，建议至少暴露持续 degraded health/计数；若成本很低，可做有界退避后重新 warm-migrate 并在成功后启用该 project 队列，避免一次 5 秒启动锁让 Layer 1 整个 Bridge 生命周期都关闭。

## Verdict

APPROVED — ready to implement
