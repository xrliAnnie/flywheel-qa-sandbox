# FLY-202 QA 沙箱 fixture 笔记 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md

---

## 0. 一句话

五步产物已在 PR #194 上成立；implement 节点**先验证、只在漂移时修改**，保持 PR #194
开放、分支 fast-forward，不 merge。

## 1. 总则

- **分支**：继续 `project-slot-4-FLY-202`（= issue step 5 的 feature branch），在
  `2ba0c9e` 之上叠加；不另建分支、不 rebase、不 force-push。
- **PR**：复用 #194，不开新 PR（同一 head 分支只能有一个 open PR；新开会制造重复）。
- **写入范围**：只允许改 `doc/qa/sandbox-notes.md`；过程文档/ledger 只写
  `engineering/doc/FLY-202-sandbox-notes-e2e/`。**禁止在 `doc/` 下新增或删除文件**
  （会让 step 4 快照过期，见 research §4）。
- **TURN**：每次写 worktree 前 `flywheel-comm turn` 必须答 `yours`；`not-yours` 时每
  60–90 秒轮询，不算失败。
- **保留继承内容**：文件末尾 `- FLY-2456 drill marker r1 B1` 保留原位（PR #194 描述承诺）。
- **语言**：`sandbox-notes.md` 保持英文（仓库现状，读者含 QA 脚本）。

## 2. 验证器（implement 与 QA 共用，一个脚本、一个真相）

implement 节点把下面的检查写成 scratchpad 里的临时 shell 脚本（**不提交进仓库**，避免
给 fixture 仓库加无关文件），对 `doc/qa/sandbox-notes.md` 跑：

| ID | 断言 | 判定命令要点 |
|---|---|---|
| V1 | 用途段落数 ∈ [2,3] | `## Top-level` 之前、非空、非 `#` 开头的行数 |
| V2 | 目录表集合 == 实际顶层目录集合 | 表格首列（去反引号和尾 `/`）排序后 vs `git ls-tree -d --name-only HEAD` 排序后，`diff` 为空 |
| V3 | README 摘要 bullet 数 ∈ [8,12] | `## \`packages/qa-framework/README.md\` summary` 到下一个 `## ` 之间的 `- ` 行 |
| V4 | 快照逐字一致 | 抽取 ```text 块 vs 现场 `ls -R doc/ \| head -50`，`diff` 为空 |
| V5 | 空白卫生 | `git diff --check origin/main...HEAD` 退出 0 |
| V6 | PR 状态 | `gh pr view 194 --json state,baseRefName,headRefName` = OPEN / main / project-slot-4-FLY-202 |

V2 用 `git ls-tree`（只看 tracked）而不是 `find`：未 tracked 的本地目录（如 harness
临时产生的）不应进表。当前两者都为 17，一致。

## 3. Chunks（implement 执行合同）

### C1 — 同步与基线
1. `turn` → `yours`。
2. `git fetch origin`；确认本地 == `origin/project-slot-4-FLY-202`（否则 `git pull --ff-only`）。
3. 若 `origin/main` 有新 commit 且 PR 出现冲突：`git merge origin/main`（技术同步，
   不需要 ship 批准），解决冲突后继续。无冲突则**不**主动 merge main（避免无意义 diff）。
- 验收：工作区 clean、与远端同步。

### C2 — 跑验证器 V1–V6
- 全绿 → 跳过 C3，直接 C4。
- 任一红 → 记录哪条红、为什么，进 C3。

### C3 — 只修漂移项（条件执行）
| 红项 | 修法 |
|---|---|
| V1 | 重写用途段为 2-3 段（内容参照 `packages/qa-framework/README.md` Test Slot 节 + 本仓库实际结构） |
| V2 | 按 `git ls-tree -d` 重建表；新增目录写一行英文描述（先 `ls` 该目录再写，不臆测） |
| V3 | 通读 README 后重写到 ~10 条；覆盖所有 `## ` 级 section |
| V4 | **最后**重跑 `ls -R doc/ \| head -50` 覆盖 ```text 块（必须在其它编辑之后，且 C3 本身不在 `doc/` 下新增文件） |
| V5 | 去掉行尾空白 |
- 改完重跑 V1–V5 至全绿。
- commit：`docs(FLY-202): refresh QA sandbox fixture notes`（带 Co-Authored-By 尾注）。
- 验收：V1–V5 全绿；diff 只涉及 `doc/qa/sandbox-notes.md`。

### C4 — push + PR 描述
- 有新 commit → `git push origin project-slot-4-FLY-202`（fast-forward；失败重试一次，
  仍失败则 `flywheel-comm ask` 上报 Lead，不静默、不 force）。
- `gh pr edit 194` 更新 body：`## Linear Issue`（FLY-202 + URL）、本轮 exec `814e38bd`、
  V1–V6 结果、「Fixture only — do not merge」、尾注
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
- 无新 commit 时也更新 body 里的核验记录（让 QA 看到本轮真的验过）。
- 验收：V6 绿；PR 未 merge。

### C5 — 收尾
- 更新 `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md`（`--phase implement`）。
- 按 implement 节点注入的 route 完成；**不** merge、不请求 ship、不 dispatch QA。

## 4. 回滚边界

- 唯一可能被改的文件是 `doc/qa/sandbox-notes.md`；回滚 = 在分支上 `git revert <sha>`
  （新 commit，不改历史）。
- PR #194 不 merge，main 永远不受影响；teardown 由 harness `test-teardown.sh` 负责。

## 5. 负向守卫（不能发生的事）

- 不在 `doc/` 下新增/删除任何文件。
- 不开第二个 PR；不 force-push；不 `--no-verify`。
- 不删除 FLY-2456 drill marker 行。旧文件夹 `doc/FLY-202-qa-sandbox-fixture/` 原样保留
  （本轮不再往里写；清理不在本 issue 范围）。
- 不碰 `packages/` 代码、不碰生产 Bridge/Discord/Linear 状态。

## 6. QA 节点可验证断言

1. V1–V6 在 PR 最终 head 上全绿（QA 独立重写同样的检查，不复用 implement 的脚本）。
2. `git diff origin/main...HEAD --name-only` 只含 `doc/qa/sandbox-notes.md`、
   `doc/FLY-202-qa-sandbox-fixture/{progress.md,workflow-output.json}` 以及
   `engineering/doc/FLY-202-sandbox-notes-e2e/` 下文件。
3. PR #194 OPEN、未 merge、CI 绿。

## 7. 取舍记录

| 选项 | 结论 | 理由 |
|---|---|---|
| A. 验证优先、只修漂移（选中） | ✅ | 产物已正确；重写只会制造噪音 diff，还可能引入回归 |
| B. 整文件重新生成 | ❌ | 与分支连续性要求冲突；五步已满足，无收益 |
| C. 新开 PR | ❌ | 同 head 只能有一个 open PR；丢失 #194 的 CI/评审历史 |
| D. 把验证器提交进仓库 | ❌ | fixture 仓库不该长出与任务无关的脚本；也会改变顶层/`doc/` 结构 |
| E. 顺手删旧 `doc/FLY-202-qa-sandbox-fixture/` | ❌ | 超出 issue 范围，且会让 step 4 快照过期 |
