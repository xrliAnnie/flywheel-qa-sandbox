# FLY-2553 固定 Epic 页减噪 — 调研
Issue: FLY-2553 (https://linear.app/geoforge3d/issue/FLY-2553)
日期: 2026-09-14
基于: exploration.md

代码证据：
- render-html.ts 的 renderHtml 是 preview/bundle 共用模板。旧 lead-panel 包括旧四段、ready、freshness，并把 waiting/stuck 藏在折叠区。
- renderEpic 已默认收起且 summary 含 root note；无 note 返回空串。
- CommDB.listAttentionQuestions 读取未答 mailbox，丢弃 content，普通 ask 全变 question；目前不检查 session 状态或 DONE/ACK 前缀。
- attention-sources.ts 解析身份，attention.ts 合并同 issue sources；schema 已允许任意 kind 字符串，可将普通 Lead 问题与显式 @founder 问题区分而不加字段。
- renderChildAudit 托管模板每个子单生成15格完整重复标记；已有 hash-bound audit sidecar 可复用，原始 Cell 仍入附件。
- 现有 E1 pageForBudgetBase(60) 保持8根60子单、120汉字标题。后加满长 note/judgment/history 的扩展 fixture 另有512KB硬上限。80KB口径已向 Lead 询问（9f38ecff-a5b6-4b7a-93e9-fa6d6cdeda23），不擅自缩小基数。
验证：DOM顺序/折叠/占位/转义，真实 CommDB 隔离 fixture，快照读路径，容量，托管 HTTP/CSP 与移动端截图，完整仓库 gates、精确头 review/CI。
