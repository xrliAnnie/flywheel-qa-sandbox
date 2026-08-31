# FLY-2121 workflow design 命名互撞 — 调研

Issue: FLY-2121 (https://linear.app/geoforge3d/issue/FLY-2121/命名-workflow-shapenoderole-三处-design-命名互撞-后端改名-稳定-id-与展示名分离)
日期: 2026-08-28
基于: exploration.md

## 1. 调研目标

把 exploration 定下的方向落成逐文件、逐表、逐字段的影响清单,并核实迁移的三个硬约束:digest 重算、在飞 run 的连续性、启动顺序。

## 2. 名字流动全链路(source of truth 链)

```
menus/shapes/*.yaml (shape/node id/role/label 的唯一源)
  → loadWorkflowMenuLibrary() 按 `${shape}.yaml` 文件名装载 (workflow-menu.ts:384-391)
  → compileWorkflowMenuSeed() 铸 manifest(node id/role 原样进 manifest;role 经 nodeType() 折成 type)
  → workflowMenuTemplateId(shape) 铸 template_id (config/workflow-menu-contract.ts:24)
  → importWorkflowTemplateSeed() 落 workflow_template / _revision(manifest JSON + manifest_digest)
  → run 启动: binding(task_category=shape) → template → pinned snapshot(JSON, 双 digest)
  → dispatch: snapshot node.role → resolveMenuAgentFile() → ic-roster.yaml 键
  → dispatch: node.type → chat_thread_role / session_role("design"|"implement"|"qa"|"main")
  → 前端: /menus 返回 shape+node(无 label 字段);DAG 视图 name=node.id (management-dag-source.ts:110)
```

关键结论(改名的分界线):**node id / role / shape 是"身份名"**,从 yaml 一路落库;**node type 是"行为类"**,由 role 折算、驱动 capabilities/threads/routes,不进前端命名面。改身份名、保行为类,即可把爆炸半径限制在下表。

## 3. 逐文件影响清单(src,已逐个打开确认)

### 3.1 必改 — 身份名定义与消费

| 文件 | 位置 | 改什么 |
| -- | -- | -- |
| `menus/shapes/design.yaml` | 全文件 | 改名 `product_design.yaml`;`shape: product_design`;`role: product_design`;新增 shape/node `label` |
| `menus/shapes/code.yaml` | nodes/edges | `id/role: design` → `tech_design`;edge `from: design` → `from: tech_design`;新增 `label` |
| 其余 4 个 shape yaml | nodes | 仅新增 `label`(id/role 不变) |
| `packages/config/src/workflow-menu-contract.ts` | 8-15 | `taskCategory: "design"` → `"product_design"`,`tpl_design` → `tpl_product_design` |
| `packages/teamlead/src/workflow-menu.ts` | 393-399 nodeType() | `role === "design"` → `role === "tech_design"`(仍返回 type `design`);label 解析/校验(parseMenuNode/parseMenuShape);compileWorkflowMenuSeed 携带 label、`land` 节点合成 label;seed `name` 用 shape label |
| `packages/teamlead/src/StateStore.ts` | 28476-28514, 38594, 39827+, 40374-40485 | rework 白名单与 TS 联合类型中的 node id 字面量 `"design"` → `"tech_design"` |
| `packages/teamlead/src/bridge/workkind-cutover.ts` | 25-37 | `REQUIRED_MENU_ROLES` 的 `design/designer` → `tech_design/product_design`;`REQUIRED_MENU_ADOPTION` 的 `"design"` → `"product_design"` |
| `packages/teamlead/src/bridge/management-dag-source.ts` | 110 | `name: node.id` → label 优先(见 §5) |
| `packages/teamlead/src/bridge/workflow-menu-routes.ts` | 108-133 | 响应加 shape `label` 与 node `label` |
| `packages/teamlead/src/workflow-template.ts` | WorkflowManifestNode | 增加可选 `label?: string`,validate 接受 |
| `.flywheel/menus/ic-roster.yaml` | 键 | `design:` → `tech_design:`,`designer:` → `product_design:`(值——agent 文件路径——不变) |
| `.flywheel/menus/adoption.yaml` | 值 | `design` → `product_design` |
| `scripts/package-onboard.sh` :140-146 与 `scripts/package-onboard-files.allow` :14-19 | 文件名清单 | `shapes/design.yaml` → `shapes/product_design.yaml` |
| `packages/config/src/node-type-registry.ts` | 70 | badge `🎨设计` → `🎨技术设计`(type id 本身不改) |

### 3.2 必改 — 测试与文档

`rg -l 'tpl_design|"designer"|shape: design'` 计 16 个文件;其中在 menu/roster 链路内需要同步改的测试:`workflow-menu.test.ts`、`work-kind.test.ts`、`workflow-engine-dispatcher.test.ts`、`workkind-cutover-routes.test.ts`、`doctor.test.ts`(roster fixture)、`run-dispatcher-fly887-turn-seam.test.ts`、StateStore 引擎族测试中以 `design` 为 node id 的 fixture(engine-invariant / workflow-claims / rework 族)。实现时以 sweep 为准,不以本清单为上限。

### 3.3 明确不改(每条都有归属)

| 不改 | 它是什么 | 为什么不撞 |
| -- | -- | -- |
| node type `design`(node-type-registry) | 行为类 | 三个身份名改掉后,type 位的 design 只剩一个所指(工程设计阶段行为);且 type 进 pinned capabilities/digest,改它要动历史快照 |
| `design_done`(edge condition、edge id、park status)、`phase_design_complete`(completion route) | 引擎/CLI 协议常量 | `phase_design_complete` 是 flywheel-comm 对外契约,净改名触发 FLY-1914 全消费者 sweep(插件缓存×N);design_done 语义=「工程设计完成」,无歧义 |
| `ChatThreadRole "design"`、session_role、`WorkflowActorRole`(turn-belt)、`WORKFLOW_PHASE_ROLES`(runner-shutdown-evidence)、post-ship-finalization 的 `chat_thread_role === "design"` | 均派生自 node **type**(workflow-engine-dispatcher.ts:2744 实证) | 保 type 即全部不动,sessions/threads 历史零迁移 |
| `review_type "design"\|"code"`(codex design review) | 另一条评审轴 | 与 workflow 命名无关 |
| `designer-labels.ts`(`designer`/`mockup` Linear label)与 config.yaml 的 `designer`/`product-designer` agent | 整 issue label→独立 agent 路由链 | 与 menu roster 是两条链路;label 是 founder 在 Linear 用的词 |
| 外部项目 roster | personal-assistant 只有 `generic` | 实测无外部仓引用 design/designer role |

## 4. 迁移核实(teamlead.db)

### 4.1 需要重写的运行态身份列(逐表确认过 schema)

| 表 | 列 | 旧 → 新 |
| -- | -- | -- |
| `workflow_template` | template_id(PK)、name | `tpl_design` → `tpl_product_design`;name 换 label |
| `workflow_template_revision` / `workflow_template_publication` | template_id(FK) | 同上 |
| `workflow_template_revision`(tpl_code 各 revision) | manifest JSON + manifest_digest | node id/role `design` → `tech_design`,digest 用 `canonicalSubmissionDigest(validateWorkflowManifest(...))` 重算 |
| `workflow_category_binding` | task_category(PK 组件)、template_id | `design` → `product_design`、`tpl_design` → `tpl_product_design` |
| `workflow_run` | template_id、current_node_id、snapshot JSON | snapshot 里 manifest+resolved 节点同步改,`manifest_digest`/`snapshot_digest` 按 workflow-run-snapshot.ts 同函数重算(parse 时校验,见 :626-630,手拼必炸) |
| `workflow_run_node` / `workflow_run_event` | node_id | `design` → `tech_design`(仅限所属 run 的模板为 tpl_code 家族;design shape 的节点叫 `produce`,不涉及) |
| `workflow_gate_holder` | gate_node_id | 不涉及(gate 叫 founder_gate)——迁移中留断言确认 0 行 |
| `workflow_node_pr_binding` | node_id | design 节点不出 PR,预期 0 行,留断言 |
| `workflow_rework_request` / `workflow_rework_route_revision` | source_node_id / target_node_id / invalidation_scope_json | `design` → `tech_design` |

### 4.2 明确不重写(append-only 引用)

`workflow_template_audit.detail`、`workflow_binding_cutover_claim.result_json`、`workflow_run_event.payload` JSON、session_events —— 它们是「当时发生了什么」的引用,按本项目 append-only 守卫原则不改写;守卫的残留检查显式排除审计引用。

### 4.3 顺序与幂等

Bridge 启动顺序实证:StateStore 构造(建表+迁移)先于 `importWorkflowMenuSeeds()`。迁移放 StateStore 打开路径,单事务;幂等性天然成立(WHERE 旧名,迁完命中 0 行)。迁移后种子导入:`tpl_code` 内容 hash 变 → 自动发新 revision;`tpl_product_design` 行已被迁移改名,seed hash 不同(role+label 变)→ 在既有模板上发新 revision(不是新模板行);`reconcileMenuCategoryBindings` 全部命中 existing。

### 4.4 在飞 run 连续性

- rework/redispatch 读 snapshot(已迁移)→ role `product_design`/`tech_design` → 同 PR 改过的 roster 命中。
- founder feedback rework payload 的 `target` 由引擎从迁移后的 snapshot/行派生,不跨迁移持久化旧值(workflow_rework_* 表已在迁移清单)。
- 残余风险(列入 implement 核对清单):selection digest 的 TOCTOU shadow re-read 若跨重启窗口比较迁移前后的 digest 会 mismatch;workkind-cutover 的 restore 路径 preflight 用新常量后与既有 claim 的 canonical_hash 关系需跑一遍其测试确认 fail-loud 而非 fail-wrong。

## 5. 展示名(label)设计核实

- `/menus` 响应与 `ManagementDagView` 是前端仅有的两个 workflow 命名消费面(bridge 全目录 grep 证实 fleet-console 不含 design 命名)。
- menu 种子模板:label 必填(parse 校验)→ 保证「不出现空名」;founder 自建模板(seed_owner='founder')manifest 可能无 label → DAG 视图 `label ?? id` 回落,作为诚实边界写进验收说明(不是兼容层:id 本来就是合法展示回落,不存在旧名映射)。
- label 建议值:`code`=工程开发 / `tech_design`=技术设计 / `implement`=实现 / `qa`=QA 验证 / `founder_gate`=创始人门 / `land`=合入 / `product_design`(shape)=产品设计 / `produce`=产出 / `prd`=产品需求 / `prototype`=原型 / `generic`=通用 / `simple_code`=轻量开发。

## 6. 守卫可行性核实

- 结构化守卫:加载真实 `menus/shapes/` 断言 shape 集合精确等于新集合、无 node id/role ∈ {design, designer}、可执行节点 label 非空;`WORKFLOW_MENU_BINDINGS` 无 design/tpl_design。
- 文本 sweep:`tpl_design`、`role: design`、`designer:`(roster 键位)等 token 扫 `packages/ scripts/ menus/ .flywheel/menus/`,allowlist 排除:迁移模块、守卫自身、`engineering/doc/`(历史文档)、`designer-labels.ts` 族(label 路由链)。
- 阴性对照:守卫核心收 `shapesDirectory` 参数(loadWorkflowMenuLibrary 已支持注入),测试喂含旧名的 fixture 目录断言守卫抛错 → 「故意留一处旧名守卫必须变红」以单测形式常驻。

## 6.5 定稿简报到达后的补充审计(2026-08-28 晚)

- `BUILTIN_NODE_AGENT`(workflow-run-snapshot.ts:274):node type → 一行话 agent 内容的内置回落;snapshot 在 run 启动时把 agent 内容(md 或回落)连 digest 一起冻结(:49, :309)。旧 run 的再解析可能命中回落 ⇒ 常量在过渡期必须保留。
- `parseWorkflowRunSnapshot` 对 snapshot 顶层 `task_category` 按 live `WORK_KIND_CATEGORIES` 校验(:583)⇒ 词表撤掉 `design` 会让全部已落库 design-shape snapshot 解析即炸;零改史下必须给解析器加 legacy 放行。
- teamlead.db 模板实测:18 行;已退役且 0 run 的恰好 = 简报④的 11 个;tpl_eng_heavy 已退役但有 36 个历史 run(founder 未点头删,单列);活跃 6 个:tpl_code(225)/tpl_generic_menu(59)/tpl_simple_code(36)/tpl_prd(17)/tpl_design(4)/tpl_prototype(4)。
- `.flywheel/config.yaml` agents 键:engineer/qa/product-designer/pm/prototype/designer/general,各带 agent_file+department(s)+match.labels;「config 不再重复定义」= 定义收缩为注册名引用。
- 新路脚本面:`scripts/test-deploy.sh:1882`(role 列表断言)、`scripts/lib/qa-generalized-e2e-lib.mjs:466`(`role === "design"`)。
- Codex 对 v1 草案的评审(已作废方案)留下的可迁移事实:workflow_actor.role / sessions.workflow_node_id / workflow_execution_binding.node_id 等运行态身份列存在且被 `resolveWorkflowNodeIdForExecution()` 交叉校验 —— 这正是零改史优于原位重写的论据(内部一致性天然保持);相关文件存档 /tmp/codex-rescue-design-feedback-flywheel-FLY-2121-plan-round1.OBSOLETE-v1.md。

## 7. 遗留开放点

1. shape 与 role 同名 `product_design` —— ask 3d1cacd9 待 Lead 答复,默认按 issue 方向(exploration §3.1)。
2. `rg -r` 是 replace 不是 recursive(本次调研踩过):sweep 脚本一律用 `rg -n --fixed-strings`,避免误写 flag 扫出假象。
