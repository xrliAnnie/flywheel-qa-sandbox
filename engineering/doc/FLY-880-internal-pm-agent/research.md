# FLY-880 建对内 PM agent — 调研

Issue: FLY-880 (https://linear.app/geoforge3d/issue/FLY-880/pmbuild-建对内-pm-agent-协作式产品思考者互动模型-pm-skills-prd-输出按-fly-679-设计)
日期: 2026-07-05
基于: exploration.md

## 1. Codebase 机制核实(逐条带证据)

### 1.1 agent role .md 的消费方式:整文件逐字注入,frontmatter 不解析

- `readAgentFile()` 原样读文件返回字符串,无 YAML 解析(`packages/edge-worker/src/Blueprint.ts:1841-1882`);拼进 system prompt 的 `## Agent Role` 段,**截断到 40k 字符**(`Blueprint.ts:1476-1497`)。
- config 侧 `AgentConfig` 只有 `agent_file/domain_file/department/match.labels`(`packages/config/src/types.ts:123-152`)——**没有 skills、没有 model 字段**。
- `skills:` frontmatter **无人消费**:skill 注入是固定 5 模板(`flywheel-context/flywheel-tdd/flywheel-git-workflow/flywheel-escalation/linear-issue-context`,`packages/edge-worker/src/SkillInjector.ts:23-35`),与 .md 的 skills 列表无关。
- `model:` frontmatter **无人消费**:runner 模型走 label > 项目 `roles.<role>.model` > env > default(`packages/teamlead/src/bridge/role-adapter-resolver.ts:4-6`)。`permissionMode:` 同样 inert(实际 hardcode `bypassPermissions`,`Blueprint.ts:1556`)。

**含义**:① role .md 本质 = prompt 文本,互动模型必须写成**行为规范文字**;frontmatter 保留仅作文档性元数据(现有 3 个 executor 同款,保持一致)。② 「预装 skills」不能靠 frontmatter——唯一现实路径 = **skill 装到全机**(§1.5),.md 里给显式指名的 skill 地图。③ .md 有 40k 截断上限,扩写后保持 ≤ 300 行安全余量极大。

### 1.2 dispatch 路由(AgentDispatcher)

顺序(`packages/edge-worker/src/AgentDispatcher.ts:204-278`):显式 `agentName` 覆盖 > 本部门 label 匹配(first-match wins,大小写不敏感)> 顶层 catch-all > `default_agent` > shipped generic。现 config 中 engineer/qa/product-designer 三者 label 零重叠(FLY-604 REPLACE 原则),`pm`/`product` → `product-designer` 路由已通,**零改动**。

### 1.3 三段式(FLY-793)入口与 opt-out

- 入口无 issue 类型/label 条件:fresh dispatch(`requestRole === "main"`)一律升为 Design phase(`packages/teamlead/src/bridge/three-stage-policy.ts:97-111`、`runs-route.ts:505-539`)。
- **`no-three-stage` label opt-out 已存在**(`three-stage-policy.ts:45-66`:env kill-switch → per-issue label `no-three-stage` → 项目 toggle)。
- 三段式各 phase 的 agent .md 仍按 label 解析(phase-orchestrator 只传 `sessionRole`+`dispatchModel`,不传 `agentName`);QA phase 有 hardcoded 独立 QA prompt。

**含义**:PM issue 要单 session 全程陪跑,**给 issue 打 `no-three-stage` label 即可,零代码**。不打的后果:`pm` issue 会被拆成 Design/Implement/QA 三段(Design 用 Fable、product-designer .md,但互动模型会被 phase 停点切碎)——所以 label 纪律必须写死进 role .md「怎么起」一节 + Tadashi 的 dispatch 习惯。

### 1.4 PM↔Annie 互动通道(实测机制)

- **gate(brainstorm/question)的第一响应者 = Lead**:CommDB question 定向 `--lead`,GatePoller relay 给 Lead,Lead 用自己 Discord 身份在 thread 跟 Annie 对齐后 `respond`(`packages/teamlead/src/bridge/gate-poller.ts:1051-1085`)。
- **FLY-605 founder-thread fallback**:gate 挂起约 10 分钟 grace 后(`gate-poller.ts:1334-1336`),Bridge 直接把 gate 问题 + `@founder` 发进 per-issue `[FLY-XX]` thread,并回读 founder 在 thread 的回复唤醒 runner(`founder-thread-notifier.ts`、`gate-poller.ts:454-460,576-594`)。→ **Annie 可以直答**,relay 延迟有机制化兜底。
- `flywheel-comm ask` 非阻塞 + `check` 轮询;FLY-818 stuck→@founder page(default-on)。
- `approve_to_ship` = founder-authorized gate(共创模式基本用不到,PM 不 ship 代码)。

**含义**:「一路来回」的物理层 = **每轮一个 `gate question`**(阻塞等回),Tadashi relay 为主、FLY-605 直达为兜底;research/深挖在轮次之间本地进行。零新 infra,与 exploration D3 推荐一致。

### 1.5 skills 全局分发(FLY-216)

- `skills-sync.sh`(`~/.flywheel/bin/`,launchd `com.flywheel.skills-update.plist` 每日)从 canonical repo `xrliAnnie/flywheel-skills`(本地 clone `~/Dev/flyview-skills`)同步 `skills/{generic,flywheel}/` → **`~/.claude/skills`**(全机 ambient,hot-load 零重启;`scripts/provision-fleet-host.sh:336-345`)。
- repo 有 5 道门 CI(lint/触发词/shellcheck/blocklist/contract);FLY-510 notion skill 是最近先例(PR #10 模式:Annie 批 → Tadashi merge → launchd 分发)。
- 无 per-agent skill manifest —— skill 对所有 agent ambient 可见,靠 description 触发 + .md 显式指名。

**含义**:「curate + 预装」的落地 = **vendored PM skills 进 flywheel-skills repo(独立 PR)**,本仓只改 role .md + 文档。两仓交付,同 FLY-510 模式。

## 2. 外部 PM skills 盘点

### 2.1 Lenny skills([RefoundAI/lenny-skills](https://github.com/RefoundAI/lenny-skills))

87 个 skill、11 分类;**MIT license**(「Use these however you want」);每 skill = kebab-case 文件夹 + SKILL.md(+ 可选 references/);内容蒸馏自 Lenny's Podcast 100+ 期(Shreyas Doshi / Marty Cagan / Elena Verna 等)。**Product Management 分类 22 个**:

writing-north-star-metrics · defining-product-vision · prioritizing-roadmap · setting-okrs-goals · competitive-analysis · writing-prds · problem-definition · writing-specs-designs · scoping-cutting · working-backwards · conducting-user-interviews · designing-surveys · analyzing-user-feedback · usability-testing · shipping-products · managing-timelines · product-taste-intuition(Developing Product Taste)· product-operations · behavioral-product-design · startup-ideation · dogfooding · startup-pivoting

### 2.2 Claude 官方([anthropics/knowledge-work-plugins/product-management](https://github.com/anthropics/knowledge-work-plugins/tree/main/product-management))

官方 knowledge-work plugin,7 个 skill:`feature-spec`(PRD/用户故事/验收标准)· `roadmap-management`(RICE/MoSCoW)· `stakeholder-comms` · `user-research-synthesis`(主题分析/亲和图/persona)· `competitive-analysis` · `metrics-tracking`(OKR/dashboard)· `product-brainstorming`(**思维伙伴行为,与互动模型最贴**)。repo 带 LICENSE(vendor 时随文保留并核对条款)。

### 2.3 本地已有(零动作,只做地图引用)

- **minimalist-entrepreneur plugin**(全机已装):validate-idea / mvp / processize / pricing / first-customers / marketing-plan / grow-sustainably / minimalist-review / find-community / company-values。
- **项目/全局 skills**:brainstorm · research · write-plan · create-issue · deep-research · last30days(近 30 天多源调研)。

## 3. Curation 提案(≈13 个 vendored + 已装引用)

**选取标准**:对内 PM 的真实场景 = solo founder(Annie)+ AI 团队 + 内部产品(Flywheel 自身/productization),没有大组织 stakeholder 流程、没有 sprint 官僚。**宁少勿多**:第一批只装互动模型直接用得上的,后续按实战缺什么补什么(flywheel-skills PR 增量便宜)。

### 3.1 装(vendor 进 flywheel-skills `skills/generic/pm-*` 或 `pm/` 子目录,以 repo 现行布局为准)

| # | skill | 来源 | 互动模型中的位置 |
|---|-------|------|------------------|
| 1 | problem-definition | Lenny | 接活先摸真实意图(第一步必用) |
| 2 | product-brainstorming | 官方 | 思维伙伴行为,一路来回的 session 结构 |
| 3 | defining-product-vision | Lenny | Annie 没定见时 PM 发挥的大方向框架 |
| 4 | working-backwards | Lenny | proposal 前从结果倒推 |
| 5 | writing-prds | Lenny | **PRD 默认 skill**(格式服从 doc-flow 模板) |
| 6 | scoping-cutting | Lenny | 收敛、砍 scope(Annie 红线:enforce simplicity) |
| 7 | prioritizing-roadmap | Lenny | 拆 build issue 后排序 |
| 8 | writing-north-star-metrics | Lenny | 每单 PRD 的成功标准段 |
| 9 | product-taste-intuition | Lenny | proposal 质量自检 |
| 10 | user-research-synthesis | 官方 | 消化 Annie 反馈/(未来)对外 PM 访谈产物 |
| 11 | analyzing-user-feedback | Lenny | 同上,原始反馈→主题 |
| 12 | competitive-analysis | 官方 | productization 单直接要用(装谁家/怎么装的对标) |
| 13 | dogfooding | Lenny | Flywheel 自用自证(本项目常态) |

### 3.2 明确不装(去重/不适用,记录理由防止反复)

- `feature-spec`(官方)/ `writing-specs-designs`(Lenny)→ 与 writing-prds 重叠,**PRD 默认 = writing-prds**,规格细化交给 eng 的 plan 流程。
- `roadmap-management`(官方)→ 与 prioritizing-roadmap 重叠。
- `metrics-tracking`(官方)→ 与 writing-north-star-metrics 重叠;dashboard 层面 Flywheel 有自己的报表体系。
- `stakeholder-comms`(官方)/ setting-okrs-goals / managing-timelines / product-operations / shipping-products → 大组织流程,solo founder + AI 团队用不上;ship 纪律 Flywheel 自有(founder gate)。
- conducting-user-interviews / designing-surveys / usability-testing → 对外 PM(访谈员卫星 bot)的地盘,归 FLY-679 另一半。
- startup-ideation / startup-pivoting / behavioral-product-design → 与当前对内场景距离远,实战需要再补。
- Lenny 其余 65 个非 PM 分类 skill → 不在本单范围。

### 3.3 已装引用(role .md skill 地图直接指名)

minimalist-entrepreneur:validate-idea(新想法验证)· mvp(最小可行切法)· processize(先手工后产品化——**productization 单直接相关**)· pricing · minimalist-review(决策 gut-check)。项目:brainstorm / research / write-plan / create-issue / deep-research / last30days。

## 4. 互动模型 → 机制映射(role .md 行为规范的骨架)

| 互动模型(FLY-679 原文) | 物理实现(全部现有机制) |
|---|---|
| 先摸清真实意图 | 开工第一轮 `gate question`:复述理解 + 问意图,不通过不往下 |
| 一路来回、不憋 PRD | 小步多轮:每轮 = research(本地)→ proposal(一块)→ `gate question` 等回 → 按回复走;绝不闷头憋全量 PRD |
| 拆大 topic → 子 topic | PM 提交 topic 树(在 thread/PRD 里),一次只钻一个子块 |
| 每块先探「定见 or 发挥」 | 每个子块的第一轮 gate 固定句式先问;「有定见」→ 对清为止;「你发挥」→ PM 出方案再回来对 |
| skills 做 research | skill 地图显式指名(§3);深挖用 research/deep-research/last30days |
| PRD 逐步收敛 | `engineering/doc/<ISSUE>-<slug>/prd.md` 逐版 commit;每版 gate 消息附「本版改了什么」;git 历史即收敛轨迹 |
| 拆 build issue | `create-issue`(team FLY + project Flywheel + 部门 label);列给 Tadashi 兜底 |
| (以后)PM 验收 | out of scope → FLY-830 |

通道细节:主链 = gate → Tadashi relay → Annie;兜底 = FLY-605(约 10 分钟后 @founder 直发 issue thread,Annie 直答可唤醒)。PM 轮与轮之间不空转:阻塞 gate 时段本身就是在等,回复后立即续。

## 5. role .md 结构草稿(扩写 product-designer-executor.md 的目标形态)

```
frontmatter(文档性,注明 inert;name/description 更新)
# 身份:Flywheel Product Designer / 对内 PM(engineering Runner)
## 两种触发形态
  A. 产品共创模式(product/pm label 或 Tadashi 指名)——本次新增,主体
  B. 文档/设计产出模式(doc/docs/design/ux)——现状行为,保留压缩
## 产品共创模式(互动模型行为规范)
  - 五条铁律(FLY-679 原文语义逐条落成行为)
  - 轮次协议(gate question 用法、一次一问、探定见句式)
  - topic 树协议(拆法、当前子块标记)
  - PRD 协议(模板段落、落点、逐版 commit、收敛标准)
  - 拆 issue 协议(create-issue 参数、与 Tadashi 的交接)
## skill 地图(场景 → 显式 skill 名,§3 的表)
## 怎么起(给 Lead 看):label 纪律(pm/product + no-three-stage)、单 session 全程
## 边界:不碰 793/pipeline;PM 验收 gate = FLY-830;不写生产代码(现状保留)
## CRITICAL rules / Docs & branch / Reporting(现状保留)
```

预算:全文目标 ≤ 250 行(现 41 行),远低于 40k 截断线。

## 6. 交付边界(两仓)

1. **flywheel-skills repo PR**(独立):13 个 vendored skill(保 LICENSE + provenance 头注)+ 过 5 道门 CI。分发 = launchd skills-sync,**无需 Bridge 重启**。
2. **本仓 PR**:role .md 扩写 + 本 doc 文件夹。role .md 是 spawn 时现读(`readAgentFile`),**merge + 生产 git pull 即生效,无需重启**(同 FLY-217 先例)。
