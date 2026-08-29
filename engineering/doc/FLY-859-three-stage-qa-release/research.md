# FLY-859 三段式 QA 收尾 — 调研

Issue: FLY-859 (https://linear.app/geoforge3d/issue/FLY-859/batch-gap三段式-qa-pass-放行-foundership-未实现deferred)
日期: 2026-07-04
基于: exploration.md

> Lead brainstorm gate 已批准方案 A(QA phase = gate 持有者 + ship 执行者)。本文回答
> 两个 watch-point + 落实现细节所需的全部代码事实。

## 1. Watch-point ①:与 FLY-846(#441)的协调 — 无冲突

逐 hunk 核对 `gh pr diff 441`:

- **#441 改动面** = `auto-qa-coordinator.ts` 内部(`onMainAwaitingReview` 加 gate ⓪-③ +
  新私有方法 `isQaIssueSession`/`collectForeignActiveQa`)+ `StateStore.ts`(qa_issue 列
  查询)+ 测试。**不碰 `onQaResult`、不碰 `event-route.ts`、不碰 `phase-orchestrator.ts`**。
- **FLY-859 改动面** = `event-route.ts` 的 `qa_result` 分支(路由分流)+
  `phase-orchestrator.ts`(新 `onQaResult`)+ `Blueprint.ts`(isQaPhase prompt)+
  `plugin.ts`(effects 接线)+ StateStore 少量新查询。**不碰 `auto-qa-coordinator.ts`**。
- **文件交集**:仅 `StateStore.ts`(两边都是加性新方法,不同区域)→ git 3-way 自动合并,
  任一 merge order 均可。
- **语义交集**:零。三段 QA session `session_role='qa'` 在 846 gate ⓪ 的第一行
  (`role !== 'main' → return`,846 前后行为一致)就被 skip;846 的四重 gate 全部作用于
  auto-QA spawn 路径,859 的分流发生在 `onQaResult` **上游**(event-route),彼此不可见。
- 三段 QA session 落 `awaiting_review` 时(方案 A 新行为):`onMainAwaitingReview` 的
  role-main guard(`event-route.ts:1834` + coordinator 内部)→ 不会被 auto-QA 二次抓取。
  846 合入后同样(gate ⓪ 重读行仍是 role='qa')。

## 2. Watch-point ②:plan Step 8「PASS 后关闭 QA」的调和(供 Codex design review 明确确认)

FLY-793 plan Step 8 原文:「QA PASS → push + 关闭 QA → 放行 founder/ship」。它没有回答
关闭之后谁持 `awaiting_review`、谁执行 ship —— FLY-859 issue 点名这是 deferred coordinator
的未决设计域。方案 A 的调和:

- **「放行 founder/ship」提前、「关闭 QA」推迟**:PASS 后 QA runner 活着走标准 APPROVE GATE
  流(它成为 gate 持有者),ship 完成后由**既有** `runPostShipFinalization` 关闭它
  (该函数本来就负责 feature runner 的 tmux + worktree + thread archive 收尾)。
- **Model A 语义全保**:全顺序 writer(PASS 后 B 不再有第二个 writer —— QA 是唯一活 session,
  持 gate 等批准不写码)、无 parked runner 挡 B(FAIL 路径 QA 仍立即关闭释放 B)、
  restart-safe(awaiting_review + 已 push 的 B + review 绑定全部持久化;Bridge 重启后
  gate-poller/799 re-wake 既有机制接管)。
- **反面**(为什么不能字面执行「PASS 即关」):关了就没有活 runner 执行 ship ——
  FLY-799(#426)是「runner self-ships」模型,其 re-wake reconciler 对 dead runner 只告警
  不代 ship;Bridge 代 ship = 新授权面,与 799「write authority unchanged」抵触。
- **真机证据**:FLY-849 §3.5 手动模拟正是「QA session 持 awaiting_review → gate →
  approved_to_ship → finalization」,全链 PASS。

## 3. 实现所需代码事实(全部现场核对)

### 3.1 路由点:`event-route.ts:625`

`qa_result` 分支在 `insertEvent` 幂等去重**之后**(`:616` duplicate 早退)→ 分流只见新
event。`store` 与 `phaseOrchestrator` holder 均已在 router builder 作用域(`:561`)。
`qa-result` CLI 恒 POST `${bridgeUrl}/events`(`qa-result.ts:141`)→ HTTP 是唯一 surface,
DirectEventSink 不经手 `qa_result`(grep 证实)。

### 3.2 三段 QA phase 的持久判别

`sessions.chat_thread_role`(`StateStore.ts:831`,NOT NULL DEFAULT 'main';迁移 `:1065`)
在 Blueprint 唯一知道 `shareParentBranch` 的地方计算一次(`Blueprint.ts:589`):
`ctx.shareParentBranch && ctx.sessionRole ? ctx.sessionRole : "main"`。
→ 判别式 `session_role==='qa' && chat_thread_role==='qa'` 唯一命中三段 QA phase;
auto-QA runner(独立 QA·issue,无 shareParentBranch)恒 'main'。

### 3.3 PhaseOrchestrator 现状与扩展点

- deps 已有:`startDispatcher.start`(StartRequest 子集)、`capturePhaseHeadSha`、
  `closePhaseRunner`(dirty-safe,fail-closed throw)、`alertLeadPipelineError`、
  `resolveThreeStage`、`listStrandedDesignPhases`(`phase-orchestrator.ts:48-83`);
  plugin.ts:3724 全部真实接线,`phaseWorktreeCleanup` 已含 branch-B 释放证明(R2 #2)。
- `onPhaseComplete` 对 qa role 现状 `nextPhase(qa)=null → return`(`:147`)—— 安全网
  检查(§3.7)可挂在这里,两 sink 调用点(`event-route.ts:1853` / `DirectEventSink.ts:645`)
  零新接线。
- `HANDOFF_STATUS` 只含 design/implement —— qa 的 FAIL 交接走新 `onQaResult`,不进
  `HANDOFF_STATUS`(qa→implement 不是 status 驱动而是 verdict 驱动)。

### 3.4 fix-loop 再派发可行性

- **dedup 不拦**:`run-dispatcher.ts:611` inflight map 是 dispatch 期 in-process key
  (`issueId:role`),`blueprint.run()` promise settle(spawn 完成)即 `finally` 删除
  (`:734`)。tmux runner detach 后长期运行不占 key → 第二个 implement(fix round)可派。
- **worktree**:QA 关闭释放 B(closePhaseRunner 已证明移除)→ `git worktree add -B <branch>
  <startPoint=B head>` 重建(849 §3.3/3.4 真机证实此机制,含 795 resume 同款)。
- **闭环零新码**:fix implement 完成 `needs_review → awaiting_review` 时,既有
  `onPhaseComplete`(`HANDOFF_STATUS.implement`)自动再起新 QA phase。
- **轮数统计**:`getSessionHistory(issueId)`(`StateStore.ts:2409`,by started_at)过滤
  `chat_thread_role==='implement'` 计数;或专用 COUNT 查询(实现取后者,免全行反序列化)。

### 3.5 StartRequest / BlueprintContext 扩展(fix 上下文)

- `isQaRunner = !!ctx.qaContext`(`Blueprint.ts:821`)→ **不能**借 `qaContext` 传递任何
  东西给 implement/qa phase(会翻转成 auto-QA prompt)。
- 新增独立可选字段 `phaseFixContext?: { round: number; qaSummary: string }`:
  `StartRequest`(retry-dispatcher.ts,Bridge-INTERNAL,`/api/runs/start` 不读 ——
  镜像 `shareParentBranch` 的安全注释与负测)→ `run-dispatcher.start` ctx 透传(`:679`
  区域)→ `BlueprintContext` → isImplementPhase prompt 附加 fix-round 段落。
- #436(795)不碰 retry-dispatcher.ts;#441 不碰这三个文件 → 加性无冲突。

### 3.6 QA phase 的 PASS 路径依赖(全部既有)

- APPROVE GATE block 对 isQaPhase **已注入**(`Blueprint.ts:1244`,skip 名单只有
  isQaRunner `:1175`)→ prompt 只需把 role 步骤 sequencing 到该 block,不新增 gate 文本。
- `complete --route needs_review` 需 `--pr <N>`(`complete.ts:29`)+ questionId 绑定
  (Bridge fail-close,`:181`)→ QA runner 从 B 上开着的 PR 取号(`gh pr view --json number`)。
- prHeadSha:complete 自动取 QA worktree HEAD(= B tip 含 QA commits = PR head,QA 已 push)
  → verify-approval 绑定自洽。
- gate relay:GatePoller 对 awaiting_review session 的 approve_to_ship 问题走既有 founder
  通知(FLY-605 → issue thread;三段 = 🧪QA phase thread,Step 11 侧表语义)。
- 无 AutoQaRecord → `isQaHeld` false → 通知不被 auto-QA held 抑制(FLY-579「不绿不扰」由
  「gate 在 PASS 后才开」结构性保证)。

### 3.7 安全网(849 静默断裂形态的告警)

- **形态**:三段 QA session 落 terminal `completed` 且带 pass 标记且无 review 绑定
  (`review_question_id` NULL)= QA 报了 pass 却没走 approve-gate 流(849 §3.8 实录)。
- **标记**:`setSessionParams(execId, { three_stage_qa_pass_at })`(`StateStore.ts:2634`,
  session_params 列既有,FLY-208 evidence-gap 同款用法)。
- **live 路径**:`onPhaseComplete` qa 分支(两 sink 已调用)。
- **startup 路径**:镜像 `getStrandedDesignPhaseSessions`(`StateStore.ts:2188`)加
  stranded-pass 查询,挂进 `reconcileOnStartup`;告警一次后写 alerted 标记去重
  (leadAlertNotifier 的 eventId 现含 Date.now(),无自带去重)。
- **误报排除**:正常 ship 后 completed 的 QA session 带 review_question_id → 不告警;
  死在 running 的 QA → 既有 stuck watchdog 兜底,不归本安全网。

### 3.8 `--target-exec` 约定

三段 QA prompt 显式传**自己的 exec id**(coordinator 按 `event.execution_id` 键定,
targetExecutionId 仅审计记录)。不动 `qa-result` CLI 契约(`--target-exec` 保持必填,
auto-QA 语义不变)。备选「注入 implement exec id」被否:需要新 plumbing 字段,且 795
resume 重派 QA phase 时 parent exec 不可知,自 id 约定在两种起法下都成立。

### 3.9 mid-flight config 关闭语义

- PASS 分支:按 session 持久标记处理(标记+日志),不查 live config —— 决不静默丢 verdict。
- FAIL 分支:再派发前查 `resolveThreeStage`;OFF → 不派新 phase,fail-closed 告警 Lead
  (「three-stage 已关,QA FAIL 不自动循环」)—— 与 PhaseOrchestrator handoff 的 live
  config 检查一致,且不在 OFF 状态下新造 phase session。

## 4. 与在飞 PR 的 merge-order 结论

| PR | 文件交集 | 结论 |
|---|---|---|
| #441 (FLY-846) | StateStore.ts(均加性、不同区域) | 任意顺序,自动合并 |
| #436 (FLY-795) | Blueprint.ts / StateStore.ts / run-dispatcher.ts(不同 hunk 区域) | 任意顺序;资 resume 语义正交(fix implement 是全新 dispatch,progress.md 若在 B 上存在则 795 的 resume 增强它,不冲突) |
| #426 (FLY-799) | 零交集 | 任意顺序;方案 A 正是 799 self-ship 模型的三段实例 |

## 5. 风险清单

1. **QA runner 不守 prompt sequencing**(报 pass 后不开 gate)→ 安全网告警(§3.7),
   与单段 runner 不守 APPROVE GATE 同类风险,非新增类别。
2. **founder ping 落 QA phase thread** —— v1 接受(Lead 知悉);若 Annie 要求落 main
   thread,是 gate relay thread 解析的独立 follow-up。
3. **fix-loop 上限拍 3**(env `FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS` 可调)超限 fail-closed
   告警 —— Lead 已认可。
4. **qa-result 4 次重试全败**(verdict 丢失)→ QA 停 running → 既有 stuck watchdog 兜底
   (auto-QA 同等暴露面,不新建 marker replay)。
