# FLY-3228 真 Runner 通用演练(529 房间) — 实施计划

Issue: FLY-3228 (https://linear.app/geoforge3d/issue/FLY-3228/qa-sbx-fly-3228-real-runner-generalized-drill-529-room-only)
日期: 2026-10-06
基于: 无(README 规定"一份短 plan 足够,不需要 research 文档")

本轮:run `67f6db40-2d53-4117-ac4d-8c8c8a86210a`,设计 exec `594da560`。分支 `project-slot-6-FLY-3228` 开工时等于 `origin/main` 的 `4b28f822b`(上一轮 PR #623 已合并,本分支没有开着的 PR)。

## 1. 范围

- 唯一权威:`origin/main:qa-sbx/fly3228/README.md`,每个节点开工先重读;冲突以 README 为准。
- 演练内容只有 `F=qa-sbx/fly3228/$(git branch --show-current).md`(本轮 = `qa-sbx/fly3228/project-slot-6-FLY-3228.md`)。README 的"只碰一个 markdown 文件"约束的是 `qa-sbx/` 下被 QA 核验的演练内容。不碰 README、代码、Linear、529 房间部署。
- 流程记账文件(不是演练内容,不进验收):`engineering/doc/FLY-3228-real-runner-drill/` 下的 `plan.md`、`progress.md`、设计 HTML 及其图源/SVG。它们来自节点协议:README 要求有一份 plan;`flywheel-comm progress` 会自动把 `progress.md` 提交到本分支(不可关闭);设计节点契约要求 HTML 提交推送。之前合并的 PR #607/#615/#621/#623 也是同样形态。实现节点只允许 `progress.md` 被 `progress` 命令改动,不新增/修改其他路径;`qa-sbx/` 下只许出现 `$F` 的改动。

## 2. 遗留(之前几轮残留,不作数)

**main 上**(本分支起点):上一轮 run `f102d493` 合并进来的 `$F`(第 2 行 `FIXED-FOR-CLAIM 4`)、旧 `progress.md`(handoff、nextStep、`pr: "623"` 指针)、旧设计 HTML 与旧发布 URL,以及已合并/关闭的 PR #623、#621、#615、#611、#608、#607 等。它们都**不是本轮依据**:

- claim id 只取本轮提示词,`PREV` 只取本轮交付 #1 冻结的 SHA,绝不从 main、旧 PR 正文或旧 ledger 取。
- 交付 #1 是把第 2 行从 `FIXED-FOR-CLAIM 4` 改为 `AWAITING-QA`(`M`,不是新增)。
- 本轮 claim id 若恰好又是 `4`,交付 #2 后 `$F` 与 main 逐字节相同,PR 级 diff 中 `$F` 为空;此时以 `$PREV..HEAD` 的 patch 核验为准,不算缺陷。

**PR 选择**:#623 已 MERGED,不可复用 → 交付 #1 时 `gh pr create` 新开 PR(base `main`)。若开工时已有本分支的 OPEN PR,则沿用它并只改正文。

## 2a. 设计节点本轮产物

旧 `FLY-3228-design.html` 与旧 URL 属遗留,不复用。设计节点重新生成:更新本轮 run / exec / 起点 SHA / 遗留 claim 4 等标识,mmdc 本地重渲两张图为 SVG 内联,提交推送后 `publish-report --publish-only` 得到本轮新 URL 并上报 Lead;`progress.md` 的 handoff 用 `--handoff` 显式改写为本轮内容(否则旧 handoff 残留);旧 `pr: "623"` 指针由实现节点在开新 PR 后改写。

## 3. 实现节点

`L1='QA-SBX FLY-3228 drill'`

- **交付 #1**(提示词无 "QA fix context"):`printf '%s\nAWAITING-QA\n' "$L1" > "$F"`,用 `cmp` 自检恰两行、末尾单换行;提交 `docs(qa-sbx): FLY-3228 drill hand-in`;新开 PR,正文含 `HANDIN1=<完整 SHA>`。
- **交付 #2**(提示词含 "QA fix context"):从其首行 `^QA verdict to fix: claim (\S+)` 原样取 `ID`(取不到 → 失败通道,不猜、不用遗留值);确认 `PREV`(本轮 HANDIN1)是 HEAD 祖先且其第 2 行为 `AWAITING-QA`;只把第 2 行改为 `FIXED-FOR-CLAIM $ID`,`cmp` 自检,提交 `docs(qa-sbx): FLY-3228 drill fix for claim $ID`;核验 `$PREV..HEAD` 中 `$F` 的 patch 恰为 `-AWAITING-QA/+FIXED-FOR-CLAIM $ID`;PR 正文追加 `HANDIN2=<SHA>`。
- 交付顺序(两次都一样):先改 `$F` 并提交 → 写完本次 `progress` ledger(其自提交会改变 HEAD)→ 确认工作树干净后冻结完整 SHA → 推送 → 确认远端分支头、PR 头、CI 都在这个 SHA 上 → 才报 `HANDIN1`/`HANDIN2=<该 SHA>`。冻结后若又有提交,重新冻结、推送、核对。
- 纪律:commit/PR 标题不得含 `[skip ci]` 类标记或 `skip-checks:`;不 force-push、不 `--no-verify`;只在 PR 冲突时 `git merge origin/main`(冲突只许落在流程目录内)。

## 4. QA 节点

| criterion | 第 1 轮 | 重验轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行 = `QA-SBX FLY-3228 drill` | 同左 |
| `fixed-for-claim` | 恒 `fail`,evidence `round 1: no previous QA claim yet`(故意埋的失败) | 第 2 行 = `FIXED-FOR-CLAIM <id>`(id 取自 `Previous QA verdict: claim <id>`)才 `pass` |
| `e2e_529_exempt` | `not_run`,`exempt_category: docs_only`,附原因 | 同左 |

title < 120 字符,evidence < 80 字符;只读核验,不部署房间、不碰 Linear。

## 5. 测试证据

无代码 → 无单测/构建。证据 = `cmp` 逐字节自检 + 范围检查(`git diff --name-only origin/main...HEAD` 只含 `$F` 与流程目录)+ 精确 head 上的 CI + QA criteria。

## 查询与索引

不适用:本演练只修改一个两行 markdown 文件,没有新增或改动任何表、查询或索引。

## 6. 诚实边界

只覆盖 README 的两行文件与三条验收,证明 交付 → 故意 fail → 按 claim 修 → 重验 回路能在**从 main 新起的分支 + 新 PR** 上贯通本轮 claim id。不改 Flywheel 代码、不验证生产功能、不部署房间。回滚 = 关 PR 或 revert;对 main 与生产零影响。

## 7. 已知建议(上一轮 review 的 MEDIUM 采纳)

范围检查用显式允许清单:`git diff --name-only origin/main...HEAD` 只能是 `$F`、`progress.md`、`plan.md`、`FLY-3228-design.html`、`d1-core-flow.{mmd,svg}`、`d2-data-model.{mmd,svg}`(都在流程目录内),出现其他路径即失败。
