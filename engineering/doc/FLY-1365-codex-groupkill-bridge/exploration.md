# FLY-1365 codex 组 SIGKILL 误伤 Bridge — 探索

Issue: FLY-1365 (URL 不可得,只写 issue 号)
日期: 2026-07-18
基于: 无

## TL;DR — 审计推翻了 issue 的根因假设

**Bridge 反复 exit 137 的真凶不是 codex daemon 的 group SIGKILL escalation，而是 Bridge 自己的 `BridgeEventLoopWatchdog`（FLY-307）**：main loop 心跳停滞 >60s 时，watchdog worker 线程按设计 `process.kill(process.pid, "SIGKILL")`（把 hang 转成 launchd 可重启的 crash）。而把 main loop 卡死的，是 **FLY-1336（#633，事故前一天 2026-07-17 刚 merge）引入的 runner-TUI-window「guarded session ensure」spawnSync 同步重试链**（默认 deadline 210s、单次 attempt 上限 90s，远超 watchdog 60s 阈值），在 `tmux-server-rescue` 锁争用（`status=5 hold_lock_unavailable/acquire_timeout`）时把整个 event loop 阻塞到死。

铁证（对时精确到秒，详见同文件夹 `research.md`）：

- `~/.flywheel/bridge-watchdog.log` 里 `bridge_event_loop_stall` 条目与**每一次** Bridge 重启一一对应：`2026-07-18T16:36:40.910Z`（stall 64.3s）→ wrapper `09:36:42` 重启（Annie 事故那次）；`16:48:08`/`16:50:16`/`16:52:27` → `09:48:09`/`09:50:17`/`09:52:28`（crash 循环，~2min 一次，节奏 = 启动 + 60s stall + 5s check）。
- 每一代 crash 的死前最后日志签名完全一致：`[CodexTmuxAdapter] runner-tui-window: guarded session ensure attempt N held (status=5): hold_lock_unavailable / acquire_timeout` —— 然后日志戛然而止。
- **07-18 事故 crash 前 ~31 万行日志里没有任何一条 group-SIGKILL escalation**。issue 里「~09:34 escalation 紧接 09:36:42/09:39:15 重启」的时间钉死，实际是把 07-17 和 07-18 两天的日志混在一起了（`09:39:15` 那次重启在 log 行 1119776，对应 **07-17** 的 `16:39:14Z` watchdog stall；bridge log 的普通行不带时间戳，是这次误诊的直接土壤）。
- 在两次「escalation 后确实有重启」的案例里（07-17 01:38 / 07-17 09:39），escalation 之后 Bridge 还**继续正常打了 3.5-5 分钟日志**才被 watchdog 杀 —— `kill -9` 若真打中 Bridge 应是毫秒级即死。escalation 与 crash 只是同一负载风暴下的并发症状，不是因果。

**codex daemon 强杀路径本身经审计是组隔离安全的**（detached spawn 自领进程组、两事实 reap 证明、活体 ps 实测验证），但审计顺带发现一个**真实的潜在缺口**：`defaultKillGroup` 的自保护 guard 只挡 `pgid === process.pid || process.ppid`，而生产 Bridge 的真实 pgid 是**祖父进程**（launchd job 头 `npm exec tsx`）的 pid —— 「绝不杀自己组」这条意图在真实拓扑下没有被结构性兜住。本 issue 顺手把它焊死。

## 问题拆解

### issue 原始三问 → 审计答案

| Issue 修法候选 | 审计结论 |
|---|---|
| 1. 强杀范围收窄（查 escalation 是 `kill -- -PGID` 还是精确 pid） | 是 `process.kill(-pgid)`，但 pgid 是 **daemon 自己 detached 的组**（`spawn(..., {detached:true})`，daemon 领组），组里只有 rotation shim + `codex app-server`，结构上打不到 Bridge。范围已经是精确的，不需要收窄；需要的是把「绝不杀自己组」的 guard 缺口焊死（见下）。 |
| 2. 确认进程组关系（Bridge 为何与 daemon 同组） | **不同组**。活体实测：Bridge node（pid 30576）pgid=28163（launchd job 头 npm），daemon shim（pid 1265）pgid=1265（自领组），app-server（1427）也在 1265 组内。「同组误伤」不成立。 |
| 3. socket-停不干净的原因 | `ensureDead()` 的 settle 窗口默认仅 2s（`childExitWaitMs`），高负载（load 60+）下 `codex app-server` 响应 SIGTERM 慢于 2s 属常态 → escalation 是**按设计的正常兜底**，16 次出现反映的是负载，不是 bug。可选小改：settle 窗口放宽以减少不必要的 SIGKILL churn。 |

### 真正要修的问题

1. **P0 · main loop 被同步阻塞**：`codex-runner-tui-window.ts` 整个模块「a chain of spawnSync」跑在 Bridge main loop 上；FLY-1336 的 guarded ensure 重试链预算（210s deadline / 90s attempt cap / `Atomics.wait` 同步睡眠）与 watchdog 60s 阈值结构性冲突 → 锁争用时**必死**，且 boot redrive 会对每个恢复中的 codex runner 重新 ensure → 争用不消失就 crash 循环（07-18 实况：4 连杀）。
2. **P0 · 自伤死亡不可归因**（Annie north-star：静默/自伤失败可见性）：watchdog 杀进程时只写了一行孤立的 forensic log，没人看、没有告警、bridge log 普通行无时间戳 —— 于是一次 watchdog 自杀被误诊成 codex 组杀，P1 issue 的根因写错。要让「上一代 Bridge 是被自家 watchdog 杀的、当时卡在哪」在重启后自动浮出水面。
3. **P1 · killGroup 自保护缺口**：`defaultKillGroup` 挡不住「pgid == 自己真实所在组（由祖父 npm 领导）」的假想调用。当前无触发路径（属纵深防御），但这是一行代价极低的结构性保险。
4. **P2 · escalation churn**：2s settle 太紧 → 高负载下大量走到 SIGKILL escalation。放宽可减少日志噪音与不必要强杀。

### 伤害链澄清（3 个 runner 之死）

Runner 不是被 group SIGKILL 打死的：codex daemon detached、Bridge 死后 daemon 存活（ps 可见大量 ppid=1 的孤儿 daemon）；claude runner 在 tmux server 会话里，与 Bridge 组无关。3 个 runner（FLY-1342/1335 implement + FLY-1364）的损失是 **Bridge blink 的下游状态损失**：in-flight handoff stranded（FLY-1339/1293 已建单）、redrive 时孤儿 daemon 被（正当的、两事实证明的）reap。修好 blink 源头（问题 1）即消除触发器；stranded-handoff 恢复不在本 issue 范围。

## 方案选项

### 问题 1（main loop 阻塞）的选项

**A. 异步化 TUI-window ensure 路径（结构性根治）** — 推荐
- 给 `ensureSessionWithRetry` 增加 async 变体（`child_process.spawn` + await，同 args/语义/重试逻辑），`CodexTmuxAdapter` 的两个调用点（`onThreadReady`、fallback open）本就在 async 上下文里。
- 优点：main loop 永不因 TUI ensure 阻塞，Discord/HTTP/心跳全程在线；FLY-1336 的 210s 韧性预算得以保留（它对「等 tmux 恢复」是合理的，错只错在同步执行）。
- 缺点：改动面比 B 大；需要保住 FLY-1239（rollout-race 有界重试）与 FLY-1336 语义。

**B. 只收紧同步预算（最小修）**
- deadline 210s → ~15s、attempt cap 90s → ~5s，保持同步。
- 优点：几行改动。
- 缺点：main loop 仍会被单次 ensure 冻结十几秒（心跳/事件全停），只是低于致死线；且实际放弃了 FLY-1336 刚为饱和负载设计的韧性预算 —— 等于把前一天的 fix 拆了一半。

**C. 调高 watchdog 阈值（>210s）** — 否决
- 方向错误：watchdog 阈值是「hang 检测灵敏度」，调高等于让真 hang 多黑 3 分钟；且任何未来新增的同步链还会再撞。

**推荐：A 为主 + B 兜底**（预算改为 env 可调并把同步路径残余的最坏阻塞压到 << 60s）。两者都做，因为 A 治「这一条」链，B 的预算钳制 + 下面问题 2 的 breadcrumb 治「下一条」还没写出来的同步链。

### 问题 2（自伤可归因）的选项

**D. watchdog breadcrumb + 重启归因告警** — 推荐
- main 线程在进入已知长同步操作前写 breadcrumb（label + 时间，进 SAB 或文件），watchdog 的 forensic 行带上「最后卡点」；
- Bridge 启动时读 `bridge-watchdog.log` 尾条，若晚于上次干净退出 → 主日志打显眼一行 + 发一条 #flywheel-alerts：「上一代 Bridge 被自身 watchdog 杀（卡死 Xs，最后卡点: <label>）」。
- 这条是把本次误诊的土壤直接铲掉：下次任何同步链卡死，重启后 30 秒内自我归因。

### 问题 3/4（kill 路径加固）

**E. `defaultKillGroup` 增加「绝不杀自己真实所在组」**：`pgid === processGroupOf(process.pid)` 时拒绝（沿用现成 `ps -o pgid=` seam，取不到 = 不拦截以外的行为不变）；每次真实 killGroup 调用打一行带 pgid 的日志（可见性）。
**F. `childExitWaitMs` 默认 2s → 10s（env 可调）**：减少高负载下的 escalation churn。行为向后兼容（仅等待窗口变宽）。

## 建议的落地形状

- 一个 PR：A（async ensure）+ B（预算钳制）+ D（breadcrumb + 归因告警）+ E + F + 文档（本文件夹三件套即事故记录更正）。
- 不做/不碰：cmux/tmux rescue 锁争用为何发生（FLY-1336 域，若复现另开 issue）；stranded-handoff 恢复（FLY-1339/1293）；watchdog 阈值。

## 风险与开放问题

1. async 化后 ensure 与 teardown 的时序：`killWindow` 在 teardown 时可能与仍在飞行的 ensure 并发 —— FLY-1239 已有 `cancelReopen`/`runEnded` 边界，async 变体要挂进同一边界。
2. 多 Bridge 并存（生产 + QA slot worktree bridges）对 `tmux-server-rescue` 锁的争用是否就是 status=5 的来源 —— 归因告警（D）上线后自然可观测，不在本单内深挖。
3. breadcrumb 的粒度：只标注已知长同步操作（guarded ensure、tmux rescue、execFileSync 批量点），不做全量插桩。
