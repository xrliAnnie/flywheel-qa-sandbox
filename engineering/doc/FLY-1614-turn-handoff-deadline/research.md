# FLY-1614 节点交接无死线无自播报 — 调研

Issue: FLY-1614 (https://linear.app/geoforge3d/issue/FLY-1614/巡检场景1-节点完成下一棒交接无死线无自播报-turn-beltfounder-gate-停滞只能靠-lead-查表发现今晚-3)
日期: 2026-08-11
基于: exploration.md

本文回答 exploration.md §7 的四个假设(H1-H4),给出 plan.md 需要的全部代码级事实。行号基于本分支 HEAD(`d6536134`,含 FLY-1655 #795 / FLY-1648 #788 / FLY-1638 #779)。审计方法:两路独立全仓扫描(引擎侧 + 唤醒侧)+ 关键 seam 逐行复核。

## 1. grantTurn 全调用点审计(H1 核心证据)

`CommDB.grantTurn`(`packages/flywheel-comm/src/db.ts:4410`)是**纯 DB 写**,零唤醒义务、零事件推送。两种形态:
- **sourced grant**(带 source,4431-4616):一个事务写 4 张表(belt upsert epoch+1 / `runner_workflow_activation`(仅当带 activation)/ `turn_source_history` / `workflow_source_event` kind=turn_grant),replay 幂等(payload mismatch = poison)。
- **bare grant**(无 source,4617-4642):只写 belt 5 列,显式 NULL 掉 target/activation 列——手工/legacy 形态,**无 source event ⇒ 引擎侧永远不会投影出 `turn_granted` 事件**。

生产调用点全表:

| # | 调用点 | 形态 | grant 后是否唤醒 | activation |
|---|---|---|---|---|
| 1 | `run-dispatcher.ts:1514`(spawn 预启动 seam) | sourced,`turn:spawn:<exec>`;仅 engineOwned 时带 targetRunId | N/A(runner 正被 spawn) | ❌ 无 |
| 2 | `run-dispatcher.ts:877`(phase retry 预启动) | 同上 | N/A | ❌ 无 |
| 3 | `phase-orchestrator.ts:1620`(QA FAIL→fix,legacy) | 经 `plugin.ts:8668`:sourced 但**无 targetRunId 无 activation** | ✅ `wakePhaseRunner`(:1627) | ❌ 无 |
| 4 | `phase-orchestrator.ts:1947`(阶段交接,legacy) | 同上 | ✅ `wakePhaseRunner`(:1954) | ❌ 无 |
| 5 | `phase-orchestrator.ts:2317`(belt 巡检 stale 恢复) | 同上 | ❌ **只发 Lead 告警,不唤醒新持有者** | ❌ 无 |
| 6 | `workflow-rework-coordinator.ts:494`(引擎 rework 交棒) | 经 `plugin.ts:8818`:sourced **全套 activation+凭据** | ✅ `wakeActor`(:548) | ✅ 唯一 |

三个结构事实:
- `run-dispatcher.ts:1521-1523` 注释写明「grant→wake 成对」是既有设计意图;**site 5 是现存违例**(告警原文「can now re-acquire the worktree turn」——依赖「parked 阶段还在轮询」这个已被证伪的假设)。
- **site 6 是全系统唯一在 grant 时铸 activation 的路径**。site 3/4/5 的 grant 对 engine-owned run 会造出「有棒无激活」状态(`FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1` 下终态提交必 409)——与手工交棒副作用 #4 同一形态,**引擎自己的 legacy 路径也会踩**(缓解:`onQaResult` 对 engine-owned 早退 :1196,故 site 3/4 目前只对 legacy run 生效)。
- StateStore 投影器(`StateStore.ts:29596-29659`)只对带 targetRunId 的 source event 发 `turn_granted` run 事件;bare/8668 形态**零引擎事件**。

**H1 判定(成立,但要修正措辞)**:不是「没有原子链」——site 6 的链已完整且有 FLY-1648 退避;而是**三种后继形态(fresh spawn / rework wake / gate exit)各自为政,无共享后置条件,且没有任何组件做「节点账本推进 ⇒ 棒已到位」的跨账本校验**。

## 2. 三个 Dead End:verdict 消费 → 交棒之间的断点逐行证实

**Dead End #1 — 引擎 lane 的 /decision 只写 claim 不推进**(`workflow-decision-routes.ts:404-504`):engine lane 提交 decision claim 后 `return`(:503),不调 `onQaResult`、不调 `commitWorkflowTransitionTx`。DAG 推进发生在 QA runner **另行调 `complete`** 时(`event-route.ts:892 → commitEnrolledCompletion → commitWorkflowTransitionTx`)。⇒ 「裁决落库」与「账本推进」之间就已有一段依赖 runner 行为的空窗。

**Dead End #2 — legacy 编排器 PASS 分支显式 no-op**(`phase-orchestrator.ts:1330-1343`):PASS 只 log + shadow + 刷状态行,**无 grantTurn、无 wake、无 dispatch**;对照 FAIL 分支(1620-1668)有完整 grant→wake。TURN 钉在 QA 上;而 `reconcileOneTurn` 对 completed-QA holder 显式 return(`:2283-2285`,即 issue 引的 2282)。implement ship 需要 `turn=yours` ⇒ **结构性死锁**(1603/1605 形态)。

**Dead End #3 — `runner_ship_approved` 事件零消费者**(`StateStore.ts:30097-30106`):founder 批准时按 `authority_mode` 分支——`land` → 正常 transition + dispatch(✅);`engine_terminal` → run completed(✅);**`runner_ship` → 只 append 一条 `runner_ship_approved` 事件,全仓 grep 该 kind 仅出现在写入处,零读者**。carrier 的唤醒走的是另一条通道(`write-gate-response.ts:277 runHook` → awaiting_review→approved_to_ship 翻转 + mailbox wake),但 **TURN 仍在 QA 手上,没有任何东西把它交给 implement carrier**。⇒ issue 主诉「engine 在 runner_ship_approved 时原子交带给 implement」缺失的精确位置。

FLY-1655(#795,已在本分支)把有 PR 的 schema-v2 DAG 收敛为 `land`(authority_mode=land 走 ✅ 分支)⇒ **新 run 不再踩 Dead End #3**;但 frozen/custom `runner_ship` 兼容边界仍在(FLY-1655 明文保留),legacy 三阶段管线仍走 Dead End #2。plan 必须对这两个残余面分别表态。

## 3. 引擎账本推进与皮带的关系(founder 追问的机制学答案)

`commitWorkflowTransitionTx`(`StateStore.ts:27852`)单事务完成:源节点 done(28338)+ `node_completed`(28346)+ **`workflow_run.current_node_id := target`(28798)** + 按 target 类型分支(gate 28585 / rework 28464 / normal 28685 铸 dispatch intent)。**该事务不含任何 TURN 语义**——belt 在另一个库(comm.db)、由另一个组件、稍后、尽力而为地写。这就是「引擎自认无事」的机制学根源:它的账本推进从不以「棒已交」为后置条件。

**engine-owned TURN 被排除在唯一的 stale 巡检之外且无替代**:`reconcileTurnBelt` 三处跳过 engine-owned(:2204/:2217/:2239);引擎侧没有等价的 `reconcileOneTurn`。engine-owned 判定 = exec 的 activation binding 指向 `workflow_run.engine_owned=1`(`StateStore.ts:22149`)。

## 4. Wake 通道机械与附观察 2 的完整解释

- `flywheel-comm send`(`send.ts:18-37`)= mailbox 入列(72h 过期)+ **`clearDeclaredState`(un-park)**——Lead 救活 runner 的原理。
- Bridge `RunnerMailboxLane.tick()`(`runner-mailbox-lane.ts:208-341`):claim → 按 transport 投递(claude-code/codex;`none` → no_transport)→ 指数退避(5s 起 10min 封顶 6 次)→ 死信。
- `sendRunnerWake`(`runner-wake.ts:107-270`):kind 只有 `approval_wake|feedback_wake`——**没有 turn_wake**;receipt-wake 分支(:166-207)带 `runner_phase_wakes` claim/complete 收据台账(t1=90s),注释「Never bypass the ledger with a raw wake」。
- rework 链的 `wake_delivered`(coordinator :562-575)只证明**信箱写成功**;`runner_phase_wakes` 消费收据只覆盖 receipt-wake 分支,不覆盖 `wakePhaseRunner`/`wakeActor`。

**附观察 2 机制**:grant 纯写库(§1)+ runner 靠轮询 + runner 判 blocked 停轮询 ⇒ 除非有人 send,永远看不到皮带翻页。wake 与 belt 是两条独立通道,今天只在 site 3/4/6 成对。

## 5. Runner 侧「not-yours → blocked 停轮询」的 prompt 根源(H3)

全仓审计:`"not-yours"` 只存在于实现与测试,**从未出现在任何 runner-facing prompt 里**。Blueprint TURN 法则只有允许条件(「proceed ONLY on `yours`」,`Blueprint.ts:1915/1928/2431/1614-1615`),从未定义 not-yours 分支。唯一的「等待不判 blocked」法则 `CODEX GATE WAIT LAW`(`Blueprint.ts:2174-2183`)是 Codex-only + gate-scoped,且其「persistent command failure may justify blocked」一句**在字面上授权了事故行为**(反复 not-yours ≈ persistent failure)。`agents/generic-executor.md:81`「idle wait would hang forever」进一步推向「等待危险」。⇒ 事故行为 prompt-合规,这是合同缺陷不是 runner 违纪。**两条腿都要修**:grant 必带 wake(推)+ 全 vendor TURN WAIT LAW(拉的兜底)。

## 6. 现有死线/巡检机器盘点(为什么今天「零事件」)

| 机制 | 位置 | 阈值 | 为什么盖不住本单 |
|---|---|---|---|
| `TURN_GRANT_GRACE_MS` | `phase-orchestrator.ts:203` | 5min | **反向死线**——抑制动作(in-flight spawn 不当 remnant),不检测停滞 |
| belt stale 巡检 | `:2198/2251` | 事件驱动+boot | 跳过 engine-owned;跳过 completed-QA;site 5 恢复后不唤醒 |
| unlaunched tripwire | `workflow-engine-dispatcher.ts:1302` | 5/10min | **只看 `admitted`**(:1343);卡在 `pending` 的节点不可见 |
| rework stall 告警 | `:1051` | 30/60min | 只看 delivery 行;跳过 hold_count>0;30min ≫ 实测 9-29min 停滞 |
| rework 退避 | FLY-1648,`settleWorkflowReworkFailure` | 1/2/4/8min→needs_lead | 只在投递**主动失败**时计时;「从未尝试」无时钟 |
| stale approved-ship 重唤 | `stale-approved-ship-reconciler.ts:27` | 5min | 只重唤已翻转 approved_to_ship 的 session;**不交棒**;翻转没发生就不启动 |

`granted_at` 的全部消费者(6 处)全是 grace/年龄过滤/replay 相等性——**没有任何一处把 granted_at 与死线比较来检测停滞交接,也没有任何一处做反向检查「账本推进了而皮带没动」**。

## 7. 附观察 1(activation 投给已 done 的 attempt)现状

已有门:rework coordinator target 必须 `pending|admitted`(:330-340,`rework_target_not_reserved`);admission 侧 `StateStore.ts:22409` + `workflowAdmissionReservationBlocker`(22155-22190);dispatcher 对 done 节点 preserveTerminalNode(:1987-1992)。**缺门处:legacy 编排器 wake 位点**(:1620/:1947)只看 session 状态 + tmux 存活,**不查 `workflow_run_node.state`**;且其 grant 无 activation ⇒ 被唤醒的 runner 有棒无凭据,409 是最后一道防线(在 runner 已烧 15-30min 之后才触发)。三个 409 `replay_payload_mismatch` 产生点:`StateStore.ts:25129/27391/29326`。

## 8. Layer 2 落点验证(turn 命令内嵌等待检测)

- `turn` CLI(`index.ts:1124-1163`)已**读写** comm.db(`ackRunnerReceiptWakesStarted` 是写)⇒ 记等待账零新依赖。
- comm.db `sessions.lead_id`(`db.ts:38`)⇒ 自动 ask 的收件 Lead 从 runner 自己的 session 行解析,**零 env/prompt 改动**。
- `ask`(`ask.ts:32`)= `insertQuestion`,GatePoller ≤1 tick(~3s)转 `runner_question` 给 Lead——通道现成。
- 等待标记:founder 评论草案「标记文件放 runner-state 目录」;本研究推荐 **comm.db 小表**(去重用 UNIQUE 表达、Lead 取证直接 SELECT、无文件生命周期),plan 作为决策点呈现。
- 阈值一处配置:默认 20min + 单一 env override。

## 9. 自校验(founder 硬验收)实现定位

- 先例:GatePoller tick piggyback(`gate-poller.ts:547/604/641`,FLY-208/513/907)——零新 timer。
- 内容:active `workflow_run`(+ legacy in-flight issue)推导「当前应持棒者」,与 `three_stage_turn` holder 对账;不一致持续超有限窗(如 5min)→ fail-loud Lead 告警(带两本账逐字段证据)。
- 定性:founder 撤回的是「以死线驱动交接」;此处是 founder 追问后**明确要求**的「引擎自己校验『我到底交出去没有』」——校验对象是引擎自己动作的完成度,不是 runner 进度,不是中央 watchdog 追人。

## 10. 事故 vs HEAD 差距判定(诚实边界)

当晚 7 例发生在落后于 HEAD 的生产 build 上(FLY-1655 记录生产曾跑 pre-#779)。本研究不逐例断言 HEAD 复现性;能断言的是以下六条在 **HEAD 逐行仍真**,构成修复面:
1. site 5 grant 不唤醒;
2. legacy PASS 分支 no-op + completed-QA 排除 ⇒ legacy PASS→ship 死锁;
3. `runner_ship_approved` 零消费者(frozen/custom runner_ship 兼容面仍可踩);
4. prompt 无 not-yours 法则,GATE WAIT LAW 反向授权判 blocked;
5. 跨账本零校验、grant/wake 无消费收据(wake_delivered ≠ 消费);
6. legacy wake 位点无 attempt 终态门 + 无 activation。

## 11. 结论 → plan 输入

1. **Layer 1(根因)**:(a) 「grant→wake 成对 + 消费收据」收敛为共享后置条件(补 site 5;wake 台账扩展到 wakePhaseRunner/wakeActor);(b) 跨账本自校验 piggyback GatePoller,fail-loud;(c) runner_ship 兼容面的批准→交棒断链补上(或显式判死并 fail-loud);(d) legacy PASS→ship 死锁处置;(e) legacy wake 位点补 attempt 终态门。
2. **Layer 2(检测)**:turn 命令内嵌等待记账 + 超阈值自动 ask(comm.db 表 / session.lead_id / UNIQUE 去重 / 20min 默认单点配置)。
3. **Layer 3(担架)**:Lead 手动交棒正式化 = 走引擎正规通路的 re-drive 入口(复用 rework coordinator 机械);SQL 手术降级为 Bridge 挂死时最后手段,附 5 副作用清单 + 成对「写库+send」纪律。
4. **Prompt**:全 vendor TURN WAIT LAW(not-yours 永不 blocked、继续轮询、命令会替你上报)。
