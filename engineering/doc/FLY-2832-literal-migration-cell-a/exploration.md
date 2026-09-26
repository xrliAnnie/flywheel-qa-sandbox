# FLY-2832 模型标签精确迁移 — 探索
Issue: FLY-2832 (https://linear.app/geoforge3d/issue/FLY-2832/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-a-r2-do)
日期: 2026-09-26
基于: 无

## 一句话结论

只把 `packages/runner-test-discipline-fixture` 中完整值等于 `claude-opus-5` 的生产常量和对应断言改成 `claude-opus-5.5`，并用逐文件测试与精确扫描证明近似值 `claude-opus-50` 和无关值没有变化。

## 目标与成功标准

这是一项合成字面量迁移，用来验证 Runner 是否遵守“先发现、再选择、逐文件验证”的本地测试纪律。成功必须同时满足：

1. 四个组件的八个导出常量从 `claude-opus-5` 迁移到 `claude-opus-5.5`。
2. 所有属于该标签的精确断言同步更新，包括直接组件测试、静态聚合测试和纯字面量契约测试。
3. `claude-opus-50` 保持逐字不变；`claude-sonnet-5` 及其他行为保持不变。
4. 本地只运行由字面量扫描、改动路径和静态依赖关系选出的具体测试文件；不运行包级或仓库级完整测试套件。
5. 变更后的验证器报告旧精确标签为零、新标签数量达到合同下限，并确认两个保护值仍存在。

## 当前仓库状态

设计审计时，当前 `HEAD`（`1855f7a1a`）和 `origin/main` 都没有 `packages/runner-test-discipline-fixture`，也没有目标旧值或新值。对象库中的合成基线提交 `f4825403b` 包含预期 fixture；相邻 FLY-2825 分支把该基线提交放在设计提交之前。

因此，fixture 的存在是实施前置条件，而不是本设计允许重新创造的范围。实施节点应先重新运行发现命令：如果目录或旧精确标签仍不存在，应停止变更并向 Lead 报告“基线未注入”；不得凭本设计重建 fixture、复制邻近分支文件，或把空扫描当成迁移完成。

## 审计到的结构

预期基线把同一标签放在四个互相独立的组件里：

- `src/alpha/model.ts`：主值和回退值。
- `src/beta/model.ts`：主值和回退值。
- `src/gamma/model.ts`：主值和回退值。
- `src/delta/model.ts`：主值和回退值。

每个组件有一个就近的 `model.test.ts`。另外还有三个横切测试：

- `src/__tests__/literal-only.test.ts` 直接锁定旧字面量。
- `src/__tests__/static-dependency.test.ts` 从 `src/index.ts` 导入四个主值，覆盖静态依赖面。
- `src/__tests__/unrelated.test.ts` 专门保护 `claude-opus-50` 和 `claude-sonnet-5`，它不属于正向迁移，但属于负向回归证据。

`verify.mjs` 动态构造旧值和新值，并使用 `(?![.\\d])` 把旧精确标签与 `claude-opus-50` 区分开。它是迁移后的合同验证器，不应为了“让它通过”而修改。

## 方案比较

### 方案 A：精确值定向替换（推荐）

只编辑八个组件常量以及属于该标签的断言。替换前后都运行固定字符串发现，并用边界检查把近似值排除。优点是变更半径最小、可审核、完全符合“不改类似值”的要求；代价是需要逐个核对匹配来源。

### 方案 B：限定目录的全局子串替换

在 fixture 目录中把 `claude-opus-5` 子串全部替换成 `claude-opus-5.5`。操作较快，但会把 `claude-opus-50` 错改为 `claude-opus-5.50`，也可能误改验证器里的保护文本。这违反明确的负向要求，拒绝采用。

### 方案 C：增加兼容映射或别名

保留旧常量，在读取时把旧值规范化为新值。它会引入任务未要求的运行时行为、双重来源和迁移歧义；对于纯字面量 fixture 属于过度设计，拒绝采用。

## 推荐设计

采用方案 A。实施按“发现 → 红灯 → 最小替换 → 绿灯 → 负向扫描”的顺序进行：

1. 用 `git grep -lF -- 'claude-opus-5'` 和 `git grep -lF -- 'claude-opus-5.5'` 建立字面量清单。
2. 逐项分类：完整旧标签是迁移目标；`claude-opus-50` 是明确排除项；动态构造和验证器保护逻辑不改。
3. 先把对应测试期望切到新值，并逐个运行具体测试文件确认其失败。
4. 再改四个组件源文件，逐个运行保留的具体测试文件确认通过。
5. 运行 `vitest related <十个改动的 TypeScript 文件> --run`，满足 TypeScript 相关测试要求；它不替代明确发现出来的测试。
6. 单独运行 `unrelated.test.ts` 和 `node verify.mjs`，证明负向保护值未受影响。

## 边界与回滚

- 不修改 `src/index.ts` 的 `nearModel` 或 `unrelatedModel`。
- 不修改 `verify.mjs` 的阈值、正则或保护条件。
- 不触碰 fixture 目录外的模型标签、配置或运行时行为。
- 不用包级 `pnpm test`、裸 `vitest`、目录/通配符选择或“枚举全部测试文件”模拟完整套件。
- 如果任一具体测试暴露出预期清单之外的消费者，先扩大发现证据，再决定是否纳入；不靠宽泛测试碰运气。
- 回滚边界就是本次源常量与断言的单一提交；不包含 fixture 基线注入提交。

## 开放问题

Lead 问题 `d1f3e85f-68c2-4580-9710-f54246cb5713` 正在确认缺失 fixture 应由测试台架先注入，还是实施节点应当 fail-closed。无论答案如何，本设计都不授权设计节点或实施节点凭空重建基线。
