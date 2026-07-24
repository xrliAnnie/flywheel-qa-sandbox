# FLY-1448 批准断路 — 实施计划

Issue: FLY-1448 (https://linear.app/geoforge3d/issue/FLY-1448/p1批准断路-founder-批准被静默丢弃-session-卡-running-无-durable-park-wake-拒投)
日期: 2026-07-23
基于: research.md
修订: R9(Codex R8 三 HIGH + 一 MEDIUM 全采纳:E2 通用件 root 状态改字段级合同(`delivered_at` 非终态 —— processed/disposed 双空即 open obligation 必清,alert outbox 的 delivered 只管 alert 行不管 root);settlement intent 增 `authority_kind` 三分治(session_terminal / issue_done / pr_merged 各配互斥 guard,terminal fence 不叠加到 issue authority);session_terminal 路径线性化点改 durable `claimTerminalSettlementIntent` CAS(与 lifecycle transition 串行,transition 先赢则 fenced、claim 先赢则跨库幂等完成,裸 re-read 降级为防御纵深);§7 ON 语义改「先 catch-up 再 drain」+ QA 行纳入 ⑥⑦⑧)← R8(Codex R7 四 HIGH + 一 MEDIUM 全采纳:E2 增通用 `settleReceiptFamilyForTerminalSubject` primitive(非 gate receipt / Done 无 gate / 多 alias 全覆盖)+ projector mutation-time fence(不可逆 effect 前 re-read terminal 态与 exact lifecycle id,mismatch → intent fenced/stale)+ 存量 detection 的 lineage catch-up(fingerprint=rootId 精确回填,歧义保留并 fail-loud)+ `ensureTerminalSettlementIntent` OFF→ON 补偿 seam;§6 验收矩阵补 ⑥⑦⑧ 三条 E 能力级验收)← R7(Codex R6 四 HIGH + 二 MEDIUM 全采纳:E1 双 authority 分治(merged→externalMergeReconcile fresh MERGED / Done→done-thread-reconcile fresh Linear + mutation 前二次 recheck + reopen 赢,candidate 覆盖 thread-less/无 PR/多 alias);E2 跨库结算协议(CommDB 单事务 `supersedeShipGateAndReceiptFamily` + StateStore detection settlement lineage 列 + fenced settlement intent/projector 两侧 re-read 才完成)+ per-kind 清算矩阵(terminal wake_failed 降 lead_only 不删未投告警、founder-origin/dropped/安全类 retain、founder-page 末跳 revalidate fence);E3 定死 `POST /api/leads/:leadId/detection-ack` + 服务端派生 target 绝不收 raw key + owner 校验 fail-closed;E 回退面入 §7(继承两巡检开关 + `FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT=0` intent 前短路);§8 措辞去绝对化(MQ 不能加入现有 SQLite 事务但可 outbox-relay、Flywheel 本就双库、容量句改为「无可观测 contention/丢失证据」))← R6(Lead 现场收编,Linear comment 3f9d0987 + founder MQ 问题:新增 Chunk E 终态清算三件套(E1 merged/Done gate 自动 supersede + escalation 同 pass RESOLVED;E2 session/issue 终态清算 pending receipts/escalations、终态后零 founder-page;E3 detection-ack lead-target 通路)+ §8 手搓 durable queue vs 真 MQ 对比(结论:消费端语义缺失非传输层问题,单机 SQLite 无瓶颈,同事务能力是正确性依赖;多机/写锁竞争/传输层实证丢失时重评,迁移对象限传输层))← R5(R4 唯一 HIGH 采纳:存量 terminal session 的 `terminal_lifecycle_id` 幂等 backfill —— migration 单事务铸稳定 id + CAS `ensureTerminalLifecycleId` 兜底 + 同一投影路径 + `completeRunnerPhaseWakeTerminal` 签名显式携带 fence + `OPERATIONAL_TERMINAL_STATUSES` 单一中立常量模块 + migration fixture 测试)← R4(R3 一 HIGH + 二 MEDIUM 全采纳:D1 episode 增 `opened_terminal_lifecycle_id` 持久身份 —— StateStore terminal-entry epoch 单调铸造、terminal→terminal 改写不推进、观测/completion API 携带 fence、身份缺失或不一致绝不并入旧 episode,补停机期 terminal→live→terminal 测试;A1 矩阵补「processed(预期 typed evidence)→ verify 幂等推进」与「processed(冲突 evidence)→ fail-closed pin+告警」两行及四种 typed evidence 崩溃重放测试;B3 定为无条件安全行为、删 `=0` 声明)← R3(R2 四 HIGH + 一 MEDIUM 全采纳:A1 root 处置改为 deliverer 权威重读 + CAS terminalization,不再按业务 outcome 盲推 root 状态,isDeadLettered 快路径推进游标前必须幂等修复 root;B2 outbox 改 append-only lifecycle 事件(park_opened/park_cleared 各占新 rowid)+ generation CAS 投影;C1 definite 决定的 classification 在不可逆写之前 durable 落盘,失败即 retry+pin;D1 terminal episode 生命周期按 category 分治(terminal 态存续期恰一 episode,dispose 不算恢复);D2/D3 terminal 处置事务后置条件 = wake terminal + alert identity + alert-pending outbox 三者同事务原子,founder-origin 改 message-scoped alert identity 不共享 episode)← R2(Codex R1 五 HIGH + 一 MEDIUM 全采纳:A 改为 root-first + 崩溃安全处置状态机;C 按 question 规范化、intent 前置于不可逆写、两级告警语义;B2 弃用 runner_declared_states 复用,改独立 engine-park 证据 + outbox/projector + activation/generation 绑定、只授权 wake pointer;D 指纹改持久 episode 代际、terminal 处置定义 CommDB 原子 transition、terminal authority 显式枚举;A 补完整 reply-to-card 授权谓词与 negative tests)

## 0. 目标与一句话方案

founder 对 ship-gate 卡的批准(散文 / 逐字 JSON / ✅ reaction)必须**生效或响亮地失败,绝不静默丢弃**。方案 = 四个修复叠加:
**A** 把被 FLY-1392 弃线的 text 归因组件接回 deliverer v2(恢复 FLY-945 合同);
**B** park/wake 记账对齐(`ship_parked` 入 wake allowlist + 引擎侧 engine-park 证据 + founder-origin wake 永不静默 dispose);
**C** founder 决定收敛看门狗(读到但未绑定 → 分钟级 fail-loud);
**D** wake_failed 告警改持久 episode 代际 + 终态 wake 原子处置(治告警跑步机且不吞新故障)。

**E** 终态清算三件套(merged/Done gate 自动 supersede + 终态 session 的 receipts/escalations 清算 + detection-ack lead-target 通路;Lead 现场收编,Linear comment 3f9d0987)。

单 PR 交付,chunk 顺序 A → C → B → D → E(A+C 先解 P1 急症,B+D 治底账,E 清终态欠账;每 chunk 独立可测)。另 §8 回答 founder 的「要不要换真 MQ」架构问题(分析结论,不产生本单构建项)。

## 1. Chunk A — 重接 founder text 批准绑定(RC-1)

### A1 · deliverer v2 增加 ship 分流 — root-first + 处置状态机

`founder-reply-deliverer.ts`:

- `FounderReplyDeliverDeps` 增可选 `tryFounderShipApproval?: (args) => Promise<ShipApprovalOutcome | null>`(类型已在 `:87-105`)。**absent → 现行为逐字节不变**(reverse-compat sentinel)。
- **次序(Codex R1 #1)**:对每条 founder 消息,若 `matching` 中存在 `checkpoint === "approve_to_ship"` 的 gate,则**先 idempotent 地 enqueue canonical hub root**(`enqueueFounderHubRoot`,id 确定性 = `founderMessageRootId`,重复 enqueue 为 no-op),**再**调 ship 归因回调 —— 保证 `trustedFounderGateResponseAndReceipt`(db.ts:2997-3097,要求 root 已存在)在 `bound` 路径上能原子完成 response + source event + root 处置。
- `founderReceipt` 携带 rootId/msgId/now/intentKey/envelope/queuedAtMs → writer 走 trusted 原子路径。

**root 处置 = deliverer 权威重读 + CAS terminalization(Codex R2 #1)**

业务 outcome(`ShipApprovalOutcome`)与 root 状态**不是一一映射**:trusted writer 事务内已把 root 标 `ship_gate_bound`,而 post-write hook/FSM 收敛失败仍可让 handler 在**之后**返回 `deferred`(parkOrRetry)甚至 `deadLetter`;反向,writer 的 prior-exact-response 分支在 trusted 分支之前返回 → handler 判 `bound` 但本条消息的新 root 仍 open。且 `LeadInboxQueue.markProcessed` 对冲突 evidence 会抛异常。因此 deliverer **不按 outcome 盲推 root 状态**,统一在回调返回后**权威重读 root** 再做 CAS 式 terminalization:

| 回调返回后 root 实况 | 处置 |
|---|---|
| 已 processed(evidence `ship_gate_bound`,trusted writer 事务完成) | 保持不改;游标推进 |
| open + outcome `bound`(prior exact response 等非 trusted 路径) | 以 typed evidence `already_applied`(ref=既有 responseId)标 processed;推进 |
| open + outcome `deferred`(pre-write deferral 已落盘) | typed evidence `deferred_founder_decision` 标 processed;推进 |
| open + outcome `suppressed`(merged retire 已落盘) | typed evidence `gate_retired_merged` 标 processed;推进 |
| open + outcome `deadLetter` | `retryLedger.deadLetterNow`(durable audit + must-deliver alert)落盘**后**,typed evidence `dead_lettered` 标 processed;推进 |
| open + outcome `retry: true` | root 保持 open;游标 pin(既有 `retryLedger.recordFailure` 同一账本) |
| processed(bound)+ outcome `deferred`/`deadLetter`(post-write 收敛失败) | root **不再改**(bound evidence 权威);收敛权归 rebind pass / dead-letter 告警本身;推进 |
| **processed(预期 typed evidence:`already_applied`/`deferred_founder_decision`/`gate_retired_merged`/`dead_lettered`)**(typed terminalization 已提交、cursor 未推进的重放,R3 #2) | verify 即幂等成功(不再 markProcessed —— `markProcessed` 对冲突 evidence 会抛);推进 |
| **processed(未知/冲突 evidence)**(如另一 actor 抢先处置) | fail-closed:不改写、游标 pin + 告警(审计 `founder_root_evidence_conflict`) |
| open + outcome `null`(不可归因) | 现行为:root 留给 Lead handoff(`deliverAmbiguousToLead`) |

`isDeadLettered` 快路径(deliverer `:337-343`)在推进游标**之前**必须幂等验证/修复 root 已 terminal(dead-letter 已落盘但 root 仍 open 的崩溃窗口 → 补 `dead_lettered` evidence),不许直接 skip。

重启测试逐窗口覆盖:root-enqueue 后崩溃(root idempotent 重放)/ 业务写后 cursor 前崩溃(writer 幂等短路 + root CAS 收敛)/ **post-write hook 失败 → deferred**(root 保持 bound)/ **post-write park 失败 → deadLetter**(root 保持 bound,告警必达)/ **dead-letter 已落盘 root 仍 open → restart**(快路径修复后才推进)/ prior exact response + 新 root(`already_applied` 闭合)/ **四种 typed terminal evidence 各自「CAS 已提交、cursor 未推进」崩溃重放**(verify 幂等 + 推进,R3 #2)。断言:不双批准、不丢消息、不留孤儿 root(不喂 receipt-patrol 噪声)。

### A2 · gate-poller / plugin 接线

- plugin.ts:在 reaction 回调旁(`:6797`)用同一批 deps 构造 `makeFounderShipApprovalCallback({...})`:`store / gateAuthorityView / mergedGateGuard / auditStore / isHeld(founderApprovalHoldGuard) / deferralSupport / projectRootFor / onResponseWritten: founderShipPostWriteHook` —— 与 reaction/voice 面共享同一 post-write hook 与 hold/deferral 语义,零第二套授权链;
- gate-poller `founderReplyDeliverPass`:把回调注入 `emitFounderReplyDeliveryForThread` deps(per-lead ctx 绑定 projectName/threadId/issueId);
- kill-switch 复用 `FLYWHEEL_FOUNDER_AUTO_APPROVE`(默认 ON,`=0` 全关)+ per-project denylist —— factory 内已实现,零新 flag。

### A3 · 完整授权谓词(Codex R1 #6,单一清单,实现照抄)

写 gate response 的**全部**前置条件(任一不成立 → 不写;仅在存在 durable fallback handoff 或 typed suppression 后才允许推进游标):

1. canonical founder id 可解析且 `msg.author.id` 逐字相等、`author.bot !== true`(fail-closed);
2. `FLYWHEEL_FOUNDER_AUTO_APPROVE !== "0"` 且 project 不在 denylist;
3. narrow 到**恰一个** current gate(gateAuthorityView `awaiting_review` 或 session `awaiting_review && review_question_id === qid`);
4. `replyToCard` 仅当:`msg.type === 19(REPLY)` **且** `message_reference.type ∈ {0, undefined}(DEFAULT)` **且** reference 所在 channel/thread 与 gate binding 的 threadId 一致 **且** `message_reference.message_id === readCurrentGateMessageBinding().gateMessageId`(binding 按 questionId+prHeadSha 解析);
5. pre-write 复验:live status/review_question_id/pr_head_sha 与归因时逐字一致(handler `:513-537` 既有);
6. hold(codex/QA/merge_block)与 mergedGateGuard 复验(既有);
7. 写入走共享 writer(绝不绕过直接翻 holder)。

Negative tests:非 founder / 伪造 author / bot 冒名 / cross-thread reference / forward-type reference / stale card / stale head / 多 pending gate / kill-switch off / denylist —— 每条断言「未写 response + root 走对应 fallback 处置」。

### A4 · 不变量

- `routeFounderReply` 对 `approve_to_ship` 的拒绝**不动**;#690 呈现守卫不动;卡面文案不动;
- engine(DAG holder)与 legacy session 两种 authority 由 handler 内 `gateAuthorityView` 优先级处理,零模板特判。

### A5 · 测试(RED 先行)

散文(Tier-3 stub approve)/ 逐字 JSON / reject+feedback / unclear→Lead handoff 回落 / 六个 outcome 行 × 三个崩溃窗口 / 无回调 dep→逐字节现行为 / A3 全部 negative;集成:真 CommDB,founder JSON → question resolved + `workflow_source_event(founder_approval)` → projector drain → holder `approved` + land run 推进。

## 2. Chunk C — founder 决定收敛看门狗(RC-4,fail-loud 兜底)

### C1 · durable 收敛账本(按 question 规范化,intent 前置于不可逆写)

StateStore 新表 `founder_decision_convergence`,**每 (thread_id, msg_id, question_id) 一行**:
`classification(approve|reject|unclear|none), card_reference_valid, disposed_at, deadline_at, resolved_at NULL, resolution NULL, alerted_at NULL`。

**写入时序(Codex R1 #2 ordering hole + R2 #5)**:deliverer 在对一条「thread 上存在 ≥1 pending approve_to_ship」的 founder 消息做**任何不可逆动作之前**先为每个候选 qid 落 intent 行(初始 classification `none`);intent 写失败 → 该消息按 process 失败走 retryLedger(pin,绝不静默)。**definite 决定的 classification 必须在不可逆写之前 durable 落盘**:handler 在 signal 评估得到 `approve|reject` 后、调用 writer **之前**,经注入的 durable classification 回调更新 intent 行;该更新失败 → handler 返回 `retry`(writer 不被调用、游标 pin)——绝不允许「classifier 已判 approve、绑定失败、classification 也丢了 → 只剩 warning 级」的降级。`unclear/none` 保持初始值即可(它们只驱动 warning 级)。这样「response 已写但保护记录/证据丢失」的窗口不存在。

### C2 · 收敛判定 + 两级告警(不把普通聊天谎报成批准被丢)

GatePoller 既有 cadence 扫账本(零新 timer):

- resolve 判定(**逐 question**):该 qid 有 response / holder `approved|superseded` / question retired / deferral 行存在 → `resolved_at` + `resolution` 落戳;一条消息的多行**各自独立闭合**,绝不「任一解决即全关」;
- 超 deadline(默认 3 分钟,`FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS`,注册 flag registry)未 resolve:
  - `classification ∈ {approve, reject}`(有 classifier/verbatim 证据)→ kind **`founder_decision_dropped`**(severe):「founder 明确决定未被系统绑定」+ 修复指引 + founder 消息 ❓ reaction(best-effort,复用 FLY-1041 Chunk 8 收据);
  - `classification ∈ {unclear, none}`(含 kill-switch off / 归因未跑)→ kind **`founder_reply_unbound_gate_pending`**(warning):「ship gate 等待中收到 founder 回复但无任何绑定动作」—— 观察级,不谎称批准被丢;
- 两 kind 均入 `receiptDetectionKinds` 白名单,指纹 = `msg_id + ":" + question_id`(稳定),episode 去重恰一次,resolve 后清 latch。

### C3 · 测试

落行/逐 question 独立闭合/超时两级告警/resolve 清 latch;情景:纯聊天(→ 仅 warning 级)/ unclear / 明确 reject 未绑 / kill-switch off(→ warning 级,= 验收 ④ 人为断供形态)/ multi-gate 同消息 / intent insert 失败(writer 前 → pin;确保无「writer 后才写 intent」路径存在的结构断言)/ **spy test:classifier=approve、classification 持久化失败 → writer 未被调用 + 游标 pinned**(R2 #5);response 已由其他原子路径完成 → intent 由 response/resolution 闭合(非 best-effort evidence)。

## 3. Chunk B — park/wake 记账对齐(RC-2)

### B1 · `ship_parked` 入 wake 合同(W3 第七消费面补账)

- `runner-recovery-nudge.ts` `wakePointerStatusAllowed` 增 `session.status === "ship_parked"`;拒投文案同步;
- `RunnerReceiptPatrol` durable-park 判定经 deps 注入「StateStore status = ship_parked」谓词(patrol 不直连 StateStore);
- PR 描述逐条列 FLY-1441 W3 六族矩阵不重叠。

### B2 · 引擎侧 engine-park 证据(独立 authority,不复用 runner 自声明)

Codex R1 #3 采纳:`runner_declared_states` 是 execution 级单行、无 source/generation、被 send 路径清除、且被 destructive-verdict/cleanup/liveness 多个 consumer 当作 runner 自报证据 —— 复用它会造成 false-positive wake admission 并放宽 cleanup 权限。改为**独立 engine-park 证据链**:

- **StateStore 侧(源头,append-only lifecycle 事件,Codex R2 #2)**:outbox 定义为**只追加**的事件流,不是 mutable 状态行 —— `workflow_engine_park_outbox` 每行一个事件:`(event_id, execution_id, run_id, node_id, attempt, generation, event ∈ {park_opened, park_cleared}, reason, created_at)`。workflow 引擎在 (i) node completion 且 phase session keep-alive 保活、(ii) run 进入 gate 节点(founder_gate)对 carrier session,两个位点在既有 engine 事务内 append `park_opened(generation)`;dispatch/resume/新 attempt 在其事务内 append `park_cleared/fenced(generation, reason)`(= generation 单调推进)。**clear 拥有自己的新 rowid** —— rowid-cursor projector 一定能看到它;
- **CommDB 侧(投影)**:既有 GatePoller cadence 上按 durable rowid cursor drain 事件流 → CommDB `workflow_engine_park` 表**按 generation CAS 应用**(applied generation 只前进;迟到的 `park_opened` 不能复活已 fence 的 generation)—— 沿 `founder-approval-projector` 的 append-only + 单调 cursor 模式(两个 SQLite 不假设跨库原子);
- **消费矩阵(白纸黑字,只授权一件事)**:engine-park **只**被 wake-pointer admission 读取(`runner-recovery-nudge` 经新 deps 谓词);**不**进入 destructive verdict、done-running reconciler、CommDB prune、stuck detection 等任何 cleanup/liveness 判定 —— 它不是 runner 存活证据;
- **send 前复验**:wake pointer 发送前重读 exact-current activation:该 execution 的 engine-park 行未 cleared、generation 与当前 activation 一致、无更新 attempt/resume fence → 才放行;否则拒(fail-closed 不变);
- 逃生口 `FLYWHEEL_ENGINE_DECLARED_PARK=0`(默认 ON,关闭写入与消费;注册 flag registry)。

### B3 · founder-origin wake 永不静默 dispose

- founder 决定派生的 wake(routeFounderReply 的 park_wake、gate_response、Lead relay founder 内容的 message_traffic)envelope metadata 带 `origin: "founder"`;
- patrol message_traffic 静默 dispose 分支(`:118-124`):`origin === "founder"` → 不 dispose,改走 escalate(reason `founder_wake_undeliverable`);其余 message_traffic 维持现状;
- dispose 本身补 session_events 审计行(`wake_disposed` + 原因)。

### B4 · 测试

wake 合同:ship_parked 放行 / running+engine-park(generation 匹配)放行 / running 无 park 仍拒 / generation 过期拒 / completed 仍拒;engine-park 生命周期:completion append `park_opened` → 投影 → 新 attempt append `park_cleared` → clear 事件投影 → **「open 已投影且 cursor 已推进 → 同 attempt resume clear → clear 投影 → Bridge/projector restart 后 admission 仍拒 wake」**(Codex R2 #2 点名场景)→ 迟到 open 不复活 fenced generation → 「completion 已提交但投影未跑」窗口(admission 拒,不误放)→ resume 原子推进 generation → `=0` 全关;founder-origin message_traffic → escalate 非 dispose;普通 message_traffic → dispose + 审计;结构断言:engine-park 谓词只被 wake admission import(consumer matrix 测试)。

## 4. Chunk D — wake_failed episode 代际 + 终态原子处置(RC-3)

Codex R1 #4/#5 采纳,重设计如下:

### D1 · 持久 failure episode(代际指纹,不吞新故障;关闭条件按 category 分治,Codex R2 #3)

- CommDB 新表 `runner_wake_failure_episode`:`(execution_id, category ∈ {terminal, no_receipt}, generation, opened_at, closed_at NULL, last_message_id, opened_terminal_lifecycle_id NULL)`;
- **terminal lifecycle 身份持久化(Codex R3 #1)**:StateStore 在 session 进入 `OPERATIONAL_TERMINAL_STATUSES` 的 transition 内铸单调 `terminal_lifecycle_id`(terminal-entry epoch;离开 terminal 时 fence;同一 terminal 停留期内的 terminal→terminal 改写如 `failed→blocked` **不**推进 epoch),并投影到 patrol 可读面 —— patrol 的 target observation 与 terminal completion API 都携带该 id;`OPERATIONAL_TERMINAL_STATUSES` 定义为**单一中立常量模块**,StateStore 铸造侧与 patrol 消费侧共用同一 export(枚举绝不两处手抄漂移);
- **存量 terminal session 的 backfill(Codex R4 #1 —— 没有它,已 completed 的老 session 按「身份缺失开新代」规则会每条 wake 一个新告警,treadmill 复活)**:
  - schema migration 在一个 StateStore 事务内,对**当前已处于** `OPERATIONAL_TERMINAL_STATUSES` 且身份缺失的全部 session 各铸**一个**稳定 terminal-entry id(单调 allocator / append-only lifecycle 行;不依赖老行可能缺失的 `terminal_at` 去推断,不在 patrol 观测时临时计算);
  - 兜底 CAS 原语 `ensureTerminalLifecycleId(executionId, observedStatus, observedLifecycleRevision)`:仅当 session 仍处同一观测 terminal 状态且身份仍空时铸造一次;并发/重放返回同一 id(部分部署 / 漏迁移场景的自愈);
  - backfilled id 走与新 transition 完全相同的投影路径;离开 terminal 时 fence,下一次进入 terminal 才铸新 id;
- **开启**:该 (execution, category) 无 open episode、**或 open episode 的 `opened_terminal_lifecycle_id` 与当前观测不一致/无法验证**时,开启 generation = prev+1(缺失身份绝不并入旧 episode —— 漏观测 `terminal→live→terminal` 时宁可多报一条,不吞新故障);身份一致的后续失败复用同一 episode(只更新 last_message_id);
- **关闭 = durable 事实驱动,且两个 category 的生命周期不同**:
  - `terminal`:execution 仍处于同一 terminal lifecycle(未复活、未被替换)期间 episode **保持 open** —— **source wake 被 D2 dispose 不算恢复、绝不触发关闭**(否则「dispose → 无 pending failed wake → 关 episode → 下一条 wake 开新 generation」= treadmill 复活,Codex 点名)。只有 durable 的 terminal→live lifecycle revision、execution replacement、或新 activation 才关闭/fence;
  - `no_receipt`:matching started receipt / 全部相关 wake 均有成功或恢复证据后关闭;单纯 dispose 不算 recovery;
- **指纹** = `sha256(execution_id + ":" + category + ":" + generation)` —— 同一 episode 恰一告警;合法关闭后再失败 = 新 generation = 可再告警;
- 测试:「连续三失败恰一报」「失败→started→再失败报第二次」「跨 Bridge restart 代际保持(durable)」「**N 条同-lifecycle terminal wake:每条都被 dispose,但恒只有一个 open episode + 恰一告警**」「**Bridge/projector 停机期间完成 terminal→live→terminal:恢复后下一条 wake 必开新 generation + 新告警**(R3 #1 点名)」「同一 terminal lifecycle 内 `failed→blocked` 改写仍保持一个 episode」「**migration fixture(R4 #1):旧 schema 建 completed session → 升级 → 投 N 条 wake → 跨 restart 恒一个稳定 id + 一个 open episode + 恰一告警;随后 terminal→live→terminal 铸第二个 id 可再告警;并发 lazy-mint 恰产一个 id**」。

### D2 · 终态 wake 原子处置(可执行的 API 设计)

- **terminal authority 显式定义**(不引用不存在的导出常量):`OPERATIONAL_TERMINAL_STATUSES = {completed, terminated, failed, blocked, timeout, canceled, cancelled}`,**从 D1 的单一中立常量模块导入**(mint / migration backfill / patrol resolve 三个消费者共用同一 export,配结构断言),并配逐状态测试(现清单行为 = 前 5 项之外照旧,新增仅 `completed`/`terminated` 两项,PR 描述标注行为差异);
- **CommDB 原子 transition** `completeRunnerPhaseWakeTerminal({ executionId, messageId, reason, terminalLifecycleId })`(签名显式携带 lifecycle fence,与 D1「completion API 携带 id」一致 —— R4 #1 指出的字面不一致已修):对任意 purpose(不限 message_traffic;扩展现 `disposeRunnerPhaseWakePending` 覆盖 `gate_response`/`park_wake`)把该 wake 置 terminal-typed 完成态。**事务后置条件(Codex R2 #4)= 三者同一 CommDB 事务原子提交**:① source wake terminal-typed 完成;② D1 episode(或 D3 的 message-scoped alert identity)open/update;③ durable alert-pending outbox 行 upsert。外部 Discord 通知与 ack 在事务之外 at-least-once drain —— dispose 已提交则 alert-pending 行**必已存在**,不存在「dispose 后崩溃 → 告警永久丢失」的窗口;
- **episode 级 alert outbox**:告警行挂在 D1 episode / D3 message identity 上(独立于任何单条 source wake 的 pending 状态)—— 解决「先 dispose 则 revalidate 失败 / 先 alert 则 wake 悬挂」的现死锁;delivery 失败不回滚 dispose(行保持 alert-pending,下轮重投);
- crash windows 逐一测试:**dispose 已提交 ⇒ alert-pending 行已存在(仅外部投递未发生)** / alert 已投 ack 未落(重投幂等)/ 双进程重复 drain(幂等)。

### D3 · founder-origin 的独立告警身份 + 与既有面的对齐

- **founder-origin 不共享 D1 episode**(Codex R2 #4:「复用 episode 指纹」与「每条独立告警」互斥):founder-origin wake 失败使用 **message-scoped alert identity** = `sha256(execution_id + ":founder:" + message_id)` —— 同一条 source wake 的所有 patrol retry / 重启恰报一次;不同 founder wake 互不合并、各报一条(founder 决定丢失永远值得一条);它不是 episode,不参与 D1 的 open/close 生命周期;
- 实现前 grep #690 wake_failed 相关处理面 + `notifyDetectionEpisodeWithOutcome` 的 episode 语义,PR 描述逐项列「已核不重叠」。

## 4.5 Chunk E — 终态清算 + ack 通路(Lead 现场收编,Linear comment 3f9d0987 四件套之 1-3;第 4 件 = Chunk D 主诉的量化)

今晚 ship 收尾期间 Lead 被迫手工 SQL 清了一批同族欠账,三个新增 scope 收编如下(全部复用既有基座,不另起炉灶):

### E1 · 已 merge / 已 Done 的 pending approve_to_ship gate 自动 supersede(双 authority 分治,R6 #1)

现场:FLY-1441/1436 founder 直合后,runner 的 approve_to_ship gate 永久 pending,受体 patrol 反复升级、威胁 30min founder page;Lead 侧 respond 该 gate = 伪造批准记录(founder-consent 红线),唯一出路是手工 SQL。

**两个 authority source 分开挂,不混用**(`externalMergeReconcile` 只有 GitHub `gh pr view` authority、候选集要求带 PR;它证明不了 Done):

- `superseded_merged`:挂 `externalMergeReconcile` / 共享 merge probe,只接受 fresh `MERGED`;`open/closed/unknown` 一律不动;
- `superseded_issue_done`:挂 `done-thread-reconcile` 的 **fresh Linear Done/Canceled observation**(该模块已有 per-issue fresh read、lookup 失败 fail-closed、mutation 前二次 fresh recheck、reopen 必须赢的完整纪律)—— 由它在同一 StateStore 事务 append issue-terminal settlement intent;每次 guarded mutation 前再调同一 fresh authority,`reopened/unknown` → pin/skip;
- candidate discovery 覆盖 thread-less、无 PR、同 issue 多 session alias(复用 done reconcile 的 residue/alias 集,不要求 external-merge 的 PR 候选形态)。

三相形态沿 `zombie-gate-hygiene`(durable INTENT 审计 → GUARDED mutation → RE-READ OUTCOME 审计),且 intent 覆盖 **gate / receipt root+outbox / detection 三个子效果** —— 任一子效果未经 re-read 验证,dangling-intent reconcile 继续,不许先写 outcome audit。已 answered 的 gate 不可触碰(并发 response 赢)。

测试:Done 后 mutation 前 reopen / Linear lookup error / Done 无 PR / Done 无 thread / 同 issue 多 session / 重复 pass+restart 幂等 —— 任何非 fresh-terminal 结果都不得 retire gate 或 settle receipt。

### E2 · 跨库结算协议 + per-kind 清算矩阵(R6 #2/#3)

现场:FLY-1443 phantom gate 收据在 runner 关掉后仍卡满 30 分钟升级,真的 page 了 Annie。

**可恢复的跨库结算协议**(gate/root/outbox 在 CommDB,detection 在 StateStore,两库不假设原子):

- **两个 CommDB 单事务 primitive 分工(R7 #1:ship-gate 专用件清不了通用 receipt debt)**:
  - E1 用 `supersedeShipGateAndReceiptFamily({ questionId, reason })`:guard unanswered gate(现 `retireShipGate` 只收 supersededBy,需扩 typed reason);retire 成功或已是同 typed disposition 时,按**精确 `ref_message_id = questionId`** 找原始 lead_inbox root → 写 typed disposed evidence + 关闭 resend family + 取消未投递 receipt alert(`markDisposed` 既有同事务语义);response 先赢 → gate/root 全部不动;
  - E2 用**通用件** `settleReceiptFamilyForTerminalSubject({ receiptId, expectedExecutionId, reason })`:按 root id 精确读取;验证 `ref_message_id → message.from_agent / session.execution_id` 与 lineage 一致。**root 状态字段级合同(R8 #1:`delivered_at` 不是终态 —— 巡检恰好挑 delivered-未-processed 的 root 重发/升级,现场 debt 几乎必然已 delivered)**:
    - `processed_at/evidence` 已存在 → 验证 processed evidence(response/processing wins),不写 disposed;
    - `disposed_at/evidence` = 本 typed reason → 幂等成功 + 重验 family 关闭;
    - `disposed` = 冲突 evidence → fail-closed;
    - `processed_* IS NULL AND disposed_* IS NULL` → **无论 `delivered_at` 有无**,都是 open obligation → 写 terminal-typed disposed evidence + 同事务关闭 resend family;
    - receipt alert outbox 的 `delivered_at` 只决定「已投审计保留 vs 未投 row 取消」,**绝不**决定 root 是否 open;
    - 最小状态矩阵测试:root 有 `delivered_at`、无 processed/disposed、alert 已投 → primitive 仍 dispose root + 关 family,但不改写/取消已投 alert。
    **lead_inbox 的 type 是开放字符串,receipt 不都挂 gate** —— terminal session 上的非 ship-gate receipt、Done issue 无 pending gate 但有 receipt debt,都由这个通用件覆盖;issue-terminal intent 枚举**全部 alias execution** 的 lineage 命中 receipt(即使该 issue 无 gate/PR/thread),同一 per-kind 矩阵;
- StateStore detection 行增 first-class **settlement lineage** 列(`source_receipt_id / source_execution_id / source_question_id`)—— 结算按 lineage 精确命中,绝不解析提示文字或猜 target_key;
- **存量 detection 的 lineage catch-up(R7 #3:新列对已有 active row 全 NULL,恰是 Lead 要清的 legacy debt)**:独立、可重放的 catch-up pass —— 以旧 row 的 `episode_fingerprint` 作为**协议已持久化的精确 root id**(receipt detection 的 fingerprint = rootId),去对应 CommDB re-read root,经 `ref_message_id → question → session` 验证 project/Lead/execution/question 全链一致后 **CAS 填充** `source_*` 列;缺 root / 跨项目 / 歧义 / 冲突 → 保留 row + Lead audit,绝不猜,settlement intent 不得标完成;
- terminal transition / D1 backfill 只在各自 StateStore 事务内 append **fenced settlement intent**(按 `terminal_lifecycle_id`);projector(既有 cadence)幂等执行 CommDB 效果 → 按 lineage resolve StateStore detection → 两边 re-read 都满足后才完成 intent。backfill **不**「顺路」跨库原子清算;
- **settlement intent 按 `authority_kind` 分治,各配互斥 guard(R8 #2:「session 必须仍 terminal」的 fence 会把 Done-issue-非终态-session 的合法清算全判 stale)**:intent 持久化 `authority_kind` + 对应 credential —— `session_terminal`(execution_id + terminal_lifecycle_id + lifecycle revision/activation)/ `issue_done`(canonical issue/project + fresh Linear Done/Canceled observation credential;每个 guarded mutation 前走 E1 既有 fresh recheck,`reopened/unknown` → pin/fence)/ `pr_merged`(PR identity + fresh `MERGED` proof)。projector 按 authority_kind 选**唯一** guard,terminal-lifecycle 条件绝不叠加到 issue authority 上。成对测试:「issue Done、session 仍 running、无 gate 有 receipt → 可结算」与「同场景 mutation 前 issue reopened → 完全不动」;
- **session_terminal 路径的线性化点 = durable claim,不是裸 re-read(R8 #3:跨库 TOCTOU —— read 后 transition 提交、CommDB 已 dispose、post-await recheck 才发现 mismatch = 留半状态)**:StateStore 内新原语 `claimTerminalSettlementIntent(intentId, lifecycleId)` —— 与 lifecycle transition **串行**的单事务:验证 exact-current lifecycle 并 CAS `pending → applying(claim_token)`。与 transition writer 共享同一状态合同:transition 先提交 → claim 失败、intent fenced、CommDB 不动;claim 先提交 → 旧 lifecycle 的 receipt settlement 已获授权,跨库幂等完成(后续 activation 不复用旧 root),post-effect 阶段按 claim_token 完成 detection —— **绝不**因 session 事后 live 而遗留「root 已 dispose、detection 未 resolve」半状态。测试:两种严格排序 + 真并发 + 「claim 后 CommDB commit → live transition → Bridge crash → restart 后 detection 仍收敛」窗口。慢 await 后的 fence 复验与 founder-page 末跳 revalidate 保留,作为 claim 之外的防御纵深;
- **OFF→ON 补偿 seam(R7 #4:flag OFF 期间升级会漏建 intent,ON 后 session 不会再 terminal transition)**:幂等 `ensureTerminalSettlementIntent(executionId, currentTerminalLifecycleId)` 挂既有 cadence —— 仅对「当前仍 terminal 且 lifecycle 精确匹配」的 execution CAS 创建恰一个 intent,已存在返回同一行,非 terminal / mismatch 不建;kill-switch OFF 时不写 intent 不执行副作用,ON 后由该 catch-up 扫描补齐 OFF 窗口欠账;
- crash windows 必测:intent 已 commit 未动 CommDB / gate+root 事务已 commit detection 未 resolve / detection resolve 前后 Bridge crash / response 与 supersede 竞争 / typed disposition 已 commit outcome audit 缺失 / 旧 schema backfill 恰产一个稳定 intent 跨 restart 收敛 / **intent commit 后 projector 前 session terminal→live:root/detection 均不清,新 terminal lifecycle 只能由新 id 的 intent 结算** / **terminal session + 非 gate receipt** / **Done issue 无 gate + receipt debt** / **多 alias 各有 receipt** / **legacy 无 lineage fixture:active receipt_unprocessed + open root → 升级 + backfill → 跨 restart 精确结算;歧义映射不动且 fail-loud** / **E2=0 部署(D1 id 已 backfill 无 intent)→ E2=1 重启 → 恰一 intent 完整收敛;反复 OFF/ON 不重复清算**。断言:无 double-retire、无 open root、无 orphan detection、不误取消已投/已处理 receipt。

**per-kind 清算矩阵(「业务义务已过期」≠「欠下的告警不用送」——绝不吞 D/B3 的 fail-loud 义务)**:

| kind | 终态处置 |
|---|---|
| lineage 命中的 `receipt_unprocessed`(该 gate/session) | typed dispose root + resolve detection |
| D1 terminal `wake_failed` | source wake 可 terminal-complete;**episode/message 的 alert-pending 必须至少送达 Lead**;终态只把 founder-page 策略降为 `lead_only`,绝不在投递前删除告警 |
| founder-origin wake 失败(D3) | 保留 message-scoped fail-loud,**不得**被 E2 合并或取消 |
| `founder_decision_dropped` / 安全·授权异常 / delivery-failure audit / `park:*`(他人 own) | **retain** —— 不进 blanket resolution |

founder-page 最后一跳 **revalidate** exact terminal lifecycle / settlement fence(解决清算与 page 并发,不靠先后顺序)。终态之后 founder-page 归零,但 Lead 侧告警义务照常兑付。

测试:D2 alert 事务与 E2 并发(wake terminal-complete 已提交、E2 先跑 → Lead alert 仍 pending 可投、founder page 不发生)/ founder-origin 每消息告警不被吞 / 无关 detection 不变 / 旧 lifecycle 已结算 receipt 在 terminal→live→terminal 后不复活。

### E3 · detection-ack lead-target 通路(定死端点 + 单一授权谓词,R6 #4)

现场:`detection_escalations` 里 target_key=`flywheel:<lead>` 的行,现 route 第一步 `store.getSession()` 就 404,Lead 唯一出路 = 手工 SQL(今晚 9 行)。

**定死为独立端点 `POST /api/leads/:leadId/detection-ack`**(不复用带伪 executionId 的 session route;`matchesLead` 需要 Session 而 lead-target 没有 session,不可复用)。单一授权谓词:

1. 既有 token auth;
2. body 携带 canonical `projectName`;服务端从**唯一** `ProjectEntry(projectName, leadId)` 派生 `${projectName}:${leadId}` —— **绝不接受 raw target_key**;
3. exact row 同时匹配派生 target + kind + fingerprint,且 `owner_lead_id === leadId`;unknown/ambiguous project、owner 缺失/冲突一律 fail-closed;
4. audit/receipt 身份用 E2 的 settlement lineage(或把 disposition-receipt prepare 显式扩成支持 `target_kind=lead`),**不伪造 session**;
5. detection ack + disposition receipt prepare 保持一个 StateStore 事务;secondary trace 失败不得反过来谎报主 ack 未成功。

测试:cross-lead / cross-project / raw-target 注入 / unknown·ambiguous project / owner mismatch / 已 resolved replay / receipt prepare 失败回滚 / session endpoint 逐字节回归(reverse-compat sentinel)。

## 4.6 §8 · 架构对比:手搓 durable queue vs 真 Message Queue(founder 现场问题,Tadashi 转达)

Annie 问:「换真 MQ(Redis/NATS 类)会不会更好?」结论先行:**本单继续在 SQLite 事件表上补齐消费端语义,不迁移 MQ;迁移评估点后置**。理由:

1. **今晚 15 个假警报的根因在消费端语义缺失,不在传输层**:无终态清算(E1/E2)、无 lead-target ack API(E3)、重投无代际去重(D)。消息本身没有丢在「传输」上 —— 丢在「收到之后没人按合同处置」上。换 MQ 只换传输,这些消费端合同照样要写。
2. **真 MQ 的 ack/nack/DLQ/TTL 语义正是本单在补的东西**:A 的处置状态机 = ack/nack;FLY-1099 dead-letter 账本 = DLQ;D 的 episode 代际 = 去重;C 的收敛看门狗 = 消费超时监控。区别在于落点:MQ **不能直接加入现有 SQLite 事务** —— 本单多处正确性(trusted writer 原子写、tri-atomic terminal 处置)依赖「消息处置与业务状态同一事务提交」;引入 MQ 后这些位置仍要 transactional outbox + relay 才能保住原子性,等于新增一个外部有状态服务(部署/监控/崩溃恢复)外加一层 relay 运维面,而业务 ledger(gate/holder/claims)谁也替代不了。诚实标注:Flywheel 今天也不是全同库 —— StateStore/CommDB 跨库处(B2/E2)本就走 outbox/projector 收敛;MQ 只会把这类跨库边界变多,不会变少。
3. **单机 Mac 部署,无传输层瓶颈证据**:当前无可观测的 SQLite writer contention、无实证的传输层丢失(今晚全部事故都定位在消费端);MQ 的横向扩展收益为零,运维成本为正。

**何时重新评估迁移**:出现以下任一信号时开专项 —— ① 多机部署(FLY-1005 方向落地,跨机传输成为真需求);② 控制面消息量级接近单写者瓶颈(持续写锁竞争可观测);③ 消费端语义补齐后仍出现传输层丢失(用本单 C 看门狗的账本作证据)。届时迁移对象优先是**传输层**(mailbox/wake 投递),业务状态账本(gate/holder/claims)留在 SQLite。

## 5. 明确不做

- FLY-1374 对账循环(独立单);
- reaction 面代码改动(无已知缺陷;真机取证归 QA);
- `routeFounderReply` 的 ship 拒绝、#690 呈现守卫、卡面文案;
- wake 合同放松为「承认裸 running」(被 B2 engine-park 取代,保持 fail-closed);
- engine-park 作为 cleanup/liveness 证据(消费矩阵明确排除)。

## 6. 验收映射(能力级,529 房)

| 验收 | 覆盖 | 验证形态 |
|---|---|---|
| ① 散文回复 → holder approved、run 推进 | A | 房测 run A 现场复测(真 founder 账号) |
| ② 逐字 JSON 同 | A | 同上 |
| ③ ✅ reaction 同 | 既有面 + A 共享收口 | 真机稳定点击取证(QA 节点) |
| ④ 人为造投递失败 → Lead fail-loud,绝不静默 | C(+B3) | kill-switch 关 A → founder 回复 → 3 分钟内 `founder_reply_unbound_gate_pending`;classifier 证据在而绑定断 → `founder_decision_dropped` |
| ⑤ 完结会话不重铸 wake_failed 指纹 | D | completed session 重复投递 → 恰 1 告警(episode 代际),指纹表一手复核;恢复后新故障可再报 |
| ⑥ merged/Done 的 pending gate 自动 supersede(含无 gate 的 terminal receipt 清算) | E1/E2 | 房测复刻 FLY-1441/1436 孤儿 gate 形态 → 自动 retire + escalation RESOLVED;含至少一个无 gate 的 terminal receipt 与一个 legacy 无 lineage fixture |
| ⑦ 终态 session 零 founder-page 且 Lead 告警仍送达 | E2 | terminal 后注入 receipt/wake 失败 → founder-page 不发生、Lead alert 送达取证 |
| ⑧ lead-target detection-ack 通路 + 鉴权 | E3 | 真 Lead 调新端点 ack `flywheel:<lead>` 行;cross-lead/raw-target 注入被拒 |

## 7. 交付与风控

- **byte-compat**:A 的 dep 可选(absent = 现行为);B2 有 `FLYWHEEL_ENGINE_DECLARED_PARK=0` 逃生口;**B3 是无条件安全行为,无开关**(R3 #3:任何恢复 founder wake 静默 dispose 的 rollback 开关都违反本 issue 核心不变量「founder 决定生效或响亮失败」;founder-origin 标记 absent 的旧 wake 自然走现行为,已是兼容面);C deadline flag 可调;**Chunk E 的回退面(R6 #5)**:E1 merged 分支继承 `externalMergeReconcile` 既有开关、Done/Canceled 分支继承 fresh-Linear reconciler 既有开关,E2 终态收据清算独立 `FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT=0`(OFF 在 intent 写入**之前**短路,零半套 side effect;已存在的 dangling intent 在 OFF 下冻结不执行;**ON 时先跑 `ensureTerminalSettlementIntent` catch-up 补建 OFF 窗口漏建的 intent,再 drain 既有 dangling intent** —— OFF/ON 测试点名「无 intent 的旧 terminal session」形态,R8 #4),E3 为 additive API 不设 runtime 开关但 session endpoint 配 reverse-compat sentinel;OFF 路径测试:gate/root/detection/审计全为旧行为;新 flag 全注册 `packages/config/src/feature-flags/registry.ts`;
- **全仓门禁**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`;Codex code review(`codex:rescue`)循环到 APPROVED;
- **部署形态**:Bridge 侧代码,merge 后需 Bridge 重启生效 —— 汇入「三线合流统一重启」窗口,不单独重启;
- **QA**:529 房复测断言 C(①②)+ ④⑤ 人为断供/重复投递取证 + ③ reaction 真机 + **⑥⑦⑧ E 段能力级验收**(⑥ 复刻孤儿 gate + 无 gate terminal receipt + legacy 无 lineage fixture;⑦ 终态零 founder-page 且 Lead alert 送达;⑧ lead-target ack + 注入拒绝;其中 legacy fixture / OFF-ON 收敛属自动化 migration 测试,孤儿 gate 复刻与 page 行为在 529 房真机执行);沿用房测留存现场(run A/B);
- **风险**:A 重新启用自动批准面 → kill-switch + denylist + canonical founder id fail-closed + A3 完整谓词 + hold/deferral 全套随组件恢复,组件历史上已在生产跑过(FLY-1099 时代);B2 两库投影不假设跨库原子(outbox + durable cursor);sql.js 单写者:CommDB 写全部经 Bridge 进程内。
