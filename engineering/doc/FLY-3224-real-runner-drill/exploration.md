# FLY-3224 真 Runner 通用演练(529 房间) — 探索
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 1. 任务来源

- 唯一权威:`origin/main:qa-sbx/fly3224/README.md`(blob `c4a1b333…`)。同 FLY-3150 合同,目录与第 1 行文字换成 FLY-3224。
- README 规定:设计"一份短 plan 足够,不需要 research 文档"。所以本文件夹只有 exploration.md(本文)+ plan.md + progress.md + 设计 HTML 与图源,没有 research.md(README 覆盖 DOC-FLOW full 档的 research 要求,在此明示)。
- 不改 Linear issue(状态 / 评论 / 标签都不碰);不部署 529 房间。

## 2. 现状快照(本次派发 run `18c10fbd`,exec `7cab2c09`,slot-2)

- `origin/main` = `caabb83da`;目标文件 `qa-sbx/fly3224/project-slot-2-FLY-3224.md` 在 main 上仍是 `QA-SBX FLY-3224 drill` / `FIXED-FOR-CLAIM 1`(更早 run `0300be9d` 的 PR #547 合入后残留)。
- 分支 `project-slot-2-FLY-3224` 继承上一轮 run `0565c800`(exec `78025e65`)的工作:交付 #1 提交 `77cdb3bf…` 已把目标文件写成 `QA-SBX FLY-3224 drill` / `AWAITING-QA`,远端分支头 `44bf91dd…`(ledger),PR #553 仍 OPEN,CI 绿。
- 所以本轮交付 #1 的目标文件**已经**是 `AWAITING-QA` 两行:实现节点不重写、不提交它,只加 ledger 提交得到新交付头,复用 PR #553(改标题/正文为本轮),CI 在新头上重跑。上一轮的 HANDIN1 / PR 正文 / CI 都不当本轮证据。
- 本文件夹的 plan / exploration / design.html 由本轮刷新,progress.md 由 `flywheel-comm progress` 覆盖。

## 3. 参考

- `origin/main:engineering/doc/FLY-3226-real-runner-drill/plan.md`:同合同、"main 残留"结构已评审通过(重置态、PR 级断言允许交付 #2 净 diff 为空的条件、main 同步后的替代核验)。
- 上一轮(run `0565c800`)已评审通过的 FLY-3224 plan:本轮只改起点(继承态)与 run id;其第 7 步自包含推送块(`set -eu` 子 shell,失败即停)。本轮合并两者。
- 仓库历史里有带 `[skip ci]` 的提交,README 明确禁止模仿。

## 4. 结论

无代码、无表、无查询。设计 = 把 README 的两行文件契约 + 三条验收写成可执行、可核验的步骤给实现 / QA 节点,并显式处理 main 残留。
