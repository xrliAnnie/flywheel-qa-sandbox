# FLY-1912 rework 验证链撞未跑节点 — 实施计划

Issue: FLY-1912 (https://linear.app/geoforge3d/issue/FLY-1912/引擎rework-verification-链含未跑节点时-completeworkflowrunnode-直接-throw-http)
日期: 2026-08-20
基于: research.md

**Version**: ship 时取当前空号(doc/VERSION 现为 v1.55.0,多单 pending)
**Status**: **codex-approved**(R3 APPROVED,2026-08-20;R1 9 项 + R2 3 项 + R3 3 条非阻断备注已折入,见 §7)

## 0. 一句话

验证链下一跳没有"上一任 actor"时,引擎按首跑方式派新人、链原地前进(①);引擎转移函数内部的不变量违反在**函数自身边界**转成结构化拒绝 `engine_invariant:<name>`,所有调用方自动拿到 4xx + reason,HTTP 边界再补一次耐久 Lead 告警(②);marker 回放对"类型化拒绝"立即持有、对未知 5xx 走耐久指数退避 + 每 episode 一次告警,永不删证据、永不无限重放(③)。零新表、零新 flag、零新 timer。

## 1. 范围与不变量

**改**:
- `packages/teamlead/src/StateStore.ts`:`commitWorkflowTransitionTx`(①+②核心)、`commitEnrolledCompletion` / `submitWorkflowDecisionByCredential` 的 catch(②告警)、两个结果 union
- 新文件 `packages/teamlead/src/workflow-engine-invariant.ts`
- `packages/teamlead/src/bridge/complete-marker-reconciler.ts`(③)
- `packages/teamlead/src/HeartbeatService.ts`(`held_for_lead` 分支)
- `packages/teamlead/src/bridge/auto-qa-coordinator.ts` + `auto-qa-effects.ts`(一个新告警 effect,照抄 `alertShipAttemptFailed`)
- `packages/teamlead/src/bridge/plugin.ts`(boot drain + heartbeat 的 reconciler deps 各加一个 late-bound 告警回调)

**不改**:`flywheel-comm complete` 的重试/marker 写法;operator 侧 `target_actor_history_missing` 合同;event-route / decision-routes 的响应形状(复用既有 409 分支);任何 schema;`commitWorkflowTransitionTx` 的其它 4 个调用方(`commitWorkflowLoopReentryRequest`、`appendWorkflowSystemClaim` ×3)—— 它们已有 `!transition.ok` 处理,reason 字符串自然带上不变量名。

**字节兼容**:有历史 actor 的链式 rework、qa_fail 回环、founder kickback、land-conflict rework 路径逐字不动;不撞 5xx / 不变量的 marker 回放逐字不动;`WorkflowEngineInvariantError extends Error` 且 `message` = 不变量名,未做 `instanceof` 的调用方行为不变(仓内无 `constructor === Error` 判断)。

## 2. 设计

### 2.1 ① 引擎:链式下一跳无历史 actor → 全新派发,路径原地前进

`commitWorkflowTransitionTx`,紧接 `targetAttempts` 计算(StateStore.ts ~36331)之后:

```ts
const chainHistoryActorExecutionId = targetAttempts
    .filter((candidate) => candidate.execution_id)
    .sort((left, right) => right.attempt - left.attempt)[0]?.execution_id;
// 验证链把下一跳指向一个从未跑过的节点(deadend-⑮ 类恢复:rework 指 implement、qa 从未跑过)。
// 没有"上一任"可唤醒 ⇒ 与首跑一致全新派发;链不断,路径原地推进到该节点。
const chainedFreshDispatch = chainedRework && !chainHistoryActorExecutionId;
const reworkAuthority =
    authorityKickback ??
    (chainedRework && !chainedFreshDispatch ? activeRequest?.authority : undefined);
```

效果(靠既有代码自然落下,不加第二套派发逻辑):
- `reworkAuthority === undefined` ⇒ `successorExecutionId = input.successorExecutionId ?? randomUUID()`;不铸 request;`preferredActorExecutionId` 整段跳过(`chainedRework` 的其余 6 处引用全在 `if (reworkAuthority && reworkRequestId)` 块内,天然不可达);
- 进入 ~36914 的普通 `else` 分支:`allocateWorkflowLaunchOrdinalTx` + 节点 `pending` + `node_dispatched(via:"engine_intent")` —— 与首跑字节一致;
- `edge_traversed` 收据含 `successorExecutionId`,`edgeId` 仍是 `rework_verify:<req>:implement:qa`(保留链可追溯性;dispatcher 查找不依赖 edgeId)。

`if (activePath)` 块(~36940)新增分支,顺序:gate → **fresh** → chained/superseding:

```ts
} else if (chainedFreshDispatch) {
    this.db.run(
        `UPDATE workflow_rework_verification_path
            SET current_node_id = ?, current_attempt = ?, updated_at = ?
          WHERE request_id = ? AND state = 'active'
            AND current_node_id = ? AND current_attempt = ?`,
        [target.id, targetAttempt, now, activePath.request_id, input.nodeId, input.attempt],
    );
    if (this.db.getRowsModified() !== 1) {
        throw new WorkflowEngineInvariantError("workflow_rework_verification_advance_cas_failed");
    }
    this.appendWorkflowRunEventCheckedTx({
        runId: input.runId,
        eventUid: `rework_verification_fresh_dispatch:${activePath.request_id}:${target.id}:${targetAttempt}`,
        kind: "rework_verification_fresh_dispatch",
        nodeId: target.id,
        executionId: successorExecutionId,
        payload: {
            requestId: activePath.request_id,
            sourceNodeId: input.nodeId, sourceAttempt: input.attempt,
            targetNodeId: target.id, targetAttempt, successorExecutionId,
            reason: "target_actor_history_missing",
        },
    });
}
```

delivery **不动**(保持 `wake_delivered`),由 qa→gate 的既有 gate 分支结清:它的两处 CAS 恰好要求 path `active@(qa,N)` + delivery `wake_delivered`。

**诊断形状(刻意的,不是损坏)**:原 `workflow_rework_route_revision` 不可变,仍写 `target_node_id=implement`;而 `workflow_rework_verification_path.current_node_id` 已到 qa。run 状态只读投影(~33048)会同时显示两者;operator 看到 route 目标 ≠ path 当前节点时应读作"链在推进"。测试 3.1-1 断言这个形状。

后续分支(research §2 已逐条核对):qa_pass → gate 正常结清;qa_fail → `supersedingRework` 指向 implement(有历史)照旧;qa 在途期间 `rework_already_open` 仍拒新 operator rework;stall 升级不看 `wake_delivered`。多个连续未跑节点:每一跳都落进同一分支。

### 2.2 ② 边界:不变量在转移函数自身边界转成结构化拒绝

新文件 `packages/teamlead/src/workflow-engine-invariant.ts`:

```ts
export const ENGINE_INVARIANT_REASON_PREFIX = "engine_invariant:";
export class WorkflowEngineInvariantError extends Error {
    readonly invariant: string;
    constructor(invariant: string) { super(invariant); this.name = "WorkflowEngineInvariantError"; this.invariant = invariant; }
}
export function engineInvariantFromReason(reason: string): string | undefined {
    return reason.startsWith(ENGINE_INVARIANT_REASON_PREFIX) ? reason.slice(ENGINE_INVARIANT_REASON_PREFIX.length) : undefined;
}
```

`commitWorkflowTransitionTx`:
1. 函数内 8 处裸 `throw new Error("…")`(research §1.1 清单)+ 新增的 advance CAS,全部改为 `throw new WorkflowEngineInvariantError("…")`。**只改这 9 处**,深层 helper(如 `createWorkflowGateHolderTx`)本单不动。
2. 把 `this.db.transaction(() => {…})` 包一层:

```ts
try {
    this.db.transaction(() => { /* 原事务体不变 */ });
} catch (error) {
    if (error instanceof WorkflowEngineInvariantError) {
        // better-sqlite3 嵌套事务 = SAVEPOINT;抛出已回滚到本函数入口,外层事务未受影响。
        result = { ok: false, reason: `${ENGINE_INVARIANT_REASON_PREFIX}${error.invariant}` };
    } else {
        throw error;
    }
}
```

这样 **6 个调用方全部自动**走各自既有的 `!transition.ok` 分支:
- `commitEnrolledCompletion`(~35161):`transitionRefusal = "engine_invariant:<name>"` → 外层回滚 → `completion_transition_refused` 事件(payload.transitionReason 带名)→ 返回 `{ok:false, reason:"transition_refused", detail:{transitionReason}}` → event-route **409**(既有分支,零改动);
- `submitWorkflowDecisionByCredential`(~35708):同构 → `decision_transition_refused` 事件 → decision-routes 既有 4xx 映射(qa→gate 正是走这条);
- `commitWorkflowLoopReentryRequest`(~35946):`transition_refused`(既有,不带名——既有行为,不扩);
- `appendWorkflowSystemClaim` ×3:抛带 reason 的 Error(founder source 的既有 fail-loud 通道,消息里自然含不变量名)。

**耐久 Lead 告警**(只在两个 HTTP 边界,`commitEnrolledCompletion` 与 `submitWorkflowDecisionByCredential` 的 catch 内;此处已在最外层事务之外):两个边界现有的"写拒绝事件"改为调用私有 helper `recordEngineInvariantRefusal`,**拒绝事件 + 告警入队在同一个小事务里**:

```ts
const invariant = engineInvariantFromReason(transitionRefusal);
let alertPending = false;
if (invariant) {
    alertPending = !this.recordEngineInvariantRefusal({ runId, issueId, nodeId, attempt, executionId, refusalEventUid, refusalKind, refusalPayload, invariant, alertIdentity: input.alertIdentity, now }).alertDurable;
} else {
    this.appendWorkflowRunEventChecked({ /* 既有写法不变 */ });
}
return { ok: false, reason: "transition_refused", detail: { transitionReason: transitionRefusal, ...(alertPending ? { alertPending: true } : {}) } };
```

`recordEngineInvariantRefusal`:`this.db.transaction(() => { appendWorkflowRunEventCheckedTx(拒绝事件); if (alertIdentity) enqueueWorkflowEngineAlertTx({escalationUid, …}) + appendWorkflowRunEventCheckedTx(alert_enqueued) })`。**事务抛错就向上抛**(→ 500,诚实:Bridge 没能耐久记录这次拒绝;runner 按 5xx 重试。completion 边界的 runner 落 `complete-failed` marker 后进 ③ 的退避;决策边界的 runner 落 `qa-result-failed` dead-letter,无自动回放,见下)。返回 `{alertDurable: Boolean(alertIdentity)}`。

- `escalationUid = engine_invariant:${runId}:${nodeId}:${attempt}:${invariant}`;payload:`eventId: escalationUid`、`eventType:"workflow_engine_escalation"`、`severity:"severe"`、title "<issue> 交棒被引擎不变量拒绝:<name>"、body 含 run/node/exec/不变量名/已回滚/marker 将被保留并每小时慢探/恢复路径、`metadata.workflowEngine.disposition:"engine_invariant_refusal"`。`escalationUid` 去重 ⇒ runner 重试 / marker 回放撞同一不变量只告警一次。
- **`alertPending` 的定义 = "没有耐久告警回执"**。两个 HTTP 边界都传入 resolved-or-fallback 身份(decision 路由经 plugin.ts 注入的 `resolveWorkflowRunAlertIdentity`;completion 路由用 event-route 既有的等价 resolved/fallback 逻辑 —— **不要从 event-route.ts 反向 import plugin.ts 的 resolver**,plugin 已 import event-route,会成环;要复用就把 resolver 抽到独立模块或经 `createEventRouter` 注入;并加一条接线断言:两条生产 HTTP 路由传入的身份都非 undefined),**永不为空**,所以生产上 `alertPending` 只在内部/测试调用方不传身份时出现;它不是"告警入队失败"的补丁(入队失败 = 整个小事务失败 = 500),而是对"没身份"的诚实标记,由 ③ 的 reconciler 用自己的 sink 接力。
- **决策边界的 dead-letter**:`flywheel-comm qa-result` 在 4xx 后写 `~/.flywheel/state/qa-result-failed/<exec>.json`,仓内**没有任何读者**(既有缺口,属 FLY-1898 对账器族,本单不加读者、不假装能重放凭据)。本单对决策边界的保证是:409 返回当且仅当拒绝事件与 Lead 告警已**原子**落盘;QA runner 收到 4xx 后按其既有协议停下并向 Lead 回报。

结果 union 改动:`WorkflowCompletionResult` 与 `WorkflowCredentialSubmissionResult` 的 `transition_refused` 变体 `detail` 增加可选 `alertPending?: true`。event-route 的 409 分支原样透传 `detail`。

### 2.3 ③ 回放:类型化拒绝立即持有;未知 5xx 耐久退避 + 每 episode 一次告警

`complete-marker-reconciler.ts`

**为什么不做"同摘要 N 次断路"**:express 错误中间件对所有未处理异常都回同一个 `{"error":"internal error"}`,响应体不能区分 db busy 与确定性 bug;按摘要开"永久断路"会把 3 次普通抖动判成死锁、且只有人工/重部署能复位。改为 FLY-1648 同款耐久退避:负载有界、证据保留、状态修好后自动恢复。

新 outcome:
```ts
| { kind: "held_for_lead"; invariant: string; alertState: "accepted" | "pending" }
```

新 deps(可选;缺省=只记日志,与 `alertShipAttemptFailed` 同风格):
```ts
/** FLY-1912: 耐久 Lead 告警。返回前必须 durableAlertAccepted,否则 reject。 */
alertCompleteMarkerHeld?: (args: CompleteMarkerHeldAlert) => Promise<void>;
```
```ts
export interface CompleteMarkerHeldAlert {
    eventId: string;               // 去重键(见下)
    kind: "engine_invariant" | "unknown_5xx_episode";
    execId: string; issueId: string; projectName: string;
    session?: Session;             // 有则用其 labels 解析 Lead;无则 labels=[]
    markerPath: string;
    reason: string;                // 人读文案主体
    httpStatus?: number;
    binding?: { runId: string; nodeId: string; attempt: number };
}
```

账本(写回 marker 自身,`parseMarker` 容忍多余键;读时做形状校验,畸形账本视为不存在并记日志):
```ts
replay_ledger?: {
    v: 1;
    mode: "backoff" | "held";
    streak: number;                 // 连续未知 5xx 次数(backoff)
    episode_started_at: string;     // 本 episode 首次 5xx 时间(backoff)/ 持有时间(held)
    last_status: number;
    last_at: string;
    next_probe_at: string;          // backoff:指数退避;held:固定 +1h 慢探针
    invariant?: string;             // held 专用
    alert_event_id?: string;
    alert_state?: "pending" | "accepted";
}
```

**判定表**(替换 ~711–770 区段)。**第 0 条压倒一切**:marker/账本校验通过后、在任何 POST / 提前结清(已有 completion receipt、session 已终态)/ 隔离 / 删除之前,先看 `alert_state==="pending"`:有 → **只重试告警**(不 POST、不结清),成功则原子改写 `accepted`(改写失败 → `transient_failed`),失败 → `transient_failed`;sink 未注入 → 视为失败(reject),绝不降级成"记日志当 accepted"。然后才进下表:

| 情况 | 处理 |
|---|---|
| 回放前,账本 `mode==="held"` 且 `now < next_probe_at` | 返回 `held_for_lead`,**不 POST**。`now ≥ next_probe_at` → 正常回放一次(POST 幂等;状态修好即 reconciled,仍坏则重新写 held 并推后 1h,告警不重发) |
| 回放前,账本 `mode==="backoff"` 且 `now < next_probe_at` | `transient_failed`,**不 POST** |
| fetch 抛错 / abort / 429 | **无账本**:`transient_failed`,不写账(legacy 行为逐字不变)。**已有 backoff/held 账本**(说明这是一次到期探针):episode/streak 不变,但 `next_probe_at` 按当前封顶延迟(backoff:`min(60s·2^(streak−1), 3600s)`;held:1h)推后再写账,返回 `transient_failed` —— 否则过期的 `next_probe_at` 会让后续每个 heartbeat 都 POST,退化回心跳频率 |
| 2xx 且校验通过 | 既有 reconciled 路径;marker 删除,账本随之消失 |
| **409 且 `detail.transitionReason` 以 `engine_invariant:` 开头** | 写账 `mode=held, invariant, next_probe_at = now + 1h`;`detail.alertPending===true` → 先写 `alert_state=pending, alert_event_id=engine_invariant:${runId}:${nodeId}:${attempt}:${invariant}`,再调 `alertCompleteMarkerHeld({kind:"engine_invariant", eventId: alert_event_id, …})`,接受后改写 `accepted`,失败保持 `pending` 并返回 `transient_failed`(下轮第 0 条只重试告警);无 `alertPending` → `alert_state=accepted`(源头在同一事务里已入耐久 outbox)。返回 `held_for_lead`。**不隔离、不 fallback** |
| 其它 4xx | 不变(隔离 + fallback) |
| 5xx(非 429) | 账本 `mode=backoff`:无账本/`mode` 不是 backoff → `streak=1, episode_started_at=now`;否则 `streak+1`。`next_probe_at = now + min(60s·2^(streak−1), 3600s)`(1m/2m/4m/8m/16m/32m/1h 封顶)。**`streak===3` 时**告警一次:先写 `alert_state=pending, alert_event_id = complete-marker-5xx:${execId}:${episode_started_at}`,再调 sink(`kind:"unknown_5xx_episode"`),接受后改写 `accepted`,失败保持 `pending`(下轮第 0 条接管)。返回 `transient_failed` |

**写账纪律**:同目录唯一 tmp(`${marker}.${pid}.${randomUUID()}.tmp`)+ `renameSync`;写账失败 → 记日志、返回 `transient_failed`、**不告警**(告警必须以账本落盘为前提,否则下轮无法判重)。**先写 pending 再发告警、收到 accepted 再改写** —— 两次写之间崩溃最多造成一次重复投递,而 `leadAlertNotifier` 按 eventId 去重,不会重复打扰。

**单飞**:模块级 `Map<markerPath, Promise<ReconcileOutcome>>`,`tryReconcileComplete` 同路径并发调用复用同一个 Promise(boot drain 与 heartbeat 当前可同时跑到同一 exec:`heartbeatService.start()` 在 plugin.ts ~7189,boot drain 在 ~8928)。单 Bridge 进程是既有不变量,进程内单飞足够。

**Episode 结束**:任何非 5xx 结果(reconciled 删 marker;4xx 隔离;engine_invariant 转 held)自然结束;5xx 恢复成 200 即 reconciled。不存在"永久开路":backoff 与 held 最坏都是每小时探一次;告警 backoff 只在第 3 次发一条、held 只在进入时发一条(同 escalationUid/eventId 去重)。

`reconcileCompleteFailedMarkers`(boot drain):`held_for_lead` 计入新计数 `held`,不 fallback,打一行日志。

`HeartbeatService.reconcileCandidateReadoptV2`:`held_for_lead` 与 `transient_failed` 同样 `markerRetryPending.add` 后 return(维持"有 marker 就不 reap"的既有保护 —— 这正是 needs_lead 姿态:session 留 running,等 Lead)。

**接线**:
- `auto-qa-coordinator.ts` 加 `alertCompleteMarkerHeld(args)` → `effects.alertCompleteMarkerHeld(args)`;`auto-qa-effects.ts` 实现:`resolveLeadForIssue(projects, args.projectName, parseLabels(args.session?.issue_labels))` → `leadAlertNotifier.alert({leadId, projectName, eventId: args.eventId, eventType:"complete_marker_held", severity:"severe", title, body, sessionKey?})` → 非 `durableAlertAccepted` 则 throw(与 `alertShipAttemptFailed` 同约定)。
- `plugin.ts` 两处 deps 用 **late-bound holder**(照 ~6650 `autoQaCoordinatorHolder.current?.` 的既有模式):`alertCompleteMarkerHeld: (args) => { const c = autoQaCoordinatorHolder.current; return c ? c.alertCompleteMarkerHeld(args) : Promise.reject(new Error("complete-marker alert sink unavailable")); }`。holder 未就绪时 reject → reconciler 记 `pending` 下轮重试,不会静默丢。

### 2.4 恢复手册(写进告警文案与本文件)

- **engine_invariant 持有**:Lead 核对该 run 的 `workflow_rework_verification_path` / `workflow_rework_delivery` / 节点状态,修正后**什么都不用删、不用改文件**:held 态每小时自动探一次,最迟 1h 内重放成功并清 marker。**绝不删 marker**:删 marker = heartbeat 停止抑制 reap,completion 从未入账的 session 会被当孤儿 fail 掉。
- **unknown_5xx episode**:不需要任何人工动作;修好根因后最迟 1 小时内自动重放成功并清 marker。
- 真要放弃该 completion:先通过既有 operator 路径终结/close 该 session(让 session 离开 `running`),再删 marker(`applyQuarantineFallback` 同款"非 running 不动"的保护会兜住顺序错误)。

### 2.5 明确不做

- 不在 reconciler 里改 run 状态(held/needs_lead 是 rework delivery 的词汇;marker 是文件层对账器,越权会造成双重权威)。Lead 告警即"转 needs_lead"。
- 不给 `flywheel-comm complete` 加新 flag 或改 4xx 落 marker 行为。
- 不按响应体摘要判"确定性"(R1 #2/#9);不做 buildSha 自动复位(R1 #5/#7)。
- 不为深层 helper 的 throw 扩类型化(FLY-1898 对账器族若落地再统一)。

## 3. TDD(RED → GREEN → REFACTOR)

实施顺序:3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → §4。

### 3.1 `packages/teamlead/src/__tests__/StateStore.workflow-rework.test.ts` 新 `describe("FLY-1912 verification chain fresh dispatch")`

基于 757 行 fixture(`createHeavyEngineRun` / `advanceHeavy` / `bindActorHead` / `openOperatorRework`),补 helper `deliverOperatorRework(store, requestId)`:把 delivery 推到 `wake_delivered`、路径 `active@(implement,2)`、节点 implement/2 `running`(优先走公开 API:`admitGeneralizedWorkflowExecution(activationMode:"wake", reworkRequestId)` + `advanceWorkflowReworkDelivery`;不得已才 SQL)。

| # | 用例 | 断言 |
|---|---|---|
| 1 | **RED 复现**:implement/2 `implement_done` | 修前:抛 `workflow_rework_preferred_actor_missing`。修后:`ok:true`、`successorExecutionId` 为 uuid、qa/1 `pending` 绑该 exec、事件含 `node_dispatched(via:engine_intent)` 与 `rework_verification_fresh_dispatch`、路径 `active@(qa,1)`、delivery 仍 `wake_delivered`、`workflow_rework_request` 行数不变、route revision 仍 `target_node_id=implement`(诊断形状) |
| 2 | 接 #1:qa/1 `qa_pass` | 路径 `completed`、delivery `completed`、`rework_verification_completed` 事件、gate holder 建立 |
| 3 | 接 #1:qa/1 `qa_fail` | `supersedingRework` 照旧:老路径 completed、新 qa-authority request 指向 implement/3、`preferred_actor` = implement/2 exec |
| 4 | 接 #1:qa 在途时 `openOperatorRework` | `rework_already_open` |
| 5 | 接 #1:同一 transition 重放 | `idempotentReplay:true`,无第二个 successor |
| 6 | **回归**:qa 有历史(先跑过 qa/1)再 operator rework implement → implement/2 `implement_done` | 走链式:铸新 request、`preferred_actor` = qa/1 exec、`rework_verification_chained` 事件、qa/2 `pending` 绑老 exec(首次覆盖这条路径) |
| 7 | 连续两个未跑节点(测试 manifest scope `[implement, review, qa]`) | 两跳都 fresh,路径逐跳前进 |

### 3.2 `packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts` 追加

从 #3.1-1 提交后的 `node_dispatched` intent 出发:新 qa execution 以 `spawn` 模式 admit、`startPoint` = implement/2 actor 的 head、binding 无 `rework_request_id`、原 delivery 仍 `wake_delivered`、launch 走 `recoverOrAcquireWorkflowLaunch` 普通路径。

### 3.3 `packages/teamlead/src/__tests__/StateStore.engine-invariant.test.ts`(新)

| # | 用例 | 断言 |
|---|---|---|
| 1 | 在 #3.1-1 之后把 delivery 改成 `completed`,再经 **`submitWorkflowDecisionByCredential`** 投 qa_pass | `{ok:false, reason:"transition_refused", detail:{transitionReason:"engine_invariant:workflow_rework_delivery_complete_cas_failed"}}`;回滚(qa/1 仍 running、无 gate holder、路径仍 active);`decision_transition_refused` 事件;engine alert outbox 恰 1 条 `escalationUid=engine_invariant:…` |
| 2 | 同输入再投 | 仍拒绝;事件/告警不增 |
| 3 | 经 `commitEnrolledCompletion` 触发任一不变量(用 implement 节点 + 人为制造 `workflow_rework_verification_step_missing_chain`:activePath 存在但 edge 缺失) | `completion_transition_refused` 事件 + 同款告警 + 返回带名 reason |
| 4 | 无 `alertIdentity`(内部调用) | 有事件、无告警、不抛,`detail.alertPending===true` |
| 5 | 小事务(拒绝事件+告警)写入被 mock 成抛错 | **向上抛**(HTTP 500 语义),拒绝事件与告警都不存在(原子) |
| 5b | 决策路由(`/api/workflow/decision`)撞不变量 | 409 body 含 `detail.transitionReason`;同一事务里 `decision_transition_refused` 事件 + outbox 告警;再投不增 |
| 6 | 非不变量异常(mock 一处 TypeError) | 原样上抛(500 语义保留) |
| 7 | 嵌套回滚边界 | 外层调用方在 `!ok` 后继续写的内容可提交;内层 savepoint 内的写全部消失 |

### 3.4 `packages/teamlead/src/__tests__/event-route-*.test.ts` + decision-routes 测试

- `/events` completion 返 `transition_refused` + `engine_invariant:` → HTTP 409 body 原样带 `detail.transitionReason`(与 `alertPending`);
- `/api/workflow/decision` 同构。

### 3.5 `packages/teamlead/src/__tests__/complete-marker-reconciler.test.ts`

| # | 用例 | 断言 |
|---|---|---|
| 1 | fetchFn 连返 500 ×3(体恒 `internal error`) | 三次都 `transient_failed`;账本 streak 1→3、`next_probe_at` 1m/2m/4m;第 3 次 alert sink 调 1 次(`complete-marker-5xx:…`),`alert_state=accepted` |
| 2 | 接 #1,`now < next_probe_at` 再调 | **fetchFn 未被调**,`transient_failed` |
| 3 | 接 #1,过了 `next_probe_at` 且 fetch 200 | reconciled、marker 删除 |
| 4 | 5xx ×10 | `next_probe_at` 封顶 1h;告警仍只 1 次 |
| 5 | 网络异常 ×5 / 429 ×5(无账本) | 始终 `transient_failed`,无账本(legacy 逐字不变) |
| 5b | 5xx → 到期探针撞网络异常/429 | streak 不变、`next_probe_at` 按当前封顶延迟推后;到期前再调 **不 POST** |
| 6 | 409 `engine_invariant:` 无 `alertPending` | 第 1 次即 `held_for_lead`,账本 `mode=held, alert_state=accepted, next_probe_at=+1h`;quarantine 目录空;sink 0 次;1h 内再调不 POST;过 1h 再调 POST 一次,仍 409 → 仍 held、再推 1h、sink 仍 0 次;改成 200 → reconciled |
| 7 | 409 `engine_invariant:` 带 `alertPending` | sink 调 1 次(eventId 与源头 escalationUid 同形);再调不 POST、不再告警 |
| 8 | sink reject(#7 情形) | 本轮 `transient_failed`、`alert_state=pending`;下轮不 POST、只重试 sink;成功后 `held_for_lead` |
| 8b | **pending 压倒一切**:`alert_state=pending` 且 `next_probe_at` 已到期、fetch 会返 200 | 本次调用:fetchFn **未被调**、marker 未删、无任何结清,只把 `pending→accepted`;**下一次**调用才 POST 并 reconciled(Rule 0 的那一轮只做告警)。同样覆盖"已有 generalized completion receipt"与"session 已终态"两条提前结清路径:pending 时都不结清 |
| 8c | sink 未注入且账本 pending | 永远 `transient_failed`、不 POST、marker 保留(不得降级为 accepted) |
| 8d | accepted 改写 rename 失败 | `transient_failed`,账本仍 pending,下轮再试 |
| 9 | 写账失败(mock rename 抛错) | `transient_failed`,sink 0 次,marker 原样 |
| 10 | 畸形账本(非对象/缺字段) | 视作无账本,照常回放,并覆盖成合法账本 |
| 11 | **并发**:boot 与 heartbeat 同时调同一 exec,fetch 500 | fetchFn 恰 1 次;账本 streak=1;无 tmp 残留;再配合 fetch 200 的并发对照:marker 被删后不被复活 |
| 12 | 其它 4xx / 2xx 既有用例 | 逐字不变全绿 |

### 3.6 `HeartbeatService.monitor-loss.test.ts` + boot drain

- `held_for_lead` → `markerRetryPending` 含该 exec、不探活、crash reaper/orphan 被抑制(复制 `transient_failed` 用例改 outcome);
- `reconcileCompleteFailedMarkers`:`held_for_lead` 计 `held`、不 fallback、session 状态不变;
- `auto-qa-effects` 新 effect:`durableAlertAccepted` 为假时 throw;plugin 的 late-bound 回调在 holder 为空时 reject(类型检查 + 单测)。

## 4. 全仓门与真机验证

- `pnpm lint`(biome 全仓)+ `pnpm -r build` + `pnpm test:packages:run`;定向先跑 3.1–3.6 文件。宿主既有例外(headless Terminal.app / Vitest worker RPC timeout)如实留证,不伪报整门全绿。
- **529 QA 房真机**(独立 QA 节点执行):
  1. `simple_code` run:implement 完成 → 不跑 qa,直接 operator rework 指 implement(模拟 deadend-⑮)→ implement/2 `complete --route needs_review` → 期望 200、qa/1 被 fresh 派发、Bridge log 有 `rework_verification_fresh_dispatch`;qa 完成 → gate 卡出现。
  2. 不变量路径(决策边界):qa→gate 前用 SQL 把 delivery 置 `completed` → `flywheel-comm qa-result` 得 **409 `engine_invariant:…`**(runner 屏幕能看到名字)、alerts 房恰 1 条;QA runner 写的是 `~/.flywheel/state/qa-result-failed/<exec>.json`(无读者,本单不动),按协议回报 Lead。
  2b. 不变量路径(completion 边界):implement 节点制造 `workflow_rework_verification_step_missing_chain`(activePath 在、边不匹配)→ `complete` 得 409、alerts 恰 1 条、`complete-failed` marker 落盘;Bridge 重启 → boot drain 日志 `held`、marker 仍在、不隔离、alerts 不增;1h 后自动慢探一次。
  3. 5xx 路径:让 slot Bridge 的 loopback 指向返回 500 的 stub(或在 slot 上临时坏一张表)→ 3 次后 alerts 恰 1 条、日志显示 `next_probe_at` 递增;恢复后 ≤ 下一探针自动 reconciled。
- 生产观察项(ship 后):FLY-1847 / FLY-1859 / FLY-1814 的折入体到达 implement complete 时零 500、qa 自动起。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| fresh 分支漏掉某个依赖 `chainedRework===true` 的副作用 | 分支顺序 gate → fresh → chained;`chainedRework` 其余 6 处引用全在 `reworkAuthority` 守护块内(research §1.1 行号);3.1-6 首次覆盖链式路径 |
| 嵌套事务语义 | better-sqlite3 `transaction(fn)()` 嵌套 = SAVEPOINT,内层抛出只回滚到 savepoint;3.3-7 专门断言 |
| reason 前缀编码被别处误解析 | 前缀为新增常量;仓内现有对 `transition.reason` 的消费只做透传/记录;grep 确认无 `=== "…"` 精确匹配会因此改变分支 |
| 账本与 runner 并发写 marker | runner 只在 exit 前写一次;reconciler 只在 marker 出现后才动;tmp+rename 保证读到完整 JSON;进程内单飞消除 boot/heartbeat 互踩 |
| 未知 5xx 永远每小时探一次 | 这是刻意选择(体不能证明确定性);第 3 次告警让 Lead 知情;根因修复后自动收敛;真要放弃走 2.4 |
| `engine_invariant` 让 session 永久 running 等 Lead | needs_lead 的定义;告警文案给出恢复路径;与 FLY-1612 "第 5 次转 needs_lead" 同姿态 |
| late-bound 告警 sink 在 boot drain 时未就绪 | reject → `pending` → 下一轮 heartbeat 重试;不会静默丢 |

## 6. 文档/里程碑

- 本 PR 末 commit:CLAUDE.md 里程碑一行(FLY-1912)+ 本文件夹随分支合入。
- 不动 `doc/engineer/plan/*` 状态目录(doc-flow:进度只看 Linear)。

## 7. Codex design review R1 折入记录

| # | R1 意见 | 处置 |
|---|---|---|
| 1 | 类型化边界漏 `submitWorkflowDecisionByCredential`(qa→gate 走决策路由);§3.2-1 用例到不了目标 CAS | **采纳**:转换下沉到 `commitWorkflowTransitionTx` 自身边界,6 个调用方全自动;告警在两个 HTTP 边界;3.3-1 改走决策路由 |
| 2/9 | 5xx 体恒定,摘要断路不成立;改耐久退避+半开 | **采纳**:按 FLY-1648 模式退避 1m…1h 封顶,第 3 次告警一次/episode;去掉"永久开路" |
| 3 | 告警耐久性:开路先于告警;outbox 失败后 reconciler 不接力 | **采纳**:账本记 `alert_event_id/alert_state`,pending 时只重试告警;409 带 `alertPending` 让 reconciler 接力,eventId 同形去重 |
| 4 | boot/heartbeat 并发 RMW 与 tmp 复活 | **采纳**:进程内单飞 + 唯一 tmp + 写账失败不告警;3.5-11 |
| 5 | buildSha 类型/接线顺序/回调载荷不足 | **采纳**:删 buildSha;late-bound holder;类型化 `CompleteMarkerHeldAlert`;union 更新 |
| 6 | 需要 dispatcher 级回归 + 诊断形状断言 | **采纳**:3.2 + 3.1-1 route≠path 断言 |
| 7 | 恢复文案删 marker 会丢证据;unknown build 永不复位 | **采纳**:2.4 重写;无 buildSha 概念 |
| 8 | 测试路径错(在 `src/__tests__`)、缺 effects/接线/并发用例 | **采纳**:路径改正;3.5-9~11、3.6 补齐;顺序 §3 开头 |

### R2 折入

| # | R2 意见 | 处置 |
|---|---|---|
| 1 | 决策边界告警无人接力(`qa-result-failed` 无读者);无身份被误报为 accepted | **采纳(结构性)**:拒绝事件 + 告警入队同一小事务,失败即 500(无半状态);两个 HTTP 边界身份永不为空(`resolveWorkflowRunAlertIdentity` fallback);`alertPending` 重定义为"无耐久回执"(仅无身份时);`qa-result-failed` 无读者如实写明、不假装能重放;§4 改名真实 marker 与 owner |
| 2 | `alert_state=pending` 没有压倒到期探针/提前结清 | **采纳**:第 0 条规则:pending 先于一切 POST/结清/隔离;sink 缺失=失败;先写 pending 后告警、收 accepted 再改写;3.5-8b/8c/8d |
| 3 | 到期探针撞网络/429 后退化回心跳频率 | **采纳**:有账本时按当前封顶延迟推后 `next_probe_at`,streak 不变;无账本 legacy 不变;3.5-5b |

### R3(APPROVED)非阻断备注折入

| # | 备注 | 处置 |
|---|---|---|
| 1 | §2.2 "事务失败后落 marker 进 ③"要按边界限定(`qa-result-failed` 不进 ③) | 已改写 |
| 2 | `resolveWorkflowRunAlertIdentity` 在 plugin.ts,event-route 不得反向 import;加接线断言 | 已写入 §2.2;实现时抽独立模块或经 `createEventRouter` 注入 |
| 3 | pending→accepted 那一轮不得 POST/结清 | 3.5-8b 已精确化 |
