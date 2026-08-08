# FLY-1657 stale intent 修复 — 验收记录

Issue: FLY-1657 (https://linear.app/geoforge3d/issue/FLY-1657/fix-migrate-fly1572-mailboxlegacy-库形状依赖确定性炸no-such-table-mailbox)
日期: 2026-08-07
基于: plan.md

## 安全边界

- 验收脚本只把 source DB/WAL/SHM 当作 opaque bytes 复制;所有 SQLite open、迁移、verify、inventory 都只指向 `/private/tmp/fly1657-acceptance/`。
- 未对 `~/.flywheel` 下任何 DB/WAL/SHM 执行 SQLite open、chmod、rename、write 或 rollback。
- 权威输入 `r4/db-snapshot/files/flywheel` 的三个文件 SHA-256 与 `r4/db-snapshot/manifest.tsv` 一致。

## 阳性对照与修后结果

### A. 未修代码阳性对照

把当时生产 `comm/flywheel/comm.db`、WAL、SHM 和重写到沙箱路径的 `phase=done` intent 复制到临时目录后,未修代码稳定复现:

```text
EXPECTED_FAILURE=no such table: mailbox_migration_meta
```

这排除了 schema shape 随机性:触发条件是 legacy canonical 与 post-swap `done` intent 的现实矛盾。

### B. 修后权威 r4 snapshot

命令使用 `evidence/acceptance.mts stale`。结果:

- `mailbox_swap_intent_reconciled` loud JSON 已输出,reason=`stale_post_swap_intent`;
- 旧 intent 唯一归档为 `.stale-<UTC>-<UUID>`,fresh v2 intent 到达 `done`;
- 最终复核 22.323s 完成迁移并通过 `verifyMigratedDatabase()`;
- source=`messages:1236`,`lead_inbox:53646`;marker 与 verify 同数;
- `mailbox` 6849 行;
- 原旧 forensic backup SHA-256 前后不变。

### C. 修后当前 live-copy 非权威预警

同一 harness 对当前活库逐文件副本运行(只作增量风险预警,不声称是 quiesced snapshot):

- 20.284s 完成,stale intent 归档,fresh v2 intent=`done`;
- source=`messages:918`,`lead_inbox:53718`;marker 与 verify 同数;
- `mailbox` 6858 行;
- 原旧 forensic backup SHA-256 前后不变。

### D. 已迁移根库 + `done` intent 幂等

对当前 root DB/WAL/SHM + 重写路径的真实 v1 `done` intent 副本同时验证 library resume 和 run5 script skip:

- library resume 成功,既有 API 语义返回 `status=migrated`;主库 bytes 与 mailbox facts 不变;
- `--confirm-quiesced --db <sandbox-root>` 只输出 inventory:`state=migrated`,`intent.phase=done`,不进入 legacy migration;
- marker=`mailbox_v1`,source=`messages:3`,`lead_inbox:0`,`mailbox:3`;
- intent 保持 `done`。

### E. 当前全库存副本 inventory

`discover()` 边界内实际发现 root + 8 shard,共 9 库,全部为 `legacy|migrated`,无 `mixed|unknown|unreadable`:

| 库 | state | intent |
|---|---|---|
| root | migrated | done |
| flywheel | legacy | done |
| geoforge3d | legacy | 无 |
| growth | legacy | 无 |
| joycon-typeless | legacy | 无 |
| personal-assistant | legacy | 无 |
| sub | legacy | 无 |
| test-slot-1 | migrated | 无 |
| tidal-echo | legacy | 无 |

## 回归

- `mailbox-migration.test.ts`:61/61 通过。
- `scripts/__tests__/migrate-fly1572-mailbox.test.sh`:PASS。
- `pnpm lint`:exit 0（13 个既有 warning,0 error）。
- `pnpm -r build`:exit 0。
- `pnpm test:packages:run`:本 runner 首轮在高并发下出现 13 个 teamlead
  timeout/环境失败与 1 个 flywheel-comm 环境变量泄漏失败；串行复核后，除未改动的
  `fly247-bash-suites.test.ts` 两项外均通过。剩余两项的 hermetic 夹具要求
  `ps -o command= -p 1`/`pgrep` 可用，而 Codex 沙箱返回
  `operation not permitted`/`Cannot get process list`，使运行态探针按设计
  fail-close；这是当前执行环境限制，不是 mailbox 代码失败。
- 隔离复核：core 排除需要真实 macOS Terminal AppleScript 的单文件后
  219/219 通过；flywheel-comm 在清除 runner 注入的
  `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED` 后 1344 passed、1 skipped；teamlead
  首轮失败文件串行复核 116/118 通过，余下 2 项即上述进程枚举限制。
- code review 在 PR 前单独执行并记录。
