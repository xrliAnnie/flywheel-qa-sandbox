# FLY-1407 binding-migration 引擎面落地 — 调研
Issue: FLY-1407 (https://linear.app/geoforge3d/issue/FLY-1407/enginebinding-migration-1396-addendum-引擎面落地v2-入口三件套keylessflag-offauth)
日期: 2026-07-21
基于: exploration.md

所有 file:line 均在本 worktree(main=5196c8cd 派生的 flywheel-FLY-1407 分支)逐处核过,非转述。

---

## 1. 派发链路事实(runs-route.ts,2117 行)

| 环节 | 位置 | 事实 |
|---|---|---|
| docTier 边界校验(先例) | `runs-route.ts:405-426` | undefined/null → 缺省;非法 → 400 `INVALID_DOC_TIER`(FLY-127 machine-only 形状,同步在边界拦)。**taskCategory 的 4xx 族照此模子** |
| requestAuthKind | `:331` | `master|scoped|tokenless` 三态,secureTokenEqual 判 master |
| 部门 scope 403 | `:647-690` 邻域 | 独立授权 gate,本单不动 |
| label 归一 + owningDept | `:851-855` | labels 一次 lowercase;`departmentRegistry.getDepartmentForIssue` 出 owningDept,**只送 dispatcher,selection/snapshot 不记** |
| active engine run 分类守卫 | `:920-1083` | W8:entry_kind + 窄分类 + fail-closed(`ACTIVE_ENGINE_RUN_UNCLASSIFIED`);legacy 短路的前置守卫已 ship |
| taskCategory 现行解析 | `:1086-1096` | `typeof === "string" ? value : undefined` —— **非 string 静默当 absent**(addendum ② 点名,开关 on 时改 4xx;开关 off 逐字保持) |
| 6(d) 短路条件 | `:1100-1104` | `freshNoThreeStageLegacy = !engineRecovery && !replayReservation && role==="main" && labels.includes("no-three-stage")` —— **信号源=issue label**(cutover 前正确;开关 on 后信号源要换成显式 override) |
| candidate-free 域 | `:1106-1133` | recovery / 短路 / flag-off 不碰 resolver;其余 preflight `resolveWorkflowTemplateCandidateSchema` |
| dagEntry 准入 | `:1140-1183` | 需 `pipelineConfig.dag===true` **且** `!labels.includes("no-three-stage")`(`:1149`,第二处 label 读点)且 flags 过且 schema=1 |
| three-stage 块 | `:1196-1254` | 条件 `!dagEntry && !engineRecovery && role==="main" && (!dispatchEnabled || candidateSchema!==2)`;`resolveThreeStageEntry` 消费 labels |
| keyless 合成 | `:1344-1355` | `dag-auto-` / `wf2-auto-` + randomUUID(W8 已 ship) |
| selection 调用 | `:1360-1398` | 失败一律 409 `GENERALIZED_WORKFLOW_REJECTED`(reason=Error message,无稳定子码) |
| generalized 202/200 | `:1757-1768` / `:1806-1820` | 含 executionId/workflowRunId/workflowNodeId + dagAuthority 附加回显先例(`:1303-1313`);**无 work-kind/来源回显**;200 经 `recordWorkflowStartResponse` 缓存 replay |
| legacy 200 | `:2040-2049` | executionId/issueId/chatThreadId/message(+designBackend);**零 route-decision 信息** |
| 时点 | `:1834+`(legacy)/ `:1489+`(generalized) | 成功路径先起 Runner / durable-accept,后发 200 —— 回显天然 post-launch(addendum ② 已按此写产品承诺) |

## 2. resolver 事实(workflow-template-selection.ts,407 行)

- `:41` `category = input.taskCategory?.trim() || "*"` —— absent/空白 → 通配。**canonicalize(lowercase)不存在**;词表不存在。
- `:42-45` templateId 存在 ⇒ 跳过 binding(豁免硬门的机制面已在);binding lookup 走 StateStore。
- `:131-138` 主 flag off ⇒ return null(W8 flag-off 面);`:137-138` schema 级 block reason → throw。
- `:144-147` v1 需 allowSchemaV1Dispatch + key,否则 null 回落。
- `:148-153` **master-only + key 必须**(auth 面;keyless 由 route 合成解决)。
- `:154-164` `selectionSource = lead | default(通配) | binding(exact)` —— **exact vs wildcard 已可区分**(`binding.task_category === "*"`),缺的是 enforcement:开关 on + category 路径 + wildcard 命中/无行 ⇒ 必须 fail-loud(§4.4a、§9 验收 5b)。
- `:165-174` selection digest 已含 category/templateId/revision/source/selectedBy/reason;**不含 category_source / tier / dept_suggested**。
- `:204-267` active shadow supersession + double-read 一致性(改 candidate 计算时必须两处同步:`:154-164` 与 `:226-246` refreshed 分支)。
- `:284-319` materialize:传 taskCategory/selection;**无 override/preset 注入**(PRD §3.4 点名的注入点)。
- `recoverWorkflowStartSelection :351-406`:candidate-free、master-only —— **新校验一律不得进 recovery 域**(§4.2 适用域)。

## 3. StateStore 事实

- `workflow_run` 列(`:12330-12374`):selection_source/selected_by/selection_reason/entry_kind 在;**无 task_category、category_source、tier、dept_suggested 列**。列迁移模式 = try ALTER ADD COLUMN(幂等,`:12357-12373` 先例)。
- 快照(`workflow-run-snapshot.ts:32-47`):v1/v2 均无 category/source/tier 字段;digest = canonicalSubmissionDigest(body)。**加字段会改变 snapshot_digest ⇒ 只能对新 run 生效,旧 run 解析必须向后兼容(可选字段)**。
- binding lookup(`:13378-13385`):`WHERE task_category IN (?, '*') ORDER BY exact first` —— 行为保留(非-v2 路径靠它);返回行含 task_category,调用方可判 exact/wildcard。
- binding 写入(`:13334-13375`):有 audit row(`bindWorkflowCategory`)。
- sessions 表有 `session_params`(`:628,1391,3100`)—— 但 route decision 需在 session 存在前记录且要可聚合 ⇒ 不选它。

## 4. 开关先例与 flag 面

- `PipelineConfig`(`packages/config/src/types.ts:304-343`):`three_stage` / `three_stage_channels` / `dag`,per-project、canonical root、**每次 dispatch 现读**(runs-route `loadMainPipelineConfig` `:867-876` 惰性一次/请求)。malformed pipeline block 在 config load fail-loud。**新键 `work_kind` 加在这里模式完全一致,免重启、回滚=revert 一行**。
- env flag 面(`workflow-template-dispatch.ts`):`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1` 总闸 + claims read/write + generalized 四合一 fail-closed 谓词。
- **交互裁定点(plan 要明写)**:W8 已 ship 契约 =「主 flag off ⇒ 字节等同 legacy」(§9 验收 6)。若新校验只挂 per-project 开关,flag-off 紧急回滚态仍会 4xx/拒绝 ⇒ 与字节等同矛盾。⇒ 新语义生效条件 = `pipeline.work_kind === true && isWorkflowTemplateDispatchEnabled(env)`(flag-off 回滚永远回到今天的行为)。
- 死 flag 教训(FLY-1385 scope 6):`FLYWHEEL_WORKFLOW_FORCE_LEGACY` 已删 —— 不再造第二个 env 杠杆,新开关只有 config 一处。

## 5. three-stage policy 事实(three-stage-policy.ts)

- `:62-66` reasonCode 词表;`:75` NO_THREE_STAGE_LABEL;`:110-152` `resolveThreeStagePolicy` precedence:global → **label(`:119-126`)** → channel → policy。
- **接线结论**:bypass 落单 session 的机制 = candidate-free(route 层)+ three-stage policy 的 label opt-out(policy 层)。开关 on 域:
  - 残留 label 不得再触发 `:119-126`(否则 1392 病回归);
  - 显式 override 必须能触发同等 opt-out(新 reasonCode,如 `no_three_stage_override`);
  - scoped/tokenless/非-main 与开关 off 域:label 臂逐字保留(§5.6 边界)。
  - ⇒ 注入点在 `ThreeStagePolicyInput` 加显式信号字段,由 runs-route 按域喂;policy 函数其余 caller(plugin.ts handoff 侧)不传新字段 ⇒ 字节不变。**handoff 侧(PhaseOrchestrator resolveThreeStage)读的是 mid-run 的相位推进,不是 fresh 派发路由 —— 不在 §5.6 的 master fresh-main 域,label 臂保留。**

## 6. tier 事实

- `applyWorkflowOverride`(`workflow-template.ts:990-1035`):exactKeys `[reason, nodes]`、node 覆盖只许 `[model, effort, skip]`、**vendor 兼容强制(`compatibleModel`),不能切 vendor**;gate 节点不可覆盖。
- §3.4 preset 表跨 vendor(design: trivial/light=codex,heavy=claude)⇒ 现有 override 无法表达 ⇒ PRD 二选一里只有 (b)(受校验的 vendor+model 原子覆盖)可行。
- selection→materialize 无 override 参数(`workflow-template-selection.ts:284-319`);注入点 = materializeWorkflowRun(PRD 点名)。
- 现三档 = 三个模板(tpl_eng_heavy/light/trivial,seed 于 `workflow-template.ts:1140-1144`);合并成单 tpl_eng + presets 是 **FLY-1380 的模板著作面**;本单只落**引擎 plumbing**(输入口/校验/应用/digest/snapshot/回显)。
- ⚠️ 时序含义:plumbing 先行、模板后到 ⇒ plumbing 必须对「模板无 presets」有定义好的行为(传 tier → 4xx `TIER_NOT_SUPPORTED`;不传 → 不适用)。

## 7. 派发面事实

- Gemini `dispatch_runner`(`gemini-agent/src/tools/schemas.ts:66-98`):现有 issueId/projectName/agentName/docTier;handler args 直通(`registry.ts:113-114`)。docTier = enum 先例(不借 optional)。**required 化后 Gemini 会对所有项目立即传 category ⇒ 在 DAG-enrolled v1 项目上 exact 命中 light/trivial = cutover 前的 live 行为变化 ⇒ schema 改动属 cutover 窗,不进本单 PR**。
- Claude Lead rules:零 taskCategory(§8-D ②拍,cutover 前置;launcher ①拍 = FLY-1402 已 Done)。
- Codex Lead:`start_runner` 不在 gateway 工具面(`action-surface.ts:53-61`),不涉及。

## 8. 部门建议值映射

服务端不存在 `product→prd / engineering→code` 映射(grep 零命中)。它按 PRD **不进路由语义**;但 addendum ②.4a 要求 route decision 持久记 `(sent_category, 部门建议值)` 对 ⇒ 映射需以**常量表**存在于引擎侧,仅供记录/聚合,绝不参与 selection。owningDept 值域来自 DepartmentRegistry(project config 的部门定义);无映射条目的部门记 null(诚实:该部门无建议值)。

## 9. 词表单一定义点(②.3「校验、lint、验收共用同一张表」)

新模块承载(建议 `packages/teamlead/src/work-kind.ts`):
- CATEGORY 词表 `["prd","designer","prototype","code","research"]` + canonicalize(lowercase+trim);
- TIER 词表 `["trivial","light","heavy"]` + 默认档 `heavy`;
- `routingOverrides` allowlist `["no-three-stage"]`;
- category_source 词表 `["task_category","template_override"]`;
- 部门建议值映射 `{product:"prd", engineering:"code"}`;
- 供 route 校验、resolver enforcement、测试 fixture 三处 import 同一常量。Lead 侧 lint(建单体验层)与验收文档引用同一模块导出 —— 不复制。

## 10. 回归/字节兼容红线(plan 的 fixture 基准)

1. **开关 off(含键缺失)⇒ 全链字节等同今天**:非 string 静默 absent、absent→通配、label 短路生效、响应体无新字段。哨兵形态照 FLY-1385/FLY-205 的 reverse-compat sentinel。
2. **dormant v2 binding 在场 + 开关 off ⇒ keyless legacy start 成功**(④.1 指定场景;不接受 v1 `*→tpl_eng_heavy` 旧 fixture 顶替)。
3. **主 flag off ⇒ 字节等同 legacy**(W8 契约不被新开关破坏;§4 的交互裁定)。
4. **recovery / 非-main(QA)/ scoped / tokenless 永不被新校验碰**(§4.2 适用域;新逻辑全部加在 fresh master main 分支内)。
5. **retry 复用 pinned 不重 derive**(actions.ts successor 路径零改动)。
