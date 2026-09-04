# FLY-2268 工人常驻收信与完成前清信(M3) — 探索
Issue: FLY-2268 (https://linear.app/geoforge3d/issue/FLY-2268/引擎loop稳定性-fly-2248-b-工人常驻收信与完成前清信m3常驻宽限-turn-边界-durable-状态-drain)
日期: 2026-09-03
基于: 无(本文件夹上游只有母单搬入的 plan.md 骨架;母单文档见 `engineering/doc/FLY-2248-generic-delivery-contract/{exploration,research,plan}.md`)

## 0. 一句话结论

母单 FLY-2248(PR #1040,2026-09-03 07:26Z 合入)与 FLY-2278(PR #1053,2026-09-03 19:29Z 合入)已经把「欠条台账 + 改派 saga + 冻结正门」铺好;本单只剩**工人层**四件事——常驻收信员、durable turn 状态、loop 目标常驻宽限、完成前清信——全部按母单 plan round 5 §M3 原文实现,**不重设计、机制只减不增**。本探索只做三件事:核对 round 5 文字与当前 HEAD 代码是否仍对得上、把 Codex R5 #3/#5 两个未过项落成可实现的形状、记录 R1(`turn/steer`)探测结果。

## 1. 本单边界(来自 issue 与 Lead 裁定,不再复议)

| 项 | 裁定 |
|---|---|
| 范围 | 母单 plan round 5 §M3 全文(git `0dac08247`),已原样搬入本文件夹 `plan.md` §2 |
| 常驻宽限 | `RESIDENT_GRACE_MS = 30 * 60_000` 常量,无 env/flag;Claude 工人同样 `loop_park`;仅 loop **入边**节点 |
| mid-goal 语义 | 「入队 + 下一 turn 边界必读 + 欠条超时兜底」;无阳性对照不得写成实时 |
| durable turn | 复用 CommDB `three_stage_turn` 加 `active_turn_id`、`turn_generation`;`grantTurn` 同事务 +1 且同一 UPDATE 清旧 id;新行 INSERT 写 `turn_generation=1`(R5 ⑤) |
| expiry | 并入既有 `workflow_delivery_operation`,`kind='resident_expiry'`(DDL 已预留,母单代码只读不写) |
| shutdown 表 | `runner_shutdown_controls` 主键改 `(execution_id, request_id)` + `settlement_reason`;exact-request 读法 + runtime 多 pending 规则 + caller sweep(R5 ③) |
| 不做 | 新表以外的表(本单新表恰好 2 张 StateStore:`workflow_resident_hold`、`workflow_completion_drain_challenge`)、新告警面、env/flag、实现面 `qa`/`implement`/`design` 字样 |
| 依赖 | 母单先合——已满足(HEAD `e85eec9a8` 含 #1040、#1053) |
| 验收 | 母单 §A3(b) 重武装 + §A7 机制守卫在本单再跑一次;真机:loop 入边节点工人 goal 完成后 30 分钟内收到欠条并被再派活,零人工唤醒 |

## 2. 现状底图(2026-09-03 HEAD `e85eec9a8` 逐点核对)

### 2.1 母单已交付、本单直接站在上面的东西

- `workflow_delivery_operation` DDL 的 `kind IN ('hold_resume','reroute','resident_expiry')` 已落地(`StateStore.ts:20754-20772`),并有 FLY-2278 的表重建迁移 `migrateWorkflowDeliveryOperationKinds`(`:20382-20435`)与守卫测试 `fly2278-m0-schema.test.ts`「rebuilds a populated resident-expiry table」。本单**不改**这张表。
- saga 四段状态 `staged → applied → sent → projected | failed` 与 barrier 写法已有两套样板:`hold_resume`(`StateStore.ts:39808-40085`:`listPendingWorkflowHoldResumeOperations` / `applyWorkflowHoldResume` / `markWorkflowHoldResumeFailed` / `projectWorkflowHoldResume`)与 `reroute`(`delivery-operations.ts`)。`resident_expiry` 照同一骨架加第三组方法,由同一个 `DeliveryOperations.runPass` 驱动(`plugin.ts:7657-7667`,维护 tick 内、projector 与 watch 之后)。
- 维护 tick 的骑乘点:`plugin.ts:7583-7690` 的 HeartbeatService 维护回调,tick 0 = boot pass;`codexSessionReowner.runPass(snapshot)` 先于 delivery 三件套。本单的 expiry saga 与 receiver supervisor 心跳都骑这里,零新 timer。
- FLY-2278 的 `collectRecipientLivenessEvidence` / `classifyRecipientLiveness`(`delivery-contract/liveness.ts`)是「判死先问送达」的证据采集点;母单 plan 说的 reentry 词汇 `wake/replace/defer` 在 HEAD 仍是 `wake/replace/hold`(`phase-actor-reentry.ts:7-22`),本单**不改**这个枚举,只在 `wakeActor` 前加 CAS。
- A7 机制守卫 `fly2248-mechanism-guards.test.ts:54-86` 固定了「StateStore `workflow_delivery_%` 恰好 3 张、CommDB 0 张、`runner_phase_wakes` 恰好一个 `first_push_at`」。本单新表前缀是 `workflow_resident_hold` / `workflow_completion_drain_challenge`,**不落在 `workflow_delivery_%` 前缀下**,母单守卫原样通过;本单另加自己的 allowlist 守卫(§5)。

### 2.2 工人层现状(与母单 exploration §2.3 一致,行号更新到 HEAD)

- **收信员只在 phase hold 期间存在**:`CodexTmuxAdapter.ts:1025-1050` 在 `ctx.phaseKeepAlive` 时 `transport.createReceiver()` 建 watcher 并交给 `CodexPhaseLifecycleController`;`confirmHoldPaused()`(`codex-phase-lifecycle.ts:372-426`)才 `watcher.start()` 并挂 `onDelivered`;`leaveHold()`(`:441-452`)与 `stopIntake()`(`:274-280`)拆线。turn 进行中没有任何收信员——信落在文件里没人读,直到 goal 边界。**这就是事故 #3(verdict 秒死信)与 #7(三道令未消费)的病根。**
- **`phaseKeepAlive` 是节点名硬编码**:`Blueprint.ts:1622-1634` `isCodexRunner && shareParentBranch` 再按 `sessionRole ∈ {design, implement, qa}` 打 role;`adapter-types.ts:210` 形状 `{ role }`;launch snapshot `launchContext.phaseRole`(`CodexTmuxAdapter.ts:198-212`)与 `capabilityDigest`(`:414-427`)都把 `phaseRole` 揉进去;reown 重建 `codex-session-reown.ts:221` 从 `launch.phaseRole` 反推 `phaseKeepAlive`;`run-infra.ts:217-221` 把 `phaseKeepAlive.role` 当 `sessionRole/chatThreadRole` 回填 env。**任意名称的 loop 目标节点拿不到常驻**,这是事故 #8 的病根之一。
- **goal 达成即 terminal**:`codex-daemon-client.ts:1131-1143` `classifyTerminalStatus` 只把 `blocked + open gate` 判 held;`settleTerminal`(`:1292-1301`)在 `phase && status === "complete"` 时 `enterPhaseHold()`——注意这是「**有 phase controller 就 hold**」,不看节点是不是 loop 目标,也没有宽限期限:held loop(`:1486-1500`)只等 wake 或 transport close。所以现状是「phase 角色永远常驻(直到被 shutdown control 或换体)」而不是「loop 目标常驻 30 分钟」。本单要做的是**收窄**:只有 loop 目标才 hold,且 hold 有 30 分钟 durable 期限。
- **turn 边界信号**:`codex-daemon-client.ts:749-790` `observeTurnNotification` 只在 `turn/started|turn/completed` 且 thread 匹配时经 `pendingTurnDispatch` 缓冲或 `applyOwnedTurnCompletion`;`ownedTurnIds` 是内存集合。这就是 `onTurnStarted/onTurnCompleted` 回调的挂点,**不是** `observeBoundary()`(那只读 `getEffectiveDeclaredState`,`codex-phase-lifecycle.ts:318-339`)。
- **CommDB `three_stage_turn`**:`issue_id PK, holder_exec_id, phase, epoch, granted_at, target_run_id, target_node_id, target_attempt, activation_id`(`db.ts:142-152`);两处 upsert 在 `grantTurn`(`db.ts:5355-5375` source 分支、`:5437-5450` legacy 分支);现有加列迁移模式是 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`(`:1235-1257`);所有读者都显式列名 SELECT(`getTurn :5470-5510`、`readPatrolTurnSnapshot :5522+`、`:6497`),**加列不破坏任何读者**。
- **`runner_phase_wakes.admission_state`** 现值域 `queued | duplicate | suppressed_cap | skipped_no_transport | NULL`(`db.ts:594-598`);写点 3 处(`enqueueRunnerPhaseWake :3867` 不写列(NULL→由后续 admission 置 queued)、`rerouteRunnerPhaseWake :3034` 写 `'queued'`、`enqueueRunnerDoorbellWake :4178`);读点 8 处(§research 矩阵)。**没有 `turn_generation` 列。**
- **`runner_shutdown_controls`**:`execution_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, state IN ('requested','acked','failed'), requested_at, finished_at, error`(`db.ts:282-289`)。`requestRunnerShutdown` 是 `INSERT OR IGNORE` 后按 `execution_id` 读一行(`:4962-4991`);`getRunnerShutdown(executionId)` 单行(`:4993-5006`);`finishRunnerShutdown` 按 `(execution_id, request_id, state='requested')` 精确(`:5008-5030`);两处 prune `DELETE … WHERE execution_id = ?`(`:6964`、`:7076`)。**Codex R5 #3 说的问题在 HEAD 原样存在**:同 execution 第二次 `requestRunnerShutdown` 因主键冲突被 IGNORE,读回的是第一行(`db.test.ts:1155-1159` 甚至把这写成了期望行为「duplicate returns requested」)。
- **shutdown 的 caller(sweep 全集,HEAD 实测)**:生产 4 个——`codex-phase-lifecycle.ts:289,514`(runtime observe/poll)、`codex-phase-shutdown.ts:207-241`(Bridge 受控关停:无行则铸 `randomId()` 请求、轮询同一 request_id)、`land-cleanup-opportunity.ts:33-48`(land 清理:`requestId = '<operation_id>:<execution_id>'`,按 execution 读 acked)、`shipped-husk-escalation.ts:263-270`(只读证据);类型消费 `runner-shutdown-evidence.ts:10-15`、`lib.ts:42`;测试 7 个文件(`db.test.ts`、`db.fly1238.test.ts`、`codex-phase-lifecycle.test.ts`、`shipped-husk-escalation.test.ts`、`land-cleanup-opportunity.test.ts`、`codex-phase-shutdown.test.ts`、`commdb-session-prune.test.ts`)。
- **Claude 工人**:completion disposition 现有三值 `engine_gate_handoff | runner_ship_park | terminal_no_gate`(`StateStore.ts:62432-62435`),由 `workflowCompletionDispositionForContext`(`:44343-44360`)在完成事务内决定并以 `completion_disposition` 事件 uid `completion_disposition:<run>:<node>:<attempt>` 幂等落账(`:45211-45232`);`complete.ts:464-465` 收到 `runner_ship_park` 只打印「已 park 等待 ship gate;等 wake,勿自行轮询」——Claude CLI 停在 prompt、自带 poller 活着。**没有 `loop_park`、没有 `consume_pending_mail`、没有 `--drain-receipt`。**
- **完成路由**:`event-route.ts:986-1057` 已在 `commitEnrolledCompletion` 前读 CommDB(founder review authority);完成结果的 `completionDisposition` 原样回给 CLI。这里就是清信规则的唯一 CommDB 读者落点。
- **Bridge 重启后的重认领**:`codex-session-reown.ts:406-413` `reown_watch_started`(活体只记一次)、`:631-641` `reown_revive_succeeded`(commit 后);deps 接口 `CodexSessionReownDeps`(`:44-83`)有 `record(event, session, payload)` 一个出口,**没有** onWatch/onRevive 专用 hook——supervisor 重武装可以订阅 `record` 的这两个事件名,或在 deps 上加一个可选 hook;两种都不新增机制。
- **收信 transport 接口已厂商中立**:`IReceiverWakeTransport.createReceiver(ctx): IMailboxWatcher | null`、`IMailboxWatcher {start, stop, health, onDelivered}`、`wakeMode: builtin-receiver | external-watcher | push-only`(`agent-team-transport/src/types.ts:199-224, 300-310`);`EXECUTOR_TO_TRANSPORT`(`role-adapter-resolver.ts:54-61`)`claude-tmux→claude-code`、`codex-tmux→codex`、其余 `none`。
- **可复用的常驻体制骨架**:FLY-2216 `classifyResidentCodexLead`(`resident-codex-lead-patrol.ts:439+`,纯函数、startup grace、identity 不确定只告警)+ GatePoller `(tickCount-1) % N === 0` rider(`gate-poller.ts:653-743`)。
- **loop 判据的数据源**:`WorkflowMenuLoop {id, from, to, loopWhen, exitWhen, maxIterations?, onLimit?}`(`workflow-menu.ts:48-56`);pinned snapshot 上 `snapshot.manifest.loops` 已被 StateStore 5 处消费(`:44994, 45962, 46420, 46910, 48873`)。dispatcher `workflow-engine-dispatcher.ts:2740-2750` 只对 `isWorkflowPhaseRole(node.type)` 设 `shareParentBranch`;`loopTarget` 要在这里显式算出、显式传。

### 2.3 R1 探测:`turn/steer`(2026-09-03 本机实测)

- 本机 `codex-cli 0.153.2`(`~/.codex-242/packages/standalone/releases/0.153.2-aarch64-apple-darwin/bin/codex`);`codex app-server generate-json-schema` 生成的协议 schema(`codex_app_server_protocol.v2.schemas.json`)含:
  - 方法 `turn/steer`;`TurnSteerParams { threadId, expectedTurnId(必填,不等于当前活动 turn 即失败), input: UserInput[], clientUserMessageId? }` → `TurnSteerResponse { turnId }`;
  - `NonSteerableTurnKind = review | compact`;
  - 二进制 strings 计数:`turn/steer` 10、`turn/interrupt` 12、`turn/start` 24。
- **结论**:协议层「有」,但这是 schema 证据不是阳性对照(没有在真 daemon 上观察到 mid-turn 注入被模型读到)。按 Lead 裁定,本单 mid-goal 语义**仍写「入队 + 下一 turn 边界必读 + 欠条超时兜底」**;`turn/steer` 作为实现节点的**可选独立 commit**,前置条件是一条经真实 app-server 的阳性对照测试(见 research §6 R1)。`expectedTurnId` 必填这一点恰好与本单 `active_turn_id` 列同构:若将来升级,steer 的前置 CAS 就是读这一列。

## 3. 事故回放(本单负责的三起,账本证据见母单 exploration §3)

| # | 事故 | 病根(HEAD 代码位置) | 本单机制 | 回放断言(research §5) |
|---|---|---|---|---|
| 3 | verdict 秒死信:Lead 15 条 response 发给 turn 中的 Codex 体,9 条 lease 过期 DEAD | turn 中无收信员(`CodexTmuxAdapter.ts:1025-1050` 只在 phaseKeepAlive+hold 时建) | 常驻收信员 + `deferred_midturn` | lease 到期前信已落 `runner_phase_wakes(deferred_midturn, turn_generation=g)`;`turn/completed` 后提升 `queued`;信不 DEAD |
| 7 | 三道令 QUEUED 未消费:工人读到它们之前到达 goal 边界并终结 | `complete` 不查未消费信(`event-route.ts:986+` 无此检查) | 完成前清信(durable challenge + 回执) | event route 拒绝并返回 `consume_pending_mail` + ids + challengeId;三行 ACK 后 `--drain-receipt` 成功;任一未 ACK 拒绝;同业务重试同 challengeId |
| 8 | 返工唤醒打不醒 goal-achieved 体,10 分钟后换体 | goal complete 后无 loop 常驻判据 + 无 durable 宽限(`codex-daemon-client.ts:1292-1301`);Blueprint role 硬编码 | loop 目标常驻宽限(revision + expiry saga)+ `wakeActor` 前置 CAS | `enter` 写 `resident r=1`;wake CAS 赢 → `reactivateWake` 同 thread 无换体;再 complete → r=2;30min 后 tick CAS→`expired` + saga 发确定性 shutdown → held loop 退出并 ACK → `closed`;mid-grace 重启后到期仍发生 |

外加母单 R6#3 拆给本单的 #4 半边:`receiver_missing` 分类 → 进程内重武装 → `receiver_armed(source=…)` 事件。

## 4. 设计方向(按 round 5 原文,只做「对齐到 HEAD」的落点更正)

### 4.1 常驻收信员 `ResidentReceiverSupervisor`(Bridge 内)

- 武装期 = 工人整个生命周期(admission 成功 → terminal/supersede/replacement),不再只在 hold 期间。
- 所有权收归:只有 supervisor 调 `createReceiver/start/stop/onDelivered`;`CodexPhaseLifecycleController.confirmHoldPaused()` 不再 start/覆盖 callback,`leaveHold()/stopIntake()` 不再 stop;`CodexTmuxAdapter.ts:1031-1036` 不再自建 watcher。
- 重武装时机:(a) dispatcher admission 成功回调;(b) `codexSessionReowner` 的 `reown_watch_started` / `reown_revive_succeeded`(`record` 事件);(c) boot pass 对 `getReadoptCandidateSessions()` 全量。
- 到件分派:先 durable 落 `runner_phase_wakes`,同一 CommDB 事务内读 `three_stage_turn` 行决定 `deferred_midturn(turn_generation=g)` 或 `queued`。
- 心跳:骑 GatePoller 60s rider;分类器 `classifyReceiver` 纯函数;episode 同 FLY-2216;每 episode 至多一次进程内重武装 + 一次告警;零 OS 信号。
- 与 Lead 的偏离说明(母单 exploration §4.2 已问过):founder 原话「体外」,本方案是 Bridge 内 + reown 重武装。Lead 裁定 (c) 把 M3 按 round 5 原文搬入即视为接受此形态。

### 4.2 durable turn 状态(Lead 定义 #3 + R5 ⑤)

- `three_stage_turn` 加 `active_turn_id TEXT`、`turn_generation INTEGER NOT NULL DEFAULT 0`(旧行升级后 0)。
- `grantTurn` 两处 upsert:**INSERT 分支写 `turn_generation = 1`**;`ON CONFLICT DO UPDATE` 同一条语句追加 `active_turn_id = NULL, turn_generation = three_stage_turn.turn_generation + 1`;同事务把旧 holder 的 `deferred_midturn` 全部提升为 `queued`。
- `onTurnStarted` 只置 `active_turn_id`(`WHERE holder_exec_id=? AND active_turn_id IS NULL`),幂等 = 同 (execution, turn_generation) 二次调用 0 rows;`onTurnCompleted` 从行里读 generation(`WHERE holder_exec_id=? AND active_turn_id=?`),命中 → 清 id + 提升 `deferred_midturn(turn_generation ≤ g) → queued`;未命中 no-op。
- 挂点:`codex-daemon-client.ts` 的 `claimTurnDispatch`(拿到 turnId 时)与 `applyOwnedTurnCompletion`(owned turn 完成时),经 `CodexDaemonAdapterDeps.onTurnStarted/onTurnCompleted` 注入(Bridge 在 `run-infra.ts:655-672` 注入实现)。

### 4.3 loop 目标常驻宽限(durable,revision + barrier + expiry saga)

- 判据:`isLoopTargetNode(snapshot, nodeId) = snapshot.manifest.loops.some(l => l.to === nodeId)`;`loopTarget?: { nodeId }` 显式贯穿 `StartRequest → RunDispatcher → BlueprintContext → AdapterExecutionContext.phaseKeepAlive{loopTarget:true,nodeId} → Codex launch snapshot → reown 重建 → Claude completion`;`Blueprint.ts:1622-1634` 去掉 `isCodexRunner &&` 与 role 分支。
- **对 HEAD 的一处落点更正**:`phaseKeepAlive` 现被 `capabilityDigest`、launch snapshot `phaseRole`、reown 漂移检查(`CodexTmuxAdapter.ts:920-935`)三处消费。形状换成 `{ loopTarget: true, nodeId }` 后,launch snapshot 需要 `schemaVersion` 不变、`launchContext` 加可选 `loopTargetNodeId: string | null`,旧 snapshot(只有 `phaseRole`)按「`phaseRole !== null` ⇒ 视为 loopTarget=true、nodeId 未知」兼容读;`capabilityDigest` 改用 `loopTargetNodeId`。这是 round 5 文字没展开、但实现必然撞上的兼容点,research §2.3 给出精确规则。
- `PhaseHoldState.schemaVersion=2` 加 `nodeId`、`residentRevision`、`graceExpiresAt`,v1 兼容读。
- 进入 / wake / 到期 / 收口四段照 round 5 原文(本文件夹 `plan.md` §2)。expiry saga 走 `workflow_delivery_operation(kind='resident_expiry')`,`client_request_id = 'resident-expiry:<executionId>:r<revision>'`,barrier:① StateStore CAS `resident→expired` + operation `staged`;② CommDB `requestRunnerShutdown(executionId, requestId)` → `applied`;③ 观察 exact request 行 `acked` → `sent`;④ 行 `closed(expired)` + 事件 → `projected`。Claude 分支 ② 换成既有 pane 清理原语(`killTmuxWindow` + `closeRunnerTerminalView`,`post-merge.ts:16-32` 同款),③ 以 pane 消失为 ACK。

### 4.4 `runner_shutdown_controls` 主键重建 + exact-request 合同(R5 ③)

- 表重建为 `PRIMARY KEY (execution_id, request_id)`,去掉 `request_id UNIQUE`(改为同一 execution 内唯一即可),加 `settlement_reason TEXT`;按 CommDB 既有「建新表 → 拷贝 → drop → rename」模式,行数守恒断言。
- 读法改成三层:`getRunnerShutdownRequest(executionId, requestId)`(exact)、`listPendingRunnerShutdowns(executionId)`(全部 `requested`,按 `requested_at, request_id` 排序)、`getRunnerShutdown(executionId)` 保留但语义改为「最早的 pending 一行,否则最新一行」并在 sweep 里逐个 caller 决定是否换用前两者。
- runtime 多 pending 规则:held loop / `pollShutdown` 观察到**任意** `requested` 行即退出;退出 ACK 时 **ACK 该 execution 全部 pending 行**(同一事务,逐行 `finishRunnerShutdown`),这样 saga 只看自己的 request_id 也一定能等到 ACK;旧 `failed` 行由 saga set-once `settlement_reason='superseded:<request_id>'` 关闭后跳过;旧 `requested/acked` 行不影响本 request 插入。
- caller sweep 结论进 research §2.5(逐个 caller 写处置)。

### 4.5 完成前清信(generic guard)

- `event-route.ts:986-1057` 是唯一 CommDB 读者(fail-closed:读不到就拒绝完成 `completion_deferred_pending_mail{reason:'commdb_unreadable'}`)。
- StateStore 只消费带 challenge identity 与核验结果的受约束调用 `issueDrainChallenge` / `consumeDrainChallengeTx`;`completionBusinessDigest` = 现有 completion digest 算法作用于剔除 `drainReceipt` 后的 payload;同 (execution, activation, business_digest) 已有 `issued` 行 → 返回原 challengeId 不重铸。
- CLI `complete --drain-receipt <challengeId>`;disposition 新值 `consume_pending_mail`、`loop_park`。

## 5. 通用性如何被强制(母单 A1 的本单版本)

- 新文件集合 `resident-receiver-supervisor.ts`、`resident-hold.ts`、`completion-drain.ts`(位置见 plan)源码不含 `/\b(qa|implement|design)\b/i`;`Blueprint.ts` 改动后 `phaseKeepAlive` 的计算里不再出现这三个词;`codex-phase-lifecycle.ts` 的 `CodexPhaseRole` 类型与 `PhaseHoldState.role` 校验随 v2 退出(v1 兼容读时保留字面量只用于**解析旧文件**,守卫按「非解析路径」扫描)。
- 三条不同的 loop 入边(fixture 模板里节点名任意,如 `founder_gate→general`、`review→builder`、`qa→implement`)经同一 `isLoopTargetNode` 与同一 `residentHold.enter` 产生 `resident` 行(spy 断言同一函数)。

## 6. 假设与待裁定(非阻塞,按默认值推进)

1. **launch snapshot 兼容**(§4.2 落点更正):默认「不升 schemaVersion、加可选字段、旧字段兼容读」。若 Lead 要求升到 2,只影响 `parseCodexLaunchSnapshot` 一处。
2. **`getRunnerShutdown(executionId)` 保留与否**:默认保留(语义改为 pending 优先),避免一次性改 7 个测试文件;sweep 里逐 caller 标注。
3. **Claude 分支 expiry 的 ACK 证据**:默认「pane 消失」由既有 `probePersisted`(tmux 目标探针)判定;不新增探针。
4. **supervisor 与 reown 的接线**:默认订阅 `record('reown_watch_started' | 'reown_revive_succeeded')`,不改 `CodexSessionReownDeps` 形状。

## 7. 非目标

- 不做 `turn/steer` 实时注入(除非实现节点拿到阳性对照,且作为独立 commit)。
- 不改 mailbox 关系/新鲜度模型(FLY-1792)。
- 不改 FLY-2211 reown 判死判据、不改 `phase-actor-reentry` 枚举。
- 不新增 feature flag、env、告警层、欠条 state 值、第二张 saga 表。
- 不把 `sessions.phase_keep_alive` 改名(它继续表示「该 execution 的 CommDB 行支持 phase wake」,对 loop 目标同样为 1)。
