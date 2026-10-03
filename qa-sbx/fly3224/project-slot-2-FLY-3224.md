# FLY-3224 529 房间演练 — 实施计划
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03
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
执行：`40087565-51ce-426a-a754-0950732a5ab2`；阶段：design；游标：2/4。
已完成：主分支 README 和项目入门审计、TURN 核验、短计划及自审、范围确认。
范围收据：`8394ac66-c3cf-415a-8842-2d3edaf7afdc` 已确认；`[lead-instruction e0a78f2d-0847-494e-8cd7-9fedff22c01b]` 要求遵循单文件范围，不增写其他文档或发布 HTML。
下一步：提交并推送；登记并取得显式设计审查；提交设计完成收据。
