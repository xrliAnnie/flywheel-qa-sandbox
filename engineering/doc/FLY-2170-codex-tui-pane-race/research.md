# FLY-2170 Codex TUI pane 出生后秒死病根 — 调研
Issue: FLY-2170 (https://linear.app/geoforge3d/issue/FLY-2170/病根-codex-实现体的-tui-pane-出生后秒死fly-1239-race注册停-pending窗口消失app-server-却活着)
日期: 2026-09-03
基于: exploration.md

行号绑定 worktree `flywheel-FLY-2170 @ 3bdbd7cbc`(main 同头)。

## 1. Codex runner 出生序列(现状)

```
RunDispatcher.preRegisterCommDb            → comm.db sessions.tmux_window = "runner-flywheel:pending"   (run-dispatcher.ts:927, :1218-1245, :1233)
CodexTmuxAdapter.execute → registerCommDbSession → 再写一次 ":pending"                                 (CodexTmuxAdapter.ts:845, :2211-2244, :2225)
runtimeFactory → codex app-server --remote-control --listen unix://<socket>  detached:true, stdio ignore (codex-daemon-runtime.ts:728-757, :973-980)
thread/start → onThreadReady(threadId, restarts) → startOpenChain()  (非阻塞, 0ms 调度)                  (CodexTmuxAdapter.ts:1277-1297, :1218-1246, :1239)
ensureRunnerTuiWindow: tmux -V → guarded ensureSession(≤210s) → FLY-1239 purge(按 @id) → new-window → settle 800ms → display-message 验 "@N <name> 0"
                                                                                                        (codex-runner-tui-window.ts:860-1053, :906-919, :521-556, :800-846, :957-975, :995-1014)
wireCreated → publishWindowExecutionIdentity(@flywheel_exec_id) → pinCommDbSessionWindow("runner-flywheel:@N") → persistSessionWindowState
                                                                                                        (CodexTmuxAdapter.ts:1059-1099, :2266-2290, :2248-2263; db.ts:6748-6752)
```

窗内命令(`buildRunnerTuiCommand`,codex-runner-tui-window.ts:85-110):
`exec /usr/bin/env -i <allowlist> CODEX_HOME=… FLYWHEEL_EXEC_ID=… <rawCodexBin> resume --remote "unix://<socket>" -C "<cwd>" -s workspace-write -c 'approval_policy="never"' <threadId>`。

重试参数:`TUI_OPEN_MAX_ATTEMPTS = 3`,`TUI_OPEN_RETRY_DELAYS_MS = [5_000, 15_000]`(CodexTmuxAdapter.ts:121-125);`tuiOpenDeadlineMs = 2 * tmuxEnsureDeadlineMs() + 60_000` = 480 s(:810);`hold_lock_unavailable` / `stale_window_unproven` 不消耗尝试次数(:1150-1163)。

**进程树事实**:app-server 是 Bridge 的 detached 子进程,自领进程组;TUI 只是经 socket 连上它的一个客户端。pane 死 ⇒ 一个客户端断开,app-server 零感知。杀 app-server 的只有 `runtime.stop()` 的组杀(goal 结束)与 Bridge 重启后 orphan reaper 的 2 小时四证回收(codex-runner-orphan-reaper.ts:24)。

## 2. 出生期 race 的现状证据

| 来源 | 结论 |
|---|---|
| FLY-1239 plan/qa | bounded retry 8×900ms;QA 6/6 PASS 但 `NP-race-diag` 未采到瞬时 `no rollout found`,即**真机未复现 race 并观测 retry**。 |
| FLY-2169 exploration.md:51-71 | 8-29 bridge.log 47 次 `founder TUI DIED immediately`;机理双因:rollout-landing race + active-writer fork(3 个 TUI 尝试各 fork 一份副本线程)。 |
| FLY-2168 research.md:19-27 | `openai/codex` `rust-v0.151.0` `thread_resume_inner()` → `resume_running_thread()`:线程已加载则复用 `CodexThread`、追加 listener。「FLY-2169 记录的旧 fork 风险不能继续当成 0.151 的既定行为」。 |
| 本机 | `codex-cli 0.153.0`(`/Users/xiaorongli/.local/bin/codex`)。 |
| 今日 bridge.log(07:51–13:26,4 段轮转) | `founder TUI DIED` **0**;`no rollout found` **0**;`founder TUI up` **13**;`terminal visibility loss` **0**;`hold_lock_unavailable` 3。 |
| 今日 comm.db + tmux | `vendor='codex' AND status='running'` 7 行,全为 `@N`;`tmux list-windows -t runner-flywheel` 7/7 存在,`pane_current_command=codex`,`pane_dead=0`。 |

结论:点火源在当前 main 上不触发。仍保留的守卫:`window_died` 归类 `retryable-transient-ipc`(codex-runner-tui-window.ts:1016-1025),3 次用尽 → `emitTuiLost("deadline-exhausted")` → plugin.ts:9808-9823 发 `tui_window_lost` warning。

## 3. 缺口一:注册后窗口死亡不可见

- `wireCreated` 置 `tuiOpened = true`(CodexTmuxAdapter.ts:1062);`attemptOpen` / `launchAttempt` 均以 `if (runEnded || tuiOpened) return`(:1116-1119, :1198-1201)。
- 再武装只有 `onThreadReady` 且 `restarts > 0`(:1290-1295):`tuiOpened = false; founderWindowId = undefined; tmuxWindow = undefined; startOpenChain()`。注意它**不**把 comm.db 写回 `:pending`,旧 `@N` 一直留到新窗 pin。
- `isRunnerTuiWindowAlive(spec)`(codex-runner-tui-window.ts:1057-1075)是**同步** `execOut`,生产零调用者(仅 index.ts:145 导出)。同文件已有异步 `spawnCommandAsync`(:420)供 purge 使用。
- adapter 已有一个 unref 的周期定时器:`startHeartbeat(heartbeat, intervalMs)`(:546-552),用于 comm.db heartbeat。
- 测试:`codex-runner-tui-window.test.ts:712-727, :1121-1140` 只覆盖 settle 期死亡;`CodexTmuxAdapter.test.ts:2559-2600` 覆盖 pending 直到 @id 提交。**没有**「@N 已提交、窗口后死」的用例。

## 4. 缺口二:探活轴的消费者清单

探针源:`probeTmuxWindowLiveness(tmuxWindow)`(tmux-lookup.ts:608,`alive|dead|indeterminate`,`:pending → indeterminate`)与 `probeRunnerProcessLivenessDetailed(tmuxWindow)`(:715,`alive|dead_pin|absent|indeterminate`)。两者签名只有 tmux 目标字串,无 execution / vendor。

`lookupTmuxTarget(executionId, projectName)`(tmux-lookup.ts:~330)读 comm.db `sessions` 行,但 `TmuxTarget` 只带 `tmuxWindow` / `sessionName`(:33-38);行上的 `vendor`(db.ts:1122-1131 列,registerSession 第 6 参强制写)与 `execution_id` 被丢弃。

进程真相:`probeCodexDaemonLiveness(executionId)`(codex-daemon-runtime.ts:215-220)→ `inspectCodexDaemonOwnership`:读持久化 session state 的 pgid + socket,`absent` 需 socket 死 **且** 进程组消失;`alive` 需 lsof holder 属该 pgid;否则 `unknown`。lsof/ps 已是异步 3 s 超时探针(FLY-2211)。现有调用者:run-quiescence.ts:33、plugin.ts:7145。

| # | 消费者 | 位置 | 现判定 | 对 codex 体的后果 | 处置 |
|---|---|---|---|---|---|
| 1 | Heartbeat zombie 链 `probeSessionLiveness` | HeartbeatService.ts:946-985 → :913-935 | `absent` 连续 2 次且 tmux server up → `declareZombie` | **窗口消失即宣告 zombie**,app-server 活着 | 改判定 |
| 2 | Heartbeat phase hold `probePhaseLiveness` | HeartbeatService.ts:1897-1910 | `dead_pin|absent → "dead"` | parked codex phase actor 被判死 → rework 死结族(FLY-2031/2152 形态) | 改判定 |
| 3 | patrol_tick `probePatrolProcessLiveness` | patrol-process-liveness.ts:37-60 | `@N` 分支 `absent → dead`;`:pending` 分支回落 `pgrep -f execId` | 窗口消失 → dead;pending 用 pgrep 猜 | 改判定 |
| 4 | crash-reaper | crash-reaper.ts:195-220 | `:pending` suppress;`absent` → reapOrphans → failed | 窗口消失 → 走 failed | 改判定 |
| 5 | commdb-fsm-reconcile | commdb-fsm-reconcile.ts:110-130, :168 | FSM 终态 + `dead` → 删 comm 行 | 只在 FSM 已终态时删行;codex 体 FSM 非终态不触发 | 改判定(同接缝,低风险) |
| 6 | commdb-session-prune | commdb-session-prune.ts:142-172 | 同 5 | 同 5 | 改判定 |
| 7 | plugin `probeActorAlive`(phase-actor-reentry / coordinator) | plugin.ts:10310-10318 | `probeRunnerProcessLiveness(target.tmuxWindow)` | **reentry 误判 dead → 铸替身**(issue 点名) | 改判定 |
| 8 | plugin `probeRegistered` | plugin.ts:10447-10453 | 同上 | 同上 | 改判定 |
| 9 | plugin `probeTurnHolderLiveness` | plugin.ts:8468-8471 | 用 StateStore `tmux_session` | TURN holder 判死 → 抢 TURN | 改判定 |
| 10 | plugin lifecycle/worktree reconciler `probeLiveness` ×3 | plugin.ts:7277, 7798, 7847 → lifecycle-sweep.ts:156/552、worktree-reconciler.ts:98/156 | `RunnerLiveness` | 归档/清 worktree 决策 | 改判定 |
| 11 | plugin `targetAlive` / 11413 | plugin.ts:11367, 11413 | `alive` 才 true | 待核语义(研究中未展开) | 改判定,plan 要求实现时逐处核 |
| 12 | gate-poller stale-ship probe | gate-poller.ts:3027-3045 | 已按 `isAutoMigratableClaudeTmux(adapter_type)` 对非 claude 返回 `indeterminate` | 已正确保守 | 不动 |
| 13 | pane-loss-reconcile | pane-loss-reconcile.ts:157-195 | `codex-tmux` + `absent` → 仅 `advisory_codex` | 已正确 | 不动(A1 的外部对照信号) |
| 14 | started-evidence / generalized-launch-recovery | started-evidence.ts:54-72;generalized-launch-recovery.ts:77-89 | `:pending → pending_only`;`dead` 才判 | 保守 | 不动 |
| 15 | patrol-orphan-sweeper `activePatrolTargets` | patrol-orphan-sweeper.ts:74-85 | 过滤所有 `:pending` 行 | 出生期 create→pin 间隔 ~1 s 的 pane 可能被计为无主(streak 制,按小时槽) | 不动;plan 记为观察项 |
| 16 | run-quiescence | run-quiescence.ts:33 | 已用 `probeCodexDaemonLiveness` | 正确 | 不动(A2 的参考实现) |

**词表映射**(A2 唯一新增的纯函数):`CodexDaemonLiveness → RunnerLiveness`:`alive → alive`;`absent → absent`;`unknown → indeterminate`。`dead_pin` 对 codex 永不产生(pane 状态不是进程真相)。`TmuxWindowProbe` 消费者(5/6)映射:`alive → alive`;`absent → dead`;`unknown → indeterminate`。

## 5. 缺口三:`:pending` 的消费者

| 位置 | 行为 |
|---|---|
| tmux-lookup.ts:611 `probeTmuxWindowLiveness` | `indeterminate` |
| tmux-lookup.ts:643 `isTmuxWindowAlive` | `false` |
| tmux-lookup.ts:817 `sendKeysToWindow` | 拒绝,`"tmux window identity is still pending"` |
| tmux-lookup.ts:915 `killTmuxWindow` | 拒绝,同文案 |
| runner-recovery-nudge.ts:336-340 | 不 nudge |
| tmux-lookup.ts:174-176 `resolveCmuxAttachTarget` | `unresolved/"pending-target"` → issue-display `warnAttachCrossWire`(issue-display-refresher.ts:163-175;调用点 :313, :372, :877, :933) |
| HeartbeatService.ts:967 | 只记 forensics `pending_sentinel`(今日 health 端点 `pending_sentinel: 2`) |
| crash-reaper.ts:197 | suppress |
| plugin.ts:6586 | 有 target 且非 pending 才算 |
| patrol-orphan-sweeper.ts:77 | 过滤 |

issue 里的 `tmux_window_identity_still_pending` 在仓内不存在为字面 token(仅出现在 issue 文本),它是 :817/:915 文案的规范化签名(推断)。

今日 `pending-target` 30 次:每个 codex 体出生 2 次(issue-display 两次刷新落在 43–46 s 的开窗窗口内),与 FLY-2168 QA 的开窗耗时一致;不是故障,是 fail-closed 的正常代价。

## 6. 今日另两个 cross-wire 形态(非本单)

- `execution-mismatch`(exec 3a938c10,FLY-2144):窗 `@117` 的 `@flywheel_exec_id` 属同 issue 更新的 execution;旧 exec 的展示按 FLY-923 fail-closed。设计正确。
- `window-id-mismatch`(ff68e9a1 / f140866f):comm 行已不在(查询为空),StateStore 侧仍持旧 target。属残留清理族,不在本单。

## 7. 可复用的既有原语(本单零新机制的依据)

| 需求 | 复用 |
|---|---|
| 异步窗口存在性核查 | `spawnCommandAsync` + settle 期同一条 `display-message -p -t =<session>:<@id> '#{window_id} #{window_name} #{pane_dead}'`(codex-runner-tui-window.ts:999-1014) |
| 周期触发 | adapter 已有 `startHeartbeat` unref 定时器(CodexTmuxAdapter.ts:546-552) |
| 重开链 | `startOpenChain` + `restarts > 0` 再武装分支(:1218-1246, :1290-1295) |
| 指针写回 | `pinCommDbSessionWindow`(:2248-2263)对任意字串生效,含 `:pending` |
| 进程真相 | `probeCodexDaemonLiveness`(codex-daemon-runtime.ts:215) |
| vendor 来源 | comm.db `sessions.vendor`(registerSession 强制写) |
| 告警 | `onTuiWindowLost` → `tui_window_lost`(plugin.ts:9808-9823);`onTuiWindowRestored`(CodexTmuxAdapter.ts:542,今日日志 `[runner-tui-window] restored execution=`) |

## 8. 缺口四:出生与 re-own 的窗口名不是同一来源(一 runner 两窗)

| 路径 | 窗口名来源 | 结果 |
|---|---|---|
| 出生(dispatcher → Blueprint → adapter `ctx.label`) | `buildWindowLabel(issueId, runnerDisplayName(role, shareParentBranch, modelDisplay), title)`(core/tmux-naming.ts:36-42;run-dispatcher.ts:239-256) | `FLY-2147-implement-codex-G-2132-B0-runner-spawn` |
| Bridge 重启后 re-own(FLY-2211,codex-session-reown.ts:100-135) | `[session.issue_identifier ?? issue_id, session.issue_title].filter(...).join("-")`(:117-122) | `FLY-2147-2132-B0-runner-spawn` |
| adapter 内 | `windowName = sanitizeTmuxName(ctx.label ?? \`codex-${executionId.slice(0,8)}\`)`(CodexTmuxAdapter.ts:784-786) | 照单全收 |
| `CodexLaunchSnapshot`(CodexTmuxAdapter.ts:194-220) | 字段:cwd / objective / kickText / launchContext / rehydrationContext,**无 label** | re-own 无据可依 |
| FLY-1239 purge(codex-runner-tui-window.ts:800-846) | `list-windows -F '#{window_id} #{window_name}'`,只杀 `name === spec.windowName` | 不同名的出生窗存活 |

今日证据(2026-09-03 13:3x 本地):
- tmux `runner-flywheel` 对:`@452`/`@546`(FLY-2147)、`@455`/`@558`(FLY-2301)、`@454`/`@494`(FLY-2145)、`@442`/`@493`(FLY-2270);每对两窗 `@flywheel_exec_id` 相同,`pane_current_command=codex`,即同一 thread 两个 TUI 客户端。
- bridge.log 对 8baa35c5:log.1:60869 `founder TUI up (FLY-2147-implement-codex-G-…)` → Bridge 19:01:44Z 重启 → log:39657 `founder TUI up (FLY-2147-2132-B0-runner-spawn, 同 thread)`;两次都跟着 `[runner-tui-window] restored execution=`(plugin.ts:9825)。
- comm.db pin 到后者(`@546/@558/@494/@493`);`patrol_orphan_watch` 表持有 `@455/@452/@442/@454`(被抛弃的出生窗被当无主 pane,streak 1–14);`discoverTmuxTargetByExecutionId` 对这四个 execution 返回 `ambiguous`(tmux-lookup.ts,`sessionsByWindow.size > 1`)。
- cmux:`cmux-FLY-2147-2132-B0-runner-spawn` 与 `cmux-FLY-2147-implement-codex-G-2132-B0-runner-spawn` 两个 workspace 并存(其余三对同形)。

**cmux 侧「can't find pane / 0 字节」的真因(Lead 指令 03f5ea17 ③,2026-09-03 13:5x 本地复核)**:cmux 侧 session 与 pane 都健全 —— `tmux capture-pane -p -t '%558'` 与 `-t '=cmux-FLY-2301-…:'`(带尾冒号)都读出 1265 字节实时 TUI(与 `runner-flywheel:@455` 内容逐字相同,同一 goal);报 `can't find pane` 的只有 `-t '=cmux-FLY-2301-…'`(**无尾冒号**)这一种写法:tmux 3.7c 对 target-pane 把 `=name` 当**窗口名**精确匹配(man tmux「Like sessions, a `=` prefix will do an exact match only」),该 session 里没有叫这个名字的窗 → 找不到。生产 `scripts/flywheel-cmux-sync.sh` 全部用 `=${session}:${wid}` 带冒号形式(:1263/:1278/:1779/:1798),不受影响;这是手工探针的语法坑,不是渲染故障。founder 看不到「Codex 层」的真因回到 §8 主表:re-own 拼名让注册指针与 cmux 主工作区落在不带 `codex-G` 的同源窗上;当前 55 个 cmux workspace 里每个 codex runner 两条(一条带 `codex-G`、一条不带),标题失去 codex 标识且互为镜像。QA 演练(plan §7 #10)的截图命令必须用 `%pane` 或 `=<session>:` 形式。

**可复用的单一来源**:活窗自带出生名 —— `tmux list-windows -a -F '#{window_id} #{window_name} #{@flywheel_exec_id}'` 按 `@flywheel_exec_id` 过滤即得。`publishWindowExecutionIdentity`(CodexTmuxAdapter.ts:2266-2290)在 pin 之前就写该选项。

**顺带发现(不在本单范围,报 Lead)**:`registerSession` 的 upsert 在 `status='running'` 时把 `started_at` 重置为 `excluded.started_at`(db.ts:6604-6607),re-own 再注册会抹掉出生时间;QA 用 `started_at` 算「pending 超 10 min」时要用 StateStore 的启动时间而非 comm.db。

## 9. 范围裁定后的归属

Lead 2026-09-03 拆单:本单只做 §8(缺口四)。§3(缺口一)、§4(缺口二)、§5(缺口三)的分析保留为病根记录,其实施与 Codex R1/R2 相关条目原样交接到 `handoff-probe-axis.md` 供另一单使用。

## 10. 会过期的结论

- 行号绑定 `3bdbd7cbc`;FLY-2296 / FLY-2302 并行设计可能触碰 CodexTmuxAdapter,实现前重核。
- §8 的四对双窗是**当前生产残留**;WS-D 部署后,在这些 execution 下一次真实 revive / 开窗链执行时由扩展后的 purge 收掉旧名窗(Bridge 重启对健康活跃、无 gate、非 parked 的 daemon 只装 watch 不 revive,codex-session-reown.ts:283-347;Codex R3 H1 纠正),不需要人工清;若在部署前有人手工清,QA 基线要重取。
- codex 0.151+ 的 `resume_running_thread()` 语义来自 FLY-2168 对上游源码的核对,未在本单重新读源码;若 QA 观察到 `no rollout found` 回归,A1 会把它暴露为 `tui_window_lost` 而不是静默 pending,但**修出生 race 本身不在本单范围**。
