# FLY-2248 通用投递合同 — 实施计划
Issue: FLY-2248 (https://linear.app/geoforge3d/issue/FLY-2248/引擎loop稳定性-通用投递合同-欠条必达超时升级工人常驻收信失联判据先问送达每种冻结配正门覆盖所有-dag-loop非)
日期: 2026-09-02(round 7「实现交接版」(round 6 拆分封顶轮 Codex 仍 CHANGES REQUESTED 1B+2H+1M;Lead 预裁:不再评审,剩余项作为实现节点 RED 测试清单进 §5;本版只做文档收口,零新机制):Lead 裁定 (c) —— M3 工人层拆出至子单,本单保留 M0/M1/M2/M4;本轮只闭合 Codex R5 的 #1/#2/#4/#6,零新表零新告警面)
基于: exploration.md, research.md

## 0. 目标、约束、范围与验收

**目标**:把「送出去了 / 送到了 / 在干了 / 冻住了」四件事从 8 个各自为政的欠条家族里抽成一份通用合同,让判死先问送达,让每种冻结都有官方正门。全部挂在通用对象(欠条 / 转移 / 冻结形状)上,不挂在任何节点对上。

**范围(Lead 2026-09-02 裁定 (c))**:
- **本单**:M0 回放床与守卫、M1 欠条层(attempt 台账 + 阶段时钟 + 投影 + watch + episode)、M2 转移层(判死先问送达、核销解耦、改派 saga、理由词汇)、M4 冻结正门。
- **拆出至子单(M3,工人层)**:常驻收信员 supervisor、durable turn 状态(`three_stage_turn` 加列)、loop 目标常驻宽限(`workflow_resident_hold`、`residentHold.enter/close`、saga kind `resident_expiry`、`runner_shutdown_controls` 主键变更)、完成前清信(`workflow_completion_drain_challenge`、`consume_pending_mail`、`--drain-receipt`)、`loop_park`、`deferred_midturn`。Codex R5 的 #3(shutdown exact-request 读法)与 #5(belt 新行 `turn_generation=1`)随之移交,原文在 `codex-review/round5.md`。本单为子单留的接口见 §2 M3 段。
- 事故覆盖:本单回放 #1、#2、#5、#6,以及 #4 的「minted-stall / 真实 `runner-wake.ts` 成功后推进 sent / episode recovery」半边与 #7 的槽位半边;#3、#4 的「receiver_missing 重武装」半边、#7 的清信半边、#8 由子单回放(Codex R6#3)。founder「每起事故至少一条测试」在两单合计满足,本单 PR body 与子单标题互相引用。

**Lead 裁定(约束,已并入)**:期限常量、不留旋钮、不新增告警层;正门沿用 master token + loopback + confirmToken;实现面不得出现 qa / implement 字样;三项实现面复核(①无节点名硬编码 ②形状与正门一一对应且各有阳性/阴性测试 ③「投递失败 ≠ actor 死」有测试)对应 A1 / A6 / A4;「append-only」与 root/血统定义(§1)照抄。

**验收(全部可机器判)**:
- A1 通用性:`packages/teamlead/src/bridge/delivery-contract/**`、`delivery-operations.ts`、`hold-shape-registry.ts`、`hold-reason.ts` 源码不含 `/\b(qa|implement|design)\b/i`(`fly2248-generality.test.ts`);三条不同边(founder_gate→general、land→cleanup、qa→implement,节点名只出现在 fixture 模板)经同一 `DeliveryContractWatch.runPass` 产生 episode(spy 断言同一函数)。
- A2 回放床:本单 5.5 起事故各 ≥1 条**真实失败**的 `it`;M0 把每条失败输出存 `__tests__/fixtures/fly2248-replay-red/<n>.txt`;RED→GREEN 均有提交记录(`fly2248-replay#<n> RED|GREEN`)。fixture 前置列与预期阶段以 research §5(round 6)为准。
- A4 判死:合同阶段 < received 时,`classifyPhaseActorReentry` 在探针 `alive` 下**不可能**返回 `replace`(24 格穷举);不再写 `rework_activation_stalled_held`、不再因投递状态写 `workflow_run.status='held'`;对照:探针 `dead_pin` 才允许 replace。
- A5 核销:欠条停在 `awaiting_receipt` 的节点提交完成 → 事务成功、欠条 `state='completed'`、attempt 行同事务 set-once `settlement_reason='superseded_by_completion'`(完成后不得存在 live attempt;幂等重放 0 rows changed);对照断言旧 CAS 会 throw;五个负例(stale revision / 同 node-attempt 两张债 / wrong execution / policy-held / 重复 completion)。
- A6 正门:22 种形状各有 fixture:`GET /holds` 返回 `resumable` 与前置条件;阳性 / 阴性各一条;两份清单双向映射;runbook SQL 段被端点替换;`workflow_delivery_operation` saga 两种 kind(hold_resume / reroute)各一套 barrier 崩溃重放,含「CommDB 已 applied 但 StateStore 未回写」的重放(以 CommDB 确定性 row id 为证据)。
- A7 迁移(最简可执行形,StateStore 与 CommDB 各做一遍):副本用 `VACUUM INTO`(`StateStore.ts:2970` 配方;CommDB 对 `comm/flywheel/comm.db` 同法)导出只读快照;canonical 查询固定为 `SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`;(a)该查询 pre→post 差集恰好 = §3 allowlist(表名 + 显式命名的索引名);(b)被改表的 `PRAGMA table_info` 列 delta 恰好 = §3 逐表新列;(c)canonical 快照(上述查询 + 全表 `table_info`)在首次与第二次启动后逐字相同,且两次 `integrity_check=ok`、`foreign_key_check` 空。告警 uid 前缀另做 `fly2248-alert-prefix.test.ts`(集合恰好 = §1 的三个)。
- A8 全仓 `pnpm lint && pnpm build && pnpm test` 通过;CI 在最终 head 上全绿(QA 节点拉 exact-head CI)。

## 1. 稳定标识(实现必须逐字使用)

| 类别 | 标识 |
|---|---|
| 家族 id | `rework` `carrier` `turn_wake` `phase_wake` `mailbox` `launch` `land` `gate_holder` |
| 阶段 id | `minted` `granted` `sent` `received` `consumed` `settled`;终/冻态 `frozen` `superseded` `cancelled` `undeliverable` |
| 期限常量(`delivery-contract/policy.ts`) | `STAGE_DEADLINES_MS = { minted: 600_000, granted: 300_000, sent: 900_000, received: 1_800_000 }`;`SEVERE_MULTIPLIER = 3`;`MAX_REROUTES_PER_ROOT = 2` |
| 合同身份(血统,**Lead 定义 #2**;Lead ruling `cba91770-a352-4f31-8eb1-1635ef1eb369`) | `root_id = '<project>:<issue>:<family>:<root ulid>'`;**root ulid = 源行的业务主键**(rework=`request_id`,carrier=`question_id`,launch=`execution_id`,land=`operation_id`,gate_holder=`question_id`,mailbox=`id`,turn_wake=`wake_id`,phase_wake=`message_id`),记入 `contract_ref_json`。家族命名空间保证共享同一业务主键的不同合同都保持各自独立的 `g1:a1`,不把后铸合同误记为前一合同的重投。**g1 物化规则按 writer 归属分述**:(i)StateStore 家族在铸造事务内同事务写 g1;(ii)**Bridge 内**的 CommDB 写点(mailbox lane、`deliverDurableTurnWake`、`enqueueRunnerPhaseWake` 调用点)的 id 在 INSERT 之前已生成,先写 StateStore g1 attempt 行再写 CommDB 行(attempt-first;发送重试凭同一 id 找回同一 root);(iii)**直接写 CommDB 的 writer**(`flywheel-comm send`、非 Bridge 的 `respond`)不做 attempt-first,其 g1 由 `DeliveryProjector` 从 CommDB 行后补;**child 行带 `root_id` 与 `parent_attempt_id` 回指,不许悬空**(StateStore 内 FK;CommDB child 由测试断言必有对应 attempt 行)。**mailbox 的 `ref_id` 保持原义(response → question 的父引用,`mailbox_unique_response`/`getResponse()`/doorbell/过期协调器都依赖它),不承载 root**:原始 mailbox attempt 的 root 由「per-project CommDB + 收件 session 的 issue + `mailbox.id`」推导;改派 child 的 root/parent 放在 `content`/`metadata` 之外的既有 `source_ref` 字段(`mailbox.source_ref`,当前仅由 `source_kind` 配套使用,格式 `fly2248:<root_id>:<parent_attempt_id>`)。(Codex R6#1 / R7#1) |
| 「append-only」的唯一解释(**Lead 定义 #1,照抄**) | 每个投递 attempt 一行,主键 `(root_id, generation, attempt)`;五个阶段时间戳 `minted_at / granted_at / sent_at / received_at / consumed_at` 各自 set-once:只允许 `UPDATE … SET col=? WHERE col IS NULL`(CAS),已设值不许覆盖、行不许 DELETE;`settlement_reason` 同样 set-once。不加 trigger,用测试锁:二次写同列必须 0 rows changed,DELETE 路径不存在(代码里没有 DELETE 语句,grep 断言)。超时判定 = 对应列 IS NULL 且 age > 常量。`generation` = 血统代(改派/重铸 +1),`attempt` = 同代内第几次经批准的重投(默认 1;例如 FLY-2211 revive 的 kick 重发 +1),push retry 不算 attempt。 |
| attempt 行的物化 id(Codex R5#1) | `attempt_id TEXT NOT NULL UNIQUE` = `'<root_id>:g<generation>:a<attempt>'`,INSERT 时写入、此后不 UPDATE(测试锁);`parent_attempt_id TEXT REFERENCES workflow_delivery_attempt(attempt_id)`(单列 FK,与三列主键解耦) |
| 阶段时钟 | 所有家族的五个阶段列都落在 `workflow_delivery_attempt` 行(set-once);StateStore 家族由各 mutation symbol 同事务写;CommDB 家族由 **投影器**(§2 M1 `DeliveryProjector`,维护 pass 内、watch 之前、幂等)从不可变列回填:turn_wake `first_push_at` / `acked_at`,phase_wake **新增** set-once `first_push_at`(只在 `completeRunnerReceiptWakePush`(`db.ts:3649-3674`)且 `result ∈ {'delivered','verified'}`——这是 `runner-wake.ts:184-203` 生产 caller 的真实成功值——时 `COALESCE(first_push_at, now)`;claim 路径不碰)/ `started_at`,mailbox `COALESCE(notified_at, delivered_at)` / `acked_at`。**禁止** `generation` / `redrive_generation` / `retry_count` / `push_attempts` / `updated_at` / `claim_expires_at` / `last_push_at` / lease 反推 |
| episode_id | `<attempt_id>:<stage>:<stageEnteredAt>`(stageEnteredAt = 该阶段列的值) |
| escalation_uid(恰好三个前缀) | `delivery_contract_stalled:<episode_id>`(severe 追加 `:severe`);`delivery_reroute_outcome:<attempt_id>`(reroute saga 出结果时恰好一次);`delivery_operation_stalled:<operation_id>`;undeliverable **不由 watch 发**;turn_wake 家族不发(沿用 CommDB `turn-wake-alert:<wake_id>`) |
| run event kinds(新增) | `delivery_contract_stalled` `delivery_contract_recovered`(informational)`delivery_contract_baseline` `delivery_rerouted` `delivery_reroute_operator_required` `delivery_operation_stalled` `rework_delivery_superseded_by_completion` `carrier_delivery_superseded_by_completion` `hold_resumed` `hold_resume_refused` `delivery_operation_<barrier>`(staged/applied/sent/projected/failed) |
| 新表(StateStore 3,CommDB 0) | `workflow_delivery_contract_episode` `workflow_delivery_attempt` `workflow_delivery_operation`(父单实现 `hold_resume`、`reroute` 两种 kind;DDL 预留第三种 `resident_expiry` 给子单,父单代码对它只读不写) |
| 新列(CommDB 1) | `runner_phase_wakes.first_push_at TEXT`;StateStore 既有表不加列;`turn_wake_outbox` / `mailbox` 不加列(`mailbox.superseded_by`、`turn_wake_outbox.first_push_at` 已有) |
| hold reason 前缀 | `actor_dead:` `delivery_unconfirmed:` `policy:` |
| reentry 判决词 | `wake` / `replace` / `defer`(现有枚举 `hold` 重命名;唯一消费点 `workflow-rework-coordinator.ts:483-511`) |
| hold shape id(22) | research §4.1 的 21 个 + `delivery_undeliverable_no_recipient` |
| HTTP / CLI | `GET /api/runs/:runId/holds` `POST /api/runs/:runId/resume/stage` `POST /api/runs/:runId/resume`;`flywheel-comm hold list|resume` |
| CommDB 重投的确定性 id(重放证据) | mailbox 新行 `id = '<family>:reroute:<root_id>:g<generation>'`;turn_wake 新行 `wake_id` 同法;phase_wake 新行 `message_id` 同法;重放用 `SELECT … WHERE id|wake_id|message_id = ?` 判 applied |
| 留给子单的接口(本单不实现) | `AdapterExecutionContext.phaseKeepAlive` 形状不动;`runner_phase_wakes.admission_state` 只用既有 `queued`;`workflow_delivery_operation.kind` 预留 `resident_expiry`;attempt 表的 `attempt` 序号供 revive 重发使用 |

## 2. 里程碑

执行顺序 M0 → M1+M2(一个原子部署/回滚组)→ M4 → M5。chunk id `M<n>`。分支 `flywheel-FLY-2248`,最终一个 PR。

### M0 — 回放床与守卫(先 RED,真失败)

- `fly2248-replay.test.ts`:本单 6 个真实 `it`(#1、#2、#4-投影半边、#5、#6、#7-槽位),`seedIncident(n)` 用 research §5(round 6)规定的前置列;失败输出存 `fixtures/fly2248-replay-red/<n>.txt`。#2 从「初始无 episode、mailbox 行首次投影即 undeliverable」回放。
- `fly2248-generality.test.ts`(A1);`fly2248-alert-prefix.test.ts`(A7 附)。
- 两份清单 + 双向测试(`fly2248-hold-inventory.test.ts`):`hold-mutation-inventory.json` `{store, table, file, symbol, mutationKind, shapeIds}`;`hold-shape-manifest.json` `{id, detectOwner, resumeOwner, authoritativeStore, decisions?}`;导出符号 allowlist 守卫(held/needs_lead/frozen 写 SQL 只允许在 `hold-writers.ts`;既有 14 处初版以 `// hold-writer: <shapeId>` 标注豁免,M4 收拢)。
- attempt 表锁测试:同列二次写 0 rows changed;`attempt_id` 不可 UPDATE;仓库内无针对该表的 DELETE 语句(grep);dangling child(`parent_attempt_id` 指向不存在的 attempt)被 FK 拒绝;CommDB child 行 `root_id` 无对应 attempt 行时测试失败。
- `fixtures/workflow-loop-edges.json`:三种边的最小模板(loop 目标节点名任意)。

### M1 — 欠条层:attempt 血统表 + 阶段时钟 + 投影器 + watch + episode

- **`workflow_delivery_attempt`(StateStore;Lead 定义 #1/#2;Codex R5#1)**:`(root_id, generation, attempt, attempt_id TEXT NOT NULL UNIQUE, family, contract_ref_json, parent_attempt_id TEXT REFERENCES workflow_delivery_attempt(attempt_id), minted_at, granted_at, sent_at, received_at, consumed_at, settlement_reason, superseded_by_attempt_id TEXT REFERENCES workflow_delivery_attempt(attempt_id))`,主键 `(root_id, generation, attempt)`;唯一部分索引 `idx_wda_live_by_root (root_id) WHERE superseded_by_attempt_id IS NULL AND settlement_reason IS NULL`。所有阶段列与 `settlement_reason` set-once;无 trigger,测试锁见 M0。
- **StateStore 家族的写点(同事务,按真实状态转移)**:

| 家族 | 铸 attempt(g1,写 minted_at) | granted_at | sent_at | received_at | consumed_at | settlement_reason |
|---|---|---|---|---|---|---|
| rework | 四个铸造点(`StateStore.ts:33780,34688,41336,42657`)与每次 route revision 重铸 | **仅** `advanceWorkflowReworkDelivery` 的 `pending → turn_granted` 成功分支(`:30521-30590`);`markWorkflowReworkGrantStarted`(`:30492`)**不写** | `advanceWorkflowReworkDelivery` `→ awaiting_receipt` | `recordWorkflowReworkWakeReceipt`(`:28586`);`markWorkflowReworkReplacementLaunched`(`:29629`,`replacement_pending → wake_delivered`,写 received,同时若无 sent 则 sent=received) | `/api/stage` 首个 `stage set`;phase wake `started` 投影 | `settleReworkDeliveryOnCompletionTx`(M2) |
| carrier | 铸造点与 redrive | `advanceWorkflowCarrierDelivery` `→ grant_started/turn_granted`(`:47699-47730`) | `→ awaiting_receipt` | `recordWorkflowCarrierWakeReceipt`(`:47787-47827`,`awaiting_receipt → receipt_started`):**同一回执同时写 received_at 与 consumed_at**(`consumedEvidence='observed'`) | 同左 | land 完成 settle |
| launch | admission(`workflow_execution_binding.bound_at`) | = 铸造 | `workflow_side_effect_ledger.started_at` 写入处 | `committed_at` 写入处 | 该 execution 首个 `session_events` 业务事件处 | = consumed |
| land | `land_operation` intent 创建 | — | = 铸造(intent 即 sent) | 首条 `land_operation_step` receipt 写入处 | — | `finalization_completed_at` 写入处 |
| gate_holder | `question_intent` | `question_written` 落地处 | `session_bound` / `card_posted` 落地处 | `card_bound` 落地处 | — | `completed` |

- **CommDB 家族与双向崩溃矩阵(Codex R5#2)**:
  - 顺序(仅 Bridge 内写点):mailbox lane / `deliverDurableTurnWake` / 既有 `enqueueRunnerPhaseWake` 调用点在写 CommDB 行**之前**先写 StateStore g1 attempt 行(`minted_at`,`root_id` 由业务主键推导——写入前已知),CommDB 行带 root(mailbox `source_ref`;turn_wake `envelope_json.rootId`;phase_wake `metadata_json.rootId`)。**非 Bridge writer**(`commands/send.ts:18-36` 直接开 CommDB 写 instruction;`commands/respond.ts:37-40,98-135` 走本地 `insertGuardedResponse`,response id 在 CommDB 事务内才生成)**不做 attempt-first**,它们的 g1 全部由窗口 B 的 projector 补(Codex R6#1)。
  - **窗口 A(attempt 已提交、CommDB 行未插入)**:发送重试**必须先按 `root_id` 查 live attempt**(`idx_wda_live_by_root`),命中即复用该 g1 intent,不再铸新 root;若始终未重试,attempt 停在 minted → 10 分钟后 stalled 告警(这正是「一份交接从未真正发出」的正确可见性)。
  - **窗口 B(CommDB 行已提交、attempt 未写 / 阶段列未回填)**:由 **`DeliveryProjector`**(`delivery-contract/projector.ts`,维护 pass 内、watch 之前、每 tick、幂等)补齐——扫描 CommDB 家族的 runner 收件行(不要求行带 root):无 attempt 行 → 按主键 INSERT g1,**`minted_at` 取 CommDB 行的不可变创建时间(`created_at` / `queued_at`),`family` 由表名、`project`/`issue` 由 per-project DB 与收件 session 的 issue、`contract_ref_json` = {table, pk} 推导**(Codex R6#2);有 attempt 行 → 从不可变列 set-once 回填 `sent_at/received_at/consumed_at`。**CommDB 家族的 source 以 attempt 表为驱动、LEFT JOIN 物理 IOU 行**:物理行不存在(窗口 A 未重试)时 attempt 仍被枚举,停在 minted 并在 10 分钟后开 stalled episode(orphan attempt 可观察)。projector 是 attempt 表在 CommDB 家族上的**唯一持续写者**;watch 仍零写入。boot pass 的 baseline 只负责部署前已 open 的 StateStore 家族行(rework/carrier/launch/land/gate_holder → g1 + 当前 state 对应列 = boot 时刻,事件 `delivery_contract_baseline`,一次性)。
  - 测试:(A)attempt 有、CommDB 无:重试复用 g1、无第二 root;**不重试时 watch 从 attempt 枚举出 minted-stall episode**;(B)CommDB 有、attempt 无:projector 从真实 CommDB 行完整重建 g1(`minted_at` = 行创建时间),第二次 pass 0 rows;CommDB 列已提交、attempt 列空 → 回填且二次 0 rows;经真实 `commands/send.ts` 与非 Bridge `commands/respond.ts` 写入的行也被 projector 接住,且 response 的 `ref_id` 仍等于 question id(Codex R6#1/#2)。
- **「无时间即未进入」**:phase wake `first_push_at` 空 = minted;mailbox `notified_at`/`delivered_at` 皆空 = minted;rework 无 `granted_at` = minted。
- 目录 `delivery-contract/`:`types.ts`、`policy.ts`、`sources/*.ts`(只读;source 把 `superseded_by_attempt_id` 非空或 mailbox `superseded_by` 非空的行映射为 `terminal='superseded'`)、`projector.ts`、`classify.ts`、`watch.ts`。mailbox source 规则:runner 收件人;终态收件人未 ACK → `undeliverable`;`DEAD` → `undeliverable`;slot 满 → `frozen(mailbox_inflight_slots_exhausted)`。
- **完整转移表**(14 行):`undeliverable + 无 open → open undeliverable episode(不告警,交 rerouter)`;`undeliverable + open(stalled) → close(terminal:undeliverable) + open undeliverable`;`undeliverable + open(undeliverable) → none`;`settled/superseded/cancelled + 无 open → none`;`… + open → close`;`frozen + 无 open → none`;`frozen + open → close(frozen:<shape>)`;`advanced` / `regressed` / `reminted` / `disappeared`;rerouter 成功后原 episode close(`rerouted`)。唯一开放索引 `idx_wdce_open_by_root (family, root_id) WHERE closed_at IS NULL`;同 tick close-before-open 同一事务。
- `watch.runPass(now)`:遍历 → classify → episode + `enqueueWorkflowEngineAlert`(仅 stalled/severe);turn_wake observe-only;**零写入源表与 attempt 表**(触发器计数)。
- 挂载:`plugin.ts:7288-7310` 维护 tick:`codexSessionReowner.runPass` → baseline(仅 boot)→ `deliveryProjector.runPass` → `deliveryContractWatch.runPass` → `deliveryOperations.runPass`。
- 退役(与 M2 同组):`workflow-engine-dispatcher.ts:1129-1262` 删除;`FLYWHEEL_ENGINE_REWORK_ALERT_MS/_HOLD_MS` 及 registry 条目删除(PR body 三 root sweep)。

测试:每家族映射穷举(含「无时间即未进入」);转移表 14 行;baseline 一次性;projector 幂等与双向崩溃矩阵;claim/release/retry/push-retry 不动时钟(push 测试经 `runner-wake.ts` 真实调用链,不直接向 DB helper 注入);第二轮 generation 时钟归零;watch 集成 replay #1、#4、#7 slot 半边;负向:零写入、同 episode 1 alert + 1 severe、turn_wake 零 alert、undeliverable 零 alert。

### M2 — 转移层:判死先问送达、核销解耦、改派 saga、理由词汇(与 M1 同组)

- `hold-reason.ts` + `last_error` 读点 sweep(`workflow-engine-dispatcher.ts:845-930`、`StateStore.ts:29246-29251`、`patrol-loop-ledger.ts:264-285`、runbook 附录)。
- `phase-actor-reentry.ts`:`hold` → `defer`;加 `delivery: { stage, receivedAt?, consumedAt? }`;规则表 research §3.1;`actor_alive_after_receipt` → `alive_not_consuming`。
- `escalateWorkflowReworkStall` 整函数删除。
- 核销(精确):`settleReworkDeliveryOnCompletionTx({requestId: activePath.request_id, runId, nodeId, attempt, executionId, activationId, completionEventUid})`:复核 route revision target node/attempt 与 preferred actor ∈ 本 activation;`wake_delivered` → `completed` + attempt set-once `settlement_reason='settled'`;`pending|turn_granted|awaiting_receipt|replacement_pending` → `completed` + attempt 同事务 set-once `settlement_reason='superseded_by_completion'` + 事件;`held|needs_lead` → 不核销、不 throw、交正门;0 行只在同 `completionEventUid` 幂等重放时成功。carrier 同款 `settleCarrierDeliveryOnLandCompletionTx(questionId)`。
- **改派(`delivery-operations.ts`,`kind='reroute'`)**:骑同一维护 tick,在 watch 之后消费 open 的 `undeliverable` episode:
  - ① StateStore 事务:`workflow_delivery_operation(kind='reroute', family, root_id, generation = 该 root 现有 attempt 最大 generation + 1, source_attempt_id, target_activation_id, client_request_id = '<family>:reroute:<root_id>:g<gen>', state='staged')`;同时铸新 attempt 行(generation+1、attempt 1,`parent_attempt_id` = 旧 attempt_id,`minted_at=now`,其余时钟空)并把旧 attempt `superseded_by_attempt_id` 指向它;root 行按定义 #2 一定已存在(缺失 = 违反 g1 物化规则,fail-closed 记 `delivery_operation_failed`,不自造 root);`generation > MAX_REROUTES_PER_ROOT + 1` 或无当前活 activation → 不 stage,开 hold shape `delivery_undeliverable_no_recipient` + 事件 `delivery_reroute_operator_required` + 恰好一次 `delivery_reroute_outcome:<attempt_id>` 告警。
  - ② 权威存储侧(带 `root_id` + `generation` + `target_activation_id` fence):rework → `appendWorkflowReworkRouteRevision` 指向当前 activation 的 execution,delivery 行回 `pending`(同一 StateStore 事务即 `applied`);carrier → 系统级内部原语 `redriveWorkflowCarrierDeliverySystemTx({questionId, rootId, generation, targetActivationId})`(无 `principal:'master'`;`:47296` 正门不动);mailbox / phase_wake / turn_wake → CommDB 自己的事务:`INSERT OR IGNORE` 新行(确定性 id;**mailbox child 保留原 response `ref_id` 语义,root/parent 只进 `source_ref`(`fly2248:<root_id>:<parent_attempt_id>`);turn_wake 进 `envelope_json.rootId/parentAttemptId`,phase_wake 进 `metadata_json.rootId/parentAttemptId`**)、原行 cancel(mailbox `superseded_by`;turn_wake `cancel_reason='rerouted:<attempt_id>'`;phase wake `finished` + `t2_result='rerouted:<attempt_id>'`),回写 `applied`。重放判据 = CommDB 内确定性 id 存在。
  - ③ 投递经既有 durable outbox → `sent`;④ 投影 `delivery_rerouted{root, from, to, generation}`、原 episode close(`rerouted`)、恰好一次 `delivery_reroute_outcome:<attempt_id>` 告警 → `projected`。
  - saga 自身超过 `3 × STAGE_DEADLINES_MS.sent` 仍非 projected/failed → 一次 `delivery_operation_stalled:<operation_id>` 告警。
- `HeartbeatService.ts:1922-1933` `isBeyondParkedStale` 接收 `deliveryStage`,< received 时返回 false。

测试:replay #2(无 episode → open undeliverable → reroute:新收件人 durable 行(确定性 id)+ ACK、旧行 cancel/superseded、新 attempt 时钟从 minted 起算、episode `rerouted`、恰好一条 outcome 告警;第 3 次改派转 operator_required 且恰好一条告警)、#5、#6(+五负例);24 格穷举;saga barrier 崩溃重放含「CommDB 已 INSERT 但 StateStore 未回写 applied」;hold-reason sweep 每读点一条。

### M3 — 工人层(已拆出至子单 FLY-2268;全文原样在 `engineering/doc/FLY-2268-worker-resident-receiver/plan.md`;本段只写接口与移交清单)

- 子单范围:`ResidentReceiverSupervisor`(receiver 唯一 owner、心跳 rider、`receiver_stalled` 告警)、durable turn 状态(`three_stage_turn` 加 `active_turn_id`/`turn_generation`,`onTurnStarted/onTurnCompleted`,`deferred_midturn` + `turn_generation` 列)、loop 目标常驻(`isLoopTargetNode`、`loopTarget` 贯穿、`workflow_resident_hold`、`residentHold.enter/close`、saga kind `resident_expiry`、`runner_shutdown_controls` 主键改 `(execution_id, request_id)` + `settlement_reason`)、Claude `loop_park`、完成前清信(`workflow_completion_drain_challenge`、`completionBusinessDigest`、`consume_pending_mail`、`--drain-receipt`)、R1 `turn/steer` 探测。
- 随之移交的 Codex 未过项:R5#3(shutdown exact-request 读法与 runtime 多 pending 规则,`db.ts:4240-4306`、`codex-phase-lifecycle.ts:287-292,493-520`、`codex-phase-shutdown.ts:207-241`、`land-cleanup-opportunity.ts:33-48`)、R5#5(belt 新行 INSERT 写 `turn_generation=1`,`db.ts:4622-4634,4704-4718`)。原文 `codex-review/round5.md`;子单 exploration 直接引用本单 research §2 与 plan round 5(git 历史 `0dac08247`)。
- 本单留下的接口:attempt 表 `attempt` 序号(revive 重发 +1);`workflow_delivery_operation.kind` 预留 `resident_expiry`;`runner_phase_wakes.admission_state` 只用 `queued`;`phaseKeepAlive` 形状不动(`Blueprint.ts:1625-1634` 的 role 分支**本单不改**,由子单换成 `loopTarget`)。

### M4 — 冻结正门:注册表 + 一扇门 + CLI + runbook

- `hold-shape-registry.ts`(22 形状,`authoritativeStore`);`hold-writers.ts` 集中所有 held/needs_lead/frozen 写 SQL。
- 效果边界:20 个 StateStore 形状一个事务 + 独立短事务写 refused;2 个 CommDB 形状(`mailbox_inflight_slots_exhausted`、`three_stage_turn_stuck`)走 `workflow_delivery_operation(kind='hold_resume')`(staged → CommDB 自己事务 CAS,重放证据为 CommDB 内确定性 receipt 行/状态 → 既有 outbox 投递 → 幂等投影),与 reroute 共用同一张表、同一 barrier 语义、同一重放测试骨架。
- 新事务函数:`resumeReceiptDeadlockTx`、`repairReplacementLeakTx`、`resumeRunHeldByOperatorTx`、`resumeUnlaunchedHeldTx`、`resumeCompletionReceiptMissingTx`、`resumeRetryLimitTx(decision)`、`resumeIdleSpinTx(decision)`、`resumeGateOriginPreflightTx`、`resumeLandNoOperationTx(decision)`、`resumeUndeliverableNoRecipientTx(decision: reroute_to <execution> | cancel)`(复用 reroute saga,operator 决策豁免上限一次)。任何 run 解冻都调 `reviveHeldWorkflowCarrierDeliveriesTx`。
- `StateStore.ts:34237-34242` 扫描名单补齐;`getWorkflowRunDiagnostic.latest_hold_reason` 改读注册表。
- 路由 `hold-routes.ts`(骨架复制 `workflow-carrier-redrive-routes.ts:262-283`);CLI `commands/hold.ts`。
- runbook 附录 A/B 与 `turn-manual-handoff-runbook.md` SQL 段替换为 `hold resume --shape …`。

测试:22 形状 × {detect, 阳性, 阴性};saga barrier 崩溃重放(两种 kind);路由 403/401/409/幂等;CLI 端到端。

### M5 — 收口

- `engineering/doc/milestones/FLY-2248.md`;`doc/engineer/implementation/delivery-contract.md`。
- PR body:变更摘要、测试计划、消费者 sweep(env 删除 + `last_error` 读点 + `state != 'completed'` 读点)、A7 度量、Linear 链接(本单 + 子单)。

## 3. Schema 与迁移(**StateStore 全加法:只加表;CommDB 只加 1 列;不改 CHECK,不重建任何表**)

**StateStore 新对象 allowlist(A7a)**:

| 表 | DDL | 索引 / 约束 |
|---|---|---|
| `workflow_delivery_contract_episode` | `(episode_id PK, family, root_id, attempt_id, run_id, stage, stage_entered_at, opened_at, alerted_at, severe_alerted_at, closed_at, closed_reason, escalation_uid)` | 唯一部分 `idx_wdce_open_by_root (family, root_id) WHERE closed_at IS NULL` |
| `workflow_delivery_attempt` | 见 M1 | 主键 `(root_id, generation, attempt)`;`attempt_id` UNIQUE;单列 FK `parent_attempt_id` / `superseded_by_attempt_id` → `attempt_id`;唯一部分 `idx_wda_live_by_root (root_id) WHERE superseded_by_attempt_id IS NULL AND settlement_reason IS NULL` |
| `workflow_delivery_operation` | `(operation_id PK, kind IN ('hold_resume','reroute','resident_expiry'), run_id, family, root_id, generation, shape_id, hold_event_uid, source_attempt_id, target_activation_id, client_request_id UNIQUE, canonical_digest, state IN ('staged','applied','sent','projected','failed'), last_error, created_at, updated_at)` | 唯一 `idx_wdo_client_request (client_request_id)` |

**StateStore 被改表的列 delta(A7b)**:无。

**CommDB**:新对象 0;`runner_phase_wakes` `ADD COLUMN first_push_at TEXT`;`workflow_run_event.kind` 白名单追加 §1 kinds(StateStore,非 schema)。

- **不新增欠条 state 值**;`state != 'completed'` 读点(`:8890`、`:8940`、`:47351-47368`)语义不变,仍列入 sweep。
- 降级承诺:旧二进制读新库不崩、把新表/新列当不存在;不承诺功能等价。

**3 张新表的自证(Lead 要求:每张一行「为什么不能是现有表的列」)**:

| 新表 | 为什么不能是现有表的列 |
|---|---|
| `workflow_delivery_contract_episode` | 一条 episode 是「某张欠条在某阶段的一次卡住」,一张欠条一生可有多条、跨 8 个家族同一形状;现有欠条表每家族一张、每合同一行,若加列就得在 8 张表(3 张在 CommDB)各加一套 opened/alerted/severe/closed 列——exploration §4.1 拒绝的「镜像词汇」。 |
| `workflow_delivery_attempt` | 血统 + set-once 阶段时钟需要「每一代一行、旧代不可改」;rework 唯一的代际表 `workflow_rework_route_revision` 被触发器禁止 UPDATE,放不下 set-once 列;carrier / land / gate_holder 没有代际表;turn_wake / phase_wake / mailbox 的行在另一本账(CommDB)。只有一张跨家族的 append-only 台账能同时承载 generation 与时钟。 |
| `workflow_delivery_operation` | 两种跨库动作(改派 / 正门恢复)共用一张 saga 表已是合并结果;现有 outbox 都单用途且不跨 barrier(`workflow_alert_outbox` 只投告警,`workflow_carrier_redrive_receipt` 只记正门回执),没有 `client_request_id` 唯一约束与四段状态。再合并只能并进 episode 表,而 episode 是只读观察、operation 是写侧动作,合并会让 watch 的「零写入」守卫失效。 |

## 4. 回滚边界

- M1+M2 原子部署/回滚组。
- M4 revert:路由/CLI 消失,runbook 回到 SQL 版。
- schema 全加法(StateStore 3 表、CommDB 1 列),revert 不需数据迁移。

## 5. 负向守卫(必须有对应测试)

1. watch 对任何源表与 attempt 表零写入(触发器计数);projector 只写 attempt 表且二次运行 0 rows。
2. 阶段 < received 时任何路径不得 `replace`、不得写 run/delivery held 或对应事件(允许 transient `defer`)。
3. saga(两种 kind):前置失败 → 零写入(除独立短事务 refused);重放不重复 side effect(CommDB 确定性 id);第 3 次改派转 operator_required;每条路径恰好一条 outcome 告警。
4. 正门只接受 loopback + master token + 一次性 confirmToken;重放幂等。
5. 新模块源码不含节点名字面量;期限只以常量出现。
6. 迁移:A7 (a)–(c) 全部成立(StateStore 与 CommDB)。
7. attempt 表:同列二次写 0 rows;`attempt_id` 不可 UPDATE;无 DELETE 语句;dangling child 被 FK/测试拒绝;claim/release/retry/push-retry 不改任何阶段列;baseline 只发生一次;改派后新 attempt 时钟从 minted 起算;push claim 后崩溃仍为 minted。
8. **机制守卫(Lead 收口规则)**:PR 新增的表恰好 3 张(StateStore)、CommDB 0 张;新列恰好 1 个(CommDB);新告警 uid 前缀恰好 3 个;A7(a)(b) 的 allowlist 测试与 `fly2248-alert-prefix.test.ts` 即此守卫。

## 5A. 实现节点 RED 测试清单(Lead 2026-09-02 预裁:R6 封顶复审未过 → 不再评审,剩余项以 RED 测试形式交实现节点)

Codex round 6(`codex-review/round6.md`)四项,已按下列方式落进本 plan,实现节点必须先写 RED 再转 GREEN,PR body 逐条引用:

| # | Codex 项 | 本 plan 落点 | RED 测试(实现节点必须先失败) |
|---|---|---|---|
| R6#1 [B] | mailbox `ref_id` 不能承载 root;`send`/`respond` 不经 Bridge | §1 合同身份行;M1 CommDB 顺序段 | (a)经真实 `commands/send.ts` 写入的 instruction 行下一 tick 有 g1 attempt;(b)经非 Bridge `commands/respond.ts` 写入的 response 行同上,且 `ref_id === question.id`、`mailbox_unique_response` 不被破坏;(c)改派 child 的 root/parent 在 `source_ref`,`getResponse()` 行为不变 |
| R6#2 [H] | 窗口 A orphan attempt 不可观察;窗口 B 的 g1 缺 minted_at/family/project 来源 | M1 窗口 A/B 段 | (a)attempt 有、CommDB 无、不重试 → watch 从 attempt 表枚举出 `minted` stalled episode;(b)projector 从真实 CommDB 行重建 g1,`minted_at` = 行 `created_at`/`queued_at`,`contract_ref_json` = {table, pk},第二次 pass 0 rows |
| R6#3 [H] | replay #4 依赖已移出的 supervisor | §0 事故覆盖;M0 | 父单 #4 只断言 minted-stall、真实 `runner-wake.ts` 成功后 `first_push_at` 落地 → sent、episode `advanced`;不引用 `resident-receiver-supervisor.ts`(generality 扫描文件集合不含它) |
| R6#4 [M] | research 残留旧合同(episode DDL 注释、launch consumed 联结、settlement_reason 归属、operation kind 数) | research §1.4/§1.5/§3.2;plan §1 新表行 | 文档一致性测试:从 research §5 fixture 列与 plan §1/§3 生成的 expected 相同(`fly2248-doc-consistency.test.ts`) |

## 6. 显示文案(Lead 收到的样子)

- `delivery_contract_stalled`:「<issue> 一份交接卡在「<阶段中文>」<N> 分钟(<家族中文>)」+ 边、对方 execution 前 8 位、阶段进入时刻、「这不是判死;查看 `flywheel-comm hold list --run <id>`」。
- `delivery_reroute_outcome`(唯一的 undeliverable 用户可见告警,由 saga 发):改派时「收件人已终结,已改派给 <exec8>(第 k 次)」;需人工时「收件人已终结且无可证明的后继(或改派已达 2 次),需要正门决策:`hold resume --shape delivery_undeliverable_no_recipient`」。
- `delivery_operation_stalled`:「一次自动改派/恢复卡在 <barrier> 超过 <N> 分钟,查看 `hold list`」。
- 阶段/家族中文同前;文案进 `alert-kind-copy.ts`。

## 7. progress.md chunk 约定

`--set-chunk M0=…|M1=…|M2=…|M4=…|M5=…`,状态 `pending|red|green|reviewed`;GREEN 后先 push 再更新 chunk。

## 8. 不做

- M3 工人层(见 §2 M3 段)——子单。
- 不改 codex 官方二进制。
- 不改 mailbox 关系/新鲜度模型(FLY-1792)。
- 不改 FLY-2211 reown 判死判据。
- 不给 Lead↔Lead 信件加合同。
- 不新增 feature flag、env 旋钮、告警层、欠条 state 值、第二张 saga 表、欠条表新列、任何 CommDB 表重建。
- 不在本单修 land 执行器内部吞错(FLY-2246 子单)。
