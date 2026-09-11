# FLY-2498 设计体交接后 CommDB 注册行永不终结 — 实施计划

Issue: FLY-2498 (https://linear.app/geoforge3d/issue/FLY-2498/病根-eng-design-交接后-bridge-会话已-completedcommdb-sessions-行仍-statusrunning)
日期: 2026-09-11
基于: research.md

## 0. 目标与不变量

**目标**:一个已经**证明死掉**的执行(窗口已杀、Codex daemon 已收或不存在),其 CommDB `sessions` 注册行不再停在
`running`,而是拿到与 StateStore 终态对应的终态戳(`completed` / `failed` / `blocked` + `ended_at`),从而退出
Lead 巡检 owner index,并在下一轮既有清扫里按既有规则删除。两条路径共用**同一个** CommDB 原语:
(A)`close-tmux` 端点在杀窗成功当场盖戳;(B)每小时/boot 清扫增加「盖戳相」收敛所有「死了没盖戳」的存量与旁路。

**不变量**(实现与评审都按这几条核):
1. **只给证明已死的执行盖戳**。死亡证明:(A)`killTmuxWindow().killed === true` ∧ daemon 收割结果 ∈ {`not_codex`,`reaped`,`absent`};
   (B)`probeRunExecutionLiveness(...) === "dead"`(Codex 先 daemon 后 tmux/discovery/host)。`residual`/`unverifiable`/`alive`/`unknown` 一律不盖。
2. **只给 StateStore 已是终态的执行盖戳**。终态门 = `isMailboxTerminalStatus(status)`(`flywheel-comm/session-terminal`);
   `running`/`awaiting_review`/`approved_to_ship`/`design_done`/`ship_parked` 等非终态不盖(即使窗口已死 —— 那是 crash-reaper / W-1 / FLY-1204 的地盘)。
3. **盖戳不删身份**。行、`session_receipt_lineage`、ask/gate 都不动;删除仍只由既有清扫 / close-runner / post-ship 收尾按既有否决(TURN、parked、探针)做。
4. **精确目标 CAS,零漂移写入**:`WHERE execution_id=? AND tmux_window=? AND status='running' AND ended_at IS NULL`;`:pending` 目标永不盖;0 行即放弃并记 skipped。
5. **同事务处理体的附属声明**:doorbell(`runner_phase_wakes` 的 `doorbell:%`)置 finished(与 `updateSessionStatusIfRunning` 同款),
   `runner_declared_states` 清空(parked 是活进程的声明;不清则清扫永远 `kept_parked`,见 research R3)。清扫自己的 parked veto **不改**。
6. **不改**:巡检脚本与 owner index、`runner-patrol-rules.md`、交接路径(`event-route.ts` `phase_design_complete` 分支)、Codex/Claude 适配器、
   `registerSession` upsert、FLY-44 close-tmux 状态守卫、close-runner、FLY-1204 回收、FLY-2302 定点封账、CommDB 表结构与 `CHECK` 词表。
   不新增表、不新增 `workflow_run_event` 种类。
7. **best-effort、fail-open 到既有行为**:盖戳段任何异常只 `console.warn` + 记 `commdb_terminal_stamp_skipped`;close-tmux 响应体形状不变
   (`{closed, error}`),清扫循环不抛、不影响后续终态扫描。
8. **方向守卫**(FLY-2302 plan §0.7,Lead 2026-09-03 裁定沿用):本单让死体的注册行拿到终结;任何「让巡检别报它」的形状
   (改 owner index、按 StateStore 交集、按 vendor/ended_at 过滤)一律不做。

## 1. 改动清单(4 个源文件 + 3 个测试文件)

### 1.1 `packages/flywheel-comm/src/db.ts` —— 新原语 `markDeadSessionTerminal`

```ts
export type MarkDeadSessionTerminalResult =
  | { stamped: true; status: "completed" | "failed" | "blocked" }
  | { stamped: false; reason: "no_row" | "pending_target" | "target_changed" | "not_running" };

/**
 * FLY-2498: give a PROVEN-DEAD execution's still-`running` registry row its terminal
 * stamp without deleting its identity. Callers must hold independent death proof
 * (a successful kill of this exact target + daemon absence, or the family-aware
 * quiescence probe). Exact-target CAS inside one IMMEDIATE transaction; any drift
 * writes nothing. Also finishes the row's pending doorbells and clears its declared
 * state — both are claims a live process makes about itself.
 */
markDeadSessionTerminal(
  executionId: string,
  expectedTmuxWindow: string,
  status: "completed" | "failed" | "blocked",
): MarkDeadSessionTerminalResult
```
事务体(`.immediate()`):
1. `SELECT tmux_window, status, ended_at FROM sessions WHERE execution_id = ?`
   → 无行 `no_row`;`expectedTmuxWindow.endsWith(":pending") || row.tmux_window.endsWith(":pending")` → `pending_target`;
   `row.tmux_window !== expectedTmuxWindow` → `target_changed`;`row.status !== "running" || row.ended_at` → `not_running`。
2. `UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE execution_id = ? AND tmux_window = ? AND status = 'running' AND ended_at IS NULL`
   → `changes !== 1` ⇒ `target_changed`。
3. `this.disposeRunnerDoorbellsForTerminal(executionId, Date.now())`。
4. `DELETE FROM runner_declared_states WHERE execution_id = ?`(readonly-tolerant 不需要:本方法只在可写库上调用)。

放在 `updateSessionStatusIfRunning` 之后(`db.ts:~8030`),与它同区、同注释风格。`types.ts` 不改(Session.status 词表已含三值)。

### 1.2 `packages/teamlead/src/bridge/commdb-terminal-stamp.ts`(新,纯函数 + 状态映射)

```ts
import { isMailboxTerminalStatus } from "flywheel-comm/session-terminal";

export type CommDbTerminalStampSource = "bridge.close-tmux" | "bridge.commdb-terminal-prune";

/** StateStore terminal → CommDB terminal vocabulary (research R2). undefined = not stampable. */
export function commDbTerminalStatusFor(stateStoreStatus: string | undefined): "completed" | "failed" | "blocked" | undefined {
  if (!stateStoreStatus || !isMailboxTerminalStatus(stateStoreStatus)) return undefined;
  return stateStoreStatus === "failed" || stateStoreStatus === "blocked" ? stateStoreStatus : "completed";
}

export interface StampAfterTmuxCloseInput {
  executionId: string; issueId: string; projectName: string;
  stateStoreStatus: string | undefined;
  tmuxWindow: string;
  killed: boolean;
  daemon: { outcome: "not_codex" | "reaped" | "absent" | "residual" | "unverifiable" };
  openCommDb: (projectName: string) => { markDeadSessionTerminal: CommDB["markDeadSessionTerminal"]; close(): void } | undefined;
  insertEvent: StateStore["insertEvent"];
  now?: () => number;
}
export type StampOutcome =
  | { stamped: true; status: "completed" | "failed" | "blocked" }
  | { stamped: false; reason: "kill_failed" | `daemon_${"residual"|"unverifiable"}` | "state_store_non_terminal" | MarkDeadSessionTerminalResult["reason"] | "commdb_unavailable" | "error" };

/** Never throws. Records exactly one audit event per call. */
export function stampCommDbAfterTmuxClose(input: StampAfterTmuxCloseInput): StampOutcome
```
判定顺序(research R4):`!killed` → `kill_failed`;daemon residual/unverifiable → `daemon_*`;`commDbTerminalStatusFor(stateStoreStatus)` 为空 → `state_store_non_terminal`;
`openCommDb` 返回空 → `commdb_unavailable`;调 `markDeadSessionTerminal`;try/catch 兜 `error`;`finally close()`。
审计:`insertEvent({event_id: \`commdb-stamp-close-tmux-${executionId}-${now()}\`, event_type: stamped ? "commdb_terminal_stamped" : "commdb_terminal_stamp_skipped", source: "bridge.close-tmux", payload: {tmuxWindow, status?|reason, daemon: daemon.outcome}})`。

### 1.3 `packages/teamlead/src/bridge/plugin.ts` —— close-tmux 端点接线(`:3226-3316`)

在 `const result = await killTmuxWindow(target.tmuxWindow);` 之后、现有 `store.insertEvent({... tmux_closed ...})` 之前插入:
```ts
// FLY-2498: a proven-dead body's registry row must not stay `running`.
const reap = reapOutcome;   // 把上面 `await reapCodexDaemonForSession(...)` 的返回值存进变量(现在被丢弃)
stampCommDbAfterTmuxClose({
  executionId, issueId: session.issue_id, projectName: session.project_name,
  stateStoreStatus: session.status, tmuxWindow: target.tmuxWindow,
  killed: result.killed, daemon: reap,
  openCommDb: (p) => { const path = resolveCommDbPath(p); return path ? new CommDB(path, false) : undefined; },
  insertEvent: (e) => store.insertEvent(e),
});
```
`reapCodexDaemonForSession` 的返回值已是 `CodexDaemonTeardownResult`(`not_codex` 或 `CodexDaemonReapResult`),直接传。
`resolveCommDbPath` 从 `./commdb-session-prune.js` 已导出;`CommDB` 已在 plugin.ts 引入(核一下,没有就加)。
**不改**:状态守卫、matchesLead、reap/cmux/kill 顺序、响应体。

### 1.4 `packages/teamlead/src/bridge/commdb-session-prune.ts` —— 清扫加「盖戳相」

`pruneDeadTerminalCommDbSessions(projectName, opts)`:
- `opts` 新增(全部可选):
  ```ts
  /** FLY-2498: StateStore-authoritative status; absent ⇒ stamp phase is a no-op. */
  getAuthoritativeStatus?: (executionId: string) => string | undefined;
  /** FLY-2498: family-aware execution liveness; absent ⇒ stamp phase is a no-op. */
  probeExecutionLiveness?: (executionId: string, projectName: string) => Promise<"alive" | "dead" | "unknown">;
  onStampOutcome?: (executionId: string, projectName: string, outcome: StampOutcome) => void;
  ```
- `CommDbPruneResult` 新增 `stamped: number`(默认 0)。
- 在 `const terminal = db.listSessions(...)` **之前**执行盖戳相(仅当两个依赖都注入):
  ```
  for s of db.listSessions(projectName, ["running"]):
    if s.tmux_window.endsWith(":pending") → continue
    status = commDbTerminalStatusFor(getAuthoritativeStatus(s.execution_id)); if !status → continue   // 不探进程
    live = await probeExecutionLiveness(s.execution_id, projectName); if live !== "dead" → continue
    r = db.markDeadSessionTerminal(s.execution_id, s.tmux_window, status)
    onStampOutcome?.(…); if r.stamped → result.stamped++
  ```
  单行 try/catch:异常 `console.warn('[commdb-prune] stamp …')` 后 continue。
- 盖戳相结束后照旧 `listSessions(projectName, [终态…])`:刚盖戳的行自然进入终态扫描,同轮按既有 sweep 规则(窗口探针 dead ∧ 非 TURN 持有者 ∧ 非 parked)删除。
- 审计回调:`onStampOutcome` 写 `session_events`(`commdb_terminal_stamped` / `commdb_terminal_stamp_skipped`,`source: "bridge.commdb-terminal-prune"`),
  与 1.2 同种类、同 payload 形状;skip 也记(便于 QA 证明没有静默跳过)。为避免每小时对同一活体重复写 skipped 事件,**清扫路径只对 `stamped` 与
  `markDeadSessionTerminal` 的拒绝原因记事件;`state_store_non_terminal` 与探针 `alive/unknown` 不记事件**(它们是常态,只进计数与日志)。

### 1.5 `packages/teamlead/src/bridge/plugin.ts` —— 清扫注入(`:6665 pruneResidueCommDb`)

```ts
const pruned = await pruneDeadTerminalCommDbSessions(projectName, {
  includeCrashPreserve: true,
  onFinalizeOutcome: recordResidueFinalizeOutcome,
  // FLY-2498
  getAuthoritativeStatus: (id) => store.getSession(id)?.status,
  probeExecutionLiveness: async (id, p) => {
    const { probeRunExecutionLiveness } = await import("./run-quiescence.js");
    return probeRunExecutionLiveness(store.getSession(id), id, p);
  },
  onStampOutcome: (id, p, outcome) => store.insertEvent({ event_id: `commdb-stamp-prune-${id}-${Date.now()}`, execution_id: id,
    issue_id: store.getSession(id)?.issue_id ?? id, project_name: p,
    event_type: outcome.stamped ? "commdb_terminal_stamped" : "commdb_terminal_stamp_skipped",
    source: "bridge.commdb-terminal-prune", payload: outcome }),
});
if (pruned.pruned > 0 || pruned.stamped > 0) console.log(`[Bridge] CommDB terminal prune (${projectName}): scanned=… pruned=… kept=… stamped=${pruned.stamped}`);
```
`probeRunExecutionLiveness` 返回 `GeneralizedLaunchLiveness`;若其词表不止 `alive|dead|unknown`,按 `plugin.ts:7574-7578` 同款折叠。

### 1.6 稳定标识与显示

| 项 | 值 | 说明 |
|---|---|---|
| 事件种类 | `commdb_terminal_stamped` / `commdb_terminal_stamp_skipped` | `session_events.event_type`,新;不进 alert kind 合同(不发 Discord) |
| 事件来源 | `bridge.close-tmux` / `bridge.commdb-terminal-prune` | 后者与 FLY-2302 的 `recordResidueFinalizeOutcome` 同值 |
| payload | `{tmuxWindow, status}` 或 `{tmuxWindow, reason, daemon?}` | 只含 id/状态词,无自由文本 |
| 日志 | `[Bridge] CommDB terminal prune (<project>): scanned= pruned= kept= stamped=` | 追加一个字段;现有 grep 该行的测试若断言整行需同步 |
| CommDB status 值 | `completed` / `failed` / `blocked` | 既有 `CHECK` 词表内;不新增 |

### 1.7 迁移 / 回滚边界

- **无 schema 迁移**;无 flag。存量残留(今天的 `1492b1f6` 与 4 具新体)由部署后第一次 boot 清扫的盖戳相收敛(StateStore completed ∧ 探针 dead),
  下一轮(≤1h)删行;巡检 STEP 1 随即无 `MISSING_PANE`。
- **回滚**:revert 本 PR 即回到「不盖戳」;已盖的行是合法终态行,回滚后按旧清扫规则(sweep 模式对 parked 已清的行)正常删除,无残留状态需要修复。
- **单文件可退**:1.3 与 1.5 各自是一处注入;拿掉任一处,另一路径仍独立生效。

## 2. 测试(TDD:先红后绿)

### 2.1 `packages/flywheel-comm/src/__tests__/db.fly2498-mark-dead-terminal.test.ts`(新,真临时 sqlite)
1. running + doorbell pending + parked 声明 → `markDeadSessionTerminal(id, win, "completed")` ⇒ `{stamped:true}`;行 `completed` + `ended_at` 非空;
   `runner_phase_wakes` 该 doorbell `state='finished'` 且 `last_push_result='disposed:terminal_target'`;`getEffectiveDeclaredState` 为 null。
2. `:pending` 目标 ⇒ `pending_target`,零写(status/ended_at/声明全部不变)。
3. 目标不符(`expected` ≠ 行)⇒ `target_changed`,零写。
4. 行已 `completed`(先 `updateSessionStatus`)⇒ `not_running`,`ended_at` 不被改写。
5. 无行 ⇒ `no_row`。
6. `"failed"` / `"blocked"` 映射写入对应值;之后 `markSessionTerminalStatus` 同值再写不改变 `ended_at`(与 FLY-1066 幂等相容)。
7. 同一 exec 的 `three_stage_turn` 持有者不影响盖戳(盖戳不是 DELETE)。

### 2.2 `packages/teamlead/src/bridge/__tests__/commdb-terminal-stamp.test.ts`(新,纯函数)
- `commDbTerminalStatusFor`:completed/terminated/rejected/deferred/shelved/approved → completed;failed/blocked → 同名;
  running/awaiting_review/approved_to_ship/design_done/ship_parked/undefined → undefined。
- `stampCommDbAfterTmuxClose` 六分支(research R8):killed+absent+completed ⇒ stamped 且事件 `commdb_terminal_stamped`;killed+`residual` ⇒ `daemon_residual`;
  `killed:false` ⇒ `kill_failed`(不开库);StateStore `awaiting_review` ⇒ `state_store_non_terminal`(不开库);CAS `target_changed` ⇒ skipped;
  `openCommDb` 抛 ⇒ `error` 且不抛出、`close` 不被调用;每分支恰好一条 `insertEvent`。

### 2.3 `packages/teamlead/src/__tests__/commdb-session-prune.test.ts` —— 追加 `describe("FLY-2498 stamp phase")`
沿用现有 harness(真 comm.db + `seed()` + 注入 `probe`),新增注入 `getAuthoritativeStatus` / `probeExecutionLiveness`:
1. **未注入 ⇒ 逐字节不变**:running 行照旧不被扫描,`stamped=0`;现有 8 组 `pruneDeadTerminalCommDbSessions` 用例原样绿(门槛)。
2. running + StateStore completed + 执行探针 dead + 窗口探针 dead ⇒ 同轮 `stamped=1`、`pruned=1`、行消失、`onStampOutcome` 收到 stamped。
3. running + StateStore running ⇒ 不调执行探针(用 `vi.fn` 断言 0 次)、`stamped=0`。
4. running + StateStore completed + 执行探针 alive / unknown ⇒ `stamped=0`,行不变。
5. `:pending` running 行 ⇒ 跳过,不探。
6. 带 parked 声明的 running 行,StateStore completed,探针 dead ⇒ 声明被清、同轮删除(对照:FLY-1329 用例 `keeps a parked blocked row` 原样绿)。
7. TURN 持有者 ⇒ `stamped=1`、`pruned=0`(`kept_turn_holder`),下一轮 TURN 释放后删除。
8. 执行探针抛异常 ⇒ 该行跳过、其余行继续、结果不抛。

### 2.4 shell 套件与不变声明
- `bash scripts/__tests__/lead-patrol-snapshot.test.sh` 原样绿(需先 `pnpm -r build`,同 FLY-2302 §2.5)。
- `packages/teamlead/src/__tests__/founder-consent-integration.test.ts` 原样绿(stub 路由不受影响)。

### 2.5 运行命令(实现方交付前逐条跑,PR test plan 贴输出)

```bash
pnpm -r build
pnpm --filter flywheel-comm exec vitest run src/__tests__/db.fly2498-mark-dead-terminal.test.ts
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/commdb-session-prune.test.ts \
  src/bridge/__tests__/commdb-terminal-stamp.test.ts \
  src/bridge/__tests__/commdb-session-prune.fly1329-parked-veto.test.ts \
  src/bridge/__tests__/commdb-residue-layer-interaction.test.ts \
  src/bridge/__tests__/workflow-engine.fly2302-dead-body-commdb.test.ts \
  src/__tests__/founder-consent-integration.test.ts
bash scripts/__tests__/lead-patrol-snapshot.test.sh
pnpm --filter flywheel-comm test && pnpm --filter flywheel-teamlead test   # 全量;排除 **/tmux-viewer.macos.test.ts
pnpm biome check packages/flywheel-comm/src/db.ts packages/teamlead/src/bridge/commdb-terminal-stamp.ts \
  packages/teamlead/src/bridge/commdb-session-prune.ts packages/teamlead/src/bridge/plugin.ts
```

## 3. 验收(QA 节点按此核)

| # | 断言 | 证据 |
|---|---|---|
| A1 | 隔离 Bridge(`FLYWHEEL_STATE_DIR` / `FLYWHEEL_COMM_DIR` 指向临时目录)里复现:Codex 设计体 `complete --route phase_design_complete` 后 StateStore completed、CommDB running+ka=1、声明 parked;对它 `POST /api/sessions/:id/close-tmux` ⇒ 响应 `{closed:true}`,CommDB 行 **≤1 s** 内 `completed` + `ended_at`,声明清空,`session_events` 有 `commdb_terminal_stamped source=bridge.close-tmux` | 隔离 comm.db / teamlead.db 前后 `SELECT` |
| A2 | A1 之后跑一次巡检快照 ⇒ STEP 1 无该 target 的 `ROSTER_EVIDENCE … findings=MISSING_PANE`(行已不在 owner index) | `lead-patrol-snapshot.sh` 输出 |
| A3 | 同环境:StateStore `awaiting_review`(FLY-44 守卫拦下,409)与 StateStore `completed` 但 daemon `residual` 的体 ⇒ CommDB 行仍 running,事件为 `commdb_terminal_stamp_skipped` 且 reason 正确 | 同上 |
| A4 | 存量形状:手工造「running + StateStore completed + 窗口不在 + daemon 不在」行(或对生产 `1492b1f6` 现状),触发一次清扫(boot 或每小时)⇒ `stamped=1`;下一轮 `pruned=1`;之间巡检无 MISSING_PANE | Bridge 日志 `stamped=` + 两轮 `SELECT` |
| A5 | 阴性对照:活着停驻的 Codex 设计体(窗口在、daemon 在、StateStore completed、声明 parked)经过两轮清扫 ⇒ 行仍 running、声明仍在、`stamped=0`;phase 唤醒 `send --to <exec>` 仍可达 | 同上 |
| A6 | Claude 车道设计体 completed 路径不变:适配器自己写 completed,清扫按旧规则删,本单代码路径 `stamped=0` | 单测 2.3-1 + 隔离环境一具 Claude 体 |
| A7 | §2.5 全部命令绿,且 PR 的 exact head 上 CI 绿 | CI 链接 |

## 4. 已知限制(本版不做)

- L1 `phase_shutdown_controller_lease_stale_live_pane` 让 close-runner 受控关停对本形状拒绝,是 Lead 退而用 close-tmux 的直接原因;本单不改 FLY-1269 的 fail-closed(另开 issue)。
- L2 `codex_app_server_orphan_identity_mismatch` 每 5 分钟一条的 reaper 噪音(台账有、CODEX_HOME 清单无)是另一形状,不在本单。
- L3 两条 2026-08 的 `runner-flywheel:pending` running 行(`35f0dbf9`/`296488f3`)本单明确跳过。
- L4 StateStore 非终态但窗口已死的体(如 legacy `design_done` 持有者被 close-tmux)不盖戳,留给 FLY-1204 alert + `close_runner --done`。
- L5 盖戳后到删除之间(≤1h)`runner_terminal_list` 会以 dead-class 显示该行,与 Claude 体现状一致。

## 5. Follow-ups(评审 advisory 留档处,本版不修)

(评审轮次填充)
