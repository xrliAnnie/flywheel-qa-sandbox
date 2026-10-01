# FLY-3123 StateStore 测试语义相撞 — 调研
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: exploration.md

## 1. 为什么"两个绿 PR"合起来会红

- GitHub 上每个 PR 的 CI 跑的是"PR 头 + 该 run 检出时的 main"的合并树。#1408 于 16:31:33Z 合入；
  #1379 的完整 CI 虽在 16:38:06Z 才整体结束，但其 teamlead 四分片在 16:13–16:19Z 就已检出并通过——
  看到的是 #1408 合入**之前**的 main。关键是检出/合并树生成时间，而不是 run 的最终结束时间。
- `import { type StateStore }`（TypeScript 内联 `type` 修饰符）
  只保留类型，编译到 JS 时整个绑定被擦除。用作类型（`let s: StateStore`）没问题，
  用作值（`StateStore.create(...)`）在运行时才炸。`tsc --noEmit` 会报 TS1361
  ("cannot be used as a value because it was imported using 'import type'")，
  但 vitest 走 esbuild 转译、不做类型检查，所以只有运行到这条测试才暴露。
- 这是典型的"语义合并冲突"：文本上无冲突，行为上冲突。

## 2. 候选修法对比

| 方案 | 做法 | 评价 |
|------|------|------|
| **A（采纳）** | 该测试改用 `createGreenHandoffStore(":memory:")` | 与 #1408 对本文件其余测试的改法一致（单一来源）；helper 内部仍是真实内存 StateStore，只额外装好绿色交接证明，不改断言含义；一行 diff |
| B | 把 `../StateStore.js` 的 `StateStore` 导入恢复为值导入 | 回退 #1408 的有意设计（#1408 刻意让本文件所有 store 都经 helper 创建，保证交接门有绿证明）；会让后续测试再次绕开 helper |
| C | 只在该测试内局部 `await import("../StateStore.js")` | 绕路、与文件风格不符，同样绕开交接证明 |
| D | 加 lint/tsc 门在 CI 抓 TS1361 | 有价值的防复发手段，但超出本 issue（simple_code、一行）范围 → 记为 follow-up 建议，不在本次实现 |

## 3. 方案 A 的语义安全性

`createGreenHandoffStore(path)` = `StateStore.create(path)` + 为需要通过交接的 completion/decision
安装精确 intent 的绿色证明。该命名测试验证的是"admitted wake 解析到原物理 owner"，
不依赖交接门被拒；装上绿色证明只会让交接相关前置条件成立，不改变被测断言。
#1425 精确头 `5ff88e1cb` 的完整 CI 已绿（交接须知记录的「CI OK」），#1431 头 `803ed4d13` teamlead 四分片 pass，
两次独立证据都说明断言在 helper 下保持成立。

## 4. 当前生产状态带来的约束

- 生产 main（`e2997d2e9`）已由 #1430 回退 FLY-2919，命名测试不存在 → main 在这一点上**已不红**。
- 修复以 #1431（re-land）与 #1400（FLY-3041）的形式存在，两边字节一致。
- 因此本 issue 剩余的工程动作是**验证**而非编码：确认任何携带命名测试的头都用 helper 调用。

## 5. 测试范围（本机只跑相关测试）

- 只跑单文件：`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.generalized-execution.test.ts`。不跑包级/全仓套件。
- 完整 CI 只看精确头的 GitHub Actions 结论，不在本机复现。
- 529 真机 QA：只改测试、不改运行中流程 → `not_run`，`exempt_category=tests_only`；豁免只覆盖本 issue 这一行，不替代 #1431 / #1400 的 QA。
