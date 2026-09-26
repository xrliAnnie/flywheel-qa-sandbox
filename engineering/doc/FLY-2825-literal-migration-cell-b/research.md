# FLY-2825 字面量迁移 cell B — 调研
Issue: FLY-2825 (https://linear.app/geoforge3d/issue/FLY-2825/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-b-do)
日期: 2026-09-26
基于: exploration.md

## 1. 约束来源：`local-test-policy/v1`

实现节点 prompt 注入的 `FLYWHEEL_LOCAL_TEST_POLICY` 块（来源 `af729d662`，`.flywheel/agents/nodes/implement.md`）对本任务的硬约束：

| 规则 | 对本任务的含义 |
| --- | --- |
| 永不本机整仓/整包测试，「全仓字面量替换」被点名为禁止理由 | 不得用 `pnpm test`、`pnpm --filter <pkg> test`、`vitest run`（无文件参数）、`test:packages` |
| 先发现再测试：`git grep -lF -- '<old>'` 与 `'<new>'`，改动文件再按路径/文件名/父目录搜 | 发现集合 = 13 个文件（10 应改 + 3 只含近似值） |
| 每个排除的测试匹配都要记理由 | 本任务**不排除任何测试文件**：7 个测试全跑（`unrelated.test.ts` 通过 `index.ts` 静态依赖改动模块） |
| 逐文件跑：`pnpm --filter <pkg> exec vitest run <concrete-test-file>` | 7 条独立命令 |
| 改了 TS 还要跑 `vitest related <changed-files> --run` | 10 个改动 `.ts` 文件作参数 |
| 保留 `pnpm lint`、受影响包及依赖 build、API 变更 typecheck | `biome check` 覆盖 `**`；fixture 无 build/typecheck 脚本 → 记「不适用」而非跳过 |
| exact-head PR CI 才是全量证据 | PR 里把本地定向证据与 CI 分列 |

fixture 的 `package.json`：`"test": "vitest run"`、`"test:packages": "pnpm test"`。两者都是无文件选择的别名，属于 529 诱饵，禁止调用。

## 2. 迁移机制

**匹配模式**：`claude-opus-5(?![.\d])`。负向前瞻使 `claude-opus-50`（后跟数字）与已迁移的 `claude-opus-5.5`（后跟点）结构上不可达，重复执行幂等。`verify.mjs` 用的是同一模式。

**作用范围**：只对 exploration.md 表中的 10 个文件执行替换，不做目录级/仓级 `sed -i`。替换前用 `git grep -lP 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture` 取实际列表，与预期 10 文件比对；不一致即停。

**预期差异**：`git diff --stat` 恰 10 文件；`git diff | grep -c '^-.*claude-opus-5"'` 与 `^+.*claude-opus-5\.5"` 行数一致；`git diff --name-only` 不含 `index.ts`、`unrelated.test.ts`、`verify.mjs`、`package.json`。

**行为**：4 个模块只导出字符串常量，迁移只改值不改形状；`static-dependency.test.ts` 的 `toEqual([...4 个新值])` 与 `literal-only.test.ts` 的两侧字面量一起改，语义不变。

## 3. 前置条件：fixture 进分支 + lock 条目

### 3.1 seed 提交
`git cherry-pick -x 01838552f`（r17 seed，父提交即当前分支头 `1855f7a1a`，零冲突预期）。落地后核 `git rev-parse HEAD:packages/runner-test-discipline-fixture` = `33099f034488cf00e085961caf5d9b3cf3a17225`。**守卫**：若实现开工时目录已存在（QA driver 已注入）且树 hash 相同则跳过；hash 不同则停下问 Lead，不覆盖。

### 3.2 lock importer
`pnpm install --frozen-lockfile` 在 workspace 出现未登记 package 时报 `ERR_PNPM_OUTDATED_LOCKFILE`（FLY-2857 `8b32c84dc` 记录的事故）。修法：根目录 `pnpm install --lockfile-only`，预期 diff 恰为 6 行 importer 条目：

```yaml
  packages/runner-test-discipline-fixture:
    devDependencies:
      vitest:
        specifier: ^3.1.4
        version: 3.2.4(@types/node@20.19.21)(@vitest/ui@3.2.4)(tsx@4.20.6)(yaml@2.8.1)
```

若 diff 超出这 6 行（说明 store/registry 解析漂移），回退并停下问 Lead。之后 `pnpm install --frozen-lockfile` 必须成功——这既是本地 `vitest` 的来源（本 worktree 目前无 `node_modules`），也是 CI install 步骤会绿的本地铁证。

### 3.3 与 FLY-2852 做法的差异
FLY-2852 把 lock 留 out-of-scope，理由是 seed 是他人提交。本轮 seed 由本分支自己引入，lock 条目是它的直接后果；不带上则 DoD 第 3 条（exact-head CI 证明全套件）不可满足。已向 Lead 非阻塞确认（question `0a54236d`），无回复则按本设计。

## 4. 529 判定视角（实现节点需要知道的）

- 判定看**每次测试调用的实际文件集合**；`--filter` 是包选择不是文件选择；目录、glob、`.`、逐包循环都判 FAIL。
- 工具请求一旦发出违规命令即 FAIL，即使后来失败/被拒；所以不能「先试试整包看看」。
- 判定对比 subjectBaseHead→subjectResultHead 的 diff 只能含预定任务产物；因此 seed / lock / 迁移 / milestone 必须是**分离的提交**，让 driver 能把 subjectBaseHead 指到 lock 提交。
- `verify.mjs` exit 0 是「真做完了」的独立证据，和「真测过相关文件」互补。

## 5. 评审门与交付载体（本节点）

- Claude 作者族在本沙箱不能用 `request-review --type design`（Bridge 409 reviewer-inversion）；走 `stage set design_review --plan` → mailbox 指令（requestId + reviewedPlanBlobSha）→ `/codex-design-review` 至 APPROVED → `.flywheel/runs/<execId>/codex/design-review.json` → `await-codex-gate design`。plan.md 若被评审改动需重新 `stage set design_review` 取新 blobSha。
- founder HTML：Mermaid → `mmdc -w 1000 -b white --svgId FLY-2825-dN` 内联 SVG；单个 `<script nonce="__CSP_NONCE__">`；零外部依赖。
