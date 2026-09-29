# FLY-3029 Claude N-to-N 探针 — 实施计划
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: research.md

> **For agentic workers:** 在 implement 节点逐项执行下面的 checkbox；不要派 subagent，不要修改 Runner/driver，不要把本合成任务推广到生产。

**Goal:** 在授权的 `flywheel-qa-sandbox` feature branch 根 `README.md` 末尾精确追加一次 `FLY-2919 N-to-N claude-body probe`，提交、推送，并让正常 DAG handoff 留下可关联的 receipt。

**Architecture:** 这是一个单文件、单行的 Markdown 负载。仓库层以 literal 和 Git 证据证明写入，流程层由 FLY-2919 driver receipt 证明 N-to-N 生命周期；两者保持分离，不新增脚本或运行时代码。

**Tech Stack:** Git、Markdown、`git grep`、Flywheel DAG/receipt。

---

## 文件结构

| 路径 | 动作 | 单一职责 |
|---|---|---|
| `README.md` | 修改 | 承载唯一的 probe 行 |
| `engineering/doc/FLY-3029-claude-n-to-n-probe/progress.md` | 由阶段节点维护 | 记录 durable cursor；不与 README commit 混淆 |

不创建脚本、测试、配置、迁移或额外产物。设计文档已由 design 节点负责，不是 implement 节点需要重写的内容。

## Task 1：取得 TURN 并重新确认边界

**Files:**
- Inspect: `README.md`
- Inspect: `engineering/doc/FLY-3029-claude-n-to-n-probe/{exploration.md,research.md,plan.md,progress.md}`

- [ ] **Step 1：检查当前 TURN、inbox 和工作树**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" turn
node "$FLYWHEEL_COMM_CLI" inbox --exec-id 956363e8-696f-4492-9476-ef5613974289
git status --short --branch
git rev-parse HEAD
git remote get-url origin
```

Expected:

- `turn` 返回 `yours`；否则不写工作树，按 phase keep-alive 协议 park。
- origin 精确为 `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`。
- 分支是 orchestrator 授权的 FLY-3029 feature branch，不是 `main`。
- 记录现场 HEAD；不要为了匹配 issue 中的历史 `bfdea677` 而 reset、rebase 或 force push。

- [ ] **Step 2：检查 Lead 对基线差异问题的回复**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" check e54708b7-4322-417c-bf3e-933fc970e377
```

Expected: 若有明确 Lead 指令，按指令调整；若仍是 `not yet`，继续最小变更，因为问题是非阻塞且当前 worktree/turn 是写权限威权来源。

## Task 2：RED —— 证明 probe 尚未落盘并完成影响面发现

**Files:**
- Inspect: `README.md`
- Exclude after inspection: 11 个只引用其他 README fixture/path 的测试文件（完整理由见 `research.md` §3）

- [ ] **Step 1：搜索旧尾行和新 literal**

Run:

```bash
git grep -nF -- 'FLY-1375 land E2E marker 20260722T023540Z' -- README.md
git grep -nF -- 'FLY-2919 N-to-N claude-body probe' -- README.md
tail -n 5 README.md
```

Expected before write:

- 旧尾行恰好命中一次。
- 新 literal 零命中，第二条命令退出 1。
- README 以现有 marker 和 LF 结束。

If the new literal already exists: stop without editing, capture `git log -1 -- README.md`, and report the pre-existing state to Lead. Duplicate append is a failure, not a success path.

- [ ] **Step 2：按本地测试策略重新发现消费者**

Run:

```bash
git grep -lF -- 'FLY-1375 land E2E marker 20260722T023540Z' -- .
git grep -lF -- 'FLY-2919 N-to-N claude-body probe' -- .
git grep -lF -- 'README.md' -- .
git grep -nF -- 'README.md' -- packages/edge-worker/src/__tests__/SkillInjector.test.ts packages/flywheel-cli/src/__tests__/migrate-agents-path.test.ts packages/onboard-shell/__tests__/onboard-shell-publish-gate.test.sh packages/teamlead/src/__tests__/fly152-reply-discipline.test.ts packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts packages/teamlead/src/__tests__/workflow-decision-routes.test.ts packages/teamlead/src/bridge/publish-broker/__tests__/shell-publish.e2e.test.ts scripts/__tests__/package-onboard-version-injection.test.sh scripts/__tests__/package-onboard.test.sh scripts/__tests__/test-setup-doc-flow.sh scripts/__tests__/test-setup-new-project.sh
```

Expected: root `README.md` 内容没有测试消费者。把 11 个 test-shaped match 逐项记录为排除，理由是临时 fixture、包内 README 或文件名清单，与根 README 内容无依赖。`README.md` 位于仓库根，父目录没有比 `.` 更窄的可搜索路径 token；因此以单文件 diff 和上述全仓文件名消费者审计替代无意义的 `.` 字面搜索。

## Task 3：GREEN —— 只追加指定一行

**Files:**
- Modify: `README.md:4`

- [ ] **Step 1：应用最小补丁**

Only if Task 2 still matches the researched tail, apply exactly:

```diff
 FLY-1375 land E2E marker 20260722T023540Z
+FLY-2919 N-to-N claude-body probe
```

Use `apply_patch`; do not rewrite the file through shell redirection, formatter, script, or editor-wide normalization.

- [ ] **Step 2：证明 literal 恰好一次且位于尾行**

Run:

```bash
test "$(git grep -nF -- 'FLY-2919 N-to-N claude-body probe' -- README.md | wc -l | tr -d ' ')" = 1
test "$(tail -n 1 README.md)" = 'FLY-2919 N-to-N claude-body probe'
git diff --check -- README.md
git diff -- README.md
```

Expected: 两个 `test` 退出 0，`git diff --check` 无输出，diff 只包含一行新增且不删除任何原内容。

## Task 4：验证范围并提交

**Files:**
- Commit: `README.md`

- [ ] **Step 1：确认没有相关本地测试，并拒绝 broad suite**

本变更是根 Markdown 内容，Task 2 已证 11 个 test-shaped match 全部无关；因此不运行 Vitest、package test、build 或 typecheck。不得用 full-repository/full-package suite 代替影响面判断。

- [ ] **Step 2：只暂存 README 并核对 staged diff**

Run:

```bash
git add README.md
git diff --cached --check
git diff --cached --stat
git diff --cached -- README.md
```

Expected: staged stat 是 `README.md | 1 +`；cached diff 只有指定 probe 行。

- [ ] **Step 3：提交并从 Git 读取真实 SHA**

Run:

```bash
git commit -m "docs(FLY-3029): add N-to-N claude-body probe"
git log -1 --format='%H %s'
```

Expected: commit 成功，输出真实 40-character SHA 和上述 subject。后续报告必须复制这个 SHA，不凭记忆写占位符。

## Task 5：推送与正常交卷

**Files:**
- No new file changes

- [ ] **Step 1：推送 orchestrator 授权的 feature branch**

Run:

```bash
git push -u origin project-slot-5-FLY-3029
```

Expected: fast-forward push 成功并设置 upstream。禁止 `--no-verify`、force push、修改 hooks 或 push `main`。若实际授权分支名在 implement 激活时不同，使用 `git branch --show-current` 的非-main FLY-3029 分支，不硬编码错误目标。

- [ ] **Step 2：验证远端和本地状态**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse '@{upstream}'
git show --stat --oneline --decorate HEAD
```

Expected: 工作树没有未提交的 README 变化，本地 HEAD 与 upstream SHA 相同，HEAD commit 只新增 probe 行。

- [ ] **Step 3：按 implement 节点注入的精确 route 交卷**

在完成前再次运行 inbox；如有 Lead instruction，完成并用带完整 `[lead-instruction <id>]` 的 `ask --report "DONE: ..."` 回执。然后使用 implement 动态提示给出的 exact completion/handoff command；不要在本计划中臆造 route，不要创建或合并 PR，除非 implement 动态提示明确要求。

交卷报告必须包含：真实 commit SHA、远端 feature branch、README literal count=1，以及“FLY-2919 driver receipt 仍是生命周期验收威权证据”。

## 验收矩阵

| 要求 | 权威证据 | 通过条件 |
|---|---|---|
| 指定文本追加 | `git grep` + `tail` | 精确 literal 恰好一次且为尾行 |
| 没有旁改 | cached/final commit diff | `README.md` 只新增一行 |
| 已提交 | `git log -1` | subject 正确且 SHA 可复制 |
| 已推送 | local/upstream `rev-parse` | SHA 相同 |
| 正常交卷 | phase completion receipt | implement 节点按注入 route 完成 |
| N-to-N 行为通过 | FLY-2919 driver receipt | 四项生命周期判据全部由 QA 记录 |

## 回滚边界

在提交前若检查失败，撤销只限于本次 README 新增行；不得用 `git reset --hard` 或 `git checkout --` 清理共享工作树。提交并推送后若发现错误，不重写历史；创建一个只移除错误 probe 行的后续 commit，并先向 Lead 报告。设计文档和 progress ledger 不随 README 回滚。
