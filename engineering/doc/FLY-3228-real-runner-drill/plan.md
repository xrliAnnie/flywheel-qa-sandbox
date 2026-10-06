# FLY-3228 真 Runner 通用演练(529 房间) — 实施计划

Issue: FLY-3228 (https://linear.app/geoforge3d/issue/FLY-3228/qa-sbx-fly-3228-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无(README 规定"一份短 plan 足够,不需要 research 文档")

本轮:run `10aec2cd-d9e5-4533-aa7f-784a633b8e05`,设计 exec `23357c8b`,分支 `project-slot-6-FLY-3228` 从 `origin/main` `e1c2e258d` 起步。

## 1. 范围

- 唯一权威:`origin/main:qa-sbx/fly3228/README.md`,每个节点开工先重读;冲突以 README 为准。
- 演练内容只有 `F=qa-sbx/fly3228/$(git branch --show-current).md`(本轮 = `qa-sbx/fly3228/project-slot-6-FLY-3228.md`)。不碰 README、代码、Linear、529 房间部署。
- 流程记账文件(不是演练内容,不进验收):`engineering/doc/FLY-3228-real-runner-drill/` 下的 `plan.md`、`progress.md`、设计 HTML 及其图源/SVG。它们来自节点协议而非 README:`flywheel-comm progress` 会自动把 `progress.md` 提交到本分支(不可关闭),设计节点契约要求 plan/HTML 提交推送,README 本身也要求有一份 plan。实现节点只允许 `progress.md` 被 `progress` 命令改动,不新增/修改其他任何路径;`qa-sbx/` 下只许出现 `$F`。

## 2. 遗留(上一轮残留,不作数)

main 上已有上一轮(run `8b093fac`)的 `$F`(第 2 行 `FIXED-FOR-CLAIM 4`)、旧 progress / HTML,以及已合并的 PR #525/#545/#551/#575/#582/#587/#604/#607。其中的 claim id、HANDIN1、PR 号、SHA 都**不是本轮依据**;claim id 只取本轮提示词,`PREV` 只取本轮交付 #1 摘要。所以:交付 #1 是修改(`M`)而非新增;本轮 claim id 若恰好又是 `4`,交付 #2 后 `$F` 与 main 逐字节相同,PR 级 diff 中 `$F` 可为空,此时以 `$PREV..HEAD` 的 patch 核验为准。

## 3. 实现节点

`L1='QA-SBX FLY-3228 drill'`

- **交付 #1**(提示词无 "QA fix context"):`printf '%s\nAWAITING-QA\n' "$L1" > "$F"`,用 `cmp` 自检恰两行、末尾单换行;提交 `docs(qa-sbx): FLY-3228 drill hand-in`,推送,开新 PR(`gh pr create --body-file …`,不复用旧 PR),摘要写 `HANDIN1=<完整 SHA>`。
- **交付 #2**(提示词含 "QA fix context"):从其首行 `^QA verdict to fix: claim (\S+)` 原样取 `ID`(取不到 → 失败通道,不猜、不用遗留值);确认 `PREV`(本轮 HANDIN1)是 HEAD 祖先且其第 2 行为 `AWAITING-QA`;只把第 2 行改为 `FIXED-FOR-CLAIM $ID`,`cmp` 自检,提交 `docs(qa-sbx): FLY-3228 drill fix for claim $ID`,推送;核验 `$PREV..HEAD` 中 `$F` 的 patch 恰为 `-AWAITING-QA/+FIXED-FOR-CLAIM $ID`。
- 交付顺序(两次都一样):先改 `$F` 并提交 → 写完本次 `progress` ledger(其自提交会改变 HEAD)→ 确认工作树干净后冻结完整 SHA → 推送 → 确认远端分支头、PR 头、CI 都在这个 SHA 上 → 才在摘要里报 `HANDIN1`/`HANDIN2=<该 SHA>`。冻结后若又有任何提交,重新冻结、推送、核对。
- 纪律:commit/PR 标题不得含 `[skip ci]` 类标记或 `skip-checks:`;不 force-push、不 `--no-verify`;只在 PR 冲突时 `git merge origin/main`(冲突只许落在上述流程目录内)。

## 4. QA 节点

| criterion | 第 1 轮 | 重验轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行 = `QA-SBX FLY-3228 drill` | 同左 |
| `fixed-for-claim` | 恒 `fail`,evidence `round 1: no previous QA claim yet`(故意埋的失败) | 第 2 行 = `FIXED-FOR-CLAIM <id>`(id 取自 `Previous QA verdict: claim <id>`)才 `pass` |
| `e2e_529_exempt` | `not_run`,`exempt_category: docs_only`,附原因 | 同左 |

title < 120 字符,evidence < 80 字符;只读核验,不部署房间、不碰 Linear。

## 5. 测试证据

无代码 → 无单测/构建。证据 = `cmp` 逐字节自检 + 范围检查 + 精确 head 上的 CI + QA criteria。

## 查询与索引

不适用:本演练只修改一个两行 markdown 文件,没有新增或改动任何表、查询或索引。

## 6. 诚实边界

只覆盖 README 的两行文件与三条验收,证明 交付 → 故意 fail → 按 claim 修 → 重验 回路能贯通本轮 claim id。不改 Flywheel 代码、不验证生产功能、不部署房间。回滚 = 关 PR 或 revert;对 main 与生产零影响。
