# FLY-1059 Designer Agent 角色 — 探索

Issue: FLY-1059 (https://linear.app/geoforge3d/issue/FLY-1059/add-a-designer-agent-role-mockup-first-design-concept-images-founder)
日期: 2026-07-09
基于: 无(source = Annie 7-09 FLY-1038 dashboard 评审「不够清晰」+ Peter GeoForge3D playbook · 兄弟 = FLY-1020 静/动 DAG · FLY-353 引擎 · FLY-793 三段式)

> 本文是 grounding + 方案探索。按 brainstorm gate 纪律:先确认理解与范围,再写 research/plan/code。

## 1. 问题(Annie 原话)

Annie 2026-07-09 review FLY-1038 dashboard localhost UI,判「不够清晰」。根因 = 我们一直 **implement-first**,没有真正的 design/UX pass。她要一个 **Designer Agent**:**mockup-first**——先出概念图 → founder 挑方向 → 高保真,再 implement,让产出从一开始就直观。

## 2. Designer 工作流(Peter 的 GeoForge3D playbook)

0. ⚠️ **先确认 mockup 类型**:一次性静态方向图 vs 必须落到真 app 的 UI 增量。这一步定全流程(FLY-1038 跳过 → 痛)。
1. **brief / brainstorm** — 弄清设计什么 + 产品语境(`brainstorming`)。
2. **视觉方向探索(核心)** — `codex-image` + `gemini-image` **并行** → 2–3 个方向 A/B/C。双模型是刻意的(Annie 比两种取向);快、便宜;她先对「长什么样」反应,再写任何代码。
3. **Founder 挑方向** — 一个 **design gate**(Annie 点一个方向),在 implement **之前**。
4. **高保真** — `frontend-design` → 生产级 HTML(真实观感 + mock 数据)。静态 → publish-report/Artifact 托管;真 UI 增量 → 落到 app。
5. Handoff 给 implement。

产物:方向图 A/B/C → 选定方向 → 高保真 mockup/spec(= implement 的 source of truth)。

## 3. Codebase grounding(核过码)

### 3.1 三段式引擎已存在(FLY-793)—— design→implement→qa 已经是现实

- `packages/config/src/three-stage-phases.ts`:`THREE_STAGE_PHASE_SEQUENCE = [design, implement, qa]`,每 phase 一个模型(design=heavy/Fable,implement=heavy,qa=medium)。thread badge 已锁 `🎨设计 / 🔨实现 / 🧪QA`。
- `packages/teamlead/src/bridge/three-stage-policy.ts`:opt-in;flywheel 项目已开(`.flywheel/config.yaml pipeline.three_stage: true`,仅 `#flywheel-engineer` 频道 `three_stage_channels`)。
- `packages/edge-worker/src/Blueprint.ts:957`:**design phase 目前用通用 prompt**——「Produce the design (brainstorm → research → plan → design review) and commit the docs; do NOT write implementation code」。**没有** mockup-first / 双模型概念图 / founder 设计门。

  → **这就是 FLY-1059 的接入点**:design 节点已在,只是它现在是「文字设计」不是「视觉 mockup 设计」。

### 3.2 DAG 节点集已锁「固定」(FLY-1020 收敛)

`product/doc/FLY-1020-workflow-templates/design-source.md` v4:Annie 第 3 轮大收敛——**节点集固定(Design/Implement/QA),动态全来自 loop + skip,不加新节点**;`node-inject 明确不做`。FLY-1020 的轻 YAML DAG 系统 **plan-approved 但尚未 build**(ship-prep)。

  → **推论**:FLY-1059 的「Designer」**不是新 DAG 节点**,而是给**现有 Design 节点**一个真正的 Designer 身份 + mockup-first 工作流。这与 Annie 锁定的固定节点模型一致,且不需要等 FLY-1020 的未建 YAML 系统。

### 3.3 现有 `product-designer-executor` 是 PM/PRD 导向,不是视觉 mockup 导向

`.flywheel/agents/engineering/product-designer-executor.md`:两模式——Mode A 产品共创(PRD co-creation)、Mode B docs/design 产出(单 pass spec)。技能是 PM 栈(`writing-prds` / `product-brainstorming` / `scoping-cutting`…)。**它不做**双模型概念图探索 + founder 设计门 + 高保真 HTML mockup。FLY-1059 的技能集(`frontend-design` / `codex-image`∥`gemini-image` / `proofshot` / `dataviz` / `founder-html-delivery`)是**视觉/UX**栈,与之互补而非重叠。

### 3.4 Designer 技能全部在机(已核)

`~/.claude/skills/` + 插件:`frontend-design`✅ `codex-image`✅ `gemini-image`✅ `founder-html-delivery`✅ `proofshot`✅ `dataviz`✅ `mermaid`✅ `artifact-design`✅ `brainstorming`(superpowers)✅。role 声称的技能都是真的。

### 3.5 设计门 = 复用现有 gate 原语,无需新原语

现有 `flywheel-comm gate brainstorm|question`(阻塞门)+ FLY-605 relay(~10min 兜底 @founder 进 thread)。Annie 点 A/B/C = 一次阻塞 gate。**不需要**新 gate 类型——designer 在 founder 选定方向前不 complete design phase / 不 handoff。

## 4. 方案提案(boring / 最小正确 / 不 over-build)

**Designer = 视觉 mockup-first 角色 = 现有 Design 节点的真正身份**,靠三块落地:

**(A) 新 agent 文件** `.flywheel/agents/engineering/designer-executor.md`
- mockup-first 工作流:confirm-type(step 0)→ brainstorm → **双模型并行概念图 A/B/C** → **founder 设计门(复用 gate)** → 高保真 HTML → handoff。
- 技能地图(显式 invoke):`frontend-design` / `codex-image`∥`gemini-image` / `founder-html-delivery`·`publish-report` / `proofshot` / `dataviz` / `mermaid` / `artifact-design` / `brainstorming`。
- 与 `product-designer-executor` 边界清楚:designer = 观感/UX/mockup + founder 批准;product-designer = PRD/产品共创;implement = 生产 wiring/data/tests/PR。

**(B) DAG 接线** = 两条互补路径,复用 FLY-793 三段式:
- **label 路由**(config.yaml agents):`design` / `designer` / `ui` / `mockup` → designer-executor,让 Lead 能为 UI issue 派一个 designer(Peter「小 UI:一 runner staged design→approval→implement」/「大:两角色」)。
- **三段式 design phase 对齐**:UI/design-flavored issue 进三段式时,design phase 走 mockup-first(而非通用文字设计 prompt)。—— 这块碰 Blueprint.ts 的 design-phase prompt(高 blast-radius,self-hosting repo),范围/做法待 gate 确认(见 §5 决策 2)。
- **设计门** = 复用 `gate`;不新增原语。

**(C) FLY-1038 dogfood** = 新角色第一次真跑:concept 方向轮(1038 实例树 + DAG-role 显示)→ Annie 点方向 → 高保真。**诚实边界**:多轮交互 + 真概念图 + founder 点方向**需要 Annie 在场**,headless 无法一次跑完;本 PR 产出角色 + 接线 + spec + 一个 1038 concept 方向轮作为证据,founder-pick 交 Annie 作首个真设计门。

## 5. 需要 Lead/Annie/Peter 拍的决策(brainstorm gate 带上)

1. **Designer 是独立新 agent(视觉 mockup-first),区别于 `product-designer-executor`(PM/PRD)?** 建议:是。
2. **「Wired as DAG role」= 复用现有 FLY-793 三段式 Design 节点 + label 路由 + 复用 gate 做设计门,不建新 DAG/节点基建(那是 FLY-1020,已 plan 未 build,且锁「固定节点不加新节点」)?** 建议:是。子问:三段式 design phase 的 mockup-first 升级是**只对 UI/design issue**(需一个判定信号,如 label)还是全 eng design phase?建议:仅 UI/design-flavored(避免把纯后端 issue 的 design phase 也塞进画图流程)。
3. **FLY-1038 dogfood 的完成度**:本 PR 出「角色+接线+spec+1038 concept 方向轮」,founder-pick + 后续高保真交 Annie 首个真设计门(follow-up 真跑)?还是要求本 PR 内跑完整个 1038 重设计?建议:前者(交互 + 概念图成本 + founder 在场,headless 跑不完整轮)。

## 6. 假设(未确认前不 silently 填)

- 三段式仅对 `#flywheel-engineer` 频道生效;本 issue 由 Product lead 派、走单 session。designer 角色本身与三段式解耦——可被单 session 派(label 路由),也可作三段式 design phase 身份。
- 阶段模型:designer 适合 heavy/Fable(高价值 founder 交互 + 视觉判断)。
- 不建新 Runner↔founder 通道;沿用 gate/relay + FLY-605 兜底。
- 不 bolt 新 phase 到三段式引擎(product-designer boundary 也这么说)。
