# FLY-2349 shutdown-controls 重建与 poison view 冲突 — 调研
Issue: FLY-2349 (https://linear.app/geoforge3d/issue/FLY-2349/p0main-fly-2268-的-runner-shutdown-controls-重建在-database-open-阶段跑-ddl撞)
日期: 2026-09-04
基于: exploration.md

## 1. 可重复反馈环

在当前 `origin/main`（`c03d312ca`）安装 lockfile 依赖并构建
`flywheel-comm` 依赖闭包后，使用 `tsx -e` 运行以下真实调用链：

1. `new CommDB(path)` 建出当前 schema；
2. 写入一行 shutdown request；
3. 临时 drop poison views，把 shutdown 表降级为
   `execution_id TEXT PRIMARY KEY`，再执行仓库的 `MAILBOX_POISON_VIEWS` 恢复两个 view；
4. `prepareFly2268CommDbRebuild(path)` 发布 source-bound receipt；
5. `new CommDB(path)` 触发真实 `openCommDbWritable()`。

有效运行在约 0.5 秒内稳定以 exit 1 结束，目标错误逐字为：

```text
CommDB open failed at <tmp>/comm.db (phase: database-open): error in view messages: no such table: main.fly1572_poison_messages_use_mailbox
```

此前两次运行分别在缺失 `tsx` 与缺失 workspace dependency `dist` 时退出，均未触到
业务断言，未计作红证据。反馈环的环境前置固定为：

```bash
pnpm install --frozen-lockfile
pnpm --filter flywheel-comm... build
```

回归测试将把同一 fixture 内联到 Vitest，使长期尺子只需一条命令：

```bash
pnpm --filter flywheel-comm test:run --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1 src/__tests__/db.fly2268.test.ts -t "rebuilds a legacy shutdown table with both FLY-1572 poison views present"
```

该命令已在未改实现的基线运行，Vitest 明确报告仅执行
`src/__tests__/db.fly2268.test.ts`：19 tests passed；此前带 `test:run -- --pool` 的写法
会让字面 `--` 截断 Vitest option parsing、误跑整包，已废弃。

## 2. 调用顺序与失配点

```mermaid
sequenceDiagram
    participant B as Bridge boot
    participant P as FLY-2268 preflight
    participant O as writable opener
    participant G as rebuild gate
    participant M as CommDB migrations

    B->>P: backup + quick_check + source binding
    P-->>B: publish receipt
    O->>G: new Database(path)
    G->>G: BEGIN IMMEDIATE
    G->>G: DROP/ALTER runner_shutdown_controls
    Note over G: SQLite reparses live poison views and throws
    G->>G: ROLLBACK; receipt remains
    O--xM: never reaches migrations
```

`CommDB` 的 migrations 事务已经遵循“先 drop 两个 view，再做 DDL，最后重建 poison
views”的 FLY-1572 合同；问题是 FLY-2268 gate 位于它之前。path-based
`MailboxQueue` 也直接使用 `openCommDbWritable()`，但没有 `CommDB.applyMigrations()`，
因此把 rebuild 只移动到 `CommDB` migrations 会漏掉另一个共享 writer。

## 3. SQLite 与事务性质

- poison view 的 sentinel 表故意不存在；创建 view 时允许不存在，其他 schema DDL 可能
  触发对 view 的重新解析。
- `openCommDbWritable()` 已在 source/backup/schema receipt 校验后执行
  `BEGIN IMMEDIATE`，且任何错误都会在 `opened.inTransaction` 时 rollback。
- 决定性实验在同一 production-shape fixture、同一 `BEGIN IMMEDIATE` 中设置
  `PRAGMA legacy_alter_table=ON`，原样执行 create/copy/drop/rename，finally 关回 OFF。
  结果 exit 0：复合 PK 为 `execution_id.pk=1/request_id.pk=2`，shutdown 行逐字段守恒，
  两个 view 的 `sqlite_master.sql` 前后完全相同，且 reset 后 pragma 读值为 0。
- 因此最小安全修复不需要 view 手术：只在既有 table rebuild 内 transaction-scope 开关
  legacy ALTER 语义。receipt 仍只在 commit 后 rename，保留现有 fail-safe 重试语义。

## 4. 方案比较

| 方案 | writer 覆盖 | 对 FLY-2268 锁定合同的影响 | 结论 |
|---|---:|---|---|
| transaction 内开 `PRAGMA legacy_alter_table=ON` | `CommDB` + path `MailboxQueue` | 实测完整 batch 通过；views byte-identical；finally 恢复 connection 状态 | 采用 |
| gate 事务内 drop / rebuild / restore | `CommDB` + path `MailboxQueue` | 可行，但必须按 sqlite_master type drop、只恢复原有 view；改写 unrelated schema 对象 | 备选，未采用 |
| 移入 `CommDB` migrations | 只覆盖 `CommDB` | path writer 漏修；重定义最早共享门 | 否决 |
| opener 捕获普通 `SqliteError` 并继续 | 表未重建却伪装成功 | 吞掉真实 schema 错误，破坏 fail-loud | 否决 |
| preflight 删除/改写生产 views | boot preflight 全部项目 | 把异步只读备份阶段变成 schema writer | 否决 |

## 5. 测试设计

在 `db.fly2268.test.ts` 把现有 downgrade helper 的默认输出改成生产形状：同一 connection
恢复仓库定义的两个 poison view 后再 checkpoint；只给一个兼容用例显式 opt out。新测试
必须在发布 receipt 前直接查询 `sqlite_master`，证明：

- shutdown 表确为 legacy PK：`execution_id.pk = 1`、`request_id.pk = 0`；
- `messages` 与 `lead_inbox` 均为 `type='view'`；
- view SQL 分别含 `fly1572_poison_messages_use_mailbox` 与
  `fly1572_poison_lead_inbox_use_mailbox`。

然后打开 `CommDB`，断言原 shutdown 行保留、复合 PK 与 `settlement_reason` 完成迁移、
两个 view 仍是 poison view、receipt 被 rename。最后连续再打开三次，证明 gate 不会永久
重放且普通 migrations 可重复。

另用同形状、独立 fixture 直接打开 path-based `MailboxQueue`，断言它也能完成 rebuild、
保留两个 view 的 byte-identical SQL 并重复打开。现有 no-receipt/stale/verified/concurrent
测试全部随默认 helper 升级为 poison 形状，覆盖失败与 winner/loser 分支。

现有测试继续覆盖：无 receipt 可写、stale receipt 可写但不迁移、verified backup、并发
winner/loser。新增测试不替代这些负向 guard。

## 6. 风险与边界

- `DROP VIEW IF EXISTS` 遇到同名 table 会报错；选中方案完全不发 view DDL，所以 poison
  views 与 pre-FLY-1572 同名 tables 都不被触碰。
- connection-level pragma 若泄漏会改变后续 migration 行为；实现必须用 finally 关闭，
  测试直接验证 open 返回后的 pragma 为 0。
- 不读取、不复制、不修改生产 CommDB；生产快照端到端验证留给独立 QA 节点。
