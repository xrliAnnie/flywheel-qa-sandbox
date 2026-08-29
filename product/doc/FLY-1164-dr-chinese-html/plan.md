# FLY-1164 实施计划 — 3 份 DR → 中文 HTML

Issue: FLY-1164 (https://linear.app/geoforge3d/issue/FLY-1164/整理本轮-3-份-deep-research-成中文-htmlorg-design-agent-incentives-dynamic)
日期: 2026-07-11
基于: exploration.md, research.md

## 流程（Lead 批准：轻流程，一份一份来）

对每份 DR 独立走一遍：**译 → 自 QA → host-only publish → 报 Lead**，不憋齐 3 份。

### 每份 HTML 结构
1. `<head>`：charset + viewport + `robots noindex,nofollow` + `<title>` 中文标题 + 内联 `<style>`（房子样式，零 dark）
2. 顶部说明卡（`.topnote`）：一句中文说明「本文由 [英文原标题] 全文译成中文；原文含 ChatGPT Deep Research 内联引用标记（不可解析内部 token，非真实网址），为可读性已移除，无真实来源/URL 被丢失。」
3. `<h1>` 中文标题 + 副标题（Issue / 日期 / 原文英文标题）
4. 正文：逐 section `<h2>`，逐小节 `<h3>` 或加粗术语条目，段落 `<p>`，列表 `<ul>/<ol>`。加粗术语用 `<b>`。
5. 无交互、无 JS、无外链。

### 三份产物（写到 doc 文件夹，同时用于 publish）
- `product/doc/FLY-1164-dr-chinese-html/dr1-org-design-zh.html`
- `product/doc/FLY-1164-dr-chinese-html/dr2-dynamic-orchestration-zh.html`
- `product/doc/FLY-1164-dr-chinese-html/dr3-agent-incentives-zh.html`

## 自 QA 清单（Lead 要求核忠实，每份都过）
- [ ] 结构完整：原文每个 `##` section + 每个加粗术语条目都在，无遗漏
- [ ] 忠实：无缩写/概括，含义未改，专有名词未译错（对 research.md §2 glossary 抽查）
- [ ] 引用 token 已剥净（grep 无 `citeturn` / `?cite?`）+ 顶部说明在
- [ ] 零 dark：grep 无 `prefers-color-scheme`
- [ ] noindex meta 在；self-contained（grep 无 http 外链 `src=`/`href=`/`@import`）
- [ ] HTML ≤ 512KB（publish 上限）
- [ ] 浏览器/结构 sanity（本地 open 或 curl 校验发布 URL 200）

## 发布 & 交付
- host-only：`POST /api/reports/publish {projectName:"flywheel", html, title}` → nonce URL
- 逐份 `flywheel-comm ask --report` 交 Lead
- 不 ship、不 deliver Discord、不动 main

## 收尾
- 3 份 doc + exploration/research/plan/progress 随分支走 → 开 docs PR（approve gate）→ Lead/Annie 授权后 executor-merge。Runner 不自 merge、不自 :cool:。
