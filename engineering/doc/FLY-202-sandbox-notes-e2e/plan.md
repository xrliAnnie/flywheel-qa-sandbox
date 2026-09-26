# FLY-202 QA 沙箱 fixture 说明刷新 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md

> **For agentic workers:** 在本 DAG 的 implement 节点按任务顺序执行；先取得 implement TURN，并逐项更新同目录 `progress.md`。不要 dispatch successor，不要 merge 或请求 ship authority。

**Goal:** 原位刷新 `doc/qa/sandbox-notes.md`，逐项满足 FLY-202 的五个 fixture 要求，并对 sandbox `main` 创建一个 open PR。

**Architecture:** 使用单一稳定 Markdown 路径作为 fixture 产物。用途说明来自已验证的 test-slot contract；目录表、README 摘要和 `doc/` tree 分别从当前文件系统、当前 README、当前命令输出生成。Git branch 与 PR 提供真实 Runner E2E 所需的远端副作用，但 merge 留给后续 founder-gated 流程。

**Tech Stack:** Markdown、POSIX shell / zsh、Git、GitHub CLI；不修改 TypeScript 或任何生产代码。

---

## 文件边界

| 文件 | 动作 | 单一职责 |
| --- | --- | --- |
| `doc/qa/sandbox-notes.md` | 修改 | FLY-202 的五步用户交付物 |
| `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md` | 由 `flywheel-comm progress` 更新 | durable phase cursor |

`exploration.md`、`research.md`、`plan.md` 和 founder HTML 已由 design 节点交付；implement 节点只在收到 design-correction 时增量修改它们。

### Task 0: 取得 TURN 并确认分支基线

**Files:** 无内容修改。

- [ ] **Step 1: 取得 implement TURN 并读 mailbox**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" turn
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
```

Expected: `turn` 返回 `yours phase=implement` 后才可写 shared worktree；mailbox 使用 implement phase-session 自己的 exec-id，指令逐条处理并按协议回执。禁止复制 design / QA session 的 exec-id，否则会读取并 ACK 另一个 session 的 mail。

- [ ] **Step 2: 确认分支没有漂移或已发布历史冲突**

Run:

```bash
git fetch origin main
git branch --show-current
git rev-list --count origin/main..HEAD
git rev-list --count HEAD..origin/main
git ls-remote --heads origin project-slot-6-FLY-202
git merge-base --is-ancestor origin/project-slot-6-FLY-202 HEAD
```

Expected: branch=`project-slot-6-FLY-202`；ahead 只包含本 issue 的 design/progress commits；已发布 remote head 是当前 HEAD 的祖先。

若 `git rev-list --count HEAD..origin/main` 大于 0，在生成目录表或 tree snapshot **之前**执行技术同步：

```bash
node "$FLYWHEEL_COMM_CLI" turn
git merge --no-edit origin/main
git push
git rev-list --count HEAD..origin/main
```

Expected after sync: behind=`0`。合并 `origin/main` 不需要 ship approval，也不得改写历史。若只在 `doc/qa/sandbox-notes.md` 冲突，以 `origin/main` 的最新文件为刷新起点，再按本计划重新生成四个区块；若冲突超出本 issue 文档范围，保持 merge state 并通过 Lead question gate 请求裁决。任何路径都不得 rebase 已发布分支或 force-push。

- [ ] **Step 3: 按本地测试政策发现受 literal 影响的文件**

Run:

```bash
git grep -lF -- 'FLY-202-generalized-e2e' || true
git grep -lF -- 'FLY-145-s6-retry-product-test' || true
git grep -nF -- 'sandbox-notes.md'
```

Expected: 旧、新 tree literal 至少命中目标 notes 或历史设计资料。只修改 `doc/qa/sandbox-notes.md`；legacy FLY-202 diagrams/design 是历史材料，记录为排除项，不随当前 tree snapshot 改写。

### Task 1: 建立失败基线

**Files:** Inspect `doc/qa/sandbox-notes.md`。

- [ ] **Step 1: 证明当前内嵌 tree 已过期**

Run:

```bash
diff -u \
  <(LC_ALL=C ls -R doc/ | head -50) \
  <(awk '/^## `doc\/` listing/{s=1} s && /^```text$/{c=1;next} c && /^```$/{exit} c{print}' doc/qa/sandbox-notes.md)
```

Expected: FAIL/non-zero；diff 显示旧 block 含 `FLY-202-generalized-e2e`，当前输出含 `FLY-145-s6-retry-product-test`。若意外相同，仍检查用途说明、目录集合与 README 摘要；不要制造无意义文本 churn。

### Task 2: 刷新用途说明、目录表与 README 摘要

**Files:** Modify `doc/qa/sandbox-notes.md`。

- [ ] **Step 1: 写 2–3 段用途说明**

使用 `# Flywheel QA Sandbox Notes` 标题，随后写三段，各自只承担一个职责：

1. 说明仓库是 test-slot 的隔离 target，运行真实 Linear → Bridge → Runner 路径而非 synthetic fixture。
2. 说明安全边界：slot 可以在 sandbox clone 中 branch / commit / push / PR，但不碰生产 repo、频道、alert queue 或数据库。
3. 说明 disposable / repeatable 属性与 `test-deploy.sh` → `inject-linear-issue.sh` → `test-teardown.sh` 生命周期，并明确生产 Lead/Runner 不得 pick up FLY-202。

保留真实名词（`flywheel-qa-sandbox`、PreHydrator、`FLYWHEEL_RUNNER_START_POINT`），首次出现时用一句白话解释，不写当前 slot 之外的临时绝对路径。

- [ ] **Step 2: 现场生成全部顶层目录集合**

Run:

```bash
git ls-tree -d --name-only HEAD | LC_ALL=C sort
```

Expected on the researched baseline: 17 tracked rows—`.claude`、`.flywheel`、`.github`、`.lead`、`.serena`、`agents`、`doc`、`docs`、`engineering`、`fleet`、`packages`、`patches`、`product`、`qa-fly294`、`qa-fly310`、`scripts`、`supabase`。使用 Git tree 而不是 filesystem `find`，避免把 `node_modules/`、`dist/` 或工具临时目录写入仓库说明。若现场 tracked 集合变化，以现场为准并为每个新目录查证后写一行描述。

- [ ] **Step 3: 写目录表**

在 `## Top-level directories` 下写 `Directory | Description` 两列表。第一列用反引号和尾随 `/`；第二列把 `research.md` §3 的事实职责转述成英文，确保整份 target notes 语言一致。不得加入 `.git/`、普通文件、符号链接或未跟踪目录。

- [ ] **Step 4: 重读 README 并写恰好 10 条转述 bullet**

Run:

```bash
cat packages/qa-framework/README.md
```

使用精确 heading ``## `packages/qa-framework/README.md` summary``，并覆盖 `research.md` §4 的十个主题。每条 bullet 一句话；保留脚本、环境变量和 contract 文件名的准确拼写，不复制整段原文。

### Task 3: 捕获指定命令的真实输出

**Files:** Modify `doc/qa/sandbox-notes.md`。

- [ ] **Step 1: 在前三部分写完后运行指定命令**

Run:

```bash
LC_ALL=C ls -R doc/ | head -50
```

Expected: 50 行 stdout；`LC_ALL=C` 固定排序，使 implement 和 QA phase-session 复跑一致。当前 baseline 首个 issue folder 为 `FLY-145-s6-retry-product-test`。

- [ ] **Step 2: 原样写入 fenced block**

使用精确 heading ``## `doc/` listing``。写明 `Command: ls -R doc/ | head -50` 和 `Locale: LC_ALL=C`，随后使用 `text` fenced block。复制 stdout 原文，不修正 `ls` 产生的 `doc//...` 显示，也不手工排序。

### Task 4: 运行 docs-only 定向验证

**Files:** Verify `doc/qa/sandbox-notes.md` and branch diff。

- [ ] **Step 1: 比对目录集合**

Run:

```bash
diff -u \
  <(git ls-tree -d --name-only HEAD | LC_ALL=C sort) \
  <(sed -n '/^## Top-level directories$/,/^## /p' doc/qa/sandbox-notes.md | awk -F'`' '/^\| `/{gsub(/\/$/, "", $2); print $2}' | LC_ALL=C sort)
```

Expected: PASS/no output。

- [ ] **Step 2: 验证摘要 bullet 数量**

Run:

```bash
test "$(sed -n '/^## `packages\/qa-framework\/README.md` summary$/,/^## /p' doc/qa/sandbox-notes.md | grep -c '^- ')" -eq 10
```

Expected: exit 0。

- [ ] **Step 3: 比对 tree block**

Run:

```bash
diff -u \
  <(LC_ALL=C ls -R doc/ | head -50) \
  <(awk '/^## `doc\/` listing/{s=1} s && /^```text$/{c=1;next} c && /^```$/{exit} c{print}' doc/qa/sandbox-notes.md)
```

Expected: PASS/no output。

- [ ] **Step 4: 检查格式与 scope**

Run:

```bash
git diff --check
git status --short
git diff --name-only origin/main...HEAD
git diff -- doc/qa/sandbox-notes.md
```

Expected: 无 whitespace error；变更只包含 `doc/qa/sandbox-notes.md` 与 `engineering/doc/FLY-202-sandbox-notes-e2e/` 下的本 issue artifacts。禁止用 bare `vitest`、package test alias 或 full-suite command；本任务没有 TypeScript 变更，因此不需要 `vitest related`。

### Task 5: Commit、push 并创建 PR

**Files:** Commit `doc/qa/sandbox-notes.md` and updated `progress.md` if present。

- [ ] **Step 1: Commit implement artifact**

Run:

```bash
git add doc/qa/sandbox-notes.md engineering/doc/FLY-202-sandbox-notes-e2e/progress.md
git diff --cached --check
git commit -m "docs(FLY-202): refresh QA sandbox fixture notes"
```

Expected: 一个 docs-only commit；若 progress 已被其专用命令单独 commit，则 `git add` 只暂存 notes。

- [ ] **Step 2: Push feature branch**

Run:

```bash
git push -u origin project-slot-6-FLY-202
```

Expected: fast-forward push 成功并建立 upstream。不得使用 `--no-verify`；若遇 non-fast-forward，不得自行 force-push。

- [ ] **Step 3: 创建对 sandbox main 的 PR**

Run:

```bash
gh pr create \
  --repo xrliAnnie/flywheel-qa-sandbox \
  --base main \
  --head project-slot-6-FLY-202 \
  --title "docs(FLY-202): refresh QA sandbox fixture notes" \
  --body-file - <<'EOF'
## Linear Issue

FLY-202 — https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up

## Summary

- refresh the 2–3 paragraph sandbox purpose statement
- inventory every tracked top-level directory with a one-line description
- summarize `packages/qa-framework/README.md` in 10 bullets
- capture `LC_ALL=C ls -R doc/ | head -50` in a fenced block

## Verification

- directory set matches `git ls-tree -d --name-only HEAD`
- README summary contains exactly 10 bullets
- fenced tree block matches the locale-pinned command output
- `git diff --check` passes and the PR is docs-only

## Boundary

Open PR only. Not merged; awaiting downstream QA and founder gate.
EOF
```

`--body-file -` 从当前命令 stdin 读取正文，因此并行 slot 不共享临时文件，也不会复用旧证据。正文不得加入 secret、本机 credential 或未经本轮验证的结果。

- [ ] **Step 4: 验证 PR 证据**

Run:

```bash
gh pr view --repo xrliAnnie/flywheel-qa-sandbox --json url,state,baseRefName,headRefName,files,commits
```

Expected: `state=OPEN`、`baseRefName=main`、`headRefName=project-slot-6-FLY-202`；files 仅为 FLY-202 notes 与 design artifacts。记录 URL，按 implement 节点注入的 review、completion 和 park 协议交接；不要 merge。

## QA 节点验收合同

1. 重新读取 issue 五项要求，并逐项映射到 PR exact head。
2. 复跑 Task 4 的四类定向验证，不扩大为 full package/repository suite。
3. 验证 PR open、base/head 正确、没有生产代码/config 变更。
4. 若 tree 在 implement 后因同分支后续 doc 变化而漂移，明确指出具体行并要求在 exact head 修正；不能把宽泛的“Markdown looks fine”当成通过证据。
