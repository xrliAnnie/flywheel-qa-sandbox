# FLY-1004 给 Tadashi 的 eng-idea 清单 — 从 homerail 开源代码里能用/能借鉴的

Issue: FLY-1004 (https://linear.app/geoforge3d/issue/FLY-1004/homerail-竞品分析-开源代码借鉴-语音多-agent-编排-ex-jarvis)
日期: 2026-07-08
基于: research.md(同文件夹,含全部 firsthand 出处)

> **这份清单是主交付物。** Annie 会据此开 eng issue。每条格式:**它怎么做(带 repo 文件出处)→ 我们能怎么用 → 值不值(✅值 / 🟡待评估 / ❌不值 + 理由)**。
> repo = `xiaotianfotos/homerail`;文件路径都是 repo 内路径,已 firsthand 读过。
> **诚实**:我只提炼机制,没把它代码原样搬;真要用还得 Tadashi 落到我们架构里。查不到的标 UNKNOWN。

---

## A. 🎙 语音层(Lead 要求单独标 —— 这几条最直接印证 + 喂我们 voice PRD)

### A1. 双 TTS 通道:`commentary`(边干边说)+ `final`(答案) ✅值
- **它怎么做**:`voice.ts:61-62` 定义 `DEFAULT_TTS_OUTPUT_CHANNELS = ["commentary","final"]`;`AgentEvent`(`worker/agent/types.ts:29-38`)把模型输出分成 `thinking`(推理)/ `text`(答案)两类事件;thinking → commentary 通道朗读,text → final 通道朗读。可配 `tts_output_channels`。
- **我们能怎么用**:直接落我们 voice PRD §12/§15 的"**在想/在说**"+ filler「让我看一下」。把 Lead 的 thinking/进度旁白走一条低优先 TTS 通道,最终答复走另一条——**用户听得到"它在动",不是干等**(§15 静默不 >3s 的兜底)。
- **值不值**:✅ **值**。这是我们 voice PRD 已经要的东西的现成分通道设计,拿来即用。

### A2. commentary 只有 Codex app-server 能"自动"合成 → 别的后端要显式喂 🟡待评估(重要认知)
- **它怎么做**:`codex-appserver.ts:427-434` 把 Codex 原生 `item/reasoning/textDelta` 映射成 thinking 事件;README 明说 claude-sdk / kimi-code 执行时"沉默"(不 stream reasoning)= "provider capability gap"。
- **我们能怎么用**:**认知价值大于代码价值** —— 提醒我们:voice "边干边说"的旁白,**不能假设所有后端都吐 reasoning**。要么(a) 只在支持 reasoning stream 的后端开 commentary,(b) 让 Lead 用一个显式工具主动发"进度旁白"(不依赖模型 reasoning),(c) 用短 filler 兜底。**我们 voice PRD 的 filler 应设计成不依赖 reasoning stream。**
- **值不值**:🟡 **待评估**(是设计约束,不是要抄的代码)。但**必须在 voice 实现前想清楚**,否则换后端 commentary 就哑了。→ 建议进 voice EPIC 的风险清单。

### A3. Generated-UI 契约:模型调工具生成卡片,朗读只留一句指针 ✅值
- **它怎么做**:voice 模式 system prompt(`manager-agent-prompt.ts:61-70`)硬性要求"**最终朗读 <80 汉字、无 markdown、无原始 reasoning**;长内容调 widget 工具、朗读留指针"。widget 工具(`manager-agent-tools.ts`)有 `show_status_card / show_list_card / show_progress_card / show_note_card / show_artifact_card / show_dynamic_widget`(type=html/metric_strip/timeline/dag_flow/chart/topic_outline/slide_deck),存成 per-session TOML、稳定 widget_id(更新不重复建卡)。
- **我们能怎么用**:等于我们 voice PRD §12 的 **TIV(Text-in-Voice)结论卡/action卡/状态行**,但抽象成"模型自己调工具吐 UI"。我们 Discord 侧可以照这个思路:**长内容不朗读,发进 thread 当卡片,语音只说一句"我把清单发你 thread 了"**。稳定 id 更新不重复 = 直接抄的好习惯(避免刷屏)。
- **值不值**:✅ **值**。我们 voice PRD 已要 TIV;这套"短朗读 + 工具生成卡片 + 稳定 id"是可直接借鉴的落地范式。

### A4. `task_draft`(执行前确认)+ `voice_memo`(多轮补槽收集意图) ✅值
- **它怎么做**:`manager-agent-tools.ts` —— `update_task_draft`(title/request/acceptance/constraints/`status:draft|clarifying|needs_confirmation|submitted`);`update_voice_memo`(`status:listening|clarifying|ready|executing|done` + known_facts + open_questions + todos + next_action + ready_to_execute,"**当成当前完整备忘、非 append-only**")。
- **我们能怎么用**:直接对上我们 voice PRD **§14 写前口头 recap + 三档确认** 和"多轮收集意图再开干"。`needs_confirmation` 状态 = 我们不可逆动作的 readback gate;voice_memo 的补槽结构 = Huddle 里"边聊边把需求整理成可确认草稿"。
- **值不值**:✅ **值**。是我们 §14 的现成状态机模型,拿结构、不拿代码。

### A5. 3 种 ASR 实时策略 + 多中文供应商 🟡待评估
- **它怎么做**:`voice.ts` —— `native_realtime`(WS 代理到上游 `/v1/realtime`)/ `emulated_batch`(收 PCM16、finish 时批量转)/ `ark_voice`(字节)。供应商:小米 MiMo、字节火山 openspeech/Ark/Doubao、OpenAI-兼容、qwen3-tts。一个 WS server 桥接浏览器麦↔provider,PCM16↔WAV 自拼头。
- **我们能怎么用**:我们 voice PRD 最大风险是 **STT 收音**(FLY-544,Discord DAVE 下 bot 收音坏)。homerail 是**桌面 shell 直接拿麦**、绕开 Discord —— 跟我们不同链路,**不能直接搬**。但 `emulated_batch`(不追求真流式、收完批量转)这个**降级策略**对我们有借鉴:如果实时 STT 在 Discord 侧起不来,可以先做"按住说完→批量转写"的 MVP。
- **值不值**:🟡 **待评估**。供应商清单(尤其中文 ASR/TTS:MiMo/火山/qwen)是有用的选型参考;但收音链路我们是 Discord、它是桌面,架构不同,主要借**降级策略思路**,不搬代码。

---

## B. 🧩 编排 / 架构

### B1. vendor-neutral harness 注册表(AgentClient + registerAgentBackend) ✅值(但我们已有)
- **它怎么做**:`worker/agent/factory.ts` —— `AGENT_BACKEND` env 选后端,`PRODUCTION_REGISTRY = {claude-sdk, codex_appserver, kimi_code}`,`registerAgentBackend(name, factory)` 运行时注册;抽象接口 `AgentClient.run(prompt,tools,ctx)→AsyncIterable<AgentEvent>` + 可选 `resume()`。
- **我们能怎么用**:**主要是验证,不是照抄** —— 我们 FLY-493/494/350 的 executor-backend 就是这个(`ExecutorBackend` + `EXECUTOR_BACKENDS`)。**外部独立撞车 = 我们方向对**。可对照的一个小点:它的 `AgentEvent` 把 `thinking / text / tool_use / tool_result / usage / done` 分得很干净、`AgentUsage` 累加 token —— 如果我们的 backend 事件模型没这么规整,可参考它的事件枚举。
- **值不值**:✅ **值**(作为验证 + 事件模型参考)。核心机制我们已有,别重造。

### B2. 文本标记 handoff/tool-call 协议(给"沉默"后端兜底) 🟡待评估
- **它怎么做**:`manager-agent-tools.ts:458-502` —— `<homerail_tool_call>{name,input}</...>` + `<homerail_handoff>{port,content,summary}</...>`。不支持原生 tool-call 的 harness,worker 在**文本输出里吐标记**,Manager 正则解析出工具调用 / DAG handoff。
- **我们能怎么用**:我们接**能力弱/无原生 tool-call 的后端**(某些国产模型)时,这套"文本标记当带外通道"是现成兜底。对我们 no-transport runner(FLY-493/494 的 pr_handoff)也可能有用:worker 用文本标记声明"我要 handoff / 我完成了"。
- **值不值**:🟡 **待评估**。我们现在主力后端都有原生 tool-call,暂用不上;**接弱后端时再捡**。记进"备选实现"。

### B3. Worker node↔node 直接消息(send/receive_message,阻塞 + timeout) 🟡待评估
- **它怎么做**:`dag-tools/{send,receive}-message.ts` —— worker 可 `send_message(target_node, content)`、`receive_message(timeout=300s)`(阻塞等 inbox,Manager broker + waiters)。不止静态 DAG 边,支持并发 node 协调 / loop。
- **我们能怎么用**:我们已有 Lead↔Runner 邮箱 + Agent Team 消息(功能覆盖)。它的 `receive_message` **带 timeout 的阻塞等待 + waiter 注册**模式,如果我们要做 Runner↔Runner 直接协调(现在是 Lead 中转),可参考这个 broker+waiter 结构。
- **值不值**:🟡 **待评估**。当前我们 Lead 中转够用;真要 Runner 互相直连再看。

### B4. Scorecard:runtime 内置质量闸 🟡待评估(我们有另一条路)
- **它怎么做**:`scorecard.ts` —— run 跑完自动打分:`ScoreCheck[]` + `ScorecardResult`(verdict/score/hard_error/soft_warning/**blind_spot**/intervention 计数)+ `ToolActivity`(每 node tool_call/tool 名/有内容响应数)。config 驱动 quality gate / handoff blockers。
- **我们能怎么用**:我们 auto-QA(FLY-579)是**独立 spawn QA Runner**;homerail 是 **runtime 内置轻量 scorecard**。两条路取舍:内置 scorecard 便宜、每 run 都跑、适合"结构性检查"(有没有真调工具、有没有 handoff、response 有没有内容);独立 QA Runner 重、能验产品可用性。**可借鉴:给我们的 run 加一层便宜的"结构性 scorecard"**(比如 Runner 是不是真产出了 PR、是不是真调了工具、有没有 blind_spot),当 auto-QA 之前的第一道廉价闸。
- **值不值**:🟡 **待评估**。概念好(廉价结构闸 vs 重 QA 分层),但我们已有 auto-QA;要不要再加一层内置 scorecard,看 Tadashi 判断值不值这工。

### B5. 每 node 独立 context window + workspace 隔离("Smart brain, efficient workers") ✅值(理念印证)
- **它怎么做**:README/ROADMAP —— 贵模型 plan/review、便宜模型干体力;每 DAG node 独立 context window(避免一个大 thread 撑爆),per-run workspace 隔离(`${HOMERAIL_HOME}/workspace/<run_id>/`)。
- **我们能怎么用**:**印证我们的 per-agent model override(FLY-241 Fable/Opus 混搭)+ Runner worktree 隔离**方向对。它的"贵脑子便宜手"= 我们 Lead 用强模型、Runner 可用便宜模型。对照可想:我们要不要在"一个大 issue 拆多 Runner"时更激进地按 node 分 context。
- **值不值**:✅ **值**(理念印证 + 印证 FLY-241)。机制我们大体有。

### B6. 结构化"从 run 抽教训"经验图谱(FailureRootCause / Lesson / RunSignal) 🟡待评估
- **它怎么做**:`server/experience.ts` + 表 `experience_nodes`/`experience_relationships` —— run 终态时从 evidence + scorecard 抽 `ExperienceDelta`(17 种节点类型,含 FailureRootCause / Lesson / RunSignal + 类型化关系),ingest 进图谱。**结构化、非语义向量**(无 embedding)。
- **我们能怎么用**:⚠️ **事实校正**(grep 了 codebase):我们 mem0+pgvector **代码在但基本没接**(env-gated,没配就 Disabling memory),**主力记忆是文件 markdown**。所以不是"我们语义向量更强"—— homerail 这条"自动从 run 抽 FailureRootCause/Lesson 进结构化图谱"是**我们目前没有的能力**,可考虑给 Runner run 收尾加一步"抽结构化 lesson"喂回 memory。
- **值不值**:🟡 **待评估**。概念好、跟我们语义记忆互补;⚠️ 但我们语义记忆(mem0+pgvector)其实基本没接、主力是文件 markdown,所以这条『自动抽 lesson』对我们价值可能不小,要不要加看 Tadashi 判断。**注意**:homerail 这套成熟度 UNKNOWN(作者可能也还没真复用)。

---

## C. 🔒 隔离 / 可信 / 分发

### C1. Docker 容器 per DAG-node(比 tmux 更硬的隔离) 🟡待评估
- **它怎么做**:`homerail_worker/Dockerfile` —— `node:22-slim`,非 root `node` 用户,一 node 一容器,workspace 挂载,`kimi` CLI 烤进镜像。Node 服务负责起容器。
- **我们能怎么用**:我们 Runner 是 tmux + worktree(host 上跑)。容器级隔离更硬(尤其"跑在用户自己机器 / 未来多机")。**跟我们 FLY-8xx 多机部署方向可能相关**(task #8「多机部署」)。但容器化是大工程,且我们现在 host+tmux 够用。
- **值不值**:🟡 **待评估**。**跟多机部署 PRD(task #8)一起考虑**才有意义;单独为隔离上容器不值。

### C2. per-run checksum transcript(可审计) 🟡待评估
- **它怎么做**:`worker/audit/` —— per-run JSONL transcript + **SHA checksum + sidecar** + `checkAuditCompleteness()` 校验完整性 + tool-event writer + error-log。
- **我们能怎么用**:我们已有审计表(founder_consent 等)。它的"**每 run 一条带 checksum、防篡改、可校验完整性的 transcript**"对我们的"可信"叙事(FLY-909 §③ append-only 审计轨迹)有用——尤其如果我们要给 Annie/founder 看"这个 Runner 到底干了啥"的可信记录。
- **值不值**:🟡 **待评估**。思路好(防篡改 + 完整性校验),但我们审计已有基础;要不要加 checksum 完整性校验看优先级。

### C3. codex-appserver adapter 的安全细节:临时 CODEX_HOME + secret 脱敏 ✅值(小而好)
- **它怎么做**:`codex-appserver.ts:549-585` —— 每 run 起独立临时 `CODEX_HOME` + `HOME`(mkdtemp),跑完清理;debug 事件里对 `SECRET_KEYS`(apiKey/OPENAI_API_KEY/Authorization…)+ bearer/`sk-` 正则**脱敏**再 log。`resume()` 故意不做 transcript replay,改"把 resume 指令注进下一个 worker prompt"(DAG checkpoint resume)。
- **我们能怎么用**:我们跑 codex-as-lead / codex runner(FLY-350/245)时,**每实例独立 CODEX_HOME + 日志脱敏**是直接能抄的安全卫生。我们已经有类似(FLY-245 managed CODEX_HOME),可对照查漏。"resume 靠注 prompt 不靠 transcript replay"也是个务实选择,对照我们的 resume 机制。
- **值不值**:✅ **值**(小改动、安全卫生)。对照我们 codex 路径查漏补缺。

### C4. SKILL.md symlink 分发 ✅值(我们已有,验证)
- **它怎么做**:`skills/README.md` —— skill = SKILL.md 目录,**symlink** 进 `$CODEX_HOME/skills` 和 `$HOME/.claude/skills`,repo pull 即更新。
- **我们能怎么用**:**跟我们 flywheel-skills(FLY-216/510)完全同思路**。纯验证,不用改。
- **值不值**:✅ **值**(作为方向验证)。已有,别重造。

---

## D. ❌ 明确不用抄的(诚实划界)

- **静态 DAG(YAML 模板)编排基元**:homerail 是"提前画好 DAG 图、node 沿边流"。我们是"Linear issue → 三段式 → runner",更贴真实协作、更动态。**别为了像它去改成静态 DAG** —— 那是它"做好判断的结果任务"的形态,不适合我们"建并养软件"的动态活。
- **memory**:⚠️ **两处校正** —— ① homerail **有**结构化 experience/lesson 图谱(不是"没记忆");② 我们 mem0+pgvector **代码在但基本没接**(env-gated、主力是文件 markdown),**别说"我们语义检索更强"**。诚实:两边都非活的语义检索;它自动从 run 抽 lesson 这条我们没有 → 见 B6(可借鉴)。
- **桌面 shell / 浏览器 UI 界面**:它赌桌面+未来多终端,我们赌手机原生 IM(Discord)。**界面别学它。**
- **它的收音链路**:桌面直接拿麦,跟我们 Discord bot 收音(FLY-544 风险)不同架构,**不能搬**(只借"批量转写降级"思路,见 A5)。
- **"不做软件"这个定位**:它主动放弃软件,我们主动做软件(这正是我们的空地,§9.1)。**方向相反,别学。**

---

## E. 优先级建议(给 Annie 开 issue 参考,非硬排期)

| 优先 | eng-idea | 为什么 |
|---|---|---|
| **P1(直接喂 voice 树)** | A1 双 TTS 通道 · A3 生成式 UI 短朗读 · A4 task_draft/voice_memo · A2 commentary 后端约束(风险) | voice PRD(FLY-906)已定稿,这几条是现成落地范式 + 必须早想清的约束 |
| **P2(安全/卫生,小改)** | C3 codex 临时 HOME + 脱敏(对照查漏) | 小、安全相关、我们 codex 路径正在用 |
| **P3(待判断值不值)** | B4 廉价结构 scorecard · C2 checksum transcript · B2 文本标记兜底 | 概念好但我们有替代;Tadashi 判断值不值这工 |
| **P4(和别的 PRD 一起看)** | C1 容器隔离(配多机部署 task#8) · B3 Runner 直连(配 Lead 效率 task#9) | 单独不值,组合才有意义 |
| **验证类(不用做)** | B1 vendor-neutral · B5 贵脑便宜手 · C4 skills symlink | 我们已有,homerail 独立撞车 = 方向对 |

> **一句话给 Annie**:homerail 最值得我们借的是**语音层**(双通道 TTS + 生成式 UI 短朗读 + 执行前确认草稿,A1/A3/A4 直接喂 voice 树);编排/harness 层它跟我们独立撞车(验证方向对,不用抄);它主动放弃软件 = 我们"建并养真软件"是块空地(好消息)。诚实:它记忆走结构化 lesson 图谱(自动抽、可能反而更成熟;我们 pgvector 基本没接、主力 markdown)、界面/DAG 基元不适合我们。
