# FLY-1765 implement↔QA 返工环修复 — 实施计划

Issue: FLY-1765 (https://linear.app/geoforge3d/issue/FLY-1765/implementqa-返工环断裂qa-fail-后原-implement-体已-completed-不可复活state-not)
日期: 2026-08-14
基于: research.md
版本: v5(折入 Codex design review R1-R3 + QA FAIL claim 191 的 implement-only park 边界)

## 0. 一句话

FLY-1655 之后 implement 节点体完工即被投影成 `completed` 终态,QA-FAIL 返工的 wake 闸(FLY-939 只唤停驻体)从此 100% 拒绝 —— 本计划两层修:**Fix 1 恢复账面停驻**(land-authority run 的 `type=implement` 节点体完工投 `ship_parked` 直到 ship finalization,wake 闸零改动),**Fix 2 终态残局受控收体**(先按既有安全链把活体收干净,让死亡证据自然成立后走既有 proven-dead replacement;绝不伪造死亡账,绝不首跳 needs_lead)。不加新 flag,不开终态复活边。

## 1. 目标 / 非目标

**目标**
- QA FAIL 后返工自动送回原 implement 体,无人工介入,run 不 held/needs_lead(体活着的一切情形)。
- 体不可用(被清/crash)或部署窗遗留终态时,自动收敛到既有 proven-dead replacement(FLY-1718 reconcile 续接分支/PR),不挂死。
- QA 一把过路径回归不破(阴性对照)。

**非目标**
- 不开 `completed→running` FSM 复活边(终态免疫族 FLY-1228/1731/1462-revert 保持)。
- 不改 codex daemon 运行时 —— 驻留能力已由 FLY-1269 resident controller 实现(见 §6 R1),本单只做定向回归验证;若真机与源码契约不符,停发另立最小 delta 单独评审。
- 不改 FLY-1731 completion_disposition 语义(受影响完工的 receipt 维持现状 `terminal_no_gate`)。
- 不批量复活存量挂死 run;不动 FLY-1612 告警 episode 形态;runner_ship legacy 路径字节不变。

## 2. Fix 1 — 账面停驻:land-authority run 的 implement 节点体完工投 `ship_parked`

### 2.1 投影改动(唯一状态写点)

`packages/teamlead/src/StateStore.ts` `projectGeneralizedCompletionTx`(`:26556-26640`):

```
projectedStatus =
  route === "no_code"                          → "completed"                     (不变)
  runner_ship carrier                          → awaiting_review | ship_parked   (不变,legacy 字节兼容)
  【新】run.engine_owned===1 && run.gate_carrier_epoch===1
      && gateAuthority?.mode === "land"
      && node.type === "implement"
      && node.capabilities.creates_pr === true
      && route === "needs_review"              → "ship_parked"
                                                 + park_opened(reason: "rework_reachable_wait")
  else                                         → "completed"                     (design/qa/engine_terminal 不变)
```

判据修正说明(R1-1):`resolveWorkflowGateAuthority` 对 terminal-land manifest **先行返回 `mode:"land"`**(`workflow-run-snapshot.ts:173-175`),生产 compiled menu 全部断言 authority=`land`(`workflow-menu.test.ts:293-305`)—— 所以命中键是 `mode==="land"`,不是不可达的 `engine_terminal`(后者=零 ship-capable 节点,无 PR 无返工目标,维持 completed)。completion_disposition receipt **维持 `terminal_no_gate`**(`StateStore.ts:28299-28316` 现状;现测 `StateStore.workflow-engine-transition.test.ts:469-518` 即 `ship_parked` + `terminal_no_gate` 的既有组合,不改 FLY-1731 语义)。

- park 台账沿用 `appendWorkflowEngineParkEventTx`,事件词汇表仅 `park_opened | park_cleared`(`StateStore.ts:4160-4172`)—— 全文不使用不存在的 "park_closed"。新 reason 值 `rework_reachable_wait`,activation 级绑定与 `runner_ship_gate_wait` 同形。
- 不写 `applyTerminalTimestamp`、不 bump lifecycle(非终态)。
- 范围收窄:`type=implement && creates_pr` 节点(QA-FAIL 的原体返工目标)。`generic` 虽同样带 `creates_pr`,但单阶段 land completion 会立即打开 founder gate、runner 同时收到退出指令,不存在 QA 循环,所以必须维持 `completed`;design(`phase_design_complete`)/qa(`no_code`)同样不动。
- **有意取舍(generic founder rework):** generic 单阶段 run 若在 founder gate 后触发返工,原 generic 体已终态,不承诺 FLY-939 原体 wake;它明确走 Fix 2 的受控收体 → proven-dead replacement/reconcile 降级路径。该路径保 run 不挂死并续接分支/PR,代价是换体而非原体返工。测试分别钉死 ①generic land completion=`completed` 且无 `rework_reachable_wait` park;②真实 `tpl_code` implement=`ship_parked`,QA PASS 后 founder gate 仍由 authoritative QA holder 真投递。
- **FLY-1731 gate-authority sentinel(R1-1 新增)**:land-mode 下 `ship_parked` 的 implement 体在 founder gate 前后都**不得**被选为 gate holder、不得 present/consume approval、不得取得 carrier authority —— authority 恒由 pinned land/gate 决定。专项测试断言 ship-gate admission(FLY-1731 immutable holder authority)对 `rework_reachable_wait` park 零匹配。

### 2.2 park 结算(账面与物理分两层,各自可重放 — R1-3/R1-4)

**正常路径(land 完工 → ship finalization)— 复用既有回收链,不新造:**
post-ship finalizer 的 `RECLAIMABLE_PHASE_STATUSES ⊇ FINALIZE_DONE_SOURCE_STATES ∋ ship_parked`(`post-ship-finalization.ts:432-487`、`close-runner.ts:76-87`),经 `closeRunner({finalizeDone:true})` 走 FSM `ship_parked→completed` + 拆体,幂等。实施时**验证**generalized land 完工确实触发该 finalizer 对 implement 停驻体生效(含 `getPhaseSessionsForIssue` 的 `chat_thread_role` 过滤对 generalized 会话的适配);有 gap 则在 land 完工链接线,而非另造回收器。

**账面结算 helper(事务内;「状态结算」与「park 台账结算」拆开但同一 StateStore 事务 — R2-1):**
新增 transaction-local `settleReworkParksForRunTx(runId, cause)`,按 run/execution/node/attempt/activation + 最新 open generation 做 CAS,双腿:
- session 仍 `ship_parked` → 投 `completed` + `applyTerminalTimestamp` + bump `lifecycle_revision`(对齐 `:26628-26643`)+ deterministic `park_cleared`;
- session 已被既有 finalizer 合法投成不可逆终态(至少 `completed`)→ **不重写**状态/时间戳/revision,但仍对同一 exact activation 追加 deterministic `park_cleared`(**ledger-only clear**)—— 这是 land 生产顺序的必经腿:dispatcher 先 `await landExecutor`(其 `deps.finalize` 走 `runResumablePostShipFinalization` → `finalizeWorkflowPhaseRoles` → `closeRunner({finalizeDone:true})` 先把 `ship_parked` 投成 `completed`,`land-executor.ts:431-475`、`post-ship-finalization.ts:721-738`),之后才 `completeWorkflowLandNode`(`workflow-engine-dispatcher.ts:2039-2092`)运行 helper;若只认 `ship_parked` 则 open park 永久残留,`getCurrentWorkflowEngineParkEvidence`(`StateStore.ts:12223-12252`)不查 session status,会继续供出 park veto/wake evidence;
- activation/identity 已变、session 处 active 非停驻态、或 reason 非 `rework_reachable_wait` → fail-closed/no-op;重放零副作用;**不得**匹配 `runner_ship_gate_wait`。

**`park_cleared` 幂等键(R3-1)** —— `appendWorkflowEngineParkEventTx` 对相同 `event_id` 直接返回旧行、不核对 payload(`StateStore.ts:12136-12152`),而 admission 已为同一 activation 写过 `engine-park-clear:${activationId}`(`:23608-23618`);真实序列 `admission clear(A) → completion open(A) → settlement clear(A)` 下,若结算键只含 activationId 会静默命中第一步旧 clear,open 仍是最新 generation,CommDB/evidence 永不清。故 canonical identity 钉为**被结算的 open row/generation**:`engine-park-settle:<executionId>:<openGeneration>`;同一 open 不因 `cause` 不同产生多个 clear;完整结算腿、ledger-only 腿、replacement 同事务 supersession 三处共用同一规则;若该 ID 已存在,校验其 run/execution/node/attempt/activation/openGeneration/reason 全 tuple 一致,不一致 fail-closed(不得当幂等成功)。

**run 终态 writer matrix(R1-3;逐一定策,不再笼统「全部路径」):**

| writer(StateStore.ts) | 接线 |
|---|---|
| land completion(`:39158-39189`) | 既有 post-ship finalizer 负责物理+账面回收;helper 兜底幂等调用 |
| operator terminate(`:24481-24701`) | 接 helper(判终 run 时账面结算;物理拆体走 Lead/close 既有链) |
| founder/source-terminal 两分支(`:31982-32013`、`:32097-32123`) | 接 helper |
| no-code completion 终态分支(`:28895-28924`) | 接 helper(该 run 若曾有 parked 体) |
| legacy ledger finalize(`:34328-34334`) | 接 helper |
| runner-ship completion(`:37942-37969`) | 阴性:只涉 `runner_ship_gate_wait`,helper 按 reason 隔离零触碰 |
| shadow terminate,engine_owned=0(`:18578`) | **明确排除**(非 engine run,不产生本 park) |

**replacement 取代(崩溃窗闭合,R1-4):** 旧体 park 的清算并入 `materializeWorkflowReworkReplacement` 的**同一 StateStore 事务**(幂等:重放时 park 已清则跳过),不做 dispatcher 返回后的后置 hook —— 杜绝「replacement 已提交、hook 前 crash → park 永久遗留」。

**物理回收边界(R1-4):** `runner_shutdown_controls` 在 CommDB、`closeRunner` 是异步跨库链(`land-cleanup-opportunity.ts:12-60`)—— 本计划**不**声称 StateStore 事务能原子提交进程关闭;物理回收一律走上述既有可重放链,失败走既有 retry/告警。

### 2.3 wake 路径(零改动,自动复活)

`activateHolderForWake` 可复活集合本就含 `ship_parked`;`ship_parked→running` 转移既存。返工完成后 attempt N+1 的完工再次走 §2.1 投影 → 再次停驻。环闭合。

## 3. Fix 2 — 终态残局:受控收体 → 让死亡证据自然成立(R1-2 重设计)

**原方案作废**(直跳 `replacement_pending` 会把刚被 liveness probe 证明存活的 actor 塞进要求 proven-dead 的 `materializeWorkflowReworkReplacement`,伪造 `execution_dead_rolled_back` / `livenessEvidence:{liveness:"dead"}` 死亡账,`StateStore.ts:21691-21711`、`:21933-21973` —— 违反 FLY-1462/FLY-939 单写者与终态免疫边界)。

**新方案 — controlled supersession(每一步复用既有安全链;mutation-time fence 见 R2-2):**

`workflow-rework-coordinator.ts:394-417` 的 `holder_activation_failed:state_not_revivable:<不可逆终态>` 分支改为:

1. 对该体发起**既有** `closeRunner` 受控关闭(executorType phase,reason 记 `rework_supersession:<requestId>`;completed 体属 `RECLAIMABLE_PHASE_STATUSES`,closeRunner 幂等拆 tmux),**必须**传 `authorityCheck`(见下),不允许裸调;
2. 无论 close 成败,`releaseRetryable(reason)` —— **不带 `terminal`**,delivery 留在既有 1m/2m/4m/8m 退避梯(`settleWorkflowReworkFailure` 的非终分支);stale owner 的 release 失败即放手,由新 owner 收敛,不写一次错误 hold;
3. 下一轮 reconcile:probe 见体已死/缺席 → `classifyPhaseActorReentry` 自然判 `replace`(`persisted_target_dead` 或 `terminal_actor_target_and_host_absent`)→ **既有** proven-dead materialize + FLY-1718 reconcile 起新体续接分支/PR。死亡证据来自真实 durable liveness,每轮从头重算,Bridge crash 后重放自然收敛;
4. close 反复失败 → holdCount≥5 → 既有 needs_lead + Lead 告警(诚实死路,非静默)。

**mutation-time authority fence(R2-2)** —— claim 默认 lease 只有 30s(`workflow-rework-coordinator.ts:213-235`、`:285-291`),而 resident codex phase shutdown 的 ack timeout 本身就是 30s(`codex-phase-shutdown.ts:23-25`),「在 claim 内」这句叙述撑不住慢关闭;fence 落成代码:
- effects seam 接收稳定五元组 `{requestId, ownerId, generation, routeRevision, executionId}`;
- `closeRunner.authorityCheck`(`close-runner.ts:140-148`,在 phase-shutdown 前后 / MCP reap / tmux kill 各慢边界处 fail-closed 重查)接 fresh StateStore predicate:delivery 仍属本 owner/generation、状态允许、route revision 未变、route/target 仍绑定该 exact actor、run 仍 active;
- lease 策略采用 **fencing-token 语义**:predicate 不看墙钟 lease 是否过期,只看「generation 仍是最新且 owner 未被接管」——takeover(新 claim 抢走 delivery)会 bump generation,使旧 callback 在下一个检查点立即失败;慢关闭期间 lease 自然到期不中断本次 close,但任何权威转移都会中断。不引入新 watcher/state machine,复用 closeRunner 既有检查点。

不变:`approved_to_ship` 不在不可逆集合(仍走 retry×5);瞬时 activation 错误 retry 路径不动;`settleWorkflowReworkFailure` 的 `terminal` 入参保留给其它 caller,本分支不再使用。

Fix 2 同时是**部署窗迁移方案**:上线时已在飞的 run(implement 体已按旧码投 completed)首次 QA FAIL 自动走受控收体→replacement,不挂死。

## 4. 改动清单(预估)

| 文件 | 改动 |
|---|---|
| `StateStore.ts` `projectGeneralizedCompletionTx` | §2.1 land-authority 停驻分支 + park_opened |
| `StateStore.ts` 新 `settleReworkParksForRunTx` + §2.2 matrix 接线 + materialize 事务内清 park | §2.2 |
| `workflow-rework-coordinator.ts` | §3 terminal 分支改受控收体 + 非终 retry + fence 五元组传递 |
| `bridge/plugin.ts`(coordinator effects 注入 close 能力,`closeRunner.authorityCheck` 接 fresh StateStore predicate) | §3 |
| 测试(§5,1-14) | 新增/扩展 |

无 schema 迁移;无新 env/flag;纯 Bridge 侧 → 单次 Bridge 重启部署,不动 Lead/Runner。

## 5. 测试(TDD,先红后绿)

**StateStore 单测**
1. **真实 compiled `tpl_code` snapshot**(非 synthetic fixture,R1-1)implement 完工 → `ship_parked` + park_opened(`rework_reachable_wait`)+ 无 terminal_at + disposition 仍 `terminal_no_gate`;QA PASS 后经真实 `QuestionAdmission.revalidate` 断言 founder gate 真投递,且 implement 仍 parked。
2. **generic 单阶段阴性**:land-authority generic 节点 `needs_review` → source session=`completed`、无 `rework_reachable_wait` park、founder gate 仍真投递;qa(no_code)/design(phase_design_complete)/engine_terminal(零 ship-capable)同样维持 `completed`。generic founder rework 明确走 Fix 2 replacement 降级。
3. runner_ship carrier 路径逐字节回归(legacy sentinel)。
4. `settleReworkParksForRunTx` 双腿:①仍 `ship_parked` → completed + terminal_at + lifecycle bump + `park_cleared`;②**finalizer 已先投 completed → ledger-only `park_cleared`(不重写状态/时间戳/revision)**;重复调用零副作用;activation/identity 已变或 session 处 active 非停驻态时 fail-closed/no-op;`runner_ship_gate_wait` 零触碰(阴性);§2.2 matrix 各 writer 逐一覆盖(land/operator-terminate/founder-terminal/no-code/legacy-finalize + shadow-terminate 阴性)。
   **4b. 幂等键序列测试(R3-1)**:从真实序列出发 —— 先有 admission `engine-park-clear:<activationId>`,再 completion open,再 settlement → 断言新增一条 generation 高于 open 的 clear、CommDB projection=cleared、`getCurrentWorkflowEngineParkEvidence` 为空、重放不新增 event;attempt N+1 再 open/再 clear,证明每个 open generation 各自唯一;既存同 ID 但 tuple 不符 → fail-closed。
5. materialize 事务内清旧体 park(含重放幂等 + crash 窗:materialize 已提交后重放不遗留 park)。
6. **FLY-1731 sentinel**:parked implement 不被 ship-gate admission 选为 holder/carrier;approval present/consume 与它无交集。

**coordinator 单测**
7. activation 失败 `state_not_revivable:completed`(probe=alive)→ 发起受控 close(带 authorityCheck)+ releaseRetryable(非终);**绝不**写 dead rollback / 绝不直跳 replacement_pending;delivery 留退避梯。
8. close 后下一轮:probe dead → `replace` → materialize(全链 e2e mock);close 失败×5 → needs_lead(诚实耗尽)。
9. crash 窗:close 已发、状态迁移前 crash → 重放从 durable liveness 收敛(不双铸、不悬空)。
10. **authority fence(R2-2)**:owner/generation 被抢、route/target 改绑、run 判终时 predicate 拒绝;authority 分别在 pre-phase-shutdown、post-phase-shutdown、pre-kill 检查点丢失 → 不再执行后续破坏性动作;stale owner 的 release 失败交新 owner 收敛,不写错误 hold。
11. `state_not_revivable:approved_to_ship` → 仍 retry(阴性);瞬时错误 retry 不变(阴性)。
12. parked holder 全链 happy path:claim → reentry wake → activate(`ship_parked→running`)→ TURN → wake_delivered。

**跨层**
13. 逆兼容 sentinel:旧世界残留(completed implement 行 + active run + rework)→ §3 受控收体 → replacement(模拟部署窗)。
14. **land 生产顺序全链(R2-1)**:按真实顺序跑 `executeLandOperation/finalize → completeWorkflowLandNode`,终态同时断言:StateStore 该 activation 最新 park event=`park_cleared`、CommDB projection=cleared、`getCurrentWorkflowEngineParkEvidence` 为空、session `completed`。

## 6. 验收 = 活体演练(issue 硬要求;QA 节点真机执行)

**R1 已改性质(R1-5)**:codex 完工后驻留**已实现** —— Blueprint `phaseKeepAlive` 注入(`Blueprint.ts:1595-1621`)、`CodexPhaseLifecycleController`(`CodexTmuxAdapter.ts:515-540`)、goal loop 完工后进 durable phase hold(`codex-daemon-client.ts:790-846`)。演练是对 FLY-1269 既有 resident controller 的**定向回归**,不是探索未知;**任何 alive-but-nonconsuming 情形 = 演练 FAIL → 停止发布,另立经评审的最小 delta**,不在本单扩 scope,也不声称 Fix 2 会自动兜底(该情形的真实行为是 retry×5 → needs_lead)。

**正戏(全自动,无人工介入为 PASS 判据)**
1. 造真单(QA 沙箱)走 tpl_code:design → implement(codex)完工 → 断言 session=`ship_parked`、park_opened 落账、pane 活、goal 处 phase hold(paused)、watcher 活。
2. QA 故意 FAIL → 断言 rework 自动 `wake_delivered`;codex 体真消费稳定 wake id、TURN 授权应答 yours、同 thread 续跑、分支出新 commit。
3. implement attempt 2 完工 → 再次进 hold + 再停驻 → QA attempt 2 PASS → founder gate → land → ship finalization → 断言 park 清算(`park_cleared`)、session `completed`、体回收。

**阴性对照**:第二张单 QA 一把过 → 全程与今日行为一致(implement 停驻至 ship finalization 后回收;无残留 park、无多余告警)。

**Fix 2 演练**:第三张单 implement 完工后手工把 session 打成旧世界形态(或直接用部署前遗留 run)→ QA FAIL → 断言:受控收体 → 下轮 replace → 新体续接同分支/PR → 环走通;全程无首跳 needs_lead、无伪造死亡账(`execution_dead_rolled_back` 仅出现于体真死后)。

## 7. 风险与边界(诚实边界)

- **R1(改)**:codex 驻留契约已有源码证据(FLY-1269);风险降级为「真机与契约不符」→ 演练 FAIL 即停发,另立最小 delta。alive-but-nonconsuming 的系统行为 = retry×5 → needs_lead(诚实死路,有 Lead 告警),不假称自动兜底。
- **R2 容量**:体停驻到 ship finalization —— 1655 前数周生产常态回归;post-ship finalizer 保证回收;观察舰队 pane 数一个窗口。
- **R3 gate 权威隔离**:FLY-1731 sentinel 测试(§5-6)双向锁死;code review 重点核对项。
- **R4 显示/巡检**:`ship_parked` 既有状态,display/watchdog 人群兼容;巡检(FLY-1687)把停驻体列非终结 roster 属预期。
- **R5 存量台账**:不做批量手术;余量走 Lead 现成序列或部署后 Fix 2 自然接住。
- **R6 结算覆盖**:§2.2 writer matrix 是闭合清单;新增终态 writer 时必须接 helper —— 在 helper docstring 与测试 4 里钉住该约定。

## 8. 交付顺序

1. TDD:测试 1-14 先红 → Fix 1 → Fix 2 → 全绿;`pnpm lint` + `pnpm -r build` + 定向 `vitest`(全量按 host 负载纪律)。
2. Codex code review(`codex:rescue`)循环至 approved。
3. PR(base=main;docs 随分支);QA 节点真机 §6 演练(独立 QA,PASS 才 verdict)。
4. ship 后单次 Bridge 重启生效;观察窗:下一例真实 QA FAIL 的自动返工即生产验证。
