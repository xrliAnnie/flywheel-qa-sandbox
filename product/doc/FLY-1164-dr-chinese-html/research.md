# FLY-1164 调研 — 翻译规范 · 房子样式 · host-only 发布契约

Issue: FLY-1164 (https://linear.app/geoforge3d/issue/FLY-1164/整理本轮-3-份-deep-research-成中文-htmlorg-design-agent-incentives-dynamic)
日期: 2026-07-11
基于: exploration.md

## 1. 房子样式（复用 FLY-1091 explainer 已验证形态）

- 令牌: `:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--line:#e5e5ea;--navy:#1a365d}`
- 字体: `-apple-system,system-ui,"SF Pro Text",Segoe UI,Roboto,sans-serif`，`line-height:1.7`（长文再宽松一点）
- 容器: `max-width:880px;margin:0 auto`
- 头部: `<meta name="robots" content="noindex,nofollow">` + `<meta charset>` + viewport
- **无 `@media (prefers-color-scheme: dark)`**（红线：零 dark-mode）
- 代码/术语: `code{font-family:"SF Mono";background:#f0f0f4}`；卡片左边色条用于「顶部说明」与「综合结论」块
- 完全 self-contained：内联 `<style>`，零外链、零 JS 依赖（纯阅读，可无 JS）

## 2. 翻译规范（Lead 要求我自核忠实）

- **全文 100% 译中文**，逐 section / 小节 / 段落 / 加粗术语条目，不缩写、不概括、不改含义。
- **保留英文（首见给中文注）**：
  - 公司/机构: Amazon, Netflix, Toyota, Haier, Buurtzorg, Morning Star, Spotify, W. L. Gore, Zappos, Bridgewater, GitLab, Automattic, Adobe, Safelite, Anthropic, OpenAI, Google SRE, NIST, METR, PagerDuty, Salesforce, Microsoft, McKinsey, Deloitte, IMF, U.S. Army
  - 框架/机制: RACI, RAPID, DACI, OKR, andon, CRM(crew resource management), Type 1/Type 2 decisions, RenDanHeYi, Holacracy, orchestrator-worker, evaluator-optimizer, manager-agent, CODEOWNERS, TeamSTEPPS, mission command, transactive memory, Goodhart's law, self-determination theory, Reflexion, CriticGPT, Petri, UTBoost, SWE-bench, pass@k / pass^k, Conway's law, Brooks's law, Dunbar
  - 人名: Mintzberg, Bloom/Sadun/Van Reenen, Lazear, Gneezy/Rustichini, Weibel, Deci/Ryan, Bezos, Kniberg, March, Grove, Doerr, Coase, Williamson, McChrystal, Dan Davies
- **引用 token 处理**（Lead 批准）：剥掉正文里所有 `citeturn…` / `?cite?turn…?`；每份 HTML 顶部加一行诚实说明。不留脚注。
- **dr2 mojibake 修复**：源文件 `�` 是 UTF-8 编码坏的标点——`�s`→`'s`（撇号）、句中孤立 `�`→`—`（em-dash）或 `'`（视上下文）。译中文时这些标点大多自然消解；对照英文语义还原，不臆造。

## 3. host-only 发布契约（FLY-930 nonce / FLY-203）

- 端点: `POST {FLYWHEEL_BRIDGE_URL}/api/reports/publish`，header `Authorization: Bearer {TEAMLEAD_API_TOKEN}` + `Content-Type: application/json`
- body: `{projectName, html, title}`（HTML ≤ 512KB）
- 返回: `{url: "https://<fw-reports-xxx>.vercel.app/r/<token>/", reportId}` —— `<token>` 即不可猜 nonce
- **不调 `/deliver`** → 不发 Discord、不落 core 频道（避开 memory 里「publish-report 对 Runner 默认落 core、Lead 没权限删」的坑）
- noindex + CSP 由托管侧注入；HTML 内也自带 noindex meta 双保险
- env 现成: FLYWHEEL_BRIDGE_URL=http://127.0.0.1:9876, TEAMLEAD_API_TOKEN=set

## 4. 交付

- 3 个 nonce URL 经 `flywheel-comm ask --lead flywheel-product-lead --report` 逐份交 Lead（一份一份，不憋齐）
- Runner 不投 Discord、不 deliver、不 ship、不动 main
