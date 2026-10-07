# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-06
基于: 无

## 范围

任务来源：新获取的 `origin/main:qa-sbx/fly3227/README.md`（main `b3f71d79bb2d8fae3175b50a262c0b25f22d551a`，README blob `0ebd338267190d8910178d1b06295b50ac172e12`）。演练交付只有 `qa-sbx/fly3227/<git branch --show-current>.md`，本分支即 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。不改产品代码、Linear issue 或房间部署。旧文件的 `FIXED-FOR-CLAIM 1` 不决定本轮轮次或标识。

本轮 design 执行标识：`73089473-5caa-4430-a21f-e10161a99864`；activation：`activation:73089473-5caa-4430-a21f-e10161a99864:484f3e1f-7b61-4842-8969-b905ed2df965:eng_design:1`。设计节点不写演练文件，由调度程序交给实现节点。

范围解释：任务书明确允许一个短计划且禁止 research 文档，因此不另建 exploration/research。注入的节点协议同时强制进度账本和已提交、已发布的设计 HTML；本轮保守复用既有文档目录中的计划、图源、图和页面，只更新这些流程记录。任务书写明本房间没有人类 Lead、不需要提问；对任务书未覆盖之处采用保守方案并在交卷说明，不视为额外授权。本解释随交卷上报，流程记录不扩展演练验收条件。

文件范围的权威划分（回应设计评审 r1 HIGH）：README 的“只碰下面这一个 markdown 文件”约束的是演练交付物——实现节点只写、只提交 `qa-sbx/fly3227/<branch>.md`，第 3 步用 `git diff-tree` 核验该提交只含这一个文件。设计节点的 `plan.md`、`progress.md` 与设计 HTML 来自注入的节点契约（DOC-FLOW、PROGRESS LEDGER、Founder design HTML 均为 MANDATORY），只位于 `engineering/doc/FLY-3227-real-runner-drill/`，不进入演练交付提交，也不被 QA 准则检查；它们与 README 不冲突，因为 README 第 1 行明确把自身定义为 issue 的任务、并允许“one short plan”，而计划必须以文件形式提交才能被评审。若调度程序日后要求设计节点零文件，则改为按调度程序指令执行。

## 实现步骤

1. 实现节点先运行 `node "$FLYWHEEL_COMM_CLI" turn`，只有 `yours` 才写工作树。设 `DRILL_FILE="qa-sbx/fly3227/$(git branch --show-current).md"`。该交付轮首次进入时记录 `DRILL_ENTRY_HEAD=$(git rev-parse HEAD)`，用节点注入的 `progress` 命令存入既有账本；重启或重复投递复用这个值，不能重新取 HEAD 替换。无 **QA fix context** 的首次交付，即使旧文件已有修复标识，也设置 `DRILL_EXPECTED=$(printf 'QA-SBX FLY-3227 drill\nAWAITING-QA')`。
2. 有 **QA fix context** 的修复交付，在该上下文中查找以 `QA verdict to fix: claim ` 开头的验收结果行，用 `^QA verdict to fix: claim (\S+)(?:\s|$)` 的第一个捕获组原样设置 `DRILL_CLAIM_ID`。这是任务书所指的结果首行，不是整段提示的物理首行；真实提示可先有 `## QA fix context` 标题。该结果行必须唯一；缺失、重复或无法解析时不猜、不写，报告具体输入错误。不使用旧文件、旧评审或其他房间的标识，不转为数字。设置 `DRILL_EXPECTED=$(printf 'QA-SBX FLY-3227 drill\nFIXED-FOR-CLAIM %s' "$DRILL_CLAIM_ID")`，固定格式串加 `%s` 参数保留标识。
3. 写 `printf '%s\n' "$DRILL_EXPECTED" > "$DRILL_FILE"`，再用 `printf '%s\n' "$DRILL_EXPECTED" | cmp - "$DRILL_FILE"` 核对完整文件。执行 `git add -- "$DRILL_FILE"`：若 `git diff --cached --quiet -- "$DRILL_FILE"` 非零，使用 `git commit --only -m 'docs(qa-sbx): FLY-3227 drill hand-in' -- "$DRILL_FILE"` 并设置 `DRILL_PAYLOAD_COMMIT=$(git rev-parse HEAD)`；若目标文件没有待提交差异，先核验 `git merge-base --is-ancestor "$DRILL_ENTRY_HEAD" HEAD`，再用 `DRILL_PAYLOAD_COMMIT=$(git log -1 --format=%H "$DRILL_ENTRY_HEAD"..HEAD -- "$DRILL_FILE")` 找到本轮已完成的目标提交。该值必须非空，才能跳过重复 commit、继续推送，不能把 main 继承的内容算成本轮提交。若该值为空（目标字节已由更早执行提交、本轮写入后无差异，见设计评审 r1 HIGH），则在确认 `git diff --cached --quiet` 整体为零后执行 `git commit --allow-empty -m 'docs(qa-sbx): FLY-3227 drill hand-in'`，并设 `DRILL_PAYLOAD_COMMIT=$(git rev-parse HEAD)`、`DRILL_PAYLOAD_EMPTY=1`；不复用旧执行的目标提交。重启时若 `DRILL_ENTRY_HEAD..HEAD` 已有该消息的本轮空提交则复用它，不重复创建。
   两条路径均核验 `printf '%s\n' "$DRILL_EXPECTED" | cmp - <(git show HEAD:"$DRILL_FILE")`；非空提交再核验 `printf '%s\n' "$DRILL_FILE" | cmp - <(git diff-tree --no-commit-id --name-only -r "$DRILL_PAYLOAD_COMMIT")`，空提交（`DRILL_PAYLOAD_EMPTY=1`）改为核验 `git diff-tree --no-commit-id --name-only -r "$DRILL_PAYLOAD_COMMIT"` 输出为空且其树等于父提交的树；正常错误即停止后续动作，预期的“本轮已提交”分支不当作错误。修复轮从本轮修复提示的 `on head` 或首交记录取得、持久化 `DRILL_PRIOR_QA_HEAD`，执行 `git diff "$DRILL_PRIOR_QA_HEAD" HEAD -- "$DRILL_FILE"`，证明只改第 2 行。
4. 普通 `git push origin HEAD`；遵守实现节点自己的精确版本 CI 与交卷协议。不得使用任何跳过 CI 的提交消息、PR 标题或 trailer。QA 再验收只在 **QA re-verification context** 中找 `Previous QA verdict: claim ` 结果行，用 `^Previous QA verdict: claim (\S+)(?:\s|$)` 的第一个捕获组取比较标识，允许标题在它前面；实现提示与 QA 提示分工不混用。没有代码测试文件变更；仅执行 `node "$FLYWHEEL_COMM_CLI" local-tests` 允许的具体文件检查。完整测试证据只来自交付精确版本的 CI。

## QA 验收

| 准则 id | 首轮 | 再验收轮 |
|---|---|---|
| `file-shape` | 文件存在且第 1 行逐字为 `QA-SBX FLY-3227 drill` | 相同 |
| `fixed-for-claim` | 提示无 re-verification context 时必 `fail`，evidence `round 1: no previous QA claim yet` | 仅当第 2 行逐字为 `FIXED-FOR-CLAIM <id>` 且 id 取自 `Previous QA verdict: claim <id>` 才 `pass`；缺 id 或不一致即 `fail` |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason：纯文档沙盒演练，禁止部署房间 | 相同 |

标题 <120 字符，evidence <80 字符。

## 禁止项与回退

不 force-push、不 `--no-verify`、不改 hooks、不推 main、不合并、不部署、不改 Linear 的状态、评论或标签。设计阶段只提交、推送设计记录，显式注册本轮设计评审；旧批准不是本轮证据。已发布 HTML 报告给注入的 `flywheel-test-5` 后，使用 `complete --route phase_design_complete` 交还调度程序，不自行派发后续节点。撤回仅 revert 本轮目标文件提交，不倒退共享分支、设计记录或其他节点的进度。

## 查询与索引

不适用：仅两行 Markdown 演练文件，没有任何表、查询或索引变更。
