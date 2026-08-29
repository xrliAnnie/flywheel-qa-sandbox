# FLY-1004 homerail 竞品分析 + 开源代码借鉴 — 调研

Issue: FLY-1004 (https://linear.app/geoforge3d/issue/FLY-1004/homerail-竞品分析-开源代码借鉴-语音多-agent-编排-ex-jarvis)
日期: 2026-07-08
基于: exploration.md(同文件夹)

> firsthand 扒了 `xiaotianfotos/homerail`(clone 到本地读源码,非只看 README)。本文 = 全部 findings;交付物 = eng-idea-for-tadashi.md + FLY-909 fold(表 A 一行 + homerail-deepdive.md)。文件路径引用均为 repo 内路径。

---

## 0. 出处 & 方法

- repo:`github.com/xiaotianfotos/homerail`(TypeScript,~191★,clone 时 3h 前还在 push)。
- 读的源文件(firsthand,18 个):`README.md` `ROADMAP.md` / `homerail_protocol/src/{manager-agent-prompt,manager-agent-tools}.ts` / `homerail_worker/src/agent/{factory,types,codex-appserver}.ts` / `homerail_worker/src/dag-tools/{handoff,receive-message}.ts` / `homerail_worker/src/audit/index.ts` / `homerail_worker/Dockerfile` / `homerail_manager/src/orchestration/dag-engine.ts` / `homerail_manager/src/server/{voice,scorecard}.ts` / `homerail_manager/src/widgets/widget-file-protocol.ts` / `homerail_manager/src/persistence/provider-catalog.ts` / `skills/README.md` 等。
- 溯源:issue 给的 XHS 笔记 `6a4de258`(《我的贾维斯开源了…》,作者 小天fotos)→ GitHub 搜 homerail → 唯一强匹配 = xiaotianfotos/homerail。

---

## 1. homerail 是什么

### 1.1 一句话 & 定位
"Voice-first local agent orchestration runtime for auditable DAG workflows." —— **跑在你自己家硬件上、语音进 / 生成式 UI 出、把一次性 agent 对话变成可审计可复用 DAG 工作流的编排 runtime。**

- **Home**:目标是常驻在你家的 NAS / home-datacenter(ROADMAP long-term)。
- **Rail**:执行形态 = DAG,"agent work flows node to node along explicit edges"。
- 核心哲学(ROADMAP 原话):**"Attention is the scarcest resource"** —— 人这侧收窄(voice in / generated UI out),机器那侧铺开(more agents / nodes / environments)。**跟我们北极星 FLY-212『离屏也顺畅工作』同一句话。**

### 1.2 ⭐ 它明确"不做什么"(战略发现 1,ROADMAP 白纸黑字)
homerail **专门不做软件工程 / 开发自动化**。ROADMAP `## Non-goals` + `## What HomeRail is for` 原话(直译):
> "一个 AI agent 能产出很多东西——视频、报告、配置、软件。这些**不是一样好判断**。生成的视频好评估——你看一眼就知道。一段软件不是——'做完了'很含糊、质量有争议、提需求的人往往判断不了它到底满不满足需求。HomeRail 就是围绕这个不对称建的:它瞄的是**结果本身就好判断**的任务(视频/报告/生成素材/配好的系统/设计产物)……**所以 HomeRail 不是为软件工程或开发自动化设计的**……软件是最难被人判断好坏的东西,所以正好是这个『让 AI 结果好判断』系统的**错误目标**。"

→ 它把"软件"主动划出去了。**这对我们是好消息**(详见 §9.1)。

### 1.3 它能干啥 / 现状(诚实)
- **DAG runtime**(最成熟):多-agent 编排、显式 handoff、per-run workspace 隔离、replay、scorecard、eval-run。
- **`hr` CLI**:`start / config / doctor / run / smoke / dag supervise / scorecard / eval-run / replay`。
- **Voice surface**:ASR / TTS / VAD 契约,默认中文,桌面 voice shell。
- **Generative UI**(探索中,README 明说 "in exploration",widget 契约会一直变)。
- **Docker Worker**:每个 DAG node 一个 Docker 容器,per-run 共享 workspace。
- 限制(README 自认):Windows 脚本兼容不全;Linux worker→manager 网络要额外配;**除 Codex 外的 harness(claude-sdk / kimi-code)执行时"沉默"**(不吐 reasoning → 无法喂 commentary 语音,见 §3.2);generated UI 还在变。

### 1.4 RoadMap(读自 ROADMAP.md,非视频)
- **Short**:桌面 shell 三平台(mac/win/linux)稳、签名安装包;**Manager Agent 可信到能托付真任务**;UI 国际化(现在默认中文,要一等公民英文)。
- **Mid**:用**真实场景**驱动 generated UI + DAG 资产迭代(不做抽象平台工作)。
- **Long**:常驻 NAS / home-datacenter,活过重启升级;**多终端**(手机/平板/TV/车,voice-primary);**多-node 多机**,Manager 跨机调度 DAG node。

---

## 2. 架构(6 个包 + skills)

```
homerail_protocol   共享消息 / 校验契约 + Manager Agent prompt/tools(单一真相)
homerail_manager    Manager 服务:DAG 协调 + voice surface + generated-UI 契约 owner
homerail_node       起 Docker Worker 容器(per DAG node);provider 目录
homerail_worker     Worker runtime:harness adapter(claude-sdk/codex/kimi)+ DAG tools + audit
homerail_cli        `hr` CLI
agent-ui            解耦的浏览器 UI(Vue)
skills/             SKILL.md 目录(homerail-cli / dag-ops / install-ops / shared)
```

- 设计口号:**"Smart brain, efficient workers"** —— 贵模型 plan/review,便宜模型干体力活;每个 node 独立 context window,避免"一个大 thread 撑爆 context"。
- 跟我们对照:**Manager ≈ 我们的 Lead;Worker(容器) ≈ 我们的 Runner;protocol 包 ≈ 我们 flywheel-comm 的契约层。** 形态高度同构,但**执行基元不同**:homerail = 静态 DAG(YAML 模板);我们 = Linear issue → 三段式 → tmux runner。

---

## 3. 语音层(⭐ 撞 voice-agent 最狠,直接喂我们 voice PRD)

### 3.1 两条 TTS 通道:`commentary` + `final`(核实 · `voice.ts:61-62`)
```
DEFAULT_TTS_OUTPUT_CHANNELS = ["commentary", "final"]
```
- **`final`** = 给用户的最终答案(短)。
- **`commentary`** = 模型**边干边说的旁白 / 推理流**("嗯,我看一下")。
- 可配 `tts_output_channels`(只留 final 也行)。
→ **这正是我们 voice PRD §12/§15 的"在听/在想/在说"+ filler「让我看一下」的工程实现**:把模型的 thinking 流单独走一条 TTS 通道,跟最终答案分开。

### 3.2 commentary 怎么"自动合成"(核实 · 为什么只有 Codex 行)
`AgentEvent`(`worker/agent/types.ts:29-38`)把模型输出分成 `text`(答案)/ `thinking`(推理)/ `tool_use` / `tool_result` / `usage` 等事件。
Codex adapter(`codex-appserver.ts:427-434`)把 Codex 原生的 `item/reasoning/textDelta` + `item/reasoning/summaryTextDelta` → `{type:"thinking"}`,把 `item/agentMessage/delta` → `{type:"text"}`。
→ **thinking 流喂 commentary 语音,text 流喂 final 语音。** README 说"Codex 是唯一自动合成 commentary 的 harness",根因就在这:**Codex app-server 会 stream reasoning delta,而 claude-sdk / kimi-code 默认不吐 reasoning** → 无 commentary 可合成(README `provider capability gap`)。

### 3.3 ASR:3 种实时策略 + 多供应商(核实 · `voice.ts:51,927-964,1029-1112`)
`AsrRealtimeStrategy = "native_realtime" | "emulated_batch" | "ark_voice"`:
- **`native_realtime`**:WS 代理到上游 `/v1/realtime`(OpenAI realtime 风格,浏览器麦 → 追加 `input_audio_buffer.append` → `commit`)。
- **`emulated_batch`**:小米 MiMo 路径——WS 收 PCM16 chunk,`finish` 时批量转写(伪实时)。
- **`ark_voice`**:字节 Ark / 火山 openspeech。
- 供应商(`voice.ts` + `provider-catalog.ts`):**小米 MiMo**(`mimo-v2.5-asr/tts`,api.xiaomimimo.com)、**字节火山 openspeech / Ark / Doubao voice**、**OpenAI-兼容**(`/v1/audio/transcriptions` `/v1/audio/speech`)、**qwen3-tts**。全部走"能力位"(`supports_asr/supports_tts/supports_llm`)配置,PCM16↔WAV 自己拼头。
- 一个 WS server 在 `/api/voice/asr/realtime` 桥接 浏览器麦 ↔ provider。

### 3.4 Generated-UI 契约:让朗读文本保持短(核实 · `manager-agent-tools.ts` + `widget-file-protocol.ts`)
voice 模式下 Manager Agent 的 system prompt(`manager-agent-prompt.ts:61-70`)硬性要求:**最终朗读文本 = 短口语中文、通常 1-2 句、<80 汉字、无 markdown、无原始 reasoning/日志**;需要列表/证据/长状态时**调 widget 工具**、朗读只留一句指针。
widget 工具(`manager-agent-tools.ts:32-48`):
- **`update_voice_memo`** —— 一张**跨多轮补槽**的备忘卡:`status(listening|clarifying|ready|executing|done)` + `known_facts` + `open_questions` + `todos` + `next_action` + `ready_to_execute`。描述原文:"**把它当成当前完整备忘,不是 append-only log**"——多轮收集意图直到可执行。
- **`update_task_draft`** —— 把需求整理成**执行前要确认**的任务草稿:`title/request/acceptance/constraints/status(draft|clarifying|needs_confirmation|submitted)`。
- **`show_status_card / show_list_card / show_progress_card / show_note_card / show_artifact_card / show_dynamic_widget`** —— 动态 widget:`type` 可为 `html / metric_strip / timeline / dag_flow / chart / topic_outline / slide_deck`。widget 存成 per-session TOML 文件、稳定 `widget_id`(更新不重复建卡)。
→ **等于我们 voice PRD §12 的 TIV(Text-in-Voice)"结论卡/action卡/状态行",但被抽象成一套"模型自己调工具生成 UI"的契约。** `task_draft` 的 `needs_confirmation` = 我们 §14 的写前口头 recap + 三档确认。

---

## 4. 多-Agent 编排(DAG mailbox 引擎)

### 4.1 引擎(核实 · `dag-engine.ts`)
- node 状态机:`PENDING / READY / RUNNING / COMPLETED / FAILED / CANCELLED / SKIPPED`。
- **mailbox 模型**:每 node 每 port 一个信箱;`handoff(fromNode, port, content)` 按 **port + condition** 匹配下游边、把 content 塞进下游信箱。
- 边 condition:`on_success / on_failure / always`;失败 port(`failed/failure/rejected/error`)有专门路由;terminal failure 会 `_skipDependentNodes`(但有 `_hasAlternativePath` 兜底不误杀)。
- `after_dep` 边(纯排序依赖)与显式数据边分开;支持 **loop**(`loop_sources` + `loop_gateway` node,可回环)。
→ 这是一个**认真的静态 DAG 调度器**,不是简单串行。

### 4.2 Worker 侧的编排工具(核实 · `dag-tools/`)
Worker(容器里的 agent)拿到 4 个 DAG 工具:
- **`handoff(port, content, summary)`**(`handoff.ts`)——把成果交给下游。**每轮只能调一次,调完本轮立即结束**;port 必须在系统提示列出的可用 port 里(否则报错)。node 不 handoff 就结束 = 报错 "agent ended without DAG handoff"(`prompt-runner.ts:364`)。
- **`send_message(target_node, content)` / `receive_message(timeout=300s)`**(`send/receive-message.ts`)—— node↔node **直接消息**(阻塞等待 inbox,Manager 做 broker + waiters)。支持并发 node 协调 / loop,不止静态边。
- **`get_graph_context`** —— worker 可查自己所在 DAG 图。
→ 对照我们:homerail 的 handoff = 我们 Runner 结束时的 completion route;send/receive = 我们 Lead↔Runner 邮箱 + Agent Team 消息。**同一需求、不同实现。**

### 4.3 Scorecard(自带质量闸 · 核实 · `scorecard.ts`)
每个 run 跑完自动打分:`ScoreCheck[]`(name/passed/severity/gate/source_type/detail)+ `ScorecardResult`(verdict / gate_verdict / score / hard_error_count / soft_warning_count / **blind_spot_count** / intervention_total)+ `ToolActivity`(每 node 的 tool_call 数 / tool 名 / 有内容响应数)。config 驱动(quality gate / handoff blockers / source issue)。
→ **DAG 产出被一套可配质量闸自动评分** = 把 QA 焊进 runtime。对照我们 auto-QA(FLY-579)是独立 spawn 一个 QA Runner;homerail 是 runtime 内置 scorecard。两条路各有取舍。

### 4.4 Audit / replay(可审计 = 招牌 · 核实 · `worker/audit/`)
per-run audit writers:**transcript(JSONL)+ tool-event writer + checksum(SHA,`checksumTranscript`+`verifyTranscriptChecksum`+ sidecar)+ error-log**。`checkAuditCompleteness(runId)` 校验 transcript 存在 + checksum 有效 + sidecar 在。
→ "auditable DAG workflows" 招牌落地 = **每 run 一条带 checksum、防篡改的 append-only transcript**,可 replay。对照我们 `founder_consent_audit` 等审计表——同思路,homerail 把它做成 per-run 文件 + checksum。

---

## 5. Harness adapter 层(⭐ 战略发现 2:vendor-neutral,跟我们独立撞车)

### 5.1 注册表(核实 · `worker/agent/factory.ts`)
```
PRODUCTION_REGISTRY = { "claude-sdk", codex_appserver, kimi_code }   // + deterministic(离线测试)
createAgentClient(backend?) // 读 AGENT_BACKEND env 选后端
registerAgentBackend(name, factory) // 运行时注册自定义后端
```
- 抽象接口 `AgentClient`(`types.ts:41-54`):`run(prompt, tools, context) → AsyncIterable<AgentEvent>` + 可选 `resume(sessionId)`。干净、统一。
- ROADMAP Non-goal 原话:**"HomeRail does not build agent harnesses …… 它在现成 harness(Claude Agent SDK / Codex app server / Kimi Code)之上编排,不重造。effort 花在编排和交互层。"**
→ **这跟我们的 executor-backend 抽象(FLY-493 antigravity / FLY-494 kimi / FLY-350 codex-as-lead)是独立撞车的同一思路。** 我们叫 `ExecutorBackend` + `EXECUTOR_BACKENDS`,它叫 `AgentClient` + registry。**两个团队独立收敛到"编排层 vendor-neutral、不自造 harness"= 强信号:这个方向是对的。**

### 5.2 具体 adapter(核实)
- **Codex app-server**(`codex-appserver.ts`):spawn `codex app-server` 子进程,**stdio JSON-RPC 2.0**;`thread/start`(`baseInstructions`=systemPrompt / `approvalPolicy:"never"` / `sandbox:"danger-full-access"` / `ephemeral:true` / DAG 工具作 `dynamicTools` 注入)→ `turn/start` 循环 → drain notification。**每 run 独立 CODEX_HOME + HOME(临时目录)** 隔离;debug 事件里 **secret 脱敏**(SECRET_KEYS + bearer/sk- 正则)。`resume()` 故意不实现 transcript replay,改"**DAG checkpoint resume**——把 resume 指令注进下一个 worker prompt"。
- **Kimi Code**(`kimi-code.ts`):包 MoonshotAI `kimi` CLI,用 **`kimi acp`**(Agent Client Protocol)JSON-RPC over stdio,或 `@moonshot-ai/kimi-agent-sdk`。
- **文本标记协议**(`manager-agent-tools.ts:458-502`,给不支持原生 tool-call 的 harness 兜底):`<homerail_tool_call>{name,input}</homerail_tool_call>` + `<homerail_handoff>{port,content,summary}</homerail_handoff>` —— worker 在文本里吐标记来发起工具调用/DAG handoff,Manager 解析。**vendor-neutral 的优雅兜底。**

---

## 6. Memory / 经验图谱(⚠️ 修正:它有,只是路线不同)

> **修正上一版的错**:上一版说"homerail 没有跨-run 记忆"——**错**。读持久化层后发现它有 experience 知识图谱。详见 homerail-code-report.md §1.6。

- **有** 一套 **experience 知识图谱**(`server/experience.ts` + 表 `experience_nodes`/`experience_relationships`/`experience_ingest_jobs` + `memories`):从每个 run 的 evidence + scorecard 抽 **17 种节点类型**(含 FailureRootCause / Lesson / RunSignal)+ 类型化关系,ingest 进图谱(接进 run 流,非纯脚手架)。
- **但没有** 向量库 / embedding / 语义检索(没见 embedding 列)—— 它是**结构化"从过去 run 学教训"**的图谱,不是语义向量记忆。
- 短期 context 管理仍靠:node 隔离 + handoff evidence 前传 + per-run workspace + per-session voice_memo。
→ **两条不同路线 · ⚠️ 已按事实校正(grep 了我们 codebase)**:它 = 结构化 lesson/failure 图谱;我们 = **语义向量记忆(mem0 + Supabase/pgvector)代码在但基本没接**(`edge-worker/src/memory/createMemoryService.ts` 要 GOOGLE_API_KEY+SUPABASE_URL+SUPABASE_KEY 才启用,没配就 "Disabling memory"),**主力记忆是文件 markdown**(per-project .md)。**所以别说"我们语义检索更强"** —— 诚实讲:两边都不是活的语义检索;它是自动从 run 抽 lesson 的结构化图谱,我们是人工维护的 markdown,**它这块可能反而更成熟**(自动抽结构化 lesson 回喂 = 我们可学的)。成熟度双方均 UNKNOWN。

## 7. Skills 分发(核实 · `skills/README.md`)
- skill = `SKILL.md` 目录,**symlink** 进 `$CODEX_HOME/skills` 和 `$HOME/.claude/skills`(链接式装,repo pull 即更新)。skills:`homerail-cli / dag-ops / install-ops / shared`。
→ **跟我们 flywheel-skills(FLY-216/510)完全同思路**(SKILL.md + symlink 分发)。又一次独立撞车。

## 8. Docker Worker 隔离(核实 · `homerail_worker/Dockerfile`)
`node:22-slim` + bash/git/curl,**`kimi` CLI 烤进镜像**(`RUN command -v kimi`),非 root `node` 用户跑,`WORKDIR /workspace`,一 DAG node 一容器、workspace 挂载。
→ 比我们的 tmux runner 隔离更硬(容器级)。是他们"跑在自己家硬件、要能托付"的必要条件。

---

## 9. ⭐ 两个战略结论(单独标给 Annie · Lead 要求写透)

### 9.1 好消息①:homerail 主动放弃软件 → 我们"建并养真软件产品"是块没人占的空地
homerail ROADMAP 白纸黑字**不做软件工程**(§1.2),理由是"软件最难判断好坏"。这恰好**反向坐实** FLY-909/911 我们那条差异候选『**替非技术的人建并养一个真软件产品**』:
- 连一个认真做语音多-agent 编排、跟我们同构的开源项目,都**主动把软件划出去**。
- 说明"软件难评估"是真痛点,但**难 ≠ 不该做** —— 我们恰恰把工程纪律(PR/CI/review/QA)当成"东西真能用"的底气(FLY-909 §③)。**别人怕的地方正是我们的护城河候选。**
- ⚠️ 诚实:homerail 的理由(软件难判断)也是对我们的**警告**——非技术 founder 判断不了软件质量,所以我们"结果证明:一试真能跑、下周还能跑"(FLY-909 候选锚点)更关键。这条喂 FLY-911。

### 9.2 好消息②:vendor-neutral 编排是对的方向(独立撞车)
homerail 和我们**独立**收敛到同一架构决定:**编排层 vendor-neutral、不自造 harness、在现成 harness 上编排**(§5)。这不是巧合,是这类系统的正确形态。→ 我们 FLY-493/494/350 的 executor-backend 路线**得到外部独立验证**。

### 9.3 voice 层直接喂我们 voice PRD(§3 详)
- 两条 TTS 通道(commentary/final)= 我们"在想/在说"+ filler 的工程实现。
- 生成式 UI 卡片让朗读短 = 我们 TIV 卡片 + 口头 recap 的抽象版。
- task_draft `needs_confirmation` + voice_memo 多轮补槽 = 我们 §14 写前确认 + 收集意图。
→ **不是"我们抄它",是"它印证我们 voice PRD 方向对、且给了可直接借鉴的实现机制"。** 具体见 eng-idea-for-tadashi.md 的 voice 专节。

---

## 10. homerail vs Flywheel 速览(诚实对照)

| 维度 | homerail | Flywheel | 谁强 / 备注 |
|---|---|---|---|
| 目标产出 | 好判断的结果(视频/报告/素材/配置)**明确不做软件** | **建并养真软件产品** | 不同赛道,我们那块它主动让出(§9.1) |
| 编排基元 | 静态 DAG(YAML 模板)+ mailbox | Linear issue → 三段式 → runner | 各有取舍;DAG 更可预测,issue 更贴真实协作 |
| 语音 | **成熟**:双 TTS 通道 + 3 ASR 策略 + 生成式 UI | voice PRD 定稿、实现待建(FLY-542 树,STT 收音是风险) | **homerail 语音领先我们** → 可借鉴 |
| harness | vendor-neutral AgentClient(claude/codex/kimi) | vendor-neutral executor-backend(claude/codex/antigravity/kimi) | 平,独立撞车 |
| 隔离 | Docker 容器 per node | tmux runner + worktree | homerail 更硬(容器) |
| memory | 结构化 experience/lesson 图谱(无语义向量,自动从 run 抽) | mem0+pgvector 代码在但**没接**、主力=**文件 markdown**(人工维护) | ⚠️校正:别说"我们语义检索更强";两边都非活的语义检索,它自动抽 lesson 这块可能更成熟 |
| QA | runtime 内置 scorecard | 独立 auto-QA Runner(FLY-579) | 各有取舍 |
| 审计 | per-run checksum transcript | 审计表(founder_consent 等) | 平,思路同 |
| 界面 | 桌面 shell + 浏览器 UI + 未来手机/车 | Discord(手机原生 IM) | 不同赌注 |
| 交互对象 | operator 单人跑自己家 NAS | 非技术 founder 指挥常驻 AI 组织 | 定位不同 |
| 定位主张 | attention 最稀缺 / 跑你自己硬件 | done-for-you / 被协调的常驻组织 / 手机 IM | 见 FLY-909/911 |

---

## Sources
- repo:`github.com/xiaotianfotos/homerail`(README / ROADMAP.md / 上列 18 个源文件,firsthand)。
- XHS 笔记 `6a4de258`(《我的贾维斯开源了,语音交互,多Agent编排》,作者 小天fotos `5b208f0511be100f9c278b53`)+ 评论区(模型栈自述)。
- 内部关联:FLY-909 competitor-scan、FLY-906 voice PRD、FLY-493/494/350 executor-backend、FLY-579 auto-QA、GEO-145 memory、FLY-216/510 skills。
