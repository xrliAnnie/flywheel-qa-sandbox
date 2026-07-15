# FLY-1230 DR 抓取 — ChatGPT Deep Research(业界视角）

Issue: FLY-1230
日期: 2026-07-13
来源: ChatGPT Deep Research(Pro,骑 ChatGPT Plus 订阅),对话《Frontier LLMs and the Fate of Multi-Agent Orchestration in AI Coding Systems》
运行证据: 「Research completed in 7m · 23 citations · 416 searches」(截图存证)

## ⚠️ 抽取限制(诚实标注)

DR **成功运行**(真跑了,23 引用 / 416 搜索,报告标题+Bottom line 见下)。但本次在这台机器的 claude-in-chrome 上下文里,**报告全文无法导出**:报告渲染在跨域 sandbox iframe(`oaiusercontent.com`)内,而合成输入(点击导出 ↓ 菜单、iframe 内滚动)进不了这个 OOPIF —— 即 deep-research skill 记录的「headless-类」失败模式(尽管 `navigator.userAgent` 报非 headless)。原生导出(Copy contents / Export to Word)与内部滚动都被堵。

**因此**:本研究抓住 DR 的 **thesis(Bottom line 完整可读,逐字见下)** + DR 报告结构,并对 DR/业界点名的**一手源自己做 web research 拿真 URL + 核准立场**(见 `dr-web-corroboration.md`)。这比原样保留 DR 更可引用 —— DR 的内联引用本就是不可解析的 `citeturn` 内部 token(FLY-1164 已验证),真 URL 只能靠 Word 导出(此处也被堵)。**无来源被编造;查不到的标 UNKNOWN。**

## DR 报告标题

**Frontier LLMs and the Fate of Multi-Agent Orchestration in AI Coding Systems**

## Bottom line（逐字,从渲染报告读取)

> The strongest public evidence from 2024 to July 13, 2026 points to a **hybrid outcome**, not a winner-take-all one. As frontier models improved, a lot of orchestration that used to exist mainly to make weaker models usable started getting absorbed into stronger single-agent runtimes: larger context windows, better native tool use, better planning, longer autonomous loops, compaction, notes/memory, and built-in subagents-as-tools all reduce the need for brittle, hand-authored step-by-step DAGs. At the same time, the orchestration that remains important is increasingly about **control**, not cognition: independent review, security boundaries, approval gates, parallel throughput, model routing, persistence, observability, and organizational interoperability. Anthropic, OpenAI, Google, Microsoft, LangChain, and Cognition all now publish systems that reflect some version of that split, even when their rhetoric differs.
>
> [接下句(部分可见)] …the industry trend is away from explicit workflow DAGs as the main way to create…

## 这条 thesis 对我们框架的直接印证

DR 独立得出的分界线 = **「control, not cognition」**,与 Annie 的「拐杖 vs 地基」**几乎逐字重合**:
- 被吸收(= 拐杖):长 context / 原生 tool use / planning / 长自主循环 / compaction / notes-memory / subagents-as-tools → 消解「手写死步骤 DAG」。
- 留存且更重要(= 地基):independent review(reviewer≠doer)/ security boundaries / **approval gates** / parallel throughput / model routing / persistence / observability / organizational interoperability。
- 结论形态 = **hybrid,非赢者通吃** —— 不是「单 agent 取代一切」,也不是「编排永恒」,而是「拐杖那半被吸收、控制那半留存并增值」。

> 注:report 的五节(两派论战 / 被吸收能力 / 持久编排 / 点名实践者 / 检验两分框架)与提问结构对应;可见部分只到 Bottom line + §开头,后续节的细节以 web 一手源补齐(见 corroboration 文件)。
