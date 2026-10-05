# FLY-3226 真 Runner 通用演练(529 房间) — 探索
Issue: FLY-3226 (https://linear.app/geoforge3d/issue/FLY-3226/qa-sbx-fly-3226-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03(首轮);2026-10-04 追加 §5(run `fee0ab7d`)、§6(run `4a9c615e`)、§7(run `76b1635c`)、§11(run `b00b1faf`);2026-10-05 追加 §12(run `6b794ca0`)
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

- 派发起点 `eb3f48ace`(FLY-3225 hand-in #542 之后);`origin/main` 已前进到 `24d94e6fa`,领先两笔无关提交:`7ed21ce86`(FLY-3150,PR #543)和 `24d94e6fa`(FLY-3227,PR #544),都没碰 `qa-sbx/fly3226/` 和本练习单的流程文档目录。PR 级断言一律用三点 `origin/main...<交付头>`(按合并基比较),main 前进不影响;只有 PR 显示 `CONFLICTING` 才按 plan §3.1 同步。
- 远端没有本分支;同名 PR #539、#541 都已 MERGED → 交付 #1 推新分支、开新 PR。
- README blob 仍是 `71e58f18…`,合同没变。
- 目标文件在 main 上 = `QA-SBX FLY-3226 drill` / `FIXED-FOR-CLAIM 1`(PR #541 残留,与 §5 时完全相同)→ 交付 #1 仍是**重置**(diff 状态 `M`);若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空仍合法,返工由区间 patch `PREV..HANDIN2` 证明。
- progress.md 原带 run `fee0ab7d` 实现节点的 handoff(`PREV=2647ad8d…`、`IMPL2=e89cfc44…`、claim 1、代码评审 `b0fa5bf4…`)。设计节点开工即用 `--handoff` 覆盖(提交 `3ceb80d78`);plan 写明这些指针本轮一律不认。
- 结论:沿用 run `fee0ab7d` 已两轮评审通过的 plan 骨架,只更新本轮专属的快照、run id 与"旧指针"清单;设计 HTML 与两张图按本轮起点重画。

## 7. 第四次派发(run `76b1635c`,exec `adebe138`,2026-10-04,slot-4)

run `4a9c615e` 已走完 design → implement → QA(claim `1`)→ merge,PR #546 合入 main(`2de71c2e2`)。本轮同一分支名再次派发:

- 派发起点 = `origin/main` = `2de71c2e2`(本地 HEAD 与 main 相同,没有领先的无关提交)。PR 级断言照旧用三点 `origin/main...<交付头>`;只有 PR 显示 `CONFLICTING` 才按 plan §3.1 同步。
- 远端没有本分支;同名 PR #539、#541、#546 都已 MERGED → 交付 #1 推新分支、开新 PR。
- README blob 仍是 `71e58f18…`,合同没变。
- 目标文件在 main 上 = `QA-SBX FLY-3226 drill` / `FIXED-FOR-CLAIM 1`(PR #546 残留)→ 交付 #1 仍是**重置**(diff 状态 `M`);若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空仍合法,返工由区间 patch `PREV..HANDIN2` 证明。
- progress.md 原带 run `4a9c615e` 实现节点的 handoff(`PREV=86d50653…`、`IMPL2=b43dee8a6`、claim 1)。设计节点开工即用 `--handoff` 覆盖(提交 `0f4f817ca`);plan 写明这些指针本轮一律不认。
- 结论:沿用已多轮评审通过的 plan 骨架,只更新本轮专属的快照、run id 与"旧指针"清单;设计 HTML 与两张图按本轮起点重画。

## 8. 第六次派发(run `a1fb43f1`,exec `6df4dc76`,节点 `eng_design`,2026-10-04,slot-4)

与前几轮不同:本轮是**通用 DAG**(设计节点 `eng_design` 只出设计,实现由后继节点做),且是在**仍 OPEN 的 PR #557** 分支上续跑(BRANCH CONTINUITY:不 force、在现有提交之上继续)。

- 分支头 `6313c5e4f`(= PR #557 头,MERGEABLE);`origin/main` = `2067445f2`,与本练习单无关。
- 分支上 `$F` 已是 `QA-SBX FLY-3226 drill` / `AWAITING-QA`(上一轮 run `0662a4ce` 交付 #1 `b10cfdc40`);main 上仍是残留 `FIXED-FOR-CLAIM 1`。
- README 合同未变(blob `71e58f18…`)。
- run `0662a4ce` 的 HANDIN1 / 设计评审 / CI / PR 正文里的 run 标记都是**旧证据**,本轮不认;progress handoff 已在开工时覆盖。
- 结论:实现节点进入的是 plan §3 的"已就绪(重试)态"——内容提交可为空,只需刷新 ledger、证明头一致、更新 PR #557 正文为本轮 run,再交付。

## 9. 第七次派发(run `813f0792`,exec `b83a17a2`,节点 `eng_design`,2026-10-04,slot-4)

run `a1fb43f1` 已走完 design → implement → QA(claim `1`)→ merge,PR #557 合入 main(`baace76a5`)。本轮同一分支名、通用 DAG 再次派发:

- 派发起点 = `origin/main` = `baace76a5`(本地 HEAD 与 main 相同);远端分支对应的 PR #539/#541/#546/#548/#557 全部 MERGED,没有 OPEN 的 PR → 交付 #1 推分支、开**新 PR**。
- README blob 仍是 `71e58f18…`,合同没变。
- 目标文件在 main 上 = `QA-SBX FLY-3226 drill` / `FIXED-FOR-CLAIM 1`(PR #557 残留)→ 交付 #1 是**重置**(diff 状态 `M`,第 2 行改回 `AWAITING-QA`);若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空仍合法,返工由区间 patch `PREV..HANDIN2` 证明。
- progress.md 原带 run `a1fb43f1` 实现节点 attempt=2 的 handoff(claim 1、review request `43901215…`)。开工即用 `--handoff` 覆盖(提交 `70e672d84`);这些指针本轮一律不认。
- 结论:回到 plan §3 的"重置态"分支(不是 run `a1fb43f1` 的"已就绪态");其余骨架沿用。

## 10. 第九次派发(run `bea81b98`,exec `5bf049cc`,节点 `eng_design`,2026-10-04,slot-4)

run `9ef89593` 已走完并由 PR #563 合入 main(`581cc2d52`)。本轮同一分支名、通用 DAG 再次派发:

- 派发起点 = `origin/main` = `39754a419`(本地 HEAD 相同);#563 之后 main 只多了无关的 FLY-3224 提交。本分支所有 PR(含 #560/#563)均 MERGED,没有 OPEN 的 PR → 交付 #1 开**新 PR**。
- README blob 仍是 `71e58f18…`,合同没变。
- `origin/main:$F` = `QA-SBX FLY-3226 drill` / `FIXED-FOR-CLAIM 1`(PR #563 残留)→ 交付 #1 仍是**重置**(diff `M`)。
- progress.md 原带 run `9ef89593` 的 handoff(plan blob `59d054e5`、request `0fd8bd66`、thread `01a108c4`、旧 HTML 链接);开工即用 `--handoff` 覆盖,这些指针本轮一律不认。
- 结论:plan 骨架不变,只更新起点快照与 run id。

## 11. 第十次派发(run `b00b1faf`,exec `800088de`,节点 `eng_design`,2026-10-04,slot-4)

- 与前几轮不同:本轮**续接 OPEN 的 PR #568**(头 `041556a`,CI 两项 SUCCESS),不开新 PR。分支上 `$F` = `FIXED-FOR-CLAIM 1`(run `bea81b98` 交付 #2 的结果);`origin/main:$F` 同样是 `FIXED-FOR-CLAIM 1`。
- README(`origin/main`)内容不变,仍是唯一权威。
- 结论:本轮交付 #1 = 在 PR #568 上**追加**一笔重置提交(第 2 行改回 `AWAITING-QA`),不 force、不 rebase;PR 标题/正文换成本轮 run 与 HANDIN 证据。run `bea81b98` 的 HANDIN1/HANDIN2/claim 1 一律不作本轮证据。ledger handoff 已在本轮开头用 `--handoff` 覆盖。

## 12. 第十一次派发(run `6b794ca0`,exec `7530071a`,节点 `eng_design`,2026-10-05,slot-4)

run `b00b1faf` 已走完并由 PR #568 合入 main(`6311d2e7a`,2026-10-05T03:25Z)。本轮同一分支名、通用 DAG 再次派发,起点回到 §9 / §10 的"重置态",**不是** §11 的"续接 OPEN PR":

- 派发起点 = `origin/main` = `ab48f1517`(本地 HEAD 相同,开工后只多了本节点的 ledger 提交 `c9db86425`)。#568 之后 main 多了 5 笔无关提交(FLY-3228 #575/#582、FLY-3227 #574、FLY-3224 #580、FLY-3225 #576),`git log origin/main -- <$F> <本文件夹>` 最新仍是 `6311d2e7a`,都没碰本练习单。
- 远端**没有**本分支(`git ls-remote --heads` 为空);同名 PR #539/#541/#546/#548/#557/#560/#563/#568 全部 MERGED,没有 OPEN 的 PR → 交付 #1 推分支、开**新 PR**。
- README blob 仍是 `71e58f18…`,合同没变。
- `origin/main:$F` = `QA-SBX FLY-3226 drill` / `FIXED-FOR-CLAIM 1`(PR #568 残留)→ 交付 #1 是**重置**(diff `M`,第 2 行改回 `AWAITING-QA`);若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空仍合法,返工由区间 patch `PREV..HANDIN2` 证明。
- progress.md 原带 run `b00b1faf` 的 handoff(plan blob `f344b18e`、request `03436b5a`、thread `01a109ed`、"续接 PR 568"、旧 HTML 链接);开工即用 `--handoff` 覆盖(提交 `c9db86425`),这些指针本轮一律不认。上一轮 plan §2 的"续接 OPEN PR #568"对本轮**不成立**,plan 按本节改写。
- research.md 仍按 README 省略(见 §1);本轮"调研"只是上面这些事实核对。
- 结论:plan 骨架沿用 §9/§10 的重置态(新 PR);只更新起点快照、run id 与"旧指针"清单;设计 HTML 与两张图按本轮起点重画。
