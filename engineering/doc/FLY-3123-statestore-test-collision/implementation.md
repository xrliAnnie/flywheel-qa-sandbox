# FLY-3123 StateStore 测试夹具冲突 — 实施记录
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: plan.md

## 结论

本 implementation checkout 是 `xrliAnnie/flywheel-qa-sandbox` 的
`project-slot-2-FLY-3123`，不包含生产仓库的
`packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`。按已批准计划的
checkout 分支规则，本阶段没有在 sandbox 伪造生产测试、没有单独补回 FLY-2919，也没有创建空代码提交。

生产修复仍由开放中的 Flywheel PR #1431 携带：精确头
`d7d72733b101472bd82236b558906f9c90d0e4d4` 的目标用例在第 5468 行调用
`createGreenHandoffStore(":memory:")`，而第 19 行继续把 `StateStore` 保持为纯类型导入。

## Task 1：checkout 与选测发现

- 根仓：`https://github.com/xrliAnnie/flywheel-qa-sandbox.git`
- 分支：`project-slot-2-FLY-3123`
- implementation 起始头：`bfbb20731636fd3872a8807d894a6de52ffb8b70`
- 目标生产测试文件：不存在，因此目标用例搜索按计划跳过。
- 旧 literal `StateStore.create(":memory:")` 在 sandbox 的多个既有测试中出现；这些都是各自独立的构造消费者，不执行或导入缺席的目标用例，全部排除。
- 新 literal `createGreenHandoffStore(":memory:")` 在 sandbox 中无命中，进一步确认该 checkout 没有生产 FLY-2968 helper 及其消费者。
- 完整路径和文件名只命中文档目录；父目录 literal 命中的是历史文档、测试清单和其他独立测试，不是本回归的执行消费者，全部排除。

## Task 2：最小修复核对

原生产 PR #1425 的目标文件 patch 是一行删除和一行新增：

```diff
-const store = await StateStore.create(":memory:");
+const store = await createGreenHandoffStore(":memory:");
```

PR #1425 已于 2026-09-30 合入，随后 PR #1430 连同 FLY-2919 整组回退。当前 re-land
PR #1431 在精确头 `d7d72733b` 恢复该测试并保留同一 helper 调用。远端原文件核对结果：

- `StateStore` 仍是 `type StateStore`，没有恢复运行时导入；
- 命名用例仍是 `FLY-2919 resolves an admitted wake on the original physical owner`；
- store 初始化使用 `createGreenHandoffStore(":memory:")`；
- 后续 run、admission、wake 与 owner 断言没有被 FLY-3123 改写。

远端 `helpers/handoff-proof.ts` 也确认 helper 会先创建真实内存 `StateStore`，仅当 completion
或 decision 明确以 `handoff_proof_required` 拒绝时，按 Store 推导的精确 intent 安装绿色证明并重试。
这与目标用例的正向 handoff 语义一致，且不会把其他拒绝无条件放行。

## Task 3：验证证据

### 本地

以下两条均记为 `not_run`：

```text
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.generalized-execution.test.ts
pnpm --filter flywheel-teamlead exec vitest related src/__tests__/StateStore.generalized-execution.test.ts --run
```

原因是当前根仓没有该文件。运行目录、glob、包级套件或无关 literal 消费者都不能替代具体文件选择；批准计划也明确禁止在 sandbox 伪造生产测试。

### 生产精确头

- PR：`xrliAnnie/flywheel#1431`
- head：`d7d72733b101472bd82236b558906f9c90d0e4d4`
- CI run：`36841532431`，`headSha` 与上述 head 一致，状态 `completed/success`
- 目标文件：`StateStore.generalized-execution.test.ts`，100 tests 通过（teamlead shard 4）
- teamlead shards 1–4：全部 `completed/success`
- 汇总门：`CI OK`，`completed/success`
- 代码评审：PR #1431 的 literal-last milestone 记录 R1–R3 finding 均修复、R4
  `APPROVED`，并完成一轮精确头评审；本阶段没有改变该生产头。

## QA 交接

QA 只需核对三项：

1. 生产载体中的变化仍是目标测试一行 helper 替换，断言未改；
2. 目标测试文件在精确头上 100/100 通过；
3. 同一精确头的完整 CI `CI OK`。

`529=not_run`，`exempt_category=tests_only`。本任务没有生产流程代码变化，因此没有新增
queued / started / dead / superseded / retried / concurrent 测试；这些相邻状态路径由该精确头现有的
100-test generalized-execution 文件覆盖，本阶段不重复或扩写测试。

## 有意未做

- 未在 sandbox 新建目标测试或 helper；
- 未把已由 #1430 回退的 FLY-2919 用例单独补回 main；
- 未重跑已经冻结并全绿的生产完整 CI；
- 未运行 529；
- 未修改生产代码、schema、断言或 feature flag。
