# FLY-2278 冻结检测·hold 正门·reroute 重绑·settle 语义 — 调研
Issue: FLY-2278 (https://linear.app/geoforge3d/issue/FLY-2278/引擎loop稳定性-从-fly-2248-砍出的后半冻结检测带阈值活性证据hold-恢复正门carrierrework-reroute-重绑settle-语义2248-r5-只留欠条必达超时升级)
日期: 2026-09-03
基于: exploration.md

> 行号基于 main `327dd9e7d`(含 PR #1040 合入 `64c1c9859`);「砍前」指 `37dc5bd63^`(PR #1040 分支上 M2/M4 被删除前的最后一棵树)。本文只记事实与方案比较;决定在 plan.md。

## 1. 六条缺陷的代码地图

### 1.1 活性证据(缺陷 ⑥,也是 ①② 的地基)

| 证据 | 来源 | 写点 | 备注 |
|---|---|---|---|
| `sessions.heartbeat_at`(StateStore) | `StateStore.updateHeartbeat` `:9820` | `HeartbeatService.ts:1063,1388`、`event-route.ts:594`、`DirectEventSink.ts:1377`、`plugin.ts:7134` | Claude 体每 tick 有;Codex 体经 event-route 才有,可能长期为空 |
| `sessions.last_activity_at`(StateStore) | `StateStore.ts:8623` 状态转移时写 | 状态变化才更新 | 长任务里可能几小时不动 |
| CommDB 出站消息 | `CommDB.hasRecentMessagesFrom(execId, windowSeconds)` `db.ts:4577`;Bridge 侧封装 `commdb-probes.ts:probeCommSignalsFromCommDb` | runner 每次 `ask/report/send/stage` | FLY-1319 形状的唯一救命证据 |
| 窗口 | `liveness-evidence.ts:activityWindowMs()` = 600 000 ms(FLY-2101 founder 定死) | — | 不是旋钮 |
| 非终态 | `operational-terminal-status.ts:15 CMUX_LIVE_SESSION_STATUSES`(pending/running/ship_parked/awaiting_review/design_done/approved_to_ship) | — | founder 8-25「合法收件人」的机器形态 |
| pane 变化 | 无持久化(`pane-live-region.ts` 只有 hash 工具,`runner-status.ts` 只做瞬时分类,都不落库) | — | 本单不造采样器;接口留给 FLY-2268 心跳 rider |

砍前 `isWorkflowDeliveryRecipientRecentlyActive`(砍前 `:35095-35120`):

```ts
const parseActivity = (v) => v ? Date.parse(...) : Number.NaN;
const latestActivity = Math.max(parseActivity(heartbeat_at), parseActivity(last_activity_at));
return Number.isFinite(latestActivity) && ...;
```

`Math.max(NaN, t) === NaN`,一列为空即整体判「不活跃」。砍后 main 已无此函数(随 M2 一起删),但它的替代品必须从一开始就把「无证据」与「证据过期」分开。

**方案:纯函数 `classifyRecipientLiveness`**(新文件 `delivery-contract/liveness.ts`):

```ts
type LivenessEvidence = { heartbeatAtMs: number|null; lastActivityAtMs: number|null; recentOutboundInWindow: boolean };
type LivenessVerdict = "alive" | "absent" | "unknown";
function classifyRecipientLiveness(e: LivenessEvidence, nowMs: number, windowMs = activityWindowMs()): LivenessVerdict {
  if (e.recentOutboundInWindow) return "alive";
  const stamps = [e.heartbeatAtMs, e.lastActivityAtMs].filter((t): t is number => t !== null && Number.isFinite(t));
  if (stamps.length === 0) return "unknown";
  return nowMs - Math.max(...stamps) <= windowMs ? "alive" : "absent";
}
```

与 `describeActivityEvidence`(同文件邻居)同构,但产出的是三态判决而不是文案;`Math.max` 只作用于已过滤的有限数组。守卫:该文件源码里 `Math.max(` 只允许出现一次且紧跟 `...stamps`(grep 断言);四格穿越测试:两列空 / 一列空且另一列在窗内 / 一列空且另一列在窗外 / 两列都在窗外。

### 1.2 冻结检测器(缺陷 ①)

砍前两种形状及其阈值:

| 形状 | 砍前源 | 触发条件 | 阈值常量 |
|---|---|---|---|
| `mailbox_inflight_slots_exhausted` | `sources/mailbox.ts` | `state='QUEUED'` 且 `inflight_batch_count >= inflightMaxBatches(3)` 且最老 inflight 批次 ≥ 30 分钟 | `MAILBOX_SLOT_FREEZE_AFTER_MS = 30min` |
| `three_stage_turn_stuck` | `sources/turn-wake.ts` | `state='sent'` 且未 ACK 且 `push_count >= 2`(推满两次)且首推 ≥ 20 分钟 | `TURN_WAKE_FREEZE_AFTER_MS = 20min` |

两者的数据需求:
- mailbox:砍前 `RunnerDeliveryProjectionRow` 多两列 `inflight_batch_count`、`oldest_inflight_delivered_at`(砍前 `db.ts:2655-2666` 的子查询),砍后被删;本单加回投影 SELECT(纯读,不改表)。
- turn_wake:`turn_wake_outbox.push_count` 列在 main 上仍在(`db.ts:168`,CHECK 0..2),但 `RunnerTurnWakeProjectionRow` 砍掉了 `push_count` 字段;加回。

砍前的处置链:`terminal='frozen'` → watch → `recordWorkflowDeliveryFreeze`(砍前 `:36494-36530`)→ **无条件** `UPDATE workflow_run SET status='held'`。这就是 reviewer 说的「无活性证据即 halt」——阈值有,活性只有一个恒 false 的布尔。

**方案**:检测与处置分两层。
1. 检测层(纯函数,`sources/*.ts` 形状不变)只产出 `{shapeId, since}`;watch 把它记成 `frozen` episode(`stage` 列写形状 id,`closed_reason` 复用现有词汇),恰好一次 warning 告警(uid `delivery_contract_frozen:<episode_id>`,**这是本单唯一新增的告警 uid 前缀**)。
2. 处置层(`hold-writers.ts:freezeRunTx`)三条件:`age >= 阈值` ∧ StateStore `sessions.status ∈ CMUX_LIVE` ∧ `classifyRecipientLiveness ∈ {absent, unknown}`;三条件在**同一事务内**重新读取后再写 `status='held'` + 事件 `<shapeId>`(payload 带 `livenessVerdict`、三条证据时间戳),run 已非 active 则 0 rows 静默。
3. 12 格穷举测试(§7 S1);`unknown` 格 hold 但告警文案必须写「无心跳记录」。

### 1.3 operator-required 零 grace(缺陷 ②)

砍前链路:`sources/mailbox.ts:292-296` `acked_at IS NULL && isWakeTerminalStatus(recipient_status)` → `terminal='undeliverable'` → episode → `delivery-operations.ts:614-628` 当 tick 找后继(`resolveWorkflowDeliveryRecipient`,砍前 `:35000-35093`:同 run 同 node 更高 attempt 且 session ∈ CMUX_LIVE)→ 找不到 → `recordWorkflowDeliveryRerouteOperatorRequired`(砍前 `:36429-36492`)→ `status='held'` + 告警。**从「收件体退出」到「run 被冻」在一个维护 tick 内完成**,而真实世界里后继 activation 的 admission 常常晚于前体退出几分钟(#2 事故正是 gate 换体窗口)。

**方案**:undeliverable episode 进入 grace。
- grace 常量:复用 `STAGE_DEADLINES_MS.sent`(15 分钟),episode `opened_at` 起算,不加新常量。
- grace 内每 tick:找后继 → 有则走改派(§1.5);无则什么都不写(episode 保持 open,不告警)。
- grace 到期:再找一次后继;仍无 → 读原收件体活性:`alive`(体虽终态但 10 分钟内还在发消息,典型是「刚 complete 还在收尾」)→ 不升级、只在 episode 上记 `deferred_alive_at`(set-once,可观察);`absent|unknown` → `operator_required`(held + 事件 + 恰好一次 `delivery_reroute_outcome:<attempt_id>` 告警)。
- 阳性对照:经真实 `commands/send.ts` 发信给一个随后被 `markSessionTerminal` 的体;t+14min 注入后继 admission → 断言改派、零 held;对照臂不注入后继、t+15min → 断言 held 恰好一次。

### 1.4 hold 恢复正门(缺陷 ③)

砍前:独立 `hold-routes.ts`(293 行)挂在 `app.use("/api", createHoldRouter(...))`,认证 `TEAMLEAD_API_TOKEN` Bearer + Origin 同源;CLI `commands/hold.ts` 两步 `resume/stage` → `resume`。既有 `runs-route.ts` 在 `app.use("/api/runs", runsRouter)`(`plugin.ts:4230`)下已有 `POST /:runId/hold`、`POST /:runId/terminate`(`registerRunManagementRoute` `:350-547`),认证 `secureTokenEqual(bearer, auth.masterToken)` + `loopbackSelfOrigin`。三处不一致:

| 项 | 砍前 hold 门 | 兄弟路由 `/hold` `/terminate` |
|---|---|---|
| token | `config.apiToken` 经砍前私有 `bearerMatches` 比较 | `auth.masterToken`(`plugin.ts:4216` 赋的就是 `config.apiToken`,**同一个值**)经 `secureTokenEqual` 比较——值同、比较函数与错误码不同(401 vs 403 `MASTER_AUTH_REQUIRED`) |
| 同源 | `isSameOrigin(origin/referer, loopbackSelfOrigin)` | `loopbackSelfOrigin(host)`(`runs-route.ts:557`) |
| 挂载 | `app.use("/api", holdRouter)`(`/api/runs/:runId/*` 与 `runsRouter` 前缀重叠,先注册者先匹配) | `app.use("/api/runs", runsRouter)`(`plugin.ts:4230`) |
| digest | 路由层 `canonicalSubmissionDigest(canonical)`(`decision` 缺席时无键)与 StateStore 层 `canonicalSubmissionDigest({…decision: decision ?? null, reason: reason.trim()})` **两次、不同输入** | 无两步 |
| runId 注入 | stage 覆盖 `body.runId`,apply 覆盖 `body.canonical.runId` | 路径参数唯一 |

digest 不一致的后果:`resumeWorkflowHold` 写入的 `canonical_digest` 与路由层重放时比较的 digest 不同 → 合法重放被判 `request_conflict`;confirmToken 绑的是路由层 digest,与落库 digest 无关。

**方案**:
- 正门并入 `runs-route.ts`:`GET /:runId/holds`、`POST /:runId/resume/stage`、`POST /:runId/resume`,与 `/hold` `/terminate` 共用同一 `requireMaster`(抽出 `registerRunManagementRoute` 里那段 bearer 检查为局部函数)+ `loopbackSelfOrigin(host)`。
- digest **只在 StateStore 算一次**:`StateStore.canonicalizeHoldResume(input) → { canonical, digest }`;路由 stage 步调它拿 digest 发 confirmToken;apply 步再调它一次,`verifyAndConsume(confirmToken, digest)`;`resumeWorkflowHold` 接收 `{canonical, digest}` 不再自算。测试:同一输入路由层与 StateStore 层 digest 逐字相等(单一函数,自然相等);`decision` 缺席 / `reason` 带首尾空格两种输入的 digest 稳定。
- `runId` 只来自路径;body 里出现 `runId` 与路径不等 → 400(不静默覆盖)。
- CLI `flywheel-comm hold list|resume` 复活(砍前 `commands/hold.ts` 逻辑可复用,token 环境变量改为与 `/terminate` CLI 一致的 master token 变量——需核 `commands/` 里现有 terminate/hold 命令用哪个变量,plan 里点名)。

### 1.5 reroute 重绑合成 pk(缺陷 ④)

砍前 `stageWorkflowDeliveryRerouteTx`(砍前 `:36008-36160`):`childPhysicalId = '<family>:reroute:<root>:g<n>'`,子 attempt `contract_ref.pk = childPhysicalId`,**对五个家族一视同仁**。对 CommDB 三家族这是对的(`rerouteMailboxDelivery` 等会 `INSERT OR IGNORE` 一行 id 正是它);对 rework/carrier,砍前 `applyWorkflowDeliveryReroute`(砍前 `:36230-36430`)做的是:rework → 直接 `INSERT INTO workflow_rework_route_revision` + `UPDATE workflow_rework_delivery SET route_revision=?, state='pending'`;carrier → `UPDATE workflow_carrier_delivery SET redrive_generation = redrive_generation + 1`。物理主键不变(`request_id` / `question_id`),但子 attempt 指向 `rework:reroute:…`,于是:
- projector 的 `getWorkflowStateDeliverySourceRun` `:35810-35870` 按 `contract_ref.pk` 查 `workflow_rework_delivery.request_id` → 查不到 → `run_terminal` 核销永远不发生;
- carrier 完成核销 `settleWorkflowCarrierDeliveryOnCompletionTx` `:35652` 按 `pk = questionId` 找 attempt → 只找到已被 superseded 的父 attempt,子 attempt 永远 live。

**方案**:`contract_ref.pk` 的不变量 = 「权威表里真实存在的主键」。
- CommDB 三家族:子 attempt `pk = 确定性新行 id`(不变)。
- rework:子 attempt `contract_ref = { table:'workflow_rework_delivery', pk: request_id(同父), routeRevision: <新 revision> }`;generation = 台账代际,`routeRevision` 是家族内代际证据。
- carrier:`contract_ref = { table:'workflow_carrier_delivery', pk: question_id(同父), redriveGeneration: <新值> }`。
- 测试:改派后 `getWorkflowStateDeliverySourceRun({family, table, pk})` 对子 attempt 返回同一 run;run terminate 后子 attempt 被 `run_terminal` 核销;carrier 完成核销能命中子 attempt。
- `appendWorkflowReworkRouteRevision` `:30921` 要求 `request.authority === 'founder'`,系统改派不能走它;沿用砍前的内部原语(同事务 INSERT revision + CAS delivery 回 pending),命名 `rerouteWorkflowReworkDeliverySystemTx`,并断言不带 `principal`。

### 1.6 settle 语义(缺陷 ⑤)

砍前:`listLiveWorkflowDeliveryAttempts` 过滤 `settlement_reason IS NULL`;watch 收集 `observedRoots`;tick 末 `closeDisappearedWorkflowDeliveryEpisodes`(砍前 `:36593-36630`)把未观察到的 open episode 关成 `'disappeared'`。settled attempt 恰好「未被观察到」→ 被记成 disappeared。

砍后 main:`listLiveWorkflowDeliveryAttempts` `:35171` **不过滤** settled;`classifyDeliveryAttempt` 把有 `settlement_reason` 的判为 `stage='settled'`、无 deadline;`observeWorkflowDeliveryContract` `:35893-35911` 走 `!overdue` 分支,open episode 因 `episode_id` 变了而关成 `'advanced'`。词错(settle 不是 advance),且 settle 与关 episode 不在同一事务(watch 下一 tick 才关),窗口内 `hold list` 会列出一条已核销的 stall。只有 carrier 完成核销 `:35721-35730` 自己同事务关了 episode(理由直接写 `settlement_reason`)。

**方案**:`settleWorkflowDeliveryAttemptTx` `:35602` 是三条 settle 路径(carrier 完成、launch abandon `source_terminal`、projector `source_terminal`/`run_terminal`)的唯一入口,在它里面同事务 `UPDATE episode SET closed_reason = 'terminal:settled:' || ? WHERE attempt_id = ? AND closed_at IS NULL`;carrier 完成核销那段 `:35721-35730` 删除(由公共入口接管)。`listLiveWorkflowDeliveryAttempts` 改为过滤 `settlement_reason IS NULL`(watch 不再看 settled 行),`classify.ts` 的 `settled` 分支保留但加守卫测试「watch 永远收不到 settled 行」。`'disappeared'` 词汇不引入。

## 2. hold 形状清单(正门的盘)

main 上 `UPDATE workflow_run SET status = 'held'` 共 14 处写点(grep),对应事件 kind:

| 写点(函数) | 行 | 事件 kind → 形状 id | 解冻动作(砍前 `applyStateWorkflowHoldResumeActionTx` 已实现,可复用) |
|---|---|---|---|
| `rollbackUnlaunchedWorkflowAdmission` | 26587 | `unlaunched_admission_rolled_back` | `resume_unlaunched` |
| `escalateUnlaunchedWorkflowStall` | 26749 | `unlaunched_admission_held` | `resume_unlaunched` |
| `escalateWorkflowReworkStall` | 26894 | `rework_activation_stalled_held` | `resume_receipt_deadlock`(**本单退役该写点,形状保留给存量 9 条 held run 中可能存在的历史事件**) |
| `settleWorkflowReworkFailure` | 30539 | `rework_pane_loss_handoff` | `retrigger_replacement` |
| `settleWorkflowReworkFailure` | 30673 | `rework_retry_exhausted` | `resume_rework` |
| `holdCompletedWorkflowExecutionWithoutReceipt` | 37052 | `completion_receipt_missing` | `reconstruct_completion` |
| `rollbackDeadWorkflowNodeExecution` | 37388/37415 | `retry_limit_escalated` / `environment_failure_escalated` | `resume_retry_limit(retry\|terminate)` |
| `commitWorkflowTransitionTx` | 42110 | `loop_limit_escalated` | `resume_loop_limit` |
| `commitWorkflowTransitionTx` | 42196 | `rework_suppressed_idle_spin` | `resume_idle_spin(accept_current_pass\|force_rework)` |
| `holdWorkflowGateOriginProbeTerminal` | 47828/47854 | `workflow_gate_origin_preflight_terminal` | `resume_gate_origin_preflight` |
| `expireWorkflowCarryoverDeparture` | 53545 | `land_held`(有 operation) | `resume_land_operation` |
| `holdWorkflowLandNode` | 56007 | `land_held`(无 operation) | `resume_land_without_operation(retry\|terminate)` |
| 既有 `POST /:runId/hold` | runs-route | `run_held_by_operator` | `resume_run_held_by_operator` |
| carrier `held` / `needs_lead`(delivery 级,不写 run) | — | `carrier_run_inactive` / `carrier_needs_lead` | `revive_carrier` / `redrive_carrier` |
| **本单新增** | hold-writers | `mailbox_inflight_slots_exhausted`、`three_stage_turn_stuck`(CommDB 权威)、`delivery_undeliverable_no_recipient` | `reconcile_mailbox_leases`、`resume_turn_handoff`(CommDB saga)、`resume_undeliverable(reroute_to <exec>\|cancel)` |

砍前 `hold-shape-manifest.json` 19 项与上表一致;砍前把 `carrier_run_inactive`/`carrier_needs_lead` 也算形状(不写 run.status 但阻塞 gate)。**清单守卫**:`hold-mutation-inventory.json` 列出 14+1 处 run held 写点 `{file, symbol, line-anchor comment}`,测试 grep 仓库内 `SET status = 'held'` 的出现集合 == 清单集合(新增写点必须登记形状)。

**existing un-hold 写点**只有两处:`materializeWorkflowReworkReplacement` `:29470`、`resumeHeldLandOperation` `:55786`。生产此刻 9 条 `held` run,其余形状今天只能 SQL 手术(`turn-manual-handoff-runbook.md` 有 2 处 `UPDATE workflow_run` 段)。

## 3. saga 表与迁移

`workflow_delivery_operation` DDL 已在 main(`StateStore.ts:20013`),但 `kind` CHECK 只有 `'resident_expiry'`(留给 FLY-2268),无 writer。生产库(Bridge 仍跑 `68e6a29`)**尚无此表**;#1040 部署后会以该 CHECK 建表。本单需要 `kind IN ('hold_resume','reroute','resident_expiry')`。SQLite 不能 ALTER CHECK,只能重建。方案比较:

| 方案 | 代价 | 取舍 |
|---|---|---|
| A 重建表(`sqlite_master.sql` 不含 `'hold_resume'` 时:`CREATE new → INSERT SELECT → DROP → RENAME`,同事务) | 一次性;行数为 0 或全是 `resident_expiry` 行(FLY-2268 若先上),都能原样搬 | **选**。与 FLY-2248「不重建任何表」不冲突——那是 2248 的承诺,且这张表是 2248 自己新建的空表 |
| B 新表 `workflow_hold_operation` | 多一张表,违反「一张 saga 表」的合并结论 | 否 |
| C 去掉 CHECK 改用测试锁 | 弱化了 2248 R5 建立的 schema 级守卫 | 否 |

A7 型度量:canonical 快照差集 = 0 张新表、0 新列(StateStore);CommDB 0 新对象(投影 SELECT 加两列是查询不是 schema);`workflow_delivery_operation` 的 `sql` 文本变更是唯一 delta,测试逐字断言新 CHECK。episode 表加一列 `deferred_alive_at TEXT`(§1.3)——**唯一新列**,`ALTER TABLE ADD COLUMN` 加法。

## 4. 阳性对照的真实写点(founder「每条修复配真事件流」)

| 修复 | 阳性臂经过的真实写点 | 阴性臂 |
|---|---|---|
| ①mailbox 槽位冻结 | `commands/send.ts` 连发 3 封给同一 running 体(占满 `inflightMaxBatches=3`),`markDelivered` 不 ACK,时钟 +31min,体的 `heartbeat_at` 停在 40 分钟前 | 同上但体 10 分钟内有 `ask`(`hasRecentMessagesFrom` 命中)→ 零 held |
| ①turn 卡住 | `deliverDurableTurnWake` + 真实 `runner-wake.ts` 推两次(`push_count=2`),+21min | 推一次(`push_count=1`)→ 不冻 |
| ②grace | `send.ts` 发信 → 收件体 `completed` 未 ACK → +14min 注入后继 admission(真实 `admitWorkflowNodeExecution` 路径)→ 改派 | +15min 无后继且原体 `absent` → held 一次;原体 `alive` → 不 held、`deferred_alive_at` 落地 |
| ③正门 | 用 `POST /:runId/hold`(既有)造 `run_held_by_operator`,再 `GET holds` → `resume` 两步 | 错 token 403、非 loopback 403、hold 已被别人 resume → 409、重放同 `clientRequestId` → idempotent |
| ④reroute | rework:`advanceWorkflowReworkDelivery` 到 `awaiting_receipt` → 原体 terminal → 后继存在 → 改派后 `contract_ref.pk === request_id`;carrier 同理经 `advanceWorkflowCarrierDelivery` | 第 3 次改派 → operator_required |
| ⑤settle | 三条 settle 入口各一条:carrier 完成经 `completeWorkflowGateRunAfterShip`;launch abandon;projector `run_terminal`(run terminate) | 未 settle 的 attempt 其 episode 不被关 |
| ⑥NaN | `classifyRecipientLiveness` 四格 | grep 守卫 |

## 5. 挂载点与退役

- 维护 tick(`plugin.ts:7439-7462`):`deliveryProjector.runPass → deliveryContractWatch.runPass` 之后加 `deliveryOperations.runPass`(grace/改派/saga 驱动)。watch 仍零写入源表(触发器计数守卫沿用)。
- 退役:`workflow-engine-dispatcher.ts:1129-1262 reconcileWorkflowReworkStalls` 的 `hold` 分支与 `escalateWorkflowReworkStall` 的 `action:'hold'` 路径;env `FLYWHEEL_ENGINE_REWORK_ALERT_MS/_HOLD_MS` 与 `feature-flags/truth.ts` 条目(PR body 三 root 消费者 sweep,FLY-1914 规则)。`alert` 分支:FLY-2248 的 stalled episode 已覆盖 rework 家族 minted/granted/sent 超时,`alert` 分支是重复告警源,一并退役(已向 Lead 提问 (2),按「退役」推进,Lead 若反对则 plan 只退役 hold 分支)。

## 6. 不确定项

1. `three_stage_turn_stuck` 的 CommDB 解冻原语 `resumeTurnWakeHold` / `resumeMailboxInflightHold`(砍前 `db.ts`,-399 行)可原样复活;它们的 receipt 行是 CommDB 内确定性 id,重放判据不变。
2. CLI token 变量:`commands/` 里既有的 run 管理命令用什么变量拿 master token,plan 阶段点名(不新造变量)。
3. 存量 9 条 held run 中,若事件 payload 缺 `reason` 等字段导致 `detectHoldShape` 匹配不上,`GET holds` 会列空——plan 要求 QA 用生产只读快照跑一次 `listWorkflowHolds`,把「匹配不上的 held run」当发现物上报,不在本单扩形状。
