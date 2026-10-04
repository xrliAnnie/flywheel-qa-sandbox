# FLY-3227 真 Runner 通用演练 — 实施计划
Issue: FLY-3227 (https://linear.app/geoforge3d/issue/FLY-3227/qa-sbx-fly-3227-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 探索：目标与范围

在 529 隔离测试房间验证真实节点的「首交 → QA 故意打回 → 按本轮标识修复 → 再验收」交接。QA 是独立验收节点；claim 是一次验收结果的标识，必须逐字沿用本轮提示中的值。

实现只涉及 `qa-sbx/fly3227/<当前 git 分支名>.md`。本轮分支为 `project-slot-5-FLY-3227`，目标为 `qa-sbx/fly3227/project-slot-5-FLY-3227.md`。设计节点保持目标文件原样。

任务专用的 main 分支 README 明确一份短计划足够、不写 research 文档。因此探索与本地调研合并于本计划，不另建探索、调研文件。注入的设计节点契约仍要求既有目录中的计划、设计 HTML、Mermaid 图源/本地 SVG 与进度账本；这些是交接记录，不扩大实现范围或 QA 准则。

禁止修改 Linear issue 的状态、评论或标签；禁止部署任何 QA 房间。没有产品代码、配置或服务变更。设计节点不实现、不创建 PR、不派发后续节点、不请求 ship 批准、不合并。后续节点由现有控制器推进。

## 调研：当前仓库证据

本次已 fetch 并完整读取 `origin/main:qa-sbx/fly3227/README.md`，main 为 `bd42785c98e83707577d16ef04d096789b79e603`。已读项目 CLAUDE.md、产品体验说明、架构和项目声明的 onboarding 参考；任务不需要外部调研或新依赖。

复用 `engineering/doc/FLY-3227-real-runner-drill/`。继承文件第 2 行为 `FIXED-FOR-CLAIM 1`；继承账本含以前的评审、PR、QA 与 CI 记录。这些都不是本轮验收或授权依据。当前设计执行标识为 `3483a259-c274-4df4-8b1a-9234c2414006`，TURN 为 design / epoch 1；后续节点须现取自己的 TURN 和当前提示。

唯一实现消费者是按 README 工作的独立 QA 节点。没有新增接口、显示标签字典、持久化表或迁移。用旧/新字面量、目标和设计文件的完整路径、文件名及父目录做 `git grep -lF` 搜索，未发现本 fixture 或本 issue 文档的测试消费者。通用 `plan.md` / `progress.md` 名称命中框架自身测试与静态样例，逐项排除理由记在进度账本；本任务不改变被测命令、路径解析、schema 或恢复行为。

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
| `file-shape` | 文件存在，第 1 行逐字为 `QA-SBX FLY-3227 drill` | 相同 |
| `fixed-for-claim` | 必须 `fail`，evidence 逐字为 `round 1: no previous QA claim yet` | 第 2 行逐字为 `FIXED-FOR-CLAIM <id>` 才 `pass`；id 只取当前 `Previous QA verdict: claim <id>` |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason：纯文档演练且任务书禁止部署房间 | 相同 |

完整内容比较必须拒绝错误标识、大小写或前导零变化、尾随空白、第三行及缺少最终换行；`wc -l` 不能代替字节比较。本任务不增加仓库测试或运行本地全仓/全包测试。保留 `pnpm lint`；无 TypeScript、导出 API 或包变化，related、build、typecheck 不适用。精确版本 PR CI 由后续节点取得，本地文档检查不代表全套 CI。

实现节点相对自身起点的改动只允许目标文件与本 issue 的 `progress.md`。PR 范围使用共同祖先差异 `git diff --name-only origin/main...HEAD`，区分已交接设计记录与实现内容，不把 main 后来合入的兄弟演练当本轮变更。修复后文件可能再次等于 main 的旧内容，PR 中净差异为空不能否定本轮修复；必须以本轮首交/QA 版本至修复版本的目标文件补丁和完整字节比较证明只改第 2 行。不得因为净差异为空跳过当前交付版本的 CI。

新增提交消息与实际 PR 标题不得含 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]` 或 `skip-checks:`。历史提交不是样板。不使用 force-push、`--no-verify` 或更改 hooks。禁止未经授权推 main。

设计 HTML 沿用 Apple-light 样式，核心图由 Mermaid 在本地渲染成自包含 SVG。无外部字体、脚本或图片；唯一脚本带 `nonce="__CSP_NONCE__"`，事件只用 `addEventListener`。每节评论按页面路径保存，存取 localStorage 均有 try/catch；意见汇总每段不超过约 1800 字符，段首逐字为 `【页面意见汇总】FLY-3227`。复制 API 缺失或拒绝都回退到 `execCommand('copy')`。动态内容只进入 `textContent` / `value`；页面评论是修订反馈，不是审批。核验保存/恢复、跨路径隔离、长评论、复制成功/两种回退与存储拒绝；发布后核验托管页面和发布/报告收据。

## 风险、迁移与回退

主要风险是误用旧 claim、跳过首轮故意失败、把历史收据当本轮证据，以及账本提交后仍引用旧 HEAD。每轮现读提示、冻结后重绑证据。无数据库或服务迁移；撤回仅 revert 本轮目标文件提交，不回滚共享分支或其他节点记录。merge 与部署分开，本演练不执行部署或合并。

## 查询与索引

不适用：仅两行 Markdown 演练内容与设计交接文档，没有新增或修改任何表、查询或索引。

## 设计完成顺序

计划提交、推送后，以注入的 `gate review_design --no-block` 与 `request-review --type design --plan ...` 显式注册评审，取得当前服务端有效 `reviewVerdict=APPROVED`；stage 或原始评审文字不能代替批准。评审者接收标记的本地选测政策，禁止全仓/全包本地测试。

最终 HTML 随设计记录提交并推送；先 `ste begin`，再 `publish-report --project test-slot-5 --occasion design_page --artifact ... --publish-only`。本次 STE begin 返回 `disabled`、`sent=false`，无 unitId，使用普通发布路径。成功后按注入身份 `ask --report` 报 URL 给 `flywheel-test-5`，只在取得批准且完成发布/报告后运行 `complete --route phase_design_complete`、`park`。不等待 founder_review，不自行实现或派发；resident goal 在阶段持有期间保持 active，后续意见交当前 TURN 持有人增量处理。
