# FLY-1050 三段式 QA 重生 — 调研

Issue: FLY-1050 (https://linear.app/geoforge3d/issue/FLY-1050/infrabug-三段式-qa-session-被杀后流水线搁浅无法干净重生-qareconcile-跳过已有-qa-row)
日期: 2026-07-09
基于: exploration.md

本文是对 `packages/teamlead/src` 的代码审计结果：每个要动/要依赖的机制的现状、行号、判据推演和布线可行性。行号以 branch `flywheel-FLY-1050`（base = main `9c0cde95`）为准。

## 1. 现有机制盘点

### 1.1 boot reconcile 链（bug 所在）

`bridge/phase-orchestrator.ts`：

- `reconcileOnStartup()`（:465）— plugin.ts 布线后一次性调用（plugin.ts:4965），顺序：stranded design 重驱 → `reconcileStrandedImplementHandoffs()`（:505）→ `reconcileQaVerdicts()`（:506）→（then）全表 `reconcileTurnBelt()`（plugin.ts:4972）。
- `reconcileStrandedImplementHandoffs()`（:522）— 候选来自 `listStrandedImplementPhases()` = `StateStore.getStrandedImplementPhaseSessions()`（StateStore.ts:2441，query：`session_role='implement' AND status='awaiting_review' AND chat_thread_role='implement'`）。对每个候选先问 `hasProgressedPastImplement(issue_id)`，true → skip（:538-543），false → `onPhaseComplete(s)` 重驱。
- **`hasProgressedPastImplement(issueId)`（:563-576，本票主修点）**：
  ```ts
  if (this.deps.hasShipFinalizationClaim(issueId)) return true;
  return this.deps.listPhaseSessionRows(issueId, "qa").length > 0;   // ← 任意状态
  // query 失败 → fail-closed 返回 true（不重驱）
  ```
- 对照：`hasProgressedPastDesign(issueId)`（:646-652）用 `getAlivePhaseSession(implement) || getAlivePhaseSession(qa) || shipClaim` — **alive-only**。

### 1.2 handoff 机器（重生要复用的路径）

`onPhaseComplete(session)`（:718）对 implement 的门依次是：

1. `isThreeStagePhaseRole(session_role)`（:720）；
2. `HANDOFF_STATUS.implement === "awaiting_review"` 边界检查（:736-737）；
3. `resolveThreeStage(session).enabled` per-project 政策（:743-752，FLY-902 disabled-warn）；
4. `hasRunnerDrivenReviewEvidence`（:761，review_question_id 已绑且非 unbound sentinel — 967 的 `df802a1c`、1018 的 `80be6c41` 都满足）；
5. `handoff(session, "qa")`（:1277）：`capturePhaseHeadSha(implement)`（worktree rev-parse，= branch B 最新 tip，天然满足 Tadashi ④「最新有效 head」）→ keep-alive ON 时 `probePhaseAlive(implement)` alive → `parkPhaseRunner(implement)`（对已 parked 的 implement 幂等——park 是 CommDB declared-state marker）→ `getAlivePhaseSession(issue,"qa")` 为空 → `ghostGuard(issue,"qa")`（:592，probe 最近 3 条带 tmux_session 的 qa row；terminate 已 kill tmux + 删 CommDB row → probe absent → 放行；若 tmux 清理失败残留活窗口 → fail-closed 拒绝 spawn + 告警，正好保护「terminate 返回 cleanupPending」的情况）→ `dispatchNextPhase(prev, "qa", headSha)`（:1410，`startDispatcher.start({sessionRole:"qa", startPoint:headSha, shareParentBranch:true, ignoreRunnerLabelSelection:true, ...}）`）。
6. 新 QA 的 TURN 由 RunDispatcher pre-launch seam 发放（epoch 自增 = issue 里说的 epoch+1），orchestrator 不代发（:1406-1408 注释）。
7. `onPhaseComplete` 出口自带 `refreshPhaseStatusLine`（:774）——founder 状态线自动刷新。

**结论：重生 = 判据通过后直接调 `onPhaseComplete(implement)`，零新 spawn 逻辑。** 上述 1-4 门在重驱时全部自然成立且各自继续兜底（synthesized row 无 evidence → 门 4 拒绝）。

### 1.3 终态集合的不一致（根因 ③ 的证据）

| 位置 | 认哪些终态 | 后果 |
|---|---|---|
| `phase-orchestrator.ts:169` `TERMINAL_SESSION_STATUS` | completed, failed | `reconcileOneTurn` 对 `terminated` holder 走 probe 路径（CommDB registration 已被 terminate 删掉 → probe absent → 仍能回收，结果对但绕路）；candidates 过滤不排除 terminated（probe absent 跳过，结果对） |
| `checkStrandedPass()`（:1263）| completed, failed | `terminated` + PASS intent 的 QA **不告警**（967 实锤静默） |
| `onPhaseComplete` qa 早退分支（:727-733）| completed, failed | terminate 不走事件流，此分支影响小 |
| `StateStore.getStrandedThreeStageQaPassSessions()`（:2506）| completed, failed | boot sweep (c) 看不见 terminated 的 stranded-pass |
| `getAlivePhaseSession`（plugin.ts:4856）ALIVE 集合 | running, awaiting_review, approved_to_ship, design_done | `terminated` 正确地不算 alive ✓ |
| `getActivePhaseSessionForIssue`（StateStore.ts:2549）| running, awaiting_review, approved_to_ship, design_done (+pending w/ worktree) | `terminated` 正确地不挡 /api/runs/start；967 的 409 来自 implement（行为正确，保持不动）✓ |

### 1.4 QA 死亡时今天都发生什么（触发位点普查）

| 死法 | 入口 | 今天做什么 | 缺什么 |
|---|---|---|---|
| Lead terminate（967 实际路径） | `bridge/actions.ts` `handleTerminate`（:1077，router `case "terminate"` :1352-1398 调用）| FSM `applyTransition → terminated`（fromStates 含 running/awaiting_review/approved_to_ship/…，workflow-fsm.ts:226-236）→ `resolveTerminatedGate`（:1023，解析 parked approve_to_ship gate）→ kill tmux + 删 CommDB session row + 关 viewer → action hook | **不通知 orchestrator**（无 belt reconcile、无 handoff 重驱） |
| runner 崩溃/被杀（1018 路径） | `DirectEventSink.emitFailed`（:871）| status→failed + `reconcileTurnBeltAfterTerminal`（:919，scoped belt）| 无 handoff 重驱 |
| 同上（HTTP 面） | `bridge/event-route.ts` session_failed 成功路径（~:2098 附近 onPhaseComplete sister + belt）| 同上（注：session_failed 的 status='failed' 不匹配任何 HANDOFF_STATUS → onPhaseComplete no-op）| 无 handoff 重驱 |
| 同上但 FSM 拒绝转移（parked awaiting_review 被杀） | event-route.ts:1956-1980 FSM-rejected 分支 | scoped belt only | row 状态停在 alive 集合 = shape 6 僵尸（已知相邻缺口，不动） |
| crash-reaper 收尸 | `bridge/crash-reaper.ts:296` `applyTransition → terminated` | 转移 + 归档 thread | 不通知 orchestrator |

### 1.5 verdict intent 读取

- intent 存 session_params key `three_stage_verdict`（`ThreeStageVerdictIntent`，:92-101），读via `deps.qaVerdicts.readIntent(executionId)`（plugin.ts 布线为 store closure）——**对死 row 同样可读**（纯 session_params 读）。
- 967 `b7b4b54d` intent = `{status:"pass", event_id:"4d39b3fb…", at:"2026-07-08T05:51"}`（无 alertedAt / fixExecId）。
- 1018 两条 qa row 无 `three_stage_verdict` key（takeover 失败，从未发 verdict）。

### 1.6 belt 与重生的交互

- terminate 当下若死 QA 是 TURN holder：新 QA spawn 的 pre-launch grant 直接**覆写** holder（`grantTurn` upsert + epoch 自增）→ 重生成功时无需 belt 手术。
- 重驱失败/被拒（cap）时：belt 仍指死 QA → 现有 scoped/boot `reconcileTurnBelt` 兜底（`terminated` holder 经 probe-absent 判 stale → 回收到 parked implement）。
- **顺序**：scoped 重驱应在 belt reconcile **之前**跑——重生成功后 holder 已是新 QA，belt reconcile 的 guard 1（terminalExecId ≠ holder）自然 no-op，避免每次重生都伴随一条「STALE TURN recovered」告警噪音；重生被拒时 belt reconcile 照常兜底。terminate action 今天完全没有 belt reconcile（1.4 表），本票顺手补上（重驱 → belt 兜底，两步一起加）。

### 1.7 fix-loop 与「FAIL intent 跳过」的安全性推演

- shape 2（QA 死时 implement 正被 wake 修复中）：implement status 仍是 `awaiting_review`（wake 不改 status），**仅凭 status 无法区分「parked 等 verdict」和「mid-fix 干活中」**。区分器 = 最新死 QA 的 intent：mid-fix 必然有 `{status:"fail", fixExecId:…}`。若此时重驱：`capturePhaseHeadSha` 读到半成品 head、`parkPhaseRunner` 把干活中的 implement 打上 park marker（压制 watchdog wake）→ 双重事故。**故 FAIL intent = 一律跳过。**
- 跳过的代价为零：implement 修完会再次 `complete --route needs_review` → 落 `awaiting_review` → live handoff 的 wake-or-spawn 分支发现 QA 非 alive → **spawn 新 QA**（:1395-1400 现成路径）。即 FAIL 场景的 QA 重生本来就有活路，不需要 reconcile 插手。
- shape 3（FAIL flow 中断 / fix 后 spawn 失败）同样被 FAIL intent 跳过：它归 `reconcileQaVerdicts` boot sweep（replay FAIL flow）和 failClosed 告警域。引入第二驱动方会造成 fix-wake 与 respawn 并发写 branch B 的风险。维持现状 = 无回归。

### 1.8 respawn cap 的口径

- cap 计数 = 触发时 `listPhaseSessionRows(issueId,"qa")` 中 status ∈ {completed, failed, terminated} 的条数，≥ 3 → 拒绝 + failClosed。
- 不新增 event type / 不新增持久层：死 row 本身就是天然 ledger（每次重生失败必然多一条死 row）。
- 已知边界：keep-alive OFF 的 legacy fix-loop 每轮关闭 QA 会累积 completed row，理论上可能提前触发 cap → 后果仅是「回到今天的行为 + 告警」，可接受（生产 keep-alive ON；且 cap 只作用于本票新增的重生路径，不影响任何既有路径）。
- 触发 cap 时的 failClosed 告警按现有模式**每次触发都报**（terminate/failed 事件与 boot 都是离散触发，不会刷屏；与其它 failClosed 一致，直到有人处理）。

### 1.9 布线可行性

- **terminate action**：`createActionRouter`（actions.ts:1274）由 plugin.ts:1021/:1447 创建。plugin.ts 侧已有 late-bound holder 先例（`issueDisplayRefresh` 参数，actions.ts:1288-1290）。同法新增可选参数 `phaseOrchestrator?: { current?: PhaseOrchestrator }` + `store`（已有），在 `case "terminate"` 成功分支（terminateResult.success，含 cleanupPending=false 的纯成功；cleanupPending=true 时也触发——FSM 已终态，ghostGuard 会挡住残留活 tmux 的 spawn）后 fire-and-forget 调 scoped 重驱。**注意 plugin.ts 有两处 createActionRouter 调用**（dashboard alias 双挂载，FLY-175 已知），两处都要传。
- **DirectEventSink.emitFailed**：sink 已持有 `phaseOrchestrator` holder（构造参数）；在 `reconcileTurnBeltAfterTerminal`（:919）**之前**插入 scoped 重驱（1.6 顺序）。
- **event-route session_failed 成功路径**：文件内已有 `phaseOrchestrator` holder（:1969 在用）；同法插入。FSM-rejected 分支**不加**（shape 6，row 未终态，alive-check 会挡，加了也是 no-op）。
- **crash-reaper**：`CrashReaperInjectedDeps`（plugin.ts:3436 组装）注入式依赖，可加一个可选 `onPhaseSessionTerminated?(executionId)` 回调（plugin.ts 里闭包到 orchestrator holder）；reaper 在 applyTransition 成功后调用。若实现时发现 reaper 的依赖面收得很紧，降级方案 = 只做前三个位点 + boot reconcile 兜底（reaper 收尸的场景本来就发生在「进程死了很久」，下次 boot 大概率先到）——此取舍留给 plan 定稿。

### 1.10 并发与幂等

- 同进程内可能并发的触发：terminate action（HTTP）× session_failed（HTTP/sink）× boot reconcile。重生成功后 alive QA row 天然挡后续触发；窗口期（dispatch 未落 row）用 orchestrator 实例内 per-issue in-flight `Set<issueId>` 关死（`tryRespawnQa` 进入即 add、finally delete；boot 循环与 scoped 共用同一 helper 即共用同一 Set）。
- dispatcher 侧已有兜底：ghostGuard + `/api/runs/start` 的 409（外部起单不受影响）。
- 跨进程（两个 Bridge）不在生产形态内（单 Bridge），不设计。

## 2. 判据定稿（伪代码）

```ts
// 替换 hasProgressedPastImplement 的语义:"流水线是否已拥有自我推进能力"
private hasProgressedPastImplement(issueId: string): boolean {
  if (this.deps.hasShipFinalizationClaim(issueId)) return true;      // 已 ship
  if (this.deps.getAlivePhaseSession(issueId, "qa")) return true;    // 活 QA 在岗
  try {
    const qaRows = this.deps.listPhaseSessionRows(issueId, "qa");    // 新序在前
    if (qaRows.length === 0) return false;                           // G-A2 原始场景
    const latest = qaRows[0];
    const intent = this.deps.qaVerdicts.readIntent(latest.execution_id);
    return intent?.status === "fail";                                // fix-loop 拥有流水线
  } catch {
    return true;                                                     // fail-closed:不重驱(保留现有语义)
  }
}
```

重驱包装（boot 循环与 scoped 触发共用）：

```ts
// 判据通过后的统一入口;cap + in-flight 都在这里
private async tryRedriveImplementHandoff(impl: PhaseSession): Promise<void> {
  if (this.redriveInFlight.has(impl.issue_id)) return;
  this.redriveInFlight.add(impl.issue_id);
  try {
    const deadQa = this.deps.listPhaseSessionRows(impl.issue_id, "qa")
      .filter(r => DEAD_QA_STATUSES.has(r.status));                  // completed/failed/terminated
    if (deadQa.length >= QA_RESPAWN_MAX) {                           // 3
      await this.failClosed(impl, `three-stage QA respawn cap …`);
      return;
    }
    await this.onPhaseComplete(impl);                                // 复用全部现有门 + handoff
  } finally {
    this.redriveInFlight.delete(impl.issue_id);
  }
}
```

scoped 入口（新公开方法，事件位点调）：

```ts
async reconcileQaLoss(scope: { issueId: string; terminalExecId: string }): Promise<void> {
  // projectName 不需要:onPhaseComplete 从 session row 自解析;belt 兜底由 caller 单独调 reconcileTurnBelt(带 projectName)
  // 死者必须是三段式 qa row(caller 预筛 + 这里 re-check),且判据未 progressed
  // → 找该 issue 的 implement@awaiting_review row → tryRedriveImplementHandoff
}
```

## 3. 回归 fixture（真实生产形态）

| fixture | 来源 | 构造 |
|---|---|---|
| F1 | FLY-967 | implement@awaiting_review（review binding 已绑）+ qa@`terminated`（intent=pass, 无 binding）+ design@design_done + 无 ship claim → 期望:重生 spawn，startPoint=implement worktree HEAD（Tadashi ④），TURN 归新 QA epoch+1 |
| F2 | FLY-1018 | implement@awaiting_review（binding 已绑）+ qa@`failed`×2（均无 intent）→ 期望:重生 spawn（死 row 数 2 < 3）|
| F3 | F2 + 第三条死 qa row | → 期望:拒绝 + failClosed 告警，无 spawn |
| F4 | qa@`failed` + intent=`{fail, fixExecId set}` | → 期望:跳过（无 spawn、无告警）|
| F5 | qa alive（awaiting_review）| → 期望:跳过 |
| F6 | ship claim 存在 | → 期望:跳过 |
| F7 | 非三段式（chat_thread_role='main'）/ 三段式 OFF 项目 | → 期望:全路径零行为变化（byte-compat 哨兵）|

## 4. 风险与开放问题

1. **`onPhaseComplete` 重入 implement 的副作用**：重驱会对已 parked 的 implement 再次 `probePhaseAlive → parkPhaseRunner`。park 是 declared-state marker，幂等（FLY-887 设计如此）；plan 中以单测锁死「re-park 不破坏 park 状态、不发多余 wake」。
2. **terminate 时 tmux 清理失败（cleanupPending）**：重驱照触发，ghostGuard probe 到活窗口 → fail-closed 拒 spawn + 告警——正确行为（绝不双写 branch B），操作员清理后下次触发/boot 自愈。
3. **respawn 的 issue-thread 可见性**：spawn 本身有 status line 刷新（onPhaseComplete 出口）；是否额外发一条「🧪 QA 段已重生」thread note——倾向加（复用 `qaVerdicts.postIssueThread`，与 postFixThread 同模式，best-effort），plan 里定。
4. **`TERMINAL_SESSION_STATUS` 是否补 terminated**：初判「直判 stale 与 probe 路径结果相同」被 Codex design review R1 推翻——terminate 可能以 cleanupPending 返回（FSM 已终态但 tmux 还活着），直判 stale 会在旧 QA 进程仍活着时把 TURN 交回 implement。**结论：belt 的 `TERMINAL_SESSION_STATUS` 保持 {completed, failed} 不动（terminated holder 继续走 liveness probe）；重生判据与 stranded-pass 域另设 `DEAD_QA_STATUSES` = {completed, failed, terminated}。**（详见 plan §Step 1a。）
5. **checkStrandedPass 的存活后继抑制**：加 `getAlivePhaseSession(issue,"qa") 存在 → return`（后继 QA 拥有重验，不算 stranded）。需确认不掩盖真 stranded：后继 QA 自己死了会再次触发本票机制或告警，无静默窗口。
