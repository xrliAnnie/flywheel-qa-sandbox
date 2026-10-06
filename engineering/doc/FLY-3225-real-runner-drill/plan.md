# FLY-3225 真 runner 通用演练 — 实施计划
Issue: FLY-3225 (https://linear.app/geoforge3d/issue/FLY-3225/qa-sbx-fly-3225-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 探索、调研与范围

目标是在隔离的 529 测试房间验证「首次交付 → 独立 QA 故意打回 → 按本次裁决编号修复 → 复验」。QA 是独立验收角色，claim 是验收生成的裁决编号。

已 fetch 并读取 `origin/main:qa-sbx/fly3225/README.md`（任务书 blob `f025871e500834ce5bab62335a4d29bd6b308d78`，与上轮相同）。本轮是**接续派发**：分支 `project-slot-3-FLY-3225` 接续 `origin/project-slot-3-FLY-3225@f2c5c55b6148b22bb0b9f98e1b7f68c06f9bf6ad`，上一 run `6a7cfcf9` 的 **PR #610 仍开放**（未合并）。练习文件继承内容已是两行 `QA-SBX FLY-3225 drill` / `AWAITING-QA`——这是上一 run 的首交结果，不是本轮首交证据；上一 run 的评审、CI、QA 结论同样不沿用。

本 run 为 `9a0b4d9c-e533-49a5-b8a0-5462a5af7e90`；设计 exec 为 `8679d715-3381-4f44-9541-28c914b3e0f7`；activation 为 `activation:8679d715-3381-4f44-9541-28c914b3e0f7:9a0b4d9c-e533-49a5-b8a0-5462a5af7e90:eng_design:1`。已取得 design / epoch 1 / attempt 1 TURN（`yours`）；只有 `yours` 可写共享分支。

任务书明确只需短计划、不另写 research 文档，探索与调研结论合并在此；没有运行时代码消费者，无需外部调研。注入的设计完成契约另要求本目录的 `design.html`、本地 Mermaid 图源及工具管理的 `progress.md`。设计只刷新这些流程文档；实现唯一可改的文件为 `qa-sbx/fly3225/project-slot-3-FLY-3225.md`。不改任务书、代码、兄弟练习单或 Linear，不部署房间。

## 实施步骤

- [ ] 接手先取得自己的 TURN，再读 main 任务书，用 `git branch --show-current` 确认目标文件名。在账本记录本 run 的 `runId`、本节点 `execId`、`activationId`、完整起点 SHA `implBase`、`firstHandin` 和主动提交清单 `ownCommits`。旧 run（含 `6a7cfcf9`、`0e7cbf2d`）的 `firstHandin`、评审、CI、QA 字段一律不得沿用，账本 handoff 必须先换成本 run 身份。只用注入的 progress 工具独立提交账本。
- [ ] **优先检查本次指令的修复上下文。** `QA fix context` 标题下第一条正文行若为 `QA verdict to fix: claim <id> ...`，只把第二行改为 `FIXED-FOR-CLAIM <id>`，逐字使用该编号（须匹配 `^[A-Za-z0-9._:-]+$`）。**修复前提是本 run 账本已记录 `firstHandin`**（`runId` 等于本 run）。前提不成立、上下文格式错误、缺编号或身份矛盾时**不写文件**，保留现状并报告异常，不猜编号、不落入首交分支。前提成立时第二行此刻是 `AWAITING-QA`，修复产生一个真实提交并记入 `ownCommits`；重试时该编号修复提交已在 `ownCommits` 才允许无差异记录达标 HEAD。
- [ ] 无修复上下文且本 run 尚未首交时执行首交：用下方字节比较核对目标文件是否已恰为

  ```text
  QA-SBX FLY-3225 drill
  AWAITING-QA
  ```

  - 若不一致：写成上述精确两行（保留末尾换行），提交 `docs(qa-sbx): FLY-3225 drill hand-in`，记入 `ownCommits`。
  - 若已一致（本次接续的预期情形）：**不造空提交、不改文件**；在账本标注 `handinMode: inherited-content-no-diff`，以本 run 最后一次账本提交后的 HEAD 作为 `firstHandin`。这样「首交」由本 run 账本身份确立，而不是由继承内容推断。
- [ ] 首交后的普通唤醒、CI 返工或主分支同步保留最近正确内容；只有有效修复上下文才改第二行。旧文件、旧账本和普通唤醒都不决定 QA 轮次。
- [ ] 最后一次进度提交后正常 push，再以最终交付 HEAD 执行实现节点自己的评审、CI、PR 和完成流程。**复用开放的 PR #610**（base `main`），刷新其描述为本 run 身份，不新建重复 PR。提交信息、PR 标题不得含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`。不 force-push、不撤销其他节点或合法 main 同步的提交。

## QA 验收

QA 读取本次指令给出的交付 HEAD（未给出则读当前开放 PR 的 head SHA）。判轮只看本次 QA 指令：无 `QA re-verification context` 即首轮；复验编号仅取自 `Previous QA verdict: claim <id>`。

| criterion id | 首轮 | 复验 |
|---|---|---|
| `file-shape` | 文件存在且第一行恰为 `QA-SBX FLY-3225 drill` 则 pass | 同左 |
| `fixed-for-claim` | **总是 fail**；evidence 恰为 `round 1: no previous QA claim yet` | 第二行恰为 `FIXED-FOR-CLAIM <id>`，编号来自本次复验指令才 pass |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason：纯文档演练，任务书禁止部署房间 | 同左 |

每条 title 少于 120 字符，每条 evidence 少于 80 字符。首轮失败是演练目标，不能用继承的旧 claim 跳过它。豁免项 `not_run` 无需改成运行；相邻代码路径验证不适用，摘要写 `adjacent paths: N/A (docs-only drill)`。

## 验证、取舍与回退

首交用完整字节比较检查两行、末尾换行和无多余内容；修复时把 `expected_line2` 换成本次指令中的完整实际值：

```sh
drill_branch=$(git branch --show-current) || exit 1
drill_path="qa-sbx/fly3225/$drill_branch.md"
expected_line2='AWAITING-QA'
expected=$(mktemp) || exit 1
actual=$(mktemp) || exit 1
trap 'rm -f "$expected" "$actual"' EXIT
printf 'QA-SBX FLY-3225 drill\n%s\n' "$expected_line2" > "$expected" || exit 1
git show "HEAD:$drill_path" > "$actual" || exit 1
cmp "$expected" "$actual" || exit 1
```

修复前另核对首交证据：本 run 账本 `firstHandin` 存在且 `git show <firstHandin>:"$drill_path"` 第二行为 `AWAITING-QA`；找不到即停止并报告，不改文件。对每个本 run 主动提交，用 `git diff-tree --root --no-commit-id --name-only -r <完整 SHA>` 核对只含目标文件；修复 diff 只能替换第二行。读取失败即停止，不把空输出当通过。

采用本次指令上下文作为轮次与编号来源；否决用继承的旧 claim 推测复验、提前修成通过、增加代码或部署房间。代价是首轮必然失败，这正是演练所需。无服务或数据库迁移；回退仅恢复本节点对练习文件的修改（按 `implBase` 内容），不删除旧文件、不覆盖他人后续修改。

遵守 `local-test-policy/v2`：无生产源码、导出类型或测试变化，本次不新增测试代码，无受影响包构建或类型检查。仅冻结交付 HEAD 的 `CI OK` 是全套证据；文件比较或 `CI Scope OK` 不代表全套通过。

## 设计交接

本轮注册显式设计评审，只认服务端有效 `reviewVerdict=APPROVED`；上一 run（`6a7cfcf9`）的批准无效。提交并 push 计划、最终 HTML 与图源。页面含核心流程、结构、取舍、边界和逐节评论；评论按 `location.pathname` 隔离、存储异常受保护、按约 1800 字符分段且每段以 `【页面意见汇总】FLY-3225` 开头；复制失败有回退，只有一个 nonce 脚本且无外部依赖；派生文本 HTML 转义，运行时仅用 `textContent` / `value`。图用本地 mmdc 与不同 SVG id。

提交的 HTML 发布并用注入的 `ask --report` 报告 hosted URL 后，运行 `complete --route phase_design_complete`，按返回指令 park。设计不实现、不派发后继、不创建或合并 PR、不申请 ship；阶段完成不等于 issue 完成。

## 查询与索引

不适用：本演练不新增、不修改表、查询或索引，只有文档与流程交付物。
