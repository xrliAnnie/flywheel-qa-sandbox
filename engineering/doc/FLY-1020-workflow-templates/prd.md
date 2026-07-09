# FLY-1020 每类任务的 workflow 模板(三层动态 DAG)— PRD(非 UI 部分)

Issue: FLY-1020 (https://linear.app/geoforge3d/issue/FLY-1020/low-level-dag-per-task-category-workflow-templates-lightoverridable)
日期: 2026-07-08
基于: `product/doc/FLY-1020-workflow-templates/design-source.md` + co-eval HTML v6(Annie 拍板通过)· Codex design-review R1→R3
Status: **Codex APPROVED**(R3,3 轮;R1 10 项 + R2 5 项 findings 全采纳,R3 3 条非阻塞实现注记已折入)

> co-eval 收敛后的**建造蓝图**。设计经 6 轮 Annie co-eval,v6 拍板。
> 放**结论 + 机制**(eng 照着能建),不堆 Q&A;过程在 design-source.md。
> **UI / dashboard 不在本 PRD** —— 拆到 **FLY-1038**(§11)。

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

### 2.4 Auto-QA 是 **default-ON opt-out**(R1#4 —— 原稿此处写错)

优先级链(`auto-qa-policy.ts:8-13`,fail-safe):`FLYWHEEL_AUTO_QA=0` → `no-qa` label → qaConfig **malformed(fail-closed)** → `qa.auto:false` → `skip_labels` → 否则 **ON**(FLY-752 fleet-wide default-on)。

> **doc drift(顺手修)**:`types.ts:616` 注释仍写 `qa` "Absent or auto:false = off",与 `QaConfig`(`:228`)自述的 default-on 矛盾。

### 2.5 ⚠️ ship gate 是 **per-execution** 的,且模板 QA 不写 `auto_qa_record`(R2#2 —— **会死锁**)

- `onMainAwaitingReview` **仅处理 `session_role === "main"` 的行**(`auto-qa-coordinator.ts:306`,`:323`);两个 sink 也只对 main 行调用它(`DirectEventSink.ts:755`,`event-route.ts:2015`)。
  → **templated product run 的可评审 phase 是 `implement`,不是 `main` ⇒ 该 hook 永不触发。**
- `evaluateQaShipGate`:`qa_required=1` ⇒ **必须**存在该 head 的 passed `auto_qa_record`,否则 `qa_not_passed`(`ship-eligibility.ts:114`,`:185`)。
- 但三段式内部 QA PASS **只写 `three_stage_verdict`**,QA runner 直接走 founder ship gate,**不写 `auto_qa_record`**(`phase-orchestrator.ts:929`)。

→ **结论**:给 templated 内部 QA 设 `qa_required=1` 会**永久死锁 ship gate**(索要一份永不会写的记录);给 product 用 `onMainAwaitingReview` 写 `qa_required=0` 则**根本不会执行**。§7 据此重写。

### 2.6 ⚠️ QA loop 还有第二个触发形态:founder-feedback kickback(R2#4)

QA PASS 打开 approve gate 后,**founder/Lead 的反馈**在窄条件下被当作 FAIL kickback,绕过「已记录 PASS」守卫、路由回 implement(`phase-orchestrator.ts:804`,`:817`,`:860`;Blueprint 显式提示 QA 发这条,`Blueprint.ts:1020`)。守卫:**keep-alive ON only** · QA session 位于 `awaiting_review`(其自身 ship gate 已开)· runner-driven review evidence 存在 · gate response 已记录 · **QA 永不改代码**(角色分离)。
→ loop 条件源若只认 `qa_fail`,会**回归掉这条现有修复路径**。

---

## 3. ⭐ MVP 范围决策(R1#1/#10)

**问题**:v6 设计说「节点类型 per-category + 可扩展」。但 §2.3 表明 `design|implement|qa` 硬编码在持久化/展示/finalizer/retry/对账里。把「任意节点类型」与「抽象化现有三段式」塞进同一 MVP,会漏掉整片生产生命周期面。

**决策(eng 排期,不改设计)**:

| | MVP(本轮验收) | 阶段 2(需先做泛化 workstream) |
|---|---|---|
| 节点类型 | **仅内建 `design`/`implement`/`qa`** | 任意注册节点类型(`research`/`generate_video`…) |
| 能力 | 模板**选择** · **skip** · per-node **model override** · 现有 QA loop **配置化** | 泛化:`ThreeStagePhase`→node-id、`ChatThreadRole`+phase query、issue-display、post-ship-finalization、retry、thread-role + 迁移 |

**三层设计与注册表 seam 不变**(Annie 拍板的架构成立);**可扩展性被排期,不被放弃**。创作视频 = **扩展样例**,不作本轮验收。

---

## 4. 三层架构

```
第一层 · YAML          = DAG 形状:哪些节点 / 顺序 / loop / skip(按名引用)         【新增】
        ↓ 节点按名引用
第二层 · 节点类型注册表  = 每节点「是什么」:model + skills + prompt + 展示 + 能力    【新增,泛化 three-stage-phases.ts】
        ↓ 技能按名引用
第三层 · Markdown 技能   = 每个技能怎么做:brainstorm.md / research.md / …          【今天这套,不变】
```

**关键原则**:YAML + 注册表 = **加在现有 Markdown 之上的编排层,不替代 Markdown**。`design` 节点 = 「用这些技能」;技能**怎么做**仍由各自 Markdown 决定。**新增只在上两层。**

### 4.1 第一层 — YAML(DAG 形状)

```yaml
# templates/eng.yaml   (core-shipped)
schema_version: 1
nodes: [design, implement, qa]          # MVP:只能引用内建三节点
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
- `schema_version` 必填;**unknown key → reject**;external file refs 必须在 canonical root 内(**路径逃逸拒绝**)。
- **引用完整性**:`nodes` 成员必须在注册表有定义;edge/skip 目标必须在 `nodes` 内。MVP 额外:`nodes ⊆ {design, implement, qa}`。

### 4.2 第二层 — 节点类型注册表(行为 + 能力)

**必须覆盖 `three-stage-phases.ts` 今天的全部职责(§2.2)**,否则旧序列继续做真编排。

| 字段 | 今天在哪 |
|---|---|
| `id` | `ThreeStagePhase` |
| `model` | `DEFAULT_PHASE_TIER` |
| `skills` | 无(新增,→ 第三层) |
| `prompt` | 散在 `Blueprint.ts` 的 `isDesignPhase/isImplementPhase/isQaPhase` 分支 |
| `badge` / display metadata | `PHASE_THREAD_BADGE` |
| `is_phase_role` | `isThreeStagePhaseRole` |
| `preserve_completion_role` | `resolveCompletionSessionRole` |
| `next_resolver` | `nextPhase`(改为按 YAML edge) |

⭐ **节点能力(capabilities,R1#7)** —— 缺了会让 product/research 节点误继承 implement/land/approve 行为:

`shared_branch_writer` · `creates_pr` · `can_ship` · `approval_gate_holder` · `needs_review_evidence` · `can_land` · `needs_mailbox_transport` · `keepalive_park` · `qa_verdict_emitter`

**实现落点**:新建 `packages/config/src/node-type-registry.ts`;Blueprint 改读 capability 而非 `sessionRole` 硬分支。**`design/implement/qa` 三条条目与今天行为逐字等价**(reverse-compat sentinel)。

### 4.3 第三层 — Markdown 技能(不变)

`skills:` 解析到**现有** Markdown 技能/命令。**本 PRD 不改任何 Markdown 技能文件。**

---

## 5. 动态语义:loop + skip

### 5.1 loop —— MVP = 把**现有 QA loop 配置化**(R1#3 + R2#4)

现有 FLY-939 loop 已具备:持久化 `three_stage_verdict` intent 供 crash replay(`:83`)· 修复轮次上限(`:993`,`:1111`)· 先 capture QA head SHA(`:1007`,`:1122`)· keep-alive 下 wake parked implement + worktree readiness + grant TURN(`:1140`,`:1156`)· ghost-guard(`:1197`)。

**条件源(受限枚举,不引入自由表达式)**:
1. `qa_fail` —— QA verdict FAIL。
2. ⭐ `founder_feedback_kickback` —— **必须保留**(§2.6)。loop 解释器须**逐字保留其守卫**:keep-alive ON only · QA session 在 `awaiting_review` · runner-driven review evidence 存在 · gate response 已记录 · 绕过「已记录 PASS」守卫 · 路由回 implement · **QA 永不改代码**。

**每条 loop 边必须声明/满足**:

| 项 | 要求 |
|---|---|
| idempotency key | `(execId, edge_id, iteration)` 唯一 |
| `max_iterations` | **必填**;达上限 → **fail-closed 升级给人**,不静默继续 |
| round ledger | 每轮持久化(复用 `three_stage_verdict` intent),支持 crash replay |
| head capture | 回边前 capture 上游 head SHA |
| wake vs spawn | keep-alive ON → wake parked 节点(校验 worktree readiness + grant TURN);OFF → respawn |
| TURN ownership | 单一 writer;ghost-guard 拒重复 writer |
| startup replay | 启动对账能重放未完成轮次 |
| wake 失败 | **fail-closed**(升级),不静默跳过 |

**MVP 只交付 `qa -> implement` 这一条被配置化的边**(行为与今天逐字等价 + 可声明 `max_iterations`)。任意 loop 边 = 阶段 2。

### 5.2 skip —— 条件跳过节点

- 语义:该节点**不 dispatch**,控制流跳到下游。
- 条件域**受限枚举**:`template == <id>` 与内建 label(如 `trivial`)。不引入自由表达式。
- **skip 不只是「不 dispatch」** —— 它必须同时写 ship-gate 证据(§7)。

### 5.3 明确不做(MVP)

跑中 **node-inject** · **fork**。→ roadmap(§9)。

---

## 6. ⭐ 物化 workflow snapshot(R1#5 + R2#1)

**问题**:`session_params` 是 **per-execution row**(`StateStore.ts:3168`);handoff **起新 execution**(`phase-orchestrator.ts:1426`);retry **派生后继 execution**(`actions.ts:840`)。仅存 `template_id + hash` 不足以让 handoff/retry/对账「一律读快照」—— canonical YAML 若在入口后变更/消失,id+hash 只能告诉你漂移发生了,**不能让 orchestrator 继续跑**。

**要求:持久化一份「物化图」而非引用。**

`workflow_snapshot` payload(入口解析后物化):

| 字段 | 内容 |
|---|---|
| `nodes[]` | **归一化节点列表**(id + 生效的 model / capability / badge metadata) |
| `edges[]` | **已解析的边**(含 loop 边 id + 条件源 + `max_iterations`) |
| `skip[]` | **skip 决策**(或 skip 输入,足以重算) |
| `overrides` | 本 run 选用的 per-run override |
| `loop_counters` | 每条 loop 边的 iteration ledger |
| `current_node_id` / `edge_state` | 当前进度 |
| ⭐ `workflow_run_id` | **本次 workflow 运行的判别符**(或 `root_execution_id` + generation)。issue-level 记录与每份 execution copy 都必须带 |
| `template_hash` / `registry_hash` | **仅供审计/漂移检测**,不作运行依据 |

**传播契约**:
- **copy-forward 到每一次**:phase handoff 起的新 execution · QA loop 的 wake/spawn · retry 的后继 execution。
- **issue-level 真相**:snapshot 以 **issue 为主键**存一份权威副本(execution row 上的是 copy),供 startup reconcile / post-ship finalization 在没有活 execution 时读取。
- ⭐ **`workflow_run_id` 判别符(R3 注记 2)**:同一 issue 上的**旧 workflow 尝试**可能仍有事件在途;reconcile 时必须用 `workflow_run_id` 匹配,**防止旧事件误读最新的 issue-level snapshot**(串线)。
- **handoff / retry / startup reconcile / post-ship finalization 一律读快照**,**绝不**中途按 live label/config 重解图形状。
- **live kill-switch 仍可阻止新的 dispatch**(fail-closed),但**不改变已在跑的图**。
- 修复 retry 的 `shareParentBranch` 传播缺口(FLY-840 遗留)。
- 若存储成本是问题:可不存 prompt 全文,但**必须存足以脱离项目 YAML 运行的归一化图 + capability 数据**。

---

## 7. ⭐ Ship-gate 证据模型 与 Auto-QA 边界(R2#2/#3 —— 重写)

### 7.1 事实约束(§2.5)

`onMainAwaitingReview` 仅对 `main` 行生效 ⇒ templated run(可评审 phase = `implement`)**永不触发它**;`evaluateQaShipGate` 在 `qa_required=1` 时**索要 passed `auto_qa_record`**,而模板内部 QA **只写 `three_stage_verdict`** ⇒ **复用 `qa_required` 会死锁**。

### 7.2 决策:**ship gate 增加 workflow-aware 分支**(遗留路径逐字不变)

```
evaluateShipEligibility(exec):
  if exec 有 workflow_snapshot:            # 新分支
      → 读 workflow QA 证据(§7.3)
  else:                                    # 遗留分支,byte-compat 不动
      → 现有 qa_required / auto_qa_record 逻辑
```

### 7.3 workflow QA 证据(新字段,per-execution + issue-level 权威副本)

| 字段 | 写入者 | 语义 |
|---|---|---|
| `workflow_qa_required` | **入口**(模板选定时,由 snapshot 是否含 QA 节点决定) | 1 = 本 run 必须有内部 QA 通过证据 |
| `workflow_qa_passed` | **QA 节点 PASS 时**(扩展 `phase-orchestrator.ts:929` 的 verdict 写点),**绑定 head SHA** | 内部 QA 已通过该 head |
| `workflow_qa_exempt` | **入口**(模板 `skip qa` 时,如 product) | 本 run 免内部 QA;ship gate 直接放行该项 |

- **eng templated**:`workflow_qa_required=1`;QA PASS 写 `workflow_qa_passed`(绑 head)→ gate 放行。head 变更 ⇒ 证据失效(与现有 head-binding 语义一致)。
- **product templated(skip qa)**:入口写 `workflow_qa_exempt=1` → gate 放行该项。**不依赖 `onMainAwaitingReview`**(它对这条 run 永不触发)。
- **独立 spawn 的 Auto-QA**:对 **templated run 一律 exempt**(不双重 QA)。遗留(未挂模板)路径的 Auto-QA **逐字不变**。

⭐ **`workflow_qa_passed` 的 head 必须是权威 head(R3 注记 1 —— 不得信 runner 自报)**:
- 写点(`phase-orchestrator.ts:929` 的 PASS 分支)**今天并不 capture head**;而 `qa-result` 携带的 `prHeadSha` **默认取 QA runner 自己的 git HEAD**(`qa-result.ts:41`,`:119`)——**runner 自报,不可信**。
- 实现必须二选一:**(a)** 服务端用现有 `capturePhaseHeadSha` effect 抓 QA phase head;或 **(b)** 把 runner 上报的 `prHeadSha` 与服务端 capture 的 head **校验一致**后才写 `workflow_qa_passed`。
- **head 缺失/不一致 → fail-closed**(不写证据)。
- 后续 `evaluateShipEligibility` 的比对必须**对齐它本就收到的 `prHead`**(`ship-eligibility.ts:266`),避免两套 head 语义。

### 7.4 三个独立控制面(R2#3 —— 不再混为一谈)

| 控制面 | 开关 | 管什么 | **不管什么** |
|---|---|---|---|
| 模板层 | workflow-template enable + 其 kill-switch env | 是否启用模板、图形状 | 不改独立 Auto-QA 策略 |
| 独立 Auto-QA | `FLYWHEEL_AUTO_QA=0` / `qa.auto` / `skip_labels` | **仅**独立 spawn 的 QA runner | **不**改变模板内部 QA 节点(不改 workflow shape) |
| ship-gate 执行 | ship-gate QA-done 开关 | gate 是否强制 QA 证据 | 不决定谁跑 QA |

- `no-qa` label:若意图是**跳过内部 QA 节点**,它是一个 **per-run workflow override**,必须走与 `skip qa` **同一条路径**(写进 snapshot + 写 `workflow_qa_exempt`),**不得**作为静默绕过。
- `malformed` 仍 **fail-closed**(OFF)。

### 7.5 startup backfill

`auto-qa-coordinator.ts:1523` 的 backfill 必须**识别 templated run**(读 snapshot),不给它们补独立 QA。

---

## 8. 配置 schema 与加载(R1#8)

```yaml
pipeline:
  workflow_templates:
    enabled: false            # 默认 false(字节兼容)
    default: null             # 未匹配类别的默认模板 id(null = 裸 session)
    files: [templates/eng.yaml, templates/product.yaml]   # canonical-root 相对路径
  node_type_registry:
    file: templates/node-types.yaml
```

- **tri-state**:absent → OFF(今天行为逐字不变)· malformed → **project fail-closed + 大声报错**(不 crash 整 Bridge)· present+valid → ON。
- `schema_version` 必填;**unknown key → reject**;**路径逃逸拒绝**;kill-switch env(mirror `FLYWHEEL_THREE_STAGE`)。
- **顺手修 doc drift**:`types.ts:616` 的 `qa` 注释改为反映 FLY-752 的 default-on(§2.4)。

---

## 9. 分阶段

- **阶段 1(MVP,本 PRD 验收)**:YAML 结构 + 节点类型注册表(含 capabilities)+ **内建三节点** + `skip` + per-node model override + **现有 QA loop 配置化(含 founder-feedback kickback)** + **物化 workflow snapshot** + **workflow-aware ship gate 证据模型** + Auto-QA 边界 + core-shipped 模板(eng / product / 裸 default)+ 可覆盖。**第三层 Markdown 不动。default-off、字节兼容。**
- **阶段 2 · 任意节点类型**:泛化 workstream(§3 右列),然后开放新节点类型 + 任意 loop 边。
- **roadmap(post-MVP,进后续 PRD)**:**node-inject**(用例:跑中加「安全审计」节点)· **fork**(用例:并行试多方案 / A/B)。
- **不做**:可视化编辑器(→ FLY-1038)· 用户随意自定义节点/模板 · 学历史自动调模板。

---

## 10. 红线守卫(可验收)

1. MVP 只提供 **core-shipped 模板**;项目只能 select / override / opt-out。
2. **不开放任意用户自定义节点类型**(阶段 2 前)。
3. 节点内部推理**不被模板约束**(第三层 Markdown + 模型决定)。
4. 不挂模板 = **裸单 session**(永远有「不套流程」的出口)。
5. loop / skip 条件域**受限枚举**,不引入自由表达式 DSL。

---

## 11. 超范围 / cross-ref

- **UI / dashboard → FLY-1038**(管理用:有哪些 DAG + 注册到哪个 instance;**非** runtime 监控)。本 PRD 交付的 YAML/注册表是其数据源。
- **第二层引擎 → FLY-353**(本层模板的消费方)。
- **Scale → FLY-1022**。

---

## 12. 验收标准

1. 一份 YAML + 注册表可声明 eng 三段式(含配置化 `qa→implement` loop)与 product 短模板(`skip qa`),**行为与今天逐字等价**(reverse-compat sentinel)。
2. 配置化 loop:`max_iterations` 生效、达上限 fail-closed 升级、crash replay 可重放、wake 失败 fail-closed;**`founder_feedback_kickback` 路径与今天逐字等价**(守卫全保留)。
3. **物化 snapshot**:handoff / QA loop wake-spawn / retry 后继 execution 均 copy-forward;issue-level 权威副本可被 startup reconcile / post-ship finalization 读取;**canonical YAML 在入口后变更/删除,已在跑的 run 仍能跑完**。
4. **ship gate**:templated eng run 的 QA PASS 写 `workflow_qa_passed`(绑 head)→ gate 放行;**head 变更则证据失效**。
5. **product skip-QA**:入口写 `workflow_qa_exempt=1` → gate 放行;**不依赖 `onMainAwaitingReview`**;独立 Auto-QA 不 spawn;startup backfill 不补测。
6. **遗留路径**(未挂模板)ship gate + Auto-QA **逐字不变**(sentinel)。
7. **三控制面正交**:`FLYWHEEL_AUTO_QA=0` **不**改变模板内部 QA 节点;模板 kill-switch **不**影响独立 Auto-QA 策略。
8. retry 能按快照恢复(含 `shareParentBranch` 传播修复)。
9. 双 sink(`DirectEventSink` + `event-route`)、transition-rejected、TURN recovery、complete-marker drain 路径均正确。
10. 第三层 Markdown **零改动**;`design/implement/qa` 注册表条目与今天逐字等价;零-Sonnet 不变量成立;`types.ts:616` doc drift 已修。

### 12.1 可执行 sentinel 用例(R3 注记 3 —— 验收必须落成这些具体测试)

| # | 用例 | 期望 |
|---|---|---|
| S1 | 无 snapshot(未挂模板)的 run 走 ship gate | 遗留 `qa_required`/`auto_qa_record` 路径**逐字不变** |
| S2 | templated eng,QA PASS | 写入**绑 head 的** `workflow_qa_passed`;gate 放行 |
| S3 | S2 之后 head 漂移 | 证据**失效**,gate 拒绝 |
| S4 | templated product(skip qa) | **从不调用** `onMainAwaitingReview`;`workflow_qa_exempt=1`;gate 放行;不 spawn 独立 QA;startup backfill 不补测 |
| S5 | `FLYWHEEL_AUTO_QA=0` | **不移除**模板内部 QA 节点(workflow shape 不变) |
| S6 | 模板 kill-switch 关闭 | **不改变**遗留 Auto-QA 策略 |
| S7 | 入口后删除 canonical YAML | 已在跑的 workflow **仍能跑完**(物化 snapshot 生效) |
| S8 | founder-feedback kickback | 走**现有守卫路径**,行为与今天逐字等价 |
| S9 | QA runner 上报伪造 `prHeadSha` | 与服务端 capture 的 head 不一致 → **fail-closed**,不写证据 |
| S10 | 同 issue 上旧 workflow 的在途事件 | 被 `workflow_run_id` 判别符挡下,**不误读**最新 snapshot |

---

## 13. build issue 拆分(交 Tadashi,按 R1#9 + R2#5 重排)

> 原则:**先定 durable shape 与 ship-gate 证据契约,再迁行为** —— 否则 registry 只是包着旧硬编码的一层新配置,且 ship gate 会死锁。

1. **模板 / 注册表 config schema + canonical loader + validation**(tri-state、unknown-key reject、schema_version、路径逃逸、fail-closed 测试)。
2. **Entry 选择模板 + 持久化物化 workflow snapshot**(§6);copy-forward 契约;修 retry `shareParentBranch` 缺口。
3. ⭐ **Ship-gate 证据模型**(§7,R2#5:必须在 orchestrator 之前定契约):`workflow_qa_required/passed/exempt` 字段 + `evaluateShipEligibility` 的 workflow-aware 分支 + 遗留分支 sentinel + **权威 head capture/校验**(`capturePhaseHeadSha`,runner 自报 `prHeadSha` 不可信,不一致 fail-closed)。
4. **迁 phase table 进注册表**(§4.2 全部职责 + capabilities);`design/implement/qa` 逐字兼容。
5. **Orchestrator 按 snapshot 解释 sequence + `skip`**;再把现有 QA loop 迁成配置化 loop 边(§5.1 全 spec,含 kickback 守卫)。
6. **Auto-QA 边界迁移**(§7.3/7.4/7.5:templated exempt、三控制面正交、startup backfill 识别)。
7. **生命周期 workstream**(R1#6):双 sink、startup reconcile、complete-marker drain、`session_failed`/transition-rejected、TURN recovery、issue display refresh、post-ship finalization。
8. **Blueprint prompt / capability 改读注册表**(去 `isDesignPhase/isImplementPhase/isQaPhase` 硬分支)。
9. **core-shipped 模板**(eng / product / 裸 default)+ default-off + reverse-compat sentinels + doc-drift 修正。

> **阶段 2**(任意节点类型泛化)· **roadmap**(node-inject / fork)· **UI**(FLY-1038)不在本次拆分。
