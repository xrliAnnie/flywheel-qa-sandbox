# FLY-3123 StateStore 测试夹具冲突 — 调研
Issue: FLY-3123 (https://linear.app/geoforge3d/issue/FLY-3123/main-红挡全部-pr-statestoregeneralized-executiontestts5467-referenceerror)
日期: 2026-10-01
基于: exploration.md

## 调研结论

根因和修复边界都已由生产源 checkout、原 PR #1425 与 re-land PR #1431 的精确提交确认：测试把 `StateStore` 保留为纯类型，却有一个新用例继续把它当运行时构造器使用。现有 `createGreenHandoffStore` 不只是构造器别名，它还安装了 FLY-2968 要求的绿色 handoff proof（交接证明，即“这个代码交接已在精确提交上通过 CI 且可安全向前”的测试前置条件）。因此替换该一个调用点既消除 `ReferenceError`，也让新测试采用文件内统一的交接语义。PR #1430 后当前 main 暂时没有该测试；修复现由 #1431 携带，不能因测试暂时缺席而宣称问题自然消失。

## 事实来源与可信边界

| 来源 | 已确认内容 | 边界 |
|---|---|---|
| 原实现提交 `b3e0c1d37` / PR #1425 | diff 只有目标测试的一行：`StateStore.create` → `createGreenHandoffStore`；原精确头 `5ff88e1cb` 曾完整 `CI OK` 后合入 | PR #1430 后不再位于当前 main，不能作为当前闭环状态 |
| 当前生产 `origin/main` | `e2997d2e9491007145778aed3a3f3a44b652f893` 的目标文件存在，但命名 FLY-2919 测试缺席 | #1430 回退整组 FLY-2919 + FLY-3123 的结果；不得单独补回测试 |
| re-land PR #1431 | 精确头 `d7d72733b101472bd82236b558906f9c90d0e4d4` 在第 5468 行使用 helper；CI run `36841532431` 的 `CI OK` 成功 | PR 仍开放；它是修复回到 main 的当前载体 |
| 当前 qa-sandbox 工作树 | 没有目标测试文件；分支是 `project-slot-2-FLY-3123` | 不能在 sandbox 本地重跑该生产测试，因此不伪造本地执行证据 |
| Lead 交接 | 原始合并碰撞、单文件失败表现、tests-only QA 边界 | 作为任务范围和历史运行证据，不替代当前 git/GitHub 状态核验 |

## TypeScript 运行时模型

```ts
import { isWorkflowProcessBodyParked, type StateStore } from "../StateStore.js";
```

`type StateStore` 只为参数与返回值提供静态类型。编译成 JavaScript 后，`StateStore` 这个名字不会存在；只有 `isWorkflowProcessBodyParked` 会保留为运行时导入。所以：

```ts
await StateStore.create(":memory:");
```

不是“类型不匹配”，而是必然的运行时未定义变量。通过恢复值导入可以掩盖第一层错误，但会绕过 FLY-2968 的 handoff proof 夹具，语义仍不对。

## Helper 契约

`packages/teamlead/src/__tests__/helpers/handoff-proof.ts` 的相关结构是：

```text
createGreenHandoffStore(...args)
  └─ await StateStore.create(...args)
     └─ installGreenHandoffProofs(store)
        ├─ 包装 commitEnrolledCompletion
        └─ 包装 submitWorkflowDecisionByCredential
```

包装器只在第一次调用被明确拒绝为 `handoff_not_ready` 且原因是 `handoff_proof_required` 时，按 Store 自己推导的 intent（交接意图，即这次提交实际要向前传递的仓库与提交身份）生成密封证明并重试。已有证明、其他拒绝原因、无法解析 activation 的情况均保持原结果，不会被无条件放行。

这带来两个重要负面守卫：

1. 需要验证拒绝行为的测试不得使用这个 helper。
2. 假定“所有代码交接都已通过精确头验证”的测试应统一使用这个 helper，避免每个测试复制证明构造逻辑。

目标 FLY-2919 用例验证 admitted wake（已接纳唤醒）仍落在原物理 owner 上，并不验证 handoff proof 的拒绝路径，因此属于第 2 类。

## 数据 / 结构关系

该修复不改变数据库 schema、持久化记录或生产输入。变化只发生在测试对象创建阶段：

```text
测试用例
  ├─ 内存数据库路径 ":memory:"
  ├─ StateStore 实例
  └─ 绿色交接证明包装
       ├─ completion handoff intent
       └─ decision handoff intent
```

测试后续仍写入相同的 run、node、execution、activation 和 owner 身份，所有断言读取相同的 StateStore API。没有新字段、迁移、序列化格式或显示标签。

## 消费者与变更面

唯一实现文件：

- `packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`

被复用但不修改：

- `packages/teamlead/src/__tests__/helpers/handoff-proof.ts`
- `packages/teamlead/src/StateStore.ts`
- handoff contract / verifier 相关生产模块

直接行为消费者只有 Vitest 执行该测试文件的进程。间接运营影响是 teamlead 单测分片恢复绿色，从而解除所有以 `PR + main` 合并结果运行 CI 的 PR 阻塞。

## 测试选择与命令

本地测试必须遵守 concrete-file selection（明确文件选择）：不能跑裸 `vitest`、包级 `pnpm test` 或目录/glob。

实现前的选测发现：

```bash
git grep -lF -- 'StateStore.create(":memory:")' -- packages/teamlead/src/__tests__
git grep -lF -- 'createGreenHandoffStore(":memory:")' -- packages/teamlead/src/__tests__
git grep -lF -- 'StateStore.generalized-execution.test.ts' -- .
git grep -lF -- 'StateStore.generalized-execution' -- .
git grep -lF -- 'packages/teamlead/src/__tests__' -- .
```

保留的本地验证命令：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.generalized-execution.test.ts
pnpm --filter flywheel-teamlead exec vitest related src/__tests__/StateStore.generalized-execution.test.ts --run
```

第二条满足 changed-TypeScript 的 related 要求；如果它只选择同一个测试文件，应在证据中明确记录，不扩展为包级套件。任何发现到但不运行的测试匹配都必须逐条记录排除理由。

## 已存在的验证证据

- 修复前历史：该文件 92 条通过、1 条因 `StateStore is not defined` 失败。
- 原修复后交接：PR #1425 上同一测试文件曾以 93/93 全绿；这是历史证据，不是当前固定测试总数。
- 回退状态：PR #1430 已合入，当前 main 没有命名 FLY-2919 测试，故不得在 main 单独新建它。
- 当前 re-land：PR #1431 精确头 `d7d72733b101472bd82236b558906f9c90d0e4d4` 的目标文件 100/100 全绿；测试数增加来自后续用例，不是回归。
- GitHub Actions：run `36841532431` 完成，最终 `CI OK` job 成功，teamlead 四个分片均成功。
- QA 分类：`529=not_run`，`exempt_category=tests_only`，因为没有生产流程代码变化。

这些证据可被后续 phase 复用，但若 implementation phase 在 #1431 或其他载体新增任何代码提交，必须重新绑定新精确头，不能沿用 `d7d72733b` 或更早提交的 CI 结论。

## 风险与回滚

| 风险 | 控制 |
|---|---|
| helper 意外掩盖拒绝路径 | 目标测试不验证拒绝；断言完全保留；拒绝测试不在变更面 |
| 机械替换扩大范围 | diff 必须只有命名测试中的一个调用点 |
| 文档提交使实现精确头变化 | 实现/QA 以代码头和当前 PR 头分别核对，不把旧 CI 冒充新头证据 |
| 当前 main 缺少命名测试、#1431 携带修复 | 不在 main 单独补测试；由 #1431 恢复整组功能，并保持原一行 helper 修复不漂移 |

回滚是一行反向替换，但会恢复确定性失败。更合理的后续变更方式是：只有当 FLY-2968 的 helper 契约被新夹具正式替代时，才在同一变更中迁移所有消费者。
