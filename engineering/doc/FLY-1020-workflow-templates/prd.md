# FLY-1020 每类任务的 workflow 模板(三层动态 DAG)— PRD(非 UI 部分)

Issue: FLY-1020 (https://linear.app/geoforge3d/issue/FLY-1020/low-level-dag-per-task-category-workflow-templates-lightoverridable)
日期: 2026-07-08
基于: `product/doc/FLY-1020-workflow-templates/design-source.md` + co-eval HTML v6(Annie 拍板通过)
Status: draft(待 Codex design-review + Lead QA)

> 本 PRD 是 co-eval 收敛后的**建造蓝图**。设计经 6 轮 Annie co-eval 收敛,v6 拍板通过。
> 放**结论 + 机制**(eng 照着能建),不堆 Q&A 过程;过程记录在 design-source.md。
> **UI / dashboard 不在本 PRD** —— 拆到 **FLY-1038**(见 §10)。

---

## 1. 背景与目标

Annie 的**两层 DAG** 模型(FLY-1004 articulate):
- **第二层 · 高层编排引擎**(FLY-353):决定做**哪些** issue、还相关吗、派给谁、何时、怎么 proactive。= CoS 分诊 + 自动派发。
- **第一层 · 本 issue**:选中一条 issue 后**怎么跑** —— 用哪套 workflow 形态。

**本 PRD 只做第一层。** 目标:把今天**唯一一个写死的 eng 三段式模板**,升级成**每类任务一套、可覆盖的动态 DAG 模板**,由**三层定义**(YAML 结构 + 节点类型注册表 + 现有 Markdown 技能)描述。

**红线(Annie,贯穿全设计):** 模板是**轻的 / 默认的 / 可覆盖的**,不是死板紧身衣。模板只钉**粗脚手架**(哪些节点 / 每节点哪个模型 / 哪里 loop / 哪里 skip),**不定节点内部怎么想**。真正耐用的价值在治理(profile 成本、独立 QA、gate 落点、context 隔离、可观测),**不在于把模型推理钉死**。

---

## 2. 现状(核过码)

| 能力 | 今天 | 证据 |
|---|---|---|
| 任务类别 → 谁跑 | label → agent/Lead(只决定 who,不决定 how) | `AgentDispatcher` · `config.yaml agents[].match.labels` / `default_agent` |
| workflow 形态 | **一个写死的三段式**:Design→Implement→QA,静态线性、就一套 | `packages/config/src/three-stage-phases.ts`(`THREE_STAGE_PHASE_SEQUENCE`) |
| profile(每节点模型) | 写死:Design/Implement=Fable、QA=Opus | `three-stage-phases.ts`(`DEFAULT_PHASE_TIER`) |
| 节点行为(prompt/skills) | 按 `sessionRole` 散在 Blueprint | `packages/edge-worker/src/Blueprint.ts`(`ctx.sessionRole === "design"` 等) |
| loop | **焊死 1 个**:QA fail → 唤醒 parked implement 重做,不可声明 | `packages/teamlead/src/bridge/phase-orchestrator.ts`(FLY-939 kickback,fix-loop) |
| skip | 无 —— 全局 on/off,不能按类别跳节点 | `packages/teamlead/src/bridge/three-stage-policy.ts` |
| 按任务类别选模板 | 无 | grep 无 `taskCategory`/`templateRegistry`/`workflowTemplate` |
| Auto-QA | 一刀切:PR 过 review 就 spawn QA Runner,不分类别 | `packages/teamlead/src/bridge/auto-qa-coordinator.ts`(项目级 `qa.auto`) |
| Markdown 技能文件 | 已在:brainstorm/research/write-plan/implement/design-review | `~/.claude/commands/*.md` + skills |

**一句话现状**:一个**静态线性 + 一个焊死 loop** 的 eng 模板 + 一个全局布尔开关。`profile` 是唯一能直接升格的存量。

`PipelineConfig`(`packages/config/src/types.ts`)当前仅 `three_stage?: boolean` + `three_stage_channels?: string[]`。

---

## 3. 设计:三层架构

**核心**:workflow 模板 = 三层。上两层是**新增的编排层**,第三层是**今天这套 Markdown、原封不动**。

```
第一层 · YAML          = DAG 形状:哪些节点 / 顺序 / loop / skip(按名字引用)      【新增】
        ↓ 节点按名引用
第二层 · 节点类型注册表  = 每节点「是什么」:prompt + skills + model               【新增,泛化 three-stage-phases.ts】
        ↓ 技能按名引用
第三层 · Markdown 技能   = 每个技能/步骤怎么做:brainstorm.md / research.md / …    【今天这套,不变】
```

**关键原则(打消误解):** YAML + 注册表 = **加在现有 Markdown 之上的编排层,不替代 Markdown**。`design` 节点 = 「用这些技能」;每个技能**具体怎么做**,还是各自的 Markdown 说了算。**新增只在上两层,不动 Markdown。**

### 3.1 第一层 — YAML(DAG 形状)

一份模板 = 一个轻 YAML 文件,声明:
- `nodes`: 引用的节点类型名(有序;顺序 = 默认走向)。
- `edges`: 节点间走向;`loop_when: <cond>` 标一条 **loop 回边**(见 §4)。
- `skip`: `<node> {when: <cond>}` 标条件跳过(见 §4)。

**示例(eng 模板):**
```yaml
# templates/eng.yaml
nodes: [design, implement, qa]
edges:
  - design    -> implement
  - implement -> qa
  - qa -> implement  {loop_when: fail}      # loop:QA 不过就回 implement,重复直到过
```

**加载与校验(安全 + fail-loud):**
- 模板从项目 **canonical / mainline root** 加载,**绝不**从实现 PR 的 worktree —— 与 `three-stage-policy.ts` 的安全约束一致(runner 不得改自己的模板 config)。
- **malformed YAML / 未知节点名 / 引用了注册表里没有的节点类型 / loop 边指向不存在的节点** → 在 config load 时**大声抛错**(mirror `ConfigLoader` 对 `pipeline` block 的处理:malformed → throw;absent → 默认关)。
- 引用完整性:YAML 里每个 `nodes` 成员必须在注册表(§3.2)中有定义;每条 edge/skip 的目标节点必须在 `nodes` 里。

### 3.2 第二层 — 节点类型注册表(行为)

注册表 = 每个**节点类型**一份定义:`{model, skills, prompt}`。**这是 `three-stage-phases.ts` 的泛化** —— 它今天只管 `model/phase`(`DEFAULT_PHASE_TIER`);注册表把 `skills` + `prompt` 也纳入,并从「3 个写死的 phase」泛化成「任意可注册的节点类型」。

**示例:**
```yaml
# node-types registry
node_types:
  design:    {model: fable, skills: [brainstorm, research, superpower, design-review], prompt: "…设计阶段…"}
  implement: {model: fable, skills: [test-driven-development],                          prompt: "…实现阶段…"}
  qa:        {model: opus,  skills: [qa-verify],                                        prompt: "…QA 阶段…"}
  # 新类别扩展 = 在此加新节点类型(定义时,非跑中):
  research:       {model: fable, skills: [deep-research], prompt: "…"}
  generate_video: {model: fable, skills: [gemini-video],  prompt: "…"}
```

**字段语义:**
- `model`: 该节点 dispatch 的模型(= 现有 profile 能力)。**保留 Annie 的零-Sonnet 不变量**(现有 invariant 测试泛化成:每个注册的节点类型 model ∈ 允许集)。
- `skills`: 该节点 session 带哪些技能(引用第三层 Markdown 的名字)。
- `prompt`: 该节点的 session 提示词骨架(今天散在 Blueprint 的 phase-prompt 逻辑,收敛进注册表条目)。

**实现落点:** 新建 `packages/config/src/node-type-registry.ts`(与 `three-stage-phases.ts` 同层),把 `DEFAULT_PHASE_TIER` 吸收为 registry 的 `model` 字段;Blueprint 的 phase-prompt 构建改为读注册表条目而非 `sessionRole` 硬分支。

### 3.3 第三层 — Markdown 技能(不变)

第二层 `skills:` 引用的名字,解析到**现有 Markdown 技能/命令文件**:
- `~/.claude/commands/{brainstorm,research,write-plan,implement}.md`(已存在)
- design-review = `codex-design-review` / `gemini-design-review` skill(已存在)
- superpowers / test-driven-development / deep-research / gemini-video 等 skill(已存在)

**本 PRD 不改任何 Markdown 技能文件。** 第三层 = 今天这套结构,原封不动。注册表只是**引用**它们。

---

## 4. 动态语义:loop + skip(跑在固定节点上,不加新节点)

一个类别的节点在**定义时**定死(YAML)。跑时的动态**全来自两个算子**:

### 4.1 loop(重复直到条件)

- 语义:一条 `<from> -> <to> {loop_when: <cond>}` 回边;当 `<from>` 节点产出满足 `<cond>`(如 `fail`)时,控制**回到 `<to>` 节点**重跑,直到不再满足。
- **两个铁例都是 loop:**
  - **QA↔Implement**:`qa -> implement {loop_when: fail}` —— 直到 QA 过。
  - **Design→4 PR**:同一 `(implement→qa)` 子图 loop 4 次(重复次数/条件由 loop 边参数给)。
- **可实现性(已有硬证据):** 今天的 FLY-939 kickback **就是**一个焊死的 QA→implement loop(`phase-orchestrator.ts`:QA fail → 唤醒 parked implement)。升级 = 把它从「焊死在 eng 模板里」泛化成「一条**可声明的 loop 回边**」,由 PhaseOrchestrator 按 YAML 边解释,而非按硬编码序列。
- **护栏:** loop 需**最大迭代数上限**(防死循环)+ 每轮留痕(mirror 现有 kickback 的 keep-alive/park 机制,FLY-887)。

### 4.2 skip(条件跳过节点)

- 语义:`skip: <node> {when: <cond>}` —— 当 `<cond>` 满足时,该节点**不 dispatch**,控制流跳到其下游。
- 例:`skip: qa {when: category == product}`(product 纯 doc 不测)· `skip: design {when: trivial}`(简单任务直接 implement)。
- **同套节点、不同任务不同路** —— skip 让一份模板/一套节点适配多种任务,不必为每类造新节点。

### 4.3 明确不做:node-inject(跑中加新节点)

- MVP **不**支持跑中往图里加/改节点。节点集在定义时固定(§5)。
- 动态需求由 loop + skip 覆盖;node-inject 排 roadmap(§9)。

---

## 5. 节点类型:per-category + 可扩展

「固定节点」的**准确含义**(两条,缺一不可):
1. **模板内固定** —— 一个类别的模板,节点在 YAML 定义时就定死,跑前已知。
2. **跑中不 inject** —— 跑起来不临时长新节点。

**≠ 全局只 Design/Implement/QA。** 节点类型是 **per-category、可扩展的**:
- eng = Design/Implement/QA;product = Design/Implement(skip QA);创作视频 = Research/生成视频(**新节点类型**)。
- **扩展 = 定义时在注册表(§3.2)加新节点类型**,不是跑中 inject。新类别加节点类型只动注册表 + 写一份 YAML。

---

## 6. 每类任务的 default 模板

| 类别 | 默认模板 | QA 节点 | 说明 |
|---|---|---|---|
| **未挂模板(全局 default)** | **裸单 session** | 无 | 不挂 YAML = agent 自己决定怎么做。最轻默认,天然满足红线。 |
| **eng** | Design→Implement→QA + `qa→implement {loop_when: fail}` | 有 | 现有三段式抽成 YAML + 注册表(profile 复用)。 |
| **product** | Design→Implement,`skip: qa` | 无 | 纯 doc 不测 → **从根治 Auto-QA 误触发**(§2 的一刀切痛)。 |
| **创作视频(示例未来类)** | Research→生成视频(+ 可 loop 重生成) | 视形态 | 新节点类型,展示可扩展。MVP 可不含,留作扩展样例。 |

**Auto-QA 收敛:** 「要不要 QA」= 「该类别模板里有没有 QA 节点」的自然结果,不再是一个全局布尔去猜。`auto-qa-coordinator.ts` 的触发条件收敛为「模板走到了 QA 节点」。

---

## 7. 模板选择 + 可覆盖

**选择(不加新分类器):** 类别 → 模板,复用**已有的 label/agent 路由信号**(`AgentDispatcher` + `config.yaml`)—— 同 FLY-353 复用 CoS 的思路。落点:泛化 `resolveThreeStageEntry` / `resolveThreeStagePolicy`(`three-stage-policy.ts`)为「resolve 该 issue 的模板」。

**可覆盖(deviation 走正门,3 级):**
- **换整套模板** —— 单 issue 用 label / dispatch 参数指定别的模板(泛化今天的 `no-three-stage` label)。
- **调这套的节点** —— 单 issue 临时 skip 某节点 / 换某节点模型(per-run override,不改全局默认)。
- **裸兜底** —— 不挂模板 = 裸 session,永远有个「不套流程」的出口。

原则:**默认省心、覆盖顺手、偏离不惩罚** —— 绝不逼一个单步能完的活跑三段式。

---

## 8. 配置与兼容

- **default-off、字节兼容:** 不配模板 config = 跟今天一模一样(单 session 或现有 `three_stage`)。照 `pipeline.three_stage` 的 opt-in 上线纪律;可灰度、可回退(kill-switch env)。
- **config 落点:** 扩展 `PipelineConfig`(或新增 `templates` config 块),承载模板 YAML 引用 + 注册表。malformed → config load 大声抛错(mirror `ConfigLoader`);absent → 默认关。
- **安全:** 模板 + 注册表从 canonical root 加载,绝不从 PR worktree(§3.1)。
- **零-Sonnet 不变量:** 泛化现有 phase-model invariant 测试到「每个注册节点类型」。

---

## 9. 分阶段

- **阶段 1(MVP,本 PRD 主体):** 三层里**新增上两层**(YAML 结构 + 节点类型注册表)+ `loop` + `skip` + profile 复用 + 几套 shipped 模板(eng / product / 裸 default)+ 可覆盖。**第三层 Markdown 不动。** default-off、字节兼容。
- **阶段 2 · roadmap(post-MVP,进后续 PRD):**
  - **node-inject**(跑中加新节点):用例 = 跑中要一个模板没有、又非 loop/skip 覆盖的新步骤(如 implement 中途加『安全审计』节点)。跑中改图要更强的追踪/治理,值得单独一版 PRD。
  - **fork**(并行分支):用例 = 同时试多方案比较(两实现策略并行 / A/B 设计)。成本翻倍要专门治理。
- **不做:** 可视化编辑器(→ FLY-1038 会 identify 形态)· 用户随意自定义模板 · 学历史自动调模板。

---

## 10. 超范围 / cross-ref

- **UI / dashboard(FLY-1038):** Annie 要一个**管理用** UI(知道有哪些 DAG + 怎么注册到哪个 instance;**非** runtime 监控)。已拆到 **FLY-1038**(统一 dashboard:现有实例/模型 config + 新 DAG config,先 identify 形态)。**本 PRD 不展开 UI**;本 PRD 交付的 YAML/注册表是 FLY-1038 的数据源。
- **第二层引擎(FLY-353):** Layer 2 编排引擎是本层模板的**消费方**(选中 issue → 按其类别模板跑)。本 PRD 提供被调用的模板层;353 不重复。
- **Scale(FLY-1022):** 规模化相关约束见 FLY-1022,不在本 PRD。

---

## 11. 验收标准

1. 能用一份 YAML + 注册表**声明** eng 三段式(含 `qa→implement` loop)与 product 短模板(`skip qa`),行为等价/优于今天。
2. `loop` 边可声明并被 orchestrator 正确解释(替代焊死的 FLY-939 kickback),含最大迭代上限护栏。
3. `skip` 条件生效:product 模板不 dispatch QA 节点 → Auto-QA 不再对 product 误触发。
4. 未挂模板的 issue = 裸单 session(字节兼容今天)。
5. 可覆盖三级(换模板 / 调节点 / 裸兜底)可用。
6. default-off:不配置 = 今天行为逐字不变(reverse-compat 测试)。
7. 第三层 Markdown 技能文件**零改动**。
8. 零-Sonnet 不变量对所有注册节点类型成立。

---

## 12. build issue 拆分建议(交 Tadashi)

1. **节点类型注册表**(`node-type-registry.ts`):吸收 `DEFAULT_PHASE_TIER` + skills/prompt;Blueprint phase-prompt 改读注册表。
2. **YAML 模板加载 + 校验**(ConfigLoader 扩展):canonical-root、fail-loud、引用完整性。
3. **orchestrator 泛化**(`phase-orchestrator.ts`):从硬编码序列 → 按 YAML 边走;`loop`(泛化 FLY-939 kickback + 迭代上限)+ `skip`(条件跳节点)。
4. **模板选择 + 可覆盖**(`three-stage-policy.ts` 泛化):类别→模板(复用 label/agent)+ 3 级 override。
5. **Auto-QA 收敛**(`auto-qa-coordinator.ts`):触发条件改为「模板走到 QA 节点」。
6. **shipped 模板**:eng / product / 裸 default 三套 + config schema + default-off + reverse-compat 测试。

> node-inject / fork(roadmap)· UI(FLY-1038)不在本次拆分。
