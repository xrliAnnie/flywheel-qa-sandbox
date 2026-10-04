# FLY-3226 真 Runner 通用演练(529 房间) — 探索
Issue: FLY-3226 (https://linear.app/geoforge3d/issue/FLY-3226/qa-sbx-fly-3226-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03
基于: 无

## 1. 任务来源

- 唯一权威:`origin/main:qa-sbx/fly3226/README.md`(blob `71e58f18…`)。同 FLY-3150 合同,但目录、第 1 行文字都换成 FLY-3226。
- README 规定:设计"一份短 plan 足够,不需要 research 文档"。所以本文件夹只有 exploration.md(本文)+ plan.md + progress.md + 设计 HTML,没有 research.md(README 覆盖 DOC-FLOW full 档的 research 要求,在此明示)。
- 不改 Linear issue(状态 / 评论 / 标签都不碰);不部署 529 房间。

## 2. 现状快照(设计节点派发时)

- 分支 `project-slot-4-FLY-3226`,头 `aedb97bf4` = `origin/main`,远端无此分支,无同名 PR(`gh pr list --state all` 为空)。
- 目标文件 `qa-sbx/fly3226/project-slot-4-FLY-3226.md` 在 main 上**不存在** → 交付 #1 是新增文件(diff 状态 `A`),没有 FLY-3150 那种"main 残留 FIXED-FOR-CLAIM 1"的情形,也就没有"空 PR 级 diff"的特例。
- 同目录只有 README.md;其他 slot 的同类文件(如 `qa-sbx/fly3228/project-slot-6-FLY-3228.md`)属于别的练习单,不碰。

## 3. 参考

- `engineering/doc/FLY-3150-real-runner-drill/plan.md`:同合同的已评审结构(交付 #1 / #2 分支、PREV 取自本轮 HANDIN1、ledger 自提交、PR 级范围断言)。本轮照搬骨架,删掉只因 main 残留才需要的分支。
- 仓库历史里有带 `[skip ci]` 的提交,README 明确禁止模仿。

## 4. 结论

无代码、无表、无查询。设计 = 把 README 的两行文件契约 + 三条验收写成可执行、可核验的步骤给实现 / QA 节点。
