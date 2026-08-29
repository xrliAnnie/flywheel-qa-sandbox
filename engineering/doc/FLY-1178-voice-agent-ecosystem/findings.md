# FLY-1178 语音 Agent 生态 — findings（双栏 digest）

Issue: FLY-1178 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: dr-report.md

> 供 Annie + HL + Tadashi 联席讨论的底料正文。每条 finding 双栏(技术形态/产品体验含义),
> finding ID 对应附录 A 证据台账(每条承重论断的 exact URL 已逐条人工核验)。
> DR 原文见 dr-report.md;引用红线执行方式见其「执行记录」节。

## 0. 一页摘要(≤15 行)

1. **2026 年行业主形态不是「一个语音模型全包」,而是「会话壳 + 深层 worker 委派」**——OpenAI 把高交互 Realtime 与长任务 Responses/后台分开,Google ADK 直接在 live 流里内建 agent 委派。我们的 /gemini-advanced(线三)正踩在最有平台背书的形状上。
2. **记忆传递是分层组合,不是单一机制**:平台 session/thread 管本次通话,handoff 包管交接,外部记忆库(Mem0/Zep/Letta/LangGraph store)管跨会话长程——生产系统三层都要。
3. **行业默认「短命 compute + 持久 state」**:所谓 persistent agent 几乎都指「身份/记忆落库、按需重建」(logical residency);在我们核验到的一手文档里,进程常驻(compute residency)只见于 live 会话期间的会话级形态,「无限期常驻」则缺乏一手证据支持(见 §7.5)——我们 FLY-1160 的 per-meeting 常驻脑正好落在有基建支持的那一档(会议期常驻)。
4. **耳嘴一家、脑另一家的拆分是正常生产形态**:可核验的 Anthropic 公开文档未见原生实时语音 API(最强反向信号=官方兼容层明说 audio 输入会被丢弃),而 Vapi/ElevenLabs/LiveKit/Azure 全都支持外接自有脑——我们的 Claude 脑 + 外购耳嘴不是妥协,是主流模式。
5. **市场空白判定:adjacent → effectively blank(推断,非证明)**。客服语音 agent 拥挤;「语音指挥自家工程/agent 组织」在扫描范围内最近的邻居只是语音转 prompt 的编码工具(Replit Voice Mode / Superwhisper / Wispr Flow),未发现做到口头派活+状态查询+批准+多 agent 房间协调的产品——「不存在」本质无法穷尽证明(§7.1/§7 口径)。
6. **多 agent 同房间的重复回应病灶,业界答案是协调面不是更好的 prompt**:raft.build 的 Agent Inbox(拉取式感知)+ Held Draft(发送前 freshness check)直接对症;AutoGen 用 speaker selection,LangChain 提供 supervisor/subagents 与 handoff,CrewAI 用显式委派——均未提供真正的房间级并发控制。→ FLY-1179 设计输入。
7. **会议 AI 市场里「在场参与者」仍缺位**:主流 copilot 是 note-taker;基建(LiveKit 房间参与者、ADK live)已就绪但产品层不成熟——/glaw 的差异化在 presence 行为(旁听/被点名/主动插话的分寸),不在转写。

## 1. Q1 实时语音 + 委派 agent 的组合

- **F1.1 OpenAI:RealtimeAgent 支持 session 内 handoff,但语音在首次发声后锁定**
  - 技术形态:Agents SDK 的 RealtimeAgent 可在 RealtimeSession 内 handoff;官方指南明说 "Voice can be configured, but it cannot change after the session has already produced spoken audio"。https://openai.github.io/openai-agents-python/realtime/guide/
  - 产品体验含义:一旦开口,专家切换只能是「同一个声音背后换脑」,用户听不出换人。对我们:要么接受单一声音下的隐形委派,要么刻意做显式交接提示——不能指望平台替你换声线表达身份切换。
- **F1.2 OpenAI 官方分工:Realtime 管低延迟对话,长任务放 Responses/后台**
  - 技术形态:官方定位 "Realtime sessions are best for live audio that needs low latency";长任务走 Responses/Agents 栈与后台执行,不塞进语音回合里。https://developers.openai.com/api/docs/guides/realtime
  - 产品体验含义:标准 UX 模式 = 「说、确认、派发、(可选)播报进度、回来交结果」,不是把语音回合挂起等工具跑完。这正是 /gemini-advanced 的形状。
- **F1.3 Google ADK:live 流内的 agent 委派是一等公民,切换对流透明**
  - 技术形态:run_live() 是 BIDI 流入口,持续 yield Event;官方文档:"agent transitions happen transparently within the same run_live() event stream";顺序流用 task_completed() 推进,UI 可用 event.author 变化标示当前 agent。https://adk.dev/streaming/dev-guide/part1 、https://adk.dev/streaming/dev-guide/part3
  - 产品体验含义:一条音频会话里可以显式露出「现在是 XX agent 在处理」而不断流——委派可见但不割裂。对 Discord 形态的我们,这是「人面壳 + 专家 worker」美学的最佳参照。
- **F1.4 ADK 对 live 会话中的长任务/流式工具有最完整的一手支持**
  - 技术形态:streaming tools 让工具持续回吐中间结果("stream intermediate results back to agents and agents can respond to those intermediate results");LongRunningFunctionTool(is_long_running=True)+ 事件里的 long_running_tool_ids 让客户端能展示 pending 状态。https://adk.dev/streaming/streaming-tools/ 、https://adk.dev/tools-custom/function-tools/
  - 产品体验含义:用户在深层工作进行中还能听到确认音/进度,而不是「语音 bot 卡死了?」——线三最该抄的一页。
- **F1.5 可核验的 Anthropic 公开文档未见原生实时语音 API(反向信号核实;非「不存在」的证明)**
  - 技术形态:DR 与我们复核的公开文档中均未见原生实时语音 API 面;最强的直接(反向)信号是官方 OpenAI-SDK 兼容页原话:"Audio input is not supported; it will simply be ignored and stripped from input"——它只证明兼容层不吃音频,不能穷尽证明全产品面(§7.1)。https://platform.claude.com/docs/en/api/openai-sdk
  - 产品体验含义:在当下可用的公开 API 面上,Claude 当脑、耳嘴外购不是我们的临时凑合——是这个技术栈组合的现实形态,且行业已把它常态化(见 F1.6)。
- **F1.6 AWS/Azure/LiveKit 都收敛到「语音是传输层,委派与状态在其后一层」**
  - 技术形态:AWS 官方博客展示 Nova Sonic 作 s2s orchestrator、把深层任务委派给 AgentCore 上的 sub-agents;Azure Voice Live 是统一低延迟语音接口、agent 逻辑放 Foundry Agent Service;LiveKit 让程序以「完整实时参与者」身份进房间,支持 multi-agent handoff + 内建负载均衡。https://aws.amazon.com/blogs/machine-learning/building-a-multi-agent-voice-assistant-with-amazon-nova-sonic-and-amazon-bedrock-agentcore/ 、https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live 、https://docs.livekit.io/agents/
  - 产品体验含义:三大厂 + 头部开源同向 = 这不是短期风潮。四条线里越贴「壳+worker」的越顺势,纯 s2s 单体(线一)越逆势。

## 2. Q2 记忆传递机制(Annie 优先问题)

- **F2.1 机制 (a) handoff 时上下文注入——最轻量,适合「这单活要什么」**
  - 技术形态:Vapi squads 给三种交接机制(handoff 参数/变量抽取/模板注入),默认 contextEngineeringPlan=all 把完整对话历史连工具结果一起带过去;Retell 的 intra-call Agent Transfer 让目标 agent 自动继承「完整对话历史 + call 级元数据 + 已抽取变量」。https://docs.vapi.ai/squads/passing-data-between-assistants 、https://docs.retellai.com/build/single-multi-prompt/transfer-agent
  - 产品体验含义:用户不用对新专家重复自己。但它只带「刚刚发生了什么」,撑不起组织级长记忆——对我们 = 线三的派工包(dispatch packet)与会议内专家切换,不是全公司记忆底座。
- **F2.2 机制 (b) 平台 session/thread 对象——管本次会话连续性**
  - 技术形态:Zep 把 session 定义为「消息同时进 session 历史 + 被吸收进 user 级知识图谱」;ADK 在 run_live 事件流层持久化事件历史(event 序列即会话记录);OpenAI Realtime 的 session 是 per-session live 上下文(语音等 session 级配置挂在其上)。https://help.getzep.com/v2/concepts 、https://adk.dev/streaming/dev-guide/part3 、https://developers.openai.com/api/docs/guides/realtime
  - 产品体验含义:「这通电话里别让我重复」住在这层。默认只到会话边界——不主动接长程记忆层,跨会话就失忆。
- **F2.3 机制 (c) 共享外部记忆库——把「本会话有上下文」变成「知道我们怎么工作」**
  - 技术形态:Mem0 是抽取式持久记忆层(按 user/agent/session 分区),有 OpenAI Agents SDK 语音伴侣 cookbook;Zep 的 facts 带 valid_at/invalid_at 时间有效期(改状态不覆盖旧事实,关窗开新边);Letta 把全部 agent 状态(消息/推理/工具调用/记忆)落库;LangGraph 明确二分:checkpointer=线程内短程,store=跨线程长程。https://docs.mem0.ai/cookbooks/companions/voice-companion-openai 、https://help.getzep.com/v2/concepts 、https://docs.letta.com/guides/agents/overview/ 、https://docs.langchain.com/oss/python/langgraph/persistence
  - 产品体验含义:长程个性化的收益与「陈旧记忆误用」的风险并存——强者都把「事实/偏好」与「原始转写」分开存,再加时间有效期。我们的 mem0+pgvector 方向正确,值得补的是 Zep 式时间有效期语义。
- **F2.4 生产系统是组合拳:session 管当下 + handoff 包管交接 + 外部库管长程**
  - 技术形态:反复出现的三种命名组合——LangGraph checkpointer+store、Mem0+OpenAI Agents 语音伴侣、Vapi/Retell 全历史转移+变量抽取(同 F2.1-F2.3 来源)。
  - 产品体验含义:对我们的映射清晰:Discord/live session 管实时轮次,派工状态落 Linear/自有 DB,长程层选择性记 founder 偏好与项目上下文。**不要指望单一机制覆盖三层。**

## 3. Q3 常驻 vs 短命 agent(两轴纪律:logical vs compute residency)

- **F3.1 行业默认桶:短命 compute + 持久 state(logical residency)**
  - 技术形态:Letta 官方把 agent 定义为 "stateful services"——记忆/消息/推理/工具调用全部落库,调用方只发新消息,不需要进程常驻;LangGraph persistence 同理(checkpoint 每步落盘,可恢复)。https://docs.letta.com/guides/agents/overview/ 、https://docs.langchain.com/oss/python/langgraph/persistence
  - 产品体验含义:用户感觉 agent「一直在」,其实是身份与记忆按需重建。伸缩像无状态服务,不为空闲付费——超出单场会话的一切,默认用这档。
- **F3.2 会话级/会议级常驻桶:live 语音房间的原生形态(= FLY-1160 对标)**
  - 技术形态:ADK 一次 run_live() 循环维持一个流式会话的完整上下文;LiveKit 让 agent 程序作为「完整实时参与者」驻留房间;OpenAI Realtime session 同样是 per-session live 上下文。https://adk.dev/streaming/dev-guide/part1 、https://docs.livekit.io/agents/
  - 产品体验含义:需要「它就在会里」的临场感、热轮次延迟、会内积累上下文时,这档值得付常驻成本——**为会议而驻,会后落纪要拆除**。FLY-1160 的形状在基建层有同款,只是没人包装成产品。
- **F3.3 无限期常驻桶:营销话术多,一手证据薄**
  - 技术形态:Letta 的 "persistent digital coworkers"、raft 的 "one agent is one session: a continuous identity that stays alive across days and tasks"(https://raft.build/resources/blog/introducing-raft-where-humans-and-agents-build-together/ ,原话逐字在此页)在可核验文档里都指向持久身份/状态,不是永远温热的模型进程;没有找到大厂为无限期 warm compute 背书的一手文档(详见 §7)。
  - 产品体验含义:联席讨论请把「persistent coworker」翻译成「可重建的身份与记忆」再算账——成本、崩溃恢复、编排复杂度都取决于这个区分。
- **F3.4 短命默认的理由:文档里是间接证据(可恢复性/伸缩/托管运行时),不是明说的成本论**
  - 技术形态:LangGraph 强调 checkpoint 带来的容错与断点恢复(https://docs.langchain.com/oss/python/langgraph/persistence );LiveKit 的生产特性按「进程可替换」设计("built-in agent server orchestration, load balancing, and Kubernetes compatibility",https://docs.livekit.io/agents/ )。
  - 产品体验含义:选 per-meeting 常驻要为明确的体验收益(临场/热延迟/会内上下文),而不是「业界证明常驻更好」——业界没证明,只证明了短命更好恢复、更好横向扩。

## 4. Q4 框架/平台生态 + 市场空白

- **F4.1 LiveKit Agents:开源框架+托管云,房间原生参与,基建控制力最强**
  - 技术形态:Apache 2.0 开源;"added to LiveKit rooms as full realtime participants";multi-agent handoff;接近全供应商的 LLM/STT/TTS 集成;内建 orchestration/负载均衡/K8s。无统一官方 TTFA 数字。https://docs.livekit.io/agents/
  - 产品体验含义:与 /glaw(线四)的房间形态最接近的框架级答案,适合想自持基建+自有脑的团队。
- **F4.2 Pipecat(Daily):开源 pipeline 构建套件,可观测性好,无官方整机延迟数**
  - 技术形态:开源 Python 框架,编排 100+ AI 服务的异步 pipeline;内建 TTFA(Time To First Audio)指标;无 "整机 X ms" 官方口径。https://docs.pipecat.ai/overview/introduction 、https://docs.pipecat.ai/pipecat/fundamentals/metrics
  - 产品体验含义:是「造运行时的材料」,不是现成答案——编排责任全归你。
- **F4.3 Vapi:托管语音 agent 平台;官方口径 ~800ms(FAQ),营销口径 sub-500ms(blog),取保守值**
  - 技术形态:assistants/squads/handoff 工具/MCP/自定义 STT+TTS;docs FAQ 说端到端典型约 800ms,blog 宣称 sub-500ms——两源冲突,按 FAQ 保守读。均为厂商自报。https://docs.vapi.ai/faq 、https://vapi.ai/blog/speech-latency
  - 产品体验含义:重心是电话/客服型会话路由。对我们最可搬的是 squads 的 context engineering(F2.1),不是整个平台。
- **F4.4 Retell AI:托管电话 agent 平台;厂商自报 ~600ms;intra-call 全历史转移**
  - 技术形态:官方博客:"Retell's stack runs around 600ms end-to-end"(厂商口径);Agent Transfer 全历史继承见 F2.1。https://www.retellai.com/blog/how-real-time-voice-ai-works-stt-llm-tts 、https://docs.retellai.com/build/single-multi-prompt/transfer-agent
  - 产品体验含义:可靠商务通话流是它的主场;值得抄的是转移模式,不是场景。
- **F4.5 ElevenLabs Agents:托管平台 + 官方支持外接自有 LLM server(= /eleven 的底座模式)**
  - 技术形态:官方 Custom LLM 文档:"bring your own OpenAI API key or run an entirely custom LLM server"(OpenAI 风格 /v1/chat/completions,SSE 流式)——我们 /eleven 的 shim → Claude 脑正是官方支持路径。https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm
  - 产品体验含义:表达力语音+托管运维是卖点;客户案例以对客场景为主。对我们的可搬件:custom-LLM 拆分模式与记忆/procedures 层。
- **F4.6 市场空白判定:crowded(客服)/ adjacent(语音编码)/ blank(语音指挥自家 agent 组织)**
  - 技术形态:最近邻三例——Replit Voice Mode(说→转写成可编辑文本→发给 Agent;https://docs.replit.com/references/agent/voice-mode )、Superwhisper(对 Claude Code/IDE 的语音输入;https://superwhisper.com/use-cases )、Wispr Flow(全应用语音听写+vibe coding;https://wisprflow.ai/use-cases/claude )。全部止步于「对一个编码 agent 口述 prompt」。
  - 产品体验含义:证明了「对造软件的系统说话」有真实需求;在扫描范围内未发现「口头派活给一组专家 agent、跨工作流查状态、口头批准、多 agent 房间协调」的成型产品。**诚实结论:adjacent → effectively blank——这是对最近邻品类的推断而非「不存在」的证明(§7.1 口径,DR 原文同款 caveat);差异化空间在此前提下成立,产品形态要自己蹚。**

## 5. Q5 会议参与度 + 多 agent 同房间协调

### 5a 人机会议参与

- **F5a.1 主流会议 copilot 仍是 note-taker,不是发言参与者**
  - 技术形态:Google Meet Gemini 的官方形态 = "Take notes for me"(实时记录、要点/决议/下一步落 Google Doc)+ 转写/字幕;没有官方文档描述 Gemini 作为「有发言权的房间参与者」。https://workspace.google.com/solutions/ai/ai-note-taking/ 、https://support.google.com/meet/answer/14754931
  - 产品体验含义:「会议 AI」很多,「会议里的 AI 同事」几乎没有——/glaw 的差异化主战场是 presence 行为(何时开口、如何旁听、被点名的反应),不是纪要功能。
- **F5a.2 「会说话的参与者」基建已就绪,产品层不成熟**
  - 技术形态:LiveKit 让 agent 程序以完整实时参与者身份进房间;ADK live 双向流支持连续音频 I/O、打断、转写与 agent 切换——「在场发言」在基建层已可行,但没有对应的成型产品层(结合 F5a.1)。https://docs.livekit.io/agents/ 、https://adk.dev/streaming/dev-guide/part1
  - 产品体验含义:从「能在房间说话」到「像个社交得体的参与者」差距仍大——难点是「决定什么时候不说话」。/glaw 的落地顺序应该是:**先旁听模式(lurk)→ 再显式点名应答 → 最后才是主动插话**。(DR 关于多方 turn-taking 学术文献的陈述整体移入 §7.4,不作正文承重。)

### 5b 多 agent 同房间协调(→ FLY-1179 设计输入)

- **F5b.1 raft.build 的 Agent Inbox + Held Draft 是对我们「撞车病灶」最直接的解 → FLY-1179 设计输入**
  - 技术形态:Tenny(Raft,2026-05-21)指出混乱来自「快照式推理 vs 持续流动的房间」的落差:Agent Inbox 把通知变成拉取式可查询队列(agent 自主分配注意力);Held Draft 在发送前做 freshness check——房间变了就扣住草稿退回差量,agent 四选(修改/照发/沉默/知情强发)。原则 = perception empathy + action explicitness,同时反对纯规则压制(@-only)与放任混乱两个极端。https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/ (设计阶段已核验转述准确)
  - 产品体验含义:治重复回应/重复建单,关键不是「更好的 dedup prompt」,而是把**陈旧感知与发送时新鲜度变成一等协议状态**。Cass+Tadashi 撞车建单正是缺这层。
- **F5b.2 AutoGen:中心化发言权——「同一时刻只有一个 agent 拿麦」 → FLY-1179 设计输入**
  - 技术形态:group chat 顺序制,Group Chat Manager 管轮次;SelectorGroupChat 用模型按上下文/角色选下一个发言者,可自定义 selector 函数。https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/selector-group-chat.html
  - 产品体验含义:对任务型文本房间有效;搬进人类持续说话的语音房间就要接受一个可见的「主持人」层。
- **F5b.3 LangChain/CrewAI:靠 supervisor 协调或显式委派避免碰撞,不做房间级并发控制 → FLY-1179 设计输入**
  - 技术形态:LangChain 多 agent 文档给两种模式——subagents 模式由中心 agent 协调("a central main agent (often referred to as a supervisor) coordinates subagents by calling them as tools",https://docs.langchain.com/oss/python/langchain/multi-agent/subagents ),handoff 模式用 handoff 工具切换活跃 agent("Handoff tools navigate between agent nodes",https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs ),持久状态由 checkpointer 保障(https://docs.langchain.com/oss/python/langgraph/persistence );CrewAI allow_delegation=True 自动给 agent「Delegate work / Ask question」两件协作工具(https://docs.crewai.com/en/concepts/collaboration )。
  - 产品体验含义:业界共识 = 可靠多 agent 来自**监督、显式任务所有权、可恢复共享状态**。就算房间 UI 看着像平等同事,底下也要有隐藏协调者裁决所有权与幂等。
- **F5b.4 语音房间协调比文本房间更不成熟:先建文本级协调底座,语音只当人机界面 → FLY-1179 设计输入**
  - 技术形态:直接治重复劳动的商用协调面(inbox/held-draft/speaker-selection)全是文本/工作区原生;语音房间原生的等价物未发现(综合 F5b.1-F5b.3 来源)。
  - 产品体验含义:/glaw 近期最稳妥的架构 = **语音门面下的文本级协调底座**:任务认领、发送时 freshness check、工具动作幂等键、显式发言权。不浪漫,但能止血。

## 6. 对四条线的启示映射(只给证据与 options,不替联席拍板)

| 线 | 留/深挖的证据面 | 体验目标 option | 技术路径 option |
|----|----------------|----------------|----------------|
| **/gemini(纯 s2s 单体)** | 生态在把语音降级为传输层(F1.6),单体形态逆势;但作为「最快最无仪式感的快车道」仍有位置(F1.2) | 快速指令收发/轻陪伴,不承担深度派活 | 保持薄:不加自有工具栈,当 thin fast lane |
| **/eleven(平台耳嘴+Claude 脑)** | custom-LLM 拆分是官方支持的主流模式(F4.5、F1.5),平台替你扛 turn-taking 运维 | 「一个助理在帮我」的连续感,不过度承诺身份切换 | 深挖点 = 记忆层接线(F2.4 三层组合)与 shim 的 session→长程记忆桥 |
| **/gemini-advanced(live 前端+异步深脑委派)** | **平台背书最强的形状**(F1.2/F1.3/F1.4/F1.6 全部指向「壳+worker」) | 「可信赖的口头运营」:干脆确认、可见所有权、异步进度播报、事后小结挂任务状态 | 抄 ADK 的 long-running/streaming tool 模式;派工包用 F2.1 的 context engineering |
| **/glaw(多 Lead huddle+常驻会议脑)** | per-meeting 常驻在基建层有同款(F3.2),市场上「参与者形态」空缺(F5a.1)= 差异化;但未解的是协调面(F5b) | 先 lurk → 点名应答 → 主动插话(F5a.2);「一个社交得体的发言者+一组安静 worker」优于「个个抢麦」 | 先建文本级协调底座(Inbox/Held Draft/任务认领/幂等键,F5b.1/F5b.4 → FLY-1179),再打磨声音 |

跨线共识(证据陈述,取舍归联席):①「语音指挥自家 agent 组织」在扫描范围内是 adjacent→blank 的空位(F4.6,推断非证明);②记忆三层组合(F2.4)是四条线共用的底座;③无限期常驻缺一手证据支持(F3.3),而会议场景的常驻有对应的体验收益与基建同款(F3.2)。

## 7. 未验证清单(DR 承认 + 我们降级的)

1. **Anthropic 原生实时语音 API 不存在**——验证的是反向信号(兼容页 audio 被丢弃,F1.5);「不存在」本身无法穷尽证明。
2. **LiveKit/Pipecat/ElevenLabs 无统一官方 TTFA 数字**(DR 与我们复核一致);Retell ~600ms 与 Vapi ~800ms 均为**厂商自报**,未独立复测。
3. **Zoom AI Companion 的参与者能力**:DR 称证据有限;我们未单独恢复 Zoom 来源,Q5a 结论以 Google Meet 来源为准。
4. **多方 turn-taking 学术文献(2025-2026 论文)**:DR 称该文献把多方 turn-taking(下一发言者预测、受话人识别、重叠语音、插话时机)列为未解难题——具体论文的 exact 来源未恢复,该陈述整体留在本清单,不进正文(F5a.2 正文只保留 LiveKit/ADK 已验证的基建面)。
5. **「无限期常驻 compute」无一手背书**(F3.3)——这是 DR 的诚实盲区声明,我们保留原样。
6. **各平台客户案例**(LiveKit/ElevenLabs 的 SAP/Klarna 等)均为厂商自报,未独立核实,正文未采用。
7. **DR 原文的 citeturn 内联引用无法逐 token 恢复**——我们按论断级重建了 claim→URL 映射(附录 A),粒度是「每条承重 finding」而非「每个内联标记」。

## 附录 A. claim 级证据台账(主键 = finding ID;全部人工打开核验)

| finding ID | exact URL | 来源 | 状态 | 备注 |
|-----------|-----------|------|------|------|
| F1.1 | https://openai.github.io/openai-agents-python/realtime/guide/ | OpenAI Agents SDK Realtime guide | VERIFIED | 原话 "cannot change after the session has already produced spoken audio" |
| F1.2 | https://developers.openai.com/api/docs/guides/realtime | OpenAI Realtime API guide | VERIFIED | "Realtime sessions are best for live audio that needs low latency" |
| F1.3 | https://adk.dev/streaming/dev-guide/part1 · https://adk.dev/streaming/dev-guide/part3 | ADK Bidi-streaming dev guide | VERIFIED | "transitions happen transparently within the same run_live() event stream";task_completed/event.author 同页 |
| F1.4 | https://adk.dev/streaming/streaming-tools/ · https://adk.dev/tools-custom/function-tools/ | ADK Streaming/Function tools | VERIFIED | streaming 中间结果原话核验;LongRunningFunctionTool 定义页 |
| F1.5 | https://platform.claude.com/docs/en/api/openai-sdk | Anthropic OpenAI SDK compatibility | VERIFIED | 原话 "Audio input is not supported; it will simply be ignored and stripped from input"(docs.anthropic.com 301 至此)。仅证明兼容层反向信号;「原生 API 不存在」按 §7.1 作推断陈述 |
| F1.6 | https://aws.amazon.com/blogs/machine-learning/building-a-multi-agent-voice-assistant-with-amazon-nova-sonic-and-amazon-bedrock-agentcore/ · https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live · https://docs.livekit.io/agents/ | AWS ML blog / MS Learn / LiveKit docs | VERIFIED | Nova Sonic 作 orchestrator 委派 AgentCore sub-agents;Voice Live=统一语音接口+Foundry Agent Service;LiveKit "full realtime participants" |
| F2.1 | https://docs.vapi.ai/squads/passing-data-between-assistants · https://docs.retellai.com/build/single-multi-prompt/transfer-agent | Vapi/Retell docs | VERIFIED | 三机制+contextEngineeringPlan all;"destination agent automatically inherits: Full conversation history" |
| F2.2 | https://help.getzep.com/v2/concepts · https://adk.dev/streaming/dev-guide/part3 · https://developers.openai.com/api/docs/guides/realtime | Zep Key Concepts / ADK / OpenAI Realtime guide | VERIFIED | session 消息双写(历史+图谱);ADK 事件序列即会话记录;Realtime per-session 上下文 |
| F2.3 | https://docs.mem0.ai/cookbooks/companions/voice-companion-openai · https://help.getzep.com/v2/concepts · https://docs.letta.com/guides/agents/overview/ · https://docs.langchain.com/oss/python/langgraph/persistence | Mem0/Zep/Letta/LangChain docs | VERIFIED | 语音伴侣 cookbook 实在;valid_at/invalid_at;stateful services;checkpointer vs store |
| F2.4 | https://docs.langchain.com/oss/python/langgraph/persistence · https://docs.mem0.ai/cookbooks/companions/voice-companion-openai · https://docs.vapi.ai/squads/passing-data-between-assistants · https://docs.retellai.com/build/single-multi-prompt/transfer-agent | LangChain/Mem0/Vapi/Retell docs | VERIFIED | 三种命名组合各有独立来源(checkpointer+store / Mem0+OpenAI Agents 语音 / 平台内全历史转移),无 F2.1-F2.3 之外的新事实 |
| F3.1 | https://docs.letta.com/guides/agents/overview/ · https://docs.langchain.com/oss/python/langgraph/persistence | Letta/LangChain docs | VERIFIED | "stateful services"、全状态落库、只发新消息 |
| F3.2 | https://adk.dev/streaming/dev-guide/part1 · https://docs.livekit.io/agents/ · https://developers.openai.com/api/docs/guides/realtime | ADK/LiveKit/OpenAI docs | VERIFIED | run_live 会话级上下文;房间常驻参与者;Realtime per-session live 上下文 |
| F3.3 | https://raft.build/resources/blog/introducing-raft-where-humans-and-agents-build-together/ · https://docs.letta.com/guides/agents/overview/ | Raft blog(introducing) / Letta docs | VERIFIED | 「one agent is one session…」原话逐字在 introducing-raft 页(QA WebFetch + implement 复核双确认;此前误挂 chaos 文章,QA round 1 纠正);持久=状态而非进程;「无限期 warm compute 无一手背书」为诚实盲区(§7.5) |
| F3.4 | https://docs.langchain.com/oss/python/langgraph/persistence · https://docs.livekit.io/agents/ | LangChain/LiveKit docs | VERIFIED | 容错/断点恢复论据;LiveKit orchestration/load balancing 原话;「间接证据」定性已在正文说明 |
| F4.1 | https://docs.livekit.io/agents/ | LiveKit docs | VERIFIED | 开源/参与者/handoff/负载均衡;无官方整机 TTFA(§7.2) |
| F4.2 | https://docs.pipecat.ai/overview/introduction · https://docs.pipecat.ai/pipecat/fundamentals/metrics | Pipecat docs | VERIFIED | 开源 pipeline 框架;TTFA 指标存在、无整机数字(§7.2) |
| F4.3 | https://docs.vapi.ai/faq · https://vapi.ai/blog/speech-latency | Vapi docs/blog | VERIFIED | ~800ms(FAQ) vs sub-500ms(blog) 冲突如实并列;厂商自报 |
| F4.4 | https://www.retellai.com/blog/how-real-time-voice-ai-works-stt-llm-tts · https://docs.retellai.com/build/single-multi-prompt/transfer-agent | Retell blog/docs | VERIFIED | 原话 "Retell's stack runs around 600ms end-to-end";厂商自报 |
| F4.5 | https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm | ElevenLabs docs | VERIFIED | "bring your own OpenAI API key or run an entirely custom LLM server" |
| F4.6 | https://docs.replit.com/references/agent/voice-mode · https://superwhisper.com/use-cases · https://wisprflow.ai/use-cases/claude | Replit/Superwhisper/Wispr docs | VERIFIED | 三个最近邻均为语音→prompt 层(来源已核);「blank」结论本身是推断(§7.1),正文已标注 |
| F5a.1 | https://workspace.google.com/solutions/ai/ai-note-taking/ · https://support.google.com/meet/answer/14754931 | Google Workspace/Meet 官方 | VERIFIED | "Take notes for me" 形态=note-taker |
| F5a.2 | https://docs.livekit.io/agents/ · https://adk.dev/streaming/dev-guide/part1 | LiveKit/ADK docs | VERIFIED | 正文仅含基建面(两源已核);学术文献陈述已整体移入 §7.4,不在正文 |
| F5b.1 | https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/ | Raft blog (Tenny, 2026-05-21) | VERIFIED | 设计阶段全文核对:Agent Inbox/Held Draft/四选项/两原则转述准确 |
| F5b.2 | https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/selector-group-chat.html | AutoGen docs | VERIFIED | 模型选下一发言者+可自定义 selector |
| F5b.3 | https://docs.crewai.com/en/concepts/collaboration · https://docs.langchain.com/oss/python/langchain/multi-agent/subagents · https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs · https://docs.langchain.com/oss/python/langgraph/persistence | CrewAI/LangChain docs | VERIFIED | allow_delegation 两工具;subagents=supervisor 协调("often referred to as a supervisor");handoff=切换活跃 agent;checkpointer 管持久状态 |
| F5b.4 | https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/ · https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/selector-group-chat.html · https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs · https://docs.crewai.com/en/concepts/collaboration | Raft/AutoGen/LangChain/CrewAI docs | VERIFIED | 四个已核协调面全部为文本/工作区原生;「语音房间原生等价物未发现」为扫描性推断,按 §7 口径陈述 |

## 附录 B. 全量 URL 健康表(2026-07-11 curl -L 实测)

| URL | HTTP | 分类 |
|-----|------|------|
| https://openai.github.io/openai-agents-python/realtime/guide/ | 200 | OK |
| https://developers.openai.com/api/docs/guides/realtime | 200 | OK |
| https://adk.dev/streaming/dev-guide/part1 | 200 | OK |
| https://adk.dev/streaming/dev-guide/part3 | 200 | OK |
| https://adk.dev/streaming/streaming-tools/ | 200 | OK |
| https://adk.dev/tools-custom/function-tools/ | 200 | OK |
| https://platform.claude.com/docs/en/api/openai-sdk | 200 | OK |
| https://aws.amazon.com/blogs/machine-learning/building-a-multi-agent-voice-assistant-with-amazon-nova-sonic-and-amazon-bedrock-agentcore/ | 200 | OK |
| https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live | 200 | OK |
| https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-agents-quickstart | 200 | OK |
| https://docs.livekit.io/agents/ | 200 | OK |
| https://docs.pipecat.ai/overview/introduction | 200 | OK |
| https://docs.pipecat.ai/pipecat/fundamentals/metrics | 200 | OK |
| https://docs.vapi.ai/faq | 200 | OK |
| https://vapi.ai/blog/speech-latency | 200 | OK |
| https://docs.vapi.ai/squads/passing-data-between-assistants | 200 | OK |
| https://docs.vapi.ai/squads/handoff | 200 | OK |
| https://docs.retellai.com/build/single-multi-prompt/transfer-agent | 200 | OK |
| https://www.retellai.com/blog/how-real-time-voice-ai-works-stt-llm-tts | 200 | OK |
| https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm | 200 | OK |
| https://elevenlabs.io/docs/eleven-agents/overview | 200 | OK |
| https://docs.mem0.ai/cookbooks/companions/voice-companion-openai | 200 | OK |
| https://help.getzep.com/v2/concepts | 200 | OK |
| https://docs.letta.com/guides/agents/overview/ | 200 | OK |
| https://docs.letta.com/core-concepts/ | 200 | OK |
| https://docs.langchain.com/oss/python/langgraph/persistence | 200 | OK |
| https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs | 200 | OK |
| https://docs.langchain.com/oss/python/langchain/multi-agent/subagents | 200 | OK |
| https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/ | 200 | OK |
| https://raft.build/resources/blog/introducing-raft-where-humans-and-agents-build-together/ | 200 | OK |
| https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/selector-group-chat.html | 200 | OK |
| https://docs.crewai.com/en/concepts/collaboration | 200 | OK |
| https://docs.replit.com/references/agent/voice-mode | 200 | OK |
| https://superwhisper.com/use-cases | 200 | OK |
| https://wisprflow.ai/use-cases/claude | 200 | OK |
| https://workspace.google.com/solutions/ai/ai-note-taking/ | 200 | OK |
| https://support.google.com/meet/answer/14754931 | 200 | OK |

> 37/37 URL 全 200(初测 docs.pipecat.ai/guides/features/metrics 404,已替换为正确路径 /pipecat/fundamentals/metrics 并复测 200;Codex R1/R2 后补入 LangChain multi-agent handoffs + subagents 两来源;QA round 1 后 F3.3 quote 出处订正为 introducing-raft 并复测 200)。
