# FLY-1912 rework 验证链撞未跑节点 — 调研

Issue: FLY-1912 (https://linear.app/geoforge3d/issue/FLY-1912/引擎rework-verification-链含未跑节点时-completeworkflowrunnode-直接-throw-http)
日期: 2026-08-20
基于: exploration.md

所有行号以本分支 `main@3c41a16f7` 为准;行号会漂,重定位用 `git log -S '<符号>'`。

## 1. 三条链路的逐行证据

### 1.1 引擎:`commitWorkflowTransitionTx` 的 rework 分支

`packages/teamlead/src/StateStore.ts`

| 行 | 内容 | 作用 |
|---|---|---|
| 36026 | `commitWorkflowTransitionTx(input)` | 函数入口,在 `db.transaction` 内 |
| 36272–36300 | 读 `workflow_rework_verification_path` 中 `state='active' AND current_node_id=? AND current_attempt=?` 的行 → `activePath/activeRoute/activeRequest` | 判定"正在完成的节点是验证链的一环" |
| 36301–36316 | `edge` 存在时,**目标改写为** `activeRoute.invalidation_scope[currentIndex+1] ?? approvalGate`,`selectedId = rework_verify:<req>:<from>:<to>` | 链式下一跳不走 manifest 边的 `to`(生产两个 shape 里恰好相同,见 §3) |
| 36318–36330 | `chainedRework` / `supersedingRework` / `reworkAuthority` | 链式 → `reworkAuthority = activeRequest.authority`(operator) |
| 36331–36336 | `targetAttempts = listWorkflowRunNodes(runId, target.id)`;`targetAttempt = max+1` | qa 从未跑过 → 空数组、attempt=1 |
| 36511–36515 | `successorExecutionId = gate ? undefined : reworkAuthority ? undefined : (input.successorExecutionId ?? randomUUID())` | **reworkAuthority 非空时不分配新 exec** —— 这是"要么 wake 老人、要么 throw"的根 |
| 36609–36617 | 从 `targetAttempts` 选 `preferredActorExecutionId`;空 → `throw new Error("workflow_rework_preferred_actor_missing")` | **事故点** |
| 36618–36628 | `INSERT OR IGNORE workflow_actor` 复用老 actor | |
| 36691–36703 | `invalidationScope = chained ? activeRoute.scope.slice(idx+1) : topology`;`verificationPolicy = chained ? activeRoute.policy : …` | 链式新 request 继承剩余 scope |
| 36704–36790 | 写 `workflow_rework_request` / `route_revision(rev 1, preferred_actor)` / `delivery('pending')` / `verification_path('pending')` + 两个事件 | 铸新链式 request |
| 36895–36913 | `else if (reworkRequestId && preferredActorExecutionId)` → 目标节点 `pending` 绑老 exec + `rework_target_reserved` | 预留给被唤醒者 |
| 36914–36938 | `else` → `allocateWorkflowLaunchOrdinalTx` + `node_dispatched(via:"engine_intent")` | **普通首跑派发路径**(A′ 要复用的就是它) |
| 36940–37035 | `if (activePath)`:gate → 路径 `completed` + delivery `wake_delivered→completed`(两处 CAS);`chained/superseding` → 老路径 `completed` + 事件 `rework_verification_chained/superseded`;否则 `throw "workflow_rework_verification_step_missing_chain"` | 链的推进/结清 |

函数内全部裸 throw(8 处,实现时逐一改成类型化不变量错误):

```
36452 workflow_rework_idle_spin_run_cas_failed
36616 workflow_rework_preferred_actor_missing        ← 本单 ① 后不可达,保留为防御性不变量
36856 land_gate_holder_requires_head
36963 workflow_rework_verification_complete_cas_failed
36972 workflow_rework_delivery_complete_cas_failed
37002 workflow_rework_verification_chain_cas_failed
37011 workflow_rework_delivery_chain_cas_failed
37033 workflow_rework_verification_step_missing_chain
```

### 1.2 边界:`commitEnrolledCompletion` → event-route → express

- `StateStore.ts:34611 commitEnrolledCompletion`:35161 调 `commitWorkflowTransitionTx`;`!transition.ok` → 设 `transitionRefusal` 再 `throw new Error("engine_completion_transition_refused")` 让事务回滚;catch(35225–35265)里只认 `terminalImmuneRefusal` / `transitionRefusal`,其余 **`throw error`** 原样上抛。
  - `transitionRefusal` 分支会落 `completion_transition_refused` 事件(`appendWorkflowRunEventChecked`,非事务)并返回 `{ok:false, reason:"transition_refused", detail:{transitionReason}}` —— 这就是我们要让不变量错误也走的形态。
- `bridge/event-route.ts:1004` 调 `commitEnrolledCompletion`;1032–1044:非 ok 且不在三种 settled 之列 → **409** `{error:"workflow_completion_rejected", reason, detail?, retryable?}`。已有结构化通道,只是裸 throw 绕过了它。
- `router.post("/")`(610)是 async handler、无顶层 try/catch;拒绝的 promise 由 express 5 送到 `plugin.ts:4155` 错误中间件 → `res.status(err.status ?? 500).json({ error: "internal error" })`。**错误消息不进响应体**,runner 只得 `internal error`。

### 1.3 回放:runner → marker → reconciler → heartbeat

`packages/flywheel-comm/src/commands/complete.ts`
- 441–512:最多 4 次 POST;`response.ok` 返回;4xx(非 429 且 `retryable!==true`)→ `break`;否则退避重试。
- 515–527:**循环结束无论因 break 还是耗尽,都** `writeMarker` + `exit 1`。所以 4xx 同样落 marker(既有行为,本单不改)。
- 855–897:marker = `~/.flywheel/state/complete-failed/<execId>.json`(或 `FLYWHEEL_COMPLETE_MARKER_DIR`),内容 = `{execution_id, attempts, error, timestamp, ...body}`。

`packages/teamlead/src/bridge/complete-marker-reconciler.ts`
- 346–365 `parseMarker`:只校验 `event_id/execution_id/issue_id/project_name/event_type==="session_completed"`,**多余键被忽略** → 可以在 marker 内加回放账本键而不破坏解析。
- 711–770 回放:`res.status >= 500 || 429` → `{kind:"transient_failed"}`;4xx → 除 `missing_output&&retryable` 外**一律隔离**(`moveToQuarantine`)并返回 `quarantined` 让调用方 fallback;网络异常 → `transient_failed`。
- 无任何计数、无 buildSha 感知、无告警。`transient_failed` 在类型上与"网络抖动"不可区分。

`packages/teamlead/src/bridge/plugin.ts:8928` boot drain(`reconcileCompleteFailedMarkers`)对 transient 什么都不做("leave for next boot or heartbeat cycle")。

`packages/teamlead/src/HeartbeatService.ts`
- 781–790:`transient_failed` → `markerRetryPending.add(execId)` 后 **`return`**,不探活、不走僵尸判定。
- 1913–1916 / 1965:`markerRetryPending` 同时抑制 crash reaper 与 orphan 通知。

→ 结论:一个确定性 500 会让 session 永久 `running`、永不被清、永不告警 —— 与 issue 描述"纯死锁"一致,而且比描述更糟(连兜底的僵尸/孤儿巡检也被它关了)。

## 2. 下游消费者审计(A′ 的安全性)

A′ 让既有 verification path 在 qa 在途期间保持 `active`、delivery 保持 `wake_delivered`。逐个核对会读这两张表的地方:

| 位置 | 读什么 | A′ 下行为 |
|---|---|---|
| `StateStore.ts:29042`(carrier 退役前置)、30599(`openOperatorRework`)、37928(founder kickback) | delivery ∈ {pending,turn_granted,wake_delivered,replacement_pending} → `rework_already_open` / `rework_delivery_inflight` | **保持拒绝**,与现有链式行为一致(链式新 request 在 qa 在途时同样 open)。A 方案会失去这层守卫 |
| `StateStore.ts:23703–23715 escalateWorkflowReworkStall` | 只对 `pending / turn_granted / replacement_pending` 升级 stall | `wake_delivered` **不在范围**,qa 跑多久都不会误报 stall |
| `workflow-rework-coordinator.ts:reconcile`(经 dispatcher 795 `listWorkflowReworkDeliveries(states:["pending","turn_granted","held"])`) | 只处理这三种 | `wake_delivered` 不被扫,不会去唤醒任何人 |
| `StateStore.ts:42864`(TURN 期望集) | `turn_granted/wake_delivered` 且 `rework_request_id` 绑在 activation 上 | 新 qa 的 activation 不绑 rework request(普通 spawn),不进该集合 |
| `StateStore.ts:33048` run 状态只读投影 | LEFT JOIN path 展示 | 诊断显示 current_node=qa、state=active,**更诚实** |
| `materializeWorkflowReworkReplacement` 25779 / `markWorkflowReworkReplacementLaunched` 26282 | 只在 `replacement_pending` 下动作 | 不触及 |
| qa→gate 结清分支 36940–36980 | CAS `path active & (qa, attempt)` → completed;CAS `delivery wake_delivered` → completed | **恰好满足**:A′ 把 path 推到 (qa,1),delivery 仍 wake_delivered |
| qa_fail 回环 | `loop` + `authorityKickback="qa"` → `supersedingRework`(需要 activePath)→ 老路径 `completed`、铸 qa-authority request 指向 implement(有历史) | 与今天一致 |

### 2.1 dispatcher 对"全新 successor"的处理(复用首跑)

`bridge/workflow-engine-dispatcher.ts`
- 2350–2395:以 `edge_traversed` 事件里 `payload.successorExecutionId === intent.execution_id` 找到 transition;`predecessorExecutionId = transition.execution_id`(= implement exec)→ `resolveLeadId`。
- 2455–2470:qa 是 phase role(`config/src/phase-roles.ts` + NODE_TYPE_REGISTRY isPhaseRole)→ `startPoint = resolvePredecessorHead(implement exec)`,与首跑 qa 完全一致。
- `edgeId` 的值(`rework_verify:…`)不参与查找。

### 2.2 其它铸 rework request 的入口(确认不受影响)

- `openOperatorRework`(30287):目标必须有历史 actor,否则 `target_actor_history_missing`(30625)—— 合同正确,不改。
- founder kickback(37928 附近)与 FLY-1833 land-conflict rework(38014 附近):目标 = implement(gate/land 之前必经),历史恒存在。
- qa_fail 回环:目标 `loop.to` = implement,同上。
- ⇒ "无历史 actor"**只可能**出现在链式下一跳指向从未跑过的节点;A′ 覆盖任意多个连续未跑节点(每一跳都走同一分支)。

## 3. 生产拓扑核对

`menus/shapes/code.yaml` / `simple_code.yaml`:`implement --implement_done--> qa --qa_pass--> founder_gate`,loops `qa_retry(qa→implement, max 3/10)` 与 `founder_rework(gate→implement, 无上限)`。operator rework 到 implement 的 scope = reachable 非 gate 节点按 `resolved.nodes` 顺序 = `[implement, qa]`,与边一致。故 A′ 的"路径 next"与"边 to"在生产中重合;文档仍按路径 next 为准(与既有链式语义一致)。

## 4. 测试现状

- `StateStore.workflow-rework.test.ts`(2871 行)与 `StateStore.workflow-engine-transition.test.ts`:对 `rework_verification_chained` / `superseded` / `engine:rework_verification` **零断言**。链式下一跳整段没有测试。
- `workflow-rework.test.ts:757` fixture(`createHeavyEngineRun` + `advanceHeavy` + `bindActorHead` + `openOperatorRework`)= FLY-1330 形态;把 delivery 推到 `wake_delivered`、路径 `active`、implement/2 `running` 后 `advanceHeavy(implement, 2, implement_done)` 即 RED。
- `workflow-rework.test.ts:1021` 已覆盖 operator 侧 `target_actor_history_missing`。
- `bridge/__tests__/complete-marker-reconciler.test.ts` + `.integration.test.ts`:有 fetch 注入的 harness(`deps.fetchFn`),可直接喂 500/409/网络异常。
- `HeartbeatService.*.test.ts`:有 `transient_failed` 路径的用例可并列。

## 5. 可复用的现成构件

| 需求 | 现成构件 | 位置 |
|---|---|---|
| 耐久、去重的 Lead 告警 | `leadAlertNotifier.alert({eventId, severity:"severe", …})` + `durableAlertAccepted` | `auto-qa-effects.ts:484 alertShipAttemptFailed`(eventId 去重 = 一次事故一条) |
| 引擎侧耐久告警(非事务版) | `StateStore.enqueueWorkflowEngineAlert({escalationUid, runId, payload})` | 30977;`escalationUid` 去重 |
| 非事务事件落账 | `appendWorkflowRunEventChecked` | 37240;`transition_refused` 已用 |
| reconciler 注入点 | `MarkerReconcilerDeps`(`fetchFn`, `alertShipAttemptFailed`, `log`…) | reconciler 160–190;plugin 8928;Heartbeat 678 |
| Bridge buildSha | `/health` 已有 `buildSha` | plugin.ts(`buildSha` 变量) |
| marker 原子写 | `writeFileSync(tmp)+renameSync` 模式 | 仓内多处(如 gate-marker.ts) |

## 6. 选项权衡

| | A 脱链 | **A′ 不脱链 + 新派发** | B 链内换新人(replacement) |
|---|---|---|---|
| 新表/新状态 | 0 | 0 | 0,但复用 `replacement_pending` 与 dead-watch |
| 账本诚实 | 路径提前 completed(qa 还没跑) | 路径如实停在 qa | 给不存在的 actor 写 `execution_dead_rolled_back` + `workflow_dead_execution_watch` |
| `rework_already_open` 守卫 | **丢失** | 保留 | 保留 |
| qa runner 看到的 prompt | 同首跑 | 同首跑 | 同首跑(replacement 只注入 startPoint+founderFeedback,qa 不用) |
| 改动面 | 1 分支 | 1 分支 + 1 事件 | 新 request + ledger reason + 绕过 base_revision 40-hex 门 |
| 与临时修复一致性 | 完全一致 | qa→gate 一步后一致 | 不同 |

选 **A′**。

## 7. 断路器参数(③)

- 只数 **HTTP 5xx(非 429)且响应体摘要相同** 的连续失败;网络异常/超时/429 不计(真瞬态)。
- N = **3**(模块常量,不开 flag)。生产 boot + heartbeat 节奏下 3 次 ≈ 分钟级,足够滤掉 db busy 一类抖动。
- 摘要 = sha256(`status + ":" + body[0:256]`)。
- 账本写进 marker 自身的 `replay_ledger` 键(`parseMarker` 容忍),字段:`streak, digest, first_at, last_at, build_sha, circuit`。
- 换 build(`build_sha` 变化)→ 自动放一次;同摘要再败 → 再开路、按新 buildSha 再告警一次("你的修复没生效")。
- 409 `reason:"engine_invariant"`(②产生)→ **N=1** 立即 held;不隔离、不 fallback、reconciler 不重复告警(源头已告警且 escalationUid 去重)。
