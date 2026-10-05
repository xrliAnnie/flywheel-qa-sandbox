# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 范围

任务唯一来源：`origin/main:qa-sbx/fly3227/README.md`（main `e63535617`）。只改一个文件 `qa-sbx/fly3227/<git branch --show-current>.md`，本分支即 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。无代码、无 research 文档。不改 Linear issue，不部署 QA 房间。继承的已合并 PR（#544–#594）与文件旧内容（`FIXED-FOR-CLAIM 1`）不决定本轮轮次。平台契约要求的 `engineering/doc/FLY-3227-real-runner-drill/` 设计记录与 `progress.md` 账本不属演练范围。

## 实现步骤

1. `flywheel-comm turn` 为 `yours` 才写工作树。轮次只由 runner 提示正文决定（是否含 QA fix context / QA re-verification context）；`flywheel-comm inbox` 只用于确认有无 Lead 指令（本房间无人类 Lead），不构成 README 之外的验收条件。
2. 上下文分工：实现节点只看 **QA fix context**（README 实现段）；**QA re-verification context** 是 QA 节点的上下文。实现节点提示若含 re-verification context 却无 QA fix context，或两者都在而 `QA verdict to fix: claim <id>` 与 `Previous QA verdict: claim <id>` 的 id 不逐字一致 → `complete --route blocked`，不写文件。
   设 `FILE=qa-sbx/fly3227/$(git branch --show-current).md`。提示中**既无** QA fix context **也无** re-verification context：`EXPECTED='QA-SBX FLY-3227 drill\nAWAITING-QA\n'`，即使旧文件已有 claim。
3. 提示中**有** QA fix context：从其首行 `QA verdict to fix: claim <id> ...` 逐字取 `<id>`（缺失或无法解析则 `complete --route blocked`，不猜），`EXPECTED='QA-SBX FLY-3227 drill\nFIXED-FOR-CLAIM <id>\n'`。第 1 行不动。
4. 按序核验，任一步非零即停：
   - 写入：`printf "$EXPECTED" > "$FILE"`
   - 工作树核验：`printf "$EXPECTED" | cmp - "$FILE"`
   - 提交：`git add "$FILE" && git commit -m 'docs(qa-sbx): FLY-3227 drill hand-in'`（无任何 skip-ci 标记或 `skip-checks:` trailer）
   - HEAD 核验：`printf "$EXPECTED" | cmp - <(git show HEAD:"$FILE")`
   - 推送：普通 `git push origin HEAD`，再读取 `git rev-parse HEAD` 这个精确 head 的 CI。

## QA 验收

| 准则 id | 首轮 | 再验收轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行逐字为 `QA-SBX FLY-3227 drill` | 相同 |
| `fixed-for-claim` | 提示无 re-verification context 时必 `fail`，evidence `round 1: no previous QA claim yet` | 仅当第 2 行逐字为 `FIXED-FOR-CLAIM <id>` 且 id 取自 `Previous QA verdict: claim <id>` 才 `pass`；缺 id 或不一致即 `fail` |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason：纯文档沙盒演练，禁止部署房间 | 相同 |

标题 <120 字符，evidence <80 字符。

## 禁止项与回退

不 force-push、不 `--no-verify`、不改 hooks、不推 main、不合并、不部署。回退仅 revert 本轮目标文件提交。

## 查询与索引

不适用：仅两行 Markdown 演练文件，没有任何表、查询或索引变更。
