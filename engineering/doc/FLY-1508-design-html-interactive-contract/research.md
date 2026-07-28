# FLY-1508 design 节点 founder HTML 合同补互动格式规范 — 调研

Issue: FLY-1508 (https://linear.app/geoforge3d/issue/FLY-1508/基建小修-design-节点-founder-html-合同补格式规范-必须可互动逐节-comment-一键汇总复制)
日期: 2026-07-27
基于: exploration.md

极简调研(Lead 指示):所有事实均已实地核实,列表如下。

## 已核实事实

| # | 事实 | 出处 |
|---|---|---|
| 1 | 合同单一来源 = `founderDesignHtmlDeliveryLines()`,`isDesignNodeCompletion` 时注入,三条 design 路径共用 | `packages/edge-worker/src/Blueprint.ts:737-760, 1706-1721` |
| 2 | nonce 机制已在:生成方写 `<script nonce="__CSP_NONCE__">`,发布时铸真 nonce + 下发 `script-src 'nonce-…'` CSP;无占位符的 script 被默认 CSP(`default-src 'none'`)拦死 | `packages/teamlead/src/bridge/report-registry.ts:52-67` |
| 3 | inline 事件属性(onclick=)**不被** script nonce 覆盖——交互必须在 nonce script 内 addEventListener 绑定,否则 CSP 下静默失效 | report-registry.ts 注释明文 + CSP 规范行为 |
| 4 | 参考成品(FLY-1501 可互动版)在线实抓核实:交互层 = ~10 行 CSS + 底部汇总卡 div + 一段 IIFE(逐 `.card` 挂 textarea、节标题取 card h2、localStorage per-page key 自动保存带 try/catch、聚合非空 comment 带【节标题】、clipboard 主 + execCommand 兜底) | https://fw-reports-a53de2.vercel.app/r/f5097a65435f73111889fa2c37502244/ (7 天后过期,故合同不引用) |
| 5 | 托管 URL 7 天过期(`DEFAULT_RETENTION_MAX_AGE_MS`)→ 合同文本必须自包含 | report-registry.ts:42-43 |
| 6 | 现有 prompt 断言测试:fly793(:109-119 正锚,:152 反锚)、designer-phase(:119-122,143 两路径)、generalized-workflow(:130,186 有/无) | `packages/edge-worker/src/__tests__/` |

## 结论

零新机制。改动 = 合同文本追加一个自包含互动层小节 + 测试扩锚点。方案细节见 plan.md。
