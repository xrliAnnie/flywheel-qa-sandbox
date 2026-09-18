# FLY-2697 summary presentation 迁移受管入口 — 调研
Issue: FLY-2697 (https://linear.app/geoforge3d/issue/FLY-2697/raya-并仓m0-code-fly-2619-summary-presentation-迁移的受管入口wrapper只部署不执行幂等-校验)
日期: 2026-09-17
基于: exploration.md

> 每条结论都附 file:line;「未验证」显式标出。没有读写生产库。

## 1. 现有迁移合同的精确语义(wrapper 的复验要按这些写)

### 1.1 数据面

| 表 / 字段 | 语义 | 依据 |
|---|---|---|
| `summary_presentation_migration(project_name, lead_id, contract_version=2)` 主键 | 每对 (project,lead) 至多一行 | `summary-presentation-store.ts:197-208` |
| `.state ∈ {building, complete}`;`cursor_seq`;`migration_boundary_seq` | complete 时 `cursor_seq = migration_boundary_seq` 由 SQL 强制 | `:476-481` |
| `.source_digests_json` | `{journal, legacyLedger, migrationDecisions}` 三个 sha256,canonical 排序后比较 | `:295`, `migration.ts:288-301` |
| `summary_presentation_rounds` | 每个 journal round 一行;`disposition ∈ {eligible, claimed, historical_presented, historical_silent, needs_reconciliation}`;`source_seq UNIQUE` | `:209-222` |
| `lead_events`(`event_type='summary_absorption_round'`) | journal 本体;`event_id == payload.execution_id` 否则抛 `journal_identity_mismatch`;`sourceDigest = sha256(payload)` | `:485-535` |

### 1.2 写入面(谁在什么状态下能写这些行)

| 写点 | 前置 | 依据 |
|---|---|---|
| `beginMigration` | 无行 ⇒ INSERT `building`;有行且 boundary 不同 ⇒ `identity_conflict`;有行且 digest 不同:complete ⇒ `sources_changed` 抛错,building ⇒ 删 `eligible/needs_reconciliation` 行并重置 cursor | `:277-334` |
| `classifyHistoricalRound` | 必须 `building`;`sourceSeq <= boundary`;同 round 重复分类必须逐字段一致否则 `classification_conflict` | `:361-427` |
| `completeMigration` | digest 必须等于行内值;逐 journal 行检查 round 存在、seq 一致、digest 一致(`gap`/`digest_mismatch`) | `:429-483` |
| `admitRound`(新 v2 round) | 与 journal 同事务写 `eligible` | `StateStore.ts:21227-21251`, `store:537-575` |
| `stale_alerted_at_ms` | 只在 `building` 时 UPDATE,且不动 `updated_at_ms` | `:996-1000` |

⇒ **complete 之后,`seq <= boundary` 的 round 行只可能发生 `eligible → claimed`(新 persona 领取)**。复验的 disposition 允许集合必须是全部五个值,并把 `claimed` 计入 `eligible` 派生态,否则 B5 之后任何复验都会假红。

### 1.3 `runSummaryPresentationMigration` 的控制流(`migration.ts:246-401`)

```
existing = getMigration()
if existing.complete → return (不重算任何东西)          ← M-1 所指
workspaceRoot = realpath; ledger = assertManagedSource(必需); decisions = assertManagedSource(可选)
parse JSONL(decisions 有 malformed 即抛)
journal = listMigrationJournalRounds(throughSeq = existing?.boundary)
boundary = existing?.boundary ?? journal.at(-1)?.seq ?? 0
sourceDigests = {journal, legacyLedger(bounded by roundIds), migrationDecisions | "absent"}
migration = beginMigration(...)                          ← 第一处写
for journal rows with seq > cursor, ≤ maxRows: classify → classifyHistoricalRound   ← 逐行写
if cursor == boundary (或 boundary==0 且 journal 空) → completeMigration
```

抽取 `:263-301` 为纯函数 `resolveSummaryPresentationMigrationInputs({store, projectName, leadId, workspaceRoot, ledgerPath?, decisionsPath?}, existing)` → `{workspaceRoot, ledgerPath, decisionsPath, ledger, decisions, journal, boundarySeq, sourceDigests}`,主流程改为调用它;所有异常码不变。

## 2. 唯一现有调用路径(必须保持连通)

- `scripts/lib/updater-raya-deploy.sh:994-1002`:standard-update 分支,`raya_migrate_summary_presentation || return 1` 在 `preflight/install` 之前。
- `:1025-1049`:硬校验 project/lead 均为 `raya`;db 默认 `${TEAMLEAD_DB_PATH:-${FLYWHEEL_HOME:-$HOME/.flywheel}/teamlead.db}`;tool = `${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/raya-summary-presentation-migrate.js`(`:46`, `:63`);ledger/decisions 固定 `$RAYA_WORKSPACE/state/…`;成功判据 `.state=="complete" && .cursorSeq==.boundarySeq`。
- 测试:`scripts/__tests__/updater-raya-deploy.test.sh:560-597`(假 node 夹具);`scripts/__tests__/raya-standard-migration.test.sh:82-104` 的退役载体守卫与本单无交集(它列的四个文件本单不碰)。

**本单对上述文件的 diff 必须为空**(QA ⑤ / M-5)。

## 3. 可复用的 durable-file / 只读打开原语

| 需要 | 复用 | 依据 |
|---|---|---|
| 原子写 + 0600 + fsync + 冲突检测 | `atomicJson(path, value, expectedDigest\|null)` | `packages/teamlead/src/bin/raya-migration-io.ts:127-165` |
| 读私有文件(拒 symlink / group-other 位) | `readPrivate(path)` | `:42-47` |
| sha256 | `digest()` | `:38-40` |
| 只读打开 DB | `new BetterSqlite3(path, {readonly:true, fileMustExist:true})` + `new SummaryPresentationStore(raw)` | `summary-presentation-store.ts:2,193`;`StateStore.ts:3919-3922` 是同样用法 |
| 读 40-hex deployed sha | `verify-backend-migration.ts:89-99` 的 `readRegular`(O_NOFOLLOW、nlink=1、size 上限)—— 它是模块私有,wrapper 内复制 10 行即可,不改该文件 | |

`atomicJson` 的边界:要求绝对路径、父目录存在且非 symlink;写入体是 `JSON.stringify(value)+"\n"`(单行)。wrapper 负责 `mkdirSync(dirname, {recursive:true, mode:0o700})`。

## 4. CI 守卫与登记

| 守卫 | 对本单的要求 | 依据 |
|---|---|---|
| FLY-2006 retention consumer gate | 扫生产 TS 源里 `FROM|JOIN <table>` 字面量,命中目标表(含 `lead_events`)且未登记 ⇒ CI 红。`summary_presentation_rounds` **不在**目标表里。⇒ wrapper 读 journal 只经 `SummaryPresentationStore.listMigrationJournalRounds`(已登记 `candidate_guarded`),自己不写 `FROM lead_events` | `scripts/fly-2006-retention-consumer-gate.config.json:3-31,335-341`;`.mjs:116-146` |
| teamlead tsconfig | `include src/**/*`,`exclude **/*.test.ts` ⇒ 新 bin 文件自动进 `dist/bin/`,测试不进 dist | `packages/teamlead/tsconfig.json` |
| vitest | 自动收集 `src/**/*.test.ts`;`vitest.shards.mjs` 的 serialFiles 未列 bin 测试 ⇒ 并行 shard | `packages/teamlead/vitest.config.ts` |
| 现有迁移测试 | `summary-presentation-migration.test.ts` 覆盖 100 轮中断/续跑/漂移 ⇒ 抽函数的回归由它兜 | `packages/teamlead/src/bridge/__tests__/` |

## 5. 测试夹具配方(来自现有测试,可直接照抄)

- 建库:`StateStore.create(join(root,"teamlead.db"))`;追加 journal:`store.appendLeadEvent("raya", roundId, "summary_absorption_round", payload, "summary-absorption")`,payload 必须含 `execution_id === roundId` 与 `project_name`(`summary-presentation-migration.test.ts:14-50`)。
- ledger 行:`{type:"report", roundId, messageId:<数字串>, channelId:<数字串>}` ⇒ `historical_presented`;`{type:"report_attempt"}` 单独 ⇒ `needs_reconciliation`;decisions 行 `{roundId, disposition, operator, reason, evidenceRef}`。
- 「零写」断言:对 `teamlead.db`、`teamlead.db-wal`(若存在)与 receipt 三个文件各取 sha256 + `mtimeMs`,前后相等。执行类断言另加 `getMigration()` 行字段相等。
- 「模拟 DB complete / receipt 之前崩溃」:直接调 `runSummaryPresentationMigration()`(= 现有 updater 路径)把库跑到 complete,不产 receipt,再跑 wrapper。

## 6. 未验证清单

1. 生产 `teamlead.db` 当前是否仍 0 行 —— 沿用 FLY-2680 research 的只读副本结论,本单未复查(也不该查:设计节点不碰生产库)。
2. better-sqlite3 `readonly:true` 打开正被 Bridge 持有的 WAL 库时的行为 —— 理论上只读连接可与写者并存;隔离夹具里可测,生产验证属于 M0-exec(B3)那一单。
3. `~/.flywheel/raya/migrations/FLY-2619-summary-presentation/` 这个建议路径在宿主上尚不存在(只 `ls` 过父目录:目前只有 `FLY-2445-standard-lead`),是否采用由运维授权时定,代码不写死。
