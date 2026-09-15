# FLY-2593 移除首页机器意见历史 — 实现说明
Issue: FLY-2593 (https://linear.app/geoforge3d/issue/FLY-2593)
日期: 2026-09-15
基于: Linear issue 验收；Lead ruling 7c6732a1-55c9-4746-b697-91683715c06c

## 范围
Lead 确认 simple_code，无上游计划，不需要设计审查；仅实现说明与进度账本。HTML 专用历史输出替换为页脚一行链接，其余页面字节不变。Markdown 历史预览和审计数据保留。

## 路径
2457 生产形状由 packages/teamlead/src/epic-page/render-html.ts 承接。render 路由调用 renderEpicPageHtml；generate 发布经 renderEpicPageBudgetBundle → renderEpicPageBundle；status 返回同一发布 URL。历史 Python 原型没有历史段，不修改。

## 验证进度
- 红测：judgment-render 1 failed / 2 passed，失败于旧 data-judgment-history；最小实现后 3 passed。
- 相关套件初跑 473 passed / 3 failed（均为旧 20 行历史/大小对照）；更新这三处测试后 28 passed，CLI 9 passed。
- pnpm lint 退出 0（已有 warnings）；pnpm -r build 退出 0。pnpm test:packages:run 在运行，尚不声称 aggregate gate 通过。
- 同一 v3 fixture：standalone 与 bundle 的机器意见历史 1→0、查看近 30 天历史 1→1；剥离替换片段后的 HTML 逐字节一致，audit JSON 完全一致。原始 HTML 在 /tmp/fly2593-evidence/{before,after}{,-bundle}.html。
- 覆盖空 cell/null value/空 URL/超长 URL/URL 转义，以及预览读取失败但旧链接仍可用。Markdown preview 与 sidecar 保留。
- 浏览器 DOM 实测 width=500，历史段=0，页脚链接=1，footerTop=700.765625 > viewportHeight=657。ProofShot 截图会话出现 CDP failure；隔离 Chrome 启动失败；Chrome MCP 被权限策略拒绝。截图未取得，尚不声称视觉通过。
- 代码审查与 exact-head CI 留待 PR 验证。
固定 URL 发布后 curl/grep 与线上截图由 QA/ship 后续验证，实现阶段不部署。
