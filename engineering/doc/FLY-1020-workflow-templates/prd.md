# FLY-1020 每类任务的 workflow 模板(三层动态 DAG)— PRD(非 UI 部分)

Issue: FLY-1020 (https://linear.app/geoforge3d/issue/FLY-1020/low-level-dag-per-task-category-workflow-templates-lightoverridable)
日期: 2026-07-08
基于: `product/doc/FLY-1020-workflow-templates/design-source.md` + co-eval HTML v6(Annie 拍板)+ `agentmd-vs-dag.html`(§2 深挖,Annie converged)· Codex design-review R1→R3
Status: **Codex APPROVED**(6 轮:R1 10 项 + R2 5 项 + R4 7 项 + R5 3 项 findings 全采纳;R3 与 R6 APPROVED。R6 两处非阻塞引用清理已折入)

> co-eval 收敛后的**建造蓝图**。放**结论 + 机制**(eng 照着能建),不堆 Q&A;过程在 design-source.md。
> **UI / dashboard 不在本 PRD** —— 拆到 **FLY-1038**(§12)。

---

## 1. 背景与目标

Annie 的**两层 DAG**(FLY-1004):第二层 = 高层编排引擎(**FLY-353**,决定做哪些 issue)· 第一层 = **本 issue**(选中后**怎么跑**)。

**目标**:把今天**唯一一个写死的 eng 三段式**,升级成**每类任务一套、可覆盖的模板**,由**三层定义**描述。

**红线(Annie)**:模板**轻 / 默认 / 可覆盖**,不是紧身衣。只钉粗脚手架(哪些节点 / 每节点哪个模型 / 哪 loop / 哪 skip),**不定节点内部怎么想**。价值在治理(成本、独立 QA、gate 落点、context 隔离、可观测),**不在把模型推理钉死**。

---

## 2. 现状(核过码 · 已按 Codex R1/R2 更正)

### 2.1 今天有什么

| 能力 | 今天 | 证据 |
|---|---|---|
| 类别 → 谁跑 | label → agent/Lead。**只决定 who,不决定 workflow shape** | `AgentDispatcher.ts:215` |
| workflow 形态 | **一个写死的三段式**(静态线性) | `three-stage-phases.ts:37` |
| loop | **焊死 1 个**:QA fail → 唤醒 parked implement | `phase-orchestrator.ts:1087` |
| skip / per-category 模板 / 节点注册表 | **全无** | grep 无 `taskCategory`/`templateRegistry`/`loop_when` |
| Markdown 技能 | 已在 | `~/.claude/commands/*.md` + skills |

### 2.2 `three-stage-phases.ts` 拥有的远不止 model(R1#2)

它同时是以下**全部**的单一真相源:`ThreeStagePhase` 类型(`:35`)· 固定序列(`:37`)· `isThreeStagePhaseRole`(`:48`)· **`resolveCompletionSessionRole`**(`:77`)· `nextPhase`(`:107`)· `PHASE_THREAD_BADGE`(`:113`)。
→ 只迁 `DEFAULT_PHASE_TIER` **不够**,会留下旧序列做事实上的真编排。

### 2.3 `design|implement|qa` 硬编码贯穿多个生产面(R1#1/#6)

| 面 | 硬编码点 |
|---|---|
| 持久化 | `StateStore.ChatThreadRole` 固定四值(`:258`);phase query `IN ('design','implement','qa')`(`:2576`);**`session_params` 是 per-execution row**(`:3168`,`:3202`) |
| 展示 | `issue-display.ts` 从 `THREE_STAGE_PHASE_SEQUENCE` 渲染(`:16`,`:214`) |
| ship 收尾 | `post-ship-finalization.ts` 只关 parked design/implement(`:205`) |
| retry | `actions.ts` 只读 durable `chat_thread_role` 重解 model;**`shareParentBranch` 明确未传播**(`:852`,FLY-840) |
| 执行边界 | handoff **起新 execution**(`phase-orchestrator.ts:1426`);retry **派生后继 execution**(`actions.ts:840`) |
| 双 sink | `DirectEventSink` + `event-route` 都触发 auto-QA / handoff / turn-belt(`DirectEventSink.ts:748`,`event-route.ts:2035`) |
| 启动对账 | 重放 stranded design/implement + QA verdict(`StateStore.ts:2413`,`:2433`) |

### 2.3b ⚠️ 「新增一个节点角色」的**完整**成本面(R4#3 —— 比原稿列的 5 处更多)

| # | 面 | 硬编码点 |
|---|---|---|
| 1 | `ChatThreadRole` 枚举 | 固定 `"main"｜"design"｜"implement"｜"qa"`;**未知 role 静默归一成 `main`**(`StateStore.ts:263`,`:276`) |
| 2 | phase / active 查询 | 只含三角色(`StateStore.ts:2549`,`:2576`,`:2659`) |
| 3 | phase-thread 反查 | 未知存储 role **又被归一回 `main`**(`StateStore.ts:4137`,`:4147`) |
| 4 | issue 展示 | 从 `THREE_STAGE_PHASE_SEQUENCE` + `PHASE_THREAD_BADGE` 派生(`issue-display.ts:16`,`:153`,`:214`);refresher 走三角色查询(`issue-display-refresher.ts:254`,`:618`) |
| 5 | **TURN recovery 优先级** | 硬编码 `qa` → `implement` → `design`(`phase-orchestrator.ts:162`;候选过滤 `:1560`,`:1567`) |
| 6 | completion sinks | 只保全三段式 role(`resolveCompletionSessionRole`,`three-stage-phases.ts:77`;`event-route.ts:1088`;`DirectEventSink.ts:612`) |
| 7 | ship 收尾 | 只关 parked design/implement(`post-ship-finalization.ts:205`) |
| 8 | retry / 启动对账 | `actions.ts:852`;`StateStore.ts:2413`,`:2433` |

> ⚠️ **静默归一是数据损坏陷阱**:第 1/3 项把**未知 role 悄悄变成 `main`**。若 `generic` 节点被当成新 role 落库而未先扩枚举,它会**静默退化成 main session**,带着 main 的 PR/ship 语义 —— 不报错、行为全错。**任何 node-id 落库都必须 fail-closed,不得静默归一。**

### 2.4 Auto-QA 是 **default-ON opt-out**(R1#4 —— 原稿此处写错)

优先级链(`auto-qa-policy.ts:8-13`,fail-safe):`FLYWHEEL_AUTO_QA=0` → `no-qa` label → qaConfig **malformed(fail-closed)** → `qa.auto:false` → `skip_labels` → 否则 **ON**(FLY-752 fleet-wide default-on)。

> **doc drift(顺手修)**:`types.ts:616` 注释仍写 `qa` "Absent or auto:false = off",与 `QaConfig`(`:228`)自述的 default-on 矛盾。

### 2.5 ⚠️ ship gate 是 **per-execution** 的,且模板 QA 不写 `auto_qa_record`(R2#2 —— **会死锁**)

- `onMainAwaitingReview` **仅处理 `session_role === "main"` 的行**(`auto-qa-coordinator.ts:306`,`:323`);两个 sink 也只对 main 行调用它(`DirectEventSink.ts:755`,`event-route.ts:2015`)。
  → **templated product run 的可评审 phase 是 `implement`,不是 `main` ⇒ 该 hook 永不触发。**
- `evaluateQaShipGate`:`qa_required=1` ⇒ **必须**存在该 head 的 passed `auto_qa_record`(`ship-eligibility.ts:114`,`:185`)。
- 但三段式内部 QA PASS **只写 `three_stage_verdict`**,不写 `auto_qa_record`(`phase-orchestrator.ts:929`)。

→ 复用 `qa_required` 会**永久死锁 ship gate**。§8 据此重写。

### 2.6 QA loop 还有第二个触发形态:founder-feedback kickback(R2#4)

QA PASS 打开 approve gate 后,**founder/Lead 的反馈**在窄条件下被当作 FAIL kickback,绕过「已记录 PASS」守卫、路由回 implement(`phase-orchestrator.ts:804`,`:817`,`:860`;`Blueprint.ts:1020`)。守卫:**keep-alive ON only** · QA session 位于 `awaiting_review` · runner-driven review evidence 存在 · gate response 已记录 · **QA 永不改代码**。

### 2.7 ⭐ Runner `agent.md` 是**纯提示词文本**,其 frontmatter 在**派发路径上 inert**(§5 的基础)

**精确表述(R4#1 收窄 —— 不要说「全仓无 frontmatter 解析器」,那是假的)**:

> **没有任何 Runner `agent.md` 派发路径消费它的 `model:` / `skills:` / `permissionMode:` frontmatter。**

逐条证据:

| 断言 | 证据 |
|---|---|
| agent.md 当**纯文本**注入 | `Blueprint.ts:1602`/`:1606`(`agentContent.slice(0, 40_000)` → `## Agent Role`)+ `:1631`(其后追加常规 baseline prompt) |
| `permissionMode` 是**硬编码**的 | `Blueprint.ts:1676`(`bypassPermissions`) |
| model **不来自** agent.md | `Blueprint.ts:1686` 取 `ctx.runnerModel`;`resolveRoleAdapter()` 从 label / dispatch model / project roles / env / 默认解析(`role-adapter-resolver.ts:165`,`:173`,`:197`,`:206`,`:218`) |
| `AgentDispatcher` 只做路由,不读 model/能力 | `AgentDispatcher.ts:31`,`:215`;类型 `AgentConfig` 只有 `agent_file` / `domain_file` / dept metadata / `match`,**无** `model`/`skills`/capability 字段(`types.ts:123`) |
| skills 来自**固定模板注入**,不是 per-agent frontmatter | `SkillInjector.ts:23` |

> **反例澄清(R4#1)**:仓库里**确实存在** frontmatter 解析 —— 例如 Codex Lead persona 加载会 strip YAML frontmatter(`codex-lead-runtime.ts:1017`,`:1028`)。那是**另一条路径**(Lead persona,非 Runner agent.md 派发),**不影响**上面的安全性质。本 PRD 只主张 Runner 派发路径。

→ **今天的代码里,Runner 的 agent.md 只能表达「我是谁」;模型 / 技能 / 能力只能来自它之外。** 这是 §5 分层契约与其安全性质的**事实基础**。

---

## 3. ⭐ MVP 范围决策(R1#1/#10 + Annie converged)

**问题**:`design|implement|qa` 硬编码在 §2.3b 的 **8 个生产面**。「支持任意新节点类型」与「抽象化现有三段式」若塞进同一 MVP,会漏掉整片生产生命周期面。

**但 Annie 的收敛给出了更好的解**(§5):**不需要开放任意节点类型 —— 加一个「通用节点」即可**。

| | MVP(本轮验收) | 阶段 2 / 可能不需要 |
|---|---|---|
| 节点类型 | **内建 `design` / `implement` / `qa`** + ⭐ **`generic`(agent.md-参数化)** | 任意**具名**新节点类型(`research` / `generate_video` …) |
| 成本 | 引入 `generic` = **一次性**建起 §3.1 的 **node-id 生命周期 substrate**(把 §2.3b 那 8 个面从「三值硬编码」扩成 node-id 感知) | 每加一个具名类型 = **再付一次** per-type 的账 |
| 扩展方式 | 非工程师**写一个 agent.md + 挂 `generic` 节点** → **零代码** | 需改代码 |

**结论(这也是「为什么不开放任意节点类型」的准确答案)**:不是「不能扩展」,而是**成本形状不同**。`generic` 是**更便宜、更安全**的扩展路径 —— 一次性付账,之后任何人靠 agent.md 零代码扩展。**具名任意节点类型因此在 MVP 之后大概率也不必做。**

### 3.1 ⚠️ `generic` 进 MVP 的**前置条件**(R4#3/#5/#6 —— 不满足就不许开跑)

`generic` **不是一个便宜的参数化节点**。它引入了「非三段式的 workflow 节点角色」,必须先有 **substrate**:

1. **node-id 生命周期 substrate**:明确**哪个 DB/session 字段承载 node-id**(建议:新增 `workflow_node_id`,与 legacy `chat_thread_role` **并存且解耦**);legacy 三角色**逐字兼容**;**未知 node-id 一律 fail-closed,绝不静默归一成 `main`**(§2.3b 陷阱)。覆盖:role 枚举 / phase-active 查询 / 反查 / 展示 + refresher / **TURN recovery 优先级** / completion sinks / marker replay / finalizer / retry / 启动对账。
2. **generic 的 output / completion 契约**(§5.6)。
3. **Blueprint capability 门控先落地**(§5.7):否则 `generic` 会**继承默认的 implement/PR/approve 提示词**(`Blueprint.ts:1031`,`:1041`)。

> **顺序硬约束**:上面三条属于 §14 的 **Gate A(substrate)**;`generic` 的任何 dispatch 必须在 Gate A 之后。

---

## 4. 三层架构

```
第一层 · YAML          = DAG 形状:哪些节点 / 顺序 / loop / skip(按名引用)         【新增】
        ↓ 节点按名引用
第二层 · 节点类型注册表  = 每节点「是什么」:model + skills + prompt + 展示 + 能力    【新增,泛化 three-stage-phases.ts】
        ↓ 技能 / 角色按名引用
第三层 · Markdown       = 每个技能怎么做 + 每个角色是谁:skill .md / agent.md      【今天这套,不变】
```

**关键原则**:YAML + 注册表 = **加在现有 Markdown 之上的编排层,不替代 Markdown**。**新增只在上两层。**

### 4.1 第一层 — YAML(DAG 形状)

```yaml
# templates/eng.yaml   (core-shipped)
schema_version: 1
nodes:
  - { id: design,    type: design }
  - { id: implement, type: implement }
  - { id: qa,        type: qa }
edges:
  - design    -> implement
  - implement -> qa
  - qa -> implement  {loop_when: [qa_fail, founder_feedback_kickback], max_iterations: <N>}
skip:
  - qa {when: template == product}
```

**加载与校验**:
- 从项目 **canonical / mainline root** 加载,**绝不**从实现 PR worktree(同 `three-stage-policy.ts:21`、`auto-qa-policy.ts:17`)。
- **tri-state**:absent → OFF(字节兼容)· malformed → **project fail-closed + 大声报错**(不 crash 整 Bridge,mirror `ConfigLoader.ts:380`)· present+valid → ON。
- `schema_version` 必填;**unknown key → reject**;external refs 必须在 canonical root 内(**路径逃逸拒绝**)。
- **引用完整性 + schema 规则(R4#7)**:
  - 每个节点的 `type` 必须在注册表有定义;
  - **节点 `id` 全局唯一**;edge 的 source/target、skip 目标、loop 边两端**都必须是已声明的 `id`**;
  - **每条 loop 边有唯一 `edge_id`**(snapshot 的 `loop_counters` / `current_node_id` 按 id 索引,避免歧义);
  - **`agent_file` 仅 `type: generic` 允许且<u>必填</u>;core 节点类型(design/implement/qa)带 `agent_file` → reject**。

### 4.2 第二层 — 节点类型注册表(行为 + 能力)

**必须覆盖 `three-stage-phases.ts` 今天的全部职责(§2.2)**,否则旧序列继续做真编排。

| 字段 | 今天在哪 |
|---|---|
| `id`(类型名) | `ThreeStagePhase` |
| `model` | `DEFAULT_PHASE_TIER` |
| `skills` | 无(新增,→ 第三层 skill .md) |
| `prompt` | 散在 `Blueprint.ts` 的 `isDesignPhase/isImplementPhase/isQaPhase` 分支 |
| `badge` / display metadata | `PHASE_THREAD_BADGE` |
| `is_phase_role` | `isThreeStagePhaseRole` |
| `preserve_completion_role` | `resolveCompletionSessionRole` |
| `next_resolver` | `nextPhase`(改为按 YAML edge) |

⭐ **节点能力(capabilities,R1#7)** —— 缺了会让 product/generic 节点误继承 implement/land/approve 行为:

`shared_branch_writer` · `creates_pr` · `can_ship` · `approval_gate_holder` · `needs_review_evidence` · `can_land` · `needs_mailbox_transport` · `keepalive_park` · `qa_verdict_emitter`

**实现落点**:新建 `packages/config/src/node-type-registry.ts`;Blueprint 改读 capability 而非 `sessionRole` 硬分支。**`design/implement/qa` 三条条目与今天行为逐字等价**(reverse-compat sentinel)。

### 4.3 第三层 — Markdown(不变)

- `skills:` 解析到**现有** skill / command Markdown。
- `agent_file:`(仅 `generic` 节点)解析到**现有 agent.md**。
- **本 PRD 不改任何 Markdown 文件。**

---

## 5. ⭐ DAG ↔ agent.md 对齐(分层契约,Annie converged)

### 5.1 三条分层契约

1. **agent.md = 角色原子(WHO),Claude 原生。** 一段角色提示词。**不挂 DAG 的活 = 一个 agent.md 跑一个 session** —— 这是默认,永远保留(§11 红线 4)。
2. **DAG = 引擎内的可选编排层(HOW MANY / WHICH STEP)。** 引擎读 DAG 决定跑哪个节点;**DAG 永不交给 Claude**。每一步只把**一个 agent.md 的角色文本**交给 Claude。Claude 从头到尾不知道有图。
3. ⭐ **通用节点 = 参数化跑任意 agent.md 的节点。** 非工程师写一个 agent.md,挂 `generic` 节点,即可进 DAG,**零代码**。

**为什么必须有引擎层(决定性论证)**:一个正在运行的 Claude session **物理上无法给自己换模型**,也**无法开一个看不见自身上下文的隔离 session**。而 Annie 引入 DAG 的两个理由恰恰是:① 不同步骤用**不同模型**(设计 Fable / QA Opus)② 写与验必须**隔离防 bias**。→ **这两件事只能由 Claude 之外的一层做。这就是 DAG 存在的唯一理由 —— 不是为了管模型怎么想。**

### 5.2 分层不是提案,是**代码现状**(§2.7)

`readAgentFile` 纯文本注入 + **没有任何 Runner agent.md 派发路径消费其 frontmatter**(§2.7 精确表述,非「全仓无解析器」)⇒ Runner agent.md 的 `model:`/`skills:`/`permissionMode:` **在派发路径上 inert** ⇒ **agent.md 天然只承载 WHO;模型/技能/能力只能来自注册表。** 本 PRD 只是把「另一层」显式化为一等公民。

### 5.3 ⭐ 由此得到的**物理安全性质**

因为 frontmatter inert:**用户(非工程师)编写的 agent.md 物理上无法给自己授予** `can_ship` / `can_land` / `creates_pr` / `approval_gate_holder`,**也无法自选模型**。这些只在 **core-shipped 注册表**里。

> **扩展性给出去了,权限没给出去。** 这不是靠约定,是靠「没有代码去读那些字段」。

### 5.4 通用节点(`generic`)规格

```yaml
# 模板里:节点实例 = {id, type, [agent_file]}
nodes:
  - { id: curate, type: generic, agent_file: agents/content/xhs-curator.md }
```

| 项 | 规则 |
|---|---|
| `agent_file` | 相对 **canonical root**。**MVP 用一个<u>严格 loader</u>**(见下),不是现有 `readAgentFile`。 |
| prompt | **只**来自 `agent_file` 的文本(沿用 40k 截断) |
| `model` | 来自注册表 `generic` 条目,或模板 per-node override。**绝不**来自 agent.md |
| capabilities | **由 core registry 的 `generic` 条目钉死**。MVP 保守默认:`shared_branch_writer=false` · `creates_pr=false` · `can_ship=false` · `can_land=false` · `approval_gate_holder=false` |
| skills | 来自注册表 `generic` 条目 |

⚠️ **严格 loader(R4#4 —— 不能直接复用 `readAgentFile`)**:现有 `readAgentFile` 的容器检查(拒绝绝对 / `..` / symlink 逃逸,`Blueprint.ts:1971`-`:1998`)可复用,**但它对不安全/不存在的文件返回 `null`,而现调用方是 warn + fallback 到通用 implement 提示词**(`Blueprint.ts:1624`)—— 这**违反** `generic` 要求的 fail-closed。所以 workflow `generic` 走一个**独立严格入口**:容器检查同款,但 **`null` → 拒绝该 run/config admission,绝不 fallback**。

⚠️ **内容寻址,防 TOCTOU(R4#4)**:snapshot 必须存**已读入的 agent.md 内容本身**(或**内容寻址 blob**),**不能**只存「canonical 路径 + `agent_file_hash`」—— 否则后续 phase 重读路径时文件可能已变(TOCTOU)。§7 据此收紧。

### 5.6 ⭐ `generic` 的 output / completion 契约(R4#2 —— 缺了不许进 MVP)

现有 completion 是**路由制、硬编码**:`flywheel-comm complete` 只认 `auto_approve` / `needs_review` / `blocked` / `no_code` / `pr_handoff` / `phase_design_complete`(`complete.ts:30`,`:101`);两个 sink + marker reconciler 镜像这套(`event-route.ts:832`,`DirectEventSink.ts:355`,`complete-marker-reconciler.ts:78`)。**`generic` 节点今天没有「怎么产出、下游怎么读」的定义。**

**MVP 契约(read-only / doc-producing generic)**:
- `generic` 节点经**已有的安全 route** 收尾:**默认 `no_code`**(已认可 route,marker 可 replay,`complete.ts` + `complete-marker-reconciler.ts:74-82`;不写共享分支、不开 PR)。
- 产出落 **`workflow_node_outputs[node_id]`**,**下游节点从这里读**,不经 PR/branch。

⭐ **生产者 / 写入 / replay 契约(R5#1 —— 补齐;不能靠 completion payload)**:
- **写入通道独立于 `complete`**:今天 `complete` 的 payload 只有自由字段 `summary`(`complete.ts:72`/`:172`-`:178`),**塞不下结构化 node output**。因此 `generic` 节点用**一条专门的 runner→Bridge 写入**(新 `flywheel-comm workflow-output --node-id <id> --payload <...>`,或 mailbox 事件),把结构化产出写进 **issue-level `workflow_node_outputs[node_id]`**(与 snapshot 同处、issue 为主键、带 `workflow_run_id`)。
- **顺序 = 先写产出、再 `complete`**:runner 先写 `workflow_node_outputs`,**成功后**才 `complete --route no_code`。Bridge 侧 **completion 前校验**:声明了 output 的 generic 节点若无对应 `workflow_node_outputs[node_id]` → **fail-closed**(不推进 handoff)。
- **replay(crash 安全)**:`workflow_node_outputs` 是 issue-level 持久态,**不依赖在途事件**;Bridge 重启 / marker replay 时,下游节点从持久表读,**与 completion marker 解耦**(completion marker 只推状态,不承载 output —— 正是 R5#1 指出的:双 sink + marker 只能推状态)。
- **幂等**:`workflow_node_outputs[node_id]` 按 `(workflow_run_id, node_id)` upsert;重复写覆盖同一 key,不产生歧义。

- 若某模板确实要 `generic` 往共享分支写 doc/证据 —— 那 `shared_branch_writer=false` 就是错的默认,**必须在该模板实例显式声明能力** + 给它 writer 的 output route。MVP 只交付 **read-only / no_code 形态**;shared-branch generic = 阶段 2。

注册表 / snapshot 因此需字段:`completion_route`(默认 `no_code`)· `output_mode`(如 `node_output_payload`)· `output_visibility` · `produces_output`(bool,用于 completion 前的 output-present 校验)。

### 5.7 ⭐ Blueprint capability 门控**必须先于** `generic` dispatch(R4#5)

今天 Blueprint 只认 `ctx.sessionRole === "design"|"implement"|"qa"`(`:913`,`:917`,`:927`);**其它一切都拿默认的「建分支 / commit / push / 开 PR」实现提示词**(`:1031`)+ merge/approve/land 规则(`:1041`,`:1348`,`:1459`)。→ 若 `generic` 在 Blueprint capability 重构**之前**就能被 dispatch,它会**继承 implement/PR/approve 行为**,与 §5.4 的保守能力**直接冲突**。

**硬约束**:capability-driven 的 Blueprint prompt 重构属于 §14 **Gate A**,**必须先于**任何 `generic` dispatch。第一条 generic sentinel(S13)即断言:**全 write/ship capability=false 的 generic 节点<u>不</u>收到 branch/PR/approve/ship 指令,且有明确的 completion 命令。**

**成本更正(R4#3)**:引入 `generic` 的一次性账 = §2.3b 的 **8 个生产面**(不是原稿说的 5 个)—— 尤其含 **role 枚举的 fail-closed(不静默归一)、TURN recovery 优先级、completion-route 映射**。**付一次 substrate,之后任何 agent.md 零代码可用。**

### 5.5 homerail firsthand 佐证(clone 读码,非二手)

我们独立 clone 了 `github.com/xiaotianfotos/homerail` 读源码。**它也是分层的**,且证据支持上面每一条:

| 我们的契约 | homerail 的实现(读码所得) |
|---|---|
| 节点 ≠ agent,节点**引用** agent | DAG 模板中 `nodes: {draft: {agent: drafter}}` —— 按名字引用 |
| **DAG 永不甩给模型** | `homerail_worker/src/index.ts`:`systemPrompt = agentConfig.system` —— worker **只拿到自己那个 agent 的 system**,拿不到整张 DAG |
| **防 bias = 结构隔离** | 一 DAG node 一 Docker 容器(`createWorkerContainer`) |
| **多 model 需要独立于角色的一层** | `runtime_profiles` / profile 文件:`default: {model_alias: local-qwen, agent_type: claude-sdk}`;`agents: {reviewer: {model_alias: kimi-main, agent_type: kimi_code}}` —— 不同 agent 绑不同模型**与不同 harness** |

**⚠️ 一处我们不抄(且它正是「DAG 取代 agent.md」的反面实证)**:homerail 把 **agent 定义内嵌进每个 DAG 文件**。三个 shipped 模板中 **`agents` 数 == `nodes` 数(1/1、5/5、2/2)**,**零跨 DAG 复用**;全 repo **没有独立可复用的 agent.md 等价物**。
→ **我们保留独立、可复用的 agent.md(一个角色写一次,任何 DAG 引用),优于 homerail。**

---

## 6. 动态语义:loop + skip

### 6.1 loop —— MVP = 把**现有 QA loop 配置化**(R1#3 + R2#4)

现有 FLY-939 loop 已具备:持久化 `three_stage_verdict` intent 供 crash replay(`:83`)· 修复轮次上限(`:993`,`:1111`)· 先 capture QA head SHA(`:1007`,`:1122`)· keep-alive 下 wake parked implement + worktree readiness + grant TURN(`:1140`,`:1156`)· ghost-guard(`:1197`)。

**条件源(受限枚举,不引入自由表达式)**:
1. `qa_fail` —— QA verdict FAIL。
2. ⭐ `founder_feedback_kickback` —— **必须保留**(§2.6),loop 解释器须**逐字保留其守卫**。

**每条 loop 边必须声明/满足**:

| 项 | 要求 |
|---|---|
| idempotency key | `(execId, edge_id, iteration)` 唯一 |
| `max_iterations` | **必填**;达上限 → **fail-closed 升级给人** |
| round ledger | 每轮持久化(复用 `three_stage_verdict` intent),支持 crash replay |
| head capture | 回边前 capture 上游 head SHA |
| wake vs spawn | keep-alive ON → wake parked 节点(worktree readiness + grant TURN);OFF → respawn |
| TURN ownership | 单一 writer;ghost-guard 拒重复 writer |
| startup replay | 启动对账能重放未完成轮次 |
| wake 失败 | **fail-closed**(升级) |

**MVP 只交付 `qa -> implement` 这一条被配置化的边**。任意 loop 边 = 阶段 2。

### 6.2 skip —— 条件跳过节点

- 该节点**不 dispatch**,控制流跳到下游。
- 条件域**受限枚举**:`template == <id>` 与内建 label(如 `trivial`)。
- **skip 不只是「不 dispatch」** —— 必须同时写 ship-gate 证据(§8)。

### 6.3 明确不做(MVP)

跑中 **node-inject** · **fork**。→ roadmap(§10)。

---

## 7. ⭐ 物化 workflow snapshot(R1#5 + R2#1)

**问题**:`session_params` 是 **per-execution row**;handoff **起新 execution**;retry **派生后继 execution**。仅存 `template_id + hash` 不足以让 handoff/retry/对账「一律读快照」。

`workflow_snapshot` payload(入口解析后**物化**):

| 字段 | 内容 |
|---|---|
| `nodes[]` | **归一化节点实例**(id + type + 生效的 model / capability / badge;⭐ `generic` 节点含**已读入的 agent.md 内容本身,或内容寻址 blob** —— **不是** canonical 路径 + hash,防 TOCTOU,R4#4) |
| `workflow_node_outputs` | 每个节点的结构化产出(§5.6;下游节点从此读,不经 PR/branch) |
| `edges[]` | 已解析的边(含 loop 边 id + 条件源 + `max_iterations`) |
| `skip[]` | skip 决策(或足以重算的输入) |
| `overrides` | 本 run 的 per-run override |
| `loop_counters` | 每条 loop 边的 iteration ledger |
| `current_node_id` / `edge_state` | 当前进度 |
| ⭐ `workflow_run_id` | 本次 workflow 运行的判别符(或 `root_execution_id` + generation) |
| `template_hash` / `registry_hash` / `agent_file_hash` | **仅供审计/漂移检测**,不作运行依据 |

**传播契约**:
- **copy-forward 到每一次**:phase handoff 新 execution · QA loop 的 wake/spawn · retry 后继 execution。
- **issue-level 权威副本**(execution row 上是 copy),供 startup reconcile / post-ship finalization 在无活 execution 时读取。
- **handoff / retry / startup reconcile / post-ship finalization 一律读快照**,绝不中途按 live label/config 重解图形状。
- **live kill-switch 仍可阻止新的 dispatch**,但不改变已在跑的图。
- ⭐ `workflow_run_id` 判别符:同 issue 上**旧 workflow 尝试**的在途事件必须被挡下,不得误读最新 snapshot。
- 修复 retry 的 `shareParentBranch` 传播缺口(FLY-840)。

---

## 8. ⭐ Ship-gate 证据模型 与 Auto-QA 边界(R2#2/#3)

### 8.1 事实约束(§2.5)

`onMainAwaitingReview` 仅对 `main` 行生效 ⇒ templated run **永不触发它**;`evaluateQaShipGate` 在 `qa_required=1` 时索要 passed `auto_qa_record`,而模板内部 QA 只写 `three_stage_verdict` ⇒ **复用 `qa_required` 会死锁**。

### 8.2 决策:ship gate 增加 **workflow-aware 分支**(遗留路径逐字不变)

```
evaluateShipEligibility(exec):
  if exec 有 workflow_snapshot:   → 读 workflow QA 证据(§8.3)      # 新分支
  else:                           → 现有 qa_required / auto_qa_record  # 遗留,byte-compat
```

### 8.3 workflow QA 证据

| 字段 | 写入者 | 语义 |
|---|---|---|
| `workflow_qa_required` | **入口**(snapshot 是否含 QA 节点决定) | 1 = 必须有内部 QA 通过证据 |
| `workflow_qa_passed` | **QA 节点 PASS 时**(扩展 `phase-orchestrator.ts:929`),**绑 head SHA** | 内部 QA 已通过该 head |
| `workflow_qa_exempt` | **入口**(模板 `skip qa` 时) | 本 run 免内部 QA |

- **eng templated**:`workflow_qa_required=1`;QA PASS 写 `workflow_qa_passed`(绑 head)→ 放行。head 变更 ⇒ 证据失效。
- **product templated(skip qa)**:入口写 `workflow_qa_exempt=1` → 放行。**不依赖 `onMainAwaitingReview`**。
- **独立 spawn 的 Auto-QA**:对 **templated run 一律 exempt**。遗留路径 Auto-QA **逐字不变**。

⭐ **`workflow_qa_passed` 的 head 必须是权威 head(不得信 runner 自报)**:PASS 分支今天不 capture head;`qa-result` 的 `prHeadSha` 默认取 **QA runner 自己的 git HEAD**(`qa-result.ts:41`,`:119`)。实现须 **(a)** 服务端用 `capturePhaseHeadSha` 抓,或 **(b)** 校验 runner 上报值与服务端 capture 一致后才写。**缺失/不一致 → fail-closed**。后续比对对齐 `evaluateShipEligibility` 已收到的 `prHead`(`ship-eligibility.ts:266`)。

### 8.4 三个正交控制面(R2#3)

| 控制面 | 开关 | 管什么 | 不管什么 |
|---|---|---|---|
| 模板层 | workflow-template enable + kill-switch env | 是否启用模板、图形状 | 不改独立 Auto-QA 策略 |
| 独立 Auto-QA | `FLYWHEEL_AUTO_QA=0` / `qa.auto` / `skip_labels` | **仅**独立 spawn 的 QA runner | **不**改变模板内部 QA 节点 |
| ship-gate 执行 | ship-gate QA-done 开关 | gate 是否强制 QA 证据 | 不决定谁跑 QA |

`no-qa` label 若意图跳过**内部** QA 节点,它是 **per-run workflow override**,须走与 `skip qa` **同一路径**(写 snapshot + `workflow_qa_exempt`),不得静默绕过。`malformed` 仍 **fail-closed**。

### 8.5 startup backfill

`auto-qa-coordinator.ts:1523` 的 backfill 必须**识别 templated run**(读 snapshot),不给它们补独立 QA。

---

## 9. 配置 schema 与加载(R1#8)

```yaml
pipeline:
  workflow_templates:
    enabled: false            # 默认 false(字节兼容)
    default: null             # 未匹配类别的默认模板 id(null = 裸 session)
    files: [templates/eng.yaml, templates/product.yaml]   # canonical-root 相对
  node_type_registry:
    file: templates/node-types.yaml
```

- **tri-state**:absent → OFF(今天行为逐字不变)· malformed → **project fail-closed + 大声报错** · present+valid → ON。
- `schema_version` 必填;**unknown key → reject**;**路径逃逸拒绝**(含 `generic` 节点的 `agent_file`);kill-switch env。
- **顺手修 doc drift**:`types.ts:616` 的 `qa` 注释改为反映 FLY-752 的 default-on(§2.4)。

---

## 10. 分阶段

- **阶段 1(MVP,本 PRD 验收)**:YAML 结构 + 节点类型注册表(含 capabilities)+ 内建三节点 **+ `generic` 节点(agent.md-参数化)** + `skip` + per-node model override + **现有 QA loop 配置化(含 kickback)** + **物化 workflow snapshot** + **workflow-aware ship gate** + Auto-QA 边界 + core-shipped 模板(eng / product / 裸 default)+ 可覆盖。**第三层 Markdown 不动。default-off、字节兼容。**
- **阶段 2(大概率不必做)**:任意**具名**节点类型 + 任意 loop 边。—— `generic` 已覆盖绝大多数扩展需求(§3)。
- **roadmap(post-MVP,进后续 PRD)**:**node-inject**(跑中加节点,用例:implement 中途加「安全审计」)· **fork**(并行试多方案 / A/B)。
- **不做**:可视化编辑器(→ FLY-1038)· 学历史自动调模板。

---

## 11. 红线守卫(可验收)

1. MVP 只提供 **core-shipped 模板与节点类型**;项目只能 select / override / opt-out。
2. **用户可通过「写 agent.md + 挂 `generic` 节点」扩展<u>角色</u>(零代码);但不能定义新<u>节点类型</u>、不能自授<u>能力</u>、不能自选<u>模型</u>** —— 这不是靠约定,是 §5.3 的**物理保证**(没有代码去读 agent.md 的 frontmatter)。
3. 节点内部推理**不被模板约束**(第三层 Markdown + 模型决定)。
4. 不挂模板 = **裸单 session**(永远留着「不套流程」的出口)。
5. loop / skip 条件域**受限枚举**,不引入自由表达式 DSL。
6. **DAG 永不交给 Claude**:每个节点只把**一个 agent.md 的角色文本**交给它。

> **「为什么不开放任意节点类型」的准确答案**:不是不能扩展,是**成本形状**不同 —— 任意具名类型 = **per-type** 付 §2.3b 那 8 个面的账;`generic` 节点 = **一次性**建 substrate,之后任何 agent.md 零代码可用,**且天然更安全**(§5.3)。

---

## 12. 超范围 / cross-ref

- **UI / dashboard → FLY-1038**(管理用:有哪些 DAG + 注册到哪个 instance;**非** runtime 监控)。本 PRD 的 YAML/注册表是其数据源。
- **第二层引擎 → FLY-353**(本层模板的消费方)。
- **Scale → FLY-1022**。

---

## 13. 验收标准

1. 一份 YAML + 注册表可声明 eng 三段式(含配置化 `qa→implement` loop)与 product 短模板(`skip qa`),**行为与今天逐字等价**。
2. 配置化 loop:`max_iterations` 生效、达上限 fail-closed 升级、crash replay 可重放、wake 失败 fail-closed;**`founder_feedback_kickback` 路径与今天逐字等价**。
3. **物化 snapshot**:handoff / QA loop wake-spawn / retry 后继 execution 均 copy-forward;issue-level 权威副本可被 startup reconcile / post-ship finalization 读取;**canonical YAML 在入口后变更/删除,已在跑的 run 仍能跑完**。
4. **ship gate**:templated eng run 的 QA PASS 写 `workflow_qa_passed`(绑 head)→ 放行;head 变更则失效。
5. **product skip-QA**:入口写 `workflow_qa_exempt=1` → 放行;**不依赖 `onMainAwaitingReview`**;不 spawn 独立 QA;startup backfill 不补测。
6. **遗留路径**(未挂模板)ship gate + Auto-QA **逐字不变**。
7. **三控制面正交**:`FLYWHEEL_AUTO_QA=0` **不**改变模板内部 QA 节点;模板 kill-switch **不**影响独立 Auto-QA。
8. retry 能按快照恢复(含 `shareParentBranch` 传播修复)。
9. 双 sink、transition-rejected、TURN recovery、complete-marker drain 路径均正确。
10. 第三层 Markdown **零改动**;`design/implement/qa` 注册表条目与今天逐字等价;零-Sonnet 不变量成立;`types.ts:616` doc drift 已修。
11. ⭐ **`generic` 节点**:能用 `agent_file` 参数化跑一个 agent.md;其 **prompt 只来自该文件**;**model / capabilities 只来自 core registry**。

### 13.1 可执行 sentinel 用例

| # | 用例 | 期望 |
|---|---|---|
| S1 | 无 snapshot(未挂模板)走 ship gate | 遗留 `qa_required`/`auto_qa_record` 路径**逐字不变** |
| S2 | templated eng,QA PASS | 写入**绑 head 的** `workflow_qa_passed`;放行 |
| S3 | S2 之后 head 漂移 | 证据**失效**,gate 拒绝 |
| S4 | templated product(skip qa) | **从不调用** `onMainAwaitingReview`;`workflow_qa_exempt=1`;放行;不 spawn 独立 QA;backfill 不补测 |
| S5 | `FLYWHEEL_AUTO_QA=0` | **不移除**模板内部 QA 节点 |
| S6 | 模板 kill-switch 关闭 | **不改变**遗留 Auto-QA 策略 |
| S7 | 入口后删除 canonical YAML | 已在跑的 workflow **仍能跑完** |
| S8 | founder-feedback kickback | 走**现有守卫路径**,与今天逐字等价 |
| S9 | QA runner 上报伪造 `prHeadSha` | 与服务端 capture 不一致 → **fail-closed** |
| S10 | 同 issue 旧 workflow 的在途事件 | 被 `workflow_run_id` 挡下,不误读最新 snapshot |
| S11 | ⭐ 用户 Runner agent.md 里写 `model:` / `permissionMode:` / `skills:` | 在**派发路径上全部无效**;实际 model/能力来自 core registry(§2.7 物理安全性质) |
| S12 | ⭐ `generic` 节点的 `agent_file` 指向 repo 外 / symlink 逃逸 / 不存在 | **走严格 loader → fail-closed**(不 warn+fallback 到通用实现提示词,§5.4) |
| S13 | ⭐ 全 write/ship capability=false 的 `generic` 节点 | **不**收到 branch/PR/approve/ship 指令;有明确 completion 命令(§5.7) |
| S14 | ⭐ `generic` 节点落库为一个未被扩枚举的 role | **fail-closed**,**绝不静默归一成 `main`**(§2.3b 陷阱);legacy 三角色仍逐字兼容 |
| S15 | ⭐ `produces_output` 的 `generic` 节点未写 `workflow_node_outputs` 就 `complete` | **completion fail-closed**,不推进 handoff(§5.6) |
| S16 | ⭐ 写完 `workflow_node_outputs` 后 Bridge 重启 / marker replay | 下游节点仍能从 issue-level 持久表读到产出(与 completion marker 解耦,§5.6) |

---

## 14. 交付方式:**一个大 epic 交 Tadashi**(Annie 定:一个大 PRD + 一个 epic,他自己拆)

> 本 PRD 不预先拆成 N 个 build issue。交付 = **一个 epic**,由 Tadashi 自行拆分。
> ⭐ **顺序分两道 gate(R4#6)**:因为 `generic` 是 MVP 的一部分,**durable node-id substrate + output/completion 契约 + 严格 loader + Blueprint capability 门控必须先于 orchestrator 能正确解释含 generic 的 snapshot**。

**Gate A — substrate(必须先全部落地)**:
1. 模板 / 注册表 config schema + canonical loader + validation(tri-state、unknown-key reject、schema_version、路径逃逸、唯一 id、`agent_file` 仅 generic、fail-closed)。
2. Entry 选模板 + 持久化**物化 workflow snapshot**(§7,含**内容寻址的 agent.md**);copy-forward 契约;修 retry `shareParentBranch` 缺口。
3. ⭐ **node-id 生命周期 substrate**(§3.1 + §2.3b 全 8 面):承载字段(`workflow_node_id`,与 legacy role 解耦)· **未知 role/id fail-closed 不静默归一** · role 枚举 / phase-active 查询 / 反查 / 展示+refresher / **TURN recovery 优先级** / completion sinks / marker replay / finalizer / retry / 启动对账。
4. ⭐ **Ship-gate 证据模型**(§8):`workflow_qa_*` + workflow-aware 分支 + 遗留 sentinel + **权威 head capture/校验**。
5. ⭐ **generic output / completion 契约**(§5.6):独立 output 写入通道(`workflow-output`,先写产出再 `complete`)+ issue-level `workflow_node_outputs`(按 `(workflow_run_id, node_id)` upsert,与 completion marker 解耦、可 replay)+ completion 前 output-present 校验 fail-closed + `completion_route`(默认 `no_code`)+ 严格 `agent_file` loader(fail-closed,§5.4)。
6. ⭐ **Blueprint capability 门控**(§5.7,**必须先于任何 generic dispatch**):去 `isDesignPhase/isImplementPhase/isQaPhase` 硬分支,改读注册表 capability。

**Gate B — 行为迁移 + 开跑(Gate A 全绿后)**:
7. 迁 phase table 进注册表(§4.2 全部职责 + capabilities);`design/implement/qa` 逐字兼容。
8. Orchestrator 按 snapshot 解释 sequence + `skip`;再把现有 QA loop 迁成配置化 loop 边(§6.1 全 spec,含 kickback 守卫)。
9. Auto-QA 边界迁移(§8.3/8.4/8.5)。
10. 生命周期收口余项 + reverse-compat sentinels(S1–S16)。
11. **启用 core-shipped 模板**(eng / product / 裸 default)**+ `generic`** + default-off + doc-drift 修正。

> **阶段 2**(任意具名节点类型,大概率不必;shared-branch generic)· **roadmap**(node-inject / fork)· **UI**(FLY-1038)不在本 epic。
