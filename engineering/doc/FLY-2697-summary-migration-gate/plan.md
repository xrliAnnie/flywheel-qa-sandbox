# FLY-2697 summary presentation 迁移受管入口 — 实施计划
Issue: FLY-2697 (https://linear.app/geoforge3d/issue/FLY-2697/raya-并仓m0-code-fly-2619-summary-presentation-迁移的受管入口wrapper只部署不执行幂等-校验)
日期: 2026-09-17
基于: research.md

> 施工依据:`engineering/doc/FLY-2680-raya-merge-plan/plan.md` §7A.2(M-1…M-6)、§10.2 A4/B3、§11.1a、§12 M0-code 行、§14;
> **receipt / fence 字段权威 = S4 `engineering/doc/FLY-2696-persona-projection/plan.md` §4.3 / §4.4**(Lead 裁定 ask `49aa8546`:逐字段对齐,冲突以 S4 为准)。
> 版本:**v8**(R5 验证轮:#1–#3 关闭,#4/#5 各一处 v6/v7 未同步的旧文本已改;Codex R1 8+2 → R2 6 → R3 5 → R4 验证轮 1 残留 + 4 条 v5 自引入回归;v6 按小修法关闭;v7 = Lead 裁定 R4 #5 走方案 a 并按 `design-correction.md` 改写 A4 措辞;修订记录见 §14)。

## 0. 一句话

给 FLY-2619 已有的迁移实现套一层 **只在 `raya/raya` 上工作、持与 updater 同一把 Raya deploy 锁、先在只读连接上冻结输入并与授权 payload digest 比对、只有确实要迁移时才开读写连接、完成后独立只读复验(逐 seq 重推 disposition)、然后按 S4 §4.3 的 `M0ReceiptV1` 落 receipt 与冻结逐行证据** 的 TypeScript CLI;**只随代码部署,不被任何东西调用**;updater 里那条既有路径一个字节不动。

## 1. 交付物(文件级)

| # | 路径 | 动作 | 说明 |
|---|---|---|---|
| F1a | `packages/teamlead/src/bridge/summary-presentation-migration.ts` | **改**(默认路径行为零变化) | ① 把 `:263-301` 抽成导出的纯函数 `resolveSummaryPresentationMigrationInputs(input, existing)`(含 S4 要求的 bounded source-digest 纯函数);② `runSummaryPresentationMigration` 新增可选 `resolved?: ResolvedInputs`,传入时不再自己解析输入;③ 导出 `classifyRound` |
| F1b | `packages/teamlead/src/bridge/summary-presentation-store.ts` | **改**(S4 §4.3「现有 schema 的必要补口」) | ④ `migrate()` 加 `ensureColumn("summary_presentation_migration","completed_at_ms","INTEGER")`;⑤ `completeMigration` 的同一条 UPDATE 里 `completed_at_ms = COALESCE(completed_at_ms, ?)`(首次 building→complete 的同一事务写一次,replay 不重写);⑥ `getMigration` 返回 `completedAtMs: number \| null`;⑦ 新增 `adoptMigrationCompletedAt(projectName, leadId): number` —— `UPDATE … SET completed_at_ms = updated_at_ms WHERE … AND state='complete' AND completed_at_ms IS NULL`,返回列值;行非 complete 抛错;已有值时零写返回现值 |
| F2 | `packages/teamlead/src/bin/raya-summary-presentation-gate.ts` | **新** | wrapper:`preflight` / `verify` / `execute` |
| F3 | `packages/teamlead/src/bin/raya-summary-presentation-gate.test.ts`;`packages/teamlead/src/bridge/__tests__/StateStore.summary-presentation.test.ts`(追加 completed_at_ms 用例) | **新/追加** | §10 |
| F4 | `engineering/doc/FLY-2697-summary-migration-gate/*` | 文档 | 本节点产物 + implement 节点的 implementation.md |
| — | `scripts/lib/updater-raya-deploy.sh`、`scripts/__tests__/updater-raya-deploy.test.sh`、`packages/teamlead/src/bin/raya-summary-presentation-migrate.ts`、`packages/teamlead/src/bin/raya-migration-io.ts`、`packages/teamlead/package.json` | **零改动** | PR 描述用 `git diff --name-only origin/main...HEAD` 自证 |

不新增:launchd、plist、`~/.flywheel/bin` shim、package.json `bin` 条目、updater 调用、环境变量读取、founder 授权真伪校验(S4 §4.1:由 Bridge 重读原始消息核对)、新锁实现(复用 `withRayaDeployLock`)、目录创建(状态目录由 activation owner 的 enrollment 步骤先建好)。

## 2. 核心流程

```mermaid
flowchart TD
    A[operator 调用 wrapper] --> G{project==raya && lead==raya<br/>所有路径参数绝对<br/>db 普通文件非 symlink · workspace/raya-home/state-root 目录非 symlink<br/>状态目录已存在?}
    G -- 否 --> X0[identity_not_allowed / path_not_absolute /<br/>db_invalid / workspace_invalid / raya_home_invalid / state_dir_missing<br/>退出 1,未打开 DB]
    G -- 是 --> M{子命令}

    M -- preflight --> P0[fd 读 deployed-sha · persona · tool 文件]
    P0 --> P1[只读打开 DB → resolveInputs 一次]
    P1 --> P2[输出 authorizedPayloadDigest + 明细<br/>退出 0,零写]

    M -- verify --> V0[只读打开 DB → resolveInputs(existing)]
    V0 --> V1{行 complete · cursor==boundary · completed_at_ms 非空?}
    V1 -- 否 --> X1[migration_missing / migration_building 退出 2;completed_at_missing 退出 1]
    V1 -- 是 --> V2[V4 digest 重算 · V5 逐 seq 重推 · V6 行数]
    V2 -- 失败 --> X2[fail closed 退出 1]
    V2 -- 通过 --> V3{m0-receipt.json 与 m0-dispositions.jsonl?}
    V3 -- 都缺 --> X3[receipt_missing 退出 2]
    V3 -- 只缺一份 --> X3b[evidence_incomplete 退出 1]
    V3 -- 都在 --> V4[receiptId 自洽 · dispositionDigest==jsonl · DB 派生字段==当前 DB ·<br/>逐行 frozen vs current(eligible→claimed 允许)]
    V4 -- 否 --> X4[receipt_malformed / receipt_conflict 退出 1]
    V4 -- 是 --> V5[ok 退出 0,零写]

    M -- execute --> L0[withRayaDeployLock(realpath raya-home)]
    L0 -- 活锁 --> X5[deploy-lock-held 退出 1]
    L0 --> E0[前置预检(未开任何 DB 连接):<br/>授权四字段 shape · deployed-sha · persona · tool ·<br/>既有 receipt/jsonl/execution 记录 shape]
    E0 -- 失败 --> X6[退出 1,零写]
    E0 --> E1[只读打开 DB → resolveInputs **一次** → frozen;读 existing]
    E1 --> E2{authorizedPayloadDigest(frozen) == --expect-preflight?}
    E2 -- 否 --> X7[preflight_drift 退出 1,零写]
    E2 -- 是 --> E3{既有 receipt?}
    E3 -- 两文件都在 --> E3a[按 verify 规则校验]
    E3a -- 有效 --> X8[unchanged 退出 0,零写(连 generatedAt 都不刷新)]
    E3a -- 无效 --> X4
    E3 -- 只有一份 --> E3b{execution 记录含 planned identity?}
    E3b -- 否 --> X11[evidence_incomplete 退出 1]
    E3b -- 是 --> E9
    E3 -- 都不在 --> E4{existing 已 complete?}
    E4 -- 是 --> E5[mode = execution 记录.mode ?? adopted-legacy<br/>记录若存在:AuthorizationRef 五字段必须逐字相等]
    E5 --> E5a[**adoption 复验**(只读):V1,V3–V7 全量,V2b 暂缓]
    E5a -- 失败 --> X2
    E5a -- 通过 --> E6{completed_at_ms 为空?}
    E6 -- 是 --> E6a[写 execution 记录(mode=adopted-legacy, 冻结 AuthorizationRef)→<br/>create 前 identity 比对 → RW 打开 → adoptMigrationCompletedAt 一次 → 关 → 记录 schemaAdoption]
    E6 -- 否 --> E9
    E6a --> E9
    E4 -- 否 --> E7[写 execution 记录 mode=executed →<br/>create 前 lstat/realpath/dev/ino == frozen?]
    E7 -- 不等 --> X9[db_identity_changed 退出 1,未开 RW]
    E7 -- 相等 --> E8[StateStore.create → runSummaryPresentationMigration(store, resolved=frozen) → 关]
    E8 -- building --> X10[退出 2,不写 receipt,可重跑(同一授权)]
    E8 -- complete --> E9[只读重开 → 重开句柄 identity == frozen? → verify 规则复验]
    E9 -- 失败 --> X2
    E9 -- 通过 --> E9b{execution 记录已有 planned identity?}
    E9b -- 是且不等 --> X12[rebuild_identity_mismatch 退出 1,不写]
    E9b -- 否 --> E9c[原子写 planned {receiptId, dispositionDigest, completedAt} 进 execution 记录]
    E9b -- 是且相等 --> E10
    E9c --> E10[atomicJson 写 m0-dispositions.jsonl → 写 m0-receipt.json<br/>(已存在且内容相同: 不写;不同: conflict)]
    E10 --> E11[释放锁,退出 0]
```

**complete 行永远不经过读写连接**,唯一例外是 S4 §4.3 授权的 **一次性 `completed_at_ms` 补口**(旧 schema 留下的 NULL,`adoptMigrationCompletedAt` 写一次,不重新分类);该例外只在围栏内的 adopted-legacy 路径、且**只在 E5a 的全量只读复验通过之后**发生(R4 #2),之后所有重跑零写。`StateStore.create` 之前(E7/E6a)与最终只读重开时(E9)各做一次 DB identity 比对。`lstat`→`open` 的窗口由 deploy 锁排除并发 operator。

## 3. CLI 合同

```
node packages/teamlead/dist/bin/raya-summary-presentation-gate.js <preflight|verify|execute> \
  --db <abs> --workspace <abs> --project raya --lead raya [--ledger <abs>] [--decisions <abs>] [--max-rows <n>] \
  --state-root <abs>                          # 三个子命令都必需;状态目录 = <state-root>/state/lead-persona/raya/raya(S4 §4.3 落盘合同)
  --deployed-sha-file <abs>                   # preflight / execute
  --raya-home <abs>                           # preflight / execute;锁目录 = <raya-home>/deploy.lock.d
  --window-id <id>                            # preflight / execute;来自 activation owner 的 fence(S4 ActivationFenceV1.windowId)
  --frozen-payload-digest <sha256>            # preflight / execute;= fence.frozenPayloadDigest
  --authorization-channel-id <snowflake>      # execute
  --authorization-message-id <snowflake>      # execute
  --authorization-author-id <snowflake>       # execute
  --authorization-content-sha256 <sha256>     # execute
  --expect-preflight <sha256>                 # execute;= preflight 输出的 authorizedPayloadDigest
```

- 共享参数(`--db …--max-rows`)先剥掉 gate 专有 flag,**原样交给** `parseRayaSummaryPresentationMigrationArgs()`。
- **在打开任何 DB 连接之前**(顺序固定):① `--project`/`--lead` 不都等于 `raya` ⇒ `identity_not_allowed`;② 所有路径 flag 必须绝对 ⇒ `path_not_absolute:<flag>`;③ 子命令所需 flag 缺失 ⇒ `missing_argument:<flag>`;④ shape:`--window-id` 匹配 `^[A-Za-z0-9._-]{1,128}$`,三个 snowflake 匹配 `^[1-9][0-9]{0,24}$`,两个 sha256 匹配 `^[0-9a-f]{64}$` ⇒ 否则 `invalid_argument:<flag>`;⑤ `lstat`:`--db` 普通文件非 symlink(`db_invalid`);`--workspace`、`--raya-home`、`--state-root` 已存在、目录、非 symlink(`workspace_invalid` / `raya_home_invalid` / `state_root_invalid`);状态目录 `<state-root>/state/lead-persona/raya/raya` 已存在、目录、非 symlink(`state_dir_missing`;wrapper **不创建**它)。①–④ 零 I/O;⑤ 只 `lstat`。
- **路径解析对齐 S4**:S4 的 `resolvePersonaStateRoot(env, homeDir)`(`packages/config/src/persona-projection.ts`,S4 交付)是唯一解析合同;本单 `main()` 若在 S4 合入后实现,直接调用它得到 `--state-root` 的默认值并拒绝不一致的显式值;若先于 S4 合入,`--state-root` 由运维显式给出,且 wrapper 的目录拼接规则与 S4 逐字相同(`join(root,"state/lead-persona/raya/raya")`,禁止 `state/state`)。核心函数只接收已解析的 root。
- **退出码**:0 = 成功(含 unchanged);2 = 状态未到位(`migration_missing` / `migration_building` / `receipt_missing` = receipt 与 jsonl **都**缺),可重跑;1 = fail closed 或参数错误。**共享 verifier 返回 typed outcome,两个子命令对同一状态映射同一 code/exit**(R4 #4):receipt 与 jsonl 只缺一份 ⇒ 两个子命令都是 `evidence_incomplete` 退出 1;`execute` 仅当 execution 记录带 planned identity 时才尝试重建,且必须复现该 identity。
- **stdout 恒为单行 JSON**;stderr 只在退出 1 时写一行 `<code>`。

## 4. 私有文件原语与大小上限

- `readPrivateRegular(path, maxBytes, {requirePrivateMode})`:`openSync(O_RDONLY|O_NOFOLLOW)` → `fstatSync` 断言 `isFile && nlink===1 && size<=max`,`requirePrivateMode` 时再要求 `(mode & 0o077)===0` → 从 fd 读。用于:deployed-sha(≤128B,须 `^[0-9a-f]{40}$`,`deployed_sha_invalid`)、persona `.lead/raya/identity.md`(≤256KiB,S4 上限)、tool 文件(≤8MiB,不要求 0600,dist 是 0644)、receipt(≤64KiB,0600)、dispositions jsonl(≤8MiB,0600)、execution 记录(≤64KiB,0600)。
- 写:一律 `atomicJson`(`raya-migration-io.ts:127-165`)或同范式的 `atomicText`(jsonl;wrapper 内 20 行,同 tmp `wx` 0600 + fsync + rename + dir fsync + expected-digest 冲突检测)。
- **写侧对称预检**:RW 打开前用 frozen 值预序列化 receipt(`generatedAt` 占位),> 64KiB ⇒ `receipt_too_large` 零写;jsonl 预估 > 8MiB ⇒ `evidence_too_large`。写后用同一 reader 读回自检。
- **摘要算法(S4)**:key 递归字典序排序、数组保序、UTF-8 compact JSON、无尾换行、SHA256。`receiptId = hash(receipt 去掉 receiptId/generatedAt)`。

## 5. 输入冻结与 authorizedPayloadDigest

### 5.1 冻结(F1a ②)

`execute` 在**只读连接**上调用 `resolveSummaryPresentationMigrationInputs()` **恰好一次**得到 `frozen`,并读 `existing`。所有判定在 frozen 上完成;只有需要写 DB 时才 `StateStore.create`,create 之前比对 DB `realpath/dev/ino`(`db_identity_changed` 否则),再把 `frozen` 作为 `resolved` 交给核心:`beginMigration` 用 frozen boundary/digests(别的写者已建不同 boundary ⇒ 核心 `identity_conflict` 兜底);分类只遍历 `frozen.journal`、只读 `frozen.ledger/decisions`。

### 5.2 authorizedPayloadDigest(= preflight 输出;S4「执行授权 payload」)

```
authorizedPayloadDigest = hash({
  windowId, frozenPayloadDigest,                                 // 来自 fence
  projectName:"raya", leadId:"raya", summaryContractVersion: 2,
  database:  { canonicalPath, device, inode },                   // 十进制字符串
  workspaceCanonicalPath, workspaceIdentityDigest,               // raw persona bytes 的 sha256(非 registry identityDigest)
  sources:   { ledgerPath, decisionsPath|null },
  stateRoot, receiptPath, evidencePath,                          // 三者 canonical
  lock:      { rayaHome, lockTarget },
  migration: { migration_boundary_seq, sourceDigests, journalRounds },
  issuer:    { toolPath, toolBlobSha256, deployedSha },
  migrationModuleSha256                                          // dist/bridge/summary-presentation-migration.js
})
```

- `boundary = existing?.boundarySeq ?? journal.at(-1)?.sourceSeq ?? 0`(与核心同规则)⇒ 缺失 → building → complete 全程不变;`state` 不入 digest。journal 在授权后又长且行仍缺失 ⇒ `preflight_drift` ⇒ 重做 preflight、重取授权(FLY-2680 §14.3)。
- `issuer.toolPath/toolBlobSha256`:wrapper 入口函数接收显式 `toolFiles:{gate, migration}`;生产默认由 `main()` 计算(`gate = fileURLToPath(import.meta.url)`,`migration = fileURLToPath(new URL("../bridge/summary-presentation-migration.js", import.meta.url))`);测试注入两个 `.ts` 源路径。缺失 ⇒ `tool_file_missing`。
- founder 授权消息正文应包含该 digest 的 canonical SHA256(S4 §4.1);**wrapper 不重读消息、不判真伪**,只把四个 AuthorizationRef 字段与 `authorizedPayloadDigest` 原样记入 receipt,由 Bridge 在激活时核对(S4「issuer 是审计标签而非自证授权」)。
- `preflight` 输出 `{ authorizedPayloadDigest, existingState, completedAtMsPresent, 上表明细 }`。

## 6. 复验合同(M-1 / QA ②;`verify` 与 `execute` 末段共用)

只读连接上重新 `resolveSummaryPresentationMigrationInputs(…, existing)`,按序:

| # | 检查 | 失败码 |
|---|---|---|
| V1 | 行存在 | `migration_missing`(退出 2) |
| V2 | `state === "complete"` | `migration_building`(退出 2) |
| V2b | `completedAtMs !== null` | `completed_at_missing`(退出 1;S4:缺值 refused。adopted-legacy 的 execute 在此之前已补口) |
| V3 | `cursorSeq === boundarySeq` | `migration_cursor_mismatch` |
| V4 | 重算三个 digest == 行内值(canonical 比较) | `source_digest_drift:<key>` |
| V5 | journal(≤ boundary)每行:`getRound()` 存在;`sourceSeq`、`sourceDigest` 相等;expected = payload `contract_version===2` ⇒ `eligible` 否则 `classifyRound(...)`;actual `=== expected` 或 expected `eligible` 时 actual 允许 `claimed` | `round_missing:<seq>` / `round_seq_mismatch:<seq>` / `round_digest_mismatch:<seq>` / `round_disposition_mismatch:<seq>:<expected>:<actual>` |
| V6 | `SELECT COUNT(*) FROM summary_presentation_rounds WHERE project_name=? AND lead_id=? AND source_seq<=?` == journal 行数(不假设 seq 连续) | `round_orphan:<n>` |
| V7 | `claimed` 行:其 `groupId`/member 引用存在且 group 状态合法(经 `SummaryPresentationStore` 读接口,不 raw SQL 目标表) | `claimed_reference_invalid:<seq>` |

- 读 `lead_events` 只经 `SummaryPresentationStore`(FLY-2006 gate 已登记);wrapper 源码**不得出现** `FROM lead_events` 字面量;`summary_presentation_rounds` 不在 gate 目标表内。
- 产出 `frozenRows = [{sourceSeq, roundId, sourceDigest, disposition, evidenceRef}]`(按 sourceSeq、roundId 排序;`evidenceRef` 保留合法 `null`)与 `dispositions` 五值计数(`claimed` 单列,不归一)、`verifiedRowCount`、`dispositionDigest = hash(frozenRows)`。
- 已知边界 **L2**:building 期间 ledger 被**改写**(非追加)后保留的 historical_* 行可能被 V5 判不一致 ⇒ 如实报错。

## 7. 证据文件合同(S4 §4.3 / §4.4;M-2 / M-3 / M-4b)

状态目录 `<state-root>/state/lead-persona/raya/raya/`(与 S4 的 `enrollment.json` / `activation.json` 同目录;wrapper 只写下面三个文件,不碰 S4 的两个):

| 文件 | 写者/时机 | 内容 |
|---|---|---|
| `m0-execution.json`(wrapper 私有) | execute 在**首次 RW 打开之前**写;复验通过后、写证据前**原子追加 `planned`**;0600;原子 | `{schemaVersion:1, kind:"raya-summary-presentation-m0-execution", windowId, mode:"executed"\|"adopted-legacy", authorizedPayloadDigest, authorization:{channelId,messageId,authorId,contentSha256}, startedAt, schemaAdoption: null \| {source:"updated_at_ms", adoptedAt}, planned: null \| {receiptId, dispositionDigest, completedAt}}`。作用(R4 #3):① 崩溃重建得到**同一个 `mode`**;② 冻结完整 `AuthorizationRef`,重跑五字段逐字相等,否则 `execution_record_conflict`(同 payload 换 locator 也被拒);③ `planned` 是 immutable materialization identity:任何重建必须复现同一 `receiptId/dispositionDigest/completedAt`,否则 `rebuild_identity_mismatch`,**不按 mode 豁免**(adopted-legacy 在 B5 后新增 claim 再丢证据同样拒绝) |
| `m0-dispositions.jsonl` | 复验通过后、receipt 之前;0600;原子 | 每行一个 `frozenRows` 元素(canonical JSON);整体 digest == receipt.dispositionDigest |
| `m0-receipt.json` | 最后;0600;原子;≤64KiB | 下面的 `M0ReceiptV1`,**字段名、枚举、类型与 S4 §4.3 逐字相同,不另起别名、不省略、不加字段** |

```ts
type M0ReceiptV1 = {
  schemaVersion: 1;
  kind: "raya-summary-presentation-m0";
  mode: "executed" | "adopted-legacy";              // 取自 m0-execution.json
  receiptId: Sha256;                                // hash(receipt 去掉 receiptId/generatedAt)
  windowId: string;
  projectName: "raya"; leadId: "raya";
  database: { canonicalPath: string; device: string; inode: string };
  workspaceCanonicalPath: string;
  workspaceIdentityDigest: Sha256;                  // execute 时 raw persona bytes
  summaryContractVersion: 2;
  state: "complete";
  migration_boundary_seq: number;
  cursor_seq: number;
  sourceDigests: { journal: Sha256; legacyLedger: Sha256; migrationDecisions: Sha256 };
  dispositions: { eligible: number; historical_presented: number; historical_silent: number;
                  needs_reconciliation: number; claimed: number };   // executed ⇒ claimed 必须为 0
  verifiedRowCount: number;
  dispositionDigest: Sha256;
  issuer: { kind: "flywheel-m0-wrapper"; toolPath: string; toolBlobSha256: Sha256; deployedSha: Commit };
  executionAuthorization: { channelId: string; messageId: string; authorId: string;
                            contentSha256: Sha256; authorizedPayloadDigest: Sha256 };
  completedAt: string;                              // ISO(UTC) of DB completed_at_ms;参与 receiptId
  generatedAt: string;                              // 本次物化时刻;不参与 receiptId
};
```

- **稳定性**:`completedAt` 只来自 DB `completed_at_ms`(不用本次时钟);崩溃后重建得到**相同 `completedAt`、相同 `receiptId`**(同一窗口、同一授权、同一工具字节;任一漂移 ⇒ `preflight_drift`,不能重建)。
- **既有 receipt 的有效性判定**(`verify`,也是 `execute` 遇到既有 receipt 时的唯一判定;**不**拿当前 tool/deployedSha 重算 receiptId 去比):① fd 读、shape、`receiptId` 自洽;② `projectName/leadId/summaryContractVersion/state` 精确;③ `database` 与当前 DB `realpath/dev/ino` 相等;④ `migration_boundary_seq/cursor_seq/sourceDigests/completedAt` 与当前 DB 行相等;⑤ `m0-dispositions.jsonl` 存在、digest == `dispositionDigest`、行数 == `verifiedRowCount` == 当前 journal 行数;⑥ 逐行 frozen vs current:相等,或 frozen `eligible` 且 current `claimed`;⑦ 计数一致:`frozen.eligible == current.eligible + (current.claimed − frozen.claimed)`,其余四项相等;⑧ `mode==="executed"` ⇒ `frozen.claimed===0`。全部成立 ⇒ 有效 ⇒ `unchanged`,零写(连 `generatedAt` 都不刷新);否则 `receipt_malformed` / `receipt_conflict`,**不覆盖**。
- **B5 之后**:`eligible→claimed` 是正常业务变化(⑥⑦允许),persona 投影、后续部署换 tool/deployedSha 都不影响有效性(不比当前部署)。
- **重建限制**(S4:B5 后不可用已变化行猜测重建):证据缺失时只允许两种情况 —— (a) execution 记录尚无 `planned`(崩在复验完成之前):按首次物化处理,`executed` 模式要求 `claimed===0`(`rebuild_after_consumption` 否则);(b) 记录已有 `planned`:重算必须逐项等于 `planned`,否则 `rebuild_identity_mismatch`。二者都不成立(无记录、或记录与授权不符)⇒ `evidence_incomplete` / `execution_record_conflict`。交 Lead 运维处置,wrapper 不猜。
- **adopted-legacy 的 `completed_at_ms` 补口**:行 complete 且列为 NULL(旧 schema 完成的迁移)⇒ **先在只读连接上跑 adoption 复验(V1、V3–V7 全量,仅 V2b 暂缓)**,通过后才写 execution 记录(mode=adopted-legacy)→ create 前 identity 比对 → RW 打开 → `adoptMigrationCompletedAt` 一次(值 = 该行持久化的 `updated_at_ms`,不用本次时钟)→ 关 → 记录 `schemaAdoption` → 只读重开做正常全量复验。这是 complete 行上**唯一**允许的写,只发生一次,且 source/round/claimed 引用任一损坏时列保持 NULL(R4 #2);S4 自己不补值、缺值即 refused。
- 顺序(S4):DB complete → 独立只读复验 → `m0-dispositions.jsonl` → `m0-receipt.json`;fence 的 `migrationReceipt` 由 activation owner 填,不由 wrapper 写。

## 8. 与既有路径的关系(M-5 / QA ⑤)

- `execute` 的写入段调用**同一个** `runSummaryPresentationMigration()`(多传冻结输入);T2 用「先由现有函数跑到 complete,再由 wrapper adopted-legacy 只复验 + 落证据」证明终态等价。
- **同一把锁**:updater 用 `${RAYA_HOME}/deploy.lock.d/{pid,start}` + `ps -o lstart=`(`updater-raya-deploy.sh:113-143`);`withRayaDeployLock`(`raya-migration-io.ts:49-125`)实现同一格式。`execute` 整段在 `withRayaDeployLock(realpath(--raya-home))` 内;home 先校验(已存在/目录/非 symlink)再 canonical,且已进入 authorizedPayloadDigest,不能换家绕锁。`preflight`/`verify` 只读不加锁。
- 旧 CLI 在新代码上完成的迁移会自带 `completed_at_ms`(F1b ⑤ 在核心里),wrapper 之后 adopted-legacy 无需补口;旧 schema 完成的才补口。
- `raya-summary-presentation-migrate.ts`、`updater-raya-deploy.sh:1025-1049` 不改;退役是 FLY-2680 §9.2 T1–T3 的事,S4 §4.4 的 ownership guard 是另一张 activation-prep 单。

## 9. 负向守卫清单

| 守卫 | 机制 |
|---|---|
| 非 raya 身份零 I/O | §3 ①,三种组合都拒 |
| 相对路径 / symlink / 目录缺失 | §3 ②⑤,在任何 DB 打开之前;wrapper 不创建目录 |
| 无授权引用不写 | `execute` 缺任一授权 flag ⇒ 退出 1;shape 不对 ⇒ `invalid_argument`(真伪由 Bridge 核对) |
| 授权绑错状态/目标/家 | authorizedPayloadDigest 含 window、DB、workspace、状态目录、锁、boundary、源 digest、工具、deployedSha;冻结输入比对,不等 ⇒ 零写 |
| complete 行只读 | 不开 RW;唯一例外是一次性 `completed_at_ms` 补口(§7) |
| 可预检错误 | deployed-sha、persona、tool、状态目录、既有三文件 shape、大小上限 —— 全部在 RW 之前 |
| DB 被换 | create 之前与最终只读重开各比一次 realpath/dev/ino |
| 输入漂移 | V4;核心 `sources_changed` 仍在 |
| disposition 被改 | V5 重推 + jsonl `dispositionDigest` |
| receipt/证据被改、被复制 | `receiptId` 自洽;DB 派生字段与当前 DB 比;路径由 state-root 派生、无自由路径 |
| 消费后重建 / 换授权 locator 重建 | `planned` identity 必须复现(`rebuild_identity_mismatch`);AuthorizationRef 五字段冻结(`execution_record_conflict`);无 planned 的 executed 首次物化要求 `claimed===0` |
| 崩溃后 mode 漂移 | `m0-execution.json` 先于首次 RW 写;window/digest/authorization 不符 ⇒ `execution_record_conflict` |
| 单边证据缺失 | 两个子命令同一 `evidence_incomplete`(1);execute 仅按 `planned` 重建 |
| 补口先于复验 | adoption 复验先行,失败则列保持 NULL |
| 与 updater 并发 | 同一把 deploy 锁 |
| 生产误用 | 不读 env、不猜路径 |

## 10. 测试(F3;vitest,隔离 tmpdir,不碰宿主)

「零写」= `teamlead.db`/`-wal`/`-shm`(存在性 + sha256 + mtimeMs)与状态目录三文件前后相等 + `SELECT COUNT(*) FROM summary_presentation_migration` 不变。夹具造数后 `close()`。tool 文件在测试中注入 `.ts` 源路径。

| # | 对应 | 场景 | 断言 |
|---|---|---|---|
| T1 | M-4 ① | 100 轮;`execute --max-rows 37` ⇒ building;再 `execute`(同授权)⇒ complete | 第一次退出 2、无 receipt、有 execution 记录(mode=executed);第二次退出 0;receipt shape 逐字段 == §7;`claimed===0`;`completedAt` == ISO(DB `completed_at_ms`);jsonl digest == `dispositionDigest`;三文件 0600 |
| T2 | M-4 ② / M-5 / S4 §4.4 | 用 `runSummaryPresentationMigration()` 跑到 complete(= updater 路径);(a) 直接 `execute` ⇒ `mode==="adopted-legacy"`,DB 零写;(b) 先 raw SQL 把 `completed_at_ms` 置 NULL 模拟旧 schema,再 `execute` ⇒ 补口;(c) 同 (b) 但先把一个 round 的 `source_digest` 改坏 / ledger 改写 / claimed 行的 group 引用删掉,再 `execute` | (a) 零 DB 写;(b) 只有 `completed_at_ms` 从 NULL 变为该行原 `updated_at_ms`,其余列字节不变;execution 记录含 `schemaAdoption`;第二次 `execute` 零写;(c) 退出 1 且 `completed_at_ms` **仍为 NULL**、无 execution 记录(R4 #2) |
| T3 | M-3 / M-4b | T1 的 R1;删 receipt 与 jsonl;再 `execute` | R2 的 `receiptId`、`completedAt`、`mode` 与 R1 相同;`generatedAt` 可不同;DB 零写 |
| T4 | QA ① | receipt 已存在再 `execute` 与 `verify` | 均退出 0、`unchanged`;三文件字节与 mtime 不变 |
| T4b | S4 B5 边界 | complete+receipt 后 `begin()` 产生 `claimed`;`verify`;再 `execute`;然后删 receipt+jsonl 再 `execute`(executed 与 adopted-legacy 各一例) | 前两者 `unchanged`;删后两例都 `rebuild_identity_mismatch`(planned 已存在且 dispositionDigest 变了),不生成新 receiptId(R4 #3) |
| T5 | M-4 ④ / QA ② | complete 后向 ledger 追加 boundary 内 round 的一行;`verify` | `source_digest_drift:legacyLedger`;退出 1;证据未改 |
| T6 | QA ② | raw SQL 改 `source_digest` ⇒ `round_digest_mismatch`;`historical_presented→historical_silent` ⇒ `round_disposition_mismatch`;改 jsonl 一行 ⇒ `receipt_conflict`(dispositionDigest 不等);改 receipt 任一字段 ⇒ `receipt_malformed`(receiptId 不自洽) | 均退出 1、零写、不覆盖 |
| T7 | QA ④ | `(mufasa,mufasa)`/`(raya,mufasa)`/`(mufasa,raya)` 跑 `execute`(参数齐全);另一组分别缺每个必需 flag;另一组 snowflake/sha256 shape 错 | `identity_not_allowed` / `missing_argument` / `invalid_argument`;零写 |
| T8 | §5 | `preflight` → 追加一轮 journal → `execute` 用旧 digest | `preflight_drift`;行仍 null;零写 |
| T8b | R1 #1 | store 包装 hook:`beginMigration` 前追加 journal + ledger | 迁移停在冻结 boundary;末段复验 `source_digest_drift`;无 receipt |
| T8c | R2 #3 / R3 #2 | `execute` 改用另一 `--state-root` / 另一 `--raya-home` / 指向原 home 的 symlink / 另一 `--window-id` | 均 `preflight_drift`(symlink 例为 `raya_home_invalid`);零写;B 家下不出现 `deploy.lock.d` |
| T9 | R1 #4 / R2 #4 / R3 #1 | (a) deployed-sha 非 40hex;(b) 行缺失但 receipt 已预置;(c) 状态目录缺失;(d) receipt 是 symlink;(e) receipt 0644;(f) `--db` symlink;(g) `--workspace` symlink;(h) receipt 预序列化 > 64KiB(构造超长 windowId 被 shape 拒 ⇒ 改用 journalRounds 极大的 jsonl > 8MiB 例) | 每例退出 1;零 DB 写;行仍 null |
| T10 | R2 #5 | 预置本进程持有的活锁 | `deploy-lock-held`;零写 |
| T12 | R3 #1 | hook:(a) 只读关闭后、RW 打开前换库;(b) 迁移完成后、最终只读重开前换库 | (a) `db_identity_changed`,两库零写;(b) `db_identity_changed`,无 receipt |
| T13 | §7 | (a) 用另一 windowId 的 execution 记录预置;(b) DB complete、receipt 未落时换一条同 payload digest、不同 messageId 的授权重跑 | 均 `execution_record_conflict`;零写(R4 #3) |
| T17 | R4 #4 | 矩阵:receipt-only / jsonl-only × `verify` / `execute`(有 planned / 无 planned) | 四格 `verify` 都是 `evidence_incomplete`(1);`execute` 无 planned ⇒ `evidence_incomplete`(1),有 planned 且复现 ⇒ 补齐缺失文件退出 0,有 planned 不复现 ⇒ `rebuild_identity_mismatch`(1) |
| T14 | F1b | store 测试:`completeMigration` 首次写 `completed_at_ms`,replay 不改;`getMigration` 返回;`adoptMigrationCompletedAt` 对 NULL 写一次、对已有值零写、对 building 抛错 | |
| T15 | R3 #5 | 注入两个 `.ts` 路径跑 `preflight` | `issuer.toolBlobSha256` **与** `migrationModuleSha256` 分别等于测试内对两个文件算的 sha256(R4 #1) |
| T16 | 回归 | 现有 `summary-presentation-migration.test.ts`、`StateStore.summary-presentation.test.ts` 不改动既有用例 | 全绿 |

验证命令(implement 节点 QA 判据;**先 build 再测**):

```
pnpm --filter flywheel-teamlead typecheck && pnpm -r build && pnpm lint
pnpm --filter flywheel-teamlead exec vitest run src/bin/raya-summary-presentation-gate.test.ts src/bridge/__tests__/summary-presentation-migration.test.ts src/bridge/__tests__/StateStore.summary-presentation.test.ts
# 真 dist 的 tool digest 验收(会失败的真命令;夹具由 implement 节点在 scratch 下造:空库 + 状态目录 + 40hex deployed-sha + persona 文件):
G=packages/teamlead/dist/bin/raya-summary-presentation-gate.js
M=packages/teamlead/dist/bridge/summary-presentation-migration.js
OUT=$(node "$G" preflight --db "$FX/teamlead.db" --workspace "$FX/ws" --project raya --lead raya \
  --state-root "$FX/root" --deployed-sha-file "$FX/deployed-sha" --raya-home "$FX/raya-home" \
  --window-id w1 --frozen-payload-digest "$(printf '%064d' 0)")
[ "$(jq -r .issuer.toolBlobSha256 <<<"$OUT")" = "$(shasum -a 256 "$G" | cut -d' ' -f1)" ] && \
[ "$(jq -r .migrationModuleSha256 <<<"$OUT")" = "$(shasum -a 256 "$M" | cut -d' ' -f1)" ] || { echo tool-digest-mismatch; exit 1; }
node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs && node scripts/fly-2006-retention-consumer-gate.mjs
bash scripts/__tests__/updater-raya-deploy.test.sh          # 必须与 main 上结果一致(未改)
git diff --name-only origin/main...HEAD | grep -E 'updater-raya-deploy|raya-summary-presentation-migrate\.ts|raya-migration-io\.ts|package\.json' ; test $? -eq 1
```

判「测试成功」看 Tests 条数,不看退出码。

## 11. 回滚与不可逆边界

- **本单代码**:纯增量 + F1 的默认行为零变化改动 + 一列 nullable 新增。`git revert` 即回滚(revert 后旧代码忽略该列)。
- **A4 对生产库的唯一变化 = 一列 nullable 的 schema-only 补齐**(R4 #5;Lead 裁定方案 a,见 `design-correction.md`):`ensureColumn("summary_presentation_migration","completed_at_ms","INTEGER")` 放在 `SummaryPresentationStore.migrate()` 里,与 FLY-2619 已合入的 `stale_alerted_at_ms` 同一模式(`summary-presentation-store.ts:266-275`);Bridge 每次 `StateStore.create` 会幂等执行它(`StateStore.ts:3899-3903` → `:6813-6817`)。**A4 不改任何行、不执行迁移、只加这一列**;A4 的验证命令 `SELECT COUNT(*) FROM summary_presentation_migration` 仍等于 A0 记录值;母方案 A4「生产 DB 未被触碰」的字面表述由 Lead 在 FLY-2680 上留评论更正为「不改任何行、只做 schema-only 列补齐」。
- **M0-exec(不属于本单)**:第一次 `execute` 成功即 FLY-2680 §7A.2 M-6 / §10.3 的第一个不可逆点;persona 可回滚、数据分类不可反向。wrapper 不提供「撤销」。
- 本单的 ship 卡只授权合并代码;对生产库执行是 §11.1a「activation-window 运维授权」的逐实例动作,需 founder 另行授权并在消息正文包含 `authorizedPayloadDigest`。**QA 节点不得对生产库执行 `execute`。**

## 12. §14 核对记录

- §14.1 ②:M0-code=A4;M0-exec=B3,是 B4 的前置,不是 S3 的前置。本文 §0/§11 措辞一致。
- §14.1 ③:本文不出现第二个「合计」;founder 动作只引用 §11.1a。
- §14.2 ④⑤⑥:与本单无直接位置重叠;§5.2 引用 §14.3。
- §13 未验证清单未被当成事实使用。

## 13. 诚实边界与已知限制

做:三个子命令、只读优先、一次冻结、逐 seq 重推、S4 `M0ReceiptV1` 逐字段 receipt + 冻结逐行证据 + 私有 execution 记录、`completed_at_ms` write-once 补口、同一把锁、隔离测试。
不做:接入 updater、执行生产迁移或任何生产行级写(A4 的唯一例外是 §11/L7 已裁定的 schema-only nullable DDL)、围栏/重启/解围栏、founder 授权真伪校验、撤销迁移、写 S4 的 enrollment/activation 文件、创建状态目录、receipt 上报 Discord。
- **L2** ledger 被改写(非追加)后保留的 historical_* 行可能被 V5 判不一致。
- **L3** `preflight`/`verify` 不加锁(只读快照一致;过时的 preflight 由 `execute` 的 drift 拦下)。
- **L4** `lstat`/`realpath` 与随后 `open` 之间不做 fd 级 seam;并发 operator 由 deploy 锁排除。
- **L5** 与 issue 文本 QA ① 的一处收窄:complete 行上有且只有一次 `completed_at_ms` 补口写(S4 §4.3 明文要求,Lead 裁定 S4 为准);补口之后所有重跑零写。
- **L7** A4 部署会随 Bridge 启动幂等执行一次 nullable DDL(Lead 裁定方案 a,`design-correction.md` 修正 1);这是本单唯一的生产 schema 变化,不改任何行。
- **L6** 若本单先于 S4 合入,`--state-root` 由运维显式给出;S4 合入后 `main()` 改为调用 `resolvePersonaStateRoot` 取默认值(一行改动,列为 follow-up FU-3)。
- 未验证:生产库是否仍 0 行(沿用 FLY-2680 结论);只读连接与 Bridge 持有的 WAL 写者并存的真机行为(留给 B3)。

## 14. 评审修订记录与 follow-ups

### R1(Codex,2026-09-17;8 BLOCKING + 2 ADVISORY)

| # | 处置 | 落点 |
|---|---|---|
| 1 check-then-act | 采纳:F1a ② 冻结输入一次并传入核心;T8b | §5.1 |
| 2 preflight 绑定不全 | 采纳:workspace 路径、persona digest、deployed sha 入 digest | §5.2 |
| 3 receipt 身份跨演进 | 采纳(v5 起按 S4:`receiptId` 排除 `generatedAt`;有效性判定只比 DB 派生字段,不比当前部署) | §7 |
| 4 预检前置 | 采纳:可预检错误移到写之前;T9 | §2、§9 |
| 5 V5 只复述枚举 | 采纳:导出 `classifyRound`,逐 seq 重推;T6;L2 | §6 |
| 6 O_NOFOLLOW 误述 | 采纳:fd 范式;T9 | §4 |
| 7 T7 覆盖不足 | 采纳 | §10 |
| 8 `--authorization-ref` 语义 | 采纳 b(wrapper 不验真伪);v5 起字段结构化为 S4 `AuthorizationRef`,核对方是 Bridge(S4 §4.1) | §5.2、§7 |
| 9 (adv) 绝对路径 | 采纳(零机制) | §3 |
| 10 (adv) WAL writer + readonly 夹具 | follow-up FU-1 | 下表 |

### R2(Codex,2026-09-17;6 BLOCKING)

| # | 处置 | 落点 |
|---|---|---|
| 1 execute 先开 RW | 采纳:只读连接冻结+判定,complete 行不开 RW(v5 唯一例外:S4 授权的 completed_at_ms 补口) | §2、§5.1 |
| 2 provenance 无完整性 | 采纳(v5 起由 S4 `receiptId` 覆盖全部字段) | §7 |
| 3 preflight 未绑 receipt 目标 | 采纳(v5 起 receipt 路径由 state-root 派生,state-root/receiptPath/evidencePath 入 digest) | §5.2 |
| 4 DB/workspace symlink 守卫 | 采纳:wrapper 自己 `lstat`;RW 前复核;T9(f)(g) | §3 |
| 5 与 updater 并发 | 采纳:复用 `withRayaDeployLock`;T10 | §8 |
| 6 QA 先测后 build | 采纳 | §10 |

### R3(Codex,2026-09-17;5 BLOCKING —— 按 Lead 规则不开 R4 前先报 Lead;裁定 ask `49aa8546`:五条按小修法关闭,R4 只做验证轮)

| # | 处置 | 落点 |
|---|---|---|
| 1 identity 检查晚于 create;最终重开未比 | 采纳:比对移到 `StateStore.create` 之前;最终只读重开再比;T12;L4 | §2、§5.1、§9 |
| 2 `--raya-home` 未入 digest、未 canonical | 采纳:preflight 也必需;已存在/目录/非 symlink + realpath;`lock` 入 digest;T8c | §3、§5.2、§8 |
| 3 receiptTarget 未比对 | 采纳(v5 起无自由路径:receipt/evidence 路径由 state-root 派生并入 digest,复制到别处的文件不会被读到) | §3、§5.2 |
| 4 receipt 可写出即坏 | 采纳:授权字段改为固定 shape;RW 前预序列化 ≤64KiB / jsonl ≤8MiB;写后读回;T9(h) | §4 |
| 5 dist 验收只是注释;vitest 下 `.js` 解析 | 采纳:`toolFiles` 显式注入;QA 块改为真命令;T15 | §5.2、§10 |

### R4(Codex,2026-09-17;验证轮,scope = R3 五条 + v5 自引入回归;结果:R3 #1–#4 关闭,#5 残留 1 项,v5 回归 4 项)

| # | 性质 | 处置 | 落点 |
|---|---|---|---|
| 1 R3 #5 残留:只验 gate blob | 残留·小修 | 采纳:T15 与 dist 验收都断言两个 blob | §10 |
| 2 adoption 先写后验 | v5 自引入·真缺陷 | 采纳:adoption 复验(V1、V3–V7)先行,失败则列保持 NULL;T2(c) | §2、§7 |
| 3 execution 记录不足以稳定 receiptId;adopted-legacy 豁免 | v5 自引入·真缺陷 | 采纳:记录冻结完整 AuthorizationRef;复验后写 `planned` identity;重建必须复现,不按 mode 豁免;T4b/T13(b) | §7、§9 |
| 4 单边证据缺失退出码矛盾 | v5 自引入·真缺陷 | 采纳:typed outcome,两子命令同一 `evidence_incomplete`(1);T17 | §3 |
| 5 `completed_at_ms` DDL 随 Bridge 启动落生产库 | v5 自引入·Lead 裁定 | **方案 a**(ask `fbd706d8`):nullable schema-only DDL 随 A4 幂等执行;A4 措辞改为「不改任何行、只做 schema-only 列补齐」;`design-correction.md` 修正 1 | §11、L7 |

### R5(Codex,2026-09-17;验证轮,scope = R4 五条;结果:#1–#3 关闭,#4/#5 各一处 v6/v7 未同步的旧文本)

| # | 处置 | 落点 |
|---|---|---|
| 1 verify 流程图仍把「只缺一份」并入 `receipt_missing`/2 | 采纳:V3 改三态(都缺 2 / 只缺一份 1 / 都在继续) | §2 |
| 2 §13 仍写「任何生产读写」 | 采纳:收窄为「不执行生产迁移或生产行级写;A4 唯一例外 = 已裁定的 schema-only nullable DDL」 | §13 |

### v5 与 S4 §4.3 的逐字段对齐(Lead 裁定 `49aa8546`)

| S4 要求 | 本文落点 |
|---|---|
| `M0ReceiptV1` 全部字段、枚举、类型;不另起别名、不省略 | §7 原样;移除 v4 的 `evidence/provenance/receiptDigest/evidenceDigest/receiptTarget` |
| `mode: executed \| adopted-legacy`;executed ⇒ claimed=0;adopted-legacy 可非零 | §7;mode 由 `m0-execution.json` 给出(新增的 wrapper 私有文件,唯一目的是让崩溃重建得到同一 mode / receiptId) |
| `dispositions.claimed` 单列 | §6/§7,不再归一 |
| `verifiedRowCount` / `dispositionDigest` / `m0-dispositions.jsonl` | §6/§7;B5 后不用已变化行重建(`rebuild_after_consumption`) |
| `AuthorizationRef` 五字段;Bridge 核对真伪 | §3 四个 flag + `authorizedPayloadDigest`;wrapper 不判真伪 |
| `completedAt` 来自新增 `completed_at_ms`,write-once,读接口返回;旧行一次性补口并记录 | F1b ④–⑦;§7 |
| 提取 bounded source-digest 纯函数供独立 verifier | F1a ① |
| 落盘路径 `$STATE_DIR/state/lead-persona/raya/raya/m0-receipt.json`;`resolvePersonaStateRoot` 唯一解析 | §3「路径解析对齐」;L6 / FU-3 |
| 摘要算法、receiptId 排除 receiptId/generatedAt | §4 |
| 顺序 DB complete → 只读复验 → receipt → fence.migrationReceipt;S4 不写 receipt、wrapper 不写 fence | §7 |
| fence 的 `legacyWriterHandoff` / `migrationOrigin` | 属 `ActivationFenceV1`,由 activation owner 写;wrapper 只消费 `windowId`/`frozenPayloadDigest`,不读不写 fence 文件 |

### Follow-ups(只记不做)

- FU-1:进程级夹具证明「另一 better-sqlite3 handle 持 WAL 写者并在 boundary 后追加」时只读 verifier 仍读到一致快照且不创建/修改 sidecar(R1 #10)。真机并存行为仍归 B3。
- FU-3:S4 合入后,`main()` 调用 `resolvePersonaStateRoot(env, homeDir)` 取 `--state-root` 默认值并拒绝不一致的显式值(L6)。
