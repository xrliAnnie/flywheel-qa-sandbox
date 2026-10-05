# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 范围

任务唯一来源：`origin/main:qa-sbx/fly3227/README.md`（main `3c3cbd5f8`）。只改一个文件 `qa-sbx/fly3227/<git branch --show-current>.md`，本分支即 `qa-sbx/fly3227/project-slot-2-FLY-3227.md`。无代码、无 research 文档。不改 Linear issue，不部署 QA 房间。继承的已合并 PR（#544–#599）、本分支已开的 PR #595 与文件旧内容（`FIXED-FOR-CLAIM 3`）不决定本轮轮次。本分支已合入 `origin/main`（merge `71bce95f8`，冲突处保留 slot-2 自己的 FLY-3227 文档）。演练范围外只允许以下平台文件，均位于 `engineering/doc/FLY-3227-real-runner-drill/`，依据是 runner 提示中的设计节点合同（DOC-FLOW 计划文档、PROGRESS LEDGER 账本、Founder design HTML 强制交付）：`plan.md`（本计划）、`progress.md`（`flywheel-comm progress` 自动提交的账本）、`design.html`（创始人设计页）及其图源 `core-flow.mmd` / `core-flow.svg`。实现节点只写演练文件与 `progress.md`，不再改其他文件。交付前核验整分支差异：`git diff --name-only origin/main...HEAD | grep -vxE "qa-sbx/fly3227/project-slot-2-FLY-3227\.md|engineering/doc/FLY-3227-real-runner-drill/(plan\.md|progress\.md|design\.html|core-flow\.mmd|core-flow\.svg)"` 输出必须为空，非空即停；再单独断言目标文件确在差异中：`git diff --name-only origin/main...HEAD | grep -qx "qa-sbx/fly3227/project-slot-2-FLY-3227\.md"` 必须 exit 0，否则即停。白名单里的平台文件不是演练范围扩张：README 规定演练改动只落在这一个 Markdown 文件，平台文件只承载节点合同要求的设计/账本记录，QA 只按演练文件验收。

## 实现步骤

1. `flywheel-comm turn` 为 `yours` 才写工作树。轮次只由 runner 提示正文决定（是否含 QA fix context / QA re-verification context）；`flywheel-comm inbox` 只用于确认有无 Lead 指令（本房间无人类 Lead），不构成 README 之外的验收条件。本轮 run `c2070246`（slot-2，exec `9aa81710`）是继承 PR #595 的重派；继续在该 PR 上提交，不新开 PR、不 force-push。
2. 上下文分工：实现节点只看 **QA fix context**（README 实现段）；**QA re-verification context** 是 QA 节点的上下文。实现节点提示若含 re-verification context 却无 QA fix context，或两者都在而 `QA verdict to fix: claim <id>` 与 `Previous QA verdict: claim <id>` 的 id 不逐字一致 → `node "$FLYWHEEL_COMM_CLI" complete --route blocked --summary "qa_context_mismatch"`，不写文件。
   设 `FILE=qa-sbx/fly3227/$(git branch --show-current).md`。提示中**既无** QA fix context **也无** re-verification context：`EXPECTED=$(printf 'QA-SBX FLY-3227 drill\nAWAITING-QA')`，即使旧文件已有 claim。
3. 提示中**有** QA fix context：从其首行 `QA verdict to fix: claim <id> ...` 逐字取 `<id>`（缺失或无法解析则 `node "$FLYWHEEL_COMM_CLI" complete --route blocked --summary "qa_claim_id_unparseable"`，不猜），`ID=<id>; EXPECTED=$(printf 'QA-SBX FLY-3227 drill\nFIXED-FOR-CLAIM %s' "$ID")`（固定格式串，id 只作参数，避免 `%`/反斜杠被解释）。第 1 行不动。
4. 按序核验，任一步非零即停：
   - 写入：`printf '%s\n' "$EXPECTED" > "$FILE"`
   - 工作树核验：`printf '%s\n' "$EXPECTED" | cmp - "$FILE"`
   - 提交：若 `git diff --quiet HEAD -- "$FILE"` exit 0（内容已与 HEAD 一致，如同一 claim 重派），跳过提交、直接进入下一步；否则 `git add "$FILE" && git commit -m 'docs(qa-sbx): FLY-3227 drill hand-in'`（无任何 skip-ci 标记或 `skip-checks:` trailer）
   - HEAD 核验：`printf '%s\n' "$EXPECTED" | cmp - <(git show HEAD:"$FILE")`
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
