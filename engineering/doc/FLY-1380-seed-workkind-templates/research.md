# FLY-1380 种 work-kind 模板 — 调研(代码/生产实况审计)

Issue: FLY-1380 (https://linear.app/geoforge3d/issue/FLY-1380/dagbuild-种-work-kind-binding1396-prd-落地-派发按活的类型选模板不再一律-tpl-eng-heavy)
日期: 2026-07-22
基于: exploration.md

全部 file:line 基于本分支 HEAD(含 FLY-1407 `e79d7daf`,已验证 `git merge-base --is-ancestor` 在历史内)。生产数据取自 `~/.flywheel/teamlead.db` 只读副本(2026-07-22)与 `~/.flywheel/.env` 实读。

## 1. 生产实况(终点取证)

| 事实 | 证据 |
|---|---|
| DAG 派发已开、generalized off | `.env` 有 `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1`,无 `FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` |
| 模板库只有 6 个 v1 | `workflow_template`:tpl_eng_{heavy,light,trivial} + 三个 `_land_v1`;`workflow_template_revision.schema_version` 全 1 |
| binding 每项目恰一行 | `workflow_category_binding`:6 项目 × `* → tpl_eng_heavy`(`system:bundled-default`) |
| retired_at 列已在、全空 | FLY-1407 幂等 ALTER(`StateStore.ts:2763`) |
| 运行史 | `workflow_run`:25×tpl_eng_heavy + 27×空(legacy);land 变体零使用 |

## 2. seed / import / publish 机制

- Bundle 清单:`workflow-template.ts:1266-1278`(`BUNDLED_SEED_FILES`,注释要求历史顺序对**追加**稳定)。seed 文件 exactKeys = `template_id/name/project_scope/manifest`(`:1289-1293`)。
- **import = 发布**:`StateStore.importWorkflowTemplateSeed`(`StateStore.ts:13485`)一个事务里写 identity + revision + **publication** + `current_published_revision`;`seed_content_hash` 幂等(unchanged → 零写入);founder-owned seed 不覆写(audit refused)。
- **v2 在 import 处被双重挡**:`importBundledWorkflowSeeds` skip(`workflow-template.ts:1310-1319`)+ store 层 throw(`StateStore.ts:13490-13492`)⇒ 生产 v2 模板永远装不上 —— 这是「发布 dormant」要解开的唯一闸门。
- warm 调用点:`plugin.ts:3964`(`importBundledWorkflowSeeds(store)`,FLY-1244 deterministic boot import)。
- `isGeneralizedTemplatesEnabled` 的**全部** caller(盘点,确认改动面收得住):
  1. `workflow-template.ts:1313`(bundle skip)——本单解除;
  2. `StateStore.ts:13490`(seed import throw)——本单解除;
  3. `StateStore.ts:13244`(revision 提交)/ `:13430`(publish)——**不动**(运行时写面控制照旧);
  4. `workflow-template-dispatch.ts:38`(`workflowTemplateDispatchBlockReason`:selection / materialization / admission / successor 的共享 fail-closed 谓词)——**不动**,v2 路由照旧被 flag 挡;
  5. `config/src/feature-flags/registry.ts:3058-3080`(`workflow_generalized_templates` 注册表条目)——描述需随本单更新(flag 真值纪律,见 §5)。

## 3. binding 与 dormancy

- **唯一写入者** = `ensureDefaultWorkflowBindings`(`workflow-template.ts:1337-1357`;产品代码里 `bindWorkflowCategory` 无第二个 caller,cutover 执行器尚不存在)。
- 守卫:项目已有**任何** binding 行 ⇒ 整体跳过(`:1347-1348`)⇒ 生产 6 项目当前 warm 零写入;零 binding 的新项目种 legacy 3 行(`*`/`light`/`trivial`,`DEFAULT_ENGINEERING_WORKFLOW_BINDINGS`,`:1326-1330`)。
- warm 调用点:`plugin.ts:4173`(ManagementProjectSource warm 回调,项目清单每次刷新都会跑)。
- binding lookup:exact 优先、自动回 `*`(`StateStore.ts:13635-13642`);FLY-1407 已加 enforced 模式(exact-miss → `WORK_KIND_BINDING_MISSING`,`workflow-template-selection.ts` R4 typed error)。**本单不碰。**

## 4. manifest schema 能力(决定 designer/prototype 形状的硬约束)

- v2 节点类型:`design|implement|qa|gate|generic|review`(`workflow-template.ts:762-766`);gate 节点不可带 vendor/model/…(`:767-781`);**只有 generic 可带 `agent_file`/`produces_output`/`output`**(`:783-789`)。
- **非终点节点恰一条出边、条件按类型绑死**(generic→`node_done`,review→`review_pass`;gate 无合法出边)⇒ **非终点 gate 不可表达、无条件分支**(`:1052-1078`)。
- **loop 只许挂 qa(qa_fail)与 review(review_fail,且 `to` 必须是 review 的直接上游)**;其它节点带 loop 直接抛(`:1079-1103`);`max_iterations` 必须正整数(`:951-956`)⇒ 开放循环不可表达。
- `founder_feedback_kickback` 只在 **v1 land 变体** approval gate 可用(`:503,634-638`;引擎消费:`workflow-engine-dispatcher.ts:1093`、`StateStore.ts:19671,19690`)。v2 词表里有它(`:963`)但没有任何节点能合法挂 ⇒ 死字。
- review/qa 节点与 ship_claims 成对强制(`:1007-1020`);**含 writes-code 节点必须恰一个 qa 节点**(`:1021-1025`);`nodeTypeWritesCode` = `shared_branch_writer || creates_pr`(`config/src/node-type-registry.ts:151-155`)——generic **不算** writes-code(tpl_ops_light 无 qa 节点能过验证即为证)。
- `compatibleModel`:claude→`claude-*`,codex→`gpt-*`(前缀校验)。

## 5. tier_presets(模型旋钮)—— 基建已全部就位

- v1 与 v2 manifest 都接受 `tier_presets`(v1 验证 `:665`,v2 `:1114`);`validateTierPresets`(`:250-266`):键 ⊆ `ENG_TIERS`,**必须定义 heavy**;每档 preset 是 `WorkflowTemplateOverride`(`{reason, nodes:{<id>:{vendor,model,effort,skip}}}`),逐档过 `applyWorkflowOverride` 校验。
- FLY-1407 D5/D6 已接线:`req.body.tier` → selection 应用 preset(`workflow-template-selection.ts:222-235`:声明 presets 时 absent→`DEFAULT_ENG_TIER`(heavy);未声明 presets 时 present→`TIER_NOT_SUPPORTED`);`applyWorkflowOverride` 已支持 vendor+model 成对覆盖(`workflow-template.ts:1175-1201`);materialize 时 `delete next.tier_presets`(`:1163`)。
- **override 只能设 effort、不能清 effort**(`:1202-1208`)⇒ 合并模板的 base 必须取「无 effort 底座」,由 heavy preset 加 `xhigh`(exploration D2)。
- 三套旧 eng seed 实测:拓扑/loop(max 3)完全一致;差异仅节点 vendor/model/effort(exploration D2 表;trivial qa=claude-fable-5、light/heavy qa=claude-opus-4-8、仅 heavy implement 带 xhigh)。

## 6. v2 generic 节点的 agent_file 解析(designer/prototype 的部署约束)

- **materialization 时**从 `canonicalRoot`(目标**项目 repo 根**)读文件、pin 内容+digest 进 snapshot:`workflow-run-snapshot.ts:99-120`(realpath + 越界拒绝 + **40k 字符截断** + 非空校验);读不到 ⇒ materialize 直接抛(fail-loud,不物化 run)。
- ⇒ 新 executor 文件落 **flywheel repo 根 `agents/`**(与 `agents/generic-executor.md`(15.0k)、`agents/qa-executor.md`(6.1k)同目录);**其它项目 repo 没有该文件之前,不能对那个项目 cutover 绑 designer/prototype** —— 这是 cutover preflight 的一条新合同,写进 plan 交接。
- 与 label 路由的 `agentFileRoot: "flywheel"|"project"` 机制(`AgentDispatcher.ts:162-190,215-268`;`Blueprint.ts:2405-2435`)是**两条不同的解析路径** —— 前者管 legacy/label 派发,后者(canonicalRoot)管 DAG v2 节点;别混。

## 7. retire 写入面(FLY-1407 D9a 移交)

- 读侧已在:fresh 选择校验 `retired_at IS NULL && current_published_revision`(`workflow-template-selection.ts:88-93`,retired/unpublished → `TEMPLATE_NOT_FRESH_ELIGIBLE` 409);active pinned run candidate-free、不受影响。
- 写侧空缺:全 repo 无任何 `retired_at` 写入者 ⇒ 本单补 `StateStore.retireWorkflowTemplate`。
- **audit 表有 CHECK 约束**:`workflow_template_audit.action IN ('seed_import','publish','rebind','create','run_override')`(`StateStore.ts:2803-2811`)⇒ 加 `template_retire` 动作需**表重建迁移**;repo 内有现成先例:`workflow_claims` 的 sqlite_master 检测 + DROP/RENAME 重建(`StateStore.ts:12711-12778`)。

## 8. 引擎面(FLY-1407 已 ship,本单只消费不改)

- per-project 开关 `pipeline.work_kind`(off=字节今天);taskCategory 词表/类型校验、exact-row enforcement、route 收据 + reminder outbox、回显、`no-three-stage` routingOverrides —— 全在 `#670`。
- **founder correction(2026-07-21)**:on 域 absent taskCategory **不拒派**,软兜 generic 单 session(`category_source=default_fallback`)+ 幂等提醒 —— PRD §4.7 的 required-param 硬门已被 founder 三分支裁定取代。对本单无直接影响(binding/模板面不变),但 HTML/文档不得再按「absent=拒派」表述。
- 词表 SSOT:`packages/teamlead/src/work-kind.ts`(`WORK_KIND_CATEGORIES = prd|designer|prototype|code|research`、`ENG_TIERS`、`DEFAULT_ENG_TIER=heavy`)—— 哨兵测试直接 import 它,不抄第二份。

## 9. 风险点登记(plan 要各给一条处置)

1. **移除 bundle 条目会移动后续条目的数组下标** —— `loadBundledWorkflowSeeds` 的消费者只有 `importBundledWorkflowSeeds`(顺序不影响正确性)与测试;无持久化顺序消费者(grep 全 repo 证)。安全,但注释里那句「historical ordering」要同步改写清楚。
2. **ungate import 后首次重启会写模板表**(每新模板 identity/revision/publication + 1 条 `seed_import` 审计)—— 属「创建+发布」动作本身,不触 binding;验收按「binding audit 零新增」口径量,并把这次安装 burst 写进 ship note(部署后核对模板表行数)。
3. **feature-flag registry 的 flag 真值**:`workflow_generalized_templates` 条目描述含「schema-v2 …templates」总括语 —— import 面解除后,描述必须改为「gates v2 admission/selection/submission,不再 gates bundled seed install」,否则就是 §5.5 第 5 例(控制面与真实行为脱钩)。
4. **QA slot / flag-on 环境已装过 tpl_ops_light/tpl_research_light** —— 从 bundle 移除只停止自愈,不删 DB 行;它们进 §3.3 retire 时序(cutover 单),本单不清理。
5. **`tpl_product_v1` 内容一字不动**(PRD:已存在)—— 但它将随 ungate 首次安装进生产;其 review 模型 claude-sonnet-4-5 是既有事实,不在本单翻新(改模型=另立 revision,交 cutover 前的产品决定)。
