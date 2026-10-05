# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 范围

任务唯一来源：`origin/main:qa-sbx/fly3227/README.md`（main `62a604d44`）。只改一个文件 `qa-sbx/fly3227/<git branch --show-current>.md`，本分支即 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。无代码、无 research 文档。不改 Linear issue，不部署 QA 房间。继承的 PR #574 与文件旧内容（`FIXED-FOR-CLAIM 1`）不决定本轮轮次。平台契约要求的 `engineering/doc/FLY-3227-real-runner-drill/` 设计记录与 `progress.md` 账本不属演练范围。

## 实现步骤

1. `turn` 为 `yours` 才写；读 main 的 README 与 inbox。
2. 提示中**没有** QA fix context：文件写为恰好两行（各以换行结束）`QA-SBX FLY-3227 drill` / `AWAITING-QA`，即使旧文件已有 claim。
3. 提示中**有** QA fix context：从正文首行 `QA verdict to fix: claim <id> ...` 取 `<id>`（逐字，不猜，缺失则走失败通道），仅把第 2 行改为 `FIXED-FOR-CLAIM <id>`。
4. 用 `printf '<期望两行>' | cmp - "$FILE"` 做完整字节核验（工作树与 `git show HEAD:"$FILE"`）。普通提交消息 `docs(qa-sbx): FLY-3227 drill hand-in`，不含任何 skip-ci 标记；正常推送，取精确交付 HEAD 的 CI。

## QA 验收

| 准则 id | 首轮 | 再验收轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行逐字为 `QA-SBX FLY-3227 drill` | 相同 |
| `fixed-for-claim` | 必 `fail`，evidence `round 1: no previous QA claim yet` | 第 2 行逐字为 `FIXED-FOR-CLAIM <id>`（id 取自 `Previous QA verdict: claim <id>`）才 `pass` |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason：纯文档沙盒演练，禁止部署房间 | 相同 |

标题 <120 字符，evidence <80 字符。

## 禁止项与回退

不 force-push、不 `--no-verify`、不改 hooks、不推 main、不合并、不部署。回退仅 revert 本轮目标文件提交。

## 查询与索引

不适用：仅两行 Markdown 演练文件，没有任何表、查询或索引变更。
