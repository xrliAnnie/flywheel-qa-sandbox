# Design Review — plan.md (Round 3)
Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮固定在 HEAD `ef0f20229e648c388c1673fad693efe1aeecbcdf`（父提交为 Round 2 的 `b458585a07d3785aa7ca43873b5ab010403c0861`），工作树干净。审查范围冻结为 Round 2 的 3 个编号项及其直接回归风险；没有重开已 R13 APPROVED 的总体设计。

Round 2 的三个核心修复都已真实进入 plan：

- 11 张最终 textual-PK 表的主键列均显式 `NOT NULL`；0001 与 0002 的 obligations 两个阶段也一致；
- v9 两段 DDL 与归档原文的 diff 经逐字复核，确实只增加了 `activations.id` 与 `processing_attempts.attempt_uid` 两处 `NOT NULL`；
- `KernelOpenOptions` / `MigrateOptions` / internal readonly options 已分离，`txBudgetMs`、`verbose`、`synchronousMode` 和 monotonic elapsed 合同已落到接口与行为条款；
- 当前仓库 TypeScript 编译器实测证明 `SyncOnly<T>` 签名会拒绝 async callback、直接 Promise callback 和预先声明的 Promise-returning callback；
- runtime exports 与 type-only exports 已拆开，并给出了穷举的 root export 集合。

我还直接从 plan 的 SQL code blocks 拼接执行了完整 0001–0004 链：结果为 17 张非 `sqlite_%` 表、13 个命名索引、`foreign_key_check=0`；11 个 textual PK 的 `PRAGMA table_info` 均为 `pk=1, notnull=1`。因此 Round 2 的 NULL-PK blocker 已关闭。

但导出面目前只收紧了 `index.ts` root exports，没有在 `package.json` 钉 root-only `exports` map。按计划参照的 `packages/token-usage` 脚手架，未声明 `exports` 时编译后的 `dist/migrator.js`、`dist/backup.js` 等仍可被 package subpath deep-import；`Object.keys(import(root))` 测试检测不到这一旁路。这会重新暴露接受 raw `Database` 的内部迁移 API，破坏计划自己声明的“唯一写库入口是 API 结构”。此外，transaction wrapper 对 callback 抛错的清理合同仍未明确使用 `finally`，也没有异常退出后 escaped `WriteTx` 失效及下一次 write 可用的测试。两项都属于 authority-boundary/failure-path 缺口，故本轮仍不能批准。

## What's Good (Keep)

- D14 以显式、可审计的 SQLite 方言修正案处理 PK-NULL quirk，同时不篡改归档设计链；plan canonical 与 archive 的允许差异被限制为两处。
- textual PK 的覆盖完整：`schema_migrations`、tasks、attempts、commands、gates、capabilities、obligations、thread_bindings、meta、activations、processing_attempts 均已显式 `NOT NULL`。
- T7 要求 INSERT NULL 与 UPDATE-to-NULL 两类负例，比只检查 `PRAGMA table_info` 更能防实现回归。
- `KernelOpenOptions` 不再暴露 `readonly`；migrator 固定 writable，backup 的 readonly 只留在内部连接层，public authority semantics 清晰。
- `SyncOnly<T>` 的具体签名可在本仓 TypeScript 版本下工作；运行时 thenable 检查仍保留，能覆盖 `any`、JavaScript 和类型绕过。
- `busyTimeoutMs` / `txBudgetMs` 的有限正数校验及 `performance.now()` 计时合同明确。
- root runtime value allowlist 已经可形成真正的精确 `Object.keys` 断言；type-only surface 也改由 consumer compile fixture 验证。
- batch-1 仍保持纯新增、零接线，没有越界实现消费循环、dispatcher、探针、告警或切换。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

### 1. [HIGH] `index.ts` 白名单没有封住 package subpath deep-import

**Issue**

`plan.md:592-612` 把 public surface 定义成 `index.ts` 的 root allowlist，并声明 `openKernelDb`、`runMigrations(db)` 及 connection/migrator/backup 模块本身“不导出”。但 `plan.md:19-47` 的 package scaffold 没有要求 `package.json` 提供 root-only `"exports"` map。

仓内被指定为脚手架参照的 `packages/token-usage/package.json` 只有 `main`、`types` 和 `files:["dist"]`，没有 `exports`。若 v2-kernel 照此落地，Node/package resolution 允许消费者 deep-import 已发布的 `dist/*` subpaths。特别是：

- `migrator.ts` 的内部 `runMigrations(db, ...)` 接受 raw `Database`；
- `backup.ts`、migration constants 及其他内部模块也可绕过 root allowlist；
- T5 的 `Object.keys(await import('flywheel-v2-kernel'))` 只检查 root module，无法发现 `flywheel-v2-kernel/dist/migrator.js` 或等价 subpath 可导入。

**Why it matters**

这是 Round 2 导出面问题的剩余结构性旁路。batch 2–3 一旦通过 subpath 直接拿内部 API，就能绕过 `Kernel.open` / `Kernel.write`、自行持有连接或执行 migration 级 SQL。源码 grep 作为次级防线不能替代 package-resolution 边界。

**Suggested fix**

- 在 §1 的 `package.json` 合同中明确 root-only exports，例如只开放 `"."` 的 `types` 与 `import` target，不提供 wildcard 或内部 subpath；
- `files:["dist"]` 可保留，但不能把它误当成 subpath access control；
- consumer fixture 必须针对**构建后的包/bare specifier**验证：
  1. root runtime/type allowlist 正常；
  2. `flywheel-v2-kernel/migrator`、`/connection`、`/backup` 及 `/dist/...` 均在类型检查或运行时被 `ERR_PACKAGE_PATH_NOT_EXPORTED` 拒绝；
- 若还要约束 monorepo 内的相对源码 import，再增加跨包 import 扫描或 lint 规则；不要把只扫描 v2-kernel 包内源码写成完整防线。

### 2. [HIGH] callback 抛错时的 `WriteTx` 失效与嵌套状态复位没有合同或测试

**Issue**

`plan.md:558` 只规定“回调返回后 tx 句柄立刻失效”，T5 也只覆盖 async/thenable 的正常返回后 continuation。计划没有明确 callback **抛错**时也必须在 `finally` 中：

1. 使本次 `WriteTx` handle 失效；
2. 清除 Kernel 的 `inWrite`/嵌套保护状态。

反例：

```ts
let escaped: WriteTx;
expect(() => kernel.write('boom', tx => {
  escaped = tx;
  tx.run(...);
  throw new Error('boom');
})).toThrow();

// 若 active flag 没在 finally 清掉，这里会在事务外写库。
escaped!.run(...);
```

同理，若 `inWrite` 只在正常返回时复位，一次业务异常会让该 Kernel 实例永久把后续 write 误判为嵌套。

**Why it matters**

前者是 immediate transaction 之外的 raw write 旁路，直接破坏单写纪律；后者会把一次可预期的业务/CAS 异常升级为 Kernel 永久不可写。事务失败是正常控制流，不能依赖实现者自行猜测 cleanup 顺序。

**Suggested fix**

- 把 wrapper 合同明确写成 `try/finally`：无论 callback 正常返回、返回 thenable、CAS/identity 抛错还是用户 callback 抛错，都先 invalidate tx handle 并复位 nesting state，再向外传播异常；
- T5 增加两个对抗测试：
  1. callback 保存 tx、执行前序 INSERT 后抛错；事务零残留，随后 escaped tx 的 `run/get/all/cas/requireIdentity` 全部抛 `TxLifecycleViolation`；
  2. 一次 callback 异常后，同一 Kernel 的下一次合法 `write()` 成功，证明 nesting flag 已复位。

### 3. [LOW] D14 snapshot 与新类型名仍有三处文字合同漂移

**Issue**

- `plan.md:474` 正确要求 v9 两表 snapshot 的 diff 恰为两处 `NOT NULL`，但 T2（`plan.md:632`）仍写“常量文本与 design-chain 原文逐字一致（§3.3 逐字合同）”。对 §3.3 migration constants 而言这与 D14 不可能同时成立。
- `plan.md:588` 仍称 `KernelDbOptions.verbose`，D6（`plan.md:661`）仍称 `KernelDbOptions`；该类型已被 `KernelOpenOptions` 取代。
- §0（`plan.md:14`）仍无例外地声明所有设计 SQL 原文“原样复制”，而 §3.3/D14 已正当地定义一个两处差异的显式例外。

**Why it matters**

这些不构成新的运行时设计缺陷，但会让实现者和测试作者面对互相冲突的验收文字，尤其可能把 D14 snapshot 写成必红测试或静默放宽成任意 diff。

**Suggested fix**

- T2 拆清两类合同：candidate/index/detector 仍 byte-for-byte；v9 两表只允许精确的两处 `NOT NULL` insertion；
- 将两处 `KernelDbOptions` 改为 `KernelOpenOptions`；
- §0 的 verbatim 总则显式注明 D14 是唯一例外。

## Verdict

CHANGES REQUESTED — address items above
