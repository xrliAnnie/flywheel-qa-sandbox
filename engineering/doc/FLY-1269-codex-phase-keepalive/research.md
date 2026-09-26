# FLY-1269 Codex Phase 全程常驻 — 调研
Issue: FLY-1269 (https://linear.app/geoforge3d/issue/FLY-1269/fix-codex-phase-会话在-phase-完成后就退出不像-claude-常驻到-issue-做完-三段式全程常驻缺失)
日期: 2026-07-14
基于: exploration.md

## Research Question

在不复制 issue FSM、不改变 Claude 行为、不引入热模型轮询的前提下，现有
Codex `/goal`、three-stage park/wake、CommDB mailbox 和 lifecycle closeout 能否组成
一条真正的「phase boundary park、same-thread re-engage、issue-terminal teardown」
闭环？如果能，缺口具体位于哪些文件、哪些 race 需要硬化？

## Scope and Method

本次调研只读检查当前 `origin/main` 与已存在的设计/测试；FLY-1257 尚未合并，因此
仅把其分支当作相邻变更与 protocol evidence，不把其冻结 scope 合并进本单。检查面：

- `packages/claude-runner`：Codex adapter、daemon runtime/client、TUI、测试；
- `packages/edge-worker`：Blueprint phase 识别、prompt、adapter context；
- `packages/agent-team-transport`：Codex mailbox watcher；
- `packages/flywheel-comm`：session registry、declared state、send/park/turn；
- `packages/teamlead`：PhaseOrchestrator、closeRunner、post-ship/lifecycle closeout、
  Bridge restart readopt；
- FLY-1188、FLY-1224、FLY-1257 的现有文档与测试证据。

## Findings

### F1 — 直接退出点在 Codex adapter 的无条件 finally

`packages/claude-runner/src/CodexTmuxAdapter.ts` 当前只调用一次
`runtime.runGoal()`。无论 outcome 是 success、blocked、timeout 还是 setup error，
`finally` 都会执行：

1. `runEnded = true`，取消 founder TUI reopen；
2. 停 gate deadline watcher；
3. 停 heartbeat；
4. kill founder TUI window；
5. `runtime.stop()` + `await runtime.drained()`；
6. CommDB session 更新为 completed/timeout；
7. scrub Codex credential。

现有 `CodexTmuxAdapter.test.ts` 的 happy-path 还把这件事锁成正确行为：complete 后
断言 window kill 一次、runtime stop/drain 各一次。修复必须把这个测试拆成两类：

- 普通 Codex/single-session complete：保持当前 terminal reclaim；
- three-stage phase complete + park evidence：不得进入 finally，改为 phase hold。

### F2 — Resident runtime 已能保留同一 daemon/thread，但 terminal 判定过早

`codex-daemon-goal-runtime.ts` 的 `CodexDaemonGoalRuntime` 在一次 `runGoal()` 内可：

- start/resume 同一 thread；
- daemon transport death 后轮换并 resume；
- 复用同一 objective/token budget；
- 直到 `runGoalToTerminal()` 返回才结束本次 call；
- adapter 调 `stop()` 前 daemon 不主动回收。

`codex-daemon-client.ts` 的 `runGoalToTerminal()` 同时消费 goal notification 和
`thread/goal/get` poll fallback；`complete` 属 terminal status，任何一路看到都会
return。这是 phase hold 最窄的拦截点：两条观察路径必须共用一个 terminal/hold
classifier，不能只修 notification 或 poll 其中一条。

当前 deadline以 `runStartedAt` 为绝对锚点：active默认24h，只有 gate-open predicate
能把等待期扩到49h。若 phase hold不改预算，paused session仍会在 issue未结束时超时。
更关键的是 `hardDeadline=startedAt+max(24h,49h)`，现有所有 extension都会被它
`Math.min` clamp；只推进 carried absolute deadline无法跨过49h。本单必须新增窄
phase-hold clock suspension：进入 hold同时冻结 current deadline与 hard deadline的
剩余值，hold loop不调用 active `remainingBudget()`，退出后只用 `now+remaining`
恢复一次；重复 hold累计排除。active/gate与 daemon restart仍保留 MED-7“不重置预算”
约束，phase idle本身没有49h cap，teardown只由 issue-terminal closeout触发。

### F3 — Native paused 可用，但 complete→paused 尚无真机证据

当前 protocol type 已包含 `active|paused|blocked|usageLimited|budgetLimited|complete`，
`thread/goal/set` 可以携带完整 objective、tokenBudget、status。

FLY-1257 在 2026-07-14 的真 app-server probe（codex-cli 0.144.4）已证明：

- active goal 可切 paused，停止新 turn；
- paused 状态与 objective/budget 跨 daemon restart + thread/resume 持久；
- paused 切 active 后同一 goal 自动恢复；
- 生产实现仍应显式重发 objective/tokenBudget，不赌 partial-update preservation。

但该 probe 没覆盖本单关键边：goal 已发 `complete` 后能否合法重置为 `paused`。
因此实施 Task 0 必须先用真 app-server 验证
`active → complete → paused → active → turn`，并记录原始 RPC 帧。若 complete→paused
被协议拒绝，不能静默退回 hot poll/respawn；应 fail-close 并重新过 Lead 架构 gate。

### F4 — Blueprint 知道 phase 身份，adapter context 不知道

`BlueprintContext` 已有：

- `sessionRole`；
- `shareParentBranch`；
- Auto-QA 的独立 `qaContext`；
- `FLYWHEEL_THREE_STAGE_KEEPALIVE` kill switch。

Blueprint 也已准确区分 design/implement/three-stage QA 与 Auto-QA。可是
`AdapterExecutionContext` 没有 phase identity，`adapter.execute()` 调用也没转发。
因此 Codex adapter 不能安全判断一个 complete 是否应 hold；从 env 或 label 猜 role
会误伤 Auto-QA/single-session。

建议增加窄、结构化字段：

```ts
phaseKeepAlive?: {
  role: "design" | "implement" | "qa";
};
```

仅当 `shareParentBranch===true`、role 属三段、keep-alive kill switch ON 时传入。
Claude adapter可以忽略该可选字段；Auto-QA 不得携带。

### F5 — Codex phase prompt 当前仍是过渡合同

Blueprint 对 Claude three-stage phase 已写明：phase 完成后 `park` 并等待；Codex
分支为了 FLY-1188 过渡，仍明确要求完成后 `END YOUR TURN`，没有真实 park promise。

机制落地时需要同窗更新 Codex 专属文本：

- Design：`complete --route phase_design_complete` 后 `park`，结束当前 turn；
- Implement：`complete --route needs_review --question-id ...` 后 `park`；
- QA FAIL：`qa-result --status fail`、提交证据后 `park`；
- wake：先 `turn --exec-id`，只在 `yours` 时操作 shared worktree；
- phase hold 不等于 goal complete，issue-terminal closeout 才结束 session。

不能先改合同再落 runtime；测试应先 RED，机制与文本同 commit 才转 GREEN。

### F6 — Bridge 已经有正确的 park/wake authority

`PhaseOrchestrator.onPhaseComplete()` 对 design_done/awaiting_review handoff：

1. capture phase head；
2. keep-alive OFF 时 close + spawn（legacy）；
3. keep-alive ON 时 probe runner process；
4. alive → `parkPhaseRunner()`，dead → close；
5. grant next phase TURN；
6. alive target → wake in place，否则 spawn。

`plugin.ts` 的 production effects 已实现：

- park：CommDB `runner_declared_states` upsert `kind=parked`；
- wake：先 clear declared state，再通过 backend-specific mailbox 投递 exact instruction；
- getAlivePhaseSession：running/awaiting_review/approved_to_ship/design_done；
- probe：读取 CommDB tmux target，并检查 pane process liveness。

所以 runner 不需要知道 handoff 是否成功、下一 phase 是谁。`declared parked` 是
phase boundary 已被 Bridge 接受的窄证据与 watchdog quiet marker；mailbox message
是 re-engage 输入；TURN row继续是 shared branch写权威。它不应成为 lifetime gate：
显式 phase身份的 complete即使先于 marker也必须 hold，marker缺失只触发告警/reconcile。

### F7 — Codex mailbox watcher 已实现但 adapter 未接线

`CodexRunnerTransport` 已暴露 `createReceiver()`；`CodexMailboxWatcher` 已提供：

- inbox directory `fs.watch`；
- poll fallback；
- 按 durable message id 去重；
- delivery ack；
- callback error fail-loud；
- watcher restart 后重新扫描未读消息。

`CodexTmuxAdapter` 当前只使用 `buildRunnerSpawnConfig()`，从未调用
`createReceiver()`。文件注释已经明确 lifecycle owner 应是
`CodexTmuxAdapter.execute()`。但当前 watcher把 message id先放入 in-memory delivered
set，调用同步 `onDelivered` 后无论 callback是否失败都会 ack整个 fresh batch；它不能
表达“durable consumer已提交”这个 ack边界。接口需改成 awaited callback，只有成功的
message才进入 delivered set并被 ack，callback reject则保留 unread等待下一次 scan。

Watcher 应在 controller全程存在，但仅在 phase hold时 start，wake激活后 stop。Mailbox
文件本身持久，`start()` 会 initial scan，所以 boundary前到达的 message不会丢；反而在
active期间 start会和 Runner的 `flywheel-comm inbox`争夺同一 Lead instruction。

`flywheel-comm send` 的实际 dual-write是关键：CommDB先插入原始 instruction，随后向
Codex mailbox写 `[lead-instruction <id>]` envelope，metadata为
`{ flywheelId: id, execId }`；CLI `inbox`只读/标记 CommDB row。若 controller只 ack
mailbox，resumed Runner会再次读到 CommDB原文。解决方式是把 ordered phase wake queue
放进 CommDB：对上述 bound envelope，用一个 transaction完成 queue insert与目标
instruction claim；即使 `read_at`已存在、没有既有 queue row也仍要入队，因为 CLI
在“列出”时就无条件标 read，不能由此推断模型已处理。稳定 source/message id把可能的
重复收敛为可幂等识别的 at-least-once wake，优先保证不丢 handback。
其他 gate/ask envelope无 CommDB instruction绑定，按 vendor message id直接入队。
低层 goal client只消费结构化 queue回调，不导入
transport package，维持现有依赖方向。

### F8 — Session registration 是 closeout 结果信号，但需要 teardown handshake

现有 issue-terminal 权威已统一在 lifecycle DAG，但 backend kill有两个入口：

- shipped：`runPostShipFinalization` → `makeFinalizeThreeStagePhases`；
- canceled/founder_parked：`lifecycle-closeout`；
- parked phases最终调用 `closeRunner`，并受 issue mutex/fresh-authority 保护；
- ship executor在它之前会经过 `postMergeTmuxCleanup`，该函数当前直接 kill tmux并
  delete CommDB row，绕过 `closeRunner`；若未来 QA phase是 Codex，这会绕过 handshake；
- successful close 最后调用 `deleteCommDbSession(executionId, projectName)`；
- DB/probe/authority 不确定时现有路径 fail-closed。

因此 adapter 不应查 Linear 或复制 disposition；只需要接受 issue-terminal DAG内的
共享 helper发出的 execution-scoped shutdown authority。`closeRunner` 与
`postMergeTmuxCleanup` 必须调用同一 helper，request idempotency让第二次调用复用 ack。

但直接把「session row 消失」当单向退出信号有一个竞态：Codex daemon 是 Bridge
进程的 child/control runtime，不是 founder TUI pane 的 child。`closeRunner` kill TUI
并删除 row 后会立刻继续 shared-worktree cleanup，而 adapter 可能要等下一次慢 poll
才 stop daemon。可见 pane 已下线不等于 backend controller 已 drained。

结论：需要在 CommDB 增加窄 shutdown request/ack（或等价的注入式 durable
control record），仍只由 issue-terminal teardown入口写 authority：

1. shared teamlead helper先用 advancing heartbeat + process probe证明 controller live；
2. 只有 live held/active Codex phase才写 `shutdown_requested(requestId)`；
3. phase controller 观察到后停止接收新 wake，退出 goal loop；
4. adapter finally stop/drain daemon、kill TUI、更新状态、scrub credential；
5. heartbeat在整个 drain/cleanup期间继续推进，所有 required cleanup完成后最后写
   `shutdown_ack(requestId, ok)`，随后才 stop heartbeat；
6. caller bounded wait ack，成功才删除 session row并让 lifecycle DAG继续；
7. timeout时 heartbeat仍推进/探针仍 alive则返回 blocked；controller不再推进或
   dead/absent则回退现有 direct cleanup，不能永久卡住 orphan closeout。

Claude 路径不走 handshake：它的 runner process 就在 tmux pane，现有 kill 是同步
teardown。这个 protocol 不是第二套 issue FSM，只是 backend-specific graceful-stop
ack，authority 仍来自现有 issue-terminal DAG。

但握手不能只按 adapter/role静态分类。Codex controller运行在 Bridge进程内；Bridge
崩溃后 tmux/TUI与 app-server可能留下，但不会再有人 ack。StateStore现有
`heartbeat_at`由 `CodexTmuxAdapter`周期更新，`probeRunnerProcessLiveness`另提供
`alive|dead_pin|absent|indeterminate`。共享 helper应只在 heartbeat新鲜且 probe alive
时发 request；ack等待期间 heartbeat持续推进才证明 controller仍活。heartbeat不推进
或 probe dead/absent时回退现有 direct cleanup，保住 closeStale/closeParked backstop；
probe indeterminate或 heartbeat仍推进但无 ack则 fail-closed。这样不要求把 Bridge boot
reattachment拉入本单，也不会制造永久不可关闭的 orphan。

### F9 — phaseHold latch 必须与 gateHold 正交、原子合并

FLY-1257 分支计划给 `session.json` 增加 `gateHold: boolean`，并把当前覆盖写改成
read-merge + temp/rename，保护 threadId/daemonPid/未来字段。FLY-1269 应假设该分支
可能先合并：

- 使用独立 `phaseHold` 对象，不能复用 gateHold；
- classifier 顺序：shutdown authority > phase hold > gate hold > ordinary terminal；
- pause/activate RPC primitive 可共用，wake predicate 与 latch 不共用；
- rebase 后保留 FLY-1257 的全部 gate tests；
- phase latch 只在 paused 状态下 exact mailbox kick 被接受、随后 active set成功后清除；
- 所有 session state writer共用 atomic merge seam。

### F10 — Heartbeat readopt 不是 controller reattachment

FLY-1188 已持久化 threadId、daemonPid、cwd、tmuxWindow；同 executionId 的 adapter
re-execute 可 reap orphan daemon并 resume thread。可是 Bridge restart 的现有
Heartbeat readopt 只证明 tmux alive、刷新 heartbeat、抑制 false stuck；launch-commit
replay对 committed execution 也只 adopt，不重新运行 Blueprint。因此 Bridge crash 后：

- founder TUI/daemon 可能仍活；
- adapter-owned mailbox watcher和 goal controller 已死；
- “monitoring re-adopted”不能等同于“session 可 re-engage”。

Lead 已确认 FLY-1269 收窄为 uninterrupted-Bridge 的 phase-complete keepalive；durable
state覆盖 daemon/runtime restart 与后续同 execution adapter re-execution。Bridge进程
重启后的 boot controller reattachment 单开 follow-up；本 plan保留持久 state/interface
接缝，但 529 acceptance 不声称 Bridge-crash resilience，也不能靠 heartbeat假装恢复。

## Authority Matrix

| Decision | Authority | Runner-visible signal | Failure rule |
|---|---|---|---|
| 当前 execution 是否三段 phase | Blueprint `shareParentBranch + role + flag` | `phaseKeepAlive` context | absent → legacy terminal |
| phase handoff 是否已接受 | PhaseOrchestrator | CommDB declared `parked` | unknown/read error → hold |
| 谁能写 shared branch | three-stage TURN | `flywheel-comm turn` result | 非 yours → zero worktree mutation |
| 返工/问题内容 | Lead/founder/Bridge mailbox + CommDB phase queue | ordered message id + exact content | enqueue/claim/ack error → latch retained |
| gate 是否仍开放 | gate marker/CommDB | FLY-1257 gate predicate | 与 phaseHold 独立 |
| issue 是否可 teardown | lifecycle closeout + mutex + fresh authority | shutdown request from closeRunner | unknown → no teardown |
| backend 是否已真正停止 | live Codex adapter；orphan fallback由 closeRunner | request-bound ack；heartbeat+process probe | live/no ack → close blocked；dead/absent → direct cleanup；unknown → no kill |

## Proposed Runtime Contract

低层不直接读 Bridge FSM，使用 adapter 注入的窄 controller：

```ts
type PhaseLifecycleObservation =
  | { kind: "active" }
  | { kind: "parked" }
  | { kind: "wake"; message: PhaseWakeMessage }
  | { kind: "shutdown"; requestId: string }
  | { kind: "unknown"; error: string };

type PhaseWakeMessage = {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
};
```

Adapter 把 `runtime.runGoal()` 与 controller 的 durable shutdown signal 做 race；shutdown
赢时立即 `runtime.stop()`，不等待 active turn 或 15s goal poll。`runGoalToTerminal` 的
phase classifier则在 notification 和 poll fallback 前后检查 phase park/wake：

1. 显式 phase identity 的 complete 或已有 latch → 写/保留 latch、pause、进入 slow hold；
2. hold + wake → goal仍 paused时 exact content kick，再 set active；两步成功后
   ack/清 latch（避免 active auto-turn 抢跑）；
3. declared park缺失/observation unknown → 保持 hold并告警，绝不 terminal success；
4. 非 phase execution →现有 terminal 行为 byte-compatible。

Phase hold期间不调用 active `remainingBudget()`；进入时持久化 current deadline与
hardDeadline两个剩余值，退出时用同一个 `now`各恢复一次。不能再通过既有
deadline-extension callback叠加 hold elapsed，否则会 double count；daemon restart
carry remaining pair，不得重新发24h/49h预算。gateHold仍使用其独立 waiting ceiling。

watcher message只有 kick 资格，不是 TURN 资格；模型合同继续要求每次 resumed turn 首步
执行 `flywheel-comm turn`。

## Test Surface

### Unit

- `codex-daemon-client.test.ts`：complete notification/poll 两路无需 park marker即进入
  phase hold，marker缺失只告警不退出；
  paused/wake/duplicate/out-of-order；24h active clock在单次/多次hold冻结；gateHold 与
  phaseHold 正交；
- `codex-daemon-goal-runtime.test.ts`：daemon transport restart 时 latch 保持，同 thread
  preflight 不误 kick；
- `CodexTmuxAdapter.test.ts`：phase context、hold-only watcher lifecycle、atomic state、ordinary
  complete仍 reclaim、active/paused 两态的 shutdown race会 stop runtime、ack 只在
  drain 成功后写；
- `CodexAdapter.test.ts`：async consumer/ack顺序与 watcher restart 去重；
- `flywheel-comm db.test.ts`：phase queue enqueue/claim同事务、active inbox先列出后仍
  queue、wrong recipient、duplicate envelope与 queue状态迁移。

### Integration

- `Blueprint.fly887-keepalive-prompt.test.ts`：Codex phase prompt恢复 park合同；Auto-QA
  与 kill switch OFF不带 context；Claude snapshots不变；
- `close-runner` / `post-merge` / post-ship / lifecycle-closeout tests：Codex phase
  live controller的 shutdown request→ack后才 delete row/cleanup；shipping Codex QA不得
  绕过 shared liveness classifier；live negative/timeout ack阻断后续，proven orphan走
  direct cleanup；Claude直接 kill不变；
- PhaseOrchestrator FLY-1224 probe-before-wake tests：parked Codex现在 probe alive并走
  wake，不再 dead→respawn。

### Real machine 529

1. dispatch锁：design=Codex、implement=Codex xhigh、qa=Opus；
2. design complete/handoff 后记录 executionId/threadId/tmux/process，证明 60s 后仍
   parked-alive；
3. Lead向 design发 founder question/handback，证明同 execution/thread 恢复且先过 TURN；
4. implement/QA推进并 ship；
5. 观察 shutdown request/ack、三段 tmux 同批消失、Codex daemon socket/process归零；
6. Claude-design 对照跑，park/wake/ship行为不变。

## Conclusion

现有系统已经拥有几乎全部业务权威：phase identity在 Blueprint，park/wake/TURN在
PhaseOrchestrator + CommDB，issue terminal在 lifecycle closeout。缺口集中在 Codex
adapter/runtime：它没有消费 phase identity/mailbox/park，且把 goal complete 无条件
当 execution terminal。

推荐在现有 goal loop里增加独立 phase-hold controller，以 native paused 实现零 token
idle，以 durable latch保证 restart时序，以 closeRunner request/ack把 issue-terminal
authority与真实 daemon teardown连成闭环。不要新增 Linear polling、热 turn 或 respawn。
