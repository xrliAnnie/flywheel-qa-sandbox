# FLY-1573 队列能力三合一 — 调研(代码现状审计)
Issue: FLY-1573 (https://linear.app/geoforge3d/issue/FLY-1573/消息层重构-d-批次2-队列能力三合一租约重投-合批投递-死信闸)
日期: 2026-08-10
基于: exploration.md

> 审计基线 = 本 worktree `flywheel-FLY-1573`(base `d32a9919`,含 FLY-1572/1646/1649/1657 全部合入)。所有行号以此基线为准。

## 1. 队列层现状(`packages/flywheel-comm/src/mailbox-queue.ts`,1423 行)

### 1.1 状态机与既有方法清单(D 的改造对象)

| 方法 | 行 | 现语义 | D 的关系 |
| -- | -- | -- | -- |
| `claimLeadBatch` | 624 | frozen-batch 优先(LEASED+batch_id,三路守卫 :661)→ 否则 fresh 批一把抓 `maxBatchSize ?? 10_000`(:679-691),无 from_agent/时间窗/in-flight 约束 | ON 换合批组批 + in-flight 闸;OFF 原样 |
| `claimRunner` | 753 | 单行认领 QUEUED → LEASED(30min TTL) | ON 换 per-recipient 组批;OFF 原样 |
| `claimBridgeProtocol` | 710 | 单行,QUEUED 或过期 LEASED 可重领(:726-728) | 不动 |
| `ack` | 865 | 单行 QUEUED/LEASED → ACKED(runner 拉取用) | 不动(pull-ack 是批 ack 的超集) |
| `ackBatch` | 877 | membership 顺序校验 + 只许 LEASED&claimed_by=ownerEpoch 成员(ACKED/DEAD 成员放行幂等,:902-907) | ON 下改由 agent 触发;需新的收件人授权入口(现签名绑 ownerEpoch) |
| `recordRunnerDeliverySuccess` | 783 | 成功后**停在 LEASED**(清 last_error/next_retry_at) | ON 下加盖 `delivered_at` + ack 租约 |
| `recordRunnerDeliveryFailure` | 798 | **投递失败**退避:回 QUEUED+retry_count+1,≥max → DEAD(`delivery_attempts_exhausted`) | 保留;与 no-ack 到期重投共用 `retry_count`(见 §5 疑点 1) |
| `recordLeadDeliveryFailure` | 927 | 失败批保持 LEASED+batch_id、NULL claim、退避;≥max(5)→ DEAD | 保留 |
| `recordBridgeDeliveryFailure` | 832 | 同上,max=3 | 不动 |
| `releaseClaimForRetry` | 507 | transient 释放:QUEUED+清 batch_id+30s 退避(admission revalidate 用) | 不动 |
| `markDead` | 492 | 单行 QUEUED/LEASED → DEAD,幂等回读 | 复用(terminal 立死) |
| `countDeliverable` / `countRunnerDeliverable` | 372/384 | 只数 QUEUED 且 next_retry_at 到期 —— 活跃判定,LEASED 不驱动 tick(红线①) | 到期扫描不得破坏此约定(见 §5 疑点 2) |
| `settle` / `getSettlement` | 964/1015 | settlement CAS(mailbox_log UNIQUE 槽) | 不动 |
| `archiveDueFamilies` | 1032 | RPC-family 终态归档 | 不动(DEAD 行本就可归档) |

### 1.2 schema(`mailbox-schema.ts`)

- 表定义 :4-46,queue 列齐备:`state/claimed_by/claim_expires_at/retry_count/next_retry_at/last_error/acked_at/dead_at/dead_reason/batch_id/collapse_key`。**没有 `delivered_at`**。
- 索引 :47-70:`mailbox_lead_reclaim`(LEASED+batch_id 部分索引)可直接服务 Lead 到期扫描;runner 侧 LEASED 行只有 `mailbox_live(to_agent, seq) WHERE state IN ('QUEUED','LEASED')` 可用——到期扫描按 to_agent 走它,或补 `claim_expires_at` 部分索引(EXPLAIN 钉死,C 惯例)。
- `mailbox_message_projection` VIEW :74-108:**把 LEASED 的 `claim_expires_at` 投影成 `delivered_at`**(:102-105)——加真列后此近似投影的读者是否需要跟进,见 §5 疑点 3。
- schema 以 `CREATE TABLE IF NOT EXISTS` 于 open 时 exec(mailbox-queue.ts:248);生产库已建 → **新列必须走幂等 ALTER 守卫迁移**(PRAGMA table_info 探测,FLY-1267 先例),不能只改 CREATE 语句。
- `mailbox_identity_guard` 触发器 :117-125:INSERT 需先 reserve identity —— 死信通知行走 `enqueue()` 正门(:251,内含 registry resolver)即可,幂等键天然可用。

## 2. 投递循环现状(`packages/teamlead/src/bridge/`)

### 2.1 `lead-inbox-loop.ts`(425 行)

- 节奏:1s 活跃 / 30s 空闲(:16-17),`nextDelayMs()` 由 `hasLiveSession / hasAdditionalWork / countDeliverable` 决定(:141-162)。
- tick 骨架(:164-303):heartbeat → owner lease → `admit()`(materialize + **leadIndex 0 顺带 `runnerLane.tick()`**,lead-inbox-runtime.ts:160-163)→ protocol 循环 → `claimLeadBatch` → revalidate → `deliverModelBatch`。
- `deliverModelBatch`(:305-383):membership 冻结校验 → adapter receipt → `markAuditDelivered`(lead_events/question 镜像 delivered,runtime :183-193)→ **`ackBatch`(:363-371)= C 的 durable-accept ACK 位点,ON 时要换成「盖 delivered_at + 30min ack 租约」**。失败走 `recordLeadDeliveryFailure` 后 re-throw(:372-381)。
- `modelPayload` 渲染:`[receipt:<delivery_id>]\n<content>` 逐条拼接(:323-330)——门铃头部(批 id + ack 指引)在这里/首成员前注入。

### 2.2 `runner-mailbox-lane.ts`(211 行)

- `tick()`(:159-202):循环 `claimRunner` 单行 → `renderRunnerMailboxEnvelope` → `deliver`(wakeRunnerMailbox)→ 成功 `recordRunnerDeliverySuccess`(停 LEASED)/失败退避。`maxAttempts=6`、backoff 5s→10min、`claimTtlMs=30min`(:152-156)。
- envelope(:82-125):instruction 行内容带 `[lead-instruction <id>]` 前缀;response 行是指针文本(让 runner 跑 `flywheel-comm check <qid>`);`intentKey` = `instruction:<id>` / `gate-answer:<qid>`(`runner_phase_wakes` 去重账本键)。
- adapter(:40-80):`CommDB.getSession(execId)?.vendor`,`vendor === "none"` → `no_transport`(FLY-493/494 no-transport runner)。**注意:`no_transport` 走 success 分支停在 LEASED** —— pull-ACK 是它唯一出路(C 计划 §5.4 明示);D 的到期重投对它会空转+3 次后死信,见 §5 疑点 4。

### 2.3 装配(`lead-inbox-runtime.ts`,360 行)

- 每 project 一个 `MailboxQueue` + 一个 `RunnerMailboxLane`;每 Lead 一个 `LeadInboxLoop`;共享 `ownerEpoch`(:88)。**`opts.store: StateStore` 在装配层可用**(:38)——terminal 判定与 owning-Lead 推导的接线点就在这里,lane 通过回调拿,不直接依赖 StateStore 类型。
- `onQuarantineAlert` 直发 sink 先例(:59-75):「报告 inbox 堵塞的告警不能经由 inbox 自己投递」——Lead 收件人死信告警按同款结构接。

### 2.4 protocol 路径(`protocol-ingress.ts`,87 行)

- `handle()` 仅认 `type='ack_receipt'`(:42-44),token 校验(deriveLeadEventAckToken)→ `markLeadEventAcked`。dispositions 已命名 `legacy_ack_*`。**`ack_batch` 新 type 在这里加分支**;flag OFF 时到达的 `ack_batch` 行会命中 :43 throw → 3 次后 DEAD + `onProtocolQuarantine` 通知(可接受的降级,plan 写明)。
- 写侧:Lead 经 inbox-mcp `flywheel_inbox_ack_event`(packages/inbox-mcp/src/index.ts:128-143)写 ack_receipt 行 —— 新工具 `flywheel_inbox_ack_batch` 同构落一行 `ack_batch`。

## 3. Runner 拉取 ACK(`flywheel-comm`)

- `commands/inbox.ts`:`getUnreadInstructions` + `markInstructionRead` 逐条 ACK + `ackRunnerReceiptWakesStarted`(:26-33);db.ts 多处 `state='ACKED' … WHERE state IN ('QUEUED','LEASED')`(db.ts:1655-1658 等)——**拉取对 QUEUED 和 LEASED 全 ACK**,C 合同如此。批级视角:拉取清空该 exec 的全部在途行 ⇒ in-flight 批数自然归零,无需 CLI 改动感知 batch id。
- `check.ts`/`gate` 的 `consumeGateResponse` 同理(response 行 consume → ACKED)。

## 4. transport 去重(`packages/agent-team-transport/src/claude/ClaudeMailboxCodec.ts`)——D 最大暗礁

- `writeMailboxBatch`(:266-297):Phase A `prepareBatchSidecar` → 同 batch 同 membership 已 finalized → `accepted_duplicate_same_membership`(**不重写 inbox 条目**);
- `prepareBatchSidecar`(:527-):同 batch 不同 membership → `MailboxBatchConflictError`;**跨批冲突闸(:580-587):member `flywheelId` 已出现在任何别的 batch → `MailboxBatchConflictError`**;
- loop 把 `MailboxBatchConflictError` 映射成 `membership_conflict`(lead-delivery-adapter.ts:66-73)→ **整批 `markDead`**(lead-inbox-loop.ts:334-346)。

结论(两条推论,plan 的硬约束):
1. **重投复用同 batch_id + 同 membership ⇒ 被去重吞掉**(adapter 报 accepted_duplicate,Lead 看不到第二响);
2. **重投换新 batch_id 但复用 delivery_id ⇒ 跨批冲突 ⇒ 整批判死**。
⇒ 重投必须在 transport 边界用 attempt-scoped member id(`<delivery_id>#r<retry_count>`),`LeadDeliveryBatchMember.deliveryId` / `RunnerMailboxEnvelope` 的 wake 幂等键同步带 attempt。`[receipt:<delivery_id>]` 正文与 settlement/`handleReceipt` 链用的耐久 id **不变**。Codex 侧 `SqliteJournalStore`(teamlead/src/lead-backends/codex/SqliteJournalStore.ts:198)同款 member 去重,同解法覆盖。
分隔符选型 `#r`:`delivery_id` 现值域(`question:<lead>:<qid>` / `ack:<lead>:<receipt>` / UUID)不含 `#`,无歧义;attempt id 仅存活于 transport sidecar/journal,不回写 mailbox。

## 5. terminal 判定与 owning Lead(`packages/teamlead/src/StateStore.ts` + `bridge/lead-scope.ts`)

- `sessions` 表(:2344-2374):PK `execution_id`,`status`、`terminal_at`、`project_name`、`issue_labels`。
- `TERMINAL_STATUSES`(:358-365):terminal 单调集合,**`approved_to_ship` 明确剔除**(runner 还要 ship,不能对它立死)。判定 API 走 StateStore 既有方法(plan 里定一个只读回调 `resolveRunnerRecipient(execId) → { terminal, leadId } | undefined`)。
- owning Lead:`matchesLead`/`resolveLeadForIssue(projects, session.project_name, labels)`(lead-scope.ts:52-60)——死信通知的 `to_agent` 由此推导;session 行缺失 → 视同不存在 → 立死;labels 解析失败/项目未配 → fail-closed 落 `dead_reason`,通知走「该 project 第一个 Lead」兜底?❌ 不兜底 —— 推导失败即留 DEAD 行 + 计入 Lead 收件人同款 alert 路径(plan 定稿)。
- CommDB 也有 `getSession`(runner-mailbox-lane.ts:52 用于 vendor)——**它不是 terminal 权威**;设计定稿点名 StateStore,勿混。

## 6. flag 基建(`packages/config/src/feature-flags/`)

- 中央 registry(registry.ts,FLY-709):必须登记 `FLYWHEEL_MAILBOX_QUEUE`;`readTimings` 全 `call_time` + `scope: bridge_global` + `valueKind: bool` + `toggleable: direct` ⇒ fleet console 可热切(direct-toggle.ts:31-49 判定式)。
- flag-truth CI 门(truth.ts):代码里出现的 `FLYWHEEL_*` env 必须注册或进 `NON_FLAG_ALLOWLIST`。**D 的 6 个参数 knob(租约 TTL/窗/批上限/in-flight/重试上限/死信窗)按「config value」路数处理**——先例:`FLYWHEEL_PUBLISH_APPROVAL_CHANNEL: "config value: …"` 在 allowlist(truth.ts:52-53)。plan 逐个列名登记。
- 现有同类 kill-switch 先例:`receiptFoundationEnabled`(receipt-foundation.ts,`!== "0"`);D 用 opt-in(`=== "1"`)极性,merge 即零行为变化,ship 步再翻 ON。

## 7. 疑点清单(plan 必须逐条给答案)

1. **`retry_count` 双语义**:投递失败重试(现有,runner max 6/lead max 5)与 no-ack 到期重投(新,max 3)共用一列。若共用,一次 transport 抖动会白吃 no-ack 额度、语义纠缠。→ plan 方向:**分账**——no-ack 重投走独立计数(新列 `lease_retry_count` 或复用 `retry_count` 但投递失败不再加它?后者破坏 OFF 兼容)。倾向新列 `lease_retry_count INTEGER NOT NULL DEFAULT 0`(与 `delivered_at` 同一次幂等迁移)。
2. **红线①与到期扫描**:`countDeliverable` 只数 QUEUED 保证空闲时 30s 慢拍;到期扫描本身也是「读」,不违反「不主动发消息」;但**到期回 QUEUED 的行会把 tick 拉回 1s 活跃拍**——这是设计想要的(有活干)。扫描必须先看「有没有 LEASED 行」再干活(空表零查询开销约定:现 tick 每次也查,同量级,可接受;EXPLAIN 钉死走部分索引)。
3. **`mailbox_message_projection.delivered_at`**:现投影 LEASED→claim_expires_at 是 C 的近似。加真列后投影改为 `COALESCE(真列, 旧表达式)`?→ 查读者:CommDB Message shape 消费方(`check`/`pending` 等)。plan 里 rg 全量核读者后定;默认**不动投影**(OFF 字节兼容优先),真列仅供 lane/QA 用。
4. **no-transport runner(vendor='none',agy/kimi)**:C 下停 LEASED 等 pull。D 的到期重投对它:重投 = 再次 `no_transport` 空转,3 次后死信给 Lead——**这其实是对的**(agy/kimi runner 45 分钟不拉信 = Lead 该知道),但要确认重投对 `no_transport` 不计投递失败、门铃零成本。plan 定:no-transport 行照常走租约/死信闸(它正是「门铃到不了、只有租约能兜」的极端形态);`skippedReason='backend_commdb'` 同型。
5. **ON→OFF 收敛**:ON 留下的 delivered-未 ack LEASED 批(30min 租约),OFF 的 frozen-batch 路径(claimLeadBatch:637-676)的 SELECT 无 claim 谓词、UPDATE 三路守卫里 `claimed_by = 本 ownerEpoch` 放行 ⇒ 下一 tick 直接重领重投 + durable-accept ACK,收敛到 C 语义;attempt 后缀在 OFF 下不再生成,但 sidecar 已记 `#r0` 形态的 member id… **注意**:OFF 重领投递用裸 `delivery_id`,与 ON 首投的 `<id>#r0` 不同键 ⇒ 视为新 member 正常写入(无冲突,因为跨批闸只看精确 id 相等)。⇒ 收敛成立,但 ON 首投的 transport 键必须**恒带** `#r0` 后缀(不能 retry>0 才加),否则 OFF↔ON 切换会出现同裸键跨批冲突。plan 落为硬规则 + 双向切换测试。
6. **门铃头部与 membership 冻结**:批头部(批 id + ack 指引)若做成首成员 content 前缀,重投时 attempt 变化不改 content(fingerprint 校验 :565-576 只在同 batch 内比对,新 batch 新记录,无碍);Codex `modelPayload` 整包重渲染,同批 crash 重试须字节稳定 ⇒ 头部渲染必须确定性(禁时间戳)。
7. **死信通知行自身的死循环**:通知行是发给 Lead 的普通 model 行,它自己也受租约/死信闸管——Lead 3 次不 ack,通知行死了,它的死信……收件人是 Lead ⇒ 走 Lead 收件人路径(alert sink),不再产生 mailbox 行 ⇒ 环断。plan 加测试。
8. **stage/nudge 偶发 abort**(本 session 实测 `stage set`/ask nudge 撞 Bridge HTTP abort,durable 行不受影响):与 D 无耦合,不入 scope;QA 真机时留意别把它误判为 D 的投递失败。

## 7b. 勘误(Codex design review R1/R2 折入后,以 plan.md 为准)

本文以下三处原始结论在 review 中被推翻/收窄,保留原文供审计、以此节为准:
1. **§3「拉取清空该 exec 的全部在途行 ⇒ pull 是批 ack 的超集」不成立**:`check <qid>` 只 consume 一条 response,混类批会产生部分 ack。plan 定稿 = ack-同质组批(instruction 可合批,response 单件批,组批键含 ack-class 与 `lease_retry_count`)。
2. **§2.2 把 runner wake 幂等归于 `runner_phase_wakes`/`intentKey` 是错的**:production adapter 不持久化 `intentKey`,该账本 out-of-scope。真实幂等边界 = agent-team transport `writeMailboxEntry` 的 sidecar `flywheelId`;且存在假成功缝(`idempotent:true, finalized:false`,ClaudeMailboxCodec.ts:195-211)——ON 路径必须传 `verified: true` 并把 unverified 判为失败。
3. **§4 只提出 member 级 attempt 键不够**:同批身份也会冲突(`prepareBatchSidecar` 对已存在 batch 要求 membership 逐一相等)。plan 定稿 = **批 + 成员双 attempt 键**(`<batchId>#r<n>` / `<deliveryId>#r<n>`,ON 首投恒 `#r0`,ON 永不占用裸 id);runner 批的 sidecar 键 = transport batch id(一批 = 一次 `writeMailboxEntry`)。
4. **§1.1 表中「recordRunnerDeliveryFailure 保留(回 QUEUED)」对 ON 路径不成立**:ON 的 runner 批投递失败改 **frozen 式**(保 LEASED/batch_id/attempt 键,只加 transport `retry_count`,同键幂等重发)——回 QUEUED 换批 id 会让模糊失败二次响铃(Codex R2#3/R3#2);OFF 单行路径原样。no-ack 到期重投用**独立** `lease_retry_count`,`retry_count` 语义不变(疑点 1 的定案)。

## 8. 现有测试资产

- `mailbox-queue.test.ts` / `mailbox-schema.test.ts` / `mailbox-migration.test.ts`(flywheel-comm);`lead-inbox-loop` / `runner-mailbox-lane` 相关套件在 teamlead `__tests__`。D 全部新语义按 TDD 加测;OFF 路径以现套件全绿为字节兼容 sentinel(不许改既有断言,除非该断言本身描述 ON 行为——不存在,C 无 ON)。
