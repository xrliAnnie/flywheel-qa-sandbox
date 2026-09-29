# FLY-3029 N-to-N QA 探针 — 实施计划
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: research.md

> **For the implement phase worker:** 按 checkbox 顺序执行；不要派 subagent，不要修改 Runner/driver，不要把本合成任务推广到生产。

**Goal:** 在授权的 `flywheel-qa-sandbox` feature branch 根 `README.md` 末尾精确追加一次 `FLY-2919 N-to-N claude-body probe`，提交、推送，并通过正常 DAG handoff 留下可关联 receipt。

**Architecture:** 这是单文件、单行的 Markdown 负载。仓库层用 literal 与 Git 证据证明写入，流程层由 FLY-2919 driver receipt 证明 N-to-N 生命周期；两层保持分离，不新增脚本或运行时代码。

**Tech Stack:** Git、Markdown、`git grep`、Flywheel DAG/receipt。

---

## 文件结构

| 路径 | 动作 | 单一职责 |
|---|---|---|
| `README.md` | 修改 | 承载唯一 probe 行 |
| `engineering/doc/FLY-3029-qa-sandbox-probe/progress.md` | 由阶段节点维护 | 记录 durable cursor；不与 README probe commit 混淆 |

不创建脚本、测试、配置、迁移或额外产物。Design 节点的文档不由 implement 节点重写。

## Task 1：取得 TURN 并确认授权边界

**Files:**
- Inspect: `README.md`
- Inspect: `engineering/doc/FLY-3029-qa-sandbox-probe/{exploration.md,research.md,plan.md,progress.md}`

- [ ] **Step 1：检查 TURN、当前 body 身份、inbox 与工作树**

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

- `turn` 返回 `yours`；否则零工作树写入并按 phase keep-alive 协议 park。
- origin 精确为 `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`。
- 当前分支是 orchestrator 授权的 FLY-3029 feature branch，不是 `main`。
- 记录现场 HEAD；不得为了匹配 issue 中的 `bfdea677` 而 reset、rebase 或 force push。
- `$FLYWHEEL_EXEC_ID` 必须是当前 implement body 的运行时身份；禁止使用 design id 或旧 body id。

- [ ] **Step 2：核对 slot/head 裁决**

读取 `research.md` §1 与本轮 design review/Lead 回复。若 Lead 确认使用 orchestrator 提供的 slot 3/current head，则照常继续；若明确要求其他隔离身份，先结束当前 TURN 并按新编排执行，绝不能自行切槽。任何时候都不得转向生产仓。

## Task 2：RED——证明 probe 尚未落盘并完成影响面发现

**Files:**
- Inspect: `README.md`
- Inspect/exclude: 所有只引用临时 fixture、包内 README、生成路径或说明链接的 test/QA 匹配

- [ ] **Step 1：刷新 main 并搜索旧/新 literal**

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

- 旧 marker 恰好命中一次。
- `origin/main` 中新 literal 必须零命中；若 main 已含它，停止并向 Lead 报告夹具冲突。
- **新写入路径**：工作树中新 literal 为 0，README 仍以原 marker 和 LF 结束；进入 Step 2 后执行 Task 3。
- **换体续跑 A（未提交）**：新 literal 恰好 1 次，`git diff HEAD -- README.md` 只新增该行；跳过 Task 3 Step 1，从验证继续。
- **换体续跑 B（已提交）**：新 literal 恰好 1 次，`origin/main..HEAD` 存在 subject 精确为 `docs(FLY-3029): add N-to-N claude-body probe` 的 commit，且 branch diff 只新增该行；恢复 probe SHA，从未完成的 progress、push 或 handoff 继续。
- 多于 1 次、来源不明或 README 有其他变化时停止并报告。可信单行进度是正常续跑，不是失败。

- [ ] **Step 2：按本地测试策略重新发现消费者**

Run:

```bash
git grep -lF -- 'FLY-1375 land E2E marker 20260722T023540Z' -- .
git grep -lF -- 'FLY-2919 N-to-N claude-body probe' -- .
git grep -lF -- 'README.md' -- .
git grep -lF -- './README.md' -- .
git grep -lF -- 'README.md' -- . | rg '(^|/)(__tests__|tests?|spec|qa)(/|[.-])|(^|/)scripts/(test-|qa-|e2e)|test-slots' | sort
```

Expected: 打开并记录每一个 test/QA-shaped match 的保留或排除理由，不把 research 的当前数量当作固定合同。当前证据表明它们只使用临时 fixture、包内 README、生成路径、说明链接或注释，与根 README 内容无依赖。根目录没有比 `.` 更窄的 parent token，因此全仓消费者审计加单文件 diff 覆盖 parent-directory discovery。

## Task 3：GREEN——只追加指定一行

**Files:**
- Modify: `README.md:4`

- [ ] **Step 1：应用最小补丁**

仅当 Task 2 仍匹配已研究的文件尾部时，使用当前 runner 的原生精确编辑工具应用：Codex 用 `apply_patch`，Claude 用 `Edit`。

```diff
 FLY-1375 land E2E marker 20260722T023540Z
+FLY-2919 N-to-N claude-body probe
```

不要使用 shell 重定向、脚本或 formatter 重写整文件。

- [ ] **Step 2：证明 literal 恰好一次且位于尾行**

Run:

```bash
test "$(git grep -nF -- 'FLY-2919 N-to-N claude-body probe' -- README.md | wc -l | tr -d ' ')" = 1
test "$(tail -n 1 README.md)" = 'FLY-2919 N-to-N claude-body probe'
test "$(tail -c 1 README.md | od -An -tx1 | tr -d ' \n')" = '0a'
git diff --check -- README.md
git diff HEAD -- README.md
```

Expected: 三个 `test` 均退出 0，最后 byte 是 LF，`git diff --check` 无输出，diff 只新增一行且不删除原内容。

## Task 4：验证范围并提交

**Files:**
- Commit: `README.md`

- [ ] **Step 1：确认无需本地测试，禁止 broad suite**

Task 2 若再次证明所有 test/QA-shaped match 都不读取根 README 内容，则不运行 Vitest、package test、build 或 typecheck。Design 调研中的 `pnpm exec biome check README.md` 已返回 `Checked 0 files`、README ignored、exit 1，证明 Biome 不覆盖 Markdown；也不运行全仓 lint。严禁 full-repository/full-package test suite。

- [ ] **Step 2：只暂存 README 并核对 staged diff**

Run:

```bash
git add README.md
git diff --cached --check
git diff --cached --stat
git diff --cached -- README.md
```

Expected: staged stat 是 `README.md | 1 +`；cached diff 只有目标 probe 行。

- [ ] **Step 3：提交并从 Git 读取真实 SHA**

Run:

```bash
git commit -m "docs(FLY-3029): add N-to-N claude-body probe"
task_probe_sha="$(git rev-parse HEAD)"
git show --format='%H %s' --stat "$task_probe_sha"
node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file engineering/doc/FLY-3029-qa-sandbox-probe/progress.md --phase implement --cursor 3/5 --next "push probe commit $task_probe_sha"
```

Expected: probe commit 成功并记录真实 40-character SHA；progress 随后可能生成独立 commit，所以 HEAD 不再被假设为 probe commit。

## Task 5：推送与正常交卷

**Files:**
- No new file changes

- [ ] **Step 1：推送当前授权 feature branch**

Run:

```bash
task_branch="$(git branch --show-current)"
test -n "$task_branch"
test "$task_branch" != main
git push -u origin "$task_branch"
task_probe_sha="$(git log -1 --format='%H' --grep='^docs(FLY-3029): add N-to-N claude-body probe$' origin/main..HEAD -- README.md)"
test -n "$task_probe_sha"
node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file engineering/doc/FLY-3029-qa-sandbox-probe/progress.md --phase implement --cursor 4/5 --next "verify probe $task_probe_sha and run exact handoff"
git push
```

Expected: 首次 fast-forward push 上传 probe 和此前设计/progress commits；第二次 push 持久化 push 后 cursor。禁止 `--no-verify`、force push、改 hooks 或 push `main`。

- [ ] **Step 2：验证远端状态**

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

Expected: 工作树无未提交 README 变化；probe commit 只改一行并且是 upstream 的祖先。HEAD 可以合法地是后续 progress commit。

- [ ] **Step 3：按 implement 节点注入的 exact route 交卷**

完成前运行 `node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"`。收到 Lead instruction 时完成并用带完整 `[lead-instruction <id>]` 的 `ask --report "DONE: ..."` 回执。最后只用 implement 动态提示给出的 completion/handoff command；不在本计划臆造 route，不创建或合并 PR，除非 implement 动态提示明确要求。

交卷报告包含真实 probe SHA、远端 feature branch、literal count=1，并注明 FLY-2919 driver receipt 仍是生命周期验收的威权证据。

## 验收矩阵

| 要求 | 权威证据 | 通过条件 |
|---|---|---|
| 指定文本追加 | `git grep` + `tail` | literal 恰好一次且为尾行 |
| 没有旁改 | cached diff + `git show <probeSHA>` | probe commit 只新增 README 一行 |
| 已提交 | 精确 subject 恢复的 probe SHA | SHA 非空且内容正确 |
| 已推送 | `merge-base --is-ancestor <probeSHA> @{upstream}` | probe SHA 已在 upstream；HEAD 可为 progress commit |
| 正常交卷 | phase completion receipt | implement 按注入 route 完成 |
| N-to-N 行为通过 | FLY-2919 driver receipt | 四项生命周期判据均由 QA 记录 |

## 回滚边界

提交前若检查失败，只撤销本次 README 新增行；不得用 `git reset --hard` 或 `git checkout --` 清理共享工作树。提交并推送后若发现错误，不重写历史；先报告 Lead，再创建只移除错误 probe 行的后续 commit。设计文档与 progress ledger 不随 README 回滚。
