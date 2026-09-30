# FLY-2127 Codex runner 原生唤醒 — 探索
Issue: FLY-2127 (https://linear.app/geoforge3d/issue/FLY-2127/病根同类合并-7-张-codex-runner-叫不醒-停着空转唤醒和停驻一族-原引擎的-rework-wake-打不醒-goal)
日期: 2026-09-30
基于: 无

## 1. 一句话

Lead / 引擎发给 Codex runner 的每一条消息，都改成直接打进 runner 自己的 `codex app-server`
控制 socket（忙时 `turn/steer`、闲时 `thread/queue/add`、停驻时再补 `thread/goal/set active`），
回执改成「daemon 通知流里看到了对应的 userMessage」；JSON inbox 文件 + 谁来 poll 的整条路删除，
tmux 按键只留作最后一级、有审计的兜底。

## 2. 病根审计（对着本仓代码，不是对着 issue 的口述）

issue 把 7 张病根单合并成一族。逐条对到本仓 (v1.55.0 sandbox) 的真实代码路径：

### 2.1 现有投递链

```
Lead `flywheel-comm send`  ──►  CommDB.insertInstruction (durable, 永远先写)
                                      │
                                      ▼
                            wakeRunnerMailbox (wake.ts)
                                      │  vendor=codex
                                      ▼
                    CodexAdapter.write → ~/.flywheel/codex-teams/<team>/inboxes/<agent>.json
                                      │
                    (只有 phase hold 期间才有人读) CodexMailboxWatcher.scan  (1s poll + fs.watch)
                                      │
                                      ▼
                    CodexPhaseLifecycleController.onDelivered → CommDB.enqueueRunnerPhaseWake
                                      │
                                      ▼
                    runGoalToTerminal 循环 (held=true) observe() 看到 wake
                                      │
                                      ▼
                    reactivateWake: client.startTurn(`[phase-wake id] …`) → setGoalStatus("active")
```

关键事实（代码坐标）：

| 事实 | 位置 |
|---|---|
| Watcher **只在** `confirmHoldPaused()` 里启动，hold 之外 inbox 文件没人读 | `packages/claude-runner/src/codex-phase-lifecycle.ts:353-380` |
| `blocked` 被当作 terminal，goal 循环直接返回，不进 hold | `codex-daemon-client.ts:35-46` (`isTerminalGoalStatus`) + 循环 `if (terminalSeen) { if (phase && terminalSeen === "complete") enterPhaseHold … break }` |
| 唤醒是「一发即忘」：`sendRunnerWake` 单次尝试，失败只写 `runner_wake_failed` 事件；没有升级、没有 pane 兜底 | `packages/teamlead/src/bridge/runner-wake.ts:99-201` |
| `wakePhaseRunner` 只把文件写成功当 ok，不等 runner 真的开 turn | `plugin.ts:6799-6870` |
| CommDB `messages.read_at` 在 mailbox 模式**故意不设**（「没有可靠的 runner 侧 ack 点」） | `flywheel-comm/src/commands/send.ts` FLY-208 B 注释 |
| 恢复门铃 = tmux 打字 `continue`，五道闸 + 审计 | `bridge/runner-recovery-nudge.ts` |
| Bridge 进程**已经持有** runner 的 daemon client（adapter 在 `execute()` 里 `runtime.runGoal`） | `CodexTmuxAdapter.ts:404-500, 660-700` |
| daemon socket 路径由 execId 确定性推出，任何进程都能算出来 | `codex-daemon-runtime.ts:64-75` `resolveDaemonSocketPath` |

### 2.2 7 张病根单在这条链上的落点

| 单 | 症状 | 在链上的哪一环断 |
|---|---|---|
| FLY-2127 主单 | goal-complete 的 Codex 体 idle at "Goal achieved"，wake 打满耗尽 | complete 之后若不在 keep-alive hold（或 hold 已退出），watcher 没起，inbox 文件永远没人读；wake 耗尽后没有任何升级路径 |
| FLY-2464 | Bridge 重启后活体只被 reown_watch，看不到 turn 边界 | Bridge 重启丢了 daemon client，只剩心跳；没有任何进程再连 socket 观察 turn/started |
| FLY-2480 | 完工 drain 的 challenge 按 digest 匹配失败 | 与投递无关，但 drain 依赖 wake started/finished 状态机 → 本单把状态机改成「userMessage 看见即 finished」后 digest 匹配不再是唯一凭据 |
| FLY-2502 | 活体挂着 pending park_wake 交不了工 | pending wake 只能在 hold 里被消费；改为 hold 内外都由同一 lane 投递，pending 不会滞留 |
| FLY-2569 | 停驻体每轮收到自动 goal-continuation 空转 | 停驻后 goal 仍 active；本单：停驻 = goal `paused`，只有真实投递才 `set active` |
| FLY-2905 | 等 Lead 外部动作时 goal 自判 blocked → "Goal stalled"，send 永远 LEASED | blocked 在本仓是 terminal → 循环退出；应与 complete 同等进 hold，且 blocked 下投递 = queue/add + set active（RPC 不受菜单阻挡） |
| FLY-2953 | 等 CI park，CI 完成无人唤醒 | 引擎侧没有「CI 完成 → 投递」的写点；本单只保证一旦有写点，投递一定到达；CI 写点 = follow-up（FLY-2953 自留） |

## 3. 原生能力（本单的依据）

FLY-3064 在生产 repo 验过的 app-server RPC（本仓没有那份报告，结论按 issue 引用，M0 探针要在本仓复验）：

| RPC | 已验行为 | 本单用法 |
|---|---|---|
| `thread/queue/add` | 空闲线程 ~20ms 起 turn；daemon 重启后队列恢复 | 闲时投递 |
| `turn/steer` | 忙时同 turn 内生效（~30s 内被看到） | 忙时投递 |
| `thread/goal/set {status:"active"}` | ~6ms 起续跑 | 停驻（paused/blocked/complete）后补一刀 |
| 「Resume paused goal?」菜单 | 只挡人工键盘输入，挡不住 RPC | 不再需要 pane 门铃 |

本仓已经有的形状可以照抄：`CodexDaemonClient.startTurn` (`turn/start`)、`setGoal` (`thread/goal/set`)、
`getGoal`。`queueAdd` / `steerTurn` 是同一个 `request()` 的两个新方法。

## 4. 方案空间

### 方案 A（选定）：Bridge 内 adapter 常驻「原生投递 lane」，CommDB 是唯一入口

- 入口不变：`flywheel-comm send` / `wakeRunnerMailbox` / `wakePhaseRunner` 仍先写 CommDB（`messages` 行 + `runner_phase_wakes` 行）。
- **删掉** CodexAdapter 的 JSON inbox 写与 CodexMailboxWatcher 读；vendor=codex 的 `wakeRunnerMailbox` 改为「只入 CommDB 队列，返回 ok=queued」。
- `CodexTmuxAdapter.execute()` 在拿到 daemon client 后立刻启动 `CodexNativeDeliveryLane`，**整个 execute() 生命周期常驻**（不只 hold）：1s 轮询 CommDB 队列 → 按 daemon 状态选 RPC → 写回执。
- 回执 = daemon 通知流里出现带 `[lead-instruction <id>]` / `[phase-wake <id>]` 标记的 userMessage → `runner_phase_wakes.state=finished` + `messages.read_at`。
- 升级：投递失败 N 次（socket 不通 / RPC 拒）→ `runner_wake_exhausted` 事件 + LeadAlertNotifier 工程告警 + 一次有审计的 tmux 兜底（`/goal` 指针 + Enter）。

优点：不引入新进程、不引入跨进程 socket 竞争（daemon client 仍只在 adapter 手里）、CommDB 本来就是共享 durable 存储、Bridge 重启后 adapter re-execute 会重连同一 socket 并把队列里 pending 的行重新投递。

### 方案 B：`flywheel-comm send` CLI 直接连 runner socket

- Lead 进程自己算 socket 路径、连上去 queue/add。
- 否决：flywheel-comm **不能**依赖 claude-runner（claude-runner 依赖 flywheel-comm，会成环）；要把 JSON-RPC 客户端下沉到 agent-team-transport 再加 `ws` 依赖；且两个进程同时对一条 thread 发 RPC，goal 循环里的 `goal_replaced` / `objectiveIsOurs` 守卫会把它当外来控制端；Lead CLI 在 Bridge 挂掉时也照样送不到。

### 方案 C：只做升级，不换通道（issue 原修法方向 ①②）

- wake 耗尽 → 通知 Lead + pane 门铃。
- 否决（founder 9-29 13:44 批「可以被取代的直接取代」）：pane 门铃本身就是不可靠的通道（菜单挡键盘、TUI 没开、cmux 断连），只能当最后一级。

## 5. 边界

做：
- `queueAdd` / `steerTurn` 两个 RPC 方法；
- Codex 投递 lane（常驻、CommDB 驱动、状态感知选 RPC、userMessage 回执、有限升级）；
- `blocked` 在 phase 模式进 hold 而不是终结；
- rework / wake 续跑补 `goal/set active`；
- 恢复门铃 Codex 分支改 RPC，tmux 只兜底；
- FLY-2861「blocked 不弹菜单」注释修正；
- 删除 JSON inbox 路径（含 CodexMailboxWatcher）。

不做：
- `instant_interrupt`（under development，FLY-3066 周更决定灰度）；
- CI 完成 → 自动唤醒的写点（FLY-2953 自留）；
- Claude runner 收信路径：**零改动**（QA 判据 ④ 是回归项）；
- Bridge 进程级 crash 后自动重建 adapter（FLY-1269 已声明 follow-up；本单只保证队列 durable、re-execute 后补投）。

## 6. 待 Lead 决断（非阻塞，按默认继续）

| 问题 | 默认 |
|---|---|
| queue/add 在 goal=paused/blocked 时是否自动起 turn，还是必须 set active 之后才起？ | M0 探针实测；默认「queue → set active」顺序，探针若证明 queue 自起则 set active 只作幂等补刀 |
| 升级阈值 N 与间隔 | N=3，指数退避 2s/8s/30s，总 ≤ 60s 落入升级（远短于 FLY-2096 的 60 分钟 stall 钟） |
| JSON inbox 目录 `~/.flywheel/codex-teams` 里残留的旧文件 | 不迁移；lane 启动时若发现旧 inbox 有未 ack 消息，一次性并入 CommDB 队列后删除文件（一次性 shim，带日志） |
