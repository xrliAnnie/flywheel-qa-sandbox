# FLY-1281 模板泛化到非三段式任务类别 — 调研

Issue: FLY-1281 (https://linear.app/geoforge3d/issue/FLY-1281/build-dag-模板引擎-子单c原-泛化模板泛化到非三段式任务类别per-leadper-category-模板选择)
日期: 2026-07-14
基于: exploration.md（brainstorm gate 已批：D1-D8 全批，Q1 materializer 归 D、Q2 review 节点类型进本单、Q3 新增 workflow_generalized_templates flag）

---

## A. 可复用基底盘点（A+B 已交付的机制，本单只扩不改语义）

### A.1 claims 词汇表（workflow-claims.ts）— **本单零 schema 改动**

- `WORKFLOW_CLAIM_PREDICATES` 闭集已含 `design_review_approved` 与 `qa_exempt`；workflow_claims 表的 predicate CHECK 同步（StateStore.ts:9155）。→ D2 的 qa_exempt 政策 claim 与 review 节点的 design_review_approved 声明**不需要动 claims DDL**。
- `WORKFLOW_DECISION_FAMILIES` 已含 `review_verdict: [codex_approved, design_review_approved]` 与 `qa_policy: [qa_exempt]`；`SYSTEM_CLAIM_ALLOWLIST.bridge_policy = [qa_exempt]`。→ review 节点的凭证 family 直接用既有 `review_verdict`；qa_exempt 走 bridge_policy 系统路径（B 已有）。
- `RUNNER_CAPABILITY_FAMILIES = [qa_verdict, review_verdict]`（workflow-claims.ts:56）——runner 可持凭证的 family 闭集。**generic 节点的 output 写入不是决策**（不发 claim），所以**不应扩这个闭集**；output 凭证是另一类（见 B.4）。

### A.2 submission credential（B）— 复用形态与一处硬约束

- `workflow_submission_credential`（StateStore.ts:9212）：hash-only、绑 (run,node,execution,attempt) 复合 FK 到 immutable `workflow_execution_binding`、短 TTL + absolute deadline、partial unique index 保证每 (run,node,attempt) 至多一张活票。
- **硬约束**：`family TEXT CHECK (family IN ('qa_verdict','review_verdict'))`——SQLite 改 CHECK 必须重建表；该表可能已在生产 teamlead.db 存在（boot 时 CREATE IF NOT EXISTS）。→ output 凭证**不扩这张表的 family**，另立轻量表（B.4，绕开重建迁移 + 语义上也更诚实：output 不是 decision）。
- `admitWorkflowExecution`（StateStore.ts:9799）fail-closed 预派发 admission：输入 (runId,nodeId,executionId,attempt,family,expiresAt,absoluteDeadlineAt)，产出一次性明文凭证（只回一次）。run-dispatcher 已有 `workflowClaimsAdmission` seam（run-dispatcher.ts:821,:974）把凭证送进 spawn env。

### A.3 模板层（B）

- 5 表：workflow_template（seed_owner + content-hash 幂等）/ _revision（manifest 字节不可变 + append-only 双 trigger + no_replace trigger）/ _publication（append-only + CAS 指针）/ **workflow_category_binding**（(project, task_category) PK，'*' 兜底行，getWorkflowCategoryBinding 已实现「精确命中优先、'*' 次之」）/ _audit。
- **audit.action CHECK 闭集 `('seed_import','publish','rebind','create','run_override')`**（StateStore.ts:2233）——D6 要新增 select 动作记录：改 CHECK 同样要重建表。**决策点**：见 B.5。
- `materializeWorkflowRun`（StateStore.ts:9652）：binding → published revision → applyWorkflowOverride → validateWorkflowManifest 复验 → snapshot 单事务钉住（含 manifest_digest）+ run_override 审计。**现状缺口**：入口只认 category binding，无 Lead 显式 templateId 参数、binding 缺失即 throw（无裸 session 语义出口）——D6 的解析器包在它外面。
- 校验器 workflow-template.ts 的三段式钉死点已在 exploration.md §2.2(a) 逐条列出（类型闭集 :19/:192、恰 1 QA :260、边条件闭集 :22/:284、type→出边条件唯一映射+恰 1 出边 :410-432、ship_claims 必含双 claim :376-383、loop 仅 QA 可挂 :433-445、种子清单硬编码 :557）。
- 种子导入：plugin.ts:3310 boot 时 `importBundledWorkflowSeeds(store)`，content-hash 幂等、绝不 repoint founder 改过的模板。

### A.4 三段式真相源与 8 面锚点（当前 main 核实）

- `packages/config/src/three-stage-phases.ts`（注意：在 **config 包**，非 teamlead）：THREE_STAGE_PHASE_SEQUENCE / isThreeStagePhaseRole / **resolveCompletionSessionRole**（双 sink 消费）/ nextPhase / DEFAULT_PHASE_DISPATCH + resolvePhaseDispatch（FLY-1224 档位 + 两个 kill-switch env）/ PHASE_THREAD_BADGE(+PARTS) / phaseMessageTag。**本单不迁移其职责**（D=PR-7），只在旁边建 registry 并让 enrolled 路径消费。
- sessions 表（StateStore.ts:1112）：`chat_thread_role TEXT NOT NULL DEFAULT 'main'` 在列尾；**无 workflow_node_id**。仓内已有幂等 `ALTER TABLE ADD COLUMN` 先例（FLY-267 journal reply_channel_id 模式）→ 加 nullable 列低风险。
- `normalizeChatThreadRole`（StateStore.ts:425-428）：未知 → 'main'（静默归一陷阱本体）。
- 8 面消费锚点：phase/active 查询（StateStore.ts:2549 区段 IN 三值）· 反查归一（:4137 区段）· issue-display.ts:16 起 + issue-display-refresher.ts（THREE_STAGE_PHASE_SEQUENCE 渲染）· TURN_RECOVERY_PRIORITY（phase-orchestrator.ts:182 + 候选过滤 :1946）· completion sinks（DirectEventSink.ts:715/:746/:1007；event-route.ts:1130/:1575 全走 resolveCompletionSessionRole）· post-ship-finalization.ts:258 起只关 parked design/implement · retry（actions.ts 读 chat_thread_role 重解 model）+ 启动对账（StateStore 重放 stranded 三段式）。
- Blueprint.ts：isDesignPhase/isImplementPhase/isQaPhase 三分支（:1024-:1136）；**其余一切拿默认 implement 形提示词**（:1031 兜底——S13 的反面）；readAgentFile 容器检查（:1971-:1998）可复用但 null→warn+fallback（:1624，S12 的反面）。

### A.5 跨厂商与 flags

- `review-family.ts`（config，B 落）：`adapterTypeToFamily`（sessions.adapter_type→family，FLY-493 后 antigravity/kimi 各自成 family）+ `manifestReviewFamilyOk`（admission 用**已解析** family，manifest vendor 永远不是 review 权威）。→ review 节点类型的 admission 校验直接复用；注意 family 集合**不止 claude/codex**。
- feature-flags registry（config/feature-flags/registry.ts:2135 起）：workflow_claims_write / workflow_claims_read / workflow_force_legacy 三条目模式（name/description/touchpoints）——新 flag 照格式加条目 + feature-flags-drift 测试会强制登记。
- 决策提交面：workflow-decision-routes.ts 为 express Router（/head-authority /decision /re-qa*），workflow-template-routes.ts 同模式——**workflow-output 端点加在 decision routes 同款骨架**，沿用其 auth/loopback 姿态。

## B. 各交付面的落点设计输入

### B.1 manifest schema v2（D1+D2，workflow-template.ts 内扩展）

- v2 精确增量：节点类型 +`generic`（`agent_file` 必填且仅 generic 允许；gate 同款「不许带 vendor/model/effort」约束不适用——generic 可带 vendor/model 意图，capability 永远来自 registry）+`review`（no-code，发 design_review_approved）；边条件 +`node_done`（generic 出边）、+`review_pass`（review 出边）；ship_claims 词汇 +`design_review_approved`，规则改为「founder_approved 永必填；含 QA 节点 ⇒ 必含 qa_passed；含 review 节点 ⇒ 必含 design_review_approved」；loop_when +`review_fail`（四要素不变，仅允许挂在 review 节点、回到其上游 producer）；**「恰 1 QA」改为 D2 不变量**：∃ 节点 type=implement（或未来任何 registry capability 含 shared_branch_writer/creates_pr 的类型）⇒ 恰 1 个 QA 节点 + qa_passed；全 no-code ⇒ 允许 0 QA。线性链约束（每非终点节点恰 1 出边 + type→条件唯一映射扩到新类型）保留。
- **v1 语义字节不变的实现姿态**：validateWorkflowManifest 按 `schema_version` 分派——version 1 走现函数原文（不动一行），version 2 走新校验路径（共享底层 helper）。既有 3 个 eng 种子与全部 v1 测试逐字节回归。
- flag 接线（D8/Q3）：`workflow_generalized_templates` OFF ⇒ schema_version 2 在 import（loadBundledWorkflowSeeds 过滤 v2 种子文件）/ publish（template-routes 拒收 v2 manifest）/ admission（materializeWorkflowRun 拒 v2 revision）三个面 reject；ON 才接受。OFF 状态全链路 = 今天字节。

### B.2 node-id 生命周期 substrate（D3，8 面）

- 承载：sessions 幂等 ADD COLUMN `workflow_node_id TEXT`（nullable；legacy/非 enrolled 恒 NULL）。写入点 = run-dispatcher 派发 enrolled 执行时（与 workflow_execution_binding 同一批信息，来源一致）。
- 判别一律走 **typed enrollment**（workflow_run.claims_read_enrolled / execution binding 存在），绝不由 workflow_node_id 非空反推 enrolled（标签≠事实——FLY-1204 教训直接适用）。
- 每面改造模式：`if (enrolled(run/execution)) { node-id+snapshot+capability 新路径, 未知/缺失 → fail-closed 显式拒绝/升级 } else { 旧路径逐字 }`。normalizeChatThreadRole 本体不改（只服务 legacy 列）；新增平行的 `resolveWorkflowNodeId(session, snapshot)`：workflow_node_id ∉ snapshot.nodes → throw/拒，绝不归一。
- TURN recovery（面 5）：enrolled run 的优先级 = snapshot 拓扑逆序（终点侧优先，即今天 qa→implement→design 的泛化）；由 snapshot edges 派生，不新增配置。
- ship 收尾（面 7）：enrolled run 关 parked 节点按 snapshot 全节点集（排除已终态），legacy 只关 design/implement 不变。
- retry/启动对账（面 8）：enrolled 从 snapshot 节点定义重解 vendor/model/effort（B 的 snapshot 已含），不读 live 模板；shareParentBranch 传播口径按伞单 §7 copy-forward（本单只覆盖 enrolled 分支的传播正确性测试，legacy FLY-840 缺口不在本单修）。

### B.3 node-type registry + Blueprint capability 门控（D4）

- 新 `packages/config/src/node-type-registry.ts`：五条目 design/implement/qa/gate/generic + review。capability 字段集（PRD §4.2 + §5.6）：shared_branch_writer / creates_pr / can_ship / can_land / approval_gate_holder / needs_review_evidence / needs_mailbox_transport / keepalive_park / qa_verdict_emitter / produces_output / completion_route / output_mode。三段式三条目取值 = 今天行为的显式化（implement: shared_branch_writer+creates_pr true…），并配 reverse-compat sentinel（断言 registry 条目推导出的行为面与 three-stage-phases.ts 现值一致，防两真相源漂移——**本单期间 registry 是「影子真相」，legacy 路径不消费它**）。
- Blueprint：enrolled 执行按 (snapshot 节点 type → registry capability) 组装提示词；generic 全 write=false ⇒ 无 branch/PR/approve/ship 段、有明确 completion 指令（flywheel-comm workflow-output → complete --route no_code）；**未知 type/capability 组合 ⇒ 拒派发 fail-closed（绝不落 :1031 兜底）**。ctx 上需新增 enrolled 判别 + snapshot 节点引用的传递（BlueprintContext 扩字段，非 enrolled 不设 → 旧路径字节不变）。

### B.4 generic output/completion 契约（D5）

- 新表 `workflow_node_outputs`：(run_id, node_id, attempt) PK + payload JSON + output_digest + schema_version + written_at + promoted INTEGER（当前合法 attempt 事务性提升位）+ execution_id（审计）。append-only 风格：同 key 重写仅限同 execution 幂等（digest 相同 → 幂等成功；不同 → 拒），旧 attempt 永不覆盖新 attempt 的 promoted 位。
- **output 凭证 = 新轻量表 `workflow_output_credential`**（同 submission_credential 形态：hash-only、绑 (run,node,execution,attempt) FK execution_binding、TTL、单活票 partial index），**不**扩 submission_credential 的 family CHECK（免重建迁移；output 不是 decision，语义分开也防止 output 票被误用于 verdict 提交面）。admission 时与 decision 凭证同批签发（produces_output 节点才发）。
- 写入链：`flywheel-comm workflow-output --payload-file` → Bridge decision-routes 同骨架新端点 → 验票（有效×未过期×未核销×绑定匹配）→ schema/size 校验 → 单事务写 outputs + 核销 → 幂等重放同 E3 语义。
- completion 校验：Bridge 侧 completion 处理（双 sink + marker reconciler 三处镜像——complete.ts 路由词汇**不动**，仍走 no_code）对 enrolled produces_output 节点检查 promoted output 存在，缺 → fail-closed 不推进 handoff（S15）；outputs 为持久态、与 marker 解耦（S16 重启 replay 测试）。
- 严格 agent_file loader：复用 Blueprint 容器检查逻辑抽出的共享 helper（拒绝绝对/../symlink 逃逸），null → **admission 拒绝**（S12）；agent.md 内容本体（40k 截断沿用）进 snapshot（内容寻址，TOCTOU 免疫）——materializeWorkflowRun 在校验 v2 manifest 时同事务读入。

### B.5 选择解析 + audit（D6）

- 新 `resolveWorkflowTemplateSelection(store, {project, taskCategory?, leadTemplateId?, leadReason?, founderOverride?})`：四级 = Lead 显式 templateId（必带 reason，缺 → 拒）→ (project, taskCategory) 绑定 → '*' 默认绑定 → null（裸 session，调用方走 legacy 不建 run）。命中后进 materializeWorkflowRun 全量复验（D2 不变量在 validate 内、跨厂商在 admission 层）。
- audit 记录 select：**避开 audit.action CHECK 重建迁移**——复用既有 action='run_override' 不诚实、改 CHECK 要重建 append-only 表。两案：(a) 重建迁移（preflight + 复制行，B 有 scoped preflight 先例）加 'select'；(b) select 事实写进 workflow_run 侧（新列 selected_by / selection_reason / selection_source ∈ {lead, binding, default, founder_override}——run 建行时一次写入，天然不可变）。**推荐 (b)**：选择是 run 的出生事实，放 run 行比 audit 流水更贴（Dashboard 直读），且零迁移风险；audit 表留给模板管理动作。plan 里定稿。

### B.6 种子（D7）

- tpl_product_v1：research(generic) → produce(generic, produces_output) → review(review) → founder_gate；ship_claims=[design_review_approved, founder_approved]；review_fail 回 produce 的 loop（max 3 / escalate）。tpl_research_light：research(generic, produces_output) → founder_gate。tpl_ops_light：execute(generic) → founder_gate。三个都 schema_version 2、无 QA（D2 合法：全 no-code）。
- BUNDLED_SEED_FILES 扩清单；flag OFF 时 v2 种子跳过导入（不落库、不报错、log 一行）——OFF 世界连表内容都与今天一致。

## C. 迁移与兼容风险清单

| # | 风险 | 处置 |
|---|---|---|
| 1 | submission_credential.family CHECK 钉死 → 扩 family 要重建表 | 规避：output 凭证独立新表（B.4） |
| 2 | template_audit.action CHECK 钉死 + append-only trigger | 规避：selection 事实写 workflow_run 新列（B.5 案 b） |
| 3 | sessions 加列 | 幂等 ADD COLUMN（FLY-267 先例），nullable 零回填 |
| 4 | v1 校验语义漂移 | version 分派、v1 函数原文不动、3 种子 + 全 v1 测试字节回归 |
| 5 | Blueprint 触生产提示词主路径 | enrolled 判别包住全部新分支；非 enrolled 零 diff 断言（快照测试） |
| 6 | 8 面改造面大、双 sink 镜像易漏 | 每面 byte-compat sentinel + enrolled 正/负测成对交付；双 sink+reconciler 三处同测 |
| 7 | flag OFF 世界纯净性 | OFF sentinel：v2 种子不导入、v2 publish/admission 拒、Blueprint/8 面新分支不可达 |
| 8 | 生产 teamlead.db 已有 B 的表 | 全部新 DDL 走 CREATE IF NOT EXISTS / ADD COLUMN 幂等；无一处改既有表的列或 CHECK |

## D. 验收映射（plan 的测试矩阵骨架）

- S11(frontmatter inert 回归) · S12(严格 loader) · S13(capability 门控) · S14(未知 node-id fail-closed) · S15(output-present 校验) · S16(outputs 与 marker 解耦 replay)。
- D2 不变量单独成组（Tadashi 硬线）：code 模板缺 QA→reject；no-code 无 QA→admission 写 qa_exempt(bridge_policy/snapshot_digest)；v2 含 implement 无 QA 负测；eng 三种子 v1 字节回归。
- 8 面 ×（legacy byte-compat + enrolled 正测 + fail-closed 负测）；TURN recovery 拓扑逆序推导；retry/启动对账 enrolled 读 snapshot。
- 选择四级逐级命中/穿透矩阵 + reason 必填负测 + selection 事实落 run 行。
- flag 三面 OFF/ON 矩阵；真机 E2E（实现期）：真 Bridge 上 admission→materialize(v2)→spawn env 凭证→workflow-output 写入→completion 校验→replay 全链 + legacy 对照；7b8255cf fresh-spawn pin 复述进 plan 部署清单。
