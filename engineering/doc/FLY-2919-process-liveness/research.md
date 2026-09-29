# FLY-2919 进程生死单一真源 — 调研
Issue: FLY-2919 (https://linear.app/geoforge3d/issue/FLY-2919/病根修复-2-体的生死只认一个真源死体当场终结活体不再按窗口判死9-张-68)
日期: 2026-09-28
基于: exploration.md

审计基线: 本 checkout `1855f7a1a`（沙箱 main）。行号以此为准；实现时用符号查找，禁止凭行号直接改。对照基线（仅用于落 Lead 义务）: 上游 mainline `55eab0862` 与 `origin/flywheel-FLY-2919` 头 `d54df3bb8`，只用 `git show` 只读读取。

## 1. 探针清单（`packages/teamlead/src/bridge/tmux-lookup.ts`）

所有 tmux 调用超时 5 s（`TMUX_TIMEOUT`，:20）。`isTmuxAbsenceMessage`（:248-257）把 `session not found` / `can't find window` / `no server running` 等消息判为「确证不在」。

| 函数（行） | 证据来源 | 返回 | 失败映射 | 本单定性 |
|---|---|---|---|---|
| `lookupTmuxTarget`（:164） | CommDB `sessions.tmux_window` | `found / gone / error` | 无 DB、无 tmux_window → `gone`；DB 抛错 → `error` | 目标定位，保留 |
| `probeTmuxWindowLiveness`（:298） | `tmux list-panes -t <window>` 是否成功 | `alive / dead / indeterminate` | 缺失消息 → `dead`；其他错 → `indeterminate` | **只证明窗口存在**，降级为 windowState |
| `isTmuxWindowAlive`（:331） | 同上 | `boolean` | 任何错 → `false`；`remain-on-exit` 死 pane 仍 `true` | 同上 |
| `probeRunnerProcessLiveness`（:371） | `tmux list-panes -F '#{pane_dead}'` | `alive / dead_pin / absent / indeterminate` | 缺窗 → `absent` | **名不副实**：只看 pane，不看 pid；重命名/注释为窗口观察，致死消费者全部迁走 |

本树里唯一真正看进程的代码：`packages/claude-runner/src/codex-daemon-runtime.ts:798`（`defaultIsPidAlive`，锁回收）以及 :300-305 的注释——`kill(shimPid,0)` 对 app-server 孙进程会误报死，所以它改用 socket 验证。fleet-console/fleet-data/review lease 的 `kill(pid,0)` 与 Runner 生死无关。`runner-teardown.ts:33` 读 `#{pane_pid}` 只用于 teardown。

**没有任何 Runner 死亡路径直接看进程**——这是本单要改的根。

## 2. 死亡决策路径（`HeartbeatService.ts`，每 tick 顺序）

`check()`（:399-470）每 `TEAMLEAD_STUCK_INTERVAL`（默认 300 s，`config.ts:148-152`）一轮：`retryUndeliveredGuardrailEvents → reconcileMonitorLoss → serverLoss.check → reapCrashedRunners → checkStuck → reapOrphans → checkStaleCompleted → checkStaleParkedPhases → checkAwaitingReviewTimeout`。stuck 阈值 15 min、orphan 阈值 60 min（`config.ts:37-50`），stale/parked 巡检节流 6 h（:279）。

候选集全部从 `status='running'` 起：`getOrphanSessions`（StateStore :4005-4007）、`getStuckSessions`（:3624-3626）。**这就是「非终态停留豁免」的结构来源**：`awaiting_review / approved_to_ship / design_done` 里的死体不进任何死亡候选。

| # | 决策者 | 证据 | 豁免/跳过 | 动作 | 本单处置 |
|---|---|---|---|---|---|
| 1 | `reconcileMonitorLoss`（:597；readopt 路径 :673-749） | 先 `tryReconcileComplete`（marker），再 `isSessionTmuxAlive`（:921-948）：`lookupTmuxTarget` gone→false、error→**true**；`probeRunnerProcessLiveness` alive/indeterminate→true，dead_pin/absent→false；`FLYWHEEL_LIVENESS_PANE_DEAD=0` 时退回 `isTmuxWindowAlive` | marker `transient_failed` → `markerRetryPending` | 活：`enterReconnecting` + `updateHeartbeat`（**tmux 存在算心跳**，:798）；死：移出抑制集，交后续 reap | 改读 BodyObservation；tmux 存在不再算心跳 |
| 2 | `ServerLossCoordinator`（`server-loss.ts`，接线 `plugin.ts:7803-7840`） | `probeTmuxServer` down；boot 时 `targetGone` = lookup + pane 探针 absent/dead_pin | `FLYWHEEL_FLEET_SENSOR_TMUX=0` | `applyTransition → failed`（`server_loss`） | 服务损失只触发进程采样，不直接 failed |
| 3 | `reapCrashedRunners`（`crash-reaper.ts:166-247`） | `getOrphanSessions` → lookup → `probeRunnerProcessLiveness`；只认 `dead_pin` | 跳 `isMonitorSuppressed \|\| markerRetryPending`（:1730）、`hasPendingCompleteMarker`（:190）、lookup error/gone、alive、indeterminate、**absent 交给 #4** | grace 后 scrollback → kill window → CommDB finalize → `terminated`（`crash_reap`）；开关 `FLYWHEEL_CRASH_REAPER` | 证据改 BodyObservation.dead；保留 marker-first 与 grace |
| 4 | `reapOrphans`（:1753-1826） | **只看心跳陈旧，不探针**（:1771-1774） | 跳 `deadPinOwned`、`serverLossOwned`、`isMonitorSuppressed`、`markerRetryPending`、`notifiedOrphans` | `applyTransition → failed`（`orphan_reap`），**无 teardown** | 这是 FLY-2618 的「活体 force-failed」出口：窗口 absent 被 #1 判死 → 不进 reconnecting → 心跳陈旧 → failed。改为：仅 `BodyObservation.dead` 才 failed；alive/unknown 只告警 |
| 5 | `checkStuck`（:1002-1155） | `getStuckSessions` + 可选 pane confirm（`plugin.ts:5530`） | `classifyQuiet`（`quiet-classifier.ts:67-93`）：parked/long_task/pending_gate/recent_comm/review_signal | 只告警 `session_stuck` | 不动（非致死） |
| 6 | `checkStaleCompleted`（:1209-1287） | `getStaleCompletedSessions`（completed/failed/blocked）+ `isTmuxWindowAlive` | `isRetestProtected`（:1685-1711）；`FLYWHEEL_STALE_TERMINAL_CLOSE` | `closeRunner(forcePreserved)` | 候选改「身体仍活」而非「窗口仍在」（FLY-2512 终态活体） |
| 7 | `checkStaleParkedPhases`（:1304-1411）/ `computeIssueReclaimVerdict`（:1429-1469） | `getParkedPhaseCandidates`（角色 design/implement/qa；状态 design_done/completed/awaiting_review/approved_to_ship/running；StateStore :3465-3471）→ `declaredStateIsParked`（:1561-1579）→ `probePhaseLiveness`（:1588-1605：gone→dead、alive→alive、indeterminate→defer、其余 dead） | 无 ship claim 的非终态 parked 候选**只告警**（:1466） | 有 claim 或 completed 超 `FLYWHEEL_PARKED_PHASE_STALE_HOURS` 才 close | 「确证死」的候选不再豁免；alive 的仍按原 parked 巡检 |
| 8 | `checkAwaitingReviewTimeout`（:491-554） | 48 h 时间 | — | `gate_timed_out`，明言 NOT killed（:528） | 不动；死体不靠这条 |
| 9 | `scanZombies`（`zombie-scan.ts:68-111`） | CommDB running vs StateStore；shape ③ 需 heartbeat ≥24 h 陈旧 + pane absent/dead_pin | indeterminate 不计 | 只检测告警 | targetAlive 改 BodyObservation；分类新增 `window_missing_body_alive` |

## 3. 换体前置（本树只有 retry 路径，无上游的 dispatcher/铸替身器）

- `ACTION_SOURCE_STATUS.retry = ["failed","blocked","rejected"]`（`actions.ts:68`，:686-692 强制）→ 旧体必须**账面终态**。
- `retryDispatcher.hasInflightForRole`（:696）；`getActiveSessions` 把 `running / awaiting_review / approved_to_ship` 都算活（StateStore :3221-3223）→ **死在 awaiting_review 的体永远堵住替身**（FLY-2083）。
- retry 前 `closeRunner(retry_force_close, forcePreserved)`，错误只记日志（:742-760）。
- gateway retry（`retry-dispatch-wal.ts:69-135`）经 `checkStartedEvidence`（`started-evidence.ts:53-90`）：`probeTmuxWindowLiveness` alive→started、dead→retry_safe、indeterminate→needs_reconfirm、`:pending`→未启动。**「已启动」= 窗口存在**：活体无窗被 re-dispatch（双体），dead-pin 窗被当已启动（永不重驱）。
- `admitWorkflowExecution`（StateStore :10234-）不查身体生死，只查 run 活跃/attempt/credential 冲突——本单不动它。
- sessions 列（StateStore :521-598）：`status, heartbeat_at, last_activity_at, tmux_session, adapter_type, run_attempt, retry_predecessor/successor, session_role, awaiting_review_entered_at, gate_timeout_notified_at, lifecycle_revision`。**没有 pid 列**；`tmux_window` 只在 CommDB。

## 4. 其余致死消费者（完整清单见附录 A，共 16 文件 + Heartbeat + gate-poller）

| 消费者 | 探针 | 决策 | 场景 A（窗缺进程活） | 场景 B（窗在进程死） |
|---|---|---|---|---|
| `complete-marker-reconciler.ts:706-731` 启动扫 | `isTmuxWindowAlive` | 不活 → `applyQuarantineFallback`（:583）→ failed | **误判死** | dead-pin 读活 → 留 running |
| `started-evidence.ts:53-90` | `probeTmuxWindowLiveness` | 铸替身/重驱 | **re-dispatch → 双体** | dead-pin 当已启动 |
| `phase-orchestrator.ts:1632 / :1428 / :1668 / :850` | pane 探针（`plugin.ts:6717-6732`） | park-or-close、wake-vs-spawn、ghostGuard | absent → close 或重复 spawn | dead_pin → 死（Claude 对，Codex daemon 外活时错） |
| `codex-phase-shutdown.ts:163-276` | lookup + pane | dead_pin/absent → `direct` 直接拆 | absent → 在活 daemon 下直接 teardown（FLY-1269 风险） | TUI pane 死 → direct，daemon 可能还活 |
| `done-thread-reconcile.ts:314-340 / :474 / :590` | lookup + pane | 死 → husk finalize + 归档 | absent → 误 finalize | 对 |
| `lifecycle-closeout.ts:1419-1437` | lookup + pane | `confirmedGone` 门 | absent → gone，在活进程下删 PR/worktree | dead_pin 刻意 ≠ gone（:1427） |
| `stale-blocker-guard.ts:230` | lookup + kill | kill 后 → completed | kill 缺窗「成功」→ 活进程旁放新 run | — |
| `commdb-session-prune.ts:146` | window | dead → 删 CommDB completed/timeout 行 | 删掉活体的 tmux target | 留 |
| `commdb-fsm-reconcile.ts:138` | window | dead → `finalizeSession` | 删活体 target | 留 |
| `server-loss.ts` 经 `plugin.ts:7805-7817` | server + pane | gone → failed | **误判死** | — |
| `actions.ts:1124-1164` terminate | lookup | gone → physicalGone | 活进程被孤立 | — |
| `worktree-reconciler.ts:147` / `lifecycle-sweep.ts:516` | window | 删 worktree（仅终态） | 终态 parked 活体 worktree 被删 | 留 |
| `gateway-main.ts:664-677` | lookup + window | close 幂等后置 | 泄漏活进程 | — |
| 非致死保留：`terminal-tab-reaper.ts:108`、`plugin.ts:2079` scan-stale、`plugin.ts:5527` stuck-confirm、`plugin.ts:7773` zombie scan、`gate-poller.ts:3419` | window / session | UI、告警、唤醒路由 | — | — |

## 5. 两载体的进程身份

**Codex daemon**（`packages/claude-runner/src/codex-daemon-runtime.ts`）：ledger `~/.flywheel/state/codex-sessions/<execId>/session.json` 含 `daemonPgid`（:93-101、:196-224）；socket `~/.flywheel/cdx-sock/<sha1(execId)[:16]>.sock`（:66-88）；alive = socket 活 + `kill(-pgid,0)` + `lsof -t` 的 socket holder 在该 pgid（:289-331）；absent = socket 死 + group 不在；spawn lock 含 pid（:226-246）。**可直接复用**为 Codex 载体探针。

**Claude**（`TmuxAdapter.ts`）：`tmux new-window -P -F '#{window_id}' … [sh -c '…exec claude "$@"' | claude args]`（:496-560）。fleet 路径 pane 进程就是 `claude`；gateway 路径 gated shell 用 `exec` 接管同一 pid。**因此 `#{pane_pid}` 在启动瞬间即 worker pid**，但今天没人记录它：没有 pid 注册表，身份 = CommDB `tmux_window`。等待路径 `waitForCompletion`（:896-）用 HTTP callback + `pane_dead` poller + sentinel；pane 消失当完成 `success:true`（:671）。

**Claude 身份不能靠 `ps` argv**（Lead 义务 claude-process-title-identity）：Claude Code 会改写进程标题。方案：启动时 `tmux display -p -t <window_id> '#{pane_pid}'` 取 pid；`ps -o lstart= -p <pid>` 取开始时间；`sysctl -n kern.boottime` 取 host boot；`lsof -p <pid> -a -d txt -Fn`（macOS）取可执行路径核对 = `binaryName` 解析路径；三者 + executionId + generation 写入绑定。核验时只比 pid + lstart + boot（argv/标题不参与）。

## 6. 完成 marker 与死亡的先后（Lead HIGH 义务）

- marker 写入：`flywheel-comm/src/commands/complete.ts` → `$FLYWHEEL_COMPLETE_MARKER_DIR/<execId>.json`（环境变量在 `TmuxAdapter.ts:859-864` 注入 pane）。
- 本树对账：`complete-marker-reconciler.ts` `tryReconcileComplete`（:322）单飞，`applyQuarantineFallback`（:583），启动 drain（:706-731）。
- 先后关系今天**不严格**：`reapCrashedRunners` 跳 pending marker（:190）；`reconcileMonitorLoss` marker-first（:673-）；但 `reapOrphans` 只跳 `markerRetryPending`，不直接查 marker；启动 drain 在 `isTmuxWindowAlive=false` 时直接 quarantine → failed。
- 处置：不变式 **marker-before-death** 落到唯一收敛入口 `convergeProvenDeadExecution`：入口第一步 `hasPendingCompleteMarker(execId) || tryReconcileComplete(...)` 未 settled → 返回 `deferred:pending_complete_marker`，不写 failed。

## 7. 运行时开关（feature registry）

`packages/config/src/feature-flags/registry.ts`：`FeatureFlagSpec`（:57-100）、`envSite()`（:103-110）、`FEATURE_FLAGS`（:112-）。对照条目 `liveness_pane_dead`（:856-876，`FLYWHEEL_LIVENESS_PANE_DEAD`，default_on，`call_time`，`toggleable:"direct"` + `directToggleProof`）。三条测试约束：`feature-flags-registry.test.ts`（唯一名、env 需 envVar+scope、read site 需 file/symbol/timing、direct 需全 call_time + proof）；`feature-flags-drift.test.ts`（新 `process.env.FLYWHEEL_*` 必须登记，且 read-site 文件真含该 env）；`feature-flags-direct-toggle.test.ts`（unset→0→1 翻转）。

新开关 `body_death_authority`（`FLYWHEEL_BODY_DEATH_AUTHORITY`，default_on，call_time，direct）：`=0` 时 `execution-body-liveness` 对所有致死消费者返回 `unknown(reason="authority_disabled")`，消费者只观察/告警，不写 failed/terminated/不删 CommDB 行。`liveness_pane_dead` 在迁移完成后成为死旗标（只影响非致死窗口观察），登记为 `dormant`。

## 8. Lead 10 条实现义务在本树的落点

| 义务 | 上游依据（对照基线） | 本树落点 |
|---|---|---|
| HIGH death-before-pending-complete-marker | `HeartbeatService.ts:886-899` marker-first；`reapOrphans` 无直接检查 | §6：收敛入口第一步查 marker；红测「pending marker + 进程死 → 不 failed，先对账」 |
| codex-reown-revive-precedence | `codex-session-reown.ts`（本树无） | 本树无 reowner。plan 写接口约束：`BodyObservation.reason` 保留 `recovery_active` 枚举位，未来 reowner 有效 binding + 预算未耗尽时返回 unknown；`codex-session-reown*.test.ts` 在本树不存在，标「不适用」 |
| obligation-replay-evidence-expiry | 上游 30 s closeout evidence（`execution-closeout-evidence.ts:223`） | 本树无义务账本；本单新增的 `body_death_obligation` 重放时**幂等键先于过期检查**（plan §5 步 6） |
| lease-contention-refuses-normal-restart | `execution-mutation-lease.ts`、`recovery_claim`（本树无） | 本树无 lease 表。plan 采样在事务外、最后同步 CAS（`lifecycle_revision` 比较更新）；不引入 lease 表 |
| no-runtime-kill-switch | registry 模式 | §7 `body_death_authority` |
| consumer-inventory-direct-importers | 5 个探针名检索 | 附录 A 全表；started-evidence / worktree-reconciler / lifecycle-sweep 纳入 |
| fly2903-sweep-and-restart-gate-unmapped | `codex-daemon-goal-runtime.ts:858-871` restartGate（本树 `codex-daemon-goal-runtime.ts` 存在但无 `mayRestartAfterTransportDeath`） | 本树落点：Codex 探针在 goal-runtime **重启中**（`restarts < maxRestarts` 且 killSession→startSession 窗口）返回 unknown(`controller_recovery_active`)，用 runtime 内存标志 + session.json 的 spawn epoch |
| claude-process-title-identity | `generalized-launch-recovery.ts:51-120` `pgrep -f`（本树无） | §5 pid+lstart+boot+lsof txt |
| standby-retirement-window-proof | FLY-2808（本树无） | 不适用；plan 留「批准退下」接口位：`convergeProvenDeadExecution` 接受 `approvedRetirement` 输入时不记 failed |
| probe-cadence-heartbeat-5min | — | plan §4.3：采样独立预算，延迟上界 = tick + 5 s |

## 9. 已核验的关键调用链

1. Heartbeat #1 判「窗 absent = 死」→ 不进 reconnecting → #4 心跳陈旧 → `failed` 且无 teardown：**活体被 force-failed 的完整链**（FLY-2618/2910 现场）。
2. 死体停在 `awaiting_review`：不进 #3/#4 候选；#7 只告警；`getActiveSessions` 堵住 retry：**死体不终结 + 换体不出**的完整链（FLY-2083/2537）。
3. `started-evidence` 用窗口证「已启动」：活体无窗 → `retry_safe` → 第二具体（FLY-2529 反向）。
4. Codex daemon 探针（`codex-daemon-runtime.ts:289-331`）已是进程真值，但没有任何 Heartbeat/reaper 消费者调用它；它们全看 TUI pane。

## 10. 约束与诚实边界

- 设计阶段未运行任何测试（依赖未安装：根与包目录均无 `node_modules`）；实现节点先 `pnpm install --frozen-lockfile`，再只跑 plan §8 精确文件。
- 未做 529 故障注入；未改任何活库。
- 外部输入（session.json、tmux/ps/lsof 输出）一律作不受信输入：限长、格式校验、身份复核、参数化 SQL、展示转义。
- 本树 StateStore 12.7k 行，无上游的 61k 行机制；plan 不引入上游的 owner 表/lease 表，只加最小 `execution_process_binding` 表与 `body_death_obligation` 事件。

## 附录 A：五探针名全仓消费者（`grep -rlE 'probeTmuxWindowLiveness|isTmuxWindowAlive|probeRunnerProcessLiveness|lookupTmuxTarget|probeCodexDaemonLiveness' packages --include='*.ts'`，排除测试）

| 文件 | 探针 | 决策类 | 处置组 |
|---|---|---|---|
| `HeartbeatService.ts` | runner-process / window | 致死（failed）、parked 回收、stale close | B |
| `bridge/crash-reaper.ts` | runner-process | 致死（terminated） | B |
| `bridge/zombie-scan.ts` | runner-process | 告警 | B（分类改 body） |
| `bridge/server-loss.ts`（经 plugin） | server + runner-process | 致死（failed） | B |
| `bridge/complete-marker-reconciler.ts` | window bool | 致死（failed） | B |
| `bridge/started-evidence.ts` | window tri-state | 铸替身 | B |
| `bridge/phase-orchestrator.ts` | runner-process | close / spawn / refuse | B |
| `bridge/codex-phase-shutdown.ts` | lookup + runner-process | direct teardown | E |
| `bridge/done-thread-reconcile.ts` | lookup + runner-process | husk finalize | C |
| `bridge/lifecycle-closeout.ts` | lookup + runner-process | confirmedGone 门 | C |
| `bridge/stale-blocker-guard.ts` | lookup + kill | completed + 释放槽 | E |
| `bridge/commdb-session-prune.ts` | window | 删 CommDB 行 | C |
| `bridge/commdb-fsm-reconcile.ts` | window | 删 CommDB 行 | C |
| `bridge/actions.ts` | lookup（terminate）；window（retry 经 started-evidence） | physicalGone / 替身 | E / B |
| `bridge/worktree-reconciler.ts`、`bridge/lifecycle-sweep.ts` | window | worktree 清理（终态） | F：加 body alive 保护 |
| `bridge/terminal-tab-reaper.ts` | window bool | UI | 保留 |
| `bridge/plugin.ts`（:2079、:5527、:7773、:7805） | window / runner-process | 报告 / 注解 / 告警 / server-loss | F / B |
| `bridge/tmux-lookup.ts` | 定义 | — | A：重命名+注释 |
| `lead-backends/codex/gateway/gateway-main.ts` | lookup + window bool | close 幂等后置 | 保留（记录泄漏风险，非本单） |
| `bridge/gate-poller.ts:3419`（`isTmuxSessionAlive`） | session | 唤醒路由 | 保留 |

`pane_dead|isSessionTmuxAlive|dead_pin` 二次检索由实现节点在改后附完整处置表。
