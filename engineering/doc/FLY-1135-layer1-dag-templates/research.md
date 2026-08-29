# FLY-1135 低层 DAG 模板引擎 — 调研

Issue: FLY-1135 (https://linear.app/geoforge3d/issue/FLY-1135/build-layer-1-per-task-category-dag-templates-fly-1020-prd-eng)
日期: 2026-07-13
基于: exploration.md

> 两半:**A. 本仓机制审计**(边契约与模板引擎的落点事实)+ **B. 业界调研**(四路并行 deep research
> 的收敛结论)。B 半随研究 agent 返回折入。

---

## A. 本仓机制审计

### A.1 今天的「声明」全景 —— 四种凭证,三种已长出契约的一部分

系统里所有「某方声明了一个事实,下游门读它」的形态(全部核过码/DB schema):

| # | 事实 | 载体 | subject 绑 head? | issuer 可验? | head 动了会失效? |
|---|------|------|------------------|--------------|------------------|
| 1 | 独立 auto-QA verdict | `auto_qa_record`(teamlead.db) | ✅ `target_pr_head_sha` 列 | ⚠️ 记 `qa_execution_id`,但 ingest 共享 bearer + `prHeadSha` 自报(qa-result.ts「Defaults to git HEAD」) | 部分(retest 机制) |
| 2 | 三段式内部 QA verdict | `session_params.three_stage_verdict` + `qa_required` 快照 | ❌ verdict 无 subject;快照 headless | ❌ 自声明 | ❌ **红测的洞**:快照写一次(`WHERE qa_required IS NULL`,StateStore :4082),对 H1 写的 0 在 head 前进到 H2 后改不回来;`evaluateQaShipGate` 读 0 = 直接放行(`qa_not_required`) |
| 3 | Codex code review | `codex_review_record` | ✅ `target_pr_head_sha` | ✅ 有 `author_family` / `reviewer_family` 列(跨厂商规则的落点已存在) | ✅(head 漂移需重审,FLY-945 系) |
| 4 | founder 批准 | session `approved_to_ship` + `pr_head_sha` + review_question 绑定 | ✅ 读侧 `verify-approval`:status + `pr_head_sha` 一致才 approved,mismatch 拒 | ⚠️ **读侧强、写侧漏**(FLY-1221):`founderApprovalHoldGuard` 只有 plugin.ts 一处真调用;`actions.ts approveExecution` 零检查;voice-routes.ts:108 / founder-ship-approval-handler.ts:174 是**描述保护的注释,不是保护** | ✅ 读侧拒 mismatch |

**结论**:第一章不是发明新东西,是**收敛** —— #3 最接近目标形态(head 键控 + 双方身份 + 漂移重审);
#1 差 issuer 认证与 subject 权威化;#4 差写边界统一;#2 全差(正是红测钉住的)。

### A.2 红测(验收线)拆解 — origin/fly-1204-split 58cecc1f

`REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts`,故意红。不变量:
**ship 的 head 必须有「对着这个 head」通过的 QA**。它证明今天不可能成立的两个结构原因:

1. `qa_required` 是**写一次快照**,head 会动 —— 单向门装不下会过期的事实。
2. QA verdict 是 **runner 自声明** —— 共享 ingest bearer + CLI 把 `--exec-id`/`--pr-head` 都交给
   调用方,任何 runner 可为任何 head 声明 PASS。

测试注释同时点名同一夜抓到 5 次的 bug class(role 冒充目录 / status 冒充活着 / marker 冒充证据 /
快照冒充持续事实 / 自报冒充可验证证据)—— 契约设计必须对这五种「标签替代事实」全部免疫。

### A.3 fly-1204-split parked 分支(未挂 PR;设计输入,非既成事实)

~10 commits / 4255 行,从 #571 拆出的部分边契约动作:

| commit | 内容 | 对第一章的意义 |
|--------|------|----------------|
| 40405388 | PR-head ownership 决定 Codex gate(去 role allowlist) | 「按 subject 归属替代按 role 标签」方向一致,可吸收 |
| 4975ee0d | retry admission 按 contended worktree 不按 role 标签 | 同上 |
| 61593e8a | 三段式 qa 段拥有自己的 PR head | subject 权威化的前置 |
| 0a06fe3e | 提前 founder 批准后的 qa_required 对账 | 治标,新契约下应被 ledger 取代 |
| 8c24044f | ship 豁免站在 EVIDENCE 上不站 marker | 方向一致,可吸收 |
| b3457180 | 只有 QA phase 可无 QA 证据 ship | 同上 |
| 58cecc1f | 红色验收测试 | **原样吸收 = 本章验收线** |

### A.4 模板引擎落点事实(FLY-1020 PRD §2 审计本轮复核 + 增量)

- 三段式六职责单文件 `three-stage-phases.ts`(类型/序列/isThreeStagePhaseRole/
  resolveCompletionSessionRole/nextPhase/badge)= 「hardcode 三段式」单一真相源;
  `design|implement|qa` 贯穿 8 个生产面(PRD §2.3b);**未知 role 静默归一成 main = fail-closed 红线**。
- **dispatch 双入口**(前任 FLY-1043 runner 审计):PhaseOrchestrator / auto-QA 直调
  `RunDispatcher.start`,绕过 `/api/runs/start` 的 DepartmentRegistry+admission → 引擎接入点选
  HTTP 边界才白拿 dept-scope 校验。
- **无持久派发队列**(内存 inflight + sessions 表)。
- `DagNode` 生产面只用 `node.id` → 旧 dag-resolver 收缩迁移极小。
- 可复用底座:fleet_pressure_hold / xhs-scheduler / FounderConsentEvaluator。

### A.5 节点字段的权威定义(FLY-1224,Annie 拍板原样成为模板节点字段)

- per-phase **{vendor, model, effort}**;三段式默认 = design(claude, fable) /
  implement(codex, gpt-5.6-sol, xhigh) / qa(claude, opus)。
- resolver 走既有 `VENDOR_TO_EXECUTOR` 别名路径(**别新写一套映射,会 drift**);
  layer 1b(role-adapter-resolver.ts:192)从无条件 `claude-tmux` 改为接受显式 backend。
- 硬约束:Codex implement 段必须 windowed TUI(FLY-398 铁律);字节兼容(不传 vendor 行为不变)。
- **跨厂商审稿不变量**(Annie):作者厂商 ≠ 审稿厂商,双向;同厂商自审在门校验层硬拒 ——
  `codex_review_record.author_family/reviewer_family` 列已备好落点;模板 admission 校验 + 门校验双层。

## B. 业界调研 = ChatGPT Deep Research × 快扫,两份结合(Annie 直令 31f52029)

> **两份来源**:① ChatGPT Deep Research 产品报告(7 分钟 · 21 引用 · 695 搜索,逐字存档
> [[dr-report.md]],18 条 resolved URL)② 4 路并行快扫(12 系统对照官方文档核实,B.1–B.7)。
> 标注:🤝 = 两边独立一致(高置信)· 🔎 = 仅快扫 · 🛰️ = 仅 DR · ⚡ = 有出入/精度差,两边摆出。

### B.0 DR 主报告结论 与 快扫的对照

**四焦点全部 🤝 收敛**:图=声明式 manifest 给引擎执行、图不进模型上下文;凭证=授权+绑内容
digest+使用时服务端核验+subject 变更自动作废(GitHub stale-review / SLSA / Temporal task token
同一课);运行时动态=预声明节点的扇出+选路,**没有任何生产系统支持往在跑的图里插新节点类型**
(DR 原话:did NOT find evidence of a general, supported mechanism),改版=run 钉 manifest 版本;
重试分环境/语义两类,人审门 fail-closed。

**⚡ 一处表述差(两边摆出,合成后一致)**:快扫说「要长久的都走向数据」;DR 更精确 ——
「大多数运行时仍是 graph-as-code,序列化是为控制面/UI/钉版本;数据优先的产品(n8n/Dify/
AutoGen Studio/CrewAI JSON-first)全是配置驱动工具」。合成:**作者面与执行面分开** ——
我们的模板简单、要非工程角色可改、要 per-run 钉版本 ⇒ 直接以 YAML 为作者面 + 引擎持有
节点语义,正是 DR 对我们 shape 的推荐原话:keep the executable workflow as declarative
manifest data, keep step implementations as server-known node types with server-enforced
contracts; do NOT hand the whole graph to any model。

**🛰️ DR 独有增量(已吸收进 plan)**:
1. completion capability 的命名要素 = (run ID, node ID, **manifest version, schema version**,
   git SHA),一次性短时效 —— 比快扫版多了 manifest/schema 版本绑定。
2. 跨厂商互审在引擎侧执行(同 SLSA 只认特定 signer–builder 对),且 **vendor 和 model 标识
   都要记进交接证据**,策略作用在「真正信任的独立性边界」上。
3. 长跑 AI 会话的节点契约 = 「suspendable activity with explicit completion semantics」:
   start policy · cancellation · heartbeat · evidence schema · timeout budget · 兼容包络。
4. 「fail-closed 的框架比想象少」:Prefect pause 超时 FAIL,Airflow HITL 可配默认选项,
   Temporal/Inngest 政策中立 ⇒ **别继承框架默认,把 fail-closed 写进自己的门节点**;
   K8s mutating webhook 甚至有 fail-open 最佳实践 ⇒ per-gate 显式决定,ship gate = fail closed。
5. 反模式五连(与快扫互补):可变的不绑定批准 · 共享密钥当完成凭证 · 跑中改图 · 重试混同 ·
   **policy-in-prompt 而非 policy-in-engine**。

### 以下 B.1–B.7 为快扫底稿(供对照;B.0 为合成结论)

> 覆盖 12 个系统:LangGraph / AutoGen v0.4+ / CrewAI · Temporal / Inngest / Restate ·
> Airflow 3 / Prefect 3 / Dagster · OpenAI Agents SDK / Anthropic 官方模式 · n8n / Dify;
> 外加「授权·过期·内容绑定声明」的行业范式(GitHub branch protection / SLSA+in-toto / Sigstore /
> K8s admission control)。

### B.1 总对比表

| 系统 | 图=数据/代码 | 交接凭证 | 静态+动态 | 人审节点 |
|---|---|---|---|---|
| LangGraph | 代码(StateGraph);DATA 只到 checkpoint 层 | checkpoint 三元组 values/versions/**versions_seen** | 结构 compile 定;Send 动态扇出、Command(goto) 选路 | interrupt() 无限等,**无超时** |
| AutoGen v0.4+ | 代码构建 + **一等 DATA 投影**(component JSON,Studio 同 spec;已进 maintenance mode) | 消息传递,edge 条件= substring 最后一条消息(反模式) | build() 固定;运行时只求值条件 | HandoffTermination:门=正常终止点+外部 resume |
| CrewAI | Crews=DATA-first(crew.jsonc 新默认);Flows=代码 | **guardrail (bool,原因) + 有界语义重试**(默认 3) | 拓扑定义时固定;@router 选路 | human_input 阻塞,OSS 无超时 |
| Temporal | 代码,**服务端 event history 才是权威**(append-only,重放强核对) | **activity task token:一次性、绑 attempt、重试即作废**;4 层 timeout=TTL | patching/worker-versioning/continue-as-new | signal/update + **durable timer** 赛跑 |
| Inngest | 代码;宽松 memoize | 共享 signing key(= 我们今天的病,反面样板) | 容忍式热改(引擎无法为图完整性作证) | waitForEvent(timeout, **if 谓词**)→ null |
| Restate | 代码;journal 权威 | **awakeable:URL 可寻址一次性 resolve/reject 句柄** | **immutable deployment,in-flight 钉出生版本** | awakeable + durable timer |
| Airflow 3 | **代码→序列化 JSON 进 DB,引擎只读序列化物**;run 钉 DAG 版本 | XCom(小元数据);worker 无 DB 凭证(Task Execution API) | 结构固定,mapping 扇出基数动态(≤1024) | **HITLOperator/ApprovalOperator(3.1 一等公民):deferrable+超时落默认选项** |
| Dagster | 代码定义,事件/条件/版本数据化 | **data_version 指纹链 + 非传递 staleness(Unsynced)** | 结构固定,DynamicOut/动态分区 | ❌ 手搓(sensor 轮询) |
| Prefect 3 | 纯运行时代码(反模式:跑前无图可审) | 结果指纹只用于缓存 | 全动态 | **suspend(释放资源)+ 类型化 wait_for_input + 超时 FAIL** |
| OpenAI Agents SDK | handoff=代码注册、对模型呈现为「可走的边的菜单」 | guardrail tripwire;needs_approval 暂停+可序列化 RunState(**无内建超时**) | 边集合固定,模型只能选边 | needs_approval → 序列化状态,宿主补超时 |
| Anthropic 官方 | **workflows(代码编排)vs agents(模型自导)二分;规模化编排官方也搬出模型上下文** | subagent=数据定义(description/prompt/tools/model),context isolation | 五 pattern 全是 code-owned 拓扑 | — |
| n8n / Dify | **workflow=JSON/YAML 文档,引擎执行**(与我们目标同形) | credentials 只引用绝不进 manifest | **draft/published 分离;旧 run 钉旧 typeVersion** | n8n Wait 节点 |

### B.2 焦点 (a) 图=数据还是代码 — 结论

- **凡是需要多进程一致性、UI 渲染、版本化历史的系统,最终都把图变成数据**:Airflow(序列化
  JSON,scheduler/webserver 只读序列化物)、n8n(JSON 文档)、Dify(YAML DSL)、AutoGen
  (component JSON + Studio 同一 spec)、CrewAI(crew.jsonc 成为新默认 —— 它从 YAML/decorator
  迁到 JSON 的轨迹本身就是验证)、Dagster(调度意图 → 声明式条件数据)。
- workflow-as-code 只在接受 determinism/replay 约束时才划算(Temporal);我们不采纳。
- **n8n/Dify 共识三件套**(与我们目标完全同形):① 节点按 (type, typeVersion) **按名引用**,
  行为永远在引擎;② **运行永远针对已发布的不可变快照**,编辑走 draft;③ secrets 绝不进
  manifest,只留引用。—— FLY-1020 PRD §7 的物化 snapshot 正是该形态。
- **Anthropic 自己的话**收束这个问题:workflows = "LLMs and tools orchestrated through
  predefined code paths";大规模编排官方推荐把编排「moves the orchestration into a script the
  runtime executes **outside the conversation context**」—— 图不进模型上下文是 vendor 官方立场,
  不只是我们的红线。

### B.3 焦点 (b) 交接凭证/契约与过期 — 结论(第一章的业界底座)

行业共识形状 = **六要素声明**(与 JWT registered claims 一一对应):

| 要素 | JWT | 业界先例 |
|---|---|---|
| issuer(谁有权发) | iss | CODEOWNERS(具名身份+write 权限)· SLSA builder.id · Fulcio OIDC 证书 |
| audience/scope(供哪个门消费) | aud | attestation predicateType(qa-passed 与 founder-approved 是不同 predicate,不能互换) |
| **subject = 内容 digest** | sub | GitHub check 锚定 commit SHA · attestation subject.digest · **绝不绑 branch name 这类可变引用** |
| expiry/freshness | exp/iat | Sigstore 10 分钟证书 · require-branches-up-to-date |
| **验证在 USE time、服务端、fail-closed** | 服务端验签 | GitHub merge 时服务端强制 · SLSA 部署侧验证 · K8s failurePolicy: Fail 默认 |
| subject 变更即作废 + 防重放 | jti | **dismiss stale approvals when commits affect the diff**(精度:影响 diff 的 push 才作废)· 新 push ⇒ 旧 check 不迁移 |

关键机制:

- **Temporal task token / Restate awakeable = 「一次性、绑到具体一次执行」的完成凭证**:引擎派发
  边时签发,绑 (run, edge, attempt, subject);重派/head 移动 = 新 attempt = 旧 token 服务端拒收。
  这是对「共享 bearer + runner 自报」的**结构性替换**,且不依赖 replay —— 纯服务端签发/核销。
- **Dagster data_version**:`hash(code_version, 上游 data_versions)` 沿图传播;下游记「我实际用过
  的输入版本」,不符 → Unsynced。**staleness 非传递**(只比对实际依据的输入,避免「任何 commit 都
  作废所有证据」的误杀)。⚠️ 反面:Dagster 默认 stale 可自动重算 —— agent 会话不是纯函数,
  我们 stale → **阻断 ship/通知**,重跑走显式 kickback(有界)。
- **LangGraph versions_seen**:每个 gate 记录它批准时「见过的版本」,上游 version bump 即失效 ——
  「QA 证据绑 head」的通用化数据模型。
- 命名反模式:**共享长期凭证当完成证明**(Inngest signing key 形状 = 我们今天的 bug);
  **payload 语义靠客户端自律**(Temporal 不校验 completion payload —— sha==H 必须服务端验证)。

### B.4 焦点 (c) 静态图与运行时改图共存 — 结论

- 业界一致:**结构 manifest/编译期固定,运行时只决定「基数」和「选路」**(Airflow mapping 扇出、
  Dagster DynamicOut、LangGraph Send;conditional edges / @router 选路)。**没有一家做「往在跑的
  图里插入新节点类型」**。
- in-flight run 与图改版共存的正解 = **版本钉住**:Airflow versioned bundles(run 钉创建时刻的
  DAG 版本)、Restate immutable deployments、n8n draft/published + 旧 run 钉旧 typeVersion。
  Inngest 的「容忍式热改」是反例(引擎无法为图完整性作证)。
- → Annie 的顺序判断(静态先行,动态=「换一个生成清单的人」)与业界架构完全一致;
  issue 里 homerail 借来的 inject/fork 概念,业界对应物是「新 revision + run 钉版本」与
  「fork-from-checkpoint」(LangGraph time-travel fork / CrewAI restore_from_state_id:
  **retry 是 fork 不是 mutate**),留 roadmap。
- **已验证锚点 homerail**(Annie 点名,FLY-1020 PRD §5.5 = HL firsthand 读码):它同样分层
  (DAG 模板按名引用 agent、worker 只拿自己的 system prompt 拿不到整图、一节点一容器隔离、
  runtime_profiles 每 agent 绑不同模型与 harness)—— 与本设计逐条同构;唯一不抄的是它把 agent
  定义内嵌进每个 DAG 文件(零跨图复用)。issue 的 inject/fork/profile 三能力即源于它:
  profile 已由 {vendor,model,effort} 承接,inject/fork 留 roadmap(对应上一条的业界形态)。
- ⭐ **cycles-first vs strict-DAG 分派**(Annie 4696188e 拍板站队):LangGraph 显式支持带环图
  (条件边回指上游 = 一等公民);Airflow/Dagster/n8n 是严格无环,**表达不了「QA 打回 implement」**
  —— 打回只能靠外部 re-trigger 整个 run,丢上下文。我们的 QA↔implement kickback 是产品核心路径
  ⇒ **必须选带环派**:模板语言允许声明式回头边(条件 + 出环条件 + 轮数上限 + 超限升级),
  精确说法是「带声明式回边的有向图」——**结构静态、路径动态**(结构+规则事先声明含回环,
  路径运行时按 verdict 走)。

### B.5 焦点 (d) 失败/重试/人审节点 — 结论

- **重试分两种,不可混**:环境错(529/网络)走 infra retry(LangGraph 哲学:只重试环境错,语义错
  重试没用 —— 与 FLY-218/220 教训同向);**语义错走有界 kickback**(CrewAI guardrail:
  (bool, 失败原因) 回喂上游重做,默认上限 3)—— 后者正是我们 QA fail → implement 的形状。
- **人审门的业界收敛形**(Airflow 3.1 HITL + Prefect + Temporal + OpenAI):
  ① deadline 活在**引擎数据库**(durable timer),不在节点进程里;
  ② 等待**释放执行资源**(Airflow deferrable / Prefect suspend —— 我们 FLY-168 mailbox 唤醒已是
  此形态);
  ③ 答复**类型化**(Prefect wait_for_input=PydanticModel;FLY-208 撞过自由文本的墙);
  ④ 超时 **fail-closed 默认**(Prefect 超时 FAIL / K8s Fail;FLY-159 的 48h fail-close 已同向),
  低风险门可显式声明「超时走默认选项」(Airflow 3.1);
  ⑤ AutoGen HandoffTermination 证明:**门 = 正常终止点 + 显式外部 resume**,不是挂着等输入的
  线程 —— 与我们 complete → gate → respond 完全同构。
- **边条件 = 封闭枚举**,不是自由表达式:Airflow 13 个 trigger rules 撑了十年生产;
  Inngest 的 if 谓词展示了「证据必须 sha==H」可以直接写成等待谓词。
  命名反模式:**substring-on-last-message 当控制流条件**(AutoGen)—— 路由绝不 grep 模型的话,
  只认结构化证据。

### B.6 一句话综合

**图结构学 Airflow/n8n(序列化 manifest + run 钉版本 + 枚举边条件),证据/失效学
Dagster/GitHub/SLSA(内容 digest 指纹 + 非传递 staleness + USE-time 服务端验证),凭证学
Temporal/Restate(一次性 task token 绑具体执行),人审门学 Prefect/Airflow 3.1(类型化输入 +
释放资源 + deadline fail-closed)**;12 家的粗粒度 API 信任模型全部弱于我们要建的 per-edge
凭证 —— 这块自研,且红测已把验收线钉死。

### B.7 引用(四路研究 agent 逐条 WebFetch 核实,2026-07-13)

- Airflow:DAG Serialization / Dag Bundles / Dynamic Task Mapping / Trigger Rules / Deferring /
  HITL(3.1)/ SLA→Deadlines / Task Execution API(apache.org 官方文档)
- Dagster:Asset versioning & caching / Declarative Automation / Dynamic graphs / Run retries;
  人审空白见 dagster discussion #15695
- Prefect 3:Deployments / Pause & Resume / Interactive workflows / Caching / Artifacts
- Temporal:workflows / activity-execution(task token)/ detecting-activity-failures(4 timeouts)/
  retry-policies / patching / worker-versioning / continue-as-new / HITL cookbook
- Inngest:how-functions-are-executed / wait-for-event / handling-idempotency / versioning
- Restate:durable_execution / awakeables / versioning(immutable deployments)
- LangGraph:graph-api / persistence / checkpointers(channel_versions, versions_seen)/ interrupts /
  RetryPolicy
- AutoGen:graph-flow / serialize-components / HITL / Studio;maintenance mode 及后继
  Agent Framework(learn.microsoft.com)
- CrewAI:crews(crew.jsonc)/ tasks(guardrail / human_input)/ flows(@persist)
- OpenAI:Agents SDK(python/js)/ guardrails-approvals(needs_approval)/ Swarm deprecation
- Anthropic:Building Effective Agents / Agent SDK subagents(Workflow tool)
- 声明范式:GitHub about-status-checks / about-protected-branches(dismiss stale approvals)/
  CODEOWNERS;SLSA provenance v1;in-toto attestation spec;Sigstore security model;
  K8s dynamic admission control(failurePolicy: Fail 默认)
