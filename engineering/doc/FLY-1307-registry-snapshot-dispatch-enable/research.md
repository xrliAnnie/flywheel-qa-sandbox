# FLY-1307 子单D：注册表迁移 + orchestrator 按 snapshot 解释 + 模板派发启用 — 调研

Issue: FLY-1307 (https://linear.app/geoforge3d/issue/FLY-1307/build-dag-模板引擎-子单d原-收尾注册表迁移-orchestrator-按-snapshot-解释-模板派发启用)
日期: 2026-07-16
基于: exploration.md

> 本调研 = 符号级代码审计（本 worktree，含 #578/#593/#613 全部合入），目的：
> ① 钉住 D 必须触碰的面；② 核对伞单 plan v1.35 假设与落地现实的 drift。

## A. 已落基建地图（D 只消费）

### A.1 packages/config — 节点类型与派发真相

| 符号 | 文件 | 现状 |
|---|---|---|
| NODE_TYPE_REGISTRY（6 条目：design/implement/qa/gate/generic/review）+ capability 闭集 + nodeTypeWritesCode | config/src/node-type-registry.ts | C 落地；**legacy 路径不消费**（reverse-compat sentinel 断言 design/implement/qa 条目与 three-stage-phases 现值一致）——双真相源窗口，D 收口 |
| resolvePhaseDispatch(phase, env, override) → {vendor, model, effort?}；DEFAULT_PHASE_DISPATCH；双向 kill-switch（CODEX_IMPLEMENT=0 / CODEX_DESIGN=1）| config/src/three-stage-phases.ts | FLY-1224 已落（1307 硬前置满足）。三段式 dispatch 三元组唯一真相 |
| isThreeStagePhaseRole / nextPhase / PHASE_THREAD_BADGE / resolveCompletionSessionRole | 同上 | legacy 编排词汇；消费方 ≥10 处（见 B.1） |
| VENDOR_TO_EXECUTOR 别名路径 | run-dispatcher.ts / role-adapter-resolver.ts 消费 | vendor→executor 解析既有，D 不新写映射 |
| 4 个 workflow flag（registry.ts governance_gate/kill_switch）| config/src/feature-flags/registry.ts:2190-2295 | workflow_generalized_templates / workflow_claims_write / workflow_claims_read / workflow_force_legacy，全 default-off；claims_write 与 claims_read 各带生产 governance 注记（fresh-spawn E2E + peer-credential 硬前置）|

### A.2 packages/teamlead — 引擎 substrate（StateStore, teamlead.db）

已存在的 workflow 表（StateStore.ts DDL 逐条核对）：

- 模板五表（B）：workflow_template / workflow_template_revision / workflow_template_publication /
  workflow_category_binding / workflow_template_audit（发布 = append-only publication 行 + CAS 指针）。
- run 域（A+C）：workflow_run（含物化 snapshot + **claims_read_enrolled 显式 enrollment 列** +
  selection_source/selected_by/selection_reason）/ workflow_run_node（(run,node,attempt) 投影）/
  workflow_run_event（(run_id,seq) append-only）。
- 凭证与声明（A+B+C）：workflow_decision_capability / workflow_claims / workflow_claim_revocation /
  workflow_execution_binding / workflow_submission_credential / workflow_execution_runtime（不可变
  实录：vendor/model/effort/resolved_family）。
- output/completion（C）：workflow_node_outputs / workflow_node_output_current（CAS 指针）/
  workflow_output_credential / workflow_node_completion（收据 = generalized 终局权威）。
- start 幂等（C）：workflow_start_reservation / workflow_start_stage / workflow_start_response /
  workflow_launch_owner（owner 世代 fence + fenced-commit + delivery_attempt 送达修复）。
- 副作用与投影（A+B）：workflow_side_effect_ledger —— 状态词汇 =
  intent_recorded→launch_committed→started|abandoned；kind 的 CHECK 枚举**已含
  materialize**。**精确现状（Codex R3#3 + R4#2）**：只有 mutation API
  （allocate/transition）硬编码 kind='dispatch'；generic list
  （listWorkflowSideEffects）、non-terminal reconcile 查询
  （listNonTerminalWorkflowSideEffects，shadow-writer.reconcileSideEffects 消费）与
  三个 attribution 方法（listWorkflowRunAttributedFixRounds /
  isExecutionAttributedToWorkflowRun / hasWorkflowRunAttributedShipClaim）的 ledger
  子查询**都未按 kind 隔离** ⇒ PR-7.5 落 materialize 行前必须先做 kind 隔离
  （见 plan §3）。行上没有 output digest / base head / materialized
  head / push 证据列（持久证据 = PR-7.5 的分阶段 receipt，见 plan §3）。
  workflow_source_receipt / workflow_source_deadletter / workflow_source_cursor
  （CommDB source outbox 的 StateStore 侧 projector 记账）。

### A.3 packages/flywheel-comm — CommDB 权威源侧（B）

- workflow_source_event / turn_source_history 两表已在 db.ts（与权威写同事务）；
  ship-eligibility.ts 的 evaluateShipEligibility 读 claims_read/force_legacy 两 flag。
- **PR-8 验收硬 gate 的落点就在这**：验收测试断言 ship 路径消费 source outbox
  （workflow_source_event + turn_source_history 有行、projector 收据对账），不许只断言
  StateStore 投影。

### A.4 编排与派发面（bridge/）

| 模块 | 行数 | 现状与 D 的关系 |
|---|---|---|
| phase-orchestrator.ts | 2052 | legacy 三段式 belt：onPhaseComplete（nextPhase 交接）/ onQaResult（QA-FAIL→implement kickback belt/epoch，recordFixRound）/ reconcileOnStartup / reconcileTurnBelt / grantTurn。**D 的「按 snapshot 解释」在此开 enrolled 分支**；守卫逐字保留（伞单 §3.1 第 4 条）|
| run-dispatcher.ts | — | 已消费 req.generalizedExecution?.dispatch.{vendor,model}（C）与 dispatchVendor/dispatchModel（FLY-1224）；GeneralizedExecutionContext 内部传递已通 |
| runs-route.ts | — | /api/runs/start：C 已接 v2 选择（auth-kind 契约 + reservation/re-drive）；v1 候选 = 返 null 走 legacy（「v1 在 C 永不接 start 线」）——**D/PR-8 打开 v1 eng 接线** |
| workflow-decision-routes.ts | 448 | POST /workflow/output（C）+ POST /workflow/decision（B）已在。**Codex R1#2 核实**：/decision 当前硬编码 QA（双 role=qa 校验、subject=PR head authority、producer 固定查 implement、predicate 固定 qa_passed/qa_failed、成功后直调 phaseOrchestrator.onQaResult）——**不写边/loop/投影**。D 需要通用 decision canonicalization seam（见 plan §2.2），不是「只接线」 |
| workflow-shadow-writer.ts | 618 | A 的并写生产者（观察 legacy 三段式补 run/events）。D 之后：enrolled 引擎驱动 run 不再需要 shadow 合成，shadow 对既有 legacy run 保留 |
| three-stage-policy.ts | — | resolveThreeStagePolicy / resolveThreeStageEntry：今天决定 issue 是否进三段式。**PR-8 的模板选择接在 entry 决策同层**（四级 lead→binding→default→裸 session，1281 已落选择器，eng v1 currently 不接线）|
| Blueprint.ts (edge-worker) | — | isGeneralizedExecution 门控完整（1281 QA HIGH 已修：gate/approve tail 对 generalized 抑制）；capability 驱动的提示组装已在 |

### A.5 种子（6 份已捆绑，workflow-seeds/）

- v1（B，schema_version 1）：tpl_eng_heavy / tpl_eng_light / tpl_eng_trivial ——
  含完整 nodes（vendor/model/effort per node）+ edges（design_done/implement_done/qa_pass）+
  qa_retry loop（qa_fail/qa_pass/max 3/escalate）+ terminal_gate(founder_approved) + ship_claims。
- v2（C，schema_version 2）：tpl_product_v1 / tpl_research_light / tpl_ops_light。
- importBundledWorkflowSeeds content-hash 幂等 + ensureDefaultWorkflowBindings 已在；
  boot 导入 flag 感知（generalized OFF ⇒ v2 种子跳过）。

## B. Drift 清单（伞单 plan 假设 vs 落地现实 — 全部无碍，写明防实现期踩空）

1. **种子命名**：伞单 §3.1b 示例写 tpl_eng_three_stage 单模板；落地为 eng 三档
   （heavy/light/trivial，B 期间演化）。D 一切以落地 6 种子为准；伞单示例仅为形态示意。
2. **「三个独立 flag」**：伞单 §3.2 说写/读/应急回退三 flag；落地为 4 个（多一个
   generalized_templates 门 v2 面，1281 gate 批过）。PR-8 的「启用」杆是否新增第 5 个
   flag = plan.md 要定的切片决策（见 plan §PR-8）。
3. **enrollment 标记（Codex R2#5 修正本条初稿）**：伞单要求「按 run 显式标记」；落地 =
   workflow_run.claims_read_enrolled 列——但它**只表示 claims 读迁移**（legacy
   admitWorkflowExecution 也会置它，legacy shadow run 可无 snapshot），**不能**当引擎
   接管判别。D 新增独立的 workflow_run.engine_owned 列（唯一写点 = start reservation +
   snapshot 物化同一事务），见 plan §2.2-0。
4. **claims_read 硬前置**：伞单 §2.2（FLY-1244 收窄后）钉死「peer-credential broker /
   独立 principal + fresh-spawn E2E 闭合前 READ 保持 off」。含义：**eng 模板派发的生产
   enable 被传递性挡住**（enrolled run 的 ship gate 走 claims 读）——PR-8 只交杆不拉杆。
5. **workflow_side_effect_ledger 的 materialize 面（Codex R1#5 + R3#3 两轮修正本条）**：
   kind 的 CHECK 枚举**已含 materialize**（StateStore.ts:15975-15995）；mutation API
   硬编码 kind='dispatch'，但 generic list / non-terminal reconcile / attribution
   子查询**均不分 kind**（shadow-writer 的 dispatch reconciler 会读到未来的
   materialize 行，attribution 会把 'mat:' effect id 当 execution）；状态词汇
   是 intent_recorded→launch_committed→started|abandoned（非伞单示意的
   intent→committed→done）。缺的是 materialize 专用 allocate/transition/reconcile API、
   分阶段持久证据与 reconciler kind 隔离 —— 正是 PR-7.5 的活；决策见 plan §3。
6. **review 执行的跨厂商第二道**：claims 层 reviewer≠producer family 校验（B）+ admission
   层 family 校验（C）都已在；D 的 review 节点执行只需接 predicate family=review_verdict
   的凭证签发与 design_review_approved claim 写入，不新做校验逻辑。

## C. D 必须触碰的面（按 PR 切片归位 → 详见 plan.md）

### PR-7（注册表迁移 + orchestrator 按 snapshot 解释）
- config：three-stage-phases.ts 的角色/badge/completion-role 语义改为从 node-type-registry
  派生（或反向单一真相 + 派生断言），消灭双真相源；resolvePhaseDispatch 保持 dispatch 真相不动。
- teamlead：phase-orchestrator enrolled 分支（onPhaseComplete/onQaResult 边界按 snapshot 选边）；
  run_event 补 node_dispatched/edge_traversed/loop_iteration/gate_opened 事件面；
  后继节点 admission 打开（fresh 起点限制放宽为「snapshot 合法后继」，attempt 规则沿用）；
  review 节点执行解锁（admission + review_verdict 凭证 + design_review_approved claim +
  review_pass/review_fail 边）；loop 边解释（四要素，belt 守卫逐字迁移）；
  gate 终点节点 → founder 批准（claim 读，E2 语义）；stranded collector 从「只 hold」升级。
- 派发一律带 snapshot 钉住三元组走 run-dispatcher 既有 generalizedExecution.dispatch 通道。

### PR-7.5（docs materializer，独立切片 — gate 裁定）
- 受信 Bridge materializer：accepted Produce output → 服务端派生 repo/branch → 物化 docs
  分支 + push → 服务端捕获 head 作 review/founder claim subject；
  side_effect_ledger kind=materialize 状态机（intent/commit/reconcile，crash 安全）；
  校验链 = schema/size/path allowlist + 规范化序列化 + 拒 symlink/路径逃逸 + docs 分支
  TURN 独占 + 内容寻址幂等；rematerialization 作废旧 review、起新 attempt（伞单 §5-Q2 ①-⑤）。
- 测试四类：伪造 output / 旧 attempt output / materializer crash / 并发 materializer。

### PR-8（模板派发启用收尾）
- eng v1 模板接 start 线：three-stage entry 决策层接四级模板选择（enrolled run 物化 +
  引擎驱动派发），default-off 新杆（flag 决策见 plan）。
- 种子导入收尾核对（6 种子 + 绑定幂等）；全 sentinel 矩阵（伞单 §0 + §2.5 E1-E6 +
  PRD §13 S1-S16 逐条映射）；**source outbox 硬 gate 验收**（断言 CommDB
  workflow_source_event/turn_source_history + projector 对账，不许投影降级）；
  一次真机 E2E；enable 决策材料（呈 Annie，带 default-enable 偏好 + claims_read 硬前置说明）。

## D. 测试资产现状（复用不重造）

- A/B/C 的既有测试全绿在 main（claims 43 / shadow 27+32 / orchestrator+dispatcher 187 /
  TmuxAdapter 108 / 1281 own 180 + E2E 14）。
- 红测 REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts 已在 B（PR-4）变绿——D 不许改弱断言。
- 1281 真机 E2E 脚本 scripts/qa-fly-1281-generalized-template-e2e.mjs 是 PR-8 真机 E2E 的底板
  （扩：后继派发 + review 执行 + loop 回环 + gate 终点 + eng v1 全链）。
