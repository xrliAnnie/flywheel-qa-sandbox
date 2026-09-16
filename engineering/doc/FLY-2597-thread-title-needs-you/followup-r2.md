# FLY-2597 自动刷新与 Markdown 同源补线 — 实施记录
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597)
日期: 2026-09-16
基于: repair-r1.md, verification.md

Lead note `[lead-instruction 1504c4de-6d02-44b9-be91-e40cc8449268]` 要求完成前核查现有 Epic 子任务链接和 Lead 收件问题，允许上一轮 review 结束后在同一 PR 修复并重新请求审查。上一 head `25506459c5e3a9e3e302af070a3c2f2be0ec6bd2` effective APPROVED（request cc1e450c-9ef0-427c-a15a-1404499544eb），CI 35058953080 全部成功；此证据不移用到本轮新 head。

## 根因与最小修复

1. 手动 epic-page 路由已把 readChildThreads 和 scopeSnapshot 传给 materializer/attention reader；plugin 后台自动刷新漏了两条接线。后台发布的页面因此没有子任务 thread_url，且 attention 元数据没有复用同次 scope snapshot。补上同一 reader，沿用项目 lead chatChannel 边界、UUID/identifier 别名与既有 binding 校验，未新增状态源。Markdown 子任务区原本完全不输出已有 thread_url；补充使用与 HTML 相同的严格 Discord URL 形状校验后输出链接，非法 URL 不渲染。
2. HTML 已调用共享 attentionAudience；Markdown 原先直接遍历 page.attention，将 lead_question 也显示在「现在要你看」。Markdown 改用相同 founder 投影；Lead 条目放到「在等 Lead 的」折叠区，较早问题仅显示计数。无链接 founder 条目继续触发 incomplete 摘要，诊断行单独折叠，不假装为可点 thread。

## 证据

仅只读查询现场三条 chat_threads（FLY-2597/2606/2616）及 discord_config，确认有唯一 identifier 绑定、channel 1516209714097291335、无 discord_missing_at、guild configured。没有复制或修改生产 DB，没有向业务 thread 发送请求或修改页面发布。

TDD：真实 startBridge 接线测试先 1 failed / 2 passed，失败为 child URL undefined；补线后新测试独立通过（1 passed / 2 skipped）。首次组合复测碰到原 startBridge 用例 5s timeout，后续测试读到前一个尚未结束启动的 mock 调用而断言 null；保留日志，不改时限。34 条 lead_question 的 Markdown/HTML 对照测试先失败，确认 Markdown founder 区暴露 Lead 问题。后续验证结果单列。

本轮没有部署、重启、真机 Discord title 验证、固定页发布或 QA 派发。生产现状与新代码 fixture 证据分开；实际激活仍由后续流程执行。

已完成验证：Bridge 接线完整套件 3/3（原时限不变），页面/物化/StateStore 绑定 3 文件 60/60。后续子任务 Markdown 链接测试先 1 failed / 2 passed，复现有效链接遗漏，同时非法 URL 两项守卫保持通过。

最终渲染回归 3 文件 90/90 通过（含新增 3 个 child URL 用例与 34 条 Lead 问题排除）。既有混合来源的 Markdown 断言改为与 HTML 相同的 audience 分拆及较早问题计数，原始 attention facts 未改。

pnpm lint 与 pnpm -r build 均退出0（lint 22 warnings）。完整包/性能测试未重跑，遵从 Lead 629c2c04 限制；新 head CI 与 review 是后续检查点。
