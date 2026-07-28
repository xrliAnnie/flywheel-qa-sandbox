# FLY-1498 门与派发模型 — 调研

Issue: FLY-1498 (https://linear.app/geoforge3d/issue/FLY-1498/v2批次2-门与派发模型-节点自带完成合同-ship-只验通用三条-派发器只认-dag)
日期: 2026-07-27
基于: exploration.md(同文件夹)

> 方法:两路 very-thorough 代码摸底(①ship 门/评审记录/QA verdict;②派发器/三段式/DAG 模板/v2-kernel),关键锚点(verify-approval hard gate、gates/task_dependencies DDL)已本人抽查核对原文。本文是 file:line 证据台账,供设计节与 Codex 评审引用。

## 1. 挡住 FLY-1497 的确切判定(病灶一号)

`packages/flywheel-comm/src/commands/verify-approval.ts:589-601`(代码注释编号 5,FLY-827 hard gate):

```ts
const codexGateOn = resolveCodexHardGateOn({...});
if (codexGateOn && !row.codex_skip && !codexApprovedForHead) {
    return notApproved("codex_review_not_approved", {...});
}
```

- `codexApprovedForHead` 的取值(`:386-441`):issue-scoped 查询 `codex_review_record` — `WHERE project_name=? AND issue_id=? AND target_repo_identity='__main__' AND lower(target_pr_head_sha)=? AND status IN ('approved','skipped')`,再对每条候选用 **author session 的 adapter** 跑 `crossFamilyReviewSatisfied`(`packages/config/src/review-family.ts:71`)。
- **触发条件与「会话做了什么」完全无关**:只看当前 head 上有无跨族 record。FLY-1497 的 QA 会话(只加测试)推了 commit → head 变 → 新 head 无 record → 拒。
- 结构性死锁:qa-role 会话的 codex verdict **无法被记录** — `auto-qa-coordinator.ts:969` `!isReviewableRole(session_role)` 直接丢弃(`isReviewableRole = main||implement`,`codex-gate.ts:50-53`)。想补评审都没有入口。
- codex 门**零内容分支**:无 docs-only/test-only/规模豁免。仅 3 个 bypass:①`FLYWHEEL_CODEX_HARD_GATE=0`(env kill-switch,key-absent=ON);②Linear label `codex-skip`(head-independent);③`codex_review_record.status='skipped'`(head-bound)。

## 2. verify-approval 完整检查清单(执行顺,全 fail-closed)

`packages/flywheel-comm/src/commands/verify-approval.ts`,reason 枚举 `:83-104`:

| 行号 | 检查 | 失败 reason |
|---|---|---|
| `:137-272` | (flag-gated)Bridge head-authority 比对 | `head_authority_*` / `review_question_unbound` |
| `:339-342` | `--pr-head` 40-hex 全 sha | `invalid_pr_head_format` |
| `:348-381` | StateStore 可读 + session 行存在 | `state_db_unreadable` / `session_not_found` |
| `:463-465` | `review_question_id` 存在且非 "unbound";**绝不回退到最新 question** | `review_question_unbound` |
| `:474-493` | question 存在 + `type==="question"` + `checkpoint==="approve_to_ship"` + `from_agent===execId` + 未 supersede + 有 response | `review_question_missing/invalid` / `gate_superseded` / `gate_not_answered` |
| `:509-524` | response 是结构化 JSON 且 `approved===true`(纯文本无效) | `response_not_structured_approval` / `response_not_approved` |
| `:537-557` | founder attribution(response.from_agent ∈ founder id/bridge/bridge-founder-consent) | `response_not_founder_attributed` |
| `:560-583` | `status==="approved_to_ship"` + `pr_head_sha` 非空 + `=== --pr-head` | `status_not_approved_to_ship` / `pr_head_sha_missing/mismatch` |
| `:589-601` | **codex hard gate(§1)** | `codex_review_not_approved` |
| `:606-634` | CI 独立轴:`probeShipCiGreen` 现场重探(开门时 green 不可复用) | `ci_not_green` |

注意:verify-approval 里**没有** QA verdict 检查;QA 是外层 `evaluateShipEligibility`(`packages/flywheel-comm/src/ship-eligibility.ts:389`)的 A 轴,与 merge approval B 轴(=verifyApproval 复用)kill-switch 互相独立。

## 3. QA verdict 两条互斥路径

`ship-eligibility.ts:267` `evaluateQaShipGate()`:

- **durable QA(三段式/engine)**:判别式 `:295-296` `session_role==="qa" && chat_thread_role==="qa"` → 必须 `FLYWHEEL_WORKFLOW_CLAIMS_READ=1` → `resolveEnrolledQaClaim()`(`:150`)SQL 里 **`AND b.node_id = 'qa'` 字面量**(`:170`),要求 workflow_claims:`decision_kind='qa_verdict'`、`subject_kind='git_head'`、`subject_digest=head`、`predicate="qa_passed"`、未 revoke 未过期。
- **legacy auto-QA**:读快照 `sessions.qa_required`(=1 须 `auto_qa_record` status='passed' 绑 head;=0 豁免;NULL 仅 `decision_route ∈ {no_code, pr_handoff}` 或无 PR 才豁免,否则 fail-closed)。
- 两套证据表(workflow_claims vs auto_qa_record)完全不互通。
- verdict 产生:`qa-result.ts:144`(有 workflow credential → POST /api/workflow/decision;否则 legacy /events);engine-owned execution 走 legacy 端点 → **HTTP 409 workflow_submission_required**(`event-route.ts:997-1004`)。
- 路由分流按节点名:`event-route.ts:1041-1044` 同判别式 → PhaseOrchestrator vs AutoQaCoordinator。
- 顺序陷阱:codex 门在 QA 之前(`auto-qa-coordinator.ts:503`)——codex 未过连 QA 都不 spawn。

## 4. approve_to_ship 开门前置强制点

| 位置 | 前置 | 硬度 |
|---|---|---|
| `flywheel-comm/src/commands/gate.ts:81-86` | approve_to_ship → 先 `probeShipCiGreen()`,不 green 直接 throw(刻意放 fail-open catch 外) | 硬 |
| `gate.ts:235-240` | 回答仅 `approved===true` 算 approved | 硬 |
| `respond.ts:28` | `GATED_CHECKPOINTS={approve_to_ship}`:Lead 不能直 respond,必须走 Bridge founder-consent | 硬 |
| `question-admission.ts:204-209` | 有 `reviewHoldReason` → `revoked_qa_hold`,gate 不呈现 | 硬 |
| `gate-poller.ts:973-985` | relay 前刷 docs-only 分类 + hold 检查(不 evict,question 留给 verify-approval 绑定) | 硬 |
| `actions.ts:209/240/281/290-336` | approveExecution:须 awaiting_review + bound question + holdReason 拦截 | 硬 |
| `auto-qa-held.ts:205` | founderApprovalHoldGuard:所有 founder approval 写入通道共享 pre-write 守卫 | 硬 |
| `Blueprint.ts:1521/2243` | prompt 层 CI PRECONDITION + codex review REQUIRED | 软 |
| `land-executor.ts:92-164` | authorizeLandOperation:legacy=computeAuthoritativeShipDecision;engine=gate holder approved + head 匹配 + PR binding + `__main__` + resolveEngineWorkflowShipClaims | 硬 |

## 5. 按节点名/role 硬编码台账(选摘;全库 114 处字面量比较)

| # | 位置 | 判定 | 后果 |
|---|---|---|---|
| 1 | `codex-gate.ts:50-53` | `isReviewableRole = main\|\|implement` | 评审门/founder hold/verdict 录入总开关;qa/design 不进 |
| 2 | `auto-qa-held.ts:138/140/163/220` | role 三分支 | 只 main 吃 docs-only 豁免;implement 保留 codex-only;qa 永不 hold |
| 3 | `auto-qa-coordinator.ts:423/441/471/969` | main-only spawn;issue title `/^\s*QA\s*·/` 判 QA 单 | 唯一一处按 issue 语义判 QA 性质 |
| 4 | `ship-eligibility.ts:170/295-296` | SQL `node_id='qa'` 字面量;durable 判别式 | 证据路径二分 |
| 5 | `three-stage-phases.ts:248-252` | `nextPhase()` 线性推进 | **派发器认识三段式的心脏①** |
| 6 | `phase-orchestrator.ts:580-583` | `HANDOFF_STATUS={design:"design_done", implement:"awaiting_review"}` | **心脏②:节点名→完成状态硬表** |
| 7 | `phase-orchestrator.ts:632/1104-1174/1195/2003-2058` | role 特判遍布推进器(2359 行) | qa 特判/implement 证据特判/线性 nextPhase |
| 8 | `three-stage-policy.ts:278-320` | 只有 `requestRole==="main"` 能进三段式,进入即改写 role="design" | 入口特权 |
| 9 | `workflow-template.ts:449/650-659` (v1) `:1060-1078` (v2) | 恰一 QA 节点;qa 须恰一 qa_fail/qa_pass loop;**code-writing 节点存在⇒必须恰一独立 QA** | manifest 校验层三段式特权 |
| 10 | `workflow-template.ts:636-645/1116-1131` | 出边条件按 type 硬映射(design→design_done 等) | 边词表绑节点名 |
| 11 | `workflow-decision-routes.ts:244-253/491-492/973` | 按 node **id** 字面量 "qa" | 最脆一类 |
| 12 | `event-route.ts:1041-1044/1400-1440` | qa_result 分流;route 白名单+running-only | 按 role/route 名 |
| 13 | `complete.ts:148-178/228-250` | route 专属约束(no_code/pr_handoff/phase_design_complete) | 按 route 名 |
| 14 | `stage.ts:151/163/218/260` | implement 专属 ux-signoff;design_review 专属 --plan | 按 stage 名 |
| 15 | `lifecycle-closeout.ts:349/1245` | `role==="qa" && qaStatus!=="passed"` → terminate | Done 门按 role |
| 16 | `codex-instruction.ts:21-25` | stage 名→review type(design_review→design;pr_created→code) | 触发评审按 stage 名 |
| 17 | `workflow-dispatch-resolution.ts:50-65` | schema-v1 + type∈{design,implement,qa} → 回落 resolvePhaseDispatch | DAG 引擎回落三段式配置的桥 |

按「改动内容」分支的全库只有 2 处,均不触碰 codex 门:
- `ship-relevant-diff.ts:167` `classifyShipRelevantDiff`:>50 文件=ship_relevant;所有路径命中 DOCS_PREFIXES(doc/, docs/, engineering/doc/, product/doc/, content/doc/, marketing/doc/)才算 docs-only;只喂 `auto-qa-held.ts` 的 qa_evidence 判定;豁免是 10s 短租约 + 60s 快照过期。
- `auto-qa-policy.ts:38`:label/config 决定 qa_required 快照。

## 6. 声明式半成品(设计的现实锚点)

- `packages/config/src/node-type-registry.ts:17-32`:`WorkflowNodeCapabilities` 12 字段(`shared_branch_writer/creates_pr/can_ship/can_land/can_request_ship_approval?/approval_gate_holder/needs_review_evidence/needs_mailbox_transport/keepalive_park/qa_verdict_emitter/produces_output/completion_route/output_mode`)——「节点声明合同」雏形;`:151-154` `nodeTypeWritesCode = shared_branch_writer || creates_pr`。
- `workflow-run-snapshot.ts:95` `resolveWorkflowDecisionContract`:注释 "Resolve a decision node from its pinned verdict pair, **never its node type or id**";`:139` `resolveWorkflowGateAuthority`:"Node ids and template ids are intentionally irrelevant";`:150-172` gate-carrier 判定纯 capability 组合。
- `manifest.ship_claims` 词表:v1 `qa_passed|founder_approved`(`workflow-template.ts:93`);v2 +`design_review_approved`(`:119`);**缺 code_review_approved** → codex 门只能留在 legacy role 硬编码侧。
- `workflow-template.ts:55-85`:manifest node/edge/loop 结构;loop 四要素 `loop_when/exit_when/max_iterations/on_limit`(FLY-1135 裁定:回边=一等构件;精确命名=「结构静态、路径动态」的带声明式回边的有向图,非严格 DAG)。
- 模板=数据已成立:12 个 YAML 种子(`workflow-template.ts:1330-1344`),三段式=`tpl_eng_heavy_land_v1.yaml`(design→implement→qa→founder_gate→land + qa_retry/founder_feedback 两条回边);单节点=`tpl_generic.yaml`。运行时 12 张 workflow_* 表(teamlead.db 权威、YAML 仅种子;admission 时选版 → 物化 snapshot → run 期只读)。
- 派发入口:`runs-route.ts:2175-2220` `pipeline.dag===true` + flags → DAG 入口(candidate 缺失 409 fail-loud);`:2235-2296` 否则三段式入口。

## 7. v2-kernel 现状(FLY-1497,commit 6caa082d,零接线)

- 包 `packages/v2-kernel/`(1352 行);17 表=0001 十四表+0003 两表(activations/processing_attempts)+schema_migrations。
- **tasks 表无任何 node/phase 字段**(id/project_id/external_issue_id/kind/state 7 值 CHECK/state_version/priority/payload/rework_of/lineage_root_id/created_at/terminal_at)——DAG 形状完全由 task_dependencies 表达,schema 层已 DAG-agnostic。
- `task_dependencies(task_id FK, blocked_by_task_id FK, condition TEXT, created_at, PK(task_id,blocked_by), CHECK(task_id<>blocked_by))`——**condition 无枚举约束、无禁环触发器**(对比 command_dependencies 两者都有)。已抽查原文核对(0001:23-31)。
- `gates(id, task_id FK, attempt_generation NULL, kind TEXT NOT NULL 无CHECK, subject_digest, state CHECK('open','approved','rejected','expired') DEFAULT 'open', opened_at, resolved_at, resolver_capability_id FK)`——无索引无 partial unique;D4:扩展走表重建(0002 已示范)。已抽查原文核对(0001:116-126)。
- attempts:`UNIQUE(task_id,generation)` + partial unique 每 task 至多一 active + `terminal_reason CHECK('completed','failed','canceled','superseded')` + `CHECK((desired_state='terminal')=(terminal_reason IS NOT NULL))`。
- commands:8 态 + result_code 6 值 + `effect_key UNIQUE`(幂等键)+ claim 三列。
- events:append-only 触发器禁 UPDATE(DELETE 留给归档)。
- 写路径 API:`Kernel.write(label, fn)` BEGIN IMMEDIATE、拒嵌套/async/thenable、事务预算 1s、`tx.cas(sql,params,expected=1)` changes≠expected→CasViolation 整体回滚、`tx.requireIdentity(registryKey, expected)` 同事务读 meta registry 全字段比较→FenceViolation 整体回滚;FENCE 谓词模板族 4 条(mailbox/processing_attempt/activation/attempt 的状态谓词 CAS)。连接工厂唯一 PRAGMA 落点;migrator 每迁移一事务+checksum;backup=Online Backup API+完整校验。
- 明确不在 FLY-1497(plan §10):消费循环/dispatcher/探针/告警事务/垫片/风暴/切换/HTTP API——**kernel 零业务写,批次 2+ 全部写路径必须经 Kernel.write**。

## 8. complete --route 与 FSM 分支

- 6 route(`auto_approve/needs_review/blocked/no_code/pr_handoff/phase_design_complete`)三处枚举必须一致(complete.ts:42-50 / event-route.ts:1400-1411 / complete-marker-reconciler);DecisionRoute 5 值(无 no_code);`WorkflowCompletionRoute` 3 值(node-type-registry:10-13)。
- `phase_design_complete` → 状态 `design_done`(非终态)→ PhaseOrchestrator.nextPhase;须 git-proven founder design HTML 证据;DirectEventSink 结构性拒载(须 HTTP/marker 路径)。
- `pr_handoff` = no-transport runner 终态(completed+ready_to_merge,founder 手动 ship);`no_code` 拒 --pr/--merged。
- WorkflowFSM `session_completed` 按 `decision_route` 分支(workflow-fsm.ts:215-231)。

## 9. 三段式特权假设(A-K,设计须逐条化解或显式保留)

A. implement 与 main 同权(都被 codex 门管);qa=VERIFIER never held;design 不到 awaiting_review(`codex-gate.ts:43-53`)。
B. QA phase 同时是 ship-gate holder 和 ship executor(`phase-orchestrator.ts:1183-1187`)——qa-role 会话跑 verify-approval,但 codex record 是 implement 写的。
C. codex record issue-scoped(FLY-1434 §10)让 QA 复用 implement 的 record,但严格绑 head → QA 一推 commit 就断链 = FLY-1497。
D. phase_design_complete 无 PR 不进评审门;design_html 证据独立。
E. HANDOFF_STATUS 只给 design/implement;qa 无 handoff("qa is last")。
F. durable QA claim 准入=role 判别式+SQL node_id='qa' 字面量。
G. 三段式 QA 的 qa_result 绕过 auto-QA 守卫(判别式=durable chat_thread_role)。
H. implement→QA handoff 需 runner-driven review evidence(review_question_id 非 unbound)。
I. cross-family 规则由 phase 表隐含(design=claude→codex 审;implement=codex→claude 审)——"表改了 lane 自动翻转"。
J. QA fail 的 fix-loop 假设 implement 还活着(parked 同 branch)。
K. 非 PASS 的 QA node 一律 terminate,不许伪造 completed。

## 10. brainstorm gate 裁定(Tadashi,2026-07-27,原文要点)

1. **(a) 三档粒度【够】**(product_code/test/docs)。两条硬要求:①混合 diff(同时含 product+test/docs)必须落最严档 product_code,写成确定性规则;②founder 原话『we do not necessarily need codex code review for qa code』⇒ **test-only 免跨族代码评审**;若要设新的「测试评审」义务必须答清哪个场景需要+什么形态,答不出就归免(与 docs 同)或进可砍列表。
2. **(b)【确认】回边=同 task 新 attempt**(processing_attempts/pa_one_running/B2/B3 模型),不开新节点。
3. **(c)【确认】落点=§1.5 重写+新增派发与完成合同节**;design-FINAL-v2.md 是活权威,修订入 design-chain 留痕。
4. 纪律①:设计节内 recite founder 三句原话逐条对照机制:『codex code review is a hard gate for implement session, not really a ship gate』『the ship gate need to be very generic』『not design this for a specific scenario』。
5. 纪律②:「CI 红=merge 执行机世界性约束而非流程门」保持现有行为不变(红了照样合不进,只是不建模为门),设计节里明确防误读。

## 11. 设计约束输入(从证据推出的硬结论)

1. 病根是双重的:①门条件按节点名分支(114 处);②评审证据的**记录入口**也按节点名闸(qa-role verdict 被丢弃)——新模型必须同时修「谁欠什么」与「谁能交什么」。
2. ship 三条通用项要充分,必须解决 FLY-1497 的暴露面:节点完成后再推 commit 会产生「无人认领的 diff」。v1 用「head 漂移→重跑全套评审」硬兜;v2 的正解是把 diff 归属到节点:每节点完成记录 (base,head) 跨度,kernel 校验链条连续。
3. 落点已有空槽:task_dependencies.condition(语义待定)、gates.kind(词表待定)、tasks.payload(合同声明可载)。不需要新表(除非 research 中发现证据模型装不进 events/gates——初步判断装得进:证据=events 行,合同满足=完成事件 payload,founder 批准=gates 行)。
4. capability registry + snapshot 物化(admission 选版→run 只读)是已验证的「合同=数据」范式,v2 设计沿用其精神,但 v2 的合同落 kernel 表(tasks/task_dependencies),不落 teamlead.db。
5. 回边≠图结构:v2 里循环=同 task 新 attempt(B2/B3),max_iterations 等循环参数是 task/DAG 数据,不是新节点——与 FLY-1135「结构静态路径动态」一致。
6. 三处枚举漂移(route 6 值/DecisionRoute 5 值/CompletionRoute 3 值)是 v1 的教训:v2 词表必须单点定义(kernel CHECK 约束)。
