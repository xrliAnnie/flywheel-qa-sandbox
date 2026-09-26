# FLY-202 QA 沙箱 fixture 笔记 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md

---

## 0. 一句话

五步产物的**结构**已在 PR #194 上成立，但内容核对发现一处事实错误（告警隔离）；
implement 节点**先验证（结构 + 内容）、只修红项**，保持 PR #194 开放、分支
fast-forward，不 merge。

> 修订记录：R1（Codex design review）后加入内容核对 V7、段落判定改为按空行分块、
> 空白检查拆成提交前/提交后两个时点、C1 同步四态、最终 ledger 先于 push、
> push 后三方 SHA 一致性、显式停止条件。

## 1. 总则

- **分支**：继续 `project-slot-4-FLY-202`（= issue step 5 的 feature branch），在已有
  历史之上叠加；不另建分支、不 rebase、不 force-push、不 `--no-verify`。
- **PR**：复用 #194，不开新 PR（同一 head 分支只能有一个 open PR）。
- **写入范围**（白名单）：内容只改 `doc/qa/sandbox-notes.md`；ledger 只写
  `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md`；另外会改 PR #194 的 body。
  **禁止在 `doc/` 下新增或删除文件**（会让 step 4 快照过期，见 research §4）。
- **TURN**：每次写 worktree 前 `flywheel-comm turn` 必须答 `yours`；`not-yours` 时每
  60–90 秒轮询，不算失败。
- **保留继承内容**：文件末尾 `- FLY-2456 drill marker r1 B1` 保留原位（PR #194 描述承诺）。
- **语言**：`sandbox-notes.md` 保持英文（仓库现状，读者含 QA 脚本）。
- **基线 SHA**：C1 结束时记下 `BASE=$(git rev-parse HEAD)`，V9 用它判断本轮是否增删了
  `doc/` 文件。

## 2. 断言合同（implement 与 QA 共用**同一份断言**，各自**独立实现**检查）

implement 节点把检查写成 scratchpad 里的临时 shell/python 脚本（**不提交进仓库**）；
QA 节点按同一表格独立重写，不复用 implement 的脚本。

| ID | 断言 | 判定要点 |
|---|---|---|
| V1 | 用途段落数 ∈ [2,3] | 取首个 `# ` 标题之后、`## Top-level directories` 之前的正文；按**空行分隔的连续正文块**计数，排除标题、列表、表格、代码块；段内普通换行不拆段。先用两个内存样例自测脚本：去掉段间空行 → 必须判 1 段；每段折成两行但保留段间空行 → 必须判 3 段 |
| V2 | 目录表集合 == 实际顶层目录集合，且每行描述非空 | 只取表格数据行（排除表头行和 `---` 分隔行）；首列去反引号和尾 `/` 后排序，vs `git ls-tree -d --name-only HEAD` 排序后 `diff` 为空；第二列 trim 后非空 |
| V3 | README 摘要 bullet 数 ∈ [8,12] | `## \`packages/qa-framework/README.md\` summary` 到下一个 `## ` 之间以 `- ` 开头的行 |
| V4 | 快照逐字一致 | 抽取唯一 ```text 块 vs 现场 `ls -R doc/ \| head -50`，`diff` 为空 |
| V5a | 候选结果空白卫生（**提交前**） | `git diff --check $(git merge-base origin/main HEAD)`（比较工作区，覆盖未提交编辑） |
| V5b | 已提交范围空白卫生（**提交后**） | `git diff --check origin/main...HEAD` 退出 0 |
| V6 | PR 状态 + SHA 绑定 | `gh pr view 194 --json state,baseRefName,headRefName,headRefOid`：OPEN / main / project-slot-4-FLY-202，且 `headRefOid` == 本地 `HEAD` == `git ls-remote origin refs/heads/project-slot-4-FLY-202` |
| V7 | 内容与来源一致（人工核对，逐条写进 PR body） | 用途段每个事实性断言都能在 `packages/qa-framework/README.md` 或脚本源码找到依据；README 摘要每条 bullet 与对应 section 不矛盾；目录描述与 `ls <dir>` 实际内容不矛盾。**已知红项**：第 2 段称测试不触及 "the production alert queue"，但 README 第 288–311 行写明告警隔离仅在 `test-deploy.sh --alerts` 时生效，默认走生产路径（`scripts/test-deploy.sh` 默认 `ALERTS=0`，`scripts/lead-alert.sh` 未设 env 时用生产队列目录） |
| V8 | 继承 marker 保留 | 文件最后一个非空行 == `- FLY-2456 drill marker r1 B1` |
| V9 | 本轮未增删 `doc/` 文件 | `git diff --diff-filter=AD --name-only $BASE HEAD -- doc/` 为空 |

## 3. Chunks（implement 执行合同）

### C1 — 同步与基线
1. `turn` → `yours`；`git status --porcelain` 必须为空（不空 → 停止并 `ask` 上报）。
2. `git fetch origin`，按 `git rev-list --left-right --count HEAD...origin/project-slot-4-FLY-202` 分四态：
   - `0 0` 相等 → 继续；
   - `0 N` 仅落后 → `git pull --ff-only`；
   - `N 0` 仅领先 → 检查领先 commit 只触及白名单路径（如 design 节点未推送的 progress commit），保留，留到 C4 一起推；越界 → 停止上报；
   - 双向都 > 0（分叉）→ 停止，`ask` 上报 Lead，不 rebase、不 force。
3. 若 PR 显示与 `origin/main` 冲突：`git merge origin/main`（技术同步，不需要 ship 批准）；
   若解决冲突需要越出白名单或违反 V9 → 停止上报。无冲突则**不**主动 merge main。
4. 记 `BASE=$(git rev-parse HEAD)`。
- 验收：工作区 clean；本地不落后远端；`BASE` 已记录。

### C2 — 跑 V1–V4、V7、V8
- V6 此时只检查 state/base/head 名（SHA 绑定留到 C4 后）。**V6 失败不是文档漂移**：
  PR 非 OPEN、base/head 不符或 `gh` 查询失败 → 停止并 `ask` 上报，不进 C3。
- V1–V4、V7、V8 任一红 → 记录红项与原因，进 C3。按 V7 已知红项，本轮 C3 **必然执行**。

### C3 — 只修红项
| 红项 | 修法 |
|---|---|
| V7 告警隔离（已知） | 局部改写第 2 段那一句：Discord/repos 的隔离保持原说法；告警队列改成「只有显式用 `test-deploy.sh --alerts` 部署并配置 alert channel 时才隔离，否则走生产默认路径」。保持 2–3 段，不重写全文，不跑真实告警测试 |
| V7 其它内容矛盾 | 只改那一句/那一条，依据写进 PR body |
| V1 | 调整为 2–3 个正文块 |
| V2 | 按 `git ls-tree -d` 重建缺失/多余行；新目录先 `ls` 再写一行英文描述 |
| V3 | 通读 README 后调整到 ~10 条，覆盖全部 `## ` 级 section |
| V8 | 把 marker 恢复到文件末尾 |
| V4 | **最后**重跑 `ls -R doc/ \| head -50` 覆盖 ```text 块（其它编辑之后执行） |
- 编辑完成后跑 V1–V4、V5a、V7、V8、V9 至全绿，再 commit：
  `docs(FLY-202): refresh QA sandbox fixture notes`（带 Co-Authored-By 尾注）。
- 提交后跑 V5b；红 → 修正后追加一个 commit（不 amend 已推送历史）。若空白错误落在白名单
  之外 → 停止上报，不扩大修复范围。
- 验收：上述断言全绿；本轮 diff（`$BASE..HEAD`）只涉及白名单路径。

### C4 — 最终 ledger → push → SHA 绑定 → PR 描述
1. **先**写最终 ledger：`flywheel-comm progress --phase implement --cursor <m/m> ...`
   （它会自动 `git commit --only` progress.md，但**不会 push**）。
2. 若本地领先远端（含 C1 保留的继承 commit、C3 的内容 commit、第 1 步的 ledger commit）→
   `git push origin project-slot-4-FLY-202`（fast-forward；失败重试一次，仍失败 → `ask`
   上报 Lead，不静默、不 force）。
3. 跑完整 V6：本地 `HEAD` == 远端分支 SHA == PR `headRefOid`。不一致 → 停止上报。
4. `gh pr edit 194` 更新 body：`## Linear Issue`（FLY-202 + URL）、本轮 exec、
   **绑定到该 SHA 的** V1–V9 结果（V7 列出核对依据）、「Fixture only — do not merge」、
   尾注 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
   PR body 修改不产生 commit，不影响 SHA 绑定。
5. CI：记录该 SHA 上的 check 状态；等待 CI 转绿**交由 QA 节点把关**（implement 不为等 CI
   而改动分支）。
- 验收：V6 全绿；PR 未 merge；之后不再产生新的本地 commit。

### C5 — 收尾
- 按 implement 节点注入的 route 完成；**不** merge、不请求 ship、不 dispatch QA。
- C4 之后若因任何原因又写了 ledger，必须重复 C4 第 2–4 步，保证 PR head 包含它。

## 4. 回滚边界

- 本轮可能变化的：`doc/qa/sandbox-notes.md`（内容）、
  `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md`（ledger）、PR #194 body。
- 回滚内容 = 在分支上 `git revert <sha>`（新 commit，不改历史）；PR body 可再次 `gh pr edit`。
- PR #194 不 merge，main 永远不受影响；teardown 由 harness `test-teardown.sh` 负责。

## 5. 负向守卫（不能发生的事）

- 不在 `doc/` 下新增/删除任何文件（V9）。
- 不开第二个 PR；不 force-push；不 `--no-verify`；不 rebase。
- 不删除 FLY-2456 drill marker 行（V8）。旧文件夹 `doc/FLY-202-qa-sandbox-fixture/`
  原样保留（本轮不再往里写；清理不在本 issue 范围）。
- 不碰 `packages/` 代码、不碰生产 Bridge/Discord/Linear 状态。
- 分叉、越界冲突、PR 异常一律停止上报，不自行"修好"。

## 6. QA 节点可验证断言

1. 按 §2 断言合同独立实现，V1–V9 在 PR 最终 head 上全绿（V7 需 QA 独立抽查用途段与
   README 的一致性，尤其是告警隔离措辞）。
2. `git diff origin/main...HEAD --name-only` 只含 `doc/qa/sandbox-notes.md`、
   `doc/FLY-202-qa-sandbox-fixture/{progress.md,workflow-output.json}`（继承）以及
   `engineering/doc/FLY-202-sandbox-notes-e2e/` 下文件。
3. PR #194 OPEN、未 merge；CI 在 PR head SHA 上为绿（QA 负责等待并判定）。

## 7. 取舍记录

| 选项 | 结论 | 理由 |
|---|---|---|
| A. 验证（结构+内容）优先、只修红项（选中） | ✅ | 结构已正确；R1 证明只数数量会放过事实错误，所以加 V7，但修复仍局部 |
| B. 整文件重新生成 | ❌ | 与分支连续性冲突；制造噪音 diff，可能引入回归 |
| C. 新开 PR | ❌ | 同 head 只能有一个 open PR；丢失 #194 的 CI/评审历史 |
| D. 把验证器提交进仓库 | ❌ | fixture 仓库不该长出与任务无关的脚本；也会改变顶层/`doc/` 结构 |
| E. 顺手删旧 `doc/FLY-202-qa-sandbox-fixture/` | ❌ | 超出 issue 范围，且会让 step 4 快照过期 |
| F. 引入 Markdown 解析库判段落 | ❌ | 过度工程；空行分块 + 两个自测样例足够 |
