# FLY-1925 patrol_tick 名册加「圈」维度 — 调研

Issue: FLY-1925 (https://linear.app/geoforge3d/issue/FLY-1925/巡检tick-patrol-tick-名册加圈维度每-run-附当前节点棒持有者开圈状态-让有人在等不存在的圈直接印成红灯founder)
日期: 2026-08-20
基于: exploration.md

---

## 1. 数据面精确事实(逐条实测,行号 as-of `main` f8f2176e2)

### 1.1 comm.db(per-project;Bridge 经 `commDbPathForProject` 打开)

**`three_stage_turn`**(`flywheel-comm/src/db.ts:118`)——棒:
- 每 issue 至多一行:`issue_id → holder_exec_id, phase, epoch, granted_at, target_run_id, target_node_id, target_attempt, activation_id`;
- 读 API:`getTurn(issueId)`(db.ts:4624,readonly-tolerant:no-such-table → null)、`listTurns()`(db.ts:5368,同样 readonly-tolerant);
- 写方:仅 Bridge(`grantTurn`;`workflow-rework-coordinator.ts:45` / `turn-belt-reconcile.ts:186`);ship 收尾 `deleteTurn`。

**`turn_wait_ledger`**(db.ts:129)——等棒账本,行生命周期(全部实测):
- **写入**:runner poll `turn` 得 `not-yours` 时 upsert `(execution_id, holder_exec_id, epoch)`,`first_seen_at` 记首见(db.ts:4702-4720);观察到新 tuple 时删同 exec 的所有旧 tuple 行;
- **清除**:① 拿到棒 `clearTurnWaitOnGrant(executionId)`(db.ts:4809);② 连续 2 次「no-turn」观察(turn 行整个消失)后删行(db.ts:4848-4856,streak >= 2);
- **精确语义**:行存在 = 该 exec 曾因当前 holder@epoch 收到 `not-yours`,且
  后续尚未被 grant 或连续两次 no-turn 清账;表没有 `last_seen_at`,不能证明
  进程此刻仍在连续 poll。它是**耐久的 turn-poll 等待账记录**,
  `first_seen_at` 只能渲染为记录账龄,不能渲染成 live 等待时长;
- 附:`asked_at`/`question_id` 是 FLY-1614 的一次性 prolonged-wait 上报(askAfterMs 后向 Lead 发一条 `turn-wait:` question),与本卡互补——它管「holder 迟迟不交」,不判「圈存不存在」;
- 读 API:`listTurnWaitLedger(executionId)`(db.ts:4878)按 exec 查,**注意它不是 readonly-tolerant**(直接查表,no-such-table 会 throw——Codex R1 #4 更正,本文档初版此处写错)。**按 issue 反查所有 waiter 无现成 API**(需新增,或读全表后按 roster exec 集过滤)。

**`runner_declared_states`**(db.ts:110)——parked 声明:
- kind ∈ `parked`/`long_task`,带 `expires_at`;写方 = runner `flywheel-comm declare-state`(`commands/declare-state.ts`);
- 读 API:`getEffectiveDeclaredState(execId, nowMs)`(db.ts:4351,readonly-tolerant,过期即 null)。

**`turn_wake_outbox`**(db.ts:141)——在途 TURN wake(注:`pending`/`sent` 只是 outbox 状态,**单凭它不构成活源权威**——活源判定见 §2 S4 完整判据;Codex R4 #3):
- state ∈ `pending`/`sent`/`acked`/`cancelled`(outbox 传输状态;是否构成「棒在路上」的活源权威须再过 §2 S4 的目标匹配 + 可投递判据)。

**Bridge 打开方式先例**:`turn-wake-patrol.ts:37` `new CommDB(path)` + finally close(写路径);**只读用 `CommDB.openReadonly(dbPath)`**(db.ts:981,跳过 schema 创建;各读 API 已对 no-such-table 容错)。`plugin.ts:7434` 也有 `new CommDB(path, false)`(createIfMissing=false)先例。本卡纯读 → `openReadonly`。

### 1.2 teamlead.db(StateStore)

**`workflow_run`**(StateStore.ts:17310):`run_id, issue_id, project_name, current_node_id, current_qa_attempt, status`;status 实测值:`active` / `held` / `terminated` / 终态(completed 族);现成查询 `getActiveWorkflowRunForIssue(issueId)`(StateStore.ts:40536,LIMIT 1 最新 active)。

**`workflow_run_node`**(StateStore.ts:17384):`(run_id, node_id, attempt) → state, execution_id`;state 全集 = 导出常量 `WORKFLOW_RUN_NODE_STATES`(StateStore.ts:49806):`pending | admitted | running | review | done | failed | completed | superseded`(Codex R1 #2 更正——本文档初版漏了 `pending`(successor reservation,admission 前的真实预留态,StateStore.ts:27815-27875)与 `review`/`failed`/`completed`)。**非终态 `pending`/`admitted`/`running`/`review` 行 = 有活在册**;终态 = `done`/`failed`/`completed`/`superseded`。

**`workflow_rework_delivery`**(StateStore.ts:18406):state ∈ `pending` / `turn_granted` / `wake_delivered` / `replacement_pending` / `completed` / `held` / `needs_lead`。非 `completed` = 圈开着;其中 `held`/`needs_lead` = 开着但卡住(可见,不算「不存在」)。issue 关联需 join `workflow_rework_request.run_id → workflow_run.issue_id`。

**`land_operation`**(StateStore.ts:17899):`issue_id, state(intent/running/partial/completed/held), current_step`;migration 补列 `superseded_at` / `superseded_by_operation_id`(StateStore.ts:17953)——**superseded 行 state 常驻非 completed,生产读方显式过滤 `superseded_at IS NULL`**(StateStore.ts:48175-48201 先例;Codex R1 #7)。开圈判据 = `state != 'completed' AND superseded_at IS NULL`,scoped `(project_name, issue_id)`。

**`workflow_gate_holder`**(StateStore.ts:17490,Codex R1 #2 补):founder gate 卡的 durable 权威;state ∈ `materializing | awaiting_review | approved | superseded`。**只有 `materializing`/`awaiting_review` = 流程活跃**;`approved` 是 display-only 的历史权威——批准事务原子铸后继(carrier/land/终态),holder 自身不再发棒,`approved` 无后继即账面不自洽(Codex R2 #2 更正,初版此处「保守同算圈存在」已废)。

**`workflow_carrier_delivery`**(StateStore.ts:17614,Codex R1 #2 补):runner_ship 批准后的 carrier 投递状态机,state ∈ `pending | grant_started | turn_granted | wake_delivered | receipt_started | completed | held | needs_lead`;FK gate_holder。非 `completed` = ship carrier 圈开着。

**`sessions`**:roster 6-status = `running, ship_parked, awaiting_review, approved_to_ship, pending, design_done`(`getPatrolRosterSessions`,StateStore.ts:6721)。`ship_parked` 由 founder 批准后 runner_ship 路径写(StateStore.ts:38643)——**ship 流程活跃的现成投影**;`awaiting_review` 同理(review gate open)。

### 1.3 join 键形态(FLY-270 UUID/identifier 串键教训 → 显式核)

`three_stage_turn.issue_id` 与 `sessions.issue_id` **同形态**:生产先例 `turn-belt-reconcile.ts:167` 直接以 `turn.issue_id` 调 `store.getActorSessionsForIssue(...)`。`workflow_run.issue_id` 与 sessions 同源(dispatch 写入同键)。`turn_wait_ledger.execution_id` = session `execution_id`(runner 自身 exec UUID)。**结论:issue_id + execution_id 直接等值 join,无需换算**。

## 2. 「圈存在」的完备枚举(红灯谓词的反面;Codex R1 重写:以 durable 权威为源,不用 session status 投影)

对 issue I(scoped `(project_name, issue_id)`),以下任一成立 ⇒ 圈存在(不红灯):

| # | 账面源 | 库 | 判据 |
|---|---|---|---|
| S1 | 有活在册 | teamlead | 当前 run 的 `workflow_run_node` 存在 state ∈ (`pending`,`admitted`,`running`,`review`) 且 actor 不在 `(W_blocked ∪ W_self)`(waiter / holder 自指 wait 对应的 attempt 不能证明有人会发棒;未绑 exec 的 `pending` reservation = 正常 handoff 窗口,算源) |
| S2 | 返工圈 | teamlead | 该 run 经 `workflow_rework_request.run_id` 关联的 `workflow_rework_delivery` 存在 state ≠ `completed`;不按 request 的 MAX/current route revision 过滤,route 仅按 delivery 自身 `route_revision` join 作展示 |
| S3 | land 圈 | teamlead | `land_operation` 存在 `state != 'completed' AND superseded_at IS NULL` |
| S4 | 在途 wake | comm | `turn_wake_outbox` 存在 state ∈ (`pending`,`sent`) **且 push_count < 2 且 (execution_id, epoch, activation_id) 与当前 TURN 目标 tuple 匹配、且按生产可投递边界仍可投**(Codex R2 #1 / R3 #2:receipt ack 精确到 execution/epoch/activation,db.ts:5181-5193;生产 wake patrol 投递前经 `inspectWorkflowTurnWakeRetry`(StateStore.ts:43566-43649)cancel 终态/非 current 目标——activation 非空的 wake 还须 TURN target 选中该 exec 的当前 active attempt;activation NULL 的 legacy recovery wake 精确镜像生产 guard:TURN activation 亦 NULL + exact (execution, epoch) + 目标 session 非 `isStateStoreIrreversibleTerminalForZombie`(StateStore.ts:43580-43587;**不要求 patrol roster 成员**——生产对可逆非 roster status 或缺失 session 照样 deliver,更严会假红,Codex R4 #2)。会被 guard cancel 的残留显示 `wake:stale`,push 用尽显示 `wake:exhausted`,均不算源) |
| S5 | gate/carrier 权威 | teamlead | `workflow_gate_holder` 存在 state ∈ (`materializing`,`awaiting_review`) 行,或 `workflow_carrier_delivery` 存在 state ≠ `completed`。**`approved` 不算源**(Codex R2 #2:批准事务原子铸后继——land successor / engine-terminal / carrier pending,StateStore.ts:38855-38948;holder 自身不会再发棒。`approved` 无后继 = 账面不自洽,恰是要暴露的形态;`approved` 仅显示) |

S5 消除的假阳性:QA-PASS 后守纪律 park 等 post-ship(标准纪律)——此时
gate holder(awaiting_review)或 carrier delivery / land successor 活跃,
绝不能红灯。**session status(awaiting_review/ship_parked/approved_to_ship)
只是投影,不作圈权威**(Codex R1 #2:stale 投影会掩盖真缺圈)。

**run reducer(Codex R2 #3 / R4 #3,四显式分支)**:`active.length === 1`
→ 选它(`held` 行无论多少仅显示,不贡献 attempt/rework/gate/carrier 源);
`active.length > 1` → `unknown(ambiguous_runs)`(防御分支);
`active.length === 0` 时:`held.length === 1` → 选它;`held.length === 0`
→ 无 run(有效的「无 run 级源」观察,不是 unknown);`held.length > 1` →
`unknown(ambiguous_runs)`。终态后 roster/wait 尚未清账而落入「无 run + aged
wait」时仍标账面红灯:v1 要暴露的正是「等待账存在但圈不存在」;渲染只称
记录账龄和账面自检,不声称进程仍 live。

**waiter 三集合(Codex R2 #3 / R3 #1 + 运行时审查)**:`W_blocked` =
所有非 holder exact-tuple 等待者(不论年龄);`W_red` = 其中记录账龄满
30min 者;`W_self` = holder 自己留下的 exact-tuple wait(activation 失配时
holder 也会收到 `not-yours` 并写账)。红灯要求 W_red 非空;W_self 不独立
触发红灯,但 **S1 的排除集是 W_blocked ∪ W_self**——混龄场景(E1 账龄
2h、E2 同 tuple 账龄 5min)
中 E2 的 blocked attempt 不能冒充发棒者抑制 E1 的红灯。S1 仅当存在「未绑
exec 的 `pending` reservation」或「绑给 ∉(W_blocked ∪ W_self) 的 exec 的活动
attempt」时成立。

**可用性分层(Codex R2 #4)**:judgment-critical 源 = turn / wait / wake +
S1..S5 各表——任一读失败 → `unknown`;`runner_declared_states` 是
**display-only** 依赖(W1-only 裁定后它只喂 parked 显示)——缺表/读失败仅
标 parked 显示不可用,不阻断红灯判定(否则缺一张展示表就把可证的 FLY-1855
红灯藏进 unknown,放大假绿)。

## 3. 「等待中」的精确账面语义

waiter 证据(exec E ∈ roster,E ≠ 当前 holder):

- **W1 turn-poll**:`turn_wait_ledger` 有 E 的行,**且该行 (holder_exec_id, epoch) 与 `three_stage_turn` 当前行精确匹配**,**且记录账龄达到阈值**(`now - first_seen_at >= 30min` 固定常数——排除正常 handoff 首次 poll 的 fresh-wait 假阳性,Codex R1 #5;当晚死等是小时级,巡检 60min 一次,30min 不损检出)。由于没有 `last_seen_at`,这只表示未清除记录的账龄,不证明进程连续 live poll。tuple 不匹配(棒已换代 / 棒已删)= 过渡态观察滞后,标 `turn-poll-stale` 仅显示不判红;
- **W2 parked**:`runner_declared_states` kind=`parked` 未过期——**仅显示,不参与红灯**(Codex R1 #1:`park` 是通用「done-but-alive」声明,Auto-QA awaiting_retest、普通非 DAG park 都是健康态;红灯 v1 只锚 W1。与 issue 原文「turn-poll/parked」的偏差是设计裁定:宁漏勿误,parked 形态的死等仍在名册可见,Lead 独立判)。

**红灯谓词(最终)**:issue I 标 🔴 ⇔ 存在合格 W1 waiter ∧ S1..S5 全不成立 ∧
judgment-critical 源全部读取成功 ∧ **teamlead 事实采集完成后重读 judgment
fingerprint(当前 TURN tuple + 该 issue roster exec **以及当前 TURN holder
(即使 holder 不在 roster)** 的全部原始 wait 行(holder/epoch/first_seen_at,
canonical 排序)+ current-target retryable
wakes)仍与初始快照一致**(跨库无原子快照;行增删或任何分量漂移 →
`unknown`,bias to green;Codex R1 #5 / R2 #5 / R4 #1——wait 分量必须含
fresh 行:S1 依赖 W_blocked 成员,采集间隙新插入的 fresh wait 行会改变
S1 判定)。
任何读失败 → 该 issue 圈列 = `⚠️ 账面不可读`,既不红也不绿(fail-honest)。
非红态命名 `not_triggered`(不叫 `ok`——红灯缺席不是健康证明,Codex R1 #4)。

**当晚 FLY-1855 形态复核**:implement 体 turn_wait_ledger 有行且与棒行匹配
(棒在 QA 手上没人动)、等了数小时(≥30min)= W1 ✓;QA attempt 已 done、
rework delivery 无非终态、land 无行、无 retryable wake、gate holder 已
superseded / 无 carrier = S1..S5 全空 ✓ → 🔴。阴性对照:rework delivery
`pending` 存在(S2)→ 不红灯 ✓。

## 4. 注入与渲染合同(现状)

- **payload**:`HookPayload.roster?: PatrolRosterEntry[]`(hook-payload.ts:176,
  `{identifier, sessionRole, status, executionId8}`)。新增字段必须 optional
  ——旧 tick 事件 journal replay(byte-stable envelope 重建,patrol-tick.ts:224)
  时新 renderer 读旧 payload 不得炸;
- **renderer**:`formatPatrolTick`(hook-payload.ts:250)是 Mailbox/CommDB 两
  runtime 的唯一共享渲染;消毒:`canonicalPatrolToken`(grammar
  `^[A-Za-z0-9._-]{1,64}$` + 指令词 `check|verify|suggest|inspect|建议|怀疑|该查`
  即哈希转义)+ `PATROL_STATUSES` allowlist。新字段(node id / phase /
  execId8 / 圈状态枚举)一律过同一消毒;红灯行解释文字 = Bridge 模板固定
  字符串,零插值 runner 可控文本;
- **注入点**:`runLeadPatrolTickPass` 构建 payload 处(patrol-tick.ts:277-285),
  deps 注入新读取器保持纯函数可测;plugin.ts:8085 组装真实现。注意该 pass
  由 GatePoller 约每 60 秒调用(`DEFAULT_PATROL_EVERY_N_TICKS=20`,poll interval
  3s),不能在 project 顶层预扫库:必须在每个 Lead 越过 roster-empty、due、
  settlement 等 `continue` 后、确定要 mint 本轮 tick 的分支才按该 Lead roster
  懒采集。

## 5. 测试基建(现有,TDD 扩展点)

| 文件 | 覆盖 |
|---|---|
| `packages/teamlead/src/__tests__/patrol-tick.test.ts` | pass 逻辑(due/settlement/幂等) |
| `packages/teamlead/src/__tests__/patrol-tick-render.test.ts` | formatPatrolTick 模板 + 消毒(含恶意 roster fixture) |
| `packages/teamlead/src/__tests__/StateStore.patrol-tick.test.ts` | roster 查询 |
| `packages/teamlead/src/__tests__/gate-poller-patrol-tick.test.ts` | rider 接线 |
| `packages/flywheel-comm/src/__tests__/worktree-turn.test.ts` | turn/ledger 语义 |

fixture 方式:StateStore 内存库 + CommDB 临时文件库(既有测试同款);验收
场景(§3 复核)可全在单测层复现,无需 529 房。

## 6. 性能与安全边界

- rider 每约 60 秒进一次 pass,但圈账采集只在某 Lead 确实 mint 约 60min 一次
  的 tick 时发生;每个 minting Lead 一次 openReadonly + 仅该 Lead roster 的
  小表等值查询(roster 通常 < 20 issue)。未到期/live/settlement 提前退出路径
  reader 调用必须为 0;不同 Lead 不共享 waiter 集;
- readonly 打开不写 WAL、不建 schema;失败(库不存在/锁)→ 该 project 圈列
  全部 `⚠️ 账面不可读`,名册主体照发(圈维度降级,tick 不因新功能挂掉);
- 消毒纪律 §4;红灯零新告警通道——只进 tick 正文(founder 拍的边界)。

## 7. 会过期的结论表

| 结论 | as-of | 重核命令 |
|---|---|---|
| roster 6-status 集 | 2026-08-20 f8f2176e2 | `grep -n "getPatrolRosterSessions" -A6 packages/teamlead/src/StateStore.ts` |
| turn_wait_ledger 清行阈值 streak>=2 | 同上 | `git log -S "streak >= 2" -- packages/flywheel-comm/src/db.ts` |
| workflow_run_node state 机(admitted/running/done/superseded) | 同上 | `grep -n "workflow_run_node SET state" packages/teamlead/src/StateStore.ts` |
| rework delivery state 集(7 值) | 同上 | `grep -n "workflow_rework_delivery" -A12 packages/teamlead/src/StateStore.ts` |
| ship_parked 仅 runner_ship 批准路径写 | 同上 | `grep -n "'ship_parked'" packages/teamlead/src/StateStore.ts` |
| formatPatrolTick 为唯一共享渲染 | 同上 | `grep -rn "formatPatrolTick" packages/teamlead/src --include="*.ts"` |
| CommDB.openReadonly 存在且各读 API no-such-table 容错 | 同上 | `grep -n "openReadonly" packages/flywheel-comm/src/db.ts` |
