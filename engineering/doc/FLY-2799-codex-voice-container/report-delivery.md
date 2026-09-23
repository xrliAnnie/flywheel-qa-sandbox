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

## 已解决：Lead 本机渲染回交，使用内联 SVG

Lead 回复 `59204e41-e16d-420b-8db2-379c8a4362b4` 撤回 CDN 路径，并回交 `/tmp/fly2799-diagrams/d1.svg`、d2.svg、d3.svg。本轮已逐字节比对当前 `.mmd` 与回交源码，核对全部 SVG SHA-256 与 Lead 给出的摘要前缀，三份一致；详见 `evidence/diagram-handoff.json`。渲染器为 mmdc 11.12.0，default 浅色、white 背景，独立 id `fly2799-d1/d2/d3`。

`founder-design.html` 已内联三张真实 SVG，删除占位内容，不加载外部脚本/资源。总计 325925 bytes，低于 512 KiB；当前生产发布器 `injectHeadMeta` 本地预检通过、nonce 正常注入；HTML parser 验证无重复 id、无外部资源引用。交互脚本检查继续通过。原 CDN 草稿与拒绝证据仅保留为交付审计，不是待发布版本。

未做浏览器 QA。Lead 声明已查看 d1 的本地 PNG，不能据此推断全部托管图已验；正式发布后仍须核对托管 HTTP/CSP/源码，并由 Lead 打开检查实际显示。

设计评审 `eb6c9d54-6d9a-421b-8c87-435e4bb50042` R1为 CHANGES_REQUESTED，修正明细见plan.md §9；待新评审通过，未发布、实施或 phase complete。若评审修改 `.mmd`，必须重新渲染对应图，不得复用旧 SVG。
