# FLY-1645 收据账本机器拆除 — 调研

Issue: FLY-1645 (https://linear.app/geoforge3d/issue/FLY-1645/消息层重裁-b-拆除收据账本机器relay-statesettle-通路-义务账归-1575-task-表排-1575-之后)
日期: 2026-08-11
基于: exploration.md

调研方法:4 路并行代码审计(flywheel-comm 全量 / teamlead+edge-worker 全量 / Discord plugin fork 全量 / 重投发射器定向)+ 产线 comm.db 只读取证 + 旧修复 plan(origin @78ade7f7)病理对照 + **前轮保全审计对照**(`origin/flywheel-FLY-1645-audit-preserve`,Lead 指令 047a2ee0 指定必读——本轮独立审计与其两租户结论完全收敛,见 §0)。所有 file:line 均为本 worktree(main @ d6536134)实测。

## 0. 前轮保全审计对照(独立双审计收敛 + 三处口径修正)

本轮 4 路审计与前轮(audit-preserve)在**互不知情**的情况下得出同一核心结构:relay_state 两租户(A=gate/question 40+ 消费点不许碰;B=收据台账,拆除对象)、settle 只写 mailbox_log 不碰行、`NOT EXISTS settlement` 是账本唯一行为级消费者。前轮另有三个本轮据此修正口径的发现:

1. **「零系统自动结清」是度量假象**:issue 的判据查的是行本体三列(半账 A)——而自动结清路(`settleChatReceipt`)**按设计只写 mailbox_log(半账 B)**,产线有 1,554 条 `discord_explicit_reply` processed 结算证明触发点一直在正常触发。真实的病不是「机器没转」,是**一条收据的关闭被拆成两个互不相干的半账、没有任何代码保证一致**(前轮实测两半分歧率 ~85%,跨 growth/tidal-echo 项目库同型复现)。半账 A 全库只有运维 sweep 写过——它是一根**没人读**的列(chat 通路上)。
2. **chat lane 的 settle 驱动重投已被 FLY-1646/#784 切断**(`state <> 'ACKED'` 主闸恢复):前轮实测当前 `listExternalPending` pending 集合仅 3 条(全在 QA 测试槽),生产 Lead = 0。8-10 实弹的两条腿因此归因更准:boot 洪水 = E1 对**未 ACKED**存量的重播;无限批重投 = E2(founder_msg inbox 行,租约级,见 §8)。
3. **1573 队列结构性拒绝义务账**(前轮 §6 逐边证明):`ackBatchByRecipient` LEASED→ACKED 后**不存在 ACKED→QUEUED 回头边**(仅有的两处回 QUEUED 写法都带 `state='LEASED'` 硬闸)——队列按铁律①设计,ack 即终局、永不再催。⇒ 拆除后「acked 但没办」的义务追踪只能由 1575 task 表承担;**1575 前置已由 Lead/founder 豁免**(lead-instruction 047a2ee0:「义务账由 FLY-1573/1574 新信箱队列接管(1575 前置已豁免)」),间隙姿态 = ack 层承接(送到即止),task 层验收移交 1575 落地时联合执行。

**新增活体病例(lead-instruction 69f1369b,2026-08-11)**:`publish-report` 的 bot 回声消息(claw-infra-bot 自动发的交付贴)也给 Lead 铸 chat receipt;而 v2 载体下 `handle-receipt` 因 lease 未绑直接报错(handle-receipt.ts:44),唯一能走通的结清路是往 thread 里发一条带 `reply_to` 的回复——**被迫制造噪音才能关账**。机器替 agent 建了一张它关不掉的账的现行犯。

---

## 1. 三套同名系统 — 域判定表(本单最重要的一张表)

"receipt" 一词在代码库里有**三套互不相干的系统**。拆错域 = 拆掉正在承重的东西:

| 域 | 实体 | 判定 |
|---|---|---|
| **A. 消息义务账本**(本单拆除对象):`receipt_root_lineage` + `mailbox_log` settlement(processed/disposed)+ 收据行铸造(chat:/founder_msg:/lead_event:/hub root)+ 重投直到 settle + `handle-receipt`/`route-founder-reply`/`chat-receipt settle` + `receipt_settlement_intent`(StateStore)+ `FLYWHEEL_RECEIPT_FOUNDATION` | **拆** |
| **B. Founder 审批电路**(FLY-1448,#696 起无条件生效):`approve_to_ship` question/response、`trustedFounderGateResponseAndReceipt` 的 gate-response+attribution 半边、founder-ack ✅ reaction、`/api/founder-consent/*`、`verify-approval`(只读 `superseded_at`,不读 settlement) | **留** |
| **C. 其他撞名系统**:`alert_delivery_receipts`(StateStore 告警投递)、`disposition_receipts`(FLY-1282)、runner phase wake「started receipts」(`runner_phase_wakes`/`receipt_alert_outbox`)、`session_receipt_lineage`(runner 身份)、workflow completion receipts(`wfc:`)、land/merge manifest receipts、carrier self-check receipts(`lead-lease.ts` 文件系统)、`ack_receipt` 协议行(`ack-event`,1573 投递层 ACK)、`[lead-instruction] 消费 receipt`(prose) | **留** |

## 2. 关键修正:`relay_state` 三列不是收据机器

审计推翻了 issue 验收原文的一个隐含假设。`relay_state`/`resolved_at`/`resolved_via` 是 **question/gate 生命周期的 answerability 轴**(FLY-1188/1099/1328/1314),在 db.ts 有 40+ 个 gate 域读写点:

- 写:`claimLifecycleConsent`(db.ts:1074)、`retireShipGate`(:1097)、`retireQuestionGuarded`(:1398)、`resolveGate`(:1562)、`markQuestionProtected`(:1687)、`markQuestionTerminalDisposed`(:1702)、`insertTimeoutResponse`(:1922)、`finalizeSession`(:5123)、投递时 question 升 protected(mailbox-queue.ts:755)
- 读:`isQuestionPending`(:1462)、supersede 巡逻(:1480/1506/1531)、gate TOCTOU 关闭(:1721)、`getPendingQuestions`(:2086)、动态超时(:4251/4276)、`archiveFamily` not-due(mailbox-queue.ts:2343)等

这套用法**有 owner(引擎)、有确定性关闭路径**,不违反 1569 两条铁律——它是 request/response 状态机,不是「替 agent 记办没办」。收据 lane 只是**蹭了这根列**:收据行出生即 `relay_state='open'`(schema 默认),而收据侧从未有任何 writer 把它关上(全库零条系统自动结清的直接机理)。

**⇒ 拆除姿态:列留人走。** 三列物理保留、归属 question 生命周期;收据侧消费者清零。issue 验收「grep 无 relay_state 消费者」相应细化为「无收据域 relay_state 消费者」(§8 逐条列出幸存 gate 域函数名单作为 grep 白名单)。唯一的 teamlead 侧 relay_state 读点 plugin.ts:7231(founder-decision convergence 判 question_retired)改用 `resolved_at`/`superseded_at` 表达,让 teamlead 对 relay_state 的引用归零。

同理 `superseded_at`/`superseded_by` 是 FLY-1314 supersede 巡逻 + FLY-1041 gate rebind 的列——**留**。仅 `TERMINAL_RECEIPT_DISPOSAL_KINDS` 里的 `superseded_*` evidence 字符串(db.ts:588-593)属于收据机器,随机器拆。

## 3. 拆除清单 — flywheel-comm

### 3.1 settlement 原语(全拆)
| 位置 | 对象 |
|---|---|
| mailbox-queue.ts:2163-2212 | `settle()`(11 个调用点全在拆除面内,见下) |
| mailbox-queue.ts:2214-2229 | `getSettlement()`(4 个调用点全在拆除面内) |
| mailbox-queue.ts:73-81, 210-252 | `ProcessedEvidenceV1` + `assertProcessedEvidence()` |
| mailbox-queue.ts:168-172 | `MailboxSettlement` 类型 |
| mailbox-schema.ts:158-159 | `mailbox_log_settlement_slot` 唯一索引(DROP INDEX) |
| db.ts:588-624 | `TERMINAL_RECEIPT_DISPOSAL_KINDS` + `isEquivalentTerminalReceiptDisposal()` |

`settle()` 全部调用点(拆除时逐一处置):db.ts:1223(supersede 家族 settle 半边)、:1378(`settleReceiptFamilyForTerminalSubject` 整函数)、:2397(`settleFounderHubRoot` 整函数)、:2542/:2618(`routeFounderReply` 两分支)、:2826(`handleReceipt`)、:2952(`respondAndReceipt`)、:3024(`trustedFounderApprovalAndReceipt` settle 半边)、:3113(`trustedFounderGateResponseAndReceipt` settle 半边)、chat-receipt.ts:310(`settleChatReceipt`)、mailbox-migration.ts:822 + :776-785(迁移 replay,见 §7 迁移处置)、teamlead ExternalReceiptSaga.ts:84(§5)。

### 3.2 收据 CLI 与 db.ts 后端
| 位置 | 对象 | 处置 |
|---|---|---|
| commands/handle-receipt.ts(全文件)+ index.ts:226 注册 + db.ts:2688 `handleReceipt()` + `receipt_handle_requests` 表(mailbox-schema.ts:214-221) | ack/no-route = 纯记账零业务效果;relay/respond = 记账 + enqueue response + 关 question | **删**。relay/respond 的业务半边由既有 `respond` CLI 承接(insertResponse + gate marker,commands/respond.ts——已是标准答题动词) |
| commands/route-founder-reply.ts(全文件)+ index.ts:223 注册 + db.ts:2452 `routeFounderReply()` | 路由半边(scope binding/stale_candidate/enqueue response/关 question)与记账半边(getSettlement 重放重构/settle) | **删整函数**。路由半边同样由 `respond` 承接(founder 回复进 gate 的 Bridge 自动路径 = FLY-1448 `tryFounderShipApproval`,不经此函数;Lead 手动转交 = `respond`)。注:db.ts:2445-2451 的「durable wake intent」注释是过时散文,函数体并无 wake 写入(实测) |
| commands/chat-receipt.ts:284-339 `settleChatReceipt` + index.ts `settle` 子命令 | 1574 lane 上已是 no-op(`ignored_inbox`,chat-receipt.ts:299-300),只对 legacy external 行生效 | **删** |
| chat-receipt.ts:215 `beginChatReceipt` / :265 `completeChatReceipt` / :341 `listPendingChatReceipts` / :386 `quarantineChatReceipt` + index.ts begin/complete/pending/quarantine 子命令 + db.ts:2419 `listChatReceiptPending` / :2430 `quarantineChatReceipt` | legacy external chat lane(=0 直推流的耐久壳) | **删**(D1 裁定:legacy chat lane 整拆,见 §9-D1) |
| db.ts:2246 `enqueueFounderHubRoot` / :2274 `settleFounderHubRoot`(135 行 evidence 交叉校验)/ :1250 `listReceiptRootsForExecution` / :1263 `getReceiptSettlementLineage` / :1312 `settleReceiptFamilyForTerminalSubject` / :2866 `respondAndReceipt` | founder hub root 铸造 + 家族清算 API | **删** |
| db.ts:2962 `trustedFounderApprovalAndReceipt` / :3035 `trustedFounderGateResponseAndReceipt` | 域 B 承重函数,settle 只是搭车 | **手术**:保 gate-response + founder attribution 事务,摘除 settle 调用;更名去掉 `AndReceipt` 谎名(调用点少,同 PR 内完成) |
| db.ts:1131 `supersedeShipGateAndReceiptFamily` | 一事务两域:gate CAS(留)+ receipt family settle(拆);幂等键还从账本侧派生(:1167-1169) | **删整函数**,3 个终局权威调用点改指既有 `retireShipGate`(db.ts:1096-1122,同款双守卫 CAS、零收据接触;issue-gate-supersede.ts:207 / zombie-gate-hygiene.ts:386 / plugin.ts:6914 已在用) |
| mailbox-schema.ts:182-203 | `receipt_root_lineage` 表 + `mailbox_receipt_root_lineage_insert` 触发器(**hot path**:每条 Lead-bound question INSERT 都触发) | **删**(消费者仅 projector + supersede 家族 settle,全在拆除面内) |
| (产线库残留,源码零消费者——本轮 grep 实证) | `receipt_activation_episodes` / `receipt_resend_deliveries` / `receipt_exemption_audit` 三张 FLY-1426 时代遗留表 | **迁移步 DROP**(仅产线库存在;schema 源码已无定义) |
| founder-reply-routing.ts | `founder_msg:` id 铸造(:20)及路由态机 | **删**(随 hub root) |

### 3.3 external carrier 与重投谓词
| 位置 | 对象 | 处置 |
|---|---|---|
| mailbox-queue.ts:653-688 `listExternalPending` 的 `NOT EXISTS settlement` 子句 | 投递谓词读账本——全库最硬的一处耦合 | **手术**:xdept lane(§5)仍需 `listExternalPending`;谓词去掉 settlement 子句,终态信号只剩 `state='ACKED'`(本就是主守卫)。**风险**:历史已 settle 但未 ACKED 的 external 行会重新可见——由 §7 存量 sweep 先把这类行收敛(ACKED 或 DEAD)后再上线,并以生产谓词预演证明集合为空 |
| mailbox-queue.ts:486-531 `claimDiscordLane` | 五值 verdict;`inserted_external`/`legacy_external` 两值随 legacy chat lane 退役 | **手术**:保 inbox 三值(chat-ingest 用);external 二值待 plugin 侧同批退役后收窄(双仓同批,§6) |
| mailbox-queue.ts:594-619 `markExternalDelivered` / :690-704 `markDead` / :539-568 `getIdentityCarrier` / QUARANTINE_DEAD_REASONS | xdept 投递层仍用 | **留** |

### 3.4 幸存(明确不碰)
`mailbox_log` 表本体 + append-only 触发器 + `archived`/`migrated_history`/`migration_snapshot`/`progress` 四类事件(`progress` 唯一 writer = db.ts:3200 `insertArtifactProgress`,GEO-151 ProofShot 审计);`ack_receipt` 协议行(db.ts:1616-1674 + ack-event CLI,1573 投递 ACK);`chat-receipt.ts` 的 envelope codec(`CHAT_RECEIPT_ENVELOPE_PREFIX`/`ChatReceiptEnvelopeV1`/`chatReceiptId`/encode/parse/normalize——**这是 chat 载荷格式,1574 ingest 与 Bridge 路由解析在用**,从 chat-receipt.ts 迁至 ingest 侧模块并保留 `chat:` id 公式作 dedupe 键[CodexDiscordMailboxStrategy.ts:79-83 在用]);`discord-chat-ingest.ts` 全部;lead-lease.ts 的 carrier self-check receipts;`mailbox_message_projection` 视图(列仍在,视图不动)。

## 4. 拆除清单 — teamlead / StateStore

| 位置 | 对象 | 处置 |
|---|---|---|
| bridge/terminal-receipt-settlement.ts(477 行整文件)+ plugin.ts:6554-6559/:7216-7221/:7305-7311 接线 | 终局清算 projector(session_terminal / issue_done / pr_merged 三权威) | **删整文件**。其中唯一承重副作用(终局时退休未答 ship gate)改指 `retireShipGate`,三权威调用点:done-thread-reconcile.ts:191-201/:468-486/:855-871(`settleIssueReceipts` dep)、external-merge-reconcile.ts:191-200/:877-900(`settleMergedReceipts` dep)、plugin.ts patrol tick |
| StateStore.ts:724-738/:2742-2770 `receipt_settlement_intent` 表 + :4960-5320 全套 ensure/claim/fence/retry/complete + :4767-4842 会话终态转换热路径上的 intent 自动铸造 | 意向账(每个 session 终态都铸一条) | **删**(保 `terminal_lifecycle_id` 生成——pane-loss 围栏与 credential 撤销在用,StateStore.ts:4820-4823) |
| StateStore.ts:12536-12640 `listActiveLegacyReceiptDetections*`/`attachLegacyReceiptDetectionLineage`/`resolveReceiptDetectionsForExecution` + `detection_escalations.source_receipt_id` 列(:3865)| `receipt_unprocessed%` 检测 lane | **删 lane 与列**(表共享,不动表;同步改 `DETECTION_ESCALATION_COLUMNS` 与 stuck-remanage-routes.ts:75/:380) |
| founder-reply-deliverer.ts:566-579 `enqueueFounderHubRoot` / :386-395 与 :670-712 `settleFounderHubRoot` + `founder_root_evidence_conflict` 审计 | founder 消息义务收据铸造与清算(冲突时整个投递失败——「毒化」面) | **删**(投递/路由/审批半边全留:founderReplyDeliverPass、emitFounderReplyDeliveryForThread、tryFounderShipApproval、founder-ack ✅) |
| gate-poller.ts:3177-3182 handoff `action` 文本 | 指示 Lead 跑 `route-founder-reply` / `--no-route --reason lead_handled` | **改写**为纯路由指示(用 `respond`;无收据关闭义务) |
| gate-poller.ts:241-1120 内 `receiptFoundationEnabled`/`receiptFoundationOff()`/`emitReceiptFoundationOffAlert()` + config/src/feature-flags/receipt-foundation.ts + plugin.ts:53/:7359 | `FLYWHEEL_RECEIPT_FOUNDATION` kill switch + CRITICAL「追办已暂停」告警 | **删整 flag**(拆除后无物可关)。alert kind `receipt_foundation_off` 同步从 LeadAlertNotifier.ts:331-333 / LeadWatchdog.ts:792/:1080 / infra-event-router.ts:44 / kind-contract.ts:128 移除(kind-contract 测试同步) |
| plugin.ts:7231 | teamlead 唯一 relay_state 读点 | **改写**为 `resolved_at`/`superseded_at` 判定 |
| lead-inbox-loop.ts:439/:453 | 批载荷渲染 `[receipt:<delivery_id>]` token(只为 handle-receipt 存在;与幸存的 `flywheel_inbox_ack_batch` 批 ACK 无关) | **删 token**(载荷格式变化,lead-inbox-loop.test.ts:143/:186-187 同步) |
| lead-rules-base/discord-reply-contract.md:20-45 | 「Durable inbound chat receipts (FLY-1426)」整节(收据公式/reply_to 关账/handle-receipt ack/重投提醒契约) | **删节**(:1-18 FLY-387 reply-tool 契约保留);discord-chat-receipt-contract.test.ts 整删 |
| ExternalReceiptSaga.ts:71-98 `handle()` | xdept 投递 saga 中唯一的账本写入(settle processed) | **手术**:摘除 settle;begin/complete/reconcile(投递+死信卫生)全留(§5) |

## 5. xdept lane 判定(external carrier 的幸存部分)

`ExternalReceiptSaga`(Codex Lead 跨部门消息投递)以 `xdept:<lead>:<msgId>` external 行做 **intent-before-accept 投递记账**:begin(enqueue external)→ complete(markExternalDelivered→ACKED)→ reconcile(listExternalPending + markDead)。这是铁律①允许的「送到没送到」——**留**。只摘 `handle()` 的 settle 写入(投递终态由 ACKED 表达,settlement 无读者依赖:complete 已把行收敛出 pending 集合)。调用方(codex-lead-runtime / codex-lead-tui-runtime / CodexDiscordGateway / CodexDiscordMailboxStrategy)零变化。

⇒ **external carrier 机制幸存**(为 xdept),死的是 legacy chat lane(`chat:` 前缀的 external 行铸造与全部五个子命令)与谓词里的 settlement 依赖。

## 6. 拆除清单 — Discord plugin fork(第二仓)

Canonical 源:`xrliAnnie/claude-plugins-official` subdir `external_plugins/discord`(本地 clone `~/.flywheel/repos/claude-plugins-official`,HEAD 49c8c47 = cache 逐字节一致;**改 clone 不改 cache**,cache 由 `~/.flywheel/bin/update-discord-plugin.sh` 刷新,~20 个活 Lead 进程 pin 在 cache 上)。

| 位置(chat-receipt-runtime.ts 除注明外) | 对象 | 处置 |
|---|---|---|
| :179-195 `acceptInbound` | 双流 fork(flag ON→ingest / OFF→begin legacy) | **手术**:收敛为无条件 `ingest()`(=删除 `FLYWHEEL_MAILBOX_DISCORD=0` 旧流,D1) |
| :197-229 `beginWithVerdict` / :284-293 `complete` / :295-308 `deliver` / :912-936 `receiptNotification`(`meta.receipt_id` 唯一产地 + `[redelivery] ` 前缀 :920)/ :974-999 `beginFlags` / :718-749 `invoke` | legacy 收据铸造/投递 | **删** |
| **:642-716 `reconcilePendingPass`** + :106-111 pacing 常量 + :1032-1051 `parsePendingPage` | **重投发射器本体**(`chat-receipt pending` 分页扫→48h quarantine→`[redelivery]` 重发→complete;触发:Discord ready + 每次 inbound accept 之后 + settle 失败,无定时器) | **删** |
| :310-359 `settle` + :790-800 `invokeSettle` + :593-640 `drainSettlePass` + settle intent 全家 + server.ts:1238-1256 `onSent` settle 包装 | reply_to → settle 链 | **删**(server.ts onSent 还原为素 `noteSent`) |
| :527-591 `drainSpoolPass` + SpoolIntentV1 的 begin 重试 | legacy begin 重试 | **删**(注意:`parseSpoolIntent`/`normalizeBeginArgs` codec 被 **ingest intent 恢复**复用[:1152-1171 readIngestIntent],**codec 留**——hazard #4) |
| chat-receipt-recorder.ts:238-251 三段 receipt 文案(`receiptInboundInstruction` = 本会话 MCP instructions 里那句「receipted message 必须 reply_to…handle-receipt ack」的源头) | 回复契约文本 | **删**,恒返 STOCK_* 三段(server.ts:994/:1078/:1090 注入点) |
| chat-receipt-recorder.ts:106-108 `FLYWHEEL_CHAT_RECEIPTS=0` kill switch | **当下活雷**:名为收据开关,实际把 1574 ingest 一起杀掉静默丢消息 | **删开关**(耐久入站不再可被此环境变量关闭) |
| **KEEP(1574 ingest 全家)** | `ingest`(:231-282)/`invokeIngest`(:751-779)/`ingestFlags`(:1001-1030,载 `--founder-id`/`--reply-channel-id`/`--reply-route-json` 路由)/ingest worker+retry+intent(:417-496, :853-872, :1152-1186)/`RecorderMode`(能力门,供 ingest 用)/`adviseWithMarker` 谱系/`parseLaneVerdict`(ingest 唯一 commit 证明)/roundtable 路由模块群/reply-send/retry | **留**(手术项:`kickWorker`:404-409 收敛为只踢 ingest;`diagnoseNode` 保 `chat-ingest --version-probe`;`spoolDir` 目录嵌套[`ingest/`+`meta/` 在 `chat-receipt-spool/` 内]保路径或带迁移改名——hazard #7) |

## 7. 存量数据与迁移处置

产线 ground truth(2026-08-11,`~/.flywheel/comm/flywheel/comm.db` 只读;其余项目 shard 同谓词另查):

```
external 行:2,760(chat: 全部;2,748 ACKED + 12 QUEUED)   settlement:processed 43,921 / disposed 10,351
relay_state='open':201(8-08 后新增 29,持续累积)          死信残留:founder_reply_dead_letter ×2 + delivery_dead_letter ×1
1574 inbox chat 行:10(正常投递中)                        重要:type 各异,sweep 谓词不得按单一 type 过滤(HL 提醒)
```

处置(一次性 operator sweep 程式,随 PR 交付、拆除上线前跑):

1. **收据行终局化**:`relay_state='open' AND type != 'question'` 的行(三条 lane + uuid 杂项)统一 `terminal_disposed` + `resolved_via='fly1645_teardown_final_sweep'`——这是**最后一次** relay 账写入,目的:让历史审计口径自洽(全部非 question 行有终局标记),消除「标签当实体」类误读(方法论:issue 评论 2026-08-11)。
2. **listExternalPending 谓词收敛前置**:已 settle 未 ACKED 的 external 行(§3.3 风险集)→ 按 delivered 证据补 ACKED 或 markDead;上线前生产谓词预演证明集合为空。
3. **死信残留 3 条**:核对后随 sweep 终局化(type 多样,谓词按 `dead_reason`+id 前缀而非 type)。
4. **未处理 founder 消息义务**:sweep 前人工 review `founder_msg:`/hub root open 行(量级 ~个位数),该办的直接办/建 task(1575 在则)——不做自动转换(量级不值机器)。
5. **mailbox_log 历史 settlement 行**:append-only,**一行不动**(no_delete 触发器保护;历史是审计不是机器)。`mailbox_log` 的 event CHECK 保留 processed/disposed 两个历史值(改 CHECK 需重建表,零收益)。
6. **mailbox-migration.ts**:迁移引擎保留(其它 shard/回放需要)。其 settlement replay(:776-785 直写 + :822 经 settle())改为统一直写 mailbox_log(历史保真),不再依赖 `settle()`;`classifyLead` 从 legacy settlement 派生 ACKED/DEAD(:350-406)不动——那是迁移映射逻辑。

## 8. 重投发射器全景(定向审计 + 8-10 实弹归因)

**双胞胎铸造(根源发现)**:一条 founder Discord 消息同时铸**两条**收据——plugin lane 的 `chat:<lead>:<msgId>`(carrier=external)+ Bridge lane 的 `founder_msg:<lead>:<msgId>` hub root(carrier=**inbox**,model-class,db.ts:2246 经 founder-reply-deliverer.ts:566)。两条各有一台重投机、关闭动词互不相通:`route-founder-reply` 只 settle founder root 的账(还只写账不动行),`chat:` 孪生行需要 Discord `reply_to` 走 `settleChatReceipt`。**任何单边处理都留一条永动债。**

| # | 发射器 | 触发 | 谓词 | 判定 |
|---|---|---|---|---|
| E1 | plugin `reconcilePendingPass`(chat-receipt-runtime.ts:642)→ 每行一条 `notifications/claude/channel` 直灌 session,`[redelivery] ` 前缀唯一产地(:920) | Discord `ready`(server.ts:1720,**每个 Lead session 启动**)+ 每条入站消息后(:1713)+ 自递归(`workRemains` 环) | `listExternalPending`:external + state≠ACKED + `chat:` 前缀 + NOT EXISTS settlement;100 行/pass 自续 | **拆**(= 实弹 (a):837 条 boot 洪水的主发射器,逐行、无背压、自递归) |
| E2 | Lead inbox 批投递 `LeadInboxLoop.tick`(lead-inbox-loop.ts:203)+ `reconcileExpiredLeases`(mailbox-queue.ts:1286) | 1s/30s 间隔 + doorbell | 纯行态:QUEUED/租约过期,**无 settlement 子句**;`frozenResend` 分支(:1480-1489,全员 delivered_at NULL 时)原批重投**不计 retry,无上限** | **混合**:传输(claim/deliver/ack)= 1573 投递层,留;拆的是它承运的义务货——`founder_msg:` 行本身与 `[receipt:<delivery_id>]` token(= 实弹 (b) 的「成批」节奏:Lead 认为已办不 ack → 冻批无限重臂) |
| E3 | `ExternalReceiptSaga.reconcile`(xdept lane) | Codex backend 调用 | listExternalPending(xdept 前缀) | 留(投递+死信卫生;不向 Lead 重发) |
| E4 | `getPendingQuestions`(db.ts:2086)消费者:`pending` CLI / gate-poller founder pass(≈60s)/ bootstrap-generator(boot 快照) | 各自 | type='question' + 无 response + relay_state≠terminal_disposed | 留(question 域;有界快照非逐行重播) |
| E5 | legacy-lead-event-reconciler(StateStore:10749)/ GEO-151 HeartbeatService redelivery loop | 无生产调用方(`runLegacyCutover` 无人供给)/ 全部引用是注释 | — | 休眠/已被 mailbox 队列取代,不在本单(不碰) |

**实弹归因(定稿)**:(a) 837 条 boot 洪水 = E1(唯一在**新 session 启动**时逐行直灌 context 的发射器);(b) 13 条无限批重投 = E1+E2 耦合——`chat:` 孪生供 `[redelivery]` 前缀,`founder_msg:` 冻批供「成批」节奏;结构性证明 = `settle()` 只写 mailbox_log 不碰行(mailbox-queue.ts:2163),而两台发射器的谓词都只读行态。**拆除从铸造根切断双胞胎,两台义务重投机同灭。**

诚实边界:E2 的 `frozenResend` 无上限分支是 1573 投递域的既有边缘(对「从未投出的批」不计 retry),拆除后它只承运真消息(Lead 该 ack 的),不再有「Lead 认为已办却永不 ack」的义务行进环——该分支本体不在本单。

## 9. 决策记录(exploration §6 的 D1–D5 收敛)

- **D1(裁定:legacy chat lane 整拆,含 =0 旧流——带显式解锁门)**:重投发射器是机器心脏(「无重投扫描」是 issue 验收原文),留半台机器 = 留一台还在铸行没人关账的机器。注意 registry 里 `mailbox_discord` **default=false、=0 是 founder 要求的验证窗回滚路径**(registry.ts:3201-3226)——因此旧流退役必须带**解锁门证据**而非默认成立:①产线 `.env` 与活 Bridge env 均 =1(本轮实测);②1574 lane 产线健康流转(inbox chat 行 8 ACKED + 2 LEASED 实测);③存量 external 行由 sweep 有界排干(§7);④验证窗观察证据(1574 于 #797 合入后的产线运行记录)由 ship 节点在 PR 里落账。满足后本单删除旧流 = **执行** founder「if it works, delete old flow immediately」的后半句,即本单承载 flag 家族清理单中 Discord 入站一支(`FLYWHEEL_MAILBOX_DISCORD` + `FLYWHEEL_CHAT_RECEIPTS` + `FLYWHEEL_RECEIPT_FOUNDATION` 三个开关全删)。1573 的 `FLYWHEEL_MAILBOX_QUEUE`/deploy barrier 与 1575 的 `FLYWHEEL_MAILBOX_TASKS` 不在本单。
- **D2(裁定:列留人走)**:§2。附加一条低成本出生不变式:非 question 行 insert 时显式 `relay_state='terminal_disposed'`(enqueue 单点改),使 `open ⇔ 活 question` 成为可 SQL 断言的结构不变式,审计陷阱绝迹。[待 design review 确认:也可不加,靠 sweep+文档;倾向加,一行代价换一条永久不变式]
- **D3(裁定:一次性 sweep 程式)**:§7。
- **D4(裁定:不加新 flag)**:拆除不留开关(留开关=机器还在);回滚 = git revert + Bridge 重启。与 founder flag 家族 mandate 不冲突:mandate 针对**新流上线**(1573/1574/1575),本单是**旧机器拆除**,且实际是删 3 个旧 flag。
- **D5(验收口径)**:全部落观测,见 plan.md 验收节;继承 issue 评论方法论(核「健康行怎么变健康的」;「尝试过/没尝试」分类;CLI 返回成功不构成证据)。

## 10. 接缝风险清单(四路审计合并去重,plan 逐条对应)

1. `listExternalPending` 谓词去 settlement 子句 → 历史 settled-未-ACKED 行复活 ⇒ sweep 前置收敛 + 上线前谓词预演(§3.3/§7.2)。
2. `supersedeShipGateAndReceiptFamily` 拆分 → gate 退休半边指 `retireShipGate`,幂等键随之换为 gate CAS 语义(三调用点已有同款先例)。
3. `receipt_root_lineage` 触发器在 question insert 热路径 → 删表+触发器后 insert 路径纯净化,question `delivery_id='question:<lead>:<id>'` 约定**不动**(它是行身份不是收据)。
4. plugin 侧 `parseSpoolIntent` codec 被 ingest 恢复复用 → codec 留、只删 receipt spool 的写入方;`isIntentFilename`、目录嵌套(`chat-receipt-spool/{ingest,meta}`)同理(改名需带迁移,倾向不改名)。
5. `RecorderMode`/`FLYWHEEL_CHAT_RECEIPTS` 是 ingest 的能力门 → 删开关时保留 enabled 判定(commCli/dbPath/leadId 三元组),不可整删 recorder。
6. `BeginArgs` 双 CLI 共用 envelope → 保留(改名 IngestArgs 可选),`--reply-channel-id`/`--reply-route-json` 路由随之存活。
7. `meta.receipt_id` 与三段 MCP 文案是配对契约 → 同批删(单删一侧 = Lead 被指示遵守一个没人再发的字段)。
8. `receipt_foundation_off` alert kind 在 kind-contract/must-deliver 名单 → 同步移除 + 测试同步。
9. 命名撞车 grep 陷阱:`already_settled`(mailbox-queue 1573 批投递含义,留)、`ack_receipt`(1573 协议 ACK,留)、`settlement`(Blueprint.ts:132 ship-attempt 散文,留)、pane-loss `attemptedSettlements`(通知类,留)、`omitMergedReceipt`(merge manifest,留)。
10. 双仓同批:plugin fork(claude-plugins-official #下一号)与主仓 PR 需协同落地;cache 刷新走 update-discord-plugin.sh;部署顺序见 plan(先主仓 CLI 保持向后兼容窗口,再 plugin,或同窗重启)。
11. teamlead `plugin.ts:7231` relay_state 读点改写(§4)。
12. `handle-receipt`/`route-founder-reply` 是 Lead 现行指令面(rules + hook payload + MCP 文案)→ 三处文本与代码同批改,否则 strand 活 Lead(hazard:Lead 会按旧文案调不存在的 CLI——CLI 删除后报「unknown command」是 fail-loud,可接受;文案先行更干净)。
13. 1575 接缝:本单不实现 task 表,但拆除后「founder 消息处理义务在 task 层可见可关」这条验收**依赖 1575 已上线**(排期约束:1575 先行或同批)。1575 未 ON 期间的间隙姿态 = 与今天等价(义务本就无有效跟踪,§exploration 5)。
