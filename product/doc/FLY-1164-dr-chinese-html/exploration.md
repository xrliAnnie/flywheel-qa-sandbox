# FLY-1164 整理 3 份 Deep Research 成中文 HTML — 探索

Issue: FLY-1164 (https://linear.app/geoforge3d/issue/FLY-1164/整理本轮-3-份-deep-research-成中文-htmlorg-design-agent-incentives-dynamic)
日期: 2026-07-10
基于: 无（源头 = /tmp 里 3 份 verbatim 英文 DR）

## 一句话

把这轮 org-design / AI-company 过程里做的 3 份 Deep Research，每一份**全文翻译成中文**、排成一份**单独的、self-contained、Apple 浅色、零 dark-mode 的 HTML**，host-only 发布（FLY-930 nonce）拿到 3 个不可猜 URL，交给 Lead → QA → 投给 Annie。**不 ship、不动 main。**

## 3 份 DR 的真实形态（已读 verbatim）

| # | 文件 | 标题 | 行数 | 结构 | 特殊情况 |
|---|------|------|------|------|----------|
| 1 | dr1-org-design-verbatim.md | Operating Systems for One Founder and Fifteen AI Agents | 118 | Executive Summary → Operating Models → Decision Rights → Escalation → Incentives → Coordination Rituals → Failure Modes → Hard-Nosed Synthesis | 干净文本；内联 `citeturn…` 引用 token |
| 2 | dr2-dynamic-orchestration-verbatim.md | Dynamic Work Orchestration in Human Companies… | 58 | What it is → Decompose/route → Who gets work → Evaluate → Feedback → What transfers | **mojibake**（`�` = 撇号/破折号被编码坏）+ 变形的 `?cite?turn…?` 标记 |
| 3 | dr3-agent-incentives-verbatim.md | Designing Management, Coordination, and Incentive Systems for Autonomous AI Coding Agents | 87 | Core premise → What transfers → Incentive analogues → Coordinate a fleet → What research says → Practical operating model | 干净文本；内联 `citeturn…` token |

三份**都没有真实的 "Sources" 段落或可点 URL**——那些 `citeturn33view0…` / `?cite?turn30view1?` 是 ChatGPT Deep Research 的**内部引用 token，不可解析、不指向任何真实网址**。

## 需要拍板的关键决策

### 决策 1（核心）—— 内联引用 token 怎么处理？
- **背景**：任务要求「有 Sources/URL 的保留」+「别丢内容」。但这 3 份里的引用标记全是 `citeturn…` 这种 ChatGPT 内部 token，**没有一个是真实 URL**，读者点不了、看不懂，混在中文正文里只会碍眼。
- **推荐做法（我倾向）**：**从正文剥掉这些 token**（它们不是「内容」，是噪声），并在每份 HTML 顶部加一行诚实说明：「原文含 ChatGPT Deep Research 的内联引用标记（不可解析的内部 token，非真实网址），为可读性已移除；无真实 URL/来源内容被丢失。」
- **备选**：保留成小号上标脚注（丑、且无意义，因为点不开）。
- **判断**：这是**排版/可读性技术决策，非产品决策**，我按 best judgment 选「剥掉 + 顶部说明」，gate 里告知 Lead，可否决。

### 决策 2 —— 翻译粒度
- **全文 100% 译中文**，保留每一个 section / 小节 / 段落 / 加粗术语条目 / 表格（dr1 无表格，都是密集散文）。
- **保留英文**：公司名（Amazon / Netflix / Toyota / Haier / Buurtzorg / Morning Star / Spotify / Gore / Zappos / Bridgewater / GitLab / Automattic / Anthropic / OpenAI…）、框架名（RACI / RAPID / DACI / OKR / andon / CRM / Type 1-2 decisions / orchestrator-worker…）、专有名词，首次出现给中文注释。符合 CLAUDE.md「技术术语/库名保留英文」。
- **不缩写、不概括、不改变含义**——纯翻译+排版。

### 决策 3 —— 版式
- **长文阅读版**（非交互 review 版）：干净排版，h1/h2/h3 + 段落 + 加粗术语，`max-width:~860-900px`，慷慨行高。
- 复用房子样式：`:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f…}` + `-apple-system` 字体 + `<meta name="robots" content="noindex,nofollow">`；**无 `@media (prefers-color-scheme: dark)`**（红线）。
- 每份文件独立 self-contained（内联 CSS，零外链）。

### 决策 4 —— 发布 & 交付
- **host-only publish**：直接 `POST {bridge}/api/reports/publish {projectName, html, title}` → 拿 `https://<fw-reports-xxx>.vercel.app/r/<token>/`（不走 `/deliver`、**不发 Discord**）。noindex+CSP 托管侧注入，HTML 内也自带 noindex 双保险。
- 3 个 URL 经 `flywheel-comm ask --report` 交 Lead；**Runner 不投 Discord、不 deliver、不 ship**。

## 边界
不 ship、不动 main、不改 DR 含义。纯翻译 + 排版 + host-only 发布。文档随分支走、随 PR 合 main（doc-flow full tier：exploration/research/plan）。
