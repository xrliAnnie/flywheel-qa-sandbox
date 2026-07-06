# FLY-880 建对内 PM agent — 探索

Issue: FLY-880 (https://linear.app/geoforge3d/issue/FLY-880/pmbuild-建对内-pm-agent-协作式产品思考者互动模型-pm-skills-prd-输出按-fly-679-设计)
日期: 2026-07-05
基于: 无(上游 = FLY-679 issue comments「对内 PM 设计 — 互动模型」等 5 条)

## 1. 问题定义

Annie 要一个**对内 PM agent = 协作式产品思考者**(不是 spec-taker):她说大概方向,PM research、提 proposal、讨论、再深挖,逐层往下把产品**一起磨出来**,输出逐步收敛的 PRD、拆成 build issue。设计已在 FLY-679 跟 Annie brainstorm 定稿(brainstorm-gate FLY-598 已过),本 issue = 把它 build 出来。

**建好后第一单** = productization(一条 command 装 Flywheel + 任意项目简单接入;关联 FLY-653/650)。

## 2. 设计输入(FLY-679 已锁,不再重开)

### 2.1 互动模型(Annie 定,核心)

1. **一路来回、不憋 PRD**:Annie 说大概 → PM research → 提 proposal → 讨论 → 到某点再深挖 → 逐层往下。
2. **拆大 topic → 子 topic**,一个子块一个往下钻。
3. **自适应自由度**:每钻一子块,PM 先探「**你有定见、还是我发挥?**」——Annie 没定见 → PM 大自由度设计;已想好 → 必须对清、不自作主张。
4. **先摸清真实意图再拆**:接活先弄懂 Annie 真正要什么。
5. **输出** = 逐步收敛的 **PRD** → 拆成 build issue →(以后)PM 验收。

### 2.2 组织与边界(FLY-679 org confirm + Tadashi 精化)

- **Tadashi = 唯一整合 Lead**,PM = 他 dept 下的**角色 .md**(FLY-604 scaffold),按 label 起 PM runner。
- **Annie 红线:保持 unified、一个可配置引擎、别搞复杂。** pipeline 形态(Product issue = PRD→implement→PM 验收)与 **PM 验收 gate** 归 **FLY-830**(pipeline-as-config),**不在本 issue** —— 本 issue 绝不往 793 三段式上焊新 phase。
- **对外 PM(访谈员卫星 bot)**:独立 issue 线,与本 issue 解耦(本 issue 只建**对内** PM)。

### 2.3 本 issue 的 scope 切线

| In scope(FLY-880) | Out of scope(归属) |
|---|---|
| PM role executor .md(互动模型 + PRD 输出行为) | Product issue 的 pipeline 形态 / phase 编排(FLY-830) |
| PM skills curation + 预装(Lenny/官方/本地) | PM 验收 gate(FLY-830) |
| 起法 wiring(label 路由 + 三段式规避 + 互动通道用法) | 对外 PM 卫星 bot(FLY-679 另一半) |
| PRD 模板 / 落点约定 | Designer role(靠后,Dashboard-first) |
|  | 新的 Runner↔founder 直连通道(现有 relay 机制够 v1) |

## 3. 现状审计(codebase)

### 3.1 FLY-604 雏形:`.flywheel/agents/engineering/product-designer-executor.md`

现状 3 role executors(engineer / qa / product-designer)+ 顶层 general。`product-designer` 是 FLY-604 时把 Product(PM)+ Designer 合并的产物(Annie:美学要求低、不设独立 Designer),labels = `doc/docs/design/product/pm/ux/designer`,定位 = 「issue 驱动的 product thinking + UX + 文档产出」,**没有**互动模型(它按 dispatch 的 issue 单向产 doc,不是跟 Annie 一路来回磨)。本 issue = 把它的 PM 半边扩成完整对内 PM。

### 3.2 Runner ↔ Annie 的互动通道(现有机制)

Runner 物理上发不了 Discord(FLY-270:Tadashi 双向 relay 进 `[FLY-XX]` issue thread,Runner↔Tadashi↔Annie 三方协作)。可用原语:

- **`gate brainstorm` / `gate question`**(flywheel-comm):阻塞等回复,Bridge relay 给 Lead,Lead 在 thread 跟 Annie 对齐后 respond。多轮互动 = 多次 gate。
- **`flywheel-comm ask`**:非阻塞问 Lead + `check` 轮询。
- **founder 通知**(FLY-605/725):机制化 push 到 issue thread。

→ **PM 的「一路来回」物理层 = 现有 gate/relay 机制的高频使用**,零新 infra(见 §4 D3)。互动延迟受 relay 链约束,v1 接受;直连通道若真需要,是后续独立 issue。

### 3.3 三段式(FLY-793)与 product issue 的冲突

flywheel 项目 `pipeline.three_stage: true` 已开(2026-07-04)。三段式是 **eng issue** 的形态(eng-design→implement→QA);PM 的产品工作是**单 session 全程互动**,不该被拆成三段。FLY-793 设计含 per-issue `no-three-stage` label opt-out(plan Step 1)——PM issue 的 dispatch 纪律要用它(细节待 research 核实 label 名/语义)。

### 3.4 Skills 现状与分发通道

- **本地已装**:`minimalist-entrepreneur` = Claude Code plugin(全机),含 validate-idea / mvp / pricing / first-customers / marketing-plan / processize / grow-sustainably / minimalist-review / find-community / company-values。项目 skills:brainstorm / research / write-plan / create-issue 已在 executor `skills:` 列表模式中使用。
- **全局分发通道(FLY-216)**:`flyview-skills` repo(canonical `xrliAnnie/flywheel-skills`,本地 `~/Dev/flyview-skills`),`skills/{generic,flywheel}/` 两层,launchd `skills-sync` 每日同步到 `~/.claude/skills`(整机半径,hot-load 零重启),5 道门 CI(lint/触发词/shellcheck/blocklist/contract)。FLY-510 notion skill 是最近先例。

### 3.5 外部 PM skills(要 curate + 装的对象)

- **Lenny 22 个 PM skill** = [RefoundAI/lenny-skills](https://github.com/RefoundAI/lenny-skills)(87 skill 库中的 Product Management 分类 22 个;MIT license;每 skill = kebab-case 文件夹 + SKILL.md;内容蒸馏自 Lenny's Podcast 100+ 期)。22 个清单见 research.md。
- **Claude 官方 PM skills** = [anthropics/knowledge-work-plugins/product-management](https://github.com/anthropics/knowledge-work-plugins/tree/main/product-management):7 个 skill(feature-spec / roadmap-management / stakeholder-comms / user-research-synthesis / competitive-analysis / metrics-tracking / product-brainstorming)。

## 4. 关键设计决策点(带推荐,brainstorm gate 对齐)

### D1:扩 `product-designer-executor.md` in place,还是拆独立 `pm-executor.md`?

- **A(推荐)**:**in place 扩写**。issue 原文就是「扩 FLY-604 的 role .md」;Annie 红线 = 别搞复杂;FLY-679 说 Designer 等真有 UI 活才上——现在拆第 4 个 executor 是提前造复杂度。文件内部分「**产品共创模式**(product/pm label,互动模型)」与「**文档/设计产出模式**(doc/docs/design/ux,现状行为)」两个触发形态。
- B:拆 `pm-executor.md`(labels pm/product)+ 留 product-designer(其余 labels)。贴 4-role 蓝图但多一个 executor + label 重分配,现在不值。

### D2:PM skills 怎么装?

- **推荐**:**curated 子集 vendor 进 `flyview-skills` repo**(`skills/generic/pm/` 下),走既有 skills-sync 分发 + 5 道门 CI。MIT/官方 license 允许 vendor(保留 LICENSE + provenance);整机半径无害(skill 按需触发)。`minimalist-entrepreneur` 已是全机 plugin = 不动。
- **curation ≠ 全装**:Lenny 22 + 官方 7 有重叠(writing-prds vs feature-spec)、部分与对内场景无关(如 usability-testing 现阶段)。真正的 curation 价值在 **PM .md 里给「skill 地图」**——什么场景用哪个 skill,避免 PM 在 30+ skill 里迷路。精选清单见 research.md。
- 备选:用 `npx skills add` / plugin 机制装原库 —— 拒绝:绕开我们的 CI 门、来源不受控、与 FLY-216 单一分发通道相悖。

### D3:PM↔Annie 多轮互动的物理通道?

- **推荐**:**完全复用现有 gate/relay**(§3.2)。PM .md 教 PM:每个子 topic 的「探定见」「proposal 讨论」用 `gate question` 一轮一问;研究/深挖在轮次之间进行;PRD 逐版 commit 到分支。零新 infra,符合红线。
- 拒绝(v1):任何新的 Runner→Discord 直连 —— 独立于本 issue 的 infra 决策。

### D4:三段式规避?

- **推荐**:product issue 的 dispatch 纪律 = `pm`/`product` label + 三段式 opt-out label;写进 PM .md「怎么起」一节 + Tadashi 侧知会。结构化方案(issue 类型→pipeline 形态)归 FLY-830。

### D5:PRD 落点与形态?

- **推荐**:doc-flow 就地复用 —— `engineering/doc/<ISSUE>-<slug>/prd.md`,标准抬头 + 版本演进段(逐步收敛 = 同文件迭代 commit,变更历史即收敛轨迹)。PRD 模板(problem / users / goals / non-goals / requirements / open questions / build issues)作为 PM .md 附录或独立 skill。
- 拆 build issue:PM 用 `create-issue`(已在 skills 列表)或列给 Tadashi 建。

## 5. 风险与开放问题

1. **relay 延迟 vs 「一路来回」体验**:每轮过 gate→Bridge→Tadashi→thread→Annie,若 Annie 觉得节奏太慢,后续再立通道 issue —— v1 先用现有机制验证互动模型本身(dogfood:Cass 已在代班 PM 跑 productization,FLY-679 落法 (a))。
2. **skill 触发可靠性**:30+ PM skill 同机,靠 description 触发词自动命中不可靠 → PM .md 的 skill 地图用**显式指名**(「做 X 时 invoke Y」),不赌自动触发。
3. **`skills:` frontmatter 的实际语义**(是否被 runtime 消费)→ research.md 核实后决定 .md 里怎么写。
4. **第一单验收**:productization 是 PM 建成后的使用,不是本 issue 的 QA 标准;本 issue 的 QA = PM agent 能被正确 dispatch + 按互动模型走一轮(方案在 plan.md)。
