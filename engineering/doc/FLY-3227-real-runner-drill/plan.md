# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 范围

演练任务来源：已获取的 `origin/main:qa-sbx/fly3227/README.md`（main `ab48f1517`）。实现只改 `qa-sbx/fly3227/<git branch --show-current>.md`，本分支即 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。无代码，不另写 exploration/research 文档，不改 Linear issue，不部署 QA 房间。文件旧内容（`FIXED-FOR-CLAIM 1`）不决定本轮轮次。

设计节点不改演练文件。关于 README 的单文件限制与注入的文档交付要求，驱动答复要求保守推进并在交卷说明选择；本轮保守解释是复用既有短计划，只更新平台硬性要求的既有计划、HTML 与进度记录，不扩展演练实现范围。评审与本轮发布证据重新取得，不沿用旧批准。

## 实现步骤

1. `turn` 为 `yours` 才写；读 main 的 README 与 inbox。
2. 提示中**没有** QA fix context：文件写为恰好两行（各以换行结束）`QA-SBX FLY-3227 drill` / `AWAITING-QA`，即使旧文件已有 claim。用 `printf 'QA-SBX FLY-3227 drill\nAWAITING-QA\n' | cmp - qa-sbx/fly3227/project-slot-5-FLY-3227.md` 核验，退出 0 才符合首交内容。
3. 提示中**有** QA fix context：从正文首行 `QA verdict to fix: claim <id> ...` 取 `<id>`（逐字，不猜，缺失则走失败通道），仅把第 2 行改为 `FIXED-FOR-CLAIM <id>`。
4. 首交与修复均做完整字节核验，包括工作树与 `git show HEAD:qa-sbx/fly3227/project-slot-5-FLY-3227.md` 的提交内容；修复只改变第 2 行。普通提交消息 `docs(qa-sbx): FLY-3227 drill hand-in`，不含任何跳过 CI 的标记；正常推送，由实现节点按自己的 hand-in 协议取得精确交付 HEAD 的 CI（仓库自动检查），不以旧版本的绿色结果替代。

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
