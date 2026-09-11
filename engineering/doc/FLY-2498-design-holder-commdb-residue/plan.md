# FLY-2498 设计体交接后 CommDB 注册行永不终结 — 实施计划

Issue: FLY-2498 (https://linear.app/geoforge3d/issue/FLY-2498/病根-eng-design-交接后-bridge-会话已-completedcommdb-sessions-行仍-statusrunning)
日期: 2026-09-11
基于: research.md

## 0. 目标与不变量

**目标**:一个已经**证明死掉**的执行(窗口已杀、Codex daemon 已收或不存在),其 CommDB `sessions` 注册行不再停在 `running`,
而是被封掉(DELETE,CommDB 行离场的唯一方式),从而退出 Lead 巡检 owner index。两条路径都复用既有原语 `finalizePaneLossResidue`:
(A)`close-tmux` 端点杀窗成功后当场封行;(B)FLY-817 running-face reconcile 的 parked 否决接受「执行缺席」作为第二种推翻证据,
每小时 + boot 自动收存量与旁路。

**不变量**(实现与评审都按这几条核):
1. **只封证明已死的执行**。(A)`killTmuxWindow().killed === true` ∧ daemon 收割 ∈ {`not_codex`,`reaped`,`absent`};
   (B)与注册窗口名无关的缺席探针 `probeExecutionAbsenceBeyondTarget(...) === "dead"`(Codex daemon 缺席 ∧ 按执行标记发现不到窗口 ∧ 宿主无进程)。
   `residual`/`unverifiable`/`alive`/`unknown`/抛异常 一律不封、不推翻。
2. **只封 StateStore 已是可删终态的执行**:`RECONCILE_DELETABLE_STATES`(completed/approved/rejected/deferred/shelved/terminated),与 FLY-817 同一份词表。
   failed/blocked 留给 FLY-1066 harvest;非终态(design_done/awaiting_review/…)不封。
3. **删除只走精确目标 + TURN 否决的原语** `finalizePaneLossResidue`:目标漂移 / TURN 持有者 ⇒ 零写入。
4. **FLY-1329 否决本身不删、不弱化**:名字探针的 `dead` 仍不算数;新增的推翻证据必须来自不看名字的三重缺席。`executionAbsence` 依赖不注入 ⇒ reconcile 逐字节旧行为。
5. **不改**:巡检脚本与 owner index、`runner-patrol-rules.md`、交接路径(`event-route.ts` `phase_design_complete` 分支)、Codex/Claude 适配器、
   `registerSession`、FLY-44 close-tmux 状态守卫、close-runner、FLY-1204 回收、FLY-2302 定点封账、CommDB 表结构与 `CHECK` 词表、`finalizeSessionEffects`。
   不新增表、不新增 CommDB 方法、不新增 `workflow_run_event` 种类。
6. **best-effort、fail-open 到既有行为**:封行段任何异常只 `console.warn` + 审计;close-tmux 响应体字段只增不改(`{closed, error}` + `commDbFinalized?`);reconcile 不抛。
7. **方向守卫**(FLY-2302 plan §0.7,Lead 2026-09-03 裁定沿用):让死体的注册行拿到终结;任何「让巡检别报它」的形状一律不做。

## 1. 改动清单(4 个源文件 + 4 个测试文件)

### 1.1 `packages/teamlead/src/bridge/run-quiescence.ts` —— 新探针 `probeExecutionAbsenceBeyondTarget`

```ts
/** FLY-2498: absence proof that ignores the registered window name (FLY-1319-safe).
 *  Codex: the detached daemon must be absent. Every family: no tmux window carries this
 *  execution marker AND no host process references the execution id. `alive` / `unknown`
 *  never authorize anything. */
export async function probeExecutionAbsenceBeyondTarget(
  session: Pick<Session, "adapter_type"> | undefined,
  executionId: string,
  projectName: string,
  deps: RunExecutionLivenessDeps = {},
): Promise<GeneralizedLaunchLiveness> {
  if (session?.adapter_type === "codex-tmux") {
    const daemon = await (deps.probeCodexDaemon ?? probeCodexDaemonLiveness)(executionId);
    if (daemon === "alive") return "alive";
    if (daemon === "unknown") return "unknown";
  }
  return (deps.probeGeneric ?? probeGeneralizedLaunchLiveness)(executionId, projectName, {
    lookup: () => ({ kind: "gone" }),            // never trust the registered name
    allowMissingTargetHostAbsence: true,
  });
}
```
`probeGeneric` 的第三参已是 `GeneralizedLaunchProbeDeps`(`lookup` 可注入,`tmux-lookup.ts:365` 有 `{kind:"gone"}`)。放在 `probeRunExecutionLiveness` 之后,同注释风格。

### 1.2 `packages/teamlead/src/bridge/commdb-fsm-reconcile.ts` —— parked 否决的第二种推翻证据

- `opts` 新增(可选):
  ```ts
  /** FLY-2498: window-name-independent absence proof. Absent ⇒ the FLY-1329 veto keeps its
   *  original single release (superseded generation evidence). */
  executionAbsence?: (executionId: string, projectName: string) => Promise<"alive" | "dead" | "unknown">;
  ```
- `CommDbFsmReconcileResult` 新增 `parkedOverridden: number`(默认 0;`parkedVetoed` 语义不变)。
- parked 分支(`:263-285`)改为:
  ```ts
  if (parked) {
    const evidence = opts.parkedGenerationEvidence ? await opts.parkedGenerationEvidence(...).catch(() => "unavailable") : "unavailable";
    if (evidence === "superseded") {
      parkedSuperseded = true;
    } else {
      const absence = opts.executionAbsence
        ? await opts.executionAbsence(s.execution_id, projectName).catch(() => "unknown" as const)
        : "unknown";
      if (absence === "dead") {
        parkedSuperseded = true;            // same exact-target finalize path as superseded
        result.parkedOverridden++;
        console.log(`[commdb-fsm-reconcile] prune_parked_overridden_execution_absent: ${s.execution_id} (${projectName}) declares itself parked but no daemon / marker window / host process carries the execution — finalizing by exact target`);
      } else {
        result.parkedVetoed++;
        console.log(`[commdb-fsm-reconcile] prune_skipped_parked_conflict: … (现有文案不变)`);
        continue;
      }
    }
  }
  ```
  只对**已经通过**步骤 1-3(非 TURN 持有者、FSM 可删终态、名字探针 dead)且自称 parked 的行调缺席探针;非 parked 行不调。
- 删除原语不变:`parkedSuperseded` ⇒ `finalizePaneLossResidue(db, exec, s.tmux_window)`;`turn_holder`/`target_changed` ⇒ keep(现有处理)。

### 1.3 `packages/teamlead/src/bridge/plugin.ts`(两处)

**(a) reconcile 注入**(`:6711` residue harvester 与 `:9363` fast path 两处都加,同一闭包):
```ts
executionAbsence: (executionId, project) =>
  probeExecutionAbsenceBeyondTarget(store.getSession(executionId), executionId, project),
```
(`run-quiescence.js` 在 `:7564` 是动态 import;这里同款 `await import` 或改为顶部静态 import,实现方二选一,保持文件现有风格。)
日志行 `[Bridge] FLY-1066 CommDB residue (...)` 追加 `parkedOverridden=`。

**(b) close-tmux 端点**(`:3226-3316`):
```ts
const reap = await reapCodexDaemonForSession(store, session, "bridge.close-tmux");   // 接住现被丢弃的返回值
…
const result = await killTmuxWindow(target.tmuxWindow);
// FLY-2498: a body we just proved dead must not keep a `running` registry row.
const decision = decideCloseTmuxCommDbFinalize({ killed: result.killed, daemon: reap.outcome, stateStoreStatus: session.status });
let commDbFinalized = false;
if (decision.finalize) {
  const finalized = finalizeCommDbPaneLossResidue(executionId, session.project_name, target.tmuxWindow);
  store.recordCommDbFinalizeOutcome({ executionId, issueId: session.issue_id, projectName: session.project_name,
    ok: finalized.ok, error: finalized.error, runnerDeathProven: true,
    audit: { retiredGateCount: finalized.retiredGateCount, retiredAskCount: finalized.retiredAskCount, source: "bridge.close-tmux" } });
  commDbFinalized = finalized.ok;
} else {
  store.insertEvent({ event_id: `close-tmux-commdb-skipped-${executionId}-${Date.now()}`, execution_id: executionId, issue_id: session.issue_id,
    project_name: session.project_name, event_type: "commdb_finalize_skipped", source: "bridge.close-tmux",
    payload: { reason: decision.reason, tmuxWindow: target.tmuxWindow, daemon: reap.outcome } });
}
store.insertEvent({ … tmux_closed … (现有) });
res.json({ closed: result.killed, error: result.error, commDbFinalized });
```
`decideCloseTmuxCommDbFinalize` 与 `finalizeCommDbPaneLossResidue` 见 1.4;整段包在 try/catch,异常 `console.warn` 后仍返回现有响应。
**不改**:FLY-44 守卫、matchesLead、reap/cmux/kill 顺序。

### 1.4 `packages/teamlead/src/bridge/commdb-session-prune.ts` —— 两个小导出

```ts
/** FLY-2498: pure decision for the close-tmux endpoint. */
export function decideCloseTmuxCommDbFinalize(input: {
  killed: boolean;
  daemon: "not_codex" | "reaped" | "absent" | "residual" | "unverifiable";
  stateStoreStatus: string | undefined;
}): { finalize: true } | { finalize: false; reason: "kill_failed" | "daemon_residual" | "daemon_unverifiable" | "state_store_not_deletable" }
// 顺序:!killed → kill_failed;daemon residual/unverifiable → 对应 reason;!RECONCILE_DELETABLE_STATES.has(status) → state_store_not_deletable;否则 finalize。

/** FLY-2498: exact-target + TURN-guarded finalize for a caller holding independent death proof. */
export function finalizeCommDbPaneLossResidue(
  executionId: string, projectName: string, expectedTmuxWindow: string,
  dbPath: string | undefined = resolveCommDbPath(projectName),
): FinalizeCommDbResult
// 与 finalizeCommDbSessionCommunications 同形:无库 ⇒ {ok:true, outcome:"no_db"};开 CommDB(path,false);
// db.finalizePaneLossResidue(exec, expected);finalized ⇒ {ok:true, outcome:"finalized", 计数};
// {finalized:false, reason} ⇒ {ok:false, outcome: reason ("target_changed"|"turn_holder"), error: reason};异常 ⇒ {ok:false, outcome:"failed"};finally close。
```
`RECONCILE_DELETABLE_STATES` 从 `./commdb-fsm-reconcile.js` 引入(该文件已 import 本文件的 `resolveCommDbPath`,循环引用只涉及值导出,ESM 下安全;若实现方顾虑,把常量移到 `close-runner.ts` 旁边并两处 re-export)。

### 1.5 稳定标识与显示

| 项 | 值 | 说明 |
|---|---|---|
| reconcile 日志 token | `prune_parked_overridden_execution_absent` | 新;与现有 `prune_skipped_parked_conflict` 并列,巡检/QA grep 用 |
| reconcile 计数 | `parkedOverridden` | 新字段;`[Bridge] FLY-1066 CommDB residue (…)` 行追加 `parkedOverridden=` |
| close-tmux 审计 | `recordCommDbFinalizeOutcome(source="bridge.close-tmux")`(成功写 `commdb_ask_disposed`);跳过写 `commdb_finalize_skipped {reason, tmuxWindow, daemon}` | 后者是新 `session_events.event_type`;不进 alert kind 合同 |
| close-tmux 响应 | `{closed, error, commDbFinalized?}` | 只增字段 |
| 终态词表 | `RECONCILE_DELETABLE_STATES` | 沿用 FLY-817 |

### 1.6 迁移 / 回滚边界

- 无 schema 迁移、无 flag。存量残留(`1492b1f6` 与今天 4 具)由部署后第一次 boot 的 residue harvester 收敛:FSM completed ∧ 名字探针 dead ∧ parked ∧
  缺席探针 dead(daemon 已被 close-tmux 收、窗口已杀、无宿主进程)⇒ `finalizePaneLossResidue` 删行;巡检 STEP 1 随即无 `MISSING_PANE`。
- 回滚:revert 本 PR 即回到「parked 只能被代际证据推翻」+「close-tmux 不封行」;已删的行是既有原语的合法结果,无需修复。
- 单处可退:1.2/1.3(a) 与 1.3(b) 各自独立生效。

## 2. 测试(TDD:先红后绿)

### 2.1 `packages/teamlead/src/bridge/__tests__/run-quiescence.fly2498-absence-probe.test.ts`(新,注入 deps)
1. Codex 体 daemon `alive` ⇒ `alive`,`probeGeneric` 0 次。 2. daemon `unknown` ⇒ `unknown`,generic 0 次。
3. daemon `absent` + generic `dead` ⇒ `dead`;断言传给 generic 的 deps 中 `lookup()` 返回 `{kind:"gone"}` 且 `allowMissingTargetHostAbsence === true`。
4. 非 Codex(`claude-tmux` / undefined)⇒ 不调 daemon,直接 generic。 5. generic `unknown` ⇒ `unknown`。

### 2.2 `packages/teamlead/src/bridge/__tests__/commdb-fsm-reconcile.fly1329-parked-veto.test.ts` —— 追加 `describe("FLY-2498 execution-absence override")`
沿用 `seedRunning(exec, parked)` + `fsmCompleted` + `probeDead`:
1. **不注入 `executionAbsence`** ⇒ 现有 5 条原样绿(门槛;「KEEPS a parked runner's row even when FSM=completed and tmux probes dead」是本单对照)。
2. parked + `executionAbsence: dead` ⇒ 行删除、`reconciled=1`、`parkedOverridden=1`、`parkedVetoed=0`、`onFinalizeOutcome` 收到 finalized。
3. parked + `alive` ⇒ keep,`parkedVetoed=1`,`parkedOverridden=0`。 4. parked + `unknown` ⇒ 同 3。 5. parked + 探针抛异常 ⇒ 同 3(fail-closed)。
6. parked + `dead` 但 finalize 时目标漂移(注入 `finalizePaneLossResidue` 返回 `target_changed`)⇒ keep。
7. 非 parked 行 ⇒ `executionAbsence` 0 次(`vi.fn`),按旧路径删除。
8. parked + `parkedGenerationEvidence: superseded` ⇒ `executionAbsence` 0 次(代际证据优先,旧路径不变)。
9. TURN 持有者 parked 行 ⇒ `executionAbsence` 0 次(步骤 1 先 keep)。

### 2.3 `packages/teamlead/src/__tests__/commdb-session-prune.test.ts` —— 追加 `describe("FLY-2498 close-tmux helpers")`
- `decideCloseTmuxCommDbFinalize`:六分支(killed+absent+completed ⇒ finalize;killed+not_codex+terminated ⇒ finalize;`killed:false` ⇒ kill_failed;
  residual ⇒ daemon_residual;unverifiable ⇒ daemon_unverifiable;status awaiting_review / failed / blocked / undefined ⇒ state_store_not_deletable)。
- `finalizeCommDbPaneLossResidue`:finalized(行删、ask 以 owner_closed 退)/ target_changed(零写)/ turn_holder(零写)/ 无库 ⇒ no_db。

### 2.4 `packages/teamlead/src/bridge/__tests__/close-tmux.fly2498.test.ts`(新,集成)
真 `StateStore.create(":memory:")` + 真临时 comm.db + express 只 mount close-tmux 路由(token 中间件用测试 token,`fcMw` 用 noop),注入 kill/reap:
1. StateStore completed、CommDB running+parked、kill ⇒ killed、reap ⇒ absent:响应 `{closed:true, commDbFinalized:true}`;CommDB 行消失;`session_events` 有 `commdb_ask_disposed source=bridge.close-tmux` 与 `tmux_closed`。
2. 同上但 reap ⇒ residual:响应 `{closed:true, commDbFinalized:false}`;行仍 running;`commdb_finalize_skipped reason=daemon_residual`。
3. StateStore awaiting_review ⇒ 409(FLY-44 现有守卫,回归)。
4. CommDB 无目标 ⇒ `{closed:false, reason:"No tmux target found"}`(现有,回归)。
若真 handler 无法单独 mount(R7),退化为 2.3 的纯函数测试 + PR test plan 说明,并在隔离 Bridge 里做 §3 A1。

### 2.5 shell 套件与不变声明
- `bash scripts/__tests__/lead-patrol-snapshot.test.sh` 原样绿(需先 `pnpm -r build`)。
- `commdb-fsm-reconcile.test.ts`、`commdb-session-prune.fly1329-parked-veto.test.ts`、`founder-consent-integration.test.ts` 原样绿。

### 2.6 运行命令(实现方交付前逐条跑,PR test plan 贴输出)

```bash
pnpm -r build
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/run-quiescence.fly2498-absence-probe.test.ts \
  src/bridge/__tests__/commdb-fsm-reconcile.fly1329-parked-veto.test.ts \
  src/bridge/__tests__/commdb-fsm-reconcile.test.ts \
  src/bridge/__tests__/close-tmux.fly2498.test.ts \
  src/__tests__/commdb-session-prune.test.ts \
  src/bridge/__tests__/commdb-session-prune.fly1329-parked-veto.test.ts \
  src/bridge/__tests__/commdb-residue-layer-interaction.test.ts \
  src/__tests__/founder-consent-integration.test.ts
bash scripts/__tests__/lead-patrol-snapshot.test.sh
pnpm --filter flywheel-teamlead test        # 全量;排除 **/tmux-viewer.macos.test.ts
pnpm biome check packages/teamlead/src/bridge/run-quiescence.ts packages/teamlead/src/bridge/commdb-fsm-reconcile.ts \
  packages/teamlead/src/bridge/commdb-session-prune.ts packages/teamlead/src/bridge/plugin.ts
```

## 3. 验收(QA 节点按此核)

| # | 断言 | 证据 |
|---|---|---|
| A1 | 隔离 Bridge(`FLYWHEEL_STATE_DIR` / `FLYWHEEL_COMM_DIR` 指向临时目录)里复现:Codex 设计体 `complete --route phase_design_complete` 后 StateStore completed、CommDB running+ka=1、声明 parked;`POST /api/sessions/:id/close-tmux` ⇒ `{closed:true, commDbFinalized:true}`,CommDB 行 ≤1 s 消失,`session_events` 有 `commdb_ask_disposed source=bridge.close-tmux` | 隔离 comm.db / teamlead.db 前后 `SELECT` |
| A2 | A1 之后跑巡检快照 ⇒ STEP 1 无该 target 的 `ROSTER_EVIDENCE … findings=MISSING_PANE` | `lead-patrol-snapshot.sh` 输出 |
| A3 | 阴性:StateStore awaiting_review 的体 close-tmux ⇒ 409;StateStore completed 但 daemon residual ⇒ 行仍 running,`commdb_finalize_skipped reason=daemon_residual` | 同上 |
| A4 | 存量形状:手工造「running + parked + StateStore completed + 窗口不在 + daemon 不在」行(或对生产 `1492b1f6` 现状),触发一次 residue harvester(boot 或每小时)⇒ 日志 `prune_parked_overridden_execution_absent`,行消失,`parkedOverridden=1`;之后巡检无 MISSING_PANE | Bridge 日志 + 两轮 `SELECT` |
| A5 | 阴性对照:活着停驻的 Codex 设计体(窗口在、daemon 在、StateStore completed、声明 parked)经过两轮 harvester ⇒ 行仍 running、声明仍在、日志仍是 `prune_skipped_parked_conflict`;phase 唤醒 `send --to <exec>` 仍可达 | 同上 |
| A6 | FLY-1319 对照:活的 Claude 停驻体,把 CommDB `tmux_window` 改成陈旧名字 ⇒ 名字探针 dead、按标记发现窗口 alive ⇒ 行不动(FLY-1329 用例 + 隔离环境一具) | 单测 2.2-1 + 隔离环境 |
| A7 | §2.6 全部命令绿,且 PR 的 exact head 上 CI 绿 | CI 链接 |

## 4. 已知限制(本版不做)

- L1 `phase_shutdown_controller_lease_stale_live_pane` 让 close-runner 受控关停对本形状拒绝,是 Lead 退而用 close-tmux 的直接原因;本单不改 FLY-1269 的 fail-closed(另开 issue)。
- L2 `codex_app_server_orphan_identity_mismatch` 每 5 分钟一条的 reaper 噪音(台账有、CODEX_HOME 清单无)是另一形状,不在本单。
- L3 两条 2026-08 的 `runner-flywheel:pending` running 行(`35f0dbf9`/`296488f3`)本单明确跳过。
- L4 StateStore 非终态但窗口已死的体(如 legacy `design_done` 持有者被 close-tmux)不封行,留给 FLY-1204 alert + `close_runner --done`。
- L5 close-tmux 对 StateStore failed/blocked 的体不封行(CRASH_PRESERVE 词表),交 FLY-1066 harvest 每小时收;`blocked` 行在 owner index 里仍可能短暂报 MISSING_PANE(≤1h,FLY-2302 已核的现状)。
- L6 `finalizeSessionEffects` 删行时不清 `runner_declared_states` / `runner_phase_wakes`(FLY-817 现状);对已删 exec 的残留声明无消费者会误判(research R3)。
- L7 从「体死」到「reconcile 封行」最长 1 小时(路径 B 的节奏);路径 A 覆盖 Lead 主动关窗的场景把它压到当场。

## 5. Follow-ups(评审 advisory 留档处,本版不修)

(评审轮次填充)
