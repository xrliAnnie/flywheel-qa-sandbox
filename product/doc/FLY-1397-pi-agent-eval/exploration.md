# FLY-1397 Pi Agent 评估 — 探索

Issue: FLY-1397 (https://linear.app/geoforge3d/issue/FLY-1397/researchhl-pi-agent-pidev-评估-要不要接进-flywheel-databricks-coding-agent)
日期: 2026-07-20
基于: 无(平级参照 `product/doc/FLY-1230-multi-vs-single-agent/research-pi-agent.md`)

## 这张单要什么

Annie 直令(#flywheel-product):「值得开一个 issue 研究一下,要不要把 Pi Agent 放到我们自己的系统里面去?」

**形态 = 纯研究 + explainer HTML + 跟 Annie co-decide**。不擅自下「接 / 不接」结论 —— 摆清楚**事实 + 选项 + 取舍**,决定权归 Annie。同尺、标 UNKNOWN、来源可追。

## 两个源

1. **pi.dev / `earendil-works/pi`** —— Pi Agent 本身。
2. **Databricks 博客** "Benchmarking Coding Agents on Databricks' Multi-Million Line Codebase" —— 百万行代码库上 benchmark coding agent。

## 要回答的四问(issue 原文)

1. **Pi 是什么** —— 形态(coding agent? control plane? 模型?)、跑法、开源/闭源、接入方式。
2. **Databricks benchmark 说了什么** —— 怎么测、Pi/同类表现、对「大代码库上跑 coding agent」的方法论借鉴。
3. **接进 Flywheel 值不值** —— 补我们什么(现在 executor = Claude Code / Codex)?跟三段式 / DAG / runner 体系怎么接?替换 vs 并列 vs 借鉴?有没有必要?
4. **诚实边界** —— 查不到标 UNKNOWN,不编。

## 初步框定(先建立在事实上,细节进 research.md)

### 一句话定性(已从源坐实)
Pi **不是模型,是一个极简 agent harness**(CLI + TS 库),MIT 开源,和 Flywheel 现有 executor(Claude Code / Codex)是**同一层的东西** —— 它自己驱动模型(15+ provider)。所以「接进 Flywheel」这个问题,天然落到 Flywheel **已有的 executor-backend 抽象**上(`claude | gemini | codex | cursor | antigravity | kimi`)。

### 为什么这张单此刻值得认真看(两条真实钩子)
- **血缘钩子**:Pi 是 **OpenClaw 内的那个 minimal agent**,而 **Flywheel 最早就搭在 OpenClaw 上**(CLAUDE.md: v0.5 OpenClaw Bridge、FLY-67 OpenClaw runtime)。不是陌生外部物,是我们自己栈的近亲。
- **benchmark 钩子**:Databricks 这个**独立第三方** benchmark 的头条恰恰是「**harness 本身**能带来 >2x 成本差」—— 而 Flywheel 的 executor 就是 harness。这条把「值不值」从「又一个 vendor」拔高成「**harness 层的效率杠杆**」问题。

### 与 FLY-1230 的关系(不重复)
FLY-1230 已从「**多-agent 编排会不会被单-agent 取代 / 拐杖 vs 地基**」的**哲学**视角研究过 Pi(它砍了什么、留了什么、代价)。本单**不重复那层**,聚焦两件 FLY-1230 没做的:
- **工程接入形态** —— Pi 在 Flywheel 的 runner/transport/三段式/DAG 里具体怎么落、落在哪一档。
- **Databricks benchmark** —— FLY-1230 时这个 benchmark 还没进视野;它给「值不值」提供了新的、可引用的成本/方法论证据。

## 交付形态(待 gate 与 Lead 确认)

- 主交付 = **explainer HTML**(facts → options → tradeoffs,不下结论),放本文件夹。
- 支撑 = research.md(实证素材,同尺 + 逐条来源)。
- **我(runner)不 publish founder-facing**(Lead publish 铁律):产出 HTML → relay 路径给 HL → HL review + publish + 跟 Annie co-eval。
- 文档随分支进 PR,走 legacy 流程。

## 待 Lead 确认的一个过程问题

doc-flow 档位是 **full**(exploration/research/plan + design_review)。但本单是**研究-explainer**(非代码改动、低风险、可逆),历史同类研究单(FLY-1230 / FLY-1294 / FLY-1237)实际是 **research.md + explainer HTML** 的轻形态,没跑 plan + codex design-review 那套。建议本单也走轻档(exploration + research + explainer HTML,跳过 plan/design-review 重流程),把精力放在事实密度和取舍清晰上 —— **请 Lead 拍**。
