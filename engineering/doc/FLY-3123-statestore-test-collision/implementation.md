# FLY-3123 StateStore 测试语义相撞 — 实施证据
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: plan.md

## 结论

本轮严格执行批准计划的“验证 / 交接”分支，没有修改生产代码，也没有给已经合入、随后被
回退的 #1425 追加提交。当前有效载体 #1431 的精确头
`803ed4d131d242f3b17c7aa88d702e2ee4e56fd5` 满足一行修法，目标单文件在该头本机
`114/114` 通过，且该头完整 CI 为 `CI OK`。

根工作树是 `xrliAnnie/flywheel-qa-sandbox`，不含目标文件。生产仓只读 checkout 按协议放在
`.flywheel/review-targets/flywheel/`，其 origin 为 `https://github.com/xrliAnnie/flywheel.git`；
该目录被根仓 `.git/info/exclude` 排除。

## 当前状态重新核实

| 对象 | 当前状态 | 精确头 / merge 头 | 结论 |
| --- | --- | --- | --- |
| 生产 main | `e2997d2e9491007145778aed3a3f3a44b652f893` | main HEAD | 目标文件存在，命名测试 0 处，旧构造 0 处；碰撞在 main 上当前不适用 |
| #1425 | MERGED 2026-09-30T21:08:22Z | head `5ff88e1cb36e0e58c03b99a3c0e0b9f3dc7c54b9`; merge `0d544f933464d40943abea0accafdee351e02769` | 本 issue 原修复已经合入，随后被 #1430 整体回退 |
| #1430 | MERGED 2026-10-01T00:31:30Z | head `9e36afbc626849f4be57de44aa15589ac1e13cc7`; merge `be24a1b57345291e3558c6afd8ac6c1a6fbb3eac` | 回退 FLY-2919 与 FLY-3123 |
| #1431 | OPEN、MERGEABLE / CLEAN | `803ed4d131d242f3b17c7aa88d702e2ee4e56fd5` | 当前有效 re-land 载体；一行修法、单文件与完整 CI 均通过 |
| #1400 | OPEN、CONFLICTING / DIRTY | `ef8eb5cf72b0d42badbb0af9e718f6c32143c30a` | 历史载体同样含正确一行，但当前不可合并；由 FLY-3041 所属 issue 处理冲突 |

## Task 1：构造与导入语义

对 #1425、#1431、#1400 三个固定头逐一读取
`packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`：

- 命名测试 `FLY-2919 resolves an admitted wake on the original physical owner` 均恰好 1 处。
- `StateStore` 均由 `../StateStore.js` 以 `type StateStore` 导入，不存在运行时绑定。
- `createGreenHandoffStore` 均由 `./helpers/handoff-proof.js` 以值导入。
- 命名测试内构造均恰好为 `createGreenHandoffStore(":memory:")`。
- 三个文件的 `StateStore.create(` 计数均为 0。
- 将 #1379 原头 `b9777db5e34c0147c86f05857b400cee4bb026ca` 的命名测试块仅归一化
  `StateStore.create(":memory:")` 为 helper 后，四个头的测试块 SHA-256 都是
  `01e266ff8d14f3e794fa290098c594fd71968787b0c42e02814a4320f017e7ab`；因此断言、
  activation 切换、物理 owner 检查与 `finally { store.close(); }` 未被这行修复改动。

决策表命中“已修复”分支，不存在需要另行报告的“碰撞形态”或“不匹配”头。

## 本机定向验证（#1431 精确头）

执行目录：`.flywheel/review-targets/flywheel/`，HEAD：
`803ed4d131d242f3b17c7aa88d702e2ee4e56fd5`。

1. `pnpm install --frozen-lockfile`：exit 0。
2. 首次单文件命令在收集前失败：`flywheel-config` 的 package export 指向尚未生成的
   `dist/index.js`；0 tests executed。这是新 checkout 未构建 workspace 依赖，不是目标测试失败。
3. 按仓库 CI 与本地测试政策运行
   `pnpm --filter "flywheel-teamlead..." build`：13 个受影响包及依赖构建成功，exit 0。
4. `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.generalized-execution.test.ts`：
   1 file passed，114 tests passed，0 failed，exit 0；无 `ReferenceError`。
5. 政策要求的
   `pnpm --filter flywheel-teamlead exec vitest related src/__tests__/StateStore.generalized-execution.test.ts --run`：
   只选择同一文件，114 tests passed，0 failed，exit 0。
6. `pnpm lint`：exit 0；仓库既有 26 warnings，无 error、无自动修复。

### 测试发现与排除

- 已执行旧字面量发现：`git grep -lF -- 'StateStore.create(":memory:")'`。
  它匹配大量既有测试 / 文档 / harness，因为这是仓库通用构造调用；这些匹配均不含命名
  FLY-2919 场景，故不属于本次单行替换的消费者，统一排除。
- 已执行新字面量发现：`git grep -lF -- 'createGreenHandoffStore(":memory:")'`，共 9 个测试文件。
  除目标文件外的 8 个文件不含命名 FLY-2919 测试，均排除；目标文件保留并执行。
- 已搜索变更文件完整路径、文件名与父目录字面量；命中均是过程文档 / 测试清单引用，没有
  额外运行时消费者测试。精确测试名全仓只命中目标文件 1 次。
- 未运行任何包级或全仓测试套件。

## 精确头完整 CI

| PR | head SHA | run / attempt | teamlead 分片 | 聚合结论 |
| --- | --- | --- | --- | --- |
| #1431 | `803ed4d131d242f3b17c7aa88d702e2ee4e56fd5` | [36866557125 / 1](https://github.com/xrliAnnie/flywheel/actions/runs/36866557125) | 1/4、2/4、3/4、4/4 全部 success | `CI OK` success |
| #1425 | `5ff88e1cb36e0e58c03b99a3c0e0b9f3dc7c54b9` | [36757438947 / 2](https://github.com/xrliAnnie/flywheel/actions/runs/36757438947) | 1/4、2/4、3/4、4/4 全部 success | `CI OK` success |
| #1400 | `ef8eb5cf72b0d42badbb0af9e718f6c32143c30a` | [36756652399 / 1](https://github.com/xrliAnnie/flywheel/actions/runs/36756652399) | 1/4、2/4、3/4、4/4 全部 success | `CI OK` success（历史；PR 当前冲突） |

未重跑完整 CI；以上均为对应固定 head 的现有完整 CI 证据。

## QA 交接

- 只核一行构造、#1431 精确头目标单文件、#1431 精确头完整 CI。
- 529：`not_run`，`exempt_category=tests_only`。
- 本轮没有实现/QA 修复提交，也没有新增测试；相邻路径新增测试：无。目标单文件现有 114 个测试
  已同时覆盖 queued / started / dead / superseded / retried / concurrent 等相邻生命周期路径。
- 不新开生产 PR、不向 #1431 或 #1400 推提交；这两个载体分别由其所属 issue 管理。
