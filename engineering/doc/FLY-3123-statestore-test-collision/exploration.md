# FLY-3123 StateStore 测试夹具冲突 — 探索
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: 无

## 一句话结论

把 FLY-2919 新增测试里的 `StateStore.create(":memory:")` 换成同文件已采用的 `createGreenHandoffStore(":memory:")`，即可同时保留 FLY-2919 的断言和 FLY-2968 的绿色交接夹具语义。

## 问题是什么

`packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts` 在两个独立 PR 合入 `main` 后出现了组合故障：

- FLY-2968（PR #1408）把 `StateStore` 改成 `type StateStore`。类型导入只供 TypeScript 静态检查，运行测试时不会生成 JavaScript 变量。
- FLY-2919（PR #1379）随后加入测试 `FLY-2919 resolves an admitted wake on the original physical owner`，仍在运行时调用 `StateStore.create(":memory:")`。
- 单独看两个 PR 都能通过各自的 CI；合并后的测试执行到该调用时，因 `StateStore` 运行时变量不存在而抛出 `ReferenceError: StateStore is not defined`。

这不是生产流程错误，也不是不稳定测试。它是测试夹具初始化方式与类型导入之间的确定性冲突，并会让所有基于当前 `main` 合并结果运行 teamlead 单元测试分片的 PR 变红。

## 已确认的事实

1. Lead 提供的失败点为原文件第 5467 行，断言本身不需要改变。
2. FLY-2968 已在同文件引入 `createGreenHandoffStore`，用于构造满足绿色交接前置条件的内存 `StateStore`。
3. 生产仓库 PR #1425 的实现提交 `b3e0c1d37d18edb07552cda71ed4956becf6735a` 只把该测试的构造调用替换为 helper；该 PR 曾在精确头 `5ff88e1cb36e0e58c03b99a3c0e0b9f3dc7c54b9` 完整 `CI OK` 后合入。
4. PR #1430 随 FLY-3143 紧急回退了 FLY-2919 与 FLY-3123，当前生产 `origin/main` 因而保留目标文件但没有命名的 FLY-2919 测试；这不等于一行修复错误，而是整组功能暂时退出 main。
5. 开放中的 re-land PR #1431 在精确头 `d7d72733b101472bd82236b558906f9c90d0e4d4` 恢复该测试，并在第 5468 行保留 `createGreenHandoffStore(":memory:")`；完整 CI run `36841532431` 的 `CI OK` 已绿，单文件当前为 100/100。当前 QA-sandbox 工作树不携带该测试文件，因此本设计以生产源 checkout、PR 元数据和已保存历史为事实来源，不在 sandbox 伪造生产测试。

## 约束与目标

### 必须做到

- 只改目标测试的 store 初始化调用。
- 保留测试名称、输入、行为步骤和全部断言。
- 使用现有 `createGreenHandoffStore`，不新增第二套夹具词汇或配置路径。
- 用目标测试文件的单文件测试证明回归被消除。
- 用精确头完整 CI 证明改动没有破坏其他分片。

### 明确不做

- 不把 `StateStore` 恢复成运行时导入。
- 不修改生产 `StateStore`、交接流程、数据库结构或 feature flag。
- 不扩大到相邻测试的机械重写。
- 不改变 FLY-2919 所验证的 owner、wake 或幂等语义。
- 不运行 529；这是 tests-only 改动，QA 记录 `not_run` / `exempt_category=tests_only`。

## 方案比较

### 方案 A：使用现有绿色交接 helper（推荐）

把唯一的 `StateStore.create(":memory:")` 改为 `createGreenHandoffStore(":memory:")`。

- 优点：与 FLY-2968 在同文件建立的测试夹具契约一致；改动最小；保留类型导入；无需碰生产代码。
- 代价：测试依赖 helper 的绿色默认值，但这正是该文件其余测试已接受的统一语义。

### 方案 B：恢复 `StateStore` 运行时导入（拒绝）

让原调用重新可执行。

- 优点：表面上能消除 `ReferenceError`。
- 缺点：绕开 FLY-2968 建立的 helper，重新制造两套初始化语义；测试随后还可能因缺少绿色交接前置条件失败。

### 方案 C：在目标测试内手工设置绿色状态（拒绝）

直接构造 `StateStore`，再逐项写入 helper 已封装的前置条件。

- 优点：测试局部可见全部设置。
- 缺点：复制夹具逻辑，未来 helper 语义变化时容易漂移；扩大一行修复的维护面。

## 设计方向

采用方案 A。实现边界是一个调用点，验证边界是一个具体测试文件加精确头完整 CI。回滚也只需回退这一行；但回滚会立即恢复确定性 `ReferenceError`，因此只有在 helper 契约被后续显式替换时才有意义。

## 成功标准

- 目标测试不再引用被类型擦除的 `StateStore` 运行时值。
- `StateStore.generalized-execution.test.ts` 单文件全部通过。
- 精确 PR 头完整 CI 显示 `CI OK`。
- 代码 diff 限于目标测试的一行；断言零变化。
