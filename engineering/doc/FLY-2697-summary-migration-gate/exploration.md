# FLY-2697 summary presentation 迁移受管入口 — 探索
Issue: FLY-2697 (https://linear.app/geoforge3d/issue/FLY-2697/raya-并仓m0-code-fly-2619-summary-presentation-迁移的受管入口wrapper只部署不执行幂等-校验)
日期: 2026-09-17
基于: 无(上游施工依据是已合入 main 的 `engineering/doc/FLY-2680-raya-merge-plan/plan.md` §7A / §10.2 / §11.1a / §12 / §14)

> 本节点只做设计。不实现、不动生产库、不碰 `~/.flywheel/`、不改 updater。

## 1. 这张单在 Epic 里的位置

FLY-2680 plan §7A 把 FLY-2619 的历史迁移升级为 **M0 硬闸**,并拆成三个节点:

| 节点 | 何时 | 本单? |
|---|---|---|
| **M0-code** | 阶段 A 的 A4,**只部署不执行** | ✅ 就是本单 |
| S3 merge | §10.2 B1(仍在 B2 围栏之前) | ✗ |
| **M0-exec** | 阶段 B 的 B3,围栏内执行;是 **B4 persona 激活**的前置 | ✗(独立逐实例 founder 授权,§11.1a) |

§14.1 ② 修订过 §7A 三节点表的措辞(S3 merge 阶段统一写成「§10.2 的 B1」、M0-exec 是 B4 的前置而非 S3 的前置);本文按修订后的文字施工。

## 2. 事实审计(全部按 file:line 复核过)

### 2.1 为什么新 persona 一 `begin` 就 409

| 事实 | 依据 |
|---|---|
| `begin()` 在 migration 行缺失或 `building` 时返回 `migration_required` | `packages/teamlead/src/bridge/summary-presentation-store.ts:595-602` |
| controller 把它变成 HTTP 409 `{status:"migration_required", migrationState}` | `packages/teamlead/src/bridge/summary-presentation-controller.ts:181-198` |
| 生产库 `summary_presentation_migration` 有表 0 行 | FLY-2680 research 只读副本查询(本单未再查生产库,也不需要) |

### 2.2 现有实现能复用什么

`packages/teamlead/src/bridge/summary-presentation-migration.ts`(402 行)的 `runSummaryPresentationMigration()`:

- **可复用**:workspace 边界校验(`assertManagedSource`,拒 symlink / 越界 / >64MB)、ledger 与 decisions 的 JSONL 解析、boundary 冻结(`existing?.boundarySeq ?? journal.at(-1)?.sourceSeq ?? 0`)、三类 source digest(`journal` / `legacyLedger` / `migrationDecisions`)、按 cursor 续跑、`beginMigration` 的输入漂移处理、`completeMigration` 的 gap/digest 复核。
- **不能靠它做复验(plan M-1 属实)**:`:247-261` 发现 `existing.state === "complete"` 立即 return,不重算 digest、不重读 journal。所以「已 complete ⇒ no-op」成立,「校验后 no-op」不成立。
- 它没有 receipt:CLI `packages/teamlead/src/bin/raya-summary-presentation-migrate.ts:97-101` 只把 JSON 写 stdout。

`packages/teamlead/src/bin/raya-summary-presentation-migrate.ts`:

- `parseRayaSummaryPresentationMigrationArgs()` 严格白名单参数(`--db --workspace --project --lead --ledger --decisions --max-rows`),未知参数直接 throw。
- `runRayaSummaryPresentationMigrationCli()`:校验 db 是普通文件、workspace 是非 symlink 目录,`StateStore.create()` 打开(会跑 schema migrate)→ 跑迁移 → close。

### 2.3 唯一现有调用路径(M-5 / QA ⑤ 要保护的东西)

`scripts/lib/updater-raya-deploy.sh`:

- `:994-1002`:standard-update 分支里 `raya_migrate_summary_presentation || return 1` **先于** `raya_standard_lead preflight/install`。
- `:1025-1049`(`raya_migrate_summary_presentation`):从 canonical manifest 取 project/lead 并硬要求 `raya/raya`;db = `${TEAMLEAD_DB_PATH:-${FLYWHEEL_HOME:-$HOME/.flywheel}/teamlead.db}`;ledger/decisions 固定在 `$RAYA_WORKSPACE/state/`;tool 路径 `${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/raya-summary-presentation-migrate.js`(`:46`/`:63`);成功判据 `jq -e '.state=="complete" and .cursorSeq==.boundarySeq'`。
- shell 测试 `scripts/__tests__/updater-raya-deploy.test.sh:560-597` 用假 node + 假 tool 夹具验证调用形状。

现场事实(Lead 2026-09-17T22:01Z):旧壳 `com.xrli.raya.brain` 已 bootout + disable;班车本身(`com.flywheel.updater` 00:00/12:00)仍在。**这条路径本单一个字节不动**。

### 2.4 durable 写文件的既有 helper

`packages/teamlead/src/bin/raya-migration-io.ts`:

- `atomicJson(path, value, expectedDigest|null)`:绝对路径、父目录非 symlink、`wx` 打开 tmp(0600)、`fsync` 文件、rename、再 `fsync` 目录;写前写后各比一次现有文件 digest,不等于 `expected` 就 `write-conflict`。
- `readPrivate(path)`:普通文件、非 symlink、mode 无 group/other 位。
- `digest(bytes)`:sha256 hex。

正好覆盖 plan M-2 的「普通文件、0600、原子写」三条,无需新造。

### 2.5 只读打开 DB 的可行方式

- `StateStore.create()` 会跑 `migrate()`(写 schema)且设 WAL —— 不适合「校验模式必须零写」。
- `StateStore.openForMaintenance(path,{readonly:true})`(`StateStore.ts:3912`)会 `assertMaintenanceSchema` 校验一堆与本单无关的表。
- `SummaryPresentationStore` 的构造函数只要一个 better-sqlite3 `Database`(`summary-presentation-store.ts:2,193`);getter 不会自动 migrate。⇒ 校验路径可以直接 `new BetterSqlite3(db,{readonly:true,fileMustExist:true})` + `new SummaryPresentationStore(raw)`,物理上写不了。

### 2.6 迁移完成后哪些字段稳定

- `summary_presentation_migration.updated_at_ms`:`completeMigration` 写一次;之后只有 `stale_alerted_at_ms` 的 UPDATE(`:996-1000`)且限定 `state='building'`,不改 `updated_at_ms`。⇒ complete 后 `updated_at_ms` 稳定,可作 plan M-4b 的「stable migration completion time」。
- `summary_presentation_rounds` 中 `seq <= boundary` 的行:`classifyHistoricalRound` 只在 building 时可写(`:372-375`);complete 后新 persona 只会把 `eligible` 改成 `claimed`(领取)。⇒ 复验时 disposition 允许集合必须含 `claimed`,否则激活后复验会假红。
- `lead_events` 中 `summary_absorption_round` 的 payload:只追加不改;`listMigrationJournalRounds` 每次从 payload 重算 `sourceDigest`(`:530`)。

## 3. 需要决定的问题与本文的取向

### Q1 入口形态:shell 还是 TypeScript?
**TS,放 `packages/teamlead/src/bin/`**。理由:复验要读 DB、算 digest、读 JSONL,shell 里做等于第二套实现;现有 Raya 迁移工具族(`raya-migration-*.ts`)已经全在这里,测试风格(`*.test.ts` 同目录,`tsconfig` exclude `**/*.test.ts`)现成。

### Q2 复验如何做到「同一来源」而不是第二套算法?
把 `runSummaryPresentationMigration()` 里 `:263-301` 的**输入解析段**(workspace canonicalize → ledger/decisions 解析 → journal 列表 → boundary → 三个 digest)抽成一个导出的纯函数,主流程与 wrapper 共用。行为零变化;现有 `summary-presentation-migration.test.ts` 直接覆盖回归。

### Q3 执行授权如何绑定到「这一次的 DB 状态」?(§11.1a「逐实例」)
`preflight` 子命令只读地产出一个 **preflight digest**(绑定 project/lead、DB identity、boundary、三个 source digest、journal 行数、工具文件 digest);`execute` 必须带 `--expect-preflight <digest>`,执行前重算,不等则 fail closed 且零写。founder 的逐实例授权引用这个 digest,授权就自然绑到了那一刻的数据状态;journal 在授权后又长了一轮(Bridge GatePoller 会继续生产,§14.3),也会被拦下并要求重做 preflight。

### Q4 receipt 里什么参与身份、什么不参与?(M-4b)
分两块:`evidence`(DB/workspace/工具/迁移事实,含稳定的 `completedAtMs`)→ 算 `evidenceDigest`;`attestation`(授权引用、本次运行时间、模式)不参与。M-3 的「从 complete 的 DB 重建同一份 receipt」= `evidence` 与 `evidenceDigest` 逐字节相同。

### Q5 receipt 路径谁定?
显式 `--receipt <abs path>`,不猜 env。建议生产值 `~/.flywheel/raya/migrations/FLY-2619-summary-presentation/receipt.json`(与既有 `migrations/FLY-2445-standard-lead/` 同级),写进 plan 的运维说明而不是写死进代码。

### Q6 要不要接进 updater?
**不接**。A4 的定义就是「只部署不执行」;唯一现有路径(§2.3)原样保留;等 M0-exec 在 B3 用本入口证明可用后,T1/T2 才按 §9.2 处置。

## 4. 明确不做

- 不改 `scripts/lib/updater-raya-deploy.sh`、不改其 shell 测试。
- 不改 `raya-summary-presentation-migrate.ts` 的参数面与退出码(T3 才处置)。
- 不新增 launchd / plist / bin shim / package.json `bin` 条目。
- 不加「自动重试」「自动解围栏」「自动重启 Lead」—— 那是 B2/B4 的运维动作,不属于工具。
- 不对生产库做任何读或写(设计与后续 QA 都用隔离夹具)。
