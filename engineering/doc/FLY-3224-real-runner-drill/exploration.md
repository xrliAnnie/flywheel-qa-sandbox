# FLY-3224 真 Runner 通用演练(529 房间) — 探索
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 1. 任务来源

- 唯一权威:`origin/main:qa-sbx/fly3224/README.md`(blob `c4a1b333…`)。同 FLY-3150 合同,目录与第 1 行文字换成 FLY-3224。
- README 规定:设计"一份短 plan 足够,不需要 research 文档"。所以本文件夹只有 exploration.md(本文)+ plan.md + progress.md + 设计 HTML 与图源,没有 research.md(README 覆盖 DOC-FLOW full 档的 research 要求,在此明示)。
- 不改 Linear issue(状态 / 评论 / 标签都不碰);不部署 529 房间。

## 2. 现状快照(本次派发 run `0300be9d`,exec `af728aa7`,slot-2)

- 分支 `project-slot-2-FLY-3224` 延续 `origin/project-slot-2-FLY-3224@9438c5d`;无同名 PR(`gh pr list --state all` 为空)。
- `origin/main` = `24d94e6fa`,领先本分支合并基 13 笔,全是别的练习单(FLY-3150/3225/3226/3227)的合入,不碰 `qa-sbx/fly3224/`。
- 目标文件 `qa-sbx/fly3224/project-slot-2-FLY-3224.md` 在 main 上**不存在** → 交付 #1 是新增(PR 级 diff 状态 `A`),没有 FLY-3226 那种"main 残留 FIXED-FOR-CLAIM"的特例。
- **前几轮遗留**:之前的 design 执行(`0cf3d0de`、`784eaa9e`)把短计划直接写进了目标文件路径,并卡在"单文件 vs 设计节点 HTML 合同"的范围问题上;那些问题 id 在当前 comm 服务均为 not found。本轮按兄弟练习单(FLY-3225/3226,同一 README 合同,已走到 implement/merge)的既定做法收口:把计划挪到流程文档文件夹,并在设计阶段 `git rm` 目标文件,让实现节点从"文件不存在"开始。旧计划里的 requestId / 问题 id / 游标一律不认。

## 3. 参考

- `origin/project-slot-4-FLY-3226:engineering/doc/FLY-3226-real-runner-drill/plan.md`:同合同、已两轮评审通过的骨架(交付 #1 / #2、PREV 取自本轮 HANDIN1、ledger 自提交、PR 级范围断言、main 同步后的替代核验)。本轮照搬,删掉只因 main 残留才需要的分支。
- 仓库历史里有带 `[skip ci]` 的提交,README 明确禁止模仿。

## 4. 结论

无代码、无表、无查询。设计 = 把 README 的两行文件契约 + 三条验收写成可执行、可核验的步骤给实现 / QA 节点。
