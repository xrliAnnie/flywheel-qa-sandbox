# FLY-3224 真 Runner 通用演练(529 房间) — 探索
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 1. 任务来源

- 唯一权威:`origin/main:qa-sbx/fly3224/README.md`(blob `c4a1b333…`)。同 FLY-3150 合同,目录与第 1 行文字换成 FLY-3224。
- README 规定:设计"一份短 plan 足够,不需要 research 文档"。所以本文件夹只有 exploration.md(本文)+ plan.md + progress.md + 设计 HTML 与图源,没有 research.md(README 覆盖 DOC-FLOW full 档的 research 要求,在此明示)。
- 不改 Linear issue(状态 / 评论 / 标签都不碰);不部署 529 房间。

## 2. 现状快照(本次派发 run `0565c800`,exec `78025e65`,slot-2)

- 分支 `project-slot-2-FLY-3224` 与 `origin/main@bd42785c9` 齐平(0 领先 / 0 落后);远端无本分支。
- 同名 PR 只有 #547(上一轮 run `0300be9d`),已 MERGED;没有 OPEN PR → 交付 #1 开新 PR。
- **main 残留**:上一轮合入后,目标文件 `qa-sbx/fly3224/project-slot-2-FLY-3224.md` 在 main 上是 `QA-SBX FLY-3224 drill` / `FIXED-FOR-CLAIM 1`。这正是 FLY-3226 遇到过的情况:交付 #1 必须把第 2 行**重置**为 `AWAITING-QA`(diff 状态 `M`),否则本轮 claim id 若又是 `1`,重验会靠残留假通过。
- 本文件夹里的 plan / exploration / progress / design.html 是上一轮的版本;本轮全部刷新,progress.md 由 `flywheel-comm progress` 覆盖。

## 3. 参考

- `origin/main:engineering/doc/FLY-3226-real-runner-drill/plan.md`:同合同、"main 残留"结构已评审通过(重置态、PR 级断言允许交付 #2 净 diff 为空的条件、main 同步后的替代核验)。
- 上一轮 FLY-3224 plan 的第 7 步自包含推送块(`set -eu` 子 shell,失败即停)。本轮合并两者。
- 仓库历史里有带 `[skip ci]` 的提交,README 明确禁止模仿。

## 4. 结论

无代码、无表、无查询。设计 = 把 README 的两行文件契约 + 三条验收写成可执行、可核验的步骤给实现 / QA 节点,并显式处理 main 残留。
