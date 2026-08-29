# FLY-1178 语音 Agent 生态 deep research — 探索

Issue: FLY-1178 (https://linear.app/geoforge3d/issue/FLY-1178/research-语音-agent-生态-deep-research-实时语音委派-agent-的行业形态记忆传递常驻取舍双视角技术形态)
日期: 2026-07-11
基于: 无

## 1. 问题定义

Annie 直令（2026-07-11，[FLY-1159] thread）：先做一轮 deep research，看别人家的语音 agent
生态怎么做，再决定我们四条语音线（/eleven /gemini /gemini-advanced /glaw）哪些留、哪些深挖、
要什么体验、技术上怎么实现。

- **交付形态**：真 cited deep research（ChatGPT Deep Research via claude-in-chrome，
  `deep-research` skill）→ 报告并入 **HL 底料包**（与四命令资料一起，Tadashi 汇编、
  hosted HTML 交付），供 **Annie + HL + Tadashi 联席讨论**用。
- **双视角硬要求**：每个发现出双栏 —— **技术形态**（别人怎么实现）/ **产品体验含义**
  （对用户意味着什么、对我们四条线意味着什么）。
- **引用红线**：引用要真实可点，不许编造。

本 issue 是 **research 类 issue，零实现代码**。三段式下：设计阶段（本文档所在）产出研究
设计 + DR prompt 定稿；实现阶段执行 DR、验证引用、写双栏 digest、开 PR。

## 2. 已有资产审计（别把已做过的再研究一遍）

### 2.1 FLY-883：直接前例 + 已覆盖地带

FLY-883（2026-07-05）用同一条 DR 管线跑过 realtime voice-to-voice **技术选型**（9 分钟、
25 citations、488 searches），沉淀了三样可直接复用的资产：

1. **执行管线**：dr-prompt.md（英文结构化 prompt + 澄清预案）→ deep-research skill →
   dr-report.md（原文 + 解析引用 URL）→ research.md 回填。本 issue 照抄这个形状。
2. **已覆盖地带（本轮明确不重复）**：三后端对比（OpenAI Realtime / Gemini Live /
   CosyVoice 本地栈：延迟、成本、音质、中英混说、工具调用、私有化）、v2v vs 管线 vs
   混合架构的取舍、Discord 收发音与 DAVE。这些结论直接当「我们已知」写进新 prompt 的
   context，让 DR 把搜索预算全花在 **agent 层生态**上。
3. **教训**：三家都没有公开 zh-en 混说 benchmark → DR 承认盲区比硬编强；prompt 要显式
   要求「说清什么没验证到」。

### 2.2 我们自己的四条线（DR findings 的映射目标）

| 线 | 形态 | 对应研究问题 |
|----|------|--------------|
| /glaw（FLY-545） | Gemini Live 耳 + 常驻 Claude 脑（FLY-1160）+ edge-tts 嘴；多 Lead huddle | Q5 会议参与度（Annie 点名的深挖方向）、Q3 常驻 |
| /gemini（FLY-967） | Gemini Live 原生耳+嘴+脑，纯托管 | Q1 的 speech-to-speech 单体形态 |
| /gemini-advanced（FLY-997/1018） | Gemini Live 前端 + 深脑异步委派（两层 delegate → 自有工具 loop） | Q1 委派/handoff 模式的自家对标 |
| /eleven（FLY-980/1006） | ElevenLabs Agents 平台（STT/TTS/turn-taking 托管）→ shim → Claude 脑 | Q4 平台生态对标 |

另两个自家锚点：**FLY-1160 常驻 Claude session 大脑**（一场会一个持久 session，Phase A
已 merge，= Q3「常驻」的自家对标）；**记忆体系**（mem0/Supabase pgvector 项目记忆 +
identity.md persona 注入 + Linear issue thread 落地，= Q2「记忆传递」的自家对标）。

### 2.3 FLY-906 voice PRD（已批 v0.17）

Huddle-only v1 + 耳机模式 v1.5；动作三档确认、延迟硬指标（首音 ≤800ms）、会后纪要落
issue。联席讨论正是要决定这张 PRD 蓝图下四条线怎么收敛 —— DR 底料按「能回答 PRD 级
取舍」的粒度写，不是学术综述。

### 2.4 deep-research skill 的硬约束（写进实施计划）

- Chrome 必须 **headed** + 已登录 ChatGPT 付费计划 + **恰一个** connected browser；
  pairing 是交互式的（不能全无人值守冷启动）。
- Chrome 是整机共享独占资源：跑前必须确认无人占用 claude-in-chrome；一次一个 DR。
- 导出走 ChatGPT 原生 export（Copy contents + Word 引用解析 → assemble_report.py），
  失败要 fail loud。

## 3. 研究问题（issue 的 5 问 → DR prompt 的骨架）

1. **实时语音 + 委派 agent 的组合**：OpenAI（Realtime API + Agents SDK voice agents
   指南：speech-to-speech vs chained、handoff/委派）、Google（Gemini Live + ADK
   bidi-streaming + agent 模式）各自的官方形态；其他值得知道的组合（如 Amazon Nova
   Sonic + Bedrock Agents、LiveKit 多 agent workflow）。
2. **记忆传递机制**（Annie 专门问的）：短命 task-agent 之间 memory 怎么接力 ——
   (a) handoff 时上下文注入；(b) 平台 thread/session 对象；(c) 共享外部记忆库
   （向量/状态 DB：mem0、Zep、Letta 一类）。各家实际用哪种、组合怎么搭。
3. **常驻 vs 短命 agent 的取舍**：谁在做常驻 session-agent（我们 FLY-1160 常驻 Claude
   的对标）、行业为何普遍选 per-task 短命、什么场景值得常驻。
4. **语音 agent 框架/平台生态**：LiveKit Agents、Pipecat、Vapi、Retell、ElevenLabs
   Conversational AI —— 各自架构形态、延迟预算、适用场景；**「语音指挥自家工程系统」
   这个我们的场景在市场上是不是空白**。
5. **对话参与度/多方会议 + 多 agent 同房间协调**（Annie 的 glaw 深挖方向；scope 加深
   来自 brainstorm gate，Annie 在 [FLY-1159] thread 的最新反馈）。两个子面：
   - 5a **人机会议参与度**：语音 agent 在多人会议里「像个在场的人」有谁做过、怎么做的
     （turn-taking、打断、旁听模式；会议 note-taker bot ≠ 参与者，重点找「参与者」形态）。
   - 5b **多 agent 同房间对话的协调/去重/发言权设计**：回合制快照式 agent（读快照 →
     思考 → 提交 → 等待）在连续流动的房间里造成重复回应/重复做事（我们真实多次发生，
     例：Cass + Tadashi 在 #core 撞车重复建 issue/派工）。业界怎么解：floor control /
     turn-taking 协议 / **Agent Inbox**（拉取式通知队列，agent 自主分配注意力）/
     **Held Draft**（发送前 freshness check，房间变了则扣住草稿退回，agent 四选：
     修改/照发/沉默/知情强发）。**种子文章（必进 DR 素材，已验证可点）**：
     Tenny (Raft CTO, 2026-05-21) *Is having agents in the room meant to be chaotic?*
     https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/
     —— Agent Inbox + Held Draft 两机制出处；设计原则 = perception empathy（决策时刻
     补上 agent 缺的感知）+ action explicitness（把人类内隐社交决策变成显式选项空间）；
     反对两个极端（纯规则压制如 @-mention-only vs 无序放开）。
   - 5b 的 findings 除四命令映射外，**须标注「→ FLY-1179 设计输入」**（Lead 更正
     441eeed8，Annie 裁定：FLY-1179 = 多 agent 同房间对话协调专单，含 raft.build
     prior art + 完整 scope，可直接引用；FLY-1168（DAG 任务编排 epic）只是 1179 的
     consumer，不直接回灌）。

每问双栏出口：技术形态 / 产品体验含义。

## 4. 关键设计决策

### D1. DR 跑几轮？ ⭐ 推荐：1 轮主跑 + 1 轮补跑预算

- **推荐（1+1）**：5 问合一个结构化 prompt 一次跑（FLY-883 实证一次 4 大问可行，
  9 分钟 25 引用）。预留至多 1 轮**定向补跑**，仅当触发补跑判据（见 plan）——某个
  研究问题回来内容 <~150 词或引用 <2 条、或 Q4「市场空白」问题只有泛泛而谈。
- 备选 A（按技术/产品双视角拆 2 轮）：不推荐 —— 双栏是同一发现的两面，拆开会让两轮
  重复搜同一批源，浪费 quota 与 Chrome 独占时间。
- 备选 B（按 5 问拆 5 轮）：明显过度，串行 Chrome 独占 5 轮不现实。

### D2. Prompt 语言与形状 ⭐ 推荐：英文，沿用 FLY-883 模板

语料主体是英文（OpenAI/Google 官方文档、LiveKit/Pipecat 文档、行业分析）。模板四件套：
Context（我们是谁 + 四条线一句话 + **已知地带声明**）→ 编号研究问题（每问列出必查对象
与证据类型）→ Source guidance（一手来源优先、每个论断带日期链接、说清未验证项）→
Output format（**每问一节，节内每 finding 双行：Technical form / Product-experience
implication**；结尾给「对四条线的启示」映射节 + 未验证清单）。澄清预案附后。

### D3. 双栏怎么保证落地 ⭐ 推荐：prompt 内要求 + findings.md 兜底

DR 的格式服从率不保证。所以：prompt 里把双栏写成硬性 output format；实现阶段无论 DR
是否照做，都产出 **findings.md**（中文双栏 digest，逐问映射到四条线，≤300 行）——
这才是进 HL 底料包的正文；dr-report.md 存原文 + 解析引用作证据底座。

### D4. 交付物与投递路径 ⭐ 推荐：Runner 只产 repo 内文档，素材经 ask 交 Tadashi

- repo 内：`engineering/doc/FLY-1178-voice-agent-ecosystem/{dr-prompt.md, dr-report.md,
  findings.md}` 随 PR 进 main。
- founder 面：**Runner 不自己 publish HTML、不直接投 founder**（founder 物料
  Lead-only delivery 铁律）。实现阶段完成后经 `flywheel-comm ask --report` 把
  findings.md 路径 + 要点交给 Tadashi，由他汇编进四命令底料包 hosted HTML。

### D5. 引用真实性验证 ⭐ 推荐：全量可点性检查 + 承重论断抽查

实现阶段对 dr-report.md 解析出的全部引用 URL 跑可点性检查（HTTP 状态非 4xx/5xx；
对 403/反爬站点标注「需人工开」而非判死）；再抽 ≥5 条**承重论断**（每问至少 1 条）
人工打开比对内容确实支持论断。验证结果写进 findings.md 附录；发现编造引用 = 该论断
降级为「未证实」并在 digest 里显式标注。

### D6. Chrome 独占纪律 ⭐ 推荐：FLY-883 同款预检

跑 DR 前：① `flywheel-comm ask` Tadashi 确认当前无人占用 claude-in-chrome（非阻塞，
ask→check 轮询）；② `list_connected_browsers` 自检恰 1 浏览器 + headed + ChatGPT
付费登录；③ 全程一次一个 DR，跑完释放。若 Chrome 被占用 → 排队等释放，不抢。

## 5. Scope 边界（不做什么）

- **零实现代码**：不碰 packages/、不动四条线任何行为。
- **不重复 FLY-883**：后端选型、延迟/成本对比、Discord 传输层不再研究。
- **不替联席讨论下结论**：findings.md 给证据与启示（options），不替 Annie/HL/Tadashi
  拍「哪条线砍/留」。
- **不自己发 founder 物料**：汇编与投递归 Tadashi。
- 与语音测试（③a/③b）无依赖，可并行；但 Chrome 独占要排队协调。

## 6. 风险与开放问题

| 风险 | 缓解 |
|------|------|
| DR 对 Q4「市场空白」证伪难（证明「没有人做」比「有人做」难） | prompt 显式要求「找最接近的 3-5 个案例并说明差距」，把否定命题转成邻近案例扫描 |
| 5 问一轮跑导致每问深度稀释 | D1 的补跑判据兜底；prompt 里给每问的必查对象清单，压住跑偏 |
| Chrome 被语音 QA / 其他 DR 占用 | D6 排队纪律；实现阶段把「等 Chrome」写成显式步骤而非隐式假设 |
| ChatGPT 账号 quota / Free 计划坑（FLY-883 撞过） | 预检确认付费计划；quota 不足 → ask Tadashi 协调，不硬试 |
| DR 输出不按双栏格式 | D3：findings.md 兜底重排，双栏由我们保证而非 DR 保证 |

## 7. Brainstorm gate 结论（2026-07-11，Tadashi）

**APPROVED**，一处 scope 加深已按原话落进 §3 Q5（5b 多 agent 同房间协调 + raft.build
种子 + 回灌标注；回灌目标后经 Lead 更正 441eeed8 定为 FLY-1179）。其余全项确认：
DR 管线 ✓、FLY-883 已覆盖地带不重复 ✓、
双栏 digest ✓、findings 经 Tadashi 汇编（Runner 不自投 founder）✓、Chrome 独占
ask-before-run ✓、1 主跑 + 至多 1 定向补跑 ✓。Lead 明示 Q5 扩充落进 dr-prompt 后
**不必重开 gate**。
