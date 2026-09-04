# FLY-2268 工人常驻收信与完成前清信(M3) — 调研
Issue: FLY-2268 (https://linear.app/geoforge3d/issue/FLY-2268/引擎loop稳定性-fly-2248-b-工人常驻收信与完成前清信m3常驻宽限-turn-边界-durable-状态-drain)
日期: 2026-09-03
基于: exploration.md;母单 `engineering/doc/FLY-2248-generic-delivery-contract/research.md` §2、§5;母单 plan round 5(git `0dac08247`)§M3

本调研只回答「round 5 的每句话在 HEAD `e85eec9a8` 上落在哪一行、要改成什么」。行号全部 2026-09-03 实测。

## 1. 收信员:所有权收归 supervisor

### 1.1 现状接线(要被拆掉的)

| 位置 | 现状 | 改后 |
|---|---|---|
| `CodexTmuxAdapter.ts:1025-1050` | `ctx.phaseKeepAlive` → `transport.createReceiver()` 建 watcher → 塞给 `phaseLifecycleFactory({..., watcher})` | 不建 watcher;`phaseLifecycleFactory` 不再收 `watcher` 参数 |
| `codex-phase-lifecycle.ts:372-426 confirmHoldPaused()` | 挂 `onDelivered` + `watcher.start()` | 只写 hold state `paused`;不碰 watcher |
| `:441-452 leaveHold()`、`:274-280 stopIntake()` | `watcher.stop()` | 不碰 watcher(`stopIntake` 保留名字,变成 no-op 兼容或删除——见 §7 dead code) |
| `CodexWakeWatcher` 接口(`:24-29`) | runtime 侧类型 | 迁到 supervisor 侧;runtime 不再依赖 |

`onDelivered` 里的两条入队路径(`enqueueRunnerPhaseWake` 普通信;`enqueueRunnerDoorbellWake` 批次门铃,`flywheelId` 以 `mailbox-batch:` 开头)与 `mailboxAgentName` 收件人校验**原样搬到 supervisor**,不改语义。

### 1.2 `ResidentReceiverSupervisor`(新,`packages/teamlead/src/bridge/resident-receiver-supervisor.ts`)

- 键:`execution_id`。候选集 = StateStore `getReadoptCandidateSessions()`(`StateStore.ts:9090-9093`,status ∈ running/ship_parked/awaiting_review/design_done/approved_to_ship)∩ `workflow_execution_binding.mode ∈ {spawn, wake, replacement}`(`:2935-2946`)且 CommDB `sessions.phase_keep_alive = 1`(`db.ts:118`)。
- transport 解析:`store.getSession(exec).adapter_type` → `EXECUTOR_TO_TRANSPORT`(`role-adapter-resolver.ts:54-61`)→ `transport.capabilities().wakeMode`:`builtin-receiver`(claude)→ 不武装;`external-watcher`(codex)→ 武装;`push-only`/`none` → `receiver_unsupported` 事件一次,不告警。
- 武装时机(三处,均只调 `arm(executionId)`,幂等):
  - (a) dispatcher admission 成功:`workflow-engine-dispatcher.ts:2742` `startDispatcher.start()` 成功返回处;
  - (b) `codex-session-reown.ts:408` `record("reown_watch_started")` 与 `:640` `record("reown_revive_succeeded")`——supervisor 作为 `record` 的订阅者(plugin 里 `record` 已是闭包,追加一行分发),**不改** `CodexSessionReownDeps` 形状;
  - (c) boot pass:`plugin.ts:7590` 维护 tick 0 已取 `codexCandidateSnapshot`,supervisor 复用同一快照。
- 到件分派(§2.3 的 CommDB 事务)。
- 心跳:骑 GatePoller 60s rider(`gate-poller.ts:653-660` 同款 `(tickCount-1) % N === 0`),对每个 armed receiver 调 `health()`(`IMailboxWatcher.health → {ok, lastEventTs?, pendingCount?}`,`types.ts:199-217`),快照进内存 + StateStore `session_events(event_type='receiver_heartbeat')`(`StateStore.ts:3335-3346`,每 execution 每 5 分钟限流一条)。
- 分类器 `classifyReceiver(snapshot, thresholds)`(纯函数,`resident-codex-lead-patrol.ts:439+` 同构):`healthy | starting | receiver_missing | receiver_stalled | unsupported`。`receiver_missing` = 候选集里有、supervisor 没有 armed 实例(Bridge 重启后典型);`receiver_stalled` = `health().ok === false` 或 `lastEventTs` 落后 `lastPollTs` 超过 `RECEIVER_STALL_MS = 180_000`(常量)。
- episode:每 episode 至多一次进程内重武装(`watcher.stop(); createReceiver(); start()`)+ 一次告警;连续 3 次 `receiver_stalled` 才升级;`receiver_armed{source: admission|reown_watch|reown_revive|boot|rearm}` 事件写 StateStore `session_events`。零 OS 信号,不进 kill-ledger。
- disarm:session 终态 / supersede / replacement(`workflow_execution_binding` 换 execution)/ run terminate。

## 2. durable turn 状态(CommDB `three_stage_turn`)

### 2.1 加列迁移

`db.ts:1235-1257` 既有循环 `for [name, sqlType] of [...]` 追加两项 `["active_turn_id","TEXT"]`、`["turn_generation","INTEGER NOT NULL DEFAULT 0"]`。`WorktreeTurn`(`db.ts:346-356`)加 `active_turn_id: string | null`、`turn_generation: number`;`getTurn`(`:5470-5510`)显式列名 SELECT 加两列,其 `no such column` 兜底分支补默认值 `null / 0`;`readPatrolTurnSnapshot.requiredColumns.three_stage_turn`(`:5522-5531`)**不加**(巡逻不需要,避免旧库判缺列)。

### 2.2 `grantTurn` 两处 upsert(Lead 定义 #3 + R5 ⑤)

| 分支 | 位置 | INSERT 列 | `ON CONFLICT DO UPDATE` 追加 |
|---|---|---|---|
| source(workflow) | `db.ts:5355-5375` | `turn_generation` 写 **1**,`active_turn_id` NULL | `active_turn_id = NULL, turn_generation = three_stage_turn.turn_generation + 1` |
| legacy | `:5437-5450` | 同上 | 同上 |

同一事务(两分支都已在 `this.db.transaction` 内)追加:`UPDATE runner_phase_wakes SET admission_state='queued' WHERE execution_id = <旧 holder_exec_id> AND admission_state='deferred_midturn'`(旧 holder 变非持棒,其 deferred 行全部提升)。旧 holder 从 upsert 前的 `current` 读(source 分支 `:5320-5326` 已读;legacy 分支要先 SELECT 一次)。

### 2.3 `onTurnStarted / onTurnCompleted`(CommDB 新方法 + runtime 回调)

```sql
-- onTurnStarted({executionId, turnId}) → {ok:true, turnGeneration} | {ok:false, reason:'not_holder'|'already_active'}
UPDATE three_stage_turn SET active_turn_id = ?
 WHERE issue_id = ? AND holder_exec_id = ? AND active_turn_id IS NULL;
-- 0 rows 且行的 holder ≠ executionId → not_holder;holder = executionId 且 active_turn_id 已非空 → already_active(幂等 0 rows)
-- onTurnCompleted({executionId, turnId}) → {ok:true, promoted:n} | {ok:true, noop:true}
UPDATE three_stage_turn SET active_turn_id = NULL
 WHERE issue_id = ? AND holder_exec_id = ? AND active_turn_id = ?;   -- 命中才继续
UPDATE runner_phase_wakes SET admission_state = 'queued'
 WHERE execution_id = ? AND admission_state = 'deferred_midturn' AND turn_generation <= ?;
```

- `issue_id` 来源:CommDB `sessions.issue_id`(`db.ts:6580 registerSession` 已写),方法内 JOIN 取,调用方只传 executionId。
- runtime 挂点(`codex-daemon-client.ts`):`claimTurnDispatch`(`:790-816`,`ownedTurnIds.add(claimedTurnId)` 之后)调 `deps.onTurnStarted`;`applyOwnedTurnCompletion`(`:749-763`,owned turn 的 `turn/completed`)调 `deps.onTurnCompleted`,**await 完成后**才继续 goal 循环(下一次 `startTurn` 前一定可见)。两回调经 `CodexDaemonAdapterDeps`(`CodexTmuxAdapter.ts:429-480`)注入,Bridge 在 `run-infra.ts:655-672` 提供实现(打开 per-project CommDB 调 §2.3 方法)。回调抛错 → 记 diagnostic、不阻断 goal(fail-open:最坏情况 = 到件按 `queued`,回到现状)。
- 到件分类(supervisor 在 §1.2 的 `onDelivered` 内,一个 CommDB 事务):读 `three_stage_turn WHERE issue_id = <sessions.issue_id>`;`holder_exec_id = executionId AND active_turn_id IS NOT NULL` → `enqueueRunnerPhaseWake(..., {admissionState:'deferred_midturn', turnGeneration: g})`;否则既有路径(`admission_state` 由后续 admission 置 `queued`)。**非持棒 execution 一律 `queued`**。
- `runner_phase_wakes` 加列 `turn_generation INTEGER`(`db.ts:1268-1275` 既有 `first_push_at` 同款 `ALTER TABLE ADD COLUMN`);`admission_state` 值域(`:594-598`)加 `'deferred_midturn'`。

### 2.4 `admission_state` reader 矩阵(HEAD 实测 8 处)

| 位置 | 方法 | 对 `deferred_midturn` 的行为 |
|---|---|---|
| `db.ts:4226` | `listPendingRunnerReceiptWakes` | `= 'queued'` 过滤 → 不可见(不推送) |
| `:4301`、`:4336` | push claim | 不可见(不 claim) |
| `:4427` | `markRunnerPhaseWakesStarted` 批量 started | 不可见(不被 turn 边界 ACK 误吞) |
| `:4494` | t2 claim | 不可见 |
| `:4561` | terminal disposal | 不可见(除 founder origin,沿用) |
| `:4627` | `disposeRunnerPhaseWakeForTerminal` | `admission_state = 'queued' OR ? = 1`——终态清理时按 `? = 1` 强制路径一并收;**测试锁**:terminal 清理必须也处理 deferred 行(否则 session 终结后残留) |
| `:7119-7122` | prune | `admission_state IS NULL OR …IN ('suppressed_cap','skipped_no_transport')`——deferred 行不被 prune(与 `queued` 同),正确 |
| `codex-phase-lifecycle.ts:291-293` | runtime `observe()` 取第一条 `state !== 'finished'` | **要改**:加 `admission_state !== 'deferred_midturn'`,否则 held loop 会把 mid-turn 信当 wake |

## 3. loop 目标常驻宽限

### 3.1 `loopTarget` 贯穿链(逐点)

| 环节 | 位置 | 改动 |
|---|---|---|
| 判据 | 新 `isLoopTargetNode(snapshot, nodeId)`(放 `packages/teamlead/src/workflow-menu.ts` 旁的纯函数) | `snapshot.manifest.loops.some(l => l.to === nodeId)`;`WorkflowMenuLoop.to`(`workflow-menu.ts:48-56`) |
| dispatcher | `workflow-engine-dispatcher.ts:2742-2750` | `startDispatcher.start({..., loopTarget: isLoopTargetNode(snapshot, node.id) ? { nodeId: node.id } : undefined})`;**不再**借 `shareParentBranch` |
| StartRequest / RunDispatcher / BlueprintContext | 三个类型加可选 `loopTarget?: { nodeId: string }` 透传 | 无逻辑 |
| Blueprint | `Blueprint.ts:1622-1634` | `phaseKeepAlive = ctx.loopTarget ? { loopTarget: true, nodeId: ctx.loopTarget.nodeId } : undefined`;删 `isCodexRunner &&` 与 role 三分支 |
| adapter-types | `adapter-types.ts:210` | `phaseKeepAlive?: { loopTarget: true; nodeId: string }` |
| Codex launch snapshot | `CodexTmuxAdapter.ts:198-212, 355-375, 955-970` | `launchContext` 加 `loopTargetNodeId: string \| null`;`phaseRole` 字段**保留但只写 null**(schemaVersion 不动);`parseCodexLaunchSnapshot` 兼容:`loopTargetNodeId` 缺失且 `phaseRole !== null` ⇒ `loopTargetNodeId = '<legacy>'`(哨兵,表示「旧体、常驻但 nodeId 未知」) |
| capabilityDigest | `:414-427` | `phaseRole` 项换成 `loopTargetNodeId`;旧 snapshot 的 digest 因此**必然不等** → 漂移检查 `:920-935` 对 legacy 哨兵放行 `phaseRole/loopTarget` 这一项(其余项照旧) |
| reown 重建 | `codex-session-reown.ts:221` | `launch.loopTargetNodeId ? { phaseKeepAlive: { loopTarget: true, nodeId } } : {}` |
| run-infra env 回填 | `run-infra.ts:217-221` | `sessionRole/chatThreadRole` 不再从 `phaseKeepAlive.role` 取(它已不存在);改从 `input.context.sessionRole`(BlueprintContext 已有)取 |
| Claude completion | `StateStore.ts:44343-44360` `workflowCompletionDispositionForContext` | 加分支:`isLoopTargetNode(context.snapshot, binding.node_id)` 且非 runner_ship carrier → `loop_park`(优先级低于 `runner_ship_park`,高于 `engine_gate_handoff/terminal_no_gate`,因为 ship carrier 的 park 已含 poller) |
| PhaseHoldState | `codex-phase-lifecycle.ts:32-39, 66-86` | `schemaVersion: 2`,去 `role`,加 `nodeId`、`residentRevision`、`graceExpiresAt`;`assertValidPhaseHold` 接受 v1(只用于读旧文件)与 v2 |

### 3.2 `workflow_resident_hold`(StateStore 新表)

```sql
CREATE TABLE IF NOT EXISTS workflow_resident_hold (
  execution_id     TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  attempt          INTEGER NOT NULL CHECK (attempt > 0),
  activation_id    TEXT NOT NULL,
  vendor           TEXT NOT NULL CHECK (vendor IN ('codex','claude-code')),
  revision         INTEGER NOT NULL CHECK (revision > 0),
  boundary_seq     INTEGER NOT NULL CHECK (boundary_seq > 0),
  state            TEXT NOT NULL CHECK (state IN ('resident','woken','expired','closed')),
  grace_started_at TEXT NOT NULL,
  grace_expires_at TEXT NOT NULL,
  closed_reason    TEXT,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES workflow_actor(execution_id)
);
CREATE INDEX IF NOT EXISTS idx_wrh_expiring ON workflow_resident_hold(state, grace_expires_at);
```

`RESIDENT_GRACE_MS = 30 * 60_000`(`packages/teamlead/src/bridge/resident-hold.ts` 常量导出,与 `delivery-contract/policy.ts` 同风格)。

方法(全部 StateStore 事务内 CAS):

| 方法 | CAS | 结果 |
|---|---|---|
| `enterResidentHold({executionId, activationId, nodeId, boundarySeq, now})` | 无行 → INSERT `resident, r=1`;`woken(r)` 且 `boundary_seq < 本次` → `resident, r+1`,新 deadline;`resident` 且同 activation/boundary_seq → 返回原 revision/deadline(幂等 adopt);其余(`expired`/`closed`/activation 不符)→ `{ok:false, reason}` | `{ok:true, revision, graceExpiresAt}` |
| `closeResidentHold({executionId, revision, reason})` | `revision` 相符且 state ≠ closed → `closed{reason}`;不符 → no-op `{ok:true, noop:true}` | 收口 |
| `wakeResidentHold({executionId, revision})` | `resident(r) → woken(r)` | 赢/输 |
| `expireResidentHoldsTx(now)` | `resident AND grace_expires_at < now` → `expired` + INSERT `workflow_delivery_operation(kind='resident_expiry', client_request_id='resident-expiry:<exec>:r<r>', state='staged')` | 由 saga 驱动 |

`vendor` 的来源:StateStore `sessions.adapter_type` → `EXECUTOR_TO_TRANSPORT`(与 §1.2 同一映射)。

### 3.3 Codex seam(`residentHold.enter/close` 经 `CodexDaemonAdapterDeps`)

- `codex-daemon-client.ts:1292-1301 settleTerminal`:`phase && status === "complete"` 改为 `phase && status === "complete" && loopTarget`(`loopTarget` 从 `phaseKeepAlive` 传进 `RunGoalInput`);进入前先 `await deps.residentHold.enter({executionId, activationId, nodeId, boundarySeq})`,`boundarySeq` = runtime durable session state 里的 `goalCompletions` 计数(session.json 新字段,`atomicMergeCodexSessionState` 写;缺失视为 1);`{ok:false}` → 不 hold,走原 terminal。成功 → `phase.enterHold(budget, {nodeId, residentRevision, graceExpiresAt})`(v2);本地写盘抛错 → `deps.residentHold.close({executionId, revision, reason:'local_hold_failed'})` 补偿 → 原 terminal。
- held loop(`:1486-1500`):每轮除 `observe()` 外还检查 (i) `getRunnerShutdown*` 任意 `requested` 行(§4 多 pending 规则)(ii) 本地 `phaseHold.graceExpiresAt <= now`——命中 (ii) 但没有 shutdown 行时**不**自行退出(权威 owner 是 Bridge tick),只把 `waitForActivity` 超时压到 ≤ 60s 以便快速看见 shutdown 请求。**只有 shutdown 行才退出**,退出即 ACK。
- `reactivateWake`(`:1007-1066`)成功后 → hold state 清除(既有 `leaveHold`),**不**调 `residentHold`(Bridge 侧 `wakeActor` 已 CAS 到 `woken`)。
- Bridge 重启 reown `watch` 分支:`codex-session-reown.ts:406-413` 处若 StateStore 有该 execution 的 `resident` 行而本地 `session.json` 无 `phaseHold` → 用同 revision 重建本地 hold(adopt),`record("reown_resident_adopted")`。

### 3.4 wake 前置 CAS

`plugin.ts:10641`(rework 协调器)与 `:10775`(ship carrier)两个 `wakeActor` 实现开头:`store.wakeResidentHold({executionId, revision: currentRow.revision})`;无行 → 直接走既有;输(已 `expired/closed`)→ `{ok:false, error:'resident_hold_expired'}` → 协调器按既有 `wake_failed:*` 路径进入换体判据。`classifyPhaseActorReentry`(`phase-actor-reentry.ts`)**不改**;母单 A4「判死先问送达」已由 FLY-2278 落地。

### 3.5 expiry saga(`kind='resident_expiry'`,`DeliveryOperations.runPass` 内第三段)

| barrier | 动作 | 幂等证据 |
|---|---|---|
| staged | `expireResidentHoldsTx(now)`(§3.2) | `client_request_id` UNIQUE |
| → applied | Codex:`commDb.requestRunnerShutdown(executionId, requestId, now)`;插入前对同 execution 的 `failed` 行 set-once `settlement_reason='superseded:<requestId>'`;Claude:`killTmuxWindow(session.tmux_session)` + `closeRunnerTerminalView`(`post-merge.ts:16-32` 同款;pane 已不在即成功) | Codex:exact request 行存在;Claude:pane gone |
| → sent | Codex:`getRunnerShutdownRequest(executionId, requestId).state === 'acked'`;Claude:`probeRunnerProcessLiveness(session.tmux_session)` ∈ {dead_pin, absent}(`plugin.ts:10570-10573` 同款) | 可重复观察 |
| → projected | `closeResidentHold({revision, reason:'expired'})` + run event `resident_hold_expired` | event uid `resident_expiry:<exec>:r<r>` |
| failed | Codex 行变 `failed`(runtime ACK 失败)→ operation `failed` + `delivery_operation_stalled:<operation_id>`(**沿用母单前缀,不新增**) | — |

每 tick 重驱所有 `expired` 且 operation ∉ {projected, failed} 的行;CommDB 打不开 → 本 tick 跳过。stall 告警沿用 `alertStalledWorkflowDeliveryOperations`(`StateStore.ts:38510`)。

## 4. `runner_shutdown_controls` 重建 + exact-request 合同(R5 ③)

### 4.1 DDL 与迁移

```sql
CREATE TABLE runner_shutdown_controls_fly2268 (
  execution_id      TEXT NOT NULL,
  request_id        TEXT NOT NULL,
  state             TEXT NOT NULL CHECK(state IN ('requested','acked','failed')),
  requested_at      INTEGER NOT NULL,
  finished_at       INTEGER,
  error             TEXT,
  settlement_reason TEXT,
  PRIMARY KEY (execution_id, request_id)
);
INSERT INTO runner_shutdown_controls_fly2268 (execution_id, request_id, state, requested_at, finished_at, error)
SELECT execution_id, request_id, state, requested_at, finished_at, error FROM runner_shutdown_controls;
DROP TABLE runner_shutdown_controls;
ALTER TABLE runner_shutdown_controls_fly2268 RENAME TO runner_shutdown_controls;
CREATE INDEX idx_rsc_pending ON runner_shutdown_controls(execution_id, state, requested_at);
```

触发条件:`sqlite_master.sql` 不含 `PRIMARY KEY (execution_id, request_id)`(`db.ts:1155-1190` sessions 重建同款);行数守恒断言;`request_id` 全局 UNIQUE 约束**去掉**(同 execution 内由主键保证;跨 execution 撞名的既有测试 `db.test.ts:1177-1181` 改为期望「允许」——`land-cleanup` 的 `<operation_id>:<execution_id>` 与 `resident-expiry:<exec>:r<r>` 本来就带 execution,不会跨撞)。

### 4.2 读写合同

| 方法 | 语义 |
|---|---|
| `requestRunnerShutdown(executionId, requestId, nowMs)` | `INSERT OR IGNORE` 后**按 (execution_id, request_id) 读回**(不再按 execution 读第一行) |
| `getRunnerShutdownRequest(executionId, requestId)`(新) | exact 一行或 null |
| `listPendingRunnerShutdowns(executionId)`(新) | 全部 `requested`,`ORDER BY requested_at, request_id` |
| `getRunnerShutdown(executionId)`(保留) | 最早 pending;无 pending → 最新一行(按 `requested_at DESC`);无行 → null |
| `finishRunnerShutdown(executionId, requestId, result, nowMs)` | 不变(已 exact) |
| `finishAllPendingRunnerShutdowns(executionId, result, nowMs)`(新) | 事务内对全部 `requested` 行逐行 finish,返回 requestIds |
| `settleFailedRunnerShutdowns(executionId, reason)`(新) | `UPDATE … SET settlement_reason = ? WHERE state='failed' AND settlement_reason IS NULL`(set-once) |

### 4.3 caller sweep(HEAD 全集,逐个处置)

| caller | 现状 | 处置 |
|---|---|---|
| `codex-phase-lifecycle.ts:289 observe()` | `getRunnerShutdown` 单行 `requested` | 改 `listPendingRunnerShutdowns()[0]`(最早 pending) |
| `:514 pollShutdown()` | 同上 | 同上 |
| `:493-506 ackShutdown(requestId)` | exact finish | 保留;新增 `ackAllPendingShutdowns(result)` 供 adapter 终态调用(`CodexTmuxAdapter.ts:1624` 处) |
| `codex-phase-shutdown.ts:207-212` | 无行则铸 `randomId()`;`:241` 轮询按 execution | 铸新行仍可(主键允许);轮询改 exact `getRunnerShutdownRequest(executionId, requestId)`;「先看有没有 pending」改 `listPendingRunnerShutdowns()[0]` |
| `land-cleanup-opportunity.ts:33,48` | 请求 `<op>:<exec>`;观察按 execution `acked` | 观察改 exact(自己的 requestId) |
| `shipped-husk-escalation.ts:263-270` | 只读证据 `getRunnerShutdown` | 保留(语义「最新一行」足够) |
| `runner-shutdown-evidence.ts:10-15`、`lib.ts:42` | 类型 | 加新方法签名 |
| `db.ts:6964`、`:7076` prune | `DELETE WHERE execution_id` | 不变(按 execution 整体清) |
| 测试 7 文件 | 见 exploration §2.2 | `db.test.ts:1155-1159`「second request is ignored」改为「second request is its own row」;其余按新语义微调;新增三种旧状态测试(§5) |

### 4.4 runtime 多 pending 规则(对 R5 ③ 的回答)

held loop 观察到**任意** `requested` 行即进入受控关停;关停 ACK 时**一并 ACK 该 execution 全部 pending 行**(`finishAllPendingRunnerShutdowns`)。因此:saga 只看自己 request_id 的行,也一定在同一次退出里被 ACK;旧 `requested`(如 land-cleanup 尚未 ACK)与新 expiry 同时 pending → 一次退出两者都 acked;旧 `acked` 行不影响插入;旧 `failed` 行由 saga 先 `settleFailedRunnerShutdowns` 关闭后跳过,不阻塞。

## 5. 完成前清信

### 5.1 event route(唯一 CommDB 读者)

`event-route.ts:986` `commitEnrolledCompletion` 之前插入:

1. 读 CommDB(`CommDB.openReadonly`,已有 `:129` 同款):该 execution 的 mailbox 行 `to_agent = execution_id AND state IN ('QUEUED','LEASED')`(`db.ts:1977` 同款条件)+ `runner_phase_wakes state='pending' AND admission_state IN ('queued','deferred_midturn')`。读失败 → `409 {error:'workflow_completion_rejected', reason:'completion_deferred_pending_mail', detail:'commdb_unreadable'}`。
2. 集合非空且 payload 无 `drainReceipt` → `store.issueDrainChallenge({executionId, activationId, businessDigest, mailSet, watermark, now})` → `409 {error:'workflow_completion_rejected', reason:'consume_pending_mail', challengeId, mailbox:[ids], phaseWakes:[ids]}`。
3. payload 有 `drainReceipt: {challengeId}` → 再读 CommDB 核验 mail_set 内 mailbox 行 `state='ACKED'`、phase wake `state IN ('started','finished')` → `store.consumeDrainChallengeTx({challengeId, executionId, activationId, businessDigest, verification})`;通过 → CAS `issued → consumed`,继续原 `commitEnrolledCompletion`;不通过 → 409 `drain_receipt_rejected{unacked:[…]}` 并保持 `issued`。
4. `businessDigest` = `canonicalSubmissionDigest(payload 去掉 drainReceipt)`(`StateStore.ts:14` 既有 import)。

### 5.2 `workflow_completion_drain_challenge`(StateStore 新表)

```sql
CREATE TABLE IF NOT EXISTS workflow_completion_drain_challenge (
  challenge_id    TEXT PRIMARY KEY,
  execution_id    TEXT NOT NULL,
  activation_id   TEXT NOT NULL,
  business_digest TEXT NOT NULL,
  mail_set_json   TEXT NOT NULL,
  watermark_json  TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('issued','consumed','superseded')),
  issued_at       TEXT NOT NULL,
  consumed_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wcdc_issued_by_submission
  ON workflow_completion_drain_challenge(execution_id, activation_id, business_digest) WHERE state = 'issued';
```

`challenge_id = 'drain:<execution_id>:<activation_id>:<business_digest 前 16 位>'`(确定性,重试同 id)。

### 5.3 CLI

`complete.ts` 加 `--drain-receipt <challengeId>` → payload `drainReceipt: {challengeId}`;收到 409 `consume_pending_mail` 时打印 ids 与「读完后重跑 `complete … --drain-receipt <challengeId>`」;收到 `loop_park` disposition 打印「已 park 等待返工唤醒(30 分钟宽限);等 wake,勿自行轮询」(与 `:464-465` 同款)。

## 6. 回放测试与 R1

### 6.1 回放矩阵(本单三起 + #4 半边)

| # | 测试文件 | fixture | 断言 |
|---|---|---|---|
| 3 | `packages/claude-runner/test/fly2268-resident-receiver.test.ts` | 假 daemon transport 发真实 `turn/started(t1)`;supervisor `onDelivered` 收 response;`turn/completed(t1)`;下一次 `startTurn` | 到件行 `deferred_midturn, turn_generation=g`;`turn/completed` 后 `queued`;下一 turn 的 push claim 可见;lease 不过期(`mailbox` 行已 ACKED by enqueue) |
| 7 | `packages/teamlead/src/__tests__/fly2268-replay.test.ts` | 3 条 response QUEUED;`complete` | 409 `consume_pending_mail` + 3 id + challengeId;同业务重试同 challengeId;3 行 ACK 后 `--drain-receipt` 成功;任一未 ACK 拒绝;七个负例(错误/旧/他人 challengeId、mail_set 内未 ACK、同 challenge 二次 consumed 0 rows、CommDB 不可读、水位线后新信不阻塞) |
| 8 | 同上 | loop 目标节点 goal `complete`;10min 后 rework wake;再 complete;30min 后 tick | `resident r=1` → wake CAS 赢 → `reactivateWake` 同 thread 无换体 → `resident r=2` → expiry saga 四 barrier → shutdown exact 行 `acked` → `closed(expired)` → 此后 wake 输;mid-grace 重启(StateStore 有行、session.json 无 hold)→ reown adopt 同 revision → 到期仍发生 |
| 4(半边) | `fly2268-resident-receiver.test.ts` | Bridge 重启:候选集有、armed 无 | `classifyReceiver → receiver_missing` → 重武装 → `receiver_armed(source=reown_watch|boot)` 事件;≤1 个维护节拍 |

三种旧 shutdown 状态各一条:同 execution 已有 `requested`/`acked`/`failed` 行时,expiry 自己的 requestId 都到 `acked` 且 operation `projected`;`failed` 行 `settlement_reason='superseded:…'`。

### 6.2 R1 `turn/steer` 结论

- 协议证据(exploration §2.3):`codex-cli 0.153.2` app-server schema 含 `turn/steer {threadId, expectedTurnId, input[]}`。
- 本单口径:**不升级语义**。实现节点若要做,必须作为独立 commit,并附一条经真实 app-server 的阳性对照(steer 后模型输出中出现注入文本;`expectedTurnId` 用本单 `active_turn_id`);没有这条测试的 steer 代码不得合入。注释与 CLI 文案统一写「入队 + 下一 turn 边界必读」。

## 7. 风险与 dead code

- **`CodexPhaseRole` / `role` 字面量**:`codex-phase-lifecycle.ts:20, 32-39, 66-70` 的 `"design" | "implement" | "qa"` 在 v2 后只剩「解析 v1 旧文件」用途;A1 守卫扫描把 `assertValidPhaseHold` 的 v1 分支列为**允许的解析例外**(以函数名白名单表达,而非放宽正则)。旧 `Blueprint.fly887-keepalive-prompt.test.ts` 的三条 role 用例改为 loopTarget 用例。
- **`stopIntake()`**:去掉 watcher 后变空;保留为 no-op 一个版本(`CodexTmuxAdapter.ts:1562` 调用方不动)还是删除,在实现节点列「新增不可达代码」后问 Lead。
- **capabilityDigest 变更**导致在飞 Codex 体 Bridge 升级后被 reown 判「漂移」:§3.1 的 legacy 哨兵放行只对 `phaseRole/loopTarget` 项;其余项仍严格。上线窗口内在飞体只有本项目自己的 runner(自托管),可接受。
- **`turn_generation` 对 legacy 行为 0**:`onTurnStarted` 在 0 上照常置 `active_turn_id`,到件 `deferred_midturn(turn_generation=0)`,`onTurnCompleted` 的 `<= 0` 提升它——一致。
- **Claude expiry 靠 pane 消失**:`probeRunnerProcessLiveness` 返回 `indeterminate` 时 saga 停在 applied 并重驱;超过母单 `delivery_operation_stalled` 期限即告警(沿用前缀)。

## 8. Round 2 更正(闭合 Codex R1,2026-09-03;与前文冲突处以本节为准)

### 8.1 receiver 候选集与初次武装(R1#1)
- 候选集**去掉** `sessions.phase_keep_alive = 1` 这一交集:资格 = StateStore session 非终态(`getReadoptCandidateSessions()`)∩ `workflow_execution_binding.mode ∈ {spawn,wake,replacement}` ∩ `EXECUTOR_TO_TRANSPORT[adapter_type]` 的 `capabilities().wakeMode === 'external-watcher'`。`phase_keep_alive` 继续只服务 hold/doorbell fence(`db.ts:4072-4077 assertPhaseKeepAliveSessionRunning`),对 loop 目标为 1、非 loop 为 0,与 receiver 无关。
- 初次武装绑定 launch-commit receipt:`workflow-engine-dispatcher.ts:2816-2831` `waitForWorkflowLaunchOutcome` 成功之后调 `supervisor.arm(executionId)`;此时 CommDB `registerSession`(`CodexTmuxAdapter.ts:2271-2300`)可能尚未落行 → `arm` 把 execution 记为 `pending_registration`,每个 GatePoller rider 重试,直到 `sessions` 行可见再真正 `createReceiver().start()`;`receiver_armed{source:'admission'}` 只在 start 成功后写。
- 非 loop Codex 工人到件:同样 durable 落 `runner_phase_wakes`(mid-turn 为 `deferred_midturn`,边界为 `queued`);「下一 turn 边界必读」的执行者是 runtime 的 `turn/completed` 处理:`markTurnCompleted` 提升后读 `listRunnerPhaseWakes` 中 `pending AND queued` 行,有则以既有 `startTurn` 路径投递(与 held 态的 `reactivateWake` 同一段代码),无则让 goal 循环自行继续。这不是新机制,是母单 round 5「之后 runtime 才继续 goal 循环,所以下一次 startTurn 前一定可见」的执行者落点。

### 8.2 turn 回调 fail-closed + reown reconcile(R1#2)
- §2.3「回调抛错 → 记 diagnostic、不阻断 goal」**撤销**。`onTurnStarted/onTurnCompleted` 是 awaited barrier:CommDB 写失败 → runtime 进入 `turn_barrier_pending`:不 push wake、不 `startTurn`、held 不 `reactivateWake`,按 1s→2s→4s… 退避重试同一写,累计超过 `TURN_BARRIER_RETRY_MS = 60_000` → goal 以 `setup_failed` 类终态退出(母单欠条超时兜底接管),事件 `turn_barrier_failed`。
- 「不能确认 CommDB 状态时退化为 queued」**撤销**:supervisor 到件分类读不到 `three_stage_turn` 行 → 到件仍落 `runner_phase_wakes`,但 `admission_state` 留 NULL(既有语义 = 未 admission),由下一次成功的 `markTurnStarted/markTurnCompleted` 或 reconcile 统一置值。
- reown reconcile(`codex-session-reown.ts:406-413` watch 分支与 `:631-641` revive 成功后、supervisor 武装**之前**):调既有 `thread/read(includeTurns:true)`(`codex-daemon-client.ts:461-468`),取该 thread 最后一个 turn:状态进行中 → `UPDATE three_stage_turn SET active_turn_id=<turnId> WHERE holder_exec_id=? AND (active_turn_id IS NULL OR active_turn_id=<turnId>)`;已完成/无 turn → `markTurnCompleted` 语义(清 id、提升 `deferred_midturn(≤g)`、把 `admission_state IS NULL` 的 pending 行置 `queued`)。reconcile 失败 → 不武装、记 `reown_turn_reconcile_failed`,下 tick 重试。
- 回放:外部 turn 已开始、`markTurnStarted` 前崩溃;completion 在 Bridge 停机期间发生;两回调 CommDB 暂不可写(退避后成功 / 超时终态)。

### 8.3 drain 与 completion 同事务(R1#3)
- §5.1 第 3 步改为:event route 核验后**不**单独调 `consumeDrainChallengeTx`,而是把 `{challengeId, verification}` 作为 `commitEnrolledCompletion(input.drainChallenge)` 传入;StateStore 在既有 `this.db.transaction`(`StateStore.ts:45109+`)内、插 completion 之前做 CAS `issued→consumed`(0 rows → 整个事务回滚,返回 `{ok:false, reason:'drain_challenge_not_issued'}`);事务失败 → challenge 仍 `issued`,重试可再消费;事务成功后响应丢失 → 重试命中既有 completion 幂等分支(`:44880-44925`)返回同 eventUid。
- `completionSubmission` 必须是剥离 `drainReceipt` 后的业务 payload:event route 在调用前 `const { drainReceipt, ...business } = payload`,`completion_submission_digest` 只对 `business` 求值(`:45017-45026` 的 digest 计算前);带/不带 receipt 的同业务重放因此同 digest。

### 8.4 launch snapshot:digest 不变、nodeId 从 binding 还原(R1#4)
- §3.1 表中「`capabilityDigest` 项换成 `loopTargetNodeId`」与「`'<legacy>'` 哨兵」**撤销**。`capabilityDigest`(`CodexTmuxAdapter.ts:414-427`)键集合与算法不变,`phaseRole` 键继续参与、新体固定写 `null`;`launchContext.phaseRole` 字段保留(新体 null),新增非 digest 字段 `loopTargetNodeId`(仅诊断)。
- 漂移检查(`:920-935`)的 `phaseRole` 比对项改为「snapshot 存的 `phaseRole` 与 rehydrated ctx 推出的 `phaseRole`」——新二进制的 ctx 不再有 role,该项比对 `snapshot.launchContext.phaseRole` 与 `null`:旧 snapshot(`'implement'` 等)会不等 → 这一项**单独放行**(只影响 role 项;digest、cwd、model、roots 等照旧严格),并记 `reown_legacy_phase_role_ignored`。
- reown 的 `phaseKeepAlive` 重建(`codex-session-reown.ts:221`)不看 snapshot 字段:`binding = store.getWorkflowExecutionBinding(executionId)`,`loop = isLoopTargetNode(pinnedSnapshot(binding.run_id), binding.node_id)` → `loop ? { loopTarget:true, nodeId: binding.node_id } : undefined`;无 binding(非 generalized 体)→ undefined。
- 双向测试三条(plan A3(j))。

### 8.5 CommDB 迁移前在线备份(R1#5)
- HEAD 上 `CommDB` 构造器直接跑 schema 与 `BEGIN IMMEDIATE` 迁移(`db.ts:1034-1089`),没有备份;`backupCommDb`(`mailbox-migration.ts:1287-1317`,WAL-safe online backup)只被 FLY-1572 专项使用。本单把它接进 `runner_shutdown_controls` 重建的 preflight:检测旧 PK → `backupCommDb(dbPath, `${dbPath}.pre-fly2268-${iso}.bak`)` → 对备份文件 `PRAGMA quick_check` → `ok` 才在事务内重建;任一步失败 → 抛错,构造器失败,Bridge 不启动(fail-closed)。恢复命令与冻结窗口见 plan §4。

### 8.6 `phaseKeepAlive` 消费者全集(R1#6)
| 位置 | 现状 | 改动 |
|---|---|---|
| `Blueprint.ts:1640-1649` | 计算(role 三分支) | `ctx.loopTarget ? {loopTarget:true, nodeId} : undefined` |
| `:2490-2509`、`:2519-2525` | prompt 文案 `${phaseKeepAlive.role}` | 文案角色词取 `ctx.sessionRole`(BlueprintContext 已有),常驻语句只看 `phaseKeepAlive` 是否存在;用例:非三阶段名称的 loop 目标 prompt 不含 `undefined` |
| `:2855` | 透传 | 不变 |
| `adapter-types.ts:205-210` | 类型 `{role}` | `{loopTarget:true; nodeId:string}` |
| `CodexTmuxAdapter.ts:1039-1049` | `role: ctx.phaseKeepAlive.role` 传 factory | 去掉 `role`;传 `nodeId` |
| `:420, 967` | snapshot `phaseRole` | 写 `null`;`loopTargetNodeId: ctx.phaseKeepAlive?.nodeId ?? null` |
| `codex-phase-lifecycle.ts:20-39, 66-70, 181-188` | `CodexPhaseRole`、`options.role`、v1 校验 | `options.role` 删除;`CodexPhaseRole` 只留给 v1 parser(白名单函数 `assertValidPhaseHoldV1`) |
| `:349-366 enterHold` | 写 `role` | 写 v2 字段 |
| `codex-session-reown.ts:221` | `launch.phaseRole` | §8.4 |
| `run-infra.ts:217-221` | `phaseKeepAlive.role` → env | `input.context.sessionRole` |
| 测试 4 文件(exploration §2.2) | role 用例 | 改 loopTarget 用例 |
TypeScript 编译即守卫(类型删掉 `role` 后任何遗留消费者都编译失败)。

### 8.7 expiry operation canonical 身份(R1#7)
`expireResidentHoldsTx` 插 operation 时写 `run_id = hold.run_id`、`canonical_digest = canonicalSubmissionDigest({kind:'resident_expiry', runId, executionId, activationId, nodeId, attempt, revision})`;`client_request_id` 冲突时读回既有行逐字段比对,不等 → 抛 `resident_expiry_operation_poison:<executionId>:r<revision>`(不覆盖、不重铸);poison 负例测试。

### 8.8 A7(d) 守卫定义(R1#8)
母单 `fly2248-mechanism-guards.test.ts:25-52` 只扫 `delivery-contract/**` 与 `StateStore.ts` 的一个构造式,不能证明「全仓恰好三个前缀」。本单守卫改为**构造点 allowlist**:枚举本单文件里每个 `enqueueInfraAlert` / `workflow_alert_outbox` 写点(测试用 spy 计数 = 源码 grep 计数),每个写点断言 uid 前缀 ∈ {`delivery_contract_stalled`, `delivery_reroute_outcome`, `delivery_operation_stalled`};receiver 升级与 expiry stall 都断言为 `delivery_operation_stalled`。母单测试不动。

## 9. Round 3 更正(闭合 Codex R2,2026-09-03;与 §8 冲突处以本节为准)

### 9.1 legacy `phaseRole` 只进 digest 重建(R2#1)
`capabilityDigest(ctx)`(`CodexTmuxAdapter.ts:414-427`)拆成 `capabilityDigestInput(ctx, overrides?)`:正常路径 `phaseRole: null`(新体);recovery 漂移检查(`:920-935`)用 `overrides = { phaseRole: snapshot.launchContext.phaseRole }`(parser `:316-324` 已把它限定为 `design|implement|qa|null`)重建输入后再比 digest——于是旧 snapshot(`'implement'` 等)digest 相等、字段项单独忽略并记 `reown_legacy_phase_role_ignored`;该值不进 loop 资格。§8.4「该项比对 snapshot 与 null」保留,digest 严格性也保留,两者不再冲突。

### 9.2 备份 preflight + receipt 门(R2#2)
- `CommDB` 构造器与 `applyMigrations()` 同步(`db.ts:1043-1085`),`backupCommDb` 返回 Promise(`mailbox-migration.ts:1287-1317`)。**不**把构造器改 async(caller 面太大)。分两层:
  - Bridge boot async preflight(`plugin.ts` 起 HeartbeatService/首个 `new CommDB` 之前):对每个 project 的 comm.db 用 `openReadonly` 查 `sqlite_master` 判旧 PK → `await backupCommDb(dbPath, bak)` → 对 bak `quick_check` → 写 `<comm.db>.fly2268-rebuild-receipt.json {backupPath, backupSha256, sourceSchemaDigest, createdAt}`;任一失败 → 抛错,Bridge 不启动。
  - 同步构造器:检测旧 PK → 读 receipt、比对 `sourceSchemaDigest`(当前 `sqlite_master` 中 `runner_shutdown_controls` 的 sql 摘要)→ 匹配才在既有 `BEGIN IMMEDIATE` 事务内重建;缺失/不匹配 → 抛 `commdb_schema_preflight_required`。
- 冻结:直接打开 CommDB 的 writer 有 runner adapter(`CodexTmuxAdapter.ts:2280-2303`)、CLI(`commands/complete.ts:265`)、gateway(`gateway-main.ts:566-586`);它们在部署窗口全部停机(updater 既有顺序),且没有 receipt 时新代码打开旧 schema 会 fail-loud,不可能绕过 preflight 写旧表。
- 恢复:plan §4(停全部 writer → 删 wal/shm → 原子替换 → `quick_check` → 删 receipt → 起旧二进制)。

### 9.3 activation 解析(R2#3)
`workflow_execution_binding` 以 `activation_id` 为主键,同 execution 每次 wake/replacement 追加一行;`getWorkflowExecutionBinding(executionId)`(`StateStore.ts:29101-29112`)行数 ≠ 1 即返回 undefined。§8.4 的 binding 取法**撤销**:resident adopt 用 `workflow_resident_hold.activation_id` 调 `getWorkflowActivation`(exact),核对 run/node/attempt/execution 与 hold 行一致;其它 reown 与 receiver 资格用 `resolveCurrentWorkflowActivation(executionId)`(`:32515-32577`),`ambiguous` → 不武装、不判 loop、记 `reown_activation_ambiguous`、下 tick 重试。

### 9.4 runner 内串行 turn barrier(R2#4、R2#6)
- `CodexDaemonEvents.onNotification` 保持同步(`codex-daemon-client.ts:196-202`),`handleFrame`(`:248-310`)不变。新文件 `packages/claude-runner/src/codex-turn-barrier.ts`:`class CodexTurnBarrier { enqueue(write: () => Promise<void>): void; settled(): Promise<void>; }`——`enqueue` 把写按到达顺序串进内部 promise 链(前一个完成才跑下一个),失败进入 1s/2s/4s… 重试,累计超 `TURN_BARRIER_RETRY_MS = 60_000`(本文件常量)后 latched;`settled()` 返回链尾,latched 时 reject。
- `runGoalToTerminal` 在 `settleTerminal`、`enterPhaseHold`、`reactivateWake`、每次 `startTurn`、最终 return 前 `await barrier.settled()`;reject → 从该点抛 `GoalRunError(message, 'setup_failed')`;失败只 `client.logDiagnostic('turn barrier failed …')`,**无**持久事件、无告警(R2#6)。
- `thread/read(includeTurns:true)`(`:461-468`)结果经 `parseThreadReadTurns(unknown)`:要求 `threadId: string`、`turns: Array<{id: string; status: string}>`,缺任一字段 → reconcile 失败(不猜)。
- 测试经真实 `handleFrame → onNotification` 注入延迟/拒绝的 CommDB 写,断言 hold/push/下一 turn/terminal 均在 barrier 之后。

## 10. Round 4 更正(闭合 Codex R3,2026-09-03;与 §8–§9 冲突处以本节为准)

### 10.1 迁移不假设停机;生产 CommDB writer 全集(R3#1)
- `scripts/restart-services.sh:2981-3008`(Step 1 只停 Bridge)、`:3065-3069`(Step 3 起新 Bridge 并验活)、`:3160-3172`(Step 4 才重启 Leads):**没有**「全 writer 停机窗口」。§9.2「冻结 = 部署窗口」**撤销**。
- 直接写 CommDB 的生产进程(逐项,各配一条「旧 PK + 无 receipt → 构造器 fail-loud、零写入」测试):Bridge(`plugin.ts` 多处 `new CommDB`)、Codex adapter(`CodexTmuxAdapter.ts:2280-2303`)、Claude adapter(`TmuxAdapter.ts:1042-1059`)、gateway(`gateway-main.ts:566-586`)、CLI `complete`(`commands/complete.ts:265`)、`send`(`:18-34`)、`ask`(`:33-42`)、`gate`(`:133-143`)、`notify`(`:258-271`)、以及 `respond`/`turn`/`hold` 等其余 `commands/*.ts` 中的 `new CommDB`(实现节点 `rg "new CommDB\\(" packages scripts` 全集入测试表,不许只列样例)。
- 安全性来源改为 §10.2 的 source binding,而不是停机。

### 10.2 receipt 绑数据态 + 写锁内复验 + consumed(R3#2)
- preflight(async,`startBridge` 内首个 `new CommDB` 之前,`plugin.ts:4520+`):`backupCommDb` → 备份 `quick_check` → 计算源库 `mainSha256`/`walSha256`(与 FLY-1572 swap intent `sourceBinding` 同构,`mailbox-migration.ts:1611-1628` 的 `assertBoundHash`)→ 写 receipt `{backupPath, backupSha256, sourceBinding:{mainSha256, walSha256}, sourceSchemaDigest, createdAt}`。
- 构造器(同步,`db.ts:1043-1085` 的 `BEGIN IMMEDIATE` 内):检测旧 PK → 读 receipt → 复验:备份文件存在且 sha256 相等;以只读方式打开备份跑 `PRAGMA quick_check` = ok;源库 main/WAL sha256 与 `sourceBinding` 相等(持 RESERVED 锁,其他 writer 无法提交,读文件字节即当前提交态);schema 摘要相等 → 重建;否则抛 `commdb_schema_preflight_required`(缺失/schema/备份问题)或 `commdb_schema_preflight_stale`(binding 不等)。
- 成功后:事务提交 → receipt 改名 `<receipt>.consumed-<ISO ts>`(保留 backupPath 供回滚定位;不可再放行)。
- 负例四条:备份后源库追加一行;同 schema 不同库的 receipt;backup 缺失/篡改;成功后旧 prepared receipt 不可复用。

### 10.3 barrier 精确语义(R3#3)
- `settled()`:`while (tail !== lastAwaited) { lastAwaited = tail; await tail }`,drain 到稳定链尾。
- started 写不依赖 `turn/started` 通知:`claimTurnDispatch`(`codex-daemon-client.ts:790-816`)拿到 RPC 响应 turnId 时同步 `barrier.enqueue(() => markTurnStarted(executionId, turnId))`(幂等:`active_turn_id` 已等于该 id → 0 rows 视为成功);迟到的 `turn/started` 只重复确认。`handleFrame` response 分支先 resolve(`:258-306`)不再构成逃逸,因为 await 点在 claim + 入链之后。
- await 点:初次 kick(`:1243-1269`)claim 后、返回前;`reactivateWake`(`:1007-1024`)`startTurn` 返回后、`setGoal(active)` 前(`:1047-1068` 的 `finishWake/leaveHold` 之前);`settleTerminal`、`enterPhaseHold`、最终 return 前。
- barrier 失败优先:setup catch(`:1452-1483`)「有 terminal 就吞掉其他错误」对 `TurnBarrierError` 例外,始终抛 `GoalRunError(..., 'setup_failed')`。
- 测试四序:response-before-notification、notification-before-response、P2 在等 P1 时入链、terminal 与 barrier 失败同时出现。

### 10.4 `thread/read` parser 按 0.153.2 envelope(R3#4)
生成 schema:`ThreadReadResponse { thread: Thread }`(顶层唯一必填 `thread`),`Thread.id`、`Thread.turns[]`,`TurnStatus ∈ {completed, interrupted, failed, inProgress}`。parser `parseThreadReadTurns(result, requestedThreadId)`:`result.thread.id === requestedThreadId` 且 `turns[]` 每项 `id: string` + `status ∈ TurnStatus`,否则 reconcile 失败;兼容既有 `parseReconcile`(`CodexTurnExecutor.ts:300-315`)接受的顶层 `turns` 旧 envelope,以受测 union 显式列出。fixture 由 `codex app-server generate-json-schema` 产物构造;测试:合法、wrong-thread、缺 turns、坏 status。reconcile 判定:最后一个 turn `status === 'inProgress'` → 置/保持 `active_turn_id = turn.id`;否则清 id 并提升 deferred。

## 11. Round 5 更正(闭合 Codex R4,2026-09-03;与 §8–§10 冲突处以本节为准)

### 11.1 受控重建门在 writable open 最前端(R4#1)
现构造器(`db.ts:1053-1088`)在迁移事务前已执行 `PRAGMA journal_mode=WAL`、`SCHEMA`、`ensureMailboxQueueSchema`(`mailbox-queue.ts:313-399`,可 ALTER/建索引/更新行/重建 view),事务内首个动作 drop views,`applyMigrations`(`:1190-1195`)再写。§10.2「门在既有 `BEGIN IMMEDIATE` 内」**撤销**。新顺序(`commdb-open-gate.ts` 的 `openCommDbWritable(path)`):
1. 只读连接(`readonly:true, fileMustExist`)查 `sqlite_master` 判 `runner_shutdown_controls` 是否旧 PK;不是 → 直接返回可写连接,走既有路径。
2. 是 → 读 receipt(缺失 → 抛 `commdb_schema_preflight_required`,**不打开可写连接**)。
3. 打开可写连接,**第一条语句** `BEGIN IMMEDIATE`(之前不跑任何 PRAGMA/SCHEMA)。
4. 锁内复验:备份文件 sha256 = receipt;备份只读 `quick_check` = ok;源库 main/WAL sha256 = `sourceBinding`;schema 摘要 = receipt。任一不等 → `ROLLBACK`、关闭连接、抛对应错误码;此时 main/WAL/schema/行内容逐字节不变(负例断言此点)。
5. 通过 → 重建 → `COMMIT` → receipt 改名 consumed → 返回连接给既有构造器路径(PRAGMA、SCHEMA、queue schema、`applyMigrations` 含三个 `ADD COLUMN`)。

### 11.2 preflight 原子绑定:hash-before / backup / hash-after(R4#2)
`backupCommDb`(`mailbox-migration.ts:1287-1317`)不持锁。§10.2「备份后再算 binding」**撤销**。preflight:`b = sha256(main), w = sha256(WAL)` → `await backupCommDb` → 备份 `quick_check` → `b' , w'` 再算一次 → `b===b' && w===w'` 才写 receipt(`sourceBinding = {b,w}`);不等 → 删除备份、重来(≤3 次)。任何在 backup 前后区间提交的 writer 都会改变 WAL(或 checkpoint 改变 main)字节 → 不等 → 不放行。fault injection 测试:writer 在 backup 返回后、hash_after 前提交一行 → 不写 receipt。等价于 FLY-1572「记录 binding 后 fence 再 backup」(`:1918-1941,1971-1977`)的无锁版本。

### 11.3 writer 全集 = 所有对 comm.db 的 writable open(R4#3)
- `CommDB` 构造器(全部 `new CommDB(` 调用点);
- path 形 `new MailboxQueue(path)`(`mailbox-queue.ts:446-475`,直接 writable open + WAL + schema + `ensureMailboxQueueSchema` + `dropReceiptLedgerSchema` + triggers):生产调用 `codex-lead-tui-runtime.ts:626-638`、`codex-lead-runtime.ts:1679-1685`、`discord-chat-ingest.ts:74-82`;
- 直接 `new Database(commDbPath)`(实现节点 `rg "new Database\\("` 全集核对,comm.db 路径者入表)。
以上新二进制路径全部改经 `openCommDbWritable`;静态守卫:除 `commdb-open-gate.ts` 外不得对 comm.db 路径直接 `new Database` 可写打开(测试以 grep 断言)。在飞旧二进制进程的提交由 §11.2 一致性证明拦下(hash 不等 → 不放行),并发写回放测试覆盖。

### 11.4 claim 时缺 turn id 即 latch(R4#4)
`startTurn`(`codex-daemon-client.ts:544-565`)现返回 `string | undefined`(宽松 `extractTurnId :1622-1631`);`claimTurnDispatch`(`:789-803`)无 id 时只记 diagnostic。改为:严格解析官方 `TurnStartResponse { turn: Turn }` 的 `turn.id: string`(0.153.2 schema 必填 `turn`);claim 时响应与缓冲通知都给不出可归属 id → `barrier.latch(new TurnBarrierError('turn id unattributable'))`,后续 `settled()` reject → `setup_failed`。测试:malformed response 先到、`turn/started` 后到 → 不 push、不 `setGoal(active)`、不 `leaveHold`。
