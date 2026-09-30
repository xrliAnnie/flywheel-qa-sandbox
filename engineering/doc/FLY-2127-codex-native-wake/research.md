# FLY-2127 Codex runner 原生唤醒 — 调研
Issue: FLY-2127 (https://linear.app/geoforge3d/issue/FLY-2127/病根同类合并-7-张-codex-runner-叫不醒-停着空转唤醒和停驻一族-原引擎的-rework-wake-打不醒-goal)
日期: 2026-09-30
基于: exploration.md

## 1. 调研问题

1. Bridge 进程里谁持有 runner 的 daemon client，daemon 重启后 client 会不会换？
2. 「看到对应 userMessage」的回执，daemon 通知流里到底叫什么？
3. 删掉 JSON inbox 路径要碰哪些消费者和测试？
4. `blocked` 改成进 hold，会不会破坏 `classifyGoalOutcome` / DecisionLayer 的既有路由？
5. 升级路径要接哪条现成的告警管道？
6. 恢复门铃改 RPC 要保留哪些闸？

## 2. 发现

### 2.1 daemon client 的持有与更替

- `CodexDaemonGoalRuntime`（`codex-daemon-goal-runtime.ts:181-540`）私有持有 `session: { handle, client, codexHome, exited }`；
  `runGoal()` 在 daemon 死亡后 `startSession()` 重建 **新 client**，同一 thread 用 `resumeThread` 续（`:337-365, 428-534`）。
- `runGoalToTerminal` 通过 `client.setEvents({ onNotification })` 独占监听，结束时 `client.setEvents({})`（`codex-daemon-client.ts:659, 1000`）；
  它把每条通知**转发**给调用方传入的 `events.onNotification`（`:660`），`CodexTmuxAdapter` 目前只用它打心跳（`CodexTmuxAdapter.ts:696`）。
- 结论：投递 lane 不能自己抓 client 引用（会在重启后失效）；要给 runtime 加一个 `withClient(fn)` 访问器，
  每次投递都在**当前** session.client 上做 RPC；通知观察挂在 adapter 已有的 `onNotification` 转发点上。
  goal 循环里的 `goal_replaced` 守卫（`objectiveIsOurs`，`:648-656`）比较的是 objective 字符串，
  lane 用 `getGoal` 读回同一 objective 再 `set active`，不会被判成外来控制端。

### 2.2 通知名（回执依据）

- 本仓 goal 循环只认 `turn/started` / `turn/completed`（`codex-daemon-client.ts:667`）和 goal 通知；
  Codex Lead backend 同样只解 `turn/completed`（`codex-lead-tui-runtime.ts:201-225`）。
- app-server v2 协议里一个 turn 的输入以 `item/started` 通知携带 `item.type === "userMessage"`（含 `content[].text`）；
  本仓没有任何代码消费过它 → **必须由 M0 探针在本机 codex 上实测**方法名与字段。
- 回执定义（两级）：
  1. 主：`item/started` 且 `item.type==="userMessage"`、文本含 `[lead-instruction <id>]` 或 `[phase-wake <id>]` 标记；
  2. 备：M0 若证明 item 通知不可得，则以「我方 RPC 成功后的下一条 `turn/started`」做相关，且要求 `turn/started` 之后 30s 内无 `turn/completed status=failed`。
- 标记前缀已经存在：`send.ts` 给 runner 可见文本加 `[lead-instruction <id>]`，`reactivateWake` 加 `[phase-wake <id>]`（`codex-daemon-client.ts:795`）。lane 沿用这两个前缀，不发明第三种。

### 2.3 JSON inbox 路径的消费面

写方（都经 `wakeRunnerMailbox` → `AgentTeamTransportFactory.forBackend("codex").write`）：

| 写点 | 文件 |
|---|---|
| Lead `send` | `flywheel-comm/src/commands/send.ts:83-99` |
| `respond` 的 gate_answered 唤醒 | `flywheel-comm/src/commands/respond.ts:95-107` |
| Bridge approval / feedback wake | `teamlead/src/bridge/runner-wake.ts:141-160` |
| three-stage fix / retest wake | `teamlead/src/bridge/plugin.ts:6799-6870` (`wakePhaseRunner`) |

读方：只有 `CodexMailboxWatcher`（`agent-team-transport/src/codex/CodexAdapter.ts:381-485`），
由 `CodexTmuxAdapter` 在 `phaseKeepAlive` 时经 `transport.createReceiver` 建、`confirmHoldPaused` 时启动。

受影响测试（要改写而非删除）：

| 测试 | 行数 | 触及 |
|---|---|---|
| `flywheel-comm/src/__tests__/send-backend-routing.test.ts` | 202 | 断言 codex 走 `forBackend("codex").write` → 改为断言「入 CommDB 队列 + 不写文件」 |
| `flywheel-comm/src/__tests__/respond-ask-wake.test.ts` | 371 | 3 处 codex 引用 |
| `agent-team-transport/src/codex/__tests__/CodexAdapter.test.ts` | 284 | Watcher / inbox 用例整体退役，保留 preflight |
| `claude-runner/test/codex-phase-lifecycle.test.ts` | 354 | watcher 注入的 9 处改为 lane 注入 |
| `claude-runner/test/CodexTmuxAdapter.test.ts` | 1268 | 无 inbox 引用，新增 lane 生命周期用例 |

CommDB 侧已有可复用件：`runner_phase_wakes`（`db.ts:70-82`，`UNIQUE(execution_id,message_id)` + `source_instruction_id` 唯一索引）、
`enqueueRunnerPhaseWake` / `listRunnerPhaseWakes` / `markRunnerPhaseWakeStarted` / `finishRunnerPhaseWake`（`:967-1100`）、
`messages.delivered_at` + `markInstructionDelivered`、`markInstructionRead`（`:954`）。**不需要新表**；
只需把「入队」从 watcher 的 onDelivered 挪到写点，并给队列行加一列 `attempts INTEGER NOT NULL DEFAULT 0`
与 `last_error TEXT`（幂等 `ALTER TABLE … ADD COLUMN`，沿用 `delivered_at` 的 race-tolerant 迁移形状，`db.ts:267-300`）。

### 2.4 `blocked` 的既有语义

- `isTerminalGoalStatus` 把 `blocked` 列为 terminal（`codex-daemon-client.ts:35-46`）；循环只对 `complete` 进 hold。
- `classifyGoalOutcome` 把非 complete 的 terminal 记为 `failureReason: "goal ended non-complete: blocked"`（`codex-daemon-adapter-helpers.ts:161-170`），
  DecisionLayer 据此路由失败。
- 改动面：**只在 `phase` 存在（keep-alive 模式）时**把 `blocked` 与 `complete` 同等进 hold；非 keep-alive 路径字节不变，
  `classifyGoalOutcome` 不改。hold 内 `ensurePhasePaused` 会把 goal 置 `paused`，之后投递走 queue → set active，
  「Resume paused goal?」菜单只挡键盘，不挡 RPC（0.159 实测，来自 FLY-3064；FLY-2861「blocked 不弹菜单」的注释要改）。
- 风险：blocked 有可能是**真**卡（沙箱拒绝、权限）。hold 后不是静默——lane 在 blocked 进 hold 时写一条 `codex_goal_blocked_held` 事件，
  Lead 能看见；FLY-2096 的 stall 钟继续管「hold 内长时间无投递」。

### 2.5 告警管道

- Bridge 侧现成：`store.insertEvent({event_type:"runner_wake_failed"})`（`runner-wake.ts:186-195`）只是事件，不到 Discord。
- `LeadAlertNotifier.notify({reason,title,body})`（`LeadAlertNotifier.ts:50-54`）+ `ALERT_EVENT_TYPES` 常量数组（`:62+`）是 Lead 可见的工程告警面；
  新 kind 必须加进数组（FLY-927：回声免疫正则由它派生，漏加会重现 FLY-220 风暴）。
- 升级事件命名：`runner_wake_exhausted`（StateStore 事件）+ alert kind `runner_wake_exhausted`。

### 2.6 恢复门铃

- `attemptRunnerRecoveryNudge`（`runner-recovery-nudge.ts:80-281`）五道闸：allowlist 短语、status running、非 needs_review、无 pending gate、
  fingerprint + idle input box、tmux target。审计先于按键；审计库不可用则拒绝。
- Codex 分支改法：闸 0-3 原样保留；闸 4/5 之前先尝试 RPC（`queueAdd("continue")` + 若 goal 非 active 则 `set active`）；
  RPC 成功 → 审计 `sent via=rpc`；RPC 失败（socket 不通 / closed）→ 才走闸 4/5 + tmux 按键，审计 `sent via=tmux-fallback`。
  Claude 分支字节不变。

## 3. M0 探针（实现第一步，不过探针不开工）

复用 FLY-1269 的 `m0-complete-paused-probe.mjs` 形状（`engineering/doc/FLY-1269-codex-phase-keepalive/qa/`），对本机 codex 跑：

| # | 场景 | 要拿到的事实 |
|---|---|---|
| P1 | goal active + 长 turn 进行中 → `turn/steer` | 同 turn 内是否出现 userMessage 项；通知方法名 / 字段 |
| P2 | goal active + 空闲 → `thread/queue/add` | 起 turn 延迟；`item/started(userMessage)` 是否出现 |
| P3 | goal `paused` → `queue/add` 单独 | 是否自起 turn（决定 set active 是必要还是补刀） |
| P4 | goal `paused` → `queue/add` + `goal/set active` | 顺序 queue→active 是否消费；active→queue 是否也行 |
| P5 | goal `blocked`（TUI 挂「Resume paused goal?」） → P4 同流程 | 菜单是否真不挡 RPC |
| P6 | goal `complete` → P4 同流程 | complete 后能否续 |
| P7 | daemon kill → 重启 resume → 队列是否还在 | 队列 durable 性 |

探针输出写进 `qa/m0-native-delivery-probe.md`，方法名 / 字段名以探针为准回填 plan §3.2。

## 4. 未决与假设

| 假设 | 若不成立 |
|---|---|
| app-server 允许同一连接既跑 goal 又发 queue/steer（单 client） | 本设计单 client，天然成立；若某 RPC 只允许 TUI 连接，退回 `turn/start`（已验） |
| `item/started(userMessage)` 可观察 | 用 §2.2 备用回执 |
| queue/add 对 paused goal 不自起 turn | 顺序固定 queue→set active，plan 已按此写 |
| Bridge 重启后 adapter 会 re-execute 同 execId | FLY-1269 已声明 follow-up；队列 durable 保证补投，不在本单 |
