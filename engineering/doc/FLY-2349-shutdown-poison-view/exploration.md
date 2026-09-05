# FLY-2349 shutdown-controls 重建与 poison view 冲突 — 探索
Issue: FLY-2349 (https://linear.app/geoforge3d/issue/FLY-2349/p0main-fly-2268-的-runner-shutdown-controls-重建在-database-open-阶段跑-ddl撞)
日期: 2026-09-04
基于: 无

## 问题与用户影响

FLY-2268 把 `runner_shutdown_controls` 的主键从单列 `execution_id` 改为
`(execution_id, request_id)`，并把一次性重建放在所有 CommDB 可写打开共享的
`openCommDbWritable()` 最前端。Bridge 启动 preflight 发布 receipt 后，下一次可写打开
会在 `database-open` 阶段消费 receipt 并执行 `DROP TABLE` / `ALTER TABLE`。

已经完成 FLY-1572 mailbox migration 的生产 CommDB 同时保留两个故意不可解析的
poison view：`messages` 和 `lead_inbox`。SQLite 执行 shutdown 表 DDL 时重新校验 schema，
首先在 `messages` 指向的不存在 sentinel 表上失败。事务回滚后 receipt 仍在原路径，
所以每次可写打开都会重放同一失败。`CommDB` 与 path-based `MailboxQueue` 共用 opener，
故障会覆盖所有写路径，而不是单一 delivery maintenance 调用方。

## 当前代码证据

- `packages/flywheel-comm/src/commdb-open-gate.ts` 的
  `rebuildRunnerShutdownControls()` 直接执行建临时表、复制、删旧表、改名，没有临时
  移除 poison view。
- `packages/flywheel-comm/src/db.ts` 只在后续 `migrations` 阶段的 immediate transaction
  内执行 `DROP VIEW IF EXISTS messages/lead_inbox`，但 rebuild gate 在构造器的
  `database-open` 阶段已经先运行。
- `packages/flywheel-comm/src/__tests__/db.fly2268.test.ts` 的 legacy fixture 在降级
  shutdown schema 时 drop 两个 view，之后没有恢复它们；现有“receipt 合法则重建”测试
  因而没有覆盖生产形状。
- `packages/teamlead/src/__tests__/commdb-fly2268-preflight.test.ts` 使用相同的无 view
  降级方式，只证明 receipt 生成，不证明下一次可写打开能穿过 FLY-1572 schema。

## 假设排序与可证伪预测

1. **主因：shutdown DDL 触发 poison view 重解析。** 若在同一个 `BEGIN IMMEDIATE`
   事务内先 drop 两个 view，完成 table rebuild 后再按 `MAILBOX_POISON_VIEWS` 恢复，
   legacy + poison fixture 的首次和后续可写打开都会成功，且两个 view 仍存在。
2. **永久性来自 receipt 的正确 fail-safe 行为。** 若 DDL 抛错，事务回滚且 receipt 不被
   rename；连续三次打开应得到相同失败。修复后 receipt 只在成功 commit 后 rename。
3. **把重建后移到 migrations 也能避开 view。** 若改动构造器阶段顺序，故障会消失；但
   这会放宽 FLY-2268 已评审锁定的“所有 writable opener 最早共享门”合同，影响
   path-based `MailboxQueue`，因此不是首选。
4. **单独处理 `messages` 不充分。** 若只 drop `messages`，错误应转移到 `lead_inbox`；
   修复和测试必须覆盖两者。

## 锁定范围

- 只修改共享 rebuild gate 与直接回归测试。
- 不改变 receipt/source-binding/backup/quick-check/data-version 约束。
- 不改变 Bridge preflight 调度，不添加 env flag，不处理生产文件，不清理现有 receipt。
- 不把 shutdown rebuild 移出 `openCommDbWritable()`，除非设计评审明确否决原子
  drop/rebuild/restore 方案。

## 成功条件

1. 一个由真实 current schema 降级出的 fixture 同时具备 legacy shutdown PK 与两个
   FLY-1572 poison view；修复前准确报 `database-open` 的 view missing-table 错误。
2. 合法 receipt 后首次 `CommDB` open 完成重建，行数和行内容守恒，主键为
   `(execution_id, request_id)`，`settlement_reason` 存在。
3. `messages` 与 `lead_inbox` 在成功后仍是原 poison view；第二次及连续重复可写打开成功。
4. 在 DDL 中途失败时，transaction rollback 同时恢复旧表与两个 view，receipt 不被消费。
5. 现有 stale/no-receipt/concurrent-writer 负向保护继续通过。

