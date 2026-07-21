# FLY-1396 DAG 分档 binding — 探索

Issue: FLY-1396 (https://linear.app/geoforge3d/issue/FLY-1396/prdhl-dag-分档-binding-不同类型的单走不同模板不再一律-eng-heavy-highway)
日期: 2026-07-20
基于: 无(上游 = FLY-1020 workflow-templates PRD 已 merge · 工程实现单 = FLY-1380)

> 本文是 co-create 的 **grounding 记录**:开工前先把「三个事实」从源码审计清楚,再把 PRD 要回答的问题拆成可逐块讨论的结构。
> **刻意不预设答案**(Annie 直令「先不预设」)—— 分类法 / 每类流水线形状 / category 判定 / 谁能改 binding,都是留给 co-create 逐块收敛的开放问题。
> 按 doc-flow full 档:exploration(本文) → research → PRD;co-create 收敛后补齐。

---

## 0. 一句话

**模板和 binding 表都已经存在(FLY-1020 已 ship 6 套模板),真正缺的是两件事:① 非工程模板从没被 bind 到任何 category;② 没有任何机制把一个进来的 issue 判成某个 category。** 结果:凡进 DAG 的单,category 恒等于 `*` → `tpl_eng_heavy`,全走重型工程流水线。

---

## 1. 问题(Annie 2026-07-20 实测)

DAG 的 `workflow_category_binding` 表里,每个项目实际只有一条能用的 binding:`* → tpl_eng_heavy`(flywheel / geoforge3d / growth / joycon-typeless / personal-assistant / tidal-echo,全 `system:bundled-default`)。

⇒ 凡走 DAG 的单,不管是 research / QA / PRD / ops,全被塞进同一条重型工程流水线 **design → implement → qa → founder_gate**。

活样本:**FLY-1378**(写研究报告的单)因此跑了 3 轮 design-review + 3 轮 code-review —— 对一份文档明显过重。这是 Annie「每个 issue 跑十几二十小时、中间很多废的」痛点的一个直接、可量化来源。

工程侧「binding 从没种下」bug = FLY-1380。**本单是它的产品定义。**

---

## 2. 三个事实(源码审计,已 grounded)

> Annie 要求「先问 Tadashi 三个事实」。技术问题应先自查代码(不烦 founder)—— 下面三条全部核过源码,附文件行号。**唯一需要 Tadashi/运行时确认的是「生产当下这些 flag 到底开没开、DB 里 binding 真实快照」**(见 §2.4),代码只能告诉我默认值和逻辑,给不了活状态。

### 2.1 事实一 · binding 现状

- **表**:`workflow_category_binding(project, task_category, template_id, updated_by, ...)` — `StateStore.ts:13166+`(`bindWorkflowCategory` / `getWorkflowCategoryBinding` / `listWorkflowCategoryBindings`)。
- **6 套模板已定义**(`workflow-template.ts:1085` `BUNDLED_SEED_FILES`,seed YAML 在 `packages/teamlead/src/workflow-seeds/`)。**但生产 DB 实况:只有 3 个 v1 工程模板真被 import 进库,3 个 v2 非工程模板(product/research/ops)从没 import**(v2 import 被 generalized flag 挡,`StateStore.ts:13065`)。⇒ 就算种上 research/ops 的 binding,模板本身当下也不在生产库里 —— 启用非工程档 = 需要 generalized flag ON + 重新 import,不只是补一条 binding。
  | 模板 | schema | 形状 | 说明 |
  |---|---|---|---|
  | `tpl_eng_heavy` | v1 | design(claude fable) → implement(codex xhigh) → qa(claude opus) → founder_gate;QA↔implement loop ×3 | 现在所有单都落这条 |
  | `tpl_eng_light` | v1 | design(codex) → implement(codex) → qa(claude opus) → gate;QA loop ×3 | |
  | `tpl_eng_trivial` | v1 | design(codex) → implement(codex) → qa(claude fable) → gate;QA loop ×3 | |
  | `tpl_product_v1` | v2 | research → produce(产出物) → review(claude sonnet) → gate;review↔produce loop ×3 | 无独立 code-QA |
  | `tpl_research_light` | v2 | research(产出物) → gate | 单实节点 |
  | `tpl_ops_light` | v2 | execute → gate | 单实节点 |
- **只种了 3 条工程档 binding**(`workflow-template.ts:1140` `DEFAULT_ENGINEERING_WORKFLOW_BINDINGS`):`* → eng_heavy` / `light → eng_light` / `trivial → eng_trivial`。**非工程模板(product / research_light / ops_light)从没进过任何默认 binding 列表 → 从没被 bind 到任何 category。**
- **seeder 是「一次性」**(`ensureDefaultWorkflowBindings` `workflow-template.ts:1151`):`if (existing.length > 0) continue` —— 只对「零 binding」的项目种。**FLY-1380 根因(git 实锤,非假设)**:生产 6 项目的 `*→heavy` 行都种于 2026-07-16 07:20:09 UTC,当时跑的是只种 wildcard 的旧 commit `c808dab98`;把默认列表扩成 3 档的 commit `9ccf47335` 晚了约 21 小时才落地。此后 `existing>0 continue` 守卫**永久跳过**所有已存在项目 —— 新档再也种不上。生产卡在一条 `*→heavy`。
- **无运行时写路径**:`bindWorkflowCategory` 在生产的唯一调用者就是 boot 时的 seeder。management console(`management-dag-writer.ts`)只能改模板节点的 model/effort,**改不了 category→template binding**。⇒ 今天没有任何人能在运行时改 binding。

### 2.2 事实二 · enable 是否 per-dept

**不是 per-dept。是「per-project config × 全局 flag 组」两个开关同时为真才走 DAG**:

- **(a) 5 个全局(`bridge_global`)founder flag,全 default OFF**(`config/src/feature-flags/registry.ts`;Fleet flag 面板 `dag-flag-panel.ts` 成组管理):`workflow_template_dispatch`(主闸)· `workflow_claims_write` · `workflow_claims_read` · `workflow_generalized_templates`(v2 专用)· `workflow_force_legacy`(kill switch)。v1 需 dispatch+claims write/read;v2 额外需 generalized。
- **(b) per-project config `pipeline.dag: true`**(`config/src/types.ts:325` `PipelineConfig.dag`,读自各项目 `.flywheel/config.yaml`,「像 three_stage」)。路由判定 `runs-route.ts:966`:只有 `pipeline.dag===true` **且** 无 `no-three-stage` label **且** flag gate 过 **且** 候选模板解析出来,才 `dagEntry=true`;且仅 fresh `role==="main"` + master auth 进。
- ⇒ enable 粒度 = **项目级(config)受全局(flag)门控**;不是 department 级。`no-three-stage` label 是 per-issue 逃生口。
- 另有一层 legacy 三段式 gate(`pipeline.three_stage` + `no-three-stage` label + `three_stage_channels` 白名单)—— 老三段式开关,不是新 DAG。

### 2.3 事实三 · category 怎么判(← 真正缺失的环节)

- `taskCategory` 只是 run-start 请求体上一个**透传字符串**(`runs-route.ts:928` `req.body.taskCategory`),不填就 default `*`。
- 选模板逻辑(`workflow-template-selection.ts:29` `resolveWorkflowTemplateCandidate`)两条路:
  1. **Lead 派单时显式给 `leadTemplateId` + reason** → selectionSource=`lead`(直接指定模板,绕过 binding);
  2. **否则按 `(project, taskCategory)` 查 binding** → `*` 命中默认 → `lead`/`binding`/`default` 三种 source。
- **源码里没有任何地方从 Linear label / issue type / 派单 agent 自动推导 category。** category 就是派单方在 start 请求里显式塞的字符串,实践中没人塞 → 恒 `*` → heavy。
- FLY-1020 §4② 本来的意图是「复用已有 label/agent 路由信号选默认模板,不加新分类器」——**但这条线从没接上。** 这正是本 PRD 要定的核心。

### 2.4 已从生产 DB 核实 + 仍需 Tadashi 确认

**已核(查生产 `~/.flywheel/teamlead.db`)**:
- binding 表快照 = 6 项目各恰一行 `* → tpl_eng_heavy`(`system:bundled-default`,种于 2026-07-16 07:20:09 UTC)—— 与 issue 观察一致。
- 生产库里只有 3 个 v1 工程模板,3 个 v2 非工程模板从没 import(generalized flag off)。

**Lead(Honey Lemon)已核实(2026-07-20,不用再问 Tadashi)**:
- 生产 `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=0` —— **DAG dispatch 现在关着、休眠**,今天没单真走 DAG。
- 更正 issue 叙事:FLY-1378 是 7-19 18:01 派的、那时 flag 还开着,它**真走了** DAG-heavy(`workflow_run entry_kind=pipeline_dag_v1`);flag 是后来某次重启才置 0。所以「过重跑」当时是真的,现在 DAG 休眠。
- ⇒ 叙事定为:**DAG 还没开(休眠),开之前先把分档定对**。flywheel 项目 config 已有 `pipeline.dag: true`(项目级已武装),只差全局 flag。

**仍需 Tadashi 确认(工程侧,块 C)**:category 判定接线倾向哪种机制(自动 label / 派单 agent / 手动指定)。

### 2.5 真实 label 路由信号(`.flywheel/config.yaml`,= category 判定可复用的现成信号)

FLY-1020 §4② 的意图是「复用已有 label/agent 路由信号,不加新分类器」。现成信号就在 `agents[].match.labels`:
| agent | 现有 label | 
|---|---|
| engineer | code, feat, fix, refactor, test, infra, tooling, bug, backend, frontend, api, server, ui, web, be, fe, eng, **research, plan** |
| qa | qa, testing |
| product-designer | doc, docs, design, ux |
| pm | pm, product |
| prototype | prototype |
| designer | designer, mockup |
| general(default_agent) | (无 label = 兜底) |

⚠️ **关键:`research` 和 `plan` 现在挂在 engineer 名下** —— 研究/计划类单当前就被路由进 engineer,category 又恒 `*` → 走 eng-heavy。这就是 FLY-1378(研究报告)走重型的具体机制。分档映射的第一件事就是把 research/plan 从 eng highway 摘出来。

---

## 3. 上游关系(FLY-1020 已 ship,别重发明)

FLY-1020 已把整套 workflow-template 系统 ship 了(PR #514):三层定义(YAML 结构 + 节点类型注册表 + Markdown 技能)、loop + skip、6 套 shipped 模板、裸 session 默认、default-off 字节兼容。

**本单 FLY-1396 是它的下一层**:一个进来的 issue **怎么被 bind 到对的模板**(category → template)+ **category 怎么判定**。不重开 FLY-1020 的模板机制讨论;若 co-create 发现现有 6 套形状不够/不对,再议增改。

**相邻工程 doc(在 `engineering/doc/`,research 阶段可参考)**:FLY-1135(layer1 dag templates)· FLY-1244(claims enforcement)· FLY-1281(v2 泛化)· FLY-1307(snapshot dispatch enable)· **FLY-1372(dag dispatch entry — 其 exploration 已记录生产 `*→heavy` 事实)** · **FLY-1390(dag-only audit / legacy-vs-DAG 弃用审计 —— 若 legacy 在被弃、DAG 成唯一默认,则分档 binding 更紧迫)**。「highway」是 Annie 的口语说法,非文档架构概念。

---

## 4. 本 PRD 要回答的(Round-1 分块,开放问题,不预设)

> 下面是给 co-create 逐块钻的结构。每块先摸 Annie「有定见还是我来发挥」,再收敛。**这里只列问题、不填答案。**

**块 A · 分类法(单分几类,粒度多细)**
- eng-heavy / eng-light / eng-trivial / research / PRD-writing / QA-only / ops / …?
- 现有 6 套(3 eng + product + research + ops)够不够?PRD-writing 用 product 还是单列?QA-only 要不要独立?
- 类别的粒度:是几大类(eng / 文档 / ops),还是更细?

**块 B · 每类的流水线形状**
- 哪些类根本不需要 implement?哪些不需要 code-review / QA gate?哪些是单节点?
- 现有 seed 形状(见 §2.1 表)哪些直接采纳、哪些要改?
- 「文档类」是否统一用「产出 → review → founder_gate」而没有 code-QA?

**块 C · category 怎么判定(核心)**
- 自动从 Linear label 推导?从派单 agent/Lead 推导?派单时手动指定?还是「默认自动 + Lead 可覆盖」?
- 复用现有 label/agent 路由信号(FLY-1020 §4② 的意图),还是加新的分类信号?
- 判错了怎么办(Lead 覆盖机制已存在 `leadTemplateId`)?

**块 D · 谁能改 binding + 要不要 gate**
- founder / lead / 自动?改 binding 要不要 founder gate?
- 今天连运行时写路径都没有(§2.1)—— 这单要不要顺带定义「改 binding」的入口,还是只定「种对默认值」交 FLY-1380?

**块 E · 默认兜底**
- 认不出类型的单落到哪个模板?**明确不能再默认 heavy。**
- 兜底候选:最轻的单节点?还是「裸 session / 不挂模板」(FLY-1020 的默认)?兜底走轻 = 保守省钱但可能欠力;兜底走 heavy = 现状痛点。倾向轻,但留 Annie 拍。

---

## 4.5 Annie 收敛(2026-07-20,经 Lead relay,拍板 ok)

Annie 拍了 ok + **大砍简化**:映射从「4 类任务类型」改成**按部门锚定的 3 桶**。

**新映射(部门 → 可用模板)**:
| 部门 | 模板 |
|---|---|
| 工程(flywheel / geoforge3d / joycon-typeless) | eng(3 档合并成 1 套 + model 旋钮)+ generic |
| 产品 | PRD + designer + prototype-engineer + generic(= 现有三个产品角色) |
| 其余所有项目(growth / personal-assistant / tidal-echo …) | 只 generic |

**砍掉(Annie 明确不要)**:research-light / ops-light / qa-only / doc —— 全删。**不为每种任务各造一套模板**。`generic` = 单 session、agent 直接做、不塞一堆阶段 prompt;是大多数单的默认 + 所有部门兜底。

**必须写进 PRD 的 3 条 framing(Annie 确认)**:
1. 静态「部门 → 模板」= **临时默认,不是永久硬规则**;Lead 派单可覆盖(能力已有)。别写成「这个部门永远只能这样」。
2. 终态 = **动态 DAG**(agent file 都备好、Lead 按任务现组);静态模板 = 动态 DAG 的默认层 / 积木。现在建 = 铺底、非弯路。一句带过(动态 DAG 形态另开方向)。
3. 硬理由 = 立刻止住「全走 eng-heavy」的浪费,**不等**动态 DAG。

**留 PRD 细化的小点**(不影响拍板):部门内怎么选模板(默认落 generic vs 按 label/Lead 指)+ 哪个项目算哪个部门。建议默认一律先落 generic,专门模板按任务类型/Lead 指定才上 —— PRD 定细,Lead review 可改。

⇒ 原 §4 的 Round-1 分块 A–E 大部分被 Annie 的部门锚定收敛掉;PRD 直接按 §4.5 写,不再逐块开放讨论。

## 4.6 dispatch 代码实情 + 机制可行性(Annie 修正②:机制才是核心,去扒代码)

> Annie:映射表是简单 30%;难的 70% = 「一件活在派发那刻凭什么被判成某部门」。去扒真实 dispatch 代码钉可行性。**结论先行:难的 70% 已经建好在跑了 —— 真正缺的只是把已算出的部门信号接进模板选择。**

### (a) 部门 = 每件活的属性,不是项目(实证印 Annie 修正①)

生产 `~/.flywheel/projects.json`,flywheel **同一项目**下的 leads:
| leadId | department | dept label(`match.labels`) | canSpawn |
|---|---|---|---|
| flywheel-eng-lead(Tadashi) | **engineering** | `Flywheel` | ✓ |
| flywheel-product-lead(Honey Lemon) | **product** | `Flywheel-Product` | ✓ |
| flywheel-cos-lead | (none) | `Flywheel-Triage` | ✗ |
| codex-infra-bot-lead / claude-infra-bot-lead | infra | `infra-bot` / `claude-infra-bot` | — |

⇒ 一个 flywheel issue 的部门 = 它带哪个 dept label:带 `Flywheel` → 工程(Tadashi);带 `Flywheel-Product` → 产品(Honey Lemon)。**部门是 per-issue、per-work,不是 per-project。** 本单 FLY-1396 带 `Flywheel-Product` → 产品。**别再用「flywheel = 工程项目」当例子。**

### (b) 派发那刻已有的信号(runs-route.ts,行号实扒)

| 信号 | 哪来 | 行号 |
|---|---|---|
| `leadId` | `req.body.leadId`;未给则 FLY-80 从 project config **auto-resolve** | `:247` / `:614-625` |
| issue labels | Linear 拉取 + 归一小写 | `:596` / `:744` |
| **`owningDept`** | `departmentRegistry.getDepartmentForIssue(project, labels)` —— **派发那刻已算出部门** | **`:745`** |
| `taskCategory` | `req.body.taskCategory`(裸透传,没人填 → undefined) | `:928` |
| `leadTemplateId` | `req.body.templateId`(Lead 显式覆盖用) | `:932` |

### (c) 部门是怎么从代码里判出来的(= Annie 说「没想清楚」的那 70%,其实已在)

`DepartmentRegistry`(`department-registry.ts`,FLY-127/137 建):
- `getDepartmentForIssue(project, labels)`(`:146`)→ `classifyIssue`(`:76`)把 issue 的 label 匹配**各 spawning lead 的单一 dept label** → 唯一命中的 lead → `getLeadDepartment` → `resolveLeadDepartment(lead)`(`ProjectConfig.ts:189` = `lead.department` 优先,否则 `match.labels[0]`)。
- `getLeadDepartment(project, leadId)`(`:126`)→ **直接 leadId→部门**(= Annie 提案②:flywheel-product-lead → product)。
- 两条路都给部门:一条从 **issue label** 推,一条从 **派发 leadId** 推。两者都已实现。

### (d) 唯一缺的一根线(gap,实证)

`resolveWorkflowTemplateSelection`(`workflow-template-selection.ts:85`,在 runs-route.ts `:1157` 调用)收 `taskCategory` + `leadTemplateId` + `selectedBy:leadId`(`:1164`),**但没收 `owningDept`**。而 `resolveWorkflowTemplateCandidate`(`:37`)`category = input.taskCategory?.trim() || "*"` → binding 查表 / `*` → heavy。**部门信号在 `:745` 算出来了,却在 400 行后的模板选择里没被用。** 这就是「机制没落到代码」的确切位置 —— 不是分类没建,是**分类结果没接到模板选择**。

### (e) 机制(钉实的可行方案,给 PRD 核心)

1. **部门 → 模板档** 是个小 lookup:engineering → eng(+generic)· product → 产品角色模板(+generic)· 其余/(none) → generic。
2. **hook 插哪最自然**:在 runs-route.ts 解析 `taskCategory` / 组 `templateCandidateInput` 那步(`:928` 附近),用已算出的 `owningDept`(或 `getLeadDepartment(leadId)`)推出档位,喂给 `resolveWorkflowTemplateSelection`;`req.body.taskCategory` / `leadTemplateId`(Lead 每单覆盖)优先级更高。
3. **优先级**:Lead 显式覆盖(`leadTemplateId`)> 每单 `taskCategory` override > 部门默认(owningDept→档)> generic 兜底。
4. **owningDept="multiple" / undefined**:落 generic(fail-safe;`getDepartmentForIssue` 对多 label 返 "multiple"、无匹配返 undefined)。

⇒ **PRD 核心 = 这套「部门→模板」在 dispatch 的接线(c/d/e),映射表本身是附属。** 难度远低于 Annie 担心的:分类器已在跑,补一根线 + 一张小 lookup + override 优先级。

> ⚠️ 待 Tadashi 核:owningDept 目前只喂给 AgentDispatcher(选 who),把它也喂给模板选择(选 how)有无副作用;multiple/undefined 的产品期望落点;是否借此机会把 `taskCategory` 从裸透传升级成 dept-derived。

## 4.7 Tadashi 代码定论(2026-07-20,经 Lead relay,收敛机制)

Tadashi 现读代码给了完整答案,收敛并**纠正**了 §4.6 的一处(leadId → label):

1. **分类信号 = label,不是 leadId**(纠正 Annie 提案 + 我 §4.6 里把 leadId 当同等选项):
   - label 是派发那刻**保证在场 + 已验**的部门锚(FLY-127 gate:无部门 label 直接 403;Cass triage 先-label-再-路由)。
   - leadId 是「谁派」≠「活是什么」;跨部门代派会错分。
   - ⇒ 用 `getDepartmentForIssue(label)` 这条(本来就 label 派生),**不用** `getLeadDepartment(leadId)`。
2. **现状铁证(与我 §2.3/§4.6 一致)**:`taskCategory` 只从 `req.body`(runs-route `~925-935`),没人传 → 永远落 `*` 通配;`workflow_category_binding` 现 6 行全 `(project,*)→tpl_eng_heavy`(`system:bundled-default`,07-16 灌);label→category auto-derive **代码里不存在**。
3. **Hook(精确)**:`getWorkflowCategoryBinding` 调用点(在 /api/runs/start 链里,`workflow-template-selection.ts:40` via `resolveWorkflowTemplateCandidate`)—— `body.taskCategory` 缺省时**从 label derive category**,body 留显式 override;SQL query 已经精确匹配 > `*`(`StateStore.ts:13214` `IN (?, '*')` 排序)。**缺的 = derive 一步(label→category)+ 真 category 的 binding 行**(现在只有 `*`)。
4. **模板收敛(定注入点)**:三档 eng 拓扑相同(design→implement→qa→founder_gate),只差每节点 vendor/model/effort = 只换模型的复制品 → **1 模板 + tier→节点旋钮 preset**;**manifest schema 不改**,在 **run 物化时(`materializeWorkflowRun`)注入 preset/override**。
5. **⚠️ 必写进 PRD 的坑**:**label 是派发那刻的快照,派发后补 label 不重读**(FLY-1391 同款)→ **category 在 triage 打 label 那刻就定死**,跟 Cass「先-label-再-路由」自洽。必须在 PRD 明说。

行号与 Tadashi 对齐(taskCategory `:928` ≈ ~925-935;query 精确>*;materializeWorkflowRun 注入点),无冲突。**PRD 定稿后同步 Tadashi 一份 → 喂 FLY-1385 引擎修。**

## 4.8 Tadashi 核完三点 → 机制锁定 + 四个必写死的实现细节(2026-07-20)

Tadashi 核完可行性:**机制锁定 = 复用已有 `owningDept`,不新建 derive**。四个 PRD 必须写死的细节(含**纠正我 §4.6 一处错误假设**):

**① provenance 不能隐身**
- `selection_reason` / `selection_source` 必须记 category 是 **dept-derive 来的**还是 **显式 body 来的**(可观测 + 审计)。
- idempotency 缓存按 key **重放旧 response**、同 key 不重算 selection(既有语义,`workflow-template-selection.ts:168` `getWorkflowStartReservation`)→ **测试别假设换 category 能改重放结果**。

**② 🔴 纠正 §4.6 错误假设:multiple / undefined ≠ generic,是 fail-loud 回 triage**
- registry 语义(`department-registry.ts`):`multiple` = 2+ Lead 匹配(FLY-127 歧义,残存于 retry / feature-off 路径);`undefined` = 无匹配 / 项目未知(主路径会被 dept-gate 403,**走到这 = 状态不一致**)。
- 两者都 **fail-loud 回 triage**(Tadashi + Cass 已 settle 的契约,loud 响在 **Cass mailbox / thread**),**不是静默落 generic**。← 这纠正我之前「multiple/undefined → generic fail-safe」的假设。
- **`generic` 只保留一种合法形态**:**dept 明确、但该 category 无专属 binding 行 → 落 `*` 通配行 = 显式默认**(不是歧义吞掉)。

**③ 一条路径 + override,不是两条并存**
- 优先级:**显式 `body.taskCategory`(测试 / 运维 override)> dept-derive > 无 → `*`**。
- `category` 语义在 PRD **写死 = 「dept 推导的族键」**;别让它悄悄变成第二个 tier 轴(**dept 选模板族、tier 旋钮选 preset** 是两回事)。

**④ retry 一致性(自核完)**
- `actions.ts:798` retry 路径有独立 `retryOwningDept = registry.getDepartmentForIssue(project, 存储 labels)` 重算(从**存储 label** 非重拉 Linear;`:785-807`)。
- ⇒ derive 上线后,**retry 派发必须走同一条 derive**(消费同一个 `retryOwningDept`),否则首派 / 重派分家。retry 用存储 label 快照 → 与 §4.5「label 派发时快照」自洽(codex-skip 是 retry 唯一重拉的例外,dept label 不重拉)。

⇒ 机制锁。定稿同步 Tadashi 喂 FLY-1385。

## 4.9 「角色从哪儿可靠取」核验(Annie 选 B 后的结构问题;file:line + 真单实证)

> Lead 要求:角色来源是**假设不是结论**,去核清楚,不确定标 UNKNOWN。以下全部坐实。

### (a) 复合 key(部门+角色)技术上可行吗 —— ✅ 可,但有一处硬约束
- `workflow_category_binding.task_category TEXT NOT NULL DEFAULT '*'`,主键 `(project, task_category)`(`StateStore.ts:2708-2717`)→ **自由文本,`product:designer` 这类复合 key 可存**。
- `bindWorkflowCategory` 对 category **只做 `trim() || "*"`,无格式校验、无归一**(`StateStore.ts:13184`)→ 复合 key 原样入库。
- ⚠️ **硬约束**:`getWorkflowCategoryBinding` 的 SQL 只有 **exact 或 `*` 两级**(`WHERE task_category IN (?, '*')`,`StateStore.ts:13214-13220`)—— **没有层级 fallback**。即 `product:designer` 查不到时**直接掉到 `*`(通用模板),不会回落到 `product`**。⇒ 复合 key 必须**每个都显式种行**,否则静默落最轻。

### (b) 角色信号有哪三个来源 —— 按「今天真实可靠度」排

| 来源 | 证据 | 今天可靠度 |
|---|---|---|
| **① 派发时显式 `agentName`** | `req.body.agentName`(`runs-route.ts:284`)→ `AgentDispatcher.dispatchByName`(explicit agentName used by Lead,`AgentDispatcher.ts:7/272-291`) | ✅ **最直接**:这本来就是「选哪个执行角色」的现成机制,Lead 派单时就在用 |
| **② 标题角色前缀 `[Role·HL]`** | 标题在 run-start 可得(`runs-route.ts:569/592` 取 `issue.title`)、持久化(`issue_title TEXT`,`StateStore.ts:1323`);**已有同款先例** `isQaIssueTitle` = `/^\s*QA\s*·/`(`founder-ux/trigger.ts:45-47`),其注释明写「title is available at run-start **independent of the Linear label fetch**」 | ✅ **今天唯一真的带着角色的地方**(见 c);约定依赖(标题没前缀就取不到) |
| **③ 角色 label(`pm`/`designer`/`prototype`)** | config 有定义:`agents[].match.labels` —— pm=`pm,product` / designer=`designer,mockup` / prototype=`prototype`(`.flywheel/config.yaml:157-245`);`AgentDispatcher` 大小写不敏感匹配(`:313-314`) | ⚠️ **定义了但没打**(见 c)—— 要用需新增打标纪律 |

### (c) 🔴 真单实证:角色**今天只在标题里**,不在 label 里
| 单 | 标题 | labels(实测) |
|---|---|---|
| FLY-1396 | `[PRD·HL] …` | `["Flywheel-Product"]` |
| FLY-1354 | `[Designer·HL] …` | `["Flywheel-Product"]` |
| FLY-1378 | `[Research·HL] …` | `["Flywheel-Product"]` |

**3/3 只有部门 label、零角色 label。** ⇒ 「用现成角色 label 取角色」在今天**是假的**(label 存在于 config,但没打在单上);**标题前缀是当前唯一真实携带角色的载体**,且约定一致(`[角色·HL]`)。

### (d) UNKNOWN(不拍脑袋,留 Tadashi/Lead 定)
- 派发时 `agentName` 在**产品单**上实际传了没有、传的是什么值 —— 我只核到机制存在(`runs-route.ts:284`),**没核生产实际调用值**,标 **UNKNOWN**。
- 若走标题前缀:前缀词表(PRD / Designer / Research / Prototype …)与角色的映射、大小写/全半角/分隔符(`·`)容错程度 —— 需定规范,**UNKNOWN**。
- 若走新增角色 label:谁负责打(Cass triage?Annie 建单时?)+ 漏打的兜底 —— **UNKNOWN**。

### (e) 结论(给 PRD §4 用)
复合 key **可行**;角色来源建议 **①显式 agentName(最可靠、已有机制)> ②标题前缀(今天唯一真带角色,有先例)> ③角色 label(需新纪律)**,三者可叠成优先级链;**每个复合 category 必须显式种 binding 行**(无层级 fallback,漏种即静默落通用模板)。

## 4.10 主轴改成 work-kind — 最小可落地方案(Annie 再推一层,盖过 §4.9 的部门+角色复合 key)

> Annie:「感觉现在把很多东西写死了,不太方便」「理论上 engineering 部门是不是也可以出 PRD?可能也可以」「先看现在怎么方便、怎么能把东西做出来」。
> **洞察**:若「部门决定模板」,工程部就**永远出不了 PRD**。⇒ 主轴 = **这件活是什么类型(work kind)**,**任何部门都能做任何类型**;部门降级成**默认值**(兜底不是锁);单次派发显式指定 = override。

### (a) 现有 binding 表能不能直接装 work-kind —— ✅ 能,且**三处零改动**(实证)
| 位置 | 实际代码 | 结论 |
|---|---|---|
| `StateStore.ts:2708-2717` | `task_category TEXT NOT NULL DEFAULT '*'`,PK `(project, task_category)` | 自由文本 → 装 `prd`/`designer`/`prototype`/`code` 都行,**schema 零改** |
| `StateStore.ts:13184`(写) | `input.taskCategory?.trim() \|\| "*"` | **只 trim,无枚举/格式校验** |
| `workflow-template-selection.ts:37-40`(读) | `category = input.taskCategory?.trim() \|\| "*"` → `getWorkflowCategoryBinding` | **无白名单**,直接查表,**resolver 零改** |
| `runs-route.ts:927-930` | 只判 `typeof req.body.taskCategory === "string"` | **route 校验零改** |

⇒ **work-kind 当 category = 纯数据改动(种对 binding 行),引擎侧零代码。** 且是**扁平 key**,不需要复合 key,**自动甩掉 §4.9 那个「无层级 fallback」的坑**。

### (b) 类型信号从哪儿读 —— 三层,按「改动最小」排
| 层 | 来源 | 改动量 | 证据 |
|---|---|---|---|
| **① 显式指定(override)** | `req.body.taskCategory` —— **就是现成那个字段** | **零新代码** | `runs-route.ts:928` |
| **② 标题前缀** `[PRD·HL]` / `[Designer·HL]` / `[Research·HL]` | 标题 run-start 可得 + 持久化;**已有同款先例** | **一个小 parser**(可照抄先例) | `runs-route.ts:569/592`;`StateStore.ts:1323`;先例 `isQaIssueTitle`=`/^\s*QA\s*·/`(`founder-ux/trigger.ts:45-47`,注释:title 在 run-start 可得且**不依赖会失败的 label 拉取**) |
| **③ 部门默认(降级兜底)** | 复用**已算好的** `owningDept` → 小 map:product→`prd`、engineering→`code` | **一个两行 map**(值已现成) | `runs-route.ts:745` |
| ④ 都没有 | → `*` → 通用模板 | 零 | 现有 wildcard 行为 |

🔴 **实证**:角色/类型 label(`pm`/`designer`/`prototype`)config 里有定义但**没打在单上**(FLY-1396/1354/1378 三单 labels 全是只有 `Flywheel-Product`)。⇒ **v1 不需要新加 label**;②标题前缀是今天唯一真带类型的地方,③部门默认兜住其余。

### (c) 为什么这是最省的
1. **schema / resolver / route 校验 全零改**(上表实证);
2. **override 字段已存在**(`body.taskCategory`),不用新造;
3. **部门默认复用已算好的 `owningDept`**,不用新算;
4. **唯一净新代码 = 一个标题前缀 parser(有先例可照抄)+ 一个两条目的部门→默认类型 map**;
5. 扁平 key **不踩** 复合 key 的无层级 fallback 坑;
6. **更松**:任何部门都能走任何类型 —— 工程部要出 PRD,给它 kind=prd(标题前缀或派发显式指定)即可,部门只在没说清时兜底。

### (d) 要种的 binding 行(数据,非代码)
`prd`→产品-PRD 模板 · `designer`→产品-designer 模板 · `prototype`→产品-prototype 模板 · `code`→工程模板 · `research`→通用模板 · `*`→通用模板。

### (e) UNKNOWN(不拍脑袋)
- 标题前缀的**词表 + 容错规范**(大小写 / 分隔符 `·` / 没前缀怎么办)未定 —— 需 Tadashi 定 parser 细则。
- 生产派发目前**没人传 `taskCategory`**(这正是现 bug);override 通路本身现成可用,但**实际由谁传、什么时候传**未定。
- 是否将来加一个类型 label 作第四层 —— **v1 不需要**,留后续。

## 5. 边界(照 issue)

- **本单及其 runner 先不走 DAG**(走 legacy)—— 免得「修 DAG」的单自己被坏 binding 反噬。
- 本单只到 PRD(定清形状)。工程实现 = FLY-1380 或其后继 build 单,交 Tadashi。
- 不动 DAG enable/disable 机制本身(flag 层);本单只管「走了 DAG 的单怎么分流」。

---

## 6. 下一步

1. brainstorm gate:把三个事实 + Round-1 分块结构交 Lead → co-create 对齐意图。
2. co-create 逐块收敛(A→E)。
3. 补 research.md(若需)+ 写 PRD → Codex design review → Annie lgtm → docs PR。
4. 拆/更新 build 单(FLY-1380)交 Tadashi。
