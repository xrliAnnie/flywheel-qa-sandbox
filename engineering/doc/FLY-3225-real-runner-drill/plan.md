# FLY-3225 真 runner 通用演练 — 实施计划
Issue: FLY-3225 (https://linear.app/geoforge3d/issue/FLY-3225/qa-sbx-fly-3225-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 1. 目标与边界

529 测试房间内，只用两行 Markdown 文件验证「首交 → QA 故意打回 → 按本次裁决编号修复 → 复验」；不改 Linear 的状态、评论或标签，不部署任何房间。

本轮已 fetch 并读取 `origin/main:qa-sbx/fly3225/README.md`；main 版本 `bd42785c98e8`，分支 `project-slot-3-FLY-3225`。继承的练习文件第二行是 `FIXED-FOR-CLAIM 1`，那是上一轮（run `37fb0f88`，PR #549 已合并）的结果，只是历史证据，不是本轮的判轮依据。本轮 run 为 `ee861e33-a46c-42b1-8e4f-dcba059c2934`，设计执行为 `355da9df-c699-49cc-bcc7-4a49ad1f12a2`，从 main `bd42785c98e83707577d16ef04d096789b79e603` 起步，保留已有计划和页面并刷新本轮身份。设计批准必须由本次执行重新注册的评审确认。

README 是演练内容契约：实现节点主动修改的唯一文件是 `qa-sbx/fly3225/<git 分支名>.md`。`flywheel-comm progress` 自动提交的本文件夹 `progress.md` 是流程账本。默认 milestone、DOC-FLOW 实现说明、相邻路径测试均不新增；完成摘要可写 `adjacent paths: N/A (docs-only drill)`。设计复用本文件夹，按 README 只写短计划，不新增探索或研究文档；保留流程强制的设计 HTML 和两份 Mermaid 图源。设计不改练习文件、不派发后继、不申请 ship、不合并。审计与方案比较记录在此短计划和页面：采用本次指令加持久账本；否决从旧文件推断轮次、增加代码或部署测试房间。

## 2. 实现步骤与稳定身份

1. 先运行本节点注入的 TURN；只有 `yours` 可写。重新读取 main 上的 README，运行 `git branch --show-current` 得到当前文件名，不硬编码其它房间的路径。
2. 首次接手、尚未提交本 run 的实现时，取得设计交接 HEAD，通过本节点的 `progress --handoff` 保存单行状态，含 `runId`、完整 SHA `implBase`、`firstHandin` 和 `ownCommits`。首交之前 `firstHandin` 为空。重启只复用同一 run 的基线，不能把已实现的 HEAD 重新当起点，也不能复用 main 上上一轮的账本身份。每次更新保留所有已有状态字段；`--pointer` 只支持固定的文档指针，不支持这些自定义状态键。
3. 真正的首次交付写恰好两行，末尾保留换行：第一行 `QA-SBX FLY-3225 drill`，第二行 `AWAITING-QA`。继承第二行不同则覆盖；文件已经是目标内容时不制造 diff。提交后用同一 `--handoff` 字段记录本 run 的 `firstHandin` 完整 SHA 和本节点自己的提交 SHA 清单 `ownCommits`。
4. 收到本次 `QA fix context` 时，其标题之后的第一行 `QA verdict to fix: claim <id> ...` 指定要修的裁决；只把第二行改为 `FIXED-FOR-CLAIM <id>`，编号逐字相同，其余不变，再次交付。文件已是目标值时允许无改动。
5. 首交之后没有修复上下文的唤醒（CI 返工、集成同步、冲突解决或后续反馈）不自动把第二行重置为 `AWAITING-QA`。遵守这次唤醒的限定任务；冲突解决只解决冲突，保留最近一次正确的第二行。首交与修复都以本 run 的持久身份和本次任务为准，不能由继承内容猜测。
6. 普通提交信息可用 `docs(qa-sbx): FLY-3225 drill hand-in`。提交信息及 PR 标题均不得包含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`。CI 必须检查最终交付的确切提交。

## 3. QA 验收映射

QA 轮次只由本次 QA 指令决定；没有 `QA re-verification context` 为首轮，有该块为复验，编号取自 `Previous QA verdict: claim <id>`。不得用旧文件、旧 claim 或历史提交判轮。

| 准则 id | 首轮 | 复验 |
|---|---|---|
| `file-shape` | 文件存在且第一行恰为 `QA-SBX FLY-3225 drill` 则 pass | 同左 |
| `fixed-for-claim` | **总是 fail**；evidence 恰为 `round 1: no previous QA claim yet` | 第二行恰为 `FIXED-FOR-CLAIM <id>`，且编号来自本次复验指令才 pass |
| `e2e_529_exempt` | status `not_run`，`exempt_category: docs_only`；reason：纯文档演练，规则禁止部署房间 | 同左 |

每条准则 title 少于 120 字符，evidence 少于 80 字符。

## 4. 验证与交付证据

- 完整内容比较必须读取成功后再比较，排除多余行和错误编号。下列命令中 `expected_line2` 是本次任务的精确第二行（首交固定 `AWAITING-QA`；修复使用指令中的实际编号），不能填继承的旧编号：
  ```sh
  drill_branch=$(git branch --show-current) || exit 1
  drill_path="qa-sbx/fly3225/$drill_branch.md"
  expected_line2='AWAITING-QA'
  printf 'QA-SBX FLY-3225 drill\n%s\n' "$expected_line2" > /tmp/fly3225-expected-content
  git show "HEAD:$drill_path" > /tmp/fly3225-actual-content || exit 1
  cmp /tmp/fly3225-expected-content /tmp/fly3225-actual-content || exit 1
  ```
  修复时先把 `expected_line2` 设置成实际的 `FIXED-FOR-CLAIM <id>`。完整字节比较检查恰好两行及末尾换行。相对本 run 首交的练习文件 diff 只应替换第二行；如果同编号修复使相对实现基线的净 diff 再次为空，仍以当前内容为证据。
- 范围检查针对**本实现节点主动提交的每一个改动提交**。从同一 run 账本读取并确认实际 `own_change_sha`，不要把整个共享分支的 tree diff 误当作本节点改动。对每个自己的非 merge 提交，运行：
  ```sh
  files=$(git diff-tree --root --no-commit-id --name-only -r "$own_change_sha") || exit 1
  printf '%s\n' "$files" | grep -Fvx -e '' \
    -e "$drill_path" \
    -e 'engineering/doc/FLY-3225-real-runner-drill/progress.md'
  scope_status=$?
  test "$scope_status" -eq 1 || exit 1
  ```
  grep 退出 1 且无输出表示没有越界路径；0 表示发现越界，2 或更大表示检查出错。先确认读取成功再过滤。交付时还要核对共享分支当前练习文件内容和本节点提交清单。**绝不为通过范围检查去回滚 main 合并进来的改动、删除 QA 证据或撤销其他节点提交。** 合法技术同步按其限定指令执行并记录合并基线；遇到归属不明的路径如实报告，不私自恢复旧树。
- 实现不改计划、设计 HTML、图源、各 README、代码或兄弟练习单。不会为此新增自动测试代码或运行仓库/包全套测试。生产代码未变、TypeScript 未变，没有相关包构建或类型检查。
- 提交后读取实际提交信息和实际 PR 标题再检查跳过 CI 标记，任何读取失败都不能解释成通过：
  ```sh
  PAT='\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:'
  msgs=$(git log --format=%B "$impl_base..HEAD") || exit 1
  title=$(gh pr view --json title -q .title) || exit 1
  test -n "$title" || exit 1
  printf '%s\n' "$msgs" | grep -iE "$PAT"
  msg_status=$?
  printf '%s\n' "$title" | grep -iE "$PAT"
  title_status=$?
  test "$msg_status" -eq 1 && test "$title_status" -eq 1 || exit 1
  ```
  `impl_base` 必须来自同一 run 的持久 `implBase`；历史上 main 的旧提交不作为本轮提交风格模板。PR 建立前仅检查已有提交，建好后必须核对实际标题。最终 full-suite 证据只认冻结交付提交的 `CI OK`；本地文档比较不代表全套测试通过。

## 5. 风险、回退与设计交接

主要风险是误用旧编号、把维护唤醒当新首交、读取失败被当作空检查，以及为了范围检查回滚他人改动；分别由本轮账本身份、首交标记、失败即停止的读取检查和提交归属检查约束。

回退没有服务或数据迁移：只撤销本节点对练习文件的修改，恢复同一 run 的实现基线内容；继承文件不能直接删除。若期间 main 或其它节点已修改同一路径，先按本次集成任务核对正确内容，不以旧基线覆盖他人结果。

设计提交并 push 本计划、最终 HTML、图源及进度账本；经有效批准的设计评审，发布并用指定 receipt 命令报告 HTML 后，运行注入的 `complete --route phase_design_complete`，随后按返回的 park 指令结束本轮。设计不自行派发实现，也不把阶段完成等同于整个 issue 已完成。

## 查询与索引

不适用：本演练不新增、不修改表、查询或索引，只有文档与流程交付物。
