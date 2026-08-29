# FLY-1230 一手源核准 — 业界点名立场(补 DR 导出受阻)

Issue: FLY-1230
日期: 2026-07-13
用途: DR 全文导出受阻(见 `dr-capture.md`),对 DR/业界点名的一手源自己做 web research 拿**真 URL + 核准立场**。诚实:查不到标 UNKNOWN,不编。

## A. 编排持久 / 多-agent 有用派

- **Anthropic — How we built our multi-agent research system**(2025-06)
  https://www.anthropic.com/engineering/multi-agent-research-system
  立场:orchestrator-worker;lead agent 分析 → 并行 spawn 3-5 个 subagent(各用 3+ 工具并行)→ 各自独立上下文当「智能过滤器」→ lead 综合 → CitationAgent 定位引用。**复杂查询研究时间砍最多 90%**。**注意**:这是把多-agent 用在**并行广度 + 上下文隔离**(scale),不是给弱模型切步。
- **Anthropic — When to use multi-agent systems (and when not to)** https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them —— 明确「何时用/何时别用」,非无条件推。
- **LangChain / Harrison Chase — How to think about agent frameworks**(2025-04-20)
  https://www.langchain.com/blog/how-to-think-about-agent-frameworks
  立场(务实中间派):多-agent 在单 agent「扛不住复杂指令/老选错工具」时能提性能与可扩展性;但**难点是每步给 LLM 对的 context**(controlling exact content + running the right steps)。
- **LangChain — How and when to build multi-agent systems** https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems

## B. 单-agent / 少编排派(最像 Annie 的「拐杖」直觉)

- **Cognition — Don't Build Multi-Agents**(Walden Yan)
  https://cognition.ai/blog/dont-build-multi-agents
  立场:**默认单线程线性 agent**,多-agent 要过很高的门才用。核心机制点名:**「Actions carry implicit decisions, and conflicting decisions carry bad results」** —— 把上下文拆给不共享全貌的子 agent,各自从局部视角决策 → 冲突 → 坏结果。**「Context Engineering」= 工程师第一要务**(类比 React 之于 web)。⚠️ 注意它反的是**认知线程的拆分**,不是反「所有编排」。
- **Pi Agent(pi.dev,Mario Zechner)** —— 极简单-agent 活样本,详见 `research-pi-agent.md`。驱动 OpenClaw。

## C. 「用最简的、编排按需」的调和派(官方 playbook)

- **Anthropic — Building Effective Agents**(2024-12)
  https://www.anthropic.com/engineering/building-effective-agents
  立场:分 **workflow**(LLM+工具走**预定义代码路径** = DAG)vs **agent**(模型**自主**导流程)。**「用能过 eval 的最简模式 —— 常常是一个 workflow 甚至一个配好工具的 LLM 调用」**;能 hardcode 路径就别上 agent,不能 hardcode 但能验证进度才上。5 个模式:Prompt Chaining · Routing · Parallelization · Orchestrator-Worker · Evaluator/Optimizer。→ 编排是**按任务复杂度加**的工具,不是默认。

## D. 债务/张力(诚实呈现的矛盾)

- **Cognition vs Anthropic 公开对立**(同期最热的架构之争):
  - CTOL:AI Leaders Clash Over Agent Architecture — https://www.ctol.digital/news/ai-leaders-clash-agent-architecture-cognition-anthropic-strategies/
  - Simon Willison 摘要 Anthropic 多-agent 系统 — https://simonwillison.net/2025/Jun/14/multi-agent-research-system/
  - 「Multi-agent is not dead, MCP is not the…」(2026)Level Up Coding — https://levelup.gitconnected.com/where-agentic-ai-goes-from-here-775e7c517c6b
  同一个 Anthropic:**《Building Effective Agents》劝你用最简**、**《multi-agent research system》又秀并行 subagent 大赢** —— 不矛盾,因为**用途不同**:前者反「无脑加编排」,后者是「并行广度」这类编排的正例。

## E. 第三类的线索(超出「拐杖 vs 地基」二分)

业界反复出现、二分不完全覆盖的维度:
1. **并行吞吐 / 广度**(Anthropic 多-agent research;省 90% 时间)—— 模型再强,单线程也快不过 N 个并行;这是**scale**,非拐杖非纯信任。
2. **上下文完整性 / 认知不分裂**(Cognition)—— 编排的**反面**:拆认知线程会坏事;所以「留一个不分裂的 doer」本身是一种设计约束。
3. **专业化 / 上下文隔离**(Anthropic subagent 各自干净上下文)—— 隔离噪声,非因为模型弱。
4. **组织 / 信任边界 + 互操作**(A2A、跨组织)—— DR Bottom line 明确点到 organizational interoperability。

> 这些不推翻「拐杖 vs 地基」,是给它**加轴**:除了「为弱模型打拐杖(会消)」和「为信任/控制(会长)」,还有「为并行/规模」和「为上下文完整性」。explainer §4 据此让 Annie 判要不要加第三类。
