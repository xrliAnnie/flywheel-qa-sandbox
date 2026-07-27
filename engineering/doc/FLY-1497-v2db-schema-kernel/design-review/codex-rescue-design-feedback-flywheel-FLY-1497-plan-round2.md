# Design Review — plan.md (Round 2)
Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮固定在 HEAD `b458585a07d3785aa7ca43873b5ab010403c0861`，按 Round 1 的 9 项冻结清单重新完整审查了 665 行 plan，并重新对照设计链原文和 SQLite 语义。

Round 1 的主体修复均已真实进入 plan，而不只是摘要声明：`thread_bindings` 恢复了 approved PK；async thenable 检查被放入 transaction wrapper 内且增加 tx 生命周期守卫；两组 UPDATE 旁路改为 immutable triggers；0002 的五个最终 triggers 全文进入单一 checksum；rebuild 失败路径用 `finally` 恢复 FK；runner identity 含 activation；导出面、verbatim、T7/T8、backup temp+link 发布合同均已展开。逐字 diff 也确认 activations、processing_attempts、七索引、四候选和 detector 五组 SQL 均与设计链对应行无差异。

但当前仍存在一个 schema 级 HIGH：SQLite 普通 rowid 表的 `TEXT PRIMARY KEY` 不隐含 `NOT NULL`。计划中 11 张权威表使用该形态，实际允许 NULL，甚至允许多条 NULL “主键”；这会破坏 canonical identity、FK 可达性和 processing-attempt CAS。另有两处类型/API 合同按当前文本无法实现。故 Round 2 仍不能批准。

## What's Good (Keep)

- batch-1 纯新增、零生产接线的边界保持不变，没有泄漏消费循环、dispatcher、告警或切换实现。
- `thread_bindings` 已撤回未经批准的多行历史语义；D5 现在正确说明 partial unique 只是冗余防御。
- `command_dependencies_immutable` 与 `obligations_hierarchy_immutable` 正确堵住 Round 1 复现的 UPDATE 旁路；0002 也完整重建后者。
- 0002 的表重建、索引和五个最终 triggers 已成为一个明确的 `Migration.ddl`，不存在 checksum 外的 schema 语句；FK `finally`、锁后重读记账与 T8 失败矩阵方向正确。
- async 运行时合同现在把 thenable 检查放在 commit 前，并对 callback 返回后的 `WriteTx` 做失效处理；这闭合了“先提交后报错”的核心窗口。
- lead/runner discriminated identity 与 runner `activationId` 已钉入 batch-1 API，缺键、畸形 JSON、kind/世代/activation mismatch 均 fail-closed。
- `index.ts` 不再导出 raw `Database`；migrate/backup 改成 path API，主 authority boundary 的方向正确。
- v9 两表 DDL、v9 七索引、v10 四候选、v8 detector 均通过本轮逐字 diff；说明性注释已移出 verbatim SQL。
- backup 不再拿在线副本与另一时刻的 live row counts 强比较；0600 call-owned temp、`linkSync` no-overwrite 发布和只清理自有 temp 的合同合理。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

### 1. [HIGH] 11 张表的 `TEXT PRIMARY KEY` 在 SQLite 中仍允许 NULL

**Issue**

计划使用普通 rowid tables，却在下列权威表上只写 `TEXT PRIMARY KEY`、没有显式 `NOT NULL`：

- `schema_migrations.id`（`plan.md:85-89`）
- `tasks.id`、`attempts.id`、`commands.id`、`gates.id`、`capabilities.id`
- `obligations.id`（0001 与 0002 新表）
- `thread_bindings.lineage_root_id`
- `meta.key`
- `activations.id`
- `processing_attempts.attempt_uid`

SQLite 官方文档明确说明：除 `INTEGER PRIMARY KEY`、`WITHOUT ROWID`、`STRICT` 或显式 `NOT NULL` 外，普通 rowid table 的 PRIMARY KEY 可以为 NULL，且 NULL 彼此视为不同值。参考 [SQLite PRIMARY KEY NULL quirk](https://www.sqlite.org/quirks.html#primary_keys_can_sometimes_contain_nulls)。

本轮在 SQLite 3.51.0 直接执行计划的 `thread_bindings` DDL，连续插入两条 `lineage_root_id=NULL, state='active'` 均成功；`PRAGMA table_info` 也显示该 PK 列 `notnull=0`。因此 `thread_bindings` 当前并没有机器化“每 lineage_root 恰一行”，partial unique 同样不会拒绝多个 NULL。

**Why it matters**

- NULL task/command/gate/capability IDs 会成为不可正常引用的权威行；
- NULL `meta.key` 会破坏 registry/cutover 键空间；
- NULL `processing_attempts.attempt_uid` 无法被设计中的 `WHERE attempt_uid=?` exactly-once CAS 正常结算；
- 多条 NULL `thread_bindings` 会直接破坏刚恢复的 canonical binding 合同；
- T7 目前只测非 NULL PK 重复，没有覆盖这一 SQLite 特有反例，因此全套测试仍可能假绿。

**Suggested fix**

给所有非 INTEGER PK 列显式增加 `NOT NULL`，并在 T7 对每类 textual PK 加 INSERT NULL（以及适用时 UPDATE 为 NULL）拒绝测试。

v9 的 activations / processing_attempts 属于 verbatim code block，因此不要静默改写：应把这视为最小 SQLite-dialect correctness amendment，先同步修正 canonical design SQL，再让 plan、migration constant 和 snapshot hash 共同更新。若 authority 流程坚持原字节不动，则必须在原代码块外增加等价的 NULL-rejection triggers；不能保留当前可插 NULL 的最终 schema。

### 2. [MEDIUM] “类型排除 PromiseLike / txBudget 可配 / options 已接线”与展示的 API 不一致

**Issue**

- `plan.md:535` 仍是 `write<T>(label, fn: (tx) => T): T`，TypeScript 会正常推断 `T=Promise<...>`；它没有实现 `plan.md:549` 声称的 compile-time PromiseLike 排除。运行时保护已正确，但类型合同尚未落地。
- `plan.md:554` 与 D12 声称 `txBudgetMs` 可配置，`KernelDbOptions`（`plan.md:53-59`）却没有该字段。
- `KernelDbOptions.verbose` 已出现，但连接构造合同 `new Database(path, { readonly, timeout })`（`plan.md:64`）没有要求把 `verbose` 传入；`synchronousMode` 也仍被行为条款写死为 `synchronous=FULL`，没有明确按 option 应用。
- 同一个 `KernelDbOptions` 暴露 `readonly?: boolean`，又被 `Kernel.open` 和 `migrateDatabase` 直接接受。这样 public API 允许构造带 `write()` 的 readonly Kernel，或要求 readonly migrator；这与两个入口的语义冲突。

**Why it matters**

实现者无法同时满足当前接口、T5 和文字合同；最可能的结果是 runtime 测试通过，但 compile-time 禁令、tx budget 配置或 verbose 审计漏接。复用带 `readonly` 的内部连接类型也让已收紧的 public authority API 再次含糊。

**Suggested fix**

- 给 `write` 写出真实排除 PromiseLike 的 conditional/overload 类型，并加 `// @ts-expect-error` compile-time fixture，证明 async callback 在类型检查期被拒；
- 定义不含 `readonly` 的 public `KernelOpenOptions`（含 `path/busyTimeoutMs/synchronousMode/verbose/txBudgetMs`），内部另有带 `readonly` 的 connection options；
- `migrateDatabase` 使用明确的 writable migration options；backup 内部自行构造 readonly options；
- 行为合同明确 `new Database(..., { timeout, readonly, verbose })`，并按 `synchronousMode` 设置 PRAGMA；
- 校验 `txBudgetMs` 为有限正数，并用 monotonic clock 测量 transaction body。

### 3. [MEDIUM] “Object.keys 恰为全部白名单”测试按当前白名单不可执行

**Issue**

`plan.md:586-598` 把 runtime values 和 type-only exports 混在同一“全部 public exports”表中：

- `AgentIdentity` 是 type-only export，编译后不会出现在 `Object.keys(await import(...))`；
- `CasViolation / FenceViolation 等错误类型` 中的“等”不是精确集合，无法形成恰等断言；
- `Kernel.open` 参数引用的 public options 类型也未在类型导出合同中列清。

**Why it matters**

T5 所称“包导出恰为 §5.4 白名单”要么必然因 type erasure 失败，要么只能偷偷维护第二份未写入计划的 runtime 白名单，失去该测试防漂移的意义。

**Suggested fix**

把 §5.4 拆成两个穷举集合：

1. **runtime value exports**：供 `Object.keys()` 精确断言，逐个列出所有 error classes，不使用“等”；
2. **type-only exports**：`AgentIdentity`、public option/result types 等，用一个 consumer compile fixture 验证可导入，同时验证 `Database` 类型不可导入。

这样既能锁住 JavaScript surface，也不会把 TypeScript type erasure 当成运行时行为。

## Verdict

CHANGES REQUESTED — address items above
