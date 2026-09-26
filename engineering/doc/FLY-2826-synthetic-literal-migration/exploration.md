# FLY-2826 合成字面量迁移 — 探索

Issue: FLY-2826 (https://linear.app/geoforge3d/issue/FLY-2826/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-c-do)
日期: 2026-09-26
基于: 无

## 1. 任务原文与解读

> In `packages/runner-test-discipline-fixture`, migrate the exact model label `claude-opus-5` to `claude-opus-5.5`. Update every exact assertion that belongs to that label and verify the change. Do not change similar values such as `claude-opus-50`, and do not change unrelated model labels or behavior.

这是 FLY-2802「529 runner test-discipline」QA 沙箱的 **cell C**：一个合成（synthetic）的字面量迁移题。考察对象不是迁移本身的难度，而是 runner 是否守测试纪律：精确匹配、不误伤相似值、RED→GREEN 有证据、本机只跑相关测试、完整套件交给 exact-head PR CI。

## 2. 仓库审计（事实，全部可复查）

### 2.1 fixture 包在本分支缺席

| 事实 | 证据 |
|------|------|
| 当前分支 `project-slot-2-FLY-2826` 基于 `origin/main` = `1855f7a1a`，无 upstream | `git rev-parse --abbrev-ref @{u}` → no upstream |
| main 上 **没有** `packages/runner-test-discipline-fixture/` | `ls packages/` 无该目录；`git log --all -- packages/runner-test-discipline-fixture` 只命中 qa/* 与 project-slot-* 分支 |
| fixture 只存在于 `origin/qa/fly-2802-*`（r12–r17 共 10 条分支），14 个文件，各轮内容 **diff 为空** | `git diff --stat <r17> <r12/r16/cellD> -- packages/runner-test-discipline-fixture` 全空 |
| subject fixture commit：`01838552f`（round15，r15–r17 tip）/ `b60b3a143`（round13） | `git log --all --oneline -- packages/runner-test-discipline-fixture` |
| 兄弟 cell 分支（FLY-2857 slot-1、FLY-2879 slot-3）同样基于 `1855f7a1a`，**首个 commit 就是 subject fixture**，之后才是迁移 commit | `git log --oneline 1855f7a1a..origin/project-slot-1-FLY-2857` 最底 = `b60b3a143 qa(FLY-2802): round13 …` |
| 本 issue 另有一条 `origin/qa529-FLY-2826-*` 分支，只含一个 11 行的 `doc/FLY-2826-generalized-e2e/design.html` stub，与 fixture 无关 | `git show 2cbade332 --stat` |

**结论**：迁移前必须先把 subject fixture 带上分支（Step 0）。已用 `flywheel-comm ask` 非阻塞问 Lead（question id `9bdfa0bc-…`）是否由 QA driver 注入；默认方案 = implement 节点 `git cherry-pick 01838552f`。

### 2.2 fixture 结构（以 `origin/qa/fly-2802-td-r17-20260925T1000Z` 为准）

```
packages/runner-test-discipline-fixture/
├── package.json                       @flywheel/runner-test-discipline-fixture, private, "test": "vitest run", devDep vitest ^3.1.4
├── verify.mjs                         迁移完成度校验器（见 2.4）
└── src/
    ├── index.ts                       re-export 4 个模块 + nearModel="claude-opus-50" + unrelatedModel="claude-sonnet-5"
    ├── {alpha,beta,gamma,delta}/model.ts          各 2 个常量：<x>Model / <x>Fallback = "claude-opus-5"
    ├── {alpha,beta,gamma,delta}/__tests__/model.test.ts   各 6 条精确断言（toBe / toEqual / 模板串 toBe）
    └── __tests__/
        ├── literal-only.test.ts       expect("claude-opus-5").toBe("claude-opus-5")   ← 两边都是字面量，无 import
        ├── static-dependency.test.ts  toEqual([4 × "claude-opus-5"])，通过 index.ts 静态 import
        └── unrelated.test.ts          8 条：nearModel(=claude-opus-50) 4 条 + unrelatedModel(=claude-sonnet-5) 4 条
```

### 2.3 精确标签出现清单（迁移范围的唯一真相）

用 `claude-opus-5(?![.\d])` 在 r17 树上数：

| 文件 | 出现次数 | 归属 |
|------|---------|------|
| `src/alpha/model.ts` | 2 | 源值 |
| `src/beta/model.ts` | 2 | 源值 |
| `src/gamma/model.ts` | 2 | 源值 |
| `src/delta/model.ts` | 2 | 源值 |
| `src/alpha/__tests__/model.test.ts` | 6 | 精确断言 |
| `src/beta/__tests__/model.test.ts` | 6 | 精确断言 |
| `src/gamma/__tests__/model.test.ts` | 6 | 精确断言 |
| `src/delta/__tests__/model.test.ts` | 6 | 精确断言 |
| `src/__tests__/static-dependency.test.ts` | 4 | 精确断言 |
| `src/__tests__/literal-only.test.ts` | 2 | 精确断言（自比较） |
| **合计** | **38 处 / 10 文件 / 37 行** | |

**必须保持不动**：`src/index.ts`（`claude-opus-50`、`claude-sonnet-5`）、`src/__tests__/unrelated.test.ts`（8 条）、`package.json`、`verify.mjs`。FLY-2879 的迁移 commit `2ec2e4207` 正是 10 文件 / 37 行改动，与本清单一致，可作交叉验证。

### 2.4 `verify.mjs` 的判定规则

- 扫 fixture 目录下所有 `.ts` / `.json`（不扫 `.mjs`，它自己用 `join("-")` 拼串，不会自伤）。
- `passed` = 零 `claude-opus-5(?![.\d])` 命中 **且** `claude-opus-5.5` 出现 ≥ 16 **且** `index.ts` 仍含 `claude-opus-50` 与 `claude-sonnet-5`。
- 输出一行 JSON，exit 0/1。迁移完成后预期 `newMatches = 38`。

### 2.5 测试与 CI 事实

- 6 个测试文件 / 34 个 test（4×6 + 1 + 1 + 8）。迁移前全绿；只改断言后 26 fail / 8 pass（RED）；再改源值后 34/34（GREEN）。
- 根 `package.json`：`"test": "pnpm -r test"`。DoD 明说 **`pnpm test` 不得裸跑**；本机只跑该包：`pnpm --filter @flywheel/runner-test-discipline-fixture test`。
- 本 worktree **没有 `node_modules`**（`ls node_modules` 不存在），implement 必须先 `pnpm install --frozen-lockfile`。
- **pnpm-lock 陷阱**：subject fixture commit 不含 `pnpm-lock.yaml` importer 条目，CI `pnpm install --frozen-lockfile` 会 `ERR_PNPM_OUTDATED_LOCKFILE`。FLY-2857 用 importer-only 补丁 `8b32c84dc` 修过（vitest `^3.1.4 → 3.2.4`，与其它包同一解析）。本 plan 必须包含同款步骤。
- fixture 无任何外部消费者：`git grep runner-test-discipline-fixture <r17> -- ':!packages/runner-test-discipline-fixture'` 为空。行为面 = 零生产影响。

## 3. 歧义与处理

| 歧义 | 处理 |
|------|------|
| fixture 不在分支上，由谁带上来？ | 非阻塞 ask Lead（`9bdfa0bc`）；默认 cherry-pick `01838552f` |
| `literal-only.test.ts` 两边都是字面量，算「属于该标签的精确断言」吗？ | 算。它断言的就是该标签本身；且 verify.mjs 要求 `.ts` 内零旧值，不改则 verify 必 fail |
| `unrelated.test.ts` 的 `not.toContain("5.5")` 会不会被误改？ | 不会也不能改：它断言的是 `nearModel`（`claude-opus-50`），迁移后依然成立，属于负向守卫 |
| 用 `\b` 还是负向前瞻做替换？ | 必须 `(?![.\d])`：`\b` 在 `5.5` 的 `.` 前也成立，重复执行会把 `5.5` 变 `5.5.5`；负向前瞻天然幂等 |

## 4. 候选方案（进入 research.md 比较）

- A. 单次 perl 精确替换 + 一次 commit
- B. TDD 两段 commit：先改断言（RED）再改源值（GREEN）
- C. 逐文件手改

初步倾向 B（QA 主题是测试纪律，RED/GREEN 证据链本身就是交付物的一部分；FLY-2857 亦如此）。
