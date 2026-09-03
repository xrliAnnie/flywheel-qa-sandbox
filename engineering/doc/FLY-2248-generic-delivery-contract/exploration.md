# FLY-2248 通用投递合同 — 探索
Issue: FLY-2248 (https://linear.app/geoforge3d/issue/FLY-2248/引擎loop稳定性-通用投递合同-欠条必达超时升级工人常驻收信失联判据先问送达每种冻结配正门覆盖所有-dag-loop非)
日期: 2026-09-02
基于: 无

## 0. 一句话结论

09-01 全天 8 起事故不是 8 个 bug,而是同一个结构洞的 8 个截面:**引擎把「送出去了」当成「送到了」,把「没动静」当成「人死了」,把「旧欠条没销」当成「新交付无效」,把「冻住」当成「处理完」**。四点修法全部挂在通用对象上(欠条 / 工人 / 转移 / 冻结形状),不挂在任何一对节点上;账本证据显示这 8 起里至少 3 起发生在 QA↔implement 之外的边(founder_gate→general、land→cleanup、design 节点 carrier),founder「必须 general」的硬要求与证据一致。

## 1. 问题边界(founder 硬要求)

- founder 2026-09-01 20:26 PT 批准诊断页(https://fw-reports-a53de2.vercel.app/r/d0b4235c76da2f607f087a5450e62f66/),硬要求:**修法必须 general——凡 DAG 有 loop 的边都被 cover,不许只修 QA↔implementation 一段**。
- 四点修法:①统一投递合同(欠条层);②接收端常驻收信(工人层);③状态机判据修正(转移层);④每种冻结形状配官方恢复正门。
- 验收第一判据是通用性:实现面不得出现特定节点对(qa/implement 字样)的硬编码;回归床用 09-01 全天 8 起活体事故做回放用例,每起至少一条测试。
- 相关病根子单:FLY-2107(信箱槽位)/ FLY-2120(held 无解除)/ FLY-2246(land 错误零持久化)/ FLY-2072(病根账本 Epic)。本 session Linear MCP 鉴权失败(HTTP 401),三张子单正文未能拉取;下文对它们的描述全部来自代码与账本,不是 issue 原文。

## 2. 现状底图

### 2.1 四条物理投递路(诊断页的 🅰🅱🅲🅳)在代码里的样子

| 路 | 发送端 | 接收端 | 失败时留什么痕 | 厂商 |
|---|---|---|---|---|
| 🅰 信箱 | `wakeRunnerMailbox`(`packages/flywheel-comm/src/wake.ts:181-243`)写 `teams/<lead>/inboxes/<agent>.json`;Lead 指令经 `runner-mailbox-lane.ts:113` 加 `[lead-instruction <id>]` 信封 | Claude:CLI 自带 poller(`ClaudeCodeAdapter.createReceiver` 返回 null,`:254-257`);Codex:Bridge 进程内的 `CodexMailboxWatcher`(`codex/CodexAdapter.ts:381`),**只在 phase hold 期间开**(`codex-phase-lifecycle.ts:372-426,449-451`) | 6 次重试后 DEAD(`runner-mailbox-lane.ts:229-234`);`runner_wake_failed` session_event(`runner-wake.ts:261`)。**没有「排队太久」告警**;在飞批次 ≥3 时新信永远 QUEUED(`mailbox-queue.ts:1192-1218`,FLY-2107) | 两家 |
| 🅱 管道直推 | `client.startTurn(threadId, "[phase-wake <id>] …")`(`codex-daemon-client.ts:1005-1012`),WS over unix socket | codex app-server daemon(detached,`codex-daemon-runtime.ts:974-980`) | FLY-2211 后:socket+rollout 双探针 ≤1 个维护节拍;`codex_transport_death_snapshot`;kill-ledger | 仅 Codex |
| 🅲 派活铃 | `activateHolderForWake`(`holder-wake-activation.ts:26-132`)+ `deliverDurableTurnWake`(`wake.ts:190-246`,CommDB `turn_wake_outbox`,最多 2 push)+ 指针 nudge(`runner-recovery-nudge.ts`,**仅 Codex**,`plugin.ts:9143`) | 工人在 goal 边界读到 `runner_phase_wakes` 行后 `turn/start` | 20 分钟无回执 → Lead question(`db.ts:5564-5624`);但 `runner_phase_wakes` 行 `pending` 且 `push_attempts=0` 时**没有任何闹钟**(09-01 实例见 §3 第 4 起) | 两家(nudge 仅 Codex) |
| 🅳 随新任务打包 | 换体:`materializeWorkflowReworkReplacement`(`StateStore.ts:29114`)铸新 execution,founder 反馈拼进 prompt(`workflow-engine-dispatcher.ts:2492-2502`) | 新工人首轮 | 未起飞 → `rollbackUnlaunchedWorkflowAdmission` 把欠条置 `held`(`last_error='replacement_launch_rolled_back'`),**没有任何恢复路径**(`StateStore.ts:29246-29251` 的 CAS 只认 `persisted_target_missing`) | 两家 |

### 2.2 「欠条」其实不止一张:现存 8 个欠条家族

诊断页只画了 `workflow_rework_delivery` 一张欠条。代码里有语义相同(「一份跨边交接,谁欠谁一次送达」)的对象至少 8 个,各自有各自的状态词汇、各自的(或没有的)闹钟:

| 家族 | 表 / 对象 | 状态词汇 | 谁在看它 | 超时闹钟 |
|---|---|---|---|---|
| 返工欠条 | `workflow_rework_delivery`(`StateStore.ts:20755`) | pending → turn_granted → awaiting_receipt → wake_delivered → completed;replacement_pending / held / needs_lead | `WorkflowReworkCoordinator.reconcile`(`workflow-rework-coordinator.ts:341-741`) | 30min alert / 60min hold(`workflow-engine-dispatcher.ts:1129-1262`),`actor_alive_after_receipt` 新鲜时**永不 hold 但也永不升级** |
| ship carrier 欠条 | `workflow_carrier_delivery`(`:19969`) | pending → grant_started → turn_granted → awaiting_receipt → wake_delivered → receipt_started → completed;held / needs_lead | `WorkflowShipCarrierDeliveryHandler`(`workflow-ship-carrier-coordinator.ts:243-560`) | 5 strikes → needs_lead;`run_inactive` → held,只有 pane-loss 恢复路径顺手复活它(`StateStore.ts:29257`) |
| TURN 唤醒 outbox | CommDB `turn_wake_outbox`(`db.ts:114-140`) | pending → sent → acked / cancelled | `drainTurnWakeOutbox`(`turn-wake-patrol.ts`) | 20min 无回执 → Lead question |
| phase 派活铃 | CommDB `runner_phase_wakes`(`db.ts:175-253`) | pending → started → finished | Codex phase lifecycle | **无** |
| 信箱行 | CommDB `mailbox`(`mailbox-schema.ts:79-122`) | QUEUED → LEASED → ACKED / DEAD | mailbox lane | **无年龄闹钟**;slot 满时静默 |
| 新派工 | `workflow_launch_owner.delivery_state`(`:21209`) | pending → repairing → delivered | dispatcher | 未起飞 hard TTL → `unlaunched_admission_held`(**无正门**) |
| 激活身份 | `workflow_execution_binding.mode`(`:2731`) spawn / wake / replacement | — | — | — |
| land 作业 | `land_operation`(`:19969` 附近) | intent → running → partial → completed;held | land executor | 9 次重试 ≈4h → held,`cause=unknown`(FLY-2246) |

**关键空洞**:普通的 design→implement、implement→QA 边**没有欠条**——边的跨越只表现为 `workflow_run_node` 状态 + 一次 fresh execution 铸造;只有返工 / carrier / 换体 / founder 恢复这些「再入边」才带 durable 送达义务。founder 要求「凡有 loop 的边都 cover」,因此新派工也必须被同一合同覆盖(`workflow_launch_owner.delivery_state` 是现成的挂靠点)。

### 2.3 工人层:「通信管家」不是独立进程(对诊断页的更正)

诊断页把 Codex 工人画成「前台干活 + 通信管家收发信」双进程。代码事实(FLY-2211 exploration §1 已更正过一次):Codex 工人 = Bridge 内 goal-runtime + detached `app-server` daemon + tmux TUI 三件;**收信的是 Bridge 进程内的 `CodexMailboxWatcher`**,它:
- 只在 `phaseKeepAlive` 且工人已进入 phase hold 时才开(`CodexTmuxAdapter.ts:982-1006`;`confirmHoldPaused()` 到 `leaveHold()` 之间);
- turn 进行中没有任何收信员——信落在文件里没人读,直到 goal 边界;
- 随 Bridge 进程死亡(daemon 与 TUI 活着,收信员没了);
- 它的 `health()` 写了但**没人读**(`IMailboxWatcher.health`,`types.ts:199-212`)。

Claude 工人:CLI 自带 poller 活着就读信;进程一退出就零读取,之后所有指令只能死信或换体。**两家共同点:goal 达成即失去收信能力**,这就是「返工唤醒打不醒 goal-achieved 体」的病根,而且它与节点类型无关。

FLY-2216 已经交付了可复用的「常驻体制」骨架(自写心跳 + 纯分类器 + GatePoller 60s 骑行 + 每 episode 至多一次恢复一次告警 + identity 不确定只告警不动手),FLY-2211 交付了「重启后重新认领在飞执行体」。二者拼起来就是工人层的地基。

### 2.4 转移层:三处把「送达」和「活着」混起来的判据

1. `escalateWorkflowReworkStall` 的 hold 理由直接取 `delivery.last_error ?? "delivery_<state>"`(`workflow-engine-dispatcher.ts:1229`)——所以 `delivery_awaiting_receipt`(信还没送到)会被写成整单冻结的理由,把「投递未确认」升级成「工人失联」。
2. `actor_alive_after_receipt`(`workflow-rework-coordinator.ts:516-527`)只压制 hold,不设自己的期限:FLY-2211 一张欠条在这个状态下 generation 打到 209、持续 11.5 小时,期间铃从未响(§3 第 4 起)。「活着」≠「收到了」≠「在干」。
3. 交货核销:`commitWorkflowTransitionTx` 在 `:41559/:41638` 只把 `wake_delivered` 的欠条推到 `completed`;若欠条仍在 `awaiting_receipt`,节点完成后欠条继续挂着,60 分钟后 stall clock 把已经交货的 run 冻住(§3 第 6 起,FLY-2241 的 `held: delivery_awaiting_receipt` 与 `land_target_not_current` 同一秒落账)。

### 2.5 冻结形状:14 处写 `held`,2 处解 `held`

`workflow_run.status='held'` 有 14 个写点,只有 2 个解点(`StateStore.ts:29239` 只认 pane-loss;`:54428` 只认 land)。通用正门 `openOperatorRework`(`:34133`)扫 11 种 hold 事件但只给 4 种开门(`:34353-34364`);`rework_activation_stalled_held`、`completion_receipt_missing`、`retry_limit_escalated`、`rework_suppressed_idle_spin`、`unlaunched_admission_held`、`run_held_by_operator` 一律 `run_not_reworkable`;`environment_failure_escalated`、`workflow_gate_origin_preflight_terminal` 连扫描名单都不在(诊断页也看不见)。操作员能 hold 不能 unhold(`runs-route.ts:347` 只挂了 hold/terminate)。于是 Lead 手里只剩 `runner-patrol-rules.md` 附录 A/B 的 SQL 手术(带备份、带断言表),09-01 23:52 PT 的 `teamlead.pre-fly2121.*.db` 备份就是那天做手术的痕迹。

## 3. 09-01 八起事故的账本回放

数据来源:`~/.flywheel/teamlead.db`(StateStore)与 `~/.flywheel/comm/flywheel/comm.db`(CommDB)于 2026-09-02 01:15 PT 的只读副本;时间戳为 UTC;「09-01 全天」按 PT 取 2026-09-01T07:00Z → 2026-09-02T07:00Z。

| # | 事故(issue 原话) | 账本证据 | 命中层 | 现有机制为何没响 |
|---|---|---|---|---|
| 1 | 裁定令排队 3h | `mailbox` 4 条 Lead→runner `bf1eb9c0…` 的 response,09:23Z 发、13:40Z 才 ACK,延迟 208–257 分钟;同日 runner 收件 ACK 延迟 >90 分钟共 10 条 | 欠条层(信箱家族) | 信箱只有「6 次重试→DEAD」,没有年龄闹钟;在飞批次 ≥3 时新信静默排队(FLY-2107) |
| 2 | 清理令双死信 | `land-cleanup-instruction:land:be9c9550…`(FLY-2237)03:55:04Z 同时发给 3 个 execution,2 个 DEAD `recipient_terminal`(0 分钟 / 30 分钟);更早 `land:7774bd…` 4 发 4 死、`land:9a7ce3…` 2 发 2 死 | 欠条层 + 转移层 | 发给已终结收件人只产生 DEAD 行,不改道、不告警 |
| 3 | verdict 秒死信 | 发给 Codex 实现体 `46b18312…` 的 15 条 Lead response(含 6 条 `{"reviewVerdict":…}` 判决):9 条 `lease_expired_unacked`(120–230 分钟)、4 条 `recipient_terminal`、2 条 `delivery_attempts_exhausted`;另有多条 `recipient_terminal` 在 0.0 分钟即死 | 工人层 + 欠条层 | Codex 工人 turn 中无人读信;lease 到期后直接 DEAD,Lead 只看到 `lead_unacked` 死信通知 |
| 4 | 管道孤儿铃不响 | `runner_phase_wakes` 一行 `pending`、`push_attempts=0`、`source=turn_end_sweep`,17:31:04Z 排队(FLY-2211 实现体 `f5ef370c…`)至今未 finished;同一实现体的欠条 `dcd0fa46…` generation=209、`actor_alive_after_receipt` 从 06:01Z 到 17:30Z;后续欠条 `9d374aa3…` 在 09-02 05:11Z 被 `rework_activation_stalled_held(reason=delivery_awaiting_receipt)` | 欠条层 + 转移层 | `runner_phase_wakes` 无闹钟;`actor_alive_after_receipt` 压制 hold 又不升级;最终 hold 的理由是「没送到」而不是「人死了」 |
| 5 | run 双假死 | PT 全天 `execution_dead_rolled_back` ×2、`rework_replacement_materialized` ×2:FLY-2237 `46b18312…`(goal 已完成、TUI 在场)02:33Z 被判死换体为 `eb0c9b92…`;FLY-2178 `f76bf88c…` 04:03Z 换体为 `e2f7774b…` | 转移层 | 「活证据过期」被读成「死亡证据」;判死前没有问「上一次投递到了没」 |
| 6 | 交货被欠条拒收 | FLY-2241 run `25703777…`:**founder_gate → general 节点 attempt 2** 的欠条 `fc0f8bd7…` 21:16Z 授棒、22:32:50Z 变 `held(delivery_awaiting_receipt)`;同一秒 `land:294…` 变 `held(land_target_not_current)`;run 停在 land 节点 `held` | 转移层(核销)+ 冻结正门 | 交货核销要先看旧欠条;stall clock 把已交货的 run 冻住;解冻只有附录 A 的 SQL |
| 7 | 2237 三道令 QUEUED 未消费致硬要求漏交付 | Lead 00:59:21Z / 01:13:20Z / 01:23:57Z 三条 response 发给 `46b18312…`,第三条原文「你信箱里有我两道未消费指令」;三条分别在 101 / 80 / 70 分钟后 DEAD `recipient_terminal`——工人在读到它们之前就到达了 goal 边界并终结 | 工人层(+FLY-2107 槽位) | Codex 只在 phase 边界读信;`complete` 不检查未消费信;slot 满时后续信永远 QUEUED |
| 8 | 2237 返工唤醒打不醒 goal-achieved 体换体 | 返工欠条 `ba0197e9…` 02:24:42Z 铸出 → 02:33:45Z `rework_replacement_materialized`(dead=`46b18312…`,new=`eb0c9b92…`)→ 新体 generation=21 `actor_alive_after_receipt` 至 03:27Z | 工人层 + 转移层 | goal-achieved 的 Codex 体不再收信,唯一出路是换体;换体后又落回「活着但没收到」的循环 |

另外两条与 FLY-2246 直接相关的旁证:PT 全天 4 个 `land_operation` 以 `retry_exhausted:issue_closeout_incomplete:cause=unknown` 进入 `held`(FLY-2166/2152/2169 + 一条 partial `window_identity_mismatch`);dispatcher land 分支的 `throw new Error("engine_land_*")` 全被 tick 的 catch 吞成 `result.held += 1`(`workflow-engine-dispatcher.ts:353-359`),`land.kick()` 是 `void … .catch(console.warn)`(`plugin.ts:6778-6784`)。

## 4. 设计方向:四个通用对象

### 4.1 欠条层 —— 「投递合同」是投影,不是新账本

**候选 A:一张新总表** `workflow_delivery_contract`,所有铸造点写入、所有推进点更新。
拒绝:8 个家族各自已有 CAS/lease/generation 语义,再加一张镜像表就是第二本账,漂移是必然(memory:prefer one source of truth over mirrored vocabularies)。

**候选 B:逐家族各加一个 timer/告警。**
拒绝:这正是现状——rework 有 30/60 分钟钟、turn_wake 有 20 分钟钟、其余没有;每家一套阈值、一套 uid、一套 dedupe,下一次新家族(例如 gate holder)又会漏。

**候选 C(采用):合同 = 纯投影 + 巡检 episode。**
- 定义规范阶段 `minted → granted → sent → received → consumed → settled`,终态 `superseded | cancelled | undeliverable`,冻态 `frozen(shape)`。
- 每个家族实现一个只读 `DeliveryContractSource.snapshot(now)`,把自家状态词汇映射到规范阶段并给出 `progressToken`(generation/updated_at/seq)与 `stageEnteredAt`。映射表是数据,不是 if/else;新家族=加一个 source。
- 一个 `DeliveryContractWatch` 骑现有 5 分钟维护 tick(零新 timer,FLY-2211/2216 同款),对每张合同按「阶段 × 家族」查期限;超期且 progressToken 未变 → 开 episode、经现有 `enqueueWorkflowEngineAlert`(`workflow_alert_outbox`,`eventType=workflow_engine_escalation`)升级给 Lead;阶段前进 → 关 episode 并发 informational `delivery_contract_recovered`。每 episode 至多一次 alert + 一次 re-alert(3N 时 severe)。
- **只持久化 episode**(新表 `workflow_delivery_contract_episode`),合同本身不落地。
- 「消费」证据是新增的观测点:工人对这份交接的第一个可归因动作(`flywheel-comm turn` 回执 / `stage set` / phase wake `started` / mailbox ACK for claude on_delivery)。这让「收到了但没在干」(第 4、8 起)第一次可被区分。

### 4.2 工人层 —— 收信员挂在 adapter 上、活满整个 execution

- 新 `ResidentReceiverSupervisor`(Bridge 内):对每个在飞 execution,若其 transport `capabilities().wakeMode !== "builtin-receiver"`,从 admission 到 terminal 全程持有一个 receiver,不再只在 phase hold 期间开;Bridge 重启后由 FLY-2211 reown 的 `watch` 分支重新武装(`reown_watch_started` → arm)。
- 信到即落 durable(`runner_phase_wakes`,新增 `admission_state='deferred_midturn'`);turn 进行中若 app-server 支持 in-turn 注入则立即注入(研究项),否则在下一 boundary 注入——但**完成许可要先清信**:`session_completed` 处理时若该 execution 仍有未消费交接(mailbox QUEUED/LEASED 或 phase wake pending),回 `disposition=consume_pending_mail`,注入后再终结(有界:一次)。第 7 起从此不可能。
- goal 达成后的常驻:节点在模板里**有入向 loop 边**(任何 DAG loop,不看节点名)时,终态分类为 `held-resident`,保留 `residentGraceMs`;返工 `wake` 在窗口内原地再派,窗口外或独立死检为死才换体。Codex 走 `classifyTerminalStatus`→held;Claude 走 `complete` 的新 disposition `loop_park`(同 `runner_ship_park` 机制,CLI 停在 prompt、自带 poller 活着)。
- receiver 自写心跳,supervisor 用 FLY-2216 的纯分类器 + episode 判 `receiver_stalled` 并进程内重武装;两次失败才告警。
- FLY-2107 槽位:slot 满不再静默——它就是信箱家族 `sent` 阶段的一种 stall 原因(`inflight_slots_exhausted`),由 4.1 升级。

**对诊断页「体外常驻收信员」的偏离**:founder 原话是「体外」。我建议的形态是 Bridge 内 supervisor + 重启后 reown 重武装,理由:(1)真正的单点是 app-server socket,而 socket 死 = daemon 死,FLY-2211 已给同 thread 复活 + kick 重发;(2)独立 OS 进程需要新的 carrier(plist/wrapper/converge 闭包),FLY-2216 证明这套闭包很重;(3)收信员用的是文件 watch,不依赖 socket。此点已作为非阻塞问题问 Lead,若 founder 坚持体外形态,4.2 的接口不变、只换宿主。

### 4.3 转移层 —— 判死先问送达;核销不看旧欠条

- 引入 `DeliveryEvidence{stage, receivedAt, consumedAt}` 作为 `classifyPhaseActorReentry`、stall clock、zombie 判定的必备输入。规则:`replace`/`actor_unreachable` 只能由独立死证据(`dead_pin`/host absent/socket+rollout 双死)触发;当合同阶段 < `received`,任何「没动静」都判 `delivery_unconfirmed` → 走 4.1 升级,永不判死、永不 hold。
- `actor_alive_after_receipt` 改名为 `alive_not_consuming` 并拥有自己的期限(received→consumed 超期即升级),终结 generation=209 这种静默自旋。
- 交货核销解耦:节点完成/land 许可只看 head + 验证声明(`workflow_node_completion` + qa claims),把仍开着的、指向该 node/attempt 的欠条一律推到新终态 `superseded_by_completion`(带事件),不再等它走完 `wake_delivered`。
- hold 理由词汇分离:冻结理由必须是 `actor_dead:*` / `delivery_unconfirmed:*` / `policy:*` 三族之一,禁止再把 `delivery_<state>` 直接当理由。

### 4.4 冻结形状正门 —— 注册表 + 一扇门

- 建 `HoldShapeRegistry`:每种形状 = {id, 检测(如何列出实例), 前置条件, resume 动作(复用现有函数或补齐), 审计事件}。首批覆盖 §2.5 全部 14 个 run 级形状 + 欠条级(`needs_lead`、`held:persisted_target_missing`、`held:replacement_launch_rolled_back`、`held:delivery_awaiting_receipt`)+ carrier `held:run_inactive`/`needs_lead` + land held(含无 operationId 的三种)+ 信箱 slot 耗尽 + 三段 TURN 卡住。
- 一扇门:`GET /api/runs/:runId/holds`(列出当前形状与可用动作)+ `POST /api/runs/:runId/resume {shape, holdEventUid, decision, reason}`,内部按形状分派;附录 A(receipt 死结)与附录 B(换体漏账)从 SQL 配方变成事务函数。CLI `flywheel-comm hold list|resume` 给 Lead 用(master token + loopback,沿用 carrier-redrive 的 stage/apply + confirmToken 模式)。
- 守卫:golden 清单测试——所有写 `status='held'` 的点必须在注册表里有形状(同 FLY-2211 kill-path inventory 的做法);runbook 的 SQL 段替换为端点调用。

## 5. 通用性如何被强制

- 新模块(contract sources / watch / supervisor / registry)以对象类型(表、adapter、模板边)为键,不含节点名;静态测试 grep 新模块源码断言不含 `qa`/`implement` 字面量(允许出现在测试 fixture 的模板里)。
- 「有 loop 的边」由 `workflow_template` 的边定义推导(`loop` 类型边的目标节点),不由节点名推导。
- 8 起回放测试的 fixture 至少覆盖三种不同的边:founder_gate→general(第 6 起)、land→cleanup(第 2 起)、qa→implement(第 4/7/8 起),以证明同一机制对不同边同样触发。

## 6. 假设与待裁定(非阻塞,已用 ask 送 Lead)

1. **宿主形态**:收信员做成 Bridge 内 supervisor(+reown 重武装)而非独立 OS 进程,是否可接受(见 4.2 末段)。
2. **期限默认值**:minted→granted 10 分钟、granted→sent 5 分钟、sent→received 15 分钟、received→consumed 30 分钟;全部为 feature flag/env 可调。
3. **常驻宽限**:goal 达成后 `residentGraceMs` 默认 30 分钟;Claude 工人是否也在 loop 边界 park(代价:每个 park 的工人占一个活 pane)。
4. **正门权限**:resume 端点沿用 master token + loopback + confirmToken(与 carrier-redrive 一致),不引入新的 duty token。

## 7. 非目标

- 不改 codex 官方二进制;不做 app-server in-turn 注入的上游改动(仅调研其能力)。
- 不重设计 mailbox 的关系/新鲜度模型(memory:FLY-1792 founder 已否决逐条撤回;那是另一张单)。
- 不修改 FLY-2211 reown 判据本身,只在其 `watch` 分支挂钩收信员重武装。
- 不给 Lead↔Lead 信件(非 DAG 边)加合同;只覆盖 execution 绑定的交接。
- 不在本单点名 09-01 的每一个具体 bug 的一次性修法——合同层通过后,家族内的个别 bug 由回放测试逼出。
