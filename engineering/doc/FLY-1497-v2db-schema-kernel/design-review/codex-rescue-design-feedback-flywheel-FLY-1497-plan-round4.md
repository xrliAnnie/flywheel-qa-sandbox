# Design Review — plan.md (Round 4)
Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮固定在 HEAD `7ea6c99735a60473ae89a08a6db8b53939d8f752`（父提交为 Round 3 的 `ef0f20229e648c388c1673fad693efe1aeecbcdf`），工作树干净。范围冻结为 Round 3 的两个 HIGH 与一个 LOW，并检查这些修订的直接 failure-path。

Round 3 的 deep-import 与文字漂移问题已经关闭：

- §1.1 明确钉了只开放 `"."` 的 package `exports` map，没有 wildcard/subpath；
- 我用与计划相同的 built-package 结构实测：bare root import 成功，`/migrator`、`/connection`、`/backup`、`/dist/*` 均得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`；NodeNext consumer 的 root 类型解析与 deep-import 编译拒绝也通过；
- T2 已正确拆成 byte-for-byte 组与 D14 两处 `NOT NULL` 例外组；
- §0、§5.3 和 D6 的旧文字均已同步。

DDL 本轮没有回归：从当前 plan code blocks 重新执行 0001–0004，得到 17 表、13 个命名索引、`foreign_key_check=0`；v9 两段 canonical DDL 与归档原文的允许 diff 仍严格只有两处 `NOT NULL`。

Round 3 的 callback-throw 漏洞也已在 **wrapper 执行阶段**修正：`WriteTx` 在 normal/thenable/CAS/identity/user-throw 各出口都会失效，T5 c/d 足以覆盖 callback 抛错与后续 Kernel 可用性。

但当前 `finally` 放置层级仍漏掉 transaction wrapper 外的 BEGIN/COMMIT 阶段。better-sqlite3 的 transaction function 在调用用户 wrapper **之前**开始事务，在 wrapper 返回**之后**提交；因此 `wrapper { try/finally }` 不是整个 `.immediate()` invocation 的 finally。已知 `BEGIN IMMEDIATE` 会因竞争抛 `SQLITE_BUSY`，并且 `verbose` 会在 wrapper 前观察到 BEGIN。当前文本无法同时保证 nesting guard 在 BEGIN 前已经生效、BEGIN 失败后必复位、且一直保持到 COMMIT 完成。该问题仍会导致常见 contention 后 Kernel 被永久误判为 nested，或在 BEGIN/COMMIT 边界出现重入窗口，所以 Round 4 仍不能批准。

## What's Good (Keep)

- D16 的 root-only exports map 是正确的 package-level access control；`files:["dist"]` 也被准确描述为 publish manifest，而不是安全边界。
- consumer fixture 被要求针对 built package 和 bare specifier，而不是只测试 `src/index.ts` alias，这能真实覆盖 Node package resolution。
- root runtime allowlist、type-only allowlist、Database 不可导入以及 subpath 拒绝形成了互补的 API surface 合同。
- D17 已明确 callback 内部所有退出路径都要在传播异常前 invalidate `WriteTx`；escaped handle 的五个方法全部测死，覆盖充分。
- T5 d 正确验证 callback 异常不会让同一个 Kernel 永久不可写。
- D14 snapshot 分层后的验收文字已自洽；`KernelOpenOptions` 命名漂移全部消除。
- batch-1 仍然纯新增、零接线，没有进入消费、dispatcher、探针、告警或切换范围。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

### 1. [HIGH] nesting flag 的 `finally` 必须包住整个 `.immediate()` 调用，而不能只放在 wrapper 内

**Issue**

`plan.md:571-572` 的顺序是：

```ts
db.transaction(wrapper).immediate()

wrapper = () => {
  try {
    callback + thenable check + elapsed gate
  } finally {
    invalidate tx
    reset nesting flag
  }
}
```

better-sqlite3 的正式 transaction 合同是：transaction function 被调用时先开始事务，随后调用 wrapped function；wrapped function 返回后再 COMMIT，抛错则 ROLLBACK。参见 [better-sqlite3 API — transaction](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function)。

所以实际时序是：

```text
set/check nesting? → BEGIN IMMEDIATE → wrapper try/finally → COMMIT/ROLLBACK → immediate() returns/throws
```

仅靠 wrapper 内 finally 存在无法闭合的两难：

- 若 nesting flag 在 `.immediate()` 之前置 true，连接竞争导致 `BEGIN IMMEDIATE` 抛 `SQLITE_BUSY` 时 wrapper 根本未执行，flag 永远不复位；
- 若 nesting flag 到 wrapper 内才置 true，正式 `verbose` callback 已能在 BEGIN 阶段重入 `Kernel.write()`，而 guard 尚未生效；
- wrapper finally 在 COMMIT 前就复位 flag，也没有覆盖 COMMIT/ROLLBACK 阶段的 reentrancy/error boundary。

plan 已把 `SQLITE_BUSY` 与 verbose BEGIN 都列为实证能力，因此这不是理论上的不可达路径。

**Why it matters**

第一种实现会把一次正常的锁竞争升级成该 Kernel 实例永久 `nested write` 拒绝；第二种实现会在事务已经开始但 wrapper 尚未进入时允许同连接重入，可能退化成 savepoint 或 SQLite transaction-state 错误。两者都破坏“唯一 IMMEDIATE 写入口 + 禁嵌套”的结构性合同。

**Suggested fix**

把两个 cleanup responsibility 分层：

```ts
if (inWrite) throw new NestedWriteViolation(...);
inWrite = true;
try {
  return db.transaction(() => {
    const tx = makeWriteTx();
    try {
      return invokeCallbackAndRunThenableAndBudgetChecks(tx);
    } finally {
      tx.invalidate(); // callback 离开即失效，发生在 commit 前
    }
  }).immediate();
} finally {
  inWrite = false; // 覆盖 BEGIN、callback、COMMIT/ROLLBACK 的全部出口
}
```

并在 T5 增加：

1. 双连接：A 持有写锁，Kernel B 的 `write()` 在 BEGIN 阶段得到 `SQLITE_BUSY`；释放 A 后，同一 Kernel B 的下一次合法 write 成功；
2. `verbose` 在观察到 `BEGIN IMMEDIATE`（以及若实现可观测则 COMMIT）时尝试重入同一 Kernel，必须被 nesting guard 拒绝且不能产生 savepoint/写残留。

T5 c/d 保留：它们验证的是 wrapper/callback 出口；新增测试验证的是 transaction invocation 外层出口，两者不能互相替代。

## Verdict

CHANGES REQUESTED — address items above
