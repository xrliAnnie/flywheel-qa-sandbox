# FLY-1572 mailbox 硬切换与回滚 — 迁移回滚手册

Issue: FLY-1572 (https://linear.app/geoforge3d/issue/FLY-1572/消息层重构-c-批次1-合表-迁移两张信箱表并成一张-mailbox)
日期: 2026-08-05
基于: plan.md

## 约束

本迁移没有 feature flag、双写或灰度层。旧 binary 只认物理表,新 binary 只认 `mailbox_v1`;混合态不得启动任何一版。迁移窗口内必须保持全舰队 quiesced。

## 正向迁移

1. 停 Bridge,再停全部 Leads,park/停全部 Runner,禁止新 launch 与临时 CLI/MCP 写入。用 `pgrep`、`lsof`/`fuser` 复验 inventory 中每个 `comm.db` 无持有者。
2. 冻结 inventory,只读检查:

   ```sh
   npx tsx scripts/migrate-fly1572-mailbox.ts --inventory
   ```

   显式白名单必须覆盖 `~/.flywheel/comm/<project>/comm.db`、`~/.flywheel/comm.db`、`FLYWHEEL_COMM_DB` 与 `--db` 指向;`db-backups/`、`teamlead.db`、v2-era leftovers 不自动纳入。重复 inode、messages-only 或 unknown schema 均须先处理。
3. 执行迁移。脚本先检查磁盘至少可容纳源资产的 3 倍,随后逐库执行连续写闸、只读 online backup、sidecar quarantine、同盘私有 staging、单事务 cutover、原子 rename、目录 fsync 与终局校验:

   ```sh
   npx tsx scripts/migrate-fly1572-mailbox.ts --confirm-quiesced
   ```

   单库可用 `--db /absolute/path/comm.db`。每库输出 backup、intent 与精确 rollback 命令。

   2026-08-05 生产副本实演中,geoforge3d 单库磁盘占用由 112MB 增至 392MB,约 **3.5×**。这与计划的 3× preflight 属同一量级,但证明 3× 不是精确峰值;正式窗口须在脚本最低门槛之外继续保留运维余量。
4. 任一库失败时保持 quiesced,只允许二选一:修复后原命令续跑;或按下节把已处理库全部回滚。不得在 mixed state 启动服务。
5. 全部库均为 `mailbox_v1` 后部署新 binary。先起 Bridge,再起 Leads/Runner;检查四条流、ACK 状态、Bridge 健康与 fleet 在线数。

## 回滚

回滚也必须全舰队 quiesced。`restore-intent` 先完整 staging DB+refs,再换 refs,最后以 DB rename 为 commit point;每个 phase 可重入。

```sh
npx tsx scripts/migrate-fly1572-mailbox.ts --rollback --confirm-quiesced
```

单库:

```sh
npx tsx scripts/migrate-fly1572-mailbox.ts --rollback --confirm-quiesced --db /absolute/path/comm.db
```

回滚完成后必须复验:

- `messages`、`lead_inbox` 均为物理 table,行数与权威 backup 相同;
- DB 内容 hash、`integrity_check`、`foreign_key_check` 与 refs manifest 全部通过;
- 无异源 `-wal`/`-shm` 留在 canonical 路径;
- `restore-intent.json`、本轮 `.fly1572-quarantine` / `.fly1572-rollback-quarantine-*` 与 `<backup>.tmp-<uuid>{,-journal,-wal,-shm}` 均已清理;
- 仅在所有 inventory 库都回到 legacy 后部署旧 binary 并启动舰队。

## 验收锚

迁移完成 marker 只在同一事务的最后写入。旧 `lead_inbox` 真未读严格定义为:

```sql
processed_at IS NULL AND consumed_at IS NULL AND delivered_at IS NULL
```

脚本按旧行 id 对新 `mailbox.delivery_id` 做逐条恒等校验,且要求对应行 `state='QUEUED' AND carrier='inbox'`;任何数量或 id 差异都会回滚单库事务。`chat-receipt pending=0` 不作为其他 lane 已清空的证据。
