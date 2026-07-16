# FLY-1281 模板泛化到非三段式任务类别 — 探索

Issue: FLY-1281 (https://linear.app/geoforge3d/issue/FLY-1281/build-dag-模板引擎-子单c原-泛化模板泛化到非三段式任务类别per-leadper-category-模板选择)
日期: 2026-07-14
基于: 无（上游 spec = main 上 engineering/doc/FLY-1135-layer1-dag-templates/plan.md 原⑥/PR-6 格 + engineering/doc/FLY-1020-workflow-templates/prd.md）

---

## 1. 任务定位 — C=原⑥ 在 spec 里到底是哪几格

FLY-1135 切单（Annie 拍板，评论 6069258b）：A=①②（FLY-1232，#578 已 ship）· B=③④⑤（FLY-1244，#593 已 ship）· **C=⑥（本单）** · D=⑦⑧（等启用）。原①-⑧ = 伞单 plan.md §3.2 的 8-PR 序列。

**PR-6 格的字面内容 = 「node-id 生命周期 8 面 + generic 契约 + Blueprint capability 门控」**。对回 FLY-1020 PRD §14，这正好是 Gate A 尚未落地的三项：

| PRD Gate A 项 | 内容 | 状态 |
|---|---|---|
| 1. schema/loader/校验 | 模板 config schema + canonical loader | ✅ B 交付（workflow-template.ts） |
| 2. 物化 snapshot + admission | materializeWorkflowRun + 钉版本 | ✅ B 交付 |
| 3. **node-id 生命周期 substrate** | §3.1 + §2.3b 全 8 面 | ❌ **本单** |
| 4. ship-gate 证据模型 | claims 形态（伞单 §2.4 修订） | ✅ B 交付（claims 读切换 + 红测变绿） |
| 5. **generic output/completion 契约** | §5.6：workflow_node_outputs + 严格 loader | ❌ **本单** |
| 6. **Blueprint capability 门控** | §5.7：去三分支硬编码，改读 capability | ❌ **本单** |

issue 标题的「泛化到非三段式任务类别（per-Lead/per-category 模板选择）」与 PR-6 格是同一件事的两面：**非三段式模板要能存在，前提是系统的 session 生命周期不再假设 design/implement/qa 三值**——这就是 8 面 substrate；**要能被选中**，就是 per-Lead/per-category 选择解析；**要能安全地跑非工程节点**，就是 generic 契约 + capability 门控。

## 2. 代码现状审计（A+B 合并后，基于 main 5e7c2a868）

### 2.1 已有（A+B 交付，不重做）

- **claims 基底（A）**：workflow_claims / claim_revocation / decision_capability / run / run_node / run_event 6 表 + 单事务提交 + E3 幂等/fail-closed + typed enrollment（claims_read_enrolled 列，绝不由数据推断）。
- **执法层（B）**：founder guard 收口 + claims 读切换（红测变绿）+ workflow_execution_binding + workflow_submission_credential（短 TTL、只存 hash、绑 (run,node,execution,attempt)）+ head-authority（服务端捕 head）。
- **模板层（B）**：workflow_template / _revision（manifest 字节不可变+append-only triggers）/ _publication（CAS 指针）/ **workflow_category_binding**（(project,task_category)→template_id，含 '*' 默认）/ _audit（含 run_override）5 表；workflow-template.ts 严格校验器；materializeWorkflowRun（binding→published revision→per-run override→复验→钉 snapshot）；admitWorkflowExecution（fail-closed 预派发 admission，已按 (runId,nodeId,executionId,attempt) 绑定）；3 个 eng 种子（tpl_eng_heavy / light / trivial——Annie 档位输入已落）。
- **flags（A/B）**：workflow_claims_write / workflow_claims_read / workflow_force_legacy 三 flag 分立，全 default-off。
- **run-dispatcher 接缝（B）**：workflowShadow + workflowClaimsAdmission 两个可选 seam 已进 spawn 路径。

### 2.2 泛化的钉死点（本单要开的锁）— 逐条核过码

**(a) manifest 校验器是三段式形状的**（workflow-template.ts）：

| 钉死点 | 位置 | 后果 |
|---|---|---|
| 节点类型闭集 design/implement/qa/gate | :19, :192 | 无 generic、无 review，产不出非工程节点 |
| **恰好 1 个 QA 节点** | :260 | 无 QA 的短链（product/research/ops）直接 reject |
| 边条件闭集 design_done/implement_done/qa_pass/founder_approved | :22, :284 | generic/review 节点无出边词汇 |
| 每节点出边条件由 type 唯一决定 + 恰 1 条出边 | :410-432 | 只能表达「design→implement→qa→gate」一种链形 |
| ship_claims 必含 qa_passed+founder_approved | :376-383 | 无 QA 模板连 ship 语义都声明不了 |
| loop 只允许挂在 QA 节点 | :433-445 | 非三段式回环不可表达 |
| 种子清单硬编码 3 个 eng 文件 | :557 | 无非三段式种子 |

**(b) session 生命周期 8 面仍是三值硬编码**（= PRD §2.3b，行号按当前 main 核实）：

| # | 面 | 现状（核实位置） |
|---|---|---|
| 1 | ChatThreadRole 枚举 | 固定四值 + **未知 role 静默归一 main**（StateStore.ts:412, :425-428） |
| 2 | phase/active 查询 | IN ('design','implement','qa') 系列（StateStore.ts:2549 区段） |
| 3 | phase-thread 反查 | 未知 role 归一 main（同上文件反查区段） |
| 4 | issue 展示 + refresher | 从 THREE_STAGE_PHASE_SEQUENCE / PHASE_THREAD_BADGE 派生（issue-display.ts:16 起） |
| 5 | TURN recovery 优先级 | TURN_RECOVERY_PRIORITY = qa→implement→design 硬编码（phase-orchestrator.ts:182, :1946） |
| 6 | completion sinks | resolveCompletionSessionRole 双 sink 镜像（DirectEventSink.ts:715/:746/:1007；event-route.ts:1130/:1575） |
| 7 | ship 收尾 | post-ship-finalization 只关 parked design/implement（:258 起） |
| 8 | retry / 启动对账 | actions.ts 只读 chat_thread_role 重解 model；StateStore 启动重放只认三段式 |

`workflow_node_id` 承载字段**全仓不存在**（grep 零命中）。node-type registry **不存在**（packages/config 无此文件）。Blueprint 仍是 isDesignPhase/isImplementPhase/isQaPhase 三分支 + 默认 implement 提示词兜底（Blueprint.ts:1024-1136 + :1031 兜底）。

**(c) 关键不对称**：claims/admission 层（A+B）**已经是 node-id 泛化的**——workflow_run_node、execution_binding、submission_credential 全按 (run,node,execution,attempt) 键控，node_id 是自由字符串。钉死的只是 **session 生命周期层**。C 的本质 = 把 session 层拉齐到 claims 层已有的泛化程度。

## 3. 设计决策（D1-D8）

### D1. schema 泛化形态：manifest schema_version 2，v1 继续原样接受

v2 = v1 的严格超集语言：新增节点类型 generic（agent_file 必填、仅 generic 允许）与 review（发 design_review_approved 声明，跨厂商不变量与 QA 同规）；允许无 QA 节点的链（受 D2 不变量约束）；边条件词汇扩 {node_done, review_pass}；ship_claims 允许 {qa_passed, design_review_approved, founder_approved} 组合（founder_approved 永远必填）；loop_when 扩 review_fail（四要素要求不变）。**保持线性链约束**（每节点恰 1 条出边）——本单不开分支图。v1 校验路径字节不变（既有 3 个 eng 种子与其测试逐字节过）。

### D2. 「QA=一等节点」的泛化不变量：capability 驱动，不是全称规则

Annie 输入 3（QA 一等、不许单 session 自测收尾）泛化为：**模板含任何「产码」节点（type=implement，或 capability 含 shared_branch_writer/creates_pr）⇒ 必须含恰 1 个独立 QA 节点 + qa_passed ship claim（校验器 reject 否则）**。纯 no-code 模板（全节点 generic/review/design 且全 write-capability=false）才允许无 QA，admission 时写 qa_exempt 政策 claim（issuer_kind=bridge_policy、subject_kind=snapshot_digest 绑 run 快照——伞单 §2.1 已定义，B 已有 predicate）。code 模板永远不可能静默丢 QA。

### D3. node-id 生命周期 substrate：新增 workflow_node_id，与 legacy 并存解耦

- sessions 侧新增 workflow_node_id 承载（enrolled workflow 执行专用；legacy run 恒 NULL）；chat_thread_role 继续存在且语义不变。
- **fail-closed 规则**：enrolled 执行的 workflow_node_id 必须 ∈ 其 run snapshot 的节点集，任何消费点遇到未知/缺失 node-id → 显式拒绝/升级，**绝不归一 main**（normalizeChatThreadRole 对 legacy 行为字节不变——它只处理 legacy 列）。
- 8 面逐面改造为「enrolled ⇒ 按 node-id + capability 走新路径；非 enrolled ⇒ 逐字走旧路径」：枚举/查询/反查/展示+refresher/TURN recovery（enrolled 按 snapshot 拓扑逆序推导优先级，legacy 硬编码保留）/completion sinks/ship 收尾（关 parked 节点按 snapshot 全节点集）/retry+启动对账（enrolled 从 snapshot 读 node 定义重解 model，修 shareParentBranch 传播口径按伞单 §7）。
- 每面配 byte-compat sentinel（legacy 路径）+ fail-closed 负测（S14）。

### D4. node-type registry + Blueprint capability 门控

- 新 packages/config/src/node-type-registry.ts：id/model 缺省/skills/prompt key/badge/is_phase_role/preserve_completion_role/**capabilities**（shared_branch_writer · creates_pr · can_ship · can_land · approval_gate_holder · needs_review_evidence · needs_mailbox_transport · keepalive_park · qa_verdict_emitter · produces_output · completion_route · output_mode）。
- design/implement/qa 三条目与今天行为**逐字等价**（reverse-compat sentinel）；generic 条目保守默认全 write/ship=false、completion_route=no_code；review 条目 no-code + needs_review_evidence 发声明。
- Blueprint：enrolled 执行改读 capability 组装提示词（S13：全 write=false 的 generic **不**收到 branch/PR/approve/ship 指令、有明确 completion 命令）；非 enrolled 路径三分支逐字保留。**默认兜底提示词（:1031 implement 形）对 enrolled generic 是禁用路径**——未知组合 fail-closed 拒派发，不 fallback。
- 注册表全部职责迁移（sequence/nextPhase 的编排真相）**不在本单**——那是 D（PR-7）；本单只建 registry + capability 门控消费面，three-stage-phases.ts 继续是 legacy 路径的真相源。

### D5. generic output/completion 契约（伞单 §5-Q2 修正后的形态）

- 新表 workflow_node_outputs **按 (run_id, node_id, attempt) 键控**（伞单 R2#5 ②推翻 PRD 的 (run,node) upsert）：payload + output_digest + schema 校验；只有当前合法 attempt 的输出可被事务性「提升」为节点产出；旧 attempt 不能覆盖新的。
- 写入通道独立于 complete：新 flywheel-comm workflow-output 命令 → Bridge 专用 endpoint，受**绑 (run,node,execution,attempt) 的 capability 保护**（复用 B 的 submission_credential 机制、扩 output family——不新造凭证类型）。
- 顺序 = 先写产出成功 → 再 complete --route no_code；Bridge completion 前校验：produces_output 节点无对应 output → **fail-closed 不推进 handoff**（S15）。
- replay：outputs 为 run 级持久态，与 completion marker 解耦；Bridge 重启/marker replay 后下游仍可读（S16）。
- 严格 agent_file loader：容器检查同 readAgentFile（拒绝绝对/../symlink 逃逸），但 null → **拒 admission**，绝不 warn+fallback（S12）；snapshot 存**已读入的 agent.md 内容本体**（内容寻址，防 TOCTOU——伞单 §7/R4#4）。

### D6. per-Lead / per-category 模板选择（选择优先级四级解析）

- 新 resolveWorkflowTemplateSelection：**Lead per-run 显式指定/override → (project, task_category) 绑定 → project 默认（'*' 绑定，B 已有）→ 裸 session（不建 workflow run，走 legacy）**。任何一级命中后走 materializeWorkflowRun 复验整快照（含 D2 不变量、跨厂商、skip 合法性）。
- Lead 点菜必须带 reason（Annie 输入 2：判断理由可见）；reason 落 workflow_template_audit（action=select，新枚举值）+ 作为素材供 Lead 贴 issue thread；founder per-issue override 优先级最高（走同一 per-run override 通道，audit actor 区分）。
- task_category 来源 v1 = 派发调用显式参数（Lead 判断）；label→category 自动映射不在本单（D 或后续）。

### D7. 种子模板集（可选模板集的首批非三段式成员）

- **tpl_product_v1**：research(generic) → produce(generic, produces_output) → review(review, 跨厂商) → founder_gate；无 QA 节点（D2 合法：全 no-code）；ship_claims=[design_review_approved, founder_approved]；qa_exempt 由 admission 写。
- **tpl_research_light**：research(generic, produces_output) → founder_gate；最短链。
- **tpl_ops_light**：execute(generic) → founder_gate。
- 三个 eng 种子字节不动。种子导入沿用 B 的 content-hash 幂等（绝不 repoint founder 改过的模板）。
- **Bridge docs materializer（把 accepted produce output 物化成 docs 分支 head）不在本单**：C 交付 outputs substrate（产出可写、可读、可 replay）；materializer 是 product 模板真跑起来（D 启用）才被行使的路径，且自带 intent/commit/reconcile 状态机整套（伞单 R2#5 ③④），单列到 D/后续。product 种子在 D 前不可派发，无功能缺口。

### D8. flag 纪律与显式不做

- 新增 1 个 default-off flag：**workflow_generalized_templates**——门住 v2 manifest 的 import/publish/admission 接受面（OFF ⇒ v2 语法 reject，v1/legacy 字节不变）；与既有 workflow_claims_write/read/force_legacy 正交分立；enrollment 依旧显式标记。
- 不做：任意具名节点类型 · 任意 loop 边 · 非线性分支图 · node-inject/fork · UI（FLY-1038）· 高层编排（FLY-1043）· label→category 自动映射 · docs materializer（见 D7）· 注册表全职责迁移与 orchestrator 按 snapshot 解释（D=PR-7/8）。

## 4. 验收面（映射 plan §3.2 验收矩阵 + PRD S11-S16 的 PR-6 相关格）

- S11 agent.md frontmatter 派发路径全 inert（物理安全性质回归）· S12 严格 loader fail-closed · S13 generic capability 门控 · S14 未知 node-id fail-closed 不归一 main · S15 无 output 不许 complete · S16 outputs 与 marker 解耦 replay。
- 8 面逐面：legacy byte-compat sentinel + enrolled 新路径正测 + fail-closed 负测；TURN recovery 按 snapshot 拓扑推导正确性；双 sink + marker reconciler + finalizer + retry 全路径含 generic 节点用例。
- D2 不变量矩阵：code 模板缺 QA → reject；no-code 模板无 QA → qa_exempt claim 落账本；v1 种子逐字节回归。
- 选择优先级矩阵：四级逐级命中/穿透 + override 复验 + audit/reason 落库。
- 真机 E2E（实现阶段，先于任何 gate 呈报）：真 Bridge admission→materialization→workflow-output 写入→completion 校验链 + legacy 路径对照；FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1 前全真 fresh-spawn E2E（FLY-1232 评论 7b8255cf pin 继续有效）。

## 5. 开放问题（带推荐，交 brainstorm gate）

1. **materializer 归属**：C 只交 outputs substrate，Bridge docs materializer 归 D（推荐）还是单开 follow-up 子单？影响 D 的体量。
2. **review 节点类型进 v2**：product v1 的跨公司 review 需要 review 节点类型（发 design_review_approved）。进本单（推荐——否则 product 种子表达不出来，「泛化」名不副实）还是砍出去让 product 种子降级为 research 形短链？
3. **flag 形态**：新增 workflow_generalized_templates（推荐）vs 不新增、纯靠 typed enrollment + 既有三 flag。
