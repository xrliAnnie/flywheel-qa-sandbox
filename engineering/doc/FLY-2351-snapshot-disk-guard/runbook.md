# FLY-2351 快照与 Data 卷防护 — 运维手册
Issue: FLY-2351 (https://linear.app/geoforge3d/issue/FLY-2351/运维磁盘-满盘事故-9-5-0130patrol-repairs-库快照无上限127-份55gb-qa-体往-tmp-拷生产库不回收)
日期: 2026-09-08
基于: plan.md

## 容量判断

- macOS 只看 `df -h /System/Volumes/Data`；`df -h /` 是密封系统卷，不能代表生产数据可用量。
- 机器接口：`node scripts/flywheel-snapshot-control.mjs disk`。`disk.availBytes` 是判定源，`disk_avail_gb` 不舍入，仅展示。
- `disk.availBytes < 20000000000` 时巡检 STEP 5 必须是 `FINDING`；等于 20GB 不触发低盘 finding。读数 unknown 不得当 0，也不得把 STEP 5 定稿为 OK。

## 低盘紧急处置顺序

低盘 finding 后严格按顺序处置：

1. **只读 inventory**：记录 Data 卷可用 bytes、计划快照的 reservation、规范 repair 快照、受管 runner 目录和不可删除项；盘点本身不得写数据库。
2. **只清理已批准对象**：仅按保留规则清理可删旧快照和已结束的受管副本。未映射、owner 不明或仍活跃的对象只列入 `non_deletable_items`，不得猜测删除。
3. **重新测量 5× 门槛**：记录 `measured_avail_bytes` 与 `required_bytes = 5 × reservation`。只有重新测量达标，才可创建恢复点并继续修改数据库。
4. **不足即停并上报**：若仍不足 5×，停止所有会修改数据库的修复，把 `measured_avail_bytes`、`required_bytes` 和 `non_deletable_items` 报给 Lead，由运维扩容或按目标存储的既有合同扩大清理范围。

不能降到 `2×`，不能用裸 `sqlite3` 绕过受管快照门槛，也不能把会额外占盘的 db-maintenance backup 或 `VACUUM` 当作紧急腾空命令。

## 创建快照

禁止 `cp` 正在使用的 `teamlead.db` 或 `comm.db`。在线快照统一走：

```sh
node scripts/flywheel-snapshot-control.mjs repair --source "$FLYWHEEL_STATE_DB_PATH" --kind teamlead --issue FLY-2351
node scripts/flywheel-snapshot-control.mjs runner --source "$FLYWHEEL_STATE_DB_PATH" --kind teamlead
node scripts/flywheel-snapshot-control.mjs runner --source "$FLYWHEEL_COMM_DB" --kind comm --project flywheel
```

runner 输出只能位于 `/tmp/flywheel-snapshots/<exec>/`。整个 execution 目录（含隐藏文件、WAL、SHM、衍生文件）上限 2GB。使用方在提交节点终态前关闭全部数据库句柄；正常 closeout 删除目录，`snapshot release` 是幂等的显式提前释放入口。

`cycle-time-report` 和 retention rehearsal 按库顺序获取、使用、释放；不能同时占着第一对副本再申请第二对。rehearsal 中另一原库只读用于跨库保护，不属于受管副本，也不执行删除或 VACUUM。行级快照及还原验证临时库都留在受管目录，最终只持久化摘要和校验和。

单库副本加该操作的 scratch 预留必须在 2GB 内；获取成功不保证后续 rehearsal 的工作空间也能通过准入。容量不足只产生该库的 finding，释放后仍尝试另一库。rehearsal 摘要以 `databases` 分库列结果，顶层 `vacuumDurationsMs` 保留供原有验证入口使用；存在 finding 时返回 `status:partial`、退出 1，不能当作完整验证通过。cycle-time 则在对应来源的 error/status 中记录拒绝，继续生成其余来源的报告。

每次大文件写入前按 SQLite page reservation 检查 Data 卷，`avail >= 5 × reservation` 才允许；等号允许。`insufficient_data_volume` 或 `data_volume_unavailable` 会拒绝写入并通过既有 `meta-alert.sh` 留下 `snapshot-storage-refused` 告警，告警失败也不会放行写入。

## 保留与巡检

```sh
node scripts/flywheel-snapshot-control.mjs prune --dry-run
node scripts/flywheel-snapshot-control.mjs prune --apply
```

自动维护每轮先记录 dry-run，再 apply。规范 repair 快照保留集合是“24 小时内”与“每 issue、数据库类型、comm project 最新一份”的并集；恰好 24 小时保留。删除逐文件核对 inode/device/size/mtime，不递归删除整个 `patrol-repairs`。

旧快照只有写入 `patrol-repairs/legacy-map.json` 且当前 inode 元数据仍与显式归属证据一致时才参与回收。未映射文件及历史任意 `/tmp/qa*` 目录只做 inventory，不能猜归属或自动删除。

## 故障含义

- 退出 0：成功，最后一行 JSON 为 `ok:true`。
- 退出 2：参数错误，不重试。
- 退出 1：运行期拒绝或失败；JSON `retryable:true` 才可重试。
- `snapshot_lock_busy`：本 tick 不绕锁，CLI 最多 12 次、总预算 90 秒；Bridge 留到下一维护 tick。
- `snapshot_helper_missing`：checkout-local dist/helper 不完整，先构建并修复当前 checkout；禁止改用手工 `cp`。
- owner mismatch、unknown、活跃或新 activation：保留目录并告警，不按目录名、mtime 或普通 `stage completed` 猜终态。
