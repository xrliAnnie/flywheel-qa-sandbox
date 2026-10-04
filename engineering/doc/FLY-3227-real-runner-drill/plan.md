# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 探索与仓库核验

目标是在 529 隔离测试房间验证真实执行节点的「首交 → QA 故意打回 → 按本轮 claim 修复 → 再验收」交接。claim 是 QA 给一次验收结果分配的标识，修复必须逐字沿用它。

已重新 fetch 并读取沙盒 `origin/main` 上的任务书；本轮设计起点为 `2de71c2e2eec04ac54d884962a20a49dc61cb585`，分支为 `project-slot-5-FLY-3227`。目标文件已从之前的演练继承，第 2 行是 `FIXED-FOR-CLAIM 1`；它不是本轮修复依据。每个后续节点重读 main 上的 README，并现取分支名；历史文件、历史 claim 和兄弟房间不决定本轮规则。

README 明确「一份短 plan 足够，不写 research 文档」，因此探索与本地调研合并在此，不另建探索、调研文档。实现内容仅一个文件 `qa-sbx/fly3227/<当前分支名>.md`。本轮对应 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。设计节点不改这个文件。

已通过问题 `8da5357d-26e4-4a52-92e3-8519f9eb5b9d` 核对文档范围；drill driver 重申按 README 执行，未覆盖的细节选最保守且能推进演练的做法，并在交接中说明。这里采用短计划，复用既有文档目录；节点契约仍要求更新计划、设计 HTML、Mermaid 图源/本地 SVG 和自动提交的 `progress.md`，它们只作流程记录，不扩展实现或 QA 准则。此范围解释会随交接报告提交。实现节点基线之后只允许目标文件与该 `progress.md` 变化。

本地调研核对了任务书、项目说明、继承的目标文件与流程记录；没有需要外部服务或新依赖来解决的技术问题。已有设计页面中的「文件尚未创建」属于旧轮次描述，本轮必须改成「已有旧文件，首交仍重置为等待验收」。

## 方案与边界

采用 README 的两行 Markdown 文件，复用现有交接与 QA 通道；没有新增代码、接口、持久化结构或消费者。拒绝新增自动修复程序：超出任务范围。拒绝首交提前填修复标识：会跳过这次演练故意安排的失败。

不修改 Linear issue 的状态、评论或标签；不部署或拆除任何 QA 房间；不改变 README、配置、其他练习文件或产品代码。设计节点只评审、推送和发布报告，完成后由控制器推进后续节点，不派发、不创建 PR、不请求 ship 或合并。

## 实现步骤（只供实现节点执行）

1. 先取得自己的 TURN，读 main 的 README，并记录实现基线 `BASE=$(git rev-parse HEAD)`。取 `BRANCH=$(git branch --show-current)`、`FILE="qa-sbx/fly3227/$BRANCH.md"`。本轮不得用别人的分支名。
2. **没有本轮 QA fix context 的首交**，内容恰为下列两行，每行以换行结束；即使继承文件含旧 claim，也以本轮提示为准：

   ```text
   QA-SBX FLY-3227 drill
   AWAITING-QA
   ```

   写入命令：`printf 'QA-SBX FLY-3227 drill\nAWAITING-QA\n' > "$FILE"`。若 HEAD 中文件已逐字节相同，不为凑 diff 修改其他文件。
3. **修复重交**仅从本轮 QA fix context 的内容首行，用 `^QA verdict to fix: claim (\S+)` 取首个非空白 token 作为 `CLAIM_ID`，把第 2 行改为 `FIXED-FOR-CLAIM <id>`。保留大小写与前导零；缺失或不匹配则不猜，使用节点失败通道。第 1 行与其他内容不得变化。若 HEAD 中文件已逐字节等于本轮修复目标，跳过文件写入和提交，继续账本、冻结版本与核验。
4. 提交目标文件，采用普通消息 `docs(qa-sbx): FLY-3227 drill hand-in`；按节点要求用 `progress` 更新账本。工作树干净后冻结交付 SHA，推送正常快进分支，再由实现节点按自己的协议复用或创建 PR 并取得该精确 SHA 的 CI 证据。账本产生新提交后必须重新冻结、推送、核验。
5. 首交交付摘要必须写 `HANDIN1=<完整 SHA>`，这是修复轮读取首交 SHA 的唯一来源；不要写入会自行改变 HEAD 的账本再当最终 SHA。修复轮先确认该 SHA 是 HEAD 的祖先，且其目标文件第 2 行为 `AWAITING-QA`，再核对目标文件只改第 2 行。摘要缺失或证据不符则用节点失败通道，不从 git log 或其他演练历史猜测。不得使用 force-push 或 `--no-verify`。

## 验收与验证证据

QA 判轮只看本轮提示词是否有 QA re-verification context；不以分支旧内容推断。准则标题少于 120 字符、证据少于 80 字符。

| 准则 id | 首轮 | 再验收轮 |
|---|---|---|
| `file-shape` | 文件存在，第 1 行逐字为 `QA-SBX FLY-3227 drill` | 相同 |
| `fixed-for-claim` | 必须 `fail`，证据逐字为 `round 1: no previous QA claim yet` | 第 2 行逐字为 `FIXED-FOR-CLAIM <id>` 才 `pass`；id 只取本轮 `Previous QA verdict: claim <id>` |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，原因：纯文档演练且禁止部署房间 | 相同 |

实现节点执行以下窄范围核验，不运行本地全仓或全包测试套件：

- 首交逐字节检查：`printf 'QA-SBX FLY-3227 drill\nAWAITING-QA\n' | cmp - "$FILE"`；修复检查：`printf 'QA-SBX FLY-3227 drill\nFIXED-FOR-CLAIM %s\n' "$CLAIM_ID" | cmp - "$FILE"`，均应退出 0。提交后再以同样内容比较 `git show HEAD:"$FILE"`，避免只验证未提交内容。
- 改前不匹配、改后匹配是本演练的红/绿证据。多一行、尾随空白、错 id、前导零变化都必须比较失败；`wc -l` 不能代替完整内容比较。
- 无 main 同步合并时，相对 `BASE` 的文件清单只能是 `"$FILE"` 与 `engineering/doc/FLY-3227-real-runner-drill/progress.md`，逐字比较路径；其他文件即越界。PR 范围始终用共同祖先差异：`git diff --name-only origin/main...HEAD -- . ':(exclude)engineering/doc/FLY-3227-real-runner-drill'`，实现交付时必须恰好一行 `"$FILE"`；设计交付时应为空。不得用两点的树差异把 main 后来合入的兄弟演练误判成本轮改动。
- 如果节点协议要求同步 main，正常 merge `origin/main`，不改写历史。同步后不用 `BASE..HEAD` 的全树清单；改用上述共同祖先 PR 范围、HEAD 文件逐字节比较，以及首交/修复的目标文件补丁。仅本轮文档目录冲突可以保留本轮版本；遇到其他冲突先 abort，使用节点失败通道。
- 核对实际提交消息和实际 PR 标题，不含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`。历史提交不能当范本。精确交付 SHA 的 CI 是后续交付要求，本地文档检查不代表全套 CI 通过。
- 设计 HTML 验证：本地渲染 SVG、无外部依赖、单一 nonce 脚本、逐节评论保存与恢复、跨路径隔离、长评论分块、剪贴板缺失与拒绝时的回退。发布后检查托管页面并保留成功发布与 Lead 报告收据。

## 风险、回退与迁移

本轮标识拿错或预填都会破坏演练；只从当前修复/再验收提示取值，不从样例、旧文件或历史取值。进度账本会改变 HEAD，因此最终证据必须在账本更新后重新绑定。无数据库或服务迁移；回退使用对本轮目标文件提交的 revert，不回滚共享分支，不影响其他节点产物。普通推送冲突按节点协议处理，不擅自改写历史。

## 查询与索引

不适用：只有两行 Markdown 演练内容与设计流程文档，没有新增或修改任何表、查询或索引。

## 设计交接

计划必须取得服务端有效 `reviewVerdict=APPROVED`；单独 stage 变更或原始 reviewer 文字不算批准。提交并推送设计 HTML 后使用 `publish-report --publish-only` 发布，按指定 `ask --report` 将托管 URL 报给 `flywheel-test-5`，然后执行 `complete --route phase_design_complete` 与 `park`。设计阶段完成后保持 resident goal，不实现、不等待 founder review、不推动后续节点；后来意见由当时 TURN 持有人增量记录。
