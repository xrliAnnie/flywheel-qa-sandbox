# FLY-1795 runner lane ACK 饿死 — 调研

Issue: FLY-1795 (https://linear.app/geoforge3d/issue/FLY-1795/消息层bug-某个-runner-lane-的收件永不-ack-3-个-in-flight-槽被占死后续指令按租约每-10)
日期: 2026-08-19
基于: exploration.md

## 1. 现状代码地图(全部实核于本分支 `ff0fa64f4`)

### 1.1 mailbox 状态机与关键列

`packages/flywheel-comm/src/mailbox-schema.ts:79` — `state ∈ {QUEUED, LEASED, ACKED, DEAD}`;载重列:`claimed_by / claim_expires_at / batch_id / delivered_at / notified_at / lease_retry_count / retry_count / acked_at / dead_reason / priority / collapse_key`。投影视图 `mailbox_message_projection`:`read_at = CASE WHEN state='ACKED' THEN acked_at END`(`mailbox_projection_delivered_on_ack_v2`)。

### 1.2 runner lane 全链

```
Lead: flywheel-comm send → mailbox(QUEUED, to_agent=execId, recipient_kind='runner')
Bridge: RunnerMailboxLane.tick()(lead-inbox-runtime.ts:245 挂在 leadIndex===0 的 admit rider 上)
  → claim 攒批(mailbox-queue.ts:1102 head 查询;in-flight 门 = 活跃 LEASED 批 <3,delivered_at 非空才计)
  → 976/1191 行 UPDATE SET state='LEASED', batch_id=?, claimed_by=ownerEpoch
  → renderRunnerMailboxBatchEnvelope(runner-mailbox-lane.ts:156)拼 envelope,文本自带
    "You must ack this batch (run 'flywheel-comm inbox --exec-id …')"
  → runnerAdapter.deliver(envelope)(Claude=Agent Team 邮箱;Codex=doorbell)
  → 成功 → recordRunnerBatchDelivered(mailbox-queue.ts:1382)stamp delivered_at + 续 claim_expires_at
ACK(唯一路径 = runner 模型自愿跑 CLI):
  flywheel-comm inbox --exec-id(commands/inbox.ts:17)
  → getUnreadInstructions(db.ts:47 UNREAD_INSTRUCTIONS_SQL: state IN ('QUEUED','LEASED') AND read_at IS NULL)
  → 逐条 markInstructionRead → MailboxQueue.ack()(mailbox-queue.ts:2306)
租约回收: reconcileExpiredLeases(mailbox-queue.ts:1497)
  → 未投过 → frozenResend;lease_retry_count≥3 → DEAD('lease_expired_unacked')
  → 否则 requeue(1722-1731 行): state='QUEUED', lease_retry_count+1, batch_id=NULL,
     notified_at=NULL, **delivered_at=NULL**
```

关键事实:
* **PostToolUse hook 不 ack**:`scripts/hooks/inbox-check.sh:48-56` — mailbox sentinel(FLY-142 默认)在场时 no-op。sentinel 不在的 legacy 回退才会裸 SQL ACK(86 行,QUEUED+LEASED 通吃、不写 delivered_at)。
* **Stop hook 已存在**:`scripts/hooks/runner-stop-notify.sh`(FLY-1571 turn-end reporter),env 里有 `FLYWHEEL_EXEC_ID` + `FLYWHEEL_COMM_DB`,codex 分支已跑第二条腿(`runner-wake-sweep`)。**机械 ack 的天然落点。**
* `flywheel-comm ask` / 报告路径不 ack 任何 instruction 行 — 「执行了但没 ACK」结构上必然可发生。
* `check` 命令(`commands/check.ts`)走 `consumeGateResponse`/`getResponse`,不经 `MailboxQueue.ack()`;response 类 wake 行同样只能靠 CLI 拉取或(修后)机械 ack 结算。

### 1.3 lead lane ACK 全链

```
Lead 模型: flywheel_inbox_ack_batch(claude MCP)/ lead_actions.ack_batch(codex)
  → handleBatchAck(inbox-mcp/delivery.ts:119)→ insertBatchAckReceipt(db.ts:1671)
  → mailbox 再入一行 {to_agent:'bridge', recipient_kind:'bridge', type:'ack_batch', msg_class:'protocol'}
Bridge: 该 Lead 的 LeadInboxLoop.tick(active 1s / idle 更长)
  → claimBridgeProtocol(fromAgent=leadId)逐行排干(lead-inbox-loop.ts:290)
  → ProtocolIngress.handle(protocol-ingress.ts:57)→ ackBatchByRecipient(mailbox-queue.ts:1453)
```

`ackBatchByRecipient` 的三个静默出口:
1. `rows.length===0` → `ack_late_noop`(1466 行)— **requeue 把 batch_id 置 NULL 后必然命中**;
2. 有非 ACKED 非 LEASED 行(即 QUEUED)→ `ack_late_noop`(1474 行);
3. UPDATE 只写 `WHERE state='LEASED'`,changes 不等 → `ack_late_noop`(1484 行)。

Lead 每次收到重投会再 ack ⇒ 终有一次命中 LEASED 窗口 ⇒ 表现为延迟结算(Cass ~3min 自愈);runner 不重 ack ⇒ 永不自愈。

### 1.4 无护栏 ack 面清单(静默丢弃路径)

| 面 | 位置 | 缺陷 |
|---|---|---|
| 单行 `ack()` | `mailbox-queue.ts:2306` | `state IN ('QUEUED','LEASED')` 无投递证据;不写 delivered_at;无调用方身份 |
| legacy hook 裸 SQL | `inbox-check.sh:86` | 同上,且绕过 MailboxQueue(签名:单条 `id IN (...)` UPDATE,全行 acked_at 相同) |
| `ackBatch()` | `mailbox-queue.ts:2318` | owner 校验齐,但同样无投递证据审计 |
| bridge 协议行自 ack | `lead-inbox-loop.ts:305` | 合法(drain 即消费),但同样进 `ack()`,修护栏时须豁免/自证 |
| `consumeGateResponse` | `db.ts:4193`(`check` CLI / blocking gate 轮询) | 合法拉取式消费,但经无护栏 `ack()`、不 stamp delivered_at ⇒ 与静默丢弃同形(2026-08-19 23:30:03.956 生产实锤:runner 自己的 founder_review gate 轮询消费,曾被误读为「另一个自动 acker」) |
| `ackInstructionRead` | `db.ts:4222`(inbox-mcp `flywheel_inbox_ack`) | Lead 显式确认面,经同一 `ack()`,同样缺 via |
| phase-wake durable-accept 自动 ack | `db.ts:2897`(codex phase-hold watcher 非-batch 腿,`codex-phase-lifecycle.ts:393`) | 同事务把内容 durable 写入 `runner_phase_wakes` = 投递成立,ack 合法;但直接 UPDATE 不经 `ack()`、无 via / delivered_at,且 `state IN` 含 ACKED 幂等。仅 codex phase-hold + 单条绑定 envelope 生效,batch envelope(`flywheelId='mailbox-batch:…'`)走 doorbell 永不结算 |

**runner-lane acker 全谱(至此收口)**:instruction 行 = ①模型自愿 `inbox` CLI ②legacy hook(sentinel 缺席时)③codex phase-hold durable-accept(仅该形态)——现代 Claude tmux runner 在 sentinel-active 下只剩①,即结构性无机械面;response 行 = ①/② + `check`/gate 轮询 `consumeGateResponse`。这份清单是 Fix C「全部调用点显式 via」的完整枚举依据。

8-19 23:45「5 条 QUEUED、delivered_at 空、7ms 批量 ACK」已裁定(exploration §2.3b/§2.3c):5 个 `acked_at` 逐行递增(.279-.286)= `inbox` CLI 逐行循环签名(hook 是单条 `id IN (...)` UPDATE,时间戳必全同);runner 证词确认它在 `inbox` 输出里首次看见这些 id ⇒ **这是 pull 投递,不是静默丢弃** — 「从未送出」是 `delivered_at` push-only 漏记造成的误读。教训落进设计:pull 盖投递章 + `acked_via` 让这类问题一条查询出答案,不再需要跨三个 Lead 的多轮取证。

### 1.5 观测断层

* `mailbox_log` 现存写入点仅 2:`mailbox-queue.ts:2599`('archived')、`db.ts:2783`('progress' artifact 审计)。settlement 写入器(pre-#808 `recordSettlement`,旧 2199 行)随 FLY-1645 receipt-ledger teardown 删除;**表还在、append-only 触发器还在(no_update/no_delete,mailbox-schema.ts:201-206),但状态迁移零记录**。
* 迁移日志若复用 `mailbox_log` 需绕 append-only 触发器做保留期清理 → 违背该表语义。**结论:新表。**
* 死信通知已有成熟范式:`scanAndInsertDeadLetterNotices`(`mailbox-queue.ts:1755`)→ `dead_letter_notice` 行发给 owning Lead,30min 窗聚合 + 游标防重;由 `lead-inbox-runtime.ts:321` 的 admit rider 驱动(`reconcileDeadLetterAlertIntents` + `drainDeadLetterAlerts`),零独立 timer。**dwell 告警照此克隆。**

### 1.6 配置现状

`packages/teamlead/src/bridge/mailbox-queue-config.ts:16-20`:`ackLeaseMs=1_800_000(30min)/ batchWindowMs=30_000 / inflightMaxBatches=3 / leaseRetryMax=3`(FLY-1751 定的 10 条/30s 攒批也在此)。8-15 事故时租约约 10min(旧值),现 30min ⇒ **今天同样的卡死,漏速会从 ~10min/条恶化到 ~30min/条,修复紧迫性更高**。

## 2. 方案定型(逐 fix 精确改法)

> **[SUPERSEDED 2026-08-20]** 本节 Fix A–H 是被 founder 整层否决的 v1 设计,只保留为历史审计记录,**不得实施**。当前唯一实施规格见同目录 `plan.md`(v2 极简版)。

### Fix A — runner turn-end 机械 ack(断 runner lane 死环)

新 CLI 子命令 `flywheel-comm ack-delivered --exec-id <id> [--db]`:

```sql
UPDATE mailbox SET state='ACKED', acked_at=COALESCE(acked_at, :now),
       acked_via='stop_hook', claimed_by=NULL, claim_expires_at=NULL, next_retry_at=NULL
 WHERE to_agent=:execId AND recipient_kind='runner' AND carrier='inbox'
   AND state='LEASED' AND delivered_at IS NOT NULL
```

* 同事务写 `mailbox_transitions`(每行一条 `acked` 事件)。
* 挂载:`runner-stop-notify.sh` 新增第三条腿(Claude Stop/StopFailure 也跑;复用 `run_supervised_leg` 12s watchdog;失败静默留日志,不阻塞 Stop)。
* 正当性:envelope 注入发生在 turn 边界(Agent Team 邮箱 → `useInboxPoller`),**turn 结束 ⇒ 已注入内容已被本 turn 消费;已投递未注入的行也已 durable 落在 session mailbox,下一 turn 必然渲染**。残余风险 = session 在下一 turn 前死亡 → 内容在 transcript 里但没人读;这属 FLY-1628 pane-loss 域,重投给死 session 同样无效,fresh dispatch 才是解 — 边界如实写进验收文档。
* 只动 `delivered_at IS NOT NULL AND state='LEASED'` ⇒ 从未投递的 QUEUED 行绝不会被这条腿吞(与 Fix C 护栏同向)。
* response 类 wake 行同样被结算:gate 答案本体在 CommDB,`check`/`consumeGateResponse` 读内容不依赖 mailbox state,ack 后仍可读(72h 归档保留期内)。
* Codex runner:不装此腿(无 Stop hook 基建;其唯一投递路径 = 自己 poll `inbox`,pull=deliver+ack 原子,不存在脱钩;从不 poll 的兜底交给 Fix E dwell 告警)。

### Fix B — late-ack 承认(lead lane `ack_late_noop` 根治,issue 修法①)

1. 新列 `last_batch_id TEXT`:在两处 lease 赋批点(`mailbox-queue.ts:976/1191`)与 `batch_id` 同写;**requeue 的 5 处 `batch_id=NULL` 不清它**。
2. `ackBatchByRecipient` 改造:
   * 行集合按 `batch_id = :b OR last_batch_id = :b` 解析;
   * 收件人一致性校验保留(to_agent 必须全等于 fromAgent,防跨收件人);
   * 应用范围 QUEUED + LEASED(消费者已确认的 ack 在重投窗口内仍是有效同意);ACKED → `duplicate` 幂等;DEAD 不复活(死信通知已发,操作面归 Lead;晚到 ack 记 `ack_late_dead_noop` 迁移事件供取证)。
   * LEASED 行不再要求 `claimed_by` 匹配当前 epoch?—— 保留现状不校验(该函数本就不校验 claimed_by;跨 epoch 的重启场景由 to_agent 一致性兜底)。
3. issue 修法②(提高 bridge lane drain 优先级)**不做**:①落地后延迟只影响时效不影响正确性,protocol 行本就在每 tick 模型批之前排干(`lead-inbox-loop.ts:288-325` 的 for(;;) 先于 claimLeadBatchQueue),已是最靠前位置。
4. issue 修法③(消费端重投重 ack)runner 侧由 Fix A 自动成立(每 turn 结束都 ack);lead 侧现状已重 ack。

### Fix C — 投递章 + 调用方身份 + 裸 ack 绊线(2026-08-19 深夜按三 Lead 判定语修订)

**语义先行(判定语①,必须写进 schema 注释与文档)**:`delivered_at` / `first_delivered_at` 的章义 = **「送出那一刻」(emission)**,非「被接住」(receipt)。push 路径在 transport-accept 盖章;pull 路径(`inbox`/`check`/gate 轮询)在**输出返回给调用方的同一事务**盖章。现状缺陷是 `delivered_at` 为 push-only、系统性漏记 pull 投递 — 「拦 QUEUED 的 ack」方案**作废**(pull 对 QUEUED 行的签收是合法投递)。

1. 新列 `acked_via TEXT`(cli_pull / stop_hook / ack_batch / ack_batch_late / legacy_push / bridge_protocol / batch_delivery)与 `first_delivered_at TEXT`(一次 COALESCE 写入,任何 requeue 不清)。
2. `ack()` 契约改为**每个 ack 面自带投递章**:
   * 新签名 `ack(idOrDeliveryId, now, opts: { via, deliveredNow?: boolean })`;
   * `deliveredNow=true`(拉取式调用方:`inbox` CLI、`consumeGateResponse`、legacy hook、bridge 协议行 drain)⇒ 同一 UPDATE 里 `delivered_at=COALESCE(delivered_at,:now), first_delivered_at=COALESCE(first_delivered_at,:now)` 再置 ACKED — **拉取即投递(emission),原子盖章**;
   * `deliveredNow` 缺省 ⇒ WHERE 追加 `AND delivered_at IS NOT NULL`。**这不是「拦 QUEUED」策略,是回归绊线**:全部合法 ack 面迁移后都自带章(pull 同事务盖、push 行本就有、phase-wake durable-accept 即章),走到拒绝分支的裸 ack 只可能来自未迁移/未来引入的调用方 = bug — 拒绝 + `ack_refused_undelivered` 迁移事件 + 结构化 stderr,返回 false。
3. `inbox` CLI(`commands/inbox.ts`)、`consumeGateResponse`(`db.ts:4193`,`via='gate_poll', deliveredNow=true`)、`ackInstructionRead`(`db.ts:4222`,`via='lead_mcp_ack'`)与 legacy hook(`inbox-check.sh:86`)改走新契约;hook 的 UPDATE 同步补 `delivered_at/first_delivered_at/acked_via='legacy_push'`;phase-wake claim(`db.ts:2897`)保持自己的 UPDATE 但补 `acked_via='phase_wake_accept'` + delivered stamp(durable-accept 即投递)。
4. requeue 的 5 处照旧清 `delivered_at`(重投机制载重字段,语义不动),取证由 `first_delivered_at` + 迁移日志承担(issue 追加事实 #2 的修法)。

### Fix D — `mailbox_transitions` 迁移日志(观测重建,优先级最高)

```sql
CREATE TABLE IF NOT EXISTS mailbox_transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  batch_id TEXT,
  event TEXT NOT NULL,          -- leased|delivered|cli_delivered|requeued|acked|ack_refused|ack_late_applied|ack_late_dead_noop|dead
  from_state TEXT, to_state TEXT,
  actor TEXT,                   -- ownerEpoch / execId / leadId / 'cli'
  via TEXT,                     -- 渠道,与 acked_via 同枚举
  detail TEXT,                  -- reason / last_error / lease_retry_count 等 JSON
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_transitions_message ON mailbox_transitions(message_id, seq);
CREATE INDEX IF NOT EXISTS mailbox_transitions_at ON mailbox_transitions(at);
```

* 写入点(与状态突变同事务):lease 赋批(976/1191)、`recordBatchDelivered`、requeue(4 处 + `adoptInflight` 350 行)、`ack()`/`ackBatch()`/`ackBatchByRecipient`、DEAD 两处(`recipient_terminal`/`lease_expired_unacked`)、ack 拒绝。批量事件按行写(攒批≤10,量可控)。
* **不复用 `mailbox_log`**:append-only 触发器禁 DELETE,保留期清理做不了;且该表语义已收窄为 archived 快照。
* 保留期:14 天,`DELETE ... WHERE at < cutoff LIMIT 500` 挂在 admit rider 现有清理位点,零新 timer。
* 体量核算:mailbox ~2,900 行/天 × 迁移 4-6 事件 ≈ 1.5 万行/天,14 天 ≈ 21 万行,单库尺寸与旧 mailbox_log(11.5 万行)同量级,无风险。

### Fix E — LEASED dwell 告警(issue 追加事实 #4:判据 = 停留时长)

* 扫描:克隆 `scanAndInsertDeadLetterNotices` 范式 → `scanAndInsertDwellNotices`:`state='LEASED' AND claim_expires_at 仍在续 或 lease_retry_count>0`,判据 `min(delivered_at|leased_at) 距 now > dwellAlertMs`(默认 600_000,配置键进 `mailbox-queue-config.ts` 有界解析);按 to_agent 聚合,一条 `mailbox_dwell_notice` 行发 owning Lead(`resolveOwningLead` 复用),内容含 lane、最老行龄、行数、batch_id、最近一次 acked_via 证据。
* episode-latch:同 lane 已有未恢复 notice(游标同死信范式)不重发;lane 恢复(无超龄 LEASED)后再犯 = 新 episode 可再报。
* 驱动:挂在 `lead-inbox-runtime.ts:321` 同一 admit rider,零新 timer。
* 注意 dwell 判据对 lead lane 同样生效(Cass 型延迟结算 >10min 也可见)。

### Fix F — 安全禁令 fail-loud(issue 追加事实 #3)

* `flywheel-comm send --inhibition` → 新列 `inhibition INTEGER NOT NULL DEFAULT 0`(发送端显式声明;内容启发式否决)。
* DEAD 迁移时若 `inhibition=1`:除照常进死信聚合外,立即产出一条 severe 级 `dead_letter_notice`(priority=0、单独成行不聚合、content 前缀 `[SAFETY-INHIBITION DEAD]`),owning Lead 收到时按现有 severe 惯例上报 founder。
* Lead 侧提示词(lead-rules)补一句「禁令类指令用 --inhibition 发」— 文档改动,不强制。

### Fix H — `inbox` 破坏性读的召回能力(判定语③,方向无关的确定缺陷)

现状:`inbox` 一次返回多条,ack(销毁 unread 可见性)落库在 stdout 打印**之前**(`commands/inbox.ts:26-28` → `index.ts:808`)— 调用方在打印后丢正文(context 截断/进程死亡)即永久失去再取途径。**正文本体并没消失**(mailbox 行存活到 72h 归档,归档后仍在 `mailbox_log` archived `row_json` 里)— 缺的是再取通道,不是持久化。修法(三选一里取最简):

* 新 `flywheel-comm inbox --replay [--since <iso>] --exec-id <id>`:只读重印该 exec 名下已 ACKED 的 instruction/response 行(默认最近 24h),不改任何状态。丢了就能找回,读=ack 的简单性保留。
* 配套:batch envelope 与 runner 提示词补一句「若感觉指令缺失,跑 `inbox --replay`」;`ack()` 的 `cli_pull` 盖章让「哪些行经 pull 送出过」可查(与召回互证)。
* 两阶段确认/读不销毁 **否决**:两者都把「第二步」重新压回模型自觉 — 正是本案根病;召回 + Fix A 机械 ack + dwell 告警的组合以更少机制覆盖同一风险。

**回归基准(判定语④)**:四行用例 = 「三条 push+pull 双路、一条 pull-only」;HL 重发的合并指令对 runner 记**首次投递**,非重复。

**测试方法论(时刻表证据包警示)**:所有时间断言用**双边界** — `created_at < 事件时刻 <= now`;只查下界的检查对未来值恒真(「不可能得出否定结论的检查不是检查」);runner 侧行为时刻只可作到达下界,不可当投递时间。

### 2026-08-19 R1 design review 修订摘要(以 plan.md R2 为准,本节记录对上文的修正)

Codex R1(7 BLOCKER + 2 HIGH,全采纳)修正了本文件上文的以下表述:

1. **Fix A**:机械 ack 仅限**成功的 Claude Stop**(`source=claude-stop`);StopFailure(覆盖 429/API error,非消费证据)与 codex-notify(doorbell 正文下一 turn 才读,ack 即吞正文)保持 reporter/sweep-only + 零突变负测;命令加 `--through <hook-ingress-ts>` 时间栅栏防 detached leg 结算 hook 之后新到的行。部署 owner 修正:hook 由 Bridge boot `syncFlywheelRuntime()` 分发(soft-fail,需 SHA256 对账),**0a 需要 Bridge restart**。
2. **Fix B**:`last_batch_id` 落笔位置改为 **requeue CAS**(先 `last_batch_id=batch_id` 再清 `batch_id`),新批 lease 不碰它——否则新批分配即覆盖旧值,竞态必败;承认范围定为上一 attempt,更老的 ack → `refused_stale_attempt` 审计。
3. **Fix C**:`ackInstructionRead` 是 push 通知后的显式 MCP 确认,**不是 pull,不得 deliveredNow**(那等于调用者自铸投递证据)——其证据由 push 成功侧(attempt-fenced notify/delivery)提前落;`cli_pull`/`gate_poll` 改为原子 `consume…` 事务(现状 select 后逐行 ack 不原子);全部面 typed disposition;首次 stamp SQL 显式 `:now` 收尾(同 UPDATE 列引用读旧值,`COALESCE(a,b)` 三皆 NULL 时结果仍 NULL);FLY-1773 静态守卫/投影 version 作为裁定变更同步更新。
4. **Fix D**:迁移点清单改为**全仓 census 驱动**(上文列举不完整,至少还有 markExternalDelivered/markDead/releaseClaimForRetry/legacy push/delivery failure/markAckReceiptConsumed/phase-wake/legacy requeue);external carrier 纳入;静态突变守卫;schema 增量入口 = `ensureMailboxQueueSchema`(非 mailbox-migration.ts);`inhibition` 不进 projection hash(identity 兼容)。
5. **Fix E/F**:通知**不进 mailbox**(self-wedged lane 的通知会排进它自己堵死的队列)——scan/DEAD 事务写 StateStore durable intent,经 `LeadAlertNotifier` 直投;`priority=0` ≠ severe,inhibition 用独立 event type + `severity:"severe"`;episode latch 持久化跨重启;dwell 时间基准 = 当前 attempt(非 first_delivered_at);prune/scan 失败隔离不阻断 admit tick。
6. **Fix H**:`--since` 限 live retention(72h)内、超界 fail-loud;max rows/bytes + 截断标记;exec-id 身份约束;archive 合并读取 = follow-up。

**R2 追加(3 BLOCKER + 2 HIGH,全采纳)**:① comm.db 与 StateStore 两库无跨库原子性 → 告警改两段式:comm.db 本地告警 outbox(与 DEAD/dwell 同一 MailboxQueue 事务)→ admit rider 幂等投影 StateStore intent → durable 后结算 outbox,配两条 kill/restart 缝测试;② `inhibition` 必须入 identity hash v2(永久排除会让同 id 重放静默丢安全标记),legacy fallback 仅限 incoming=0;③ late-ack 证据必须 attempt-specific——热修加 `last_batch_delivered_at`(requeue CAS 复制),完整路径用 transitions 的 message_id+batch_id 事件;热修期超一 attempt 统一 `ack_late_noop`(无历史时不虚构 stale/absent 区分);④ 机械 ack 收进 `runner-stopped` 成功分支,through/execId 内部派生,不设新 CLI 面,「不可伪造」措辞删除、本地信任边界入风险登记;⑤ replay 身份 fail-closed(env 不一致拒绝,警告不是约束),maintenance 取证另设入口。

**R3 追加(1 BLOCKER + 4 HIGH,全采纳)**:① `through` 定稿 = hook 前台 detach 前捕获的 turn ingress(hook 已生成并传给 runner-stopped;detached 子进程自身时刻会晚于下一 turn 开始,用它作上界必吞新行);preflight(source/env/identity)与 reporter/ack 拆成共享前置 + 平级 sibling effects,reporter duplicate 不得跳过 ack;② Step 0 验收/部署矛盾消除:热修期证据 = dwell + DONE 对账(transitions 是 Step 2 产物),0b 热修审计 = 行级 last_error 注记 + stderr;③ dwell episode 状态机定稿(open 唯一 per (alert_type,lane)、健康 close、re-wedge 以 generation+1 重开、outbox settle 不关 episode)+ 全局 event id 绑定 projectName 防跨项目碰撞;④ replay 要求非空 FLYWHEEL_EXEC_ID,env 缺失 fail-closed;⑤ member/batch disposition 真值表 + ProtocolIngress 映射(含 batch_ack_refused)+ 所有 outcome settle protocol 行(refused 不重试,补救 = 重投时消费端重 ack)。

## 3. 被否决的替代方案

| 方案 | 否决理由 |
|---|---|
| A2 transport-confirm 即 ack | 抹掉 delivered≠consumed 区分,死 session 场景丢重投保护;FLY-1773 刚把这两层拆开 |
| A3 提示词加强 | 1/4 命中率即实测上限;LLM 自觉不是机制 |
| PostToolUse 每次工具调用 ack | 每 tool call 一次 DB 写,重;Stop hook 每 turn 一次已足够,且 PostToolUse hook 在 sentinel 模式下现为 inert,改它牵动 FLY-142 回退路径 |
| 修法②提高 protocol drain 优先级 | 已是 tick 内最先;正确性问题在①,时延优化无对象 |
| 复用 mailbox_log 记迁移 | append-only 触发器禁清理;语义已收窄 |
| 复活 receipt ledger | FLY-1645 founder 判死;本单只要窄取证 |
| ack 时复活 DEAD 行 | 死信通知已发,双重语义;记 noop 事件足够取证 |
| 内容启发式识别安全禁令 | 不可靠,假阴性即事故 |
| 拦-QUEUED ack(拒绝对 QUEUED 行的一切 ack) | **判定语②作废**:pull 对 QUEUED 行的签收是合法投递;正确修法 = pull 盖投递章 |
| 两阶段确认 / 读不销毁(修破坏性读) | 都把「第二步」重新压回模型自觉 — 正是本案根病;召回 + 机械 ack + dwell 告警以更少机制覆盖同一风险 |

## 4. 兼容与风险

* **Schema**:3 列 ADD COLUMN(`last_batch_id`/`acked_via`/`first_delivered_at`/`inhibition` — 4 列)+ 1 新表,全部幂等 additive(照 `mailbox-migration.ts` 现有 duplicate-column 容忍范式);旧行全 NULL 语义 = 现状。
* **字节兼容路径**:不修改 in-flight 门、攒批、租约参数;`ack()` 新增 opts 参数带默认值时**必须显式迁移全部调用方**(全仓 7 个调用点,逐个标 via)— 不允许缺省 via 的调用残留。
* **部署**:flywheel-comm + teamlead 双包 build;Bridge 重启一次;hook 文件经 `install-hooks.sh` 分发(已跑的 runner 下一次 Stop 生效,无需重启 runner);`mailbox-queue-deploy-barrier` 照 FLY-1573 纪律走。
* **风险 1**:Stop hook 机械 ack 在「envelope 投递成功但 Agent Team 注入实际失败」时会吞行。评估:`recordRunnerBatchDelivered` 只在 adapter.deliver 成功后写 delivered_at,Agent Team 投递 = durable 写 session mailbox 文件,注入由 stock poller 保证;若那层断了属 claude-code 平台故障,重投同样无效。接受,写进验收边界。
* **风险 2**:dwell 告警在长 turn(runner 30min 不结束一个 turn)时会对「投了还没到 turn 边界」报警。默认阈值 10min < 长 turn 常态?— Stop hook ack 后 dwell 从 turn 边界清零;长写作 turn 中途 delivered 的行会挂到 turn 结束。缓解:阈值可配 + 告警文案自带「若 runner 在长 turn 属预期,等 turn 结束自动恢复」;episode-latch 保证只报一次。
* **风险 3**:`ackBatchByRecipient` 扩到 QUEUED 后,若行已被**重新攒进新批并投给同收件人**,晚到的旧批 ack 会把新批成员 ACK 掉 — 这是**正确行为**(同一内容,消费者已确认),新批投递时会发现行已 ACKED → `already_settled` 路径,无副作用。

## 5. 回归矩阵(计划的测试骨架)

| # | 场景 | 断言 |
|---|---|---|
| R1 | 构造不 ACK 的消费者(vitest:lane 投递成功、无人调 ack) | dwell notice 恰一条、episode-latch 不重发;槽按租约轮换不静默饿死 |
| R2 | Stop-hook 腿:LEASED+delivered 行 | `ack-delivered` 后全 ACKED,`acked_via='stop_hook'`,迁移事件在 |
| R3 | Stop-hook 腿:QUEUED 未投递行 | 一条不动(护栏) |
| R4 | late ack:行已 requeue(batch_id=NULL) | 经 last_batch_id 命中,QUEUED→ACKED,事件 `ack_late_applied` |
| R5 | late ack:行已 DEAD | 不复活,事件 `ack_late_dead_noop` |
| R6 | 无证据 ack() | 拒绝 + `ack_refused_undelivered` 事件;CLI 拉取(deliveredNow)照常成功且 stamp delivered_at |
| R7 | requeue 后取证 | `first_delivered_at` 保留、`delivered_at` 清空、迁移日志含 requeued 事件 |
| R8 | inhibition 行 DEAD | severe 单行通知即刻插入,不进聚合窗 |
| R9 | 阴性对照 | lead lane 攒批/in-flight 计数/正常 ACK 路径行为逐字节不变(现有 mailbox 套件全绿);codex runner 路径零改动 |
| R10 | 真机(529 房或隔离 harness) | 正对照按证人纪律(plan §4.0):新指令 **LEASED dwell < 60s** 且 runner 的 DONE 报告**逐字引其完整 id**(远端产物对账,不数 acked 行);负对照:健康 lane 不变 |
| R11 | 四行用例(判定语④基准):三条 push+pull 双路、一条 pull-only | 四条全 ACKED 且 `first_delivered_at` 非空、`acked_via='cli_pull'`;pull-only 行的章由 pull 盖;重发合并指令记**首次投递**非重复 |
| R12 | 召回:pull ack 后模拟调用方丢正文 | `inbox --replay` 完整重印内容;replay 前后 mailbox 零状态变化 |

## 6. 会过期的结论(as-of 2026-08-19,行号基于 `ff0fa64f4`)

| 结论 | 失效条件 | 重核命令 |
|---|---|---|
| runner 行唯一 acker = 3 个拉取面 | 任何新增 ack 调用点 | `grep -rn "\.ack(" packages --include="*.ts" \| grep -v test` |
| protocol 行每 tick 先于模型批排干 | lead-inbox-loop tick 结构重排 | `git log -S claimBridgeProtocol` |
| ackLease 默认 30min | mailbox-queue-config 改值 | `grep ackLeaseMs packages/teamlead/src/bridge/mailbox-queue-config.ts` |
| mailbox_log 仅 2 写入点 | 有人恢复迁移写入 | `grep -rn "INSERT INTO mailbox_log" packages` |
