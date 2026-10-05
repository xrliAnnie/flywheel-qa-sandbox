# FLY-3225 真 runner 通用演练 — 实施计划
Issue: FLY-3225 (https://linear.app/geoforge3d/issue/FLY-3225/qa-sbx-fly-3225-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 探索、调研与范围

目标是在隔离的 529 测试房间验证「首次交付 → 独立 QA 故意打回 → 按本次裁决编号修复 → 复验」。QA 是独立验收角色，claim 是验收生成的裁决编号。

已 fetch 并读取 `origin/main:qa-sbx/fly3225/README.md`（任务书 blob `f025871e500834ce5bab62335a4d29bd6b308d78`，与上轮相同）。审计时 main 为 `295978c2b48ead0aca48bc1db54c076ff321d314`，只多了兄弟练习单 FLY-3150 的文档改动；设计节点已把它无冲突同步进本分支（合并 HEAD `ac6df7b669f87f22993ce74e678535efcf0f3b84`）。分支为 `project-slot-3-FLY-3225`，延续开放 PR #603（继承 head `623f5dac8211f15bc83afbd6cd3363b7e50e778e`）。练习文件继承的第二行是 `FIXED-FOR-CLAIM 1`，那是上一 run `ba2f6f2c` 的修复结果，不能作为本轮首交、复验或批准证据。

本 run 为 `0e7cbf2d-df17-4a44-847e-f8331109baaa`；设计 exec 为 `5ec44708-cc92-4c8d-952d-7e239b470cab`；activation 为 `activation:5ec44708-cc92-4c8d-952d-7e239b470cab:0e7cbf2d-df17-4a44-847e-f8331109baaa:eng_design:1`。已取得 design / epoch 1 / attempt 1 TURN；TURN 是当前节点写共享分支的授权，只有 `yours` 可写。

已核对项目 onboarding、架构、main 任务书、现有文件与旧设计；没有需要改动的运行时代码消费者，无需外部调研。任务书明确只需短计划、不另写 research 文档，探索与调研结论合并在此。注入的设计完成契约另要求本目录的 `design.html`、本地 Mermaid 图源及工具管理的 `progress.md`。设计只刷新这些流程文档；实现主动修改的唯一文件为 `qa-sbx/fly3225/project-slot-3-FLY-3225.md`。不改任务书、代码、兄弟练习单或 Linear，不部署房间。

## 实施步骤

- [ ] 接手先取得自己的 TURN，再读 main 任务书，用 `git branch --show-current` 确认目标文件名。保存本 run 的 `runId`、本节点 `execId`、`activationId`、完整起点 SHA `implBase`、`firstHandin` 和主动提交清单 `ownCommits`。旧 run 的实现、QA、评审和 CI 字段不得沿用；本 run 重启保留原基线与首交记录。只用注入的 progress 工具独立提交账本。
- [ ] **优先检查本次指令的修复上下文。** `QA fix context` 标题下第一条正文行若为 `QA verdict to fix: claim <id> ...`，直接只改第二行为 `FIXED-FOR-CLAIM <id>`，逐字使用该编号，即使账本没有首交记录也不重置。编号必须匹配 `^[A-Za-z0-9._:-]+$`；即使编号与继承的旧值相同（如 `1`，diff 为空）也只记录达标 HEAD，不制造空提交。上下文存在但首行格式错误、缺编号或身份矛盾时保留文件并报告异常，不能猜编号或落入首交分支。
- [ ] 无修复上下文且本 run 尚未首交时，将目标文件写成以下精确两行并保留末尾换行。本次继承的旧 claim 1 必须由实现节点替换为 `AWAITING-QA`；设计节点不修改它。

  ```text
  QA-SBX FLY-3225 drill
  AWAITING-QA
  ```

  提交信息使用 `docs(qa-sbx): FLY-3225 drill hand-in`，记录完整首交 SHA 与主动提交。目标内容已达标时不制造空提交，记录达标 HEAD。提交成功但账本未更新时，读取本 run 的 `implBase..HEAD` 历史，核对仅修改目标文件且 diff 符合当次指令的提交后补记；排除进度提交与同步合并，不能用共享作者或空清单判断归属。
- [ ] 首交后的普通唤醒、CI 返工或主分支同步保留最近正确内容；收到有效修复上下文才按本次 claim 改第二行并追加主动提交。同编号内容已正确时无需新修改。旧文件、旧账本和普通唤醒都不决定 QA 轮次。
- [ ] 最后一次进度提交后正常 push，再以最终交付 HEAD 执行实现节点自己的评审、CI、PR 和完成流程。继续使用已开放的 PR #603，不新建重复 PR；按实现节点注入的路径核对它的 head 与标题。提交信息、PR 标题不得含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`。不 force-push、不撤销其他节点或合法 main 同步的提交。

## QA 验收

QA 读取本次指令给出的交付 HEAD（未给出则读当前开放 PR 的 head SHA）。判轮只看本次 QA 指令：无 `QA re-verification context` 是首轮；复验编号仅取自 `Previous QA verdict: claim <id>`。

| criterion id | 首轮 | 复验 |
|---|---|---|
| `file-shape` | 文件存在且第一行恰为 `QA-SBX FLY-3225 drill` 则 pass | 同左 |
| `fixed-for-claim` | **总是 fail**；evidence 恰为 `round 1: no previous QA claim yet` | 第二行恰为 `FIXED-FOR-CLAIM <id>`，编号来自本次复验指令才 pass |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason：纯文档演练，任务书禁止部署房间 | 同左 |

每条 title 少于 120 字符，每条 evidence 少于 80 字符。首次失败是演练目标，不能提前写旧 claim 跳过它。通用修复提示中豁免 `not_run` 无需改成运行；相邻代码路径验证不适用，摘要写 `adjacent paths: N/A (docs-only drill)`。

## 验证、取舍与回退

首交用完整字节比较检查两行、末尾换行和无多余内容；修复时将 `expected_line2` 替换为本次指令中的完整实际值：

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

对每个本 run 主动提交，用 `git diff-tree --root --no-commit-id --name-only -r <实际完整 SHA>` 核对只含目标文件；修复 diff 只能替换第二行。读取失败停止，不把空输出当通过。主动提交清单为空时仍核对内容和实际 PR 标题，不用空 SHA 意外检查 HEAD。

采用本次上下文作为轮次与编号来源；否决用旧 claim 推测复验、提前修成通过、增加代码或部署房间。代价是首轮必然失败，但这正是演练所需。保留短计划与注入的设计交付物，避免另建研究文件。无服务或数据库迁移；回退仅恢复本节点对练习文件的修改，按 `implBase` 核对继承内容，不删除旧文件或覆盖后续他人修改。

遵守 `local-test-policy/v2`，只运行允许的具体测试文件与固定 smoke。设计审计的 `local-tests` 返回没有改动测试、直接对应测试或声明 smoke；本次不新增测试代码。保留 `pnpm lint`，无生产源码或导出类型变化，无受影响包构建或类型检查。仅冻结交付 HEAD 的 `CI OK` 是全套证据，文件比较或 `CI Scope OK` 不代表全套通过。

## 设计交接

本轮重新打开 `review_design` 并注册显式设计评审，只认服务端有效 `reviewVerdict=APPROVED`；历史批准无效。提交并 push 计划、最终 HTML 与图源。页面含核心流程、结构、取舍、边界和逐节评论；评论按 `location.pathname` 隔离、存储异常受保护、按 1800 字符分段且每段以 `【页面意见汇总】FLY-3225` 开头；复制失败有回退，只有一个 nonce 脚本且无外部依赖。派生文本做 HTML 转义，运行时仅用 `textContent` / `value`。图用本地 mmdc 与不同 SVG id；失败重试一次，再明确标注待渲染并报告。

提交的 HTML 发布并用注入 `ask --report` 报告 hosted URL 后，运行 `complete --route phase_design_complete`，处理未读邮件并按返回指令 park。设计不实现、不派发后继、不创建或合并 PR（PR #603 只随 push 更新）、不申请 ship；阶段完成不等于 issue 完成。后续反馈由当前 TURN 持有者增量修正，停泊节点不能写共享分支。

## 查询与索引

不适用：本演练不新增、不修改表、查询或索引，只有文档与流程交付物。
