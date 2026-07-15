# FLY-1178 语音 Agent 生态 deep research — 调研

Issue: FLY-1178 (https://linear.app/geoforge3d/issue/FLY-1178/research-语音-agent-生态-deep-research-实时语音委派-agent-的行业形态记忆传递常驻取舍双视角技术形态)
日期: 2026-07-11
基于: exploration.md

> 本文档是 **DR 执行的设计依据**：每问的搜索锚点、deep-research skill 的执行约束提炼、
> FLY-883 管线复用点、findings.md 模板。dr-prompt.md（同文件夹）是据此定稿的英文 prompt。

## 1. 方法

1. **离线审计**（已完成，见 exploration §2）：FLY-883 前例 + 四条线现状 + FLY-1160 +
   FLY-906 PRD + FLY-1168 设计要求 comment（其 Agent Inbox/Held Draft 内容现归
   FLY-1179 专单）+ raft.build 种子文章（已 fetch 验证可点，
   术语核实：Agent Inbox / Held Draft / perception empathy / action explicitness，
   作者 Tenny，Raft CTO，2026-05-21）。
2. **DR prompt 设计**（本文档 §2-§3 → dr-prompt.md）：锚点先行 —— 每问给「必查对象」
   清单压住跑偏；锚点是**起跳点不是结论**，prompt 显式允许 DR 超出清单。
3. **执行**（implement 阶段，见 plan.md）：deep-research skill 跑主轮 → 引用验证 →
   补跑判定 → findings.md 双栏 digest。

## 2. 每问搜索锚点（供 prompt 起跳 + findings 校验）

> 锚点来自模型先验，**时效需 DR 核实**；prompt 里全部转成英文必查对象。

### Q1 实时语音 + 委派 agent 的组合

| 锚点 | 查什么 |
|------|--------|
| OpenAI Realtime API + Agents SDK「voice agents」指南 | 官方两分法：speech-to-speech（realtime 模型直连）vs chained（STT→LLM→TTS）；各自适用判据原话 |
| OpenAI Agents SDK handoff（voice 场景） | 语音会话里 agent 间 handoff 的机制（交接时上下文怎么带、用户听感是什么：换声线？播报？静默？）；RealtimeAgent 的 handoff 支持 |
| Gemini Live API + ADK（Agent Development Kit） | bidi-streaming（live mode）下的 agent 化；ADK sub-agents / agent transfer / delegation 与 Live 的组合形态 |
| 其他仅当显著 | Amazon Nova Sonic + Bedrock Agents、Azure Voice Live + AI Agent Service、LiveKit Agents 多 agent workflow/handoff |
| 反向事实 | Anthropic **没有** native voice API（我们脑是 Claude、耳嘴外购 —— 行业里「脑与耳嘴分厂」的组合别人怎么搭） |

### Q2 记忆传递机制（Annie 专门问的）

| 机制类 | 锚点 |
|--------|------|
| (a) handoff 时上下文注入 | Agents SDK handoff 的 input filter / 会话历史传递；ADK agent transfer 时 session state 共享 |
| (b) 平台 thread/session 对象 | OpenAI Conversations/Threads、Realtime session；ADK Session / State / Memory Service；ElevenLabs Agents 的会话对象 |
| (c) 共享外部记忆库 | mem0、Zep、Letta（MemGPT）、LangGraph checkpointer/Store、向量 DB 直挂；语音平台的内建方案（Vapi 的 memory / dynamic variables、Retell 的会话变量、ElevenLabs knowledge base + 跨会话记忆） |
| 组合问法 | 生产系统实际怎么搭组合（如「platform session 管短程 + 外部库管长程」）；短命 task-agent 接力时哪种最常见 |

### Q3 常驻 vs 短命 agent

> **两轴纪律（Codex R1 #4）**：「常驻」必须拆成两个不同的轴，逐案例分别标记，
> 否则会把「可恢复的持久状态」误算成「常驻进程」：
> ① **logical residency** = identity/history/memory 持久化可重建（如 Letta 官方把
> agent 定义为 "stateful services"，状态落 DB、调用方只发新消息 ——
> https://docs.letta.com/guides/get-started/for-agents ，这只证明持久状态）；
> ② **compute/session residency** = 进程/模型连接/live context 空闲期仍在线
> （= 我们 FLY-1160「一场会一个常驻脑」的真正含义）。

| 锚点 | 查什么 |
|------|--------|
| 常驻派案例 | Letta/MemGPT（标两轴！）；companion 类（Character.AI/Replika 持久 persona）；LangChain「ambient agents」概念；OpenAI/Google 官方是否有常驻 session 形态背书。每案例标：durable state / warm process / idle 成本 / 崩溃恢复 / 生命周期边界（per task/conversation/meeting/indefinite） |
| 短命派理由 | 成本（空转）、上下文漂移/污染、崩溃恢复、水平扩展、安全面 —— 找有明说理由的一手/权威来源 |
| 判据 | 什么场景值得 **compute 常驻**：warm 首轮延迟、会议连续在场、会话内积累上下文（= FLY-1160 动机）；行业有没有「per-meeting resident」同款。终局对比至少三桶：ephemeral compute + persistent state / per-meeting resident / indefinite resident |

### Q4 框架/平台生态

| 对象 | 形态假设（待核实） |
|------|-------------------|
| LiveKit Agents | 开源框架 + WebRTC 基建；agent 编排、多 agent、电话/网页场景 |
| Pipecat（Daily） | 开源 pipeline 框架；可组合 STT/LLM/TTS 节点 |
| Vapi | 托管语音 agent 平台（API-first，电话为主） |
| Retell AI | 托管平台，客服/电话 agent |
| ElevenLabs Agents（Conversational AI） | 托管平台：STT/TTS/turn-taking 全包 + 工具调用（= 我们 /eleven 的底座） |
| 补充仅当显著 | Hume EVI（共情语音）、Bland、Sindarin 等 |
| 每对象四件事 | 架构形态（框架 vs 平台 vs API）/ 延迟预算（公布的 TTFA 数字）/ 适用场景 / 谁在生产用 |
| **市场空白问** | 「语音指挥自家工程系统」（founder 对着自己的 agent 组织说话：派活/查状态/批准）—— 找最接近的 3-5 个案例（voice coding 如 Serenade/Talon/Wispr Flow、voice + IDE agent、Jarvis 式 org 控制）并说明与我们场景的差距；证明「空白」比证明「有」难，转成邻近案例扫描 |

### Q5 会议参与度 + 多 agent 同房间协调（gate 加深）

| 子面 | 锚点 |
|------|------|
| 5a 人机会议参与 | Zoom AI Companion / Google Meet Gemini（note-taker 形态，≠参与者）；recall.ai（会议 bot 基建）；真正「会说话的参与者」案例；多方口语对话的 turn-taking 研究（who-speaks-next 预测、backchannel、旁听→插话时机） |
| 5b 多 agent 同房间 | **种子（必读必引）**：raft.build *Is having agents in the room meant to be chaotic?*（Tenny，2026-05-21）—— 回合制快照病灶 + Agent Inbox（拉取式感知）+ Held Draft（freshness check，四选项）+ perception empathy / action explicitness；再扫：AutoGen group chat 的 speaker selection、LangGraph supervisor/swarm 的发言权、CrewAI、floor control 协议（人机对话文献）、shared-channel bot 去重/幂等实践 |
| 我们的病灶（写进 prompt context） | 回合制 agent 在连续房间重复回应/重复做事（Cass+Tadashi 撞车建 issue 真实发生）——让 DR 对着病灶找解法 |

## 3. dr-prompt 设计要点（→ dr-prompt.md 定稿）

1. **英文**，FLY-883 四件套结构：Context → 编号研究问题 → Source guidance → Output format。
2. **已知地带声明**（防重复烧预算）：backend 选型（OpenAI Realtime vs Gemini Live vs
   本地栈的延迟/成本/音质/混说）、v2v vs pipeline vs hybrid 架构取舍、Discord 传输层
   —— 写明 "we already completed a separate deep research on X; do NOT re-cover"。
3. **双栏硬格式**：每 finding 两行标签 `Technical form:` / `Product-experience
   implication:`；结尾两节 `Implications for our four voice lines` + `What we could
   not verify`。
4. **四条线以形态描述**（不带内部 issue 号）：s2s 单体 / 平台耳嘴+自有脑 / Live 前端+
   深脑异步委派 / 多 Lead huddle+常驻脑。
5. **每问带必查对象**（§2 锚点英译），并注明 "not exhaustive — go beyond"。
6. **时效**：today = 2026-07；优先 2025-2026 来源；每个论断带链接，日期按
   dr-prompt 定稿口径（source 自带 published/updated 日期才用，否则标 undated +
   access date，禁止猜日期）；说清未验证项。
7. **澄清预案**（中文附录）：范围=行业形态综述非选型；受众=founder+产品+工程联席；
   粒度=能支撑 PRD 级取舍；不需要代码；英文源为主中文源可选。

## 4. deep-research skill 执行约束（从 SKILL.md 提炼，implement 照做）

- **硬前置**：headed Chrome（非 headless）+ 恰一个 connected browser + ChatGPT
  付费计划登录；pairing 交互式（全无人值守冷启动不可行 —— implement 阶段用已配对的
  持久 Chrome profile，`~/.flywheel/deep-research-chrome` 形态）。
- **独占**：Chrome 整机共享独占；跑前 ask Tadashi 确认无人占用（非阻塞 ask→check
  轮询，等待期间可做 M2 之外的准备工作）；一次一个 DR。
- **导出**：ChatGPT 原生 export（报告 viewer ↓ 菜单 Copy contents + Word 引用解析 →
  skill 的 assemble_report.py 合并）→ dr-report.md（原文 + resolved URLs）。
- **fail loud**：iframe 不渲染 / 剪贴板空 → 报错停，绝不产出半份报告。
- **坐标换算**：`computer` 点击是截图像素空间（`clickX = cssX × screenshotWidth /
  innerWidth`）—— skill 内置处理，不要绕开 skill 手驱。
- **时长预期**：FLY-883 实测 9 分钟（25 citations / 488 searches）；预算 5-30 分钟。

## 5. FLY-883 管线复用点

| 资产 | 复用方式 |
|------|----------|
| dr-prompt.md 模板 | 结构照抄，内容换 5 问 |
| 执行记录 checklist（research.md §9） | plan.md M1 的步骤蓝本：Chrome 确认 → 独占自检 → 跑 DR → 导出 → 回填 |
| assemble_report.py | skill 自带，直接用 |
| 澄清预案模式 | 同款附录 |
| 「承认盲区」纪律 | prompt 要求 + findings「未验证清单」节 |

## 6. findings.md 模板（implement 阶段产出，进 HL 底料包的正文）

```markdown
# FLY-1178 语音 Agent 生态 — findings（双栏 digest）
Issue / 日期 / 基于: dr-report.md（抬头三行照合同）

## 0. 一页摘要（≤15 行，联席讨论可只读这节）
## 1-5. 每研究问题一节
   每 finding 带编号（F1.1、F2.3…，= 附录 A 主键）：
   - **技术形态**：…（带 exact 引用链接）
   - **产品体验含义**：…（对用户/对我们四条线意味着什么）
   Q5b 的 finding 额外标 `→ FLY-1179 设计输入`（多 agent 同房间对话协调专单；
   FLY-1168 仅为其 consumer，不直接标）
## 6. 对四条线的启示映射（/eleven /gemini /gemini-advanced /glaw × 留/深挖/体验/技术，
     只给证据与 options，不替联席拍板）
## 7. 未验证清单（DR 承认 + 我们验证未过/降级的）
## 附录 A. claim 级证据台账（主键 = finding ID）：
     finding ID → exact 直达 URL(s) → 来源节/标题 → VERIFIED/UNVERIFIED → 备注。
     只有 VERIFIED 的论断才能无标注进正文；定位不到精确来源/打不开/内容不支持的
     一律降级进 §7。
## 附录 B. 全量 URL 健康表（独立附表：resolved URL × HTTP 终态分类
     OK/需人工开/DEAD —— 平面 URL 列表不等于 claim→source mapping，两表分开）
```

> **导出产物保全（Codex R1 #1）**：skill 的 assemble 只把 .docx relationships 里的
> URL 去重成平面 Sources 列表，inline citation → exact URL 的映射未实现 —— 所以
> **保留本轮 .docx 原件**（验证时可从 .docx 的 hyperlink relationships 手工恢复
> claim→URL 对应），别把平面列表当映射用。

## 7. 补跑判据：coverage matrix（D1 细化，Codex R1 #5 收紧）

主轮报告按问切分后，逐格打 coverage matrix（字数/引用数只是辅助信号，不是主判据）：

| 问 | 必须覆盖的格子 |
|----|----------------|
| Q1 | OpenAI ✚ Google 两家都有 ✚ live 会话内 delegation/异步工具的用户体验（不只其一） |
| Q2 | 三类机制（handoff 注入 / platform session / 外部记忆库）全出现 ✚ 2-3 个主流组合 stack 各有命名案例 |
| Q3 | 两轴（logical vs compute residency）被区分 ✚ 三桶对比出现 |
| Q4 | 3-5 个邻近案例 ✚ 逐案例 gap 分析（不是泛泛「未发现」）✚ crowded/adjacent/blank 三档结论 |
| Q5a | 「参与者形态」案例（≠note-taker）有正面回答（哪怕结论是「没找到」也要有扫描过程） |
| Q5b | raft.build 种子被引用且转述准确 ✚ ≥2 个种子之外的协调机制 |

**5a 与 5b 分开判**。任一格子缺失 → 记录缺口；多格同缺 → 把**最大证据缺口组合**进
**唯一一次**定向补跑（新 DR 会话，只带缺口问题 + context 摘要 + 已有发现清单
「不要重复这些」，重过 Chrome 独占确认 + 引用验证）；其余缺口如实列入未验证清单。
补跑后仍薄 → 写进「未验证清单」，不硬凑、不再跑。
