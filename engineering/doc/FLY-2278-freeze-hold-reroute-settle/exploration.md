# FLY-2278 冻结检测·hold 正门·reroute 重绑·settle 语义 — 探索
Issue: FLY-2278 (https://linear.app/geoforge3d/issue/FLY-2278/引擎loop稳定性-从-fly-2248-砍出的后半冻结检测带阈值活性证据hold-恢复正门carrierrework-reroute-重绑settle-语义2248-r5-只留欠条必达超时升级)
日期: 2026-09-03
基于: 无(上游为 FLY-2248 的 `engineering/doc/FLY-2248-generic-delivery-contract/` 全套与 PR #1040 的砍前/砍后代码)

## 0. 一句话

FLY-2248 砍前实现过 M2(改派)+ M4(冻结正门),四轮 code review 不收敛后被整体删除(commit `37dc5bd63`,-7871 行);本单要把这六个被 reviewer 点名的缺陷**按修正后的语义重做**,而不是把删掉的代码原样贴回来。

## 1. 现状审计(2026-09-03,main = `327dd9e7d`,含 #1040 合入 `64c1c9859`)

### 1.1 已经在 main 上的(FLY-2248 砍后交付)

| 器官 | 位置 | 状态 |
|---|---|---|
| attempt 台账 + set-once 五时钟 | `StateStore.ts:19962` DDL;`projectWorkflowDeliveryAttempt` `:35730` | 在用 |
| episode(warning / severe 两级) | `observeWorkflowDeliveryContract` `:35873-35990` | 在用;关闭理由只有 `advanced` / `regressed` / `reminted` / `terminal:superseded` / carrier 完成时的 `settled` / `superseded_by_completion` |
| projector(CommDB 三家族 + 终态核销) | `delivery-contract/projector.ts` | 在用;`source_terminal` / `run_terminal` 只写 `settlement_reason`,**不关 episode** |
| watch(零写入源表) | `delivery-contract/watch.ts` | 在用;逐 attempt try/catch 隔离 |
| `workflow_delivery_operation` 表 | `StateStore.ts:20013` | **DDL 存在但 `kind` CHECK 只允许 `'resident_expiry'`**(留给 FLY-2268),无 writer |
| 合法收件人集合 | `operational-terminal-status.ts:15` `CMUX_LIVE_SESSION_STATUSES` = pending/running/ship_parked/awaiting_review/design_done/approved_to_ship | 在用(founder 8-25 直令的机器形态) |
| 活性证据 | `sessions.heartbeat_at`(`updateHeartbeat` `:9820`,HeartbeatService / event-route / DirectEventSink 三处写)、`sessions.last_activity_at`、CommDB `hasRecentMessagesFrom(execId, windowSeconds)`(`db.ts:4577`)、`liveness-evidence.ts` 的 10 分钟窗 `activityWindowMs()` | 在用,**但只用于告警文案,从不进判决**(FLY-1329 A2 的设计意图) |
| 砍范围时**复活的**旧机制 | `workflow-engine-dispatcher.ts:1129-1262` `reconcileWorkflowReworkStalls` + `StateStore.escalateWorkflowReworkStall` `:26819`;env 旋钮 `FLYWHEEL_ENGINE_REWORK_ALERT_MS` / `_HOLD_MS`(`feature-flags/truth.ts` +2) | 在用;30 分钟 alert、60 分钟 **hold run**,活性证据只看 `last_error === 'actor_alive_after_receipt'` 这一条 |

### 1.2 被砍掉的(commit `37dc5bd63^` 树,本单的「负面样本」)

| 器官 | 砍前位置 | reviewer 点名的缺陷(对应 issue 六条) |
|---|---|---|
| 冻结检测器 ①:mailbox 槽位耗尽 | `sources/mailbox.ts` `observeRunnerMailboxDelivery` → `terminal='frozen'` → watch 调 `recordWorkflowDeliveryFreeze` → `UPDATE workflow_run SET status='held'` | 有 30 分钟阈值(`MAILBOX_SLOT_FREEZE_AFTER_MS`),但活性证据只有一个 `recipientRecentlyActive` 布尔,且该布尔因 `Math.max(NaN, x)` 恒 false(见 ⑥);冻结即 halt run |
| 冻结检测器 ②:三段 turn 卡住 | `sources/turn-wake.ts` `observeRunnerTurnWakeDelivery`(20 分钟 + `push_count>=2`) | 同上 |
| operator-required 升级 | `delivery-operations.ts:614-628` + `StateStore.recordWorkflowDeliveryRerouteOperatorRequired` `:36429`:undeliverable episode 找不到活的后继 → **立刻** `status='held'` + 告警 | 「runner ended with unread inbox mail」= `mailbox.ts:292-296`(`acked_at IS NULL && isWakeTerminalStatus(recipient_status)` → undeliverable)→ 同一 tick 就 held,零 grace,不看收件体是否只是刚退出、有没有后继正在起 |
| hold 恢复正门 | `hold-routes.ts` 挂 `/api` 下的 `/runs/:runId/holds`、`/runs/:runId/resume/stage`、`/runs/:runId/resume`;认证 `TEAMLEAD_API_TOKEN` Bearer + Origin 同源;CLI `commands/hold.ts` | (a)与既有 `runs-route.ts` 的 `/api/runs/:runId/hold` `/terminate`(`auth.masterToken`)**是兄弟路径却两套认证**;(b)`canonicalSubmissionDigest` 在路由层(`decision` 缺席时不带键)与 StateStore 层(`decision: decision ?? null`、`reason.trim()`)**各算一次**,同一请求两个 digest,`request_conflict` 判定不可信;(c)`runId` 由路径覆盖 body,但 stage 与 apply 两步覆盖的是不同层级(`body.runId` vs `body.canonical.runId`) |
| carrier/rework reroute | `StateStore.stageWorkflowDeliveryRerouteTx` `:36008-36160`:子 attempt 的 `contract_ref_json.pk = '<family>:reroute:<root>:g<n>'` | 对 mailbox/phase_wake/turn_wake 这是真实的确定性新行 id;对 rework/carrier **不存在这样的物理行**(它们的 pk 是 `request_id` / `question_id`,改派只是追加 route revision / redrive),于是活的子 attempt 指向一个合成 pk,projector 的 `source_terminal` / `run_terminal` 核销永远找不到源行,episode 永远 open |
| settle 语义 | 砍前 `listLiveWorkflowDeliveryAttempts` 过滤 `settlement_reason IS NULL`;watch 收集 `observedRoots`,tick 末 `closeDisappearedWorkflowDeliveryEpisodes` 把没被观察到的 open episode 关成 `'disappeared'` | settled 的 attempt 从 live 列表消失 → 它的 episode 被当成「凭空消失」关掉,而不是 `terminal:settled`;**砍后 main** 的做法是 live 列表不过滤 settled、classify 出 `stage='settled'` 且无 deadline → episode 以 `'advanced'` 关闭 —— 词错了但至少不是 disappeared |
| recently-active 守卫 | `isWorkflowDeliveryRecipientRecentlyActive` `:35095-35120`:`Math.max(parseActivity(heartbeat_at), parseActivity(last_activity_at))`,`parseActivity` 对空值返回 `NaN` | `Math.max(NaN, 1000) === NaN` → `Number.isFinite` false → 只要两列有一列为空,守卫就判「不活跃」;生产里 `heartbeat_at` 对 Codex 体常空,所以守卫基本失效 |

### 1.3 FLY-2268 是否已覆盖(issue「前置」项)

`git branch -r | grep 2268` 为空,`gh pr list --search FLY-2268` 只命中 #1040 本身;FLY-2268 目前只有 `engineering/doc/FLY-2268-worker-resident-receiver/plan.md` 骨架,**零代码**。它承诺的心跳 rider(`ResidentReceiverSupervisor`)将来会是更强的活性证据,但本单不能依赖未合入的东西。结论:2268 未覆盖本单任何一条;本单只用 main 上已有的证据源(1.1 表「活性证据」行),并把「未来接 2268 心跳 rider」写成接口而非依赖。

### 1.4 两本账的 session 状态词汇不同(审计中先误判、后经生产库核实更正)

`CommDB.listRunnerDeliveryProjectionRows()`(`db.ts:2617-2643`)的 WHERE 按 **CommDB** `sessions.status` 过滤(`running`,或 `blocked/timeout` 且信仍 QUEUED/LEASED)。我一度据此断言「发给 `ship_parked` / `awaiting_review` / `design_done` 体的信不进合同」,并已把它作为问题 (1) 发给 Lead;随后用生产库直接核对:StateStore 里 14 天内 3 个 `ship_parked` 体在 `comm/flywheel/comm.db` 的 `sessions.status` 全是 `running`(CommDB 的状态词汇只有 running/completed/timeout 等,parked 是 StateStore 独有的词)。**结论:parked 体的信正常进投影,该问题不成立,已向 Lead 撤回。**

留下的真事实是设计约束:两本账各有一套 session 状态词汇。
- CommDB `recipient_status`(投影行携带)只能回答「收件体是否已终结」(`isWakeTerminalStatus`),不能回答「是否 parked」;
- 「收件体非终态 / 是合法收件人」的权威来源必须是 **StateStore** `sessions.status ∈ CMUX_LIVE_SESSION_STATUSES`。
- 本单的活性分类器读 StateStore 状态 + StateStore `heartbeat_at` / `last_activity_at` + CommDB 出站消息;不得用 CommDB `recipient_status` 判「活」。

## 2. 问题定义(founder 约束翻译成机器判据)

founder 三条约束:**不加旋钮;任何检测器必须有阈值+活性证据;每条修复配真事件流阳性对照**。翻译:

1. **阈值**:只以 `policy.ts` 常量出现;不读 env;砍范围时复活的两个 env 旋钮 `FLYWHEEL_ENGINE_REWORK_ALERT_MS/_HOLD_MS` 是既有旋钮,不由本单新增——但本单若替换掉 `reconcileWorkflowReworkStalls` 的 hold 分支,就要顺手把这两个旋钮和 registry 条目一起删(它们是 FLY-2248 plan M1「退役」项,砍范围时被复活)。
2. **活性证据**(三条件缺一不 halt):(a)`age >= 阈值`;(b)收件体 session 状态 ∈ `CMUX_LIVE_SESSION_STATUSES`(非终态);(c)近期活性证据缺失——「近期」= `activityWindowMs()`(10 分钟,FLY-2101 founder 定死),证据源取三者任一命中即算活:`sessions.heartbeat_at`、`sessions.last_activity_at`、CommDB `hasRecentMessagesFrom`。**pane 变化**:main 上没有持久化的 pane 变化时间戳(只有 `pane-live-region.ts` 的 hash 工具与 `runner-status.ts` 的 pane 分类,均不落库);本单不新造 pane 采样机制,用 CommDB 出站消息作为「体在动」的替代证据,并把 pane 变化列为 2268 心跳 rider 到位后的追加证据源。
3. **每条修复配真事件流阳性对照**:每个检测器 / 每条修复至少一条测试走真实写点(不是直接 INSERT 目标表):mailbox 经 `commands/send.ts`,phase_wake 经 `runner-wake.ts`,rework 经 `advanceWorkflowReworkDelivery`,carrier 经 `advanceWorkflowCarrierDelivery`;阳性臂「应当触发」与阴性臂「不该触发」同轮。
4. **合法收件人**:ship_parked / awaiting_review / design_done 三种体一律按「活」处理;任何把它们判成终态/undeliverable 的路径都是 bug。

## 3. 六条缺陷 → 六个设计方向

| # | issue 条目 | 设计方向(一句话) | 与旧实现的本质差别 |
|---|---|---|---|
| ① | 两个冻结检测器 | 保留「mailbox 槽位耗尽」「三段 turn 卡住」两种**形状**,但检测结果从「halt run」降为「开一个 `frozen` episode + 一次告警」;**只有三条件同时成立才把 run 置 held**,而且置 held 走同一个 `hold-writers` 写点 | 旧:阈值 + 一个失效的布尔 → 直接 held。新:阈值 + 非终态 + 证据缺失三条件;证据缺失由一个纯函数 `classifyRecipientLiveness` 给出,可穷举测试 |
| ② | operator-required 零 grace | undeliverable(收件体终态且未 ACK)不再当 tick 升级;先开 `undeliverable` episode,进入 **grace = `STAGE_DEADLINES_MS.sent`(15 分钟)**;grace 内每 tick 找后继(同 run 同 node 的新 activation);grace 后仍无后继 **且** 原收件体无活性证据 → 才 `operator_required` + held | 旧:同 tick held。新:grace + 后继查找 + 活性证据三道门 |
| ③ | hold 正门路径/参数 | 正门并入既有 `runs-route.ts`:`GET /api/runs/:runId/holds`、`POST /api/runs/:runId/resume`(两步 stage/apply 保留,但**只在 StateStore 一处算 digest**,路由层只透传);认证与兄弟路由 `/hold` `/terminate` 完全一致(`auth.masterToken` + loopback) | 旧:独立 router、独立 token、两处 digest。新:一处 digest、一套认证、一个文件 |
| ④ | reroute 重绑合成 pk | 按家族分两类:CommDB 家族(mailbox/phase_wake/turn_wake)子 attempt 指向**真实新行**(确定性 id,旧实现已对);StateStore 家族(rework/carrier)**不铸新物理行**,子 attempt 的 `contract_ref` 指向**同一物理 pk** + 新 `generation`,由 `route revision` / redrive 计数作为代际证据 | 旧:五家族一把梭,rework/carrier 指向不存在的 pk。新:`contract_ref.pk` 永远是权威表里真实存在的主键,projector 核销能找到源行 |
| ⑤ | settle 语义 | settle 是 attempt 的**终态**,与 superseded/cancelled 同级:`settleWorkflowDeliveryAttemptTx` 在同一事务里把该 attempt 的 open episode 关成 `terminal:settled`(带 `settlement_reason` 作为后缀);watch 不再需要「消失」判断;`disappeared` 只保留给「attempt 行本身没了」这一不可能路径的守卫 | 旧(砍前):靠 observedRoots 差集,把 settled 当 disappeared。旧(砍后):当 advanced。新:settle 写点自己关 episode |
| ⑥ | `Math.max` NaN | 删掉 `isWorkflowDeliveryRecipientRecentlyActive`(砍后 main 已不存在),用 `classifyRecipientLiveness` 替代:先把可空时间戳过滤成有限数组,空数组 = 无证据(不是「不活跃」,是「不知道」);「不知道」在三条件里**算证据缺失**,但要在告警文案里说明是 unknown | 旧:NaN 静默失效。新:`unknown` 是显式第三态,并有「两列全空」「一列空」「两列都在窗内」「两列都在窗外」四格穷举测试 |

## 4. 备选方案与取舍

### 4.1 冻结后要不要 hold run?

- A(旧):检测即 hold。被 reviewer 否决:无活性证据就冻结整条 run,误杀活体。
- B(**选**):三条件 hold。检测器产出 `frozen` episode(可见、可告警),hold 是 episode 之上的第二步,条件更严。
- C:永不 hold,只告警。founder 的原话是「每种冻结配正门」,正门的前提是 hold 存在;C 让正门无事可做。

### 4.2 grace 用哪个常量?

- 复用 `STAGE_DEADLINES_MS.sent`(15 分钟):**选**。理由:undeliverable 本质是「送出去了但收件体死了」,与 sent 阶段的等待语义一致;不新增常量就不新增「旋钮」。
- 新常量 `UNDELIVERABLE_GRACE_MS`:多一个数字要 founder 记,否决。

### 4.3 正门放哪?

- 独立 `hold-routes.ts`(旧):否决,兄弟路由两套认证。
- 并入 `runs-route.ts` `registerRunManagementRoute` 旁(**选**):`hold` / `terminate` / `resume` 三个动作同一处、同一认证、同一 `reason` 校验;`holds` 列表是 `GET /:runId/holds`。
- 挂 `/api/workflow`:那是模板/菜单路由,语义不合。

### 4.4 rework/carrier 改派要不要真的「改派」?

- 铸合成物理行(旧):否决(④)。
- **选**:rework 改派 = `appendWorkflowReworkRouteRevision`(既有,`:30921`)指向后继 activation + delivery 回 `pending`;carrier 改派 = 既有 `redriveWorkflowCarrierDelivery`(`:48583`)的系统级内部原语(不经正门 principal 校验)。attempt 台账只记 generation+1,`contract_ref.pk` 不变。
- 不改派、只告警:等于把 #2 事故(gate 后继换体、信件送给尸体)留给人工;founder 要求「判死先问送达」的后半就是自动改派,不做等于范围回退。但**改派上限** `MAX_REROUTES_PER_ROOT = 2` 保留,超限走 operator_required。

### 4.5 settle 关 episode 放在 settle 写点还是 watch?

- watch 统一关(砍前做法):watch 看不到「为什么 settled」,只能给 disappeared/advanced 这种含糊词。
- **选**:settle 写点关。`settleWorkflowDeliveryAttemptTx` 已经是所有 settle 的唯一入口(carrier 完成、launch abandon、projector 的 source_terminal/run_terminal 都调它),在它里面同事务关 episode,理由 = `terminal:settled:<settlement_reason>`。

## 5. 范围边界(做 / 不做)

**做**:上面六条;两个 env 旋钮与 `reconcileWorkflowReworkStalls` 的 hold 分支退役(它被本单的三条件 hold 取代;alert 分支已被 FLY-2248 的 stalled episode 取代);`workflow_delivery_operation.kind` CHECK 扩到 `('hold_resume','reroute','resident_expiry')`(纯放宽,不重建表);hold shape 注册表 + 一扇门 + CLI `flywheel-comm hold list|resume`;runbook SQL 段替换。

**不做**:FLY-2268 全部(心跳 rider、durable turn、resident hold);pane 采样落库;新告警层;mailbox 关系模型(FLY-1792);FLY-2211 reown 判死;Lead↔Lead 信件合同;§1.4 的投影 WHERE 放宽(等 Lead 裁定,若裁定入本单则作为 M2 的一个子项)。

## 6. 提给 Lead 的非阻塞问题

1. ~~§1.4:mailbox 投影排除 parked 体的信~~ —— 经生产库核实不成立,已撤回(见 §1.4)。
2. 砍范围时复活的 `FLYWHEEL_ENGINE_REWORK_ALERT_MS/_HOLD_MS` 两个旋钮:本单删(建议)还是留给别的单?

## 7. 成功判据(可机器判)

- S1 三条件穷举:`{age<阈值, age>=阈值} × {status 终态, 非终态} × {证据 alive, absent, unknown}` = 12 格,只有 `(>=, 非终态, absent|unknown)` 两格 hold;其余 10 格断言 `workflow_run.status` 不变。
- S2 grace:undeliverable 开 episode 后 14 分钟内出现后继 → 自动改派、零 held;15 分钟后无后继且原体无证据 → 恰好一次 operator_required;有证据 → 不升级、告警文案带 unknown/alive 说明。
- S3 正门:`GET holds` 列出的每个形状 `POST resume` 阳性一条、阴性一条;同一 `clientRequestId` 重放返回 `idempotentReplay:true` 且 digest 一致;错 token 403、非 loopback 403、hold 已变 409。
- S4 reroute:rework/carrier 改派后子 attempt `contract_ref.pk` 等于父 attempt 的 pk,且 `getWorkflowStateDeliverySourceRun` 能解析;第 3 次改派转 operator_required。
- S5 settle:三种 settle 入口(carrier 完成、launch abandon、projector 终态)各一条测试断言 episode `closed_reason = 'terminal:settled:<reason>'`;仓库内 `'disappeared'` 字面量只出现在守卫测试里。
- S6 NaN:四格穿越测试;`Math.max` 不出现在 liveness 分类器源码里(grep 守卫)。
- S7 阳性对照:每条上述测试的阳性臂经真实写点;仓库 grep 断言新测试文件不直接 `INSERT INTO workflow_delivery_attempt`。
