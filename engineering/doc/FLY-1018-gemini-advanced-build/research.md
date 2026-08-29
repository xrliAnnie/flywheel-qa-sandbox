# FLY-1018 /gemini-advanced 正式建造 — 调研

Issue: FLY-1018 (https://linear.app/geoforge3d/issue/FLY-1018/voicebbuild-gemini-advanced-正式建造-cc-设计思想-spike-资产产品化m1-m4)
日期: 2026-07-08
基于: exploration.md

> **TL;DR**:三路调研支撑 plan:① CC 设计思想概念级提炼(五维 + 10 条可落地原则,license 红线内 ideas-not-expression);② FLY-997 spike 代码解剖(骨架三段闸可直接 TS 化继承 + 13 条产品化 gap);③ 本仓接线面事实审计(voice-core seam / Bridge 鉴权 / M2 入口挂点 / reserved endpoints)。结论:CC 主循环剥掉 compact 全家桶与 REPL 特有路径后,本质复杂度正好落在我们几百行目标区间;spike 骨架 + mock 生产合同是高复用资产;产品化实质工作在「工程外壳」(TS/auth/超时重试/审计落盘/config/测试/resume)。

## 1. Claude Code 设计思想提炼(概念层)

**来源与纪律**:研读 `~/Dev/claude-code`(UNLICENSED 泄露源码)。本节只记录**思想/模式**(ideas, not expression):零代码引用、零逐文件转写地图;实现阶段 clean-room(不打开该仓)。gemini-cli 按 founder 裁定不作任何参考。

### 1.1 单主循环

**CC 做法**:两层结构——外层会话壳(每会话一个实例,持消息数组、usage 累计、abort controller,跨 turn 存活);内层循环是 `while(true)`:每轮 = 上下文整备 → 调模型 → 收集 tool-use → 执行工具 → 结果追加进消息 → continue。**唯一自然退出信号 = 本轮输出里没有 tool-use**(CC 明确不信任 stop_reason,自己数 block)。跨轮状态收进一个**显式 State 对象**,每个 continue 点整体替换并记录 transition 原因(next_turn / compact_retry / recovery…);终止返回**结构化 Terminal reason**(completed / aborted / max_turns / model_error…)。中断 = 贯穿全程的 AbortController;abort 后不直接抛,而是**给每个悬空 tool-use 合成一条 is_error 的 tool-result 再优雅返回**(维持 API 消息配对不变量)。上限防护:maxTurns、预算、结构化输出重试上限,全部循环内检查、以带 error 标记的结果退出。

**适配**:照学骨架——while(true) + 显式 State + 结构化 Terminal reason。「无 function call 即退出」+ maxSteps 硬上限双终止条件(spike 已有)。AbortController + 合成 functionResponse 的中断姿势照学(Gemini functionCall/functionResponse 同样要求配对)。transition reason 简化为 log 一行。

### 1.2 工具抽象

**CC 做法**:Tool 接口核心五组概念:(a) 身份(name/description);(b) schema——**校验发生在 dispatch 层,不在工具内**(「模型意外地经常生成非法输入」);(c) 行为声明(isReadOnly / isConcurrencySafe / isDestructive,用于并发分批与权限分级),工厂给 **fail-closed 默认值**(不声明就当最保守);(d) 执行;(e) 结果映射(专门一步把工具原生输出规范化成 tool-result)。dispatch 管线固定顺序:schema 校验 → 工具自校验 → 权限检查 → 执行 → 结果映射,**每步失败都产出 is_error 结果回喂模型,绝不 throw 穿透主循环**;「点名不存在的工具」同样回 error result。并发按 isConcurrencySafe 分批(安全的并发、不安全的串行)。

**适配**:接口砍到四成员:name、schema、readonly 标记、execute。校验层必须保留(spike 的 validateArgs 已是此形态)。并发分批不需要(6 个 HTTP 工具串行足够);「readonly 批并发、写操作串行」分类法留作未来参考。

### 1.3 上下文管理

**CC 做法**:消息历史只追加。压缩是多层防御(microcompact / autocompact / reactive compact + **circuit breaker**——连续 3 次压缩失败放弃,否则曾单 session 3000+ 次徒劳调用)。工具结果两级预算:单结果超阈值 → 存盘 + 回喂 preview+路径;消息级还有聚合预算。系统提示**三段拼装**(身份规则 / system 尾部追加 context / 首条 user 消息前置 context),合起来是 prompt cache 的 key 前缀,**turn 内绝不变动**(cache 稳定性 = 一等不变量)。

**适配**:大幅简化——我们是任务级短生命周期对话,**不做 compact 全家桶**。只要两样:(1) 工具结果头部截断 + 「已截断」标记(单结果 cap ~10-20k chars);(2) 粗 token 估算 + 接近窗口时 **fail-fast 终止**(带明确 reason)而非压缩。系统提示三段式概念照学:固定 system(角色+护栏话术)与每任务注入 context(persona/identity.md + 项目记忆)分开,对 Gemini implicit caching 也有收益。**北极星的 persona+context 注入落在这一层**。

### 1.4 架构分层

**CC 做法**:四层——UI ⟂ 会话壳(状态持有者,REPL 与 headless 共用)⟂ 循环核心(**不持状态**,状态全在参数/State 进出)⟂ 服务层(API 客户端/retry、工具执行)。层间用 async generator 的 yield 流做协议;依赖注入点少而关键(callModel 等可整体替换,是主循环可测性的根)。

**适配**:压成三层:`GeminiClient`(纯传输:调 API + retry)/ `AgentLoop`(纯函数式循环,状态显式进出)/ `ToolRegistry`(6 工具 + dispatch 管线)。**「循环核心不持状态、callModel 可注入」强烈保留**——主循环可用脚本化响应序列纯单测,不打真 API(CC 测试策略里最值得学的一条)。yield 流不要(无流式 UI),循环返回终局结果 + 过程回调(onEvent)即可。

### 1.5 审计先行

**CC 做法**:三条独立管道:① Transcript 逐消息落盘,**用户输入在首次 API 调用之前先写盘**(进程随时被杀也可 resume);② 成本/用量从流事件累计、按模型分桶,终局 result 携带全套统计(duration/turns/cost/usage/denials);③ 遥测:每个工具调用记 decision、duration、**归一化错误分类**(telemetry-safe 字符串而非裸 message,防泄漏)。错误路径同样留痕(每次 retry 一条可见系统消息)。

**适配**:照学三件:(1) 先写后调——JSONL transcript,追加式,用户输入落盘先于首次 API 调用;(2) 终局 result 带全套统计(turns/工具调用数/token/耗时/终止 reason);(3) 工具执行每次一行(name/args 摘要/ok-error/duration)。按模型分桶可略(单模型档)。

### 1.6 错误路径

**CC 做法**:核心不变量「**错误即消息,不是异常**」——API 错误变成打了标记的合成消息,循环据此决策;throw 只留给 bug。分界:可恢复(429/529 → 指数退避,retry-after header 优先;prompt-too-long → compact 重试;过载 → fallback model,切换时补合成 tool-result 防孤儿)vs 致命(4xx 校验/auth → 直接 Terminal 退出)。工具失败**永远回喂模型**让其纠偏,不终止循环;只有 API 层错误可能终止。防死循环:一切自动恢复带上限 + circuit breaker,上限打穿后**如实暴露原始错误**(不吞)。

**适配**:三条铁律:(1) 工具错误回喂不终止;fatal/recoverable 在 API 层分界(429/5xx/网络 → 退避重试有限次;4xx/auth → fatal 终止留痕);(2) 遵守 retry-after;(3) 自动恢复带上限,打穿后暴露原始错误。fallback model、max-output-tokens 恢复 v1 不做。**spike 的错误分类靠 message 正则(误配风险),产品化改用 SDK error code/status 字段**。

### 1.7 CC 有而我们明确不要的

Hooks(外部策略插桩——6 个固定工具,策略写死 dispatch 层)/ Subagents(不递归)/ Permission 三态规则引擎(权限在 Bridge 侧,agent 内 readonly 标记足够)/ Streaming UI(headless 等完整响应)/ ToolSearch(6 工具全量常驻)/ prompt-cache 字节级洁癖(只守「system turn 内不变」一条)。

### 1.8 十条可落地设计原则(plan 的设计骨架)

1. 一个 while(true) 就是全部控制流;「无 tool call」是唯一自然退出。
2. 跨轮状态收进显式 State;终止返回结构化 Terminal reason。
3. 错误即消息,不是异常;throw 只代表 bug。
4. 每个 functionCall 必有 functionResponse——配对不变量高于一切(abort/未知工具/校验失败都要合成 error response)。
5. 校验在 dispatch 层,fail-closed 默认。
6. 用户输入先落盘再调 API;transcript 追加式写。
7. 工具结果有预算:超限截断 + 明示「已截断」。
8. 一切自动恢复带上限 + circuit breaker;打穿后暴露原始错误。
9. 循环核心纯函数 + callModel 可注入;主循环用脚本化响应序列单测。
10. 终局自带审计:result 携带 turns/usage/duration/终止原因/工具统计。

**规模判断**:CC 主循环 ~1700 行中 ≥60% 是 compact 全家桶、feature flag、遥测与 REPL 特有恢复路径;剥掉后「循环骨架 + 工具 dispatch + 截断 + retry + transcript」的本质复杂度落在几百行区间——与 spike 实测(~301 行跑出 100/100)互相印证。

## 2. FLY-997 spike 代码解剖(产品化基线)

**来源**:`flywheel-FLY-997` 分支逐文件核读(调研时 PR #513 尚未 merge;brainstorm gate 期间已 merge 进 main `36e99fcb`,下文分支路径引用在 main 上同样有效)。

### 2.1 骨架里的高复用资产

- **双 adapter 统一接口**:`start(userMessage)` / `continueWith(functionResults)` → `{functionCalls, text, usage}`;Interactions 主选(`steps[]` + `previous_interaction_id` + `function_result{call_id}`,`store:true` 服务端持历史)、generateContent fallback(本地 contents[] + 显式关 AFC)。
- **dispatch 三段闸**(每个 call):① 审计先落(dispatch 前写 `{ts,model,surface,tool,args,decision}`);② 注册表白名单——不存在的工具名 → `hallucinated` 标记 + 错误文本(含可用工具列表)作 isError 结果注回,绝不执行;③ 本地 schema 校验失败 → 同样注回。过闸才执行,HTTP ≥400 标 isError。**这与 CC 的 dispatch 管线思想(§1.2)天然同构,TS 化直接继承。**
- **主循环终止**:无 functionCalls 取终答退出;maxSteps(默认 12)熔断;同轮多 call 串行执行后一次性 continueWith。
- **模型层错误处理雏形**:429/RESOURCE_EXHAUSTED 识别为 QuotaError;5xx 单次重试(固定 2500ms)。
- **tools.mjs**:6 工具 = `{declaration(JSON-schema 子集), handler}`;`registryFor(names)` 子集选择;save_memory 有模型面→生产面的 adapter 层(content string → messages[])。
- **mock-bridge.mjs 的生产合同对齐**(头注逐条标生产源:`runs-route.ts:139+` / `plugin.ts:1976+` / `tools.ts:294` / `memory-route.ts:30,129`;错误体逐字对齐,含 409 dedup 原文、INVALID_AGENT_NAME、memory 双桶 400)——**可直接改造成正式包的合同测试 fixture**。

### 2.2 spike-only 捷径(产品化必改)

| # | 捷径 | 产品化 |
|---|------|--------|
| 1 | 全 .mjs 零类型 | TypeScript + pnpm workspace + biome/CI |
| 2 | `callMock()` 零 auth、URL hardcode | 真 Bridge 客户端:base URL 配置 + Bearer apiToken + endpoint 白名单 |
| 3 | 工具 handler 无超时无重试(fetch 裸调) | AbortController 超时 + 网络层有限重试 |
| 4 | 审计=注入回调,默认空;只记 dispatch 不记结果/耗时 | 结构化 JSONL 落盘(含结果/耗时),先写后调(§1.5) |
| 5 | config 是 hardcode 常量表 | FLYWHEEL_* env 解析器模式(model/maxSteps/budget/bridge) |
| 6 | `lastId` 内存态,崩溃丢链 | 本地持久化 interaction id(Interactions store:true 天然支持 resume) |
| 7 | 零 vitest | 单测(校验/白名单闸/adapter parse)+ 合同测试(mock-bridge 改造)+ E2E |
| 8 | create_issue 的 description 必填是 spike-strict 收紧 | 回正生产合同(title-only 必填) |
| 9 | request_ship_approval 只是 mock 记录 | 真接 approve_to_ship gate 机制 |
| 10 | 预算/quota 闸在 harness 层 | 进 loop(maxSteps 之外加 token 预算熔断) |
| 11 | 错误分类靠 message 正则 | SDK error code/status 字段 |
| 12 | validateArgs 拒绝 unknown parameter(比生产 route 严) | **保留**(更强防幻觉;schema 与工具面同包内演进,锁死无害) |

### 2.3 spike 已定稿决策(继承清单)

见 exploration.md §3(D1-D6)。补充两点:① SDK 硬前提 ≥2.0.0(1.x wire schema 已被服务端拒收;voice-core 的 ^1.16.0 不受影响,包内独立 pin 已验证);② Interactions 标 experimental → pin 精确版本 + build 当日复核(FLY-883 教训)。

## 3. 本仓接线面事实审计

(代码引用基于 origin/main;FLY-997 文档基于 `flywheel-FLY-997` 分支 = PR #513,设计日未合入 main。)

### 3.1 voice-core extraTools / BrainAdapter seam(M3 挂点)

- `LiveToolSpec`(`packages/voice-core/src/types.ts:107-112`):`{declaration, handler(args,{signal}) => Promise<string>}`——声明与 handler 强制同行(防「只声明不回注 = Live turn 卡死」)。`ConversationOptions.extraTools?: LiveToolSpec[]`(types.ts:113-129),缺省 `[]` 字节兼容。
- 注册:`GeminiLiveBackend.ts:104-120` connect 时一次性声明 `[ask_lead, ...extraTools]`;分发:`:238-259`,extraTools 走 `handleExtraTool`(:334-367):await handler → `sendToolResponse(callId, output, "when_idle")`。**结果 = function response(WHEN_IDLE),不是新 turn**;另有 `ConversationSession.injectToolResult`(types.ts:185)与 profile 级 `asyncFunctionCalling`(GeminiLiveBackend.ts:112)。**voice-core 今天没有 sendText**。
- 取消合同:tool-call-cancellation → abort(:261-266);cancelled turn 丢弃迟到 tool-call(:242)。delegate handler 必须尊重 signal。
- **`/meet` 编排层(voice-bridge PR-2 HuddleSession)尚未 land**:`voice-bridge/src/cli.ts:6-7` 明说 PR-2 才有 orchestration loop;main 上只有 PR-1 skeleton(BotRegistry + Note-taker 进 VC;`SessionSlot.ts:4-16` meet/live 争同一 slot)。**M3 只能对着 extraTools seam + SessionSlot 合同设计,真接线依赖 voice-bridge PR-2 时序。**

### 3.2 FLY-996 PRD 载体

repo 里**没有** FLY-996 PRD 文档(engineering/doc 与 product/doc 全目录核过;Linear issue documents/comments 均空)。PRD 内容两个载体:① Linear FLY-996 issue 本体(guardrail 底线:语音能「准备+派活」,merge/ship 永远走 founder 结构化批准);② FLY-997 spike 文档(PR #513 分支):三北极星(深脑/自带上下文/结果落地)、N2 项目记忆注入 20/20 实测、汇报语言贴 gate 状态开箱即得、长任务「先应答后播报」S3 实测成立、MVP 6 工具全实测背书。identity.md 模式的最接近先例 = FLY-543 HeadlessClaudeBrain(claude -p + identity.md persona;design-review 警告 identity.md ≠ 完整 Lead 运行时)。

### 3.3 Bridge HTTP 工具面与鉴权(M1/M4)

- **鉴权**:`tokenAuthMiddleware`(plugin.ts:635-645)= Bearer + timingSafeEqual(:621-624);token ← `config.apiToken` ← env `TEAMLEAD_API_TOKEN`(config.ts:57,107)。**token 未配置时 no-op 放行(:637),/api/runs 无 token 时裸挂(:2561)**——M4 一切安全假设的前提 = 部署配置了 TEAMLEAD_API_TOKEN。
- 五条工具 route 均现成(create-issue plugin.ts:2007-2009 / runs-route.ts:4 / sessions status tools.ts:306 / memory-route.ts:30,129;memory 路由仅 memoryService 初始化时挂载,双桶 user_id/agent_id 约束)。
- **approve_to_ship 的「发起」今天没有 HTTP 面**:走 flywheel-comm CLI + CommDB(gate.ts 非阻塞 insert → complete 绑定 → Bridge gate-poller relay)。红线「agent 不持 raw comm.db 写权限」⇒ **M1 需要 Bridge 新增 ship-approval-request 白名单 route**(FLY-997 findings §2 已预留此方向),由 Bridge 进程代写 CommDB,agent 只 REQUEST。批准写入侧已有 HTTP 先例(POST /api/founder-consent/runner-gate-response,plugin.ts:1470-1483,fail-closed)。
- **Reserved endpoints**:`founder-consent/reserved-endpoints.ts:29-36,46-104`(/api/actions/* 与 /actions/* 双挂载 + close-tmux/close-runner)。**S-b 挂点**:plugin.ts:1414-1417 全局 /api Bearer 中间件(单一共享 token → token→endpoint 可达集映射);/api/actions 挂载处已有 fcMw("action_router") 中间件先例(plugin.ts:1442-1445)可仿。

### 3.4 Discord 文字入口现状(M2 挂点)

现有三条消息路由机制:① Claude Lead 经 claude-code-discord plugin fork 自然语言直进 Lead session(无 slash 层);② Codex Lead 走 RestPoll + mention-gate(FLY-267);③ **真 slash command 先例只在计划里**(FLY-545 plan 的 voice-bridge MeetCommand,属未 land 的 PR-2;main 上 voice-bridge bot 只带 Guilds+GuildVoiceStates intents,无 interaction handler)。

M2 候选挂点:
- **A. voice-bridge daemon 加 handler**:slash 注册/bot 常驻现成(PR-2 后),但把 B 赛道耦进语音 daemon 生命周期,与 FLY-996「独立 track」相悖,且文字面不需要 VC。
- **B. packages/gemini-agent 自带瘦 Discord 入口(推荐)**:自己的 bot(FLY-882 bot 池领 slot),仿 voice-bridge BotRegistry/discordWiring 模式注册 guild slash command,直调同一 agent loop——最贴 findings「文本 command 直调同一 loop」+ 独立进程 + 不依赖 PR-2 时序。
- **C. Lead prompt 路由**(Lead 转译后调 CLI):零新 bot,但脑变成 Claude 转译、绑 Lead pane 可用性,不符「Gemini 当脑」。**排除。**

### 3.5 对 M1-M4 的硬约束清单

1. extraTools 结果 = function response(WHEN_IDLE),非新 turn;「先 ACK 后播报」需 delegate handler 先回 ACK 字符串、完成注回另走机制(injectToolResult / asyncFunctionCalling / 编排层)。
2. M3 真接线依赖 voice-bridge PR-2(尚不存在)——M3 交付物要切成「seam 侧就绪 + 编排侧合同」两半。
3. 文本面不能复用 Live 模型(TEXT-only 模态被拒)——文字入口独立进程 + 文本档模型(硬约束非偏好)。
4. M4 前提:部署已配置 TEAMLEAD_API_TOKEN(否则中间件放行、runs 裸挂)。
5. S-b 在 plugin.ts:1414 全局中间件层做 token→endpoint 可达集映射;fcMw 先例可仿;字节兼容(不配 scoped token 行为不变)。
6. ship 面 = 新增 request 型白名单 route(Bridge 代写 CommDB);agent 零 comm.db 访问;verify-approval 权威链零改动。
7. 工具 HTTP 客户端零 reserved endpoint(grep/CI 可断言)。
8. M2 不等 PR-2、不走 Lead 转译:gemini-agent 自带瘦 bot(FLY-882 池)。
9. FLY-996 PRD 正文不在 repo——设计文档引用按 Linear issue + PR #513 分支引。

## 4. 对 plan 的输入汇总

| 设计项 | 结论 | 来源 |
|--------|------|------|
| 模块分层 | GeminiClient(传输+retry)/ AgentLoop(纯函数循环,callModel 可注入)/ ToolRegistry(6 工具+dispatch 三段闸)/ ContextAssembler(三段式 system)/ Audit(JSONL 先写后调)| §1.4 + §2.1 |
| 循环骨架 | while(true) + 显式 State + Terminal reason + 双终止(无 call / maxSteps)+ token 预算熔断 | §1.1 + §1.8 |
| 错误路径 | 错误即消息;工具错回喂不终止;API 层 fatal/recoverable 分界;retry 有限次+retry-after;错误分类用 SDK code 字段 | §1.6 + §2.2 |
| 上下文 | 不做 compact;单结果截断 cap + 接近窗口 fail-fast;system 三段式(核心角色护栏 / persona identity.md / 项目记忆注入)| §1.3 |
| 审计 | JSONL transcript(输入先落盘)+ 工具行级记录 + 终局全套统计 | §1.5 + §2.2 |
| M2 入口 | gemini-agent 自带瘦 Discord bot(FLY-882 池),slash /gemini-advanced,deferred reply + follow-up | §3.4 |
| M3 形态 | delegate LiveToolSpec 导出 + ACK 即回 + 完成注回合同;真 /meet 接线随 voice-bridge PR-2 | §3.1 |
| M4 形态 | Bridge 全局中间件 token→endpoint 可达集映射;scoped token 只达 6 工具 route;默认不配=行为不变 | §3.3 |
| 新 Bridge 面 | POST ship-approval-request(request 型,Bridge 代写 gate)| §3.3 |
| 上线开关 | feature-flag default-off;M4 落地 + QA 过才真启用 | 项目字节兼容惯例 |
