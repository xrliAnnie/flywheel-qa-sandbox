# FLY-3224 529 房间演练 — 实施计划
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: README.md（origin/main:qa-sbx/fly3224/README.md）

目标：用一个 Markdown 文件验证设计、实现、首次 QA 拒绝、按原 claim 修复和复验的真实工作流。
唯一改动文件：`qa-sbx/fly3224/project-slot-2-FLY-3224.md`；设计阶段只记录本短计划，不实现夹具。

1. 设计：提交、推送本计划；显式登记设计审查并取得有效 APPROVED 后，以 `phase_design_complete` 交接。各阶段写入前都核验自己的 TURN，后继由控制器调度。
2. 首次实现：以 UTF-8 和 LF 将本文件完整替换为恰好两行：第一行 `QA-SBX FLY-3224 drill`，第二行 `AWAITING-QA`。不保留计划或额外内容。
3. 首次 QA：`file-shape` 验证文件存在及第一行精确匹配；`fixed-for-claim` 必须 fail，证据精确为 `round 1: no previous QA claim yet`。不要提前修复这个刻意设置的失败。
4. 修复：仅当实现节点收到 `QA verdict to fix: claim <id> ...` 上下文时，将第二行改为 `FIXED-FOR-CLAIM <id>`；claim 直接取该上下文，不猜测或自行生成。第一行及其他文件保持原样。
5. 复验：`fixed-for-claim` 仅在第二行与 `Previous QA verdict: claim <id>` 中的 claim 精确一致时通过；`file-shape` 仍须通过。所有 QA 标题少于 120 字符，证据少于 80 字符。
6. 每轮 QA：登记 `e2e_529_exempt`，status 为 `not_run`，`exempt_category: docs_only`，reason 为 `Markdown-only drill; no room deployment`。不得部署、重启服务或修改 Linear 的状态、评论、标签。
7. 验证和提交：检查唯一改动路径、行数与精确文本；这是文档演练，不运行本地全仓或全包测试。提交使用普通消息 `docs(qa-sbx): FLY-3224 drill hand-in`，不添加任何跳过 CI 的标记；最终交卷的精确提交由 PR CI 验证。本设计节点不创建 PR、不申请发布、不合并。

## 查询与索引
不适用：只读写上述 Markdown 文件；不新增或修改数据库表、查询或索引。

## 设计进度
执行：`784eaa9e-ef0b-420d-bebd-876230c8db2c`（重派，延续 `2b5109696`）；阶段：design；游标：2/4（主分支范围和短计划已核验，当前单文件范围已确认，准备新设计审查；阶段完成仍待范围决策）。
身份：run=`e50560ad-e739-4b53-9c50-976affb2a6a0`；node=`eng_design`；attempt=1；TURN=yours, epoch=1；activation=`activation:784eaa9e-ef0b-420d-bebd-876230c8db2c:e50560ad-e739-4b53-9c50-976affb2a6a0:eng_design:1`。
已完成：抓取并复读主分支 README、onboarding、TURN 核验、分支和 PR 审计（当前无 PR）；计划第 1–7 条与查询索引节保持不变；相对主分支仅本文件有改动。
范围：问题 `df017544-843e-45b9-933a-658923a9615c` 的当前服务端答复要求严格遵循主分支 README；未覆盖事项采取能推进演练的保守方案并在交卷中说明。报告答复 `750562fd-c1d2-468f-a832-3d112ab6a42b` 随后要求 founder 决策前保持单文件、不扩大范围、不声称 phase_design_complete。因此保留本短计划和内联游标，不另建 exploration/research/progress.md 或 HTML；继续显式设计审查，但不提前完成阶段。
历史身份：执行 `0cf3d0de-4eb4-4a0d-8686-1553207fb30d` 的范围问题 `91b5d025-6c1e-4445-80f3-7ee41227bfc4` 和审查问题 `8c109bf4-24c0-4576-b411-b59ba21ed086` 在当前 comm 服务均为 not found；旧 requestId=`21632a9d-a4bb-4bb2-9e38-a96963628bc3` 仅作审计记录，不继承其裁决。
DESIGN-HTML: pending founder scope decision — 尚未创建、发布或取得允许完成阶段的本轮豁免。
审查：本轮尚未登记；plan=`qa-sbx/fly3224/project-slot-2-FLY-3224.md`；只有服务端有效 reviewVerdict=APPROVED 才能交接。
下一步：显式登记新设计审查并保存 questionId/requestId；每个 turn 仅 check 一次待答问题，pending 时登记自己的 wait watcher 并结束当前 turn。有效审查和范围完成许可两项均满足后，提交 `phase_design_complete` 收据并 park。
