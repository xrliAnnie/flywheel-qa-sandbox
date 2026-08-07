# FLY-1649 r4 重迁前加固包 — 实施计划

Issue: FLY-1649 (https://linear.app/geoforge3d/issue/FLY-1649/1572-r4-preflight批1-重迁前加固包geoforge3d-完整性误判修复-growth-残表清理-回滚脚本撞锁重试)
日期: 2026-08-06
基于: 无(本文档含完整取证记录;Codex design review R1 8 项已折入)

---

## 0. 第一屏:取证对 issue 前提的两处修正(先读这里)

本设计基于对 r1/r2/r3 全部现场证据的离线取证(`/tmp/flywheel-bridge.log` 86 万行逐段钉位 + 7 分片保留库 SQL 级检查 + restart 日志逐秒对时)。**两个 issue 前提与 ground truth 不符,scope 相应重定向**;§3/§4 前提成立,照原样执行。

| Issue 前提 | Ground truth(证据见 §1 取证) | Scope 重定向 |
|---|---|---|
| §1「r2 死于新 Bridge 把已迁好的 geoforge3d 判成没迁(Legacy or partial Fatal)」 | **r2 窗口(Aug 6 15:20Z 之后)日志里 0 条该 Fatal**。该 Fatal 只出现在 r1(Aug 5)与 01:23 attempt,且两次**判定都是正确的**(当时库真没迁)。r2 真死因:①某分片(指纹指向 geoforge3d)**已迁好但被 0444 只读闸残留卡住**,`SqliteError: attempt to write a readonly database` **不带路径** → 被误诊为「判错」;②code-only auto-rollback 后**旧栈**(4857d999,还有 lead-inbox-queue.ts)开迁移库撞兼容 view:`views may not be indexed` | 判定函数**不改判定逻辑**(它没错过);改修:错误带路径+权限诊断、迁移收尾 verify-open、权限恢复缺口、boot 错误带 project 上下文(§2 F1-F4) |
| §2「growth 现在 legacy 与新 mailbox 表并存,classify 会静默跳过」 | live growth **当前是纯 legacy**(只有 messages+lead_inbox,无 mailbox 族表)——08-06 09:26-09:27 的 pre-r2 restore 操作已消解混合态。且 classify 静默跳过已由 FLY-1646(#784)修成 fail-loud(`mixed` → throw) | **不造新清理工具**(review R1-6:按前缀 drop 有共享表误伤面;当前又无残骸=为假想造重械)。改为:窗口前重验(G1);若 mixed 复现 → 既有 fail-loud 闸拦下 + **应急恢复程序**(从已验证 pre-fly1572 备份恢复该分片,见 G2);离线演练验收照跑(A6) |

§3(rollback 撞锁 `exit 0` 且被 `\|\| true` 吞掉,Bridge 裸奔 32 分钟)与 §4(updater 若被重新 load 会自动 pull 新栈复死)前提**全部证实**,按原 scope 修——但 review 抓出两处执行矛盾已修:rollback 的锁处理**不能依赖会被 checkout reset 掉的新代码**(R2 重设计);updater **装机 plist 与仓库 plist 已漂移**(U1 记录双份证据 + 收敛步骤)。

**保质期声明**:本文档的「现场状态」结论(growth 纯 legacy、updater unloaded、queue 空)是 2026-08-06 13:3x MDT 的快照,**会随运维操作作废**——所以每一项都写成「r4 窗口前重验」的可执行检查,而不是假设。取证结论(r1/r2/r3 死因链、代码行为)不会作废。

---

## 1. 取证记录(证据指针,实施与 review 可复核)

### 1.1 时间线(MDT)

| 时刻 | 事件 | 证据 |
|---|---|---|
| 08-05 ~17:10-17:22 | 新代码先部署、迁移未跑 → Bridge bootloop,9 条 `Fatal: Legacy or partial CommDB at .../geoforge3d/comm.db`(**判定正确**:库真没迁) | bridge.log:481172-482019;wrapper 戳 17:10:21-17:22:30;邻近 EventFilter `2026-08-05T23:08Z` |
| 08-05 17:48 | r1 迁移跑(pre-fly1572 backup 三件套生成) | `~/.flywheel/comm/*/comm.db.pre-fly1572-2026-08-05T23-48-*` |
| 08-06 01:23 | 重迁 attempt,又一条 Legacy Fatal(判定正确) | bridge.log:809941;邻近 EventFilter `2026-08-06T07:24Z`;restart log 012335 |
| 08-06 09:26-09:27 | pre-r2 手工整备:r1 intent 归档、malformed 库隔离、pre-remigration 副本、restore | `*.archived-r1-20260806T152614Z`、`comm.db.malformed-20260806T152614Z`、`.fly1572-restore-*` 目录 |
| 08-06 09:28:14-09:28:2x | r2 迁移跑,7 分片全部迁移成功(保留库可证) | 7 个 `comm.db.migrated-r2-failed-20260806`;geoforge3d meta=`mailbox_v1/2026-08-06T15:28:14.852Z` |
| 08-06 09:28:52 | 新栈 Bridge boot → **Fatal #1** `attempt to write a readonly database`(无路径)。调用栈:`assertMailboxGeneration` **已通过**(即该分片内容已迁好),死在下一步 `db.exec(SCHEMA)` 写入 → 权限问题,非误判 | bridge.log:829218 + 栈帧 `new CommDB (db.ts:699)`;restart log 092829 |
| 08-06 09:44:56 | health check 判死 → **code-only** auto-rollback → 09:45:10 旧栈 boot | restart log 092829:103-170 |
| 08-06 09:45-09:46 | 旧栈开迁移库 → **Fatal #2** `views may not be indexed`。栈帧 `new LeadInboxQueue (lead-inbox-queue.ts:550)` —— 该文件已被 #780 删除,**证明这是旧栈**;旧 SCHEMA `CREATE INDEX ... ON messages/lead_inbox` 撞迁移库兼容 view | bridge.log:829281;09:46 操作员把迁移库移侧(`*.migrated-r2-failed`)恢复旧库后转健康 |
| 08-06 11:55-11:58 | r3:迁移+preflight 全绿、Bridge 健康 3 分钟,死于 stormwatch 阶段热循环(**FLY-1648 的器官,非本单**) | `~/.flywheel/r3/progress.log`、r3.FAILED |
| 08-06 11:58:51-59 | r3 auto-rollback 代码+DB 恢复全对;最后 detached restart 在 **11:58:59 撞锁 `exit 0`**——锁持有者(11:55:50 的 r3 步骤7 restart)**同一秒**打出 Done. 释放锁;`\|\| true` 把失败吞掉 → Bridge 裸奔至 12:31。注意:r3 rollback 是在步骤7 restart **仍持锁运行期间**就开始杀 Bridge/回代码/回 DB 的——mutation race 本身也是缺陷(R2 一并封堵) | restart log 115859(全文 81 字节:`Another restart in progress (189s old), exiting.`);115550 尾部 `11:58:59 Done.`;123114=12:31 人工恢复 |

### 1.2 关键物证

- **r2 保留库健康**:`comm.db.migrated-r2-failed-20260806`(geoforge3d,392MB):`mailbox_migration_meta=mailbox_v1`、0 张 legacy 表、含 `messages`/`lead_inbox` 兼容 **view**、`PRAGMA quick_check=ok`;SQLite header write/read version byte 18/19 均为 `2`,即保留库是 **WAL**,不是 delete-journal。
- **黄金实验**:用当前分支代码(`flywheel-comm` 现 build)`new CommDB()` 打开该保留库副本 → **OPEN OK**。判定函数对好库不误判,当场排除「看错好库」假设。
- **0444 指纹**:全 comm 树今天唯一 0444 文件 = geoforge3d 的 `comm.db-shm.migrated-r2-failed-20260806`。与 09:26-09:27 手工整备用「chmod 只读闸」的操作模式吻合(memory 教训:WAL 的 -shm 不能上只读闸)。机制:migrated 保留库本身就是 WAL;CLI classify 的只读 SQLite open 仍会 materialize canonical `-shm`,且它可继承 0444 主库 mode。`ensureCanonicalDbWritable` 只修主库,F3 随后必须对新建 sidecar fail-loud;当前实现每轮点名第一个 offender 的路径/mode/chmod remediation,操作员逐条照做并重跑,直到 canonical 三件全 owner-writable 才允许通过。该保留物证在 r4 成功前**不许挪动**(§2 U2.8)——因此一切权限扫描**只扫 canonical 三件套精确路径**,绝不 `comm.db*` 通配(review R1-2)。
- **live growth 现状**:`sqlite3 mode=ro` 查 sqlite_master:只有 `messages`+`lead_inbox`,无 mailbox 族 → 纯 legacy。
- **updater 现状(双份证据,已漂移)**:装机 `~/Library/LaunchAgents/com.flywheel.updater.plist` = **仅 StartCalendarInterval 6:00,无 QueueDirectories**;仓库 `scripts/com.flywheel.updater.plist` = **QueueDirectories(self-ship-pending.d)+ 00:00/12:00**。当前 `launchctl list` 无该 job(r3 步骤1 unload 后未恢复);`~/.flywheel/self-ship-pending.d/` 空;`deployed-sha=4857d999`。风险:若按装机版盲目 reload = 保留漂移(self-ship 队列触发器缺失);若换仓库版 reload 且队列非空 = 立即触发部署。恢复策略见 U1。

### 1.3 涉案代码位点(当前分支;review R1 已逐一核实)

- `packages/flywheel-comm/src/db.ts:628-662` `assertMailboxGeneration`(判定函数,不改判定逻辑);`:688-711` 构造(mkdir→database-open→pragma→virgin-probe→generation-assert→schema→migrations→purge)——SqliteError 全链**不带路径**;`openReadonly` 的 `busy_timeout` pragma 在 close-on-error try 之外。
- `packages/flywheel-comm/src/mailbox-migration.ts:1276-1405` `migrateCommDbWithSwap`:fence chmod 0444(:1314-1316);swap 后 chmod 0600(:1388-1389);**already_migrated 早退路径(:1283-1297)不查不修权限**;faultAfter 注入 seam 现成(TDD 用)。
- `packages/teamlead/src/bridge/lead-inbox-runtime.ts:~100-105`:每 project `new CommDB(dbPath)` + `new MailboxQueue(dbPath)`,异常裸抛 → run-bridge Fatal 不带 project。
- `scripts/migrate-fly1572-mailbox.ts`:classify(mixed fail-loud 已在,FLY-1646);cutover 循环 `:142-143` 对 `migrated` 分片 `continue` **跳过**(→ F4 的 already_migrated 修复经它不可达,CLI 需补位);无收尾 verify-open。既有测试:`scripts/__tests__/migrate-fly1572-mailbox.test.sh`。
- `scripts/restart-services.sh:678-705` `acquire_lock`:争锁 → `exit 0`(:687-689),无等待重试;stale 判定 >7200s,stale-break 后 re-acquire 失败也 `exit 0`。**旧栈(4857d999)同样有 `FLYWHEEL_RESTART_FOREGROUND`(:611)**——rollback 可用它拿到可观测退出码,不依赖任何新 env。restart harness = `scripts/test-restart-services.sh`(**顶层**,非 `__tests__/`)。
- `~/.flywheel/r3/rollback-r3.sh`(ops 工件):最后一步 `restart-services.sh ... \|\| true` + detached → 结果不可观测;且 mutation 全程无锁保护。

---

## 2. 修理设计

### §1 组:boot/迁移「完整性误诊」类根治(全离线可验)

**F1 — CommDB open 错误带路径+权限诊断**(`packages/flywheel-comm/src/db.ts`)
兼容合同(review R1-5,单一明确):**原地增强原 error 对象**——catch 后把 `error.message` 改写为 `CommDB open failed at <dbPath> (phase: <phase>): <原 message 全文>[<权限诊断>]` 并 **rethrow 同一对象**;prototype/`name`/`.code`(如 `SQLITE_READONLY`)/`cause` 全保留,原 message 作为子串保留 → `isMissingTableError` 等按子串匹配的消费方不破。phase 覆盖构造全链:`mkdir` / `database-open` / `pragma` / `virgin-probe` / `generation-assert` / `schema` / `migrations` / `purge`;`openReadonly` 同样包住(并把 `busy_timeout` pragma 挪进 close-on-error try)。generation 断言的三条自家错误(Legacy/Unsupported/Partial,本就带路径)改用 **typed error class**(如 `MailboxGenerationError`)标识,wrap 层遇它原样透传、逐字不变;断言函数内部抛出的**其他**异常(如 malformed SQL)照常获得上下文。权限诊断:仅当原错误 `.code`/message 含 readonly/EACCES 时,best-effort(自身 try/catch,失败绝不遮蔽原错误)`stat` 主库/-wal/-shm 三件 mode(八进制)附进 message + remediation(`chmod 0600 <file>`)。任何 phase 失败时已开的连接在 finally close。

**F2 — LeadInboxRuntime boot open 带 project 上下文**(`packages/teamlead/src/bridge/lead-inbox-runtime.ts`)
`new CommDB(dbPath)` 与 `new MailboxQueue(dbPath)` 包 try/catch,rethrow(同一对象,message 前缀)`LeadInboxRuntime init failed for project=<name> db=<path>:`。r2 若有这两条,误诊不会发生。

**F3 — 迁移 CLI 收尾 verify-open**(`scripts/migrate-fly1572-mailbox.ts`)
cutover 循环完成后,对**每个**分片(含 classify=`migrated` 被跳过的)执行:(a) `stat` **canonical 三件套精确路径**(`comm.db`/`comm.db-wal`/`comm.db-shm`,存在即查;绝不通配),任何非 owner-writable → fail-loud 报文件+mode+remediation,退非零;(b) 真实 open+close 一次:**`new CommDB(path, false, false)`**(`createIfMissing=false` 防分片失踪被静默重建;`archiveOnOpen=false` 防验证步骤触发 purge 副作用),`close()` 在 finally;open 会触发 WAL 转换与 shm 建立,正是 r2 死点;(c) close 后**再扫一遍** canonical 三件 mode(open 过程新建的 sidecar 也要合规)。任何 throw = 退非零带路径。r2 的 0444 -shm 在迁移窗口内就会被抓住,而不是留给 Bridge boot。

**F4 — 迁移权限恢复缺口补全 + CLI 可达性**(`packages/flywheel-comm/src/mailbox-migration.ts` + CLI)
抽共享 helper `ensureCanonicalDbWritable(dbPath)`(幂等:主库非 owner-writable → chmod 0600,返回是否修复):(a) `migrateCommDbWithSwap` 的 `already_migrated` 早退路径 early-return 前调用;(b) done 收尾幂等断言(防未来路径漂移);(c) `rollbackMailboxMigration` 恢复完成后调用;(d) **CLI cutover 循环对 classify=`migrated` 的分片显式调用**(修复 review R1-4 的不可达:`:142-143` 的 `continue` 使 (a) 永不触发)——顺序:helper → F3 verify-open。sidecar(-wal/-shm)不自动 chmod:classify/verify-open 可新建它们,但脚本不猜测并静默改权限;F3 精确 fail-loud 交操作员按打印出的 remediation 修复后重跑。行为锁进 `scripts/__tests__/migrate-fly1572-mailbox.test.sh`。

**明确不做**:`assertMailboxGeneration` 判定逻辑不动(取证证明它从未冤枉过任何库);旧栈 `views may not be indexed` 不做代码修(旧栈已 ship 不可改),由「code+DB 成对回滚」结构性封堵(r3 已做,r4 runbook 沿用,§4 写死为硬前置)。

### §2 组:growth 混合态「重验 + fail-loud + 应急恢复程序」(不造新工具)

**G1 — 窗口前重验(runbook 硬前置)**:quiesce 后跑 `npx tsx scripts/migrate-fly1572-mailbox.ts --inventory`,7 分片 state 逐个记录进 r4 进度档。预期 growth=`legacy`。任何 `mixed`/`unknown` → 停,走 G2;**cutover 对 mixed 的 fail-loud 闸(FLY-1646)保持原样,是最后防线**。
**G2 — 应急恢复程序(runbook 文档,非代码)**:若某分片 mixed 复现:①不 cutover 该分片,窗口内不即兴手术;②恢复路径优先级:有 swap-intent → 既有 `--rollback`(`rollbackMailboxMigration`,已验证,自带 DB+refs 双恢复);无 intent → 按 **pre-fly1572 备份的真实形态**恢复(review R2-2):该备份是 `backupCommDb` 产物 = **standalone 一致性 backup DB + `<backup>.refs` 树 + `<backup>.refs-manifest.json`,没有 wal/shm 可拷**。流程:对备份 DB 跑 `PRAGMA quick_check` + classify=`legacy` + refs 按 manifest 校验 → 现场 canonical 三件整套 mv 到时间戳保留名(live wal/shm 是隔离出去,**不是**从备份拷回)→ cp 备份 DB 进场 + refs 树按 manifest 恢复 → classify 复验必须=`legacy`;refs 备份缺失/校验不过 → 直接走③;③该分片退出本次 r4(不迁),报 Annie 决策。**为什么不造 drop 工具**(review R1-6):新 schema 的 `receipt_*`/`loop_*` 族在 legacy 库同样存在且是活数据,按前缀 drop 有误伤面;当前 ground truth 无残骸,为假想场景造带风险的重械违反简单性铁律。
**G3 — 验收(离线演练,A6)**:growth **副本**跑 --inventory → `legacy`(现状路径);再人工构造 mixed 副本(ATTACH 拷入 r2 保留库的 mailbox 族对象)→ 验证 ①cutover 对它 fail-loud(既有闸,回归确认)②按 G2 备份恢复流程走一遍 → classify=`legacy`,且 legacy 两表 **schema + 内容摘要**前后一致。摘要口径(review R2-4,唯一确定实现):小型 Node fixture —— 逐表按声明列全读,值做类型标记的 canonical 编码(NULL/TEXT/BLOB/数值显式区分),按稳定主键排序(无主键回退 rowid),流式 SHA-256;schema 单独对 `sqlite_master` 的 `type/name/sql` 排序后哈希。**负对照**:改动任一行一个值 → 摘要必须变(证明尺子有效)。

### §3 组:rollback 链路 restart 撞锁有界重试

**R1 — `restart-services.sh` acquire_lock 加 opt-in 有界等待**(服务未来所有 rollback-forward/自动化调用方;**r4 rollback 不依赖它**,见 R2):
- 新 env `FLYWHEEL_RESTART_LOCK_WAIT_SECS`:**边界校验**——非负整数、上限 7200;非法值 → fail-loud exit 1(绝不静默当 0)。默认/未设 = 0 = 现状字节兼容(争锁立即 `exit 0`,输出逐字不变,golden test 锁死)。
- >0 时:按 deadline(`start+N`)循环,每次 `mkdir` 失败 sleep min(5, 剩余时间)(短超时不被 5s 步长冲过);期间日志心跳;**stale-break(>2h)后 re-acquire 失败同样回到等待循环**,不再 `exit 0`(review R1-7);拿到锁 → 正常继续;超时 → **exit 1** + `alert_severe`(signature `restart-lock-wait-timeout`)。
- 测试进 **`scripts/test-restart-services.sh`**(顶层 CI-wired harness):默认路径 golden(输出/退出码/无副作用逐字现状)、opt-in 等到锁、超时+alert、非法值 fail-loud、stale-break 再争锁不退 0。

**R1b — `restart-services.sh` 内置 code-only rollback 的 opt-out**(review R3-1 的代码侧配套):现状 `restart-services.sh`(新旧两代同)在 Bridge health/build 失败时走内部 `rollback_and_restart` = `git reset --hard` **不回 DB** —— 迁移库在场时这正是 r2 死因②的复刻路径。新 env `FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK`,**布尔合同**(review R4-5,与 R1 的数值合同分开):恰好 unset 或 `0` = 现状字节兼容;恰好 `1` = 关闭;**其余任何值**(含空串、空白、`2`)→ 在任何服务/代码 mutation 之前 exit 1 fail-loud。设 1 时,内部 rollback 分支(**build 失败与 health 失败两个调用位点都覆盖**)改为 fail-loud 停下(打印明确 FAILED + `alert_severe`,exit 非零,git/dist 一步不动),把恢复决策交给持有整套快照的 rollback-r4.sh/操作员。r4 窗口内**每一次** `restart-services.sh` 调用都必须带它(U2 写死)。测试进同一 harness:默认 golden;非法值 exit 1;设 1 分别注入 build 失败与 health 失败 → 两位点都无 `git reset`、退出非零、alert 留痕。

**R2 — `scripts/r4/rollback-r4.sh`(repo canonical,窗口前拷到 `~/.flywheel/r4/` 成为不可变工件)**:review R1-1 重设计——锁屏障**先于一切 mutation**,且全程**不依赖会被 checkout reset 掉的新代码**:
1. **锁排干屏障(mutation 前)**:自行 bounded 等待获取 `~/.flywheel/restart.lock.d`(每 5s `mkdir`,上限 10 分钟)。拿不到 → **exit 1 fail-loud,零 mutation**(此时上一个 restart 还活着,rollback 在它脚下拆台正是 r3 的 mutation race)。**锁清理必须 ownership-aware**(review R2-1):只有 `mkdir` 成功后才置 `LOCK_OWNED=1` 并 arm `trap`(trap 内只在 `LOCK_OWNED=1` 时 rmdir;INT/TERM handler 清理后**如实 exit 130/143**,不吞信号)。**释放 = 临界区,信号「延迟」而非「丢弃」**(review R3-3 + R4-3:`trap ''` 是丢弃,注入的 TERM 会消失、父进程 exit 0,违反测试判据):释放期间换装临时 INT/TERM handler **只记录 `PENDING_SIG` 不碰锁** → `rmdir` **必须成功**(失败 → fail-loud、不起子进程)→ `LOCK_OWNED=0` 解除武装 → 恢复正常 handler → 若 `PENDING_SIG` 非空 → **如实 exit 130/143**。此后父进程任何退出路径都不再碰 `restart.lock.d`——继任者的锁绝不会被父进程的残 trap 误删,包括「rmdir 与 disarm 之间收到信号」的窄缝(INT 与 TERM 都要测)。
2. **launch-authority + 持有者双重 fence**(review R2-3 + R3-2):杀 Bridge(:9876)后、任何 git/dist/DB mutation 前,断言两层:(a) **launch authority 已排空**——`launchctl print` 逐一确认 `com.flywheel.bridge`、全部 `com.flywheel.lead.*`、`com.flywheel.updater` **不在 loaded 集**(KeepAlive=true 的 loaded job 会在 lsof 快照后复活重开 DB,点时刻观察不构成 fence);(b) **零持有者**——`lsof` 扫 7 分片 canonical `comm.db` 精确路径。任一不过 → **fail-loud exit 1,git/dist/DB 一律不动**;绝不「warning 后继续」。**DB/refs 换入前再各查一次**。断言全过才开始 mutation:`git checkout -f -B main $KNOWN_GOOD` → dist tar 解包 → **DB 状态按快照合同 staged 恢复**(见下)。
3. **deploy 账本配对回置**(review R4-2):调用旧 restart 之前,把 `~/.flywheel/deployed-sha` **原子写回 `$KNOWN_GOOD` 并读回校验**(旧值保留进 quarantine/证据)。理由:Phase C 若已推进过账本(restart-services `:1830-1835` 写入目标 SHA),旧栈 restart 的内部失败路径会 `git reset --hard "$(cat deployed-sha)"` —— 把代码 reset **回新 SHA** 而 DB 已回 legacy = 再造代际错配;R1b 帮不上(checkout reset 已把它的实现删了),必须靠账本先归位。
4. 释放锁(步骤 1 临界区纪律)→ 立即以 **`FLYWHEEL_RESTART_FOREGROUND=1`** 调 `restart-services.sh`(旧代码同样支持,:611 已核),**不加 `\|\| true`**,退出码如实传播。窗口环境已由 runbook 把发起方全部 fence;即便有竞争者,restart 自身的锁串行化兜底(父进程已解除武装,不会破坏它)。
5. restart 返回后本脚本自行 **/health 有界轮询**(每 10s,上限 5 分钟):healthy → 打印成功;否则 **fail-loud**(醒目 FAILED + 尽力 `lead-alert.sh` severe + exit 1),绝不静默「done」。
- **快照合同(review R2-2 + R3-5,单一 manifest 覆盖全体成员)**:r4 窗口快照 = 每分片 quiesce 下的 `comm.db`(+ 存在的 `-wal`/`-shm`)原样拷贝 + 同分片 `refs/` 内容树拷贝;**一份 manifest 覆盖每个在场成员**(相对路径、字节数、mode、SHA-256);快照时对拷贝出的 SQLite 集跑 `PRAGMA quick_check` 后 manifest 落盘。理由:`CommDB` 常规 open 的 `purgeExpired()` GC 会 unlink content-ref 文件(db.ts:709 → mailbox-queue GC),只回 DB 不回 refs 会留下指向已删文件的行。**恢复 = staged 换入**:拷进同文件系统 staging → 按 manifest 全量校验 staged 集 → canonical DB/sidecars/refs 隔离(quarantine)→ rename staged 进场 → fsync 父目录 → 复跑 hash + integrity + classify 复验 → 全部 7 分片通过后才清 quarantine、才释放锁。任何一步失败 = canonical 原样(或可从 quarantine 复位),fail-loud。
- KNOWN_GOOD sha、dist tar 路径、快照目录 = 生成时写死进工件并在窗口前人工核对(r4 版指向 r4 快照)。**rollback 适用区间(review R3-4)**:自「已验证快照之后的第一笔持久 mutation」(第一个分片 reset 或迁移 fence)起,至「Lead 激活开始之前」止,窗口脚本显式标记该边界;Lead 激活开始后的失败**不再走本 rollback**(处置见 U2 前进生命周期:先重新全面 quiesce 才允许整态回滚,否则修复/升级在新代上进行)。零持有者断言在任何阶段都保持生效,作为运行时防线。

**R3 — rollback 测试**:独立 focused harness `scripts/__tests__/rollback-r4.test.sh`(黑盒,mock repo/lock/health/lsof/launchctl;沿用 `__tests__` 既有模式):(a) 锁被占 → **零 mutation** 且等待;超时 → exit 1 零 mutation;(b) 锁 3s 后释放 → 屏障通过,mutation 执行;(c) foreground restart 非零 → 传播非零;(d) health 永不 200 → fail-loud exit 1;(e) 持锁期间被 INT → 自己的锁被 trap 清理且 exit 130;(f) **handoff 场景(review R2-1)**:父释放锁后 mock 继任者持锁,父被 INT/正常退出 → 继任者的锁**原样存活**;(g) 释放 `rmdir` 失败 → fail-loud 且不起 restart;(h) **mock 非 Bridge 持有者存活**(review R2-3)→ git/dist/DB mutation 一步未发生;(i) refs 快照/恢复:构造至少一个 content-ref 文件在快照后被删改 → 恢复后 DB 摘要与 refs manifest 双双复原(review R2-2);**负对照**:损坏一个 DB 快照成员 → staged 校验拦下,canonical 零替换(review R3-5);(j) **释放临界区 seam(INT 与 TERM 各一)**(review R3-3/R4-3):在 `rmdir` 后、disarm 前注入停顿,竞争者获锁,注入信号 → 竞争者锁存活、父**如实 exit 130/143**(信号被延迟递送,不是丢弃);(k) **KeepAlive 复活模拟**(review R3-2):mock launch authority 显示 bridge job loaded / 或第一次持有者扫描后 mock 进程重开 canonical DB → 拒绝,零 DB 替换;(l) **post-commit 账本场景**(review R4-2):种子 `deployed-sha=<新 SHA>` → 重 quiesce 后整态回滚 → 强制旧栈 restart 的 build 失败与 health 失败两条路径 → **HEAD 全程不回到新 SHA** 且 legacy DB 保持 canonical(常规 pre-commit 回滚 case 并存)。

### §4 组:updater 检查 + r4 runbook 收紧

**U1 — updater 双份证据 + 收敛决策(窗口前执行并留痕)**:
- 证据已录(§1.2):装机 plist(6:00,无 QueueDirectories)与仓库 plist(QueueDirectories + 00:00/12:00)**漂移**。
- 决策:**canonical = 仓库版**(self-ship 队列触发器是 FLY-270 设计的一部分,装机版是漂移残留)。r4 成功验证后的恢复步骤(**staged 原子安装**,review R2-5,绝不先毁装机件再 lint):`plutil -lint` 仓库源 → cp 到装机目录内的临时文件 → 校验 mode/ownership → 对 staged 文件再 `plutil -lint` → **原子 `mv` 换入** → **再查一次队列目录必须为空**(review R1-3:reload 前最后一刻查,不是只在窗口开头查)→ `launchctl bootstrap` → `launchctl print` 核实生效配置含 QueueDirectories + 双 calendar。
- 硬前置(窗口全程):`launchctl list | grep com.flywheel.updater` 必须为空;`ls ~/.flywheel/self-ship-pending.d/` 必须为空;**r4 验证通过前禁止 load**。

**U2 — r4 runbook**(`engineering/doc/FLY-1649-r4-preflight-hardening/r4-runbook.md` canonical,窗口前拷到 `~/.flywheel/r4/runbook.md`):继任 r3 版。

**U2-A 前进生命周期(review R3-1/R3-2/R3-4 的根治;每个转换写明确切命令,禁止即兴)**:
- **既有事实**:`restart-services.sh`(新旧两代)的合同 = **每次合法调用都全舰队重启(Bridge+全部 Lead)**,且 health/build 失败会走内部 **code-only rollback**(`git reset --hard` 不回 DB)= r2 死因②本因。所以**迁移库在场的前进路径全程不调用全舰队 `restart-services.sh`**,直到最终激活步(且激活步必须带 R1b 关掉 code-only rollback)。
- **Phase Q(quiesce,含 launch-authority fence)**:**硬前置(review R5-2)**:逐一核对每个生产 manifest Lead 的 launchd 原始态,**任何「有生产 manifest 但 unloaded」的 Lead 存在 → 窗口在快照前 fail-loud 停下**,由 Annie 决定该 Lead 去留(移走 manifest 或 load 起来)后才重开窗口。理由:`restart_lead` 把 on-disk plist 当 lifecycle ownership、对 unloaded job 也会 bootstrap(lead-restart-lifecycle.sh:741-773 + restart-services.sh:1238-1327),「原本 unloaded 的 Lead 保持 unloaded」在全舰队 restart 语义下是**不可兑现的承诺**,与其造激活选择机制不如把前提查干净。前置过了才:`launchctl bootout` updater、全部 `com.flywheel.lead.*`、`com.flywheel.bridge`(逐一 `launchctl print` 确认出 loaded 集,**记录原始 loaded/unloaded 状态供恢复**)→ 杀 Bridge 进程与残 Lead → lsof 7 分片零持有者。launch authority 排空是 fence 的一部分,不是观察(KeepAlive job 会在点时刻检查后复活)。
- **Phase S(快照)**:authority+持有者**再各查一次** → 按 R2 快照合同做 7 分片快照+manifest。**rollback 适用区间从此后的第一笔持久 mutation 开始**。
- **Phase M(mutation)**:6 分片 reset(若 Annie 授权维持)→ flywheel 分片迁移 + F3 verify-open。本 phase 任何失败(含 reset 半途、迁移 fault 任意 seam)→ rollback-r4.sh 整态回滚。
- **Phase B(Bridge-only 试运行)**:用**预审的 Bridge-only 启动命令**(与 restart-services 内部 bridge 启动同款;review R4-1 修正:run-bridge.ts 是 0644,必须经解释器;review R5-1 修正:`cd` 必须是独立前台步——`cd X && nohup … &` 会把整个 AND-list 后台化,`$!` 抓到的是 wrapper 而非 Bridge 进程):
  ```sh
  cd "$REPO" || exit 1
  nohup npx tsx scripts/run-bridge.ts >> /tmp/flywheel-bridge.log 2>&1 < /dev/null &
  BRIDGE_TRIAL_PID=$!   # 记录进窗口台账(仅作线索,不作清理依据)
  ```
  **不**经 restart-services,**不** bootstrap bridge plist——launchd authority 保持排空,Lead 全程不在 → /health + stormwatch ≥5 分钟,期间持续断言无 Lead job/进程/DB 持有者。**收割合同(review R5-1)**:单个 PID 不构成清理证据(npx→tsx→node 是进程树);失败清理必须复用 restart-services `stop_bridge` 的**端口监听者定位 + 祖先树遍历**原语(:936-1042 同款/抽取),TERM → 等 → KILL 后对**每个后代** `kill -0` 验尸 + `:9876` 解绑确认,全部通过才允许进 rollback-r4.sh;「listener 还没起来就失败」的早夭分支同样要有清理与判定。
- **Phase C(commit 边界 + 激活)**:stormwatch 绿 = commit。之后才允许 Lead 激活:按 U2-B authority 矩阵恢复 Lead launch authority,然后**前台**收编(review R4-1:不带 FOREGROUND 会在锁与 mutation 之前自分离、打印 detached PID 即 exit 0,窗口会在真实结果未知时误入 Phase R):
  ```sh
  FLYWHEEL_RESTART_FOREGROUND=1 \
  FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1 \
    bash "$REPO/scripts/restart-services.sh" --reason fly1572-r4-activate
  ```
  不加 `\|\| true`,退出码如实捕获;restart-services 的 stop-bridge 步骤会收掉 trial nohup 体(端口接管顺序见 U2-B)。**前台调用退出码 + Bridge/Lead 终局证据全部通过之前,禁止进入 Phase R**。**Phase C 起失败不再走 rollback-r4.sh**:R1b 保证不会发生 code-only rollback;处置 = 在新代上修复/升级 Annie 决策;若确需整态回滚,必须先重新走 Phase Q 全量 quiesce(rollback-r4.sh 的 deployed-sha 归位步骤保证旧栈 restart 不会被账本拽回新 SHA)。
- **Phase R(恢复外围)**:stormwatch 后续观察 → updater 按 U1 staged 流程恢复 → 按 U2-B 矩阵做 authority 终态对账,断言 **:9876 恰好一个健康持有者**。
- **U2-B authority 终态矩阵**(review R4-6;每行写死 bootout/bootstrap/kill 顺序与验证):

  | Authority | 窗口前原始态 | r4 成功终态 | rollback 终态 |
  |---|---|---|---|
  | `com.flywheel.bridge` | 现状 = 文件在、job **unloaded**(nohup 形态) | 维持原始形态:**不** bootstrap;Phase C 由 restart-services 以 nohup 形态接管(先 stop 旧/trial 体、端口释放、再起新体)。若窗口前实测原始态为 loaded,则 Phase C 前先杀 trial 体→端口空→bootstrap→由 launchd 管理 | 同「维持原始形态」,由 rollback-r4 的前台旧栈 restart 起 nohup 体 |
  | `com.flywheel.lead.*`(生产 manifest 集;Phase Q 前置已保证全部原始 loaded) | loaded | Phase C bootstrap 回原集合 + restart-services 收编 | 保持 booted-out,由 rollback 后的前台旧栈 restart 拉起(其自身 Lead 管理逻辑) |
  | 「有生产 manifest 但 unloaded」的 Lead | **不允许进窗口**(Phase Q 硬前置 fail-loud,Annie 先裁决去留) | — | — |
  | `com.flywheel.updater` | unloaded(r3 后遗留) | U1 staged 收敛到仓库版后 bootstrap | **保持 unloaded**(= 原始态;恢复与否是 r4 复盘后的人类决策) |
- **离线 runbook harness**(`scripts/__tests__/r4-window.test.sh`,mock launchctl/lsof/health;**必须穿过真实的顶层自分离 seam**——case 观察到 `[restart] detached` 后紧跟 Phase R 即判 FAIL):模拟 ①Bridge-only 启动失败(含 listener 未起的早夭分支)②stormwatch 失败 ③Lead 激活失败(前台非零)④reset 半途失败 ⑤迁移 fault seam 失败 ⑥Bridge 原始态 loaded/unloaded 两分支 ⑦**trial 进程树收割**(review R5-1:构造 wrapper→tsx→node 三层树,断言每个后代死透 + :9876 解绑后才进 rollback)⑧**unloaded 生产 Lead fixture**(review R5-2:有效生产 manifest + launchd unloaded → Phase Q fail-loud,零快照零 mutation),断言:任何路径都不会执行 git-only rollback、不会在 commit 边界前起 Lead、Phase M/B 失败都进整态回滚、Phase R 后 :9876 恰好一个健康持有者。

硬前置清单在 r3 基础上新增:
1. FLY-1648 热循环检查绿(sibling 单产物);
2. 本单 §1-§3 修理项已 merge 且 `pnpm build` 后的 dist 为窗口所用版本;
3. **权限扫描(canonical 三件套精确路径,7 分片 × {comm.db, comm.db-wal, comm.db-shm},存在即查)**:任何非 owner-writable → 先修再开窗。**绝不 `comm.db*` 通配**——保留物证(如 geoforge3d 0444 -shm 指纹)必须原样保全到 r4 成功后(review R1-2 的矛盾即由此解);运维纪律写明:整备操作禁止对 -wal/-shm 上 chmod 只读闸;
4. inventory 重验(G1)+ 7 分片 state 记录;任何 mixed → G2 应急程序;
5. updater 双查 + 恢复流程(U1);
6. **code+DB 成对**:任何 rollback 必须代码+DB 同回(r2 死因②的闸),rollback-r4.sh 就位 + KNOWN_GOOD/tar/快照路径核对;
7. 窗口执行严格按 **U2-A 前进生命周期**(Phase Q→S→M→B→C→R;快照合同、Bridge-only 启动、R1b env、rollback 区间边界全部以 U2-A 为准);preflight(CommDB 同款 open ×7)保留在 Phase M 与 Phase B 之间;
8. 残留清账:r2/r3 保留工件(`*.migrated-r2-failed*`、`retired-r3-*`、`.fly1572-*` staging 目录)在 r4 成功验证**之后**才允许归档,窗口前只盘点不动。

---

## 3. 验收矩阵(全部离线,不上真机试错)

| # | 验收 | 方法 | 判据 |
|---|---|---|---|
| A1 | r2 死因①离线复现(修前) | **两进程 fixture**(review R1-8):子进程对迁移库副本 open(建出 wal/shm)→ chmod -shm 0444 → **abrupt exit(不 close,防 SQLite 清走 sidecar)**;主进程断言 0444 shm 存在后再 CommDB open;权限位不可强制的环境显式 skip/fail | 修前:裸 `SqliteError ... readonly`,**无路径**,`.code=SQLITE_READONLY` |
| A2 | F1/F2 修后诊断 | 同 A1 修后 | 同一 error 对象:`.code` 保留、原 message 子串保留、新增 dbPath+phase+三件 mode+remediation;经 LeadInboxRuntime 再含 project 前缀 |
| A3 | 好库不误判(回归) | r2 保留库副本(0600)当前 CommDB open;generation 三错误逐字不变断言 | OPEN OK;Legacy/Unsupported/Partial 文案 byte-identical |
| A4 | F3 抓 0444(canonical-only 哨兵) | A1 布置 + CLI cutover/verify-open;**同目录放一个带后缀的 0444 保留物证仿真文件** | CLI 退非零、报出 canonical 文件+mode;**后缀物证文件被忽略**(哨兵) |
| A5 | F4 migrated 分片可达 | 保持 WAL 的保留库副本 chmod 主库 0444、移除 canonical sidecar 后 classify=`migrated` → **CLI 全流程**;每轮只按 CLI 打印的那一条精确 remediation 修复并重跑,直到通过 | 真库控制序列:首跑 helper 把主库恢复 0600,随后 F3 对新建且继承 0444 的 `-wal` fail-loud;修 `-wal`后二跑对 `-shm` fail-loud;再修 `-shm`后三跑 verify-open 通过。每次均含准确路径/mode/chmod 命令;`scripts/__tests__/migrate-fly1572-mailbox.test.sh` 锁行为 |
| A6 | growth 演练 | §2 G3 双场景(现状 legacy no-op;构造 mixed → fail-loud 闸 + G2 恢复流程,备份用真实 backupCommDb 形态含 refs) | classify=`legacy`;legacy 表 schema+内容 SHA-256 摘要前后一致(含负对照);mixed 场景 cutover 确实 throw |
| A7 | 撞锁重试 + rollback 安全 | §3 R3(rollback harness 场景 a-l)+ R1/R1b(restart harness:golden/等锁/超时 alert/非法值/stale 再争锁/R1b 布尔合同+build/health 双位点) | 锁被占/持有者存活/authority 未排空 → 零 mutation;handoff 与释放 seam(INT/TERM)后继任者锁存活、父 130/143;refs+DB staged 校验双向;post-commit 账本场景 HEAD 不回新 SHA;默认路径逐字节兼容 |
| A8 | runbook + updater + 前进生命周期 | r4-runbook.md 落盘评审 + `r4-window.test.sh` harness(八 case,穿真实自分离 seam)+ CI 登记 | U2-A 六 phase 精确命令 + U2-B authority 矩阵齐全;harness 证明各类失败都不触 git-only rollback、不提前起 Lead、Phase R 后 :9876 单一健康持有者;两个新 suite 在 ci.yml + ci-structure 测试登记;U1 双 plist 证据+staged 安装+reload 前重查队列;A1-A8 汇总证据附档 |

测试位置:TS → `packages/flywheel-comm/src/__tests__/`(vitest,faultAfter seam + 临时目录权限沙箱 + 两进程 fixture 用 child_process);CLI/shell → `scripts/__tests__/migrate-fly1572-mailbox.test.sh` 扩展 + 新增 `scripts/__tests__/rollback-r4.test.sh` + `scripts/__tests__/r4-window.test.sh` + `scripts/test-restart-services.sh` 扩展。**CI 登记**(review R4-4:本仓不 glob `scripts/__tests__`,shell suite 是显式枚举):`.github/workflows/ci.yml` 的 `script-tests` job 注册两个新 suite(恰好一次)+ `scripts/__tests__/ci-structure.test.sh` pin 住;若时长逼近容量线则按 FLY-1482 模式抬 floor;CI-structure 测试计入验收证据。全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 上述 shell 测试。

## 4. 实施顺序

1. F1→F2(错误诊断,原地增强合同 + typed generation error)
2. F4→F3(共享 helper + CLI migrated 可达 + verify-open 三步)
3. R1+R1b(restart 锁等待 + code-rollback opt-out,golden 先行)→ R2(rollback-r4.sh)→ R3(rollback harness)
4. G3 演练脚本化 + A6 证据
5. U1 收敛流程 + U2 runbook(含 U2-A 前进生命周期)+ `r4-window.test.sh` + A1-A8 汇总证据
6. Codex code review → PR(docs 与代码同 PR;里程碑行随 PR 最后一笔)

## 5. 风险与边界

- **不碰生产**:全部验收用副本/沙箱;live 库只做过 `mode=ro` 元数据读。r4 窗口执行本身不在本单 scope(founder-gated,另行授权)。
- **字节兼容**:`FLYWHEEL_RESTART_LOCK_WAIT_SECS` 与 `FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK` 不设 = restart-services 现状(golden test 锁死);F1 原地增强保 prototype/`.code`/原 message 子串,generation 三错误逐字不变(A3 断言);CLI verify-open 只加在 cutover 尾部,`--inventory`/`--rollback` 路径不变。
- **rollback 自含性**:rollback-r4.sh 的锁屏障/前台调用/健康轮询全部只用旧代码也具备的机制(mkdir 锁协议 + `FLYWHEEL_RESTART_FOREGROUND` + curl /health),对 checkout reset 免疫(review R1-1 的根)。
- **旧栈死因②无代码修**:结构性闸(code+DB 成对)+ runbook 硬前置,是诚实边界不是遗漏。
- **G 组红线**:不造 drop 工具;legacy `messages`/`lead_inbox` 表是旧栈活体,任何流程碰它 = bug;恢复只走已验证备份整套替换,验收 A6 用 schema+内容摘要对账。
