# FLY-1657 迁移工具 stale intent 修复 — 实施计划

Issue: FLY-1657 (https://linear.app/geoforge3d/issue/FLY-1657/fix-migrate-fly1572-mailboxlegacy-库形状依赖确定性炸no-such-table-mailbox)
日期: 2026-08-07
基于: research.md
Status: **codex-approved**(design review 4 轮:R1 8 项 → R2 6 项 → R3 6 项 → R4 APPROVED + 4 ADVISORY 已折入)

## R4 ADVISORY 折入(实现时照做)

1. **收养禁令放在最终调用边界**:除入口对账外,每一处 `backupCommDb(dbPath, intent.backupPath)` 调用**前**就地断言禁令(含同进程新建 v:2 intent 的路径),T5b-⑤ 覆盖 resumed 与 fresh 两种 fenced intent。
2. **`aborted` 作为独立校验分型**:v:2 aborted-before-backup 合法缺 backup/staging 哈希,aborted-after 保留哈希——不得把 `aborted` 当数值相位参与 "≥ backed_up" 判断;v:1 的 "fenced + no backup" 例外显式编码(它只改 mode/账本,从不 replay artifact,故安全)。
3. **pre-swap rollback 成功后 quarantine 目标的处置**:回滚验证全过后删除(或防碰撞归档)`intent.quarantinedSidecars` 的已验证固定名目标,T10-② 加对应断言——否则留下的固定名会让下次重跑正确地 fail-loud,徒增操作员工作。
4. **runbook 清点命令用 `find`** 而非依赖 shell globstar 的 `ls ~/.flywheel/**/...`,防嵌套 intent 静默漏扫。

## 0. 一句话

`migrateCommDbWithSwap()` 与 `rollbackMailboxMigration()` 在信任 swap-intent 之前先做**内容级**现实对账(intent 严格校验 + fence 期 source-binding 哈希 + canonical 状态分类):证据链闭合的 stale `done` intent 自动归档后走全新迁移(run5 免手工),其余任何不一致一律 fail-loud——把 forward 与 rollback 两侧所有"用旧备份/旧 staging 盖新数据"的静默丢失路径全部封死。

## 1. 改动清单(全部在 `packages/flywheel-comm` + `scripts/`)

### C0 共享判据:`classifyMailboxDatabase()`(新,library 层)

`packages/flywheel-comm/src/mailbox-migration.ts` 新增导出:

```ts
export type MailboxDbState = "legacy" | "migrated" | "mixed" | "unknown";
export function classifyMailboxDatabase(dbPath: string): MailboxDbState
// readonly 开库;判据与 scripts/migrate-fly1572-mailbox.ts classify() 完全一致
// (使用 MAILBOX_SCHEMA_GENERATION,poison view type='view' 不算 legacy table)
```

script 的 `classify()` 改为直接复用(消除双实现 drift,R1-#8)。对账逻辑把 `mixed`/`unknown` 归入"other"处理。

### C1 `mailbox-migration.ts` — resume 现实对账(核心)

#### C1.0 intent 严格校验 + 版本化(R1-#4,R2-#6)

`readIntent()` 拆成**导出的只读校验器** `inspectMailboxSwapIntent(path)`(script inventory 复用同一实现,不复制 schema)+ 内部消费端。任何 `resolve`/`stat`/`existsSync`/mutation 之前,先校验:

- JSON 可解析;`v ∈ {1, 2}`;`phase` ∈ 已知枚举(8 相位 + `aborted`);
- `dbPath`/`backupPath`/`stagingPath` 为绝对路径,且 **artifact layout 绑定**:`backupPath` 必须是 `${dbPath}.pre-fly1572-` 前缀的同目录邻居;`stagingPath` 必须位于 `dirname(dbPath)/.fly1572-*/` 内;
- `originalMode`/`createdAt`/`sourceMessages`/`sourceLeadInbox` 类型正确(非负安全整数/字符串);`quarantinedSidecars` 为 string[],每项前缀绑定 `${dbPath}-wal|-shm` + `.fly1572-quarantine`;
- **版本语义**:`v:2` = 本单新写形态,`sourceBinding` 必填,且 `backupSha256`/`refsManifestSha256` 在 phase ≥ backed_up 时必填、`stagingSha256` 在 phase ≥ staging_verified 时必填(C1.1);`v:1` = 旧兼容形态,只允许进 post-swap reality 对账(pre-swap 一律 fail-loud)。

失败统一抛 `invalid mailbox swap intent: ${path}: ${reason}`(含 JSON parse 失败,吸收原 T9)。

#### C1.1 source + artifact binding:内容级凭据链(R1-#1、R2-#1 BLOCKER)

mode 位不是内容绑定(chmod 0444 撤销不了已打开的 writable FD,Codex 实测确认);且 resume 会**复用** backup/staging 本体,binding 必须把它们也钉死(R2-#1)。`v:2` intent 携带:

```ts
sourceBinding: {                 // 首次 durableJson 之前计算(chmod 不改字节)
  mainSha256: string,            // sha256File(dbPath)
  walSha256: string | null,      // wal 存在则哈希,否则 null
},
backupSha256?: string,           // backupCommDb 返回并 verify 后,与 phase:"backed_up" 同一次 durable 写入
refsManifestSha256?: string,     // sha256File(`${backupPath}.refs-manifest.json`),同上
stagingSha256?: string,          // staging migrate+verify 后,与 phase:"staging_verified" 同一次 durable 写入
```

**pre-swap resume(phase < canonical_swapped)必须全链验证,任何一环不符即 fail-loud、零 mutation**:

- **canonical source**:main 哈希一致;WAL 判据**按相位分型**(R2-#3、R3-#2):
  - `fenced`:**只接受** canonical wal == walSha256 记录态 ∧ quarantine 目标不存在(合法顺序里 fenced 阶段不可能已 quarantine;若接受"WAL 已挪走"态,后续 backup 只见 main 会丢 WAL 提交);
  - `backed_up`:两态合法 reconcile = (canonical wal == 记录态 ∧ quarantine 目标不存在) **或** (canonical wal 缺失 ∧ `${dbPath}-wal.fly1572-quarantine` == walSha256,即 rename 已落地、phase 未推进的合法 seam;该态下**不再调用 rename**,直接视 quarantine 为已完成);source 与 target 同时存在、双双缺失(记录非 null 时)、哈希不符 → fail-loud;
  - `sidecars_quarantined`/`staging_verified`:canonical wal 必须缺失(新出现的 wal = 有 writer 碰过 → fail-loud);
- **backup 收养禁令**(R3-#1 BLOCKER,最小安全方案):`phase == fenced` 且 `backupPath` 处**已存在文件**但 intent 无已持久化的 `backupSha256` → **fail-loud,绝不让 `backupCommDb()` 的"已存在则复用"路径收养它**(backup publish 完成与 `advance("backed_up")` 落盘之间的 crash seam 放弃自动恢复,换零数据损失;remediation:人工核对该 bundle 后归档,重跑生成新备份);
- **artifact**:phase ≥ backed_up 时 `sha256File(backupPath)` == backupSha256 且 refs manifest 哈希一致;phase == staging_verified 时 `sha256File(stagingPath)` == stagingSha256(替换成"另一份结构合法的 backup/staging"即被拦下,R2-#1 两个 RED 负例);
- **rename-landed reconcile(精确条件,R3-#4)**:pre-swap ∧ reality=migrated 时,**唯一**放行条件 = `phase == staging_verified ∧ stagingSha256 存在 ∧ sha256File(canonical) == stagingSha256`(L1352 式收敛);`fenced`/`backed_up`/`sidecars_quarantined` + migrated reality 在合法执行序里不可能出现 → 一律 fail-loud;v:1 任意 pre-swap → fail-loud;
- **mode tripwire**:`fenced` 相位 → 先验 binding,匹配则**幂等补做** main/WAL chmod fence 后继续(R2-#4),不匹配则 chmod 前零 mutation 拒绝;`fenced` 之后的相位 → 发现写位即 fail-loud(合法流程无任何路径在 fence 后恢复写位);
- **quarantine rename 防覆盖**:执行 quarantine rename 的前提是处于"未落地"合法态(source 存在且经 binding 验证);rename 前目标已存在 → fail-loud(POSIX rename 不许静默覆盖;与上文"已落地态跳过 rename"互斥不冲突,R3-#5)。

不匹配统一 throw:`mailbox swap intent is stale: … diverged from the fenced source/artifacts; resuming would replay an old backup/staging over newer data; archive ${intentPath} (and any .fly1572-* staging/backup) explicitly before retrying`。

#### C1.2 对账规则(`readIntent` 之后、`if (!intent)` 之前)

1. **路径绑定**:`resolve(intent.dbPath) !== resolve(dbPath)` → throw(intent 属于别的库)。
2. **aborted**:保留现有 throw,检查点上移到对账块。
3. `reality = classifyMailboxDatabase(dbPath)`(C0)。
4. **phase ≥ canonical_swapped**(swap 已完成过):
   - reality=migrated → 合法尾部 resume,放行(现有流程,含 L1404 verify 与 cleanup)。
   - reality=legacy → 结论性 stale 判定,自愈前置条件**全部**满足才自愈:
     a. `intent.stagingPath` 文件不存在(swap 已消费 staging;还在 = 矛盾 → fail-loud);
     b. `intent.quarantinedSidecars` 列出的每个 quarantine 目标**均不存在**(任一存在 → fail-loud,防 fresh 迁移的固定 quarantine 目标名 rename 覆盖旧证据,R1-#3);
     c. 满足则自愈:intent 原子归档 `renameSync(intentPath, `${intentPath}.stale-${UTC}-${randomUUID()}`)`(UUID 防碰撞,先断言目标不存在,R1-#5)+ `fsyncDirectory`;stderr 一条结构化 loud 日志(JSON:dbPath、旧 phase、旧 createdAt、归档路径、原因);`intent = undefined` → 落回 `if (!intent)` 全新迁移(新 binding、新时间戳备份、新 staging)。旧备份文件不动。
   - reality=mixed/unknown → fail-loud(FLY-1646 语义,需要显式处置)。
5. **phase < canonical_swapped**(swap 未发生过):
   - reality=migrated → **仅** `phase==staging_verified ∧ canonical hash == stagingSha256` 放行(rename 已落地的合法 crash,L1352 收敛,L923 锁定 + 补 hash 断言);其余相位 + migrated → fail-loud(R3-#4:合法执行序不可能)。
   - reality=legacy → 按 C1.1 验全链 binding(含 backup 收养禁令);通过 → 合法 crash-resume 放行;不通过/无 binding → fail-loud。
   - reality=mixed/unknown → fail-loud。

自愈只存在于唯一证据链闭合的场景(4-legacy 且 a+b 全过):phase≥canonical_swapped 保证旧 staging/备份已履职,现在的 legacy canonical 是唯一事实源。其余一律 fail-loud,满足"缺什么补什么,fail-loud 不许静默 skip"。

### C2 `verifyMigratedDatabase()` — 诊断质量 + 测试缝

- `SELECT` 前先 `tableType(db,'mailbox_migration_meta')`,缺表 → throw 既有格式 `mailbox migration marker missing: ${dbPath}`。
- 函数**导出**(与 `backupCommDb`/`ensureCanonicalDbWritable` 同级),作为 T6 的直接测试入口(R1-#6;不再依赖集成路径命中)。

### C3 `scripts/migrate-fly1572-mailbox.ts` — inventory observability

inventory 条目 `{ path, state, intent?: { phase } }`:通过**导出的** `inspectMailboxSwapIntent()`(C1.0,与库层同一实现,R2-#6)读取——校验通过 → 打印 phase;存在但校验/解析失败 → `intent: { phase: "unreadable" }`。只投影 phase,不暴露 mutation 内部。不改 cutover 决策。

### C4 `rollbackMailboxMigration()` — 同侧现实守卫(R1-#2、R2-#2 BLOCKER)

stale done intent + 被带外恢复且已被活写的 legacy canonical 上执行 `--rollback`,现状会把旧备份盖上去(L1524 sha256 不等 → 换库)并用 intent 旧行数"验证成功";且 FLY-1649 runbook §4.2 "有 intent 就 --rollback" 会直接引爆它。同时注意(R2-#2 实测):online backup 产物字节**通常不等于** source main,"main==backup"不能当收敛判据的全部,且守卫必须在 refs swap(L1503-1520)**之前**——否则 DB 侧拒绝前 refs 已被旧备份覆盖。完整裁决矩阵(入口先做与 C1 相同的 intent 校验 + 路径绑定,全部判定在任何 refs/sidecar/DB mutation 之前):

| 场景 | 判据 | 动作 |
|-----|------|-----|
| fenced 早退 | phase=fenced ∧ backup 不存在 ∧ sourceBinding 匹配 | 保留现有 mode-restore + 标 aborted 路径(L1433-1446) |
| 窗口内合法 abort | pre-swap 相位 ∧ source/artifact binding 按当前相位全链匹配(WAL 已 quarantine 则验 quarantine 目标)∧ **backup bundle 核 binding**(下注)∧ canonical refs == backup manifest | 照现有流程从 durable backup 恢复(fenced/backed_up/sidecars_quarantined/staging_verified 各相位的**合法回滚**,不得误杀) |
| 真回滚 | reality(canonical) = migrated ∧ **backup bundle 核 binding**(下注) | 照现有流程替换为 backup |
| 已恢复收敛 | main hash == backup ∧ canonical WAL 缺失 ∧ canonical refs == backup manifest | 收敛:标 aborted + 清理(**三条件缺一不可**,只看 main 相等会漏掉新 WAL 提交/新 refs) |
| 其余 | —— | **fail-loud,零 mutation**(含 refs):`rollback refused: canonical ${dbPath} …; resolve manually` |

- **backup bundle 核 binding**(R3-#3):所有会消费 backup 的行(窗口内 abort、真回滚,以及 restore-intent resume)在任何 canonical mutation 前必须验 `sha256File(backupPath)` == backupSha256、refs manifest 哈希 == refsManifestSha256,并以 `verifyRefsBackup()` 对照**已绑定的** manifest 验实际 refs tree——`verifySqlite`/`verifyRefsBackup` 只证 bundle 自洽,不证归属,换成"另一份合法 bundle"必须被拦下。
- `v:1` 无 binding 的旧 intent:仅"真回滚"(reality=migrated,作为显式 legacy policy)与"fenced 早退且 backup 缺失"两行可走;其余 fail-loud(生产现存 stale intent 均为 post-swap done,不受影响)。
- run5 runbook 对接(§4):**废止**"intent ⇒ rollback"经验法则。

### C5 不改的东西(边界,review 对照)

- `migrateLegacyDatabaseFile()` 映射逻辑零改动(53k 行全量彩排已证无缺陷)。
- `backupCommDb()` "已存在则复用"零改动——只在 resume 可达,C1.1/C1.2 已在上游拦死非法 resume。
- 生产残留清理(旧备份、staging 残目录、intent 归档目录)、窗口脚本本体(`~/.flywheel/r4`)、模板回灌(任务 #192)不在本单;runbook 修订条目随 PR 文档交付,落地由 run5 准备工作执行。
- ~~done-resume 返回 `already_migrated`~~ **撤销**(R1-#6:与既有 L878 全相位 `status:"migrated"` 断言矛盾,且 script 层 root 走 classify=migrated 提前跳过,修 incident 不需要;不动 public API 语义)。

## 2. TDD 序列(RED → GREEN,vitest `packages/flywheel-comm` + bash `scripts/__tests__/`)

先写全部失败测试再实现;每个丢数据守卫测试在 RED 阶段先演示现状确实丢数据/裸炸。

| # | 测试 | 未修代码行为(RED 佐证) |
|---|------|----------------------|
| T1 | **run4 回归**:legacy 库 + `phase:"done"` intent(staging 已消费、quarantine 目标不存在、旧备份在场)→ 成功迁移;intent 归档 `.stale-*-<uuid>`;新 intent 带 sourceBinding;新备份新路径;旧备份字节不动;stderr loud 日志 | 抛 `no such table: mailbox_migration_meta` |
| T2 | stale done intent 但 stagingPath 文件仍存在 → fail-loud;canonical/备份零变动 | 裸炸不可辨 |
| T3 | stale done intent 且任一 `quarantinedSidecars` 目标仍存在 → fail-loud;quarantine 文件字节不动 | fresh rename 覆盖旧 quarantine(证据破坏) |
| T4 | `intent.dbPath` 与实际路径不符 → fail-loud | 按错误路径行事 |
| T5 | **source binding 负例**(R1-#1):① main/wal 均 0444 但行内容已变(open-FD 写入模拟);② main 0444 + wal 可写/新出现;③ `cp -p` 保 0444 恢复不同内容快照 —— pre-swap 各相位 resume 全部 fail-loud、零 mutation | 静默用旧备份/旧 staging 盖新数据(RED 用行数断言演示) |
| T5b | **artifact binding 负例**(R2-#1、R3-#1/#2/#4):canonical/sourceBinding 不变,但 ① backupPath 换成另一份结构合法 legacy 库(phase=backed_up resume);② stagingPath 换成另一份带合法 mailbox marker 的库(phase=staging_verified resume)—— 均 fail-loud、零 mutation;③ rename-landed 且 canonical hash ≠ stagingSha256 → fail-loud;④ **migrated-but-impossible 三负例**:fenced/backed_up/sidecars_quarantined + reality=migrated → fail-loud;⑤ **backup 收养禁令**:phase=fenced + backupPath 已有文件(含换成 foreign bundle)+ 无 backupSha256 → fail-loud、零 mutation;⑥ phase=fenced + WAL 已挪到 quarantine 目标 + backup 不存在 → 在任何 backup/chmod/rename 前拒绝 | ① ② 静默换入错误数据集;⑤ 现状 backupCommDb 静默收养;⑥ 现状 backup 只备 main 丢 WAL 提交 |
| T6 | `verifyMigratedDatabase`(导出)对无 meta 库 → `mailbox migration marker missing: <path>` | 裸抛 `no such table` |
| T7 | 既有 L878(全相位合法 resume,新 v:2 intent 带全链 binding 后仍全绿)、L923(rename 先落地,补 stagingSha256 匹配断言)、L767 保持绿 | 绿(基线) |
| T7b | **WAL-authority 正向矩阵**(R2-#5):fixture 带 committed WAL-only row,逐 forward 相位 crash/resume 全收敛;WAL rename 已落地但 phase=backed_up 的 seam(R2-#3)两态 reconcile 均放行;quarantine 目标已存在时 rename 拒绝 | L878 现 fixture 非 WAL authority,盲区 |
| T8 | intent 校验负例集:unknown phase / 缺字段 / 相对路径 / backupPath 越界(非邻居前缀)/ stagingPath 越界 / sidecars 越界 / malformed JSON / v:2 缺相位必填 binding 字段 → 统一 `invalid mailbox swap intent: <path>: <reason>`,零 mutation | 裸 TypeError/SyntaxError 或按坏值行事 |
| T9 | v:1 兼容矩阵:pre-swap 相位 → fail-loud;post-swap done + migrated canonical → 照常收敛(root 场景);post-swap done + legacy → 走 T1 自愈 | (锁定兼容矩阵) |
| T10 | **rollback 矩阵**(R1-#2、R2-#2、R3-#3):① stale done intent + legacy canonical 加一行新数据 → `--rollback` 非零,DB/sidecars/refs/备份字节全不变;② 各 pre-swap 相位 + binding 全链匹配 → 合法 abort 恢复成功(含 WAL-only row 与 refs 恢复),二次 rollback 幂等;③ fenced + backup 缺失 → mode-restore/aborted;④ migrated + backup binding 匹配 → 真回滚;④b **migrated + v:2 intent + valid-but-foreign backup/manifest** → 拒绝,DB/refs/sidecars 全不变;⑤ main==backup 但有新 WAL / 但 refs 有新增 → 拒绝且 refs 零变动;⑥ backup publish 完成、advance(backed_up) 前 crash 的 seam:重跑 forward 与 rollback 均 fail-loud 不收养(R3-#1) | ① 静默盖旧备份"验证成功";④b 绕过 binding replay foreign bundle;⑤ 现状会先覆盖 refs |
| T11 | 自愈+fence durability seams(R1-#5、R2-#4、R3-#5):fault injection 在 intent 归档后 / dir-fsync 后 / 新 intent 落盘前、首次 intent durable 后 chmod 前、main chmod 后 WAL chmod 前、**WAL chmod 完成后第二次 durable 前** → 重跑收敛(fenced 相位 binding 匹配时幂等补 fence)、无重复归档、无覆盖;`.stale-*` 同名(人为)→ 断言不覆盖 | (锁定新状态机) |
| T12 | script 层(bash):shard 带合法 intent → inventory 含 `"intent":{"phase":"done"}`;坏 intent → `"unreadable"`;migrated 根库 + intent 在场 → cutover 跳过 + `verifyCommDbOpen` 通过 | inventory 无 intent 字段 |

## 3. 验收(阳性对照先行;生产 db 只 cp 不开;副本区分权威/非权威,R1-#7)

**权威彩排输入** = `~/.flywheel/r4/db-snapshot/`(2026-08-07 01:16 全量 quiesce 后由窗口 controller 生成,manifest 带 sha256)——这是"不开生产库"约束下唯一可得的一致快照。**活库 cp 副本**(`cp db && cp db-wal`,`PRAGMA integrity_check` 不过重拷)仅用于机制复现与尽早暴露增量数据风险,**明确标注非权威**:顺序 cp 活写库不构成一致 snapshot 合同,run5 增量内容的最终裁决靠窗口内工具自身守卫 fail-loud。

1. **A 复现(未修代码,机制级)**:comm/flywheel 活库副本 + 其 stale intent 副本(dbPath/backupPath/stagingPath 按 C1.0 绑定要求改写为沙箱路径)→ 原样抛 `no such table: mailbox_migration_meta`。设计期已完成合成库版(逐字同错)。
2. **B 修后(权威数据级)**:r4 snapshot 的 comm/flywheel 副本 + stale intent 副本 → 自愈日志 + intent 归档 + 全量迁移 + verify 通过(设计期无-intent 彩排基准 16.6s/53k 行);同副本重扫 source 族/candidates_json/pending claim/dangling ack;活库副本再跑一遍作增量风险预警(非权威,发现异常报 Lead 不静默)。
3. **C 根库幂等**:root 活库副本(348KB,老栈低频写)+ 其 done intent 副本(路径改写):
   - script 层:`--inventory` 显示 `migrated` + `intent:{phase:"done"}`;`--confirm-quiesced` 对副本集运行 → root 走跳过分支 + `verifyCommDbOpen` 通过;
   - 库层:`migrateCommDbWithSwap(副本)` → 收敛成功、数据无损(T9 post-swap+migrated 分支的实库版)。
4. **D 全库存清点(含 intent 期望断言,R1-#8)**:生产当前全部 comm DB(discover() 实测集合,当前为 root + 8 shard:flywheel、geoforge3d、growth、joycon-typeless、personal-assistant、sub、test-slot-1、tidal-echo)逐一副本化 → `--inventory`:每条 state ∈ {legacy, migrated};intent 期望逐库断言:root=`migrated`+`done`、flywheel=`legacy`+`done`、其余 7 库**无 intent 字段**;任何 `unreadable`/意外 intent = FAIL。exit 0。
5. **E 全仓门禁**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `bash scripts/__tests__/migrate-fly1572-mailbox.test.sh`。
6. Codex code review(`codex:rescue`)循环至 APPROVED → PR → merge 后报**新 target SHA** 给 run5。

## 4. run5 对接说明(随 PR 交付文档;落地属 run5 准备,不在本 PR 代码)

- 预期序列:inventory 显 flywheel=`legacy`+`intent{done}` → 库层自愈归档 → 全新迁移(基准 ~17s)→ verify;root=`migrated`+`intent{done}` → 跳过。
- **废止 FLY-1649 runbook §4.2 "有 intent 就 `--rollback --db`"**(R1-#2):C4 落地后代码支持**四类**合法 rollback 行(fenced 早退 / 窗口内 pre-swap abort / migrated 真回滚 / 已恢复收敛),非法场景 fail-loud;**run5 operator policy 授权范围收窄为其中两类**(migrated 真回滚、已恢复收敛)——窗口内 pre-swap abort 属工具自动路径,操作员不手工触发(R3-#6:政策收窄是刻意的,不是代码能力边界)。run5 快照必须新做,禁止复用会把 root 还原成 legacy 的旧窗口快照;preflight 断言 root classify=`migrated`(mailbox_v1)。
- preflight 增列 `find "$HOME/.flywheel" -type f -name 'comm.db.migration-swap-intent.json*' -print`;窗口报告须包含自愈 stderr 日志。
- 根库 backup + done intent 原位保留至 run5 成功收窗——定位为 **forensic/recovery evidence**(root 铁律不许回滚,它们不是"可执行的回滚保险"),之后由运维归档(R3-#6)。

## 5. 风险与回退

| 风险 | 缓解 |
|-----|------|
| 对账误伤合法 crash-resume | T7 全相位基线 + T7b WAL-authority 矩阵 + T11 全 seam 注入锁定;放行集 = {migrated ∧ (post-swap ∨ canonical==stagingSha256)} ∪ {legacy ∧ pre-swap ∧ 全链 binding 匹配(WAL 两态 reconcile)};binding 随 v:2 intent 各相位 durable 同步落盘,合法 resume 必然带着它 |
| 自愈误触发 | 四重门:phase≥canonical_swapped ∧ 纯 legacy ∧ staging 已消费 ∧ quarantine 目标全缺席;差一样即 fail-loud;归档不删可复盘 |
| 旧形态(无 binding)intent 兼容 | pre-swap → fail-loud(生产不存在该形态);post-swap → reality 对账不依赖 binding;T9 锁定矩阵 |
| sha256 开销 | 162MB+wal 约 1s/库,窗口预算可忽略 |
| rollback 行为收紧影响既有恢复剧本 | 四类合法行(fenced 早退 / pre-swap abort / migrated 真回滚 / 已恢复收敛)行为保留且以 T10 ②③④ 直接作证;新拒绝的恰是会丢数据或 replay foreign bundle 的场景;runbook 同步修订(operator policy 收窄为两类是政策而非能力边界) |
| run5 活库增量数据触发内容守卫 | 属正确 fail-loud;验收 B 的非权威预扫尽早暴露 |
| 回退 | 单 PR、纯库+script 改动、不碰生产状态;revert 即回 run4 行为 |
