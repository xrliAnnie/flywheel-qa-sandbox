# FLY-1020 每类任务的 workflow 模板(低层 DAG)— 探索/设计源

Issue: FLY-1020 (https://linear.app/geoforge3d/issue/FLY-1020/low-level-dag-per-task-category-workflow-templates-lightoverridable)
日期: 2026-07-08
基于: 无(source = FLY-1004 homerail deep-dive · 兄弟 = FLY-353 Layer 2)

> 本文是 co-eval 设计 HTML(`workflow-templates-design.html`)的**设计源 / grounding 记录**。
> 按 Lead 的 co-creation 节奏:**先出交互设计 HTML 给 Annie co-eval → 收敛 → 再写完整 PRD**。
> 所以此刻**不写 PRD/plan**;exploration/research/plan 三件套等 co-eval 收敛后补齐。

## v2 — 折进 Annie 第 1 轮 co-eval(7 点)

1. **三段式只对 eng** → 提成主线(§1):product/designer 要不同 session/节点;DAG 搭积木价值 = 加新模板省事。
2. ⭐ **Auto-QA 误触发 = 头号动机**(§2):`auto-qa-coordinator.ts` 一刀切(项目级 `qa.auto`,不分类别),对纯 doc 的 Product 误 spawn QA runner = 浪费 + 干扰 founder。per-category:QA 变模板节点(eng 有 / product 无),从根上 generic。
3. **两种 inject 分开**(§6.1):**消息 inject**(往跑着 session 插指令,内容变图不变)= 我们已有(`flywheel-comm send`→mailbox / brainstorm gate);homerail 的 `inject`(active-runs.ts:1090)其实也是这种。**节点 inject**(往跑着 DAG 图加/改/跳节点,图形状变)= 净新;固定三段式做不到。诚实标:homerail 图动态性靠 loop_gateway + skip,**没有**干净的自由插节点,所以节点 inject largely 净新、非照抄。
4. **inject/fork/loop 三分**(§6.2):inject=改图 · fork=并行独立分支(两实现同时试;homerail checkpoint fork 干净 session)· loop=串行重复迭代(Annie 的 4-PR = loop 不是 fork;homerail loop_gateway+loop_sources)。
5. **default = 裸单 session**(§5):没挂模板 = agent 随便做 = 无约束(天然满足红线);per-category 模板 opt-in 后加。
6. **DSL/编辑器澄清**(§8,核过 homerail 码):自定义模板 / DSL(写模板小语言)/ 编辑器(可视化 UI)三件不同。**homerail 模板 DSL = YAML**(`assets/orchestrations/*.yaml.template`)——**TOML 是它的 UI widget 格式、不是模板格式**(纠 Lead 转述);**无可视化模板编辑器**(agent-ui 是语音/run 界面,模板手写 YAML)。MVP 明确不做 DSL/编辑器/自定义。
7. **inject/fork/loop 深挖清楚 → 留 Annie 拍 Later**(§6/§9)。MVP 只吃 profile(已有)。

grounding 来源:`product/doc/FLY-1004-homerail-analysis/homerail-code-report.md`(code-grounded)。

## v3 — 折进 Annie 第 2 轮 co-eval(叙事升级:静态 DAG → 动态 DAG)

Annie 第 2 轮把叙事从「模板」升级到 **静态 DAG → 动态 DAG**:

1. **核心 = 动态 DAG**(§1):三段式 = 静态线性图;现实要动态(能 loop / 回头 / 重复)。「模板」只是外壳,真升级是静态→动态。
2. **两个铁例都是 loop**(§2):① QA↔implement 来回 = loop(重复直到过)② Design→4 PR(每 PR:implement→QA)= loop(重复 implement+QA)。**关键 grounding:① 已被硬编码进三段式**(FLY-939 QA→implement kickback fix-loop,`phase-orchestrator.ts:910`:QA fail → 唤醒 parked implement 重做)—— 证明 loop 需求真到已焊死它,但焊在一个 eng 模板里、非可声明原语。② 是新 loop 形状,焊死版做不到。
3. **loop = MVP 动态原语**(§3);**node-inject = Later 且诚实说可能永不做**(loop 覆盖痛点;随意加节点更复杂/更险/难治理);**fork = Later**(这俩痛是串行 loop 非并行)。答 Annie「加节点对不对」= loop 先、node-inject 可能不做。
4. **homerail 静/动**(§6,核码):动态,但靠 loop_gateway 迭代 + skip;其 `inject` ≈ 消息 inject(往 node 注入指令,非改图);**没有干净的随意加节点** → 印证 loop 成熟、node-inject 连竞品都没干净做。
5. ⭐ **YAML 模板定义(采纳,修正 v2 的「不做 DSL」)**(§7):DAG 需定义格式,**YAML 最合适**(homerail 用 YAML)。MVP **要**轻 YAML 模板(节点+边+**loop 边**,如 `qa -> implement {when: fail}`)+ profile 字段;**不做可视化编辑器**、不做用户自定义。裸 session = 不挂 YAML 的默认。product 模板无 qa 节点 = 从根治 auto-QA 误触发。
6. **三段式泛化**(§7):三段式 = 一份 YAML(带 QA→implement loop);product = 短 YAML(无 QA)。

**MVP(v3 定稿方向,待 Annie 拍)**:轻 YAML 模板(节点+边+loop)+ 几套 shipped(eng/product)+ profile 复用 + QA 变模板节点 + 裸 session 默认 + 可覆盖;default-off 字节兼容。Later:fork。可能永不做:node-inject / 编辑器 / 自定义 / 自动学。

## v4 — Annie 第 3 轮大收敛(固定节点 + loop + skip = 动态,不加节点)

Annie nail 了最终模型,设计收敛:

1. ⭐ **节点集固定**(Design/Implement/QA),**动态全来自 loop + skip,不加新节点**(§1)。—— 纠正 v2/v3 里「product 有自己的 explore/converge 节点」的旧框架:现在是**同一套固定节点**,product 靠 **skip QA** 得到不同路。
2. **skip**(§2,新概念)= 条件跳过节点:Product skip QA(纯 doc)/ 简单任务 skip Design。同套节点、不同任务不同路。
3. **loop**(§3)= 重复直到条件:① Implement↔QA(已硬编码 FLY-939 kickback)② Design→4PR = loop (Implement→QA) ×4。
4. **一张图**(§4):固定节点竖列 + loop 回边(QA→Implement fail)+ skip 条件边(Product 跳 QA / 简单跳 Design)+ 三条路(eng/product/简单走同套节点不同路)。
5. ⭐ **node-inject 明确「不做」**(Annie 确认不需要加新节点,从 Later 降级)· **fork 也不做/远期**。核心动态 = **loop + skip**(+ profile 已有)。
6. **homerail 印证**(§7):homerail 动态也是 loop_gateway + skip(`_skipDependentNodes`),**没有随意加节点**;其 inject = 消息 inject。= Annie 收敛跟成熟做法一致。
7. **YAML 定义**(§8)升级带 skip:`nodes{model}` + `edges` + `qa->implement {loop_when: fail}`(loop 回边)+ `skip: qa {when: category==product}`(skip 条件)。没有「加节点」语法(不需要)。

**MVP(v4 收敛,待 Annie 最终拍)**:轻 YAML(节点 + 边 + **loop** + **skip**)+ profile 复用 + 几套 shipped(eng 全节点带 QA loop / product skip QA / 简单 skip Design)+ 裸 session 默认 + 可覆盖;default-off 字节兼容。**明确不做**:node-inject / fork / 可视化编辑器 / 用户自定义 / 自动学。

## 1. 分工(与 FLY-353)

两层 DAG(Annie 在 1004 articulate):
- **第二层 · 引擎(FLY-353)** — 做**哪些** issue、还相关吗、派给谁、何时、怎么 proactive。= CoS 分诊 + 自动派发。
- **第一层 · 模板(本 issue)** — 选中一条 issue 后**怎么跑**:几阶段、每阶段哪个模型、QA/gate 卡哪。

本文只谈第一层,353 不重讲。

## 2. 现状(核过码 · grounded)

| 能力 | 状态 | 证据 |
|---|---|---|
| 任务类别 → 谁跑 | 已有 | `AgentDispatcher` + `config.yaml` `agents[].match.labels` / `default_agent`(label→agent/Lead,只决定 who,不决定 how) |
| 模板序列 | 已做但写死 | `three-stage-phases.ts` `THREE_STAGE_PHASE_SEQUENCE` = design→implement→qa,固定 |
| profile(每节点绑模型) | 已做但写死 | `three-stage-phases.ts` `DEFAULT_PHASE_TIER` = design/implement=Fable(heavy)、qa=Opus(medium),零 Sonnet |
| 开关粒度 | 已做 | `three-stage-policy.ts` = 全局布尔 `pipeline.three_stage` + `no-three-stage` label + `three_stage_channels` 白名单 |
| 按任务类别选不同模板 | 没有 | grep 无 `taskCategory`/`templateRegistry`/`workflowTemplate`;开了就所有 issue 套同一套 |
| 可选模板库 | 没有 | 同上,就一套 |
| inject(跑中插节点) | 没有 | grep 无 |
| fork(岔并行) | 没有 | grep 无 |

**一句话现状**:我们有的是**一个写死的三段式 + 一个全局开关**,不是「每类任务一套」。`profile` 是唯一能直接升格的存量。

`PipelineConfig` 当前 shape(`packages/config/src/types.ts`):仅 `three_stage?: boolean` + `three_stage_channels?: string[]`。

## 3. 设计约束(Annie 红线,翻成三条)

1. 模板只定「粗脚手架」(几个 session / 每 session 哪个模型 / gate·QA 卡哪),**不定节点内部怎么想**。
2. 默认可偏离,**deviation 走正门**(换模板 / 调节点 / 跑中插岔)。
3. **先怀疑「要不要建」再想「怎么建」** —— 宁可少建。

核心论证(回应「模型越来越强还要模板干嘛」):**模板挂住的全是治理/基建钩子(profile 成本、独立 QA 位置、gate 落点、context 隔离、可观测),没有一样是替模型推理;这些东西模型变强也不会过时。** → 落 🅑「轻默认可覆盖」。

## 4. 提议的最小形态(草案,待 co-eval)

- **① 2-3 套 shipped 模板**(把写死的三段式抽成数据 + 加 1-2 套短的)。
- **② 用已有 label/agent 信号选默认模板**(不加新分类器,复用路由信号 —— 同 353 复用 CoS 的思路)。
- **③ profile 直接复用**(`three-stage-phases.ts` 升成模板通用字段)。

起步模板表(草案):Eng=三段式(已有)/ Product=短模板(探索/收敛,无实现+QA 尾,新)/ Docs·低风险=单节点(新)。

**刻意克制**:起步不做 template DSL / 可视化编辑器 / 用户自定义模板。先证明「分类别选模板」有用。

## 5. 节点级能力评估(push back)

- `profile` — 已做,MVP 直接用,无争议。
- `inject` — **later**。模型能自理时,「插一步」它直接做即可;只有当插进来的步要单独绑模型/卡 gate/上面板时才值。
- `fork` — **later**。真有用(并行择优)但是加分项、成本翻倍要治理,不进 MVP。

MVP 只吃 `profile`;inject/fork 往后放(它俩最像「重建 homerail run 内引擎」,在模型越来越能自理的系统里最该怀疑是否为做而做)。

## 6. 分阶段

- **阶段 1(MVP)**:模板抽数据 + 按类别选 + profile 复用 + 2-3 套 shipped + 可覆盖。**default-off、字节兼容**,照 `pipeline.three_stage` 的 opt-in 上线纪律。
- **阶段 2**:inject/fork(若证明值)、更多模板、更细 per-run override。
- **不做(除非跑出真痛)**:DSL / 编辑器 / 自定义模板 / 学历史自动调。

安全阀在第二层(353)治理里(founder gate + 接管叫停 + 出错升级),所以这层可以「轻」。

## 7. 留给 Annie 定的点

见 HTML §9:刻度(🅑 vs 更靠 🅐)· 核心论证服不服 · 起步 3 套对不对 + product 短模板形状 · inject/fork 是否都 later · 「起步不做自定义」的克制是否认同。

---
**下一步**:HTML → Lead QA → relay Annie co-eval → 收敛 → 补 exploration/research/plan + PRD → 拆 build issue 交 Tadashi。

## v5 — Annie 第 4 轮 co-eval(继续收敛,大概率定稿)

1. ⭐ **纠正「固定节点」**(§1):节点类型 **per-category + 可扩展** —— eng=Design/Implement/QA;创作视频=Research/生成视频(新类型)。「固定」准确含义 = ① 模板内固定(YAML 定义时定死)② 跑中不 node-inject;**≠ 全局只 3 种**(新类别在注册表定义新节点类型)。QA→Implement→QA loop 确认能实现(已跑硬编码版 FLY-939)。
2. **node-inject / fork = 现在不做 + 用例**(§5,解决 不做/可能不做 冲突):node-inject 用例 = 跑中要模板没有、又非 loop/skip 覆盖的新步骤(如 implement 中途加『安全审计』节点),很少见;fork 用例 = 同时试多方案比较(两实现策略并行 / A/B 设计)。都现在不做、留概念+用例。
3. ⭐⭐ **两层定义**(§6,关键):**第一层 YAML = DAG 形状**(哪些节点/顺序/loop/skip,按名字引用)· **第二层 节点类型注册表 = 每节点「是什么」**(prompt + skills + model)= 泛化 `three-stage-phases.ts`(它现在只管 model/phase → 加 skills+prompt)。YAML 管结构、注册表管行为;示例:eng.yaml 引用 design → node_types.design={model:fable, skills:[brainstorm,research,design-review], prompt}。新类别加新节点类型 = 只动注册表(= §1 可扩展的落地)。

**MVP(v5 收敛,大概率定稿)**:两层定义(YAML 形状 + 节点类型注册表)+ loop + skip + profile 复用 + 几套 shipped(eng/product/未来创作类)+ 裸 session 默认 + 可覆盖;default-off 字节兼容。现在不做(留用例):node-inject / fork。不做:可视化编辑器 / 用户自定义 / 自动学。

## v6 — Annie 第 5 轮 co-eval(三层定义 + inject/fork=roadmap,大概率定稿)

1. ⭐⭐ **三层定义**(§6,关键澄清,最底层今天不变):
   - 第一层 YAML = DAG 形状(节点/顺序/loop/skip,按名引用)【新增】
   - 第二层 节点类型注册表 = 每节点带哪些技能 + 模型(design={skills:[brainstorm,research,superpower,design-review], model:fable})= 泛化 three-stage-phases.ts【新增】
   - 第三层 Markdown = 每个技能/步骤怎么做(brainstorm.md/research.md/design-review.md)= **今天这套 Markdown,一个字不改**【不变】
   - ⭐ 打消误解:**YAML+注册表 = 加在现有 Markdown 之上的编排层、不替代 Markdown**;design 节点=「用这些技能」,每个技能怎么做还是各自 Markdown 说了算。新增只在上两层。
   - grounded:brainstorm.md/research.md/write-plan.md/implement.md 今天在 ~/.claude/commands/;design-review=codex/gemini-design-review skill。第三层「不变」是实锤。
2. **inject/fork = roadmap**(§5,改自 v5 的「现在不做」):Annie 定 = 有价值、post-MVP、进后续 PRD,不是「不做」也不是「可能永不做」;保留用例(node-inject=跑中加新步骤如安全审计;fork=并行 A/B)。
3. 保留 v5:节点类型 per-category 可扩展(§1)· loop+skip=MVP 动态(§2/3)· 流程图(§4)。

**MVP(v6 收敛,大概率定稿)**:新增上两层(YAML 结构 + 节点类型注册表)+ loop + skip + profile 复用 + 几套 shipped(eng/product/未来创作类)+ 裸 session 默认 + 可覆盖;**第三层 Markdown 不动**;default-off 字节兼容。roadmap(post-MVP):node-inject / fork。不做:编辑器 / 自定义 / 自动学。

**下一步**:v6 清 → 写 1020 PRD(exploration/research/plan,补齐三件套)+ 收敛前跑 Codex → 拆 build issue 交 Tadashi。
