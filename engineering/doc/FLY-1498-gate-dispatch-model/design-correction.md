# FLY-1498 design-correction 附录

Issue: FLY-1498 (https://linear.app/geoforge3d/issue/FLY-1498/v2批次2-门与派发模型-节点自带完成合同-ship-只验通用三条-派发器只认-dag)
日期: 2026-07-27
基于: plan.md(同文件夹;设计内容不变)

## 更正 1(founder 直令,经 Tadashi [lead-instruction c2783c65-cf3c-4150-84d8-c549ad130c1f])

founder-design HTML 必须为**可互动版**,对以后每份设计稿 HTML 生效:
1. 每个 section/card 下方 comment 输入框(textarea,localStorage 自动保存);
2. 页面底部汇总卡:实时聚合所有非空 comment(带节标题)+「一键复制所有 comments」(navigator.clipboard + execCommand 兜底);
3. 所有 JS 内联且 script 标签带 nonce="__CSP_NONCE__"(publish-report 托管时注入真 nonce)。

**处置**:`founder-design-FLY-1498.html` 已按上述三条改造并重新发布;设计内容(六卡)不变,仅交付形态更正。参考成品=FLY-1501 可互动版。
