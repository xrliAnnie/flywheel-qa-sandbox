# FLY-2661 机器试判历史按需生成 — 探索
Issue: FLY-2661 (https://linear.app/geoforge3d/issue/FLY-2661/报告托管省量-机器试判历史页停止定时托管发布改为按需手动生成worker-每-30-分钟-24-页全量重发把-vercel-blob)
日期: 2026-09-16
基于: 无

## 问题与边界

生产故障不是机器试判本身，而是展示历史的托管生命周期：Bridge 启动后会构造 `ShipJudgmentHistoryRuntime`，立即运行一次，并每分钟检查一次 30 分钟到期状态。到期轮次把最多 10,000 条近 30 天记录切成每页 20 条，逐页生成新 token、上传 Blob、提交 registry、再 GET 校验。24 页每 30 分钟重复，和 founder “不看就不该上 Vercel” 的要求相反。

必须保留：机器试判意见、卡下评论、founder 决定学习、只读历史查询、历史审计数据。必须移除：Bridge 自动托管发布、定时续期、由历史发布完成触发的 Epic refresh、Epic 上旧托管历史链接。生产 `next_due_at=2026-12-31` 只作为遗留数据保留，不能再驱动任何动作。

## 可选方案

1. **删除生产接线，保留只读查询并提供按需本地渲染（采用）**：Bridge 只提供经 master token 保护的 loopback HTML 读取；CLI 把完整单文件写到 `--out`，之后 Lead 明确调用既有 `publish-report`。优点是没有自动上传入口，权限和数据边界复用现有读路由；代价是 Lead 多一步显式发布。
2. **增加默认关闭的环境开关**：保留 timer/publisher，通过配置关闭。代码改动小，但留下可误开的生产路径，不符合“没有任何配置能打开定时发布”的验收方向。
3. **保留 runtime 但让 `begin()` 永远 deferred**：可以满足零写入测试，但仍保留 timer、lease 和误恢复风险，且把已作废方案继续留在主路径。

## 设计结论

采用方案 1。删除 `plugin.ts` 中 history runtime 的构造、启动、停止和 `ship_judgment_history` refresh 回调；按需命令只读 StateStore，不读取或修改 `next_due_at`，也不接触 report registry/Blob。HTML 使用现有历史行 schema、转义和审计链接语义，改成单文件全量表格并明确标注“本地按需生成，尚未上传”。

Epic 固定页不再渲染旧 URL，改为静态说明“机器试判历史按需生成”；迁移只跳过“无标题且正文是机器试判历史”的旧自动页，避免误伤其它无标题报告。

## 验收映射

- 零自动发布：生产插件源中不存在 history runtime 构造/启动/refresh 接线；24 小时假时钟测试保持 registry/Blob 写入为 0。
- 按需生成：`flywheel-comm ship-judgment-history render --project flywheel --out <file.html>` 通过 loopback GET 获取完整 HTML，并原子写文件；命令本身不调用 publish-report。
- Epic 固定页：无托管链接，只有按需说明；不存在 history refresh 调用方。
- 清理：初次迁移与账号 retarget 都跳过旧自动历史页。
- 止血字段：按需路由直接读取历史查询，完全不读 `ship_judgment_project_state.next_due_at`。
- 回归：不修改 opinion/outcome/learning/runtime 的机器试判路径。
