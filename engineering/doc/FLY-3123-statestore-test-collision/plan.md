# FLY-3123 StateStore 测试夹具冲突 — 实施计划
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch successors; the DAG orchestrator owns phase advancement.

**Goal:** 消除 FLY-2919 测试对被类型擦除的 `StateStore` 运行时值的调用，并用文件既有绿色交接夹具保持测试原语义。

**Architecture:** 只替换 `StateStore.generalized-execution.test.ts` 中命名用例的 store 构造调用。`createGreenHandoffStore` 仍由现有 helper 创建真实内存 Store，再为需要通过交接的 completion/decision 安装精确 intent 的绿色证明；生产模块、schema 和断言均不变。

**Tech Stack:** TypeScript、Vitest、pnpm workspace、GitHub Actions。

---

## 当前状态与执行规则

生产 Flywheel PR #1425 已在精确头 `5ff88e1cb36e0e58c03b99a3c0e0b9f3dc7c54b9` 实现并合入；实现提交是 `b3e0c1d37d18edb07552cda71ed4956becf6735a`。当前 design 工作树是 `flywheel-qa-sandbox`，目标测试文件不存在。

因此 implementation phase 必须先识别实际 checkout：

- 如果目标文件存在且命名测试已经调用 `createGreenHandoffStore(":memory:")`，不要重复编辑或提交代码；核对精确头证据后直接交接。
- 如果目标文件存在且仍调用 `StateStore.create(":memory:")`，执行下面的一行修复。
- 如果目标文件不存在，不得在 sandbox 伪造整份生产测试；向 Lead 报告 checkout 不匹配，并引用已合入的 PR #1425。

任何实现后新提交都会产生新精确头，必须等待该新头自己的完整 CI；不能沿用 `5ff88e1cb` 的绿。

## 文件结构

**唯一允许修改的实现文件**

- Modify: `packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`

**只读依赖**

- Read: `packages/teamlead/src/__tests__/helpers/handoff-proof.ts`
- Read: `packages/teamlead/src/StateStore.ts`

**设计与进度文档**

- Read: `engineering/doc/FLY-3123-statestore-test-collision/exploration.md`
- Read: `engineering/doc/FLY-3123-statestore-test-collision/research.md`
- Read: `engineering/doc/FLY-3123-statestore-test-collision/plan.md`

## Task 1：确认 checkout、旧失败与选测范围

- [ ] **Step 1：确认仓库和目标文件**

```bash
git remote get-url origin
git branch --show-current
git rev-parse HEAD
test -f packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts
```

Expected: 在生产 Flywheel checkout 中，文件存在；在当前 QA sandbox 中最后一条会失败，此时不得继续代码编辑。

- [ ] **Step 2：定位唯一目标用例和构造调用**

```bash
rg -n -C 8 'FLY-2919 resolves an admitted wake on the original physical owner|StateStore\.create\(":memory:"\)|createGreenHandoffStore\(":memory:"\)' \
  packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts
```

Expected: 命名测试中只出现旧调用或新调用之一；helper 已在文件顶部导入。

- [ ] **Step 3：按本地测试政策完成 literal / path 发现**

```bash
git grep -lF -- 'StateStore.create(":memory:")' -- packages/teamlead/src/__tests__
git grep -lF -- 'createGreenHandoffStore(":memory:")' -- packages/teamlead/src/__tests__
git grep -lF -- 'packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts' -- .
git grep -lF -- 'StateStore.generalized-execution.test.ts' -- .
git grep -lF -- 'packages/teamlead/src/__tests__' -- .
```

Expected: 记录所有测试命中。保留目标文件；其他命中只要没有执行或导入该目标用例，就逐条记录为排除，并写明“构造 literal 的独立消费者”或“路径/CI 清单，不是本回归的执行消费者”。不得用目录、glob 或裸 `vitest` 扩大测试范围。

- [ ] **Step 4：保存红态证据**

若当前 checkout 是旧态，复用已确认的失败证据：目标文件 92 passed / 1 failed，失败为 `ReferenceError: StateStore is not defined`。不要为了重现红态而运行任何包级或全仓套件。

若当前 checkout 已是新态，记录“red evidence historical, current head already fixed”，不要回退代码制造失败。

## Task 2：应用最小修复

- [ ] **Step 1：只改目标测试的一行**

在命名测试内把：

```ts
const store = await StateStore.create(":memory:");
```

替换为：

```ts
const store = await createGreenHandoffStore(":memory:");
```

不得修改 import、测试名称、`try/finally`、run/admission 数据或任何断言。若新调用已经存在，本步骤为 no-op。

- [ ] **Step 2：核对 diff 只有一个调用点**

```bash
git diff -- packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts
git diff --check
```

Expected: 代码 diff 只有一行删除和一行新增；`git diff --check` 退出 0。若当前头已修复，第一条无输出。

- [ ] **Step 3：确认没有恢复运行时导入**

```bash
sed -n '1,35p' packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts
```

Expected: 仍为 `import { isWorkflowProcessBodyParked, type StateStore } from "../StateStore.js";`，且 `createGreenHandoffStore` 的既有 import 保留。

## Task 3：运行相关验证

- [ ] **Step 1：运行唯一具体测试文件**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.generalized-execution.test.ts
```

Expected: 目标文件全绿（历史实现证据为 93 tests passed），没有 `StateStore is not defined`。

- [ ] **Step 2：运行 changed-TypeScript related 选择**

```bash
pnpm --filter flywheel-teamlead exec vitest related src/__tests__/StateStore.generalized-execution.test.ts --run
```

Expected: 退出 0；记录 Vitest 实际选择的具体文件。空选择时检查 diff 与依赖，不得退回包级测试。

- [ ] **Step 3：只在有新代码 diff 时提交**

```bash
git add packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts
git commit -m "fix(teamlead): use green handoff store in FLY-2919 test"
```

Expected: 新提交只包含目标测试文件。如果当前头已经修复，不创建空提交。

## Task 4：精确头 CI、复审与 QA 交接

- [ ] **Step 1：绑定当前精确头**

```bash
git rev-parse HEAD
git status --short
```

Expected: 工作树干净；记录完整 SHA。

- [ ] **Step 2：核对完整 CI**

对该精确头等待 GitHub Actions 的最终 `CI OK`，且至少核对四个 teamlead unit shard 成功。不得把 `CI Scope OK`、局部测试或祖先提交的 `CI OK` 当作新头完整 CI。

已合入历史头可复用的证据：

- head: `5ff88e1cb36e0e58c03b99a3c0e0b9f3dc7c54b9`
- run: `36757438947`
- result: `CI OK` success

- [ ] **Step 3：复审同一代码头**

如果该精确代码头还没有有效 APPROVED，按 implement phase 的 review gate 请求一次；已有有效 APPROVED 则直接复用，不重复请求。任何修复提交都使旧 review 失效，必须在新头复审。

- [ ] **Step 4：QA 只核三项**

1. diff 是目标测试的一行 helper 替换，断言未改；
2. 目标测试文件在精确头全绿；
3. 精确头完整 CI `CI OK`。

记录 `529=not_run` 与 `exempt_category=tests_only`。不得把本任务扩成生产流程或 Discord 真机验证。

## 完成定义

- 目标调用不再引用运行时不存在的 `StateStore`。
- 变更没有触及生产代码、schema、断言或其他测试。
- 单文件测试与 related 选择均通过。
- 精确头完整 CI 为 `CI OK`。
- 同头复审有效；QA 按 tests-only 三项交接。
- 如果生产 PR #1425 已合入且当前 checkout 无目标文件，则以“无需重复实现 + checkout 边界已报告”收口，不创建替代测试或空提交。

