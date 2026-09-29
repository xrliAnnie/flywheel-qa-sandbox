# FLY-3043 Codex 契约文件加沙箱注释 — 调研

Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-28
基于: exploration.md

## 1. 调研问题

exploration.md 已确认改动本身零行为风险；本文回答"实施节点照抄就能跑通"所需的三个操作性问题：

1. 本机**相关测试**的确切命令、前置条件与耗时（DoD 第 3 条：不裸跑 `pnpm test`）。
2. PR CI 会覆盖到什么（完整套件证据由谁提供）。
3. 沙箱里 commit / push / PR / 评审门的已知坑。

## 2. 本机相关测试（实测 2026-09-28）

### 2.1 前置：worktree 没有 `node_modules`

本 worktree 初始状态下 `node_modules/` 与 `packages/claude-runner/node_modules/` 均不存在，直接 `npx vitest` 会 `ERR_MODULE_NOT_FOUND`。实测：

```bash
pnpm install --frozen-lockfile --prefer-offline   # 7.2s（pnpm v10.13.1，store 已热）
```

唯一告警是 `packages/teamlead/node_modules/.bin/flywheel-comm` 的 bin 链接失败（依赖 `flywheel-comm/dist` 未 build）——与本 issue 无关，不影响 claude-runner 测试。

### 2.2 相关测试 = 一个文件

| 命令（仓库根执行） | 结果 | 耗时 |
|---|---|---|
| `pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts` | 1 file / **37 passed** | ~0.85s |
| 等价：`(cd packages/claude-runner && npx vitest run test/codex-home.test.ts)` | 同上 | ~0.8s |

包名 `flywheel-claude-runner`（`packages/claude-runner/package.json`）。该文件的 `describe("FLY-1188 AGENTS.md contract materialization")` 就是断言契约锚点进入 `$CODEX_HOME/AGENTS.md` 的用例，是本改动**唯一直接相关**的单测。

### 2.3 为什么不本机跑 `package-onboard-smoke.test.sh`

它需要 `pnpm build` 产出 `packages/teamlead/dist`（第 31 行无 dist 即 `SKIP … exit 0`），是打包完整性检查而非内容检查；CI 第 188 行会跑。按政策留给 CI。

### 2.4 Lint

`biome.json` `includes: ["**", …]`，但 biome 不检查 `.md`；契约文件改动不会触发 lint 差异。测试文件改动是 TypeScript，须保证 biome 通过：`pnpm exec biome check packages/claude-runner/test/codex-home.test.ts`（对单文件跑，不裸跑全仓 `pnpm lint` 也可以，但全仓 lint 是 CI 必跑项，见 §3）。

## 3. PR CI 覆盖（`.github/workflows/ci.yml`，触发 `pull_request → main`）

`build-and-test` 单 job 顺序：`pnpm install --frozen-lockfile` → better-sqlite3 prebuild → `pnpm build` → `pnpm typecheck` → `pnpm lint` → **`pnpm test:packages:run`**（含 claude-runner 全部 vitest）→ 一串 hermetic shell 测试 → 第 188 行 **`package-onboard-smoke.test.sh`**（③b 断言 `agents/codex-runner-contract.md` 随包分发）。

结论：PR CI 同时提供 (a) 完整 vitest 套件 (b) 契约文件打包存在性，正是 DoD 第 3 条要的"exact-head PR CI 证明"。`concurrency.cancel-in-progress: true`：每次 push 新 head 会取消旧 run，所以**账本提交要在最终 push 之前**（见 §4.3）。

## 4. 沙箱操作坑（来自 slot-2 既往实测，已在本分支核对）

### 4.1 分支与仓

- 远端 `xrliAnnie/flywheel-qa-sandbox`；分支 `project-slot-2-FLY-3043` 与 `origin/main` **0/0 齐平**，无需重锚。
- 远端尚无该分支、尚无 PR（`gh pr list --head project-slot-2-FLY-3043 --state all` = `[]`）。首次 push 用 `-u`。
- `core.hooksPath` 指向 slot 的 push-guard hooks；**不得**改 hooksPath、不得 `--no-verify`（FORCE-PUSH GUARD）。

### 4.2 `flywheel-comm` 调用形态

- `flywheel-comm` 不在 PATH，必须 `node "$FLYWHEEL_COMM_CLI" …`；exec-id 从 `$FLYWHEEL_EXEC_ID` 读，不手敲。
- `progress` 必须在仓库根执行，`--file` 路径含 issue 号；它会**真实 commit** `progress.md`（path-limited）。

### 4.3 Mutation freeze

`progress` 会产生 commit → PR head 变化 → CI 重跑并取消旧 run。因此实施节点的账本终值（N/N）必须写在**最终 push 之前**；push 之后只读（核对 `git rev-parse HEAD` == `gh pr view --json headRefOid`、等 CI、complete），不再补 commit。

### 4.4 `gh pr checks --watch` 空 rollup 立刻退出

PR 刚建时 `statusCheckRollup=[]`，`gh pr checks --watch` 会 exit 1 不等待。要先有界轮询 `gh pr view --json headRefOid,statusCheckRollup` 直到非空再 watch（约 1 分钟）。

### 4.5 代码评审门（Claude 作者族）

implement 节点的评审走法（既往实测）：`gate review_code --no-block` → `request-review --type code` 预期 **409**（reviewer-inversion 守卫，是分流信号不是错误）→ 派 `codex:rescue` 评审到 APPROVED → `codex-review-result --exec-id … --pr-head $(git rev-parse HEAD)` 落账 → `complete --route needs_review --pr <n>`；`complete` 后 Bridge 会补发 FLY-827 指令要求写 `.flywheel/runs/<exec>/codex/code-review.json` 再 `await-codex-gate code`。本 plan 只把这一段作为"提醒"，具体命令以 implement 节点 dispatch 文本注入的合同为准（合同优先）。

### 4.6 PR body

按项目 git 规则：变更摘要 + 测试计划 + `## Linear Issue` 段（`FLY-3043: …` + URL）+ 结尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。`--body-file` 用明确绝对路径（scratchpad），不要用可能被 shell 当重定向的裸文件名。

## 5. 对 plan 的输入

| 结论 | 进 plan 的形式 |
|---|---|
| 改动 = 契约文件 +1 行 + 单测 +1 条断言 | Task 1 / Task 2，各自给出精确 diff 与验证命令 |
| 相关测试命令 + 前置 install | Task 0（install）+ Task 2 的 RED→GREEN 顺序 |
| CI 是完整套件证据 | Task 4 等 CI 绿的有界轮询步骤 |
| Mutation freeze | Task 3 账本 N/N 在 push 前；Task 4 只读 |
| 评审门 | Task 5 提醒 + 以 dispatch 合同为准 |
