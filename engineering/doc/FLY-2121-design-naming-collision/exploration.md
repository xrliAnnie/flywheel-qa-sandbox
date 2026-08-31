# FLY-2121 workflow design 命名互撞 — 探索

Issue: FLY-2121 (https://linear.app/geoforge3d/issue/FLY-2121/命名-workflow-shapenoderole-三处-design-命名互撞-后端改名-稳定-id-与展示名分离)
日期: 2026-08-28
基于: 无

## 1. 问题重述

founder 通过 Honey Lemon 路由的原话要求:前端不许自己编名字,名字直接从后端拿;后端如需更 human-friendly 的名字,由 Tadashi 改后端。issue 给出三处互撞事实与三条方向:

1. 改名让它说出自己是什么:shape `design` → `product_design`;`code` 里的 `design` → `tech_design`;role `designer` → `product_design`。
2. 稳定 id 与展示名分离:后端明确哪个字段是稳定 id、哪个是给人看的名字。
3. ⛔ 不许留双名兼容层;同一 PR 删干净旧名;历史行迁移方案写清楚。

## 2. 代码审计事实(全部读过源码)

### 2.1 三处互撞的载体

| 文件 | 内容 | 含义 |
| -- | -- | -- |
| `menus/shapes/code.yaml` | `id: design` / `role: design`,edge `from: design`,edge id `design_done` | 工程设计节点(出 plan,后接 implement) |
| `menus/shapes/design.yaml` | `shape: design`,节点 `id: produce` / `role: designer` | 产品/视觉设计 workflow 与其执行者 |
| `packages/config/src/workflow-menu-contract.ts` | `WORKFLOW_MENU_BINDINGS`: `taskCategory: "design"` → `templateId: "tpl_design"` | shape 名即 task_category,且铸进 template id |

### 2.2 审计中发现的第四、五处 "design"(issue 未列)

- **node type `design`**(`packages/config/src/node-type-registry.ts`):行为类型注册表,含 badge `🎨设计`、capabilities、completion route `phase_design_complete`。`workflow-menu.ts:393 nodeType()` 把 role `design` 映射为 type `design`。
- **一族内部协议常量**:edge condition `design_done`、sessions park status `design_done`、`ChatThreadRole = "main"|"design"|"implement"|"qa"`、completion route `phase_design_complete`、review_type `"design"|"code"`(codex design review 轴)、Linear label 路由 `designer-labels.ts`(整 issue 路由到独立 designer-executor,与 menu roster 是两条不同链路)。

### 2.3 关键降压事实:chat_thread_role 来自 node TYPE 不是 node id

`workflow-engine-dispatcher.ts:2744`:`const role = isWorkflowPhaseRole(node.type) ? node.type : "main"`。
⇒ 若保留内部 type 词表(`design` type 不改),sessions / chat_threads / park status / HeartbeatService / flywheel-comm complete route 全部不动。爆炸半径从「全系统」缩到「shape/node id/role 三个身份 + 其落库行」。

### 2.4 名字的落库与消费面(逐个确认)

| 载体 | 位置 | 存什么 |
| -- | -- | -- |
| `workflow_template` | teamlead.db | `template_id`(tpl_design)、`name`("design menu") |
| `workflow_template_revision` | teamlead.db | manifest JSON(含 node id/role)+ `manifest_digest`(canonicalSubmissionDigest,parse 时校验,StateStore 迁移必须重算) |
| `workflow_category_binding` | teamlead.db | `task_category='design'` → `tpl_design`(PK 组件) |
| `workflow_run` | teamlead.db | `template_id`、`current_node_id`、pinned `snapshot` JSON(含全部 node id/role/type,`snapshot_digest` + `manifest_digest` parse 时校验,workflow-run-snapshot.ts:626-630) |
| `workflow_run_node` / `workflow_run_event` | teamlead.db | `node_id` 列(event 另有 payload JSON 引用) |
| `workflow_gate_holder` / `workflow_node_pr_binding` / `workflow_rework_request` / `workflow_rework_route_revision` | teamlead.db | `gate_node_id` / `node_id` / `target_node_id` / `invalidation_scope_json` |
| 引擎字面量 | StateStore.ts 28476-28514(`appendWorkflowReworkRouteRevision` 的 routeIsValid 白名单)、38594(`target.id === "design"` 定 verification policy)、39827/40374 区域 | node id `"design"|"implement"|"qa"` 以 TS 联合类型+字面量写死 |
| Menu API | `bridge/workflow-menu-routes.ts` `/menus` | 返回 `item: menu.shape` + node `id`/`role`,**无展示名字段** |
| DAG 视图 | `bridge/management-dag-source.ts:110` | `name: node.id` —— **前端拿到的"名字"就是裸 id**,即「稳定 id 与展示名分离」缺口的实证 |
| 派工 | `resolveMenuAgentFile(role)` → `.flywheel/menus/ic-roster.yaml` | roster 键 = role 名(design/designer 均在) |
| 打包 | `scripts/package-onboard.sh:140-146`、`scripts/package-onboard-files.allow:14-19` | 按文件名列出 `shapes/design.yaml` |
| 外部项目 | `~/Dev/personal-assistant/.flywheel/menus/` | roster 只有 `generic` —— **无外部仓受 design/designer 改名影响**;flywheel 自己的 `.flywheel/menus/` 是 git 跟踪文件,随同一 PR 改 |

### 2.5 模板导入与绑定语义

- `importWorkflowTemplateSeed`(StateStore.ts:20611):按 `templateId` 找模板;内容 hash 变 → 发新 revision。⇒ `tpl_code` 改 node 名 = 自动新 revision;`tpl_design` → `tpl_product_design` 是**新模板行**,旧行必须迁移或退役。
- `reconcileMenuCategoryBindings`:只补缺失绑定,不清旧行 ⇒ `task_category='design'` 旧绑定行需要显式迁移。
- 种子导入发生在 Bridge 启动、StateStore 构造(含迁移)之后 ⇒ 「先迁移旧行、再导入新种子」的顺序天然成立。

## 3. 方案方向(带取舍)

### 3.1 改名集(身份层)

- shape `design` → `product_design`(文件名 `product_design.yaml`,`WORKFLOW_MENU_BINDINGS` → `tpl_product_design`,adoption 值,task_category)。
- `code.yaml`:node `id/role: design` → `tech_design`(含 edge from、引擎字面量、nodeType() 映射改为 `role === "tech_design"` → type `design`)。
- role `designer` → `product_design`(ic-roster 键同步:`design`→`tech_design`、`designer`→`product_design`)。

**已识别歧义(已向 Lead 发非阻塞 ask,id 3d1cacd9)**:issue 方向让 shape 与 role 同为 `product_design`,验收却写「三处名字互不相同」。默认解读:互撞的本质是一个词指三件不同的事;改名后 `product_design` 两处同名但指同一事物(产品设计域),且 shape/role 分属不相交命名空间(adoption 值 vs roster 键)。备选 `product_designer` 主动否决:与 config.yaml 既有 `product-designer` agent(不同 executor)只差连字符,制造新撞名。

### 3.2 展示名层(稳定 id 与展示名分离)

- shape yaml 增加 shape 级与 node 级 `label`(中文展示名,如 产品设计 / 技术设计 / 实现 / QA 验证)。
- `WorkflowMenuShape/Node`、`WorkflowManifestNode` 增加 `label`;menu 编译把 label 带进 manifest;合成的 `land` 节点给 label。
- `/menus` API 与 `ManagementDagView` 返回 label;`management-dag-source.ts` 的 `name: node.id` 改为 label(菜单种子模板 label 必填保证非空;founder 自建模板缺 label 时回落 id,作为 honest boundary 写明)。
- `workflow_template.name` 从 `"design menu"` 之类改为 shape label。
- node type `design` 的 badge `🎨设计` → `🎨技术设计`(founder 可见的相邻澄清,一行)。

### 3.3 迁移(teamlead.db,Bridge 启动时一次性、幂等)

单事务重写**运行态身份列**:template_id(tpl_design→tpl_product_design,含 revision/publication/binding 引用)、task_category、workflow_run.current_node_id、snapshot JSON(重算 manifest_digest/snapshot_digest)、workflow_run_node.node_id、workflow_run_event.node_id、gate_holder/pr_binding/rework 表、tpl_code 各 revision 的 manifest JSON(重算 digest)。
**不改**:审计引用表(workflow_template_audit.detail、workflow_binding_cutover_claim.result_json)与 event payload JSON —— 它们是「当时说了什么」的引用,按本项目 append-only 守卫原则不改写(guard 排除)。
在飞 run 兼容:snapshot 与行一起迁移后,rework/redispatch 读到的全是新名;roster 同 PR 更名,redispatch 的 `resolveMenuAgentFile("product_design")` 命中。

### 3.4 守卫(残留 + 阴性对照)

结构化守卫而非裸 `rg design`(design 一词在合法语境成千上万):
- 测试断言 menu library 无 shape/node id/role 为 `design`、无 role `designer`、shape 集合精确、可执行节点 label 非空;
- 仓库 sweep 检查 `tpl_design` / `role: design` / `designer:` 等 token 于配置与源码位置,allowlist 明确排除迁移模块、守卫自身、历史文档;
- 阴性对照:守卫核心函数吃一个故意含旧名的 fixture shapes 目录,断言守卫变红。

## 4. 明确不做(决定,不是遗漏)

1. **不为 System Design / Engineering 在图上做显示层区分**(issue 原文决定:后端就是同一个东西,该被看见)。
2. **不改内部行为词表**:node type `design`、edge condition/edge id `design_done`、park status `design_done`、completion route `phase_design_complete`、`ChatThreadRole "design"`、review_type `"design"`。理由:三处身份改名后,这些位置的 design 全部只剩一个所指(工程设计阶段),互撞已不存在;其中 `phase_design_complete` 是 flywheel-comm CLI 对外契约(改动触发 FLY-1914 消费者 sweep,横跨插件缓存),代价与命名收益完全不成比例。
3. **不动 Linear label 路由**(`designer-labels.ts` 的 `designer`/`mockup` label):那是「整 issue 路由到独立 agent」的另一条链路,label 是 founder 面向 Linear 的词汇,不在本单三处之内。
4. **不动 config.yaml 的独立 agent 注册**(`designer` / `product-designer` agents):同上,非 menu roster 链路。

## ⚠️ 附记(2026-08-28 晚):方向被定稿简报替换

本文件 §3「方案方向」写于 Lead 定稿简报(lead-instruction 1965c21b,founder 已拍)到达之前,其改名集(tech_design / role designer→product_design)与迁移策略(DB 原位重写)已被简报替换:新名 `eng_design`、executor designer 不动、**零改史**(模板版本+1,历史 run 保旧名,显示层映射,过渡双名有收场)、新增两层注册表 `.flywheel/agents/registry.yaml`、派工菜单收编、模板清理。§1-2 的代码审计事实不受影响,仍是 plan v2 的依据。ask 3d1cacd9 已获 Lead 裁定(CDE 同名原则确认)。最终方案见 plan.md v2。

## 5. 风险与开放问题

- shape==role 同名歧义 → 已 ask Lead(3d1cacd9),默认按 issue 方向。
- snapshot/manifest digest 重算必须复用 `canonicalSubmissionDigest` 与现有 validate 函数,任何手拼 JSON 都会造成 parse 时 digest mismatch 硬错。
- workkind-cutover 的 canonical_hash 与 selection digest 的 TOCTOU shadow re-read 在部署窗内的行为需在 implement 阶段逐一核对(列入 plan 的实现清单)。
- 部署与 merge 解耦(FLY-1959):迁移代码随 00:00/12:00 班车重启生效,merge 不触发。
