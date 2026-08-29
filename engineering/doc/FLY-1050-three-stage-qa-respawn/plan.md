# FLY-1050 三段式 QA 重生 — 实施计划

Issue: FLY-1050 (https://linear.app/geoforge3d/issue/FLY-1050/infrabug-三段式-qa-session-被杀后流水线搁浅无法干净重生-qareconcile-跳过已有-qa-row)
日期: 2026-07-09
基于: research.md

## 0. 摘要

死 QA phase row（`terminated`/`failed`/`completed` 无 ship claim）不再挡 implement→QA 的 handoff 重驱（方案 A，boot 自愈）；并在 QA 死亡的三个事件位点挂 scoped 重驱（方案 B，无需重启 Bridge）。重生完全复用现成 `onPhaseComplete(implement)` handoff。护栏：FAIL-intent 跳过、cap=3、per-issue in-flight、alive-row 天然幂等。附带修根因 ③（`terminated` 不在终态集合导致的静默）。方案取舍与 shape 矩阵见 exploration.md §4-5，代码依据见 research.md。

分支：`flywheel-FLY-1050`（三段式共享分支，Design/Implement/QA 同栈）。全部改动在 `packages/teamlead/src`。

## 1. 变更总览

| # | 文件 | 变更 |
|---|---|---|
| 1 | `bridge/phase-orchestrator.ts` | 主修：判据、重驱包装、scoped 入口、`DEAD_QA_STATUSES` 域集合（belt 终态集合不动）、stranded-pass 覆盖与抑制 |
| 2 | `StateStore.ts` | `getStrandedThreeStageQaPassSessions` 补 `terminated` |
| 3 | `DirectEventSink.ts` | `emitFailed` 挂 scoped 重驱（belt reconcile 之前） |
| 4 | `bridge/event-route.ts` | session_failed 成功路径挂 scoped 重驱（FSM-rejected 分支不动） |
| 5 | `bridge/actions.ts` + `bridge/plugin.ts` | terminate 成功后挂 scoped 重驱（router 新可选参数；plugin.ts 两处挂载点都传）+ 顺手补 terminate 的 scoped belt reconcile |
| 6 | `bridge/crash-reaper.ts` + `bridge/plugin.ts` | 可选回调 `onPhaseSessionTerminated`（收尸后触发；依赖面不干净则降级为不做，boot 兜底） |
| 7 | 测试 | `bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts`（新）+ 各触点既有测试文件补 case |

不动的东西（显式）：`getActivePhaseSessionForIssue` 与 /api/runs/start 409（行为正确）；`hasProgressedPastDesign`；FAIL fix-loop 全链；FSM-rejected 僵尸分支（shape 6）；`reconcileQaVerdicts` sweep 逻辑本体。

## 2. 实施步骤（TDD：每步先写红测，再最小实现）

### Step 1 — phase-orchestrator.ts 核心（先写 F1-F7 红测）

**1a. 常量与开关**（文件顶部，`TERMINAL_SESSION_STATUS` 附近）：

```ts
// TERMINAL_SESSION_STATUS 保持 {completed, failed} 不动 —— 它是 turn-belt holder 的
// "跳过 liveness probe 直判 stale" 快路径。terminated 绝不能进这个集合(Codex R1 #1):
// terminate 可能以 cleanupPending 返回(FSM 已终态但 tmux 还活着),直判 stale 会把 TURN
// 交回 implement 而旧 QA 进程仍在写 —— 必须继续走 probe 路径(probe alive/indeterminate → no-op)。
const DEAD_QA_STATUSES = new Set(["completed", "failed", "terminated"]); // 重生判据/stranded-pass 域专用
const QA_RESPAWN_MAX = 3; // 死 qa row 达到此数 → 拒绝重生 + failClosed
/** FLY-1050 逃生口:=0 时关闭 QA 重生(判据回退 row-exists,事件位点不重驱)。
 *  注意:terminated 的 stranded-pass 告警硬化(1f/1g/Step 2)不受此开关控制 ——
 *  它是独立的静默搁浅修复,回滚重生不应重新引入静默(Codex R1 #4)。 */
function qaRespawnEnabled(): boolean {
  return process.env.FLYWHEEL_THREE_STAGE_QA_RESPAWN !== "0";
}
```

belt 侧行为保持现状：`reconcileOneTurn` 对 `terminated` holder 继续走 liveness probe（CommDB registration 被 terminate 删掉时 probe absent → 正常回收；cleanupPending 残留活 tmux 时 probe alive/indeterminate → no-op，不动 TURN、不告警）。补两条红测锁死：terminated holder + probe alive/indeterminate → TURN 不动、无 STALE-TURN 告警；terminated holder + probe absent/dead_pin → 正常回收。

**1b. 判据 `hasProgressedPastImplement`（:563 处重写）**：

```ts
private hasProgressedPastImplement(issueId: string): boolean {
  if (this.deps.hasShipFinalizationClaim(issueId)) return true;
  try {
    const qaRows = this.deps.listPhaseSessionRows(issueId, "qa"); // 新序在前
    if (!qaRespawnEnabled()) return qaRows.length > 0;            // 逃生口 = 旧判据
    if (this.deps.getAlivePhaseSession(issueId, "qa")) return true;
    if (qaRows.length === 0) return false;                        // G-A2 原始场景
    // 只看"最新一条"qa row 的 intent(qaRows[0],StateStore 保证新序在前 + rowid tiebreak)。
    // 绝不能扫全部历史 row:老一轮合法 FAIL(带 fixExecId)会永久挡住新死 QA 的重生(Codex R1 #3)。
    const intent = this.deps.qaVerdicts.readIntent(qaRows[0].execution_id);
    return intent?.status === "fail";                             // fix-loop 拥有流水线(shape 2/3)
  } catch (err) {
    this.warn(`hasProgressedPastImplement query failed for ${issueId}: … — treating as progressed (no re-drive)`);
    return true;                                                  // fail-closed 保留
  }
}
```

注意：JSDoc（:554-562）同步重写——旧注释「terminal QA 归 checkStrandedPass 管」是 FLY-1050 根因 ① 的错误推理，必须改掉而不是留着误导。

**1c. 重驱包装 + in-flight guard**（新私有成员）：

```ts
private readonly redriveInFlight = new Set<string>(); // issueId

private async tryRedriveImplementHandoff(impl: PhaseSession): Promise<void> {
  if (this.redriveInFlight.has(impl.issue_id)) return;
  this.redriveInFlight.add(impl.issue_id);
  try {
    const deadQa = this.deps
      .listPhaseSessionRows(impl.issue_id, "qa")
      .filter((r) => DEAD_QA_STATUSES.has(r.status));
    if (deadQa.length >= QA_RESPAWN_MAX) {
      await this.failClosed(impl, `three-stage QA respawn cap reached on ${impl.issue_id} (${deadQa.length} dead qa sessions; max ${QA_RESPAWN_MAX}) — NOT respawning; Lead decides how to proceed`);
      return;
    }
    const hadDeadQa = deadQa.length > 0;
    await this.onPhaseComplete(impl); // 复用全部现有门(边界/政策/evidence)+handoff
    // 仅在"确实是重生"(有死 qa 前科)且 spawn 真发生(alive qa 现已存在)时发 note,见 1e
    if (hadDeadQa && this.deps.getAlivePhaseSession(impl.issue_id, "qa")) {
      await this.postRespawnThreadNote(impl);
    }
  } finally {
    this.redriveInFlight.delete(impl.issue_id);
  }
}
```

`reconcileStrandedImplementHandoffs`（:537-551）循环体改调 `tryRedriveImplementHandoff(s)`（原直接 `onPhaseComplete(s)`）。G-A2 零 qa row 场景走同一入口（0 < 3，不发 thread note，行为不变）。

**1d. scoped 入口（新公开方法，事件位点调）**：

```ts
/** FLY-1050:一个三段式 QA row 到达死终态 — 若流水线因此失去自我推进能力,
 *  重驱 implement→QA handoff(重生新 QA)。幂等/可重复调用。 */
async reconcileQaLoss(scope: { issueId: string; terminalExecId: string }): Promise<void> {
  if (!qaRespawnEnabled()) return;
  const dead = this.deps.qaVerdicts.getSession(scope.terminalExecId); // fresh re-read
  if ((dead?.chat_thread_role ?? "main") !== "qa") return;            // 只管三段式 qa row
  if (!DEAD_QA_STATUSES.has(dead?.status ?? "")) return;              // 必须已终态(FSM 拒绝的僵尸不进来)
  if (this.hasProgressedPastImplement(scope.issueId)) return;         // 同一判据
  const impl = this.deps
    .listPhaseSessionRows(scope.issueId, "implement")
    .find((s) => s.status === "awaiting_review");
  if (!impl) return;                                                  // 无搁浅 implement → 无事可做
  await this.tryRedriveImplementHandoff(impl);
}
```

三段式政策（per-project OFF）与 review-evidence 由 `onPhaseComplete` 内部既有门把守，不重复实现。

**1e. respawn thread note**（新私有，模式抄 `postFixThread`）：

```ts
private async postRespawnThreadNote(impl: PhaseSession): Promise<void> {
  try {
    await this.deps.qaVerdicts.postIssueThread(impl,
      "🧪 三段 QA 段已死(terminated/failed),已自动重生新 QA session 重验(同分支最新 head)。founder 不打扰。");
  } catch (err) { this.warn(`postIssueThread failed: …`); }
}
```

注意放在 `onPhaseComplete` 之后仅当真发生了 spawn 才发——最简实现：仅在 `hadDeadQa && getAlivePhaseSession(issue,"qa") 现在存在` 时发（spawn 失败时 onPhaseComplete 内部已有 failClosed 告警，不再叠加）。

**1f. `checkStrandedPass`（:1260）两处小改**：

```ts
if (!DEAD_QA_STATUSES.has(row.status)) return;   // 原 completed/failed 硬编码 → 含 terminated(注意用 DEAD_QA_STATUSES,不动 belt 的 TERMINAL 集合)
…
if (this.deps.getAlivePhaseSession(row.issue_id, "qa")) return; // 存活后继 QA 拥有重验 → 不算 stranded(防重生后误报)
```

后继抑制无静默窗口：后继 QA 自己死掉会再次进入本票机制（重生或 cap 告警）。

**1g. `onPhaseComplete` qa 早退分支（:727-733）**：`completed/failed` 硬编码 → `DEAD_QA_STATUSES.has(session.status)`（让经事件流到达 terminated 的 qa row 也能触发 stranded-pass 检查；terminate action 不走这里，但 crash-reaper 收尸后的 replay 可能走）。

### Step 2 — StateStore.ts

`getStrandedThreeStageQaPassSessions`（:2506）：`status IN ('completed','failed')` → `IN ('completed','failed','terminated')`。补单测（`__tests__/StateStore…` 既有 suite 里加 case：terminated + three_stage_verdict 的 row 能被查出）。

### Step 3 — 事件位点布线

**3a. DirectEventSink.emitFailed（:919 之前）**：

```ts
await this.maybeReconcileQaLoss(env.executionId);        // 先重驱(成功则 belt 已被新 spawn 覆写)
await this.reconcileTurnBeltAfterTerminal(env.executionId); // 再 belt 兜底(重驱被拒时回收)
```

`maybeReconcileQaLoss` 私有 helper（模式抄 `reconcileTurnBeltAfterTerminal` :933-952）：读 session → `chat_thread_role === "qa"` 且有 project_name → `orchestrator.reconcileQaLoss({issueId, terminalExecId})`，try/catch never-throw。

**3b. event-route.ts session_failed 成功路径**：在既有 sister 位置（session_failed 转移成功后、belt reconcile 之前）插同样两行。FSM-rejected 分支（:1956）不加（research §1.4：row 未终态，`reconcileQaLoss` 的 DEAD_QA_STATUSES re-check 也会挡——加了是 no-op，不加省一次调用）。

**3c. actions.ts terminate**：

- `createActionRouter`（:1274）末尾加可选参数 `phaseOrchestrator?: { current?: PhaseOrchestrator }`（late-bound holder，模式同 `issueDisplayRefresh`）。
- 触发守卫必须写成 `(terminateResult.success || terminateResult.cleanupPending)`（Codex R1 #2：cleanupPending 走的是 `success:false` + `cleanupPending:true` 的 400 分支，只挂 success 分支会漏掉它）。两种情况 FSM row 都已终态；cleanupPending 残留活 tmux 时，spawn 被 ghostGuard 挡、belt 被 liveness probe 挡（1a），行为安全。对 `chat_thread_role === "qa"` 的 session（用 handleTerminate 之前预读的 session row）fire-and-forget：

```ts
void phaseOrchestrator?.current?.reconcileQaLoss({ issueId: sess.issue_id, terminalExecId: eid })
  .then(() => phaseOrchestrator?.current?.reconcileTurnBelt({ issueId: sess.issue_id, projectName: sess.project_name, terminalExecId: eid }))
  .catch((err) => console.warn(`[terminate] qa-loss reconcile failed: …`));
```

（terminate 今天没有任何 belt reconcile——research §1.4 空档，顺手补上；guard 1 保证只在死者是 holder 时动 belt。）

实现注记（Codex R2）：pre-read 的 `sess` 要提到现有 scope-check block 外层作用域，post-handleTerminate 的 hook 用原始 row 的 `chat_thread_role`/`issue_id`/`project_name`；整条 scoped reconcile 链 never-throw + fire-and-forget（与 plugin.ts 既有 holder 模式一致）。
- **plugin.ts 两处 `createActionRouter` 调用（:1021 与 :1447，dashboard alias 双挂载）都传 `phaseOrchestratorHolder`**——FLY-175 双挂载教训，漏一处 = dashboard 面的 terminate 不重生。

**3d. crash-reaper.ts**：`CrashReaperInjectedDeps` 加可选 `onQaPhaseTerminated?: (executionId: string, issueId: string) => void`；`applyTransition → terminated` 成功后、归档之前，对 `chat_thread_role === "qa"` 的 row 调用。plugin.ts:3436 组装处闭包到 orchestrator holder（fire-and-forget `reconcileQaLoss`）。**降级条款**：若实现时 reaper 的现有依赖形态放不进（比如它拿不到完整 session row），砍掉 3d 不补——boot reconcile 兜底该场景（reaper 收尸 = 进程早死，多等一次 boot 可接受），在 PR 描述里记录取舍。

### Step 4 — 测试（新文件 `bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts` + 各触点补 case）

沿用 `phase-orchestrator.test.ts` 的 deps-mock 模式。fixture 严格照 research §3：

| 测试 | 断言 |
|---|---|
| F1（967 形态：qa terminated + intent pass） | `reconcileQaLoss` → `startDispatcher.start` 恰 1 次，`sessionRole:"qa"`、`startPoint === capturePhaseHeadSha(implement) 返回值`（**Tadashi ④：最新有效 head**）、`shareParentBranch:true`；implement 被幂等 re-park（`parkPhaseRunner` 调用但无 close/wake）；thread note 发出 |
| F1-boot | 同 fixture 走 `reconcileOnStartup` → 同样 spawn（boot 与 scoped 同判据） |
| F2（1018 形态：qa failed×2 无 intent） | spawn 1 次（2 < cap） |
| F3（三条死 qa row） | 无 spawn；`alertLeadPipelineError` 1 次（cap 文案） |
| F4（intent fail + fixExecId） | 无 spawn、无告警（fix-loop 域） |
| F4b（intent fail 无 fixExecId） | 无 spawn（verdict sweep 域） |
| F4c（latest-only：老 qa row 带 `{fail, fixExecId}`，最新 qa row 死且无 intent） | **有 spawn**（历史 FAIL 不挡新死 QA 的重生——Codex R1 #3，实现只准看 qaRows[0]） |
| F5（alive qa 在岗） | 无 spawn |
| F6（ship claim） | 无 spawn |
| F7 byte-compat | chat_thread_role='main' 的死 row → `reconcileQaLoss` 全程 no-op；三段式 OFF 项目 → `onPhaseComplete` 内政策门拒绝（disabled-warn，无 spawn）；`FLYWHEEL_THREE_STAGE_QA_RESPAWN=0` → **重生路径**回到修复前行为（判据回退 row-exists：F1 fixture 下 boot skip、scoped no-op）。注意开关只管重生；terminated stranded-pass 告警硬化独立生效（Codex R1 #4，静默搁浅修复不随重生回滚） |
| 并发 | 同 issue 两个并发 `reconcileQaLoss` → spawn 恰 1 次（in-flight guard） |
| 幂等 | spawn 成功后（alive qa row 落库）再触发 → no-op |
| evidence 门 | implement 无 review binding（unbound sentinel）→ 无 spawn + failClosed（既有门文案） |
| ghost 门 | 死 qa row 带 tmux_session 且 probe alive → 无 spawn + failClosed（既有 ghostGuard） |
| belt 顺序 | 死 QA 是 holder：重驱成功 → belt holder = 新 QA（pre-launch grant 覆写，epoch+1）且无 STALE-TURN 告警；重驱被 cap 拒 → 后续 belt reconcile 回收到 implement |
| belt liveness（Codex R1 #1 红测） | terminated holder + probe alive/indeterminate（cleanupPending 形态）→ TURN 不动、无 STALE-TURN 告警；terminated holder + probe absent/dead_pin → 正常回收（belt 的 TERMINAL 集合不含 terminated，保持 probe 路径） |
| stranded-pass | terminated + intent pass + 无 binding + 无存活后继 → 告警照发；有存活后继 → 不告警 |
| DirectEventSink / event-route / actions | 各触点：qa row 死 → `reconcileQaLoss` 被调且在 belt reconcile 之前；非 qa row → 不调；terminate 触点专测 cleanupPending（success=false + cleanupPending=true）也触发 |
| StateStore | terminated stranded-pass 候选可查出 |

### Step 5 — 收尾

1. `pnpm lint`（全仓，push 前必跑）+ `pnpm test`（teamlead 包全绿，重点 `phase-orchestrator.*` 三个既有文件零回归）。
2. 全仓 grep 复查：`TERMINAL_SESSION_STATUS` 语义变化是否影响本文件外 import（当前无 export，确认保持不 export）。
3. progress.md 收尾 + 本文件夹三文档随实现 PR 合入 main。

## 3. 部署与验收

- **部署形态**：纯 Bridge 侧（teamlead 包）→ 单次 Bridge 重启生效；按惯例攒批（多 PR 一次重启），不为本票单独重启。逃生口 `FLYWHEEL_THREE_STAGE_QA_RESPAWN=0`。
- **QA 段真机验收剧本**（QA phase 执行，实现段只保证可复现）：529 Room 或生产影子 issue 起三段式 → implement 到 awaiting_review、QA 起来后 terminate 它 → 断言：≤1 个 reconcile 周期内新 QA session 出现、window 名正确、TURN holder=新 QA epoch+1、issue thread 有重生 note、status line 正确；再连杀至 cap → 断言 failClosed 告警且不再 spawn。对照组：`=0` 时 terminate 后无重生（修复前行为）。
- **验收即等于**：再遇 967/1018 形态，terminate 旧 QA 即自动干净重生，不再需要 belt 手术/删记录/重启 Bridge/独立 QA issue。

## 4. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 重驱误伤 mid-fix implement（shape 2） | FAIL-intent 跳过 + F4 测试锁死 |
| respawn 循环（spawn 即死） | cap=3 + F3；告警每次触发（离散事件，不刷屏） |
| terminate 后 tmux 残留（cleanupPending） | spawn 被 ghostGuard fail-closed 挡；belt 被 liveness probe 挡（terminated 不进 belt 终态快路径，Codex R1 #1）；操作员清理后自愈 |
| 双挂载漏传 holder | plugin.ts 两处调用点 + 测试断言 dashboard alias 路径也触发 |
| 未知回归 | 逃生口 env=0 一键回到修复前行为；改动全部限 three-stage ON + chat_thread_role 路径 |

回滚 = revert PR，或设 `FLYWHEEL_THREE_STAGE_QA_RESPAWN=0` + Bridge 重启（只关重生路径；terminated stranded-pass 告警硬化保留——回滚不重新引入静默搁浅）。
