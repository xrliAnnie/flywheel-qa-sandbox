# FLY-2799 报告图形交付 — 调研
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-23
基于: plan.md

## 新裁定及实际验证

Lead 回复 `ed8d3fd4-e6da-48da-a57b-8de4575ee925` 要求最终 HTML 不留 `DIAGRAM PENDING LOCAL RENDER`，改用浏览器加载 Mermaid CDN、固定 default 浅色；未做浏览器 QA 可如实说明。有效设计 APPROVED 前仍不得发布或 phase complete。此回复替代本单初始的占位图交付许可；旧 `founder-design.html` 只能算待修改草稿。

已生成具体的 `founder-design-cdn-draft.html`：三个 `<pre class="mermaid">` 包含 HTML-escaped 原始 `.mmd`，指定 CDN `<script src>` 带 nonce，初始化只设浅色 default，没有 dark 分支，注明未做浏览器 QA。

2026-09-23 验证：指定 `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js` HTTP 200（响应版本 11.17.2）。但是当前生产构建 `/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist/bridge/report-registry.js` 的 `injectHeadMeta` 直接拒绝该草稿，错误为：

> hosted reports must not contain external script src tags; bundle the code into an inline script and republish so publish-report can add matching nonces automatically, or use the __CSP_NONCE__ inline-script convention

源码对应 `packages/teamlead/src/bridge/report-registry.ts:1004`；同仓测试明确覆盖这一拒绝。证据为 `evidence/cdn-publish-preflight.json`。这是**本地发布器校验**，没有调用 publish-report，也没有发布远程页面。nonce 不豁免外部 script 检查；不能用动态插入脚本规避它。完整库约 3.57 MB，也不能直接内联进有 512 KiB 上限的报告。

问题 `59204e41-e16d-420b-8db2-379c8a4362b4` 已给 Lead：建议由能运行本地 Chromium 的环境渲染 d1/d2/d3 后回交 SVG，或提供受支持的发布方式。三张图的源、稳定独立 svgId 与原失败证据已在本分支；无需重做设计或语音探针。

设计评审 `eb6c9d54-6d9a-421b-8c87-435e4bb50042` 本轮仍 pending。保留完整目标，等待新交付裁定与有效评审；没有发布、实现或 phase complete。
