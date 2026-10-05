# FLY-3225 真 runner 通用演练 — 实施计划
Issue: FLY-3225 (https://linear.app/geoforge3d/issue/FLY-3225/qa-sbx-fly-3225-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 探索、调研与范围

目标是在隔离的 529 测试房间验证「首次交付 → 独立 QA 故意打回 → 按本次裁决编号修复 → 复验」。QA 是独立验收角色，claim 是验收生成的裁决编号。

已 fetch 并读取 `origin/main:qa-sbx/fly3225/README.md`（任务书 blob `f025871e500834ce5bab62335a4d29bd6b308d78`，与上轮相同）。分支 `project-slot-3-FLY-3225` 当前与 main 同为 `e1c2e258db30da1fae1b114683bece48a5968bca`；上一轮 PR #603 已合并，远端同名分支已删除，**本轮没有开放 PR**。练习文件继承的第二行是 `FIXED-FOR-CLAIM 1`，那是上一 run `0e7cbf2d` 的修复结果，不能作为本轮首交、复验或批准证据。

本 run 为 `6a7cfcf9-e321-4df1-ba2a-a275cf3c38e2`；设计 exec 为 `251231eb-af1e-4e59-8da5-033415a772c2`；activation 为 `activation:251231eb-af1e-4e59-8da5-033415a772c2:6a7cfcf9-e321-4df1-ba2a-a275cf3c38e2:eng_design:1`。已取得 design / epoch 1 / attempt 1 TURN（`yours`）；只有 `yours` 可写共享分支。

任务书明确只需短计划、不另写 research 文档，探索与调研结论合并在此；没有运行时代码消费者，无需外部调研。注入的设计完成契约另要求本目录的 `design.html`、本地 Mermaid 图源及工具管理的 `progress.md`。设计只刷新这些流程文档；实现主动修改的唯一文件为 `qa-sbx/fly3225/project-slot-3-FLY-3225.md`。不改任务书、代码、兄弟练习单或 Linear，不部署房间。

## 实施步骤

- [ ] 接手先取得自己的 TURN，再读 main 任务书，用 `git branch --show-current` 确认目标文件名。在账本记录本 run 的 `runId`、本节点 `execId`、`activationId`、完整起点 SHA `implBase`、`firstHandin` 和主动提交清单 `ownCommits`。旧 run（含 `0e7cbf2d`）的实现、QA、评审、CI、PR 字段不得沿用。只用注入的 progress 工具独立提交账本。
- [ ] **优先检查本次指令的修复上下文。** `QA fix context` 标题下第一条正文行若为 `QA verdict to fix: claim <id> ...`，只把第二行改为 `FIXED-FOR-CLAIM <id>`，逐字使用该编号。编号须匹配 `^[A-Za-z0-9._:-]+$`；若与当前内容相同（如继承的 `1`，diff 为空）只记录达标 HEAD，不制造空提交。上下文存在但格式错误、缺编号或身份矛盾时保留文件并报告，不猜编号、不落入首交分支。
- [ ] 无修复上下文且本 run 尚未首交时，将目标文件写成以下精确两行（保留末尾换行），即把继承的 `FIXED-FOR-CLAIM 1` 替换为 `AWAITING-QA`；设计节点不修改它。

  ```text
  QA-SBX FLY-3225 drill
  AWAITING-QA
  ```

  提交信息用 `docs(qa-sbx): FLY-3225 drill hand-in`，记录完整首交 SHA。提交成功但账本未更新时，读 `implBase..HEAD` 历史，核对仅改目标文件且 diff 符合当次指令后补记；排除进度提交与 main 同步合并。
- [ ] 首交后的普通唤醒、CI 返工或主分支同步保留最近正确内容；只有有效修复上下文才改第二行。旧文件、旧账本和普通唤醒都不决定 QA 轮次。
- [ ] 最后一次进度提交后正常 push（远端分支会被重新创建），再以最终交付 HEAD 执行实现节点自己的评审、CI、PR 和完成流程。因 PR #603 已合并，按实现节点注入的流程**新开一个** PR（base `main`），后续修复只更新这一个新 PR，不再新建重复 PR。提交信息、PR 标题不得含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`。不 force-push、不撤销其他节点或合法 main 同步的提交。

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

对每个本 run 主动提交，用 `git diff-tree --root --no-commit-id --name-only -r <完整 SHA>` 核对只含目标文件；修复 diff 只能替换第二行。读取失败即停止，不把空输出当通过。

采用本次指令上下文作为轮次与编号来源；否决用继承的旧 claim 推测复验、提前修成通过、增加代码或部署房间。代价是首轮必然失败，这正是演练所需。无服务或数据库迁移；回退仅恢复本节点对练习文件的修改（按 `implBase` 内容），不删除旧文件、不覆盖他人后续修改。

遵守 `local-test-policy/v2`：无生产源码、导出类型或测试变化，本次不新增测试代码，无受影响包构建或类型检查。仅冻结交付 HEAD 的 `CI OK` 是全套证据；文件比较或 `CI Scope OK` 不代表全套通过。

## 设计交接

本轮注册显式设计评审，只认服务端有效 `reviewVerdict=APPROVED`；上一 run 的批准无效。提交并 push 计划、最终 HTML 与图源。页面含核心流程、结构、取舍、边界和逐节评论；评论按 `location.pathname` 隔离、存储异常受保护、按约 1800 字符分段且每段以 `【页面意见汇总】FLY-3225` 开头；复制失败有回退，只有一个 nonce 脚本且无外部依赖；派生文本 HTML 转义，运行时仅用 `textContent` / `value`。图用本地 mmdc 与不同 SVG id。

提交的 HTML 发布并用注入的 `ask --report` 报告 hosted URL 后，运行 `complete --route phase_design_complete`，按返回指令 park。设计不实现、不派发后继、不创建或合并 PR、不申请 ship；阶段完成不等于 issue 完成。

## 查询与索引

不适用：本演练不新增、不修改表、查询或索引，只有文档与流程交付物。
