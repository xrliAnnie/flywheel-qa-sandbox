# FLY-1397 Pi Agent 评估 — 调研

Issue: FLY-1397 (https://linear.app/geoforge3d/issue/FLY-1397/researchhl-pi-agent-pidev-评估-要不要接进-flywheel-databricks-coding-agent)
日期: 2026-07-20
基于: exploration.md;平级参照 `product/doc/FLY-1230-multi-vs-single-agent/research-pi-agent.md`

> 纪律:同尺、逐条来源、查不到标 **UNKNOWN**、我方推断显式标「(我方读法)」。**不下「接/不接」结论** —— 摆事实 + 选项 + 取舍,决定权归 Annie。

---

## Q1 — Pi 是什么

### 一句话
**Pi 不是模型,是一个极简 agent harness(CLI + TypeScript 工具箱)。** 它自己驱动模型(15+ provider),跟 Flywheel 现有 executor(Claude Code / Codex)是**同一层**的东西 —— 所以「接进 Flywheel」天然落到我们已有的 **executor-backend 抽象**上,而不是「加一个模型」。

### 形态与事实(逐条来源)

| 维度 | 事实 | 来源 |
|---|---|---|
| 形态 | 极简 agent harness;GitHub 自述 "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI";官网 "a minimal agent harness. Adapt Pi to your workflows, not the other way around." | github.com/earendil-works/pi;pi.dev |
| 开源/许可 | **MIT 开源** | github.com/earendil-works/pi |
| 仓库/活跃度 | earendil-works/pi;**73.5k stars、v0.80.10(2026-07-16)、247 个 release、5016 commits** —— 高度活跃、迭代极快 | github.com/earendil-works/pi(抓取时点) |
| 作者/公司 | **Mario Zechner(badlogic,libGDX 之父)**,现挂在 **Earendil Inc.** 下 | explainx.ai / startuphub.ai / daily.dev 二手报道 + mariozechner.at 博文 + FLY-1230 |
| 模型 | 统一 API 接 **15+ provider、数百模型**(Anthropic/OpenAI/Google/Azure/Bedrock/Mistral/Groq/Cerebras/xAI/HuggingFace…),支持中途换模型 | pi.dev |
| 跑法 | 交互式 TUI;`pi -p "query"`(headless/脚本);`--mode json`(事件流);**RPC(JSON over stdin/stdout,给非-Node 集成)**;**SDK(嵌进自己 app)** | pi.dev |
| 扩展 | extensions / skills / prompt 模板 / 主题;能力包按需加载;**自我扩展**(自己写 TS 扩展、热加载) | pi.dev |
| 权限/沙箱 | **无内置权限系统**("Pi does not include a built-in permission system");隔离靠容器化(Gondolin 扩展 / Docker / OpenShell)或自建 confirmation flow | github.com/earendil-works/pi;pi.dev |
| 血缘 | **Pi 就是 OpenClaw 里的那个 minimal agent**("See OpenClaw for a real-world integration") | pi.dev;Armin Ronacher "Pi: The Minimal Agent Within OpenClaw" |

### 设计哲学(自 FLY-1230 + Mario 博文,已核)
极简主义:**4 个核心工具(read/write/edit/bash)**、system prompt + 工具定义**合计 <1000 token**、默认砍掉 sub-agents / plan-mode / MCP / 权限弹窗;主张「模型已经够强,重脚手架反而遮蔽上下文」。全上下文透明,人在**事后** review。承认代价:「Models are still poor at finding all the context needed.」(来源:mariozechner.at;FLY-1230 research-pi-agent.md)

---

## Q2 — Databricks benchmark 说了什么

### 它怎么测(方法论,这部分对我们最有借鉴价值)

| 维度 | 事实 | 来源 |
|---|---|---|
| 语料 | 从 Databricks **百万行私有代码库**真实 merged PR 抽任务,跨 10+ 语言(Python/Go/TS/Scala/Rust/Java/Bazel/Protobuf) | Databricks blog |
| 筛选 | 近期**人写**改动(排除 bot/AI 生成)、有**高质量测试套件**、跨「几个 module」的自包含改动 | Databricks blog |
| 评分 | 用**真实测试套件**判对错,**不用 LLM judge** | Databricks blog |
| 护栏 | **封存 git 历史**,防 agent 从版本记录里翻出正确答案 | Databricks blog |
| 姿态 | 用「标准、开箱、带常用工具」的 setup 测;自称「不求全面」、还在加任务 | Databricks blog |
| 任务数 | **UNKNOWN**(原文未给具体条数) | — |
| 可复现性 | **内部专有、未公开、不可复现**(建在自己 PR 上) | Databricks blog |

### 结果(逐条,含精确数字)

**模型层(三档能力梯队):**
- Opus 4.8 — **$1.94/task,完成率 87%**
- Sonnet 5 — **$2.09/task,完成率 81%**(比 Opus 贵、低 6 分)
- GLM 5.2 — **$1.28/task,质量与 Opus 4.8 统计上并列**(强「日常主力」候选)
- GPT 5.5 / GPT 5.4 Mini — 有提及,**精确数字 UNKNOWN**(抓取未给)
- 方法论金句:**「token 单价是端到端真实成本的差指标」** —— 要按 task 级测,不按 token 定价。

**Harness 层(这单的核心)：**
- 「同一个模型、同样 thinking effort、过**两个不同 harness**(Claude Code/Codex vs **Pi**),**每 task 成本相差显著(有些情况 >2x),而质量不变**。」
- 「**Pi 每轮少发约 3x 的 context**。它上下文管得更好,working set 更紧,用更少轮次完成任务。」
- 「极简的 Pi harness 拿到跟 vendor harness(Opus、GPT-5.5)**一样的成功率**,但**成本少 2x**,主要因为**喂给 LLM 的输入更小**。」
- Databricks CEO Paddy Srinivasan(X):**「The harness is the runtime.** Same model. Same codebase. Very different cost/perf. 因为 harness 控制:repo search、context hygiene、file selection、tool orchestration、test/repair loops、跨轮 state。」

### 一个诚实核查(重要)
**Databricks 原博客里的「Pi」没注明出处** —— 没写它是 pi.dev / Mario Zechner。把「博客的 Pi = pi.dev 的 Pi」这个等号连起来的是**二手报道(explainx/startuphub/daily.dev)+ 业界普遍理解**。可信度高,但**不是原博客一手确认**。(来源:Databricks blog 无归属 + 二手报道有归属)

---

## Q3 — 接进 Flywheel:怎么接、值不值(摆选项,不下结论)

### 我们现在长什么样(已核代码)
- executor backend:`RunnerVendorType = claude | gemini | codex | cursor | antigravity | kimi`(`packages/config/src/runner-label.ts`、`types.ts` `EXECUTOR_BACKENDS`)。
- 加一个 vendor 的成熟路子(FLY-493 antigravity、FLY-494 kimi 刚走过两遍):写一个 **TmuxAdapter 瘦子类**,覆盖 `type`/`binaryName`/`runPreflight`(bounded 探活 + 凭据存在检查)/`buildCliArgs`(vendor CLI flag)/`registrationVendor`,再 **~6 处注册**(`EXECUTOR_BACKENDS`、`EXECUTOR_TO_TRANSPORT`、`VENDOR_TO_EXECUTOR`、runner-label vendor、index 导出、run-infra factory)。(来源:`KimiTmuxAdapter.ts` + grep)
- transport 三态:`claude-code | codex | none`。agy 与 kimi 都是 **transport=none** → 无 Lead→Runner 邮箱 → 终于 **`pr_handoff`**(build→PR→**founder 手动 ship**),**永不进 approve/ship 环**。(来源:`Blueprint.ts`、`DecisionLayer.ts`)

### Pi 相对 agy/kimi 的差异点(值得点出)
agy/kimi 是「没有邮箱只能 transport=none」的 CLI。**Pi 不一样**:它有 `pi -p`、`--mode json`、**RPC over stdin/stdout**、**SDK**。这意味着 Pi **有可能**支持比 transport=none **更丰富的接法**(session 中途 push-wake、自动 ship)—— 正好是 agy/kimi 至今没做的 follow-up。**(我方读法)**:这让 Pi 比 agy/kimi **更值得接**,因为它能接得更深,不止「build+PR 就交回人」。

### 一个反直觉的取舍(核心,且直接强化 Q4 的 UNKNOWN)
Databricks 测出的省钱,来自 **Pi 自己的极简 harness 纪律**(紧上下文、4 工具、<1000 token prompt)。而 Flywheel 的 runner harness 会往 Pi 里**塞一大坨** procedure prompt(现在 kimi/agy 就是把庞大 Flywheel 流程 prompt 写进 0600 bootstrap 文件当种子)**+ 三段式 gate**。**(我方假设)**:把 Pi 包进 Flywheel 的重 harness,很可能**抵消掉** Pi 的 context-efficiency 优势 —— 那正是它省钱的来源。换句话说:**「Pi 省 2x」是 Pi-裸跑的属性,不自动等于「Flywheel-里的-Pi 省 2x」。** 这是「值不值」的关键不确定性。

### founder-safety(Lead 要求摆最显眼:能不能接的前提,不是脚注)
- 事实:**Pi 无内置权限系统**;Flywheel 有 founder-only-authority 合同 + merge/ship/runner-lifecycle 的 founder-gating(FLY-175/245/350)。
- **好消息(已核代码)**:最便宜的接法(transport=none → `pr_handoff`)**恰好也是最安全的** —— Pi 只负责 build + 开 PR,**founder 仍手动 ship**,Pi 拿不到 merge/ship 权限,founder-gating 完整保留。便宜路 == 安全路。
- **风险点**:一旦想让 Pi「更丰富地接」(RPC transport、自动 ship),权限这条就会咬回来 —— 谁给沙箱内的 Pi 兜安全?Pi 官方答案是「不放心就跑容器里」(container),不是程序化前置闸。这跟我们「自治 fleet、founder 不在每个动作旁边」的语境是**开放张力**(FLY-1230 已提出、留给 Annie 判)。

### 三个选项(替换 / 并列 / 借鉴)+ 取舍

| 选项 | 是什么 | 优 | 劣 / 风险 |
|---|---|---|---|
| **替换 (replace)** | 用 Pi 顶掉 Claude Code / Codex 当主 executor | 若省钱成立,全 fleet 受益 | 丢 Claude/Codex 的成熟度 + Agent-Team 真 transport;省钱在我们库上**未验**;高风险不可轻试 |
| **并列 (add as backend)** | Pi 做**第 7 个 vendor**,按 label 逐 issue opt-in(同 agy/kimi) | 便宜(~1 adapter + 6 注册)、低风险、可逆、默认字节兼容;**能在我们自己代码库上真 A/B Pi vs Claude/Codex 去验证那个 2x**;transport=none → founder-gating 完整 | 若被重 harness 抵消,A/B 可能测不出 Pi 的优势(见上「反直觉取舍」);要设计公平的 A/B |
| **借鉴 (learn-from)** | 不接 Pi,把 Pi 的 **harness 纪律**(每轮更紧的 context、更少工具、更小 system prompt)移植进我们**现有** Claude/Codex runner | 省钱是 **harness 属性、可移植**(Paddy:harness is the runtime);可能**最高杠杆** —— 不引第三方、全 fleet 立即受益 | 要先搞清我们 harness 的 context 膨胀在哪、动的是核心 runner 代码(不是加个 opt-in vendor 那么可逆) |

**(我方不下结论)**:三者不互斥 —— 例如「并列做一个 opt-in Pi vendor 去实测 2x 是否在我们库上成立」与「借鉴 Pi 纪律瘦身现有 harness」可以**先后**做。用哪个、要不要,归 Annie。

---

## Q4 — 诚实边界 / UNKNOWN(不编)

- **成本 2x = UNKNOWN-on-our-side**:Databricks 的 2x 在其**私有、不可复现**代码库上测得,**我们这边没验过**。它是「他们测出、我们待验」,不是事实陈述。
- **Databricks 的「Pi」无一手归属**:原博客没写 Pi 出处;= pi.dev 的等号来自二手报道 + 业界理解(高可信,非一手)。
- **GPT-5.5 / GPT-5.4 Mini 精确数字 UNKNOWN**(抓取未给)。
- **benchmark 任务条数 UNKNOWN**(原文未给)。
- **Pi 在 Flywheel 重 harness 下是否还省 = UNKNOWN**(我方假设可能被抵消,未验)。
- **Pi 面向无人值守 fleet 的成熟度 UNKNOWN**:Mario 明示语境是**本地结对**(人在旁边),无人值守他建议「跑容器里」;我们是 founder 不在每个动作旁的自治 fleet —— 落差是开放问题。
- **HN 讨论的批判视角未取回**(news.ycombinator.com/item?id=48837696 抓取 429 限流);为不编造,标未取回。

---

## Q5 — Annie 的 reframe(2026-07-20):统一 agent 层 + Pi-as-wrapper

> Annie 把 1397 从「要不要用 Pi」**升级**成一个具体架构愿景:**让 Lead↔Runner 变 model-agnostic —— 一层统一 agent 抽象,Pi 做新厂商(Kimi/Gemini/…)的通用 wrapper,CC+Codex 留着吃自家模型适配。** 深挖三条,证据优先、保 UNKNOWN 台账、不下结论。

### 关键发现:**执行器「选择层」**已经建得很干净(已核代码,`role-adapter-resolver.ts`)

> **诚实修正(Annie 亲历反例,见 §Q6)**:我上一版把这条说成「整层抽象已建 80%」是**过度声称**。准确说法:**干净的是「选择层」** —— 但一个 vendor 的完整集成面**远不止选择层**,vendor-specific 逻辑抹在选择层**之外的 ~25 个文件**里(prompt 生成 / dispatch / DB schema / QA-gate / 报告 / 生命周期)。**Annie 加 Codex 撞的痛就落在那些地方**,§Q6 逐个 file:line 点名。以 founder 亲历为准,我不替 80% 辩护。

现有 dispatch 已经把**三件事显式分开**(不是要从零造):

| 概念 | 代码里的东西 | 说明 |
|---|---|---|
| **harness(执行器)** | `ExecutorBackend` = `claude-tmux \| codex-tmux \| antigravity-tmux \| kimi-tmux` | 按 role 选 |
| **transport(Lead↔Runner)** | `TransportMode` = `claude-code \| codex \| none`,经 `EXECUTOR_TO_TRANSPORT` 从 backend 派生 | agy/kimi = `none` |
| **model** | 独立解析,叠在 harness 上 | `dispatchModel`(FLY-728 难度分档)+ label + 项目默认 |

- `resolveRoleAdapter()` 精确按 **task override(label)> 项目 config > 全局 env > 内建默认(claude-tmux)** 选 harness;`FLYWHEEL_RUNNER_BACKEND`(执行器)与 `FLYWHEEL_AGENT_BACKEND`(transport)**代码里明确不许混同**。
- **Pi 就是这层上的一个新 `ExecutorBackend`(如 `pi-tmux`)** —— 加进 `EXECUTOR_TO_TRANSPORT` + `VENDOR_TO_EXECUTOR` 即可,与 agy/kimi 同构。
- **今天的形态 = 「一 vendor 一 adapter」**:claude/codex/agy/kimi 各是一个 `TmuxAdapter` 子类(agy=FLY-493、kimi=FLY-494,各一个 PR)。**Annie 的 reframe = 一个 `pi-tmux` 顶掉未来 N 个 per-vendor adapter**(Pi 自带 15+ provider),CC+Codex 保留做自家深适配。**(我方读法)**:这正是 reframe 的杠杆 —— 不再每来一个新厂商写一个新 adapter。

### ① 自家适配到底真不真(CC/Codex 的 model-specific 事 vs Pi 通用 adapter)

**CC/Codex 确实做真实的 vendor-specific 事(已核代码 + 官方文档):**
- **Codex adapter(`CodexTmuxAdapter.ts`)**:`sandbox: "workspace-write"`、`approvalPolicy: "never"`、`model_reasoning_effort=`(GPT reasoning 档)、per-runner `CODEX_HOME`(TOML `-c` 配置)、`codex app-server` 常驻 daemon + thread rollout resume + 429 rotation shim。
- **CC adapter(`TmuxAdapter` 家族)**:`--model` / `--permission-mode` / `--allowed-tools`+`--disallowed-tools`(内置工具权限面)/ `--append-system-prompt-file` / `--session-id`(resume)。
- **产品内部(官方文档)**:CC 用 Anthropic **prompt caching**(system prompt + 工具定义缓存)+ **extended thinking**(thinking 模式);Codex 用 OpenAI reasoning。这些是**厂商 API 原生**特性。

**但要诚实拆两层:**
- 上面多数是 **harness 层 plumbing**(沙箱/resume/工具权限面/reasoning flag)—— 不是模型权重级的独家优化。真正「模型独家」的(prompt caching / thinking)住在 **CC/Codex 产品内部**,不在 Flywheel 的 wrapper 里。
- **Pi 的通用 adapter**:15+ provider 统一 API;它**能**传厂商特性,但作者自己承认「leaky abstractions,统一 API can never be perfect」。**Pi 到底有没有吃 Anthropic prompt-caching / extended-thinking / OpenAI reasoning-effort = UNKNOWN(未查 Pi 的 provider adapter 源码)。**

**对上 Databricks 头条(关键、且要「别默认成立」):**
- Databricks:**同模型下,harness 本身带来 >2x 成本差,Pi 更省(靠更小输入)**。即在**成本轴**上,「vendor 自家适配」并没有赢 —— **harness 的上下文管理压过了 first-party 适配**。
- prompt caching 本是省钱杠杆,vendor harness 理论上更会用;但 **Databricks 里 Pi 仍在成本上赢** —— 说明「留 CC+Codex = 成本优势」这条**不明显成立**。
- **净结论(不下,交 Annie)**:「留 CC+Codex 吃自家适配」作为**能力**主张(resume / 工具权限面 / thinking / reasoning 档)是真的;但作为**成本优势**主张,Databricks 的证据**指向相反**(harness 纪律 > 自家适配)。到底是真优势还是 **harness 锁定**(我们只是习惯了 CC/Codex 的成熟壳),**别默认成立** —— 要在我们自己库上 A/B(Pi+Anthropic vs CC+Anthropic 同模型)才知道。这是 UNKNOWN-on-our-side。

### ② 权限怎么包(Pi 无内置权限 → founder-gating 包在外面)

**事实分层(已核):**
- **CC 有内置工具权限面**:`buildAllowedTools/buildDisallowedTools`(`RunnerSelectionService`)→ CC 的 `--allowed-tools` / `--disallowed-tools` / `--permission-mode`。这是 **runner 进程内**的工具闸(限制它能跑哪些 bash/edit/MCP)。
- **Pi 明确「no built-in permission system」** —— 这层 in-runner 工具闸,Pi 没有。
- **但真正的红线闸(merge / ship / runner 生命周期)本来就在 runner 外面**:`verify-approval`、`FounderConsentEvaluator`(FLY-175)、`approve_to_ship` gate、`:cool` deploy、branch protection、`verify-lifecycle-consent`(FLY-245)。**任何 vendor 的 runner 都拿不到 merge/ship 权限** —— 它只产 PR,founder ship。

**所以 Pi-driven runner 怎么仍过我们的确认闸(具体形状):**
- **v1 便宜路(同 agy/kimi)**:Pi 跑在**容器里**(Pi 官方对无人值守的建议)+ transport=none → `pr_handoff`(只 build+PR,founder 手动 ship)。**不需要新权限接线** —— 红线闸本来就在外面;沙箱内动作由容器兜底,runner 无 push/merge 权限。**这是最省事也最安全的形状。**
- **更深路(若要 Pi 中途做保留动作)**:Pi 是可扩展的,支持自建 confirmation flow —— 可把 **Pi 的 RPC 确认流 hook / SDK 里拦截 tool-call**,把要做保留动作的 tool-call 路由到 Flywheel 的 gate / `verify-approval` / founder-consent。这是 Pi 官方「build your own confirmation flow / permission-gate extension」的落地。**(我方读法)**:v1 不必做这层;它只在「想让 Pi 自动 ship / 中途执行保留动作」时才需要。
- **要诚实的落差**:Pi 丢了 CC 的 **in-runner 工具闸**(defense-in-depth 的一层)。补法 = 容器隔离(Pi 自己的答案)。这层是「防 runner 在沙箱里乱跑」,不是「防它 merge/ship」(后者外部闸已兜)。

### ③ 怎么嵌进 dispatch(Pi-wrapped runner 走 pi 的 RPC/SDK,model=<厂商>)

**现在的 dispatch 链(已核 `role-adapter-resolver.ts` + `RunnerSelectionService.ts`):**
- runner = 一个 agent 进程(CC 或 Codex),由 `resolveRoleAdapter` 按 role 选 `ExecutorBackend` → 对应 `TmuxAdapter` 子类 spawn;`leadId` / `taskCategory`(role/phase)/ `dispatchModel` 走 `StartRequest`,**与 harness 正交**。
- **一个真实约束**:今天 **model 反推 vendor 反推 harness 是 1:1:1 链**(`inferRunnerFromModel`:opus→claude、gpt→codex、gemini→gemini)。而且 **`VENDOR_TO_EXECUTOR` 里 gemini / cursor 根本没 executor**(「no executor — label layer cannot resolve them」)→ **今天 Gemini/Cursor 模型当 runner 跑不了,fall through 到 claude-tmux 默认**。这正是 Pi-as-wrapper 要填的洞。

**一个 Pi-wrapped runner 要动/不动什么:**
- **要动(小、加性)**:① 加 `pi-tmux` 到 `ExecutorBackend` + `EXECUTOR_BACKENDS` + `EXECUTOR_TO_TRANSPORT`(Pi=`none`→pr_handoff 最省,或走 RPC 上更丰富 transport)+ `VENDOR_TO_EXECUTOR`(`pi` → `pi-tmux`);② 写一个 `PiTmuxAdapter`(同 `KimiTmuxAdapter` 瘦子类:`type`/`binaryName=pi`/`runPreflight`/`buildCliArgs`=`pi -p "<bootstrap>" --model <厂商模型>`);③ **解耦 model↔harness** —— 让「harness=pi」可独立于 model 选中、model=<Pi 的任一 provider 模型>。现有 `dispatchVendor`(FLY-1224)已经能让 phase 表带一个独立于 model 的 vendor,所以这个 seam **部分已在**;要补的是「pi 作为 harness 时 model 原样透传给 Pi、不被 `inferRunnerFromModel` 抢去」。
- **不动(大部分)**:`leadId` / `taskCategory` / `StartRequest` 派发链、worktree、Bridge 路由、transport-mode 机制、resolver 优先级 —— 全 vendor-neutral,**Pi 直接继承**(这也是 FLY-494 kimi「执行逻辑零改动继承」的同款收益)。
- **(我方读法)对齐 Tadashi 的机制**:resolver 按 **role**(runner/lead)解析,`dispatchModel`/`dispatchVendor` 来自难度分档 / phase 表 —— `taskCategory` 映射 role/phase,与「哪个 harness」正交。**Pi 落在 harness 层,不碰 leadId/taskCategory 语义。**

### 三条张力汇总(供 co-eval,不下结论)

| # | 张力 | 已知 | UNKNOWN / 要 Annie 判 |
|---|---|---|---|
| ① | 留 CC+Codex 吃自家适配 | CC/Codex 真做 vendor-specific 事(resume/工具闸/thinking/reasoning);但 Databricks 证据显示 harness 纪律 > 自家适配(**成本轴**) | 是真优势还是 harness 锁定?Pi 有没有吃 prompt-caching/thinking = UNKNOWN;要我们库上 A/B |
| ② | Pi 无内置权限 | 红线闸(merge/ship/lifecycle)本就在 runner 外、任何 vendor 都过;v1 容器+pr_handoff 零新接线 | 若要 Pi 中途做保留动作,才需把 RPC/SDK 确认流接到 gate —— 要不要走那步 |
| ③ | 嵌 dispatch | 抽象已建 80%(ExecutorBackend+transport 分离);Pi=加性新 backend + 解耦 model↔harness;dispatch 链不动 | 解耦 model↔harness 的具体 label/config 形态;transport 选 none 还是 RPC |

---

## Q6 — 覆盖边界(Annie 亲历反例:80% 是哪 80%,她的 Codex 痛落在哪)

> Annie 亲历:她在把 Codex 加进更多项目,发现**很多意想不到的地方没做 Codex 适配、要一层层手动补**。这跟我上一版「已建 80% / kimi 零改动」表面矛盾。**真相(全仓 grep 坐实):干净的是「选择层」,vendor-specific 逻辑抹在选择层之外的 ~25 个文件里 —— 她的痛正落在那儿。以下逐个 file:line 点名,不替 80% 辩护。**

### 抽象**覆盖**什么(INSIDE — 干净、加性、近乎零改动)

| 覆盖面 | 代码 | 加一个 vendor 要做的 |
|---|---|---|
| 执行器**选择** | `role-adapter-resolver.ts:180 resolveRoleAdapter`(优先级 label>config>env>default);`:49 EXECUTOR_TO_TRANSPORT`;`:59 VENDOR_TO_EXECUTOR` | 加一个 map 条目 |
| label/model 解析 | `config/src/runner-label.ts:134 parseRunnerLabels` | 加一个 vendor 关键词 |
| adapter 执行契约 | `TmuxAdapter`(claude)+ 瘦子类(`KimiTmuxAdapter`/`AntigravityTmuxAdapter`/`CodexTmuxAdapter`) | 写一个瘦子类 |

→ **这层就是我说的「~80%」的真实所指** —— 选择 + 注册 + 一个 adapter。**到此为止确实近乎加性。**

### 抽象**不覆盖**什么(OUTSIDE — vendor-specific 抹在 ~25 文件,这就是 Annie 的痛)

| 面 | 文件:line(节选) | 它在按 vendor 做什么(= 加 Codex 时要手补的) |
|---|---|---|
| **runner 提示词生成** | `Blueprint.ts:932 isCodexRunner`、`:1276/:1521/:1780 codexPhaseWakeContract`、`:1778 codexGateWaitLawInjected`、`:2199 "Environment Translation (codex runner)"`、`:1636 "NOTE (codex author)"`、`:1965 runnerTransportMode==="none" → pr_handoff FINISH`、`:258/:776/:2009 codexSkip`、`:1124/:1136/:1145 codex_worktree_required/mismatch` | runner **提示词本身**按 harness 能力分叉 ~15 处:codex 无 mailbox → 注入 poll-based phase-wake 合同;codex 的 gate-wait 律;整段「环境翻译(把 claude-isms 翻给 codex)」;design-review skip;codex 专属 worktree 校验;transport=none 的 pr_handoff 终态 |
| **dispatch 强制回退** | `run-dispatcher.ts:302-308`(FLY-752) | **需要 mailbox 的 lane(如三段式 QA retest_wake)遇到 transport=none 后端 → 强制改写成 claude-tmux**。即 no-transport vendor **结构性被排除**在这些 lane 之外 |
| **DB schema(vendor 专属表/列)** | `StateStore.ts:661/769 codex_skip`、`:935 codex_thread_id`、`:2173 codex_review_record 表`、`:2222 codex_review_job 表`、`:337/338 codex_nudge_queue/wake` | Codex 有**自己的表和列**(review 记录、thread id、nudge 队列、skip 标记)—— 加 vendor 常要加持久化 |
| **QA / code-review 硬门** | `codex-gate.ts:75 codexHardGateEnabled/:34 codexHoldStuckThreshold`、`auto-qa-coordinator.ts:711 codexHold/:504`(FLY-827) | 整套「Codex code review 硬门 + hold」是 **codex 专属**机器 —— 决定 QA 起不起、founder 能不能 ship |
| **fleet 能力面** | `fleet-capabilities.ts:103/115/169/178 codex-app-server 特判`、`CODEX_EFFORT_OPTIONS`、`isCodexEligible` | fleet 控制台按 backend 给不同 effort 选项 / 资格判定 |
| **相位生命周期** | `codex-phase-shutdown.ts:82 adapter_type==="codex-tmux"`、`ProcedureAnalyzer.ts:175 codexSessionId`、`AgentSessionManager`、`decision/DecisionLayer.ts`(transport==="none" 分支) | codex daemon 的关停 / session 分析 / 决策路由都有 vendor 分支 |
| **报告 / 路由 / 长尾** | `dashboard-html.ts`、`event-route.ts`、`founder-action-drain.ts`、`management-existing-writers.ts`、`lead-dual-active-scan.ts`、`ask.ts`… | 各处零散 vendor 分支(报告展示、事件路由、founder 动作等) |

**净事实(不替 80% 辩护)**:选择层干净;但**一个 vendor 的完整集成面横跨 ~25 文件**,大头在 **runner 提示词(Blueprint,~15 处)+ 持久化 + QA 硬门**。**加 Codex 要一层层手补 = 这些地方,Annie 是对的。** 且 **Codex 是最贵的那种**(transport=codex:自带 daemon、phase 生命周期、专属 gate、环境翻译),所以它 vendor 分支最多(Blueprint 就 40 处命中)。

### Pi 对照:Pi 到底解不解 Annie 的痛(诚实判,不 hand-wave)

**为什么这些分支存在**:它们按 **harness 能力**分叉(有没有 mailbox?怎么等 gate?要不要环境翻译?daemon 怎么关?),**不是按模型**。Codex 要这些,是因为 codex 这个 harness 的属性。

**一个 Pi adapter 会不会避开它们?——分三点:**
1. **不会零成本。** Pi 是**另一个 harness**,会落在 **transport=none**(像 kimi/agy,Pi 无 claude-code Agent Team mailbox)。它**复用** kimi/agy 已铺好的 transport=none 分支(pr_handoff、no-transport FINISH),所以**比 Codex 便宜**(Codex 是 transport=codex 那条最贵的路);但仍要一个 `PiTmuxAdapter` + 可能自己的环境翻译 + poll-based phase-wake(Pi 也无 mailbox)。**不是「零改动」。**
2. **Pi 不回头修 Codex 的痛。** 加 Pi ≠ 重构现有的 vendor-fork。Annie 加 Codex 撞的那 ~25 处,Pi **一处都不清理** —— 它们是 codex 这条已建的 transport=codex 集成,与 Pi 正交。
3. **Pi 真正的价值 = 折叠「模型轴」,不是消灭「harness 轴」。** 今天每加一个**新模型厂商**(gemini/kimi/cursor/…)当**独立 harness**都要一套 adapter + 分支;Pi(一个 harness 驱动 15+ provider)把 **N 个新模型集成折成 1 个 Pi 集成**。但 Pi **坐在 dispatch/执行层** —— 它把 Flywheel 侧的 harness 集成面付**一次**(≈一个 transport=none vendor 的量,Blueprint 提示词分支 + 持久化仍要),**不会归零**。

**一句话诚实结论(交 Annie,不下决定)**:
- Pi **不解决**「加 Codex 很痛」这个具体问题 —— 那是 transport=codex 的 harness 集成复杂度,跟 Pi 正交。
- Pi **能**让**未来加新模型**变便宜(N 厂 → 1 Pi wrapper,且落在便宜的 transport=none)。
- 但 Pi **自己**也要付一次 transport=none 集成(比 Codex 小,因 kimi/agy 已铺路),**不是零改动**。
- 所以 Pi 的真实价值命题是「**未来模型广度便宜**」,**不是**「消除现有 vendor-fork / 治好 Codex 痛」。要不要为这个价值买单,归 Annie。

**UNKNOWN / 边界**:这 ~25 文件是 grep 命中的**代码分支**;每一处「加 vendor 是否**必须**改它」的强弱不一(有的是硬依赖如 Blueprint 提示词,有的是可选如报告展示)—— 精确的「必改 vs 可选」清单要一次工程 spike 才能定档,本研究给的是**面与量级**,不是逐行工作量估算。

### Annie 又给的两个具体痛点(亲历,已代码坐实)

**痛点① — DAG 节点的 model/agent 识别(她的「Tadashi 3B DAG 只认 Claude Code、加 Codex 要开新 issue」)**
- `DagNode` 类型**只有 `id` + `blockedBy`**(`dag-resolver/types.ts:5-10`)—— DAG resolver 纯管依赖顺序,**agent-agnostic**、不带 model。这层✓抽象。
- per-node 的 agent 从 `generalizedExecution.dispatch.{vendor,model,effort}` 来 —— 在 dispatch 时(`run-dispatcher.ts:669-671`)喂进**同一个** `resolveRoleAdapter`。**plumbing 上** claude/codex per-node 是通的。
- **但**「节点→agent 的识别 / 授权 / 校验」层在 resolver **之外**:`workflow-run-snapshot.ts:357`(校验 `dispatch.vendor` 未知则抛)、`StateStore.ts:14859`(跨节点 `dispatch.vendor` 一致性判定)、以及 dashboard 的 per-node model 选择器(FLY-1038 ④)。**加一个新 agent 到 DAG = 要动 `PhaseDispatchVendor` 白名单 + snapshot 校验 + 跨节点一致性 + dashboard 选项**,这些都在 resolver 之外。**→ Annie 对:这是边界外一个点,不是改个 map 就完。**

**痛点② — 换某 Lead 的 agent(Claude→Codex,她直觉又要开新 issue)**
- Lead 的 agent 是**另一条平行 seam**:`leads[].backend: LeadBackendId = "claude-code" | "codex-app-server"`(`ProjectConfig.ts:125`),代码里**明确注明「the Lead backend seam, NOT the Runner's executor id」**(`:633`)—— 跟 Runner 的 `ExecutorBackend` 是**两套东西**。
- 换 Lead agent 要动的层(全在 resolver 外):① fleet config `leads[].backend`(且 `codex-app-server` 有**跨字段硬约束**:必须 `canSpawnRunners:false`、不支持 effort —— `ProjectConfig.ts:696/723-729`)② **Lead launcher 不同**:claude 用 `claude-lead.sh`,codex 用独立的 windowed TUI launcher + wrapper + launchd plist(FLY-398,见 CLAUDE.md 硬规)③ `lead-lease.ts:841 lead_backend_drift` 漂移检测(backend 与 env 不一致会告警)④ `fleet-capabilities.ts` 的 effort 选项 / 资格判定。**→ Annie 对:换 Lead agent 散在 config + launcher + 约束 + 漂移检测多层。**

### 层级图(Annie 要的核心:一眼看清「只有派发层被抽象」)

一个「用自己 agent 的新 model」要穿过的层,逐层标 **✓已抽象 / ✗要手补 + file:line**:

| 层 | 状态 | 代码位 |
|---|---|---|
| DAG 依赖解析 | ✓ agent-agnostic | `dag-resolver/types.ts:5`(DagNode=id+blockedBy) |
| Runner **执行器选择** | ✓ 干净 | `role-adapter-resolver.ts:180` + `:59 VENDOR_TO_EXECUTOR` |
| Runner adapter | ~ 写一个瘦子类 | `KimiTmuxAdapter` 等 |
| **DAG 节点→agent 识别/校验** | ✗ 手补 | `workflow-run-snapshot.ts:357` + `StateStore.ts:14859` + dashboard 选项 |
| Runner **提示词**(procedure) | ✗ 手补(按 harness 能力分叉 ~15 处) | `Blueprint.ts:932/1276/2199` |
| dispatch mailbox-lane 回退 | ✗ 手补 | `run-dispatcher.ts:302`(transport=none→claude) |
| **DB 持久化** | ✗ 手补(vendor 专属表/列) | `StateStore.ts:2173/935/337` |
| **QA / code-review 门** | ✗ 手补(codex 专属) | `codex-gate.ts:75` + `auto-qa-coordinator.ts:711` |
| **Lead→agent 绑定** | ✗ 手补(平行 seam + 跨字段约束) | `ProjectConfig.ts:125/723` |
| **Lead launcher / runtime** | ✗ 手补(claude-lead.sh vs codex TUI + plist) | FLY-398(CLAUDE.md 硬规) |
| Lead 漂移检测 | ✗ 手补 | `lead-lease.ts:841 lead_backend_drift` |
| fleet 能力 / 控制台 | ✗ 手补 | `fleet-capabilities.ts:103` |
| 生命周期 / 报告 | ✗ 手补 | `codex-phase-shutdown.ts:82` · dashboard-html · event-route |

**一眼结论(交 Annie,不下决定)**:**被抽象的只有最上面 2-3 层(DAG 解析 + 执行器选择 + 写一个 adapter);其余 ~10 层每加一个自带 agent 的新 model 都要手补。** 这就是她说的「散在很多层、非常多工作量」—— 用真实 file:line 坐实了。**Pi 也逃不过这张图**:它作为一个新 harness,DAG-识别 / 提示词 / DB / QA / (若做 Pi Lead 则)Lead 那几层照样要碰;Pi 省的是**把 N 个新模型折成 1 次穿越**,不是把这张图的层数减少。

---

## 来源清单

- Databricks, "Benchmarking Coding Agents on Databricks' Multi-Million Line Codebase" — https://www.databricks.com/blog/benchmarking-coding-agents-databricks-multi-million-line-codebase
- Pi 官网 — https://pi.dev/
- Pi 仓库 — https://github.com/earendil-works/pi(MIT;73.5k⭐;v0.80.10 @ 2026-07-16)
- Mario Zechner, "What I learned building an opinionated and minimal coding agent" — https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- Armin Ronacher, "Pi: The Minimal Agent Within OpenClaw" — https://lucumr.pocoo.org/2026/1/31/pi/
- Paddy Srinivasan(Databricks CEO)"The harness is the runtime" — https://x.com/paddix/status/2075015398995472613
- 二手归属报道 — explainx.ai / startuphub.ai / daily.dev(把 Databricks 的「Pi」连到 pi.dev/Mario Zechner)
- Flywheel 代码(已核):`packages/config/src/runner-label.ts`、`packages/config/src/types.ts`(EXECUTOR_BACKENDS)、`packages/claude-runner/src/KimiTmuxAdapter.ts`、`packages/edge-worker/src/Blueprint.ts`(pr_handoff / runnerTransportMode)、`packages/edge-worker/src/decision/DecisionLayer.ts`
- 平级前置研究:`product/doc/FLY-1230-multi-vs-single-agent/research-pi-agent.md`(拐杖 vs 地基 哲学层)
- 未取回:HN 讨论 news.ycombinator.com/item?id=48837696(429)
