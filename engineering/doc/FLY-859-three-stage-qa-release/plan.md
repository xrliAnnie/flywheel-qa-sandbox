# FLY-859 三段式 QA PASS → 放行 founder/ship — 实施计划

Issue: FLY-859 (https://linear.app/geoforge3d/issue/FLY-859/batch-gap三段式-qa-pass-放行-foundership-未实现deferred)
日期: 2026-07-04
基于: research.md
修订: R2(纳入 Codex design review Round 1 全部 6 项:qa_result 重启窗口 durable 化、
FAIL 两阶段 intent、#436 qa-role resume 冲突显式化、overlap 措辞收敛、轮上限语义、
patchSessionParams)

## 定案(Lead brainstorm gate 已批)

**Model A 设计点的答案:QA phase 自己 = ship gate 持有者 + ship 执行者。**
PASS 后 QA runner 不关,走标准 APPROVE GATE 流持 `awaiting_review`;founder 批准后
QA runner self-ship;关闭推迟到既有 post-ship finalization。FAIL → Bridge 关 QA、
起 Implement-fix、既有 handoff 自动再起新 QA = 闭环。deferred ThreeStageQaCoordinator
的职责落进既有 `PhaseOrchestrator`(新 `onQaResult`),不建平行类。

### Step 8「PASS 后关闭 QA」的调和(Codex design review 请显式确认此 reconcile)

FLY-793 plan Step 8 字面「QA PASS → push + 关闭 QA → 放行 founder/ship」没有回答关闭后
谁持 gate / 谁 ship(= FLY-859 issue 点名的 deferred 设计域)。本计划把「关闭 QA」的时机
从 PASS 时刻移到 **ship 完成后的既有 `runPostShipFinalization`**(它本来就负责 feature
runner 的 tmux/worktree/thread 收尾),换取 ship 执行者不缺位(FLY-799 是 runner-self-ships
模型,批准时必须有活 runner;三段里 Design/Implement 已按 Step 4 关闭,只剩 QA)。
Model A 语义逐条核:全顺序 writer 保持(PASS 后 QA 持 gate 不写码,B 无第二 writer);
FAIL 路径 QA 仍立即关闭释放 B(无 parked runner);**Bridge/活 runner 重启安全**
(awaiting_review + review 绑定 + 已 push 的 B 全持久化,gate-poller/799 re-wake 既有机制
接管;**死 QA-at-gate 的恢复 = #426 dead-runner Lead 告警边界,直到 #436 收窄其 qa-skip
—— 见「在飞 PR 协调」,不宣称 795 resume 覆盖**,Codex R2 #3)。
真机先例:FLY-849 §3.5 手动模拟即此链路,全 PASS。

## 改动面(5 文件 + 测试;不碰 auto-qa-coordinator.ts)

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/teamlead/src/bridge/phase-orchestrator.ts` | 新 `onQaResult` + deps 扩展 + startup stranded-pass 告警 |
| 2 | `packages/teamlead/src/bridge/event-route.ts` | `qa_result` 分支分流(三段 → orchestrator;否则 auto-QA 原路) |
| 3 | `packages/teamlead/src/bridge/plugin.ts` | orchestrator 新 effects 接线(markQaPass / readQaTail / countImplementPhases / postThread) |
| 4 | `packages/teamlead/src/StateStore.ts` | `countSessionsByIssueAndChatThreadRole` + `getStrandedThreeStageQaPassSessions` |
| 5 | `packages/edge-worker/src/Blueprint.ts` | isQaPhase prompt sequencing + isImplementPhase fix-round 段落 |
| 6 | `packages/teamlead/src/bridge/retry-dispatcher.ts` + `run-dispatcher.ts` + `packages/edge-worker/src/types.ts`(BlueprintContext) | `phaseFixContext` 加性字段透传(Bridge-INTERNAL,runs-route 不读) |

## 实施步骤(TDD:先失败测试 → 最小实现 → 重构)

### Step 1 — event-route qa_result 分流

- **逻辑**(`event-route.ts:625` 分支内、insertEvent 去重后):
  ```
  const reporting = store.getSession(event.execution_id);
  const isThreeStageQaPhase = reporting
    && (reporting.session_role ?? "main") === "qa"
    && (reporting.chat_thread_role ?? "main") === "qa";
  if (isThreeStageQaPhase && phaseOrchestrator?.current) → onQaResult(reporting, payload)
  else → autoQaCoordinator.current?.onQaResult(event)   // 逐字原路
  ```
  各自 try/catch(镜像现有两 holder 的隔离注释:一边故障不废另一边)。
- **RED**:三段 QA session 的 qa_result 进 orchestrator、不进 autoQaCoordinator;
  auto-QA runner(role=qa, chat_thread_role=main)仍进 autoQaCoordinator(byte-compat 哨兵);
  role=main / 未知 session / holder 缺失 → 原行为;duplicate event 不重复触发。

### Step 2 — PhaseOrchestrator.onQaResult(核心;verdict 处理 durable 化,Codex R1 #1/#2/#5/#6)

- **签名**:`onQaResult(session: PhaseSession, verdict: { status: string; summary?: string; prHeadSha?: string; targetExecutionId?: string; eventId: string }): Promise<void>`
- **守卫(顺序)**:
  1. `session_role !== 'qa'` 或非三段(caller 已判,防御性重判)→ no-op log。
  2. **幂等**:deps 重读 session 行(镜像 846 gate ⓪ 不信 caller 快照)。已有**同
     eventId** 的 verdict intent 且已走完(见下)→ no-op;`status` 已非 running 且无未完成
     intent → no-op log(重复/迟到 verdict)。
  3. `status` 非 pass/fail → warn 丢弃。
- **durable verdict intent(核心修订)**:任何副作用之前,先把 verdict 落成持久 intent
  (`patchSessionParams` merge 式写 —— **绝不用覆盖式 `setSessionParams`**,保 proofshot/
  evidence-gap 等既有 params,Codex R1 #6;模式 = `proofshot-session.ts:88` +
  `DirectEventSink.ts:786` 的 replay-safe 用法):
  ```
  three_stage_verdict: { status, event_id, summary?, at,
                         headSha?, closed?, fixExecId?, alertedAt? }   // 后四项仅 FAIL 逐步填
  ```
- **PASS 分支**(轻):
  - intent 落库(= pass 标记,含 `at` + 摘要)→ log 审计(targetExecutionId 仅记录)。
  - **不**碰 status、**不**开 gate —— QA runner 自己接着走 APPROVE GATE 流(Step 5 prompt)。
- **FAIL 分支(两阶段 durable,顺序重排:capture → intent → close → dispatch → 记
  fixExecId;每一步落库后崩溃均可由 Step 3 reconcile 续驱,Codex R1 #2)**:
  1. `resolveThreeStage(session).enabled` 为 false → fail-closed 告警
     (「three-stage 已关,QA FAIL 不自动循环」),intent 记 `alertedAt`,不派,return。
  2. 轮上限(**语义精确化,Codex R1 #5**):`maxFixRounds` 默认 3(env
     `FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS` 覆盖,非法值回默认);
     `maxImplementPhases = 1 + maxFixRounds`;守卫 =
     `effects.countImplementPhases(issueId) >= maxImplementPhases` → fail-closed 告警,
     intent 记 `alertedAt`,不派,return。边界:首轮 + 恰好 3 次 fix 放行,第 4 次 FAIL 拦。
  3. `capturePhaseHeadSha(session)` → null → fail-closed 告警(intent 记 `alertedAt`),
     return(QA findings 必须已 commit+push)。成功 → **intent 补 `headSha` 落库**
     (close 之后 worktree 即消失,head 必须先持久化)。
  4. `closePhaseRunner(session)`(dirty-safe;throw → fail-closed 告警,return)。
     成功 → **intent 补 `closed: true` 落库**。
  5. `startDispatcher.start({ issueId, projectName, leadId, sessionRole:'implement',
     dispatchModel: resolvePhaseModel('implement'), startPoint: intent.headSha,
     shareParentBranch: true, issueIdentifier, issueTitle,
     phaseFixContext: { round, qaSummary: truncate(summary, 600) } })`
     → 成功 → **intent 补 `fixExecId` 落库**(= FAIL 流程完成标志)。
  6. `effects.postIssueThread(...)`(best-effort,失败只 log)。
  - 闭环:fix implement 完成 `needs_review` 时**既有** `onPhaseComplete` 再起新 QA,零新码。
- **RED**:pass → 只写 intent 不动状态;fail → capture→intent(headSha)→close(closed)→
  start(fixExecId) 每步 durable + 各步失败 fail-closed 告警且不派;同 eventId 重放 no-op;
  上限边界(3 次 fix 放行/第 4 拦);config OFF 不派 + 告警;targetExecutionId 不参与键定;
  **params 保全测试:既有无关 session_params 键在 intent 各阶段写入后原样保留**。

### Step 3 — 重启对账:verdict 不落地 + 静默断裂告警(Codex R1 #1/#2/#3)

`reconcileOnStartup` 扩为三个 sweep(全部幂等、告警一次去重、best-effort 单会话失败不阻别的):

- **(a) inserted-but-unprocessed verdict 重放**(修 Codex R1 #1 的丢失窗口:
  `/events` 先 `insertEvent` 去重(`event-route.ts:605-618`)后调 coordinator,中间崩溃 →
  CLI 重试同 event_id 被 dedup,verdict 永久丢失):
  `StateStore.getUnprocessedThreeStageQaVerdicts()` —— 对每个三段 QA session
  (`chat_thread_role='qa'`)取 `session_events` 中最新 `qa_result` 事件
  (`idx_events_execution` 索引;既有 `SELECT * FROM session_events WHERE execution_id = ?`
  模式 `:1418`),与 session_params 的 `three_stage_verdict.event_id` 比对;
  事件在而 intent 缺/event_id 不同 → 用存储 payload 重放 `onQaResult`(守卫链天然幂等)。
- **(b) FAIL intent 续驱**:`three_stage_verdict.status==='fail' && !fixExecId && !alertedAt`
  → 按 intent 进度续跑:无 `headSha` 且 session 仍 running → 整条 FAIL 分支重走;
  有 `headSha` 未 `closed` → 从 close 续;`closed` 未 `fixExecId` → 从 dispatch 续
  (head 用 intent 持久值 —— worktree 已没了)。每个恢复点 RED 测试:崩在该边界后重启,
  要么续驱成功、要么告警一次。
- **(c) stranded-pass 告警**(849 §3.8 形态):`getStrandedThreeStageQaPassSessions()`
  (`chat_thread_role='qa' AND status='completed'` + TS 层过滤 `three_stage_verdict.status
  ==='pass' && 无真实 review 绑定 && !alertedAt`;**「无真实绑定」= `!review_question_id ||
  review_question_id === REVIEW_BINDING_UNBOUND`** —— `unbound` 哨兵是 qid-less 完成的
  占位、verify-approval 会拒,不能当成功 gate,单独 RED 测,Codex R2 #1)→ `alertLeadPipelineError`
  (「QA 报 PASS 却未开 ship gate 即落终态」)+ intent 记 `alertedAt` 去重。
  **live 路径**同款检查挂 `onPhaseComplete` qa/completed 分支(两 sink 已调用,零新接线);
  正常 ship 后 completed 带 `review_question_id` → 不告警(误报排除)。
- **RED**:三 sweep 各自的窗口用例 + 幂等重跑不重复告警/不重复派发;
  正常路径(verdict 处理完成 / ship 完成)扫描零动作。

### Step 4 — StateStore 新查询

- `countSessionsByIssueAndChatThreadRole(issueId, role): number`(COUNT 查询,免全行反序列化)。
- `getStrandedThreeStageQaPassSessions(): Session[]`(Step 3c;镜像
  `getStrandedDesignPhaseSessions` `:2188` 形态,粗筛 SQL + TS 层解析 params 精筛)。
- `getLatestQaResultEventForExecution(execId): { event_id, payload } | undefined`
  (Step 3a;`session_events` 按 execution_id + event_type='qa_result' 取最新)。
- **RED**:计数只含目标 role;跨 issue 不串;stranded/latest-event 查询形态精确。

### Step 5 — Blueprint isQaPhase prompt sequencing(修 849 实测的死文字问题)

- 替换 `:883-890` 的 4 步为显式 sequencing(参数全给,镜像 auto-QA `:407` 的做法):
  1. 读 branch 上的 design+实现,验证 + 补测试,commit+push 到本 branch(不开第二个 PR)。
  2. **PASS**:`node <comm> qa-result --exec-id <execId> --target-exec <execId> --status pass
     --summary "<tested + verdict>"`,然后**立即执行下方 APPROVE GATE 流(a-g)** ——
     PR 用本 branch 上 Implement 段开的那个(`gh pr view --json number`);
     **你就是本 pipeline 的 ship 执行者**,批准后由你 :cool: ship。
  3. **FAIL**:先把 findings/failing tests commit+push 到本 branch,再
     `qa-result --exec-id <execId> --target-exec <execId> --status fail --summary "<报告>"`,
     然后 STOP 等待关闭 —— pipeline 会起 Implement-fix 重走;**不要** park 等 retest
     (那是 auto-QA 协议)、不要自己 `complete`。
- isImplementPhase:`ctx.phaseFixContext` 存在 → 追加「## QA Fix Round N」段落
  (QA FAIL 摘要 + 「findings/failing tests 已在本 branch,修复后 push,pipeline 自动重跑 QA;
  PR 已存在,勿再 `gh pr create`」)。
- **RED**:isQaPhase prompt 含 qa-result 完整参数 + APPROVE GATE 衔接句 + FAIL STOP 句;
  fix 上下文渲染;无 fix 上下文时 implement prompt 逐字不变;main/design/auto-QA prompt
  逐字不变(既有 101 Blueprint 测继续全绿 = byte-compat 哨兵)。

### Step 6 — phaseFixContext 透传

- `StartRequest.phaseFixContext?: { round: number; qaSummary: string }`
  (Bridge-INTERNAL 注释镜像 `shareParentBranch`;runs-route 显式列字段、不含它 → 外部不可注入,
  负测覆盖)+ `run-dispatcher.start` ctx 透传 + `BlueprintContext.phaseFixContext`。
- **RED**:透传到 Blueprint;`/api/runs/start` body 夹带被忽略(负测)。

### Step 7 — plugin.ts effects 接线

- orchestrator deps 增(**命名对齐 durable intent 模型,Codex R2 #2:全部是
  `three_stage_verdict` 之上的薄 `patchSessionParams`/读 helper**):
  `readVerdictIntent(execId)` / `patchVerdictIntent(execId, patch)` /
  `countImplementPhases(issueId)`(store 闭包)+ `postIssueThread`(复用 autoQa 侧已构建的
  postThread 基建;若实例不可达则最小 ChatThread 发送闭包,失败仅 log)+
  `maxFixRounds`(env 解析)。
- **RED**:接线冒烟(构建期不抛;env 覆盖生效)。

## 测试计划汇总

| # | 文件 | 断言 |
|---|---|---|
| 1 | `event-route` 测试 | 分流三向(三段/auto-QA/缺 holder)+ 幂等 + 互不影响的 try/catch |
| 2 | `phase-orchestrator.test.ts` | PASS 轻分支(intent);FAIL 两阶段 durable(capture→intent→close→start 每边界崩溃可续)+ 4 个 fail-closed 出口;轮上限边界(3 fix 放行/第 4 拦);config OFF;同 eventId 重放 no-op;params 保全 |
| 3 | 同上 | reconcile 三 sweep(unprocessed 重放 / FAIL 续驱 / stranded-pass 告警)+ live 路径 + 去重 + 误报排除 |
| 4 | `StateStore` 测试 | 三新查询 |
| 5 | `Blueprint` 测试 | isQaPhase sequencing;fix-round 渲染;既有 role prompt 逐字不变 |
| 6 | dispatcher 测试 | phaseFixContext 透传 + 外部注入拒绝 |
| 7 | byte-compat 哨兵 | auto-QA onQaResult 全链现状(既有 auto-qa 测试全绿);three_stage OFF 项目零行为变化 |

## 在飞 PR 协调(措辞收敛:同文件、可分 hunk、语义双保 —— 非「零冲突」,Codex R1 #3/#4)

| PR | 交集 | merge-delta 检查单(合并后必须逐项验) |
|---|---|---|
| #441 (FLY-846) | `StateStore.ts`(加性、不同区域);语义零交集(846 gate 全在 `onMainAwaitingReview`,三段 QA role='qa' 第一行即 skip) | qa_result 分流仍在 auto-QA 之前;846 四重 gate 语义不变 |
| #436 (FLY-795) | `Blueprint.ts` / `StateStore.ts` / `run-dispatcher.ts` 同文件不同 hunk;**语义冲突一处(见下)** | resume-mode 仍保 ship-gate;分流/prompt sequencing 未被 resume 注入覆盖;`phaseFixContext` 仍不可从 `/api/runs/start` 注入 |
| #426 (FLY-799) | `event-route.ts` / `DirectEventSink.ts` 同文件(#426 对 793 已有过冲突史);`runPostShipFinalization` 调用面 | 每个 finalization 调用点保住 799 的 markIssueDone 接线;founder-approval 写路径与 QA-as-holder 组合跑通(re-QA 场景 3) |

**#436 的语义冲突(显式化,Codex R1 #3)**:#436 的 `computeProgressResume` 对
`role==='qa'` 一律返 null(假设 qa = auto-QA)。本计划让三段 QA 成为 gate 持有者/
ship 执行者后,**死在 `awaiting_review`/`approved_to_ship` 的三段 QA 不会被 795 resume**。
v1 边界声明:**dead-QA-at-gate 的恢复路径 = FLY-799 的 dead-runner Lead 告警(#426 已含,
re-wake reconciler 对死 runner 告警一次)—— 显式 out-of-scope,不宣称 795 会救**。
协调项(交 Lead / #436 owner):建议 #436 把 qa-skip 判别从 `session_role==='qa'` 收窄为
「auto-QA runner」(`chat_thread_role==='main'` 的 qa,即非三段),让三段 QA phase 可
resume —— 那是 #436 的改动域,本 PR 不代改。本 PR 先 merge 不产生回归(main 上无 795)。

## 风险 / 边界(照 research §5 + R2 修订)

- QA runner 不守 sequencing → 安全网告警(非新风险类别,单段 runner 同款暴露)。
- founder ping 落 🧪QA phase thread —— v1 接受,UX follow-up 另立。
- verdict 传输丢失(qa-result 4 重试全败,事件根本没进 Bridge)→ QA 停 running →
  既有 stuck watchdog 兜底(与 auto-QA 同暴露面);**事件已进 Bridge 后的处理丢失
  已由 Step 2/3 durable intent + 重放收口**。
- 部署:纯代码,Bridge 重启生效(Tier-3 攒批);`pipeline.three_stage` 仍默认 OFF,
  enable 是 batch ship 后的独立 config 动作。

## 交付 / 验收

1. 全套单测绿 + 全仓 lint 绿 + build 绿。
2. PR(含本 doc 文件夹),Codex code review 循环至 APPROVED。
3. Lead 叫 FLY-849 re-QA:组合分支真机重跑三段 → 期望 QA PASS → founder gate 出现在
   thread →(sandbox)approve → QA runner self-ship → finalization —— 849 §3.8 断点消失。
4. HOLD ship 等 Annie(batch 一起)。
