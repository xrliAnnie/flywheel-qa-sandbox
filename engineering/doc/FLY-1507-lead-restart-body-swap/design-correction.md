# FLY-1507 设计报告互动层修正 — 设计修正
Issue: FLY-1507 (URL 不可得,只写 issue 号)
日期: 2026-07-27
基于: design-report.html

## 修正记录

Founder 直令 `2aa11a3e-ce02-4001-9955-21511c33ec62` 要求设计报告必须可逐段留言。Design 会话自审发现已发布 HTML 的唯一 `<script>` 缺少 `nonce="__CSP_NONCE__"` 占位，发布器因此没有生成 `script-src`，浏览器 CSP 会拦截整段评论逻辑。

本次用 Design 会话准备的完整替换件覆盖 `design-report.html`：设计内容与已评审版保持一致，仅修正互动层，加入 nonce 占位、每节常驻自动保存留言框、页尾留言汇总/复制/清空，以及 light-only 显示约束。重新发布与线上 CSP/nonce 验收由 Lead 执行。
