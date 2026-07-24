# FLY-1448 批准断路 — 实施计划

Issue: FLY-1448 (https://linear.app/geoforge3d/issue/FLY-1448/p1批准断路-founder-批准被静默丢弃-session-卡-running-无-durable-park-wake-拒投)
日期: 2026-07-23
基于: research.md
修订: R5(R4 唯一 HIGH 采纳:存量 terminal session 的 `terminal_lifecycle_id` 幂等 backfill —— migration 单事务铸稳定 id + CAS `ensureTerminalLifecycleId` 兜底 + 同一投影路径 + `completeRunnerPhaseWakeTerminal` 签名显式携带 fence + `OPERATIONAL_TERMINAL_STATUSES` 单一中立常量模块 + migration fixture 测试)← R4(R3 一 HIGH + 二 MEDIUM 全采纳:D1 episode 增 `opened_terminal_lifecycle_id` 持久身份 —— StateStore terminal-entry epoch 单调铸造、terminal→terminal 改写不推进、观测/completion API 携带 fence、身份缺失或不一致绝不并入旧 episode,补停机期 terminal→live→terminal 测试;A1 矩阵补「processed(预期 typed evidence)→ verify 幂等推进」与「processed(冲突 evidence)→ fail-closed pin+告警」两行及四种 typed evidence 崩溃重放测试;B3 定为无条件安全行为、删 `=0` 声明)← R3(R2 四 HIGH + 一 MEDIUM 全采纳:A1 root 处置改为 deliverer 权威重读 + CAS terminalization,不再按业务 outcome 盲推 root 状态,isDeadLettered 快路径推进游标前必须幂等修复 root;B2 outbox 改 append-only lifecycle 事件(park_opened/park_cleared 各占新 rowid)+ generation CAS 投影;C1 definite 决定的 classification 在不可逆写之前 durable 落盘,失败即 retry+pin;D1 terminal episode 生命周期按 category 分治(terminal 态存续期恰一 episode,dispose 不算恢复);D2/D3 terminal 处置事务后置条件 = wake terminal + alert identity + alert-pending outbox 三者同事务原子,founder-origin 改 message-scoped alert identity 不共享 episode)← R2(Codex R1 五 HIGH + 一 MEDIUM 全采纳:A 改为 root-first + 崩溃安全处置状态机;C 按 question 规范化、intent 前置于不可逆写、两级告警语义;B2 弃用 runner_declared_states 复用,改独立 engine-park 证据 + outbox/projector + activation/generation 绑定、只授权 wake pointer;D 指纹改持久 episode 代际、terminal 处置定义 CommDB 原子 transition、terminal authority 显式枚举;A 补完整 reply-to-card 授权谓词与 negative tests)

## 0. 目标与一句话方案

founder 对 ship-gate 卡的批准(散文 / 逐字 JSON / ✅ reaction)必须**生效或响亮地失败,绝不静默丢弃**。方案 = 四个修复叠加:
**A** 把被 FLY-1392 弃线的 text 归因组件接回 deliverer v2(恢复 FLY-945 合同);
**B** park/wake 记账对齐(`ship_parked` 入 wake allowlist + 引擎侧 engine-park 证据 + founder-origin wake 永不静默 dispose);
**C** founder 决定收敛看门狗(读到但未绑定 → 分钟级 fail-loud);
**D** wake_failed 告警改持久 episode 代际 + 终态 wake 原子处置(治告警跑步机且不吞新故障)。

单 PR 交付,chunk 顺序 A → C → B → D(A+C 先解 P1 急症,B+D 治底账;每 chunk 独立可测)。

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

## 7. 交付与风控

- **byte-compat**:A 的 dep 可选(absent = 现行为);B2 有 `FLYWHEEL_ENGINE_DECLARED_PARK=0` 逃生口;**B3 是无条件安全行为,无开关**(R3 #3:任何恢复 founder wake 静默 dispose 的 rollback 开关都违反本 issue 核心不变量「founder 决定生效或响亮失败」;founder-origin 标记 absent 的旧 wake 自然走现行为,已是兼容面);C deadline flag 可调;新 flag 全注册 `packages/config/src/feature-flags/registry.ts`;
- **全仓门禁**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`;Codex code review(`codex:rescue`)循环到 APPROVED;
- **部署形态**:Bridge 侧代码,merge 后需 Bridge 重启生效 —— 汇入「三线合流统一重启」窗口,不单独重启;
- **QA**:529 房复测断言 C(①②)+ ④⑤ 人为断供/重复投递取证 + ③ reaction 真机;沿用房测留存现场(run A/B);
- **风险**:A 重新启用自动批准面 → kill-switch + denylist + canonical founder id fail-closed + A3 完整谓词 + hold/deferral 全套随组件恢复,组件历史上已在生产跑过(FLY-1099 时代);B2 两库投影不假设跨库原子(outbox + durable cursor);sql.js 单写者:CommDB 写全部经 Bridge 进程内。
