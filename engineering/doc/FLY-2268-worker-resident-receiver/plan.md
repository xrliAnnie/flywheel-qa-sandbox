# FLY-2268 工人常驻收信与完成前清信(FLY-2248-B / M3) — 实施计划
Issue: FLY-2268 (https://linear.app/geoforge3d/issue/FLY-2268/引擎loop稳定性-fly-2248-b-工人常驻收信与完成前清信m3常驻宽限-turn-边界-durable-状态-drain)
日期: 2026-09-03(round 5:闭合 Codex R4 的 2B+2H——受控重建门移到 writable open 最前端(任何 PRAGMA/SCHEMA/加列之前);preflight 用 hash-before/backup/hash-after 一致性证明把备份与 binding 原子绑定;writer 全集扩到所有对 comm.db 的 writable open(`CommDB`、path 形 `MailboxQueue`、直接 better-sqlite3)并共享同一早期门;claim 时取不到 `TurnStartResponse.turn.id` 即 latch `TurnBarrierError`;round 4:闭合 Codex R3 的 4 BLOCKER——撤销「updater 已冻结全部 writer」断言,改为 receipt 绑源库 main/WAL sha256 + 写锁内复验、成功后 receipt 标记已消费;barrier `settled()` drain 到稳定链尾、started 写以 RPC 响应 turnId 在 claim 时入链、barrier 失败压过 terminal;`thread/read` parser 按 0.153.2 `result.thread.{id,turns[]}` 形状;round 3:闭合 Codex R2 的 3B+1H+1M+1L——legacy `phaseRole` 参与 digest 重建、备份改为 Bridge boot 的 async preflight + receipt 门、reown/receiver 资格按 exact/current activation 判定、runner 内串行 turn barrier、守卫文字去矛盾、清掉撤销残文;round 2:闭合 Codex R1 的 5B+1H+2M——候选集与武装时机、turn 回调 fail-closed + reown reconcile、drain 与 completion 同事务、launch snapshot digest 不变+nodeId 从 binding 还原、CommDB 迁移前在线备份、`phaseKeepAlive.role` 消费者全扫、expiry canonical 身份、A7(d) 构造点 allowlist;round 1:补齐 §0/§3/§4/§5/§6 并闭合 R5 #3 / #5)
基于: research.md, exploration.md;母单 FLY-2248 plan round 5(git `0dac08247`)§M3 原文;母单 `codex-review/round5.md` #3/#5

> 机制只减不增:本单**不设计新机制**,§2 的 M3 核心文字是母单 round 5 原文原样搬入(Lead 2026-09-02 裁定 (c));本计划只把它落到 HEAD `e85eec9a8` 的精确位置(research.md 给出行号)并补齐验收/迁移/回滚/守卫。母单 #1040、FLY-2278 #1053 已合入,本单在其 attempt 台账、`workflow_delivery_operation` saga 表与冻结正门之上实现。

## 0. 目标、约束、范围与验收

**目标**:让工人从 admission 到 terminal 全程能收信(常驻收信员);turn 进行中到的信 durable 落账并在下一 turn 边界必读(durable turn 状态);loop 入边节点的工人 goal 完成后常驻 30 分钟等返工唤醒,到期由 Bridge 权威 saga 关停(常驻宽限);完成前必须把未消费的信读完(清信)。四件事全部挂在通用对象上,不看节点名。

**范围**(issue 原文,全部来自母单 plan §M3):
- Bridge 内 `ResidentReceiverSupervisor`:武装期 = 工人整个生命周期;Bridge 重启后由 reown watch/revive 分支重武装;mid-goal 语义 = 「入队 + 下一 turn 边界必读 + 欠条超时兜底」(无阳性对照不得写成实时)。
- 常驻宽限 `RESIDENT_GRACE_MS = 30 * 60_000` 常量(无 env/flag);Claude 工人同样 `loop_park`;仅 loop 入边节点。
- durable turn 状态:复用 CommDB `three_stage_turn`(+`active_turn_id`、`turn_generation`);`grantTurn` 同事务 +1 并同一 UPDATE 清旧 id;`onTurnStarted` 同 (execution, turn_generation) 幂等;新行 INSERT 写 `turn_generation=1`(R5 ⑤)。
- 完成前清信 / drain challenge;expiry 并入同一 saga 表 `kind='resident_expiry'`(不新表)。
- `runner_shutdown_controls` 主键改 `(execution_id, request_id)` 后的 exact-request 读法 + runtime 多 pending 规则 + caller sweep(R5 ③)。

**不做**:上述之外的新表(本单 StateStore 新表恰好 2 张)、新告警面(告警 uid 前缀沿用母单三个,零新增)、env/flag 旋钮;实现面不得出现 `qa` / `implement` / `design` 字样硬编码;不做 `turn/steer`(除非实现节点以独立 commit + 真实 app-server 阳性对照交付,见 §2 M3-R1);不改 mailbox 关系模型、FLY-2211 判死判据、`phase-actor-reentry` 枚举。

**验收(全部可机器判)**:

- **A3 常驻与收信(母单 round 5 原文,逐条对应测试)**:(a) **所有** codex 工人(loop 目标与非 loop 目标一样;资格 = StateStore session 非终态 + `workflow_execution_binding.mode ∈ {spawn,wake,replacement}` + transport `wakeMode='external-watcher'`,**不看** CommDB `sessions.phase_keep_alive`)从 launch commit 到 terminal 全程 `receiver_heartbeat` 不间断;初次武装绑定 dispatcher 的 launch-commit receipt(`waitForWorkflowLaunchOutcome` 成功之后,`workflow-engine-dispatcher.ts:2816-2831`),CommDB session registration 尚不可见时 arm 挂起并在每个 GatePoller rider 重试,测试「延迟 registration 不漏武装」;(b) Bridge 重启后 ≤1 个维护节拍内 `receiver_armed(source=reown_watch|reown_revive|boot)`,含非 loop 工人;(c) 在真实顺序 `turn/started → mid-turn 到件 → turn/completed → 下一次 startTurn` 上断言「当前 turn 不消费、下一 turn 必读」(假 daemon transport 发真实通知);(d) 常驻宽限:同一 execution 连续两轮 park/wake(revision 递增);旧 revision 的迟到 wake/expiry 输;mid-grace 崩溃重启后到期仍发生;expiry 后 Codex held loop 确实退出;重复 cleanup 幂等;两家 vendor;(e) barrier:「`enter` 提交后、本地 hold 写盘前崩溃」→ reown 用同 revision 幂等 adopt;「本地 hold 写盘失败」→ 补偿 close 走原 terminal;「expiry CAS 后、shutdown request 前崩溃 / CommDB 暂不可读」→ 下一 tick 重驱直到 shutdown 被 ACK 再 closed;`runner_shutdown_controls` 已有 requested / acked / failed 行时各一条测试(saga 只看本 request_id 的行,且 expiry 自己的 requestId 到 `acked`、operation 到 `projected`);(f) Bridge 在 turn 进行中重启后到件仍能按 CommDB `three_stage_turn` 行上的 durable turn 列正确判 deferred/queued;`turn/completed` 与到件的两种交错顺序都不丢行、不早放行;**turn 回调是 fail-closed 的边界 barrier**:`markTurnStarted/markTurnCompleted` 写不进 CommDB 时 runtime 不推进(不 push、不开下一 turn、held 不 reactivate),有界退避重试,超过 `TURN_BARRIER_RETRY_MS` 仍失败 → goal 以 `setup_failed` 类终态退出(回到「欠条超时兜底」);reown 时用既有 `thread/read(includeTurns:true)`(`codex-daemon-client.ts:461-468`)对 `active_turn_id` 做确定性 reconcile(daemon 有活动 turn → 置/保持 id;无 → 清 id 并提升 deferred),reconcile 完成后才武装投递;回放「外部 turn 已开始、mark 前崩溃」「completion 在 Bridge 停机期间发生」「两回调 CommDB 暂不可写」。**barrier 的可执行形状(R2#4)**:`CodexDaemonEvents.onNotification` 保持同步签名;runner 内新增 `codex-turn-barrier.ts`:`observeTurnNotification` 把每个 `turn/started|turn/completed` 的 CommDB 写**按通知顺序串进一条 promise 链**(`barrier = barrier.then(write)`),失败 latched;`settled()` **drain 到稳定链尾**(循环 await 直到链尾不再变化);started 写**以 RPC 响应的 turnId 在 claim 时同步入链**(`claimTurnDispatch` 内 `barrier.enqueue(markTurnStarted(turnId))`,幂等;迟到的 `turn/started` 通知只作重复确认);turnId 取自严格解析的官方 `TurnStartResponse.turn.id`(0.153.2 schema 必填 `turn`),claim 时响应与已缓冲通知都给不出可归属 id → 立即 latch `TurnBarrierError`(不再只记 diagnostic),最终 `setup_failed`,不得继续 goal;测试「响应缺 id、`turn/started` 稍后到」的真实 frame 顺序,断言不 push、不 `setGoal(active)`、不 `leaveHold`;`startTurn` 的调用方(初次 kick `:1243-1269`、`reactivateWake :1007-1024`)在 claim + 入链**之后**、任何 `setGoal(active)` / `finishWake` / `leaveHold` **之前** `await settled()`;`settleTerminal`、`enterPhaseHold`、`runGoalToTerminal` 最终 return 前同样 await;barrier 失败(`setup_failed`)**压过**已流入的 terminal(setup catch `:1452-1483` 的「有 terminal 就吞错」路径对 barrier 错误例外);链内写失败按 1s/2s/4s… 重试,累计超过 `TURN_BARRIER_RETRY_MS`(常量在 `packages/claude-runner`,teamlead 不被反向依赖)→ 从该 await 点抛 `GoalRunError(..., 'setup_failed')`;`thread/read` 结果经严格 parser:0.153.2 官方 `ThreadReadResponse` 顶层唯一必填 `thread`,校验 `result.thread.id === requestedThreadId`、`result.thread.turns[]` 每项 `id: string`、`status ∈ {completed, interrupted, failed, inProgress}`(生成 schema 的 `TurnStatus` 枚举),缺字段/错线程/坏 status → reconcile 失败、不猜;兼容既有 `parseReconcile`(`CodexTurnExecutor.ts:300-315`)接受的顶层 `turns` 旧 envelope 以受测 union 显式列出;fixture 用本机 `codex app-server generate-json-schema` 产物;测试:合法、wrong-thread、缺 turns、坏 status;barrier 测试:response-before-notification、notification-before-response、P2 在等 P1 时入链、terminal 与 barrier 失败同时出现;测试走真实 `handleFrame → onNotification` 路径注入延迟/拒绝 Promise,断言 hold、push、下一 turn、terminal 均未提前发生。
- **A3(g) belt 首次 generation(R5 ⑤)**:无既有行首次 `grantTurn` → `turn_generation = 1`;legacy 行升级后 `= 0`;换手 `+1` 且同一语句 `active_turn_id = NULL`;两处 upsert 各一条。
- **A3(h) shutdown exact-request(R5 ③)**:同 execution 先有 `requested(land-cleanup)` 再来 `resident-expiry` → 两行并存;runtime 一次退出 ACK 全部 pending;`getRunnerShutdownRequest` exact;`db.test.ts` 原「重复请求被忽略」改为「各自成行」;caller sweep 清单(research §4.3)逐项有测试或「未改动」标注。
- **A3(i) drain 与 completion 同事务**:`consumeDrainChallengeTx` 不再独立提交;event route 把核验结果作为 `commitEnrolledCompletion` 的新输入 `drainChallenge`,challenge CAS `issued→consumed` 与 completion 插入、DAG 推进、disposition 写入在**同一个** StateStore 事务;权威 completion digest 用剔除 `drainReceipt` 的业务 payload(event route 在调用前剥离);测试:「challenge 核验后、completion 事务前崩溃」→ 重试仍可消费;「事务提交后 HTTP 响应丢失」→ 重试幂等返回同 eventUid;「同业务 payload 带/不带同一 receipt 重放」不冲突。
- **A3(j) launch snapshot 双向兼容**:`capabilityDigest` 算法与键集合**不变**(`phaseRole` 键保留,新体写 `null`);`loopTargetNodeId` 是 snapshot 上的**非 digest** 字段;reown 时 loop 判定不信任 snapshot 字段,而是从 StateStore `workflow_execution_binding` + pinned snapshot 重新跑 `isLoopTargetNode`;recovery verifier 用 snapshot 已由 parser 校验的 legacy `phaseRole` 值**重建 digest 输入**(`capabilityDigest(ctx, {phaseRole: snapshot.launchContext.phaseRole})`),该值只进 digest、不进 loop 资格;三条合法旧值的双向测试:old(`phaseRole=null`)→new、old(`phaseRole='implement'`)→new(字段 mismatch 单项忽略且 legacy digest 相等、loop 资格只来自 authoritative activation + pinned snapshot)、new→old 二进制回滚(旧算法对 `phaseRole:null` 求 digest 相等,旧代码视为无 keep-alive)。**reown 的 activation 解析(R2#3)**:resident adopt 用 `workflow_resident_hold.activation_id` 调 exact `getWorkflowActivation` 并逐字段核对 hold 行(run/node/attempt/execution);其他 active reown 与 receiver 资格用既有 `resolveCurrentWorkflowActivation`,`ambiguous` → fail-closed(不武装、不判 loop、记 `reown_activation_ambiguous`、下 tick 重试),**不得**退化为 non-loop;**不用**单数 `getWorkflowExecutionBinding`(binding 以 activation 为主键,二次 wake 后同 execution 有 ≥2 行);回放「同一 execution 有 spawn+wake 两条 binding、在 r=2 resident 中重启」。
- **A4 通用性(母单 A1 的本单版本)**:`resident-receiver-supervisor.ts`、`resident-hold.ts`、`completion-drain.ts`、`Blueprint.ts` 的 `phaseKeepAlive` 计算段、`codex-daemon-client.ts` 的 hold/turn 回调段源码不含 `/\b(qa|implement|design)\b/i`(`fly2268-generality.test.ts`;`assertValidPhaseHold` 的 v1 解析分支以函数名白名单例外);三条不同 loop 入边(fixture 节点名任意)经同一 `isLoopTargetNode` + 同一 `enterResidentHold` 产生 `resident` 行(spy)。
- **A7 机制守卫(母单 §A7 在本单再跑一次 + 本单 delta)**:(a) 母单 `fly2248-mechanism-guards.test.ts` 原样通过(`workflow_delivery_%` 仍恰好 3 张;CommDB 该前缀 0 张;`first_push_at` 恰好 1);(b) 本单 allowlist:CommDB 主键重建被 **receipt 门**守住:同步构造器检测到旧 PK 时只有在 `<comm.db>.fly2268-rebuild-receipt.json`(由 Bridge boot 的 async preflight 写;preflight 顺序 = `hash_before(main,WAL)` → `await backupCommDb` → 备份 `quick_check` → `hash_after(main,WAL)`,**`hash_before === hash_after` 才写 receipt**(前后一致性证明:期间任何提交都会改变 WAL/main 字节;不等则重来,最多 3 次),内容 = `{backupPath, backupSha256, sourceBinding:{mainSha256, walSha256}, sourceSchemaDigest, createdAt}`,与既有 FLY-1572 swap intent 的 source binding 同构,`mailbox-migration.ts:1611-1628`)存在,且**受控重建门是 writable open 的第一步**:用只读连接探测旧 PK → 读 receipt → 打开可写连接后**第一条语句**就是 `BEGIN IMMEDIATE`(在 `PRAGMA journal_mode`、`SCHEMA`、`ensureMailboxQueueSchema`、drop views、三个 `ADD COLUMN` 之前),写锁内复验:备份文件存在且 sha256 等于 receipt、备份 `quick_check = ok`(同步 `better-sqlite3` 只读打开)、源库 main/WAL sha256 等于 `sourceBinding`(= 备份之后零已提交写)、schema 摘要匹配——全部成立才重建;任一不成立 → 不重建、抛 `commdb_schema_preflight_required`(binding 不等时错误码 `commdb_schema_preflight_stale`,下一次 boot preflight 重新备份);重建成功后同事务外立即把 receipt 改名为 `<receipt>.consumed-<ISO ts>`(保留回滚定位信息,不可再放行第二次重建)——测试「无 receipt」「同 schema 不同库的 receipt」「备份后源库追加一行(binding 不等)」「backup 缺失/篡改(sha 不等)」「成功后旧 receipt 不可复用」「receipt 合法 → 重建且行数守恒」,前五条**断言 main、WAL、schema 与全部行内容逐字节不变**(不只断言 shutdown 表没重建);fault injection「writer 在 backup 完成与 hash_after 之间提交」→ hash 不等、不写 receipt、不放行;StateStore 新表恰好 `workflow_resident_hold`、`workflow_completion_drain_challenge` 2 张 + 索引 `idx_wrh_expiring`、`idx_wcdc_issued_by_submission`;CommDB 新表 0,新列恰好 3(`three_stage_turn.active_turn_id`、`three_stage_turn.turn_generation`、`runner_phase_wakes.turn_generation`),`runner_shutdown_controls` 重建后列集合 = 旧 6 列 + `settlement_reason`,主键 `(execution_id, request_id)`;(c) 二次启动 schema 一致(`sqlite_master.sql` 快照相等);(d) 告警 uid **构造点 allowlist**:本单新增/修改的文件(`resident-receiver-supervisor.ts`、`resident-hold.ts`、`completion-drain.ts`、`delivery-operations.ts` 的 resident_expiry 段)里每一个 `enqueueInfraAlert`/`workflow_alert_outbox` 构造点都被测试枚举,且产出的 uid 前缀 ∈ 母单三个(receiver 与 expiry 都断言落入 `delivery_operation_stalled`);母单 `fly2248-mechanism-guards.test.ts` 原样不动;(e) 期限 named-constant 逐文件 allowlist:`resident-hold.ts` 只允许 `RESIDENT_GRACE_MS`;`resident-receiver-supervisor.ts` 只允许 `RECEIVER_STALL_MS`、`RECEIVER_HEARTBEAT_EVENT_MIN_INTERVAL_MS`;`packages/claude-runner/src/codex-turn-barrier.ts` 只允许 `TURN_BARRIER_RETRY_MS`;`completion-drain.ts` 零期限;四个文件禁止 raw duration 字面量(`/\b\d{4,}\b/` 在非常量定义行)与 `process.env`。
- **A8 回放**:research §6.1 的 #3、#7、#8 与 #4 半边全部 GREEN(先 RED)。
- **A9 真机(QA 节点)**:一个 loop 入边节点的工人 goal 完成后,30 分钟内收到返工欠条并被再派活,零人工唤醒;`workflow_resident_hold` 行 `resident(r=1) → woken(r=1)`;无 `rework_replacement_materialized` 事件。对照臂:不发 wake,30 分钟后行 `closed(expired)`、`runner_shutdown_controls` exact 行 `acked`、operation `projected`。

## 1. 稳定标识(实现必须逐字使用;母单 §1 移交行 + 本单补齐)

| 类别 | 标识 |
|---|---|
| 常量 | `RESIDENT_GRACE_MS = 1_800_000`;`RECEIVER_STALL_MS = 180_000`;`RECEIVER_HEARTBEAT_EVENT_MIN_INTERVAL_MS = 300_000`;`TURN_BARRIER_RETRY_MS = 60_000`(前三者在 `packages/teamlead/src/bridge/resident-hold.ts` / `resident-receiver-supervisor.ts`,第四个在 `packages/claude-runner/src/codex-turn-barrier.ts`;全部导出常量,不读 env) |
| 新表(StateStore 2,CommDB 0) | `workflow_resident_hold` `workflow_completion_drain_challenge`(DDL 见 §3) |
| 新列(CommDB 3) | `three_stage_turn.active_turn_id TEXT`、`three_stage_turn.turn_generation INTEGER NOT NULL DEFAULT 0`、`runner_phase_wakes.turn_generation INTEGER`;`runner_shutdown_controls` 受控重建:主键 `(execution_id, request_id)` + `settlement_reason TEXT`;StateStore 既有表不加列 |
| `admission_state` 新值 | `deferred_midturn`(仅 mid-turn 到件;边界到件沿用 `queued`) |
| `workflow_resident_hold.state` | `resident` `woken` `expired` `closed`;`closed_reason` ∈ `expired` `terminal` `superseded` `replaced` `run_terminated` `local_hold_failed` |
| `workflow_completion_drain_challenge.state` | `issued` `consumed` `superseded` |
| 确定性 id | `challenge_id = 'drain:<execution_id>:<activation_id>:<business_digest[0:16]>'`;expiry `client_request_id = 'resident-expiry:<execution_id>:r<revision>'`;expiry operation_id = 同串;shutdown `request_id` = 同串;run event uid `resident_expiry:<execution_id>:r<revision>` |
| expiry operation canonical 身份 | `run_id` = hold 行 `run_id`;`canonical_digest = canonicalSubmissionDigest({kind:'resident_expiry', runId, executionId, activationId, nodeId, attempt, revision})`;命中既有 `client_request_id` 行时逐字段比对,任一不等 → `resident_expiry_operation_poison` fail-loud(不覆盖、不重铸) |
| completion 输入(新增) | `commitEnrolledCompletion.input.drainChallenge?: { challengeId, verification: { mailbox: Record<id,'ACKED'\|other>, phaseWakes: Record<id,state> } }`;`completionSubmission` 必须是剥离 `drainReceipt` 后的业务 payload(event route 负责剥离) |
| launch snapshot | `launchContext.phaseRole` 键保留、新体写 `null`;`capabilityDigest` 键集合与算法**不变**,recovery verifier 以 snapshot 的 legacy `phaseRole` 重建 digest 输入;新增非 digest 字段 `launchContext.loopTargetNodeId: string \| null`(只作提示,不作判据);reown 的 loop 判定 = `isLoopTargetNode(pinnedSnapshot, activation.node_id)`,activation 来自 exact(`workflow_resident_hold.activation_id`)或 `resolveCurrentWorkflowActivation`(ambiguous → fail-closed) |
| 迁移 receipt | `<comm.db>.fly2268-rebuild-receipt.json { backupPath, backupSha256, sourceBinding:{mainSha256, walSha256}, sourceSchemaDigest, createdAt }`(`sourceBinding` = hash_before,且 = hash_after);共享早期门 `openCommDbWritable(path)`(`packages/flywheel-comm/src/commdb-open-gate.ts`)被 `CommDB` 构造器与 path 形 `MailboxQueue` 构造器共同调用;备份文件 `<comm.db>.pre-fly2268-<ISO ts>.bak`;成功后改名 `<receipt>.consumed-<ISO ts>`;构造器抛错码 `commdb_schema_preflight_required`(缺失/不匹配)、`commdb_schema_preflight_stale`(源库 binding 不等) |
| completion disposition(新增) | `consume_pending_mail`(以 409 `reason` 返回,不是 disposition 枚举值)`loop_park`(`WorkflowCompletionDisposition` 加一值) |
| completion 业务摘要 | `completionBusinessDigest = canonicalSubmissionDigest(payload without drainReceipt)` |
| 上下文字段 | `loopTarget?: { nodeId: string }` 贯穿 `StartRequest → RunDispatcher → BlueprintContext`;`AdapterExecutionContext.phaseKeepAlive?: { loopTarget: true; nodeId: string }`;Codex launch snapshot 见下行(**无** `'<legacy>'` 哨兵——R1#4 撤销);`PhaseHoldState v2 { schemaVersion: 2, nodeId, residentRevision, graceExpiresAt, state, enteredAt, deadlineRemainingMs, hardDeadlineRemainingMs }` |
| Codex runtime ↔ Bridge 控制面 | `CodexDaemonAdapterDeps.residentHold.enter({executionId, activationId, nodeId, boundarySeq}) → {ok:true, revision, graceExpiresAt} \| {ok:false, reason}`;`residentHold.close({executionId, revision, reason})`;`onTurnStarted({executionId, turnId}) → {ok:true, turnGeneration} \| {ok:false, reason:'not_holder'\|'already_active'}`;`onTurnCompleted({executionId, turnId}) → {ok:true, promoted:number} \| {ok:true, noop:true}` |
| CommDB 新方法 | `markTurnStarted(executionId, turnId)`、`markTurnCompleted(executionId, turnId)`、`getRunnerShutdownRequest(executionId, requestId)`、`listPendingRunnerShutdowns(executionId)`、`finishAllPendingRunnerShutdowns(executionId, result, nowMs)`、`settleFailedRunnerShutdowns(executionId, reason)`;`enqueueRunnerPhaseWake` 第 4 参 `{admissionState?:'deferred_midturn', turnGeneration?:number}` |
| StateStore 新方法 | `enterResidentHold` `closeResidentHold` `wakeResidentHold` `expireResidentHoldsTx` `listPendingResidentExpiryOperations` `applyResidentExpiry` `markResidentExpirySent` `projectResidentExpiry` `markResidentExpiryFailed`;`issueDrainChallenge` `consumeDrainChallengeTx` |
| run event kinds(新增) | `resident_hold_entered` `resident_hold_woken` `resident_hold_expired` `resident_hold_closed` `resident_hold_adopted` `completion_drain_issued` `completion_drain_consumed`;session_events `receiver_heartbeat` `receiver_armed` `receiver_stalled` `receiver_unsupported` |
| 告警 uid 前缀 | **零新增**;stall 沿用 `delivery_operation_stalled:<operation_id>`;receiver 升级沿用既有 `enqueueInfraAlert` 路径,uid `delivery_operation_stalled:receiver:<execution_id>:<episode>`(前缀仍是母单三个之一) |
| HTTP / CLI | `flywheel-comm complete --drain-receipt <challengeId>`;409 `{error:'workflow_completion_rejected', reason:'consume_pending_mail', challengeId, mailbox:[], phaseWakes:[]}`;409 `reason:'drain_receipt_rejected'`;409 `reason:'completion_deferred_pending_mail', detail:'commdb_unreadable'` |
| 母单接口(不得改形状) | attempt 表 `attempt` 序号(revive 重发 +1);`workflow_delivery_operation.kind='resident_expiry'`(DDL 已含);`delivery_operation_stalled` 前缀 |

## 2. 里程碑

### M3-0 — RED 床(先失败)

- `packages/teamlead/src/__tests__/fly2268-replay.test.ts`(#7、#8、三种旧 shutdown 状态、mid-grace 重启)、`packages/claude-runner/test/fly2268-resident-receiver.test.ts`(#3、#4 半边、A3(c)(f))、`packages/flywheel-comm/src/__tests__/db.fly2268.test.ts`(A3(g)(h)、迁移守恒)、`packages/teamlead/src/__tests__/fly2268-mechanism-guards.test.ts`(A4、A7b–e)。全部先 RED,PR body 引用。

### M3-1 — durable turn 状态 + shutdown 表重建(CommDB,可独立合入)

- research §2.1–§2.4 + §4.1–§4.4 全部,加 research §8.2/§9.4(turn barrier)、§9.2(备份 preflight + receipt 门)。顺序:(1) Bridge boot **async preflight**(`plugin.ts` 在首个 `new CommDB` 之前,对每个 project:只读探测旧 PK → `await backupCommDb` → `quick_check` → 写 receipt;任一失败 → Bridge 启动失败)→ (2) 同步 writable open:**门在最前**——只读探测旧 PK → 读 receipt → 可写连接第一条 `BEGIN IMMEDIATE` → 复验(备份 sha/`quick_check`/源 main+WAL sha/schema)→ shutdown 表重建 → COMMIT → receipt 改名 consumed → 才进入既有构造器路径(`PRAGMA journal_mode=WAL`、`SCHEMA`、`ensureMailboxQueueSchema`、drop views、`applyMigrations` 含三个 `ADD COLUMN`);无旧 PK 时门为空操作 → (3) `grantTurn` 两处 upsert(INSERT 写 1、UPDATE +1 清 id、旧 holder deferred 提升)→ `markTurnStarted/markTurnCompleted` → `enqueueRunnerPhaseWake` 分类参数 → reader 矩阵(`codex-phase-lifecycle.ts:291` 过滤 deferred)→ 6 个新/改 shutdown 方法 → caller sweep 7 项。**不假设全 writer 停机**(R3#1:`scripts/restart-services.sh:2981-3172` 只在 Step 1 停 Bridge,Step 3 起新 Bridge,Step 4 才重启 Leads;在飞 adapter 与 `send/ask/gate/notify` 等 CLI 都能独立写 CommDB)。安全性改由 **精确 source binding** 保证:receipt 绑定备份时刻的源库 main/WAL sha256,构造器在写锁内复验相等才重建 ⇒ 备份与重建之间若有任何已提交写,重建被拒(`commdb_schema_preflight_stale`),Bridge 本次启动失败并在下次 boot 重新 preflight;preflight 内部以 hash-before/backup/hash-after 一致性证明保证「备份 = receipt 所绑源快照」(R4#2);preflight → 构造器打开在同一进程内相隔毫秒级,失败即重试(preflight 最多 3 次,仍 stale → Bridge 启动失败并告警既有 boot 通道)。receipt 缺失时新代码 fail-loud、绝不用新代码写旧 schema——门在任何 PRAGMA/SCHEMA/加列之前(R4#1)。writer 全集 = **所有对 comm.db 的 writable open**(`new CommDB`、path 形 `new MailboxQueue(path)`、直接 `new Database(commDbPath)`),research §11.3 逐项列出,新二进制路径共享同一早期门;在飞旧进程由 preflight 的一致性证明保证(它们的提交会让 hash 不等 → 不放行)。
- 测试:legacy 行 0、首次 grant 1、换手 +1 且清 id、重复 `turn/started` 0 rows、重启后 `turn/completed`(无内存 generation)、两种交错顺序、非持棒 `queued`、终态清理收 deferred;shutdown:重建行数守恒、两行并存、exact 读、ACK 全部 pending、`failed` set-once settlement、跨 execution 同名 request 允许。

### M3-2 — 工人层:常驻收信员、durable turn 状态、loop 常驻(revision + barrier)、完成前清信(**母单 plan round 5 §M3 原文,原样搬入**)

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

**本单对上文「同 round 3」的展开与对 HEAD 的落点更正(不改机制)**——全部在 research.md(round 2 更正在 §8,以 §8 为准):§1(所有权收归、武装三时机、心跳/分类器/episode)、§2.4(reader 矩阵 8 处,含 `codex-phase-lifecycle.ts:291` 必改一处)、§3.1(`loopTarget` 贯穿 12 个环节;`run-infra.ts:217` env 回填改源)+ §8.4/§9.1(launch snapshot:digest 算法不变、legacy `phaseRole` 只进 digest 重建、loop 资格来自 activation + pinned snapshot)、§3.3(held loop 到期只压短等待、只有 shutdown 行才退出)、§3.5(Claude 分支 ② = `killTmuxWindow` + `closeRunnerTerminalView`,③ = `probeRunnerProcessLiveness ∈ {dead_pin, absent}`)、§5(event route 三步与 409 形状)。
**R1 结论**:codex-cli 0.153.2 协议**有** `turn/steer`(schema 证据),但无阳性对照 ⇒ 本单语义不升级;steer 只允许作为实现节点的独立 commit 且必须附真实 app-server 阳性对照测试。

### M3-3 — 收口

- A7(a)–(e) 守卫、A4 通用性守卫、research §7 dead code 清单(`stopIntake` 空壳、`CodexPhaseRole` 只剩 v1 解析)在 PR body 列出并问 Lead 后再删。
- 母单 §A3(b) 重武装 + §A7 在本单 CI 再跑一次(同一 PR 的 CI 即证据,PR body 贴 job 名)。

## 3. Schema 与迁移

**StateStore(全加法,只加表 + 索引;不加列、不改 CHECK、不重建)**:

| 表 | DDL | 索引 / 约束 | 为什么不能是现有表的列 |
|---|---|---|---|
| `workflow_resident_hold` | research §3.2 | `PRIMARY KEY (execution_id)`;`idx_wrh_expiring (state, grace_expires_at)`;FK `execution_id → workflow_actor` | 母单 round 5 §3 原文:候选宿主 `sessions` 已被 FLY-2211 `lifecycle_revision` + execution mutation lease 保护,再放一套 revision/state/deadline CAS 会让两套 fence 互相误判过期;独立 1 行/execution 小表隔开。 |
| `workflow_completion_drain_challenge` | research §5.2 | `PRIMARY KEY (challenge_id)`;唯一部分 `idx_wcdc_issued_by_submission (execution_id, activation_id, business_digest) WHERE state='issued'` | 母单 round 5 §3 原文:挑战发生在「完成被暂缓」时刻,`workflow_node_completion` 行还不存在;挂 `sessions` 回到上一行 fence 冲突;部分唯一索引在宿主表上无法表达。 |

`workflow_delivery_operation` **不动**(`kind='resident_expiry'` DDL 已含,FLY-2278 迁移已落地);`workflow_run_event.kind` 白名单追加 §1 kinds(非 schema)。

**CommDB**:
- `three_stage_turn ADD COLUMN active_turn_id TEXT`、`ADD COLUMN turn_generation INTEGER NOT NULL DEFAULT 0`(`db.ts:1235-1257` 既有循环追加两项);
- `runner_phase_wakes ADD COLUMN turn_generation INTEGER`(`:1268-1275` 同款);
- `runner_shutdown_controls` **受控重建**(research §4.1;触发条件 `sqlite_master.sql` 不含 `PRIMARY KEY (execution_id, request_id)`;**重建前置 = receipt 门**(R2#2:`backupCommDb` 是 async,同步构造器不能等它):Bridge boot 的 async preflight `await backupCommDb(dbPath, '<comm.db>.pre-fly2268-<ISO ts>.bak')` → 备份 `PRAGMA quick_check = ok` → 写 receipt;共享早期门 `openCommDbWritable` 在可写连接的第一条语句 `BEGIN IMMEDIATE` 内(任何 PRAGMA/SCHEMA/加列之前)复验备份 sha256 + 备份 `quick_check` + 源库 main/WAL sha256(= receipt `sourceBinding`)+ schema 摘要,全部匹配才重建,否则抛 `commdb_schema_preflight_required` / `commdb_schema_preflight_stale`;成功后 receipt 改名为 consumed;`sessions_fly1066` 同款 `CREATE → INSERT SELECT → DROP → RENAME`;事务内;行数守恒断言);
- 降级承诺:旧二进制读新库不崩(`getTurn` 显式列名;新列有默认值;shutdown 表列集合是旧的超集,旧 `INSERT (execution_id, request_id, state, requested_at)` 仍合法——但旧二进制的「同 execution 第二次请求被 IGNORE」语义会变成「各自成行」,这是 FLY-2248 母单 Lead 定义 #6 的既定代价);不承诺功能等价。

**CommDB 全部 delta(A7b 的 allowlist)**:新表 0;新列 3;重建表 1(`runner_shutdown_controls`,列 +1 `settlement_reason`,主键变更,`request_id` 全局 UNIQUE 撤销);新索引 1(`idx_rsc_pending`)。

## 4. 回滚边界

- **M3-1(CommDB)与 M3-2(Bridge/runtime)可分两 PR 合入,回滚顺序相反**:M3-2 先回滚(新列被旧代码忽略,`deferred_midturn` 行无 reader → 由终态清理按 `? = 1` 路径收掉;`workflow_resident_hold`/challenge 残留行无 reader;`loop_park`/`consume_pending_mail`/`--drain-receipt` 消失;receiver 回到 phase-hold 期间才开);M3-1 回滚需要**恢复 `runner_shutdown_controls` 旧主键**——按 CommDB 备份/恢复边界回滚:恢复步骤 = 停 Bridge、gateway 与全部 runner(与部署窗口同一套停机顺序)→ 删除 `<comm.db>-wal`、`<comm.db>-shm` → 把备份 `cp` 到 `<comm.db>.restore.tmp` 后 `mv -f` 原子替换 → 对恢复库 `PRAGMA quick_check` → 删除 receipt → 起旧二进制;备份是 §3 迁移 preflight 产物(R1#5:HEAD 上**没有**「Bridge 启动既有备份」,本单把 `backupCommDb` 接进这一次迁移),**不写反向迁移代码**(母单 R5#6 Lead 已裁定「CommDB shutdown 表受控重建且按备份/恢复边界回滚」)。回滚无数据丢失的保证来自 source binding 而不是停机:重建只在「源库 main/WAL 与备份时刻逐字节相同」时发生,因此备份 = 重建前一刻的完整状态;回滚到该备份只丢弃重建之后(新代码期间)的写,这是回滚本身的既定代价。
- 在飞 Codex 体升级窗口:`capabilityDigest` 算法不变,旧 snapshot(`phaseRole` 任意值)在新二进制下 digest 相等、被 reown 正常认领,其 loop 资格由 binding + pinned snapshot 重算(旧 phase 角色不再自动等于常驻);回滚到旧二进制时,新 snapshot 的 `loopTargetNodeId` 被旧解析器忽略、`phaseRole=null` 参与旧算法 digest 与存值相等 ⇒ 旧代码视为无 phaseKeepAlive → 该体完成后直接 terminal(回到现状,不会更差)。A3(j) 三条双向测试锁住。
- `RESIDENT_GRACE_MS` 是常量,没有运行时旋钮,回滚 = 回滚代码。

## 5. 负向守卫(必须有对应测试)

1. supervisor 是 receiver 唯一 owner:`confirmHoldPaused/leaveHold/stopIntake` 对 watcher 零调用(spy);一个 execution 一个 callback、一次 start;仅 terminal/supersede/replacement 时 disarm。
2. `deferred_midturn` 行在当前 turn 内对 push/claim/t2/started-ACK 不可见(reader 矩阵 8 处各一断言);`turn/completed` 事务后、下一次 `startTurn` 前可见;Bridge mid-turn 重启后分类正确;非持棒 execution 到件为 `queued`;终态清理收走 deferred 行。
3. `grantTurn`:首次 1、换手 +1、同一 UPDATE 清 `active_turn_id`、旧 holder deferred 全提升;`markTurnStarted` 二次 0 rows;`markTurnCompleted` 换手后 no-op。
4. 常驻宽限:`enter` 幂等 adopt(同 activation/boundary_seq 返回原 revision);`woken(r)` + 更大 boundary_seq → r+1;`expired/closed` 上 enter 拒绝;旧 revision wake/expiry no-op;`enter` 失败 → 不 hold、原 terminal;本地写盘失败 → 补偿 close;held loop 只在 shutdown 行出现时退出(到期无行不自行退出);退出 ACK 全部 pending。
5. expiry saga:前置失败零写入;每 barrier 重放 0 side effect(exact request 行 / pane gone 为证据);三种旧 shutdown 状态各一条,expiry 自己的 requestId 都 `acked` 且 operation `projected`;CommDB 不可读 → 本 tick 跳过、下 tick 重驱;`failed` → operation `failed` + `delivery_operation_stalled` 恰好一次。
6. drain 七个负例:错误/旧/他人 challengeId 拒绝;mail_set 内任一未 ACK/started 拒绝;同 challenge 只 consumed 一次;同业务提交不重铸;CommDB 不可读拒绝完成;水位线后新信不阻塞;`drainReceipt` 不参与 business digest。
7. shutdown 表:重建行数守恒;同 execution 两 request 并存;`requestRunnerShutdown` 读回 exact 行;`finishAllPendingRunnerShutdowns` 只动 `requested`;`settlement_reason` set-once 二次 0 rows;prune 仍按 execution 整体删。
8. 通用性:A4 文件集合零节点名;三条任意命名 loop 入边共用同一函数(spy)。
9. 机制守卫:A7(b)–(e) allowlist(告警前缀 = 构造点 allowlist;期限 = 逐文件 named-constant allowlist;`process.env` 零读取)。
10. 母单守卫原样通过:`fly2248-mechanism-guards.test.ts`、`fly2248-alert-prefix`、`fly2278-m0-schema.test.ts`。
11. turn barrier fail-closed:`markTurnStarted` 写失败 → 该 turn 内不 push 任何 wake、held 不 reactivate;`markTurnCompleted` 写失败 → 不开下一 turn;超过 `TURN_BARRIER_RETRY_MS` → goal 终态 `setup_failed`(不是静默降级为 `queued`);reown reconcile 用 `thread/read(includeTurns:true)` 且 reconcile 前 supervisor 不投递。
12. drain 原子:challenge `issued→consumed` 与 completion 在同一事务(事务回滚 → challenge 仍 `issued`);`drainReceipt` 不进入 `completion_submission_digest`。
13. `phaseKeepAlive` 消费者全扫(TypeScript 编译即守卫 + 用例):`Blueprint.ts:1640-1649`(计算)、`:2490-2509`、`:2519-2525`(prompt 文案里的 `${phaseKeepAlive.role}` 改为 `ctx.sessionRole`)、`:2855`(透传)、`CodexTmuxAdapter.ts:1039-1049`(lifecycle factory 去 `role`)、`codex-phase-lifecycle.ts:20-39,181-188`(`CodexPhaseRole` 只剩 v1 parser 白名单)、`codex-session-reown.ts:221`、`run-infra.ts:217-221`;一条「非三阶段名称的 loop 目标」prompt 用例断言文案不含 `undefined`。
14. expiry operation 身份:`canonical_digest` 按 §1 公式;既有行字段不等 → `resident_expiry_operation_poison` 抛错;poison 负例测试。
15. 迁移备份:构造器检测到旧 PK 且 receipt 缺失/schema 不匹配 → `commdb_schema_preflight_required`;源库 main/WAL binding 不等 → `commdb_schema_preflight_stale`;备份缺失/sha 不等/`quick_check` 失败 → 不重建;成功后 receipt 变 consumed 不可复用;preflight 备份或校验失败 → 不写 receipt、Bridge 不启动;receipt 合法 → 重建、行数守恒。生产 writer 全集(research §11.3)各一条「旧 PK + 无 receipt → fail-loud 不写」;门在 writable open 最前端:缺失/stale 时 main、WAL、schema、行内容逐字节不变。
18. preflight 原子绑定:`hash_before === hash_after` 才写 receipt;fault injection「backup 完成与 hash_after 之间有提交」→ 不写 receipt。
19. writer census:`rg "new CommDB\\(|new MailboxQueue\\(|new Database\\(" packages scripts` 全集入表,每个 writable open 路径都经 `openCommDbWritable`(静态守卫:除该文件外不得直接 `new Database(<comm.db path>)` 可写打开)。
16. reown activation 解析:adopt 用 hold 行 `activation_id` exact 核对;`resolveCurrentWorkflowActivation` 返回 ambiguous → 不武装、不判 loop、下 tick 重试;同 execution 多 binding 回放。
17. turn barrier 串行:通知顺序 = 写顺序(乱序注入测试);`settled()` drain 到稳定链尾(P2 在等 P1 时入链的测试);started 写在 claim 时以严格解析的 `TurnStartResponse.turn.id` 入链(response-before-notification / notification-before-response 两序);claim 时无可归属 id → latch `TurnBarrierError` → `setup_failed`(「响应缺 id、通知迟到」负例);latched 失败后任何 `startTurn`/`setGoal(active)`/`finishWake`/`leaveHold`/hold/terminal 都被挡且 `setup_failed` 压过 terminal;`thread/read` 严格 parser 按 `result.thread.{id,turns[]}` 校验并拒绝 wrong-thread/缺 turns/坏 status。

## 6. 显示文案(Lead / runner 收到的样子)

- `consume_pending_mail`(CLI 409 输出):「完成被暂缓:你信箱里还有 <n> 条未消费交接(mailbox <ids> / phase-wake <ids>)。读完并处理后重跑 `flywheel-comm complete … --drain-receipt <challengeId>`。」
- `loop_park`(CLI):「已 park 等待返工唤醒(常驻宽限 30 分钟);等 wake,勿自行轮询。」
- `receiver_stalled` 升级(Lead 收件,沿用 `delivery_operation_stalled` 前缀):「<issue> 工人 <exec8> 的收信员连续 3 次无响应,已进程内重武装 1 次仍无效;信件仍 durable 入队、不会丢,但送达会延迟到下一次重武装或欠条超时告警。」
- `resident_hold_expired`(informational run event,不发 Lead):「<exec8> 在 <node> 常驻 30 分钟无返工唤醒,已按期关停(request <id> acked)。」
- 文案进 `alert-kind-copy.ts`(母单同处)。

## 7. progress.md chunk 约定

`--set-chunk M3-0=…|M3-1=…|M3-2=…|M3-3=…`,状态 `pending|red|green|reviewed`;GREEN 后先 push 再更新 chunk。

## 8. 不做

- `turn/steer` 实时注入(无阳性对照);不改 codex 官方二进制。
- 不改 mailbox 关系/新鲜度模型(FLY-1792)、FLY-2211 reown 判死判据、`phase-actor-reentry` 枚举。
- 不新增 feature flag、env 旋钮、告警层、告警 uid 前缀、欠条 state 值、第二张 saga 表、欠条表新列、StateStore 表重建。
- 不改 `sessions.phase_keep_alive` 语义(loop 目标同样为 1)。
- 不在本单修 land 执行器吞错(FLY-2246)。

## 9. 随本单闭合的 Codex round 5 未过项

| # | 原文要点 | 闭合落点 |
|---|---|---|
| R5 #3 [BLOCKER] | 只改主键未迁移单行读取合同;runtime 可能 ACK 旧行,saga 永远等不到自己的 ACK;要 exact-request 查询 + 多 pending 规则 + caller sweep + 三种旧状态测试 | research §4.2(读写合同 7 方法)、§4.3(caller sweep 全集逐项处置)、§4.4(多 pending 规则:任意 requested 即退出、退出 ACK 全部 pending);验收 A3(e)(h);守卫 §5.5/§5.7 |
| R5 #5 [HIGH] | 新 belt 行首次 generation 未定义 | research §2.2(两处 INSERT 写 1、UPDATE +1);验收 A3(g);守卫 §5.3 |

## 10. Codex round 1(2026-09-03,`codex-review/round1.md`)闭合表

| # | 项 | 处置 | 落点 |
|---|---|---|---|
| R1#1 [B] | 候选集误绑 `phase_keep_alive=1`;初次 arm 早于 launch commit | 接受 | §0 A3(a);research §8.1 |
| R1#2 [B] | turn 回调 fail-open;重启后无 reconcile owner | 接受 | §0 A3(f);§1 `TURN_BARRIER_RETRY_MS`;§5.11;research §8.2 |
| R1#3 [B] | drain 消费与 completion 不原子;`drainReceipt` 污染 digest | 接受 | §0 A3(i);§1 completion 输入;§5.12;research §8.3 |
| R1#4 [B] | `'<legacy>'` 哨兵 + digest 键替换双向不兼容;哨兵当 nodeId 违反 loop-only | 接受(撤销哨兵;digest 不变;nodeId 从 binding 还原) | §0 A3(j);§1 launch snapshot;§4;research §8.4 |
| R1#5 [B] | 「Bridge 启动既有备份」不存在 | 接受(接入既有 `backupCommDb` 作迁移 preflight) | §2 M3-1;§3;§4;§5.15;research §8.5 |
| R1#6 [H] | `phaseKeepAlive.role` 消费者漏扫 | 接受 | §5.13;research §8.6 |
| R1#7 [M] | expiry operation 缺 `run_id`/`canonical_digest` 定义 | 接受 | §1 canonical 身份;§5.14 |
| R1#8 [M] | A7(d)「全仓恰好三个前缀」不可执行 | 接受(改为构造点 allowlist) | §0 A7(d) |

## 11. Codex round 2(2026-09-03,`codex-review/round2.md`)闭合表

| # | 项 | 处置 | 落点 |
|---|---|---|---|
| R2#1 [B] | legacy 非空 `phaseRole` 仍使 digest 不等;`'x'` 不是合法旧值 | 接受(verifier 用 snapshot 的 legacy `phaseRole` 重建 digest 输入;测试用 `implement`) | §0 A3(j);§1 launch snapshot;research §9.1 |
| R2#2 [B] | `backupCommDb` 是 async,同步构造器等不到;停 Bridge 不等于冻结 | 接受(Bridge boot async preflight + receipt 门;冻结 = 部署停机窗口;恢复步骤含 sidecar 清理与原子替换) | §0 A7(b);§1 迁移 receipt;§2 M3-1;§3;§4;§5.15;research §9.2 |
| R2#3 [B] | 单数 `getWorkflowExecutionBinding` 在二次 wake 后返回 undefined | 接受(adopt 用 hold 行 activation exact;其余用 `resolveCurrentWorkflowActivation`,ambiguous fail-closed) | §0 A3(j);§5.16;research §9.3 |
| R2#4 [H] | 通知链同步,async callback 会丢 Promise;常量放错包 | 接受(runner 内串行 barrier promise 链 + 统一 await 点;常量移到 claude-runner;严格 parser) | §0 A3(f);§1 常量;§5.17;research §9.4 |
| R2#5 [M] | §5.9「全仓恰好三个」与 A7(e) 期限守卫自相矛盾 | 接受 | §0 A7(e);§5.9 |
| R2#6 [L] | M3-2 落点残留 `'<legacy>'`/digest 替换;M3-1 重建写两次;`turn_barrier_failed` 未登记 | 接受(清掉;`turn_barrier_failed` 降为 `client.logDiagnostic`,不持久、不告警) | §2 M3-1/M3-2;research §9.4 |

## 12. Codex round 3(2026-09-03,`codex-review/round3.md`)闭合表

| # | 项 | 处置 | 落点 |
|---|---|---|---|
| R3#1 [B] | 「updater 已停全部 writer」与 `restart-services.sh` 顺序不符;writer 清单不全 | 接受(撤销断言;改为 source binding 写锁内复验;writer 全集逐项列出) | §2 M3-1;§4;§5.15;research §10.1 |
| R3#2 [B] | receipt 只绑 schema,不绑数据态;不复验备份 | 接受(receipt 绑 main/WAL sha256 + 备份 sha256;写锁内复验;成功后 consumed) | §0 A7(b);§1 receipt;§3;§5.15;research §10.2 |
| R3#3 [B] | `settled()` 只到当前链尾,`startTurn` 后 started 写可逃逸;barrier 失败被 terminal 吞 | 接受(drain 到稳定链尾;claim 时以响应 turnId 入链;await 点前移到 `setGoal(active)`/`finishWake`/`leaveHold` 之前;`setup_failed` 压过 terminal) | §0 A3(f);§5.17;research §10.3 |
| R3#4 [B] | parser 顶层 `threadId/turns` 与 0.153.2 `ThreadReadResponse{thread}` 不符 | 接受(按 `result.thread.{id,turns[]}`;status 枚举;旧 envelope 受测 union) | §0 A3(f);§5.17;research §10.4 |

## 13. Codex round 4(2026-09-03,`codex-review/round4.md`)闭合表

| # | 项 | 处置 | 落点 |
|---|---|---|---|
| R4#1 [B] | 构造器把三个 `ADD COLUMN`、PRAGMA、SCHEMA、queue schema、drop views 排在 receipt 门之前,合法 receipt 被自己写 stale;缺 receipt 时也非零写入 | 接受(门移到 writable open 第一条 `BEGIN IMMEDIATE`;负例断言逐字节不变) | §0 A7(b);§1;§2 M3-1;§3;§5.15;research §11.1 |
| R4#2 [B] | `backupCommDb` 之后才算 binding,backup 与 binding 不原子 | 接受(hash-before / backup / hash-after 一致性证明;fault injection) | §0 A7(b);§2 M3-1;§5.18;research §11.2 |
| R4#3 [H] | writer census 只扫 `new CommDB(`,漏 path 形 `MailboxQueue` 与直接 better-sqlite3 | 接受(全集 = 所有 writable open;共享 `openCommDbWritable` 早期门;静态守卫) | §1;§2 M3-1;§5.19;research §11.3 |
| R4#4 [H] | claim 时缺 turn id 只记 diagnostic,barrier 可空过 | 接受(严格解析 `TurnStartResponse.turn.id`;缺 id 即 latch) | §0 A3(f);§5.17;research §11.4 |

