# FLY-1286 Codex 常驻三段式 529 Room 真机 E2E — Research

Issue: [FLY-1286](https://linear.app/geoforge3d/issue/FLY-1286/qa-fly-1269-codex-常驻三段式-529-room-真机-e2edesigncodex-implementcodex)
日期: 2026-07-15
基于: exploration.md、FLY-1269 candidate snapshot `c833f78b`

## Scope

本研究只审计当前 worktree 的 candidate code、现有设计/测试与 test-slot-2 的实时状态。
未使用外部网页或生产运行数据；原因是本票的权威来源就是隔离 Bridge、该 branch、
StateStore、CommDB 与每个 runner 的 CODEX_HOME。

审计重点：

- `packages/config/src/three-stage-phases.ts`
- `packages/edge-worker/src/Blueprint.ts`
- `packages/teamlead/src/bridge/phase-orchestrator.ts`
- `packages/claude-runner/src/CodexTmuxAdapter.ts`
- `packages/claude-runner/src/codex-daemon-client.ts`
- `packages/claude-runner/src/codex-daemon-goal-runtime.ts`
- `packages/claude-runner/src/codex-phase-lifecycle.ts`
- `packages/flywheel-comm/src/db.ts`
- `packages/teamlead/src/bridge/codex-phase-shutdown.ts`
- `packages/teamlead/src/bridge/post-merge.ts`
- FLY-1269 / FLY-1224 / FLY-921 / FLY-939 的设计与测试证据

## Finding 1 — Phase routing is table-driven, but Design=Codex is a runtime override

`three-stage-phases.ts` 是顺序与 dispatch spec 的单一来源：

- sequence 固定为 `design → implement → qa`；
- default implement 为 `codex / gpt-5.6-sol / xhigh`；
- default QA 为 Claude 的 medium tier，当前解析为 `claude-opus-4-8`；
- default Design 是 Claude/Fable，只有
  `FLYWHEEL_THREE_STAGE_CODEX_DESIGN=1` 才切到同一
  `CODEX_STANDARD_DISPATCH`（Codex / gpt-5.6-sol / xhigh）；
- `FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0` 会把 Implement fallback 到 Claude。

因此本票不能只引用源码默认值证明“Design=Codex”。必须同时证明隔离 Bridge 本次 runtime
override 生效：成功 Design session 的 `adapter_type=codex-tmux`、vendor registry 为
`codex`、model 为 `gpt-5.6-sol`，并从 daemon argv/TUI 证明 xhigh（若本票只锁 Design
vendor、不要求 Design effort，仍记录 effort 作为解释性证据）。

Implement effort 不被 StateStore 独立列持久化。FLY-1224 明确选择 phase table 每次重推导
vendor/effort，不增加 StateStore 列；daemon 才用
`-c model_reasoning_effort="xhigh"` 接收真实值。因此 `session_params` 或 issue title 不是
xhigh 的充分证据，必须采 daemon argv，TUI 的 `model: … xhigh` 作为第二来源。

## Finding 2 — Native complete is intercepted into a durable paused hold

`runGoalToTerminal()` 在普通 runner 中把 `complete` 当 terminal；当 `phaseLifecycle` 存在
时，`terminalSeen === complete` 会改走 `enterPhaseHold()`：

1. 把剩余 active deadline 与 hard deadline 写入 `session.json.phaseHold`，先落
   `state=entering`；
2. 对同一 thread/goal 执行 full-field `thread/goal/set(status=paused)`；
3. 再以 `thread/goal/get` 确认 paused 且 objective 属于本 goal；
4. 将 latch 改为 `state=paused`，此后才启动 mailbox watcher；
5. local loop 只轮询 lifecycle activity，不启动 model turn。

`CodexPhaseLifecycleController.observe()` 的优先级是 shutdown > unfinished wake > declared
parked > active。DB 读失败返回 `unknown`，goal loop 会继续慢轮询而不是误退出。这个顺序
使 issue terminal 能压过已经排队的普通 wake。

真机验收必须在 Design phase 的 `complete` 和 `park` 都成功后观察以下组合，而不是只看
任意一项：

- StateStore status 已到 `design_done`，execution row 仍在且 heartbeat 继续；
- CommDB `runner_declared_states.kind=parked`；
- `session.json.phaseHold.state=paused`；
- native `thread_goals.status=paused`；
- tmux window 存活，execution-private control socket 可连接且 `lsof` holder 属于
  `daemonPid` 领导的 detached process group。

这五项联合才能区分“活着且 hold”与“DB label 残留/进程已死”。

`session.json.daemonPid` 必须按实现语义解读：它是 rotation shim pid/process-group leader，
不是持有 socket 的 app-server pid。`codex-daemon-runtime.ts` 明确禁止用
`process.kill(daemonPid, 0)` 作为 app-server 死亡证明；真正 liveness/death oracle 是
execution-private socket 的 bounded connect，再以 `lsof` holder/PGID 交叉验证。

## Finding 3 — Budget freeze is a persisted remainder, not a reset

进入 hold 时，runtime 保存：

- `deadlineRemainingMs`
- `hardDeadlineRemainingMs`
- `enteredAt`
- phase role

hold 期间 `remainingBudget()` 不再被 model loop读取，native goal paused，理论上
`tokens_used`、`time_used_seconds` 与 `updated_at_ms` 均不增长。wake 成功后 runtime 用
当前时刻加保存的 remainder 恢复两条 deadline，而不是用原始 timeout 重开一份预算。

daemon restart 时，`CodexDaemonGoalRuntime` 继续使用同一 `startedAt`、deadline floors、
phase lifecycle 与 resume thread；`runGoalToTerminal()` 若发现已持久化 phaseHold，先
恢复 deadline 并 `ensurePhasePaused()`，不会发送 generic initial kick。

因此预算验收需包含两个窗口：

1. 正常 hold ≥60s：goal token/time/updated_at 与 phaseHold 两个 remainder 不变；
2. kill/restart 后 hold ≥60s：shim/PGID 变化且同一路径 socket 由新 group 重新持有，但
   同一 goal 的 token/time、phaseHold 与 remainder 仍不变。

只比较 token 数不够，因为缓存/延迟写入可能造成误判；同时比较 time、updated_at、
phaseHold 和当前进程身份。

## Finding 4 — Mailbox delivery and wake execution have distinct durable records

`flywheel-comm send` 先写 `messages` instruction，再按目标 CommDB session 的 vendor 写
对应 mailbox。Codex watcher 回调不会直接开始 turn；它先调用
`enqueueRunnerPhaseWake()`：

- 验 `metadata.execId` 等于 target execution；
- 用 `metadata.flywheelId` 绑定 CommDB instruction；
- queue insert 与 instruction `read_at` claim 在同一 transaction；
- `(execution_id,message_id)` 与 `(execution_id,source_instruction_id)` 双重去重；
- callback 重试返回既有 row，可安全 ack transport。

激活顺序固定为：

1. wake row `pending → started`；
2. paused goal 上先 `turn/start([phase-wake id] …)`；
3. 再把同一 goal 设为 active；
4. wake turn 已提交后，仅重试 durable bookkeeping，绝不重放 `turn/start`；
5. row `started → finished`，clear declared park，删除 phaseHold；
6. agent 当前 turn 完成、native goal 再 complete 后重建新的 phaseHold。

FLY-1269 app-server probe 已证明 active transition 不会在 wake 仍 running 时并发创建第二
turn；wake 完成后同 goal 的顺序 auto-continuation 是允许的。真机本票不需要从日志重新
证明每个毫秒，但必须证明 stable id、same thread/goal、wake row 完整状态与新的
`phaseHold.enteredAt`。

Lead wake 指令必须是无副作用 probe。Design 被唤醒后按 prompt 先执行 TURN，预期 CLI
真实输出 `not-yours`，只报告并 re-park。这样即使 mailbox 重放，也没有可重复的外部
side effect。

## Finding 5 — TURN current row is authority; history may contain failed setup noise

CommDB 包含：

- `three_stage_turn(issue_id PK, holder_exec_id, phase, epoch, granted_at)`：当前唯一 authority；
- `turn_source_history`：append-only source event 审计。

PhaseOrchestrator 在 handoff 中先确认 worktree clean/ready，再 grant TURN，然后 wake existing
phase 或 spawn successor。Codex prompt 也要求每次 phase wake 首动作执行 `turn`，只在
`yours` 后才能触碰 worktree。

FLY-1286 在成功 execution 前已有多次 blocked/terminated Design attempt，history 已存在
多个 epoch=1 的 spawn source。这不表示本次 chain duplicate。验收算法应：

1. 以成功 Design exec `c552669e-…` 作为 root；
2. 记录它完成时的 current row；
3. 从随后产生的 Implement/QA session 与 current TURN 变化建立 epoch 2/3；
4. 旧 attempt 只归档，不计入成功链数量；
5. 若成功链内出现同 phase 两个 live execution 或 epoch 回退，才 FAIL。

daemon crash 只应改变 Design 的 shim/PGID 与该 group 内的 socket holder，不应改变
StateStore execution、CommDB TURN 或新增 turn history。这个 negative assertion 能区分
“same-session recovery”和“Bridge 又 spawn 了一个替身”。

## Finding 6 — Controlled shutdown evidence is transient by design

`prepareCodexPhaseShutdown()` 只适用于 `adapter_type=codex-tmux` 且 role 为
design/implement/qa 的 resident phase。对 live、heartbeat fresh 的 controller：

1. Bridge 写 `runner_shutdown_controls(state=requested, request_id=…)`；
2. adapter 的 shutdown race 赢后停止 goal runtime、drain daemon/TUI、scrub credential；
3. 只对同 execution + request id 写 `acked`；
4. Bridge 重新确认 TUI/target 已 gone 后才允许后续 cleanup；
5. probe indeterminate、DB error、heartbeat 仍前进但 ack timeout 都 fail closed，不直接 kill。

如果 heartbeat stale、target gone 或 process 被证明 dead/absent，Bridge 才允许 legacy
direct cleanup；liveness indeterminate 或 heartbeat 仍前进但 ack timeout 都是 blocked，
不能 direct kill。

成功 cleanup 最终会调用 CommDB lifecycle prune，删除 wake、shutdown 与 session rows。
因此 `runner_shutdown_controls` 是瞬态握手表，不是长期审计表。final observer 必须在终态前
运行，以 50ms cadence 记录 requested/acked。单纯轮询仍可能错过 ack→delete 窗口，所以
observer 还必须读取 durable `session_events`：`closeRunner` 只有在 graceful shutdown 完成
后才写 `lead_close_runner`，其 payload 带同一个 `phaseShutdownRequestId`。捕获到 request
但错过 ack 时，可用同 request id 的 durable event 佐证；没有相同 id 佐证不得 PASS。

observer 同时连续采样 StateStore `heartbeat_at` 与 CommDB tmux target liveness。对 live 且
heartbeat-fresh controller，request/ack（或上述同 id graceful event）是强制 oracle；对
已经证明 target gone/dead 或 lease stale 的 controller，缺少 handshake 应分类为
`direct_proven`，而不是误报“跳过协议”。`direct_proven` 不是本票所需 handshake 的替代物：
它记录 cleanup path 合法，但本次注入 E2E 仍需重跑才能取得 `runner_shutdown_controls`
验收。liveness indeterminate 必须 fail closed。

终态进程清理也不能以 persisted `daemonPid` 的 `kill -0` 为准。FINAL oracle 必须要求
execution-private socket bounded connect 失败且 `lsof` 无 holder；`lsof` 不存在、权限不足
或结果不可解析均是 indeterminate，不得当作“无 orphan”。随后再用 row deletion、tmux
消失与 StateStore terminal event 完成闭环。

QA=Opus 是 Claude runner，不应产生 Codex shutdown-control row；它走既有 Claude close
路径。验收应断言 Design/Implement 两个 Codex execution 有 request/ack，而不是错误要求
三个 phase 都写该表。

## Finding 7 — Evidence ownership must cross the phase boundary

没有单个 phase 能完整自证：

- Design 活跃时看不到自己的 hold；
- Implement 活跃时能看 Design hold/crash/wake，但看不到自己的 hold；
- QA 能看 Design+Implement hold，却在 issue terminal 时也会被关闭；
- cleanup 会删握手表。

因此证据责任分四层：

| Owner | Evidence |
|---|---|
| Design | baseline manifest、设计 docs、成功 handoff id |
| Implement | Design hold 60s、daemon crash recovery、Lead wake request 与 wake row |
| QA Opus | 两个 Codex phase parked、Implement xhigh、TURN epoch 1→2→3、独立复核 |
| FLY-1269 closing session / Lead observer | terminal request→ack→delete、all processes/session/TURN gone |

QA 可以在 terminal closeout 前给出 `PHASE PASS / TERMINAL PENDING`，但只有外部 observer
补齐最后一层后才能写 `FINAL PASS`。这不是降低验收，而是避免由即将被销毁的主体对自己
销毁成功作循环论证。

## Finding 8 — Isolation must enumerate protocol-owned runtime paths

“不碰 production `~/.flywheel`”不能按字面作为 oracle，因为本次真实 Codex runner 的
execution-private control plane 就位于该 root：

- `~/.flywheel/state/codex-sessions/<exec>/**`
- `~/.flywheel/codex-homes/<exec>/**`
- `~/.flywheel/cdx-sock/<sha1(exec)[0:16]>.sock` 与 `.lock`
- `~/.flywheel/state/codex-gates/<question>.json`
- `~/.flywheel/state/review-requests/<request>.json`
- test-slot-2 的 `~/.flywheel/comm/test-slot-2/comm.db*`

这些都是本 execution/gate 可唯一归因的协议写入，不是 production project data。A8 应断言
“没有写出上述 allowlist + `/tmp/flywheel-test-slot-2/**` + qa-sandbox branch”，并特别检查
没有修改其他 project CommDB、其他 execution state、production repo/branch。observer 的
SQLite 读取本身必须使用 `sqlite3 -readonly` 与 `PRAGMA query_only=1`；裸 `sqlite3` 对 WAL
数据库可能创建/恢复 `-shm/-wal`，不能满足 read-only 声明。

## Current Live Baseline

2026-07-15 本次研究读取到：

- StateStore DB: `/tmp/flywheel-test-slot-2/teamlead.db`
- CommDB: `/Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db`
- Design exec: `c552669e-611b-47fc-98ca-63371c81cbe8`
- Design thread: `019f6506-6123-7453-9bc1-5aaaa4c32c58`
- Design adapter/model: `codex-tmux / gpt-5.6-sol`
- Design goal id: `acedce0b-ad08-47b8-adbe-0618df6caa09`
- TURN: `design / epoch 1 / holder c552669e-…`
- candidate SHA: `c833f78b552b0df54fb49d8f0d7c79331513ea28`
- sandbox remote branch: `origin/flywheel-FLY-1269`
- qa-sandbox 当前没有该 head 的 PR；production PR #604 不属于此 remote，不能用
  `gh pr view 604` 在 sandbox 代替 production PR 证据。

旧失败 attempt 包含 blocked Codex Design、terminated Codex Design 与一个 terminated
Claude main 预检。它们应保留在 raw session snapshot 中解释，但必须从 manifest 的
successful chain 过滤掉。

## Acceptance Oracle

| ID | Requirement | PASS oracle | FAIL oracle |
|---|---|---|---|
| A1 | locked dispatch | successful chain roles 恰为 Codex / Codex xhigh / Opus；无 Sonnet | backend/model/effort 任一不符或 fallback |
| A2 | Design resident | complete+park 后同 exec/thread/goal ≥60s paused/parked，socket live 且 holder group 可归因 | socket dead、替身 exec、goal active、token 增长 |
| A3 | crash recovery | shim/PGID 变化、socket 由新 group 重持有；exec/thread/goal/phaseHold/TURN 不变 | orphan holder、新 phase session、goal/thread 变化、budget 重置 |
| A4 | mailbox wake | instruction delivered；wake row pending→started→finished；新 hold | 无 row、错绑定、stable id 重复副作用、未 re-hold |
| A5 | Implement resident | needs_review+park 后同 exec/thread/goal ≥60s paused，socket/holder group live | socket dead或 goal/token继续跑 |
| A6 | TURN chain | current holder 单调 Design→Implement→QA，epoch 1→2→3 | 回退、wrong holder 写 worktree、两个 live holder |
| A7 | shutdown | live/fresh Codex exec 各 requested→acked（或同 request id durable graceful event）→delete；socket 无 listener/holder、all phases gone | live/fresh 无握手/佐证、failed/stuck、socket orphan、TURN 残留；proven direct 单独分类并重跑握手验收 |
| A8 | isolation | mutation 只在枚举的 per-exec/gate/test-slot-2 runtime paths 与 qa-sandbox；observer DB read-only | 写入其他 project/execution/production repo，或 observer 以 read-write 打开 WAL DB |

缺证据等价于未通过，不允许把 `N/A`、自报、静态 prompt、旧 FLY-1269 单测或“没有看到
错误”替代上述 oracle。

## Regression Checks

真机链之外，QA 应复跑当前实现的窄测试，确认 fault injection 失败时不是候选实现本身已
在静态层红：

```bash
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-phase-lifecycle.test.ts \
  test/codex-daemon-client.test.ts \
  test/codex-daemon-goal-runtime.test.ts

pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/codex-phase-shutdown.test.ts \
  src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts \
  src/bridge/__tests__/phase-orchestrator.fly939-wake-not-respawn.test.ts \
  src/__tests__/phase-orchestrator.fly921-adversarial.test.ts

pnpm --filter flywheel-config exec vitest run \
  src/__tests__/three-stage-phases.test.ts
```

这些测试是 fail-fast 辅助，不是 A1–A8 的替代物。

## Research Conclusion

推荐的 E2E 不需要任何 production code change。最小充分方案是：真实三段链、跨 phase
反向观察、一次 bounded Design mailbox wake、一次 parked Design daemon crash、终态前
预置外部 shutdown observer。plan 必须把 observer 的启动时机、row 被删除的事实、
successful-chain 过滤、effort 的真实证据源与每个 FAIL stop condition 写成可逐步执行的
命令，避免 Implement/QA 自行缩窄验收。
