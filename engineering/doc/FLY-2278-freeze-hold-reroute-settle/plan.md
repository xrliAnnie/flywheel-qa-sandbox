# FLY-2278 冻结检测·hold 正门·reroute 重绑·settle 语义 — 实施计划
Issue: FLY-2278 (https://linear.app/geoforge3d/issue/FLY-2278/引擎loop稳定性-从-fly-2248-砍出的后半冻结检测带阈值活性证据hold-恢复正门carrierrework-reroute-重绑settle-语义2248-r5-只留欠条必达超时升级)
日期: 2026-09-03(round 5「收口版」:Lead 裁 B(`185d2b82`,不开 R5)——Codex R4 的 2B+1M+1L 按拟改逐字进 plan,两条 BLOCKER 的顺序控制写成 §5A 实现节点 RED 清单前两条,design-review.json 以 APPROVED + leadAcceptance 收口。round 4:Lead 裁 A(`c992a211`)——Codex R3 六项(3B+2H+1M)全部闭合:baseline/通用 minter 铸一次就带版本、episode 转移规则成表、cancel 只在有真实 cancel 态的家族提供、operator_required 单调、已消费源 no-op、回滚从事件 `before` 还原。round 3:Lead 裁 A(`563388ee`)——Codex R2 九项全部按拟改法闭合;附加约束:活性门复用 `classifyRecipientLiveness` 不新写分类、超上限操作员确认走同一扇门不开新入口、JSON 升级幂等可回滚并写明回滚步骤、冻结谓词不成立零写入。round 2:闭合 R1 十二项,净减 `deferred_alive_at` 列与 state-native 跨库 saga。本轮再净减一个 `sent` 跳)
基于: research.md;`codex-review/round1.md` … `round4.md`

## 0. 目标、约束、范围与验收

**目标**:把 FLY-2248 砍掉的 M2(改派)与 M4(冻结正门)按 reviewer 点名的六条缺陷**修正后**重做。两条互斥的策略线:
- **冻结线**(收件体**非终态**):欠条命中「冻结形状」且三条件同时成立才把 run 置 held——① 卡住时长 ≥ 阈值;② 收件体 StateStore 状态 ∈ `CMUX_LIVE_SESSION_STATUSES`;③ 活性判决 ∈ {absent, unknown}。谓词不成立 → **零写入**(founder 口径;Lead 裁定)。
- **undeliverable 线**(收件体**终态**且未 ACK):不冻结、不告警,进入 15 分钟 grace 找后继;有后继就改派;grace 到期仍无后继且原体活性 ∈ {absent, unknown} 才 `operator_required`(唯一的第二个 hold 写点)。
- 每种 hold 形状有一扇官方正门;改派后的 attempt 永远指向真实物理主键;settle 是终态并在同一事务关 episode。

**范围**:issue 六条 + 随之而来的收口:(a)砍范围时复活的旧 rework stall 扫描器与两个 env 旋钮退役,其 30 分钟告警覆盖搬进既有合同并**过活性门**;(b)`workflow_delivery_operation.kind` CHECK 放宽(M0);(c)部署前已铸的 rework/carrier 欠条一次性幂等 JSON 版本升级(M0);(d)hold 形状注册表 + `GET holds` / `POST resume` + CLI `flywheel-comm hold`。**不做**见 §8。

**founder 约束(照抄)**:不加旋钮;任何检测器必须有阈值+活性证据;每条修复配真事件流阳性对照;ship_parked / awaiting_review / design_done 体是合法收件人;不新增告警层;General 不写死节点名;简单=净删除,开新路必须同 PR 删老路。

**Lead 裁定(2026-09-03;`c042f1bd` / `2c10547b` / `563388ee` / `c992a211` / `185d2b82`)**:
- **退役决定**:`FLYWHEEL_ENGINE_REWORK_ALERT_MS` / `FLYWHEEL_ENGINE_REWORK_HOLD_MS` 两个旋钮与 dispatcher 的 rework stall 扫描器**在本单同 PR 删除**。理由:founder 规矩「不留旋钮;开新路必须同 PR 删老路」;三条件 hold 是唯一 hold 路径,阈值写死。被删符号:`WorkflowEngineDispatcher.reconcileWorkflowReworkStalls`、`WorkflowEngineDispatcher.reworkThresholdMs`、`StateStore.escalateWorkflowReworkStall`、`feature-flags/truth.ts` 两条目、registry 两条目。旧 `alert` 分支的观测覆盖由 §1「rework received 告警」承接(**过活性门**,Codex R2#1)。
- 活性证据 = 内容/进度证据(心跳、状态变化、工人出站消息),不以画面刷新为判据;活性分类**只有一个实现** `classifyRecipientLiveness`,所有消费点(冻结、undeliverable、rework received 告警)复用它。
- R4 为最后一轮(`c992a211`)。R4 结果 2B+1M+1L,Lead 裁 B(`185d2b82`,不开 R5):四条按拟改逐字进 plan,不加 state/column/knob/endpoint;`design-review.json` 写 APPROVED + `leadAcceptance{instructionId:185d2b82-a69f-4fcf-8e4e-74f40c1762c3, codexFinalVerdict:"CHANGES REQUESTED(R4 2B+1M+1L 已改进 plan 未再评)", residue:[…]}`;两条 BLOCKER 的顺序控制为 §5A 实现节点 RED 清单前两条。R3 三条 BLOCKER 已在 round 4 闭合并经 R4 确认。

**验收(全部可机器判)**:
- A1 冻结三条件:`hold-writers.test.ts` 12 格穷举(`{age<T, age>=T} × {status∈CMUX_LIVE, 终态} × {alive, absent, unknown}`),仅 `(>=T, CMUX_LIVE, absent)` 与 `(>=T, CMUX_LIVE, unknown)` 两格写 `status='held'` + 1 episode + 1 事件 + 1 告警;其余 10 格 **`workflow_run` / `workflow_delivery_contract_episode` / `workflow_run_event` / `workflow_alert_outbox` 四张表逐字节不变**(零写入)。两条 barrier:检测后、事务前 session 变终态 → 零写入;检测后、事务前出现窗口内活性证据(含 ISO-Z 格式的 `last_activity_at`)→ 零写入。
- A2 undeliverable:(a)projector 先跑、watch 后跑的真实维护顺序下,收件体终态且未 ACK 的信仍以 live attempt 存在并开 `undeliverable` episode(阳性对照经真实 `commands/send.ts` + `markSessionTerminal`);(b)grace 内后继出现 → 改派,零 held、零告警;(c)grace 到期、`holdUndeliverableTx` 事务内重新解析后继:有后继 → 改派不 hold(barrier:扫描与提交之间后继被 admit);无后继且原体 `alive` → 零写入;无后继且 `absent|unknown` → 恰好一次 `delivery_reroute_operator_required` 事件(`runHeld:true`)+ 恰好一次 `delivery_reroute_outcome:<attempt_id>` 告警;(d)改派上限耗尽且有活后继 → run 不 held、恰好一次 `delivery_reroute_operator_required` 事件(`runHeld:false`)+ 一次 outcome 告警,**且该 episode 出现在 `GET holds`(scope=delivery)可经 stage/apply 执行一次超上限改派,或 cancel(仅对有真实 cancel 态的家族提供,见 §1)**(阳性对照:cap 告警 → 列表出现 → confirmToken apply → 改派/cancel 完成 → run 从未 held);**单调**:cap 分支发出 `runHeld:false` 事件后,该 episode 永不升为 run hold——后继随后终态时 `holdUndeliverableTx` 检测到已有事件 → 零写入,门仍可用(两向转换测试:cap 事件后后继消失;后继消失前后 run-hold 计数不变);apply 失败 / saga 卡住 → 只告警不 hold;(e)`alive` at T → 窗口外 `absent` at T+11min → 升级。
- A3 正门(完整挂载 app):缺/错 bearer → 401;非 loopback Host → 403;body `runId` ≠ 路径 → 400 `run_id_mismatch`;hold 已变 / digest 冲突 → 409;同 `clientRequestId` 重放 → 200 `idempotentReplay:true`;digest 唯一实现(grep);两个 run 级 hold:resume 其一后 run 仍 held,第二个仍可 resume;`carrier_needs_lead` 在 run active 时可 list / resume;`carrier_run_inactive` 在仍有其他 run 级 hold 时**拒绝**直接 revive(负向),最后一个 run 级 resume 自动 revive(阳性);`three_stage_turn_stuck` 冻结后收件体 ACK、形状自然清除 → list/stage/apply 对已 acked 源视为 no-op 成功并投影 `hold_resumed` → run active(阳性);另有 run 级 hold 时 run 仍 held(负向)。
- A4 reroute:五家族改派后子 attempt `contract_ref.pk` ∈ 权威表真实主键;rework/carrier 改派在一个 StateStore 事务内完成且 operation 直接落 **`projected`**(终态);改派成功后越过 `3 × STAGE_DEADLINES_MS.sent` **零** `delivery_operation_stalled`(负向);崩溃注入(事务回滚)后台账与权威表一致;旧代事件不能推进或核销子 attempt;**目标 fence**:扫描到事务之间目标 execution 终态 / 被替换 → 事务零写入、episode 保持 open、改派额度不消耗(两条 barrier,state-native 与 CommDB staging 各一套);改派后 run terminate → 子 attempt `run_terminal` 核销;carrier 改派后完成 → 子 attempt `settled`。
- A4b episode 转移(Codex R3#2):真实维护流顺序控制——turn_wake 15 分钟开 `sent` stalled episode → 20 分钟冻结时同事务关它(`superseded_by_freeze`)并开 `frozen`,`idx_wdce_open_by_root` 不被违反;终态未 ACK 的信在有 open 阶段 episode 时 → 同事务关旧开 `undeliverable`;rework 收到回执后工人 alive → 不开 received episode,而旧 `sent` episode 正常以 `advanced` 关闭(无残留 open episode)。
- A5 settle:`settleWorkflowDeliveryAttemptTx` 的**每个逻辑调用点**——baseline(`:35320`)、launch rollback(`:26580`)、launch side-effect abandon(`:56229`)、carrier completion(`:35696`)、gate_holder completion(`:47678`)、land completion(`:55216`)、projector(`settleProjectedWorkflowDeliveryAttempt`)——各一条测试断言 episode `closed_reason = 'terminal:settled:<settlement_reason>'` 且 `closed_at` = 调用方 `now`,各一条事务回滚测试;幂等重放同理由 0 rows;仓库源码 `'disappeared'` 0 次;`listLiveWorkflowDeliveryAttempts` 返回集合 `settlement_reason IS NULL` 恒成立。
- A6 活性解析:`liveness.ts` 四格穿越 + 时间格式矩阵(SQLite `YYYY-MM-DD HH:MM:SS`、ISO-Z、ISO 带偏移、null、垃圾串 → 前三种解析成功,后两种 = 无证据而非 NaN);grep 守卫 `Math.max(` 在该文件恰好 1 处且形如 `Math.max(...stamps)`;`stale-blocker-guard.parseSqliteUtcMs` 在 `delivery-contract/**` 与 `hold-writers.ts` 出现 0 次。
- A7 迁移:`VACUUM INTO` 快照 pre/post,canonical 查询差集 = 0 新表、0 新索引、0 新列;`workflow_delivery_operation` 的 `sql` 含三种 kind;非空旧表(含一行合法 `resident_expiry` + 其 attempt)重建后行内容、索引、FK 逐字相同;**JSON 版本升级**:升级前快照含每家族一条无版本的 live rework/carrier attempt → 升级后 `contract_ref_json` 多出 `routeRevision` / `redriveGeneration` 且等于权威行当前值,已 settled / superseded 行不动,第二次启动 0 rows;升级后当前版本的时钟/核销推进,旧版本事件被拒;回滚步骤(§3)执行后 `contract_ref_json` 逐字回到升级前(含一条**非规范但合法** JSON fixture,如 `{ "table" : "workflow_rework_delivery" , "pk" : "r1" }`);**baseline 边界**(Codex R3#1):从一条无 attempt 的旧权威 rework/carrier 行出发,跑真实 `baselineWorkflowDeliveryContracts`,产出的 attempt **带版本**,同一进程内当前版本可推进、旧版本被拒。两次启动逐字相同、`integrity_check=ok`、`foreign_key_check` 空。
- A8 阳性对照:每条 A1–A6、A10 的阳性臂经 §2 列出的真实写点;新测试文件 grep `INSERT INTO workflow_delivery_attempt` 与 `INSERT INTO workflow_delivery_contract_episode` 0 次。
- A9 全仓 `pnpm lint && pnpm -r build && pnpm test:packages:run` 通过;QA 拉 exact-head CI。
- A10 rework received 告警(替代退役的旧扫描器):经真实 `recordWorkflowReworkWakeReceipt` 写 `received_at` 后——工人 `alive` 于 30 分钟与 90 分钟 → 零 episode 零告警;`absent` 于 30 分钟 → 恰好一次 warning;90 分钟时 **重新**判活性,`absent|unknown` → 一次 severe,`alive` → 不 severe(episode 保持);从不 hold。

## 1. 稳定标识(实现必须逐字使用)

| 类别 | 标识 |
|---|---|
| 活性判决 | `LivenessVerdict = 'alive' \| 'absent' \| 'unknown'`;`classifyRecipientLiveness(evidence, nowMs, windowMs = activityWindowMs())`(**唯一实现**);证据 `LivenessEvidence = { heartbeatAtMs, lastActivityAtMs, recentOutboundInWindow, observedAtMs }`;文件 `delivery-contract/liveness.ts` |
| 时间解析 | `founder-notify-utils.ts:parseSqliteUtcMs`(既有导出;SQLite / ISO-Z / ISO 偏移三格式,不可解析返回 `null`);**禁用** `stale-blocker-guard.parseSqliteUtcMs`(对 ISO-Z 追加第二个 `Z` 得 NaN,Codex R2#2) |
| CommDB 活性读(新增 1 个只读查询) | `CommDB.hasMessagesFromAfter(execId, cutoffIso)`:`created_at > ?`,cutoff 由调用方按注入的 `now - windowMs` 算 |
| 冻结谓词(唯一实现,`hold-writers.ts` 导出) | `shouldFreeze({ ageMs, thresholdMs, sessionStatus, liveness })` = `ageMs >= thresholdMs && CMUX_LIVE_SESSION_STATUSES.has(sessionStatus) && liveness !== 'alive'` |
| undeliverable 谓词(唯一实现) | `shouldHoldUndeliverable({ graceElapsed, recipientTerminal, successorExecutionId, liveness })` = `graceElapsed && recipientTerminal && successorExecutionId === null && liveness !== 'alive'` |
| 两个 hold 写点(仓库内 `SET status = 'held'` 新增恰好两处) | `freezeRunTx({ runId, shape, attemptId, rootId, physicalId, recipientExecutionId, shapeSince, thresholdMs, commEvidence: { recentOutboundInWindow, observedAtMs }, now, alertIdentity })`;`holdUndeliverableTx({ episodeId, recipientExecutionId, commEvidence, now, alertIdentity })`。两者事务内:重读 run(`status='active'`)、重读 StateStore session、按同一 `now` 重算判决(`holdUndeliverableTx` 还重解析后继),**谓词成立 → 原子写 episode + `status='held'` + 事件 + 告警;不成立 → 零写入**,返回 `{ held:false, reason }`(不发「未冻结」文案,Codex R2#8) |
| 阈值常量(`policy.ts`,只增不改) | `MAILBOX_SLOT_FREEZE_AFTER_MS = 1_800_000`;`TURN_WAKE_FREEZE_AFTER_MS = 1_200_000`;`UNDELIVERABLE_GRACE_MS = STAGE_DEADLINES_MS.sent`(别名);`MAX_REROUTES_PER_ROOT = 2`;`RECEIPT_CONSUMPTION_DEADLINE_FAMILIES` 加 `'rework'` |
| rework received 告警(过活性门,Codex R2#1) | `observeWorkflowDeliveryContract` 对 `family='rework' && stage='received'` 增加输入 `liveness`(watch 用 `collectRecipientLivenessEvidence` 对 route 的 preferred actor 采证据后调 `classifyRecipientLiveness`);`overdue && liveness === 'alive'` → **不开新 `received` episode、不告警**;无旧阶段 episode 时零写入,有旧 `sent` episode 时只做那一次 `advanced` 关闭(与转移表一致,Codex R4#3);`overdue && liveness !== 'alive'` → 开 episode + warning;severe 时刻**重新**采证据,`alive` → 不 severe。其他家族/阶段路径不变。这是改既有分类路径的一个分支,不是新检测器 |
| projector 核销规则 | 只有已消费或被显式替代的物理行才 `source_terminal`:mailbox `state='ACKED'` 或 `superseded_by IS NOT NULL`;phase_wake `state='finished'`;turn_wake `state IN ('acked','cancelled')`;`acked_at IS NULL` 且(`DEAD` / `dead_reason` / 收件体终态)的行**不核销**;`run_terminal` 规则不变 |
| undeliverable 判定(watch,exact-read 物理行) | mailbox:`acked_at IS NULL && (state='DEAD' \|\| dead_reason IS NOT NULL \|\| isWakeTerminalStatus(recipient_status))`;phase_wake:`started_at IS NULL && isWakeTerminalStatus(recipient_status)`;turn_wake:`acked_at IS NULL && state<>'cancelled' && isWakeTerminalStatus(recipient_status)`;rework/carrier:delivery 停在 `awaiting_receipt` / `replacement_pending` 且 preferred actor 的 StateStore session ∉ CMUX_LIVE |
| 冻结形状 id | `mailbox_inflight_slots_exhausted`、`three_stage_turn_stuck`(CommDB 权威);`delivery_undeliverable_no_recipient`(StateStore 权威) |
| hold 形状注册表(19 项,不增不减) | `hold-shape-registry.ts`:research §2 的 19 项,每项 `scope: 'run' \| 'delivery' \| 'run-derived'`。`carrier_needs_lead` = `delivery`(前置 = delivery 行 `needs_lead`,不要求 run held);`carrier_run_inactive` = **`run-derived`**(Codex R2#5:列表时挂在底层 run 级 hold 之下,`resumable:false, derivedFrom:<run hold uid>`,它的「门」就是解掉底层 run hold;最后一个 run 级 resume 调既有 `reviveHeldWorkflowCarrierDeliveriesTx`);`delivery_undeliverable_no_recipient` = `delivery`(见下一行);其余 16 项 = `run`(前置 `run.status='held'`) |
| `delivery_undeliverable_no_recipient` 的两个 producer(同一形状、同一扇门,Codex R2#6;Lead:不开新入口) | 事件 kind 都是 `delivery_reroute_operator_required`,payload `runHeld: true \| false`。(i)`holdUndeliverableTx`:`runHeld:true`,run 置 held;(ii)改派上限耗尽且有活后继:`runHeld:false`,run 不动。前置条件 = 该 attempt 的 undeliverable episode 仍 open;`resume_undeliverable(decision: reroute_to <exec> \| cancel)`:`reroute_to` = 一次 `allowOverCap:true` 改派(仍过目标 fence);`cancel`(Codex R3#3;只对有**真实 cancel 态**的家族提供,`requiredDecision` 按家族计算):同一事务/saga 先终态化**权威物理行**,再 attempt set-once `settlement_reason='cancelled_by_operator'` + episode close `terminal:settled:cancelled_by_operator`。家族表:rework → `workflow_rework_delivery` CAS `state='completed'`(`last_error='cancelled_by_operator'`,同 StateStore 事务);carrier → `workflow_carrier_delivery` CAS `state='completed'`(同事务);mailbox → CommDB **CAS 精确行到既有终态 `DEAD`**(`state='DEAD'`, `dead_reason='cancelled_by_operator:<operation_id>'`, `dead_at=now`, `superseded_by='cancelled:<operation_id>'`,同语句清 lease / `batch_id` / 重试所有权;只写 `superseded_by` 不算 cancel——队列按 `state`/`batch_id` 取行,QUEUED 仍会被 claim,Codex R4#1);已 `DEAD` 且同标记 = 重放成功;已 `ACKED` = 已消费 no-op 成功;经 `hold_resume` saga,**operation 行填既有 `family` 与 `source_attempt_id`,`target_activation_id` 为空 = cancel**(saga 重放的持久编码,不加列),owner = `delivery-operations.runPass`,覆盖「staged 但 CommDB 未落」与「CommDB 已落但 StateStore 未投影」两个崩溃窗口;turn_wake → CommDB CAS `state='cancelled', cancel_reason='cancelled_by_operator:<operation_id>'`(同 saga、同 operation 行编码;已 `acked`/`cancelled` 同上 no-op);phase_wake → **不提供 cancel**(`runner_phase_wakes` 无真实 cancel 态,`finished`+`t2_result` 是执行结果不是取消),只提供 `reroute_to`。崩溃 barrier:staged 未落 CommDB → 重放落地;CommDB 已终态而 attempt 未结 → 重放补齐投影;attempt 已结而物理行未终态 → 顺序保证不可能,测试断言;**并断言 cancel 后的 mailbox 行不出现在真实 runner claim / delivery 流**(经 `mailbox-queue.ts` 的真实 claim 路径)。事件 `runHeld:true` 在 run 级 hold 计数中算一项,resume 后按「无其他 run 级 hold 才 active」规则处理。**单调规则**(Codex R3#4):每个 episode 至多一条 `delivery_reroute_operator_required` 事件(uid `delivery_reroute_operator_required:<episode_id>`);已存在 `runHeld:false` 事件的 episode 永不升为 run hold(`holdUndeliverableTx` 先查该 uid,存在即零写入);**两模式对称**(Codex R4#2):已存在 `runHeld:true` 的 episode,自动改派**不再碰它**——episode 保持 open,`GET holds` 持续可 resume;只有确认门的 `reroute_to`(仍过目标 fence)/ 家族支持的 `cancel` 才完成物理变更、关 episode、写 `hold_resumed`、按剩余 run 级 hold 决定是否 active;在 `holdUndeliverableTx` 提交前赢的后继仍由事务内 fence + 自动改派处理 |
| resume 后 run 状态 | 只有当没有其他当前 run 级 hold(含 `runHeld:true` 的 undeliverable 事件)时才 `status='active'`;否则 run 保持 held,`hold_resumed` payload 带 `remainingRunHolds:[...]`;变 active 的那次 resume 同事务调 `reviveHeldWorkflowCarrierDeliveriesTx` |
| episode 用法 | `frozen`:`stage` = 形状 id,`episode_id = '<attempt_id>:frozen:<shapeId>:<since>'`;`undeliverable`:`stage='undeliverable'`,`episode_id = '<attempt_id>:undeliverable:<openedAt>'`;无新列;post-grace 每 tick 重新分类 |
| episode 转移规则(一条表,Codex R3#2;唯一部分索引 `idx_wdce_open_by_root (family, root_id) WHERE closed_at IS NULL` 不变) | 当前 open episode × 新观察 → 动作(全部同一事务):`阶段 stalled × 冻结谓词成立` → 关旧 `superseded_by_freeze` + 开 `frozen` + held;`阶段 stalled × 冻结谓词不成立` → **零写入**;`无 open × 冻结谓词成立` → 开 `frozen` + held;`阶段 stalled × 终态未 ACK` → 关旧 `superseded_by_undeliverable` + 开 `undeliverable`;`无 open × 终态未 ACK` → 开 `undeliverable`;`frozen × 形状消失` → 关 `frozen:<shape>:cleared`(run 状态不动,经正门解冻;已消费源 no-op 见下);`undeliverable × 改派成功` → 关 `rerouted`;`任意 × settle` → 关 `terminal:settled:<reason>`;`阶段 stalled × 阶段推进` → 关 `advanced`(既有);`rework 阶段 stalled(sent)× 收到回执且工人 alive` → 关旧 `advanced`、**不开** `received` episode |
| 新表 / 新列 / 新索引 | **0 / 0 / 0** |
| `workflow_delivery_operation` | `kind CHECK IN ('hold_resume','reroute','resident_expiry')`(M0 受控重建);**状态**:state-native reroute(rework/carrier)在同一事务内直接 INSERT `state='projected'`(终态,Codex R2#3);CommDB reroute:`staged` → CommDB 确定性行落地 → `applied` → **直接** `projected`(删除 `sent` 跳;既有 outbox 投递不是 operation 的状态,重放判据 = CommDB 确定性 id);hold_resume:StateStore 权威形状直接 `projected`,CommDB 两形状 `staged → applied → projected`;stall 扫描只看 `staged/applied` |
| `client_request_id` | hold_resume = 调用方 `clientRequestId`;reroute = `'<family>:reroute:<root_id>:g<generation>'` |
| 告警 uid 前缀(新增恰好 1) | `delivery_contract_frozen:<episode_id>`;沿用 `delivery_reroute_outcome:<attempt_id>`、`delivery_operation_stalled:<operation_id>`;守卫集合 = 4 |
| 告警 disposition union(`StateStore.ts:58253`)追加 | `delivery_contract_frozen` `delivery_reroute_outcome` `delivery_operation_stalled` |
| run event kinds(新增;`kind` 是 string,只需 producer/replay 测试) | `mailbox_inflight_slots_exhausted` `three_stage_turn_stuck` `delivery_reroute_operator_required` `delivery_rerouted` `delivery_operation_stalled` `hold_resumed` `hold_resume_refused` `delivery_attempt_version_upgraded` |
| 事件 payload 必带(冻结 / operator_required) | `{ shape, attemptId, rootId, physicalId, recipientExecutionId, livenessVerdict, heartbeatAt, lastActivityAt, recentOutboundInWindow, observedAt, thresholdMs, ageMs, decidedAt, runHeld }` |
| HTTP / CLI | `GET /api/runs/:runId/holds`、`POST /api/runs/:runId/resume/stage`、`POST /api/runs/:runId/resume`(`runs-route.ts`,与 `/hold` `/terminate` 同一 `requireMaster` + `loopbackSelfOrigin(host)`;外层 `tokenAuthMiddleware` 保留;边界 = loopback Host + Bearer master);CLI `flywheel-comm hold list --run <id>`、`hold resume --run <id> --shape <s> --hold-event <uid> --reason <r> [--decision <d>] [--request-id <id>]`,token `TEAMLEAD_API_TOKEN` |
| digest 单点 | `StateStore.canonicalizeHoldResume(input) → { canonical, digest }`;键序 `runId, shape, holdEventUid, decision(null 占位), reason(trim), principal, clientRequestId` |
| reroute `contract_ref`(版本化) | rework:`{ table:'workflow_rework_delivery', pk:<request_id>, routeRevision:<n> }`;carrier:`{ table:'workflow_carrier_delivery', pk:<question_id>, redriveGeneration:<n> }`;CommDB 三家族:`{ table, pk:'<family>:reroute:<root_id>:g<gen>' }`。**全部铸造点**从本单起就写版本(Lead:首选「铸一次就带版本」):`mintWorkflowReworkDeliveryAttemptTx` `:35351`、`mintWorkflowCarrierDeliveryAttemptTx` `:35402`,以及 `baselineWorkflowDeliveryContracts` `:35203-35273`(查询加选 `delivery.route_revision` / `delivery.redrive_generation`)→ `mintWorkflowStateDeliveryAttemptTx` `:35474`(rework/carrier 分支序列化版本键);守卫测试:仓库内任何为 rework/carrier 家族 INSERT attempt 的路径产出的 `contract_ref_json` 都含版本键(三个 minter 单测 + A7 baseline 用例) |
| 代际感知选择器 | `hasWorkflowDeliveryAttemptTx` / `projectWorkflowDeliveryClockTx` / `settleWorkflowDeliveryAttemptTx` 对 rework/carrier 接 `version: { routeRevision } \| { redriveGeneration }`(必填),匹配 `json_extract(contract_ref_json,'$.routeRevision') = ?`;全部调用点传当前物理版本 |
| 一次性 JSON 版本升级(M0,Codex R2#4;Lead:幂等可回滚) | `upgradeWorkflowDeliveryAttemptVersionsTx(now)`:`UPDATE workflow_delivery_attempt SET contract_ref_json = json_set(contract_ref_json,'$.routeRevision', (SELECT route_revision FROM workflow_rework_delivery d WHERE d.request_id = json_extract(contract_ref_json,'$.pk'))) WHERE family='rework' AND superseded_by_attempt_id IS NULL AND settlement_reason IS NULL AND json_extract(contract_ref_json,'$.routeRevision') IS NULL AND <子查询非空>`;carrier 同款用 `redrive_generation`;每行一条事件 `delivery_attempt_version_upgraded{attemptId, before, after}`(replay 证据);幂等 = 第二次 0 rows;权威行缺失的 attempt 不动(留给 projector 的 `run_terminal`) |
| 目标 fence(Codex R2#7) | `rerouteWorkflowStateDeliveryTx` 与 `stageWorkflowDeliveryRerouteTx` 事务内:重新解析当前 activation,要求 `targetExecutionId` 仍是同 run 同 node 的当前 execution 且其 StateStore session ∈ CMUX_LIVE;否则零写入、返回 `{ ok:false, reason:'target_not_current' }`,episode 保持 open,不消耗 `MAX_REROUTES_PER_ROOT` 额度 |
| state-native 改派(单事务) | `rerouteWorkflowStateDeliveryTx({ episodeId, targetExecutionId, now, allowOverCap })`:① 目标 fence ② 物理改派(rework:INSERT `workflow_rework_route_revision` + CAS delivery `pending`,不经 `appendWorkflowReworkRouteRevision` 的 founder authority 门;carrier:`redrive_generation + 1` + delivery 回 `pending`)③ 父 attempt `superseded_by_attempt_id` ④ 子 attempt mint(带新版本)⑤ operation INSERT `projected` ⑥ episode close `rerouted` + `delivery_rerouted` 事件 + 恰好一次 outcome 告警;不接受 `principal`(类型级) |
| CommDB 改派(跨库 saga,仅三家族) | `stageWorkflowDeliveryRerouteTx`(含目标 fence)→ `staged` → CommDB `rerouteMailboxDelivery` / `rerouteRunnerPhaseWake` / `rerouteTurnWake`(砍前 `db.ts` 原样)→ `applied` → `projectWorkflowDeliveryReroute` → `projected`;每步 owner = `delivery-operations.runPass`;重放判据 = CommDB 确定性 id |
| CommDB 恢复原语对已消费源(Codex R3#5) | `resumeTurnWakeHold` / `resumeMailboxInflightHold`:精确源已 `acked` / `ACKED` / `cancelled` → 返回 `{ ok:true, noop:true }` 并照常写 receipt 行,`hold_resume` saga 照常 `applied → projected`,run 按「无其他 run 级 hold 才 active」解冻;只有源不存在才 `{ ok:false }` |
| JSON 升级回滚(Codex R3#6) | 从 `delivery_attempt_version_upgraded` 事件 `payload.before` **逐字**还原:`UPDATE workflow_delivery_attempt SET contract_ref_json = :before WHERE attempt_id = :attemptId AND contract_ref_json = :after`(双 fence:attemptId + 事件记录的 `after`;升级后又被改过的行拒绝回滚并列出);不用 `json_remove` |
| 退役(M4) | 见 §0 Lead 裁定;`fly2278-retirement.test.ts` |

## 2. 里程碑

执行顺序 M0 → M1 → M2 → M3 → M4 → M5。chunk id `M<n>`。分支 `flywheel-FLY-2278`,一个 PR。每个 M 先 RED(失败输出存 `__tests__/fixtures/fly2278-red/<M>.txt`)再 GREEN,提交信息 `fly2278 M<n> RED|GREEN`。

### M0 — 守卫、清单、schema 与数据前置(先 RED)

- `fly2278-generality.test.ts`;`fly2278-alert-prefix.test.ts`(=4);`fly2278-hold-inventory.test.ts`(`SET status = 'held'` 出现集合 == inventory;manifest ↔ registry 双向;registry 每项有 `scope`);`fly2278-liveness.test.ts`(四格 + 格式矩阵 + `Math.max` 守卫 + stale-blocker 解析器 0 次)。
- schema 前置:`workflow_delivery_operation` CHECK 放宽(新库 DDL 三种 kind;旧库 `sqlite_master.sql` 不含 `'hold_resume'` → 同事务 `CREATE __new → INSERT SELECT * → DROP → RENAME → 重建 idx_wdo_client_request`);A7 非空旧表用例。
- 数据前置:`upgradeWorkflowDeliveryAttemptVersionsTx` 挂在 schema 迁移之后、首个维护 tick 之前;baseline 与通用 minter 版本感知(§1「全部铸造点」)保证升级后不再出现无版本行;A7 升级用例 + baseline 边界用例 + 回滚验证(§3)。
- `fly2278-replay.test.ts` 骨架:#2、#5、#7 槽位半边;先 RED。

### M1 — 活性分类器 + settle 契约(缺陷 ⑥⑤)

- `liveness.ts`;`collectRecipientLivenessEvidence({ store, commDb, executionId, nowMs })`:StateStore `getSession` 读 `heartbeat_at` / `last_activity_at`(`founder-notify-utils.parseSqliteUtcMs`),CommDB `hasMessagesFromAfter(executionId, iso(nowMs - windowMs))`,`observedAtMs = nowMs`。
- `settleWorkflowDeliveryAttemptTx({ family, table, pk, version?, reason, now })`:① 解析唯一 `attempt_id`(`superseded_by_attempt_id IS NULL`,rework/carrier 加版本);② set-once `settlement_reason`;③ 同事务关 episode(`closed_at = now`,`closed_reason = 'terminal:settled:'||reason`);④ 才返回。删除 `settleWorkflowCarrierDeliveryOnCompletionTx` `:35721-35730` 的私有关闭段。**调用点 sweep(七个逻辑调用点,全部传 `now` 与版本)**:baseline `:35320`、launch rollback `:26580`、launch side-effect abandon `:56229`、carrier completion `:35696`、gate_holder completion `:47678`、land completion `:55216`、projector。
- `listLiveWorkflowDeliveryAttempts` 加 `AND settlement_reason IS NULL`;projector 核销规则改为 §1。
- 测试:A5 七调用点 × {关闭, 回滚};A6;projector 阳性(ACKED → settled)/ 阴性(终态未 ACK → 仍 live)。

### M2 — 冻结线 + undeliverable 线 + 改派(缺陷 ①②④)

- CommDB 投影加回 `inflight_batch_count`、`oldest_inflight_delivered_at`、`push_count`;`sources/mailbox.ts` / `sources/turn-wake.ts` 复活但只产出 `{ shapeId, since }`。
- watch:按 §1「episode 转移规则」一条表执行:形状命中 → `freezeRunTx`(谓词成立才同事务关旧阶段 episode + 开 `frozen` + held + 事件 + 告警,否则零写入);形状消失且有 open `frozen` episode → close `frozen:<shape>:cleared`。undeliverable 判定 → 同事务关旧阶段 episode + open `undeliverable`(不告警)。rework `received` 阶段按 §1「rework received 告警」过活性门,alive 时旧 `sent` episode 仍以 `advanced` 关闭。测试 A4b。
- `delivery-operations.ts` `runPass`(watch 之后):对每个 open undeliverable episode:① 若该 episode 已有 `delivery_reroute_operator_required` 事件(任一 `runHeld`)→ 跳过(只等确认门);否则解析后继 → 有 → 改派(state-native `rerouteWorkflowStateDeliveryTx`;CommDB saga),目标 fence 失败 → 留 open 下 tick 重试;② 无后继且 grace 未到 → 零写入;③ 无后继且 grace 到期 → `holdUndeliverableTx`。改派上限耗尽且有活后继 → `delivery_reroute_operator_required{runHeld:false}` + 一次 outcome 告警,不 hold;apply 失败 / saga 卡住 → 告警不 hold;stall 扫描只看 `staged/applied`。
- 测试:A1(12 格四表零写入 + 两 barrier)、A2(a)–(e)、A4(含 `projected` 终态、零 stall 告警、目标 fence 两 barrier、旧代事件、单事务崩溃注入)、A10。

### M3 — hold 正门(缺陷 ③)

- registry + manifest(19 项 + `scope`,`carrier_run_inactive` 为 `run-derived`);`listWorkflowHolds` / `resumeWorkflowHold` / `applyStateWorkflowHoldResumeActionTx`(砍前 `:36905-37780` 逻辑)复活,差异:前置条件按 scope;`run-derived` 项 `resumable:false` 并指向底层 run hold;resume 后仅当无其他 run 级 hold 才 `active` 并同事务 revive carrier;`resumeWorkflowHold` 接收 `{ canonical, digest }`;`resume_undeliverable` 两个 decision 按 §1(cancel 按家族表;phase_wake 无 cancel);CommDB 两恢复原语对已消费源 no-op 成功(§1)。
- `runs-route.ts`:抽 `requireMaster`;三路由;`createRunsRouter` 的 `auth` 加 `confirmTokens`,`plugin.ts:4216` 传 `opts?.fleetConsole?.tokens ?? new ConfirmTokenStore()`;body `runId` ≠ 路径 → 400。
- CommDB 两形状经 `kind='hold_resume'` saga(`resumeMailboxInflightHold` / `resumeTurnWakeHold` 砍前逻辑 + 已消费源 no-op 分支)。
- CLI `commands/hold.ts` 复活 + `index.ts` 接线;runbook SQL 段替换。
- 测试:A3 在完整挂载 app;19 形状 × {detect, 阳性, 阴性};`carrier_delivery_exhausted → needs_lead` 真实阳性;双 hold;`carrier_run_inactive` 负向 + 自动 revive 阳性;A2(d) 超上限门阳性 + 单调两向转换;cancel 五家族(四提供 + phase_wake 拒绝)阳性 + 崩溃 barrier;turn 冻结 → ACK → 门 → active(+ 另有 run hold 仍 held)。
- QA 交接项:生产只读快照跑 `listWorkflowHolds` 遍历存量 held run,列出无匹配形状的 run 作为发现物。

### M4 — 退役

- 按 §0 Lead 裁定删除被列符号;`policy.ts` 加 `'rework'`;A10 测试;`fly2278-retirement.test.ts`(源码 `FLYWHEEL_ENGINE_REWORK_(ALERT|HOLD)_MS` 0 次、`reconcileWorkflowReworkStalls` 0 次、`escalateWorkflowReworkStall` 0 次)。
- PR body 三 root 消费者 sweep(插件 fork `external_plugins/`、`~/.claude/plugins/cache/*/`、主仓 `scripts/` `packages/`,带时间戳;缺 root 显式写「未检查」)。
- 挂载:`plugin.ts:7461-7462` 后加 `deliveryOperations.runPass(deliveryNow)`。

### M5 — 收口

- `engineering/doc/milestones/FLY-2278.md`;`doc/engineer/implementation/delivery-contract.md` 替换「不做自动改派 / 不 hold / 不提供 resume API」段,`workflow_delivery_operation` 的「保留」句改为三种 kind 的 owner 表。
- PR body:变更摘要、A1–A10 度量、消费者 sweep、Linear 链接;`progress.md` chunk 全 green。

## 3. Schema、数据与迁移

| 对象 | 变更 | 类别 |
|---|---|---|
| `workflow_delivery_operation` | `kind` CHECK `('resident_expiry')` → `('hold_resume','reroute','resident_expiry')` | 受控重建(M0);其余列、索引、FK 逐字不变;非空旧表用例 |
| `workflow_delivery_attempt.contract_ref_json`(rework/carrier live 行) | `json_set` 追加 `routeRevision` / `redriveGeneration` | **数据升级,非 schema**(M0);幂等(第二次 0 rows);每行一条 `delivery_attempt_version_upgraded` 事件 |
| StateStore 其余 | 0 表 0 列 0 索引 | — |
| CommDB | 投影 SELECT 加三列输出;新增 1 个只读查询 `hasMessagesFromAfter` | 查询变更,非 schema |

**JSON 升级的回滚步骤(Lead 要求写明;Codex R3#6 改为逐字还原)**:回滚 = 部署旧二进制 + 对每条 `delivery_attempt_version_upgraded` 事件执行 `UPDATE workflow_delivery_attempt SET contract_ref_json = :before WHERE attempt_id = :attemptId AND contract_ref_json = :after`(`before`/`after`/`attemptId` 取自事件 payload;双 fence:升级后又被改过的行不回滚并列出);不用 `json_remove`(会重排 JSON 空白)。本单新铸(带版本)的行没有升级事件,不被触碰——旧二进制读它们时多出的键被忽略(旧代码只读 `table/pk`)。A7 断言回滚后 `contract_ref_json` 逐字等于升级前快照,含非规范 JSON fixture;脚本放 `scripts/fly2278-rollback-attempt-versions.sh`(只读快照上先 dry-run 列出行数)。

降级承诺:旧二进制读新库不崩(CHECK 更宽、JSON 多键都向后兼容);不承诺功能等价。

## 4. 回滚边界

- M1(settle 契约 + projector 规则)独立可回滚。
- M2+M3 一个原子部署/回滚组。
- M4 退役独立;M0 的 CHECK 放宽与 JSON 升级不需回滚(无害),需要时按 §3 步骤回滚 JSON。

## 5. 负向守卫(必须有对应测试)

1. watch 对源表与 attempt 表零写入(触发器计数);`freezeRunTx` / `holdUndeliverableTx` 是仅有的两个新增 `SET status='held'` 出现点。
2. 12 格四表零写入 + 两 barrier;`unknown` 格事件 `livenessVerdict='unknown'` 且文案含「无心跳记录」。
3. undeliverable:grace 内零 held 零告警;后继 barrier;alive 零写入;alive→absent 升级;operator_required 每 episode 恰好一次(uid 绑 episode,重放 0 rows);cap 分支不 hold 且门可达;`runHeld:false` 后永不升为 run hold(单调);apply/stall 失败零 hold;cancel 先终态化权威行(四家族)且 phase_wake 无 cancel。
4. 正门:401 / 403 / 400 / 409 / 幂等五路径;双 hold;delivery 级不要求 run held;`run-derived` 拒绝直接 revive;前置失败只写 `hold_resume_refused` 短事务。
5. episode 转移:唯一部分索引在全部转移路径下不被违反(A4b 三条顺序控制);frozen 清除后 run 可经正门解冻(已消费源 no-op)。
6. reroute:`contract_ref.pk` 真实存在(五家族);全部铸造点(含 baseline)带版本;state-native 单事务崩溃注入;operation 终态 `projected` 且零 stall 告警;目标 fence 两 barrier 且不消耗额度;旧代事件不推进子 attempt;`rerouteWorkflowStateDeliveryTx` 不接受 `principal`(类型级)。
7. settle:七调用点关 episode 同事务 + 回滚;`listLive` 不含 settled;projector 不核销终态未 ACK 行。
8. rework received:alive 不开新 episode;旧阶段 episode 正常 advanced;severe 前重判活性。
9. 期限只以常量出现;新模块源码无节点名字面量;`process.env` 在 `delivery-contract/**`、`hold-writers.ts`、`delivery-operations.ts` 0 次;`stale-blocker-guard.parseSqliteUtcMs` 在这些文件 0 次。
10. 机制守卫:新表 0、新列 0、新索引 0、新告警前缀 1、CHECK 变更 1、CommDB 新查询 1、JSON 升级幂等且可逐字回滚(A7 逐字断言)。
11. 阳性对照:新测试文件不直接 INSERT attempt / episode 表(A8 grep)。

## 5A. 实现节点 RED 测试清单(Lead 裁 B:R4 两条 BLOCKER 的顺序控制先 RED 再 GREEN,PR body 逐条引用)

| # | Codex 项 | 本 plan 落点 | RED 测试(实现节点必须先失败) |
|---|---|---|---|
| R4#1 [B] | mailbox cancel 只写 `superseded_by` 不是终态 | §1 cancel 家族表 mailbox 行 | 经真实 `commands/send.ts` 投一封信 → 门 `cancel` → 断言行 `state='DEAD'`、`dead_reason` 带 operation id、lease/batch 清空;随后跑真实 `mailbox-queue.ts` claim/delivery 路径,该行**不被 claim、不被 deliver**;重放 `cancel` 同 operation id → 成功且 0 rows;已 ACKED 行 → no-op 成功;「staged 未落 CommDB」与「CommDB 已落未投影」两条崩溃 barrier |
| R4#2 [B] | `runHeld:true` 后自动改派关掉 episode,正门失去可 resume 项 | §1 单调规则「两模式对称」;M2 ① | `runHeld:true` 事件落地 → 注入后继 admission → 跑维护 pass → 断言 episode 仍 open、run 仍 held、`GET holds` 列出且 `resumable:true` → 确认门 `reroute_to` → 改派完成、episode `rerouted`、`hold_resumed` 落地 → 仅当无其他 run 级 hold 时 run `active`(另加一臂:另有 run hold → 仍 held) |
| R4#3 [M] | rework alive 零写入 vs 关旧 episode 措辞 | §1 rework received 行 | 旧 `sent` episode 存在 + 回执 + alive → 恰好一次 `advanced` 关闭、零新 episode、零告警;无旧 episode + alive → 四表零写入 |
| R4#4 [L] | 文案建议门会拒绝的 cancel | §6 | phase_wake 的 `runHeld:true` 文案不含 `cancel`;mailbox 的含 |

## 6. 显示文案(Lead 收到的样子,进 `alert-kind-copy.ts`)

- `delivery_contract_frozen`(只在真的冻结时发):「<issue> 一份交接在「<形状中文>」卡了 <N> 分钟;收件体 <exec8> 状态 <status>,活性 <absent|无心跳记录>(心跳 <t1>、状态变化 <t2>、最近出站 <有/无>);run 已冻结。正门:`flywheel-comm hold list --run <id>`」。
- `delivery_reroute_outcome`:改派成功「收件体已终结,已改派给 <exec8>(第 k 次)」;需人工(`runHeld:true`)「收件体已终结且 15 分钟内无后继、无活性证据(<verdict>),run 已冻结,正门:`hold resume --shape delivery_undeliverable_no_recipient --decision <按该家族 requiredDecision 渲染:reroute_to <exec> [| cancel]>`」(文案与 list/stage/apply 用同一个 `requiredDecision` 值,不会建议门会拒绝的动作,Codex R4#4);超上限(`runHeld:false`)「已自动改派 2 次仍未送达,run 未冻结,需要你确认再改派一次<或取消——仅当该家族提供 cancel>:同上命令」;apply 失败「改派未能自动完成(<reason>),run 未冻结,下一轮重试」。
- `delivery_operation_stalled`:「一次自动改派/恢复卡在 <state> 超过 <N> 分钟,run 未冻结,查看 `hold list`」。
- `delivery_contract_stalled`(rework received,沿用文案)追加「收件体活性 <verdict>」。
- 形状中文:槽位耗尽「收件箱三批未读」;turn 卡住「换手唤醒两次无回执」;无后继「收件体已终结且无人接手」。

## 7. progress.md chunk 约定

`--set-chunk M0=…|M1=…|M2=…|M3=…|M4=…|M5=…`,状态 `pending|red|green|reviewed`;GREEN 后先 push 再更新 chunk;判决绑头那一轮不做 ledger 提交。

## 8. 不做

- FLY-2268 全部(心跳 rider、durable turn、resident hold、清信);pane 采样落库(`LivenessEvidence` 预留 `paneChangedAtMs?: number|null`,本单不填)。
- 不新增 feature flag / env 旋钮 / 告警层 / 欠条 state 值 / 第二张 saga 表 / 新表 / 新列 / 新索引 / 新 hold 形状。
- 不改 mailbox 投影 WHERE(exploration §1.4 已证明不需要)。
- 不为 rework 家族补 `consumed_at` 写点(FLY-2248 遗留;received 告警过活性门即止)。
- 不改 FLY-2211 reown 判死;不给 Lead↔Lead 信件加合同;不改 codex 二进制;不在本单扩 hold 形状覆盖存量 held run 中匹配不上的历史事件(QA 发现物另开单)。

## 9. Design correction（实现审查 R9，2026-09-03）

R9 HIGH `failed-reroute-retry-loop-is-unbounded` 原文标题："A persistently failing CommDB reroute retries forever — one new operation row, child attempt and founder alert every tick, and the operator door is never reached"。其复现结论逐字为："Growth is strictly linear and never self-limits."；其建议逐字为："bound consecutive compensated failures per episode — e.g. count `failed` operations for the episode/root and, past a small threshold, route through `recordWorkflowDeliveryRerouteOperatorRequired` (opening the existing operator door) instead of re-staging, and suppress the per-attempt failure alert behind that same bound rather than emitting one per operation."

实现节点向 Lead 提交的收敛方案逐字为："stable failure-alert UID per source attempt, and on the next pass after a failed operation for the same target emit existing delivery_reroute_operator_required runHeld:false so GET holds exposes the existing requiredDecision door; no new state/schema/knob/shape and run stays active." Lead 批准此窄偏离并裁定**不增加失败上限**：保留 §1/A2 的「failed operation 不扣 reroute 配额」「apply 失败不 hold」；新增「同目标第一次自动 apply 失败后，下一轮暴露既有 operator 门」。失败告警按 source attempt 使用稳定 UID，同一目标反复失败只留一条；operator 可从既有门继续重试，run 保持 active，不新增 knob、表、列、状态、告警层、endpoint 或 hold 形状。
