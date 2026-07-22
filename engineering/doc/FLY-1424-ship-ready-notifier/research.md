# FLY-1424 ship 就绪通知发射器 — 调研
Issue: FLY-1424 (https://linear.app/geoforge3d/issue/FLY-1424/enginebug1-founder-gate-变-ready-零宣告-接ship-就绪通知发射器谁-emit-emit-给谁-怎么判)
日期: 2026-07-22
基于: exploration.md

逐条回答 exploration §6 的问题。全部证据取自本 worktree(HEAD ee2bf78f)。

---

## R1 · readiness 判定的数据源

**gate 节点 id 解析**:`workflowApprovalGate(manifest)`(`workflow-template.ts:679-685`)对所有 manifest 形态统一返回 `{node, predicate:"founder_approved"}` —— land_v1 → `approval_gate`,v1 非 land 与 v2 → `terminal_gate`。检测器用它 + `isWorkflowManifestV1Land` 排除 land(land 已有整链,F1)。

**ready 谓词**(全部现有列/表,无 schema 新增):
| 条件 | 数据源 |
|---|---|
| engine run 活跃 | `workflow_run.engine_owned=1 AND status='active'`(`listActiveWorkflowRuns` 已存在,dispatcher `reconcileDeadExecutions` 在用,`workflow-engine-dispatcher.ts:424-425`) |
| 停在 gate | `workflow_run.current_node_id == workflowApprovalGate(snapshot.manifest).node` |
| gate 已 open | `workflow_run_node(runId, gateNode).state == 'review'`(写入点 `StateStore.ts:18595-18601`);attempt 取 `listWorkflowRunNodes(runId, gateNode).at(-1)` |
| 尚无 founder 批准 | `workflow_claims` 无 `predicate='founder_approved' AND workflow_run_id=?` 行(批准 ingest 唯一写入点 `StateStore.ts:19660-19680`,issuer `founder_challenge`) |
| 尚未宣告(per-path) | pending.lead = 无 `ship_ready_lead_queued:<uid>`;pending.founder = 无 `ship_ready_founder_posted:<uid>` **且**无 `ship_ready_delivery_failed:<uid>`(uid = `<runId>:<gateNode>:<attempt>`;uid 唯一性即现有引擎幂等惯例,如 `engine_node_completed:` / `gate_opened:`) |

**attempt 维度语义**:founder_feedback_kickback(land)或 qa_retry loop 后再次到达 gate 会是新 attempt → 新 uid → 正确地重新宣告。v1 非 land 现无 kickback 进 gate 的回路(kickback 是 land approval_gate 的能力),但 uid 带 attempt 让语义天然向前兼容。

## R2 · 双路发射的落点 API

**路①(Lead)**:
- 落库:`store.appendLeadEvent(leadId, eventId, "workflow_ship_ready", payloadJson, sessionKey)`(`StateStore.ts:8255-8288`,UNIQUE(lead_id,event_id),重复返既有 seq —— 幂等重放安全)。eventId = `workflow_ship_ready:<runId>:<gateNode>:<attempt>`。
- 送达(唯一权威):`LeadInboxRuntime.enqueueLeadEvent(envelope, content)`(`lead-inbox-runtime.ts:159-171`,CommDB durable queue + nudge,1s LeadInboxLoop 消费)。queue id 由 `lead-event-queue.ts:11` 固定生成 `lead_event:<leadId>:<eventId>`(canonical,调用方不可传);重放 byte-stable 要求用 `getLeadEventBySeq(seq)` 的持久化 payload 重建 envelope/content(Codex R2 #5,queue 拒同 id 不同 content)。
- ⚠️ **勘误(Codex R1 #1)**:初稿设想「加进 `RETRYABLE_LEAD_EVENT_TYPES` 由 HeartbeatService 重投」已失效 —— 该重投 lane 受 `legacyDeliveryWatchdogsEnabled` 保护(`HeartbeatService.ts:596-603`),FLY-1393 后对任何 env 恒 false(`legacy-delivery-watchdog-policy.ts:11-16`)。**不改该集合**;在线可靠性由「emitter 每 tick 重驱未完成路径 + durable per-path fact」承担(见 R4 修订),durable queue receipt 之后归 LeadInboxLoop at-least-once。
- ack:FLY-1373 后新事件 `ackPolicyForLeadEvent` 一律返 null(`lead-event-ack-policy.ts:24-36`),durable inbox receipt 即回执 —— 无需新 ack 协议。
- payload 形态:HookPayload 惯例(`event_type/execution_id/issue_id/issue_identifier/project_name/status/summary/chat_thread_id`,参照 `question-admission.ts:112-125`),execution_id 用 qa source execution,summary 含 PR/QA 证据。

**路②(founder)**:
- `emitFounderThreadNotification(opts, {store})`(`founder-thread-notifier.ts:151-233`):已处理 thread/botToken/ownerUserId 校验、审计事件、transient/permanent 分类、429 Retry-After。
- `FounderGateCheckpoint` 现为 `"brainstorm" | "approve_to_ship"`(`:33`);新增 `"ship_ready"` 检查点 + 专属文案(见 R3)。共享 POST 核 `postFounderThreadCore`(FLY-725)不动。
- thread/lead 解析:照抄 `workflowGateMaterializeTick` 的现成闭包(`plugin.ts:7463-7477`):`resolveLeadForIssue(projects, run.project_name, labels)` + `store.getChatThreadByIssue(run.issue_id, lead.chatChannel)` + `lead.botToken ?? config.discordBotToken` + `config.discordOwnerUserId`。

**发射器宿主**:issue 钉「WorkflowEngineDispatcher 的 reconcile tick」。dispatcher 不持有 Discord/lead 解析,但已有注入先例 —— `landExecutor?: (operationId) => Promise<...>`(`workflow-engine-dispatcher.ts:76-81`)由 plugin.ts 注入。同款:注入 `shipReadyArm`(三方法:`queueLeadNotice` / `postFounderCard` / `isShipHandled` tri-state,合同见 plan W2),dispatcher 拥有检测+幂等+重试策略,plugin.ts 拥有投递臂(lead 解析 + lead_events + founder 卡 + PR-merged 只读探测)。pass 位于 reconcile 的 dispatch 消费**之后**(慢 POST 不推迟 dispatch);1s tick(`start(intervalMs = 1_000)`,`:192`)满足「N 秒内」验收。

## R3 · 卡片证据(PR + QA 状态)

- **head**:该 run 最新 ship-claim 证据。v1 eng:qa 节点最新 attempt 的 `qa_passed` claim `subject_digest`(claim 写入 `StateStore.ts:18198-18230`,subject_kind='git_head';attempt 取 `listWorkflowRunNodes(runId, qaNode).at(-1)`,与 `resolveEngineWorkflowShipClaims` 同法,`StateStore.ts:20038-20048`)。
- **PR 号**:`store.getWorkflowRunPrNumber(runId, headSha)`(land 分支在用,`workflow-engine-dispatcher.ts:726-728`)。
- **v2**:不在本单范围(R6 勘误:v2 三模板是 no-code founder-review 语义且形态互异,follow-up issue 承接);evidence 查询只需覆盖 v1 工程模板的 `qa_passed`。缺失时降级(qaPassed:false)照样宣告,卡上标注证据缺失。
- **文案(诚实边界,F4)**:`ship_ready` 卡**不得**承诺「回复/✅ 即批准」(那是 land 卡在 `gate-authority-view.ts:53-58` 权威守卫下才成立的承诺)。文案:🚀 ship 就绪 + @founder + issue identifier + PR/head/QA 状态 + 「Lead 已同步收到;在本 thread 表态 ship,由 Lead 执行合并」。

## R4 · 幂等、重试、失败分类(Codex R1 #1/#3 修订)

- **per-path durable facts(替代单一总闸)**:两路各自一个 workflow_run_event fact —— `ship_ready_lead_queued:<uid>` 与 `ship_ready_founder_posted:<uid>`(uid = `<runId>:<gateNode>:<attempt>`)。检测扫描对**缺哪路补哪路**;founder 路成功绝不压掉 Lead 路尾巴(R1 #1 的核心洞)。终态 fact:`ship_ready_delivery_failed:<uid>`(与告警同事务原子写,见 R5)。
- **路①**:`appendLeadEvent`(幂等,重复返既有 seq)→ `enqueueLeadEvent`(确定性 queue id)→ 两步都成才写 `lead_queued` fact;任一步抛错 → 无 fact → 下 tick 重驱(两步均幂等重放安全)。
- **路②(FLY-605 caller-owns-dedup 姿态,`founder-thread-notifier.ts:1-13` 头注明确否定 claim-first)**:
  - `posted` → 写 `founder_posted` fact(at-least-once:crash 在 post 与 fact 之间 → 下 tick 可能重发一张卡,与 materializer `card_posted` 同姿态,可接受);
  - `transient`(429/5xx/网络/`no_chat_thread`)→ 不写 fact,退避重试:base 30s 指数、cap 5min、honor 429 Retry-After(GatePoller 先例 `gate-poller.ts:2566-2568,2697-2737`);
  - **预算跨重启**:以 `gateOpenedAt`(durable)起算 45min 时间预算,不用 in-process attempts 计数(Bridge 重启清零问题);
  - `permanent` / 配置类 skipped(no_bot_token/no_owner/bad_owner_id)/ 预算耗尽 → 原子(单事务)写 `delivery_failed` fact + 告警(不静默吞;R5)。
  - notifier 返回合同 = discriminated union:`posted | transient{reason, retryAfterMs?} | permanent{reason}`(底层 `FounderThreadNotifyResult` 的 kind/skipReason/retryAfterMs 映射,`founder-thread-notifier.ts:82-99`)。
- **竞态**:检测与批准同 tick 交错 → 最坏多发一张已批准的卡,无状态破坏(检测器不写 run/gate 状态)。

## R5 · 超时兜底(review 停留超时 → 提醒 Lead)(Codex R1 #2/#4 修订)

- 阈值:`FLYWHEEL_SHIP_READY_REMIND_MS`,默认 30min。停留时长基准:gate open 时刻 = `workflow_run_node(gate).started_at`(upsert 于 `state:'review'`)。
- 通道(最终原子合同,Codex R2 #6b / R3 #4):新 public StateStore 方法(`recordWorkflowShipReadyStalledAlert` / `recordWorkflowShipReadyDeliveryFailure`)**内部**单事务写 fact + 调 private `enqueueWorkflowEngineAlertTx`(`StateStore.ts:16589`);不得在外层组合 public `enqueueWorkflowEngineAlert`(`:16597`,自开事务并 save,无法与 fact 原子)。消费 `reconcileWorkflowEngineAlerts` claim-before-send → alertSink(`workflow-engine-dispatcher.ts:351-395`)。escalationUid = `ship_ready_stalled:<runId>:<gate>:<attempt>`(uid 唯一 → 每 attempt 提醒一次,不刷屏 —— FLY-1220 教训)。
- **outbox 同 uid 要求 run_id+payload_json 字节相同,否则 `workflow_alert_uid_conflict`**(`StateStore.ts:16575-16586`)→ payload 必须确定性(含 gateOpenedAt,不含 now/age 动态值);disposition 枚举需扩 `ship_ready_stalled`/`ship_ready_delivery_failed`(现仅 held/partial 族,`:22593-22617`)。
- **「未处理」的可观测事实(R1 #2 的核心洞)**:v1 非 land 无批准绑定 —— founder 表态 → Lead 人肉 merge 不写任何 claim,run 停 gate 属正常已处理态。误报防线 = stalled 判定前过 **handledGuard**(注入,plugin 实现,tri-state 只读):PR 已 merge(FLY-1238 同源 GitHub 核验的只读提取)→ `handled` 并写 durable 收敛 fact `ship_ready_handled_observed:<uid>`(Codex R4 #1:merged run 从此退出 stalled 扫描、重启后不再 probe;该 fact 不冒充批准、不影响双路宣告);founder_approved claim 存在 → ready 基础谓词已排除。stalled 查询**独立于宣告 facts**(已宣告但未处理照样提醒 —— 这正是兜底的意义;初稿「同形态」自相矛盾,已废)。
- 残余风险(诚实边界):Lead 未 merge 且 founder 已口头拒绝的 run 会提醒一次 —— 单次、可接受。
- 身份:`resolveRunAlertIdentity(projectName, issueId)` 已注入 dispatcher(`:72-75`)。

## R6 · v2 覆盖判定(Codex R1 #5 修订:收窄到 v1 工程)

`gate_opened` 事件零消费者(全仓唯一命中 = 写入点 `StateStore.ts:18604-18605`);六个非 land 模板全部 `terminal_gate` 全部零宣告 —— 但 v2 三模板**不是 ship gate 语义**:
- ⚠️ **勘误**:初稿称 v2 统一「review_pass 进 gate、ship_claims 含 design_review_approved」是错的 —— 只有 tpl_product_v1 如此;`tpl_research_light`/`tpl_ops_light` 是 `node_done → founder_gate`,ship_claims 仅 `founder_approved`(各 seed yaml 已逐个核对)。
- v2 是 no-code artifact/review 流:可能无 PR、无 QA、无 merge 动作;「ship 就绪 + Lead 执行合并」的卡文案与 `workflow_ship_ready` 事件名对它们是**错误指令**。
→ **本单收窄到 v1 非 land 工程模板(tpl_eng_heavy/light/trivial,qa_passed-bearing)**,与 issue 验收精确对齐。v2 的 founder-review-ready 宣告(claim/能力驱动的 generic 合同 + no-code CTA)→ 开 follow-up issue,本单 HTML 诚实边界注明。

## R7 · 与现有机制互不干扰

- **不建 CommDB 问题、不建 holder** → GatePoller 准入/驱逐(`question-admission.ts:181`、`gate-poller.ts:1543-1575`)、zombie hygiene、materializer(只吃 holder,`plugin.ts:7459`)全部无交集;land_v1 双卡不可能(land manifest 被检测器显式排除)。
- **GatePoller 的 founder fallback** 只对 CommDB pending question 触发(`gate-poller.ts:2589-2598`),我们不产生 question → 无双发。
- **lead_events**:新 event_type,LeadInboxLoop 按类型无感透传(HeartbeatService 重投 lane 已退休,R2 勘误 —— 不再列为消费者);`idx_lead_events_dedup` UNIQUE(lead_id,event_id) 已存在(`StateStore.ts:1797`)。
- **字节兼容缺省**:发射器整体挂 `FLYWHEEL_SHIP_READY_NOTIFY`(default ON —— 本单就是修「零宣告」bug,default OFF 等于没修;`=0` 为逃生口,同 FLY-193 default-ON 先例)。

## R8 · 真机 E2E(复现 1375/1407 场景)

隔离房(qa-framework 4-slot,参照 memory `reference_qa_framework` + `reference_fly793_three_stage_e2e_three_bugs` 的三段式 DAG 房):
1. 隔离 Bridge + 隔离 Discord channel + slot lead;tpl_eng_heavy run 推进到 qa_pass(可用 FLY-793 房里驱动 DAG run 的注入法,或直接 SQL 预置 run 到 qa done 前一步再走真转移);
2. 断言:gate open 后 ≤10s,issue thread 出现 @founder ship-ready 卡(带 PR+head)∧ `lead_events` 出现 `workflow_ship_ready` 行;
3. 幂等:再跑 60s reconcile,卡与 lead_event 均不重复;
4. 兜底:把 remind 阈值调小(env),不处理 → alert outbox 出 `ship_ready_stalled` 且只出一条;
5. 反向:`FLYWHEEL_SHIP_READY_NOTIFY=0` → 全静默(回落现状字节等同)。

## R9 · 风险清单

| 风险 | 处置 |
|---|---|
| 卡片被误读为批准载体 | R3 诚实文案 + HTML 明示边界;批准绑定留给 land 迁移(F6) |
| at-least-once 双卡(crash 窗口) | 与 materializer 同姿态;marker 写入紧跟 posted;可接受 |
| thread 尚未建出(新 issue 早期) | `no_chat_thread` transient 重试;超预算走 R5 告警 |
| run 无 qa_passed claim(异常路径进 gate) | 证据行降级为「无 head 证据」,照样宣告 + 卡上标注;不 fail-close 整个宣告(宣告本身就是安全网) |
| v2 被误当 ship gate 宣告 | 检测器谓词硬限 schema_version===1 ∧ 非 land;v2 → follow-up issue(R6) |
| 告警刷屏 | escalationUid 唯一 + outbox claim-before-send;绝无每 tick 重发(FLY-1220 教训) |
