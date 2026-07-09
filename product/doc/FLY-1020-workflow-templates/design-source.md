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
