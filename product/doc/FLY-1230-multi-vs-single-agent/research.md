# FLY-1230 调研 — DR 问题分解 · 预期来源图景 · 房子样式 · 发布契约

Issue: FLY-1230 (https://linear.app/geoforge3d/issue/FLY-1230/research-多-agent-编排会不会被单-agent-模型能力取代-业界视角-chatgpt-deep-research)
日期: 2026-07-13
基于: exploration.md

## 1. DR 问题分解(喂给 ChatGPT Deep Research 的结构)

面向 Annie 的疑问,让 DR 覆盖五问,要求**引用来源、诚实、查不到标 UNKNOWN**:

- **Q1 — 大势与两派:** 2024–2026 业界怎么看「multi-agent 编排 vs 单个足够强的 agent」?哪些声音说编排是过渡拐杖(模型变强就多余)、哪些说编排是持久架构?各自的论据。
- **Q2 — 正在被单 agent 吸收的能力:** 长 context、原生 tool-use、planning/reflection、self-correction、subagents-as-tools(把子 agent 当工具调)、更长自主时限 —— 这些让哪一类「切步喂」式编排变多余?给具体证据(模型/产品/benchmark)。
- **Q3 — 持久的编排(agent 越强越重要):** 独立验证 / 交叉检查(reviewer≠doer)、安全/审计、人对不可逆动作的控制(批准闸)、并行与规模、可靠性 barrier、成本/延迟隔离 —— 哪些是「聪明 10 倍也依然需要」的?
- **Q4 — 头部实践者的具体立场:** 点名引用(公司/人/产品)—— 例如 Anthropic(multi-agent research system;subagents;context engineering)、Cognition/Devin(「Don't Build Multi-Agents」)、OpenAI(Swarm→Agents SDK)、LangChain/LangGraph、Google ADK/A2A、Microsoft AutoGen、CrewAI/MetaGPT、以及反方/怀疑派。诚实呈现**互相矛盾**的立场。
- **Q5 — 对照「拐杖 vs 地基」框架:** 这套二分对不对?哪里过简?业界有没有它没覆盖的第三类(例:并行吞吐、专业化/上下文隔离、组织/信任边界)?

> 说明:DR 报告本身是**业界视角**,不含我们四个 DAG 程序的内部映射 —— 那层映射放在 explainer 里由我们做,并留给 Annie co-eval。

### 补充(Lead 指令 8db6eb55)—— 极简单-agent 派单列一节
Annie 主动问到 **Pi Agent**(pi.dev,Mario Zechner)—— 「主动砍编排 / 一个精干 agent 自己扛,核心 4 工具 + 短 prompt」的活样本,正好现实测试「拐杖 vs 地基」(留下什么/丢了什么/代价)。已做带引用的补充调研,见 **`research-pi-agent.md`**;explainer 单列一节对照。顺带扫 OpenHands/OpenClaw(Pi 即 OpenClaw 内的 minimal agent)。

## 2. 预期来源图景(帮判断 DR 是否覆盖到位;不是结论)

以下是**预期会出现**的业界坐标,用于事后核对 DR 覆盖面,不预设立场:

- **偏「编排持久」派:** Anthropic multi-agent research(orchestrator-worker;独立 subagent 上下文隔离)、LangGraph(显式图=可控/可审计)、OpenAI Agents SDK、Google A2A/ADK。
- **偏「单 agent 吸收」派:** Cognition《Don't Build Multi-Agents》(共享上下文、单线程更可靠)、「context engineering > 多 agent」论、长-horizon 单 agent(Devin/Claude Code 自身)。
- **中间/混合派:** 「多数活单 agent + 少数场景编排」、subagents-as-tools(编排退化成一个工具调用)、evaluator-optimizer 只在有客观评分时用。
- **学术:** multi-agent LLM survey、agentic workflow、cross-examination/debate 提升可靠性、self-consistency。

## 3. 房子样式(复用 FLY-1045/1164 已验证形态)

- 令牌: `:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#6e6e73;--navy:#1a365d;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de}`
- 字体: `-apple-system,system-ui,"PingFang SC",sans-serif`,`line-height:1.6`
- 容器: `max-width:860px;margin:0 auto`
- 头部: `<meta name="robots" content="noindex,nofollow">` + charset + viewport
- **零 dark-mode**(红线:grep 无 `prefers-color-scheme`)
- 完全 self-contained（指**资源**）:内联 `<style>`,零远程 `src`(脚本/图片)、零 `@import`、零远程样式表/字体。注:正文里指向来源的 `<a href>` 链接是**有意保留**的(读者要能点到 anthropic/cognition 等原文),不算外链违规。
- 交互 JS(留言框「一键复制我全部批注」)走 `<script nonce="__CSP_NONCE__">` —— FLY-930/发布时注入真 nonce,内联 JS 真可用(memory:hosted CSP 已支持 nonce 内联 JS,别退回静态)

## 4. host-only 发布契约(FLY-930 nonce / FLY-203)

- 端点: `POST {FLYWHEEL_BRIDGE_URL}/api/reports/publish`,header `Authorization: Bearer {TEAMLEAD_API_TOKEN}` + `Content-Type: application/json`
- body: `{projectName:"flywheel", html, title}`(HTML ≤ 512KB)
- 返回: `{url: "https://<fw-reports-xxx>.vercel.app/r/<token>/", reportId}` —— `<token>` = 不可猜 nonce
- **不调 `/deliver`** → 不发 Discord、不落 core 频道(避开「publish-report 对 Runner 默认落 core、Lead 没权限删」的坑)
- nonce URL 经 `flywheel-comm ask --lead flywheel-product-lead --report` 交 Lead

## 5. 交付

- DR 抓取(Bottom line 逐字 + 一手源核准;全文导出受阻,见 `dr-capture.md`)+ 中文 co-eval explainer HTML(nonce URL 交 Lead)
- Runner 不投 Discord、不 deliver、不 ship、不动 main、不下结论
