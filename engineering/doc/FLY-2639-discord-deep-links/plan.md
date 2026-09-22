# FLY-2639 移动端安全的 Discord 深链 — 实施计划
Issue: FLY-2639 (URL 不可得,只写 issue 号)
日期: 2026-09-17
基于: research.md

## 锁定范围

只返工 Epic 页面 Discord 链接的默认目标和桌面渐进增强。保留第一版覆盖的 child thread、attention、Lead issue、history preview/standalone history surfaces，保留“网页版”回退，保留原 URL 校验与非法链接降级。实现节点不发布、不做真机结论、不派 QA。

## 实施步骤

1. 先改测试形成红侧：所有静态主链必须以 HTTPS 输出；未执行脚本仍可点击；真实 nonce 脚本在 iOS Safari、Discord iOS WebView、Android 下保持 HTTPS，在桌面 Chrome/Safari 下升级到 `discord://`。
2. 最小修改 `discord-link.ts`：主链 `href` 改成 canonical HTTPS，把已校验的 app URL放入 `data-discord-app`；相邻“网页版”不变。
3. 在 `render-html.ts` 既有唯一 nonce 脚本里加入桌面增强 IIFE，不引入外部资源，不新增 CSP，不修改其他页面行为。
4. 运行 focused tests，随后 lint、workspace build、package aggregate 和相关 shell suites；保持每类结果独立记录。
5. 更新 milestone，确保它是 PR literal-last commit；推送一次，发起新 code review，并以新 head 获取 exact-head CI。
6. 通过 `ask --report` 交付：明确实现者未发布，QA 必须重新发布试点页，且“移动端真机点击仍由 founder 验”；最后走 `complete --route needs_review`。

## 验收证据

- 渲染快照的主 `href` 是 `https://discord.com/channels/...`。
- 同一主链携带对应 `discord://-/channels/...` 桌面增强目标。
- 设备矩阵覆盖五类 UA，且 no-script 阴性对照为 HTTPS。
- 页面仍只有一个带 `__CSP_NONCE__` 的可执行内联脚本，没有外部 script。
- focused/aggregate/CI/review/head SHA 与交付路由分别可核验。
