# FLY-2639 移动端安全的 Discord 深链 — 探索
Issue: FLY-2639 (URL 不可得,只写 issue 号)
日期: 2026-09-17
基于: 无

## 返工背景

第一版把 Epic 进度页所有合法的 `https://discord.com/channels/...` 链接直接渲染为 `discord://-/channels/...` 主链接，并保留相邻的“网页版”链接。桌面 Chrome 能直接打开 Discord App，但 founder 在 iPhone 的 Discord 内置浏览器中点击主链接没有反应；相邻 HTTPS 链接却能通过 universal link 返回 Discord App。

## 必须成立的体验

- 页面生成时主按钮 `href` 必须是原始 HTTPS Discord URL，确保脚本禁用、CSP 未注入 nonce 或脚本未运行时仍然可用。
- iOS Safari、Discord iOS 内置 WebView 和 Android 都保持 HTTPS 主链接。
- 桌面 Chrome 与桌面 Safari 在内联 nonce 脚本执行后，把合法主链接升级为对应的 `discord://` URL。
- 显式“网页版”回退链接继续存在并保持 HTTPS。
- 所有已有 Discord surface 共用同一渲染器；不改变非法链接处理、页面内容、发布流程或其他交互。

## 边界与验收

实现阶段只修改 Discord 链接组件、现有页面 nonce 脚本及对应测试。实现者不发布试点页、不做移动真机结论、不派 QA；QA 后续必须重新发布试点页，并明确“移动端真机点击仍由 founder 验”。
