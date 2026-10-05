# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 探索：目标与范围

在 529 隔离测试房间验证真实节点的「首交 → QA 故意打回 → 按本轮标识修复 → 再验收」交接。QA 是独立验收节点；claim 是一次验收结果的标识，必须逐字沿用本轮提示中的值。

实现只涉及 `qa-sbx/fly3227/<当前 git 分支名>.md`。本轮分支为 `project-slot-5-FLY-3227`，目标为 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。设计节点保持目标文件原样。

任务专用的 main 分支 README 明确一份短计划足够、不写 research 文档，且只触碰一个 Markdown 文件、没有代码。**演练范围**因此只有一个路径：`qa-sbx/fly3227/project-slot-5-FLY-3227.md`；本计划只把这一个文件交给实现节点，实现节点不得改动其他任何文件。

禁止修改 Linear issue 的状态、评论或标签；禁止部署任何 QA 房间。没有产品代码、配置或服务变更。设计节点不实现、不创建 PR、不派发后续节点、不请求 ship 批准、不合并。后续节点由现有控制器推进。

## 调研：当前仓库证据

本次已 fetch 并完整读取 `origin/main:qa-sbx/fly3227/README.md`，main 为 `6311d2e7a7f0e4a403bb89e618defcd0c39cbd03`。已读项目 CLAUDE.md、产品体验说明、架构和项目声明的 onboarding 参考；任务不需要外部调研或新依赖。

复用 `engineering/doc/FLY-3227-real-runner-drill/`。重派时继承分支 `082196bf6` 已有 PR #574 与目标文件（继承内容第 2 行为上一次修复的 `FIXED-FOR-CLAIM 1`，与 main 当前内容相同，故 `git diff origin/main...HEAD` 暂不列出它）；继承账本含以前的评审、PR、QA 与 CI 记录。这些都不是本轮验收或授权依据。当前设计执行标识为 `36461ca5-5e8f-466a-b74a-4d8c1cd775d9`（本次重派），TURN 为 design / epoch 1；后续节点须现取自己的 TURN 和当前提示。

唯一实现消费者是按 README 工作的独立 QA 节点。没有新增接口、显示标签字典、持久化表或迁移。用旧/新字面量、目标和设计文件的完整路径、文件名及父目录做 `git grep -lF` 搜索，未发现本 fixture 或本 issue 文档的测试消费者。通用 `plan.md` / `progress.md` 名称命中框架自身测试与静态样例，逐项排除理由记在进度账本；本任务不改变被测命令、路径解析、schema 或恢复行为。

## 演练范围审计

README 授权的演练变更只有 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。实现节点相对自身起点的差异（`git diff --name-only <起点>..HEAD`）中，除平台自动提交的本 issue 进度账本外，只能出现这一个路径；出现其他路径即越界。

本计划不授权任何其他文件。编排器另以独立平台契约（DOC-FLOW 与设计节点完成契约，不由 README 授权，也不属演练范围）要求设计节点在 `engineering/doc/FLY-3227-real-runner-drill/` 留下设计记录与设计说明页，并由 `flywheel-comm progress` 维护 `progress.md`；这些由设计节点按该契约自行处理，不是实现或 QA 的工作项，也不进入 QA 准则。

## 方案与取舍

采用任务书的两行 Markdown 文件与现有交接流程，不建立新的自动化程序。拒绝新增修复程序，因为没有代码需求；拒绝首交预填或沿用旧 claim，因为会跳过故意失败。内容规则唯一来源是 main 的 README；本计划说明执行方法，不增加 QA 准则。

## 实现步骤（仅供实现节点执行）

1. 先运行自己注入的 `turn`，只有 `yours` 才可写；读取 main 的 README，检查 inbox。用 `git branch --show-current` 确定文件路径，记录本轮实现起点。旧分支文件不决定本轮轮次。
2. 当前提示没有 QA fix context 时，即使继承文件已有旧标识，仍写入恰好以下两行，每行以换行结束：

   ```text
   QA-SBX FLY-3227 drill
   AWAITING-QA
   ```

   命令：`BRANCH=$(git branch --show-current)`，`FILE="qa-sbx/fly3227/$BRANCH.md"`，`printf 'QA-SBX FLY-3227 drill\nAWAITING-QA\n' > "$FILE"`。若完整内容已经相同，不为凑差异改其他文件。
3. 只有当前提示含 QA fix context 时才修复。跳过块标题，从正文第一行 `QA verdict to fix: claim <id> ...` 取 claim 后的首个非空白 token；保留大小写和前导零，不把标题、旧文件、样例或历史 claim 当来源。正文缺失则不猜值，使用自己节点的失败通道。确认原文件恰为本轮首交两行后，仅将第 2 行改成 `FIXED-FOR-CLAIM <id>`。若文件已逐字节等于本轮修复内容，跳过重复写入。第 1 行和换行保持不变。
4. 首交用 `printf 'QA-SBX FLY-3227 drill\nAWAITING-QA\n' | cmp - "$FILE"`；修复用 `printf 'QA-SBX FLY-3227 drill\nFIXED-FOR-CLAIM %s\n' "$CLAIM_ID" | cmp - "$FILE"`，预期退出 0。提交后以相同内容核对 `git show HEAD:"$FILE"`，并检查相对于本轮首交或提示所指 QA 版本的目标文件补丁只改第 2 行。使用普通消息 `docs(qa-sbx): FLY-3227 drill hand-in`，正常快进推送，按实现节点自己的协议完成评审、PR 与精确交付版本的 CI。
5. 进度账本更新会产生提交，必须在最后一次更新后冻结、推送并核验交付版本。记录本轮首交 SHA 供返工比较；SHA 是 Git 给一个提交分配的版本标识。CI 是提交后运行的自动检查，只认当前交付版本的证据。由控制器推进 QA，执行节点不自行派发或部署房间。

## 验收与负向守卫

QA 判轮只看当前提示是否含 QA re-verification context，不根据旧文件推断。使用下列准则 id，标题少于 120 字符、每条 evidence 少于 80 字符。

| 准则 id | 首轮 | 再验收轮 |
|---|---|---|
| `file-shape` | 文件存在，第 1 行逐字为 `QA-SBX FLY-3227 drill`，且整份文件恰为两行（无第三行、无尾随空白、以换行结束）；以完整字节比较核验，任一不符即 `fail` | 相同 |
| `fixed-for-claim` | 必须 `fail`，evidence 逐字为 `round 1: no previous QA claim yet` | 第 2 行逐字为 `FIXED-FOR-CLAIM <id>` 才 `pass`；id 只取当前 `Previous QA verdict: claim <id>` |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason：纯文档演练且任务书禁止部署房间 | 相同 |

完整内容比较必须拒绝错误标识、大小写或前导零变化、尾随空白、第三行及缺少最终换行；`wc -l` 不能代替字节比较。本任务不增加仓库测试或运行本地全仓/全包测试。保留 `pnpm lint`；无 TypeScript、导出 API 或包变化，related、build、typecheck 不适用。精确版本 PR CI 由后续节点取得，本地文档检查不代表全套 CI。

实现节点相对自身起点的改动只允许目标文件（平台自动提交的进度账本除外，见上）。不把 main 后来合入的兄弟演练当本轮变更。修复后文件可能再次等于 main 的旧内容，PR 中净差异为空不能否定本轮修复；必须以本轮首交/QA 版本至修复版本的目标文件补丁和完整字节比较证明只改第 2 行。不得因为净差异为空跳过当前交付版本的 CI。

新增提交消息与实际 PR 标题不得含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`。历史提交不是样板。不使用 force-push、`--no-verify` 或更改 hooks。禁止未经授权推 main。

## 风险、迁移与回退

主要风险是误用旧 claim、跳过首轮故意失败、把历史收据当本轮证据，以及账本提交后仍引用旧 HEAD。每轮现读提示、冻结后重绑证据。无数据库或服务迁移；撤回仅 revert 本轮目标文件提交，不回滚共享分支或其他节点记录。merge 与部署分开，本演练不执行部署或合并。

## 查询与索引

不适用：仅两行 Markdown 演练内容与设计交接文档，没有新增或修改任何表、查询或索引。

## 设计节点收尾

设计节点在评审批准后按编排器的平台契约收尾（不属于演练范围），不实现、不派发后续节点、不请求 ship、不合并。
