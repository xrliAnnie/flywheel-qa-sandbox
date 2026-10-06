# FLY-3228 真 Runner 通用演练(529 房间) — 实施计划

Issue: FLY-3228 (https://linear.app/geoforge3d/issue/FLY-3228/qa-sbx-fly-3228-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无(README 规定"一份短 plan 足够,不需要 research 文档")

本轮:run `50cebdc0-0fb9-4c6d-baa3-23ceedcf2142`,设计 exec `61b57574`。分支 `project-slot-6-FLY-3228` 不是从 main 新起,而是**接续**仍开着的 PR #615(头 `9d7498e72`,merge-base `357fe55a3`)。

## 1. 范围

- 唯一权威:`origin/main:qa-sbx/fly3228/README.md`,每个节点开工先重读;冲突以 README 为准。
- 演练内容只有 `F=qa-sbx/fly3228/$(git branch --show-current).md`(本轮 = `qa-sbx/fly3228/project-slot-6-FLY-3228.md`)。不碰 README、代码、Linear、529 房间部署。
- 流程记账文件(不是演练内容,不进验收):`engineering/doc/FLY-3228-real-runner-drill/` 下的 `plan.md`、`progress.md`、设计 HTML 及其图源/SVG。它们来自节点协议而非 README:`flywheel-comm progress` 会自动把 `progress.md` 提交到本分支(不可关闭),设计节点契约要求 plan/HTML 提交推送,README 本身也要求有一份 plan。实现节点只允许 `progress.md` 被 `progress` 命令改动,不新增/修改其他任何路径;`qa-sbx/` 下只许出现 `$F`。

## 2. 遗留(之前几轮残留,不作数)

两层遗留,都**不是本轮依据**:
- **main 上**:更早一轮的 `$F`(第 2 行 `FIXED-FOR-CLAIM 4`)、旧 progress / HTML,以及已合并的 PR #525/#607 等。
- **本分支 / 开着的 PR #615 上**:上一轮 run `38e9b6ae` 的成果——`$F` 第 2 行 `FIXED-FOR-CLAIM 13`,PR 正文里的 `HANDIN1=2b0b54f4…`、`HANDIN2=9d7498e7…`,以及 ledger 里的 claim 13。

claim id 只取本轮提示词,`PREV` 只取本轮交付 #1 冻结的 SHA,PR 正文里的旧 `HANDIN1/HANDIN2` 必须被本轮值**替换**(不是追加)。所以:交付 #1 是把第 2 行从 `FIXED-FOR-CLAIM 13` 改回 `AWAITING-QA`(`M`);本轮 claim id 若恰好又是 `4`(或 `13`),交付 #2 后 `$F` 与 main(或上一轮 `9d7498e7`)逐字节相同,PR 级 diff 中 `$F` 可为空,此时以 `$PREV..HEAD` 的 patch 核验为准。

**PR 选择**:按分支接续规则沿用开着的 PR #615(不新开、不 force-push),只更新其正文;若 #615 在本轮开工时已非 OPEN,才新开 PR。

## 2a. 设计节点本轮产物

旧 `FLY-3228-design.html` 与旧发布 URL 属遗留,不复用。设计节点本轮在同一文件夹内重新生成设计 HTML:更新本轮 run / exec / 基线 SHA / 遗留 claim 等标识,mmdc 本地重渲图源为 SVG 内联,提交推送后用 `publish-report --publish-only` 发布得到本轮新 URL,并上报 Lead;`progress.md` 的 handoff 也显式改写为本轮内容。

## 3. 实现节点

`L1='QA-SBX FLY-3228 drill'`

- **交付 #1**(提示词无 "QA fix context"):`printf '%s\nAWAITING-QA\n' "$L1" > "$F"`,用 `cmp` 自检恰两行、末尾单换行;提交 `docs(qa-sbx): FLY-3228 drill hand-in`,推送,在 PR #615 上用 `gh pr edit 615 --body-file …` 把正文改成本轮(`HANDIN1=<完整 SHA>`,删掉上一轮的 HANDIN1/HANDIN2 与 claim 13 字样);#615 非 OPEN 时才 `gh pr create`。
- **交付 #2**(提示词含 "QA fix context"):从其首行 `^QA verdict to fix: claim (\S+)` 原样取 `ID`(取不到 → 失败通道,不猜、不用遗留值);确认 `PREV`(本轮 HANDIN1)是 HEAD 祖先且其第 2 行为 `AWAITING-QA`;只把第 2 行改为 `FIXED-FOR-CLAIM $ID`,`cmp` 自检,提交 `docs(qa-sbx): FLY-3228 drill fix for claim $ID`,推送;核验 `$PREV..HEAD` 中 `$F` 的 patch 恰为 `-AWAITING-QA/+FIXED-FOR-CLAIM $ID`;PR 正文追加 `HANDIN2=<SHA>`。
- 交付顺序(两次都一样):先改 `$F` 并提交 → 写完本次 `progress` ledger(其自提交会改变 HEAD)→ 确认工作树干净后冻结完整 SHA → 推送 → 确认远端分支头、PR 头、CI 都在这个 SHA 上 → 才在摘要里报 `HANDIN1`/`HANDIN2=<该 SHA>`。冻结后若又有任何提交,重新冻结、推送、核对。
- 纪律:commit/PR 标题不得含 `[skip ci]` 类标记或 `skip-checks:`;不 force-push、不 `--no-verify`;只在 PR 冲突时 `git merge origin/main`(本轮开工时 #615 为 MERGEABLE,预计不需要)(冲突只许落在上述流程目录内)。

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

只覆盖 README 的两行文件与三条验收,证明 交付 → 故意 fail → 按 claim 修 → 重验 回路能在**接续的开放 PR** 上贯通本轮 claim id。不改 Flywheel 代码、不验证生产功能、不部署房间。回滚 = 关 PR 或 revert;对 main 与生产零影响。
