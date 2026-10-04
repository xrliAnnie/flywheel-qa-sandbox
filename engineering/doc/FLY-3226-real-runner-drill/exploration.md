# FLY-3226 真 Runner 通用演练(529 房间) — 探索
Issue: FLY-3226 (https://linear.app/geoforge3d/issue/FLY-3226/qa-sbx-fly-3226-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03(首轮);2026-10-04 追加 §5(run `fee0ab7d`)、§6(run `4a9c615e`)
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

## 5. 本轮重派发(run `fee0ab7d`,2026-10-04,slot-4)

上一轮(2026-10-03)已经走完 design → implement → QA → merge,PR #539 合入 main(`e0099630e`)。本轮同一分支名 `project-slot-4-FLY-3226` 被重新派发,起点和上一轮**不一样**:

- 分支头 `2e65d3791` = `origin/main`;远端没有本分支;唯一同名 PR #539 已 MERGED → 交付 #1 推新分支、开新 PR。
- README blob 仍是 `71e58f18…`,合同没变。
- 目标文件 `qa-sbx/fly3226/project-slot-4-FLY-3226.md` 在 main 上**已存在**,内容 = `QA-SBX FLY-3226 drill` / `FIXED-FOR-CLAIM 1`(PR #539 残留)。
  - 所以本轮交付 #1 是**修改**(diff 状态 `M`,第 2 行 `FIXED-FOR-CLAIM 1` → `AWAITING-QA`),不再是新增。
  - 必须先重置:否则本轮 QA 若又产生 claim `1`,重验会靠残留假通过,返工回路实际没跑。
  - 本轮 claim id 若恰好又是 `1`,交付 #2 后文件与 main 逐字节相同 → PR 级演练净 diff 为空,是**合法**结果;返工的证据改由区间 patch(`PREV..HANDIN2`)证明。这正是 FLY-3150 plan §1.3 处理过的残留特例,本轮照搬。
- 本文件夹里的 progress.md 带着上一轮实现节点的 handoff(`PREV=e36c698…`、claim 1)。设计节点已用 `--handoff` 覆盖,并在 plan 里写明:上一轮的 HANDIN / PREV / claim id / 代码评审 / CI 一律不认。
- 上一轮的 plan.md 写着"main 上没有 `$F`,空输出不合法"——对本轮已不成立,plan 按本节改写;上一轮的设计 HTML 与两张图同样按本轮起点重画。

## 6. 第三次派发(run `4a9c615e`,exec `e261dee3`,2026-10-04,slot-4)

run `fee0ab7d` 已走完 design → implement → QA(claim `1`)→ merge,PR #541 合入 main(`3ec694479`)。本轮同一分支名再次派发,起点与 §5 **同构**:

- 分支头 `eb3f48ace`(FLY-3225 hand-in #542 之后);`origin/main` 已前进到 `24d94e6fa`(多了一个 FLY-3227 的 hand-in,只碰 `qa-sbx/fly3227/` 和 `engineering/doc/FLY-3227-*`,与本练习单无交集)。PR 级断言一律用三点 `origin/main...<交付头>`(按合并基比较),main 前进不影响;只有 PR 显示 `CONFLICTING` 才按 plan §3.1 同步。
- 远端没有本分支;同名 PR #539、#541 都已 MERGED → 交付 #1 推新分支、开新 PR。
- README blob 仍是 `71e58f18…`,合同没变。
- 目标文件在 main 上 = `QA-SBX FLY-3226 drill` / `FIXED-FOR-CLAIM 1`(PR #541 残留,与 §5 时完全相同)→ 交付 #1 仍是**重置**(diff 状态 `M`);若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空仍合法,返工由区间 patch `PREV..HANDIN2` 证明。
- progress.md 原带 run `fee0ab7d` 实现节点的 handoff(`PREV=2647ad8d…`、`IMPL2=e89cfc44…`、claim 1、代码评审 `b0fa5bf4…`)。设计节点开工即用 `--handoff` 覆盖(提交 `3ceb80d78`);plan 写明这些指针本轮一律不认。
- 结论:沿用 run `fee0ab7d` 已两轮评审通过的 plan 骨架,只更新本轮专属的快照、run id 与"旧指针"清单;设计 HTML 与两张图按本轮起点重画。
