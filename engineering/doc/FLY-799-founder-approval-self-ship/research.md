# FLY-799 机制参考(codebase 实证锚点)— 调研

Issue: FLY-799 (https://linear.app/geoforge3d/issue/FLY-799/infrafounder-facingp1-ship-流程重构founder-discord-批准-归属-founder-runner-自)
日期: 2026-07-02
基于: exploration.md

> 目的:给 plan.md 每个改动点提供精确的现状锚点(file:line)+ 可复用的接口面。全部读过、非猜测。

---

## A. 批准链路(Part A 要改/复用的)

### A.1 `verify-approval`(runner 的 ship 授权闸,零改动复用)
`packages/flywheel-comm/src/commands/verify-approval.ts`
- 4 个 trusted 本地源全一致才 `approved:true`(L106-269):StateStore `review_question_id`
  绑定(L167-176)→ CommDB 该 question 存在且是 `approve_to_ship` 且 `from_agent===execId`
  (L189-197)→ 有 response(L198-201)→ response 解析成 `{approved:true}`(L217-232)→
  session `approved_to_ship` 且 `pr_head_sha` 匹配(L235-258)。
- **关键**:verify-approval **不校验 response 的 `responseFrom` 是谁**(L202 只记录)——
  它信任「谁写了 approve_to_ship 的 response 就是权威」,因为写路径被 respond.ts 限死(见
  A.3)。→ FLY-799 只要用一条**被信任的、归属 founder 的写路径**写 `{approved:true}`,
  verify-approval 自然 true。
- Fail-closed:缺文件/缺 binding/parse 错/head 不匹配 → false + machine-readable reason。

### A.2 `onResponseWritten` hook(翻状态 + 唤醒,Part A 复用)
`packages/teamlead/src/bridge/founder-consent/wiring.ts` L153-223
- 输入 `{executionId, questionId, leadId, answer, db}`。answer 解析 `{approved:true}` →
  若 session `awaiting_review` 用 `applyTransition` 翻 `approved_to_ship`(L175-207,与
  approveExecution 同 FSM 路径)→ `sendRunnerWake(…, "approval_wake", {questionId})`
  (L209-222)。非批准 → feedback_wake（不 terminal）。best-effort,幂等(重跑同结果)。
- 已 threaded 进 `createGateResponseRouter` 的 `onResponseWritten`（L241/293）。

### A.3 `respond.ts` 写闸(为何只有被信任路径能写 approve_to_ship)
`packages/flywheel-comm/src/commands/respond.ts`
- `GATED_CHECKPOINTS = {approve_to_ship}`（L12）。gated → 必须走 Bridge
  `/api/founder-consent/runner-gate-response`（L45-64)或 emergency
  `FLYWHEEL_COMM_BYPASS_BRIDGE=1`（L66-95);否则拒(L97-101)。CLI 从不直写 gated gate。
- → 这就是 verify-approval 敢信任 response 的原因。FLY-799 在 **Bridge 进程内** 写(见 A.5),
  等价于「被信任路径」。

### A.4 `gate-response-router.ts`(HTTP surface B;Part A 可复用其 insert+hook 逻辑)
`packages/teamlead/src/bridge/founder-consent/gate-response-router.ts`
- POST `/`：派生 CommDB path(server 端,L169-200)→ 校验 checkpoint===approve_to_ship
  (L210)→ `getCurrentReviewQuestionId` 只认当前 review question(L223-233,防 stale)→
  幂等/冲突(L244-268)→ evaluator(enforce)或 pass-through(off,L273-288)→
  `db.insertResponse(questionId, leadId, answer)`(L274/335)→ `onResponseWritten`。
- **注意**:这里 `leadId` 是 actor。FLY-799 若走这条,actor 要设成 founder 归属值而非 lead。

### A.5 `founder-reply-deliverer.ts`(Part A 的**主改点**)
`packages/teamlead/src/bridge/founder-reply-deliverer.ts`
- 已读 [FLY-XX] thread(GET `/channels/{threadId}/messages?after=`,L132-151)、按
  `msg.author.id===ctx.ownerUserId && author.bot!==true` 身份验证(L181-182)。
- `processFounderMessage`(L223-353):对 `approve_to_ship`(`ship` 数组,L238)**当前只
  WAKE**(L243-297,注释 L6-13「NEVER insertResponse」🔴 FLY-175);对 non-ship 走
  `respond()`(L318-349)。**FLY-799 = 给 ship 分支加「明确批准 → 写归属 founder 的
  `{approved:true}` + 跑 onResponseWritten」**。
- 已有 `db`(CommDB)+ `store`;deliverer 跑在 Bridge 进程内 → 可直接
  `db.insertResponse(qid, FOUNDER_ACTOR, '{"approved":true}')` + 调注入的 onResponseWritten。
- 可靠性:processed-through cursor,写成功/wake durable 才前移(L215-217)。
- 装配点:`gate-poller.ts` `founderReplyDeliverPass()` L1795-1883 构造
  `emitFounderReplyDeliveryForThread` 的 deps(L1866-1871,现传 store/fetchImpl/cursorStore/
  deliverAmbiguousToLead)→ **在这里 thread 一个新 dep**(如 `onFounderApproval` /
  `writeApprovalHook`)。

### A.6 批准意图分类器 `FounderConsentEvaluator`(Part A 复用)
`packages/teamlead/src/bridge/founder-consent/evaluator.ts`
- `evaluate(input)`:读 thread(L226)→ LLM 判 → **evidence 必须是 founder message id 且在
  window_hours 内**(L297-304)→ allow/deny/fail_closed。`EvaluateInput`(L73-）含 action /
  threadId / botToken。= 天然的「这条 founder 消息是否授权此 action」判定器。
- **caveat**:受 DECISION_MODE 控(wiring.ts L88-92:off 时 evaluator undefined)。prod
  default-off(MEMORY:FLY-175 default off byte-compat)→ **FLY-799 的批准检测必须独立于
  DECISION_MODE**(要么 FLY-799 自建一个 evaluator 实例做检测,要么用更轻的 classifier —
  见 plan D2)。

### A.7 outbound「等你批准」ping(已存在,不改)
`founder-thread-notifier.ts` `emitFounderThreadNotification`(approve_to_ship 分支 L87-95
「🚀 Ship gate 等你批准 @founder」)。由 `gate-poller.maybeEmitFounderThreadFallback`
(L1275-1404)在 grace 后发。FLY-799 只是让「回复它」真的能 ship。

## B. runner 自 ship(Part B,基本不改)
`packages/edge-worker/src/Blueprint.ts` APPROVE GATE 段 L1145-1177:verify-approval →
`stage set ship` → `:cool:` → 轮询 MERGED → 改写 land-status=merged → `stage set completed`。
L1167 明写「:cool: 是唯一 merge path,别自 `gh pr merge`(FLY-248)」。**Part B 的开放问题
= 要不要改这句**(见 plan D3)。resume 依赖 795(见 D5)。

## C. fan-out 收尾基建(Part C)

### C.1 单 runner 收尾(已存在,shipped runner 用)
`post-ship-finalization.ts` `runPostShipFinalization`(L150-285):原子 claim(L159-168)→
`postMergeTmuxCleanup`(L171)→ `removeCleanWorktree`(L189-205)→ ready-to-close 通知
(L227)→ 移 founder + `archiveChatThread`(L243-263)。触发谓词 `isPostApproveShipComplete`
(L63-82,要 landing=merged)。

### C.2 单 runner 清理原语 `closeRunner`(fan-out 每节点复用)
`close-runner.ts` `closeRunner`(L139-356):`finalizeDone`(卡 running/awaiting_review/
approved_to_ship → FSM 翻 completed,L159-201)+ kill cmux linked session(L282)+
killTmuxWindow(L287)+ 关 Terminal tab(L293-310)+ FLY-369 `maybeArchiveThreadOnClose`
(L270/345)+ `deleteCommDbSession`(L275/352)。幂等。**不含 worktree 删**。

### C.3 QA runner 清理原语 `closeQaRunner`(已存在!)
`auto-qa-effects.ts` L463-473+:`closeRunner({finalizeDone:true})` → idle/parked QA 翻
completed + archive(FLY-369)+ 删 row。→ **fan-out 的 QA 节点直接调它**。

### C.4 关系边
- **feature↔QA**:`auto_qa_record` 表(StateStore L1242-1259):PK
  `(parent_execution_id, target_pr_head_sha)`,`qa_execution_id` + `qa_issue_id/identifier/
  url`(FLY-643)。QA spawn 时 `claimAutoQaRecord`(L2580)/`setQaExecutionId`(L2603)记边。
  查:`getAutoQaRecord*`(L2553 rowToAutoQaRecord;有 idx on qa_execution_id + status)。
- **Linear sub-issue 子树**:`sessions` 表**无** parent 列(schema L775-800)。Bridge 有
  Linear SDK client(auto-qa-effects L171 `client.issue()`)→ 可 `issue.parent`/`.children()`
  但 prod projects.json 可能没配 `linear`(L152 注释)。→ v2 遍历要处理「无 linear client」
  fallback。

### C.5 worktree 删 + cmux
`WorktreeCleanupFn`(worktree-cleanup.ts,由 composition root 建、threaded 进 3 个
finalization 点)。cmux 由 `closeRunner` 的 `killCmuxLinkedSession`(tmux-lookup.ts,FLY-756)
清。标 Linear Done:auto-qa-coordinator / post-ship-finalization / done-running-reconciler 已
有 Linear-Done 能力(grep 命中,plan 里定位精确 helper)。

## D. 依赖 / 边界
- **FLY-795**(durable-state):Part B runner 自 ship 的 resume/finalize execution 地基。795
  有自己的强制 Annie brainstorm gate、P0。FLY-799 设计**标依赖、留接口**,不实现 795 的地基。
- **FLY-793**(三段式 sub-issue):Part C v2 子树结构来源。v1 不依赖它。
- **DECISION_MODE**:Part A 批准检测要独立于它(A.6 caveat)。
- **byte-compat**:所有改动要有 env 开关 + 默认不变行为(fleet 惯例)。
