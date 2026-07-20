# FLY-1373 消息系统消费循环照抄 — 调研

Issue: FLY-1373 (https://linear.app/geoforge3d/issue/FLY-1373/消息系统-照抄-claude-code-消费循环-lead-收件全链路根治1s轮询销账语义忙时挂起批量投递类型分流)
日期: 2026-07-19
基于: exploration.md

> 蓝本解剖见 exploration.md §2(第一手精读,行号已核)。本文 = 我方现状审计(两个独立 codebase 审计 agent 的回报,经整合;所有 file:line 为本 worktree 实测)+ 差距分析 + 设计输入。

---

## 1. 最重要的发现:Lead 终端那一跳**已经在用蓝本**

FLY-142 之后的默认收件路径(`FLYWHEEL_COMM_BACKEND=mailbox`):

```
producer → comm.db / lead_events → Bridge GatePoller(3s)/HeartbeatService(5min)
        → MailboxLeadRuntime.deliver() → 写 Lead 自己的 claude-code 信箱文件
          teams/<leadId>/inboxes/<leadId>.json
        → Lead 进程内 stock useInboxPoller(= 蓝本本体!)1s 轮询消费
```

- `packages/teamlead/src/bridge/mailbox-lead-runtime.ts:87-134`:`deliver()` 把 envelope 格式化成纯文本,`mailbox.writeVerified({leadName, recipient: leadId, payload})` 写 Lead **自己的** Agent-Team inbox;文件头注释(L1-19)明说「Lead's stock `useInboxPoller` reads … on its own loop and injects directly into the conversation」。**无 tmux send-keys、无 PostToolUse additionalContext**。
- 旧路径 `CommDBLeadRuntime`(`commdb-lead-runtime.ts:32`,`FLYWHEEL_COMM_BACKEND=commdb` 回滚开关)才是 PostToolUse hook 注入。

**推论(修正 exploration.md §3 的候选映射)**:蓝本的忙/闲检测、忙时挂起、批量打包、markRead-after-delivery 在**最后一跳**(信箱文件 → Lead 模型 turn)已由 stock claude-code 原厂提供,不需要我们造 pane 忙检测。**FLY-1373 真正缺的那半边在 Bridge 侧**:comm.db/lead_events → 信箱文件之间的消费循环没有蓝本语义。这与 issue 考古结论一致(GEO-206 搬走的是存储,消费循环没搬),只是「消费循环」的落点比 exploration 初判更精确:**Bridge 内 per-Lead 的 comm.db 消费循环**,它的「提交 turn」动作 = 写 Lead 信箱文件(verified write),之后的事蓝本原厂已管。

代码里也自证了这个缺口:`detection-gap-scan.ts:64-66` —— 「Only the FLY-109 push path carries this evidence today; **the Lead-mailbox consumption gap is PRD-bound (D7)**」。

## 2. comm.db 现状(schema 与读写方)

- 打开:`packages/flywheel-comm/src/db.ts:312-325`,better-sqlite3,`journal_mode=WAL`(L320)+ `busy_timeout=5000`(L321);只读打开 `openReadonly`(L332-337)。路径:`resolve-db-path.ts:9-27`(`--db` → `FLYWHEEL_COMM_DB` → `~/.flywheel/comm/<project>/comm.db`)。
- `messages` 表(`db.ts:18-40` + 迁移列):`type` CHECK `('question','response','instruction','progress','ack_receipt')`、`checkpoint`(gate 类)、`content`、`parent_id`、`read_at`、`delivered_at`(FLY-109,`db.ts:361`)、`resolved_at`、`relay_state`、`kind`('report',FLY-1041)、provenance 列若干。**无 priority 列、无 deadline 列**。
- 排序:全部 `ORDER BY created_at ASC`(questions `db.ts:1480`;instructions `db.ts:1631`;push `db.ts:1879`)。**`created_at` 秒级分辨率 + UUID 不按插入序排 —— db.ts:1531-1535 自己写了 caveat**;`runner_phase_wakes` 已示范正解:`queue_seq INTEGER AUTOINCREMENT`(`db.ts:86-98`)。
- 索引:`idx_messages_to_agent(to_agent,type,created_at)`、`idx_unique_response`(UNIQUE parent_id WHERE type='response')、`idx_messages_checkpoint`、`idx_messages_logical_event` 等(`db.ts:119-127, 490-493`)。
- 写方:`ask`(insertQuestion checkpoint NULL,`ask.ts:36`)、`gate`(insertQuestion + checkpoint,`gate.ts:125`)、`send`(insertInstruction,`send.ts:49`)、`respond`(insertResponse,`respond.ts:104,158`)、`ack-event`(insertAckReceipt,`db.ts:1122-1143`)、Bridge 直写 instruction(codex 触发,`event-route.ts:375,411`)。
- 读方:Bridge `GatePoller.getPendingQuestions`(`db.ts:1468-1483`)、Runner `flywheel-comm inbox`(`getUnreadInstructions` → `markInstructionRead`,`inbox.ts:14-28`)、只读 gap-scan(`detection-gap-scan.ts:299-441`)。

## 3. 现有投递链路全图(将被替换/吸收的部分)

### 3.1 GatePoller — 3s tick + ~20 个搭车 patrol

- 实例化 `plugin.ts:6933`,**`pollIntervalMs: 3_000`**(`plugin.ts:6934`);timer `gate-poller.ts:593-609`,重入护栏 L637。
- 每 tick:逐 project 逐 lead 读 `getPendingQuestions`(L833),每条 question 单独 `relayToLead`(L900)——**一条一投,无批量,无优先级**(`HookPayload.filter_priority` 只是展示字段,不重排,`mailbox-lead-runtime.ts:356`)。
- 同一 tick 上搭了 ~20 个 patrol pass(misroute patrol、zombie-gate hygiene、founder-reply deliver、disposition-receipt、gap-scan…,`gate-poller.ts:640-1189`),节奏按 tick 数折算(如 `DEFAULT_PATROL_EVERY_N_TICKS=20` ≈ 60s,L380)。**新统一循环必须逐一处置这些搭车客**(吸收/保留/禁用)。

### 3.2 relayToLead 的销账语义(现状)

`gate-poller.ts:1651-1790`:gate 作用域校验 → `isLeadEventDelivered` 去重(L1704)→ `appendLeadEvent` 落 `lead_events` 得 seq(L1744-1750)→(ack 开启时)`markQuestionProtected` 绑定 CommDB 行(L1752-1762)→ `runtime.deliver(envelope)` → 成功即 `markLeadEventDelivered(seq)`,失败 `recordDeliveryFailure`。

**「delivered」= 信箱文件写入成功,不是「Lead 消费了」。** FLY-109 语义(`db.ts:1854-1866`):`inserted → markDelivered →(retry 窗口)→ ackRead(read_at)`;`send.ts:116-125` 明说 delivered_at = transport write returned ok(**raw write,不验证**);mailbox 路径故意不设 read_at(「没有可靠的 Runner 侧 ack 点,我们不造假」)。Lead 侧的 ack 走独立协议(`ack_receipt` 行 + `LeadEventDeliveryCoordinator.reconcile()`,`lead-event-delivery.ts:113-171`,机器证据可 auto-ack L320-358)。

### 3.3 第二条投递循环 — HeartbeatService(5min)

`HeartbeatService.ts:555-559`,间隔 `TEAMLEAD_STUCK_INTERVAL` 默认 **300_000ms**;`check()` 先 `retryUndeliveredGuardrailEvents()`(L588-591,实现 L2941-2983)重投未投递的 guardrail `lead_events`。生命周期事件(session_stuck/orphaned/gate_timed_out/runner_idle…,清单 `lead-runtime.ts:18-31`)走 `appendLeadEvent + deliver + 5min 重试`。

### 3.4 已知丢/重窗口(代码自documented)

- **重**:mailbox at-least-once —— `send.ts:71-79`:同一 instruction 可能注入两次,靠 `[lead-instruction <id>]` 前缀让 Runner 幂等跳过;`MailboxLeadRuntime` 重投靠 `flywheelId` sidecar 去重(`mailbox-lead-runtime.ts:96-104`,`ClaudeMailboxCodec` 两阶段写 + read-after-write 验证)。
- **丢**:no-transport backend(`vendor="none"`)只落 CommDB 不投递(`send.ts:92-101`);mailbox 写失败 best-effort(stderr + CommDB 行是唯一 durable 记录,`send.ts:130-134`);ask 后 runner 转 idle 需显式 wake(`respond.ts` `wakeAskedRunnerBestEffort`,GEO-371 事故)。
- **两本账**:questions 在 comm.db,Bridge 事件在 StateStore `lead_events`(sql.js,schema `StateStore.ts:1720-1748`,`appendLeadEvent` L8128-8183)。sql.js 是「每写全库 export」的已知病灶(FLY-663)。

### 3.5 Producer 全清单(统一队列要吸收的五族)

1. Runner→Lead questions:`ask`/`gate` → comm.db `messages`(GatePoller 面)。
2. Bridge 生命周期事件:`POST /events`(`event-route.ts:528,433`;session_completed L613-673、qa_result L721、codex_review_result L770 …)→ `appendLeadEvent`。
3. 守护类告警:HeartbeatService / RunnerIdleWatchdog / LeadWatchdog → `appendLeadEvent`(guardrail 集合 `lead-runtime.ts:18-31`)。
4. Founder Discord 回复:主路径**不经**本管道(Lead 直读 chat channel);fallback = `founder-reply-deliverer.ts`(GatePoller 搭车,L1050-1073)写 CommDB `response` 或 wake-only;✅-reaction 船批走 `insertFounderApprovalResponseWithSource`(`db.ts:1256-1314`)。
5. Bridge 直写 instruction(codex 触发 `event-route.ts:375,411`、phase wakes `runner_phase_wakes`)。

### 3.6 Runner 侧收件(对照,受影响面小)

`flywheel-comm inbox` pull(`inbox.ts:14-28`)+ FLY-142/168 mailbox 双写唤醒:`send.ts:39-140`(insertInstruction → 按 session.vendor 路由 → `wakeRunnerMailbox` → wake.ok 才 markInstructionDelivered);`wakeRunnerMailbox`(`wake.ts:57-116`,**wake 是 HINT 不是 authority**);`deriveRunnerMailboxIdentity`(`path-helpers.ts:163-168`,`runner-${execId前8}` @ team=leadId);Bridge 侧 `sendRunnerWake`(`runner-wake.ts:105-201`,no-transport 跳过)。Runner 收件已有 FLY-1282 消费回执检测(见 §5)。

## 4. 忙检测 / 批量 / 优先级现状

- **写侧无忙检测**:Bridge 无条件写 Lead 信箱;注入时机由 stock `useInboxPoller` 全权决定(busy → 蓝本原生挂起排队)。Bridge 的 quiet/busy 机械(`quiet-classifier.ts`、`LeadWatchdog` 30s capture-pane)只服务卡死检测,不 gate 投递。→ **蓝本的忙时挂起在终端跳已原生存在;Bridge 层要补的是「优先级排序 + 打包」发生在写信箱之前**。
- **无批量**:每 question/事件一次 `deliver`。
- **无优先级**:纯 FIFO(且 created_at 秒级并列时序不稳,§2)。

## 5. 消费回执现状(FLY-1282)与 Lead 缺口

- Runner instruction 的消费证明:`detection-gap-scan.ts:393-425` —— delivered-but-unread 中排除「runner 后续消息内容 `instr(content, m.id)>0`(引用了完整 `[lead-instruction <id>]`)」者;前缀由 `send.ts:106` 写入;Runner 合同在 `Blueprint.ts:1688-1703`;阈值 unconsumedMs 默认 30min(`detection-gap-scan.ts:98-113`)。
- **Lead 信箱消费缺口今天没有任何回执/检测**(`detection-gap-scan.ts:64-66` 自认 PRD-bound D7)。本单的销账语义即是对这个缺口的根治:mark-consumed 的判据从「写文件成功」升级为「verified write 落到 Lead 信箱(sidecar flywheelId 可查)」,配合 stock poller 的原厂 markRead 语义完成端到端 at-least-once。

## 6. Watchdog / 补丁层全清单(反向 flag 圈定范围)

### 6.0 issue 描述与代码的 id 出入(以代码为准,已核)

- **FLY-1282 在本仓 = zombie-session-liveness**(`HeartbeatService.ts`,tri-state 会话活性),**不是**「Lead 指令未消费→催办」的检测。「指令疑似未消费」实为 **FLY-1048 A6 `delivery_unconsumed`**(`detection-gap-scan.ts`)+ **FLY-637-ext lead-pending-escalation**(`lead-pending-escalation.ts`)。
- FLY-270 在本仓 = self-hosting ship control plane,真正的 stale-session patrol 是 FLY-742/867/1204/754/720/1082/1099 系列。
- FLY-1365 = codex 路径同步超时契约(sync-op-marker 归因 + kill-group guard + ≤10s bound 契约测试),不发独立告警。

### 6.1 消息投递相关 watchdog(反向 flag 主要圈定对象)

| Watchdog | 位置 | 监什么 / 发什么 | 现有开关(默认) |
|---|---|---|---|
| **LeadWatchdog**(FLY-83→193→218→220→368→1048 A4/A5) | `teamlead/src/LeadWatchdog.ts`(1398 行),wired `plugin.ts:9510-9700`,30s capture-pane | Lead pane 冻结/blocked 关键词 → `rate_limit`/`usage_limit`/`login_expired`/`permission_blocked`/`pane_hash_stuck`/`pane_error_stalled`;eventId 与 `scripts/lead-alert.sh` 字节对齐共用 claims.db | `FLYWHEEL_PANE_IDLE_SUPPRESS`(ON)、multiframe 固化 ON、cooldown 30min |
| **Gate timeout**(FLY-159→191) | `HeartbeatService.ts:706-824` `checkAwaitingReviewTimeout` | awaiting_review 超 `reviewTimeoutHours`(48h)→ `gate_timed_out`(只通知不杀);FLY-1314 superseded 静默;FLY-579 QA-held 跳过 | `reviewTimeoutHours`(48,`plugin.ts:5479`) |
| **RunnerIdleWatchdog**(FLY-92) | `RunnerIdleWatchdog.ts`,wired `plugin.ts:9305-9364` | running session waiting≥2 cycle / idle / unknown → `runner_idle_detected` | `FLYWHEEL_IDLE_POLL_MS`(默认 3_600_000 ≈1h,FLY-628)、`FLYWHEEL_QUIET_PERSIST_DEDUP`(ON) |
| **StuckRunnerDetector**(FLY-195) | `bridge/stuck-runner-detector.ts`(无自有 timer,搭 idle poll) | 冻结超阈值且非合法 park → `runner_stuck_escalation`/`runner_stuck_unhandled` | `FLYWHEEL_STUCK_DETECT` + `FLYWHEEL_STUCK_*` 一族 |
| **FLY-1048 检测簇** | `detection-gap-scan.ts`(A6,~5min=100 tick)、`focused-frame-scheduler.ts`(A7)、`watchdog-judge.ts`(PR-B)、`detection-escalation*.ts`(PR-C) | gap1_parked_unreported / gap2_ask_unanswered / **delivery_unconsumed**(D6)/ pane_progress_suspect → Lead-first → founder page;fleet 聚合 | `FLYWHEEL_DETECTION_GAP_SCAN`、`FLYWHEEL_DETECTION_ESCALATION`、`FLYWHEEL_WATCHDOG_JUDGE`、`FLYWHEEL_GAP_UNCONSUMED_MS` 等 |
| **Misroute patrol**(FLY-208) | `gate-poller.ts:1195-1484`(20 tick ≈60s 搭车) | 黑洞 `team-lead.json` 未读 → 先归档 JSONL 再 ack → `runner_misrouted_report` | `FLYWHEEL_MISROUTE_PATROL`(有 transport 时 ON)、`FLYWHEEL_MISROUTE_ARCHIVE_DIR` |
| **Lead-pending escalation**(FLY-637-ext) | `bridge/lead-pending-escalation.ts`(纯策略,GatePoller 持久行) | question gate 挂 >20min 无进展 → 催 Lead,指数退避,3 轮后 page Annie → `runner_lead_pending_unhandled` | `FLYWHEEL_LEAD_PENDING_ESCALATION`、`_NUDGE_GRACE_MS`(20min)、`_PAGE_ANNIE_ROUNDS`(3) |
| **Delivery-ack / redelivery / dead-letter** | lead_events ACK 协议(`lead-event-delivery.ts`)+ dead-letter | 未 ack 重投,超限 dead-letter → `delivery_dead_letter` | `FLYWHEEL_DELIVERY_ACK`、`_TIMEOUT_MS`、`_MAX_REDELIVER`、`FLYWHEEL_DELIVERY_UNCONSUMED_V2`、`_DEAD_LETTER` |
| **founder-reply-watchdog**(FLY-1099 §7.2) | `bridge/founder-reply-watchdog.ts` | founder-reply pass 死掉/cursor 钉死/runner 不可达 | `FLYWHEEL_FOUNDER_REPLY_WATCHDOG`、`FLYWHEEL_FOUNDER_REPLY_DELIVER` |

### 6.2 不在本单射程的 liveness/清理类(**保留,不进反向 flag**)

进程与会话生命周期机制,与消息投递正交:**BridgeEventLoopWatchdog**(FLY-307 C,worker-thread 心跳,主循环卡 ≥60s SIGKILL 自杀由 launchd 拉起;`FLYWHEEL_BRIDGE_WATCHDOG` ON)、HeartbeatService 的 monitor-loss/orphan/crash-reaper/zombie(FLY-172/720/1282)/server-loss(FLY-1082)/stale-close(FLY-867/1204)、viewer-session-reaper(FLY-754)、stale-blocker-guard(FLY-742)、account-switch(FLY-696)、checkpoint-park patrol(FLY-927)、cmux pane-died hook(FLY-110,shell 层)。

### 6.3 gate 类 API 的 founder 绑定校验现状(Lead-ack 拒绝加哪)

三层现状:
1. **写路径 CLI** `respond.ts`:`GATED_CHECKPOINTS={"approve_to_ship"}`(L20);gated 路径 fail-close 必须经 Bridge(L68-155);`isReservedApprovalAttribution` 拒 `bridge`/`bridge-founder-consent`/founder-snowflake 冒名(L75-81)。**普通 Lead id 不在此拒** —— 会写进 response 行,只在读侧失败。
2. **写路径 Bridge HTTP** `founder-consent/gate-response-router.ts` `POST /api/founder-consent/runner-gate-response`:reserved-attribution 400(L188-194)、仅 approve_to_ship(L249-255)、FLY-191 question 绑定 409 stale(L257-272)、consent enforce 403/503(L387-419)。**今天 Lead-ack 被记成 `changes_requested` feedback + `approvalIntentWarning`(L107-129),不拒绝** —— **FLY-1373 的「API 层拒 Lead-ack」就加在这里**(+ respond.ts gated 路径同步)。
3. **读路径** `verify-approval.ts`(L265-552):`isTrustedApprovalAttribution` —— Lead id → `response_not_founder_attributed` fail-close(FLY-945 Fix E,L433-464;`FLYWHEEL_FOUNDER_ATTRIBUTION_GATE` 默认 ON)。
   原语:`founder-attribution.ts`(founder id 从 `~/.flywheel/.env` 活读)。

## 7. 差距分析:蓝本 6 件 × 我方现状

| # | 蓝本机制 | 我方现状 | 差距 → 设计输入 |
|---|----------|----------|------------------|
| 1 | 1s 硬轮询 + 挂载即首拉 | GatePoller 3s + HeartbeatService 5min 两条腿 | 合并为一条 per-Lead 消费循环;1s 活跃 / 30-60s 空闲 / push 即唤;boot 即首拉 |
| 2 | 处理完才销账(markRead after delivered-or-queued) | 写文件成功即 delivered;lead_events 与 comm.db 两本账;Lead 消费无回执 | 统一持久账本(comm.db);consumed 判据 = verified mailbox write;崩溃重读重投;消费者幂等(蓝本 L338-345 同款) |
| 3 | 忙时挂起(AppState.inbox pending) | 终端跳已由 stock poller 原生提供;Bridge 层无 | Bridge 层 pending = 队列行的自然状态(持久,强于蓝本内存态);不需造 pane 忙检测 |
| 4 | turn 结束批量打包投递 | 一条一投 | 每轮把应投消息按优先级打包为一次(或少数几次)信箱写 |
| 5 | 类型化分流 + 来源安全校验 | GatePoller 分 gate/runner_question;协议事件散在各 patrol;founder 绑定校验在 respond/verify-approval | 显式分流表:代码状态机类(ack、reaction 批准、生命周期状态推进)不进 Lead 模型;批准类只认 founder 绑定来源(§6 补校验点) |
| 6 | 优先级 now>next>later + 同级 FIFO + 用户不饿死 | 无 priority 列;created_at 秒级并列 | priority 列 + 单调 seq(仿 runner_phase_wakes.queue_seq);founder > gate/提问 > 报告 > 遥测;同级 FIFO;deadline 列一并加(SLA) |

## 8. 其他确认过的事实

- Feature-flag 落点:`packages/config/src/feature-flags/registry.ts`(FLY-709 中央目录,136 个 flag,读时机分类决定可否热切)。legacy watchdog 反向 flag 与消费循环心跳的注册都在这里。
- DAG pilot 证据面:`workflow_claims` 表(`StateStore.ts:12173+`)、`workflow-engine-dispatcher.ts`、flags `workflow_claims_write`/`workflow_claims_read`(registry.ts:2766,2802)。本单自身由 DAG 引擎派发即为 pilot 证据(验收⑥)。
- Codex-backend Lead 是独立 transport 族(`lead-backends/codex/`:`LeadInputRouter`、`RestPollDiscordInboundSource`、`CodexTurnExecutor`),**没有 stock useInboxPoller**。新消费循环的「批量投递」出口按 LeadRuntime 抽象走(`lead-runtime.ts:184-190`),对 codex Lead 的终端跳语义需在 plan 里单独交代边界。
