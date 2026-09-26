# FLY-2832 模型标签精确迁移 — 调研
Issue: FLY-2832 (https://linear.app/geoforge3d/issue/FLY-2832/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-a-r2-do)
日期: 2026-09-26
基于: exploration.md

## 1. 证据来源

本调研以当前分支和 Git 对象库为证据，不把相邻 Runner 的未评审设计当作规范：

- 当前分支：`project-slot-2-FLY-2832`，审计头 `1855f7a1a`，与 `origin/main` 相同。
- 预期 fixture 基线：提交 `f4825403bd08009ded469d37a64537bfab7c5c3c`，提交说明为 `qa(FLY-2802): round15 literal-migration subject fixture`。
- 相邻先例：FLY-2824 的主题分支也先出现独立 fixture seed，再出现迁移提交，说明 seed 和任务产物应保持可区分。
- 硬约束：注入的 `local-test-policy/v1`。它禁止本地整仓/整包测试，并要求先做字面量与改动路径发现，再逐个运行具体测试文件。

当前分支没有 fixture。调研读取 `f4825403b` 的树来确定未来实施面，但没有把该提交 cherry-pick 到共享分支；是否以及如何注入基线由 Lead/测试台架确认。

## 2. 精确字面量清单

固定字符串 `git grep -F 'claude-opus-5'` 会把 `claude-opus-50` 也列出来，因此必须再用边界语义分类。fixture 自带验证器的边界为 `claude-opus-5(?![.\d])`：后面跟点或数字的值不算旧精确标签。

| 文件组 | 文件数 | 每文件旧精确值 | 合计 | 实施动作 |
| --- | ---: | ---: | ---: | --- |
| `src/{alpha,beta,gamma,delta}/model.ts` | 4 | 2 | 8 | 更新常量 |
| `src/{alpha,beta,gamma,delta}/__tests__/model.test.ts` | 4 | 6 | 24 | 更新断言 |
| `src/__tests__/literal-only.test.ts` | 1 | 2 | 2 | 更新纯字面量合同 |
| `src/__tests__/static-dependency.test.ts` | 1 | 4 | 4 | 更新聚合断言 |
| **总计** | **10** | — | **38** | 全部迁移到新精确标签 |

固定字符串发现还会命中以下三个排除文件；排除理由必须写进实施证据：

| 文件 | 命中原因 | 为什么不改 |
| --- | --- | --- |
| `src/index.ts` | 包含 `claude-opus-50` | 明确的近似值保护对象，同时包含无关 `claude-sonnet-5` |
| `src/__tests__/unrelated.test.ts` | 断言 `claude-opus-50` | 负向回归测试；要运行但不能改 |
| `verify.mjs` | 两处检查 `claude-opus-50` | 独立验收器；修改会污染完成证据 |

迁移前新精确标签数量为 0；迁移后预期为 38。`verify.mjs` 只要求 `newMatches >= 16`，所以不能把较低阈值误当成完整迁移证明；38/38 才是本 issue 的范围证据。

## 3. 消费关系

`src/index.ts` 重新导出四个组件模块。四个就近测试直接导入各自模块；`static-dependency.test.ts` 通过 `index.ts` 聚合导入四个主值；`unrelated.test.ts` 通过同一个 `index.ts` 读取两个保护值。

因此测试选择来自三类独立证据：

1. **直接改动**：四个 `model.test.ts`、`literal-only.test.ts`、`static-dependency.test.ts`。
2. **静态消费者**：四个 `model.test.ts` 和 `static-dependency.test.ts` 覆盖四个源模块的导出。
3. **负向保护**：`unrelated.test.ts` 证明近似值和无关值没有被子串替换误伤。

七个测试文件都必须逐文件运行。虽然它们恰好等于 fixture 的全部测试文件，选择依据不是“跑完整包”，而是每个文件都有直接字面量、改动消费者或负向保护关系；命令仍然必须一次只带一个具体文件。禁止用循环隐藏无文件选择的包级命令。

## 4. 本地测试纪律映射

| 硬规则 | 本任务的具体做法 |
| --- | --- |
| 字面量改动先发现 | 先对旧值、新值分别运行 `git grep -lF`，再用边界扫描把 10 个迁移文件和 3 个保护文件分开 |
| 改动文件再发现 | 对每个改动文件搜索完整路径、文件名和父目录；记录相对导入和 `index.ts` 重新导出形成的消费者 |
| 测试必须正向选择文件 | `pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run <concrete-file>`，七次独立执行 |
| TypeScript 要跑 related | 对十个改动 `.ts` 文件运行一次 `vitest related ... --run`；这不替代七个显式文件测试 |
| 排除测试要记原因 | 不排除任何被发现的测试。`unrelated.test.ts` 不改，但作为负向保护保留执行 |
| 禁止完整套件 | 不调用 `pnpm test`、`test:packages`、`pnpm --filter ... test`、裸 `vitest`、无文件 `vitest run`、目录或 glob |
| 全套件证据归 CI | 本地只声称定向检查通过；exact-head PR CI 才能声称完整套件通过 |

fixture 没有 build 或 typecheck 脚本，也没有导出类型变化；实施报告应把受影响包 build、依赖 typecheck 标为“不适用”，而不是伪造成功证据。仓库 `pnpm lint` 仍需保留。

## 5. TDD 可行性

四个组件适合标准红绿循环：先把相应 `model.test.ts` 的六个期望改为新标签，运行该具体测试并观察旧源值导致失败；再把对应 `model.ts` 的两个常量改为新标签，重跑转绿。

两个横切测试有不同性质：

- `static-dependency.test.ts` 可以在四个源模块迁移前先改期望并得到红灯，源模块迁移后转绿。
- `literal-only.test.ts` 只比较两个字面量；同步改两边会一直通过，无法提供有意义的红灯。它仍需更新和单独运行，但红灯证据由组件/聚合测试提供，不能人为制造无关失败。

## 6. 验收器与负向不变量

`verify.mjs`：

- 遍历 fixture 内的 `.ts` 与 `.json` 文件；
- 报告仍含旧精确标签的文件列表；
- 统计新标签出现次数；
- 读取 `src/index.ts`，确认 `claude-opus-50` 和 `claude-sonnet-5` 仍存在；
- 只有旧精确标签为零、新标签至少 16、两个保护值都存在时退出 0。

实施还需要比验证器更强的差异守卫：改动文件应恰好是十个目标文件；`src/index.ts`、`src/__tests__/unrelated.test.ts`、`verify.mjs`、`package.json` 不应出现在迁移提交 diff 中；新值计数应为 38。

## 7. 基线缺失的决策边界

推荐把“fixture seed”视为测试台架提供的前置状态，而不是迁移实现的一部分：

- 若实施 TURN 开始时 fixture 已存在，重新发现并按本计划执行。
- 若 fixture 仍不存在，实施节点 fail-closed，报告 Lead 并等待台架注入；不手写、不从邻近分支复制、不把空搜索解释为成功。
- 若 Lead 明确授权使用某个 seed 提交，seed 必须保持独立提交，并在迁移前核对树内容；迁移提交自身仍只能包含十个目标文件。

这样可以保住 529 的核心测量边界：主题变更是精确迁移，不夹带 fixture 构造或 lockfile 修复。
