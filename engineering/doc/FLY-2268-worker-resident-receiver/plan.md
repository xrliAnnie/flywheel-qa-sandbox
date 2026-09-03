# FLY-2268 工人常驻收信与完成前清信(FLY-2248-B / M3) — 实施计划(骨架)
Issue: FLY-2268 (https://linear.app/geoforge3d/issue/FLY-2268)
日期: 2026-09-02
基于: 母单 FLY-2248 的 engineering/doc/FLY-2248-generic-delivery-contract/exploration.md、research.md(§2 工人层)、plan.md round 5(git `0dac08247`)§2 M3 原文;Codex 设计评审 round1–round5(同文件夹 codex-review/)

> 本文件由母单 FLY-2248 设计节点按 Lead 2026-09-02 裁定 (c) 建立:**M3 全文从母单 plan round 5 原样搬入,不重设计**。子单设计节点在此骨架上补 §0 验收、§3 schema、§4 回滚、§5 守卫,并闭合下列 Codex 未过项。母单保留的接口见母单 plan §2「M3(已拆出至子单)」段。

## 0. 范围(母单裁定移交)

- 常驻收信员 supervisor(receiver 唯一 owner、心跳 rider、`receiver_stalled` 告警)
- durable turn 状态(CommDB `three_stage_turn` 加 `active_turn_id`/`turn_generation`;`onTurnStarted/onTurnCompleted`;`runner_phase_wakes.turn_generation` 与 `deferred_midturn`)
- loop 目标常驻宽限(`isLoopTargetNode`、`loopTarget` 贯穿、`workflow_resident_hold`、`residentHold.enter/close`、saga kind `resident_expiry`、`runner_shutdown_controls` 主键改 `(execution_id, request_id)` + `settlement_reason`)
- Claude `loop_park`;完成前清信(`workflow_completion_drain_challenge`、`completionBusinessDigest`、`consume_pending_mail`、`--drain-receipt`);R1 `turn/steer` 探测
- 事故回放:#3 verdict 秒死信、#7 三道令未消费(清信半边)、#8 返工唤醒打不醒 goal-achieved 体

## 1. 母单 §1 中随本单移交的稳定标识(原样)

| 类别 | 标识 |
|---|---|
| 新列(全部) | CommDB `runner_phase_wakes`:`first_push_at TEXT`(时钟纠错)、`turn_generation INTEGER`;CommDB `three_stage_turn`:`active_turn_id TEXT`、`turn_generation INTEGER NOT NULL DEFAULT 0`;CommDB `runner_shutdown_controls`:主键改为 `(execution_id, request_id)`(表重建,Lead 定义 #6)+ `settlement_reason TEXT`;CommDB child 行的 `root_id`/`parent_attempt` 走既有 `ref_id`(mailbox)与 envelope/metadata JSON(turn_wake/phase_wake),不加列;StateStore 既有表不加列 |
| phase wake admission_state | 边界到件沿用 `queued`;仅 mid-turn 用新值 `deferred_midturn`(带 `turn_generation`);durable active-turn 账本 = CommDB **既有** `three_stage_turn` 行新增两列 `active_turn_id TEXT`、`turn_generation INTEGER`(Lead 裁定:不另造 execution 级 turn 状态行) |
| completion disposition(新增) | `consume_pending_mail` `loop_park` |
| completion 业务摘要 | `completionBusinessDigest` = 现有 completion digest 算法作用于剔除 `drainReceipt` 后的 payload |
| 上下文字段 | `loopTarget?: { nodeId }` 贯穿 `StartRequest → RunDispatcher → BlueprintContext → AdapterExecutionContext.phaseKeepAlive{loopTarget:true,nodeId} → Codex launch snapshot → reown 重建 → Claude completion` |
| Codex runtime ↔ Bridge 控制面(新) | `CodexDaemonAdapterDeps.residentHold.enter({executionId, activationId, nodeId, boundarySeq}) → {ok:true, revision, graceExpiresAt} \| {ok:false, reason}`(幂等:同 execution/activation/boundarySeq 的现存 `resident` 行返回原 revision/deadline);`onTurnStarted({executionId, turnId})`、`onTurnCompleted({executionId, turnId})`(对 CommDB `three_stage_turn` 行做 CAS;**Lead 定义 #3**:`turn_generation` 的 +1 由 `grantTurn` 在同事务写,`onTurnStarted` 只置 `active_turn_id`,同 (execution, turn_generation) 二次调用 0 rows);Bridge → runtime 退出命令沿用 CommDB `requestRunnerShutdown(executionId, requestId, nowMs)`(`db.ts:4240`),`requestId = 'resident-expiry:<executionId>:r<revision>'`(确定性;**Lead 定义 #6**:表主键改 `(execution_id, request_id)`,saga 只看本 request_id 的行) |

## 2. 母单 plan round 5 §2 M3 原文(原样搬入)

### M3 — 工人层:常驻收信员、durable turn 状态、loop 常驻(revision + barrier)、完成前清信

- **loop 目标判定与贯穿**:同 round 3(`isLoopTargetNode = snapshot.manifest.loops.some(l => l.to === nodeId)`;`loopTarget` 显式贯穿;`Blueprint.ts:1625-1634` 去掉 `isCodexRunner &&` 与 role 分支;launch snapshot 与 reown 重建;`PhaseHoldState.schemaVersion=2` 含 `nodeId`、`residentRevision`、`graceExpiresAt`)。
- **durable turn 状态(复用 CommDB 既有 `three_stage_turn` 行;Lead 定义 #3,照抄)**:新增两列 `active_turn_id TEXT`、`turn_generation INTEGER NOT NULL DEFAULT 0`(旧行升级后为 0)。**`turn_generation` 的 +1 由 `grantTurn` 在同事务写**:两处 upsert(`db.ts:4597-4634`、`:4701-4718`)的 `ON CONFLICT … DO UPDATE` 同一条 UPDATE 语句里追加 `active_turn_id = NULL, turn_generation = three_stage_turn.turn_generation + 1`——**换手时先清旧 `active_turn_id` 再写新 holder,同一语句完成**;同一事务把旧 holder execution 的全部 `deferred_midturn` 行提升为 `queued`(非持棒语义)。`onTurnStarted({executionId, turnId})`:`UPDATE three_stage_turn SET active_turn_id=? WHERE issue_id=? AND holder_exec_id=? AND active_turn_id IS NULL`,返回行内 `turn_generation`;**幂等 = 同 (execution, turn_generation) 二次调用 0 rows**(`active_turn_id` 已非空);`holder_exec_id ≠ executionId` → `{ok:false, reason:'not_holder'}`(到件按 `queued`)。`onTurnCompleted({executionId, turnId})`:generation 从行里读(`WHERE issue_id=? AND holder_exec_id=? AND active_turn_id=?`,重启后无需内存值);命中 → 同一事务 `SET active_turn_id=NULL` **并** `UPDATE runner_phase_wakes SET admission_state='queued' WHERE execution_id=? AND admission_state='deferred_midturn' AND turn_generation<=g`;未命中(已被换手清掉)→ no-op。到件分类在同一 CommDB 事务内读该行再插 wake 行:收件 execution 是 `holder_exec_id` 且 `active_turn_id` 非空 → `deferred_midturn, turn_generation=g`;否则 `queued`。**非持棒 execution 的到件一律 `queued`**。测试:legacy 行(`turn_generation=0`)、active 中换 holder(旧 deferred 提升、新 holder 可 start)、重复 `turn/started` 0 rows、重启后 `turn/completed`、两种交错顺序。
- **常驻宽限(durable,revision + barrier)**:
  - `workflow_resident_hold(execution_id PK, run_id, node_id, attempt, activation_id, vendor, revision, boundary_seq, state IN ('resident','woken','expired','closed'), grace_started_at, grace_expires_at, closed_reason, updated_at)`。
  - **进入(fail-closed + 幂等)**:goal 到 terminal 且 `loopTarget` → runtime 先调 `deps.residentHold.enter({executionId, activationId, nodeId, boundarySeq})`(`boundarySeq` = 该 execution 已完成 goal 次数,runtime 从 durable session state 读);Bridge CAS:无行 → `resident(r=1)`;`woken(r)` 且 `boundary_seq < 本次` → `resident(r+1)` 新 deadline;**已有 `resident` 且同 activation/boundary_seq → 返回原 revision/deadline(幂等 adopt)**;返回后 runtime 才 `enterPhaseHold`(v2 state 写 revision/deadline)。本地 hold 写盘失败 → runtime 调 `deps.residentHold.close({executionId, revision, reason:'local_hold_failed'})` 补偿 → 按原 terminal 退出。Bridge 重启后 reown `watch` 分支若发现 `resident` 行而本地无 hold state → 用同 revision 重建本地 hold(adopt),不新铸。
  - **wake**:`wakeActor` 前置 CAS `resident(r) → woken(r)`;赢 → `reactivateWake`;输 → 换体判据。
  - **到期(saga `kind='resident_expiry'`,权威 owner = Bridge 维护 tick)**:① `resident(r) AND grace_expires_at < now` → StateStore 事务 CAS → `expired` + operation `staged`(`client_request_id='resident-expiry:<executionId>:r<r>'`);② CommDB `requestRunnerShutdown(executionId, 'resident-expiry:<executionId>:r<r>', now)`(`db.ts:4240-4267`;**Lead 定义 #6**:`runner_shutdown_controls` 主键改为 `(execution_id, request_id)`,表重建 + 新列 `settlement_reason TEXT`;saga **只看本 request_id 的行**;同 execution 的旧 `failed` 行由 saga 先 set-once `settlement_reason='superseded:<本 request_id>'` 关闭后跳过,不得阻塞;旧 `requested`/`acked` 行不影响本 request 的插入)→ `applied`;③ 观察 `runner_shutdown_controls.state='acked'`(held loop 每轮检查 shutdown control 与 deadline,命中即退出并 ACK)→ `sent`;④ 行 `closed(closed_reason='expired')` + 事件 → `projected`。**每 tick 重驱**所有 `expired` 且 operation 未 `projected` 的行(CommDB 暂不可读 → 本 tick 跳过,下 tick 再驱),直到 ACK。Claude:同一 saga,② 换成 `runner_ship_park` 既有 park 清理原语终结 pane,③ 以 pane 消失为 ACK。
  - **收口**:terminal / supersede / replacement / run terminate → `closed{reason}`;旧 revision 迟到 wake/expiry no-op。
- **`ResidentReceiverSupervisor`**:同 round 3(唯一 owner;`confirmHoldPaused()` 不再 start/覆盖 callback,`leaveHold()/stopIntake()` 不再 stop;所有权测试);到件分派按上文 durable turn 状态;admission_state reader 矩阵同 round 3;心跳 rider、`health()` 扩展、分类器、episode、零 OS 信号、武装时机同 round 3。
- **Claude**:completion disposition `loop_park`(同谓词;`enter` 由 StateStore 在 completion 事务内直接调用同一函数);CLI 停在 prompt 保持 poller。
- **完成前清信**:同 round 3(event route 唯一 CommDB 读者;`completionBusinessDigest`;同 (execution, activation, business_digest) 复用 challengeId;`consumeDrainChallengeTx` 只消费核验结果;水位线后新到件不阻塞)。
- **R1 探测**:`turn/steer` 有 → 单独 commit + 阳性对照;无 → 注释与文案写「入队+边界必读」。

测试:A3 (a)–(f) 全部;replay #3、#7、#8(含 revision 1→2、expiry saga 三个 barrier、shutdown ACK);`classifyReceiver`/`classifyGoalBoundary` 穷举;drain 七个负例。

## 3. 随本单移交的 Codex round 5 未过项(原文)

3. **[BLOCKER] #6 只改复合主键而没有迁移现有单行读取合同，expiry saga 仍可能永远等不到自己的 ACK。** 当前 `requestRunnerShutdown` 插入后和 `getRunnerShutdown` 都仅按 `execution_id` 读取一行；held loop 的 `observe`/poll 也只消费这一个未排序结果。复合主键允许同 execution 同时存在旧 requested/acked/failed 与新 expiry request 后，runtime 可能读到并 ACK 旧行，而 saga 按计划只检查自己的 requestId，于是自己的行永久 requested。请明确并实现 exact-request 查询以及 runtime 的多 pending 规则（例如退出时 ACK 该 execution 的全部 pending shutdown，或确定性选中并 ACK expiry request），并把所有仍假设“一 execution 一行”的 caller/测试纳入迁移 sweep；三种旧状态测试必须同时断言 expiry 自己的 requestId 达到 ACK/projected。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:43,52,113,152`；`packages/flywheel-comm/src/db.ts:230-237,4240-4306`；`packages/claude-runner/src/codex-phase-lifecycle.ts:287-292,493-520`；`packages/teamlead/src/bridge/codex-phase-shutdown.ts:207-241`；`packages/teamlead/src/bridge/land-cleanup-opportunity.ts:33-48`。

5. **[HIGH] #3 没有定义全新 `three_stage_turn` 行的首次 generation。** 两条计划内 SQL 只在 `ON CONFLICT ... DO UPDATE` 分支执行 `turn_generation + 1`；当前 INSERT 分支创建新 belt 行。如果新增列采用默认 0 而 INSERT 不显式写 1，首次 `grantTurn` 得到 generation 0，与“+1 由 grantTurn 写入”不一致，也让 legacy-0 与首次真实 grant 无法区分。请规定新 INSERT 写 `turn_generation=1`、冲突换手写 `+1`，并增加“无既有行首次 grant 为 1”的测试；legacy 行升级为 0 的测试继续保留。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:43,52,108`；`packages/flywheel-comm/src/db.ts:4622-4634,4704-4718`。

## 4. 待子单设计节点补齐

- §0 验收(母单 round 5 的 A3(a)–(f) 原文可直接沿用,见 `git show 0dac08247:engineering/doc/FLY-2248-generic-delivery-contract/plan.md`)
- §3 schema(`workflow_resident_hold`、`workflow_completion_drain_challenge`、CommDB 4 列 + shutdown 表受控重建)、§4 回滚、§5 负向守卫、§6 文案
- 母单 M1 attempt 表的 `attempt` 序号(revive 重发 +1)与 `workflow_delivery_operation.kind='resident_expiry'` 是本单的接口,不得改形状
