# Design Review — plan.md (Round 5)
Date: 2026-07-27
Author: Codex
Status: APPROVED

## Summary

本轮审查目标为用户指定提交 `3c5e3c3d60ad7652afb2ec2469228b885d38742e`。检查时工作区 HEAD 已前进到其子提交 `22d4a376020e82dd0fcd3e7a947f47ac39312ef1`，但该额外提交只修改 `progress.md`；目标 plan 在两提交中的 blob SHA 完全相同（`ee1b98cf59241ecbfb7a3dd3d6973a99a2bb0795`），因此本轮实际复核的 plan 内容与指定版本一致。

Round 4 的唯一 HIGH 已完整关闭。§5.1 现在把两个生命周期分成正确的两层：

- outer guard 在调用 `.immediate()` 前完成 nesting check 并设置 `inWrite=true`，outer `finally` 包住 BEGIN、wrapper、COMMIT/ROLLBACK 的整个 invocation；
- inner `finally` 只负责在 callback 离开时、COMMIT 前失效 `WriteTx`；
- `BEGIN IMMEDIATE` 因 `SQLITE_BUSY` 在 wrapper 之前失败，也必经 outer `finally`；
- BEGIN 阶段的 verbose reentrancy 会遇到已置位的 guard，抛 `NestedWriteViolation`；
- T5 e/f 分别锁定 contention recovery 与 verbose reentrancy，T5 c/d 继续覆盖 callback 内部异常及 escaped handle。

这一层级与 better-sqlite3 的正式 transaction 时序一致：transaction function 被调用时先开始事务，wrapped function 返回后提交，异常则回滚。参考 [better-sqlite3 transaction API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function)。

本轮没有发现新的 fidelity、SQLite、migration、API、failure-path 或 scope blocker。计划可进入实现。

## What's Good (Keep)

- 两层 `try/finally` 的责任划分清晰，既不会让 tx handle 活过 callback，也不会让 nesting flag 在 BEGIN/COMMIT 边界提前失效或永久残留。
- `NestedWriteViolation` 已加入穷举 runtime export 集合，API surface 测试会防止漏导出或额外漂移。
- T5 e 使用同一 Kernel 在 BUSY 后重试成功，直接证明 outer cleanup，而不是只证明 SQLite 会报 BUSY。
- T5 f 同时断言无 savepoint、无写残留，能识别“只是抛了错但已经进入 nested transaction”的假修复。
- root-only package exports、built-package consumer fixture、type-only/runtime allowlist 均保持不变并通过本轮独立最小 fixture。
- DDL 回归复验仍为 17 表、13 个命名索引、`foreign_key_check=0`、11 个 textual PK 全部 `notnull=1`。
- v9 两表的 D14 diff 仍严格只有两处 `NOT NULL`；七索引、四候选和 detector 仍与设计链原文逐字一致。
- batch-1 继续保持纯新增、零生产接线，没有进入消费循环、dispatcher、探针、告警或切换执行。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. 无阻塞问题。实现时按 TDD 顺序保留 T5 a–f 的独立失败语义，不要把 contention、callback exception 与 verbose reentrancy 合并成只检查异常类型的单一测试。

## Verdict

APPROVED — ready to implement
