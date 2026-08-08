# FLY-1657 迁移工具 stale intent 修复 — 调研

Issue: FLY-1657 (https://linear.app/geoforge3d/issue/FLY-1657/fix-migrate-fly1572-mailboxlegacy-库形状依赖确定性炸no-such-table-mailbox)
日期: 2026-08-07
基于: exploration.md

## 1. 相关代码地图(全部行号对应本分支 HEAD)

| 位置 | 职责 | 与本单关系 |
|-----|------|-----------|
| `packages/flywheel-comm/src/mailbox-migration.ts` `migrateCommDbWithSwap()` L1283-1414 | 单库 backup→staging→migrate→swap→verify 全流程,swap-intent JSON 作 crash-resume 日志 | **主修改点**:resume 无现实核验 |
| 同文件 `migrateLegacyDatabaseFile()` L788-1027 | 单事务把 messages/lead_inbox 映射进 mailbox 系表,尾部写 `mailbox_migration_meta` marker | 无缺陷(全量彩排已证),不改映射逻辑 |
| 同文件 `verifyMigratedDatabase()` L1239-1265 | 读 meta marker 验证 | **次修改点**:meta 表缺失时裸抛 `no such table`,无 db 路径上下文 |
| 同文件 `backupCommDb()` L1160-1191 | 备份;**backupPath 已存在则直接复用**(L1165-1172) | stale resume 静默丢数据链的关键一环(见 exploration §5) |
| 同文件 `rollbackMailboxMigration()` L1425-1592 | 官方回滚;结束时把 intent 标 `phase:"aborted"` 并留档 | 反证:现场 intent 是 `done` ⇒ Aug 6 后的恢复没走这里 |
| `scripts/migrate-fly1572-mailbox.ts` | inventory/classify + 逐库 cutover 循环 | **第三修改点**(observability):inventory 不显示 intent 残留 |
| `packages/flywheel-comm/src/__tests__/mailbox-migration.test.ts` | 既有迁移测试(含 fault-injection resume) | 回归测试落点 |

## 2. resume 路径逐相位行为(现状)与危害矩阵

`migrateCommDbWithSwap` 的 intent 相位序列:`fenced → backed_up → sidecars_quarantined → staging_verified → canonical_swapped → dir_fsynced → verified → done`。resume 时 `reached(p)` 只看 intent 里记的相位,**从不看 canonical 实际长什么样**。

stale intent(canonical 已被带外恢复成 legacy)下的行为:

| intent.phase | 现状 resume 行为 | 危害 |
|---|---|---|
| `fenced` | L1352 try-verify 失败被 catch → 重新 chmod 0444;`backupCommDb` 复用**旧备份**(L1165)→ staging 迁旧数据 → swap | 静默丢数据 |
| `backed_up` / `sidecars_quarantined` | 跳过备份;复用旧备份做 staging → swap | 静默丢数据 |
| `staging_verified` | 直接 `renameSync(旧 staging, canonical)`(L1396) | 静默丢数据(若旧 staging 文件尚存) |
| `canonical_swapped` / `dir_fsynced` / `verified` / `done` | 全跳过 → L1404 最终 verify 裸炸 | loud 失败(= run4) |

补充事实:
- fence 动作(L1322-1324)把 canonical db+wal chmod 0444;直到 swap 完成前没有任何路径解除 fence(rollback 会解除)。⇒ **合法 crash-resume 的 canonical 必然仍是只读**。带外文件级恢复(cp 快照回来 + 老栈接管写)产生的是可写文件。
- `canonical_swapped` 相位在 `renameSync(staging→canonical)` **之后**才落盘(L1396-1398)⇒ phase ≥ canonical_swapped 时旧 staging 文件必已被消费。现场证实:`.fly1572-6fd5e9ea-…/` 只剩 -wal/-shm,comm.db 不在。
- 备份文件字节与 canonical 不保证一致(`Database.backup()` 是 checkpoint 合并拷贝),所以 sha256 相等不能当 resume 合法性判据;rollback 里的 sha256 比较(L1524)是"swap 是否已发生"的启发式,语义不同。

## 3. classify 语义(script 层)

`scripts/migrate-fly1572-mailbox.ts` `classify()`:
- `legacy` = messages+lead_inbox 都是 **table** 且无 meta 表
- `migrated` = meta 表存在、generation=mailbox_v1、且 messages/lead_inbox 不是 table(poison view 的 type='view' 不算)
- `mixed` = meta 存在但 legacy table 共存(FLY-1646 fail-loud 语义)
- `unknown` = 其余

已实测(生产 root 副本):root 现状 = messages/lead_inbox 均为 **view** + meta(mailbox_v1)⇒ classify=`migrated` ⇒ run5 script 层走 `ensureCanonicalDbWritable + continue` 幂等跳过,**不会**进 `migrateCommDbWithSwap`。intent 文件对 script 层完全不可见——这也是 observability 修改点的动机。

## 4. 设计期实测证据清单(全部临时副本,详细结果见 exploration §4)

1. **阳性对照**:合成 legacy 小库 + `phase:"done"` intent → 未修代码原样抛 `no such table: mailbox_migration_meta`(错误文本逐字匹配 run4.log L3467)。
2. **负对照 A**:同库带 4 张额外表、无 intent → `status:"migrated"`。形状假设排除。
3. **负对照 B**:生产 root 副本 + done intent(路径改写)→ 通过且无损;返回 `status:"migrated"`(语义上宜为 `already_migrated`,见 §6.4)。
4. **全量彩排**:r4 snapshot 真实 comm/flywheel 副本(1236 msgs + 53646 lead_inbox)未修代码 16.6s 迁完,verify 过,额外表(`workflow_engine_park`、`workflow_engine_park_cursor`、`lead_inbox_fenced_root`、`lead_inbox_freeze_install`)原样保留。
5. **数据风险扫描**(同副本):source 族全部 ∈ 已知 `LegacyLeadSourceFamily`;`candidates_json`=0、pending claim=0、dangling ack=0。⚠️ 注意这是 Aug 7 01:16 快照;run5 时活库会多出增量行,验收必须用**新鲜副本**重扫(见 plan 验收)。

## 5. 生产现场盘点(run5 输入面,只读取证)

| 库 | 状态 | intent 残留 |
|---|------|-----------|
| `~/.flywheel/comm.db`(root) | migrated(poison views + mailbox_v1),老栈在用 | **有,phase=done**(run4 合法产物,保留作回滚保险) |
| `comm/flywheel/comm.db` | legacy(Aug 7 01:17 rollback 重生,老栈活写,163MB+) | **有,phase=done ← 本单要治的雷** |
| `comm/geoforge3d` `growth` `joycon-typeless` `personal-assistant` `sub` `tidal-echo` | legacy(同批 rollback 重生) | 无(r2 后已归档进 `comm/intent-archive-r2-20260806/`) |
| `comm/test-slot-1/comm.db` | migrated(QA slot) | 无 |

另:run5 窗口脚本(r4 的 `r4_reset_nonfly`)会在 migrate 前把非-flywheel 项目 shard 挪去 retire,真正过 cutover 循环的预期是 root(跳过)+ comm/flywheel(迁移)+ test-slot-1(跳过)。工具修复不依赖这一点——对全部 9 库(root+8 shard)都必须行为正确。

## 6. 修复设计要点(结论,展开为 plan)

### 6.1 核心:resume 前 intent-现实对账(`migrateCommDbWithSwap` 入口)

读到 intent 后立即:

1. **路径绑定**:`intent.dbPath !== dbPath` → fail-loud(防副本/挪目录误配;验收副本需改写该字段,plan 有交代)。
2. `intent.phase === "aborted"` → 维持现状 loud 拒绝(操作员显式决策态)。
3. 观察 canonical 现实(readonly 开库,复用 script `classify` 同判据):`legacy` / `migrated` / `other`。
4. **phase ≥ canonical_swapped**(swap 已完成过):
   - 现实 = migrated → 合法尾部 resume,照旧走完(verify/cleanup)。
   - 现实 = legacy → **结论性 stale**(swap 完成过 + 现在纯 legacy = 必然带外恢复)。加一道 tripwire:旧 stagingPath 文件若还存在 → 矛盾,fail-loud;否则**自愈**:intent 原子改名归档为 `<intentPath>.stale-<UTC>`(rename + dir fsync,不删),stderr 打一条结构化 loud 日志,随后按**全新迁移**走(新时间戳备份、新 staging、全量 migrate+verify+swap)。
   - 现实 = other → fail-loud(mixed/unknown 需要人)。
5. **phase < canonical_swapped**(swap 未发生过):
   - 现实 = legacy **且 fence 完好**(canonical mode 无任何写位)→ 合法 crash-resume,照旧。
   - 否则 → fail-loud,错误信息点名"canonical 在窗口外被改动,resume 会用旧备份/旧 staging 盖掉新数据",给出归档 intent/staging/backup 的 remediation 指引。**这条把 §2 的三条静默丢数据路径全部封死。**

自愈只放在证据链闭合的场景(4-legacy):phase≥canonical_swapped 保证旧 staging 已消费、旧备份已履行过职责,现在的 legacy canonical 就是当前唯一事实源,对它做全新迁移正是工具的本职。其余一律 fail-loud——满足 issue"缺什么补什么,fail-loud 不许静默 skip"。

### 6.2 `verifyMigratedDatabase` 诊断质量

先 `tableType(db,'mailbox_migration_meta')`,缺表 → 抛既有格式 `mailbox migration marker missing: ${dbPath}`(带路径),不再裸漏 `no such table`。run4 的裸错误让 operator 多花了一夜定位。

### 6.3 script inventory observability

inventory 输出加 `intent` 字段(存在 intent 文件时给出 `{phase}`),run5 preflight/报告一眼可见残留。不改 cutover 决策逻辑(对账在库层)。

### 6.4 done-resume 返回语义

入口相位已是 `done` 且现实 = migrated 时,返回 `status:"already_migrated"`(现状返回 `migrated`,日志有歧义)。行为(cleanup 等)不变。

### 6.5 明确不做(边界)

- 不改 `migrateLegacyDatabaseFile` 映射逻辑(彩排已证无缺陷)。
- 不动生产残留清理(旧备份/staging 残目录/intent 归档目录)——run5 后运维事项。
- 不改窗口/rollback 脚本(`~/.flywheel/r4` 生产资产,模板回灌在任务 #192);run5 runbook 建议加一条 preflight 列出全部 `*.migration-swap-intent.json`(belt-and-braces)。
- 不改 `rollbackMailboxMigration`(其 aborted 语义正确)。

## 7. 风险与开放问题

1. **fence 完好性判据**(§6.1-5 用 mode 写位):若未来有人用 `cp -p` 从恰好 0444 的快照恢复,mode 判据会误放行——但该场景 canonical 内容=旧备份内容,resume 结果与合法 resume 等价,无数据损害;接受。
2. **readonly 开 0444 WAL 库**:现有 L1352 try-verify 已在生产/测试同条件下工作(run4 comm/flywheel 正是 fence 后被 readonly 打开过),对账复用同一开库方式,无新风险。备份文件取证需 `immutable=1` 的坑只影响离线取证,不影响工具路径。
3. **run5 活库增量数据**:彩排数据是 Aug 7 快照;若 run5 前活库新增了未知 source 族/candidates_json/pending claim,`migrateLegacyDatabaseFile` 既有守卫会 loud 拒绝(这是正确行为,不是本单缺陷)。验收要求用新鲜副本重扫一次以提前暴露(plan 验收步骤)。
4. **root 的 done intent 长期滞留**:修复后它是良性的(script 层 migrated 跳过;库层就算被调也走合法 done-resume)。是否归档留给 run5 后运维,不进本单。
