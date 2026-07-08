# FLY-997 tool-capable Gemini Agent 骨架 — 探索

Issue: FLY-997 (https://linear.app/geoforge3d/issue/FLY-997/voiceb-research-tool-capable-gemini-agent-骨架-feasibility-spike-track-b)
日期: 2026-07-08
基于: 无

## 1. 背景 — 两条独立赛道

Annie 2026-07-08 定:voice-agent 分两条独立赛道。

- **A · /glaw + /gemini**(代码里叫 `/meet` + `/live`)= 语音开会 + 一层薄派活,agent 轻。已在做:FLY-545 PR-1(voice-bridge 常驻底盘)与 FLY-546 PR-1(headphone)已 merge,FLY-967(`/live` 组装)在途。
- **B(本 issue 的上游 FLY-996)· /gemini-advanced** = 一个**真·tool-using Gemini Agent**——Gemini 当脑 + 自建一层真工具,能 take action(开会里说「帮我 ship 这个 PR」它真去准备)。独立 track、独立 PRD,不塞进 A。

FLY-997 = B 赛道的 **eng feasibility spike**,喂 FLY-996 的 PRD。**本 issue 只做 research spike,不 build 产品**。要答的三个问题:

| # | 问题 | 一句话 |
|---|------|--------|
| ③ | 放哪 | Flywheel 里还是外?给数据定死 |
| ④ | 骨架 + 怎么接 Lead/Runner | 借哪个 agent 骨架给 Gemini 装工具;**Gemini 在 agent loop 里 tool-call 的可靠性**(直接决定 PRD scope 现不现实) |
| ⑤ | guardrail 架构 | 语音能「准备 + 派活」,但 merge/ship 永远走 founder 结构化批准——架构上怎么强制 |

## 2. 现状审计(brainstorm 前的 codebase 事实底座)

### 2.1 Track A 已经有什么(能吃的现成资产)

- **voice-core**(`packages/voice-core/`):可插拔语音后端库。Gemini Live 后端(默认模型 `gemini-3.1-flash-live-preview`,`config.ts:37`)已实现「嘴耳 + 外部脑」混合架构:Live 模型只管听说/VAD/打断,实质推理经 **`ask_lead` 工具**回 in-repo 的 `HeadlessClaudeBrain`(shell 出 `claude` CLI)。
- **给 track B 留好的口**:`ConversationOptions.extraTools`(`LiveToolSpec` = declaration + handler,`GeminiLiveBackend.ts:104-121`)——orchestrator 可注册任意 Gemini 可调用的工具,结果默认 `when_idle` 注回。目前 in-repo 只接了 `ask_lead`,**没有任何 action 工具**。
- **voice-bridge**(`packages/voice-bridge/`):FLY-545 PR-1 的常驻 Discord 语音底盘(DAVE E2EE ears bot),`index.ts:5-8` 明确写着底盘有三个消费者:545/546/967。
- **语音内 tool-call 已真机验证**(FLY-968 bakeoff V9):说完→function-call 约 710ms;FLY-959 教训:**工具声明必须带完整 schema**,零 schema 声明会让模型编造答案或 stall。
- **唯一状态改变动作已守卫**:headphone 的 ship-approval 走 Bridge `voice-routes.ts:275-460` 守卫梯(kill-switch→binding 校验→founder-id 校验→精确确认词)→ `writeGateResponseAndRunPostWrite`,写进现有 founder-gate 机制。语音从不绕过 gate——track B 必须保持这条不变量。
- **`/gemini-advanced` 零代码**:grep 全仓只有 issue 描述自身。Track B 纯 greenfield。

### 2.2 「prepare + dispatch」工具面已经存在(不用发明)

Bridge HTTP(`packages/teamlead/src/bridge/plugin.ts`,Bearer `TEAMLEAD_API_TOKEN`):

| 能力 | endpoint | 备注 |
|------|----------|------|
| 派活(起 Runner) | `POST /api/runs/start` | `runs-route.ts:139+`,参数 issueId/projectName/agentName/docTier/model,Lead 今天就这么用 |
| 建 issue | `POST /api/linear/create-issue` | 代理模式,agent 不持 `LINEAR_API_KEY` |
| 记忆读写 | `POST /api/memory/search|add` | `memory-route.ts`,双桶契约 + ID 校验 |
| 状态查询 | `GET /api/*`(status/chat-threads 等) | 只读 |

### 2.3 Guardrail 已有的结构性先例(FLY-245 gateway)

写能力 Codex Lead 的 gateway(`packages/teamlead/src/lead-backends/codex/gateway/`)就是「给一个非 Claude 脑一个窄工具面、ship 类动作结构性卡在 founder-gate 后」的现成模板:

- 权威字段(execId/prHead/action/nonce)**runtime 派生,绝不信模型 tool args**;
- 模型只能 **REQUEST**(`request_runner_lifecycle`),founder Discord 确认后才由 runtime 执行;
- **根本不存在 merge 工具**——merge 红线是结构性的,不靠提示词;
- secrets 走 unix-socket broker,只在受信进程内存。

ship 权威链(`verify-approval`):review_question 绑定 + founder 归因(FLY-945)+ pr_head_sha 绑定 + Codex hard gate(FLY-827),全部独立于 `DECISION_MODE`(默认 off)。**关键审计发现**:comm.db/teamlead.db 不是进程级完整性边界——同机进程有写权限就能伪造批准(`verify-approval.ts:37-42` 自己注明)。所以外来 agent 进程**必须走受控接口(Bridge HTTP),不能给 raw CLI/DB 访问**——这正是 FLY-245 沙箱 + broker 的立论。

## 3. 选项空间与推荐

### 3.1 ③ 放哪 — 三个选项

| 选项 | 说明 | 判 |
|------|------|-----|
| **B1. monorepo 新包 `packages/gemini-agent`** ⭐推荐 | 独立 package 贴着 Flywheel | 它要吃的一切都在仓内:Bridge HTTP 工具面、voice-core seam、memory 路由、config;pnpm workspace 直接引 voice-core 类型;测试/CI/review 全套现成 |
| B2. 独立 repo | 边界最干净 | 现阶段代价大于收益:跨仓类型共享、版本同步、CI 重建;等 standalone 需求真出现再抽(条件见 research) |
| B3. 塞进 voice-core/voice-bridge | 不新建包 | 形状不对:track B 是「脑 + 工具层」,不是语音后端;塞进去把 A/B 赛道耦死,违背 Annie 的「独立 track」决定 |

**推荐 B1**,与 Tadashi/issue 首选假设一致,审计数据支持(依赖清单见 research.md §2)。

### 3.2 ④ 骨架 — 候选矩阵

| 候选 | evidence | 判 |
|------|----------|-----|
| **C1. 自建薄 agent loop on `@google/genai`** ⭐主选 | repo 已有依赖(voice-core 在用 ^1.16.0);loop 本体小(工具注册表 + while 循环 + schema 校验);我们完全控制工具面 = ⑤ 最好落地 | 推荐:代码量小、零新依赖、guardrail 面自持 |
| **C2. Google ADK-JS(`@google/adk`)** 备选 | 官方、Apache-2.0、v1.3.0、TS 原生、Zod 工具、MCP、LlmAgent 抽象 | 若 spike 发现 own-loop 里模型行为需要大量 harness 工程(重试/规划/状态),ADK 是现成的官方骨架;代价 = 新依赖 + 它的抽象税 |
| C3. Codex App 开源(issue 假设) | **排除的实锤**:2026-02 起 codex CLI 只支持 Responses API wire protocol(chat completions 已移除),接 Gemini 必须加 Bifrost/LiteLLM 翻译代理;且它是 coding-agent 形状(shell/文件系统工具面 + 沙箱),与 track B 的「派活/查状态」窄面正交,还引入 ⑤ 不想要的攻击面 | 排除(骨架);它的**安全模式**(FLY-245 已消化)保留 |
| C4. 早期 Claude Code(issue 假设) | 闭源,无法字面借代码;repo 已有 FLY-31 源码分析(loop 设计模式可参考) | 排除(字面借用);借 loop 设计思想 |
| C5. gemini-cli 当骨架 | Google 官方 coding agent,支持 MCP/headless | 形状同 C3(coding agent);它的正确位置是**将来当第四/五个 Runner executor backend**(照 FLY-493/494 的 agy/kimi tmux-adapter 模式),不是 track B 的 dispatch-agent 骨架 |

**可靠性关键未知的先验**(比 issue 担心的乐观):
- BFCL v3 多轮 agentic tool-calling 榜(2026-06-29):GLM 4.5 76.7% > Claude Opus 4.7 76.6% ≈ **Gemini 3.1 Flash Lite Preview 76.5%**——Gemini 多轮工具调用与 Claude 旗舰几乎持平;
- FLY-968 真机:语音内 tool-call 已证(V9,~710ms);
- 但 76% 量级也说明多轮 agentic 对谁都没「解决」→ **spike 用我们自己的真工具面实测**仍必要,这正是本 issue 的核心交付。

**接 Lead/Runner 体系** = §2.2 的 Bridge HTTP 面(不新发明通道);**语音接入** = voice-core `extraTools` seam。单层(Live 直接持全部工具)还是两层(Live 一个 delegate 工具 → 文本模型 agent loop 当深脑)是 spike 命题(见 research §3.4)。

### 3.3 ⑤ Guardrail — 三层结构(照 FLY-245 模式)

> **立论校准(Tadashi gate 补充①)**:这个窄工具面是 **voice-agent 产品形态的边界**——「prepare + dispatch 受控工具面 + 人人适用的 founder-merge-gate」,**不是**对 Gemini 模型的不信任。Annie 已定 agent-agnostic 原则:任何模型做 Runner backend 时都是 full-capability 一等公民(kimi/agy/codex 同款);将来若 Gemini 做完整 Runner executor backend,它继承 Runner 全能力,与本产品面无关。founder-merge-gate 对 Claude Lead、Codex Lead、任何 agent 一视同仁。

1. **工具注册表结构红线**:merge/ship 工具**不存在**。模型只能 REQUEST,不能 SELF-AUTHORIZE。ship 意图 → 产生现有 `approve_to_ship` gate 请求(和今天 Runner 一样),verify-approval 链(founder 归因 + pr_head 绑定 + Codex hard gate)原样继承零改动。
2. **接口层隔离**:agent 进程只能走 Bridge HTTP(Bearer apiToken)+ voice-core seam;**不给** raw comm.db/teamlead.db 写权限、**不给** `flywheel-comm respond`、**不碰** reserved endpoints(`/api/actions/*`、close-tmux/close-runner)。依据 = §2.3 的同机伪造发现。
3. **凭证隔离**:agent 进程不持 merge 凭证(无 gh merge 权限 token、LINEAR_API_KEY 走 Bridge 代理)。secrets 处理参照 FLY-245 broker 模式(spike 阶段简化为 env 注入受信 wrapper)。

## 4. Lead 拍板记录(brainstorm gate,2026-07-08)

三个方向(③ B1 / ④ C1 主选 C2 备选 + Bridge HTTP 接入 / ⑤ 三层结构)**全批**。两条补充已折进:

1. guardrail 立论按 §3.3 引言校准(产品形态边界,非模型歧视;注明 Gemini-as-Runner-backend 的未来路径);
2. spike 可靠性矩阵以 **FLY-996 PRD 三北极星为测试场景**(深脑/自带上下文/结果落地),尤其「派活→查状态→汇报→结论落回 issue/memory」全链(Annie 痛点②)。

## 5. 开放问题(→ research.md)

- R1: ③ 的依赖清单量化(哪些面、什么形式、standalone 抽离条件)。
- R2: ④ 单层 vs 两层脑架构(Live 直持工具 vs delegate 到文本模型 agent loop)的取舍与 spike 判据。
- R3: 脑模型选型(gemini-3-pro vs 3.1-flash 系)+ 成本量级。
- R4: 可靠性矩阵的具体场景/指标/判据(北极星链)。
- R5: spike 的沙箱形态(不真派活污染生产)。
- R6: guardrail 在 spike 与未来 build 两个阶段各自的最小形态。
