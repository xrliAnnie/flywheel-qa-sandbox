# FLY-1614 节点交接无死线无自播报 — 实施计划

Issue: FLY-1614 (https://linear.app/geoforge3d/issue/FLY-1614/巡检场景1-节点完成下一棒交接无死线无自播报-turn-beltfounder-gate-停滞只能靠-lead-查表发现今晚-3)
日期: 2026-08-11(R4,折入 Codex design review R1×10 + R2×7 + R3×2)
基于: research.md

## 0. 一句话

按 founder 三层裁定修交接:**引擎交棒收敛为「durable 意图 + 可重放协调器 + 棒/绑定/激活/唤醒/收据全束」并自校验两本账(第 1 层)**;**等棒 runner 经 `flywheel-comm turn` 命令机械化、事务幂等地超时上报(第 2 层)**;**Lead 手动交棒复用既有 guarded recovery 合同(第 3 层)**;外加全 vendor TURN WAIT LAW。

## 1. 设计原则(founder 裁定,不可违背)

1. 根因修复 = 「确保 Bridge 自己发得出去」;验收必须含**自校验**(engine 账本 vs belt 跨账本对账,不一致 fail-loud)。
2. 不建中央 watchdog、不加「以死线驱动交接」的引擎机器;第 2 层复用 runner 已有轮询循环。
3. 交棒必须是原子一整套:**棒 + 目标绑定 + 激活凭据 + 唤醒(+ 消费收据)**;不允许「棒到了但激活没到」中间态。durable 意图先落库,投递靠可重放协调器,不靠单次 hook(crash 任一边界后 Bridge 重启可续)。
4. 对已 done 的 attempt 不再投递 activation/wake(投递前 + 外发前双重校验,exact tuple)。
5. Runner 保持 generic:检测埋进全节点共用的 `turn` 命令。

## 2. 第 1 层 — 根因修复

### 2.1 runner_ship 批准 → carrier 交棒:durable 意图 + 专用协调器(堵 Dead End #3)

**为什么不能用 admission `wake` 模式对 gate 节点铸激活(R1 #1)**:`admitGeneralizedWorkflowExecution` 对 gate/无 dispatch 节点返回 `not_start_node`;绑回 implement 节点则撞「attempt 已 done + spawn binding 不可变 + current_node 倒退」三重墙。⇒ 引入**第一类 carrier 绑定形态**,不 overload 既有 admission:

- **durable 意图(与批准同事务)**:`applyWorkflowSourceEvent` 的 `runner_ship` 分支(`StateStore.ts:30097`)在 append `runner_ship_approved` 事件的**同一事务**里落 `workflow_carrier_delivery` 行:key = `(run_id, gate_node_id, gate_attempt, question_id, approved_head, source_execution_id)`,state=`pending`,携带确定性 `carrier_activation_id = carrier:<runId>:<gateNodeId>:<gateAttempt>:<questionId>`。不改 `current_node_id`、不 dispatch gate、不重开 implement attempt。
- **协调器 `WorkflowShipCarrierCoordinator`**(镜像 `WorkflowReworkCoordinator` 的机械):leased claim → carrier session 校验(status/liveness/worktree@approvedHead)→ CommDB **sourced grantTurn 一次性写全束**(belt + target(run/gate node/attempt)+ carrier 激活行,`sourceEventId = ship-turn:<questionId>:<approvedHead>`,replay 幂等)→ epoch projection(`recordWorkflowActivationTurn` 同款,carrier 专列)→ wake(带收据,§2.2)→ 状态机 `pending → grant_started → turn_granted → wake_delivered → receipt_started`;失败走 FLY-1648 同款退避(1/2/4/8min,第 5 次 `needs_lead` + 一次性 severe)。挂 `workflow-engine-dispatcher` 既有 1s reconcile 循环(boot/tick 扫描,重启可续)。
- **carrier 激活的消费合同**:`runner_workflow_activation` 行 node_id = gate node、attempt = gate attempt(与 grantTurn 的 `activation.nodeId === phase` 校验一致,belt phase 写 gate node id);`turn` 返回 `yours phase=<gateNode> activation=carrier:...`;ship 授权(verify-approval / merge 面)不变——carrier 激活只授权「触碰 worktree 执行 ship」,不授权任何节点终态提交(gate 无 submission credential,天然满足「不重开 done attempt」)。
- **carrier 专属 epoch projection(R2 #1)**:**不复用** `recordWorkflowActivationTurn`(其 FK 经 `workflow_execution_binding` 解析,carrier 绑定不在该表,调用必失败)。改为把 `turn_epoch / turn_source_event_id / turn_granted_at` 以 **owner/generation CAS、immutable-once-set** 写回 `workflow_carrier_delivery` 行,新方法 `recordWorkflowCarrierActivationTurn` 校验 exact (run, gate node, attempt, execution, question) tuple。
- `write-gate-response.ts` post-write hook 只做**nudge**(踢一次 coordinator reconcile),不承担恢复职责。

### 2.2 全束不变量推广 + 唤醒收据 + 终态门

**(a) spawn 预启动 grant 升级为全束(R1 #3)**:`GeneralizedExecutionDispatch` 把 activation 身份/context 透传到 `run-dispatcher.ts:877/1514`,两处 sourced grant 补 `activation`(与 launch 凭据同源),**grant 后显式调 `recordWorkflowActivationTurn` 投影 epoch**(R2 #1;spawn 的 grant→projection→launch-fence crash/replay 序列进测试矩阵);**spawn 的「唤醒」= 既有 launch fence**(进程被创建即视为通知,无需信箱)。legacy 非引擎三阶段行:不硬造激活——声明**窄兼容谓词**(自校验只查存在的字段),不把 bare grant 称作原子束。byte-compat 测试:schema-v2 `land`/generic-main 节点**永不**获得 TURN;frozen legacy run 行为不变。

**(b) TURN 唤醒收据 = 真正的投递 outbox(R1 #4 + R2 #2)**:
- 新 comm.db 表 `turn_wake_outbox`:key = 确定性 `wake_id`;列含 `(execution_id, epoch, activation_id NULLABLE, purpose, envelope_json+backend(或可重建的 durable source ref), state, push_count, first/last_push_at, last_push_result, claim_token/claim_expires_at, acked_at, cancel_reason, episode_id)`——重启后 GatePoller 能**重建信封与目标 backend**、能安全 claim、能知道首投是否成功;
- `wakeActor` / `wakePhaseRunner` / carrier coordinator 外发前登记行,wake effect 返回真实结果(不再依赖 `sendRunnerWake` 不抛的 telemetry 合同);
- **精确 ack**:engine wake 要求 `turnStatus` 的 epoch+activation 与行匹配才写 `acked_at`;**legacy wake(无 activation)按 exact holder+epoch+wake_id ack,不硬造激活**;本表不用旧 `ackRunnerReceiptWakesStarted` 粗粒度通道;
- **T1/T2 语义**:T1 = push_count 1→2 的 CAS(**恰一次重投**,重投前同样过终态门);T2 从原投递 deadline 起算 → `turn_wake_no_receipt` durable 告警 episode(open/close);
- **有界 drain**:GatePoller piggyback 扫描;ack 后**幂等投影**到 StateStore 对应 delivery 的 `receipt_started` 状态(CommDB 收据 → StateStore 状态机不脱节)。

**(c) 终态门 exact tuple + 与终态化的串行化(R1 #6 + R2 #3 + R3 #2)**:所有引擎 wake effect 携带 `(runId, nodeId, attempt, executionId, activationId)`;投递前查 `workflow_run_node` 状态,外发前经**共享 fence**:原子 admit 一个短命 `wake_sending` claim(仅当该 node attempt 非终态时可 admit);发送后记 sent/canceled 并释放。**fence 的覆盖面 = 单一共享终态守卫**:StateStore 内**所有** `workflow_run_node` → done/failed/superseded 的写点(不止 `commitWorkflowTransitionTx`——含 generalized no-code completion、rework 耗尽清理、route replacement、operator rework cleanup 等 superseded 路径)与所有 engine-bound session 终态写点(`persistTransition`/`upsertSession`/`forceStatus`)统一过该守卫;实现前先审计全部直写 SQL 位点。终态调用方在 claim 存活期间收到可重试的 `wake_send_inflight`,由其 durable source/coordinator 释放后重放。**claim 生命周期与 transport 绑定**:transport 硬超时 < claim lease(或发送期间心跳续约);Bridge 重启后旧 lease 未过期不得重投,过期后重新校验 node/session 再投。grant 后目标终态化 → 取消 delivery 不外发,belt 用 exact holder+epoch CAS 收敛到新应持棒者(无人则删行)。race 矩阵:终态化在 admit 与 send 之间提交;no-code completion / rework supersede / operator cleanup / forceStatus / claim-expiry-during-send 各一例。该门适用于全部引擎 grant/wake 生产者(含 T1 重投)。FLY-1609 形态回归测试钉住。

**(d) site 5(belt stale 恢复)**:re-grant 后接 `wakePhaseRunner`(recovery 文本)+ 收据登记;wake 失败保持既有 failClosed 告警。

### 2.3 跨账本自校验(founder 硬验收;R1 #5 全折入)

- **`turn_required` 谓词(durable 推导,state/backoff-aware——R2 #4)**:仅当 run 的 current 语境满足——admitted/running 的三阶段角色节点(shared-branch 形态)、或 open `workflow_rework_delivery`、或 open `workflow_carrier_delivery`——才要求「belt holder = 该语境的 actor/target」。**按 delivery 状态定义期望**:`pending` 且(lease 存活 或 `next_retry_at` 未到)→ **零期望**(FLY-1648 的 8min 退避是健康形态);到期后从 due/claim 时刻起算宽限;`grant_started/turn_granted/wake_delivered` → 要求 exact target;`needs_lead`/completed/canceled → 排除。**其余排除**:generic `main` 节点、未批准 gate、`land`、终态 run、held(它们有自己的告警)。零误报 fixtures 必含 8min 退避与 lease-in-progress 两例。
- **时间锚**:用 durable 时间戳(transition/delivery/launch 时刻),宽限 ≥ 既有 `TURN_GRANT_GRACE_MS`(5min);告警前**重读两侧**(排中间态);legacy 行只查窄兼容谓词字段。
- **episode durable 化**:`ledger_divergence_episode`(open/close 落库),恢复后关闭、复发重开(跨 Bridge 重启保语义);按 project 分组批查;DB 读失败与语义失配分开上报。
- **shadow 模式先行**:默认 `FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS=0` 时只记 episode/event 不告警;fixtures 证明对健康 run 零误报(含 §2.2a 全束落地前的存量行)后置 `=1` 开告警。该 call-time 开关也是误报时的即时 killswitch,不会关闭对账、episode 恢复闭合或审计。上线顺序见 §8。
- 告警内容:两本账逐字段证据 + 第 3 层 re-drive 指令原文;只告警不改写。

### 2.4 明确不改

`commitWorkflowTransitionTx` 不塞 TURN 语义(跨库);rework 主链投递机械不动(仅补收据/终态门);`reconcileTurnBelt` 对 engine-owned 的排除不动(引擎侧由 §2.3 负责);`runner_ship_approved` 事件保留(carrier 意图行成为消费者)。

## 3. 第 2 层 — turn 命令内嵌等待检测(R1 #7 折入:事务幂等)

- 表:`turn_wait_ledger(execution_id, holder_exec_id, epoch, first_seen_at, asked_at, question_id, last_error, no_turn_streak, last_no_turn_at, PRIMARY KEY(execution_id, holder_exec_id, epoch))`。
- not-yours 分支(**单个 CommDB 事务**):upsert first_seen;超阈值且未 ask → 以**确定性 question id**(`turn-wait:<execId>:<holderExecId>:<epoch>`)insert-or-verify 问题行(收件 = session.lead_id,缺失则从 receipt lineage 兜底),成功才写 `asked_at`;事务由 PK 串行化,crash/并发不重发。
- 清账(R2 #5,durable 语义):仅 `yours` 或 **epoch 变化** 清行;`no-turn` 走 `no_turn_streak`+`last_no_turn_at` 同事务计数——「连续」定义为**两次观察间隔 ≥ 最小间隔(如 30s)且中间无任何 turn 行观察**,streak≥2 才清;任何 turn 行观察即重置 streak。fixtures 含并发双呼与快速重复两例(不只顺序调用)。
- **debug 判定 = 身份感知(R3 #1,修正 R2 版的倒退)**:生产 prompt/wake 全部显式传 `turn --exec-id <自己的 id>`——显式 id **等于** `FLYWHEEL_EXEC_ID` 是正常自查(记账 + 精确 ack 照常);显式 id **不等于** env、或 env 缺失时显式传 id,才是 debug(零副作用:不记账、不 ack)。测试覆盖四象限(隐式 self / 显式=env / 显式≠env / 显式无 env)× 两种副作用(wait ledger、outbox ack)。阈值唯一 knob `FLYWHEEL_TURN_WAIT_ASK_MINUTES`(默认 20,校验 5-720 整数分钟,非法回默认);stdout 合同不变,诊断走 stderr。
- 失败面:insertQuestion 失败 → 行留 retryable(`last_error`),下次轮询重试;「两本账一致但 runner 等错人」的形态由 §2.3 兜不住时最终仍有 Lead 巡检(FLY-1687,另单)。

## 4. 第 3 层 — Lead 手动交棒正式化(R1 #8 折入:复用 guarded 合同)

- **耗尽 rework(needs_lead)**:复用既有 `/api/runs/:runId/rework`(`openOperatorRework`)——**新建 request**(完整 master 授权/quiescence/凭据撤销/幂等 client request),绝不原位重置耗尽 delivery 的 hold_count/凭据/lease。
- **carrier 未持棒**:薄 stage/apply 入口(digest + 单次 confirmToken + reason + exact (questionId, approvedHead, runId) tuple + StateStore run event 审计)→ 落/重置 `workflow_carrier_delivery` 为 pending(若不存在则按批准事实补铸意图行)→ 协调器正常 drain;重启后 boot 扫描兜底。**鉴权(R2 #6)**:stage 与 apply 都要求 master/Lead Bearer(`TEAMLEAD_API_TOKEN`),token 缺失 **503 fail-closed**;audit principal **从鉴权派生,绝不取请求体**;loopback/same-origin/digest/单次 token/pre-apply 重校验为叠加控制;路由挂在鉴权 middleware 之内(不进 gate-carrier-rebind 的 pre-auth 挂载区)。
- **SQL 手术**:runbook(`doc/engineer/implementation/turn-manual-handoff-runbook.md`)限定**仅 legacy 无凭据形态 + Bridge 挂死**;exact epoch CAS + 前后取证 SELECT + **成对纪律(UPDATE 后必须 `flywheel-comm send` 告知 holder/phase/epoch)**;engine-owned 提交型节点**禁用**(SQL 无法补凭据,必 409);5 条已知副作用全文收录。

## 5. Prompt — 全 vendor TURN WAIT LAW

- Blueprint TURN 法则注入点(design/implement/qa/generalized)统一追加:「`not-yours` 是正常等待态,**永不判 blocked**;继续不急不缓地轮询(60-90s);`turn` 命令会在超阈值时自动替你上报 Lead,不需要也不应自行升级;只有 `no-turn` 持续存在或 Lead 明确指示才改变行为。」
- `CODEX GATE WAIT LAW` 补限定:「a successful `turn` answer of `not-yours` is a wait state, NOT a command failure」。
- `agents/generic-executor.md` 同步。
- **与 §3 同一 commit 落地**(先有机制后有承诺,避免中间态合同错位——R1 #10)。

## 6. 测试(TDD 合同 + R1 #10 失败矩阵)

| 面 | 测试 |
|---|---|
| 2.1 | 批准事务同落意图行;协调器全链状态机;**crash 矩阵:StateStore 意图后 / grant 后 / projection 后 / wake 前后各断点 kill → Bridge 重启续投递**;source replay 幂等;退避→needs_lead |
| 2.2a | spawn 全束 grant 断言;land/generic-main 永不获 TURN;frozen legacy byte-compat |
| 2.2b | 收据登记/精确 ack(epoch/activation 匹配才 ack;不匹配不 ack)/t1 重投/t2 告警 episode 开合/重复 wake 去重/Bridge 重启后 drain 继续 |
| 2.2c | 双重终态校验;await 间隙终态化 → 取消+belt CAS;FLY-1609 回归 |
| 2.3 | turn_required 谓词全排除项零误报(gate/land/main/held/launch 宽限内);推进未 grant → shadow 事件→(开启后)告警;恢复关 episode、复发重开(跨重启) |
| 3 | 确定性 question id 幂等(crash 重放不重发);并发 turn 单发;瞬时 no-turn 不清账;env 边界;debug 四象限(隐式 self / 显式=env / 显式≠env / 显式无 env)× 两副作用 |
| 4 | openOperatorRework 复用路径;carrier stage/apply 单次 token;SQL runbook 前后取证脚本 |
| 5 | Blueprint 注入断言(全 vendor;GATE WAIT LAW 限定句) |

真机 QA(529 房,独立 QA 节点):重放事故 #4 形态(qa_failed → grant 断点注入)→ 协调器续投/自校验告警/re-drive 复活三线取证;Layer 2 e2e(真轮询超阈值 → Lead 收 runner_question 恰一条)。

## 7. 边界与不做

- FLY-1612 / FLY-1687 / FLY-1621 不在本单;§2.3 是引擎自检,不替代 1687 独立巡检。
- 不动 FLY-1655 land 主线;不动 rework 投递机械本体。
- 新 env 为 `FLYWHEEL_TURN_WAIT_ASK_MINUTES` 与 rollout 开关 `FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS`;后者默认 off,只控制 severe Lead alert,不关闭 durable 自校验证据。
- 版本号 ship 时取空号。

## 8. 实施与上线顺序(按不变量排序,R1 #10)

1. **schema + 协调器骨架**(carrier_delivery 表 / turn_wake_outbox / turn_wait_ledger;协调器 shadow 不外发。**部署边界(R2 #7):意图写入(projector)与协调器 drain 在同一 build 落地——不存在「先有 intents 无人 drain」的部署形态**);
2. **全束 grant 归一**(spawn 透传激活 + epoch 投影、终态门 exact tuple + wake_sending fence、site 5 wake);
3. **收据 patrol + 精确 ack**(GatePoller drain + episode);
4. **启用 carrier 协调器效果**(grant/wake 真外发)→ 跑 carrier crash/restart canary;
5. **自校验 shadow** → 兼容 fixtures 全绿(含存量行/退避/lease 例)→ 开告警(**必须在 4 之后**——修复路径先于诊断路径启用);
6. **Layer 2 wait ledger + 全 vendor prompt(同 commit)**;
7. **guarded re-drive + runbook**;
8. 全仓门(`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + shell 合同测试)+ 故障注入 QA。
