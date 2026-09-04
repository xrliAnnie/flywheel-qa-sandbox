# FLY-2170 Codex TUI pane 出生后秒死病根 — 探索
Issue: FLY-2170 (https://linear.app/geoforge3d/issue/FLY-2170/病根-codex-实现体的-tui-pane-出生后秒死fly-1239-race注册停-pending窗口消失app-server-却活着)
日期: 2026-09-03
基于: 无

## 0. 一句话

Codex runner 的 tmux 窗口只是一个**视图**,真正干活的是 `codex app-server` 守护进程;今天的系统却把「视图存在」当成「进程存活」,把「视图未就绪(`:pending`)」当成「不能碰」,又在视图注册成功后再也不看它一眼。本单要把这三处倒置扶正,并对 issue 点名的 FLY-1239 出生 race 给出可核的收口结论。

## 1. Issue 描述的形状(8-29 取证)

- `tmux_window_identity_still_pending` / `[issue-display] attach cross-wire window_name undefined`
- codex implement 的 TUI pane 出生后数秒~数分钟内死亡
- comm 注册停在 `runner-flywheel:pending`,或留下已消失的 `@N`
- `codex app-server` 反 parent 到 Bridge 继续干活 ⇒ cmux 零可见,phase-actor-reentry / zombie / patrol 全部误判,FLY-2031/2152 rework 死结族
- 8-29 全天 7 个 codex 体:2 建窗即失(@118/@1245),5 恒 pending

## 2. 今日(2026-09-03)复核:形态已经分裂成两半

### 2.1 已经不再复现的一半:出生期 TUI 秒死

| 观测 | 8-29(FLY-2169 exploration 取证) | 今日 07:51–13:26(bridge.log 4 段轮转) |
|---|---|---|
| `founder TUI DIED immediately` | 47 次 / 6 个 implement 窗 | **0** |
| `no rollout found` | 有 | **0** |
| `founder TUI up` | 少数,且成活后消失 | **13** |
| comm.db codex 行 | 5 恒 `:pending`,1 指向消失的 `@118` | 7 个 running 行全为 `@N`,**7/7 窗口存在且 `pane_current_command=codex`** |

原因不是巧合。8-29 的机器跑的是 FLY-2169 **之前**的代码;8-30 18:19 合入的 FLY-2168 (#998) 把窗口命令换回原生 `codex resume --remote`,并核对 `openai/codex` `rust-v0.151.0` 的 `thread_resume_inner()`:线程已在 app-server 内加载时走 `resume_running_thread()` 复用现有 `CodexThread`,**不再依赖磁盘 rollout 文件是否已落地**(FLY-2168 research.md:19-27)。本机 codex-cli 已是 0.153.0。FLY-1239 描述的「rollout-landing race」在这条路径上从机理消失。

诚实边界:这是「机理消失 + 今日 6 小时零复现」,不是「已证明永不复现」。第 6 节给出可核的收口判据。

### 2.2 仍在生产的一半:三处结构倒置

**倒置一:注册成功之后,窗口死亡再也没人察觉。**
`CodexTmuxAdapter` 的开窗链在 `wireCreated` 置 `tuiOpened = true` 后永久停止(CodexTmuxAdapter.ts:1062, 1116-1119, 1198-1201);唯一的再武装是 daemon 重启(`onThreadReady` 且 `restarts > 0`,:1290-1295)。`isRunnerTuiWindowAlive` 在生产路径**零调用者**(只在 index.ts:145 导出与测试里)。窗口在成功注册之后死掉 ⇒ comm.db 留着一个已消失的 `@N` ⇒ 这正是 8-29 `@118` 的形态,也正是「窗口消失,app-server 却活着」。今日 0 次,但机制上没有任何东西阻止它下次发生(founder 手滑 `q`、cmux 关 surface、tmux server 抖动)。

**倒置二:探活轴用窗口存在性冒充进程存活。**
`probeRunnerProcessLivenessDetailed(tmuxWindow)`(tmux-lookup.ts:715)和 `probeTmuxWindowLiveness(tmuxWindow)`(:608)只看 `list-panes`。对 claude 体这是对的(claude 进程就在 pane 里);对 codex 体是错的:app-server 是 Bridge 的 **detached 子进程**(codex-daemon-runtime.ts:973-980),与 pane 无父子关系,pane 死对它零影响。消费这两个探针并据此**做出终态/破坏性决定**的有:Heartbeat zombie 链(`absent` 连续 2 次 → `declareZombie`,HeartbeatService.ts:913-935)、patrol_tick(patrol-process-liveness.ts:58-59 `absent → dead`)、crash-reaper(:216-220 → reapOrphans → failed)、commdb-fsm-reconcile(:110-130 终态+dead → **删行**)、commdb-session-prune、lifecycle-sweep、worktree-reconciler、gate-poller 与 plugin.ts 内 8 处。唯一按 codex 正确处理的是 pane-loss-reconcile(:173 `codex-tmux` → 仅 `advisory_codex`)。而**正确的进程真相早就存在**:`probeCodexDaemonLiveness(executionId)`(codex-daemon-runtime.ts:215,FLY-2211 交付,`absent` 要求 socket 死 **且** 持久化进程组消失双证据),但只有 run-quiescence 和 plugin.ts:7145 两处在用。

**倒置三:`:pending` 被当成「不能碰」而不是「路由未就绪」。**
`:pending` 的存续期 = `onThreadReady` → 一次开窗完成。FLY-2168 QA 实测单次开窗固有 ~43.5 s(两次 guarded tmux ensure,不可压缩),外层预算 480 s。这段时间里:issue-display 对 attach fail-closed(今日 `pending-target` **30 次**,每个 codex 体出生必现 2 次)、`sendKeysToWindow` / `killTmuxWindow` / `runner-recovery-nudge` 一律拒绝(tmux-lookup.ts:818/916,runner-recovery-nudge.ts:336-340)、patrol-orphan-sweeper 把所有 `:pending` 行从「有主」集合里过滗掉(patrol-orphan-sweeper.ts:74-85)。其中 attach 的 fail-closed 是 FLY-923 的正确设计;但 Lead 对一个正在干活的 codex 体**无法唤醒、无法救援、无法收尾**,不是设计,是缺口。

**倒置四(Lead 2026-09-03 现场取证,本单核实):Bridge 重启后窗口名换了一套,一个 runner 两个窗口。**
出生时窗口名 = `buildWindowLabel(issueId, runnerDisplayName(...), title)` = `FLY-2147-implement-codex-G-2132-B0-runner-spawn`;FLY-2211 的 re-own 路径重建 adapter 上下文时用 `[issue_identifier, issue_title].join("-")` = `FLY-2147-2132-B0-runner-spawn`(codex-session-reown.ts:117-122),不带 runner 段,而 `CodexLaunchSnapshot` 根本没有持久化 label。FLY-1239 的 purge **只按同名**清窗 ⇒ 出生窗活着、新名字再开一个,comm.db pin 到新窗,cmux watcher 按窗口名各建一个 workspace。今日 4 个 codex 体(FLY-2145/2147/2270/2301)每个都是一对窗、一对 cmux workspace,两窗 `@flywheel_exec_id` 相同、同一 thread 两个 TUI 客户端;`patrol_orphan_watch` 表里 `@455/@452/@442/@454` 正是那四个被 comm.db 抛弃的出生窗,`discoverTmuxTargetByExecutionId` 对它们返回 `ambiguous`。这就是 Lead 看到的「cmux 显示另一个、capture 报 can't find pane / 0 字节」。

### 2.3 一句话定位

issue 标题里的「FLY-1239 race」是 8-29 那次事故的**点火源**,已被 FLY-2168 + codex ≥0.151 顺带熄灭;但让点火变成整夜大火的**四处结构倒置**一处未修——下一个点火源(不论是什么)会烧出一模一样的形状。FLY-2170 作为「病根」单,修的应是结构,不是再修一次点火源。**事实边界(Lead ①)**:「今日 0 复现」是本单不再修出生 race 的依据,不是验收目标;验收对象只能是四处倒置各自的可核行为。

### 2.5 范围裁定(Lead 2026-09-03,question 8ff0b4ec)

Codex 设计评审 R1(10 条)→ R2(11 条)条数在涨,Lead 判定「面在长」:倒置四(一 runner 两窗)是 founder 今天肉眼疼的那个,**FLY-2170 只做 A4 / WS-D**;倒置一~三(A1 视图自愈、A2 进程真相接缝、A3 pending 收窄)另开一单承接。属于它们的 16 条评审原文与 rev 2 设计稿原样收进 `handoff-probe-axis.md`。本文档 §3–§6 保留全部四处倒置的分析作为病根记录;§6 的收口判据中只有第 6 条(一 runner 一窗)与第 1 条的「已告警 pending」口径属本单,其余随交接。

## 3. 方案空间

### 方案 A(采用):视图自愈 + 进程真相一个接缝 + `:pending` 语义收窄
- **A1 视图自愈**:adapter 在注册成功后定期(复用已有 heartbeat 定时器,不新增 timer)用异步 `display-message` 核一次 `@N` 是否仍在;连续 2 次不在 → 把 comm.db 指针先写回 `:pending`(真话:此刻没有窗口),再以新预算重跑**现有**开窗链。有上限、有告警、有 teardown 守卫。
- **A2 进程真相接缝**:在 `tmux-lookup.ts` 新增**一个**按 vendor 分派的探针 `probeRunnerLivenessForTarget(target)`:`vendor === "codex"` → `probeCodexDaemonLiveness(executionId)` 映射成既有 `RunnerLiveness` 词表;其他 vendor → 原探针,字节不变。`lookupTmuxTarget` 顺带带出已存在于 comm.db 的 `vendor` 与 `execution_id`。做终态/破坏性决定的消费者统一改调它;只做展示/advisory 的不动。
- **A3 `:pending` 收窄**:`:pending` 只保留一个含义「路由未就绪」;codex 体在 pending 期的**存活**判定归 A2(不再 `pgrep` 猜);sendKeys/kill/nudge/attach 对 pending 的拒绝保持(那段时间确实没有窗口),A1 保证 pending 不再是「永远」。
- **A4 窗口名单一来源**(Lead ②):出生 label 持久化进 `CodexLaunchSnapshot`;re-own 不再自己拼名字,只认「快照 label → 带本 execution `@flywheel_exec_id` 的活窗的名字 → fail closed(不开窗,告警)」;FLY-1239 purge 从「同名」扩到「同名 或 同 `@flywheel_exec_id`」。同 PR 删除 codex-session-reown.ts 的拼名分支。
- Pros:零新词表、零 schema、零新守护进程;A2 改的是一条 import 行/调用点;A1 重用 FLY-1239/2168 已经在生产验证过的整条开窗链。
- Cons:A2 消费者清单要逐个核(研究文档给出全表);codex 的 daemon 探针成本(lsof + ps)高于 `list-panes`,需要节流。

### 方案 B(否):Bridge 侧 pane 看门狗
pane-loss-reconcile 已能对 codex 判出 `absent` 并发 `advisory_codex`,让它反向通知 adapter 重开窗。否:Bridge 持有的是 `IAgentRunner`,**没有按 execution 找回活 adapter 实例的句柄**(plugin.ts 里只有 adapter→Bridge 的 `onTuiWindowLost` 单向回调);要加一个 execution→adapter 注册表就是新机制。且窗口的所有者本来就是 adapter。

### 方案 C(否):彻底不用窗口,cmux 直接挂 socket
去掉 tmux 窗口,让 cmux surface 直接跑 `codex resume --remote`。否:FLY-2168 刚把原生 TUI 恢复到 tmux 窗口,cmux watcher(FLY-2207/2281)整套身份与 receipt 契约建立在 tmux window 上;推翻它不是 FLY-2170 的范围。

### 方案 D(否):再修一次 FLY-1239 出生 race
在 adapter 里等 rollout 落地或加长重试。否:第 2.1 节证明点火源已经不在这条路径上;继续修它是在修一个已经不触发的分支,且会重新引入 FLY-1239 明确禁止的同步等待。

## 4. 假设(显式)

1. codex-cli 生产版本 ≥ 0.151(本机 0.153.0);`resume_running_thread()` 语义不回退。若未来 codex 升级回归,A1 的视图自愈会把它重新暴露为 `tui_window_lost` 告警,而不是静默 pending。
2. comm.db `sessions.vendor` 对所有 codex 体都已写为 `"codex"`(今日 10/10 codex 行为真;registerSession 第 6 参强制写入)。
3. `probeCodexDaemonLiveness` 的 `unknown` 语义是「不可证」,映射到 `indeterminate` 后所有消费者已有 fail-closed 处置(FLY-1282/FLY-720 契约)。

## 5. 非目标

- 不压缩单次开窗的 ~43.5 s(两次 guarded ensure 是 FLY-1336 的锁契约,归它自己的单)。
- 不改 attach 的 fail-closed(FLY-923)。
- 不改 orphan reaper 的 2 小时门槛与四证身份(FLY-2169/2211)。
- 不处理 `execution-mismatch` 形态(今日 exec 3a938c10 / FLY-2144):那是被 supersede 的旧 execution 指向同 issue 新窗,是 FLY-923 守卫按设计工作。
- 不碰 FLY-2296(Codex rate-limit nudge pin,并行在设计)。
- 不动 launchd / 不重启 Bridge / 不 deploy。

## 6. 收口判据(可核,给 QA)

部署后连续 ≥ 24 h 生产窗口,全部只读:
1. comm.db 中 `vendor='codex' AND status='running' AND tmux_window LIKE '%:pending' AND started_at < now-10min` 的行数 = **0**。
2. 对每个 `vendor='codex' AND status='running'` 行,`tmux list-windows -t runner-flywheel -F '#{window_id}'` 包含其 `@N` 的比例 = **100%**。
3. **回归哨兵(不是验收目标)**:bridge.log 中 `founder TUI DIED immediately` 与 `no rollout found` 若出现即报 Lead;`tui_window_lost` 若出现,必须对应一个 `app-server` 也已死亡的 execution(否则是 A1 失效)。
4. 谋杀演练:对一个健康 codex 体 `tmux kill-window -t runner-flywheel:@N`,要求 ≤ 2 个 heartbeat 周期内同 execution 重开窗、comm.db 重新指向新 `@M`、期间 zombie/patrol/crash-reaper **零终态动作**、app-server pgid 不变;连杀 6 次,第 6 次后 `tui_window_lost(reopen-exhausted)` 恰一次且不再重开。
5. 反向对照:对一个健康 codex 体 kill 其 app-server 进程组,要求 heartbeat 按既有路径判 dead(不是被 A1 反复重开窗遮住)。
6. **一 runner 一窗(Lead ②③,founder 可见)**:新起一个 Codex runner → 截图 cmux 对应 tab 显示 TUI 内容;`tmux list-windows -a -F '#{window_id} #{window_name} #{@flywheel_exec_id}'` 中该 execution **恰 1** 个窗,名字等于出生 label,comm.db `tmux_window` 指向它;随后经 `scripts/test-cycle-bridge.sh` 做一次 slot-only Bridge 重启(不碰生产 launchd),重启后仍恰 1 窗、同名、comm.db 同指向、cmux 仍只有一个同名 workspace。

## 7. 给 Lead 的非阻塞问题(已答,2026-09-03,question 5e6b311c)

- Q1(fsm-reconcile / session-prune 对 codex 体改判定还是跳过?)→ **改判定,不跳过**:跳过 = 让 codex 体永远逃出终态判定,是把误判换成盲区。探针接缝**只有一处**(按 vendor 分派),zombie / patrol / crash-reaper / fsm-reconcile 都从它取真相;探针不可得时 **fail-loud**(不静默当活、不静默当死)。
- Q2(重开上限常量还是 config?)→ **常量**,不加 flag / config(founder 立场:不留旋钮)。
- 附加硬要求 ①②③ 已分别落到 §2.3 事实边界、§3 A4、§6 第 6 条。
