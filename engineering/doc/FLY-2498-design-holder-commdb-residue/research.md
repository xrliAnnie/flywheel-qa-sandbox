# FLY-2498 设计体交接后 CommDB 注册行永不终结 — 调研

Issue: FLY-2498 (https://linear.app/geoforge3d/issue/FLY-2498/病根-eng-design-交接后-bridge-会话已-completedcommdb-sessions-行仍-statusrunning)
日期: 2026-09-11
基于: exploration.md

exploration.md 选定 A(close-tmux 杀窗成功后 CAS 盖终态)+ B(清扫增加盖戳相做收敛网),两者共用一个 CommDB 原语。
本文逐条核实两条路径各自依赖的事实,并把「证据、词表、原语、审计、测试缝」钉死。

## R1. 「执行已死」两条路径各用什么证据

**close-tmux 端点**(`plugin.ts:3226-3316`)在杀窗前后手里已经有:
- `reapCodexDaemonForSession(store, session, "bridge.close-tmux")` → `CodexDaemonTeardownResult`:
  `{outcome:"not_codex"}`(非 Codex 体)或 `CodexDaemonReapResult.outcome ∈ reaped|absent|residual|unverifiable`
  (`codex-daemon-teardown.ts:12-15`,`codex-daemon-runtime.ts:113-117`)。`residual/unverifiable` 已经会写
  `exec_host_processes_residual` + `lead_close_runner_failed(cleanupPending)`。
- `killTmuxWindow(target.tmuxWindow)` → `{killed:boolean, error?}`(`tmux-lookup.ts:979`);`:pending` 目标直接
  `killed:false`。`killed:true` = 审计守卫放行且 `tmux kill-window` 成功;窗口本来就不存在时 `result.kind` 走
  benign 分支(需实现方核 `tmux-lookup.ts:1040+` 的 already-dead 映射 —— 若 already-dead 也返回 `killed:true`,
  盖戳同样成立:窗口不在 + daemon 不在 = 死)。

**死亡证明(close-tmux 路径)** := `result.killed === true` ∧ daemon 结果 ∈ {`not_codex`, `reaped`, `absent`}。
`residual/unverifiable` ⇒ 不盖(体可能还活;已有告警事件)。这与 close-runner 的 `canDeleteSessionIdentity = res.killed || runnerDeathProven`
(`close-runner.ts:951`)同向但更严(多要 daemon 结论),因为 close-tmux 在 close-runner 之前就把 daemon 收了。

**清扫路径**用 `probeRunExecutionLiveness(session, executionId, projectName)`(`run-quiescence.ts:26-45`):Codex 体先
`probeCodexDaemonLiveness`(alive/unknown 直接返回),再 `probeGeneralizedLaunchLiveness(..., {allowMissingTargetHostAbsence:true})`。
返回 `alive | dead | unknown`;只有 `dead` 盖戳。这正是引擎「严格静默门」用来回滚死体的同一探针(`plugin.ts:7564-7573` 同款调用),
比 FLY-1329 parked-veto 防的「只探 tmux 窗口名」强一级。

## R2. StateStore 终态词表与状态映射

单一来源 `flywheel-comm/session-terminal`(`packages/flywheel-comm/src/session-terminal.ts`):
`OUTCOME_STATUSES = completed|approved|approved_to_ship|blocked|failed|rejected|deferred|shelved|terminated`;
`TERMINAL_STATUSES = OUTCOME − approved_to_ship + awaiting_review`;
`isMailboxTerminalStatus(s) = TERMINAL_STATUSES.has(s) && s !== "awaiting_review"`。

`awaiting_review` 的体是驻留活体(mailbox 要能送达),`approved_to_ship` 还要 ship —— 都不能盖。所以**盖戳门 = `isMailboxTerminalStatus`**。
映射到 CommDB `status` 词表(`types.ts:105`:running|completed|timeout|blocked|failed):

| StateStore | CommDB | 备注 |
|---|---|---|
| failed | failed | 与 FLY-1066 镜像同名;大多数情况镜像已先写,CAS 0 行即幂等 |
| blocked | blocked | 同上 |
| completed / approved / rejected / deferred / shelved / terminated | completed | Claude 适配器 `finally` 也是这样写的(`TmuxAdapter.ts:1130`,只分 completed/timeout) |

不引入新词(`terminated` 等不进 CommDB `CHECK`);不写 `timeout`(那是适配器对自己超时的申报)。

## R3. CommDB 原语:一条 CAS,两处调用

现有最接近的是 FLY-2313 提升 CAS(`db.ts:8318-8333`),但它嵌在 `finalizeSessionCommunications` 里、只接受 failed/blocked、
且带 TURN/parked/founder-wake 否决(那些否决是为 DELETE 设的)。盖戳不删身份,所以新开一个公开方法:

```ts
/** FLY-2498: a proven-dead execution's still-`running` registry row gets its terminal
 *  stamp without losing identity. Exact-target CAS; zero writes on any drift. */
markDeadSessionTerminal(
  executionId: string,
  expectedTmuxWindow: string,
  status: "completed" | "failed" | "blocked",
): { stamped: true } | { stamped: false; reason: "no_row" | "target_changed" | "not_running" | "pending_target" }
```
事务(`.immediate()`,与 `updateSessionStatusIfRunning` 同款):
1. `SELECT tmux_window, status, ended_at FROM sessions WHERE execution_id = ?` → 无行 `no_row`;
   `tmux_window LIKE '%:pending'` → `pending_target`;`tmux_window !== expected` → `target_changed`;
   `status !== 'running' || ended_at` → `not_running`。
2. `UPDATE sessions SET status=?, ended_at=datetime('now') WHERE execution_id=? AND tmux_window=? AND status='running' AND ended_at IS NULL`,
   `changes !== 1` → `target_changed`(并发漂移)。
3. `disposeRunnerDoorbellsForTerminal(executionId, now)`(`db.ts:8046-8060`:把该体 pending/started 的 doorbell 置 finished,
   `last_push_result='disposed:terminal_target'`)—— 与适配器自己写终态时完全一致。
4. `DELETE FROM runner_declared_states WHERE execution_id = ?`(即 `clearDeclaredState`,`db.ts:6197`)。

**为什么第 4 步必须有**:六具体里 4 具带 `kind=parked` 声明且无 `expires_at`(exploration §1.3/§1.4)。若只盖 status,
下一轮清扫在 sweep 模式对「parked 且窗口不可解析」返回 `kept_parked`(`commdb-session-prune.ts:342-349`,FLY-1329 形状),
`finalizeSessionCommunications` 也以 `parked` 否决(`db.ts:8300`)—— 行永远删不掉,只是从 MISSING_PANE 换成 dead-class 残留。
parked 是活进程对自己的声明;两条路径都先拿到了比 FLY-1329 更强的死亡证明(R1),声明随之失效。清扫的 parked veto
本身**不改**:它保护的是「探针只说窗口没了」的弱证据场景。

不动 `registerSession` upsert:体若被重新拥有/复活会 `INSERT … ON CONFLICT` 或 `db.ts:7941` 那条 `SET status='running', ended_at=NULL`
路径重新翻回 running,与盖戳互不干扰。

## R4. close-tmux 端点的接法与负向守卫

在 `plugin.ts:3300` `killTmuxWindow` 之后、`insertEvent(tmux_closed)` 之前(或之后,顺序不重要,都是 best-effort)加一段:

```
if (result.killed && daemonDead(reap) ) {
  if (!isMailboxTerminalStatus(session.status)) → event commdb_terminal_stamp_skipped reason=state_store_non_terminal
  else CAS markDeadSessionTerminal(executionId, target.tmuxWindow, mapStatus(session.status))
       → stamped: event commdb_terminal_stamped {tmuxWindow, status}
       → not stamped: event commdb_terminal_stamp_skipped {reason}
} else → event commdb_terminal_stamp_skipped reason=kill_failed | daemon_<outcome>
```
- CommDB 打开:`resolveCommDbPath(session.project_name)`(`commdb-session-prune.ts:41-45`,已做路径穿越守卫)→ `new CommDB(path,false)`,
  用完 `close()`;任何异常 `console.warn` + `commdb_terminal_stamp_skipped reason=error`,**响应仍是 `{closed:true}`**。
- `session.status` 取杀窗前读到的那份(`store.getSession` 在 handler 顶部);FLY-44 守卫已保证它不是 running 家族。
- `leadId` 缺省 `unknown` 照旧写进 payload。
- 不改 FLY-44 状态守卫、不改 founder-consent 中间件、不改响应体形状(`{closed, error}`),现有 `founder-consent-integration.test.ts` 的
  stub 路由不受影响。

## R5. 清扫的盖戳相:放在哪、扫什么、成本

`pruneDeadTerminalCommDbSessions(projectName, opts)`(`commdb-session-prune.ts:514`)目前 `listSessions(project, [终态…])`。
在它**开头**加一相(先盖后删,同一次开库):

```
running = db.listSessions(projectName, ["running"])
for s of running:
  if s.tmux_window ends with ":pending" → skip(counter pendingSkipped)
  auth = opts.getAuthoritativeStatus?.(s.execution_id)   // StateStore status
  if auth === undefined || !isMailboxTerminalStatus(auth) → skip(counter runningKeptNonTerminal)
  live = await opts.probeExecutionLiveness(s.execution_id, projectName)   // R1 清扫探针
  if live !== "dead" → skip(counter runningKeptAlive / runningKeptUnknown)
  r = db.markDeadSessionTerminal(s.execution_id, s.tmux_window, mapStatus(auth))
  r.stamped → counter stamped, opts.onStampOutcome?.(…);  push s 进本轮终态扫描集
```
- 两个新依赖都是**可选注入**:`getAuthoritativeStatus` 与 `probeExecutionLiveness` 任一缺席 ⇒ 盖戳相整体 no-op
  (现有 8 组 prune 单测不注入,行为逐字节不变)。生产在 `plugin.ts:6665 pruneResidueCommDb` 处注入
  `(id) => store.getSession(id)?.status` 与 `(id, p) => probeRunExecutionLiveness(store.getSession(id), id, p)`。
- 盖了戳的行**同一轮**进入既有终态扫描(`finalizeDeadTerminalCommDbSession` sweep 模式):窗口探针 dead、声明已清、非 TURN 持有者 ⇒ 当轮删除;
  是 TURN 持有者 ⇒ `kept_turn_holder`,下一轮再来(与 FLY-2302 同)。
- 成本:每小时 + boot,每个 `running` 行一次 StateStore 内存查询;只有 StateStore 终态的行才探进程(今天生产 19 行 running 里 5 行满足)。
- `CommDbPruneResult` 加 `stamped` 计数;日志行 `[Bridge] CommDB terminal prune (...)` 追加 `stamped=`。
- 调度不变:`residue-harvest.ts:67 pruneTerminalCommDb` 每小时(`residueMaintenanceEveryNTicks`)+ boot(`runResidueAwareBootSweep`)。

## R6. 审计与可观测

- 新 `session_events` 种类(`insertEvent` 无白名单,`StateStore.ts:22304` 的 `commdb_ask_disposed` 同法):
  `commdb_terminal_stamped {tmuxWindow, status, source}` / `commdb_terminal_stamp_skipped {reason, source}`,
  `source ∈ bridge.close-tmux | bridge.commdb-terminal-prune`。清扫路径通过 `opts.onStampOutcome` 回调写,与 `onFinalizeOutcome` 同形。
- event_id 用 `commdb-stamp-<source>-<exec>-<Date.now()>`(每次动作一条;skip 也记,便于 QA 反证「没有静默跳过」)。

## R7. 与其他机制的相互作用(逐一核过)

| 机制 | 盖戳后的行为 | 判定 |
|---|---|---|
| Lead 巡检 owner index(`status IN running,blocked`) | `completed` 行退出名册 ⇒ MISSING_PANE 消失;`failed/blocked` 映射行仍在名册 —— 但那是 Claude 取证现场合同(FLY-2302 方案 B 否决理由),Codex failed/blocked 体窗口已被适配器 kill,其行会被 FLY-2302/每小时清扫删 | 符合 FLY-2302 不变量 7 |
| phase 唤醒门栓(`assertPhaseKeepAliveSessionRunning` / `db.ts:4516`) | 死体不再 running ⇒ `send`/wake 对它 fail-fast,而不是投给死体 | 改善 |
| FLY-1204 停驻体回收 | 只看 StateStore + 活体探针,不看 CommDB status | 无影响 |
| post-ship `closeRunner("DAG workflow ship finalization")` | `finalizeCommDbSession` full 模式不看 status(`finalizeSessionEffects(…, true)`);行若已被清扫删掉 ⇒ `no_session_row_communications_finalized`(FLY-2302 research §2.3 已核) | 无影响 |
| FLY-1066 `terminal-commdb-sync` | 对 failed/blocked 先到者赢,后到者 CAS 0 行 | 幂等 |
| `runner_terminal_list` parked-alive 检测(`db.ts:8543`) | 盖戳行 `ended_at` 有值 ⇒ 按 dead-class 显示,一小时内被删 | 与 Claude 体同 |
| 两条 2026-08 `:pending` running 残留 | 明确跳过 | 不在本单 |
| Codex 适配器 `updateSessionStatusIfRunning` | 若适配器先写(受控关停)⇒ 我们 CAS 0 行;若我们先写(体已死)⇒ 适配器 `AND status='running'` 0 行 | 互不覆盖 |

## R8. 测试缝

- `packages/flywheel-comm`:`db.ts` 新方法 → 新增 `src/__tests__/db.fly2498-mark-dead-terminal.test.ts`(真 sqlite 临时库):
  running→completed 成功 + doorbell finished + declared state 清;`:pending` 拒;目标不符拒;已终态 0 行;failed/blocked 映射。
- `packages/teamlead/src/__tests__/commdb-session-prune.test.ts` 现有 harness(真 comm.db + 注入探针,`:21-47 seed()`):
  追加 `describe("FLY-2498 stamp phase")`:未注入 ⇒ 逐字节不变(现有 8 组原样绿是门槛);注入后 running+StateStore completed+dead ⇒ 当轮 stamped=1 pruned=1;
  StateStore running ⇒ 不探不盖;probe alive/unknown ⇒ 不盖;`:pending` ⇒ 不盖;parked 声明被清后能删;TURN 持有者 ⇒ stamped=1 pruned=0。
- close-tmux handler 目前**无**真 handler 测试(`founder-consent-integration.test.ts:119` 是 stub 路由)。新增
  `packages/teamlead/src/bridge/__tests__/close-tmux.fly2498-commdb-stamp.test.ts`:把 handler 的盖戳段抽成纯函数
  `stampCommDbAfterTmuxClose({session, target, killed, daemon, openCommDb, insertEvent})` 单测六种分支(killed+absent+completed ⇒ stamped;
  killed+residual ⇒ skipped;kill 失败 ⇒ skipped;StateStore awaiting_review ⇒ skipped(FLY-44 守卫外的双保险);CAS target_changed ⇒ skipped;
  CommDB 打开异常 ⇒ skipped 且不抛)。
- `bash scripts/__tests__/lead-patrol-snapshot.test.sh` 原样绿(不改脚本,只证没碰)。
- 生产验收(QA 节点):对 `1492b1f6` 现状(StateStore completed、窗口 `@2998` 不在、pgid 56544 不在)跑一次盖戳相 ⇒ 行变 completed+ended_at、
  声明清空;下一轮清扫删行;巡检快照 STEP 1 无 `MISSING_PANE`。若 QA 时该行已被人工处理,用 529 房复现同形状。

## R9. 未核实项

- `killTmuxWindow` 对「窗口本来就不在」返回 `killed:true` 还是 `false`(`tmux-lookup.ts:1040+` benign 分支)—— 两种结果盖戳逻辑都成立,实现方核一次并在测试里定死。
- `probeGeneralizedLaunchLiveness` 对 Claude 车道体的 `dead` 判定细节未展开(本单主要形状是 Codex 体;Claude 体本就由适配器盖戳)。
