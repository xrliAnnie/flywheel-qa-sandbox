# FLY-1773 Flow 2(Batch 通道)三件治病 — 调研

Issue: FLY-1773 (https://linear.app/geoforge3d/issue/FLY-1773/机制-flow-2batch-通道治病三件真送达才盖章-未读不占位-读者可判活-两条规则终稿的主刀单)
日期: 2026-08-14
基于: exploration.md

## 1. 现状机器全图(Flow 2,Lead 收件)

```
enqueue(discord chat-ingest / 事件 / 协议行)
  → mailbox 行 QUEUED (priority: founder discord=1)
LeadInboxLoop.tick (per-Lead, 1s 活跃 / 30s 空闲, lead-inbox-loop.ts)
  ① recordTickStarted → acquireOrRenewOwner(owner 租约)
  ② reconcileExpiredLeases(recipientKind='lead', recipientState=()=>"alive", maxTerminalRows=0)
  ③ claimBridgeProtocol 循环(ack_batch 等协议行 → ProtocolIngress)
  ④ claimLeadBatchQueue:
       in-flight 检查(≥3 → return [],一条不投)          ← 病 2
       head 选取(ORDER BY priority,seq)→ 攒窗(30s/10条/4MB)→ 整批置 LEASED
  ⑤ deliverModelBatch → adapter.deliverBatch(transport receipt)
       → recordLeadBatchDelivered:delivered_at=now, ack lease 30min   ← 病 1
Lead 模型读到批 → flywheel_inbox_ack_batch / codex ack_batch
  → insertBatchAckReceipt(protocol 行 to=bridge)
  → 下一 tick ③ → ProtocolIngress → ackBatchByRecipient → 整批 ACKED(acked_at)
ack lease 过期未 ack → ② reconcile:
  - 全员 notified 过 → lease_retry_count++ 回 QUEUED 重投;≥leaseRetryMax(3) → DEAD(lease_expired_unacked)
  - 从未传输成功(delivered_at IS NULL 判定)→ frozenResend(冻结批原样重发)
  - lead 分支判活硬编码 "alive"                                        ← 病 3
```

Push 路径(FLY-109,instruction 类,与批路径并存):inbox-mcp 1s poll → `processPendingDeliveries`(`delivery.ts:34-59`)→ MCP notification 成功 → `markInstructionDelivered`(`db.ts:3581`,置 LEASED+claim_expires_at=now)→ projection `delivered_at` 立即非空(`mailbox-schema.ts:145-148` 派生:LEASED→claim_expires_at / ACKED→acked_at)→ retry window(`PENDING_PUSH_INSTRUCTIONS_SQL`,`db.ts:56-65`)基于它隐藏;`flywheel_inbox_ack` → `ackInstructionRead` → ACKED。

## 2. 病灶位点清单(全部经代码核实)

| # | 病 | 位点 | 现状 |
|---|-----|------|------|
| 1a | notify 即盖章(批) | `mailbox-queue.ts:1207-1254` `recordBatchDelivered` | transport receipt → `delivered_at = COALESCE(delivered_at, now)` |
| 1b | notify 即盖章(push) | `delivery.ts:47-55` + `db.ts:3581-3589` + `mailbox-schema.ts:145-148` | notification resolve → LEASED+claim_expires_at=now → projection delivered_at 非空 |
| 2 | 未读占位 | `mailbox-queue.ts:1058-1068` | `COUNT(DISTINCT batch_id) WHERE state='LEASED' AND delivered_at IS NOT NULL AND claim_expires_at>now` ≥ `inflightMaxBatches`(3)→ claim 返回空 |
| 2' | 占位堵死时长 | `mailbox-queue-config.ts:16` | `ackLeaseMs=1_800_000`(30min)× 3 批 |
| 2'' | 堵死写进合同 | `lead-inbox-loop.ts:433` | header:「once 3 batches are unacked, no further batch will be delivered」 |
| 3a | Lead 判活硬编码 | `mailbox-queue.ts:1477-1481` | lead 分支 `recipientState` 恒 `"alive"` |
| 3b | Lead loop 不传判活 | `lead-inbox-loop.ts:241-250` | `recipientState: () => "alive"`,`maxTerminalRows: 0` |
| 3c | retired Lead 无人收尾 | 结构性 | reconcile 只在**该 Lead 自己的** loop tick 里跑;Lead 移出配置 → loop 不存在 → 批永远 LEASED/QUEUED,死信闸永不触发 |

对照組(已健康,复用其形态):runner lane(`runner-mailbox-lane.ts:212-265`)是 Bridge 全局 tick,带 `recipientState` 回调 + `resolveOwningLead` + `scanAndInsertDeadLetterNotices`;runner 判活、terminal 死信(`recipient_terminal`)、`skippedUnknown` hold 语义全部已存在于共享函数 `reconcileExpiredLeases`(`mailbox-queue.ts:1415-1432, 1477-1510`)。**病 3 的本质是把 runner 已有的判活面接到 lead 分支**,不是发明新机制。

## 3. 判活源(病 3 的两级真源)

| 层 | 问题 | 真源 | 现成 API |
|----|------|------|----------|
| registry 层 | 这个 leadId 还是本 Bridge 的 Lead 吗 | Bridge 启动时装配的 per-Lead loop 集合(源自 projects.json → FLY-1726 canonical identity) | Bridge plugin 侧闭包可拿当前 Lead 集合;不在集合 = `terminal_or_missing` |
| 进程层 | 该 Lead 进程活着吗 | v2 lease store(`~/.flywheel` lead lease,pid+start_time tuple) | `lead-lease.ts:307` `processAliveWithStart` / `:325` `processTupleStateWithStart` → `"alive"|"dead"|"sensor_error"`(fleet-data.ts 已消费同族 API) |

映射:`alive`→`"alive"`;`dead`/`sensor_error`→`"unknown"`(hold:跳过不重投不涨 retry,既有 `skippedUnknown` 语义,`mailbox-queue.ts:1482-1485`)。**`dead` 不映射 `terminal_or_missing`**:v2 载体 launchd KeepAlive 秒级拉回,进程 dead 是暂态;只有 registry 层不在才是 terminal。换代恢复面:FLY-1708/1751 的 `adopt-inflight`(launcher + SessionStart(source=clear) hook)→ `recipient_reborn` requeue(`mailbox-queue.ts:298-326`)已有,不加第二套。

3c(retired Lead 收尾)的位点选择:复用 runner lane 同款「Bridge 全局 tick」形态 —— 但**不加新 timer**(FLY-1560 后铁律)。候选:(i) GatePoller rider(FLY-1687 同款,60s 骑行);(ii) runner lane tick 里搭车扫 lead 行。倾向 (i):runner lane 语义上是 runner 的,搭车会混 recipientKind;GatePoller rider 已是「per-Lead 到点闹钟」宿主,加一段有界 lead-mailbox terminal 扫描顺路。频率要求极低(retired Lead 是罕见事件)。

## 4. `delivered_at` 全仓读点影响矩阵(非测试)

| 文件 | 用法 | 是否受改动影响 |
|------|------|----------------|
| `flywheel-comm/src/mailbox-queue.ts` | 病灶本体:in-flight 计数(1063)、frozenResend 判定(1511)、reconcile/adopt 清列(318,1427)、recordBatchDelivered(1239) | **是 — 改动主场** |
| `flywheel-comm/src/mailbox-schema.ts` | projection 派生列(145-148) | **是**(push 路径语义收口) |
| `flywheel-comm/src/db.ts` | `PENDING_PUSH_INSTRUCTIONS_SQL`(56-65,retry window 读 projection delivered_at)、`markInstructionDelivered`(3581) | **是**(push 路径) |
| `flywheel-comm/src/mailbox-migration.ts` | 列迁移工装 | **是**(新增 `notified_at` 列) |
| `flywheel-comm/src/types.ts` | Message 类型字段 | 核对(字段可选,预计零改) |
| `inbox-mcp/src/delivery.ts` / `index.ts` | push 循环 + 注释 | **是**(注释与 notify 后写点) |
| `teamlead/src/StateStore.ts` | **别的表**(lead_events / design_review_manifest / doa_backoff 各自的 delivered_at 列) | 否 — 同名不同账,零改动 |
| `claude-runner/src/TmuxAdapter.ts`、`agent-team-transport/src/types.ts` | 仅注释提及 | 否 |

其他核过不受影响:`countDeliverable`(`mailbox-queue.ts:629`,只看 QUEUED,不读 delivered_at)→ nudge/活跃判断零变化。

## 5. Flow 1(runner)兼容红线(逐条)

1. claim head 的 runner in-flight 子查询(`mailbox-queue.ts:1078-1084`)`delivered_at IS NOT NULL` 条件**字节不动** —— runner 行的 delivered_at 写点照旧,该查询行为恒等
2. `recordBatchDelivered`:runner 行**双写**(`delivered_at` 照旧 + 新列 `notified_at` 同刻);lead 行只写 `notified_at`
3. `reconcileExpiredLeases` frozenResend 判定(1511)统一改读 `notified_at IS NULL` —— runner 行两列同刻,行为等价(等价性单测锁死)
4. `adoptInflightForRecipientOnConnection`(318)/reconcile 清列(1427)同时清 `notified_at` —— 对 runner 是纯附加清理,无行为差
5. runner lane(`runner-mailbox-lane.ts`)零改动;runner 判活/死信/owning-lead 路径零改动
6. `queueConfig.enabled=false` 的 legacy 分支(`lead-inbox-loop.ts:306-318` claimLeadBatch / ackBatch)零改动

## 6. 现有测试底盘(阴性对照的地基)

- `flywheel-comm/src/__tests__/`:`mailbox-queue.test.ts`(claim/deliver/ack/reconcile/死信主套)、`mailbox-queue-schema.test.ts`、`mailbox-adopt-inflight.test.ts`、`mailbox-migration.test.ts`、`mailbox-settlement.test.ts`、`send-mailbox.test.ts`、`respond-mailbox.test.ts`
- `teamlead/src/bridge/__tests__/`:`lead-inbox-loop.test.ts`、`runner-mailbox-lane.test.ts`、`mailbox-queue-config.test.ts`、`lead-inbox-runtime.test.ts`
- `inbox-mcp/src/__tests__/`:`index.test.ts`、`ack-semantics.test.ts`、`channel-lease.test.ts`

这些套件整体 = 「正常收发/签收/死信闸/幂等零回归」的既有断言面;三病修完必须全绿,新增用例只加不改已断言语义(除非该断言就是病本身 —— 逐条点名,见 plan)。

## 7. 迁移与部署形态

- schema:`ensureMailboxQueueSchema`(`mailbox-queue.ts:272-296`)已是幂等 ADD COLUMN 工装,`notified_at TEXT` 循例新增;老库老行 `notified_at IS NULL` —— 对存量 LEASED 行,frozenResend 判定用 `COALESCE(notified_at, delivered_at)` 过渡读(一个 ack-lease 周期内自然收敛,之后 delivered_at 旧写点消失)
- in-flight 新语义对存量行为的一次性影响:部署瞬间正在占位的「已投未 ack」批立即不再占位 —— 这正是治疗目标,无需灰度旗(founder「不加新 flag」铁律,FLY-1466 同款口径)
- 纯 Bridge + inbox-mcp 侧改动 → 单次 Bridge 重启部署;Lead 端零改(ack 工具契约不变)
