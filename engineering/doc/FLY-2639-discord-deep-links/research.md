# FLY-2639 移动端安全的 Discord 深链 — 调研
Issue: FLY-2639 (URL 不可得,只写 issue 号)
日期: 2026-09-17
基于: exploration.md

## 当前实现

`packages/teamlead/src/epic-page/discord-link.ts` 集中校验 Discord channel/thread/message URL，并为 child thread、attention card、Lead issue 行和 judgment history 生成同一组主链/回退链。第一版直接把主链 `href` 写成 `discord://`，因此脚本是否执行都无法改善 iOS WebView 的死链。

`packages/teamlead/src/epic-page/render-html.ts` 已经在文档结尾生成唯一的内联 `<script nonce="__CSP_NONCE__">`。托管入口 `packages/teamlead/src/bridge/report-registry.ts` 会把占位符替换成每份报告的 nonce，并注入 `default-src 'none'; script-src 'nonce-...'`。因此桌面增强应加入这个既有脚本，不能新增外部脚本或自带 CSP。

## 设备判定

采取保守的渐进增强：

- UA 包含 `Android`、`iPhone`、`iPad`、`iPod` 或 `Mobile` 时不升级。
- iPadOS 可能使用桌面 `Macintosh` UA；当 `navigator.maxTouchPoints > 1` 时同样不升级。
- 其余桌面环境把带 `data-discord-app` 的主链从 HTTPS 改为该属性保存的 `discord://` 目标。

这不是一般设备识别库，而是本需求所需的 fail-safe 分流：不确定时保留可用的 HTTPS universal link；已知桌面 Chrome/Safari 才执行 app 深链增强。

## 测试接缝

- 链接组件测试断言静态 HTML 的主 `href` 是 HTTPS，`data-discord-app` 保存合法深链，显式“网页版”仍是 HTTPS。
- 从真实渲染 HTML 提取唯一 nonce 脚本，在 Happy DOM 中分别注入 iOS Safari、Discord iOS WebView、Android、桌面 Chrome、桌面 Safari UA 并执行，观察主链最终 `href`。
- 不执行脚本的阴性对照直接解析静态 HTML，证明主链仍指向 HTTPS。
- 现有所有 surface 测试继续证明共用组件，没有扩展到发布或真机行为。
