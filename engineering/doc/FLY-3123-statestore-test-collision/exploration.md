# FLY-3123 StateStore 测试语义相撞 — 探索
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: 无

## 1. 问题一句话

两个各自 CI 全绿的 PR 在 main 上"语义相撞"：FLY-2968（#1408）把
`StateStore.generalized-execution.test.ts` 第 18 行改成**类型导入**
`import { isWorkflowProcessBodyParked, type StateStore } from "../StateStore.js";`，
而 FLY-2919（#1379）在同文件新增的测试
「FLY-2919 resolves an admitted wake on the original physical owner」仍调用
`await StateStore.create(":memory:")`。`type` 导入在编译后被擦除，运行时
`StateStore` 不存在 → `ReferenceError: StateStore is not defined`，
teamlead 单元测试分片确定性红，挡住所有 PR 的完整 CI。

## 2. 审计：本次重开时的真实状态（2026-10-01 核实，gh API 只读）

| 对象 | 状态 | 证据 |
|------|------|------|
| #1425 FLY-3123 修复 | **MERGED** 2026-09-30T21:08Z，头 `5ff88e1cb`，合入 `0d544f933` | 头上第 5467 行已是 `createGreenHandoffStore(":memory:")` |
| #1430 回退 FLY-2919 + FLY-3123 | **MERGED** 2026-10-01T00:31Z（因 FLY-3143 runner spawn/resume 回归） | 当前生产 main `e2997d2e9`：目标文件 5683 行，命名测试**不存在**，`StateStore.create(` 出现 0 次 |
| #1431 FLY-3143 re-land FLY-2919 | **OPEN**，头 `803ed4d13` | 命名测试在第 5467 行，第 5468 行已是 `createGreenHandoffStore(":memory:")`；teamlead 1–4 分片 pass |
| #1400 FLY-3041 | **OPEN**，头 `ef8eb5cf7` | 命名测试第 5469 行同样已是 helper 调用（Lead 裁定的同款改法） |

结论：**任务描述（2026-09-30 13:0x PDT 写的交接须知）已过期**。
"实现体检出 `flywheel-FLY-3123` 分支、核头 5ff88e1cb、请求同头复审、交卷"
所描述的 PR #1425 已经合入并随后被 #1430 整体回退；
生产 main 已不再有那条红测试，修复以 #1431 / #1400 的形式随 FLY-2919 一起"重新落地"。

## 3. 本工作树的事实

当前 design 工作树是 QA 沙箱仓库 `xrliAnnie/flywheel-qa-sandbox`，分支
`project-slot-3-FLY-3123`，派发头 `cd82e42e4`。该仓库里
`packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`
**不存在**（`git ls-files | grep generalized-execution` = 0），
`isWorkflowProcessBodyParked` / `createGreenHandoffStore` 也不存在。
因此在本工作树里**不可能、也不应该**伪造生产测试文件去"修一行"。

## 4. 受影响消费者

- 唯一需要的代码形态：命名测试内的 store 构造调用（一行）。
- 只读依赖：`helpers/handoff-proof.ts` 的 `createGreenHandoffStore`（真实内存 StateStore + 绿色交接证明），
  该 helper 已在文件第 36/37 行导入；同文件其余 76+ 处测试已用同一 helper（#1408 的统一改法）。
- 无生产代码、schema、迁移、持久化契约变化。

## 5. 歧义与处理

- **交接须知过期**：以生产 gh 事实为准，不按过期指令"请求同头复审 #1425"（已合入的 PR 没有可复审的在飞头）。
  在 plan 里给 implement 阶段写"按实际 checkout 分支判定"的决策表。
- **#1431 / #1400 谁先合**：两边改法字节一致，合 main 互不冲突（Lead 已裁定），本设计不干预。
