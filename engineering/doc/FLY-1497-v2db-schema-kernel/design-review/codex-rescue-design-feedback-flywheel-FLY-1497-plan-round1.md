# Design Review — plan.md (Round 1)
Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮按当前 HEAD `f951c5e31f95f2b2d2a8dfa0c956e26fd8d12613` 审查，范围严格限定为 FLY-1497 batch-1，不重审 R13 已批准的总体设计。

计划的总体拆分、四段迁移链、17 表/13 个设计命名索引台账、真实双连接测试方向和 batch-1 零接线边界都是正确的。逐字核验也确认：七条 mailbox 索引语句、F1/F2/N1/N2 以及 detector SQL 的语句主体与设计链原文一致；仓库的 `better-sqlite3 ^12.8.0`、pnpm workspace、Biome、Vitest 和 `packages/token-usage` 脚手架主张均有源码支持。

但目前仍有会把错误结构固化给 batch 2-3 的阻断项：`thread_bindings` 改写了批准设计的显式主键；async 写回调的提交窗口没有被正确钉死；层级/依赖触发器可由 UPDATE 绕过；0002 的最终 trigger 集合及失败恢复没有完整进入迁移合同；runner generation fence 缺少 approved design 要求的 activation 身份。故本轮不能批准实施。

## What's Good (Keep)

- 保持 `packages/v2-kernel` 纯新增、零生产接线，边界与 Linear issue 的 batch-1 范围一致。
- `0001 → 0002 obligations rebuild → 0003 activations/processing_attempts → 0004 mailbox indexes` 的顺序合理；0002 在 DROP/RENAME 前先移除挂在 tasks/attempts 上的 tombstone triggers，符合 SQLite 全 schema 重解析行为和本轮已给的真实 spike。
- 七个 mailbox partial indexes、四条候选 SELECT、detector SQL 的实现语句与 `design-v9.md` / `design-v10.md` / `design-v8.md` 对应原文一致，五路 EQP 测试直接使用生产常量的做法应保留。
- 13 个设计命名索引的存在性台账比 Linear 描述中的“9 个索引”更完整，且没有错误地把 `sqlite_autoindex_*` 纳入按名合同。
- `pa_one_running`、activation 双 partial unique、CAS changes 校验、真双连接 `SQLITE_BUSY`/约束测试均对准了后续批次最重要的并发基元。
- `foreign_keys` 必须在事务外切换、迁移记账与 DDL 同事务、checksum 不一致 fail-loud、WAL-safe online backup 等方向正确。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

### 1. [HIGH] `thread_bindings` 的 `[落地]` 决策改写了批准设计，而不是消除歧义

**Issue**

`design-chain/design-final.md:27` 明确写的是 `canonical_key=lineage_root_id PK`，同时保留 partial unique。计划在 `plan.md:311-318` 删除了该 PK，改成允许同一 lineage_root 存在多条 archived 历史行。

“partial UNIQUE active 存在”并不逻辑蕴含“必须允许多行”；它完全可以是对 PK 的冗余防御。当前计划选择的是一种新的多行生命周期语义，而不是对原文的机械展开。

**Why it matters**

batch 2-3 按 lineage root 查 canonical thread 时会从“恰一行”变成“可能多行”。计划没有定义历史行主键、排序、重绑规则或所有查询必须带 `state='active'` 的合同，容易产生多结果、错误归档或错误继承。

**Suggested fix**

按已批准文本落地：

```sql
CREATE TABLE thread_bindings (
  lineage_root_id TEXT PRIMARY KEY REFERENCES tasks(id),
  thread_id       TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL CHECK(state IN ('active','archived'))
);
```

若索引台账要求，保留冗余的 `thread_bindings_one_active`。如果确实需要 archived 多行历史，先把它作为对 authority design 的显式修订，补齐稳定行 ID、canonical selection 和 rebind 状态机后再落地；不能以 `[落地]` 名义静默改变。

### 2. [HIGH] async 回调可能“事务已提交后才抛错”

**Issue**

`plan.md:498` 同时规定 `write() = db.transaction(fn).immediate()` 和“返回 Promise 即抛错”，但没有规定 thenable 检查必须发生在 transaction wrapper **内部、返回之前**。

better-sqlite3 的正式 API 文档明确说明：transaction function 一返回就提交；async function 在第一个 `await` 处先返回 Promise，因此事务会在后续 async 代码执行前已经提交。仅在 `.immediate()` 返回后检查 Promise 会先提交回调在第一个 `await` 前做的写，再抛错，直接违反“异步回调拒绝且零残留”。参考 [better-sqlite3 transaction caveat](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function)。

**Why it matters**

这会把计划用来结构性禁止事务内网络/LLM 的核心保护变成假保护；调用者看到异常，但数据库中可能已经存在部分业务效果。

**Suggested fix**

- 在调用前拒绝声明为 `AsyncFunction` 的回调；
- 在 `db.transaction(() => { ... })` 的函数体内调用用户回调，并在该函数体返回前检查 `PromiseLike`；发现 thenable 时立刻 throw，使 better-sqlite3 回滚；
- `WriteTx` 加 transaction-lifetime guard，回调一返回即失效，防止 `await` 后的 continuation 再用旧 tx 在事务外写库；
- 类型签名排除 `PromiseLike` 返回值；
- T5 增加两条实测：async 回调在首个 `await` 前先 INSERT，最终仍为零行；`await` 后再次 `tx.run` 也必须失败且零写入。

### 3. [HIGH] 两组结构不变量可通过 UPDATE 绕过

**Issue**

- `command_dependencies_no_cycle` 仅是 `BEFORE INSERT`（`plan.md:199-208`）。已存在的边可通过 UPDATE 改成环。
- `obligations_parent_depth` / `obligations_inherit_root` 也仅是 `BEFORE INSERT`（`plan.md:260-267`）。合法 child 插入后，可以 UPDATE 到 depth=1 parent，或改成不继承 parent root；行内 CHECK 与 FK 都不会阻止。

本轮用 SQLite 3.51.0 对计划文本做了最小复现：`a→b, b→c` 可 UPDATE 成 `a→b, b→a`；合法 obligation child 可 UPDATE 为挂在另一个 depth=1 child 下并同时改掉 `root_episode_id`，两者均成功。

**Why it matters**

这些是设计要求由 schema/trigger 机器化的结构不变量。未来业务代码即使都经过 `Kernel.write`，仍可用普通 UPDATE 写出永久坏账；`PRAGMA foreign_key_check` 也不会发现这些逻辑违规。

**Suggested fix**

为相同字段补 `BEFORE UPDATE OF ...` 版本的校验 trigger；或者把依赖边、obligation 的 parent/depth/root 定义为创建后不可变，任何 UPDATE 直接 abort，变更只能 delete+insert。测试必须同时覆盖 INSERT 和 UPDATE 两条旁路。

### 4. [HIGH] 0002 的可执行文本、checksum 边界和失败恢复未闭合

**Issue**

`plan.md:344-384` 的 0002 SQL literal 在重建 `obligations_episode_open` 后结束，四个最终 triggers 只在 `plan.md:386-388` 以“按 0001 文本重建”描述，没有进入明确的 `Migration.ddl`。但 `plan.md:68-74` 又定义 checksum 对象只有 `ddl`。照“从本 plan 复制 DDL”实施，trigger 重建可能落在 checksum 外，甚至被漏掉。

同时，`plan.md:88` 只描述 `OFF → transaction → ON` 的成功序列，没有要求 `PRAGMA foreign_keys=ON` 必须在 `finally` 中恢复。若 DDL、copy、trigger recreation 或 `foreign_key_check` 抛错，复用该连接可能继续处于 FK OFF。仓库现有 rebuild migration 已使用 `try/finally` 恢复（例如 `packages/teamlead/src/StateStore.ts:1675-1816`），SQLite 官方程序也要求事务外重新启用 FK。参考 [SQLite ALTER TABLE rebuild procedure](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes) 和 [SQLite foreign_keys pragma](https://www.sqlite.org/foreignkeys.html#fk_enable)。

**Why it matters**

漏 trigger 会让新库表面上 17 表/FK clean，但缺少终态 tombstone 和层级保护。失败后 FK 留在 OFF 则会污染后续迁移或测试，产生很难定位的静默坏库。

**Suggested fix**

- 把 0002 的四个最终 `CREATE TRIGGER` 全文放入同一个 canonical `ddl`，与表重建和索引一起 checksum；
- `fkMode:'rebuild'` 必须捕获原 FK 状态、要求入口为 1，并用 `finally` 在事务外恢复且再次断言为 1；
- 每个 migration 在取得 `BEGIN IMMEDIATE` 后重新读取 `schema_migrations`，避免并发 migrator 都在锁前判断“未应用”；
- 增加语法错误中途失败、`foreign_key_check` 非空、trigger recreation 失败、双连接同时 migrate 四类测试，均断言 schema/记账原子回滚且 FK 最终为 1。

### 5. [HIGH] runner fence 骨架缺少批准设计要求的 `activation_id`

**Issue**

`plan.md:493,501` 的 `requireGeneration` 只比较 `{instanceId, generation}`。但 `design-chain/design-v8.md:35` 明确要求 processing-attempt start 校验当前 `{instance_id,generation,activation_id}`；`design-chain/design-v7.md:33` 也给出了 consumer registry 的 `kind` 与 runner `activation_id` 形状。

**Why it matters**

batch 1 的目标是给 batch 2 提供不可绕过的 fence 原语。如果现在把 registry JSON 和 helper 固化成二字段，batch 2 要么再破坏 API/迁移，要么无法证明处理尝试绑定当前 activation。仅检查 generation 不是 approved start fence 的完整实现。

**Suggested fix**

现在就钉死 discriminated registry schema，例如 lead 与 runner 两种 entry；runner entry 必含 `agent_id/kind/instance_id/generation/activation_id`。`requireGeneration` 应按 kind 比较全部身份字段，malformed JSON、缺字段、错误 kind、activation mismatch 均 fail-closed，并加入测试。registry key 的 `:` 分隔也是实现决策，应标 `[落地]` 并只保留一个 canonical helper。

### 6. [MEDIUM] “唯一写库入口”仍是可旁路的口头/API 合同

**Issue**

计划同时出现：

- `openKernelDb()` 返回原始 `Database`（`plan.md:50-64`）；
- `Kernel` 的 public constructor 接收原始 `Database`（`plan.md:483-486`）；
- migrator/backup 也接收原始 `Database`；
- 又声称包导出面不暴露写句柄（`plan.md:502`）。

`index.ts` 的实际 export allowlist 未定义。源码 grep “kernel.ts 外无 `.transaction(`”也不充分：`.prepare(...).run()`、`.exec()`、手写 `BEGIN` 都能写；而 migrator 本身又是必要的 kernel 外 schema writer。

**Why it matters**

batch 2 接线时一旦把 factory 或 raw DB 暴露出去，调用方可绕过 CAS、fence 和 IMMEDIATE 纪律。此后再收口会成为破坏性 API 变更。

**Suggested fix**

在 plan 中明确 `index.ts` 的 public exports：对生产消费者只提供按 path 创建、内部持有私有连接的 `Kernel.open(...)`（或 factory）；不导出 writable `Database`、不公开 `Kernel(Database)`。只读访问使用独立 opaque/read API。migrator 与 backup 明确为 bootstrap/maintenance 例外并保持 internal。用 API/export 测试或架构 lint 验证边界，不以字符串 grep 代替。

### 7. [MEDIUM] 两张新增表的 “verbatim SQL” 声明不成立

**Issue**

七索引、四候选和 detector 的 SQL 语句逐字比对通过；但 `plan.md:392-418` 声称 `activations` / `processing_attempts` 为 design-v9 DDL 原文，实际与 `design-chain/design-v9.md:12-24,64-72` 不同，包括 `CREATE TABLE name(` 被改成 `name (`、列对齐、`UNIQUE(` 空格、partial predicate 的 `state='active'` / `outcome='running'` 被改写为带空格形式，并插入了行尾评论。

这些变化当前没有改变 SQLite 语义，但违反了本轮明确的 byte-for-byte 核验合同，也会使以后基于文本 hash/snapshot 的 drift check 失真。

**Why it matters**

本 issue 特别要求“设计给出的 SQL 原文不得改写”。不能一边把格式化后的等价 SQL 称为原文，一边把 migration checksum 作为不可变合同。

**Suggested fix**

把 v9 两个 code block 原样复制为 canonical constants；实现、checksum 和 snapshot test 均使用同一文本。说明性注释放在 SQL string 外。若团队决定只要求语义等价，则必须先把 plan 的“逐字/原样”声明和本轮验收口径统一修改，不能保留错误断言。

### 8. [MEDIUM] 测试矩阵没有证明“17 表 DDL 的 CHECK/FK/trigger 合同”及“短事务”

**Issue**

T1 主要检查表数、索引、FK clean 和 checksum；T4 覆盖 obligations 的部分语义。计划没有系统测试 tasks self-rework、events UPDATE 禁止、command dependency 环、各关键 CHECK/UNIQUE、trigger 名称全集，也没有 UPDATE 旁路测试。

此外，Linear 验收中的“短事务”在 T5 被等同于“回调同步”。同步回调仍可执行 `readFileSync`、`execFileSync` 或任意长 CPU 工作；当前接口和测试都没有可测的时长合同。`KernelDbOptions` 也未包含 `plan.md:62` 承诺的 synchronous override 或 `plan.md:522` 需要的 verbose hook。

**Why it matters**

DDL 对象“存在”不等于约束“生效”；async 禁令也不等于短事务。当前矩阵可能在结构保护缺失时全绿。

**Suggested fix**

- 增加 schema-contract test：断言全部命名 triggers/indexes 存在，并对每个非平凡 CHECK/FK/trigger 做正反例；
- 增加本报告第 2、3、4 项的失败路径回归；
- 对“短事务”给出诚实、可测的合同：至少 transaction 内 elapsed 超预算在 commit 前 fail/rollback 并记录 label；同时明确同步 I/O 仍由 API 限制/静态规则禁止；
- 补齐 options 类型（或删除“可覆盖”承诺），让 verbose 与 synchronous 的测试注入路径成为正式合同。

### 9. [MEDIUM] backup 的在线一致性验证和文件安全合同不完整

**Issue**

`plan.md:532-534` 在 online backup 完成后将副本每表 count 与“源库当前 count”比较。better-sqlite3 明确允许备份期间继续写，同连接写会进入备份、其他连接写会使备份重启；备份完成到源 count 查询之间仍可继续写。因此，一个完全正确的一致快照也可能因源库随后新增行而被误判并删除。参考 [better-sqlite3 backup API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise)。

计划也没有钉 dest parent/file mode、失败时只删除“本调用创建的文件”、验证连接关闭顺序，以及 exists-check 到创建之间的 TOCTOU。

**Why it matters**

这会把健康备份误报为损坏；权限或清理处理不严还可能泄露权威账本副本，或误删竞争者刚创建的同名文件。

**Suggested fix**

二选一明确合同：

1. 若只服务 §4 stop-the-world：要求调用方先 quiesce kernel writes，并在测试中证明该前置条件；
2. 若支持在线备份：不要把副本与另一个时刻的 live source count 作强相等断言；改为验证副本 `integrity_check`、`foreign_key_check`、schema migration set，并通过同一稳定 snapshot/manifest 做逻辑核对。

同时使用本调用独占的临时目标，设 0600、验证后原子发布到最终路径；只清理由本调用拥有的临时文件，并补 failure cleanup、权限和并发写测试。

## Verdict

CHANGES REQUESTED — address items above
