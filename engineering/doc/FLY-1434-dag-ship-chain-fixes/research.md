# FLY-1434 DAG ship 链小修族批 — 调研

Issue: FLY-1434 (https://linear.app/geoforge3d/issue/FLY-1434/engine族批-dag-ship-链小修-3-统一重启改造-pr-回写绑定-runs-start-假成功-闭-run-rework-入口)
日期: 2026-07-23
基于: exploration.md

逐项给出现状代码盘点（file:line 为准）与设计约束。

## ① PR 回写绑定缺失 — 现状盘点

### 列与现有写入器（全是 legacy/三段式 sink）

- `sessions.pr_number`（`StateStore.ts:1912`，GEO-292）、`sessions.pr_head_sha`（`:1938`，FLY-175/191）
- 写入器：`event-route.ts` `setReviewBinding` `:1579-1582`（awaiting_review 时写 review_question_id + pr_head_sha，40-hex 校验 `:1571-1575`）、`patchCompletionEvidence` `:1647-1668`（写 `evidence.landingStatus.prNumber`）；`DirectEventSink.ts:794,947-951`；StateStore setters（`setReviewBinding` `:4895-4908`、`patchSessionMetadata` fieldmap `:4067,4076`、`upsertSession` COALESCE `:3671,3905`）

### DAG 路径绕过点（实锤）

`event-route.ts:725-729` 解析 generalizedContext → `:760-768` `commitEnrolledCompletion` → **`:769-808` 除 `not_enrolled` 外全部提前 return**，legacy 写入块永不执行。`commitEnrolledCompletion`（`StateStore.ts:20401-20720`）对 PR 列只有一处 READ（`:20636`），**丢弃 `evidence.landingStatus.prNumber`**（runner 的 `complete.ts:52-53,71` 明明带上来了）。引擎 head authority 是 git 派生（`head-authority.ts:18-43` rev-parse），qa_passed claim 的 `subject_digest` 存 head（`workflow-decision-routes.ts:422-423`）——**PR number 在 claim/gate-holder 体系里根本不存在**。

### 读侧（谁在等这个绑定）

- ship_ready 组装：`listWorkflowShipReadyCandidates`（`StateStore.ts:23804-23927`）→ head 取最新 qa_passed claim 的 subject_digest（`:23893-23897`）→ `prNumber = getWorkflowRunPrNumber(run_id, headSha)`（`:23898-23900`）
- `getWorkflowRunPrNumber`（`:25057-25083`）：查 sessions 行 `pr_head_sha === headSha && pr_number>0`（精确匹配 `:25061-25072`，>1 个匹配返 undefined `:25072`），fallback「该 issue 唯一 PR」（`:25073-25082`）—— DAG 单 sessions 无值 → undefined
- 「PR 未绑定」文案：`workflow-ship-ready-arm.ts:76-85` `evidenceSummary`（`:78`）
- **land 节点同样依赖**：`workflow-engine-dispatcher.ts:1356-1358` 取 prNumber，`:1359-1366` 无值抛 `engine_land_authority_unavailable` —— 不修 ①，⑤ 修完 self-ship 也会断在 land

### ① 设计要点（初步）

- 修在 enrolled completion 路径：`commitEnrolledCompletion`（或 event-route enrolled 分支）把 evidence 里的 `headSha`/`landingStatus.prNumber` 回写 sessions（与 legacy sink 同语义、同校验：40-hex、prNumber>0）→ `getWorkflowRunPrNumber` 现有读逻辑零改动即恢复工作
- ship_ready 组装侧无需改（读逻辑已对）；验收 = 新 DAG 单 ship_ready 带真 PR 号

## ② /api/runs/start 假成功 — 现状盘点

- Handler：`runs-route.ts:346`（`createRunsRouter` `:213`；挂载 `plugin.ts:3632-3637`）
- **假成功源头 = idempotency 缓存回放**：`runs-route.ts:1711-1718` —— `getWorkflowStartResponse(idempotencyKey)` 命中即原样 `res.json(priorResponse)`（含 `success:true` + 旧 executionId），零 admission、零 spawn。缓存写入在成功尾部 `:2149-2174`（`workflow_start_response` 表 `StateStore.ts:13536`）。**缓存只按 key 查，不校验 run 是否还活着，无 TTL/失效**
- Dedup 逃逸口：`:620-678` —— `alreadyActive`（running/awaiting_review/approved_to_ship）本应 409（`:668-674`），但 `exactActiveEngineStartSession`（`:643-645`）与 `exactGeneralizedReplay`（`:646-653`）两个豁免让请求落进 generalized 块 → 撞上缓存回放
- `admitGeneralizedWorkflowExecution` 幂等回放：`StateStore.ts:18438-18454` 返 `{ok:true, idempotentReplay:true}` 不 spawn
- 现有 admission 原因码（`StateStore.ts:18312-18660`）：`activation_conflict/invalid_expiry/run_not_found/invalid_snapshot/engine_ownership_required/unknown_node/not_start_node/unsupported_capability_combination/decision_producer_ambiguous/review_output_producer_required/same_vendor_review/actor_identity_conflict/successor_not_reserved(:18473)/invalid_retry_attempt`；HTTP 层另有 `GENERALIZED_*` 与 DAG-recovery 系列（`:1022-1383`）
- 802 案例（completed run）：active 查询查不到已完成 run → recovery 分类跳过 → 同 idempotencyKey 重调直接吃缓存 = 假成功

### ② 设计要点（初步）

- 缓存回放前校验 run 存活性：completed/terminal run → 诚实 4xx + 明确原因码（如 `RUN_ALREADY_COMPLETED` / `STALE_START_RESPONSE`）；缓存回放只对仍 active 且 execution 仍有效的 run 合法
- 语义辨析写进响应：真幂等回放（launch 在途）与「你在重启一个死 run」是不同的事，前者 202/200、后者 4xx

## ③ rework 入口 — 现状盘点

6b42de3f（PR #674，61 文件 +13579）落的 `WorkflowReworkCoordinator`（`workflow-rework-coordinator.ts:186-503`）：

- **本质是 re-entry 不是 respawn**：`reconcile()` 认领 lease → 唤醒 preferred 既有 actor（activationMode `"wake"` `:372-384`）→ 授 TURN（`:416-432`）→ `wake_delivered`；actor 死了发 `replacement_pending`（`:331-350`）由 dispatcher 物化替补
- **不覆盖 completed run**：`:270-283` `run.status !== 'active'` → retryable `rework_context_unavailable`；自动驱动器也跳非 active（`workflow-engine-dispatcher.ts:507-514`）；rework request 只能在 active run 的 live transition 里创建（`commitWorkflowTransitionTx` `StateStore.ts:21491-21599`）
- **不覆盖未预留 blocked 节点**：`:289-293` 要求 target 已被 route 的 preferred actor 预留（pending/admitted），否则 retryable `rework_target_not_reserved`；admission 同样卡 `successor_not_reserved`（`:18473`）。预留只发生在 transition 创建 request 时（`:21459-21511`）
- **触发面全自动、无人工入口**：request 创建仅三源 —— QA kickback（`submitWorkflowDecisionByCredential` → transition `:21101`）、founder feedback kickback（`applyWorkflowSourceEvent` `:22892-22910`）、completion 链式（`:20677`）；reconcile 由 engine tick 驱动（`workflow-engine-dispatcher.ts:481,260` + stall reconciler `:606`）。run 管理路由只有 `/:runId/hold` 与 `/:runId/terminate`（`runs-route.ts:235-320`，master-token）——**没有任何 founder/Lead 可触发的 rework endpoint**
- 表结构已备：`workflow_rework_request`（authority CHECK **已含 'founder'**，`:13286-13299`）+ `route_revision`（`:13302-13316`）+ `delivery`（`:13319-13331`）

### ③ 设计要点（初步）

- 802/1418 两案例正好对应两个盲区：completed run 重开、blocked 节点无预留。补一个 operator rework 入口（master-token 路由，Lead 经 Bridge 调用），职责 = 在一个事务里补齐 coordinator 需要的前置（completed run 重开为 active + 目标节点新 attempt 预留 / blocked 节点补预留 + rework request/route/delivery 行），然后交给**既有** coordinator/dispatcher 机器驱动 —— 不另造一台返工机器
- authority 沿用表内已有 `'founder'`；审计经 `workflow_run_event`（已有 `rework_route_interpreted` 等 kind）

## ⑥ 多 PR 单完成判定 — 现状盘点

### 三条完成机制（全部单 PR 假设）

1. **v1 land（merge 驱动）**：founder_approved → land 节点（`StateStore.ts:23060-23082`）→ dispatcher `:1345-1432` 用 `getWorkflowRunPrNumber(run_id, holder.head_sha)` 取**单个** PR → `land_operation`（`UNIQUE(project, issue, pr_number, approved_head)` `:13004-13023`）→ `completeWorkflowLandNode`（`:25621-25695`）置 run completed
2. **v2 terminal_gate（无 merge 尾）**：founder_approved + ship claims → 直接 `status='completed'`（`:23083-23109`）
3. **外部 merge finalization（per-session）**：`external-merge-reconcile.ts` 轮询 gh（`:86-90,265`）→ merged → `runPostShipFinalization` → Linear Done（`:428-465`）；ship-ready arm `classifyShipHandled` 单 prNumber 判 `pr_merged` handled（`workflow-ship-ready-arm.ts:277,386`）

### 多 PR 被当错误而非状态

- `getWorkflowRunPrNumber` `:25072` 多匹配返 undefined；fallback 仅 issue 恰一 PR `:25082`
- `external-merge-reconcile.ts:304-324` `resolveTurnPrNumber` 显式 `numbers.size > 1 → conflict`
- 全仓 grep `declared*pr / multi*pr / expectedPrs / pr_list` 等零命中 —— **「计划声明的 PR 集合」无任何承载结构**

### ⑥ 设计要点（初步）

- 引入最小「声明 PR 集」结构（run 级），声明时机 = implement 完成证据（多 PR 时 runner 在 complete evidence 里列全）或 Lead 显式登记；Done/ship 收口点（v1 land 完成、v2 terminal、外部 merge finalizer 标 Linear Done、ship-ready handled 分类）都改为「声明集全 merged 才收口」
- flag-off 纪律：先合部分必须 flag-off —— 机制化落点为 ship 前检查/提示（声明集未全齐时 ship_ready 文案与 Lead 通知明示「partial delivery, flag-off required」），不做构建期强制（无法静态判定 flag 存在性）——边界在 plan 里写实

## ⑦ wake_failed 假阳风暴 — 现状盘点

### wake pointer 何时建（根因：send 时无条件建）

- 持久表 `runner_phase_wakes`（`packages/flywheel-comm/src/db.ts:124-147`）：`state CHECK('pending','started','finished')`，`UNIQUE(execution_id, message_id)`
- **建行路径无任何 session 状态检查**：`send.ts:50` 只读 `getSession(...).vendor` → `:60` `db.instructionAndIntent`（`db.ts:2394`）→ `:2487` `admitReceiptWakeIntent`（`db.ts:3075-3205`）→ `:3163-3180` INSERT pending wake。response/gate 路径同样（`respond.ts:121,185` → `responseAndIntent` `db.ts:2818`；founder gate → `trustedFounderGateResponseAndReceipt` `db.ts:2973`）
- **started 收据只有一个来源**：runner 跑 `flywheel-comm inbox`（`inbox.ts:28` → `ackRunnerReceiptWakesStarted` `db.ts:4272-4289`）。running 中忙于本轮工作的 runner 不会调 inbox → wake 永远 pending

### 判定阶梯（RunnerReceiptPatrol）

`runner-receipt-patrol.ts:87-207`，接线 `plugin.ts:7702-7704`：T1=90s 重推 mailbox；T2=5min `nudgeWakePointer` —— 但 nudge 的状态门 `wakePointerStatusAllowed`（`runner-recovery-nudge.ts:196-202`）只放行 `awaiting_review|approved_to_ship|design_done` 或「running 且 isDeclaredParked」，**running 非 parked 直接 409 拒** → patrol 转 escalate；T3=12min → `wake_failed`（`plugin.ts:7817-7852` `notifyWakeFailure`）→ detection escalation 30min grace（`detection-escalation.ts:273` `DEFAULT_DETECTION_LEAD_GRACE_MS=1_800_000`）→ `pageFounder`（`:461`）

**反向激励闭环**：Lead 给健康 running runner 发正常消息 → 无条件建 pending wake → runner 不调 inbox → T2 nudge 被状态门拒 → T3 判 wake_failed → 30min 后 page founder。一晚 ~17 条全此类。

### ⑦ 设计要点（初步）

- 修在建行侧：`admitReceiptWakeIntent` 增加目标状态判定 —— 目标是 running（非 durable park）→ 正常流量，不建 wake pointer（或建即 finished）；只有唤醒 durable park 态（parked/design_done/awaiting_review/approved_to_ship）才要求 started 收据
- 状态判定来源与 nudge 的 `wakePointerStatusAllowed` + `isDeclaredParked`（`getEffectiveDeclaredState`）同一套语义，避免两处口径漂移
- 注意：send 侧在 flywheel-comm（CommDB 手里没有 sessions 表状态？——实现时需确认 send.ts 能读到什么状态面；`getSession` 已在读，看它含 status 与 declared park 与否）

## ⑧ review verdict 投递卡 open — 现状盘点

### 写入侧

- verdict = CommDB `messages` 普通 `type='response'` 行（`parent_id`=review gate questionId，`from_agent='bridge'`）；`relay_state` DEFAULT `'open'`（`db.ts:48`），`delivered_at` 迁移列（`db.ts:635-644`）
- Bridge 写入方：`review-request-coordinator.ts:1320-1383` `respond()` → `insertResponseIfGateOpen`（`db.ts:1592-1640`）——**不设 delivered_at、不动 response 的 relay_state**（`:1637` 只把 question 标 terminal_disposed）

### 递送侧（缺口）

- 写完只做一次 best-effort `wakeRunner`（`:1365-1381`）→ `plugin.ts:8359-8381` 接到**裸 `wakeRunnerMailbox`**（`wake.ts:65`）：无收据、无 `runner_phase_wakes` 行、无 T1/T2/T3 重推
- **全仓不存在 response 的 delivered 标记**：`delivered_at` 只有 instruction 路径的 `markInstructionDelivered`（`db.ts:4671-4674`，`send.ts:183`）会设
- claude lane 阻塞轮询 `gate.ts:206` → `getResponse`（`db.ts:1854-1859`，只按 parent_id/type 查）能读到；**codex lane runner 不阻塞轮询**（request-review 后收turn 等唤醒）→ 唯一一次 mailbox wake 丢了就永远空等。FLY-1364 15+ 分钟事故即此
- 崩溃恢复 `deliverStoredResponse`（`:739-810`，boot redrive `plugin.ts:8383`）只重跑同样的 best-effort wake
- 注：「No reviewer output yet」字面串不在仓内（事故记录的转述）；runner 读面 = `getResponse`

### ⑧ 设计要点（初步）

- verdict 递送改走 durable 收据链：写 response 后建 receipt-tracked wake（复用 `runner_phase_wakes` + patrol 阶梯——此场景 runner 正处 park/等待态，started 收据语义成立，与 ⑦ 的修互补：⑦ 砍掉 running 的误建，⑧ 给真 park 场景补上应有的 durable wake）
- 递达后标 delivered（response 的 delivered_at 语义补齐），审计可见

## ⑨ 跨仓 review 绑定缺失 — 现状盘点

- runner 侧 payload（`request-review.ts:84-90`）：`{executionId, requestId, reviewType, questionId, planPath?}` —— **无 repo、无 sha 字段**；头注释 `:16-18`「Bridge derives the trusted code-review head server-side」
- 服务端冻结：`review-request-coordinator.ts:597-604` `frozenHeadSha`（仅 code review）← `tryDeriveHead`（`:1405-1417`）← `deriveWorktreeHead`（`:296-307`）= `git -C <session.worktree_path> rev-parse HEAD`。被审对象 = session 自己 worktree 的 HEAD，无外部声明路径；underivable → 422（`:598-603`）
- `planPath` 有 `isSafePlanPath`（`:287-293`）拒绝 absolute/`~`/`..` —— 明确防止指出 worktree 外
- FLY-1437 场景：真代码在 session worktree **内嵌**的 plugin fork nested worktree（`cd7f0a6d`）→ rev-parse 冻的是外层 Flywheel HEAD，review 绑错对象

### ⑨ 设计要点（初步）

- payload 增可选被审对象声明（如 `--target-repo <worktree 内相对路径>`），Bridge 端校验：路径必须落在 session.worktree_path 之下（同 `isSafePlanPath` 语义），在该子 repo 内 rev-parse 冻结 —— 保持「payload 是被校验输入，authority 由服务端派生」的既有安全模型
- `codex_review_job.frozen_head_sha` 与 record 落账需带 repo 标识，避免跨仓 sha 混淆

## ⑩ codex_review_record 绑 exec 错位 — 现状盘点

- 表（`StateStore.ts:2604-2637`）：**PK (execution_id, target_pr_head_sha)** + issue_id/project_name/status/author_family/reviewer_family/request_id
- 写入方两条 lane 都绑「跑 review 的 exec」：结构化 lane `review-request-coordinator.ts:1188-1210` `commitAuthorityIfApproved` 用 `job.execution_id`（= implement exec）；legacy lane `auto-qa-coordinator.ts:975` 用 `targetExec = payload.targetExecutionId ?? event.execution_id`
- 查询方绑「ship 时的 exec」：`verify-approval.ts:325-329` `WHERE execution_id = ? AND lower(target_pr_head_sha) = ?`，execId 来自 ship 时 CLI `--exec-id`（= 持 TURN/QA exec）；Bridge 侧 `isCodexCodeReviewApproved`（`StateStore.ts:6884-6905`）同谓词
- 错位：implement exec 写行、ship exec 查行 → PK 不命中 → `codexApprovedForHead=false` → ship 卡死，executor-merge 已退役无人工兜底（FLY-1435 实证）
- **勘误**：issue 称「FLY-1255 复发」，但仓内 FLY-1255 文档是 vendor-neutral 标题显示，与 review record 无关；真实血缘 = FLY-827（durable gate record）/ FLY-1188 §7.1/§7.3（review-job registry + family stamps）/ FLY-945（executor-merge 退役）。plan 中按事实引用

### ⑩ 设计要点（初步）

- 按 issue 给的方向：查询键切到 issue+head（`issue_id` 列已在表上）—— verify-approval 与 `isCodexCodeReviewApproved` 改 `WHERE issue_id=? AND target_pr_head_sha=?`（head 是防漂移锚，issue 是归属锚）；写侧 PK 保留作幂等
- 需过一遍所有读点，确认无「同 issue 多 exec 并行 review」歧义场景（一 issue 一 worker 是现行纪律）

## ⑤ DAG founder-reply→decision 适配器 — 现状盘点

### 两条 founder 批准路径（现状）

**路径 1（三段式，FLY-945/FLY-799）**：founder thread 回复/reaction → FLY-945 识别器（`founder-ship-approval-handler.ts:212` `tryFounderShipApproval` / `founder-reaction-approval-handler.ts:86`）→ 收窄到「恰一个 awaiting_review session 且 `review_question_id` 匹配」的 CommDB `approve_to_ship` question → `writeGateResponseAndRunPostWrite`（`write-gate-response.ts:326`）写 `'{"approved": true}'` response。

**路径 2（DAG 引擎）**：run 到 `founder_gate`（node type `gate`）→ 节点置 `review` + `gate_opened` 事件（`StateStore.ts:21682-21698`）；引擎 dispatcher 对 gate 节点不派工（`workflow-engine-dispatcher.ts:1443`），只等。解锁唯一途径 = `workflow_claims` 里出现 `founder_approved` claim（issuer_kind `founder_challenge`），由 `applyWorkflowSourceEvent`（`StateStore.ts:22628`）在 drain CommDB `workflow_source_event(kind='founder_approval')` 时写入（claim 写入 `:22977-22996`）。v2 模板 terminal_gate 收到 claim 即 resolve ship claims + run `completed`（`:23083-23110`）；land_v1 则 gate_holder→approved→transition to land（`:23026-23082`）。

### 断链点（⑤ 的真根因）

CommDB gate 物化链 **只对 `land_v1` 变体接线**，三处 guard：

1. **gate holder 只在 land_v1 建**：`StateStore.ts:21699-21748` `commitWorkflowTransitionTx` —— `manifest_variant === "land_v1"` 才 INSERT `workflow_gate_holder`；默认 `tpl_eng_heavy`（v1 非 land）与全部 v2 模板到 founder_gate **零 holder**。
2. **gate-materializer 只吃 holder**：`gate-materializer.ts:60` `materializeWorkflowGateHolder` —— 开 CommDB `approve_to_ship` question（`:92`）+ 发卡（`:117`）+ thread 绑定（`:141`）；由 `plugin.ts:7586` 驱动。无 holder ⇒ 永不跑。
3. **GateAuthorityView 只 resolve land_v1**：`gate-authority-view.ts` `isWorkflowManifestV1Land` guard。

**后果**：非 land DAG 单到 founder_gate 时，无 approve_to_ship question、无卡、无绑定 → GatePoller `founderReplyDeliverPass`（`gate-poller.ts:3219`）的 shipGates 为空 → FLY-945 识别器收窄到零（`founder-ship-approval-handler.ts:232`）→ founder 回 ship 只被当普通消息转给 Lead（`founder-reply-deliverer.ts:485`）→ 零 `workflow_source_event` → 引擎停在 founder_gate。1423 实测（2026-07-23 03:18）与此完全吻合。

### 关键修正：issue 说「调 workflow decision API」，代码结构不支持

`/api/workflow/decision`（`workflow-decision-routes.ts:267`）的能力族只有 `qa_verdict/review_verdict`（`workflow-claims.ts:61-64`）；`founder_approved` 只允许 `founder_challenge` 系统签发（`workflow-claims.ts:55,76`，注释 `:68`）。**decision API 结构上不能替 founder 落笔**。真正的引擎侧「decision 写入面」= `workflow_source_event(founder_approval)` → projector（`founder-approval-projector.ts:74` drain，`plugin.ts:3978` 启动，5s 间隔）→ `applyWorkflowSourceEvent` → `founder_approved` claim。

### 现成可复用的 seam

`insertFounderApprovalResponseWithSource`（`db.ts:1647`）**同一事务**写 CommDB response + `workflow_source_event(founder_approval)`（`:1699-1716`），由 `writeGateResponseAndRunPostWrite` 的 trusted-founder 分支调用（`write-gate-response.ts:574-609`）。即：只要非 land DAG 单也物化出 approve_to_ship question + GateAuthorityView 放行，FLY-945 全套识别（文字+reaction）、consent 语义、source-event→claim 链路**原样复用，零新协议**。

### consent 语义现状（设计必须保持）

- `decisionMode`（off|audit_only|enforce）：`decision-mode.ts:30`
- Surface A（HTTP middleware，14 个 reserved endpoint）+ Surface B（gate-response wrapper `founder-consent/gate-response-router.ts`，action `approve_to_ship_gate`，`reserved-endpoints.ts:126-131`）
- `/api/workflow/decision` 不在 reserved 集（credential 认证 + loopback-only）；founder_approval source 写入方是 trusted internal writer（`write-gate-response.ts:496-497`）
- ⑤ 走「物化 gate + 复用 FLY-945」方案时 consent 语义天然保持（批准仍经 Surface B / trusted 分支），满足 issue「consent audit_only/enforce 语义保持」

### thread→run 映射（现成）

- `chat_threads` 表 `UNIQUE(issue_id, channel_id)`（`StateStore.ts:2281-2300`）；GatePoller 已按 issue thread 归组 pending questions（`gate-poller.ts:3262,3286-3345`）
- issue→活跃 run/node：`listActiveGeneralizedWorkflowExecutions(issueId)`（`StateStore.ts:18773`）
- `workflow_gate_holder` 表（`StateStore.ts:12971-12999`）：`state(materializing|awaiting_review|approved|superseded)` + `materialization_stage` + `question_id UNIQUE` —— 泛化到 v2 的承载结构已在

### ⑤ 设计要点（初步）

- 方案：把 gate-holder 创建从 land_v1 guard 泛化到「所有到达 gate 节点的 DAG run」（v1 非 land + v2），gate-materializer / GateAuthorityView 同步放行对应形态；v2 terminal_gate 的 claim 消费已存在，无需新写
- 不走「Lead/adapter 调 decision API」——结构上不通且会绕开 consent
- 风险面：land_v1 现行为字节不变（回归护栏）；v2 头 sha（`founder_approved ⇒ subject_kind='git_head'`，`StateStore.ts:22537-2255x`）从哪来 —— 与 ① 的 pr_head_sha 回写强耦合，①⑤ 联动设计

## ④ 统一重启改造 — 现状盘点

### 现存重启入口全景

| 入口 | 位置 | 模式/flag | 调用方 |
|------|------|-----------|--------|
| `scripts/restart-services.sh` | 主脚本 1445 行 | 三分支：bridge-only (`:1350-1398`)、Lead-only/PLUGIN_ONLY (`:507-519` → `:1400-1434`)、全量 deploy (`:1435+` → `deploy_and_verify` `:1256-1344`)；flags `--force/--wait-idle/--dry-run/--bridge-only` (`:410-435`) | Orchestrator/spin post-merge、update-flywheel.sh |
| `scripts/self-ship-restart.sh` | FLY-270 Method B | 不自己重启；入队 ship marker → detached launchd updater → kickstart (`:42-47`) | spin.md:398、orchestrator.md:416（防自重启死锁） |
| `scripts/update-flywheel.sh` | launchd updater | `default_deploy()` `:77-91` → 内部跑 restart-services.sh `:88` | launchd |
| `scripts/packaged/restart-packaged-services.sh` | NPM 分发路径（FLY-1062） | `--no-leads` `:30` = packaged 版 bridge-only 类似物 | packaged 用户 |
| launchd KeepAlive | com.flywheel.bridge.plist 等 | kill 后 ~5s 自动 respawn | 系统 |

### `--bridge-only` 删除范围（全仓 grep 实测）

**功能代码（删了会断）**：
- `restart-services.sh` 本体：`:5,13,412,424,438,475,478,617,672,675,690,693,1350-1396`（flag 解析、全部 guard、整个 bridge-only Main 分支）
- **活体调用方** `setup-quota-monitor.sh:174,353` —— `"$RESTART_BIN" --bridge-only`（CUTOVER env-key 流），flag 删除即断，必须同步改
- `scripts/hooks/flywheel-restart-guard.py:116-117` —— DENY_REASON 操作指引文案（FLY-913 强制唯一合法路径的 hook）
- `packages/config/src/feature-flags/registry.ts:930,958` + `packages/config/src/three-stage-phases.ts:38,216` —— flag 说明文案指示「改 env 后 restart-services.sh --bridge-only」

**测试**：`scripts/test-restart-services.sh`（专门的 bridge-only hermetic 套件，30+ 处）、`test-flywheel-restart-guard.py:215-219`、`__tests__/setup-quota-monitor.test.sh:273`（断言 restart.log 含 `--bridge-only`）。

**历史文档**（FLY-1142/1224/1245/1259/1264/1282/1285/1427/1182/1062 等 doc 文件夹）：不改——历史设计文档记录当时事实，非活文档。活文档（feature-flags registry、restart-guard 文案、bridge-ship-discipline 等）改。

### 通告现状（谁发、发哪、何时静默）

FLY-1081 已完成去 Simba 化，三条通道齐备：
- `notify_routine()` `restart-services.sh:155-179` —— ✅/🔄/⏳ 例行通告 → **claw-infra-bot → #flywheel-notify**（需 `CLAUDE_INFRA_BOT_TOKEN` + `FLYWHEEL_NOTIFY_CHANNEL`，未配置 = stderr ERROR + meta-alert，无静默回落）
- `alert_warning()/alert_severe()` `:127-146` —— deploy_degraded/deploy_failed → lead-alert.sh → #flywheel-alerts（severe @founder）
- 触发位点：全量 deploy 起止 `:1259/:1343`、Lead-only 起止 `:1403/:1428`、idle-wait 进度 `:678`

**缺口（④ 要堵的）**：bridge-only 分支 `:1350-1397` 内零 `notify_routine`/`alert_*` 调用，注释 `:1356-1360` 明言 "never sends deploy notifications" —— 这正是「env 变更重启无通告」的来源。

### env 变更流

- 单一真相 `~/.flywheel/.env`，由 `flywheel-bridge-wrapper.sh:32,42-48`（`set -a; source`）与 `restart-services.sh:86-95` 读取；plist 刻意不带 EnvironmentVariables（bridge-daemon-management.md:19-21）
- Node `process.env` 是 fork 时快照 → env 生效必须重启 Bridge
- 现行规程（restart-guard.py DENY_REASON `:109-120`）：纯 env 变更 = `--bridge-only`；代码 deploy = 全量；ship = self-ship 链路 —— ④ 之后前两者合一

### 安全约束（改造不得破坏）

1. **FLY-270 自重启死锁**：Runner/Lead 不可 inline 跑 restart-services.sh（会重启协调者自己 + idle-wait 数到自己）；self-ship-restart.sh 的 detached handoff 通道**必须保留**
2. **FLY-239 精准杀**：`bridge_target_pids()/bridge_port()`（`:783-784`）按 port + 进程树，不裸 pattern sweep（不误杀 QA-slot bridge）
3. **FLY-516 port fail-closed**：`bp_confirm_port_released` `:813-829`，kill 后必须确认 9876 释放，否则 abort（防 EADDRINUSE / 旧进程假健康）
4. **FLY-913 restart-guard hook**：改造后 DENY_REASON 文案必须同步（删 `--bridge-only` 指引），否则 hook 教人用不存在的 flag
5. **FLY-1224**：idle-wait 已 default-OFF，`--wait-idle` 恢复 —— 与 ④ 无冲突，保留
6. bridge-ship-discipline.md `:9`：多 PR 攒一次重启 —— 全量化后此纪律更重要（重启成本上升）

### ④ 设计要点（初步）

- 删 `--bridge-only` flag + 整个 bridge-only Main 分支；env-only 场景走全量路径（自动带通告）
- `setup-quota-monitor.sh` 两处调用改为无 flag 全量调用
- restart-guard.py DENY_REASON、feature-flags registry / three-stage-phases 文案同步
- bridge-only 专属测试套件删除/改写；setup-quota-monitor 测试断言更新
- 开放问题：Lead-only(PLUGIN_ONLY) 分支是否也算「分档」要删？（Annie 直令原文是「一切分档重启入口」——需在 plan 中明确：建议一并删，classify_changes 仅用于日志/通告内容，不再决定重启范围）
- 边界：packaged 路径 `--no-leads` 是独立产品面（NPM 分发用户），不在本单射程 —— plan 中显式声明
