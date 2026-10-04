# FLY-3228 真 Runner 通用演练(529 房间) — 实施计划

Issue: FLY-3228 (https://linear.app/geoforge3d/issue/FLY-3228/qa-sbx-fly-3228-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无(README 规定"一份短 plan 足够,不需要 research 文档";本文件是前几轮 plan 的本轮改写版)

本轮:run `ddc84d0c-4c7c-4a87-8adb-965486307fa7`,`general` 节点 exec `a4262905-decb-4f6f-b250-10f9d8560993`。

## 1. 范围

- 唯一权威:`origin/main:qa-sbx/fly3228/README.md`;与本 plan 冲突时以 README 为准。
- 演练内容只有一个文件 `F=qa-sbx/fly3228/$(git branch --show-current).md`。本轮分支 `project-slot-4-FLY-3228` → `qa-sbx/fly3228/project-slot-4-FLY-3228.md`。
- 起点:`origin/main` 上**没有**该文件(只有 README 和 slot-6 的文件),所以交付 #1 是**新增**(`A`)。
- 不碰:README、任何代码、Linear issue、529 房间部署、其他 slot 的目标文件。
- 流程文档例外(授权来源 = 本轮节点派发提示词里的 DOC-FLOW 段:full 档要求在 `engineering/doc/FLY-3228-<slug>/` 写 `plan.md`,并要求同文件夹 `progress.md` 进度账本,由 `flywheel-comm progress` 做 path-limited 提交;README 也明确"一份短 plan 足够"):只允许这**两个具体文件** `engineering/doc/FLY-3228-real-runner-drill/plan.md` 与 `engineering/doc/FLY-3228-real-runner-drill/progress.md` 变动。它们是 Runner 协议记账,不进 QA criterion。同文件夹内前几轮遗留的 HTML / 图 / 其他文件一律不改。
- 范围断言(每次交付前跑):`git diff --name-only origin/main...HEAD | grep -vxF -e "$F" -e engineering/doc/FLY-3228-real-runner-drill/plan.md -e engineering/doc/FLY-3228-real-runner-drill/progress.md` 输出必须为空,且输出列表里必须含 `$F`。任何其他路径(包括同文件夹的 HTML / 图)→ 停,不交付。

## 2. 实现

固定内容 `L1='QA-SBX FLY-3228 drill'`。

**交付 #1(提示词无 "QA fix context")**:`printf '%s\nAWAITING-QA\n' "$L1" > "$F"`;自检 `printf '%s\nAWAITING-QA\n' "$L1" | cmp - "$F"`(红:改前文件不存在;绿:改后逐字节相等);提交 `docs(qa-sbx): FLY-3228 drill hand-in`;推送,开 PR(`--base main`),CI 在精确 head 上跑。

**交付 #2(提示词含 "QA fix context")**:从该 context 首行 `^QA verdict to fix: claim (\S+)` 原样取 `ID`(取不到 → 失败通道,不猜);只把第 2 行改为 `FIXED-FOR-CLAIM $ID`,`cmp` 自检;提交 `docs(qa-sbx): FLY-3228 drill fix for claim $ID`;推送同一 PR。

纪律:commit message / PR 标题不得含 `[skip ci]` 等跳过标记或 `skip-checks:` trailer;不 force-push、不 `--no-verify`。

## 3. QA 验收(供 QA 节点)

| criterion | 第 1 轮 | 重验轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行 = `QA-SBX FLY-3228 drill` | 同左 |
| `fixed-for-claim` | 恒 `fail`,evidence `round 1: no previous QA claim yet` | 第 2 行 = `FIXED-FOR-CLAIM <id>`(id 取自 `Previous QA verdict: claim <id>`)才 `pass` |
| `e2e_529_exempt` | `not_run`,`exempt_category: docs_only`,附原因 | 同左 |

title < 120 字符,evidence < 80 字符;不部署房间。

## 查询与索引

不适用:只新增一个两行 markdown 文件,无表、查询或索引改动。

## 4. 测试证据与边界

无代码 → 无单测/构建;证据 = `cmp` 逐字节自检 + 范围断言 + 精确 head 上的 CI。负向:多一行、尾随空白、错 claim id 都必须让 `cmp` 失败。回滚 = 关 PR 不合并,对 main 与生产零影响。
