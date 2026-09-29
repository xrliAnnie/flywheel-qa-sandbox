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
test -n "$FLYWHEEL_EXEC_ID"
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
git status --short --branch
git rev-parse HEAD
git remote get-url origin
```

Expected:

- `turn` 返回 `yours`；否则不写工作树，按 phase keep-alive 协议 park。
- origin 精确为 `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`。
- 分支是 orchestrator 授权的 FLY-3029 feature branch，不是 `main`。
- 记录现场 HEAD；不要为了匹配 issue 中的历史 `bfdea677` 而 reset、rebase 或 force push。
- `$FLYWHEEL_EXEC_ID` 必须是当前 implement body 的运行时身份。禁止填 design exec-id、旧 body id 或其他 phase id；`inbox` 会把消息标记已读，读错 id 会破坏性消费别人的信箱。

- [ ] **Step 2：遵守已记录的 QA identity override**

Lead 已在问题 `e54708b7-4322-417c-bf3e-933fc970e377` 明确回复：继续授权的 slot 5 sandbox 当前头 `1855f7a1a`，不要 reset，也不要转向生产 slot 2 / `bfdea677`。Implement 节点无需重复提问；如果新的 inbox 指令与此冲突，停止写入并请 Lead 澄清。

## Task 2：RED —— 证明 probe 尚未落盘并完成影响面发现

**Files:**
- Inspect: `README.md`
- Exclude after inspection: 所有只引用其他 README fixture/path 的 test/QA 匹配（当前审计分组与理由见 `research.md` §3；数量不是固定合同）

- [ ] **Step 1：搜索旧尾行和新 literal**

Run:

```bash
git fetch origin main
git grep -nF -- 'FLY-1375 land E2E marker 20260722T023540Z' -- README.md
git grep -nF -e 'FLY-2919 N-to-N claude-body probe' origin/main -- README.md
git grep -nF -- 'FLY-2919 N-to-N claude-body probe' -- README.md
tail -n 5 README.md
git diff HEAD -- README.md
git log --format='%H %s' origin/main..HEAD -- README.md
git diff origin/main..HEAD -- README.md
```

Expected decision tree:

- 旧尾行恰好命中一次。
- `origin/main` 中新 literal 必须零命中；若 main 已包含它，停止并向 Lead 报告夹具冲突。
- **新写入路径**：工作树中新 literal 为 0，README 仍以原 marker 和 LF 结束；继续 Task 2 Step 2 后进入 Task 3。
- **换体续跑路径 A（未提交）**：工作树中新 literal 恰好 1 次，`git diff HEAD -- README.md` 只新增该行；这个比较同时覆盖 staged 和 unstaged 变化。跳过 Task 3 Step 1，从 Task 3 Step 2 继续。
- **换体续跑路径 B（已提交）**：工作树中新 literal 恰好 1 次，`git log origin/main..HEAD -- README.md` 存在 subject 精确为 `docs(FLY-3029): add N-to-N claude-body probe` 的 commit，且 branch diff 只新增该行；恢复该 probe SHA，跳过已完成的写入/commit 步骤，从未完成的 progress、push 或 handoff 继续。
- 新 literal 多于 1 次、来源不明、或 README 还有其他变化时，停止并向 Lead 报告；只有重复追加或来源冲突是失败，前一个 body 的可信单行进度是正常续跑状态。

- [ ] **Step 2：按本地测试策略重新发现消费者**

Run:

```bash
git grep -lF -- 'FLY-1375 land E2E marker 20260722T023540Z' -- .
git grep -lF -- 'FLY-2919 N-to-N claude-body probe' -- .
git grep -lF -- 'README.md' -- .
git grep -lF -- 'README.md' -- . | rg '(^|/)(__tests__|tests?|spec|qa)(/|[.-])|(^|/)scripts/(test-|qa-|e2e)|test-slots' | sort
```

Expected: 对完整搜索结果逐项打开匹配行，并记录每一个 test/QA-shaped match 的保留或排除理由；不得把 research 的当前 21 个匹配当作固定清单。当前证据表明它们只使用临时 fixture、包内 README、生成路径、说明链接或注释，与根 README 内容无依赖。`README.md` 的完整路径和文件名相同；父目录是仓库根，没有比 `.` 更窄的可搜索路径 token，因此用全仓消费者审计 + 单文件 diff 覆盖 parent-directory discovery。

## Task 3：GREEN —— 只追加指定一行

**Files:**
- Modify: `README.md:4`

- [ ] **Step 1：应用最小补丁**

Only if Task 2 still matches the researched tail, apply exactly:

```diff
 FLY-1375 land E2E marker 20260722T023540Z
+FLY-2919 N-to-N claude-body probe
```

使用当前 runner 的原生精确编辑工具做一次最小插入：Codex 使用 `apply_patch`，Claude 使用 `Edit`。不要用 shell 重定向、脚本或全文件 formatter 重写；验收以 Step 2 的字节与 diff 断言为准，而不是以工具名称为准。

- [ ] **Step 2：证明 literal 恰好一次且位于尾行**

Run:

```bash
test "$(git grep -nF -- 'FLY-2919 N-to-N claude-body probe' -- README.md | wc -l | tr -d ' ')" = 1
test "$(tail -n 1 README.md)" = 'FLY-2919 N-to-N claude-body probe'
test "$(tail -c 1 README.md | od -An -tx1 | tr -d ' \n')" = '0a'
git diff --check -- README.md
git diff HEAD -- README.md
```

Expected: 三个 `test` 退出 0，最后 byte 是 LF，`git diff --check` 无输出，diff 只包含一行新增且不删除任何原内容。

## Task 4：验证范围并提交

**Files:**
- Commit: `README.md`

- [ ] **Step 1：确认没有相关本地测试，并拒绝 broad suite**

本变更是根 Markdown 内容，Task 2 已逐项证明所有当前 test/QA-shaped match 都不读取其内容；因此不运行 Vitest、package test、build 或 typecheck。定向 `pnpm exec biome check README.md` 在 design 调研中返回 `Checked 0 files`、README ignored、exit 1，证明 Biome 不覆盖 Markdown，所以也不运行全仓 `pnpm lint`。不得用 full-repository/full-package suite 或无关全仓 lint 代替影响面判断。

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
task_probe_sha="$(git rev-parse HEAD)"
git show --format='%H %s' --stat "$task_probe_sha"
node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file engineering/doc/FLY-3029-claude-n-to-n-probe/progress.md --phase implement --cursor 3/5 --next "push probe commit $task_probe_sha"
```

Expected: commit 成功，记录真实 40-character probe SHA；随后 progress 写下 durable cursor，并可能产生一个新的 progress commit，所以 HEAD 不再被假设为 probe commit。后续可按精确 subject 从 `origin/main..HEAD` 恢复 probe SHA，报告必须复制 Git 输出，不凭记忆写占位符。

## Task 5：推送与正常交卷

**Files:**
- No new file changes

- [ ] **Step 1：推送 orchestrator 授权的 feature branch**

Run:

```bash
task_branch="$(git branch --show-current)"
test -n "$task_branch"
test "$task_branch" != main
git push -u origin "$task_branch"
task_probe_sha="$(git log -1 --format='%H' --grep='^docs(FLY-3029): add N-to-N claude-body probe$' origin/main..HEAD -- README.md)"
test -n "$task_probe_sha"
node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file engineering/doc/FLY-3029-claude-n-to-n-probe/progress.md --phase implement --cursor 4/5 --next "verify probe $task_probe_sha and run exact handoff"
git push
```

Expected: 首次 fast-forward push 上传 probe + commit 后 progress；随后 progress 记录 push 完成，再次 push 使 cursor 也远端持久化。禁止 `--no-verify`、force push、修改 hooks 或 push `main`。始终使用运行时的非-main 当前分支，不硬编码 design 时的分支名。

- [ ] **Step 2：验证远端和本地状态**

Run:

```bash
git status --short --branch
task_probe_sha="$(git log -1 --format='%H' --grep='^docs(FLY-3029): add N-to-N claude-body probe$' origin/main..HEAD -- README.md)"
test -n "$task_probe_sha"
git show --format='%H %s' --stat "$task_probe_sha"
git merge-base --is-ancestor "$task_probe_sha" '@{upstream}'
git diff --check origin/main..'@{upstream}' -- README.md
git diff origin/main..'@{upstream}' -- README.md
```

Expected: 工作树没有未提交的 README 变化；锚定的 probe commit 只改 README 一行且是 upstream 祖先；`origin/main..@{upstream}` 的 README diff 只新增该 probe 行。HEAD 可以合法地是后续 progress commit，绝不因此改写历史。

- [ ] **Step 3：按 implement 节点注入的精确 route 交卷**

在完成前运行 `node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"`；禁止使用 design/旧 body 的 id。如有 Lead instruction，完成并用带完整 `[lead-instruction <id>]` 的 `ask --report "DONE: ..."` 回执。然后使用 implement 动态提示给出的 exact completion/handoff command；不要在本计划中臆造 route，不要创建或合并 PR，除非 implement 动态提示明确要求。

交卷报告必须包含：真实 commit SHA、远端 feature branch、README literal count=1，以及“FLY-2919 driver receipt 仍是生命周期验收威权证据”。

## 验收矩阵

| 要求 | 权威证据 | 通过条件 |
|---|---|---|
| 指定文本追加 | `git grep` + `tail` | 精确 literal 恰好一次且为尾行 |
| 没有旁改 | cached diff + `git show <probeSHA>` | probe commit 中 `README.md` 只新增一行 |
| 已提交 | 精确 subject 恢复的 probe SHA | SHA 非空且 commit 内容正确 |
| 已推送 | `merge-base --is-ancestor <probeSHA> @{upstream}` | probe SHA 已包含在 upstream；HEAD 可为 progress commit |
| 正常交卷 | phase completion receipt | implement 节点按注入 route 完成 |
| N-to-N 行为通过 | FLY-2919 driver receipt | 四项生命周期判据全部由 QA 记录 |

## 回滚边界

在提交前若检查失败，撤销只限于本次 README 新增行；不得用 `git reset --hard` 或 `git checkout --` 清理共享工作树。提交并推送后若发现错误，不重写历史；创建一个只移除错误 probe 行的后续 commit，并先向 Lead 报告。设计文档和 progress ledger 不随 README 回滚。
