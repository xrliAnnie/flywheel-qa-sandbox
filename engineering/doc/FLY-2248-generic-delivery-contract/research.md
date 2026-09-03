# FLY-2248 通用投递合同 — 调研
Issue: FLY-2248 (https://linear.app/geoforge3d/issue/FLY-2248/引擎loop稳定性-通用投递合同-欠条必达超时升级工人常驻收信失联判据先问送达每种冻结配正门覆盖所有-dag-loop非)
日期: 2026-09-02
基于: exploration.md

本文回答一个问题:exploration §4 的四个通用对象,分别挂在代码的哪一处、复用什么、新增什么、如何用 09-01 的 8 起事故逼出测试。所有 file:line 均以分支头 `4e77a3973`(main 同步)为准。

## 1. 欠条层:8 个家族 → 6 个规范阶段的映射

### 1.1 规范阶段

```
minted ──► granted ──► sent ──► received ──► consumed ──► settled
   │          │          │          │            │
   └──────────┴──────────┴──────────┴────────────┴──► frozen(shape) / superseded / cancelled / undeliverable
```

- `minted`:交接义务已在账本上诞生。
- `granted`:目标工人拿到了改代码的权(TURN),或新执行体已被 admission。
- `sent`:物理投递已发出(信箱写盘 / `turn/start` 已发 / 启动命令已发)。
- `received`:接收端产生了可归因回执(mailbox ACK、`flywheel-comm turn` 回执、phase wake `started`、launch delivery evidence)。
- `consumed`:工人对这份交接的第一个业务动作(`stage set`、首个 heartbeat、`turn yours` 后的首次提交、goal turn 真正开始)。**这是新增的观测点**,现有家族里只有 `runner_phase_wakes.started` 与 carrier 的 `receipt_started` 接近它。
- `settled`:义务核销(completed / acked / finished / delivered)。

### 1.2 家族映射表(数据,不是分支逻辑)

| 家族 id | 源表 / 对象 | minted | granted | sent | received | consumed | settled | frozen | 进度令牌 | 阶段进入时刻 |
|---|---|---|---|---|---|---|---|---|---|---|
| `rework` | `workflow_rework_delivery`(`StateStore.ts:20755`) | pending | turn_granted | awaiting_receipt | wake_delivered | (新)attempt 行 `consumed_at`,见 §1.4 | completed | held / needs_lead / replacement_pending | 规范阶段 id | `workflow_delivery_attempt` 行的 set-once 列:`granted_at` 仅在 `pending → turn_granted` 成功时写(`markWorkflowReworkGrantStarted` 不写);`received_at` 在 wake receipt 或 replacement launch(`replacement_pending → wake_delivered`)时写(**不用** `generation`/`updated_at`/run event 挖掘) |
| `carrier` | `workflow_carrier_delivery`(`:19969`) | pending | grant_started / turn_granted | awaiting_receipt | receipt_started(**现有状态机 `awaiting_receipt → receipt_started` 一步到位,没有 `wake_delivered`**) | receipt_started(同一回执同时写 received+consumed,`consumedEvidence='observed'`) | completed | held / needs_lead | 规范阶段 id | attempt 行 set-once 列(同上) |
| `turn_wake` | CommDB `turn_wake_outbox`(`db.ts:114-140`) | pending | — | sent | acked | — | acked | cancelled | 规范阶段 id | `created_at` / **`first_push_at`**(既有不可变列;没有 `sent_at`)/ `acked_at`(不用 `push_count`、`last_push_at`) |
| `phase_wake` | CommDB `runner_phase_wakes`(`db.ts:175-199`) | pending 且 `first_push_at` 空(**从未推送即仍是 minted**) | — | pending 且 `first_push_at` 非空 | started | started | finished | — | 规范阶段 id | `queued_at` / **新增 set-once `first_push_at`**(`last_push_at` 每次 push claim 重写,只管 retry,禁用)/ `started_at` / `finished_at` |
| `mailbox` | CommDB `mailbox`(`mailbox-schema.ts:79-122`),仅 `recipient_kind='runner'` 且 type ∈ {instruction, response} 且 `carrier='inbox'` | QUEUED 且 `notified_at`/`delivered_at` 皆空(**信箱文件未写即仍是 minted**) | — | `COALESCE(notified_at, delivered_at)` 非空 | ACKED(claude `on_delivery`)/ ACKED(codex `on_consume`,同时也是 consumed) | ACKED(codex)/ 推断(claude,§1.4) | ACKED | DEAD(→ undeliverable);`superseded_by` 非空(→ superseded);收件人 session 终态且未 ACK(→ undeliverable);在飞批次 ≥3 且 QUEUED(→ frozen `mailbox_inflight_slots_exhausted`) | 规范阶段 id | `created_at` / `COALESCE(notified_at, delivered_at)` / `acked_at`(**不用** `claim_expires_at`、`retry_count`、`lease_retry_count`) |
| `launch` | `workflow_launch_owner.delivery_state`(`:21209`)+ `workflow_side_effect_ledger(kind='dispatch')` + `workflow_execution_binding` | pending(attempt `minted_at`) | admission(`bound_at` → attempt `granted_at`) | dispatch `started_at` → attempt `sent_at` | dispatch `committed_at` → attempt `received_at` | 该 execution 首个 `session_events` 业务事件 → attempt `consumed_at` | = consumed | `unlaunched_admission_held` / `rolled_back` | 规范阶段 id | attempt 行 set-once 列(源事件时刻写入;**不用** `delivery_attempt` 计数、lease 反推) |
| `land` | `land_operation`(states intent/running/partial/completed/held) | intent(`created_at`) | — | running(仍取 `created_at`:intent 即已发出) | partial(首条 `land_operation_step` receipt 时间) | — | completed(`finalization_completed_at`) | held | 规范阶段 id | `created_at` / 首条 step receipt / `finalization_completed_at`(**不用** `retry_count`、`resume_generation`、`updated_at`) |
| `gate_holder` | `workflow_gate_holder.materialization_stage`(`:19831-19884`)+ `workflow_gate_holder_evidence` | question_intent(`created_at`) | question_written | session_bound / card_posted | card_bound | — | completed | superseded | 规范阶段 id | 各 stage 在 `workflow_gate_holder_evidence` 首次出现的时间(**不用** `updated_at`) |

覆盖检查:founder 列的五种交接——design→implement / implement→QA(`launch`)、QA 返工→implement(`rework`+`turn_wake`+`phase_wake`/`mailbox`)、换体(`rework.replacement_pending` + `launch`)、founder_gate resume(`rework` with `authority='founder'` + `carrier` + `gate_holder`)——每一种至少落在一个家族上。09-01 的 founder_gate→general 欠条(`fc0f8bd7…`,`authority=founder`)就在 `rework` 家族里,证明它不是 QA 专属对象。

### 1.3 现有闹钟(要被替换为统一合同的)

| 家族 | 现有闹钟 | 位置 | 处置 |
|---|---|---|---|
| rework | 30min alert / 60min hold;`actor_alive_after_receipt` 新鲜时不 hold | `workflow-engine-dispatcher.ts:1129-1262` | alert 归并到合同 watch;**hold 动作移除**(冻结只能由转移层的死证据触发,见 §3) |
| turn_wake | 20min 无回执 → Lead question | `db.ts:5564-5624`、`turn-wake-patrol.ts:35` | 保留(它是 CommDB 侧,Bridge 死也能响),但 uid 纳入合同 episode 去重 |
| mailbox | 6 次重试 → DEAD;`lead_unacked` 死信通知 | `runner-mailbox-lane.ts:229-290` | 保留 DEAD 终态;新增 `sent` 阶段年龄期限与 slot 耗尽原因 |
| phase_wake / launch / land / gate_holder | 无年龄闹钟(land 有 9 次重试 ≈4h 后 held) | — | 全部由合同 watch 覆盖 |

### 1.4 「consumed」证据的采集点

- rework / carrier:`flywheel-comm turn` 回执(`commands/turn.ts:172-184` → `db.ackTurnWakes`)已经是 `received`;`consumed` 取该 activation 的首个 `stage set`(`packages/flywheel-comm/src/commands/stage.ts` → Bridge `/api/stage`)或 Codex `runner_phase_wakes.started`。写入 `workflow_delivery_attempt` 行的 `consumed_at`(set-once,`WHERE consumed_at IS NULL`;IOU 表**不加列**,plan §1 Lead 定义 #1)。
- launch:`workflow_execution_binding` 已有 `bound_at`;`consumed` 取该 execution 的首个 `session_events` 业务事件(`stage_changed` / heartbeat),由该事件的写入点 set-once 写进 attempt 行的 `consumed_at`(阶段钟以 attempt 表为权威,source 不做联结推导)。
- mailbox(claude):`on_delivery` 语义下 ACK 只证明写盘成功;真正的「读到」回执是 `inbox-check.sh` 的 hook 出口或 CLI poller——**研究项**:claude-code 的 `useInboxPoller` 不回写任何回执,本单不改 CLI;`consumed` 对 claude mailbox 家族取「ACK 后该 execution 的下一个业务事件」作为近似,并在合同快照里标 `consumedEvidence: 'inferred'`。

### 1.5 Watch 的落点与告警通道

- 落点:`plugin.ts:7288-7310` 的 codex 维护 tick(5 分钟,tick 0 = boot pass)。在 `codexSessionReowner.runPass` 之后追加 `deliveryContractWatch.runPass(now)`,与 FLY-2211 同款 try/catch fail-closed 日志。不新增 timer。
- 快照:每个 `DeliveryContractSource.snapshot(now)` 只读 SELECT;CommDB 家族经现有 `commDbPathFor(projectName)`(`plugin.ts:9821`)按项目打开只读连接,读完关闭(与 GatePoller 现行做法一致)。
- 期限表:`delivery-contract-policy.ts` 导出 `STAGE_DEADLINES_MS: Record<Stage, number>` = {minted:10m, granted:5m, sent:15m, received:30m},**写死为常量,不做 env/flag 可调**(Lead 2026-09-02 裁定,founder 红线「不留旋钮」);不进 feature-flag 注册表。
- 告警:**不新增告警层**(Lead 裁定)。run 绑定的合同经现有 `enqueueWorkflowEngineAlert`(`StateStore.ts:34912`,`workflow_alert_outbox`,`eventType=workflow_engine_escalation`)进入既有 Lead inbox 事件 → issue thread 通路;escalation_uid = `delivery_contract_stalled:<attempt_id>:<stage>:<stageEnteredAt>`(attempt_id = `<root_id>:g<generation>:a<attempt>`,root_id = `<project>:<issue>:<root ulid>`;血统与阶段时钟都在 `workflow_delivery_attempt` 表,plan §1/M1;物化为 `attempt_id TEXT UNIQUE` 列作 FK 目标);3N 时 severity 升 `severe`,uid 后缀 `:severe`。无 run 绑定的(legacy land、Lead 收件人)不在范围。
- 恢复:阶段前进 → episode `closed_reason='advanced'`,追加 informational run event `delivery_contract_recovered`(`INFORMATIONAL_KINDS`,`LeadAlertNotifier.ts:630`),不发 Discord。
- Episode 表(StateStore 新表,唯一持久化):
  ```sql
  CREATE TABLE workflow_delivery_contract_episode (
    episode_id TEXT PRIMARY KEY,           -- <attempt_id>:<stage>:<stageEnteredAt>,attempt_id = <root_id>:g<n>:a<m>
    family TEXT NOT NULL, root_id TEXT NOT NULL, attempt_id TEXT NOT NULL, run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    stage_entered_at TEXT NOT NULL, opened_at TEXT NOT NULL,
    alerted_at TEXT, severe_alerted_at TEXT, closed_at TEXT, closed_reason TEXT,
    escalation_uid TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_wdce_open_by_root ON workflow_delivery_contract_episode(family, root_id) WHERE closed_at IS NULL;
  ```

## 2. 工人层:收信员挂在 adapter 上(**Lead 2026-09-02 裁定 (c):本节实现整体拆至子单 FLY-2268**,母单只保留接口;下文保留作子单的调研依据)

### 2.1 现状接口(已经是厂商中立的)

- `IReceiverWakeTransport.createReceiver(ctx): IMailboxWatcher | null`(`packages/agent-team-transport/src/types.ts:213-223`),`IMailboxWatcher {start, stop, health, onDelivered}`(`:199-212`),`TransportCapabilities.wakeMode: "builtin-receiver" | "external-watcher" | "push-only"`(`:300-310`)。
- Codex 实现 `CodexMailboxWatcher`(`codex/CodexAdapter.ts:381-485`):`fs.watch` + 1s 轮询,按 message uuid 去重。
- 生命周期持有者 `CodexTmuxAdapter.execute()`(`CodexTmuxAdapter.ts:982-1006`)——只在 `ctx.phaseKeepAlive` 时创建;`onDelivered` 只在 `confirmHoldPaused()` 里接线(`codex-phase-lifecycle.ts:372-426`),`leaveHold()`/`stopIntake()` 拆线(`:449-451`,`:274-278`)。
- `phaseKeepAlive` 的来源 `Blueprint.ts:1625-1634`:`isCodexRunner && shareParentBranch` 再按 `sessionRole` ∈ {design, implement, qa} 打 role 标签——**节点名硬编码**,本单要去掉。

### 2.2 新增:`ResidentReceiverSupervisor`(Bridge 内)

- 位置:`packages/teamlead/src/bridge/resident-receiver-supervisor.ts`。
- 键:execution_id。输入:`workflow_execution_binding` 中 mode ∈ {spawn, wake, replacement} 且 session 非终态的 execution;transport 由 `EXECUTOR_TO_TRANSPORT`(`role-adapter-resolver.ts:54-61`)解析;`wakeMode === "builtin-receiver"`(claude)→ 不武装(CLI 自带);`"external-watcher"`(codex)→ 武装;`"push-only"`/`none` → 记 `receiver_unsupported` 事件一次,不告警。
- 武装时机:(a)dispatcher admission 成功后(`workflow-engine-dispatcher.ts:2571-2579` 之后的 launch 成功回调);(b)FLY-2211 reown 的 `watch` 与 `revive_succeeded` 分支(`codex-session-reown.ts:20-28` 事件处追加 hook);(c)Bridge boot pass 对 `getReadoptCandidateSessions()` 快照全量武装。
- 收到信:supervisor 先 durable 落 `runner_phase_wakes`(`enqueueRunnerPhaseWake`,`codex-phase-lifecycle.ts:388-413` 已有);当前 execution 有 owned turn 进行中(runtime 经 `onTurnStarted/onTurnCompleted` 在 CommDB **既有** `three_stage_turn` 行(issue 级 TURN 传送带,`holder_exec_id` = 持棒 execution)新增的 `active_turn_id`/`turn_generation` 两列上做 CAS;非持棒 execution 的到件一律 `queued`)→ `admission_state='deferred_midturn', turn_generation=g`,对 push/claim/t2 不可见;否则 `queued`(既有语义)。**turn 边界的真实信号**是 daemon client 已经接收并归属化的 `turn/completed`(`codex-daemon-client.ts:749-781`),不是 `observeBoundary()`(那只是 declared state);`turn/completed` 回调里同步 CAS `deferred_midturn(≤g) → queued`,之后 runtime 才继续 goal 循环,所以下一次 `startTurn` 前一定可见。**真实语义:「入队 + 下一 turn 边界必读 + 欠条超时兜底」,不是实时注入**(Lead 裁定)。**研究项 R1**:codex app-server 是否支持 `turn/steer`;只有拿到阳性对照证据才允许把语义升级为实时。
- 心跳:supervisor 每次 GatePoller 60s rider(`gate-poller.ts:741-757` 同款 `(tickCount-1) % N === 0`)调用各 receiver 的 `health()`,并把 `{execution_id, lastDeliveryAt, lastPollAt, running}` 写入内存快照 + `session_events(receiver_heartbeat)`(每 5 分钟一条,限流)。
- 分类器(纯函数,FLY-2216 `classifyResidentCodexLead` 同构):`healthy | starting | receiver_missing | receiver_stalled | unsupported`;episode 状态机同 `ResidentCodexLeadPatrol`(`resident-codex-lead-patrol.ts:612-720`):每 episode 至多一次进程内重武装 + 一次告警;连续 3 次 `receiver_stalled` 才升级。
- 重武装是进程内 `watcher.stop(); createReceiver(); start()`,不涉及 OS 进程、不发信号——所以不进 kill-ledger 范围。

### 2.3 goal 达成后的常驻(loop 目标节点,durable + revision)

- 判据(Codex R1#1 修正):**只认 loop 目标**——pinned run snapshot 上 `manifest.loops.some(l => l.to === nodeId)`(`workflow-menu.ts:48-56` 的 `WorkflowMenuLoop`);仅有 loop 出边的源节点不常驻。`loopTarget` 作为显式字段贯穿 `StartRequest → RunDispatcher → BlueprintContext → AdapterExecutionContext.phaseKeepAlive{loopTarget,nodeId} → Codex launch snapshot → reown 重建 → Claude completion`,不借用 `shareParentBranch`(它只管共享 worktree,且 dispatcher `:2774-2785` 只对 `isWorkflowPhaseRole` 设置,任意名称的 loop 目标拿不到)。
- Codex:`classifyTerminalStatus`(`codex-daemon-client.ts:1131-1143`)增加分支——`status === "complete" && loopCapable` → `"held"`,进入 phase hold(`enterPhaseHold`,`:979-1004`)并启动 `RESIDENT_GRACE_MS` 计时(**常量 30min,不可调**,Lead 裁定);宽限到期无 wake → 正常 terminal。宽限内收到 rework `wake` → 现有 `reactivateWake`(`:1005-1012`)原地再派,**无需换体**。
- durable 行 `workflow_resident_hold(execution_id PK, …, revision, state ∈ {resident, woken, expired, closed}, grace_expires_at)`。Codex seam:goal 到 terminal 且 `loopTarget` → runtime **先**调 `CodexDaemonAdapterDeps.residentHold.enter()`(`CodexTmuxAdapter.ts:411` 的 deps,Bridge 在 `run-infra.ts:640-663` 注入)→ Bridge CAS 写行(无行 → revision 1;`woken(r)` → `resident(r+1)`)→ 才 `enterPhaseHold`(v2 state 带 revision/deadline);`enter` 失败 → 不常驻,按原 terminal 退出。到期的权威 owner 是 Bridge 维护 tick(CAS `resident(r) → expired`,再经 CommDB `runner_shutdown_controls` 命令 held loop 退出,`codex-daemon-client.ts:1292-1300,1486-1500` 每轮检查);wake 前置 CAS `resident(r) → woken(r)`;旧 revision 的迟到 wake/expiry 因 revision 不符 no-op。Claude:completion disposition `loop_park`(同谓词、同一张表、同一 tick owner),CLI 停在 prompt 保持 poller;到期复用 `runner_ship_park` 的 park 清理原语终结 pane。
- 换体判据改为:行处于 `resident` 且收信员 healthy → 只允许 `wake`;`replace` 需要 (i) 行已 `expired` **或** (ii) 独立死证据(§3.1)。

### 2.4 完成前清信(generic guard)

- 位置:`event-route.ts:986-1057` 是**唯一** CommDB 读者(fail-closed:不可读即拒绝完成);StateStore 只消费带 challenge identity 与核验结果的受约束调用(`issueDrainChallenge` / `consumeDrainChallengeTx`),自己不读 CommDB。
- 规则:若该 execution 存在 `mailbox` QUEUED/LEASED runner 行或 `runner_phase_wakes` pending(含 deferred)行,且请求无有效回执 → StateStore 写 **durable 一次性挑战** `workflow_completion_drain_challenge(execution, activation, business_digest, 精确 mail_set, watermark)`,返回 `completionDisposition='consume_pending_mail'` + ids + challengeId;同 (execution, activation, business_digest) 已有 `issued` 行 → **返回原 challengeId,不重铸**(覆盖首次响应丢失后 runner 用新 event_id 重试)。`business_digest` = 现有 completion digest 算法作用于剔除 `drainReceipt` 后的 payload。runner 读完后 `complete --drain-receipt <challengeId>`:event route 再读 CommDB 核验 mail_set 内 mailbox 行 ACKED、phase wake started|finished,把核验结果交 StateStore;通过 → CAS `issued → consumed`,继续原完成事务;不通过 → 保持 `issued` 并拒绝。**不比对 caller 提供的任何 hash**。水位线之后的新到件不阻塞本次完成(有界一次),由常驻宽限(loop 目标)或 rerouter(非 loop)接住。
- 该规则对两家一致,与节点类型无关。

## 3. 转移层:判据修正的具体落点

### 3.1 判死先问送达

- `classifyPhaseActorReentry`(`phase-actor-reentry.ts:30-67`)增加输入 `delivery: { stage: Stage; receivedAt?: string; consumedAt?: string }`。新规则表:

| 独立探针 | 合同阶段 | 判决 |
|---|---|---|
| `dead_pin` / host absent(现有) | 任意 | `replace`(理由 `actor_dead:<probe>`) |
| `alive` | < received | `defer`(现有枚举值 `hold`,仅 coordinator 暂缓,**不写** run/delivery held),理由 `delivery_unconfirmed:<stage>` → 合同 watch 负责升级,**永不换体** |
| `alive` | received,< consumed 且超期 | `defer`,理由 `alive_not_consuming` → 合同 watch 升级;`replace` 只当 (2.3) 的常驻宽限已过或独立死证据 |
| `alive` | ≥ consumed | `wake` |
| `indeterminate` / `absent` | 任意 | `defer`(现状不变:absent 不是死) |

- `escalateWorkflowReworkStall`(`StateStore.ts:26603`)的 `action: "hold"` 分支**删除**;dispatcher `:1232-1262` 只保留 alert(并入合同 watch 后整段退役)。`rework_activation_stalled_held` 事件种类保留在 schema 白名单(`:34239`)用于历史行,不再新写。
- `HeartbeatService.declareZombie` 与 `codex-session-reown` 的 `revive` 判定已经用独立探针(socket + rollout),不改;但 `isBeyondParkedStale`(`HeartbeatService.ts:1922-1933`)的时间兜底在合同阶段 < received 时不得生效(把「等信」当「僵尸」)。

### 3.2 核销与旧欠条解耦

- 现状(证据):`commitWorkflowTransitionTx` 在 `StateStore.ts:41559-41566` 与 `:41638-41645` 执行 `UPDATE workflow_rework_delivery SET state='completed' WHERE request_id=? AND state='wake_delivered'`,`getRowsModified() !== 1` 即 `throw WorkflowEngineInvariantError("workflow_rework_delivery_complete_cas_failed")`——欠条若停在 `awaiting_receipt`(信没送到但活干完了),**整个完成事务回滚,交货被拒收**。这就是 FLY-2241 与 runbook 附录 A 存在的原因。
- 修法(Codex R1#7/#8 收窄):**不新增 state 值**,终态仍 `completed`,在 **attempt 行**(不是 IOU 表)set-once `settlement_reason ∈ {settled, superseded_by_completion}`;仍以 `activePath.request_id` 精确定位一张欠条,事务内复核 route revision 的 target node/attempt 与 preferred actor 属于本 activation;`wake_delivered` → `settled`(语义不变);`pending|turn_granted|awaiting_receipt|replacement_pending` → `superseded_by_completion` + 事件;`held|needs_lead`(policy 冻结)不核销、不 throw,交正门;0 行只在同 completion 事件幂等重放时成功。工作真实性由 head + 验证声明判,不由欠条状态判。
- 因终态仍是 `completed`,`listOpenReworkDeliveries`(`:8890`,`state != 'completed'`)、`listOpenGateAuthorities`(`:8940`)、carrier redrive(`:47351-47368`)等读点语义不变;不需要重建表、不改 CHECK。
- carrier 家族同款 `settleCarrierDeliveryOnLandCompletionTx(questionId)`:终态仍 `completed`,attempt 行 set-once `settlement_reason` 记 `settled` / `superseded_by_completion`(IOU 表不加列,不改终态名)。

### 3.3 冻结理由词汇

- 新 `hold-reason.ts` 导出三族构造器:`actorDead(probe)`、`deliveryUnconfirmed(stage)`、`policy(kind)`;所有写 `workflow_run.status='held'` 的 14 个点(§4.1 清单)必须经这三者之一生成 reason 字符串(测试用正则 `^(actor_dead|delivery_unconfirmed|policy):` 断言)。

## 4. 冻结形状正门:注册表清单

### 4.1 形状清单(来自代码盘点;`held` 写点 14,解点 2)

| # | 形状 id | 写点 | 现有解法 | 本单动作 |
|---|---|---|---|---|
| 1 | `rework_activation_stalled_held` | `StateStore.ts:26678` | 无(附录 A SQL) | 写点退役(§3.1);历史行 → resume = 把欠条按 §3.2 supersede 或重铸 route revision(附录 A 事务化) |
| 2 | `rework_pane_loss_handoff` | `:30294` | 自动(`:845-930` → `materializeWorkflowReworkReplacement`) | 注册为 `auto`;暴露 `resume` 仅作重触发 |
| 3 | `rework_retry_exhausted` | `:30428` | `POST /api/runs/:runId/rework`(needs_lead 分支) | 注册,复用 |
| 4 | `unlaunched_admission_rolled_back` | `:26371` | `/rework` 的 `heldUnlaunchedRollback` 分支 | 注册,复用 |
| 5 | `unlaunched_admission_held` | `:26533` | 无 | resume = 重新 admission(复用 `:26155` 的 rollback + dispatcher 重派) |
| 6 | `completion_receipt_missing` | `:35837` | 无 | resume = 重建 completion disposition(`reconstructWorkflowCompletionDispositionTx`)后 active |
| 7 | `retry_limit_escalated` | `:36173` | 无 | resume = 重置 launch 计数(带 decision=retry/terminate) |
| 8 | `environment_failure_escalated` | `:36200`(不在扫描名单) | 无 | 加入 `latestHold` 扫描名单(`:34237-34242`);resume 同 7 |
| 9 | `loop_limit_escalated` | `:40895` | `/rework` + escalationAck | 注册,复用;正门代算 ack digest |
| 10 | `rework_suppressed_idle_spin` | `:40981` | 无 | resume = decision ∈ {accept_current_pass → 推进出边, force_rework → 铸欠条} |
| 11 | `workflow_gate_origin_preflight_terminal` | `:46541/:46567`(不在扫描名单) | 无 | 加入扫描名单;resume = 清 `origin_probe_last_reason` 并重排 probe |
| 12 | `land_held`(有 operationId) | `:54649` | `POST /api/lifecycle/land/:operationId/resume`(`lifecycle-routes.ts:277`) | 注册,复用;正门统一入口转发 |
| 13 | `land_held`(无 operationId:`nested_land_unsupported`/`engine_land_executor_unavailable`/`authority_mismatch`) | `workflow-engine-dispatcher.ts:2176-2260` | 无 | resume = 铸/重铸 land intent(`makeLandOperationRetryRunnable`)或 terminate |
| 14 | `run_held_by_operator` | `:33411` | 无(只有 hold/terminate 路由) | 暴露 `changeWorkflowRunStateByOperator({target:'active'})` |
| 15 | 欠条 `held:replacement_launch_rolled_back` | `:26377` | 无(`:29246` CAS 只认 pane-loss) | resume = 附录 B 事务化(重铸 route revision 指向新 execution 或回到 pending) |
| 16 | 欠条 `held:delivery_awaiting_receipt`(历史) | `:26686`(退役后不再产生) | 附录 A SQL | 同 #1 |
| 17 | 欠条 `needs_lead`(run 仍 active) | `:30103/:30409/:34452` | 不可达(`/rework` 要求 run held) | 正门允许 run active 时处理 |
| 18 | carrier `held:run_inactive:*` | `:48216-48224` | 只有 pane-loss 路径顺手复活(`:29257`) | 任何 run 解冻都调用 `reviveHeldWorkflowCarrierDeliveriesTx`(`:32300`) |
| 19 | carrier `needs_lead` | `:48310-48325` | carrier-redrive stage/apply | 注册,复用 |
| 20 | 信箱 slot 耗尽(FLY-2107) | `mailbox-queue.ts:1192-1218` | `adopt-inflight`(要收件人重连) | resume = 强制 `reconcileExpiredLeases` for recipient(收信员 healthy 时可安全释放) |
| 21 | 三段 TURN 卡住 | CommDB `three_stage_turn` | `turn-manual-handoff-runbook.md` SQL | 正门 `turn-handoff`:同 epoch CAS + 配对 `send`,把 runbook `:71-101` 事务化 |
| 22 | `delivery_undeliverable_no_recipient`(新) | M2 改派 saga:无可证明收件人或改派已达上限 | 无(新形状) | resume = decision `reroute_to <execution>`(复用 reroute saga,operator 决策豁免上限一次)或 `cancel` |

### 4.2 一扇门的形状

- `GET /api/runs/:runId/holds` → `{ holds: [{shape, holdEventUid, reason, since, resumable, requiredDecision?, preconditions: [{name, ok, detail}]}] }`。只读,master token + loopback。
- `POST /api/runs/:runId/resume/stage` + `POST /api/runs/:runId/resume`(stage/apply + 一次性 `confirmToken`,完全复用 `workflow-carrier-redrive-routes.ts:262-283` 的 origin/loopback/timingSafeEqual/canonical-digest 骨架)。body `{shape, holdEventUid, decision?, reason, principal, clientRequestId}`。
- 内部:`HoldShapeRegistry.get(shape).resume(store, input)`;每个形状声明 `authoritativeStore`:20 个 StateStore 形状在一个 `db.transaction` 内(前置全绿 → 动作 → `hold_resumed:<shape>:<holdEventUid>` 事件),拒绝走**独立短事务**只写 `hold_resume_refused`;2 个 CommDB 形状(信箱槽位、三段 TURN)走 `workflow_delivery_operation(kind='hold_resume')` saga(staged → CommDB 自己事务内 CAS+receipt → 既有 durable outbox 投递 → 幂等投影),与 M2 改派(`delivery-operations.ts`,kind=reroute)共用同一张表(kind `resident_expiry` 预留给子单 FLY-2268);**不再声称跨库原子**。任何 run 解冻都追加 `reviveHeldWorkflowCarrierDeliveriesTx`。
- CLI:`flywheel-comm hold list --run <id>` / `hold resume --run <id> --shape <s> --reason <r> [--decision <d>]`,读 `TEAMLEAD_API_TOKEN`,两步确认在 CLI 内完成。
- 守卫测试:两份清单 `hold-mutation-inventory.json`(每条 mutation:store/table/file/symbol/mutationKind/shapeIds)与 `hold-shape-manifest.json`(每个 shape:detect/resume owner、authoritativeStore),双向映射测试 + 导出符号 allowlist 守卫(held/needs_lead/frozen 写 SQL 只允许在 `hold-writers.ts`),plan M0。

## 5. 八起事故 → 回放测试

每条测试用真实账本形状造 fixture(表名、状态、时间差与 09-01 一致),断言「新机制在 N 内产生了可见动作」。测试文件:`packages/teamlead/src/__tests__/fly2248-replay.test.ts`(StateStore + 内存 CommDB)与 `packages/claude-runner/test/fly2248-resident-receiver.test.ts`。

| # | 事故 | fixture(边) | 断言 |
|---|---|---|---|
| 1 | 裁定令排队 3h | `mailbox` runner 收件 response:`state='LEASED'`、`created_at=T0`、**`notified_at=T0+1s`**(Bridge 已写信箱文件 = sent)、`acked_at` 空,持续 3h(qa→implement) | 合同 watch 在 sent 阶段 15min 处开 episode、`workflow_alert_outbox` 出现 `delivery_contract_stalled:<project>:<issue>:<root ulid>:g1:a1:sent:<T0+1s>`;45min 处 severe;ACK 后 episode `closed_reason='advanced'`。对照:同一行去掉 `notified_at` → 按 minted 10min 告警(证明「未写信箱文件」与「写了没人读」被区分) |
| 2 | 清理令双死信 | `land-cleanup-instruction` 发给 3 个 execution,其中 2 个 session 终态(land→cleanup) | mailbox 家族对终态收件人立即判 `undeliverable`;`delivery-operations.ts` 的 reroute saga(M2,唯一 mutation owner;新收件行用确定性 id `mailbox:reroute:<root>:g<n>`)把指令改派给当前 activation 的存活 execution,**断言新收件人的 durable mailbox 行落地并被 ACK**;无可证明收件人时断言开出 `delivery_undeliverable_no_recipient` hold shape;只断言告警不算 GREEN |
| 3 | verdict 秒死信(**→ 子单 FLY-2268**) | review verdict response 发给 turn 进行中的 codex execution;lease 120min 后过期 | 常驻收信员在 lease 过期前把信落成 `runner_phase_wakes(deferred_midturn)`;信不 DEAD;`complete` 前清信把它注入 |
| 4 | 管道孤儿铃不响 | `runner_phase_wakes` `pending`、`push_attempts=0`、`first_push_at` 空、`queued_at=T0`(qa→implement,`turn_end_sweep`) | 阶段 = **minted**(从未推送);watch 在 10min 处开 `<root_id>:g1:a1:minted:<T0>` episode 并告警;**父单半边**:真实 `runner-wake.ts` 调用链成功推送后铃响(`receiver_missing` 重武装半边 → 子单 FLY-2268)(`completeRunnerReceiptWakePush` result ∈ {delivered, verified}(`runner-wake.ts:184-203` 的真实成功值)落 `first_push_at` → sent;仅 claim 不算;测试经 `runner-wake.ts` 真实调用链)→ episode `advanced`。对照:`first_push_at` 非空的行按 sent 15min 计时 |
| 5 | run 双假死 | actor `alive` 探针 + 合同阶段 `sent`(`awaiting_receipt`) | `classifyPhaseActorReentry` 返回 `defer(delivery_unconfirmed:sent)`,**不**返回 `replace`;没有 `execution_dead_rolled_back` / `rework_replacement_materialized` 事件;对照:探针改 `dead_pin` 才返回 `replace(actor_dead:dead_pin)` |
| 6 | 交货被欠条拒收 | `authority='founder'`、source `founder_gate`、target `general` 节点的欠条停在 `awaiting_receipt`;节点提交完成 | `commitWorkflowTransitionTx` 成功,欠条 `state='completed'`,attempt 行同事务 set-once `settlement_reason='superseded_by_completion'`(完成后无 live attempt;重放 0 rows changed) + 事件 `rework_delivery_superseded_by_completion`,run 不 held,land intent 铸出;对照组(旧 CAS)抛 `workflow_rework_delivery_complete_cas_failed` |
| 7 | 三道令 QUEUED 未消费(清信半边 **→ 子单 FLY-2268**;槽位半边留本单) | 3 条 response QUEUED 且在飞批次已满 3;runner 调 `complete` | event route 拒绝完成并返回 `consume_pending_mail` + 3 个 id + challengeId(同业务提交重试返回同 challengeId);三行 ACK 后 `complete --drain-receipt <challengeId>` 成功;任一行未 ACK 时拒绝;slot 耗尽在 mailbox 家族生成 `frozen(mailbox_inflight_slots_exhausted)` 并由正门 `hold list` 可见 |
| 8 | 返工唤醒打不醒 goal-achieved 体换体(**→ 子单 FLY-2268**) | codex goal `complete` 于 loop 目标节点;10min 后 rework wake | `residentHold.enter` 写 `workflow_resident_hold(resident, revision=1)`,`classifyTerminalStatus` 返回 held;wake CAS `resident→woken` 赢 → `reactivateWake` 同 thread,无换体;再次 goal complete → `resident, revision=2`;宽限过后 tick CAS → `expired` + saga(kind=resident_expiry)发确定性 `runner_shutdown_controls` 请求 → held loop 退出并 ACK → 行 closed → 此后 wake 输、允许 replace;mid-grace 崩溃重启后到期仍发生 |

通用性断言(第 9 条测试):对 `delivery-contract/**`、`delivery-operations.ts`、`hold-shape-registry.ts`、`hold-reason.ts` 做源码扫描(`resident-receiver-supervisor.ts` 随 M3 归子单),断言不含 `/\b(qa|implement|design)\b/i` 字面量;fixture 里的三条不同边(founder_gate→general、land→cleanup、qa→implement)共用同一条 watch 代码路径(用 spy 断言调用同一函数)。

## 6. 风险与研究项

- **R1 codex `turn/steer`**:未知。实现期用 `codex app-server --help` / 协议 schema 探测;不支持则依赖 §2.4。
- **R2 claude CLI 无「读到」回执**:mailbox 家族对 claude 的 `consumed` 为推断值,合同快照显式标 `inferred`,告警文案注明。
- **R3 维护 tick 5 分钟的粒度**:期限 5/10/15 分钟在 5 分钟 tick 下有 ±5 分钟抖动,可接受;若要更细,骑 GatePoller 60s rider(§2.2 心跳已用)。
- **R4 stall hold 退役后的空窗**:退役 `rework_activation_stalled_held` 后,真正的死体只能靠转移层死证据冻结;FLY-2211 reown 已是唯一死检 owner,覆盖 codex;claude 走 HeartbeatService pane 探针。空窗 = claude 工人「活着但永远不读信」,由 mailbox 家族 received→consumed 超期告警兜底(告警,不冻)。
- **R5 schema 迁移**(Codex R1#8 / R4#6 / R5#6 后收窄,拆单后):StateStore 只加 3 张表(含显式命名索引与 `attempt_id` 单列 FK)、不加列、不改 CHECK、不重建表;CommDB 只加 1 列(`runner_phase_wakes.first_push_at`)。`three_stage_turn` 加列、`runner_shutdown_controls` 主键重建、`deferred_midturn` 与 `turn_generation` 全部随 M3 移交子单 FLY-2268。A7 按 plan 的 canonical 查询做 (a)(b)(c)。
- **R6 Lead 未答的四个裁定**(exploration §6)按默认取值推进;答复到后作为 design-correction 增量应用。
