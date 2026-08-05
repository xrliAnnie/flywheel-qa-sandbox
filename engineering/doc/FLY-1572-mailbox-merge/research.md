# FLY-1572 合表 + 迁移:两张信箱表并成一张 mailbox — 调研

Issue: FLY-1572 (https://linear.app/geoforge3d/issue/FLY-1572/消息层重构-c-批次1-合表-迁移两张信箱表并成一张-mailbox)
日期: 2026-08-04
基于: exploration.md

> 三路并行代码审计(投递循环/适配器、lead_inbox 读写方、messages 读写方 + writer_gap 历史)的结论汇总。行号基于 worktree HEAD `e8de842e`。

## 1. 投递循环现状(lead-inbox-loop.ts,432 行)

### 1.1 结构

- **节奏**:活跃 1s / 空闲 30s(`:22-23`);活跃判定 = `hasLiveSession() OR queue.countPending(leadId) > 0`(`:159-179`,FLY-1599 教训:countPending 抛 SQLITE_BUSY 必须兜住,否则整 Bridge 死)。
- **门铃**:`nudge()`(`:148-157`)清 timer 立即跑;HTTP 入口 `POST /api/lead-inbox/nudge`(plugin.ts:2173-2191)→ registry → runtime → loop。
- **单 Lead 实例**:`LeadInboxLoop` 一实例一个 `leadId`;收件人发现在上一层 `LeadInboxRuntime`(lead-inbox-runtime.ts:91-165)——**构造时静态遍历** `projects[].leads[]`,一 `(project, lead)` 一 loop,一 project 一 `LeadInboxQueue`。**不存在任何动态收件人发现。**
- **每 tick**:recordTickStarted → acquireOrRenewOwner(丢租约即抛)→ `admit?()`(物化 CommDB 新问题/协议行)→ protocol 逐行 drain(claimProtocol→handleProtocol→markConsumed,attempts/backoff/死信 quarantine)→ model 批(claimModelBatch 一批/tick,`attempts===0` 才 revalidate)→ recordTickSuccess。
- **queue 接口边界恰好 11 个方法**(全同步 SQL):countPending / recordTickStarted / acquireOrRenewOwner / claimProtocol / isCurrentOwner / markConsumed / recordProtocolDeliveryFailure / claimModelBatch / recordTickSuccess / quarantineModelBatch / recordModelDeliveryFailure。
- **所有 claim/count SQL 都限定 `carrier='inbox'`** —— `carrier='external'` 影子行对循环结构性不可见(含部分索引 `idx_lead_inbox_pending ... WHERE carrier='inbox' AND consumed_at IS NULL`)。

### 1.2 owner 租约与 in-flight

- `loop_owner` 是**每库单例**(singleton=1),非 per-Lead;整个 Bridge 进程共用一个 `ownerEpoch`(lead-inbox-runtime.ts:82 randomUUID),BEGIN IMMEDIATE + CAS 续约(lead-inbox-queue.ts:1390-1438)。
- 循环在 4 个位点重查围栏:protocol effect 前、handoff 前、receipt 后、以及 markConsumed 改行数断言。
- **无显式 in-flight 上限**(maxBatchSize 默认 10,000),但 `claimModelBatch` 的「先领养已存在未消费批」逻辑(`:1553-1619`)形成**事实上的每收件人同时 1 批**。总纲 §4 的「3 批上限」属 D 单。
- 心跳独立:`loop_heartbeat`(per-Lead)由 recordTickStarted/Success 写。

### 1.3 适配器契约(「一行不改」的精确含义)

lead-delivery-adapter.ts(116 行,全部契约):

```ts
LeadDeliveryBatchMember { deliveryId; content; priority; seq }
LeadDeliveryBatch { batchId; leadId; ownerEpoch; members[]; modelPayload }
DurableAcceptReceipt { batchId; memberIds[]; status }
interface LeadDeliveryAdapter { deliverBatch(batch): Promise<DurableAcceptReceipt> }
```

- **Claude**(`:41-75`):member → `MailboxBatchMember{flywheelId: deliveryId, payload:{from:"bridge", to: leadId, content}}` → `writeMailboxBatch`(inbox.json + `.flywheel.jsonl` sidecar,三相写,重复同 membership 返 `accepted_duplicate_same_membership`)。忽略 modelPayload/priority/seq/ownerEpoch。
- **Codex**(`:77-115`):硬断言 `batch.leadId === opts.leadId`;`submitCodexLeadInboxBatch` 走 unix socket(`<stateDir>/lead-inbox.sock`,HMAC,5MB 上限),消费 **modelPayload 整包一 turn** + memberIds 回执。
- 新循环必须保的六件事:①`LeadDeliveryBatch` 形状逐字段不变(含 ownerEpoch);②**`deliveryId` = mailbox 行 id = 跨重试稳定的去重身份**(Claude sidecar dedupe key / Codex memberIds 元素);③一批只有一个收件人;④membership 冻结且有序(receipt 校验是按位置的,claim 必须稳定 `ORDER BY priority, seq`);⑤`membership_conflict` 是返回值不是 throw;⑥payload `from:"bridge"` / `to:<收件人>` 字节不变。
- **adapter 工厂**:lead-inbox-runtime.ts:390-417 `createProductionAdapter` 按 lead backend 分支(codex-app-server → Codex,否则 Claude);Claude 的 inboxPath 来自 `ClaudeCodeAdapter().getInboxPath(agentId, agentId)`。

### 1.4 Lead→Runner 今日路径(要被循环收编的对象)

- **100% 发送时同步直写,无队列无循环无适配器**:`wakeRunnerMailbox`(flywheel-comm/wake.ts:65-144)→ `deriveRunnerMailboxIdentity(execId, leadId)` = `{agentName:"runner-"+execId.slice(0,8), teamName:leadId}` → `transport.write({leadName, recipient, payload})` 写 `teams/<leadId>/inboxes/runner-<exec8>.json`。**注意是 `write` 不是 `writeMailboxBatch`** —— Runner 路径从未用批编解码器。
- Bridge 侧包装 `sendRunnerWake`(runner-wake.ts:105-243):`transport:"none"` 后端(antigravity/kimi)短路;receipt-wake ledger 分支走 `runner_phase_wakes` 表(claim→wake→complete,`UNIQUE(execution_id,message_id)`,t1=90s / claimTtl=30s)—— **这是现存最接近 per-Runner 耐久投递账本的东西**。
- 其他直写位点:plugin.ts:7356/8212/8440、gate-poller.ts:2754、auto-qa-effects.ts:696、CLI send.ts:154 / respond.ts:336-447。

### 1.5 founder→Lead 影子行(E 单前保持直推,但行要进 mailbox)

- **唯一影子行写入函数**:`beginChatReceipt`(flywheel-comm/commands/chat-receipt.ts:163-199)。id=`chat:<lead>:<msg>`,source=`discord_chat`,type=`external_delivery`,msgClass=`model`,**refMessageId 刻意 null**(避开全局唯一索引 idx_lead_inbox_ref),carrier=`external`。生命周期:completeChatReceipt→markExternalDelivered;settleChatReceipt→markProcessed(evidence)。调用方在仓外(Discord 插件 spawn CLI,dispatch 在 index.ts:230/763/786/798)。
- **第二个 external 生产者**:Codex Lead 跨部门 `ExternalReceiptSaga`(lead-backends/codex/ExternalReceiptSaga.ts:43-90),source=`discord_cross_department`,**会设 refMessageId**(与 chat-receipt 不同)。
- **第三套入站 id 词汇表**:`founder_msg:<lead>:<msg>`(founder-reply-routing.ts:19-25),消费在 founder-reply-deliverer.ts。此前 Codex design review 已把「双生产者」标为风险(doc/engineer/plan/v2/design-chain/codex-verdict-r1.md:74)。
- external 语义队列侧五函数:markExternalDelivered / listExternalDeliveryPending / listExternalPendingForLane / markExternalAborted / quarantineExternalDelivery(lead-inbox-queue.ts:1078-1297)。

### 1.6 boot 时序(合表不得打破)

`LeadInboxRuntime.ensureCutover()`(lead-inbox-runtime.ts:263-372):每 project 队列拿 owner 租约 → `freezeStockBelowWatermark`(耐久 MAX(seq) 水位线,disposition=`frozen_fly1586`,明确非钟表基)→ LegacyAckDrain → LegacyLeadEventReconciler(带真实 inbox+sidecar 探针)→ drainQuarantineAlerts(顺序有讲究)。

### 1.7 现存 lead_inbox 生产者清单(agent 3 视角,与 §2 互核)

- `enqueueLeadEvent`(lead-event-queue.ts:14-36,id=`lead_event:<lead>:<eventId>`,msgClass=model,priority 2,legacyAlias=旧 mailbox flywheelId)
- `ProtocolIngress.materializePending`(protocol-ingress.ts:71-98,id=`ack:<lead>:<receipt>`,protocol,priority 1)
- `QuestionAdmission.materializePending`(question-admission.ts:71)
- quarantine 自告警(lead-inbox-runtime.ts:135-147,id=`protocol_alert:<lead>:<row>`)
- `enqueueHubRoot`(lead-inbox-queue.ts:783)
- 两个 external 生产者(§1.5)

## 2. `lead_inbox` 全量读写方(37 列逐列判决)

### 2.1 物理 INSERT 只有 4 处(1 处已死)

| # | 位置 | 函数 | 状态 |
| -- | -- | -- | -- |
| I1 | lead-inbox-queue.ts:667 | `enqueue()`(:557) | **唯一通用写入口** |
| I2 | :1884 | `quarantineModelBatch()` 隔离告警自建行 | LIVE |
| I3 | :2001 | `reconcileEnqueueConsumed()` boot cutover 终态行 | LIVE |
| I4 | db.ts:4806 | `advanceDueUnprocessedReceipts()` **复制 resend 子行** | **DEAD(FLY-1570 后)** —— 这就是「重投=复制新行」的那行代码,已无生产调用者 |

### 2.2 四条流的入口实况(比总纲表格多一条)

- **founder→Lead 实际是两条路径**:①Discord 聊天影子行 `beginChatReceipt`(chat-receipt.ts:184,carrier=external,id=`chat:<lead>:<msg>`,仓外 CLI 触发);②**thread 内 founder 回复走 `enqueueFounderHubRoot`(founder-reply-deliverer.ts:574,carrier=inbox!,priority 0,id=`founder_msg:<lead>:<msg>`,routing_state=hub_recorded)—— 会进 inbox loop**。总纲表格只写了①,设计须分别处理。
- **Lead→Lead**:ExternalReceiptSaga(id=`xdept:<lead>:<msg>`,carrier=external);`begin()` 仓内无调用者(写入方在仓外 CLI),仓内只有 handle()/reconcile()。
- **Runner→Lead 双写的真身**:不是一个函数写两张表,而是「Runner 写 `messages`(insertQuestion)→ Bridge 每 tick `QuestionAdmission.materializePending`(question-admission.ts:169)镜像成 lead_inbox 行」。桥接键 `ref_message_id = messages.id` + 唯一索引 idx_lead_inbox_ref;血缘触发器 `receipt_root_lineage_capture`(db.ts:1195-1204)把两表钉在一起。**第二条双写 = protocol-ingress.ts:81(messages 的 ack_receipt → lead_inbox protocol 行)。**
- **other**:enqueueLeadEvent(lead-event-queue.ts:22,StateStore lead_events 的规范生产者)、protocol_quarantined 告警、legacy reconciler boot 补写。

### 2.3 消费路径

- **唯一消费循环 = lead-inbox-loop.ts**(全经 LeadInboxQueue,无裸 SQL)。mailbox-lead-runtime.ts / commdb-lead-runtime.ts **零 lead_inbox SQL**(渲染/传输层;生产 `deliver()` 是死路径,registry.leadEventEnqueuer 短路)。
- 但 **db.ts 里有 31 处对 lead_inbox 的裸 SQL**,多数属 receipt 链(FLY-1570 后大半已死,见 2.5)。
- 终态戳:markConsumed(:1726,主消费)、markExternalDelivered(:1097)、quarantineModelBatch、freezeStockBelowWatermark(boot 冻结)、closeReceiptFamily(supersede)、markProcessed / markDisposed(live 调用者:settleFounderHubRoot、routeFounderReply、handleReceipt、settleChatReceipt、ExternalReceiptSaga.handle;**respondAndReceipt / trustedFounder* 两位点无 live caller**)。
- **row 级租约(claimed_by/claim_expires_at)形同虚设的原因**:全进程单 ownerEpoch + 所有 claim 先过 loop_owner 单例围栏(10s TTL),`claim_expires_at < ?` 分支只在进程重启换 epoch 时可达,而那时 loop_owner 已先排他 —— row 租约从未独立生效。

### 2.4 issue「删 17 列」逐列核对 —— **5 列翻案**

| 判定 | 列 |
| -- | -- |
| **活的承重列,不能按 issue 直接删** | `consumed_at`(核心 pending 谓词+索引)、`delivered_at`(external lane 强依赖)、`carrier`(分流主键,所有 claim 带 `carrier='inbox'`)、`batch_id`(批次膜验证 live)、`next_retry_at`(claim 的 respectRetryAt + 失败退避 live) |
| 只写不读(写侧要一起拆) | `next_unprocessed_at`、`routing_state`(除 enqueueHubRoot 自校验外零读者)、`legacy_alias`、`resend_round`、`delivered_rounds` |
| 只读不写(靠历史数据;读者须重构) | `candidates_json` / `family_root_id`(routeFounderReply 读 legacy promoted family,LIVE)、`resend_of`(claim/settlement 谓词读,值恒 NULL 恒真;**getReceiptSettlementLineage 经 terminal-receipt-settlement.ts 是 LIVE**) |
| 完全死 | `read_at`(从未被任何 SQL 碰过)、`escalated_at`(FLY-1570 后) |
| 边界 | `receipt_exempt_reason`(markConsumed/markExternalDelivered 资格谓词)、`receipt_episode_id`(claimModelBatch 恒真 OR 分支) |

**语义解读**:翻案的 5 列不是「issue 错了要保留旧列」,而是「它们承载的语义会被新状态机接管」:`consumed_at`→`state='ACKED'+acked_at`;`delivered_at`(external)→external 生命周期映射;`carrier`→仍需分流机制(E 单前 external 行必须对循环结构性不可见);`batch_id`/`next_retry_at`→新 schema 本来就有/须补。设计必须给出逐列映射表,不能照抄 issue 的删除清单。

### 2.5 FLY-1570 之后的死代码清单(实施时一并清)

- db.ts receipt 链 10 个方法零 live caller:deriveProcessedReceipts(:4233)、reconcileReceiptActivation(:4371)、bootstrapUnprocessedReceipts(:4692)、advanceDueUnprocessedReceipts(:4722)、promoteDueFounderRebinds(:4874)、listPendingReceiptAlerts(:4885)、markUnprocessedReceiptEscalated(:5717)、markReceiptAlertDelivered(:5706)、revalidateReceiptAlert(:5551)、buildUnprocessedReceiptAlertPayload(:4907)。
- LeadInboxQueue 上:claimPending、claimHealthEpisode、recordFailure、recordProtocolFailure(零引用连测试都没有)、listExternalDeliveryPending、reconcileConsumed、listFrozenStock、listFencedRoots、listSanitationAudit。
- **receipt_alert_outbox 现在是只进不出的孤儿表**:6 个 live 写入点(quarantine/deliveryFailure/wake_cap/escalation),**零生产读者/投递者**(读侧全在被删的 patrol 里)。合表设计须表态(本单至少不扩大它)。

### 2.6 附带表与写闸门

- `loop_owner`:进程级围栏,**保留不动**;但注意它是每库单例 —— 循环扩容到所有收件人后仍是单 owner,设计要明说。
- `loop_heartbeat`:**`recordTickSuccess` 的 UPSERT SQL 内嵌 `SELECT 1 FROM lead_inbox …` 子查询(:2387)—— 表改名会穿透,必须一起改**。读者:watchdog-health.ts:109(/health 的 w2_delivery_loop)。
- `lead-inbox-freeze.ts`:非运行时闸门,boot 一次性水位线冻结(FREEZE_INSTALL_SCHEMA 持久化保 one-shot);其 NOT_FENCED 谓词的 4 个用点全在已死 receipt 方法里。
- `inbox-write-normalize.ts`:**真写闸门**,enqueue 事务内生效(身份/路由键 REJECT lone surrogate;content REPAIR+audit)。新 mailbox 写入口必须保留同等闸门。
- `text-truncate.ts`:所有能到达 lead_inbox 的边界先截断 —— 新表同样要。

## 8. 权威列清单勘误(生产 PRAGMA 实测,2026-08-04)

- **`messages` 实际 28 列,不是 issue 说的 22**。CREATE TABLE 21 列之外 migration 加了 7 列:`checkpoint`(gate 检查点,getPendingGatesByRunner 承重)、`content_ref`(大内容外溢,gate.ts live)、`content_type`、`resolved_at`(gate 解决戳)、`delivered_at`(instruction 投递状态机)、`attachments`(progress/artifact)、`kind`(report 等,runner-stopped live)。**这 7 列全部要进拆分对照表,issue 的对照表没覆盖它们。**
- `lead_inbox` 37 列与 schema 一致(21 base + 16 RECEIPT_LEAD_COLUMNS)。
- issue 的 mailbox DDL 草图与它自己的「留 14 列」清单不一致:清单含 `msg_class`、`last_error`,DDL 里没有 —— 设计定稿须补进 DDL(msg_class 驱动 protocol/model 双 lane,循环承重)。

## 3. `messages` 全量读写方 + writer_gap 历史

### 3.1 写入方(按 type)

| type | 写入函数(db.ts) | 调用方 / 流 |
| -- | -- | -- |
| `question` | `insertQuestion`(:1341,INSERT :1401/:1420) | `ask.ts:38`(Runner→Lead 非阻塞 ask)、`gate.ts:132`(阻塞 gate)、`runner-stopped.ts:556`(FLY-1571 停机报告)、`gate-materializer.ts:98`(Bridge 物化 approve_to_ship,确定性 id)、Codex gateway lifecycle-orchestrator.ts:170 |
| `response` | `insertResponse`(:1954)、`insertResponseIfGateOpen`(:2103)、`insertFounderApprovalResponseWithSource`(:2158)、`insertTimeoutResponse`(:2301,合成 TIMEOUT)、`routeFounderReply`(:2804)、`handleReceipt`(:3266)、`respondAndReceipt`(:3463)、`responseAndIntent`(:3577) | `respond.ts` 各分支、write-gate-response.ts、review-request-coordinator.ts:1480、CodexTmuxAdapter.ts:1337(timeout) |
| `instruction` | `insertInstruction`(:2541)、`insertInstructionWithId`(:2578,OR IGNORE)、`instructionAndIntent`(:3150,**与 runner_phase_wakes intent 同事务**) | `send.ts:60`(Lead→Runner 主路径)、plugin.ts:9206、event-route.ts:419/455、commdb-lead-runtime.ts(rollback 后端 Bridge→Lead)、proofshot-trigger.ts:352 等 |
| `progress` | `insertArtifactProgress`(:4082) | `notify.ts:261`(ProofShot)。**纯写入,src 无任何 SELECT 过滤 type='progress'** |
| `ack_receipt` | `insertAckReceipt`(:2024) | inbox-mcp delivery.ts:139;读者 getPendingAckReceipts(:2047)← protocol-ingress.ts:74 / legacy-ack-drain.ts:41 |

另:`migrateMessageTypeConstraint`(:1113)表重建拷贝 —— **加列时必须同步改它的列清单(:1155-1167)**。

### 3.2 读取方与过期删除

- 命令级:check(consumeGateResponse/getResponse)、gate(readonly 轮询 + 消费)、inbox(getUnreadInstructions→markInstructionRead→ackRunnerReceiptWakesStarted)、pending、complete(getPendingGatesByRunner)、verify-approval / verify-lifecycle-consent(getResponse)、runner-stopped(getPendingRunnerQuestion)。inbox-mcp push:getPendingPushInstructions(:5868)/ ackInstructionRead(:5943)。
- Bridge 级全走 CommDB 方法,**repo 内除 db.ts 与 v2-cutover/migration.ts:1148 外无裸 SQL 摸 messages**。重点:question-admission.ts:74 getPendingQuestions → 物化进 lead_inbox(拷 deadline_at,盖 markQuestionProtected)。`deriveProcessedReceipts`(:4233)JOIN lead_inbox ↔ messages 且**读 response.sender_lease_key / sender_generation**。
- **72h 过期删除的执行位置 = CommDB 构造函数(db.ts:784),每次读写 open 都跑**;openReadonly 跳过;无 cron。删除保护(FLY-1279,:1243-1250):过期但未 terminal_disposed 且无 response 的 question 免删。`cleanupReadMessagesWithRefs`(24h TTL)只有手动 `flywheel-comm cleanup` 会调。FK 强制子先删(children :1271 → parents :1279)。

### 3.3 「writer_gap」历史 —— 重要翻案发现

**字面 token `writer_gap` 与这 6 列无关**:repo 内所有命中都是 `packages/v2-dag/src/writer-gap.ts`(git-HEAD/commit-span 概念)。issue 里的 "writer_gap" 是 FLY-1572 自己的速记,**真正指向 FLY-1309(Lead 身份互斥)事故**:

> 2026-07-15/16,一个与真 Lead pane **同身份的第二进程**并存并发出一条未授权指令;事后无法回放定位 —— `messages` 行没有任何进程溯源(FLY-1309 research.md Gap C:「授权面零绑定、零溯源」)。三层修复 = lease mutex(预防)+ 双活检测(告警)+ **这 6 个溯源列(可回放)**。列生于 `1e87cf1d feat(fly-1309): persist lead instruction provenance`。

### 3.4 压缩成 `sender_ref` 的 5 条不可破约束(逐条带出处)

1. **holder 身份必须从 lease-generation HISTORY 按 claimed generation 解析,绝不冒充当前 holder**(FLY-1309 plan.md:256;代码 lead-lease.ts:2626-2627,history 缺失 → NULL + degraded)。
2. **writer_\* ≠ sender_holder_\***:writer 是瞬态 flywheel-comm CLI 子进程,holder 是长命 Lead pane —— 两个不同进程,合并即丢失事故所需证据。pid/start **仅作溯源记录,不作执法判据**(research.md:64)。
3. **bind 窗口不得产生 VALIDATED writer**:`validate()` 四态(missing_lease / stale_generation / unbound / missing_history)必须保持可区分(plan.md:100,Codex R2 #2)。
4. **⚠️ `sender_lease_key` + `sender_generation` 是活的授权数据,不只是遥测**:它们是 `ProcessedEvidenceV1` 的 fence(db.ts:4307-4310 / :4353-4356);`handle-receipt.ts:40-46` 缺 validated generation **硬失败**;`processedFenceFromProvenance`(db.ts:3067-3085)有三级降级梯:`{lease_key, lease_generation}` → `{writer_pid}` → `{authority:"lead_write_unprotected"}`(⇒ **writer_pid 也是活读者**,真正 write-only 的只有 sender_holder_pid / sender_holder_start / writer_start 三列)。**任何 sender_ref 方案必须让 lease_key 与 generation 保持机器可提取、且三级降级梯语义不变。**
5. **Runner 可见字节冻结**:`[lead-instruction <id>]` 前缀字节不变(FLY-208 幂等解析),溯源只走行内列 + envelope.metadata。

### 3.5 messages 其余列活性判决

| 列 | 判决 |
| -- | -- |
| `relay_state` | **LIVE 承重**('open'/'protected'/'terminal_disposed';答复性谓词 `!= 'terminal_disposed'` 出现在 18+ 处;purge 豁免也靠它) |
| `logical_event_id` | 只写 + 自身 UPDATE 幂等闩(question-admission 传 lead_events seq);**无任何 SELECT 读它** |
| `superseded_at/by` | LIVE 窄用(retireShipGate/retireQuestionGuarded 写;issue-gate-supersede.ts 读) |
| `resolved_via` | LIVE 薄用(supersede 家族写;唯一读 = already_settled 幂等判定 db.ts:1542) |
| `deadline_at` | 纯 pass-through:question-admission.ts:179 拷进 lead_inbox.deadline_at 驱动 SLA;messages 自身从不与 now 比较 |
| `parent_id` | 深度恰 1 的 question→response 树;**`idx_unique_response`(每问至多一答)是承重不变量**;NOT EXISTS「未答」谓词出现 27 处 |
| `read_at`/`delivered_at` | instruction 投递状态机(inserted→delivered(重试窗)→read);getPendingPushInstructions/:5868 注释 :5860-5866 |

### 3.6 messages ↔ runner_phase_wakes 的双词汇表(缺口全貌)

- `messages.id` = UUID/确定性 id;`runner_phase_wakes.message_id` = **因果意图键**:`instruction:<msgId>`(purpose=message_traffic,source_instruction_id 回链)、`gate-answer:<qid>`(purpose=park_wake,**无任何回链**)、`<responseId>` 裸 UUID(purpose=gate_response,唯一写者 insertReviewResponseWithWakeIfGateOpen db.ts:4034 —— **consumeGateResponse 本来就只为 Bridge review-verdict 路径设计**)、`founder-route:<msgId>`、`phase:<kind>:<exec>:<head>`。
- CLI respond 写的全部是 park_wake(respond.ts:125/189 → responseAndIntent db.ts:3644)⇒ `check` 够不着;通用消费者 `ackRunnerReceiptWakesStarted`(db.ts:5134)又只吃 `purpose='message_traffic'`(:5149)⇒ **活 Claude runner 的 park_wake gate-answer 行在 session finalize 之前无任何消费者** —— 与生产 pending=21 完全对上。
- admission cap(db.ts:3903-3927):per-exec 滑窗只数 `purpose != 'gate_response'`,超限 → `admission_state='suppressed_cap'` + receipt_alert_outbox。

## 4. `mailbox` 命名冲突(已确认,两条独立轴)

1. **`mailbox-lead-runtime.ts` 与 v2 kernel 无关**:那里的 "mailbox" 指 claude-code inbox JSON 文件传输(MailboxTransport),FLY-142 时代命名,不是 DB 表。生产上它的 `deliver()` 是死代码(registry 有 leadEventEnqueuer 时短路进队列),活的只有 `renderEnvelope`(产出 lead_inbox.content 字符串)+ `sendBootstrap`。
2. **`packages/v2-kernel` 已有一张叫 `mailbox` 的表**,在 `~/.flywheel/flywheel-v2.db`(paths.ts:4-8;0001-base-schema.ts:200-218,0005 重建,0004 七索引家族)。schema 语义近似但不同(`message_uid`/`source_kind`/`source_id`/`retention_class`/state=`pending|applied|dead`)。**不同库、不同包、不同生命周期 owner** —— 舰队 2026-07-31 已迁回 v1,本单的 mailbox 建在 v1 comm.db(`~/.flywheel/comm/<project>/comm.db`)。设计文档必须显式写明这条,防实施混淆。

## 5. 迁移机制可复用资产(v2-cutover)

`packages/v2-cutover/src/migration.ts`(1544 行)+ `database-lifecycle.ts` + v2-kernel `backup.ts` / `rollback-fence.ts`:

- **在线备份**:`backupDatabase` —— SQLite online backup API(WAL-safe)→ `.tmp`(0600)→ integrity_check + foreign_key_check + schema_migrations checksum 对齐 → 清 `-journal/-shm/-wal` 残件。
- **staging→promote**:`prepareStagingDatabase`(三态 prepared/already_prepared/already_promoted,幂等)→ `promoteStagingDatabase`(三态;staging+final 双存在拒绝;`wal_checkpoint(TRUNCATE)` 必须全排干;rename → fsync 目录 → 发标记 → 复验;每步带 fault 注入 seam)。
- **rollback fence**:meta 三键 `cutover_authority_state` / `rollback_state` / `external_effect_intent_count`,缺失/畸形皆 fail-closed。
- **幂等核心**:`INSERT OR IGNORE` + changes==0 时按唯一键回读逐字节比对,分歧 → `migration canonical conflict`,一致 → 计 duplicate。
- 它本身就直接读 `messages` + `lead_inbox`(readLegacySourceSnapshot:1114-1370,含 carrier='external' 的测试覆盖)—— 字段映射经验可直接抄。
- **判决:骨架可复用**。本单迁移是「同库建新表 + 搬行」而非「换库文件」,所以 staging-file/promote 那层可简化,但 备份+验证+fence+幂等比对 四件套照抄。

## 6. 现场证据复核(consumeGateResponse)

亲读 db.ts:5897-5936 确认 issue 描述属实:consume 的 UPDATE 只匹配 `purpose='gate_response' AND message_id=<response uuid>`,而 park_wake 行是 `purpose='park_wake'` + `message_id='gate-answer:<qid>'`,双字段不匹配 → 永远 pending。生产 runner_phase_wakes:finished 1,863 / started 300 / pending 21(2026-08-04)。**病根 = 同一义务两套 id 词汇表**。本单管身份模型统一,重投/死信行为归 D 单(FLY-1573)。

## 7. 生产数据快照(2026-08-04)

| 表 | 行数 | 备注 |
| -- | -- | -- |
| lead_inbox | 49,531(未消费 9) | FLY-1570 后重发风暴已停 |
| messages | 687 | 72h 窗口内 |
| runner_phase_wakes | 2,184(pending 21) | 结构性漏 21 行 |
| comm.db 文件 | 145MB | |
