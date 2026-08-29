# Research: 现有 pipeline / runner-spawn / notify / QA 机制审计 — FLY-579

**Issue**: FLY-579
**Date**: 2026-06-26
**Source**: `doc/engineer/exploration/new/FLY-579-global-auto-qa-pipeline.md`

> 目标：审计现有 stage-flow / runner-spawn / decision-layer / approve-gate / notify / QA 机制，标出 FLY-579 的接入点与缺口。全部 file:line 基于 main = `ea944bb9`。

## 1. 现状 end-of-pipeline（已验证）

engineer runner：implement → test → `stage set code_review` → `stage set pr_created`（Bridge 在 `event-route.ts` ~L1168 `handleCodexAutoTrigger` 自动触发 Codex code review）→ runner `await-codex-gate code` 阻塞到 `code-review.json` = APPROVED → 开 approve gate：`gate approve_to_ship --no-block` + `complete --route needs_review --question-id <q> --pr-head <sha>` → Bridge 映射 status = `awaiting_review`、写 review binding（`review_question_id` + `pr_head_sha`）→ Bridge「always deliver」块（`event-route.ts` ~L1531）投事件给 Lead → Lead 把 ship gate 呈给 founder。

**FLY-579 触发点 = main session 进入 `awaiting_review`**（Tadashi Q1 裁决）。带 `pr_head_sha` + binding；独立于 Codex 内部；codexSkip 项目也覆盖。

### stage vs status（关键区分）
- **stage**（信息性，runner 上报）：`stage-utils.ts:13-43` VALID_STAGES + 顺序。`started→onboard→brainstorm→research→plan→design_review→implement→test→code_review→pr_created→approve→ship→completed`。
- **status**（FSM 校验的门）：`workflow-fsm.ts` `pending→running→awaiting_review→approved_to_ship→completed`（+ blocked/rejected/deferred/shelved/terminated/failed）。

## 2. Runner spawn（QA Runner 怎么起）

- HTTP 入口：`runs-route.ts` `POST /api/runs/start`，body 收 `issueId, projectName, sessionRole?, agentName?, leadId?, issueLabels?, owningDept?, docTier?, issueUrl?` 等。
- Dispatcher：`run-dispatcher.ts` `RunDispatcher.start(StartRequest)`（L526）。`StartRequest` 定义在 `retry-dispatcher.ts:69-109`，字段含 `sessionRole / agentName / issueLabels / owningDept / codexSkip / docTier / issueUrl`。返回 `{executionId, issueId}`。
- **非-HTTP-route 也能调 dispatcher**（先例）：retry 由 `actions.ts` + gateway 调，证明 Bridge 内部（如 event 处理）调 dispatcher 是既有模式。
- **inflight dedup 按 role**：`run-dispatcher.ts` `inflightKey(issueId, role)` = `issueId:role`（normalized）。所以同 issue 的 `qa` role 与 `main` 不冲突，且重复 `qa` 自动去重。
- BlueprintContext 构造：`run-dispatcher.ts` ~L571-606。executor backend 选择 `buildRunnerSpawnFields()`（role-adapter-resolver）。

## 3. Worktree（QA 必须 pin 到 reviewed commit，不是 origin/main）

- `WorktreeManager.create({mainRepoPath, projectName, issueId, startPoint?})`（`WorktreeManager.ts:114+`）。
- 命名：worktree/branch = `<repoSlug>-<issueId>`；`Blueprint.ts:405` role≠main → `worktreeIssueId = <issueId>-<role>`，故 QA worktree = `<repoSlug>-<issueId>-qa`，与 main 隔离（已有）。
- `startPoint = opts.startPoint ?? FLYWHEEL_RUNNER_START_POINT ?? "origin/main"`（`WorktreeManager.ts:130-133`）。
- **缺口 G1**：`StartRequest` 没有 `startPoint` 字段，没从 spawn 串到 `WorktreeManager`。FLY-579 需新增一条 `startPoint`（= main session 的 `pr_head_sha`，最稳：验的就是要 ship 的那个 commit）串 `StartRequest → BlueprintContext → Blueprint.run → WorktreeManager.create`。

## 4. Decision Layer / routes

- `decision-types.ts` `DecisionRoute = auto_approve | needs_review | blocked | pr_handoff`。`complete.ts` VALID_ROUTES 校验。
- `event-route.ts` session_completed 处理（~L538-1015）：route→status 映射。`needs_review` + 未 merged + running → `awaiting_review`。
- **QA verdict 怎么回报（设计点 D1）**：QA runner 不建 PR、产 PASS/FAIL 报告。需要让 Bridge 拿到结构化 verdict。候选：① QA 完成时用专门 route（如 `complete --route qa_passed|qa_failed`，需扩 VALID_ROUTES + FSM）；② 专门 comm 命令 / 结构化 event（如 `flywheel-comm qa-result --status pass|fail`）写到 parent(main) session。Plan 阶段定（倾向最小：一个 QA 结果 event/marker，Bridge 关联 parent main session）。

## 5. Approve gate / founder authority（保留不动）

- `verify-approval.ts:106-269`：fail-closed 4 检（StateStore `approved_to_ship` + bound `review_question_id` + `pr_head_sha` 匹配当前 HEAD + CommDB 有 `{approved:true}` 响应）。
- `actions.ts` `approveExecution`（~L178-416）：写 gate 响应 + FSM `awaiting_review→approved_to_ship` + `stage=ship` + wake runner。
- **FLY-579 不碰这套**。auto-QA 只决定**何时**把 main session 的 ship-ready 通知发给 founder；founder 仍走原 approve gate。

## 6. Runner wake（QA FAIL 把报告喂回 engineer）

- `runner-wake.ts`：`WakeKind = "approval_wake" | "feedback_wake"`；`WakeDetail.feedbackText`（截断 1500，durable copy 在 CommDB）；`wakeRunnerMailbox`。
- **QA FAIL = `feedback_wake` 实现 Runner**，feedbackText = QA 报告摘要 → 实现 Runner 走现成 changes-requested 路径（修 → push → re-request review → 重进 awaiting_review → **重新触发 QA**）。完美复用，0 新机制（Tadashi Q2 裁决）。
- no-transport backend（antigravity/kimi，`EXECUTOR_TO_TRANSPORT==="none"`）无 mailbox 不能 wake → FLY-579 需对 no-transport main runner 做特例（这类走 `pr_handoff` 终态、founder 手动 ship；auto-QA 对它们的语义 plan 阶段定，可能直接不上 QA 段或 QA 结果只通知 Lead）。

## 7. Notify 现状（⚠ 关键修正，见 exploration O1）

- `event-route.ts:81-105` `formatNotification` + 「always deliver」（~L1531）= 现有 awaiting_review → Lead 投递。
- **FLY-523 的 founder-gate-pending 主动 notify（#351）已被 #360 revert**（`aa5c6653`）—— `FounderGatePendingNotifier.ts` + `HeartbeatService` sweep 已删。revert 原因：把 ready 通知塞进 FLY-368 **alert 频道**（Annie：alert≠notification，ready 通知该落 issue thread）。
- `LeadAlertNotifier.ts`（仍在用）= **alert** 基建（claims.db 去重 / queue / deadletter / severity），**不是**本 notify 该走的路（它是 alert 频道）。
- **结论（✅ O1 RESOLVED，Tadashi 确认）**：main 上当前**没有** live 的 founder-ready 主动通知。**FLY-579 自己 own** 它的重新落地 —— **in-thread**（issue 的 [FLY-XX] thread）、gate 在 QA-PASS 之后、**绝不进 alert 频道**。无别的 PR 在重落 notify。
- **设计原则（写死）**：通知（ready-to-ship / completed 类「活儿好了」）→ issue thread；**alert 频道只放错误/异常**。alert ≠ notification（#351 被 revert 的根因）。

## 8. FLY-604 role executors（QA agent 现状）

- `.flywheel/config.yaml` `agents:` 声明 `engineer / qa / product-designer / general`，按 label match（`AgentDispatcher.ts:172-221` 3 步：override `dispatchByName` → dept+label → default/shipped-generic）。
- `qa` agent = `.flywheel/agents/engineering/qa-executor.md`（**flywheel-only**，dept=engineering），含完整 E2E 协议（Claude-in-Chrome、fetch HEAD before PASS、报 Lead via `flywheel-comm ask`、loop with dev runner）。其自述「Often spawned in parallel with Codex code review (feedback_qa_auto_spawn_on_pr)」—— **aspirational，机制尚未接**（正是 FLY-579 要做的）。
- shipped agent 只有 `agents/generic-executor.md`（repo 根，`agentFileRoot="flywheel"`，所有项目都拿得到）。
- **缺口 G2**：要「全项目通用」需一个 **shipped、项目无关的 `agents/qa-executor.md`**（repo 根），auto-QA-spawn 默认用它（经 `agentName` 或一个 sessionRole→agent 解析）；flywheel 自己的 `engineering/qa-executor.md` 保留/可作 project override。

## 9. QA context 注入（QA 怎么知道测哪个 PR/branch）

- Blueprint 把 agent 文件 + issue 内容注入 system prompt（`Blueprint.ts` ~L941-972；agent context 前置于 baseline）。
- **缺口 G3**：spawn 没有把「测 THIS PR / branch / parent exec id」传给 QA runner。需注入一个 QA-context 块（target PR 号/branch、parent main executionId、reviewed `pr_head_sha`）。与 G1（worktree pin）配套。

## 10. 接入缺口汇总（给 Plan）

| ID | 缺口 | 接法 |
|----|------|------|
| **G0** | event-route 不持有 dispatcher | 把 `startDispatcher` 接进 `createEventRouter`（`event-route.ts:348` + `plugin.ts` 接线）；或新建一个 coordinator 组件由 event-route 调（更可测，倾向后者）。 |
| **G1** | StartRequest 无 startPoint | 加 `startPoint` 串到 WorktreeManager，QA pin `pr_head_sha`。 |
| **G2** | 无 shipped 项目无关 qa-executor | 新增 `agents/qa-executor.md`（repo 根）。 |
| **G3** | QA 无 PR/branch context | spawn 注入 QA-context 块（PR/branch/parent exec/sha）。 |
| **D1** | QA verdict 回报机制 | QA 结果 event/marker 关联 parent main session（最小化，plan 定）。 |
| **C** | per-project/issue QA 策略 | `.flywheel/config.yaml` `qa:` 块（auto / skip_labels / agent）+ per-issue label + 全局 env kill-switch。`ConfigLoader` schema 扩展。 |
| **B-notify** | QA-PASS → founder 通知（O1 待确认） | in-thread 通知（绝不 alert 频道）gate 在 QA-PASS 后。 |
| **no-transport** | antigravity/kimi 不能 wake | 特例：QA 段对 no-transport runner 的语义（不上 / 只通知 Lead），plan 定。 |

## 11. 字节兼容 / rollout（Q4）

- 默认 OFF / opt-in（config `qa.auto` 默认 off 或全局 `FLYWHEEL_AUTO_QA` 默认关）= 字节兼容（不配置 → 现状行为逐字不变，reverse-compat sentinel）。
- flywheel 自身先开、验过 → 再全局 ON。全局 env kill-switch 兜底。
- 这与 FLY-205 doc-flow / FLY-175 founder-consent 的「default-off + sentinel」一脉相承。
