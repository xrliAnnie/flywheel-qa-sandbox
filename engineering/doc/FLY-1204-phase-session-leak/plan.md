# FLY-1204 三段式 phase session 泄漏 — 实施计划

Issue: FLY-1204 (https://linear.app/geoforge3d/issue/FLY-1204/bug-三段式-designqa-阶段-session-交接后不被收掉-内存泄漏累积-oomclose-runner-也拒关-design)
日期: 2026-07-12
基于: exploration.md, research.md
Status: **codex-approved**（Codex design review 3 轮 APPROVED — R1 5 项(3 BLOCKER+2 MAJOR)+ R2 4 项(2 BLOCKER+2 MAJOR)全部采纳;5 条非阻塞实现提醒见文末 §Implement Notes）

> 目标:三段式 keep-alive 的 parked/终态 phase 段在 ship 或 pipeline 终结后被回收,不无限累积 → OOM。**不动** FLY-887 交接期 PARK 语义;守卫硬到**绝不误杀健康 parked holder**(Tadashi brainstorm 决策 + Codex R1 BLOCKER-1)。

---

## 0. 改动总览

| # | 缺口/诉求 | 文件 | 核心改动 |
|---|-----------|------|---------|
| A | ship finalize 漏 qa + 漏 external-merge 路径(诉求1) | `post-ship-finalization.ts` + `external-merge-reconcile.ts` + `plugin.ts` | finalize filter 加 `qa`+`completed`;`finalizeThreeStagePhases` seam 接入 external-merge `finalize()` |
| B | 兜底候选漏 design_done(诉求3) | `StateStore.ts` | 新增 `getParkedPhaseCandidates()`(候选预筛,真 parked 判定在 C) |
| C | 兜底守卫 + closeStale 关 design_done(诉求3) | `HeartbeatService.ts` + `StateStore.ts` + `plugin.ts` | issue-grouped verdict 引擎:**ship-claim 路径**自动回收全部真-parked/terminal(pipeline 已终结,安全);**no-claim 路径**只自动回收 `completed` 终态段,非终态 parked 段**只告警**(诚实 TOCTOU 边界);TURN stale-aware(仅 in-flight spawn defer)/ declared_state='parked' 验证 / lookupTmuxTarget error→defer / 双 probe 预算 / 独立节流 + 全局重入 guard / **不 archive** / 告警一次 + 单列阈值 + kill-switch |
| D | close_runner 关 design_done(诉求2) | `terminal-mcp/src/lifecycle.ts` + `index.ts` | `DONE_STATUS_SET` 加 `design_done` + tool 描述文档化(Codex R1 认可,不变) |

全部 byte-compat:仅三段式 keep-alive 路径生效;keep-alive OFF / 非 phase session 不受影响。

---

## Change A — ship finalize 主动回收 qa 段 + 覆盖 external-merge 主路径

### A1. finalize filter 加 qa + completed(`post-ship-finalization.ts`, `makeFinalizeThreeStagePhases` 现 L207-269)
```ts
const RECLAIMABLE_PHASE_STATUSES = new Set([
  ...FINALIZE_DONE_SOURCE_STATES,   // running/awaiting_review/approved_to_ship/design_done
  "completed",                      // FLY-1204: qa 段 ship 后终态
]);
const phases = store.getPhaseSessionsForIssue(issueId).filter(
  (s) =>
    (s.chat_thread_role === "design" ||
     s.chat_thread_role === "implement" ||
     s.chat_thread_role === "qa") &&            // FLY-1204: 加 qa
    RECLAIMABLE_PHASE_STATUSES.has(s.status),    // FLY-1204: 加 completed
);
```
`closeRunner({ finalizeDone: true, transitionOpts })` 不变:design_done→FINALIZE_DONE transition;completed→finalizeDone 分支不触发(FINALIZE_DONE_SOURCE_STATES 不含 completed)→ 落 AUTO_CLOSE。**幂等**:target=null → alreadyGone(Codex R1 确认)。`makeFinalizeThreeStagePhases` 不传 `archive`,A 本身不触发 close→archive cascade(Codex R1 确认)。

### A2. external-merge 也执行 finalize(Codex R1 BLOCKER-2)
`external-merge-reconcile.ts` 的 `finalize()`(L234)调 `runPostShipFinalization` 时**没传** `finalizeThreeStagePhases` seam,导致 external merge 写了 `post_ship_finalization_claim` 却不关 phase 段,只能等 C 的 patrol。修:
- `ExternalMergeReconcileDeps`(L115)加 `finalizeThreeStagePhases?: (issueId, projectName) => Promise<void>`(可选,byte-compat)。
- `finalize()` 的 `runPostShipFinalization({..., finalizeThreeStagePhases: deps.finalizeThreeStagePhases})`。
- plugin composition root(external-merge wiring, ~L4466-4501)注入**同一个** `makeFinalizeThreeStagePhases(...)`(与 DirectEventSink/event-route 共用,`run-infra.ts:678` 已构造)。
- 与 `removeCleanWorktree`/顺序一致:finalize 在 worktree 删除前(`runPostShipFinalization` 内部保证)。

---

## Change B — 兜底候选预筛(不碰 FLY-867 通用 stale)

`StateStore.ts` 新增(不改 `getStaleCompletedSessions`,保 FLY-867):
```ts
/**
 * FLY-1204: 三段式 phase 段兜底回收的 *候选预筛*(仅 status 层)。
 * 真"parked"由 HeartbeatService 用 CommDB declared_state 二次验证(Codex R1 BLOCKER-1:
 * status 不等于 parked;keep-alive OFF 下 handoff 仍产生 phase rows)。故这里只做粗筛,
 * 缩小要二次验证的集合,不作回收判据。
 */
getParkedPhaseCandidates(): Session[] {
  // chat_thread_role IN ('design','implement','qa')
  //   AND status IN ('design_done','completed','awaiting_review','approved_to_ship','running')
  // running 纳入候选:FAIL fix-loop 的 QA park 时 status 仍可能 running(Codex R1),
  //   由 C 的 declared_state='parked' 验证区分"parked running" vs "working running"。
}
```
复用现有 `getPhaseSessionsForIssue(issueId)`(L2857)、`countEventsByIssueAndType(issueId,type)`(L2888) —— 无需新查询。

---

## Change C — 兜底 patrol:issue-grouped verdict 引擎(R2 重写,Codex R1+R2 全部反馈)

### C0. 设计原则
- **绝不误杀健康 holder**:issue 里只要有任一 phase 段"真正在工作"(非终态 + declared_state≠parked + probe alive),整个 issue keep。
- **诚实的安全边界(R2 BLOCKER-2)**:patrol 与 PhaseOrchestrator 不共享跨生命周期互斥(不扩 handoff coordination —— 超 scope),所以 probe→close 存在 TOCTOU。因此**自动 kill 只用于两种 TOCTOU 无害的情形**:
  - **(i) ship-claim 路径**:issue 已有 `post_ship_finalization_claim` → pipeline 已终结,不会再 spawn working phase → 回收其全部真-parked/terminal 候选安全。**这是自动化主力**(覆盖 1062/1188/1189 等已 ship 僵尸的 design_done + completed qa)。
  - **(ii) no-claim + `completed` 终态段**:completed 是终态,不会变回 working,回收它 TOCTOU 无害(qa 段 ship-executor 完成后残留)。
  - **no-claim 的非终态 parked 段(design_done/awaiting_review/approved_to_ship/running)→ 只告警,不自动 kill**:无法诚实证明"绝不误杀"(verdict→close 间 PhaseOrchestrator 可能 wake/spawn 让它重新成为健康 holder)。运维用 `close_runner --done`(Change D 已让 design_done 可关)一键处理。FLY-545 类 no-claim design_done 孤立即走此告警路径。
- **TURN 只用于 in-flight spawn 检测(R2 BLOCKER-1)**:TURN 是无 TTL 的覆盖式 ownership pointer,正常只在 ship finalizer 尾部 `deleteTurn`,park 不释放 —— 所以"TURN 存在"**不等于** pipeline 活跃(stale TURN 会永久 defer 掉 no-claim 僵尸,正是 FLY-1204 要治的)。复用 `TURN_GRANT_GRACE_MS`(phase-orchestrator.ts:168,export 共享保持同源):**只有 holder session row 缺失 且 `now - granted_at < TURN_GRANT_GRACE_MS`(5min)→ in-flight spawn → defer**;holder row 存在(parked/terminal/dead)→ 不因 TURN 永久 keep,交给 working 判定 + grace。
- **read error / indeterminate 一律 defer**(fail-closed,`lookupTmuxTarget` 区分 error/gone/found,不用折叠的 `getTmuxTargetFromCommDb`)。
- **两类 probe 预算分离(R2 MAJOR-4)**:working-safety probe 用**每 role 最新 `GHOST_PROBE_MAX_ROWS`(3) 条**(复用 ghost-guard 思路,防"最新 terminal + 次新 alive non-parked"漏判),整 issue ≤9;cleanup probe(close 前 revalidate)对 autoReclaim 候选逐个,每 sweep 设总 cap。
- **独立节流(R2 MAJOR-3d/e)**:**不合并** checkStaleCompleted(保 FLY-867 public + byte-compat,现有 20+ 测试直接调它)。新 `checkStaleParkedPhases` 自带独立 gate(`lastParkedCheckAt`)+ **全局 `parkedSweepInFlight` boolean**(防长 sweep 被下个 tick 重入)+ per-issue guard。

### C1. 阈值 env(`plugin.ts`,紧邻 L3794)
```ts
const parkedPhaseStaleHours = (() => {
  const v = parseInt(process.env.FLYWHEEL_PARKED_PHASE_STALE_HOURS ?? "24", 10);
  return Number.isFinite(v) && v >= 1 ? v : 24;   // 决策②:保守偏长,纯安全网
})();
```

### C2. 独立 parked patrol(`HeartbeatService.ts`,不动 checkStaleCompleted)
```ts
private lastParkedCheckAt = 0;
private parkedSweepRunning = false;                     // R2 MAJOR-3e:全局防重入
private readonly parkedIssueInFlight = new Set<string>();

async checkStaleParkedPhases(): Promise<void> {
  if (!this.staleParkedClose || !this.staleCloseEnabled()) return;   // 复用 FLY-867 kill-switch
  if (this.parkedSweepRunning) return;                                // 全局:上个 sweep 未完
  if (Date.now() - this.lastParkedCheckAt < this.staleCheckIntervalMs) return;
  this.parkedSweepRunning = true;
  try {
    const byIssue = groupBy(this.store.getParkedPhaseCandidates(), (s) => s.issue_id);
    for (const [issueId, group] of byIssue) {
      if (this.parkedIssueInFlight.has(issueId)) continue;
      this.parkedIssueInFlight.add(issueId);
      try {
        const v = await this.computeIssueReclaimVerdict(issueId, group);
        for (const s of v.autoReclaim) {
          const live = await this.phaseProcessStillAlive(s);   // R2 MAJOR-3a:三态
          if (live !== "alive") continue;                       // dead/defer 都不 close
          await this.staleParkedClose.closeParked(s, { noClaim: v.noClaim });
        }
        if (v.alertOnly.length > 0) await this.alertOrphanParkedOnce(issueId, v.alertOnly);
      } catch (err) { /* warn,best-effort */ }
      finally { this.parkedIssueInFlight.delete(issueId); }
    }
  } finally { this.parkedSweepRunning = false; this.lastParkedCheckAt = Date.now(); }
}
```
调用点:HeartbeatService 周期 tick 里,与现有 `checkStaleCompleted()` **并列**新增一行 `await this.checkStaleParkedPhases()`(各自独立节流)。

### C3. verdict 引擎(核心守卫,R2 重写)
```ts
type ReclaimVerdict = { autoReclaim: Session[]; alertOnly: Session[]; noClaim: boolean };

private async computeIssueReclaimVerdict(
  issueId: string, group: Session[],
): Promise<ReclaimVerdict> {
  const hasClaim =
    this.store.countEventsByIssueAndType(issueId, "post_ship_finalization_claim") > 0;

  // (1) ship claim → pipeline 已终结,不会再 spawn → 自动回收全部真-parked/terminal(TOCTOU 无害)
  if (hasClaim) {
    const autoReclaim: Session[] = [];
    for (const s of group)
      if ((await this.isReclaimableParkedOrTerminal(s)) === "yes") autoReclaim.push(s);
    return { autoReclaim, alertOnly: [], noClaim: false };
  }

  // (2) no claim → 先判整 issue 是否还在工作/spawn 中
  const working = await this.classifyIssueWorking(issueId);  // has_working|in_flight|defer|clean
  if (working !== "clean") return { autoReclaim: [], alertOnly: [], noClaim: true };  // keep/defer

  // (3) pipeline 静止 + no claim → 超 grace 的候选:completed 自动收,非终态 parked 只告警
  const autoReclaim: Session[] = [], alertOnly: Session[] = [];
  for (const s of group) {
    if ((await this.isReclaimableParkedOrTerminal(s)) !== "yes") continue;
    if (!this.isBeyondParkedStale(s)) continue;              // 时间安全网(决策②)
    if (s.status === "completed") autoReclaim.push(s);        // terminal,TOCTOU 无害
    else alertOnly.push(s);                                   // 非终态 parked → 告警,交运维 close_runner --done
  }
  return { autoReclaim, alertOnly, noClaim: true };
}

/** 整 issue 是否有 working phase / 正在 spawn。bounded ≤9 probe(每 role 最新 GHOST_PROBE_MAX_ROWS)。 */
private async classifyIssueWorking(
  issueId: string,
): Promise<"has_working" | "in_flight" | "defer" | "clean"> {
  const rows = pickLatestNPerRole(
    this.store.getPhaseSessionsForIssue(issueId), GHOST_PROBE_MAX_ROWS);  // ≤3/role,≤9 total
  for (const p of rows) {
    if (TERMINAL_PHASE_STATUSES.has(p.status)) continue;
    const parked = await this.declaredStateIsParked(p);      // yes|no|defer
    if (parked === "defer") return "defer";
    if (parked === "yes") continue;                           // parked → 不 working
    const live = await this.probePhase(p);                    // alive|dead|defer
    if (live === "alive") return "has_working";
    if (live === "defer") return "defer";
  }
  // 无 working phase → 是否有 in-flight spawn(TURN holder row 缺失 + grace 内)
  const turn = this.classifyTurn(issueId);                    // none|in_flight|stale|defer
  if (turn === "defer") return "defer";
  if (turn === "in_flight") return "in_flight";
  return "clean";                                             // stale/none TURN 都不永久挡
}
```
辅助:
- `classifyTurn(issueId)`:开 project CommDB → `getTurn(issueId)`(read error→`defer`;无→`none`);有 → `getSessionForTurnHolder(holder_exec_id)`:holder row 缺失 且 `now - granted_at < TURN_GRANT_GRACE_MS`→`in_flight`;否则(holder 存在或 grace 过)→`stale`(不挡回收;必要时 closeParked 后由 `reconcileTurnBelt` 清)。
- `isReclaimableParkedOrTerminal(s)`:`completed`(terminal)→`"yes"`;`design_done/awaiting_review/approved_to_ship/running`→ `declaredStateIsParked(s)`(`yes`/`defer`/`no`)。
- `declaredStateIsParked(s)`:开 project CommDB → `getEffectiveDeclaredState(s.execution_id, Date.now())`(**R2 MAJOR-3b:签名带 nowMs**,`db.ts:755`,readonly-tolerant),`kind==='parked'`→`yes`;read 抛错→`defer`;否则`no`。
- `probePhase(s)` / `phaseProcessStillAlive(s)`:用 `lookupTmuxTarget(execId, project)`(三态)→ `error`→`defer`;`gone`→`dead`;`found`→`probeRunnerProcessLiveness`(alive→`alive`;dead_pin/absent→`dead`;indeterminate→`defer`)。返回 `"alive"|"dead"|"defer"`。**不用** `getTmuxTargetFromCommDb`(折叠 error+gone)。
- `TERMINAL_PHASE_STATUSES` = `{completed, failed, terminated, rejected, deferred, shelved}`。
- `pickLatestNPerRole(rows, N)`:按 chat_thread_role 分组各取最新 N 条(`getPhaseSessionsForIssue` 已 `last_activity DESC, rowid DESC`)。

### C4. constructor 尾部单一 optional config(R1 MAJOR-4,不动现有 positional 参数)
```ts
staleParkedClose?: {
  parkedStaleHours: number;
  commDbPathForProject: (project: string) => string;
  closeParked: (s: Session, o: { noClaim: boolean }) => Promise<{ closed: boolean; alreadyGone?: boolean }>;
  alertOrphan: (issueId: string, sessions: Session[]) => Promise<void>;  // R2 MAJOR-3c:注入 alert
}
```
未 wire → parked patrol inert(byte-compat)。`alertOrphanParkedOnce` 包 `alertOrphan` + per-issue durable dedupe(复用 `quiet_wake_notified` 式一次性记账,R2 MAJOR-3c:告警一次,非每 session 各一次)。

### C5. closeParked + alertOrphan 闭包(`plugin.ts`,紧邻 closeStale L3927)
```ts
closeParked: async (session, { noClaim }) => {
  const r = await closeRunner({
    executionId: session.execution_id, issueId: session.issue_id,
    projectName: session.project_name ?? "",
    reason: noClaim ? "fly1204_orphan_completed_reclaim" : "fly1204_shipped_parked_reclaim",
    finalizeDone: true, transitionOpts,
    // NO archive(R1 BLOCKER-3):孤立回收只释放进程;已 ship 的 thread teardown 由 runPostShipFinalization 负责。
  }, store);
  return { closed: r.closed, alreadyGone: r.alreadyGone };
},
alertOrphan: async (issueId, sessions) => {
  // 复用已 routed 的 lead alert sink(与 FLY-867 stale 告警同源),issue-level,一次。
  await alertSink({ issueId, reason:
    `FLY-1204:issue ${issueId} 有 ${sessions.length} 个孤立 parked phase 段(无 ship claim,pipeline 疑似崩溃/未 ship):` +
    sessions.map((s) => `${s.chat_thread_role}/${s.execution_id}`).join(", ") +
    ` —— 未自动回收(诚实安全:非终态 parked 无法证明 TOCTOU 安全)。请人工 close_runner --done 或确认 pipeline。` });
},
```

---

## Change D — close_runner 补 DONE_STATUS_SET 漂移 + 文档化(Codex R1 认可,不变)

`terminal-mcp/src/lifecycle.ts` L101-105:
```ts
export const DONE_STATUS_SET = [
  "running", "awaiting_review", "approved_to_ship",
  "design_done",   // FLY-1204: 与 Bridge FINALIZE_DONE_SOURCE_STATES(close-runner.ts:68-78)对齐
] as const;
```
`index.ts` close_runner tool done 说明加:三段式 design 段(`design_done`,parked 等 ship)也用 `done=true` 关。`completed` 普通 close 已能关(补回归断言,不改逻辑)。**保留** `>1` disambiguation guard(index.ts:553-620):同 issue 多个 done-mode candidate 时仍 fail-closed 要求 `execution_id`。

---

## 测试计划(TDD,含 Codex R1 MAJOR-5 安全反例)

**Change A** — `post-ship-finalization.fly887.test.ts`(扩)+ external-merge 集成测试:
- qa `completed` 残留 → finalize 关它;qa 已关(target=null)→ 幂等 alreadyGone。
- design+implement+qa 三段 → 各关一次。
- **external-merge eligible path → 立即调 finalizeThreeStagePhases**(qa/design/implement 都在 worktree cleanup 前关)。

**Change B** — StateStore DB 测试:
- `getParkedPhaseCandidates()` 返回 design_done / completed-qa / awaiting_review-implement / running-qa;不返回非 phase(chat_thread_role=main)。

**Change C** — HeartbeatService 单测(安全反例为主):
- **keep-alive OFF + QA awaiting_review/approved_to_ship**:declared_state 非 parked → 不 close;非 phase main row 不受影响。← 硬边界
- **running QA + declared parked**(FAIL fix-loop):识别为 parked 候选;**running 但未 parked**(真在工作,probe alive)→ has_working → keep 全 issue。← 硬边界
- **has_working 保护**:`design_done(parked) + implement(non-parked,alive)` 无 claim → has_working → keep 全部(含 parked design)。← 决策① 核心
- **ship claim 路径**:claim 存在 → 自动回收全部真-parked/terminal 候选(design_done + completed qa),即便有 alive row 也回收(pipeline 已终结)。
- **no-claim 收窄(R2 BLOCKER-2)**:pipeline 静止 + no claim + 超 grace → `completed` 段自动回收;`design_done`/awaiting_review 段**只进 alertOnly 不 close**(mock 断言 closeParked 未被这些 session 调用)。
- **TURN stale-aware(R2 BLOCKER-1)**:① `completed QA holder + no claim + stale TURN`(holder row 存在/terminal)→ 不永久 defer,最终回收 completed;② `parked design holder + stale TURN` → design 进 alertOnly;③ `fresh pre-launch TURN`(holder row 缺失 + <5min)→ in_flight → defer 整 issue(保护 handoff spawn 窗口)。
- **TOCTOU(R2 BLOCKER-2)**:verdict 返回后、close 前注入"新 phase 完成 TURN grant + registration + alive" → 该 issue 下轮 classifyIssueWorking=has_working;断言 completed 自动回收路径不误伤新健康 holder(completed close 与新 holder 无关);并验证 patrol 不与正常 handoff 死锁。
- **双 probe 预算(R2 MAJOR-4)**:`同 role 最新 terminal + 次新 non-parked alive` → working-safety probe(每 role 最新 3 条)命中次新 alive → has_working → keep(不因只看最新 terminal 而漏 working)。
- **CommDB lookup error vs gone**:declared_state read error → defer;lookupTmuxTarget `error`→defer、`gone`→dead —— 分开(不折叠)。
- **helper 三态(R2 MAJOR-3a)**:`phaseProcessStillAlive` 返回 `dead`/`defer` 时**不** close(断言 `!== "alive"` skip)。
- **告警一次(R2 MAJOR-3c)**:同一 issue 多个 alertOnly session → alertOrphan 只调一次;跨 sweep durable dedupe(不重复刷)。
- **全局重入 guard(R2 MAJOR-3e)**:长 sweep 未完时下个 tick 调 checkStaleParkedPhases → `parkedSweepRunning` 短路,不重入。
- **独立节流(R2 MAJOR-3d)**:checkStaleCompleted 保持原样可直接调(现有 20+ 测试不破);checkStaleParkedPhases 自带独立 `lastParkedCheckAt` gate。
- **kill-switch** `FLYWHEEL_STALE_TERMINAL_CLOSE=0` → parked patrol no-op。
- **closeParked 对 design_done 传 finalizeDone:true**;**不传 archive**(mock 断言 maybeArchiveThreadOnClose / archive 未被调用)。

**Change D** — terminal-mcp 单测:
- `DONE_STATUS_SET` 含 design_done;done-mode issue lookup 能解析单一 design_done 段;同 issue 多 done-mode candidate → 仍 fail-closed 要求 execution_id。
- completed 普通 close 成功(回归)。

**全仓**:相关包 `pnpm test` + `pnpm -w lint`。

---

## 实施顺序

1. D(最独立)→ 2. A1+A2(finalize + external-merge seam)→ 3. B(候选查询)→ 4. C(verdict 引擎 + sweep coordinator + wire)。每步 TDD 红→绿。
2. 全仓 lint + 相关包 test 绿 → 交 QA 阶段真机验收(跑几轮三段式,每 issue 结束不残留 design_done/completed alive session;健康 parked holder 不被误杀)。

## 风险 / kill-switch

- **误杀健康 holder = 最大风险** → 硬边界:"任一 working phase → keep 全 issue" + declared_state='parked' 验证 + read-error/indeterminate defer + fresh-TURN(≤5min)in-flight defer + grace。
- **TOCTOU 诚实边界(R2)**:patrol 不与 PhaseOrchestrator 共享互斥(不扩 handoff coordination),所以自动 kill **只限 TOCTOU 无害情形**:ship-claim 路径(pipeline 已终结不再 spawn)+ no-claim 的 `completed` 终态段(不会变回 working)。no-claim 的非终态 parked 段(design_done 等)**只告警**,运维一键 `close_runner --done` —— 不写"绝对安全"的自动 kill 承诺。
- 复用 `FLYWHEEL_STALE_TERMINAL_CLOSE=0` 整体关兜底;新阈值 `FLYWHEEL_PARKED_PHASE_STALE_HOURS` 单列可调。
- probe 成本:working-safety ≤9/issue(每 role 最新 3)+ cleanup revalidate 每 sweep 设 cap;独立节流(同 staleCheckIntervalMs 默认 6h)+ 全局 `parkedSweepRunning` 防长 sweep 重入。
- 无 claim 回收/告警必留痕(reason 区分 shipped/orphan;alertOrphan 一次),运维可见,不静默。

## Scope 边界(不做)

- 不改交接期 PARK(FLY-887)。
- 不并入 FLY-603 worktree 泄漏(同类但独立;follow-up 记录)。
- 不让普通 close_runner 静默接受 design_done(决策③:保留 done-mode 显式意图)。

---

## Implement Notes（Codex R3 APPROVED 附 5 条非阻塞提醒 —— implement 阶段照做）

1. **stale TURN 清理写实**:no-claim `completed` QA 被 patrol 关闭后,其 stale TURN **不会**被现有 `reconcileTurnBelt` 自动清(turn-belt 对 completed QA holder 明确直接 return,等 post-ship finalization 删 —— 而这里正是 finalization 没发生)。它不阻塞、不泄漏内存,但实现时应二选一:在已判定 `clean + stale TURN + no-claim` 且回收 completed 后**显式 `deleteTurn(issueId)`**,或删掉该注释、接受一行 tiny stale row(不要留"由 reconcileTurnBelt 清"的不实注释)。
2. **常量 export + cleanup rotation**:`GHOST_PROBE_MAX_ROWS`(phase-orchestrator.ts:119)也 export 复用(与 `TURN_GRANT_GRACE_MS` 一致,避免漂移);cleanup revalidate cap 给具体常量/env + **跨 sweep rotation**,避免 backlog 永远只处理同一批头部 rows。
3. **alert dedupe 落账时机**:`alertOrphanParkedOnce` 的 durable dedupe 必须在**告警被接受/持久化后**落账(不要 delivery 前先写 dedupe,否则告警失败还被静音)。用稳定 event id / existing alert claim;若复用 `quiet_wake_notified`,明确其 synthetic issue key、source、episode fingerprint 与 prune 行为。
4. **late-bound alert sink 注入**:plugin 的 routed alert sink 晚于 HeartbeatService 构造 —— 按现有 holder pattern 注入 closure(如 `routedAlertSinkHolder.current`);事件类型**复用 `three_stage_stuck`**,payload 带真实 lead/project/session attribution。
5. header status 已更新为 codex-approved(本 note 5 已办)。
