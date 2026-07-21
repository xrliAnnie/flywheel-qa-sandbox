# FLY-1396 DAG 分档 binding — PRD(按「活的类型」分档)

Issue: FLY-1396 (https://linear.app/geoforge3d/issue/FLY-1396/prdhl-dag-分档-binding-不同类型的单走不同模板不再一律-eng-heavy-highway)
日期: 2026-07-20
基于: exploration.md（§4.6 dispatch 实扒 / §4.7 Tadashi 定论 / §4.8 四点 / §4.9 角色核验 / §4.10 work-kind 最小方案）· research.md

> **SSOT**:本文档以 **§3.2 映射表**为唯一真相;任何「部门决定模板」的旧表述都已删除(全文扫过并 re-grep 归零)。
> **口径**:代码事实 file:line 核过(Tadashi 复核);生产 DB / 真单抽样核过;不确定标 UNKNOWN;**提案待 Annie 确认**的地方明确标出。
> 本 PRD 只定形状;实现交 Tadashi(FLY-1380 建模板 / FLY-1385 引擎接线,§8)。

---

## 0. Topic tree（▶ 当前 = Codex 设计评审）

```
FLY-1396 分档 binding
├─ ★主轴          ✅ 活的类型决定模板;任何部门都能做任何类型;**部门值=纯指令面建议(服务端不认它)**;派发时必须显式给
├─ 分合判据        ✅ 只差模型的合并 / 流程形状不同的分开(§3.1)
├─ 类型→模板 映射   ✅ prd·designer·prototype·code·research·*(§3.2 = SSOT)
├─ 库存 6→5        ✅ 工程 3 合 1 + 产品 3 套 + 通用重定义
├─ ★★上位原则      ✅ **路由判断在派发那一刻做,不读单子上的存量标记**(§4.0,Annie 抓出)
│                  ⚠️ 本单只落到 **work-kind + `no-three-stage`**;其它存量 label 读点不动(§4.0 例外表;⚠️ 目前无接收方)
├─ 类型怎么判       ✅ **v2-routed**:templateId **或** taskCategory(派发时必给)—— 缺则**拒派**;非-v2 行为不变(§4.1/§4.7)
├─ 标题前缀 parser  ❌ **整段删除** —— 因为它编码的是「这次的用法」;会过期只是症状不是判据(§4.0)
├─ 忘不了的落法      ✅ **required-param gate**:v2-routed 缺 work-kind 直接拒派;部门值降为**纯指令面建议**(无确认协议,§4.7,Lead 拍)
├─ fail-loud 两分   ✅ 有 kind 缺 exact 行=炸 / **v2-routed 无 kind=拒派**(不落默认,§4.4/§4.7)
├─ lint 权威点      ✅ **dispatch-time**(1392 事故;Tadashi 背书,§5)
├─ rollout 安全序    ✅ 1380 只建 → 1385 v2 入口三件套 → 迁 binding(带回归 fixture)→ 开 flag(§6)
├─ 三套 flow 合同    ✅ **Annie 已批准**(§7);designer 改为开放确认循环(她的修订)
└─ no-three-stage   🟡 **提案待 Annie 确认**(§5.3,会动到现有派发纪律)
```

---

## 1. 问题 · 用户 · 目标 · 非目标

**问题**:`workflow_category_binding` 每项目只有一条 `* → tpl_eng_heavy`(生产 DB 实测 6 项目)。凡走 DAG 的单全被塞进最重的工程流水线。活样本 FLY-1378(研究报告)跑了 3 轮 design-review + 3 轮 code-review。

**Users**

| 角色 | 现在的痛 | 分档后 |
|---|---|---|
| **Founder** | 每个 issue 跑十几二十小时、很多废阶段 | 每件活按**它是什么类型**跑;审阅带宽不被无谓阶段占用 |
| **各部门 Lead** | 派下去的活被 eng-highway 反噬 | 派发那一刻说清这是什么活,就走对应的流;**任何部门都能做任何类型**;必要时单次 override |
| **Runner** | 一份报告也走 设计→实现→QA | 拿到相称模板;通用模板单 session 直接干 |

**目标**:每件活按类型走相称模板;**任何部门都能做任何类型**;**绝不再默认 eng-heavy**(v2-routed 上「认不出」不再是静默落最轻,而是**拒绝派发**、要求派发者当场判断);**路由信号不得静默改变行为**(§5)。

**非目标**:不动 DAG enable/disable(flag 层);不写实现代码。⚠️ **不宣称「零引擎改动」**(§4.6)。

---

## 2. 现状(grounded)

- 6 套 seed 已定义;**生产库只装了 3 套工程模板**(v2 被 generalized flag 挡)。
- `taskCategory` 只从 `req.body`(`runs-route.ts:928`),**没人传** → 恒 `*` → eng-heavy;**label→category derive 代码里不存在**。
- 坏 binding 根因(git 实锤):seeder 的「项目已有 binding 就跳过」守卫(`workflow-template.ts:1151`),旧版本只种一条 wildcard 后永久跳过老项目。
- DAG 现休眠(`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=0`);flywheel 项目 config 已有 `pipeline.dag: true`。

---

## 3. 方案

### 3.1 🔑 分合判据

- **只差【模型】→ 合并**:工程重/中/轻流程相同、只换模型 → **1 套工程模板 + 模型旋钮**。
- **流程【形状不同】→ 分开**:PRD / designer / prototype 三种流程形状不同(§7),不是重复。

> Annie:「我们还是必须得有 designer 和 prototype 的模板吧,因为它和产品出 PRD 完全是不一样的 flow 呀」。

### 3.2 ★ SSOT:活的类型 → 模板

> Annie 定主轴:「理论上 engineering 部门是不是也可以出 PRD?可能也可以。我只是不希望我们把东西写得太死。」⇒ **若部门决定模板,工程部就永远出不了 PRD** ⇒ 主键 = 类型,**部门值只是写在指令里的建议**,服务端不会拿它顶替(§4.7)。

**每个项目要种的 live rows(迁移直接照这个)**:

| category key | 模板内部 id | 模板(人话) |
|---|---|---|
| `prd` | `tpl_product_v1` | 产品-PRD 模板(已存在) |
| `designer` | `tpl_product_designer` | 产品-designer 模板(🆕,§7) |
| `prototype` | `tpl_product_prototype` | 产品-prototype 模板(🆕,§7) |
| `code` | `tpl_eng` | 工程模板(3 档合并 + 模型旋钮) |
| `research` | `tpl_generic` | 通用模板 |
| `*` | `tpl_generic` | 通用模板 —— ⚠️ **不是 v2 的兜底**:开关 on 后 fresh selection 不消费它;它是**未切换项目的现行路径 + 回滚防线**(§9 验收 5b) |

**任何部门都能走任何类型**:工程部要出 PRD → **派发那一刻传 `taskCategory=prd`**;**部门不挡**。

**设计理由(不只是结果)**:扁平 key **顺带消掉**复合 key(`dept:product:designer`)的坑 —— binding 查表只有 exact 或 `*` **两级、无层级 fallback**(`StateStore.ts:13214-13220`),嵌套 key 漏种就静默掉到通配;**不嵌套就没有回落问题**。Annie 那一 push 同时让方案**更松、更便宜、还少一类坑**。

### 3.3 库存 6 → 5

工程 3 合 1(−2)· 产品新建 2(+2)· 研究并入通用(−1)⇒ 净 −1,但**多 2 套要真造**(§7/§8)。

- **`tpl_generic`** = 现有单节点 `tpl_ops_light` 重定义/重命名(**替换不是新增**)。⚠️ 代码里的 `generic` 是 v2 **node type** / AgentDispatcher fallback,**不是**可被 binding 指向的模板。
- **退休资格**:旧 5 个 identity 对**所有 fresh selection 不可选**;历史 revision + active pinned run **继续可读可重放**。
- **retire 时序**:必须在 founder-owned refs 处理完、system wildcard/exact cutover 成功、**复查旧 identity 零 live refs** 之后执行。

### 3.4 工程模板的模型旋钮

3 档拓扑相同、只差每节点 vendor/model/effort。**下表是现有 seed 的事实参考,非 target contract**;产品合同 = **tier 是轻/中/重成本能力刻度**(不锁 vendor)。

| 节点 | trivial | light | heavy |
|---|---|---|---|
| 设计 | codex | codex | claude |
| 实现 | codex | codex | codex(xhigh) |
| QA | claude(轻) | claude(重) | claude(重) |

⚠️ **不是零引擎改动**:`applyWorkflowOverride` 只接受 model/effort/skip 且**强制 vendor 兼容、不能切 vendor**(`workflow-template.ts:998-1019`);selection 调 materialize 时**没传 override**。FLY-1385 二选一:(a) 各档同 vendor 预置复用现有 override;(b) 扩 override 支持受校验的 vendor+model 原子覆盖。**注入点** = `materializeWorkflowRun`;**类型选模板、tier 选 preset 两轴正交**。

---

## 4. 核心机制

### 4.0 ★★ 上位原则:**路由判断在派发那一刻做,不读单子上的存量标记**

> ⚠️ **先看清适用域再往下读**:这条原则**本单只落到 work-kind 与 `no-three-stage` 两样上**。系统里其它读存量 label 的地方**一律不动** —— 详见本节末的例外表与 catch-all。

**Annie 的反对(她抓出来的,机制因此改了)**:

> 「开完单可能几周后才被捡起来,这中间系统会变很多,那时候开单时写的旧标记已经不作数了。」

**为什么这一击是致命的**:我们**当初否掉「行为标签从 issue 继承」,理由正是「它会过期」** —— 标签是开单那一刻贴的,几周后没人记得它还在。但我们**没看出标题前缀是同一类东西**:它同样是**开单那一刻写的**,同样在单子躺着的几周里悄悄失效。**我们用一个会过期的信号,去替换另一个会过期的信号。** 是 Annie 用「单子可能搁几周才被捡起」把这个盲点抓出来的。

**⚠️ 这一段留着,是为了防止以后有人再提一个「在开单时写下的路由信号」。但判据要写准 —— 首要判据不是「写得早不早」:**

> 🔑 **首要判据 = 这个信号描述的是「身份」还是「这次的用法」。**
> - 描述**身份**(不随时间变的属性,如归属哪个部门)→ **写在单子上完全正当**,开单时写也没问题;
> - 描述**这次的用法**(这次拿它当什么做)→ **它天生属于派发那一刻**,写在单子上从一开始就是把「一次性的用法」记成了「单子的属性」。
> ⚠️ **「会过期」是症状,不是裁决标准** —— 过期只是**把这个错误暴露出来**的方式。标题前缀被否掉,**是因为它编码的是用法**,不是单纯因为它创建得早。
> ⇒ **推论**:将来**在开单时写下的 identity 信号是明确允许的**;usage 信号则无论写得多晚、更新得多勤,**都不行** —— 别以为「只要够新就合法」。

**⇒ 定案(Annie 点头)**:

| | 它标注的是什么 | 什么时候定 | 会不会过期 |
|---|---|---|---|
| **部门标签** | **不随时间变的身份** —— 这单归哪个 Lead | 开单时 | **不会** —— 身份不随时间变;Annie 也确认现在真在用、也管用 |
| **work-kind** | **这次拿它当什么做** | **派发那一刻,由派它的 Lead 现给** | **不会** —— 因为是现做的判断 |

> **🔑 判据本身(Tadashi 给的,比我们原来的解释准,写进来当原则)**:
> **部门标签标注的是「不随时间变的身份」,work-kind 标注的是「这次拿它当什么做」。**
> ⇒ 后者**本就该在派发那一刻定** —— 这不是「为了避免过期而挪到派发时」的权宜,而是**它本来就属于那一刻**。同一张单,今天可以当研究做、下个月可以当 PRD 做,**单子本身没变,变的是这次拿它当什么用**。所以把它写死在单子上,从一开始就是**把「一次性的用法」记成了「单子的属性」**。
> ⇒ 这条判据也顺带回答了「以后能不能再加一个开单时写的路由信号」:**如果那个信号标注的是身份,可以;如果标注的是「这次怎么用」,不行。**

**标题前缀 parser 整段删除。** 它连同 `·HL` routing-intent 命名空间、拼错阻断规则、前缀词表 —— 全部不做。

> **🔑 顺带消掉的一整类失效**:前缀 parser 一删,「**拼错的 work-kind marker 静默落默认**」这个静默点就**不存在了**(它是 §5.5 表里的第 4 例)。这和「不继承」消掉 1392 那类残留标签是**同一种收益** —— 不是加一道校验去防它,而是**让它无法被表达**。

**🔴 适用域必须写准 —— 这条原则不是「系统再也不读任何存量 label」**(Codex pivot #1;我原先写得过宽,已收窄)

**唯一被切断继承的,是 work-kind 与 `no-three-stage` 这一个行为覆盖,且只在 master fresh-main 域内。** 系统里**仍然在读存量 issue label 的地方**(实锤,本单**不动**):

| 仍读存量 label 的地方 | 出处 | 本单处置 |
|---|---|---|
| **部门 label** → `owningDept` → 归属 + work-kind 的**建议值**(v2-routed 上不静默生效) | `runs-route.ts:745` | **明确保留** —— 它是**唯一允许参与 category 的存量信号**。理由:归属关系稳定、不随时间失效,且 Annie 确认现在真在用 |
| **`codex-skip`** → 进 start behavior snapshot → 送 DAG dispatch(会跳过 review) | `runs-route.ts:1093-1095`、`:1434-1436` | 🔴 **out of scope,仍会继承**。本单只切 `no-three-stage` |
| **`founderFacingUx`** 的 exempt-label / QA-title 判定 | `runs-route.ts:1088-1105`(真正的消费点在 `:1100-1105`;`:1104` 显示 QA 标题也参与) | 🔴 **out of scope,仍会继承** |
| **`no-qa`** → 跳过自动 QA | `bridge/auto-qa-policy.ts:36,47` | 🔴 **out of scope,仍会继承** |
| **`no-vision`** → 关掉 vision 默认 | `bridge/proofshot-trigger.ts:291` | 🔴 **out of scope,仍会继承** |
| **scoped / tokenless / 非-main role 的 legacy start** 读 Linear 上的行为 label | `three-stage-policy.ts:119-125` | 🔴 **out of scope,行为原样不动**(否则破坏「legacy 字节兼容」) |

> ⚠️ **上表是 dispatch 邻域的举例,不是穷举清单。** **catch-all 合同**:除 work-kind 与 `no-three-stage` 外,**任何其它从存量 issue label / 标题读取行为的地方,本单一律不动**。实现者**不得**因为某个读点没被列进这张表就认为它该被切掉。
>
> 🔴 **这些读点目前没有接收方 —— 而且明确不是 FLY-1393(先前记错了,已更正)**。FLY-1393 的 scope 是 **flag 真值修复(开关 ↔ 组件接线)**,**不含存量 label 读点的盘点**。`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 全是 **label 面**,和它不是一回事。
> ⚠️ **把它们挂到 1393 头上 = 看起来有人接、实际掉进缝里** —— 那正是本 PRD §5.5 在讲的那类病的又一个变种(**一个错误的接收方,比明写「没人接」更坏**)。
> ⇒ **本 PRD 的处置**:上表**就是**它们在本单的完整边界说明(列清 + 本单不切 + 为什么不切)。将来若要统一清理,**需要新开一张 label-lint 族的单**;**在那张单真的存在之前,这里如实写「无接收方」,不假装有人接。**

**⇒ 因此「三类失效结构性消失」这句必须带域**:
- ✅ **无条件消失**:过期的标题前缀 · 前缀拼错静默落默认(**parser 都没了,全局归零**)。
- ⚠️ **只在 master fresh-main 域内、且只对 `no-three-stage` 消失**:残留行为标签静默改派发(1392 那类)。**同一类病在 `codex-skip` 上、在 scoped/tokenless legacy 路径上,今天仍然可以发生。**

> **为什么选窄的**:切一个 label 的继承,和切**所有** routing-affecting label 的继承,是**两个量级完全不同的活**。后者要逐个列出现有读点、给每个信号设计 dispatch-scoped 的替代输入 —— 本单的 `routingOverrides` allowlist 里只有 `no-three-stage` 一个,**没有为 `codex-skip` 准备替代口**。硬说「全都不继承」而只实现一个,是**合同和实现对不上**。⇒ 剩下那些的清理,⚠️ **目前无接收方**(见 §4.0 例外表)。

### 4.1 类型判定优先级(**v2-routed 只有两条有效路径**;标题那一级已删除)

**v2-routed 项目 —— 有效路径只有这两条,依次判:**

| # | 路径 | 说明 |
|---|---|---|
| **1** | `req.body.templateId` | 直接指定模板(必须是 active 已发布的 5 套之一;指向 retired/unpublished → fail-loud)。**豁免硬门** —— 它本身就是那一刻的显式路由判断,且已强制非空 `selectionReason` |
| **2** | `req.body.taskCategory` | **★ 判定主力 —— 派它的 Lead 在派发那一刻给**。必须在 **category 词表**内;**非法值 fail-loud,不静默落通配** |
| **两条都没走** | — | 🔴 **拒绝派发(fail-loud)**。**不落部门值、不落 `*`**(§4.7) |

**不在这张表里的两样(它们不是「更低的一级」,而是根本不参与 v2 解析):**

- **部门值(`owningDept`,`runs-route.ts:745`)**:`product→prd` · `engineering→code` 只是**写在指令面/交互文案里的建议**。**没有确认协议** —— Lead 采纳它的做法就是**自己把这个值显式发出来**,那就落回路径 2;服务端**不区分心理来源**。⚠️ **它自己不会顶上**。
- **通配 `*`**:**不是 v2 的兜底**。开关 on 后 v2-routed 的 fresh selection **不消费它**;它服务的是**未切换项目的现行路径 + 回滚防线**(§9 验收 5b)。

**非-v2-routed 项目**:**行为原样不动** —— 走它今天走的那条路(含 `*` 兜底),**不被这张表的任何新规则改道或拒绝**。

> **部门是建议,更不是锁**:工程部要出 PRD,派发时传 `taskCategory=prd` 即可,**部门不挡**;而且在 v2-routed 项目上,**部门值不会因为你没传就自己顶上** —— 没传就是拒绝(§4.7)。
> **`agentName` 不参与类型判定** —— 它只管执行 agent,且 DAG 入口下模板还会覆盖 request 的 agentName(`runs-route.ts:1123-1138`);生产最近 10 个真 session `agent_name` 全空。

### 4.2 category 词表(**现在只有一套了**)

- **CATEGORY 词表(供 `taskCategory` + binding + preflight,唯一一套)**:`prd` · `designer` · `prototype` · `code` · `research`。
- **匹配**:大小写不敏感、容忍空白;canonical 输出 = 小写词表值。**大小写不敏感是合法输入,不是异常、不提示。**
- **`taskCategory` 边界语义(写死,别留给实现者)**。🔴 **以下全部只在该项目的 cutover 开关 on 时生效;开关 off 时逐字保持今天的行为**(§4.7):
  - 缺失 / null / 空白 → **absent**(⇒ **v2-routed 项目触发 §4.7 的 required-param gate、拒绝派发**;非-v2-routed 项目行为不变);
  - 大小写差异 → **canonicalize,合法**;
  - **present 但非 string(如 `42`)→ 稳定 4xx**,**不再静默当 absent**;
  - **在词表外的非空值(含拼错,如 `desiner`)→ 稳定 4xx**。
  - ⚠️ 现状 `runs-route.ts:926-935` 对非 string 是**静默当 absent**,**这一条是有意改变现状**(理由 = §5.5 通则:显式路由输入不得静默降级),需在验收里覆盖。
- **⚠️ 拼错在新机制下是「当场报错」不是「几周后跑错」**:`taskCategory` 是**派发那一刻传的**,4xx 立刻打在派它的 Lead 脸上、当场改掉重派。这和旧方案里「开单时把前缀拼错、几周后没人知道地跑错模板」是**完全不同量级**的失效 —— 所以这里**不需要**旧方案那套「阻断要求确认」的复杂机制,一个稳定 4xx 就够。
- **`qa` 不进 category 词表、不进 binding**(库存里没有 qa 模板)。现有 `sessionRole=qa` 继续走 legacy,不被改道。
- **适用域(必须写死)**:词表校验 / exact enforcement **只作用于 fresh main-role entry**;**active recovery、非-main role(尤其 QA)、scoped/tokenless legacy start 不受影响、不被改道或拒绝**。

### 4.3 Truth table

| 输入 | 结果 |
|---|---|
| `templateId` 合法已发布 | 用该模板(记 provenance) |
| `templateId` 指向 retired/unpublished | **fail-loud**,不物化 run |
| `taskCategory` 非空且在词表内 | 用该 category;**必须命中 exact row**,否则 §4.4(a) |
| **(开关 on)** `taskCategory` 非空但不在词表 / 非 string | **fail-loud**(稳定 4xx) |
| **(开关 off)** 同样输入 | 🔴 **逐字保持今天的行为** —— 非 string **静默当 absent**;**不得**提前应用新 4xx |
| **v2-routed 项目**,`taskCategory` absent **且无合法 `templateId`** | 🔴 **拒绝派发,稳定 fail-loud**(§4.7)—— **不落部门值、不落通配**。这是本单唯一新增的硬门 |
| **v2-routed 项目**,`templateId` 合法已发布(无 `taskCategory`) | ✅ **豁免硬门** —— 直接指定模板本身就是显式路由判断,且已强制非空 `selectionReason`;`category_source = template_override` |
| **非-v2-routed 项目**(legacy / 未切换),`taskCategory` absent | **行为原样不动** —— 走它今天走的那条路,**不被新 gate 拒绝**(§4.7 边界) |

> **部门 scope 403**(`runs-route.ts:647-690`)是**独立的派单授权 gate**,不在这张表里,**不得**被解释成「部门决定模板」。

### 4.4 fail-loud 两分

- **(a) 走 `taskCategory`→binding 这条路径、但该项目缺 exact row** → **fail-loud、不物化 run**。⚠️ **`templateId` 路径不受这条约束** —— 它**跳过 binding**,只校验模板 active/published/fresh-eligible + 非空 reason + provenance;**审计用的 category / sentinel 不要求 exact binding**,否则刚定的豁免又被这条撤销一半(配置 bug;配 §5 上线检查后近乎不可达,纯防御)。⚠️ 需**能区分 exact 命中 vs wildcard 回退** —— 现有 lookup 对 exact miss 自动回 `*`,所以这是**新增 runtime enforcement,不是纯种子能兑现的**。
- **(b) v2-routed 项目缺 work-kind** → 🔴 **fail-loud 拒绝派发**(§4.7 的 required-param gate)。⚠️ **这与 (a) 不同**:(a) 是配置 bug,(b) 是**派发者没做那个判断**,拒绝就是要求他现在做。
- **(c) 非-v2-routed 项目** → **不适用本节任何新规则**,行为原样不动。

### 4.5 provenance + idempotency

- **两条独立轴**:保留 `selection_source = lead|binding|default`(模板来源)原义;**新增 `category_source = task_category | template_override`**(v1 就这两个)。⚠️ **不再有 `title_prefix`**;⚠️ **也不设 `department_default` / `confirmed_department_suggestion`** —— 前者在 v2-routed 上根本不会生效(缺值直接拒派),后者**服务端不可判定**(§4.7)。`wildcard` 只在**非-v2-routed 的旧路径**上有意义,**不进 v2 的 provenance 词表**。canonical category / source / tier 一并进 **selection digest + pinned snapshot**。
- **`templateId` 直选的合同**:真实 resolver 在 `templateId` 存在时**跳过 binding、记 `selection_source=lead`、并强制非空 `selectionReason`**(`workflow-template-selection.ts:37-41,146-156`)⇒ **PRD 保留「非空 selectionReason 必填」**;此时 **`category_source = template_override`**,category 记为审计用途、**不参与选模板**。
- **显式字段的校验顺序(写死)**:**先校验、后按优先级取** —— 即使 `templateId` 会胜出,**同请求里非法的 `taskCategory` 仍然报 4xx**,**不被静默忽略**。
- **idempotency 三态**:完全相同请求 → 精确 replay;active pipeline-DAG run → candidate-free pinned recovery;**同 key 但 digest 不同且不在 recovery 域 → 409 mismatch,绝不新建第二个 run**。

### 4.6 诚实的改动面(**「零新代码」只对一部分入口成立**)

**判定来源这一层确实零新代码** —— `taskCategory` 是 `req.body` 上**已经存在**的字段(`runs-route.ts:926-935`),不需要新解析器。**但「Lead 能不能传」要分三个派发面看,不能一句话带过**:

| 派发面 | 现状(核过) | 要不要动 |
|---|---|---|
| **Claude Lead**(生产主力) | 按 `department-lead-rules.md:142,152,177` 直接 `POST /api/runs/start` | **传输层不用动**(原始 body 直通,今天就能传);🔴 **但 runtime rules 必须改,且是开关翻转的硬前置** —— 该规则文件今天一次都没提过 `taskCategory`(§4.7⑤ / §8-D) |
| **Gemini Lead backend** | `dispatch_runner` 工具 schema 只声明 `issueId` / `projectName` / `agentName` / `docTier`(`gemini-agent/src/tools/schemas.ts:66-98`),handler 是 `args` 直通(`registry.ts:113-114`) | **要加一个 🔴 required enum 参数**。⚠️ **`docTier`(`schemas.ts:88-92`)只是 enum 写法的先例 —— 借它的 enum 形状,不借它的 optional 性质**:这一面是模型在选参数,required 才能逼它产出一个值 |
| **Codex Lead backend** | `start_runner` **明确不在** gateway 工具面内(`action-surface.ts:53-61`,属 FLY-251) | **本单不涉及** —— 它现在根本不派 Runner |

**FLY-1385 仍需**(与派发面无关的引擎侧):① **preflight 之前**一次算定 effective category(现 preflight 输入只有 project/taskCategory/templateId,不含 owningDept,`runs-route.ts:926-950`),**同一 canonical 值同时喂 preflight 与 materialization**;② **exact-presence enforcement**(§4.4a);③ `taskCategory` **词表校验 + 类型边界**;④ provenance/digest 扩展(含 §4.7 的回显);⑤ **v2 入口三件套**(§6);⑥ tier preset plumbing。

> ⚠️ **不要把「不用写 parser」说成「零工程量」** —— 上面六项一项没少。删掉的是**新增的那个解析器**,不是接线本身。

### 4.7 🔴 **required-param gate —— 缺 work-kind 就拒绝派发**(Lead 拍;取代早前的「部门默认兜底」)

**先说被推翻的是什么**:这一节早前的论证是「**拦不住遗忘,所以让遗忘不致命**」—— 靠部门默认兜底 + 回执可见 + 漂移可度量。**Tadashi 给了一个事实,把这个论证的前提打掉了。**

**🔴 那个事实(操作陷阱,不是理论担忧)**:`taskCategory` 和 `agentName` **同构** —— 都是「派发时可选传的路由参数」。而 **`agentName` 在生产里从来没人传过**(本单早前审计:最近 10 个真 session 的 `agent_name` **全空**)。

**⇒ 推论,而且很硬**:留一个「不传就有默认」的可选参数,在这套系统里的实际结果**不是「大多数时候传、偶尔忘」,而是「一次都不传」**。
- ⇒ 「部门默认兜底」不是 fallback,**它会变成唯一实际生效的路径**;
- ⇒ 「显式传入」不是主路径,**它永远不会发生**;
- ⇒ 整套方案悄悄退回**「部门决定模板」** —— 而那正是 §3.2 里 Annie 亲自否掉的东西。

**⇒ 定案(Lead 拍):走 required-param gate。**

| | 规则 |
|---|---|
| **硬门** | **v2-routed 项目,派发时既无合法 `templateId`、也无显式 `taskCategory` → 拒绝派发,稳定 fail-loud。** 不落部门值、不落通配、不「提示一下照样跑」 |
| **部门值的新地位** | **降级为纯指令面/交互文案里的建议,不进服务端语义** —— **没有任何「确认协议」**:Lead 采纳它的方式就是**自己把这个值显式发出来**,服务端**不区分也无法区分**它的心理来源。⚠️ **v2-routed 上它绝不会自己顶上**,没传就是拒绝 |
| **为什么不留静默默认** | 「部门默认兜底」听着友好,但**它就是一个静默默认** —— 正是本 PRD 一路在杀的那类东西(§5.5)。而且既然生产从没人传过这类参数,**留默认 = 默认永远生效、显式永远不发生** |
| **它为什么是机制不是纪律** | 派发者**在那一刻读单定类**,就是**填这个必填项的动作本身**。gate 保证它**不可能被忘** —— 忘了就派不出去。**这不需要任何人记得任何事** |
| **provenance** | 🔴 **v1 只记一个来源:`category_source = task_category`** —— 见下方「为什么砍掉『确认了建议值』这个来源」 |
| **`templateId` 是否满足硬门** | ✅ **满足,明确豁免**。直接指定 `templateId` **本身就是那一刻做出的显式路由判断**,而且 resolver 已强制**非空 `selectionReason`**(`workflow-template-selection.ts:37-41,146-156`)⇒ 判断做了、理由也写了,**再要一个 `taskCategory` 是重复劳动**。此时 `category_source = template_override`,category 仅作审计 |

**🔴 为什么砍掉「确认了建议值」这个 provenance 来源(Codex gate1 #2 抓出,是真缺陷)**

早前写的是:`category_source` 记 `task_category`(显式传入)**或** `confirmed_department_suggestion`(确认了建议值)。**这个区分在服务端不可判定**:
- 到达服务端的只有**一个 `taskCategory` 字符串**。`taskCategory=code` 到底是 Lead 独立判断出来的,还是他看到 `engineering→code` 的建议点了确认 —— **请求里没有任何事实能区分这两者**;
- Claude Lead 走的是**裸 HTTP**,**根本不存在「先展示建议、再确认」的协议**;
- ⇒ 实现者只能**任意**把同一个请求记成两者之一,那么基于它的「走过场」指标就是**编出来的**。

> **⚠️ 这正是本 PRD 一直在杀的东西的一个变种**:一个**看起来可观察、实际不可判定**的 provenance 字段,比没有这个字段更坏 —— 它会让人以为自己在度量确认质量。

**⇒ v1 定案:所有实际发送的值一律记 `task_category`**,不设 `confirmed_department_suggestion`。**部门建议值只存在于指令面 / 交互文案里,不进 provenance 词表,也不存在任何「确认协议」** —— Lead 采纳它 = 他自己把这个值显式发出来,和他独立想到这个值**在服务端完全同形**。

**⇒ 那个「走过场」的问题还答得了吗?答得了,而且不需要新输入** —— 换成一个**诚实命名的代理指标**:
> **「本次发送值 == 该部门建议值」的占比**(这是**可算的**:两边服务端都有)。
> ⚠️ **它证明不了走过场** —— 独立判断的结果本来就常常等于建议值(建议值取的就是该部门最常见的活)。**它只是一个提示信号**:这个比例**接近 100%** 时值得去看看**分类实践是不是已经机械地等同于建议值**。**必须按这个口径命名和解读,不许当成「走过场率」。**

**🔴 边界(硬要求,别把正常派发打爆)**

**🔴 先把 `v2-routed` 定义死(Codex gate1 #1/#4;含糊会直接毁掉回归 fixture)**

> **`v2-routed` ≡ 该项目的 work-kind cutover 开关(§6 那一个 per-project 开关)已打开。**
> ⚠️ **不是**「该项目存在 v2 binding / candidate」。**dormant 的 v2 binding 在场但开关 off ⇒ 仍算 non-v2**,行为完全不变 —— 这正是 §6 第 3 步那条回归 fixture 要守住的场景;若实现者按「有没有 v2 binding」判断,**那条 fixture 会被自己实现的判据打穿**。
> ⚠️ **判定时点**:这个分支必须发生在 **candidate / binding lookup 之前** —— 否则「要不要拒绝」会依赖「查到了什么」,又变成一个隐式耦合。

**🔴 所有本单新增的 `taskCategory` 行为,一律挂在这同一个开关后面**(不只是「缺参数拒绝」这一条):
- **开关 on**:absent → 拒绝;非 string → 稳定 4xx;词表外的非空值 → 稳定 4xx。
- **开关 off**:**全部保持今天的行为** —— 包括 `runs-route.ts:926-935` 今天对**非 string 静默当 absent** 这一条。⚠️ **不得**因为「校验总是好的」就把新 4xx 提前应用到未切换的项目上:**那会让 legacy 调用在 cutover 之前就开始报错**,和「缺参数拒绝」写宽了是同一种事故。
- ⇒ 验收必须是 **开关 on/off × (absent / 非 string / 词表外)** 的**六格全覆盖**,不是只验「缺参数」两侧。

**这个 gate 只对 `v2-routed`(= 开关已开)的项目生效。**
- **非-v2-routed 项目(legacy / 尚未 cutover)的派发行为原样不动**,**不得**被这个必填项卡住。
- ⚠️ **这条边界不是可选的谨慎,是躲过一个 P0** —— 本单已经踩到过一次同类:wildcard 一迁 v2,**普通 keyless 派发就从「回落 legacy 成功」变成 409**,今晚 Batch 2 的两张单正是靠旧路径才派出去的(§5.5 第 3 例)。**一个作用域写宽了的硬门,会在上线那一刻打爆所有正常派发。**
- ⇒ 验收必须同时覆盖**两侧**:v2-routed 缺参数**拒绝**;非-v2-routed 缺参数**照常成功**。

**仍然保留的两条(它们现在服务于「查得到、看得见」,不再承担「兜底」)**

**① 回显 —— 但要诚实说清回执什么时候到**
派发回执里**必须**明说:本次用的 work-kind **是什么** + 它**来自哪**(**只有 `task_category` 与 `template_override` 两个值**)。落地就是 `category_source` 进 route decision 记录**并出现在回执**;⚠️ **仅写一条没人看的 audit 不算可见**(§5.4)。

> **⚠️ 时点的诚实边界(源码实锤,别写成「只损失一次重派」)**:`/api/runs/start` 的成功路径是**先 `startDispatcher.start(...)`(`runs-route.ts:1424-1459`)→ 等 session 注册与 launch 投递(`:1464-1529`)→ 最后才发 200**(`:1531-1545`;202 也在 durable launch 建立后于 `:1513-1524` 返回)。
> ⇒ **派发者看到 category 时,Runner 已经起来了 / 已被 durable-accept**;系统还会挡住第二个 active run。
> ⇒ **产品承诺按实际时点写**:回执**只承诺把发现时间从几周缩短到当场**,**不承诺「不会跑一次错流程」、也不承诺「零浪费」**;**纠正路径 = 先终止那个错 run,再重新 fresh dispatch**,过程中**必须维持 single-active-run**。
> ⚠️ **注意 gate 上线后这条的适用面变小了但没消失**:硬门挡住的是「**没做判断**」,挡不住「**做了判断但判错了**」—— 后者仍会跑一次错流程。

**② 漂移可度量 —— 而且 gate 上线后这个数的含义变了**
`category_source` 每次都记 ⇒ 可以算出**各来源的占比**。
- **gate 之前**它回答的是「大家是不是系统性地忘了传」;**gate 之后**这个问题不存在了(忘了根本派不出去)。**能算的是一个代理指标:「本次发送值 == 该部门建议值」的占比**。⚠️ **它证明不了走过场** —— 独立判断本来就常常落在建议值上。**接近 100% 时值得去看看「分类实践是不是已经机械地等同于建议值」**,仅此而已;**不许把它叫作「走过场率」或据此下结论**。⚠️ 另外「dispatch 那一刻服务端两个值都有」**不等于事后可算** —— 必须**在 route decision 里持久留下可聚合的 `(sent_category, 部门建议值)` 对**(现有代码把 `owningDept` 传给了 dispatcher,但 workflow selection / snapshot **并没有记它**)。
- ⚠️ **「能算」不等于「会被看见」**:既然这个数承担这个职责,就**必须有具名消费者与查看节奏**(建议并进现有周期性回顾,owner = 产品 Lead)。**没有消费者的指标 = 另一条没人看的 audit。**
- 进 §9 副指标;**硬阈值不现在拍**(该由上线后的真实分布来定)。

**③ 指令面仍要改(gate 让它「无法被忽略」,但不能让它「无从判断」)**
`department-lead-rules.md` 全文**一次都没出现过 `taskCategory`**。gate 保证 Lead **不填就派不出去**,但**不会告诉他这五个值是什么、怎么选**。
⇒ **开关翻转前,Claude Lead 的 runtime rules 仍必须更新**:说明 fresh main 派发要先读单定类、五个 work-kind 各自什么时候用、以及**建议值只是建议**。**gate 解决「会不会漏」,指令解决「填得对不对」—— 两件事,都要。**

**🔴 诚实边界(这套不解决什么)**:派发者**填了一个错的 kind**,gate 一样放行 —— 那是**判断错误,不是遗漏**,它在 provenance 里**显式可见**(`category_source=task_category`),但产品层**不假装解决它**。

**保留的一条运行时事实(与上面无关但必须记着)**:
- **retry 复用 pinned,不重 derive**:已物化 DAG run 的 retry 读原 snapshot、同 `run_id/node_id/snapshot_digest` 生成 successor(`actions.ts:869-918,1052-1067`),**不调 template selection、不查当前 binding**;`retryOwningDept` 只服务 agent routing。只有「旧 run 终结后的全新 fresh start」才重新解析 work-kind。⚠️ **gate 也不作用于 retry** —— 它只管 fresh dispatch。

> **注**:旧版本这里还有一条「坑① 标题/标签是派发时快照,派发后再改不重读」。**新机制下它不再是坑** —— 我们不读标题、work-kind 也不从 issue 上读,所以「读的是哪一刻的快照」这个问题**自然消失**。这正是 §4.0 那条上位原则的价值:**不是把快照读得更准,而是不再依赖快照。**

---

## 5. 🔴 lint(硬要求)

**事故(2026-07-20 真事)**:1392/1393 上残留的 `no-three-stage` 标签,让 1392 被**静默**派成单体 Opus,Annie 当场抓包。**根因 = 外部可变信号在派发边界没有权威校验。**

### 5.1 权威点 = dispatch-time(Tadashi 背书)

- 本 lint 合同的权威信号是 **`/api/runs/start` 请求体上本次显式给的路由输入**(`taskCategory` / `templateId` / `routingOverrides`)。⚠️ **本条只管 work-kind 与 `no-three-stage` 这两样** —— 它们**不再**从 issue 存量标记读取(§4.0);**`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 等其它 stored-label 消费者不受本 lint 合同影响,仍按现状从 issue 读**。校验必须发生在 `no-three-stage` 短路(`runs-route.ts:966-1006`)与 schema 分支之前。
- **立单时校验只是体验层 / 早期提示** —— 它绕得过(Linear UI 手改、建完再改标题标签、其它创建器)。**这正是 §4.0 不再依赖立单时写下的信号的原因之一。**

### 5.2 规则

1. **routing-signal registry**:category 词表 + **本单纳入的那一个行为 label(`no-three-stage`)** + 互斥/冲突规则 + owner/version。⚠️ registry 里**只登记本单真的改了语义的信号**;`codex-skip` / `no-qa` / `no-vision` / founder-facing UX **不进本单的 registry、行为不变**(**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表))。
   > ⚠️ **不再有「前缀词表」这一半** —— 标题前缀 parser 已整段删除(§4.0)。registry 只管**派发时可传的那些值**。
2. **`taskCategory` 输入校验(🔴 仅在该项目 cutover 开关 on 时生效;开关 off 逐字保持现状,§4.7)**:不在词表 / 非 string → **稳定 4xx**;大小写不敏感是合法输入、不提示;absent ⇒ **v2-routed 项目触发 required-param gate 拒绝派发**(非-v2-routed 不变),生效值一律**回显来源**(§4.7①)。**没有「阻断要求确认」这一档** —— 派发时的拼错当场 4xx 打回,不需要确认流程(§4.2)。
3. **行为覆盖的冲突 lint —— 冲突主体只能是「本次显式 `routingOverrides`」**:行为覆盖生效时**必须在派发决定里显式可见**,并满足「不静默」的可测标准(§5.4);registry 给每个行为 label 标 owner + 适用范围。派发时若**本次显式传入的覆盖与本次显式传入的 work-kind 冲突**(如同一请求里既传 `no-three-stage` 又传 `taskCategory=prd`)→ 提示/要求确认,不静默生效。
   > ⚠️ **issue 上残留的 `no-three-stage` 绝不是冲突 lint 的输入**(§5.6,**master fresh-main 域**):它**不改变本次路由、不阻断、也不触发任何确认**,至多作为 documentation intent 被记录。1392 事故在本 PRD 里的作用是**上位原则(§4.0)的成因背景**,不是继续把这个残留 label 喂给冲突 lint 的理由 —— 那等于把已经消灭掉的失效模式又请回来。
   > 🔴 **只指这一个 label**:`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 的 label 与 QA-title 判定**仍照现状从 issue 读取**,本条**不是**让实现者去切断或忽略它们(**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表))。
4. **per-project 上线检查**:binding 主键是 `(project, category)` ⇒ 每项目各查各的全集;**必须查 exact rows(不能用会自动回 `*` 的 lookup)**,检查 5 个 kind + `*` 的 target 存在、已发布、fresh-eligible。不过则该项目不得进 DAG。

### 5.3 🟡 `no-three-stage` 语义(**提案待 Annie 确认** —— 会动到现有派发纪律)

**硬事实**:该 label 今天 = 「这张单以单 session 跑」,并显式豁免 schema-v1 DAG entry(`three-stage-policy.ts:72-75`);且 `.flywheel/agents/engineering/pm-executor.md:53-65` 与 `prototype-executor.md:52-62` **要求产品单派发时带它**,免得 co-create/prototype flow 被拆阶段。

**冲突**:新方案要 `prd`/`prototype` 走专门模板 —— 若 label 对 v2 同义,这两类继续绕过新模板;若不同义,现有「单 session」纪律被静默改义、那两个 agent 文件变成错误指令。

**✅ 定案 = A(Lead 拍)**:`no-three-stage` **永远表示「绕过所有 DAG、单 session」**(语义单一、不分版本)⇒ 由 work-kind 模板保证 flow 形状,不再靠这条 label 绕过。

**🔴 时序硬约束 —— 用「一个开关」表达(§6;取代早前「五件同生同死」的写法)**

**真正需要原子的是 runtime 行为集合**,由**同一个 per-project 开关**一起控制,**每次 fresh dispatch 对该开关取一个一致的决定**:
1. work-kind binding 解析;
2. issue 上的 **`no-three-stage`** 在 **master fresh-main 域**内**不继承**(§5.6;⚠️ **只这一个 label** —— `codex-skip` / `no-qa` / `no-vision` / founder-facing UX / legacy 路径的 label 读取本单不动,**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表));
3. 显式 `routingOverrides` / dispatch-time lint / `no-three-stage` hard bypass 的新语义。

**🔴 cutover 的原子单元 = 开关 + binding 行 + prompt 资产,三件一体(Tadashi 确认并加固)**
prompt 资产在 **spawn 时逐字注入** ⇒ 它是**与代码同等的运行时行为源**,不是文档,**必须进原子单元**。

> **🔑 边界判定(Tadashi 给的,写进来防止有人拿 §8-B 的引擎短路来豁免这条)**:§8-B 的引擎短路 + dispatch-time 权威读**能兜住「路由后果」** —— 旧 role 指令让 runner 去贴标签,**贴了也改不了已派 run 的路由**;
> **但它兜不住「指令冲突本身」** —— 新 runner 会收到**自相矛盾的指挥**(role 提示词要它加 `no-three-stage`,而系统已经不认这条继承了)。
> ⇒ **原子性要求成立,不能靠引擎短路豁免。** 「反正路由不会错」不是跳过这条的理由:**一个收到矛盾指令的 runner,本身就是缺陷**。

**不在原子集合里的**:
- `.flywheel/config.yaml` 注释 —— 纯注释,**翻转后跟进即可**。

**在原子集合里的第三件(源码更正)**:
- ⚠️ **两个 agent markdown 不是纯文档,是 runtime prompt 资产**:`pm-executor.md` / `prototype-executor.md` 在 `.flywheel/config.yaml:187-215` 注册为 `agent_file`,由 `Blueprint.ts:2170-2221` 在 **Runner spawn 时逐字注入 Agent Role system prompt**;它们**当前还明确要求派发者加 `no-three-stage`**。
  - **产品约束(必须满足)**:**属于「翻转后新做出的派发决定」的 fresh Runner,不得收到与已激活 routing 语义相冲突的 role 指令**(⚠️ 判据是**决定归属**,不是出生时间 —— 属于翻转前 pinned 决定的 Runner 拿旧 prompt 是自洽的、by design)。
  - **怎么做到**(dual-compatible prompt / prompt variant / 部署顺序)→ **交 FLY-1385 / FLY-1380 设计**(§11.5)。**不得**用「它是文档所以无所谓」跳过这条。

> **提前撤 = 产品单立刻掉进三段式** —— 正是这条 label 当初要防的。**cutover 前一切照旧**,不得单独先撤。
> ⚠️ **那两个 agent 文件本 PRD 不动**:纪律变更已由 Lead 明说给 Annie,**标「agent 文件改动待 Annie 点头」**;她点头前 §6 cutover 保持 blocked。

**备选 B(未采纳)**:只豁免 legacy/v1 ⇒ 必须改名或版本化(否则同 label 两义)并迁移现有使用者。

### 5.4 「不静默」= 可测结果

**本次请求中**非法或互相冲突的**显式**输入,要么**阻止 start 并返回稳定 error code + 幂等一次 Cass 提醒**,要么**要求显式确认**;**仅写一条没人看的 audit 不算**。合法行为信号生效时也要有 route-decision 记录,且 **legacy 与 schema-v2 两条路径都可观察**。⚠️ **「残留信号」不在这条的作用对象里** —— issue 上残留的 **`no-three-stage`** 不改变本次路由、不阻断、也不要求确认(§5.6,master fresh-main 域);本条只约束**本次请求显式带来的**输入。⚠️ 这**不**是说系统不读任何存量 label:`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 仍按现状读取,不受本条约束。

### 5.5 🔴 行为不许悄悄变,控制面不许是假的,修复不许是没生效的,装载也不许是没发生的

> **一句话脊柱(四个面,缺一不可)**:
> **① 系统不许在没人知道的情况下改变自己的行为;② 「你以为你在控制它」必须是真的;③ 「你以为你修好了」必须是真的;④ 「你以为它已经装进去了」也必须是真的。**
> —— 前四例是①,第 5 例是②,第 6 例是③,第 7 例是④。**而且第 7 例告诉我们两件事:光看它行为对不对,这四条一条都验不出来;而且【在起点取证】(看配置、看参数、看文件)也验不出来 —— 必须在终点让它自己说出来。**

本单一路查下来,**同一个病在七个完全不同的地方各犯了一次**(前四个是「没人动代码,但行为变了」;第 5 个是「你以为你在控制它,其实那个开关没接线」;第 6 个是「你修好了,被修的东西还在跑旧的」;第 7 个是「以为装进去了,其实整条装载链从没被验证过」)。这七条不是举例凑数,**全是本次调查里撞到的真事**:脏标签静默改派发(1392 事故)· 一行配置差点静默打死全部 keyless 派发 · Bridge 重启会静默激活 binding · 拼错的 work-kind 标记会静默落默认 · **被拍板打开的那个开关是死的,而真正在发警报的那条路径没有对应的总开关** · **规则改了也 merge 了,但长驻 Lead 不重启就一直跑旧那份** · **命令行参数里明明装着 18 份规则,实际只有最后一份进了上下文,而当事人行为一直正常所以整夜没人发现**。**七个真例子比讲道理有力** —— 它们分别来自**标签面、配置面、部署面、输入面、控制面、生效面、装载面**,说明这不是某一处的疏忽,而是同一条脊柱在七个面上都缺了。⚠️ 第 5、6、7 例是后来补进来的,而且**一个比一个阴**:第 5 例是「你以为你在控制它」,第 6 例是「你以为你已经修好了」,第 7 例是「你以为它装进去了 —— 而命令行参数看起来完全支持这个结论」。三者都见表下的说明。

> **⚠️ 第 4 例的处置在机制改版后变了,但例子留着** —— 见下表第 4 行。留着是因为**它记录的是真实发生过的思路**:我们一度打算「加一道阻断校验」去防它;后来 §4.0 把整个前缀 parser 删了,这个静默点**连发生的地方都没有了**。**「消掉它」永远好过「校验它」,这条经验比那道校验本身值钱。**

| # | 静默点 | 会怎样 | 显式 gate / 权威校验 |
|---|---|---|---|
| 1 | **残留的行为标签**(1392 事故) | 1392/1393 上残留的 no-three-stage 让 1392 被静默派成单体 Opus | **`no-three-stage` 不继承**(§5.6;⚠️ **只切 `no-three-stage` 这一个,且只在 master fresh-main 域内**;其它存量 label(`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 等)**行为原样不动,**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表)**)+ dispatch-time lint 权威 gate(§5.1) |
| 2 | **重启静默激活**(boot seeder) | seeder 在 Bridge warm 时自动跑,默认集一换,**一重启就把 live binding 写下去** | 1380 默认集**保持 dormant**;cutover 只能由**有 activation gate 的一次性迁移**触发(§6) |
| 3 | **配置行静默改行为**(wildcard 迁移) | wildcard 一迁 v2,**普通 keyless 派发从「回落 legacy 成功」变成 409**;今晚 Batch 2 的 1392/1385 正是靠回落才派出去的 | 迁移 PR **必须带回归 fixture**(每个只有 wildcard 的项目,keyless legacy start 依然成功;**且场景须为 dormant v2 binding 在场 + 开关 off**,见 §6 第 3 步)+ 先补 v2 入口三件套(§6) |
| 4 | **拼错的 work-kind 标记静默落默认**(⚠️ **已被结构性消灭,非现行方案**) | 旧方案里标题写 `[Desiner·HL]`,**意图明确但拼错** → 若静默落部门默认,这张单会**跑错模板而没人知道**,而且是**几周后**才跑 | **不再需要那道阻断校验** —— 标题前缀 parser 整段删除(§4.0),这个静默点无处发生。今天的等价输入是派发时传错的 `taskCategory`,它**当场稳定 4xx** 打回给派它的 Lead(§4.2),不是几周后无声跑错 |
| 5 | 🔴 **控制面与真实行为脱钩**(开关是死的) | `FLYWHEEL_STUCK_ERRORSIG` 在 FLY-1243 就**退役了、生产零读取** —— `env=1` 是**一具尸体**;真正在发警报的是 HeartbeatService 那条路径(DB 活动停滞即发),而**它没有对应的总 enable 开关**(⚠️ 精确说法:**不是「毫无任何确认或 kill switch」** —— 确认层是 FLY-1234 的 `STUCK_PANE_CONFIRM`;缺的是**一个能整体开关这条告警路径的控制面**) | 每个「看起来能调行为」的控制面,**必须能指出它实际接到哪条代码路径**;**退役的开关要真的删掉**,不能留在环境里假装还管事;**真正在跑的行为路径不该没有开关** |
| 6 | 🔴 **补救措施本身静默失效**(修好了,被修的东西还在跑旧的) | rules 是 **Lead 会话启动时**加载的 ⇒ 即使内容改了、PR 也 merge 了,**长驻 Lead 读到的仍是它启动时那份,直到重启**。⚠️ **这一条在 launcher 修好之后依然成立** —— 那时合并后的 rules 才真进上下文,而「进去的是哪一版」仍由重启决定 | 它是 §8-D 四拍里的 **②→③ 风险**:内容 merge(②)之后**必须重启并哨兵读回(③)**,否则等于没改。⚠️ **第 7 例说明:①(launcher 修复)在②之前也不能省** |
| 7 | 🔴 **整条装载链从来没被验证过**(而且它推翻了当晚最像铁证的那份证据) | `--append-system-prompt-file` 是 **last-one-wins**(哨兵实验 + 反序对照实测)⇒ **每个 Lead 实际只装了清单里最后一份**;Cass 那 18 份里真正进上下文的只有 `screencapture-l3-skill.md`,`department-lead-rules.md` 与 `cos-lead-rules.md` **都没进去**。**而 argv 里它们全都在** —— argv 只证明 launcher 想装 | **① launcher 修复(拼接成一份、单 flag)→ ② 更新内容 → ③ 重启 + 哨兵读回 → ④ 才许翻 flag**(§8-D)。**验证装载必须在【终点】取证,argv 是必要非充分** |

**通则(写给工程)**:凡是「改一行配置 / 换一个默认集 / 加一个标签」就能改变派发行为的地方,**要么有显式 activation gate,要么在权威边界(dispatch-time)被校验并可观察**;**不接受「事后 audit 里能查到」当作不静默**。

**🔴 第 5 例为什么比前四例更锋利(值得单独说)**

前四例是**「行为被悄悄改了」**;第 5 例是另一种病:**你以为你在控制它,其实那个开关根本没接线。**

- 被拍板打开的那个开关**是死的**(退役、零读取);
- 而**真正在发警报的那条路径,没有对应的总 enable 开关**;
- ⇒ **人以为在管事的控制面,和系统实际的行为路径,是脱钩的。**

**所以这条脊柱不止一个面**(完整四面见本节开头的脊柱句;这里先补上第 5 例带来的那一面):
> **系统不许在没人知道的情况下改变自己的行为** —— 而且 **「你以为你在控制它」也必须是真的**。
> 一个没接线的开关,比没有开关更坏:**没有开关时人知道自己管不了;有一个假开关时,人以为自己管住了。**

**第 5 例的出处与边界(诚实标注)**:来自 Tadashi 在 #flywheel-core 的**自我更正** —— 他用 file:line 推翻了自己先前给出的一半口径;全量证据在 **FLY-1393 的 research.md**。⚠️ 他推翻的**只是这一半**:两个 HOLD runner 被误判的归因(static-frame 低置信问 judge、judge=0 → fail-open)**不变**。**本 PRD 只借用这一例作为原则展品,不对 FLY-1393 的结论作任何断言。**

**🔴 第 6 例:第三类失效**(⚠️ 它一度是本节的收尾;**第 7 例出现后,最难被发现的那个是第 7 例** —— 见紧随其后的那一段)

前面几例还能归到「**行为被悄悄改了**」(1–4)和「**开关是死的**」(5)。第 6 例是第三种:

> **你修好了、也合进去了,而被修的东西还在跑旧的。** —— **补救措施本身静默失效。**

- 它阴在**每一步看起来都做对了**:issue 有了、PR 写了、review 过了、merge 了。**没有任何一步会报错。**
- 而**生效**这件事发生在另一个时间轴上(进程重启),**没有人被通知它还没发生**。
- ⚠️ 而且它**长在我们自己的解法里** —— §8-D 本来就是为了救「Lead 系统性不传 `taskCategory`」而加的硬前置;**如果它自己静默落空,那么这条救命前置就等于没写**,而且**同样不会有人收到报错**。

**⇒ 第三面因此要多加一句**:
> 光有修复不够,**「修复真的生效了」这件事本身也必须被验证**。
> ⇒ 落到合同上就是:**任何「改了某份被进程在启动时加载的东西」的前置项,都必须带上一次可验证的重启确认** —— 只写「已更新」不算完成(§8-D 四拍的第 ③ 拍)。⚠️ **而第 7 例又在它前面加了一拍**:改一份**从来没被装进去过**的文件,连「已更新」都是空的。


**🔴 第 7 例是第四类失效,而且是这七个里最难被发现的一个**

前面三类各管一面:行为悄悄变(1–4)· 开关是假的(5)· 修复没生效(6)。**第 7 例是【第四类】** —— 它管的是**「这东西到底有没有真的装进去」**这一面:

> **从 launcher 到上下文的整条装载链,此前没有任何一环被真正验证过。**

**它是怎么被发现的,这个过程本身就是展品**:

1. 先是发现**排除 CoS 的那道门从来没生效** —— 她 leadId 是 `flywheel-cos-lead`(不是字面 `cos-lead`)、env 又没设 `FLYWHEEL_LEAD_ROLE`,**两条臂一条都没命中**。证据是 `ps` 活进程:参数里赫然装着 `department-lead-rules.md`、一份 CoS 规则都没有。
2. **那份 argv 当晚是最像铁证的东西** —— 「我 ps 了活进程,它就在参数里」。本 Runner 还拿同一把尺「独立复核」过一次,三点全对。
3. **然后哨兵实验把这把尺整个否掉了**:`--append-system-prompt-file` 是 **last-one-wins**,只认最后一份(反序对照确认是位置决定的)。⇒ **argv 里的 18 份,真正进上下文的只有最后一份** —— 那 18 份里既没轮到 `department-lead-rules.md`,也没轮到 `cos-lead-rules.md`。

> 🔑 **一句点透:argv 只证明 launcher 想装,不证明装进去了。**
> 我们看的是**起点**(命令行怎么写的),而要证的是**终点**(上下文里到底有什么)。**在起点取证,永远回答不了终点的问题。**

**⇒ 因此这一节的最后一条,也是最容易被漏的一条**:
> **验证装载,必须在【终点】取证 —— 让被验证的那个会话把哨兵串说出来。**
> **一切「我看了配置 / 看了参数 / 看了文件」都是起点证据,只能当必要条件,不能当结论。**

⚠️ **并且注意第 1 步那个发现【仍然成立】,只是不再是同一个故事**:排除臂确实从来没生效,这一点没变;变的是**它的后果** —— 我们以为后果是「她装了不该装的部门规则」,实际后果是「**谁都没装上任何一份该装的规则**」。**一个错误的证据,可以指向一个真实的问题,却把问题的形状说错。**

**⚠️ 关于「行为对 ≠ 规则接线对」那条,它在这里更强了**:Cass 整夜行为正常,而她实际上**几乎什么规则都没装**(只有一份截图技能)—— 撑着她那些 CoS 纪律的是 project 层 prompt。**表现正常,恰恰是这类故障最有效的伪装;而且它能掩盖的规模,比我们以为的大得多。**

**⇒ 把这条规矩从「建议」升级成「有实例支撑的硬要求」**:
> **判断一个角色被判成了什么 / 谁加载了什么 / 谁需要重启,一律以【被验证方自己读得回什么】为准,不得按名字、按配置、按命令行参数、或按我们对它的印象推断。**

**这一例的出处**:Tadashi 的哨兵实验(两文件各含唯一串,`ALPHA=no / BETA=yes`);本 Runner **独立复跑并补了反序对照**(反序返回 ALPHA,证明是位置决定而非文件本身有问题),并实测 Cass 进程 argv 的最后一份是 `screencapture-l3-skill.md`。


### 5.6 `no-three-stage` 不继承 —— **§4.0 上位原则的推论(窄域,不是全类别)**

> **⚠️ 定位变了(Annie 那一击之后)**:早前这一条是独立发明的「行为标签不继承」特例规则。**现在它不是特例了** —— 它是 **§4.0「路由判断在派发那一刻做,不读单子上的存量标记」**这条上位原则**作用在 `no-three-stage` 上的推论**。work-kind 和 `no-three-stage` **走同一条规则**,不需要各记一套。
> 🔴 **但推论只到这一个 label 为止** —— 上位原则**没有**被应用到 `codex-skip` / `no-qa` / `no-vision` / founder-facing UX 或 legacy 路径上(§4.0 例外表 + catch-all);那些**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表)。

**推论(⚠️ 精确范围)**:**在 master fresh main-role 派发域内,issue 上的 `no-three-stage` 不再继承生效;要它生效,必须在那一次派发时显式带上。** 该 label 留在 issue 上仍可作**意图 / 文档**,但它**不再自动改路由**。

> 🔴 **本单只切这一个 label。** 其它同样从存量 label 读的行为(`codex-skip`、`no-qa`、`no-vision`、founder-facing UX 的 exempt 判定,以及 scoped/tokenless/非-main legacy start 读 Linear label)**全部保持现状、本单不动**,**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表)。**理由**:本单的 `routingOverrides` allowlist 里只有 `no-three-stage` 一个,**没有为其它信号准备派发时的替代输入口** —— 宣称「全类别不继承」而只实现一个,是合同和实现对不上。

**为什么是这条,而不是「owner + 有效期 + 冲突确认」**:后者要靠人正确填有效期、再加一套冲突检测,**机器判据仍是软的**;而「不读存量标记」是**结构上让这个病无法表达** —— 标签是否陈旧根本不重要,因为它本来就不自动生效。**1392 那种「合法但残留」的场景直接消失,不需要机器去判断「旧不旧」。**

⚠️ **但这份收益本单只买到了 `no-three-stage` 这一格**:`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 仍然从 issue 读,**它们身上的「旧不旧」问题一个都没解决**(**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表))。**别把一格的收益写成一片。**

> **🔑 同一条原则消掉的失效 —— 按域分清楚,别笼统说三类**:
> - **全局无条件消失**(前缀 parser 整个删了,病灶物理不存在):② 开单时写的标题前缀几周后已失效(Annie 抓出的那条);③ 前缀拼错静默落默认。
> - **只在 master fresh-main 域、且只对 `no-three-stage` 消失**:① 残留行为标签静默改派发(1392 那类)。**同一类病在 `codex-skip` / `no-qa` / `no-vision` / founder-facing UX 上、在 scoped/tokenless legacy 路径上,今天仍然可以发生**(**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表))。
> **共同点是手法**:不是「加校验防住的」,是「让它无法被表达」—— 但**覆盖面必须如实说,不能因为手法一样就说都消灭了**。

> **🔴 明确顶回「digest 确认」方案(评审提过,本 PRD 不采纳)**:有人会提「把确认绑定到 项目+issue+canonical title/labels+registry 版本 的 digest,任一信号变就失效」。**该方案只有在「master fresh-main 域内的 issue-resident `no-three-stage` 仍会继承生效」的前提下才必要** —— 而本单**取消的正是这一个继承**,所以对它而言这个失效模式**根本不存在**。⚠️ 本单**没有**取消其它行为标签的继承(`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 仍照现状读),**这段顶回只针对 `no-three-stage`,不要外推**。**「派发时显式带上」本身就是那个确认**,且天然只绑定这一次派发:**不需要 digest、不需要有效期、也不需要判断陈旧**。记在这里是为了说明:这不是漏考虑,是前提变了之后**主动选了更省的那条**。

**边界(别扩太宽)**:
- 🔴 **只管 `no-three-stage` 这一条**会影响路由的标签 —— **不是「这一类」**。其它行为标签(`codex-skip` / `no-qa` / `no-vision` / founder-facing UX)**保持现状,**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表)**;**纯文档标签**本来就不受影响。
- 🔴 **适用域只在 master fresh-main 的 cutover 域内(Codex R9 #2)**:**scoped / tokenless / 非-main role 的 legacy start 继续照旧读 Linear 上的 label**(`three-stage-policy.ts:119-125`)—— 否则会破坏 §4.2/§6 承诺的「legacy 行为原样不动」。**不同时承诺「全局不继承」和「legacy 字节兼容」。**
- 「行为标签要不要 owner / 有效期」这个更大的卫生问题 —— **本单 out-of-scope**,⚠️ **目前无接收方 —— 明确不是 FLY-1393**(见 §4.0 例外表)。

**🔴 派发时怎么「显式带上」—— 输入合同(Codex R9 #1;这是权限/路由控制面,不能只写「显式带上」)**
- **字段**:`req.body.routingOverrides`,**allowlist 单值**,v1 **只有 `no-three-stage`**。
- **语义**:缺失 / null / 空白 → **absent(不生效)**;**类型错或不在 allowlist → 稳定 4xx**(不静默忽略)。
- **谁能传 / 何时生效**:**只在 master auth 的 fresh main-role entry**;scoped/tokenless/非-main **不接受该字段**(它们走 §5.6 边界里的 legacy 老路)。
- **provenance**:记 `source = dispatch_override` + selectedBy + reason,进 **route decision 记录**(**可观察**是硬要求)。⚠️ **本 PRD 不规定它是否进 generalized idempotency digest** —— 去重形态(legacy 单-active-session vs 独立 receipt)由 **§11.5①** 定,两者都必须满足:可观察 / 不产生并行第二个 run / 不进 v2 selection。
- **override 只授权「这一次 fresh dispatch」**:后续新的 fresh dispatch **必须重新显式携带**。
- **active DAG run 的 recovery 忽略新 override** —— **理由是「已物化的 DAG 决定拥有优先权」**,**不是**因为 override 被烘进那个 run 的 snapshot。⚠️ 更正:一次**成功触发 no-three-stage bypass 的 fresh start 根本不会创建 workflow run / reservation**(§8-B),所以它**不存在** pinned snapshot;验收不得去找一个产品明令不许创建的 run。
- **优先级**:**显式 override 胜过 issue 上同名的 inert label**(后者本来就不生效)。

**🔴 inert label 不得阻断或要求确认(Codex R9 #3 —— 否则病没消失,只是从「改成单 session」变成「阻断派发」)**
- **路由冲突 lint 只检查「本次显式 dispatch override」**;issue 上的同名 label **可被记录为 documentation intent,但不得改变、阻断、也不得要求确认本次 route**。
- 精确验收(⚠️ **必须标成 non-v2 用例**,否则和 §4.7 硬门打架):**非-v2-routed 项目 + 本次未传 `taskCategory` + issue 上有旧的 `no-three-stage` + 本次无 dispatch override** ⇒ **该 label 被忽略、按该项目今天的老路正常路由、无提示无阻断**;**同一请求带了显式 override** ⇒ legacy 单 session。
- ⚠️ **v2-routed 侧的对应用例是另一条**:**传了 `taskCategory` + issue 上有旧的 `no-three-stage` + 无 dispatch override** ⇒ 该 label 被忽略、按传入 kind 正常路由;**若没传 `taskCategory`,则由 §4.7 硬门拒绝派发** —— 拒绝的理由是缺 work-kind,**不是**那个残留 label。

**🔴 时序**:与 §5.3 同 —— **必须在 cutover 那一步原子生效,不能提前**(提前 = 产品单上的 no-three-stage 立刻失效 → 掉进三段式)。已并入 §5.3 的 **single-switch runtime set**(同一个 per-project 开关控制,翻转前全旧态、翻转后全新态)。

> 🟡 **待 Annie 确认**:这条与 §5.3 的 no-three-stage 决定**是同一条原则**,Lead 正与她一起过;她点头前不实施,§6 cutover 保持 blocked。


---

## 6. 🔴 rollout 安全顺序(Tadashi 读码确认 + 新坑)

**危险实情(逐条实锤)**:工程 seed 是 **schema v1**、产品/通用模板是 **v2**。
- `workflow-template-selection.ts:124-126` 注释原文:**「A v2 candidate never falls back to legacy」** —— v1 + flag off → `return null`(回落 legacy);**v2 + flag off → throw → 409**。**flag off 对 v2 不是保护。**
- `:136-138` v1 keyless → null 回落;`:143-144` **v2 无 `idempotencyKey` → 直接 throw**;keyless 只有 `dagEntry`(v1 政策门内)才合成 key。
- 🔴 **`:141` 新坑(比原先认识的更大)**:**v2 还要求 master auth** —— 就算带了 key,**普通 Lead 派发也会撞「requires master auth」→ 409**。

**🔴 今晚的真近失(写进来当理由)**:今晚 Batch 2 的 **1392/1385 正是靠「wildcard→v1 + flag off → null 回落 legacy」才派出去的**;**wildcard 若已迁 v2,今晚这些全 409**。这属于「**配置行静默改变行为**」家族,与 1392 标签事故同病同治。

**安全顺序(可执行)**:
1. **FLY-1380 只建不迁**(**发布 ≠ 绑定**,Codex R7 #3 的时序矛盾在此解开):
   - **只发布 3 套已定模板**:工程模板 / 产品-PRD 模板 / 通用模板。
   - **designer 与 prototype 两套:§7 flow 合同经 Annie 批准后,由 FLY-1380 创建 + 发布,但仍 dormant(不绑定)**(✅ **批准已到位 2026-07-21,可执行**;designer 走开放确认循环 —— §7);**绑定统一留给 post-1385 的 cutover 一次性做**(与其余四条 binding 同一步)。
     - **Lead 的本意保住了**:未批准前**连 identity 都不建** ⇒ 注册表里**永远不会有「已发布但没批准」的模板**被显式 `templateId` override 误用。
     - **同时解掉顺序矛盾(Codex R9 #4)**:若在批准时就绑定,会**提前产生 live routing**、违反本步「只建不迁」;若等到 cutover 才发布,则 cutover 前**五套不齐、per-project preflight 过不了**。⇒ **批准后发布(dormant)+ cutover 时绑定** 是唯一同时满足三条契约的顺序。
   - **一律不得改任何 live binding**;work-kind 默认集必须**保持 dormant** —— 部署/重启**不得产生新的 binding audit row**(⚠️ `ensureDefaultWorkflowBindings` 在 Bridge warm 时自动跑,`plugin.ts:3994-4007`,只改默认列表不够,见 §5.5-2)。
   - ⇒ 因 per-project preflight 要求「5 个 kind 全有」,**§7 未批准 = 5 套不齐 = 该项目 cutover 天然 blocked**,与 §7 前置一致、不矛盾。(✅ **§7 现已获批,此 gate 不再触发**;cutover 仍受其余前置约束。)
2. **FLY-1385 补 v2 入口三件套**:**keyless 合成 / flag-off 行为 / auth 面**(generic v2 的 auth 面必须一并定义,否则迁移后连带 key 的正常派发都死,`workflow-template-selection.ts:141`)。⚠️ **落点并进 FLY-1385**(同引擎族,已在 design 阶段),**不另开新单**。
   - **适用域澄清(Codex R7 #1 / R8 #1,按窄的写)**:这三件套**只作用于 fresh main-role DAG entry**;**scoped / tokenless / 非-main role / active recovery 的 legacy start 行为原样不动、不被改道** —— 两条契约**适用域不重叠**。
   - **auth 取最小安全方案**:代码只有 `master | scoped | tokenless` 三种 auth kind(`workflow-template-selection.ts:15`、`runs-route.ts:238-245`),而 scoped/tokenless 明确留在 legacy ⇒ **今天不存在「非 master 的 v2 caller」,也就没有要放宽的对象**。故 1385 的 auth 工作 = **确认并保持 fresh-main v2 的 master-only 要求**(`:141`),**不做整体 auth 放宽**(那会把 legacy 卷进来、并扩大 scoped 凭据对 templateId/taskCategory 的权限)。将来真要非-master v2,须另定 auth kind 及其项目/Lead/override 权限,并同步修改「scoped/tokenless 保持 legacy」这条。
3. **迁 binding cutover**(post-1385,由**明确的 founder-authorized migration / 有 activation gate 的 seeder mode** 一次补 5 个 exact + wildcard,校验 target/published/eligibility)。**前置硬要求:迁移 PR 必须带回归 fixture** —— **每个「只有 wildcard binding」的项目,keyless legacy start 依然成功**。⚠️ **fixture 必须复现真正的危险场景**(Codex final #4):**dormant 的 schema-v2 通用模板 binding 已经在场 + 开关 off**,断言此时**仍保持旧行为**。**不接受复用现有那个 schema-v1 `*→tpl_eng_heavy` 的 fixture** —— 它形式上满足文字,却完全没覆盖这次的风险面。
4. **最后单独开 flag**。

**🔴 cutover = 一个开关翻转(Lead 定;取代早前的「冻结窗口」写法)**

这些事天然跨 SQLite / Bridge 代码 / 两个 agent markdown / config,**不可能在一个数据库事务里**。**所以别指望事务,用开关**:
- **两个运行时行为**(work-kind binding 解析 + **`no-three-stage` 在 master fresh-main 域不继承**)**代码先上线,但一起挂在同一个开关后面,默认 off**;binding 先种好,**开关 off 时不解析(dormant)**。
- 🔴 **原子单元是三件,不是两件**:**开关 + binding 行 + prompt 资产**。prompt 资产在 spawn 时逐字注入 ⇒ 与代码同等的运行时行为源。**引擎短路只兜住路由后果,兜不住「新 runner 收到自相矛盾的指令」** —— 所以 prompt 资产**不能留到翻转之后再跟进**(§5.3)。
- **cutover = 单次开关翻转** —— **三件一体同时生效**(① 该次派发对开关取到的 runtime 决定 ② 已备好的 binding 行 ③ 与该决定一致的 prompt 资产内容/变体),这才是**真原子**。
- **不需要冻结派发**:在跑的 run 用的是**已固定的 snapshot**(§4.7 坑② 已确认),不受影响;**只有新派发读新开关**。
- **config 注释**是纯注释,翻转后跟进即可。⚠️ **两个 agent markdown 是 runtime prompt 资产、不是纯文档**(注册为 agent_file、spawn 时逐字注入 system prompt)—— 产品约束:**属于翻转后新决定的 fresh Runner 不得收到与已激活 routing 语义冲突的 role 指令**(判据=决定归属,非出生时间);实现形态交 FLY-1385/1380(§5.3/§11.5)。
- **回滚 = 把开关翻回去 + 回滚那两个 markdown**;**已种的 binding 留着不动**(off 时本来就 dormant)。
- **翻转前置**:§7 批准 + Annie 对 §5.3/§5.6 点头 + per-project preflight 通过 + §6 第 3 步回归 fixture 通过。

> ⇒ 「冻结 / 旧态 / 新态」那个三选一**被直接消解**:**开关之前全是旧态,翻转之后全是新态,没有中间态。**
- 铁律:binding **不得指向缺失/未发布模板**;**active pinned run 不因 rebind 改道**。
- ~~**§7 未获 Annie 批准前,整个「要求 5-kind preflight」的项目 cutover 都 blocked**~~ ✅ **§7 已获批(2026-07-21)——此 gate 解除**;cutover 仍受其余前置约束(§5.3 拍板 / launcher 修复 / preflight / 回归 fixture)。

---

## 7. 三套 flow 合同(✅ **Annie 已批准**,2026-07-21;designer 轮数按她的修订改为开放循环 —— 见「循环 / 终止」行)

| | **PRD** | **designer** | **prototype** |
|---|---|---|---|
| **阶段** | 研究 → 写 → 评审 → gate | 低保真 mockup → **founder 确认方向** → 做出来(hi-fi/可点)→ review → gate | 搭一个能真跑/能点的东西 → **founder 试** → 判定 → gate |
| **产物** | 研究 → PRD 稿 → 评审记录 | 低保真图 / 方向确认 / hi-fi 或可点原型 / review 记录 | 一条命令能跑的原型 / founder 体感 / 判定结论 |
| **谁批** | 评审 + 终态 founder | **方向 = founder**;终态 = founder | **试和判定都是 founder** |
| **失败回哪** | 评审不过 → 回写 | hi-fi 或 review 不过 → **回到低保真那步**(方向错就回最便宜的一步,不在 hi-fi 上反复磨) | 跑不起来 → **回第一步修到能跑,不许进 founder 试用**(不能让她试一个跑不起来的东西) |
| **循环 / 终止** | 评审 ≤3 | 🔴 **无固定上限** —— 方向对之后的**细节来回磨**是开放循环:每轮产出**更新的 mockup** 交 founder,founder 满意即定、不满意即继续。⚠️ **终止只认 founder 显式「定了」** —— **不是轮数耗尽,也不是 founder 停止参与/超时默认**(她没回**不等于**默认定稿)。这条与「失败回哪」的推倒重来**并存、是两件事**:那条是「方向错了回最初步」,这条是「方向对了磨细节」 | 修 ≤2 轮;**判定即终态** |
| **终态 gate** | founder approved | founder approved | **能做 / 不能做都是合法终态**(能做→交工程产品化;不能做→drop 并写明为什么) |

**owner**:Honey Lemon 跟 Annie 定并批准 —— ✅ **已批准(2026-07-21)**。**FLY-1380 现可创建并发布(seed)designer 与 prototype 的模板 identity,但保持 dormant** —— ⚠️ **live category binding 仍只在 post-1385 cutover 写入,1380 不 bind**(§6「只建不迁」/§8-A)。§6 cutover 的其余前置(§5.3 拍板、launcher 修复、per-project preflight、回归 fixture)仍需满足。节点/vendor/model 留工程设计。

---

## 8. 工程交付边界

- **A · FLY-1380(只建不迁)**:**先发布 3 套已定模板**(工程 / 产品-PRD / 通用);designer 与 prototype 的 identity **仅在 §7 经 Annie 批准后**才创建+发布(✅ **批准已到位**);五套齐全后才允许 per-project cutover;可重构 seeder 代码,但 **work-kind 默认集保持 dormant**,warm/重启**不得写 live binding**;retire 按 §3.3 时序(cutover 成功 + 零 live refs 后)。
- **B · FLY-1385(引擎接线)**:§4.6 六项(effective category 前置算定 / exact-presence enforcement / 词表校验 / provenance+digest / **v2 入口三件套** / tier plumbing)+ §5 的 **dispatch-time lint gate**,**外加**:
  - 🔴 **no-three-stage 的 v2 hard bypass(Codex R8 #4)**:现在该 label **只挡 fresh `dagEntry` 分支**(`runs-route.ts:966-1006`),之后仍会调 `resolveWorkflowTemplateSelection`;源码还明写 schema-v2「independently selectable and skips this legacy policy」(`:1011-1014`)。⇒ **wildcard/exact 指向 v2 后,光改 agent 文件和 lint 挡不住**。**契约**:dispatch lint 通过且 `no-three-stage` 被确认有效时,**fresh main 必须在任何 v2 candidate selection / materialization 之前转入 legacy 单 session,不创建 workflow run / reservation**。
  - **`no-three-stage` 不继承**的运行时落地(§5.6)。⚠️ **只这一个 label、只在 master fresh-main 域** —— `codex-skip` / `no-qa` / `no-vision` / founder-facing UX / legacy 路径的 label 读取**一律不动**(**本单不切,且⚠️ 目前无接收方**(见 §4.0 例外表))。
- **C · cutover(post-1385)**:有 activation gate 的一次性迁移,**带 §6 第 3 步的回归 fixture**;owner 需明确(不能沿用会在 ordinary warm path 无条件执行的默认 seeder)。
- **D · 🔴 指令面 = 有序四拍(原来写的三拍,第一拍是空的)**

  **🔴 先说被推翻的是什么**:这一节原本写「更新 `department-lead-rules.md` → 重启 → 翻 flag」。**Tadashi 的哨兵实验证明第一拍是空的** —— 更新一份**从来没被加载过**的文件,效果为零。

  **哨兵实验(本 Runner 独立复跑并加了反序对照)**:两个文件各含一个唯一串,各挂一个 `--append-system-prompt-file`,然后问模型看得见哪些串。
  - `a.md`(ALPHA)+ `b.md`(BETA)按此序传 ⇒ 模型只答 **BETA**;
  - **反序**传 ⇒ 模型只答 **ALPHA**。
  ⇒ **`--append-system-prompt-file` 是 last-one-wins,只认清单里最后一份**;而且**是位置决定的**(反序对照排除了「某个文件本身有问题」)。
  ⇒ **全 fleet 每个 Lead 实际只装了它清单里的最后一份。** 实测 Cass(pid 12962)那 18 份里,真正进上下文的**只有 `screencapture-l3-skill.md` 一份** —— `department-lead-rules.md` 和 `cos-lead-rules.md` **都没进去**。

  | 拍 | 动作 | 完成判据 |
  |---|---|---|
  | **①** | 🔴 **launcher 修复** —— 把全部 rules **拼接成一份、用单个 flag 传入**(Tadashi 已立单派修) | 修复已上线;**在此之前后面三拍全部无意义** |
  | **②** | 更新 rules 内容:fresh main 派发要先判断 work-kind 并显式传 `taskCategory`、**不传会被直接拒绝**、五个 kind 各自何时用、**部门值只是建议不会自己顶上** | 已 merge |
  | **③** | **重启,并用【哨兵探针】验证真加载** —— 在拼接文件里植入一个版本哨兵串,重启后**问 Lead 把它读回来** | 🔴 **读回哨兵 = 权威判据**。走项目统一的重启脚本及其自带验证通报 |
  | **④** | **才允许翻 flag** | 前三拍都有据可查 |

  **🔴 验证方法的等级(这一条比四拍本身更容易被漏)**
  - **argv = 必要非充分**:它只证明 **launcher 想装**,**不证明装进去了**。⚠️ **当晚看起来最像铁证的那份物证(「我 ps 了活进程,它就在参数里」)正是这么失效的** —— 我自己也用同一把尺「独立复核」过一次,得出的结论同样不成立。
  - **哨兵读回 = 权威**:只有让被验证的那个会话**把哨兵串说出来**,才证明它真的在上下文里。
  - ⇒ **通则:验证装载,要在【终点】取证,不能在【起点】取证。**

  **🔴 ③那一拍怎么证明 —— 一正一负两个对照(缺一不可)**(⚠️ 对照发生在**重启之后**;②只是内容 merge,证明不了任何加载)

  | 对照 | 谁 | 重启后要看到什么 | 看不到说明什么 |
  |---|---|---|---|
  | **阳性** | 一个**应当加载**这份 rules 的部门 Lead | **把哨兵串和那条 work-kind 指令都读回来** | ①或②③没真生效,**不许翻 flag** |
  | **阴性** | **CoS 角色** | 读得回**它自己那份**的哨兵,但**读不到**这条 work-kind 指令 | 🔴 **cos 排除臂失效** |

  > 🔴 **两条前置,缺一这对对照就不成立**:
  > **(a) launcher 修好之前不成立** —— 现在两边其实**谁都没装上**这份 rules,对照测的是一个所有人都「读不到」的世界,**分不出好坏**。
  > **(b) 干净基线之前不成立** —— cos 的两条排除臂(`FLYWHEEL_LEAD_ROLE=cos` 或 `LEAD_ID=cos-lead`)在生产**一条都没命中**(她 leadId 是 `flywheel-cos-lead` 且 env 未设)。**先补 env → 重启生效 → 确认角色判定正确 → 才谈这对对照。** 在此之前,阴性那侧读到什么都属于**预期内的基线故障**,不构成 cutover 失效的证据。
  > ⚠️ **判据必须落在「该会话实际读得回什么」**,不能 grep 磁盘文件 —— 我们从不往 `cos-lead-rules.md` 里加这条指令,**grep 它永远绿,那是一条红不了的空对照**。

  **🔴 「生效怎么验」分三档,别混成一次重启**

  | 东西 | 什么时候加载 | 验证方法 |
  |---|---|---|
  | **① rules** | 长驻 **Lead 会话启动**时 | **重启 + 哨兵读回** + 上面那对正负对照 |
  | **② agent prompt 资产** | **fresh execution 时读盘** | 🔴 **翻转后派一个金丝雀 spawn**(或看翻转后第一个真实 runner 注入的 role prompt)—— **不是看 Lead** |
  | **③ 已在跑的 run** | 用**已物化**的内容 | 🔴 **不验,也不算失效** —— by design(pinned snapshot 免疫,与 cutover 开关同一套语义) |

  > 🔴 **和「翻转后出生的 fresh Runner 不得收到冲突 role 指令」怎么不打架**:判据**不是「什么时候出生」,而是「属于哪一次派发决定」**。已物化 run 的模板 / category / prompt 是**一整套一起钉住**的,它后续 spawn 的 Runner 拿翻转前的 prompt **与所属决定自洽,不构成冲突**;那条约束管的是**翻转后新做出的决定**所产生的 Runner。

- **E · 前置**:§7 三套 flow 合同经 Annie 批准(✅ **2026-07-21 已获批**)+ §5.3 `no-three-stage` 语义拍板(🟡 **仍待 Annie**)+ **D 的四拍全部完成(含①launcher 修复与③哨兵读回)** —— **三者都是 cutover 的前置**。

---

## 9. Success metrics + 验收(work-kind 矩阵)

**主指标**:**fresh selection 按 canonical work kind 命中预期模板;「认出 kind 却回落 wildcard」= 0**。
**副指标**:rollout 后 system-owned `*→tpl_eng_heavy` 命中 = 0;**v2-routed 上缺 work-kind 的派发被拒绝而非静默落默认**(可观测);**「本次发送值 == 该部门建议值」的占比**可算出来(§4.7② 的代理指标 —— ⚠️ **它不是「走过场率」**,独立判断本来就常落在建议值上;接近 100% 时值得去看看,**不设硬阈值**);founder 审阅带宽不被无谓阶段占用(定性)。

**验收**

> 🔴 **单源化规矩(本单出现过三次「改了规格、没改验收」,其中一次留下的偏偏是 QA 真正照做的那份 —— 所以这里用结构解,不靠更仔细)**
> **每条验收只写「要断言什么」,不复述规格正文;规格正文只在它自己那一节存在一份。** 验收里出现规格细节时,**必须指名它的同源出处**,格式:`(同源:§X)`。
> ⇒ **改动纪律**:改了 §X 的规格,**必须回来看所有标了 `同源:§X` 的验收项**;反过来也一样。**做不到单源的地方,就让两处互相点名,让下一个改的人看得见它的孪生。**

1. 5 个 kind + `*` 在**每个项目**都有 exact/wildcard row,target 已发布且 fresh-eligible。⚠️ `*` 的角色见第 5b 条 —— 它**不是** v2 的 missing-kind 兜底。
2. **部门不是锁**:engineering 部门 + 派发时传 `taskCategory=prd` → 产品-PRD 模板;**product 部门 + `taskCategory=code` → 工程模板**。
3. **FLY-1378 这类研究单**:派发时传 `taskCategory=research` → **通用模板**(部门不得抢占显式传入值)。⚠️ **不再有「标题 derive」这条路径** —— 同一张单**只写标题不传 category**,在 v2-routed 项目上的预期结果是**被 required-param gate 拒绝派发**,**既不 derive 出 research、也不静默落部门默认**。
4. 🔴 **v2-routed 的两条有效路径逐条验 + 两条都没走时 fail-loud**(**同源:§4.1 优先级表 + §4.3 truth table + §4.5「显式字段的校验顺序」** —— 期望结果、错误形态、以及「先校验后 precedence」的次序均以那三处为准,**此处不复述**)。断言点:**(a)** `templateId` 且无 `taskCategory` → 成功且仍强制非空 `selectionReason`;**(b)** 显式合法 `taskCategory` → 成功且命中 exact row;**(c)** 两者都无 → **拒绝派发,不落任何默认**;**(d)** 同请求里非法的 `taskCategory` **仍报错**,不因 `templateId` 胜出而被豁免。
4b. 🔴 **switch on/off × (absent / 非 string / 词表外) 六格全覆盖**(**同源:§4.2 的 `taskCategory` 边界语义 + §4.7 的开关分支** —— 六格的期望值以那两处为准,**此处不复述**)。⚠️ **switch off 那三格不过 = 上线前就打爆 legacy 调用**,与本单躲过的那个 P0 同类。
4c. 🔴 **`v2-routed` 判定本身要验**(**同源:§4.7 的 `v2-routed` 定义段** —— 定义、为什么不能按「有没有 v2 binding」判、以及判定时点,均以那一段为准)。断言点:**dormant v2 binding 在场 + 开关 off ⇒ 仍走旧行为**(与第 7 条同一件事);**判定发生在 candidate / binding lookup 之前**。
5. **有 work-kind 但缺 exact row → fail-loud**(**同源:§4.4** —— 两分的边界以那一节为准)。断言点:**该 fail-loud 只作用于 `taskCategory`→binding 这条路径**;**`templateId` 路径不受它约束**(跳过 binding,审计用的 category 不要求 exact row)。
5b. 🔴 **`*` 的角色**(**同源:§4.1「不参与 v2 解析的两样」**)。断言点:**开关 on 时 `*` 不被 fresh selection 命中**;**开关 off / 回滚后 `*` 照常被消费**。
6. **v2 入口与幂等的既有合同不被本单破坏**(**同源:§6 第 2 步(v2 入口三件套)+ §4.5(idempotency 三态)+ §4.7(retry 复用 pinned)** —— 各自的期望行为以那三处为准)。断言点:**keyless schema v1/v2 fresh start 都不 409**;**flag-off 回滚**;**idempotency 三态**;**pinned retry 仍成功**。
7. **🔴 迁移回归 fixture**(**同源:§6 第 3 步** —— 场景条件与「不接受复用哪个 fixture」以那一步为准,**此处不复述**)。断言点:**每个只有 wildcard binding 的项目,keyless legacy start 依然成功**。
8. **lint 合同**(**同源:§4.0 例外表(哪些 label 本单不动)+ §5.1–§5.2(权威点与规则)+ §5.6(`no-three-stage` 不继承的精确范围)** —— 语义与适用域均以那几处为准,**此处不复述**)。断言点:**creation 与 dispatch 两侧都验**;🔴 **同一个 `no-three-stage` 的两种输入必须给出相反结果**(issue 上残留 → 不生效不阻断不确认;本次显式传入且与 work-kind 冲突 → 要求确认)—— **这一条不过 = 「不继承」没真落地**;**直接在 Linear 建单绕不过**;**只验 `no-three-stage` 一个 label**,不对其它行为标签作任何要求。
   > ⚠️ **反向断言取代「建完再改标题」那条用例**:**改标题不改变任何路由结果**。
8b. **🔴 指令面四拍全部完成**(**同源:§8-D** —— 四拍的内容、顺序、完成判据与验证等级均以那一节为准,**此处不复述**;另 **Gemini `dispatch_runner` 的 `taskCategory` 必须是 required enum** —— **同源:§4.6 派发面表**,仅 optional 不算通过)。断言点:**四拍逐拍都有据可查**;**第 ③ 拍的证据必须是「该会话把哨兵串读回来」**,**不接受 argv / 配置 / 文件内容当通过依据**;**「谁受影响」必须实测,不得按名字圈定**。**这条不过 = 不许翻开关。**
8c. **🔴 分类判错的纠正流程**(**同源:§4.7 ①的回执时点段** —— 时点、承诺边界与纠正路径以那一段为准)。断言点:回执可读出本次 kind 及来源(**来源词表只有 `task_category` / `template_override`**);**纠正路径跑得通且全程只有一个 active run**;**不得断言「只损失一次重派」**。
8d. 🔴 **代理指标可算且真的被消费**(**同源:§4.7 ②** —— 指标定义、它证明不了什么、以及为什么需要具名消费者,以那一段为准)。断言点:route decision 里**持久留下可聚合的 `(sent_category, 部门建议值)` 对**;占比**算得出**且**按既定节奏交到一位具名产品 Lead 手上**;**验收文字里不得出现「确认来源」「走过场率」**。
9. 旧 identity 的 fresh override 被拒;retire 后无 binding 指向 ineligible/unpublished。

10. **适用域**:active recovery / 非-main role(QA)/ scoped/tokenless legacy start **不被新校验改道或拒绝**。

---

## 10. 边界与非目标

- 本单及其 runner 走 legacy、**不走 DAG**。
- 只到 PRD(定形状);实现交 Tadashi(FLY-1380 / FLY-1385)。
- **不动** DAG enable/disable(flag / `pipeline.dag`)机制本身。
- 不做动态 DAG;不做可视化编辑器 / 用户自定义模板。

---

## 11.5 交 FLY-1385 的 runtime 契约 → **正文在独立文件里,这里只放指针**

> 📎 **唯一正文**:[`fly1385-addendum.md`](./fly1385-addendum.md)(同文件夹)
>
> **为什么不在这里再存一份**:本单一路撞到的病,有一半是**同一件事存了两处、改了一处另一处变陈旧** —— §5.3 把 agent markdown 的翻转时序委派给 §11.5 而 §11.5 里没有对应条目(悬空委派)、标题写「三次」而表里已是四例、两处「五件同生同死」的陈旧孪生、以及窄域收窄后散落六处的宽口径残留。**一份正文 + 一个指针**,是不让下一轮改动再制造一次同样的病。
>
> **那份文件是刻意自包含的**(不含任何指回本 PRD 的交叉引用),可以整节复制进 FLY-1385 的 design 文档做增量 review。**FLY-1385 不等本 PRD** —— 它的六个修复面先走到 APPROVED,这份契约清单到手后作为 addendum 节喂进去跑一轮增量 review。
>
> **里面有五条**:① override 的 idempotency / reservation 生命周期 · ② `taskCategory` 输入合同 + 生效值与建议值的持久化/可见性 + required-param gate · ③ 直接指定 `templateId` 时的 canonical category 与 provenance · ④ 回归 fixture / cutover owner / 开关 scope · ⑤ 两个 agent markdown 的翻转时序落地形态。每条带 (a) 两难 · (b) 产品层约束边界 · (c) 谁定。


## 11. Open(不阻塞主方向的下游细化)

- **工程模板旋钮默认档** + vendor path (a)/(b)(§3.4)—— FLY-1385 拍。
- **改 binding 的运行时入口**是否本单就定,还是先只种对默认值(founder-gated)。
- 🟡 **阻塞项(非 open,已列前置)**:~~§7 三套 flow 合同~~ ✅ **已获 Annie 批准(2026-07-21,designer 轮数按她修订)**;§5.3 `no-three-stage` 语义**仍待 Annie 拍**。
