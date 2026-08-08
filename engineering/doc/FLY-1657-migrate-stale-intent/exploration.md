# FLY-1657 迁移工具 stale intent 确定性炸 — 探索

Issue: FLY-1657 (https://linear.app/geoforge3d/issue/FLY-1657/fix-migrate-fly1572-mailboxlegacy-库形状依赖确定性炸no-such-table-mailbox)
日期: 2026-08-07
基于: 无

## 1. 症状回放(run4,2026-08-07 01:17 MDT)

r4 迁移窗 M-migrate 步跑 `npx tsx scripts/migrate-fly1572-mailbox.ts --confirm-quiesced`:

- inventory:root `~/.flywheel/comm.db` = legacy、`comm/flywheel/comm.db` = legacy、`comm/test-slot-1/comm.db` = migrated
- root 迁移**成功**(3 messages,backup + swap-intent 落盘)
- 紧接着处理 `comm/flywheel/comm.db` 时抛 `no such table: mailbox_migration_meta` → exit 1 → 整窗 FAILED 自动回滚

案发原文:`~/.flywheel/r4/run4.log` 3454–3477 行;`~/.flywheel/r4/run4-report.md`。

## 2. 起点假设(Tadashi 预勘)与独立验证结论

| # | 预勘假设 | 独立验证结论 |
|---|---------|------------|
| 1 | 错误串来自 `verifyMigratedDatabase()` 的 `SELECT * FROM mailbox_migration_meta`;staging_verified 阶段调用无 try/catch | **部分成立**:错误确实来自 `verifyMigratedDatabase()`,但抛出点不是 staging 阶段(L1391-1392),而是 `migrateCommDbWithSwap` 尾部 L1404 的最终 verify(见 §3) |
| 2 | 两个 legacy 库 schema 形状不同(comm/flywheel 多 `workflow_engine_park` 等表)⇒ `migrateLegacyDatabaseFile()` 对某种形状没走到 meta 表创建 | **推翻**。形状是 red herring:① 合成小库(不含任何额外表)+ stale intent → 原样复现同错;② 同一小库带上 `workflow_engine_park`/`lead_inbox_fenced_root` 等额外表、**不带** stale intent → 迁移成功;③ r4 snapshot 的真实 comm/flywheel 数据(1236 messages + 53646 lead_inbox,含全部额外表)在**未修代码**上全量迁移成功(16.6s),额外表原样保留 |
| 3 | `comm/flywheel/comm.db` 无任何 `mailbox*` 残表(纯 legacy) | **成立**(与 classify=legacy 一致) |
| 4 | root 备份 `mode=ro` 打不开需 `immutable=1` | 取证注意事项,与根因无关 |

## 3. 真正的根因:stale swap-intent resume

`~/.flywheel/comm/flywheel/` 目录现场(2026-08-07 实查):

```
comm.db.migration-swap-intent.json          ← phase:"done", createdAt 2026-08-06T17:55:35.799Z
comm.db.pre-fly1572-2026-08-05T23-47-54.535Z  (r1 备份,162MB)
comm.db.pre-fly1572-2026-08-06T15-28-00.141Z  (162MB)
comm.db.pre-fly1572-2026-08-06T17-55-35.799Z  (r2/r3 备份,162MB)
comm.db.migrated-r2-failed-20260806           (521MB,被换下的 migrated 库)
.fly1572-6fd5e9ea-…/                          (staging 残目录,comm.db 已被 rename 消费,只剩 -wal/-shm)
```

事件链:

1. Aug 6 17:55Z 的那次迁移窗对 comm/flywheel **完整走完了 swap**(intent 推进到 `phase:"done"`,staging 文件被 rename 消费,canonical 变 migrated)。
2. 该窗整体判 FAILED 后,恢复走的是**文件级 snapshot restore**(窗口 rollback 脚本把 legacy 快照拷回 canonical),**不是** `rollbackMailboxMigration()`。后者会把 intent 标成 `phase:"aborted"`(mailbox-migration.ts L1574-1575),而现场是 `"done"`——这是文件级恢复的铁证。文件级恢复只还原 `comm.db`,**不清理 swap-intent 文件** → 陷阱埋下。
3. run4 再进来:`migrateCommDbWithSwap()` 先 `readIntent()` 读到 stale `phase:"done"` intent → `reached()` 判定所有阶段已完成 → **备份/staging/迁移/swap 全部跳过** → 直落 L1404 无守卫的 `verifyMigratedDatabase(dbPath)` → canonical 实际是 legacy(无 `mailbox_migration_meta` 表)→ 裸抛 `no such table: mailbox_migration_meta` → exit 1。

root 为什么能过:root 的旧 intent 在更早的窗后被归档了(`comm/intent-archive-r2-20260806/` 有 7 个 shard 的归档 intent),run4 时 root 无残留 intent,走的是全新迁移。comm/flywheel 的 Aug 6 intent 是唯一漏网的——**重跑必死在同一处,与库形状无关**。

## 4. 阳性对照与对照组(设计期实测,全部在临时副本上)

| 实验 | 输入 | 结果 |
|-----|------|------|
| 复现(阳性对照) | 合成 legacy 小库(仅 messages+lead_inbox)+ `phase:"done"` intent | ❌ 原样抛 `no such table: mailbox_migration_meta`,canonical 未被改动 |
| 负对照 A | 同款小库 + 额外表(`workflow_engine_park` 等),**无** intent | ✅ status=migrated |
| 负对照 B(根库幂等) | **生产 root 副本**(migrated)+ `phase:"done"` intent(路径改写到沙箱) | ✅ 通过,3 行 mailbox 数据无损,meta 无损 |
| 全量彩排 | r4 snapshot 的真实 comm/flywheel 副本(163MB),无 intent | ✅ 16.6s 完成,1236/53646 行,4 张额外表原样保留;source family 全部落在已知族,candidates_json/pending claim/dangling ack 三守卫全 0 |

## 5. 危害面:不止 run4 这一种死法

stale intent 的 phase 决定死法。run4 撞上 `done` 是**运气好的那种**(loud 失败):

| stale intent phase | resume 行为 | 后果 |
|---|---|---|
| `done` / `verified` / `dir_fsynced` / `canonical_swapped` | 全跳过 → L1404 最终 verify 对 legacy canonical 必炸 | **loud 失败**(run4 实况) |
| `staging_verified` | 直接 `renameSync(旧 staging, canonical)` | **静默数据丢失**:把 Aug 6 的旧 migrated 库盖到今天的 canonical 上,工具还报成功 |
| `backed_up` / `sidecars_quarantined` | `backupCommDb()` 见旧备份**已存在则直接复用**(L1165-1172)→ 用 Aug 6 旧数据做 staging → swap | **静默数据丢失**,同上 |
| `fenced` | 同上(复用已存在的旧备份) | **静默数据丢失** |

即:修复不能只补 run4 那条 loud 路径,必须让 **resume 前先对 canonical 现实做一致性核验**,否则下一次窗口炸的可能不是 exit 1,而是无声丢掉一天的数据。

## 6. 现场约束(Annie/issue 铁律)

- 根 `~/.flywheel/comm.db` 保持 migrated 态,老栈正用(加表不减表)。**不许回滚**。backup + intent(phase=done)原位保留。
- **绝不碰生产 `~/.flywheel` 下任何 db**,一切诊断/复现在临时副本上(本探索全部遵守:cp 到 /tmp 沙箱后才开库)。

## 7. 方向候选

| 方向 | 说明 | 取舍 |
|-----|------|-----|
| A. resume 前 intent-现实一致性核验(fail-loud)+ 结论性场景自愈 | intent 与 canonical 实际状态对账;证据链完整的 stale-done 场景自动归档 intent 走全新迁移;歧义场景一律 loud 拒绝 | **选定**。run5 免手工步骤,静默丢数据路径全部封死 |
| B. 只做 fail-loud,stale intent 一律人工归档后重跑 | 最保守 | run5 M-migrate 会再失败一次,把清理压力转给窗口内人工操作——r4 类失败正是这么养出来的;且窗口自动化(window 脚本)没有人机交互点 |
| C. 修 rollback 脚本让文件级恢复顺手清 intent | 治表 | 窗口脚本在 `~/.flywheel/r4`(生产资产,任务 #192 另管);工具自身仍对 stale intent 无防御,换个来源(手工 cp、Time Machine 恢复)照样炸 |

选 A,细节展开见 research.md;C 的窗口模板加固作为 run5 runbook 备注(belt-and-braces),不在本单代码范围。
