# FLY-2832 模型标签精确迁移 — 实施计划
Issue: FLY-2832 (https://linear.app/geoforge3d/issue/FLY-2832/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-a-r2-do)
日期: 2026-09-26
基于: research.md

> **给实施节点：** 按本计划逐项执行，遵守注入的 DAG TURN、TDD 和 `local-test-policy/v1`。不要派发子节点；不要用整包测试替代下面的具体文件选择。

**目标：** 把 fixture 中完整模型标签 `claude-opus-5` 的 38 个目标出现点迁移为 `claude-opus-5.5`，同时逐字保留 `claude-opus-50`、`claude-sonnet-5` 和无关行为。

**架构：** 不增加映射层或兼容分支；源常量和锁定它们的断言继续保持单一、直接的字符串合同。实施用“固定字符串发现 + 精确边界分类”确定十个文件，用组件测试与静态聚合测试走 RED→GREEN，再以负向测试和独立验证器收口。

**技术栈：** TypeScript、Vitest 3、pnpm workspace、Node.js ESM、Git。

**状态：** draft

---

## 不变量

1. 迁移提交只改十个 TypeScript 文件：四个 `model.ts`、四个就近 `model.test.ts`、`literal-only.test.ts`、`static-dependency.test.ts`。
2. 旧精确标签迁移后为 0，新精确标签为 38。
3. `src/index.ts`、`src/__tests__/unrelated.test.ts`、`verify.mjs`、`package.json` 字节不变。
4. `claude-opus-50` 在 fixture 内保持 4 次，`claude-sonnet-5` 保持 4 次。
5. 本地不调用 `pnpm test`、`test:packages`、`pnpm --filter ... test`、裸 `vitest`、无具体文件的 `vitest run`、目录或 glob 选择。
6. 本地证据只证明相关检查；完整测试套件只能由 exact-head PR CI 证明。

## 文件映射

| 责任 | 文件 | 动作 |
| --- | --- | --- |
| Alpha 标签 | `packages/runner-test-discipline-fixture/src/alpha/model.ts` | 两个常量改为新值 |
| Alpha 合同 | `packages/runner-test-discipline-fixture/src/alpha/__tests__/model.test.ts` | 六个期望改为新值 |
| Beta 标签 | `packages/runner-test-discipline-fixture/src/beta/model.ts` | 两个常量改为新值 |
| Beta 合同 | `packages/runner-test-discipline-fixture/src/beta/__tests__/model.test.ts` | 六个期望改为新值 |
| Gamma 标签 | `packages/runner-test-discipline-fixture/src/gamma/model.ts` | 两个常量改为新值 |
| Gamma 合同 | `packages/runner-test-discipline-fixture/src/gamma/__tests__/model.test.ts` | 六个期望改为新值 |
| Delta 标签 | `packages/runner-test-discipline-fixture/src/delta/model.ts` | 两个常量改为新值 |
| Delta 合同 | `packages/runner-test-discipline-fixture/src/delta/__tests__/model.test.ts` | 六个期望改为新值 |
| 纯字面量合同 | `packages/runner-test-discipline-fixture/src/__tests__/literal-only.test.ts` | 两个字面量改为新值 |
| 聚合导入合同 | `packages/runner-test-discipline-fixture/src/__tests__/static-dependency.test.ts` | 四个期望改为新值 |

## Task 0：取得 TURN 并验证基线

**文件：** 不改文件。

- [ ] **Step 0.1：确认共享工作树写权限**

```sh
node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID" --json
```

预期：`answer` 为 `yours`，`phase` 为 `implement`。其他结果均不触碰工作树，按 TURN wait law 等待。

- [ ] **Step 0.2：读取进度和 Lead 邮箱**

```sh
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
sed -n '1,200p' engineering/doc/FLY-2832-literal-migration-cell-a/progress.md
```

预期：没有未处理的范围变更；若 inbox 列出问题 id，先逐个 `check`。

- [ ] **Step 0.3：验证 fixture 已由测试台架提供**

```sh
test -d packages/runner-test-discipline-fixture
git status --short --branch
git log -1 --oneline -- packages/runner-test-discipline-fixture
```

预期：目录存在，且分支上的 fixture 基线可追溯。若目录不存在，停止实施并运行 `node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" "FLY-2832 fixture baseline missing; implementation stopped before worktree changes"`；不得手写、复制相邻分支或把空扫描当成完成。

## Task 1：先发现并冻结作用范围

**文件：** 不改文件。

- [ ] **Step 1.1：执行政策要求的全仓旧值/新值发现**

```sh
git grep -lF -- 'claude-opus-5'
git grep -lF -- 'claude-opus-5.5'
```

预期：输出会包含本 issue 的过程文档；过程文档不属于运行时迁移。保留原始输出作为发现证据，不直接把固定字符串结果喂给替换命令。

- [ ] **Step 1.2：在 fixture 内区分目标与近似值**

```sh
git grep -lF -- 'claude-opus-5' -- packages/runner-test-discipline-fixture
git grep -lP -- 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture
git grep -lF -- 'claude-opus-5.5' -- packages/runner-test-discipline-fixture
```

预期：固定字符串命中 13 个文件；精确边界命中“文件映射”里的 10 个文件；新值迁移前命中 0 个文件。额外三个固定字符串文件及排除理由：

- `src/index.ts`：只含近似值与无关值，不改。
- `src/__tests__/unrelated.test.ts`：负向保护测试，不改但保留执行。
- `verify.mjs`：独立验收器，不改。

- [ ] **Step 1.3：按完整路径、文件名和父目录搜索十个将改文件**

```sh
for changed_file in \
  packages/runner-test-discipline-fixture/src/alpha/model.ts \
  packages/runner-test-discipline-fixture/src/alpha/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/beta/model.ts \
  packages/runner-test-discipline-fixture/src/beta/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/gamma/model.ts \
  packages/runner-test-discipline-fixture/src/gamma/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/delta/model.ts \
  packages/runner-test-discipline-fixture/src/delta/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/literal-only.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/static-dependency.test.ts
do
  git grep -nF -- "$changed_file" || true
  git grep -nF -- "${changed_file##*/}" || true
  git grep -nF -- "${changed_file%/*}" || true
done
```

预期：结合文件内容审计确认四个就近测试、`src/index.ts` 重新导出、静态聚合测试和负向测试是完整消费面。测试排除清单为“无”：七个发现到的测试均在 Task 4 逐文件运行。

## Task 2：先更新可失败的断言，取得 RED

**文件：**

- 修改：`packages/runner-test-discipline-fixture/src/{alpha,beta,gamma,delta}/__tests__/model.test.ts`
- 修改：`packages/runner-test-discipline-fixture/src/__tests__/static-dependency.test.ts`

- [ ] **Step 2.1：用 `apply_patch` 把五个测试文件中的完整旧标签改为新标签**

每个组件测试的最终形状如下；按对应组件名分别应用，不能改 import、测试名或表达式结构：

```ts
import { expect, test } from "vitest";
import { alphaFallback, alphaModel } from "../model.js";

test("alpha primary", () => expect(alphaModel).toBe("claude-opus-5.5"));
test("alpha fallback", () => expect(alphaFallback).toBe("claude-opus-5.5"));
test("alpha primary is stable", () =>
	expect(alphaModel).toEqual("claude-opus-5.5"));
test("alpha fallback is stable", () =>
	expect(alphaFallback).toEqual("claude-opus-5.5"));
test("alpha primary serializes", () =>
	expect(`${alphaModel}`).toBe("claude-opus-5.5"));
test("alpha fallback serializes", () =>
	expect(`${alphaFallback}`).toBe("claude-opus-5.5"));
```

Beta、Gamma、Delta 文件分别保留自身现有导出名和测试名，只把六个完整字符串值改成 `claude-opus-5.5`。静态聚合测试的最终数组必须精确为：

```ts
expect([alphaModel, betaModel, gammaModel, deltaModel]).toEqual([
	"claude-opus-5.5",
	"claude-opus-5.5",
	"claude-opus-5.5",
	"claude-opus-5.5",
]);
```

- [ ] **Step 2.2：逐文件运行五个可失败测试，确认 RED**

```sh
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/alpha/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/beta/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/gamma/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/delta/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/__tests__/static-dependency.test.ts
```

预期：前四个文件各因实际值仍为 `claude-opus-5` 而失败；静态聚合测试因实际数组仍含四个旧值而失败。若失败原因是模块找不到或工具安装问题，先修复基线环境，不把它算作 RED。

## Task 3：更新源常量和纯字面量合同，取得 GREEN

**文件：**

- 修改：`packages/runner-test-discipline-fixture/src/{alpha,beta,gamma,delta}/model.ts`
- 修改：`packages/runner-test-discipline-fixture/src/__tests__/literal-only.test.ts`

- [ ] **Step 3.1：用 `apply_patch` 更新八个源常量**

四个源文件的最终内容分别为：

```ts
// src/alpha/model.ts
export const alphaModel = "claude-opus-5.5";
export const alphaFallback = "claude-opus-5.5";

// src/beta/model.ts
export const betaModel = "claude-opus-5.5";
export const betaFallback = "claude-opus-5.5";

// src/gamma/model.ts
export const gammaModel = "claude-opus-5.5";
export const gammaFallback = "claude-opus-5.5";

// src/delta/model.ts
export const deltaModel = "claude-opus-5.5";
export const deltaFallback = "claude-opus-5.5";
```

- [ ] **Step 3.2：用 `apply_patch` 更新纯字面量合同**

```ts
import { expect, test } from "vitest";

test("literal-only contract", () => {
	expect("claude-opus-5.5").toBe("claude-opus-5.5");
});
```

这个测试两边都是字面量，不能提供有意义的 RED；它的职责是防止旧合同残留。

- [ ] **Step 3.3：确认 diff 仅含十个目标文件**

```sh
git diff --name-only -- packages/runner-test-discipline-fixture
git diff --check
```

预期：只有文件映射中的十个路径；`git diff --check` 无输出并退出 0。若出现 `index.ts`、`unrelated.test.ts`、`verify.mjs` 或 `package.json`，立即恢复该意外文件并重新审计。

## Task 4：逐文件 GREEN 和 TypeScript related 验证

**文件：** 不新增改动。

- [ ] **Step 4.1：逐个运行六个已改测试文件**

```sh
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/alpha/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/beta/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/gamma/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/delta/__tests__/model.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/__tests__/literal-only.test.ts
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/__tests__/static-dependency.test.ts
```

预期：四个组件文件各 6/6，通过；两个横切文件各 1/1，通过。

- [ ] **Step 4.2：单独运行未改的负向保护测试**

```sh
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/__tests__/unrelated.test.ts
```

预期：8/8，通过，证明近似值和无关标签没有被改坏。

- [ ] **Step 4.3：运行 owning package 的 related 选择**

```sh
pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest related \
  src/alpha/model.ts \
  src/alpha/__tests__/model.test.ts \
  src/beta/model.ts \
  src/beta/__tests__/model.test.ts \
  src/gamma/model.ts \
  src/gamma/__tests__/model.test.ts \
  src/delta/model.ts \
  src/delta/__tests__/model.test.ts \
  src/__tests__/literal-only.test.ts \
  src/__tests__/static-dependency.test.ts \
  --run
```

预期：Vitest 只选择与十个改动文件相关的测试并全部通过。此结果不替代 Step 4.1–4.2 的显式文件证据。

## Task 5：完成精确扫描与独立验证

**文件：** 不新增改动。

- [ ] **Step 5.1：证明旧精确标签清零、新标签完整**

```sh
git grep -nP -- 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture
git grep -oF -- 'claude-opus-5.5' -- packages/runner-test-discipline-fixture | wc -l
```

预期：第一条无输出并以“无匹配”状态退出；第二条输出 `38`。

- [ ] **Step 5.2：证明保护值逐字保留**

```sh
git grep -oF -- 'claude-opus-50' -- packages/runner-test-discipline-fixture | wc -l
git grep -oF -- 'claude-sonnet-5' -- packages/runner-test-discipline-fixture | wc -l
git diff --exit-code -- packages/runner-test-discipline-fixture/src/index.ts
git diff --exit-code -- packages/runner-test-discipline-fixture/src/__tests__/unrelated.test.ts
git diff --exit-code -- packages/runner-test-discipline-fixture/verify.mjs
git diff --exit-code -- packages/runner-test-discipline-fixture/package.json
```

预期：两个计数均为 `4`；四条 diff 命令均无输出并退出 0。

- [ ] **Step 5.3：运行 fixture 独立验收器**

```sh
node packages/runner-test-discipline-fixture/verify.mjs
```

预期：exit 0；JSON 至少包含 `"passed":true`、`"oldMatches":[]`、`"newMatches":38`、`"nearValuePreserved":true`、`"unrelatedValuePreserved":true`。

- [ ] **Step 5.4：运行仓库 lint；记录不适用项**

```sh
pnpm lint
```

预期：exit 0。fixture 没有 build/typecheck 脚本、没有导出类型变化、没有新增 `scripts/__tests__/*.test.sh`，这些项目在实施报告中明确记为“不适用”，不运行替代性的宽泛测试。

## Task 6：提交与交接

**文件：** 十个目标 TypeScript 文件。

- [ ] **Step 6.1：提交前复核 Lead 邮箱和 TURN**

```sh
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID" --json
git status --short
git diff --stat
```

预期：TURN 仍为实施节点所有；没有未处理的范围修正；状态只含预期十个文件。

- [ ] **Step 6.2：创建单一迁移提交**

```sh
git add \
  packages/runner-test-discipline-fixture/src/alpha/model.ts \
  packages/runner-test-discipline-fixture/src/alpha/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/beta/model.ts \
  packages/runner-test-discipline-fixture/src/beta/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/gamma/model.ts \
  packages/runner-test-discipline-fixture/src/gamma/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/delta/model.ts \
  packages/runner-test-discipline-fixture/src/delta/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/literal-only.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/static-dependency.test.ts
git diff --cached --check
git commit -m "chore(FLY-2832): migrate exact opus model label"
```

预期：提交只含十个文件和 38 对精确值替换。后续 code review、PR 和 QA 使用各自注入的命令；本计划不授权实施节点 merge、ship 或派发后继节点。

## 回滚边界

迁移是一个独立提交；如需回滚，应对实施报告中记录的迁移提交执行普通 `git revert`，回到旧标签。fixture 基线注入不属于该提交，也不应与迁移一起回滚。若 exact-head CI 暴露 fixture seed 自身的 lockfile 问题，应由 Lead 明确分配基线修复；不要把它伪装成模型标签迁移。

## 明确拒绝的替代方案

- 目录级或仓库级子串替换：会把 `claude-opus-50` 改坏。
- 兼容映射/运行时规范化：引入任务之外的行为和双重来源。
- 修改 `verify.mjs` 的阈值或保护条件：会削弱验收器。
- 运行 fixture 的 `test` / `test:packages` script：两者都是无具体文件选择的整包诱饵。
- fixture 不存在时手工重建：掩盖测试台架基线缺失并污染 subject diff。
