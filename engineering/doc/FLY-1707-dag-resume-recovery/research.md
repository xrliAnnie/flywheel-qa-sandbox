# FLY-1707 DAG 断点继续与恢复 epic — 调研

Issue: FLY-1707 (https://linear.app/geoforge3d/issue/FLY-1707/epic-重跑与恢复dag-断点继续fly-1699-prd-已定稿-建设)
日期: 2026-08-15
基于: exploration.md

本文是对当前分支(`flywheel-FLY-1707`,HEAD `523b7fb2d`,= 最新 main + 1 个 progress commit)的代码事实审计。所有行号以本分支为准(PRD 里的行号已漂移,本文全部重核过)。审计方式:4 个并行只读代码审计 + 1 个在飞 PR(#845/#846)plan 对账。

---

## 1. 进场路径现状(Ch.1 的改造对象)

### 1.1 起点是模板头的纯函数
- `workflow-template-selection.ts:380-390`:入度 0 节点唯一起点(不唯一 throw),`:416` 写死 `startReservation.nodeId = starts[0].id`,attempt 恒为 1。
- 同款 in-degree 计算另有 4 处(`workflow-template.ts:692-697,1304-1309`;`StateStore.ts:23895-23902,27206-27221`)。
- **admission 侧同样写死**:`workflowAdmissionReservationBlocker`(`StateStore.ts:23637-23672`)—— 首个 admission 必须是唯一起点节点 + attempt 1,否则 `not_start_node`。

### 1.2 recoverWorkflowStartSelection 是 candidate-free 的同 run 恢复
`workflow-template-selection.ts:470-538`:只读、master-only、要求 run `active` + `engine_owned=1`,从 pinned snapshot + 原 reservation 恢复,**固定返回原起点节点 / attempt 1 / 原 execution**(`replayed: true`)。这是 Ch.1 resolver 的直接改造点:恢复目标要从「原 reservation」换成「当前权威目标元组」。

### 1.3 successor-phase 409:mid-flight run 永远无法从 start 路由再驱动
`runs-route.ts:1607-1773` 是 engine-recovery 块,内部 `:1734-1751`:存在 active phase session 且 `execution_id ≠ reservation.execution_id` → 409(**纯 message、无 code 字段**)。它在 `recoverWorkflowStartSelection`(`:1753`)和 resolver(`:2226`)**之前**返回 —— 这就是「只能从头」的 HTTP 层封口,resume admission 的接线位置就在这里。

### 1.4 STALE_START_RESPONSE 的两个产生点
- 主:`runs-route.ts:1228-1236`,条件 = `inspectWorkflowStartReplay`(`:181-213`)返回 `start_attempt_not_current`(current_node_id / execution / node state / activation 任一与 reservation 不符)。
- 次:`:2350-2359`(cached response 无 durable reservation)。
- run 非 active 时同函数返回 `run_not_active` → 409 `RUN_NOT_REWORKABLE_VIA_START`(`:1218-1226`,hint 指向 /rework)。

### 1.5 start 幂等三层
① `workflow_start_reservation`(`selection_digest` 比对,payload 不符 throw);② `workflow_start_response`(byte-identical 重放,写入需 `launch_committed`/`responded` stage + launch owner `delivered` 证据,`StateStore.ts:19033-19081`);③ route decision digest(`claimWorkflowRouteDecision`,digest 不符 → 409 `WORK_KIND_ROUTE_DECISION_CONFLICT`)。无 key 时自动合成随机 key(`wf2-auto-${uuid}`,`:2210-2211`,防止确定性 key 永远重放第一个 run)。
**请求体今天没有任何 entry/resume 字段**;无 zod,全部 ad-hoc 读取。

### 1.6 workflow_start_reservation 是单行 append-only
`StateStore.ts:17191-17211`:`run_id UNIQUE`、`execution_id UNIQUE`、no_update/no_delete 触发器。**第二次进场的 entry/attempt/execution/幂等响应必须新表承载**(PRD 判断成立)。stage 阶梯 `workflow_start_stage`(materialized→admitted→commdb_registered→launch_committed→responded)。

## 2. 权威前沿与完成语义(附件挂载点)

### 2.1 转移事务(唯一的前沿写入点)
`commitWorkflowTransitionTx`(`StateStore.ts:30098-31062`,单事务):
- `transitionUid = workflow_transition:digest({runId,nodeId,attempt,outcome})`(`:30128-30133`)= `edge_traversed` 的 event_uid,幂等重放键。
- 写序:源节点 `done` + `node_completed` 事件(`:30584-30601`)→ `edge_traversed` receipt(含 `targetNodeId/targetAttempt/successorExecutionId/reworkRequestId/loopIteration/gateOpened`,`:30808-30830`)→ 目标 `workflow_run_node` upsert(gate `review` / rework `pending`+preferred actor / normal `pending`+ordinal,三分支 `:30831-30952`)→ **`current_node_id` 无 CAS 裸 UPDATE**(`:31044-31047`)。
- **`workflow_run` / `workflow_run_node` 均无 generation/lease 列**;run 级幂等只有 event_uid 唯一性。附件表的唯一键 `(run_id, target_node_id, target_attempt, transition_uid)` 有现成的 transitionUid 可绑。

### 2.2 完成收据与 head 来源
- `commitEnrolledCompletion`(`:28734` 起):`completionSubjectDigest` 计算在 `:29121-29128`(input.subjectDigest 优先,兜底 `sessions.pr_head_sha`,40-hex 校验;`genericNoCodeExit` → undefined)。INSERT `workflow_node_completion` 在 `:29209-29226`(唯一生产写入点);同事务内调 `commitWorkflowTransitionTx`(`:29268-29282`)。PR binding 闸 `headSha === subjectDigest` 在 `recordWorkflowGateEntryBindingTx:28435-28440`。唯一生产调用方 `bridge/event-route.ts:1010`。
- `workflow_node_completion`(`:17175-17190`)append-only(触发器 `:17330-17338`)→ 旧行不可回填,NULL 语义必须显式定义。
- **裁决路径确认不写 completion**:`submitWorkflowDecisionByCredential`(`:29505`)写 `workflow_claims`(schema `:16798-16831`)+ `claim_written` 事件 + 转移;QA 节点的 done 只来自转移事务的源节点 upsert。producer 查找:engine 分支 `workflow-decision-routes.ts:152-163`(按 manifest 入边找本 run 最后一个 done 的 producer),legacy 分支 `:790-807`(写死 "implement")。

### 2.3 pinned snapshot(V3 的锚)
`workflow-run-snapshot.ts`:V2 冻结 template id/revision、validated manifest、`manifest_digest`、resolved nodes(含 agent content 40k 截断后的 digest、dispatch pin)、`snapshot_digest = digest(body)`(`:470-486`)。parse 时全部重验(`:551-826`)。同 run 恢复绑 snapshot_digest 有完整现成实现。

## 3. 围栏与恢复原语(V1/V5 的地基)

### 3.1 已存在的 fence/lease 家族
- **launch owner lease**:`workflow_launch_owner`(`:17274-17299`,owner_generation + committed_generation CHECK + delivery_state)+ append-only `workflow_launch_cancellation`(`:17301-17318`)+ `fencedCommitWorkflowLaunch`(`:21301-21372`,cancellation check → generation CAS → marker 写+回读 → commit fence)。消费方 `workflow-engine-dispatcher.ts:2319-2368`。
- **session lifecycle_revision**:单调 generation(`:4969-4977`),`ensureTerminalLifecycleId` CAS(`:5068-5120`)。
- **rework delivery lease**:owner/generation/lease_expires_at + 5-strike 1m/2m/4m/8m backoff → `needs_lead`(`settleWorkflowReworkFailure:22997-23050`;claim 侧 `next_retry_at` 闸 `:22595-22598`)。同款策略另有 `settleHeldReworkRecoveryFailure:22714`、`settleWorkflowCarrierFailure:35789`。
- **worktree generation nonce**:create() 写入(`WorktreeManager.ts:629-636`),PR binding 带 `worktree_binding_generation`(`:16357`),canceled-pr-close 突变前重读 generation(`canceled-pr-close.ts:172-182,239-259`)。
- **物理围栏**:FLY-1759 —— `remove()`/`removeIfExists()` 拆 worktree 前按 cwd census 回收进程树(旧 writer 进程被物理杀掉)。
- **pre-push guard**(FLY-1718 P2):per-worktree `core.hooksPath`,拒非 FF 与删除,`FLYWHEEL_FORCE_PUSH_ACK` 单次放行 + 审计。非安全边界(`--no-verify` 可绕),是纪律层。

### 3.2 quiescence 陷阱(V5 反例,已核实仍在)
`validateRunQuiescenceEvidenceTx` = 永远 `{ok:true}`(`StateStore.ts:24629-24641`,#705 founder 指令中和)。严格版 `validateNeedsLeadReworkQuiescenceTx`(`:24644-24692`,30s 新鲜度 + lifecycle_revision + liveness dead)只用于 `heldNeedsLead` 的 operator rework。**任何新围栏不得复用中和版。**

### 3.3 worktree 删除与重建(K1/K2 的物理事实)
- `removeIfExists`(`WorktreeManager.ts:787-871`):删 worktree + 无条件 `git branch -D`(`:858-863`)。
- `create({startPoint})`(`:535-577`):startPoint 缺省链 = `opts.startPoint → FLYWHEEL_RUNNER_START_POINT → origin/main`,`worktree add -B`。
- takeover 分支(`edge-worker/src/Blueprint.ts:1312-1399`):要求 shareParentBranch + 角色匹配 + registered + clean + `head === startPoint || isAncestorOf(startPoint, head)`;任一不满足 → `worktree_takeover_failed`(terminal failure kind);else 路径 = removeIfExists + create(`:1400-1424`,失败无 failureKind 分类)。
- **FLY-1718 已合入**(#824):fresh dispatch 先 `materializeRemoteBranch`(`continuity-preflight.ts:132-203`,ls-remote → 定向 fetch → rev-parse 验证,indeterminate → **abort launch**),验证过的 sha 成为 `ctx.startPoint`(`run-dispatcher.ts:1699-1701`)。**已 push 的历史已有救;未 push 的本地提交仍会被 branch -D + GC 杀死** —— V1 受保护 ref 的必要性收窄到「未 push 的状态」+「外部删 origin 分支」两种情况,但依然必要。
- `ctx.startPoint` 的 7 个 producer 优先级表:req.startPoint → progressResume → continuityInherit.sha → auto-QA parent head → phase-retry branch tip → DAG predecessor head(`workflow-engine-dispatcher.ts:2198-2245`,root design 首 attempt 可缺省,否则 `engine_predecessor_unavailable` throw)→ retry passthrough。
- `isAncestorOf`(`GitResultChecker.ts:93-109`):`merge-base --is-ancestor`,任何错误 → false(fail-closed,但**不区分「证明非祖先」与「无法判定」** —— Ch.1 需要区分,不能直接拿它做「外部 drift → hold」的判据,要包一层三态探针)。

### 3.4 引擎自有 ref 命名空间(V1 先例)
- `refs/flywheel/materializations/<digest>`(`workflow-docs-git.ts:87,177-187`):create-only CAS claim(`update-ref <ref> <head> 000…0`)。
- `refs/flywheel/archive/<branch>`(`lifecycle-sweep.ts:1107-1142`):删远端分支前先 fetch 进本地 ref + bundle,失败则跳过删除。
- **checkpoint ref 与 git quarantine ref 均不存在**(只在 PRD 文本里)。
- 安全 git plumbing 现成模式:`casDeleteLocalBranch`(`branch-cleanup.ts:118-185`,occupancy + rev-parse + `update-ref -d <old>`)、`deriveTargetPrHead`(`ship-preflight.ts:213-251`,**只 rev-parse、不 git status**,防 `.gitattributes` filter RCE,附 `GIT_SAFE_CONFIG` hooksPath=/dev/null 家族)、三态探针 `probePhaseRetryBranchTip`(`run-infra.ts:171-215`,exit 1 = 唯一 confirmed-missing,其余 indeterminate)。

## 4. run 生命周期现状(Ch.3/Ch.4 的改造对象)

### 4.1 run terminate/hold API(已存在,比 issue 描述的现状好)
`POST /api/runs/:runId/{hold,terminate}`(`runs-route.ts:368-520`):master-only,`reason`(≤500)+ `clientRequestId` 必填,幂等键 `run_{held_by_operator|terminated}:<runId>:<clientRequestId>`(payload 逐字节比对,冲突 409)。状态前置:hold 要求 `active`,terminate 接受 `active|held`(`StateStore.ts:24867-24875`),CAS UPDATE(`:24977-24984`)。
**🔴 issue 里的 `RUN_HAS_LIVE_EXECUTIONS` 今天是不可达死代码**:产生点 `:24876-24888` 依赖已中和的 quiescence 验证器。FLY-1416 立案(07-22)在中和(07-24,#705)之前 —— catch-22 的「拒绝」半边已经消失。**剩下的真缺口是「收执行体」半边**:terminate 只写 run status + settle rework parks + cancel carrier deliveries(`:24985-24993`),**不碰任何 session/tmux/runner**。

### 4.2 dead-exec sweep 与「不再生」
`reconcileDeadExecutions`(`workflow-engine-dispatcher.ts:1695-1885`,每 tick,flag `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` default-on):只枚举 `status='active'` 的 run;replacement 有 [60s,5m,15m] backoff + 3 次上限(超限 → run held);FLY-1638 已合入两道围栏 —— StateStore 级 `engine_run_not_active` fence(`:26453-26457`,使「先冻 run 再收 exec」事务级免竞态)+ completed-without-receipt hold(`:26261-26373`,**close_runner --done 今天就是从这里把 run 打成 held + severe alert 的**)。
**「运维意图」标记不存在**(全库 grep 零命中)—— 唯一抑制 respawn 的杠杆就是 `run.status != 'active'`,共四道独立闸(dispatcher `:316-319` 派发闸、`:1697-1700` sweep 枚举、StateStore `:26454`、`:26302`)。FLY-1416 的 held-DB workaround 正是压在这四道闸上。

### 4.3 close_runner 与 run 的双向失联(已核实,两个方向都断)
- **正向**:`close-runner.ts`(808 行)零 workflow_run 引用。done=true 先 FSM 转 `completed`(`:244-293`,来源状态 {running, ship_parked, awaiting_review, approved_to_ship, design_done}),然后 tmux/CommDB/Discord 收尾。**不写 run、不写 teardown fact**(`generalized_teardown_recorded` 只由 runner 侧 lifecycle 事件写入)。后果:DAG 载体被 close --done → 下个 tick completed-without-receipt fence → **run 转 held + severe alert**(与 1711 要的方向相反);close 用 `/api/actions/terminate`(abandon)→ session `terminated` → sweep 走盲 replacement 分支 → **respawn**(≤3 次)。
- **反向**:run 判终 → 零 session 动作。`run_terminated_by_operator` 等事件**没有任何 session 侧消费者**;done-running-reconciler / crash-reaper / commdb-* 全部不读 workflow_run。现有 phase session 收尾都以 **issue + PR merge 证据**(`makeFinalizeWorkflowPhaseRoles`)或 **Linear disposition**(`lifecycle-closeout.ts`)为键,不以 run status 为键。唯一对 run 终态起反应的是 carrier delivery reaper(只 settle delivery 行,`:35852-35880`)。
- **execution→run 正向 helper 不存在**;反向 `listRunAttributedExecutions(runId)`(`:24613-24627`,三表 UNION:workflow_run_node ∪ workflow_side_effect_ledger ∪ workflow_execution_binding)已有,当前唯一消费者是废掉的 quiescence 证据收集。execution→context 有 `generalizedExecutionContext(executionId)` 可复用。
- **级联挂载点**:`closeRunnerInner` 各路径(graceful/already-gone/killed)收敛在 `finalizeCommunications()`(调用点 `:497,:550,:760`)—— 级联检查放这一汇合点。

### 4.4 run status 的真实状态集与 FSM
`workflow_run.status` **无 CHECK、无 FSM、TS 类型是裸 string**;穷举全部写入点(17 处 UPDATE)得到值集 = `active | held | completed | terminated`。**没有 superseded**(shadow supersession 写 terminated,`:18749`)。held→active 唯一逃生口 = `materializeWorkflowReworkReplacement` 的 pane-loss 恢复(`:22121-22128`,窄条件 + CAS throw);terminated 无任何复活路径。
`completed` 的写入者:commitEnrolledCompletion(no-code exit)、land completion、gate-run-after-ship、ledger finalize —— 全部是「引擎走完了」语义;FLY-1770 在其上再加 linear_done disposition 前置。**⇒ Ch.4 级联不应写 completed(会伪造「走完了」),应写 terminated + typed reason。**

### 4.5 terminate 后新 start 的解锁链(FLY-1711 的残余死锁)
run → terminated 后:engine-recovery 块整体跳过(`getActiveWorkflowRunForIssue` 空)✅;旧 idempotencyKey 会 409 `RUN_NOT_REWORKABLE_VIA_START`(reservation 物理不可删,须换 key)⚠️ 文档化;**session 级 dedup(`runs-route.ts:1188-1205,1286-1310`,按 issue+role+status∈{running,ship_parked,awaiting_review,approved_to_ship})是 run-status-盲的 —— run 判终后活 session 不收,新 start 仍 409**。这正是 8-11 实操里「terminate 解锁」成立的前提是残留 runner 也被收掉。⇒ Ch.3 的「收执行体」同时是 Ch.4 验收「close 后 runs/start 立即可用」的必要条件。

## 5. rework 救援路径现状(Ch.2)

- `openOperatorRework`(`StateStore.ts:25082` 起):eligibility = `active | completed | held+needs_lead | held+land pr_head_mismatch`(`:25183-25192`;FLY-1655 的 #795 已合入,`base_revision` 已修为 40-hex actor head,`:25336-25341`)。
- 死角 #3 仍在:`activateHolderForWake`(`bridge/holder-wake-activation.ts:26-52`)status 白名单 {running, ship_parked, design_done, awaiting_review},completed → `state_not_revivable:completed`(兜底 `:50`)。
- **但骨架已长出来**:协调器撞到 `state_not_revivable:<终态>` 且 `isStateStoreIrreversibleTerminalForZombie` 时会 `closeActorForReworkSupersession` 收掉 zombie(`workflow-rework-coordinator.ts:400-433`),reentry `kind==='replace'` 走 `replacement_pending`(`:370-388`),`materializeWorkflowReworkReplacement`(`StateStore.ts:22191-22271`)铸 fresh replacement;5-strike backoff + needs_lead 已由 #788(FLY-1648)兜底。
- **FLY-1772 Part 2 正在修的**:dispatcher 侧 replacement context 提前于 predecessor gate(`workflow-engine-dispatcher.ts:2199-2217` 区域)、`request.base_revision` 当 startPoint、rework attempt 的 PR binding 机器 mint(land_head_unavailable 收口)。1772 明确不动 coordinator wake 路径与 `preferred_actor_execution_id` 语义。
- ⇒ Ch.2 的残余死角清点范围:coordinator 在「preferred actor 已 completed + 1772 修好 replacement dispatch」链路上是否还有第四处断点(replacement 的 route 改绑、reservation 绑旧 execution 的 `rework_target_not_reserved` 循环,`:328-352`),以及 doctrine 文档化。

## 6. flag / rollout 合法通道

- 中央 registry(FLY-709):`packages/config/src/feature-flags/registry.ts` + `truth.ts` 的 `validateFlagTruthEnvironment`(未注册 FLYWHEEL_* = 硬错误,退役 flag 有 tombstone)。新 flag 合法路径 = 注册 FEATURE_FLAGS 条目(含 readSites、directToggleProof)。
- 现成先例:`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH`(opt-in)、`FLYWHEEL_WORKFLOW_GATE_CARRIER`(opt-in + **per-run 冻结进 `gate_carrier_epoch`**,`StateStore.ts:18790-18793` —— 「翻 flag 但在飞 run 保旧语义」的精确先例)、`FLYWHEEL_LAND_NODE`(default-on kill switch)、`FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP`(default-on)。
- FLY-1770/1772 都自我约束「no new env flag(FLY-1466)」;本 epic 因 PRD K7(爆炸半径 = 所有 DAG start)要求 observe-only + kill switch,取「恰好一个注册 opt-in flag + shadow 无条件落账」的最小方案,plan 里向 Tadashi 明示这个张力。

## 7. Tadashi 两条硬要求的落点核实

- **hold 可观测**:证据⑥(dispatcher consume 返回 false 零输出)对应 `:316-319` 的 `continue` —— 静默跳过。本 epic 所有新 hold/409 必须写 `workflow_run_event`(或专用账表)+ 结构化 log;alert 走现成 `enqueueWorkflowEngineAlertTx` outbox(FLY-1764),disposition union 在 `StateStore.ts:41485-41532` 一带(1772 会 +6 literals,文本冲突点)。
- **reason 归一化**:操作类 API reason ≤500 字校验在 `runs-route.ts:370-401`;FLY-1770 刀7 有 `normalizeLandLinearDoneReason`(≤200)先例。本 epic 的 typed reason 一律「短码 + 细节进 payload」。

## 8. 与在飞 PR 的辖区(对账细节)

见 exploration.md §7 表。补充两个实施级事实:
- 1772 §13.3 改 `workflow-engine-dispatcher.ts:2199-2217`(replacement context 先于 predecessor gate);本 epic 的 resume 恢复落地也要在同函数注入「resume admission 的 startPoint 优先级」。**实施排序:E5 的 dispatcher 接线切片在 1772 合入后 rebase。**
- 1770 把 `held` 收窄为「人类终态」;本 epic 不新增 held 产生点(force-cancel 用 terminated;resume 降级用 typed 409 + 账表,不落 held)。

## 9. 事故重放素材核实(§5.2 前置)

- 8-11 那批 run 完成时附件字段不存在、checkpoint ref 未建 —— 重放需凭据重建,取材:`workflow_node_pr_binding.head_sha`(schema `:16347-16364`,含 target_repo_path)、`codex_review_record.target_pr_head_sha`、已提交产物。重放证明「判据逻辑当时能判对」,不是「机制当时在跑」—— 与省时数字绑定发布(锁定语义④)。
- 生产库只读副本配方:记忆 `reference_qa_prod_db_replica_dispatcher_harness.md`(VACUUM INTO → 转 WAL)。
