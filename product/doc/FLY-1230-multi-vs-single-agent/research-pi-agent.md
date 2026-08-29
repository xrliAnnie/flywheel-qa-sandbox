# FLY-1230 补充调研 — Pi Agent + 极简单-agent 派(Lead 指令 8db6eb55)

Issue: FLY-1230 (https://linear.app/geoforge3d/issue/FLY-1230/research-多-agent-编排会不会被单-agent-模型能力取代-业界视角-chatgpt-deep-research)
日期: 2026-07-13
基于: research.md;Honey Lemon 指令(Annie 主动问到 Pi,值得单列一节对照)

> 为什么单列:Pi 是「主动砍编排 / 一个精干 agent 自己扛」的**活样本**,正好是「拐杖 vs 地基」框架的现实测试 —— 看它**留下了什么、丢了什么、代价是什么**。且 Pi 就是 **OpenClaw** 里的那个 minimal agent(和我们自己的栈有交集)。

## Pi 是什么(pi.dev,作者 Mario Zechner,libGDX 之父)

极简、可自我修改、终端里跑的 AI coding agent。起因:Claude Code 功能越堆越多 → 行为变得**不可预测** → Mario 决定「尽量少加功能」。核心主张:**模型已经够强,重脚手架反而添乱 + 遮蔽上下文。**

## ① 它主动砍掉了什么(赌这些是「拐杖」)+ 理由(带引用)

| 砍掉的编排/功能 | Pi 的理由(verbatim / 转述) |
|---|---|
| **Sub-agents(子 agent)** | 「zero visibility into what that sub-agent does. It's a **black box within a black box**.」需要时用 bash 直接 spawn 一个 pi,保住可观测。 |
| **Plan mode** | 引入不必要的状态;改把计划写进**文件**(跨 session 持久、用户可编辑、可协同改)。 |
| **MCP** | 「MCP servers are overkill for most use cases」,上下文成本高(占 7–9% 窗口);改用带 README 的简单 CLI 工具,按需才付 token。 |
| **权限弹窗 / 安全护栏** | 「**full YOLO mode**」——无权限检查。理由:他把前置权限检查视为 **security theater(安全剧场)**——一旦 read/execute/network 共存,前置闸挡不住 exfiltration(**转述,非逐字连续引用**)。 |
| **内置 to-dos** | 「generally confuse models more than they help」;用外部文件替代。 |
| **后台 bash** | 加复杂度无真收益;用 tmux 拿「full observability」+ 交互式协同 debug。 |
| **大 system prompt** | Pi 的 system prompt + 工具定义**合计 <1000 token**(对比 Claude Code 大得多)。 |

## ② 它保留了什么

- **4 个核心工具:read, write, edit, bash**(另有可选只读 grep/find/ls,默认关)。「these four tools are all you need for an effective coding agent.」
- **全上下文透明 / 可观测**(你确切知道什么进了 context window;无隐藏 plan mode、无偷偷注入工具)。
- session 管理 + 连续性;项目级 `AGENTS.md` 配置;token/成本追踪;15+ 多 provider + 中途换模型;**自我扩展**(自己写 TypeScript 扩展,热加载)。

## ③ 「模型够强所以不用重脚手架」主张(verbatim)

> 「All the frontier models have been **RL-trained up the wazoo**, so they inherently understand what a coding agent is. There does not appear to be a need for 10,000 tokens of system prompt.」

Armin Ronacher(独立呼应):「**LLMs are really good at writing and running code, so embrace this.**」我们把他的意思概括为:很多编排更像**过早的复杂度**、而非**必要拐杖**(此为<b>我们的概括,非原文引用</b>)。

## ④ 承认的代价 / tradeoff(诚实呈现)

- **上下文收集仍差**:「Models are still poor at finding all the context needed.」——砍掉脚手架后,模型漏读关键上下文的问题裸露出来。
- TUI 信息密度不如 GUI;跨 provider 统一 API「can never be perfect due to leaky abstractions」。
- 无前置安全闸后的相关做法(**分述,来源事实**):① 在 YOLO 段他明确建议「不放心就跑在容器里(Run pi inside a container)」做隔离;② 全上下文可观测;③ session / 计划都在可读文件里(②③ 出现在 planning / review 等其它语境)。—— **他并没有把「容器 + 透明 + 事后人审」定义成 permission gate 的替代方案;是我们把这几项合起来读成一种可能的代偿**(『实时盯』更是我们对本地结对语境的推断,非 Pi 明示)。

## ⑤ 对「人工监督 / 验证 / 不可逆动作控制」的态度(关键,直接对照我们的地基类)

- **明确拒绝程序化前置监督**:无权限弹窗、无预检、无护栏——把安全当「theater」。
- **用透明当主要保障**:全可观测(可读 session 文件、markdown 计划、可见 tool call)→ **人在事后 review**,而非事前拦截。
- **文件化协同**:计划/todo/追踪都在人可编辑文件里,保住人「先看、改、再放行」的能动性。
- **不做黑箱 sub-agent**:任何子工作要么可见、要么用户发起。
- Review 和多-agent 不是「不做」,是**做成按需 opt-in 扩展**:Pi 有 `/review`(代码审查)和实验性 `/control`(多-agent)扩展——**不内建,任务需要时才显式、可见地加上。**

## 对「拐杖 vs 地基」框架的直接含义(供 co-eval,不下结论)

- **支持「拐杖」侧**:一个强模型 + 4 工具 + 短 prompt 就能扛住大部分 coding —— 很多编排确实是给不够强的模型/给不透明打的补丁。
- **细化「地基」侧的关键张力(假设,留给 founder 判)**:Pi **也砍了批准闸**(我们框架里的地基项之一)——作者**仍日常用它、仍主张 YOLO**(他也**明确承认** prompt-injection / exfiltration 攻击面,并未声称「没出过事」)。一种读法是**它的语境是本地结对(人就在旁边)**;他明说的相关做法是容器隔离 + 可观测 + 可读文件事后审(把这几项合起来当「替代」、以及『人实时看』,都是**我们的读法**)。
- **对我们(Flywheel)的可能落差(开放问题,非结论)**:我们更像**人注意力稀缺的自治 fleet**——founder 不在每个动作旁边。**如果** Pi 的「透明+容器+事后人审」替代依赖『有人在看』,那在我们的语境它还成不成立、同一个批准闸算不算地基,**这是要交给 Annie 判的开放问题**,不是本研究的结论。一种可用的判据:『人还在不在回路里』——但用不用它、结论是什么,由 founder 定。
- **一个共通做法可借**:「不内建、按需 opt-in、且可见」——review/orchestration 做成显式可见的扩展而非藏在黑箱里。这条正对我们「拐杖砍薄、地基留厚、且都要可审计」。

## 来源

- Mario Zechner, "What I learned building an opinionated and minimal coding agent" — https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- Armin Ronacher, "Pi: The Minimal Agent Within OpenClaw" — https://lucumr.pocoo.org/2026/1/31/pi/
- The Pragmatic Engineer, "Building Pi, and what makes self-modifying software so fascinating" — https://newsletter.pragmaticengineer.com/p/building-pi-and-what-makes-self-modifying
- 项目: pi.dev(开源)
- 顺带(极简/单-agent 派其它样本,主 DR 若覆盖则并入):OpenHands、OpenClaw(Pi 即其内 minimal agent)。
