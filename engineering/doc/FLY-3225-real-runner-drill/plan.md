# FLY-3225 真 runner 通用演练 — 实施计划
Issue: FLY-3225 (https://linear.app/geoforge3d/issue/FLY-3225/qa-sbx-fly-3225-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 目标与已核对事实

在 529 沙盒房间，用两行文件验证「首交 → 独立 QA 故意打回 → 按本次裁决编号修复 → 复验」。QA 是独立验收角色；claim 是其生成的裁决编号。

已 fetch 并读取 `origin/main:qa-sbx/fly3225/README.md`，main 为 `62a604d441b959318623292e07bf8af9ebdc28b3`，任务书 blob 为 `f025871e500834ce5bab62335a4d29bd6b308d78`；分支为 `project-slot-3-FLY-3225`，继承 head 为 `2443d8b1c591293b49c1c81583135cc3c8ecef35`，开放 PR #576，保留已有历史并正常 push。本次 run 为 `d91dc5fb-3878-47b1-a994-01d0fd6c1a19`，设计 exec 为 `09be8223-130b-4a05-93ea-ec327d96e264`，activation 为 `activation:09be8223-130b-4a05-93ea-ec327d96e264:d91dc5fb-3878-47b1-a994-01d0fd6c1a19:eng_design:1`，TURN 为 design/epoch 1/attempt 1。现有练习文件第二行为 `AWAITING-QA`；继承的账本、首交、评审和 CI 属于旧 run，不能决定本轮轮次或代表本次批准。

任务书要求短计划、不另写研究文档，因此探索、调研结论及取舍收在本计划。已核对项目 onboarding、任务书、现有练习文件、旧设计、进度记录和 PR 描述；限定搜索未发现需要修改的运行时代码消费者，不需要外部调研。注入的设计完成契约另外明确要求复用本目录的 `design.html`、本地 Mermaid 图源和工具管理的 `progress.md`。这些是设计交付物；实现节点主动修改的唯一交付文件是 `qa-sbx/fly3225/<当前 git 分支名>.md`。设计节点不写练习文件；不改 Linear 状态、评论或标签，不改 README、代码或兄弟练习单，不部署房间。

## 实施步骤

- [ ] 接手先运行本节点的 TURN，仅 `yours` 可写；重新读取 main 的任务书，用 `git branch --show-current` 得到文件名。本分支目标为 `qa-sbx/fly3225/project-slot-3-FLY-3225.md`。
- [ ] 用注入的 `progress --handoff` 保存同一 run 的 `runId`、本节点 `execId`、`activationId`、接手时完整 SHA `implBase`、`firstHandin`、主动提交清单 `ownCommits`。清除旧 run 的实现、QA、代码评审、CI 和 PR 字段，保留本 run 有效的设计证据。重启保留本 run 的基线和首交记录，不能把新 HEAD 当新起点。账本只由 progress 工具独立提交，不与练习文件同提交。
- [ ] **先判断本次指令是否有修复上下文。** `## QA fix context` 标题下第一条正文行给出 `QA verdict to fix: claim <id> ...` 时，从该行取本次编号并直接执行按编号修复；“首行”指上下文正文首行，不是含标题的整个提示首行。即使账本缺首交记录，也不得先重置为等待 QA。上下文存在但首行格式错误、缺编号或与本轮身份矛盾时，保留文件并通过注入命令报告异常；不得落入首交分支或猜编号。无该上下文且本 run 尚未首交时，目标为以下精确内容，恰好两行且末尾换行；当前继承内容已相同，核对后记录达标 HEAD，不制造空提交。需要改动时提交信息使用 `docs(qa-sbx): FLY-3225 drill hand-in`。

  ```text
  QA-SBX FLY-3225 drill
  AWAITING-QA
  ```

  提交后记录该完整 SHA 为 `firstHandin`，将主动改动提交加入 `ownCommits`。若提交成功但账本未更新，恢复时先读取本 run 的 `implBase..HEAD` 历史，只认仅改目标文件且完整 diff 恰为第二行改成当次预期值的提交，排除 `chore(progress)` 与合并提交，再补回本节点确实已作的提交；所有节点可共享作者，作者不能证明归属，空清单也不能证明无改动。内容已经达标则不制造空提交，记录更新账本之前的达标 HEAD。最后一次账本提交后 push，再冻结最终交付 HEAD 作为 CI 对象；CI 是提交后自动运行的检查流水线，后续提交必须重新检查。
- [ ] 仅在本次指令带有效 `QA fix context`、其标题下正文首行给出 `QA verdict to fix: claim <id> ...` 时，只将第二行改为 `FIXED-FOR-CLAIM <id>`，编号逐字使用该指令值，追加主动修复提交到本 run 清单，重新交付。不能复制旧 claim 1。通用修复块列出的 `e2e_529_exempt: not_run` 是预期豁免，无需部署；“相邻状态路径补测试”在此无代码演练不适用，完成摘要写 `adjacent paths: N/A (docs-only drill)`，仍核对两行字节、末尾换行及只改第二行。
- [ ] 首交后的 CI 返工、同步、冲突处理或普通唤醒不自动重置第二行；按唤醒的限定任务保留最近正确内容。同编号修复已达标则允许无改动。不撤销其他节点或合法 main 同步的提交。
- [ ] 首交核对当前分支的开放 PR #576，可沿用但须更新并核对本轮的实际描述、标题与证据；旧 run 已合并或关闭的 PR 不复用。若当前 PR 已关闭，依实现节点指令处理；设计节点不创建或修改 PR。
- [ ] 遵守实现节点自己的评审、CI、报告和完成指令。本设计节点只交接计划，不派发后继、不请求 ship、不创建或合并 PR。

## QA 验收契约

判轮只看本次 QA 指令：无 `QA re-verification context` 为首轮；复验编号取自 `Previous QA verdict: claim <id>`，不从文件或旧账本猜测。

| criterion id | 首轮 | 复验 |
|---|---|---|
| `file-shape` | 文件存在且第一行恰为 `QA-SBX FLY-3225 drill` 则 pass | 同左 |
| `fixed-for-claim` | **总是 fail**；evidence 恰为 `round 1: no previous QA claim yet` | 第二行恰为 `FIXED-FOR-CLAIM <id>`，编号来自本次复验指令才 pass |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`；reason：纯文档演练，规则禁止部署房间 | 同左 |

每条 title 少于 120 字符，每条 evidence 少于 80 字符。首次失败是演练目标，不能提前修成通过。

## 验证、风险与回退

完整字节比较验证两行与末尾换行。首交命令如下；修复时将 `expected_line2` 设为本次指令给出的完整实际值：

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

对本 run 非空 `ownCommits` 中每个主动改动提交，用 `git diff-tree --root --no-commit-id --name-only -r <实际 SHA>` 核对只含目标文件；不含 progress 工具提交或同步合并。读取失败须停止，不能把空输出当通过。修复相对本 run 首交的文件 diff 只替换第二行。空主动提交清单跳过提交扫描，仍核对文件和实际 PR 标题，不能用空 SHA 参数意外读 HEAD。

主动提交完整信息和实际 PR 标题均不能含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`，历史提交不是风格模板。冻结交付 HEAD 的 `CI OK` 才是全套证据；本地文件比较和 `CI Scope OK` 不代表全套通过。仅运行本地测试策略允许的具体测试文件和固定 smoke 命令；本次 `local-tests` 返回无改动测试、无直接对应测试、未声明 smoke。不新增测试代码、不运行包或仓库全套。保留节点要求的 `pnpm lint`。无生产源码或导出类型变化，没有受影响的包构建/类型检查。

否决以旧文件判断轮次、提前写旧 claim、增加代码和部署房间。主要风险是误用旧身份、重复首交或范围检查误撤他人提交；由本次上下文、本 run 账本及主动提交归属限制。无服务或数据库迁移；回退仅恢复本节点对练习文件的修改，按本 run `implBase` 核对原内容，不删除继承文件，也不覆盖后续他人修改。

## 设计交接证据

本轮需重新注册设计评审并取得服务端有效 `reviewVerdict=APPROVED`，旧 run 的批准无效。提交并 push 计划、最终 HTML 和图源；核对页面逐节评论、按 `location.pathname` 隔离且有异常保护的本地保存、1800 字符内重复标记的可复制分段、剪贴板拒绝时的回退、单个 nonce 脚本、无外部资源。派生文本做 HTML 转义；运行时只经 `textContent` / `value` 写入。两张图用本地 mmdc 渲染并采用独立 SVG id；失败按注入契约重试一次，再明确标注待渲染并报告。发布 committed HTML，用注入的 `ask --report` 报告 hosted URL，再运行 `complete --route phase_design_complete`，处理未读邮件后按返回指令 park。设计阶段完成不等于整个 issue 完成；页面评论也不是批准信号。后续反馈由当前 TURN 持有者写 `design-correction.md` 并增量修正，停泊设计节点不能写共享 worktree。

## 查询与索引

不适用：本演练不新增、不修改表、查询或索引，只有文档与流程交付物。
