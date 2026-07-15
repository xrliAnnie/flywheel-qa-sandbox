# FLY-1269 Codex Phase 全程常驻 — 实施计划
Issue: FLY-1269 (https://linear.app/geoforge3d/issue/FLY-1269/fix-codex-phase-会话在-phase-完成后就退出不像-claude-常驻到-issue-做完-三段式全程常驻缺失)
日期: 2026-07-14
基于: research.md

## Goal

让 `shareParentBranch=true` 的 Codex Design/Implement/QA phase 在 phase boundary 后
进入零 token 的 paused/parked-alive 状态，保持同一 executionId、thread、goal、founder
TUI 与 mailbox controller；Lead/founder handback 在同一 goal 恢复，且仍先过 TURN；
只有现有 issue-terminal lifecycle closeout（shipped/canceled/founder close）请求并确认
backend teardown 后，三段才一起下线。

## Architecture

实现分为四层，业务权威不下沉：

1. **Identity/contract**：Blueprint 用 `shareParentBranch + sessionRole + kill switch`
   生成 `phaseKeepAlive` adapter context，并恢复 Codex phase 的 `park` prompt；
2. **Controller**：Codex adapter 常驻持有 shutdown observer与 `phaseHold` latch；进入
   hold后才启动 mailbox watcher，durable wake queue位于 CommDB；
3. **Goal loop**：notification 与 poll fallback 共用 classifier；显式 phase complete
   直接进入 native paused，declared park只确认 handoff/quiet；wake 先在 paused goal
   提交 exact turn、再 active；adapter另把
   `runGoal()` 与 shutdown signal做 race，active turn也能立即停；
4. **Teardown handshake**：issue-terminal DAG仍是唯一 authority；`closeRunner` 与
   `postMergeTmuxCleanup` 共用一个 Codex phase shutdown helper。对 heartbeat持续前进的
   live controller，adapter drain/ack后才删除 CommDB row、继续 cleanup；proven orphan
   回退现有 direct cleanup，indeterminate fail-closed。Claude仍直接 kill。

```mermaid
sequenceDiagram
    participant R as Codex phase goal
    participant A as Phase controller
    participant B as PhaseOrchestrator
    participant C as closeRunner

    R->>B: complete phase route
    B->>B: persist boundary + handoff
    B->>A: declared parked
    R-->>A: goal complete
    A->>A: persist phaseHold, goal paused
    B->>A: mailbox wake (same execution)
    A->>R: exact wake turn while goal is paused
    A->>R: set same goal active after turn accepted
    R->>B: turn check; work only if yours
    C->>A: shutdown request (issue terminal)
    A->>A: stop watcher + drain daemon + kill TUI
    A-->>C: request-bound shutdown ack
    C->>C: delete session row; continue cleanup
```

## Tech Stack

TypeScript、Node.js、Vitest、SQLite/better-sqlite3、Codex app-server v2 Goal RPC、
CommDB mailbox、tmux、pnpm monorepo。生产代码/注释/commit message 用 English；
QA evidence 与设计交接可用中文。

## Scope Decisions

- 包含：Design `phase_design_complete`、Implement `needs_review`、QA FAIL park、QA
  active期间 issue-terminal shutdown、same-thread mailbox handback、daemon transport
  restart、closeout request/ack、529 real-machine E2E。
- 不包含：FLY-1257 的 gate-wait bugs、retry TURN/startPoint、zombie gate chronology；
  只保证可与其 `gateHold` 安全合并。
- 不包含：Bridge **进程级** crash 后自动重建 adapter/controller。现有 Heartbeat readopt
  只重建 monitoring，不重跑 Blueprint；本单保持 durable `phaseHold`/wake queue，供同
  execution adapter re-execution安全恢复，但 boot reattachment 另立 follow-up。529
  本单不宣称 Bridge-restart acceptance。
- 回滚：沿用 `FLYWHEEL_THREE_STAGE_KEEPALIVE=0`，关闭时 Blueprint 不传
  `phaseKeepAlive`、Codex恢复当前 terminal reclaim；不增加并行 feature flag。

## Durable State

`~/.flywheel/state/codex-sessions/<execId>/session.json` 在现有字段上原子 merge：

```ts
interface PhaseHoldState {
  schemaVersion: 1;
  role: "design" | "implement" | "qa";
  state: "entering" | "paused" | "reactivating";
  enteredAt: string;
  deadlineRemainingMs: number;
  hardDeadlineRemainingMs: number;
}
```

保留并 merge 现有 `threadId`、`daemonPid`、`tmuxWindow`，以及 FLY-1257 可能加入的
`gateHold`。所有 writer 使用同一 temp-write + rename seam。phase wake不放进这个多
writer JSON，而使用同一个 CommDB里的 ordered table：

```sql
CREATE TABLE IF NOT EXISTS runner_phase_wakes (
  queue_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  source_instruction_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','started','finished')),
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (execution_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS runner_phase_wakes_source
  ON runner_phase_wakes(execution_id, source_instruction_id)
  WHERE source_instruction_id IS NOT NULL;
```

Mailbox callback只有在入队 transaction提交后才允许 transport ack，避免「mailbox
已读但 controller crash丢消息」。对 `send` 的
`metadata={flywheelId:<instruction id>,execId:<target>}`，同一 transaction校验目标、
insert phase wake并把对应 CommDB instruction标记 read；若 instruction已被 active
Runner的 CLI inbox列出、`read_at`已存在，仍然 insert phase wake：`read_at`只证明内容
被打印，不证明模型已经处理，稳定 `[phase-wake <id>]`负责幂等重放。wrong recipient/
missing bound instruction是 fail-loud，不 ack。其他 gate/ask envelope不绑定
instruction，直接按 vendor message id入队。重复 callback返回既有 row并安全 ack。
Queue reads使用 `queue_seq`而非毫秒时间戳，保证同 tick消息仍按 FIFO处理。

Wake delivery保证 **no loss + durable dedupe**。若 daemon/Bridge恰好在
`turn/start` 成功后、queue item 标记完成前 crash，缺少 server idempotency key 时
可能 at-least-once replay；kick 必须带 `[phase-wake <messageId>]`，runner先检查该 id
是否已处理。`finished` row保留到 execution teardown，既支持 retry ack也防止重复
envelope重建 turn；禁止为了伪造 exactly-once 而提前删除 durable queue。

CommDB 新增 execution-scoped shutdown control（一个 execution 只需一个 close）：

```sql
CREATE TABLE IF NOT EXISTS runner_shutdown_controls (
  execution_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('requested','acked','failed')),
  requested_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
```

request insert 是 idempotent；ack/fail 必须 CAS 同一 `request_id`。readonly DB缺表读取
为 `null`，其他 DB 错误向上报告并 fail-closed。

## Classifier Order

Adapter 层的 shutdown signal 永远先于 goal outcome：它与 `runGoal()` race，命中后
立即 `runtime.stop()`。其下同一个 helper供 goal notification 与 `getGoal` poll调用，
顺序固定：

1. phaseHold latch 或显式 `phaseKeepAlive` execution 的 `complete` → phase hold；
2. FLY-1257 `blocked + gate open/gateHold` → gate hold（若该分支已合并）；
3. declared park缺失/读取未知 → 保持 phase hold并告警，等待 reconcile或 wake；
4. 非 phase ordinary terminal → current outcome mapping。

第1条在每一次 re-engaged turn之后仍成立：wake成功会结束旧 latch，但不会移除
`ctx.phaseKeepAlive` eligibility；下一次 goal `complete` 无论模型有没有重新调用
`park` 都必须建立新 latch并继续常驻。declared park始终只是 handoff/quiet证据，不是
lifetime前置条件，pending wake也绝不落入 ordinary terminal分支。

任何 CommDB/latch/controller read error返回 `unknown`，保留 current hold/active并 log；
不能把 unknown映射为 terminal success。

## Time Budget Semantics

Phase hold是 issue lifecycle wait，不是 active work，也不是 Lead gate wait：

- 对 phase-eligible run使用同一个 suspend/resume budget state；进入 hold时同时记录
  当前 `deadline - now` 与 `hardDeadline - now` 两个剩余值；
- paused期间 goal loop不调用 active `remainingBudget()`，本地 slow poll/RPC使用独立的
  bounded control-RPC timeout；active与49h hard-ceiling两个时钟都冻结；
- wake后唯一恢复方式是 `deadline=now+deadlineRemainingMs`、
  `hardDeadline=now+hardDeadlineRemainingMs`，不能重置新的24h/49h，也不能再按 hold
  elapsed做第二次 absolute extension；
- 多次 park/wake累计排除每段 hold时间；
- daemon transport restart carry同一个 phase budget state；active/gate期间既有
  `minDeadlineMs`/`onDeadlineExtended`语义不变，但 phase hold不经过该 gate extension；
- ordinary Codex、active工作、FLY-1257 gateHold预算保持原语义。

这是对现有 run-start-anchored hard ceiling的窄例外：只有显式 `phaseKeepAlive` 且 state
处于 phase hold时暂停两个时钟；daemon restart、active work与 gate wait本身仍不能重置
或乘大预算。只有 closeRunner shutdown结束无限期 phase idle；不加「park 49h后自动
success/fail」出口。

## File Map

| Area | Production files | Tests |
|---|---|---|
| Phase identity/prompt | `packages/core/src/adapter-types.ts`; `packages/edge-worker/src/Blueprint.ts` | `Blueprint.fly887-keepalive-prompt.test.ts`; `Blueprint.fly1188-codex-prompt.test.ts`; `Blueprint.fly859-qa-phase-prompt.test.ts` |
| Mailbox delivery | `packages/agent-team-transport/src/types.ts`; `packages/agent-team-transport/src/codex/CodexAdapter.ts` | `packages/agent-team-transport/src/codex/__tests__/CodexAdapter.test.ts` |
| Phase queue/shutdown control | `packages/flywheel-comm/src/db.ts` | `packages/flywheel-comm/src/__tests__/db.test.ts` |
| Phase controller/state | new `packages/claude-runner/src/codex-phase-lifecycle.ts`; `packages/claude-runner/src/CodexTmuxAdapter.ts` | new `packages/claude-runner/test/codex-phase-lifecycle.test.ts`; `CodexTmuxAdapter.test.ts` |
| Goal hold | `packages/claude-runner/src/codex-daemon-client.ts`; `codex-daemon-goal-runtime.ts` | `codex-daemon-client.test.ts`; `codex-daemon-goal-runtime.test.ts` |
| Close handshake | new `packages/teamlead/src/bridge/codex-phase-shutdown.ts`; `packages/teamlead/src/bridge/close-runner.ts`; `packages/teamlead/src/bridge/post-merge.ts`; `packages/teamlead/src/bridge/commdb-session-prune.ts`; closeout call sites only if a dependency seam is required | new `packages/teamlead/src/bridge/__tests__/codex-phase-shutdown.test.ts`; `packages/teamlead/src/__tests__/close-runner.test.ts`; `packages/teamlead/src/__tests__/post-merge.test.ts`; `packages/teamlead/src/__tests__/commdb-session-prune.test.ts`; `bridge/__tests__/lifecycle-closeout.test.ts`; `bridge/__tests__/post-ship-finalization.fly887.test.ts` |
| Contract | `packages/claude-runner/agents/codex-runner-contract.md` | prompt identity tests |
| QA evidence | `engineering/doc/FLY-1269-codex-phase-keepalive/qa/*` | 529 artifacts |

## TDD Tasks

### Task 0 — Prove complete→paused on a real daemon

**Files:**

- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/m0-complete-paused-probe.mjs.txt`
- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/m0-complete-paused-probe.md`

**Step 1 — Copy the proven harness shape**

Base the one-shot probe on FLY-1257's `m0-paused-probe.mjs.txt`; use a temporary
CODEX_HOME/socket/thread and record version, RPC request/response frames, notification timing,
threadId and cleanup result. Do not change production code.

**Step 2 — Drive the missing transition**

Run one short goal to a real `complete`, then call `thread/goal/set` with the same threadId,
cached objective/tokenBudget and `status:"paused"`; verify goal/get reports paused. Kill the
daemon cleanly, start a new daemon against the same temporary CODEX_HOME, `thread/resume` the
same thread, and verify goal/get still reports paused with identical objective/tokenBudget。
While still paused, call `turn/start` with a unique wake probe and verify exactly that manual
turn starts first，with no concurrent auto-turn。Then set active with the same fields and verify
the same goal resumes：while the exact wake turn is running，the active transition cannot start a
second concurrent turn；after that wake completes，native sequential continuation is allowed only
inside the same goal。The next phase boundary must still establish a fresh `phaseHold` before any
further continuation，so activation can never punch through the hold contract。

```bash
node --input-type=module < \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/m0-complete-paused-probe.mjs.txt
```

Expected: exit 0; evidence says PASS; same threadId throughout; complete→paused accepted;
paused status/fields survive daemon restart + thread/resume；paused produces no automatic turn；
manual wake while paused is accepted exactly once and is the first resumed turn；active creates
no concurrent duplicate；any later sequential continuation starts only after the wake completes
and retains the same goal；cleanup removes socket/process.

**Step 3 — Fail-close decision**

If any critical assertion fails, stop implementation and open a new Lead architecture gate;
do not select hot polling, clear+new goal, or respawn without approval. If PASS, commit evidence:

```bash
git add engineering/doc/FLY-1269-codex-phase-keepalive/qa/m0-complete-paused-probe.*
git commit -m "test(codex): prove completed phase goals can pause"
```

### Task 1 — Thread explicit phase identity and restore the Codex park contract

**Files:**

- Modify: `packages/core/src/adapter-types.ts`
- Modify: `packages/edge-worker/src/Blueprint.ts`
- Modify: `packages/edge-worker/src/__tests__/Blueprint.fly887-keepalive-prompt.test.ts`
- Modify: `packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts`
- Modify: `packages/edge-worker/src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts`
- Modify: `packages/claude-runner/agents/codex-runner-contract.md`

**Step 1 — RED: context identity matrix**

Add a capturing fake adapter and assert:

- Codex design/implement/three-stage QA + keepalive ON receives exact role;
- Auto-QA `qaContext` receives no phaseKeepAlive;
- single-session receives none;
- kill switch `=0` receives none;
- Claude prompt snapshots stay unchanged.

Expected RED command:

```bash
pnpm --filter flywheel-edge-worker exec vitest run \
  src/__tests__/Blueprint.fly887-keepalive-prompt.test.ts \
  src/__tests__/Blueprint.fly1188-codex-prompt.test.ts \
  src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts
```

Expected: new adapter-context assertions fail because the field is absent; Codex prompt tests
fail because they still contain `END YOUR TURN`/no-park wording.

**Step 2 — GREEN: add the narrow optional field**

Add to `AdapterExecutionContext`:

```ts
phaseKeepAlive?: { role: "design" | "implement" | "qa" };
```

In Blueprint, derive it only from existing `isDesignPhase/isImplementPhase/isQaPhase` and
`threeStageKeepAlive`; pass it to `adapter.execute()`. Do not read raw env in the adapter.

Restore Codex phase epilogues to run exact `complete/qa-result`, then
`flywheel-comm park --exec-id ...`, then end the current turn while the controller stays alive.
Every wake paragraph must say message text is context, TURN is authority。The contract also
defines `[phase-wake <id>]` replay handling：if the same id is already handled in this thread，
do not repeat external/worktree side effects；re-check TURN and report/park idempotently。Add
prompt assertions for this stable-id rule。

**Step 3 — Verify and commit**

```bash
pnpm --filter flywheel-core typecheck
pnpm --filter flywheel-edge-worker typecheck
pnpm --filter flywheel-edge-worker exec vitest run \
  src/__tests__/Blueprint.fly887-keepalive-prompt.test.ts \
  src/__tests__/Blueprint.fly1188-codex-prompt.test.ts \
  src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts
git add packages/core/src/adapter-types.ts packages/edge-worker/src/Blueprint.ts \
  packages/edge-worker/src/__tests__/Blueprint.fly887-keepalive-prompt.test.ts \
  packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts \
  packages/edge-worker/src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts \
  packages/claude-runner/agents/codex-runner-contract.md
git commit -m "feat(codex): declare three-stage phase keepalive"
```

Expected: tests/typechecks exit 0; Claude assertions unchanged.

### Task 2 — Make mailbox consumption durable and add CommDB control records

**Files:**

- Modify: `packages/agent-team-transport/src/types.ts`
- Modify: `packages/agent-team-transport/src/codex/CodexAdapter.ts`
- Modify: `packages/agent-team-transport/src/codex/__tests__/CodexAdapter.test.ts`
- Modify: `packages/flywheel-comm/src/db.ts`
- Modify: `packages/flywheel-comm/src/__tests__/db.test.ts`

**Step 1 — RED: callback-before-ack contract**

Add watcher tests where `onDelivered` is async/throws. Assert successful callback → delivered
set + ack；throw/reject → no ack, no in-memory delivered latch, next scan retries same id.

```bash
pnpm --filter flywheel-agent-team-transport exec vitest run \
  src/codex/__tests__/CodexAdapter.test.ts
```

Expected: failure because current watcher marks delivered before callback and acks all fresh
messages even when callback fails.

**Step 2 — GREEN: await only accepted deliveries**

Widen shared `IMailboxWatcher.onDelivered` in `src/types.ts` to
`void | Promise<void>` and await it in `CodexMailboxWatcher`；add id to delivered only after
callback resolves and ack only accepted ids。The Claude implementation remains source-compatible
with a void callback。Keep fs.watch + poll fallback and per-message error logging。

**Step 3 — RED: atomic phase queue ownership**

Add CommDB tests for:

- ordinary gate/ask envelope insert + duplicate id dedupe；
- `send` envelope atomically inserts wake and marks only the matching unread instruction read；
- two vendor envelopes with different message ids but the same bound instruction dedupe to one
  source row；same-millisecond messages preserve `queue_seq` FIFO；
- callback retry after commit returns the same wake row；
- instruction with `read_at` already set but no queue row is still queued（listed≠handled）；
- wrong `execId`、wrong recipient、missing bound instruction fail without queue/read mutation；
- `pending → started → finished` requires the expected prior state and exact execution/id；
- readonly missing-table returns an empty queue，other DB errors throw。

**Step 4 — GREEN: transaction-backed phase queue**

Add `runner_phase_wakes` and narrow methods such as:

```ts
enqueueRunnerPhaseWake(execId: string, message: PhaseWakeInput, nowMs: number):
  { kind: "queued" | "duplicate"; wake: RunnerPhaseWake };
listRunnerPhaseWakes(execId: string): RunnerPhaseWake[];
markRunnerPhaseWakeStarted(execId: string, messageId: string, nowMs: number): boolean;
finishRunnerPhaseWake(execId: string, messageId: string, nowMs: number): boolean;
deleteSessionAndRunnerPhaseLifecycle(execId: string): number;
```

Use one `better-sqlite3` transaction for bound instruction validation、queue insert and
`read_at` claim. The phase controller must not call the unbound `markInstructionRead(id)` helper。
The terminal-delete method atomically removes phase wakes、shutdown control and the session row，
returning the session delete count；legacy `deleteSession` remains available for compatibility。

**Step 5 — RED/GREEN: shutdown DB CAS**

Add DB tests for request idempotency、request read、wrong-id ack refusal、matching ack、failed
ack with error、readonly missing-table returns null. Then add the schema and methods:

```ts
requestRunnerShutdown(execId: string, requestId: string, nowMs: number): RunnerShutdownControl;
getRunnerShutdown(execId: string): RunnerShutdownControl | null;
finishRunnerShutdown(execId: string, requestId: string, result: { ok: true } | { ok: false; error: string }, nowMs: number): boolean;
```

```bash
pnpm --filter flywheel-comm exec vitest run src/__tests__/db.test.ts
pnpm --filter flywheel-comm typecheck
```

Expected: exit 0 after implementation; duplicate request returns the original request id/state.

**Step 6 — Verify and commit**

```bash
pnpm --filter flywheel-agent-team-transport exec vitest run \
  src/codex/__tests__/CodexAdapter.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/db.test.ts
pnpm --filter flywheel-comm typecheck
git add packages/agent-team-transport/src/codex/CodexAdapter.ts \
  packages/agent-team-transport/src/types.ts \
  packages/agent-team-transport/src/codex/__tests__/CodexAdapter.test.ts \
  packages/flywheel-comm/src/db.ts packages/flywheel-comm/src/__tests__/db.test.ts
git commit -m "feat(runtime): add durable Codex phase control signals"
```

### Task 3 — Implement the phase lifecycle controller and atomic state

**Files:**

- Create: `packages/claude-runner/src/codex-phase-lifecycle.ts`
- Create: `packages/claude-runner/test/codex-phase-lifecycle.test.ts`
- Modify: `packages/claude-runner/src/CodexTmuxAdapter.ts`
- Modify: `packages/claude-runner/test/CodexTmuxAdapter.test.ts`

**Step 1 — RED: pure controller state matrix**

Use temp CommDB/session dirs and a fake watcher. Cover:

- `declared parked` → observation parked；missing/cleared → active；DB error → unknown；
- `start()` polls shutdown but does not start mailbox intake while goal active；
- `enterHold()` starts watcher and initial scan catches pre-boundary envelopes；wake activation
  stops watcher before returning active；subsequent hold restarts scan；
- watcher callback commits CommDB enqueue/claim before resolving；same id dedupes；order preserved；
- active Runner already listed instruction → envelope still queues one idempotent wake；
- persisted pending queue survives controller reconstruction；
- shutdown requested wins over queued wake；
- atomic merge preserves threadId、daemonPid、phaseHold in both writer orders；if FLY-1257
  is present at implementation time，also preserve `gateHold`；
- corrupt phaseHold/session object fails closed and never truncates state。

```bash
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-phase-lifecycle.test.ts test/CodexTmuxAdapter.test.ts
```

Expected: module/import missing and new adapter lifecycle assertions fail.

**Step 2 — GREEN: controller API**

Implement an adapter-owned controller with no teamlead dependency:

```ts
interface CodexPhaseLifecycleController {
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForShutdown(): Promise<{ requestId: string }>;
  observe(): PhaseLifecycleObservation;
  enterHold(budget: { deadlineRemainingMs: number; hardDeadlineRemainingMs: number }): Promise<void>;
  leaveHold(): Promise<void>;
  markWakeStarted(id: string): void;
  finishWake(id: string): void;
  ackShutdown(requestId: string, result: { ok: true } | { ok: false; error: string }): void;
}
```

It may import CommDB and use the structural `CodexWakeWatcher`; it must not import StateStore or
PhaseOrchestrator. Start the controller once for every `ctx.phaseKeepAlive`, before `runGoal`；
its shutdown poll is a fast local control tick（≤1s、zero token）。Do not start receiver intake
until `enterHold()`；mailbox durability + initial scan covers pre-hold delivery without stealing
active Runner inbox ownership。Paused goal polling remains slow。Stop controller only in adapter
finally. Use one atomic session-state merge helper for normal metadata and phase state.
The current `persistSessionState()` rewrites the whole object with non-atomic `writeFileSync`；
converting that concrete writer to read-merge + temp-file/fsync/rename is part of this task，not
an assumed pre-existing seam。

**Step 3 — Verify adapter compatibility**

Existing ordinary Codex happy path must still assert one window kill + one runtime stop/drain.
New phase fixture initially still returns complete (Task 4 adds hold) but proves controller starts
once while watcher remains stopped before hold；Auto-QA/ordinary create no receiver.

**Step 4 — Commit**

```bash
pnpm --filter flywheel-claude-runner typecheck
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-phase-lifecycle.test.ts test/CodexTmuxAdapter.test.ts
git add packages/claude-runner/src/codex-phase-lifecycle.ts \
  packages/claude-runner/test/codex-phase-lifecycle.test.ts \
  packages/claude-runner/src/CodexTmuxAdapter.ts \
  packages/claude-runner/test/CodexTmuxAdapter.test.ts
git commit -m "feat(codex): persist phase lifecycle state"
```

### Task 4 — Hold complete phase goals and reactivate the same goal

**Files:**

- Modify: `packages/claude-runner/src/codex-daemon-client.ts`
- Modify: `packages/claude-runner/src/codex-daemon-goal-runtime.ts`
- Modify: `packages/claude-runner/src/CodexTmuxAdapter.ts`
- Modify: `packages/claude-runner/test/codex-daemon-client.test.ts`
- Modify: `packages/claude-runner/test/codex-daemon-goal-runtime.test.ts`
- Modify: `packages/claude-runner/test/CodexTmuxAdapter.test.ts`

**Step 1 — RED: terminal classifier matrix**

Add notification and poll-fallback pairs for:

- ordinary complete → returns immediately；
- phase complete without park marker → writes latch、sets same objective/budget paused、does
  not return；later park只确认 quiet/handoff；
- after a successful wake clears the prior latch/declared marker，the next complete still creates
  a fresh phase hold solely from `ctx.phaseKeepAlive`；missing model `park` never terminalizes it；
- phase complete + observation unknown → remains held，no terminal success；
- held + one wake → exact `[phase-wake id] content` turn while paused，then set active；
- queued `send` envelope is not visible again through CLI inbox；an already-listed instruction
  still produces one durable id-tagged queue item，and crash-window replay keeps the same id；
- duplicate/out-of-order notifications → one activation/kick；
- wake kick fails → queue/latch retained；success → item becomes finished；
- gateHold and phaseHold both present → shutdown > phase > gate ordering。
- fake clock跨过49h hard ceiling时 held phase仍不 timeout；单次/多次hold同时冻结 active
  deadline与 hard deadline；wake不重置预算；daemon restart carry同一 remaining pair；
  ordinary/gate-wait run仍受原 hard ceiling。

```bash
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-daemon-client.test.ts \
  test/codex-daemon-goal-runtime.test.ts \
  test/CodexTmuxAdapter.test.ts
```

Expected: new phase cases fail; ordinary cases remain green.

**Step 2 — GREEN: generalize the goal loop without importing CommDB**

Add an optional structural controller input to `runGoalToTerminal`; both terminal observation
paths call one classifier. Implement a shared full-field status setter:

```ts
await client.setGoal({
  threadId,
  objective,
  tokenBudget,
  status: "paused" // or active
});
```

On enter hold: persist latch state=`entering` + both remaining deadline values first, then set paused；
only after goal/get confirms paused may state become `paused` and watcher initial scan start。
If the pause RPC/confirmation fails，keep `entering`，do not expose queued wake or call
`turn/start` against a complete goal；retry pause on the slow local control loop，and on transport
failure let runtime restart/resume the same thread then retry before intake。Task 0 proves the
semantic transition but does not make transport failure impossible；persistent rejection is
fail-loud/held until shutdown or a Lead-approved architecture change，never hot model polling or
ordinary terminal fallthrough。
On wake: keep goal paused，call `startTurn` with exact message id/content，persist the queue item
as started，then set the same goal active；only after both RPCs succeed may the item become
finished、watcher stop and latch clear。The exact wake must be the first resumed turn and active
must not create a concurrent second turn；native goal continuation after the wake finishes is
expected and remains inside the same goal。The next `complete` is still classified from
`phaseKeepAlive` eligibility and must create a fresh latch，even if the prior wake cleared both the
old latch and declared marker。
This order is mandatory because native `paused→active` can auto-start a turn before a later kick。
Use an injected `sleep`/poll interval so unit tests use zero time；production idle interval 15s，
mailbox fs.watch triggers an immediate controller wake signal rather than waiting a full tick.
While held，do not call the active `remainingBudget()`/hardDeadline timeout path；bound each local
control RPC separately with an injectable 30s default。On wake restore the two stored remaining
values exactly once。Do not also
extend by elapsed hold，never route phase hold through `waitingTimeoutMs`，and never reset
`runStartedAt` on daemon restart。

**Step 3 — Runtime restart preflight**

Before initial setGoal/kick on a resumed thread, inspect phase latch + existing goal：paused+
held stays asleep；entering+complete retries pause before mailbox intake；held+queued wake
reactivates once；shutdown exits；ordinary execution keeps
current setup order。Carry the controller callbacks through `RunGoalInput` and every daemon
restart。For a later same-execution adapter re-execution，rebuild its deadline as
`now + phaseHold.deadlineRemainingMs` and hard deadline as
`now + phaseHold.hardDeadlineRemainingMs` rather than arming fresh 24h/49h ceilings；a
within-runtime daemon restart keeps the same budget state。

In `CodexTmuxAdapter.execute()`，race the in-flight `runtime.runGoal()` promise against
`controller.waitForShutdown()`。If shutdown wins，set a request-bound controlled-shutdown flag，
call `runtime.stop()` immediately，await the goal promise to settle，then let finally drain and
ack。A resulting `transport_closed` is success only when bound to that exact shutdown request；
all other transport deaths keep current failure semantics。

**Step 4 — Verify and commit**

```bash
pnpm --filter flywheel-claude-runner typecheck
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-daemon-client.test.ts \
  test/codex-daemon-goal-runtime.test.ts \
  test/CodexTmuxAdapter.test.ts \
  test/codex-phase-lifecycle.test.ts
git add packages/claude-runner/src/codex-daemon-client.ts \
  packages/claude-runner/src/codex-daemon-goal-runtime.ts \
  packages/claude-runner/src/CodexTmuxAdapter.ts \
  packages/claude-runner/test/codex-daemon-client.test.ts \
  packages/claude-runner/test/codex-daemon-goal-runtime.test.ts \
  packages/claude-runner/test/CodexTmuxAdapter.test.ts \
  packages/claude-runner/test/codex-phase-lifecycle.test.ts
git commit -m "fix(codex): keep completed phases resident until issue close"
```

### Task 5 — Make every issue-terminal kill wait for real Codex backend teardown

**Files:**

- Create: `packages/teamlead/src/bridge/codex-phase-shutdown.ts`
- Create: `packages/teamlead/src/bridge/__tests__/codex-phase-shutdown.test.ts`
- Modify: `packages/teamlead/src/bridge/close-runner.ts`
- Modify: `packages/teamlead/src/bridge/post-merge.ts`
- Modify: `packages/teamlead/src/bridge/commdb-session-prune.ts`
- Modify: `packages/teamlead/src/__tests__/close-runner.test.ts`
- Modify: `packages/teamlead/src/__tests__/post-merge.test.ts`
- Modify: `packages/teamlead/src/__tests__/commdb-session-prune.test.ts`
- Modify only if needed for dependency injection: `packages/teamlead/src/bridge/lifecycle-closeout.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/post-ship-finalization.fly887.test.ts`
- Modify: `packages/claude-runner/src/CodexTmuxAdapter.ts`
- Modify: `packages/claude-runner/test/CodexTmuxAdapter.test.ts`

**Step 1 — RED: close handshake matrix**

In the shared-helper/closeRunner/post-merge tests, identify three-stage Codex by
`adapter_type=codex-tmux` + `chat_thread_role in design|implement|qa`，then classify controller
liveness from StateStore `heartbeat_at` plus `probeRunnerProcessLiveness(tmuxWindow)`。Assert：

- fresh heartbeat + `alive` probe → request written before any tmux kill；
- matching ack → re-fetch target, treat adapter-removed TUI as success, delete session row；
- ack timeout/failed/wrong id while heartbeat continues advancing + probe stays alive → no row
  delete、no worktree-close success；
- missing/stale heartbeat or `dead_pin|absent` probe → no handshake，fall through to the existing
  direct-kill cleanup；`indeterminate` remains fail-closed；
- a heartbeat fresh at request time but unchanged after the ack wait is reclassified
  controller-dead and falls through to direct cleanup，so Bridge crash cannot create permanent
  closeStale/closeParked/lifecycle-closeout blockage；
- repeated close reuses pending request；
- shipping Codex QA进入 `postMergeTmuxCleanup` 时也先走同一 helper classification：live
  controller必须 request/ack，proven orphan才可 direct cleanup；不能提前 delete row；
  随后 phase finalizer重入复用同一 ack/cleanup result；
- Claude phase and ordinary non-phase Codex keep current direct-kill path；
- DB read/request failure fail-closed。
- successful live/direct close makes `deleteCommDbSession` transactionally remove the session
  plus phase wake/shutdown rows；failed close and boot indeterminate probe preserve them。

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/codex-phase-shutdown.test.ts \
  src/__tests__/close-runner.test.ts \
  src/__tests__/post-merge.test.ts \
  src/__tests__/commdb-session-prune.test.ts \
  src/bridge/__tests__/lifecycle-closeout.test.ts \
  src/bridge/__tests__/post-ship-finalization.fly887.test.ts
```

Expected: new Codex handshake assertions fail because current closeRunner kills/deletes directly.

**Step 2 — GREEN: bounded request/ack**

Add one shared helper with injectable `shutdownAckTimeoutMs`/`controllerLeaseMaxAgeMs`/poll
sleep/liveness probe/clock for tests；production ack timeout 30s，freshness ceiling 60s（twelve
default 5s heartbeat periods）。Handshake eligibility requires both a fresh adapter heartbeat
and process probe=`alive`。Capture the heartbeat value when request starts。On exact ack，let the
caller continue its terminal-view/audit/CommDB delete sequence。On timeout，re-read heartbeat and
probe：if heartbeat advanced and probe remains alive，return blocked/partial（live controller but
broken protocol）；if heartbeat did not advance or process is dead/absent，fall through to existing
direct cleanup；indeterminate stays fail-closed。This preserves orphan backstops without allowing
direct kill of a demonstrably active controller。

Adapter request-bound lifecycle-shutdown finally order：stop mailbox intake →
`runtime.stop()`（idempotent）→
`await runtime.drained()` → kill TUI → update CommDB status → scrub credential → **last** write
request-bound ack success → stop heartbeat。Heartbeat must keep advancing through the entire
drain/cleanup/ack attempt；otherwise closeRunner's two-sample liveness check would misclassify a
slow live drain as an orphan and direct-kill underneath it。If drain or required cleanup is
unconfirmed，write ack failed，then stop heartbeat and preserve failure evidence；never ack
success before daemon teardown/credential scrub。

After either an acked graceful close or a proven-orphan direct close succeeds，the shared helper
deletes the CommDB session row and execution-scoped phase wake/shutdown control rows together。
No phase-control row is purged before the backend close result is known；failed/indeterminate
close retains all retry evidence。Extend the existing `commdb-session-prune` live-delete seam so
callers cannot delete only the session row and strand control rows；cover boot-prune behavior too。

This drain-first sequence applies only to request-bound phase shutdown。Ordinary/non-phase Codex
keeps the current finally order（kill TUI first，then runtime stop/drain）for byte compatibility；
pin both sequences in adapter tests，including heartbeat stop order，instead of only counting calls。

**Step 3 — Cross-path regression**

Post-merge shipping-session cleanup、post-ship Design/Implement/QA finalization and
canceled/founder_parked lifecycle-closeout must all exercise the same helper；external/manual
close of a qualifying phase inherits it automatically。No second issue-terminal predicate。

**Step 4 — Verify and commit**

```bash
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-claude-runner typecheck
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/codex-phase-shutdown.test.ts \
  src/__tests__/close-runner.test.ts \
  src/__tests__/post-merge.test.ts \
  src/__tests__/commdb-session-prune.test.ts \
  src/bridge/__tests__/lifecycle-closeout.test.ts \
  src/bridge/__tests__/post-ship-finalization.fly887.test.ts
pnpm --filter flywheel-claude-runner exec vitest run test/CodexTmuxAdapter.test.ts
git add packages/teamlead/src/bridge/codex-phase-shutdown.ts \
  packages/teamlead/src/bridge/__tests__/codex-phase-shutdown.test.ts \
  packages/teamlead/src/bridge/close-runner.ts \
  packages/teamlead/src/bridge/post-merge.ts \
  packages/teamlead/src/bridge/commdb-session-prune.ts \
  packages/teamlead/src/__tests__/close-runner.test.ts \
  packages/teamlead/src/__tests__/post-merge.test.ts \
  packages/teamlead/src/__tests__/commdb-session-prune.test.ts \
  packages/teamlead/src/bridge/lifecycle-closeout.ts \
  packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts \
  packages/teamlead/src/bridge/__tests__/post-ship-finalization.fly887.test.ts \
  packages/claude-runner/src/CodexTmuxAdapter.ts \
  packages/claude-runner/test/CodexTmuxAdapter.test.ts
git commit -m "fix(lifecycle): drain resident Codex phases before cleanup"
```

If `lifecycle-closeout.ts` required no change, omit it from `git add`；do not make a no-op edit。

### Task 6 — Lock handoff, wake, and FLY-1257 orthogonality regressions

**Files:**

- Modify: `packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly1224-probe-before-wake.test.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts`
- Modify: `packages/claude-runner/test/codex-daemon-client.test.ts`
- Modify: `packages/claude-runner/test/CodexTmuxAdapter.test.ts`

**Step 1 — Add integration assertions**

- live Codex design_done now probes alive、parks、handoffs Implement；
- later handback targets same execution and calls wake, never respawn；
- wake clear-declared + mailbox delivery order unchanged；
- TURN grant occurs before mailbox wake；
- kill switch OFF follows legacy dead/close/spawn path；
- if FLY-1257 is present, all its blocked/gateHold tests remain untouched and green；add one
  combined phaseHold+gateHold test proving independent latches and classifier priority。

**Step 2 — Verify and commit**

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/phase-orchestrator.fly1224-probe-before-wake.test.ts \
  src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-daemon-client.test.ts test/CodexTmuxAdapter.test.ts
git add packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly1224-probe-before-wake.test.ts \
  packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts \
  packages/claude-runner/test/codex-daemon-client.test.ts \
  packages/claude-runner/test/CodexTmuxAdapter.test.ts
git commit -m "test(runtime): lock three-stage Codex park and wake"
```

### Task 7 — Full package verification and self-review

**Step 1 — Focused suites**

Run every command from Tasks 1–6 again from a clean working tree。

**Step 2 — Full affected packages**

```bash
pnpm --filter flywheel-core typecheck
pnpm --filter flywheel-comm test
pnpm --filter flywheel-comm typecheck
pnpm --filter flywheel-agent-team-transport test
pnpm --filter flywheel-agent-team-transport typecheck
pnpm --filter flywheel-claude-runner test
pnpm --filter flywheel-claude-runner typecheck
pnpm --filter flywheel-edge-worker test
pnpm --filter flywheel-edge-worker typecheck
pnpm --filter flywheel-teamlead test
pnpm --filter flywheel-teamlead typecheck
```

Expected: all exit 0；no unhandled timer/open-handle warning；ordinary Codex terminal reclaim、
Claude keepalive、Auto-QA、single-session snapshots all green。

**Step 3 — Static review**

```bash
git diff --check origin/main...HEAD
rg -n 'TO''DO|TB''D' packages engineering/doc/FLY-1269-codex-phase-keepalive
rg -n "phaseHold|gateHold|runner_phase_wakes|runner_shutdown_controls" \
  packages engineering/doc/FLY-1269-codex-phase-keepalive
git status --short
```

Expected: first two commands produce no whitespace/unresolved-marker findings；every new
control/latch reference has
tests and cleanup semantics；only intended files changed。

**Step 4 — Cross-family code review**

Create/push the PR，then use the mandatory `review_code` request-driven lane；do not open the
approve gate until the reviewed head is APPROVED/SKIPPED。Any changes require a new review round。

### Task 8 — 529 Room real-machine acceptance（mandatory before ship）

**Files:**

- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-report.md`
- Create evidence files under the same `qa/` folder（tmux/process/session snapshots、message ids、
  thread ids、shutdown request/ack）。

**Step 1 — Deploy isolated candidate**

Use the existing 529 slot deployment/runbook，confirm candidate SHA，then dispatch a purpose-built
three-stage issue with locked models：Design=Codex（Fable unavailable path）、
Implement=Codex gpt-5.6-sol xhigh、QA=Claude Opus。Record issue id and three execution ids。

**Step 2 — Design park proof**

After Design commits docs and handoff starts Implement，wait at least 60s，then capture：

```bash
tmux list-windows -a -F '#S:#I.#P #{window_name} #{pane_dead} #{pane_pid}'
ps -axo pid,ppid,command | rg 'codex app-server|codex resume --remote'
```

Expected: Design pane/process remains live；session shows design_done + declared parked；goal is
paused；no new turns/tokens during quiet window。

**Step 3 — Same-session re-engage proof**

Send one Lead handback/founder question to the Design execution。Record mailbox message id，prove
the same executionId/threadId becomes active，runner executes TURN first，answers/acts within role，
then re-parks。No new Design session row/tmux window may appear。

**Step 4 — Full issue close proof**

Let Implement and QA finish and ship through verified approval/workflow。Capture：

- closeRunner shutdown request id for every resident Codex phase；
- matching adapter ack after daemon drained；
- Design/Implement/QA panes disappear in the same lifecycle finalization；
- no matching app-server/socket remains；
- shared worktree cleanup occurs only after ack；
- issue reaches Done/terminal once。

**Step 5 — Claude regression control**

Run the same phase park/handoff/ship shape with Claude phase backend。Expected：existing
parked-alive behavior、wake、TURN、final close unchanged；no shutdown handshake wait is added to
Claude direct tmux kill。

**Step 6 — Report**

Write exact SHA、versions、timestamps、execution/thread/message/request ids、commands、raw outputs
and PASS/FAIL per acceptance item to `qa/529-e2e-report.md`。Any failure blocks ship；do not
substitute unit tests for this E2E。

## Failure and Recovery Rules

| Failure | Required behavior |
|---|---|
| complete→paused probe fails | stop；new Lead architecture gate；no hot poll/respawn fallback |
| enter-hold pause RPC/confirmation fails | retain `entering` latch；no watcher/wake；slow local retry or daemon restart/resume；shutdown remains available |
| declared-state/DB read fails | stay alive/paused，log；never infer issue terminal |
| mailbox callback persist fails | do not ack；retry same message |
| bound mailbox/CommDB instruction mismatch | fail loud and do not ack；never deliver cross-execution content |
| active Runner listed instruction before hold | still queue one `[phase-wake id]` replay；dedupe by source/message id，never infer handled from `read_at` |
| paused wake kick or later active set fails | keep phaseHold + queue state；runtime restart/retry same thread，never active-first |
| daemon transport dies while held | resume thread；preflight latch；do not initial-kick blindly |
| shutdown arrives during an active turn | adapter race stops runtime immediately；ack only after drained |
| phase parked longer than 24h/49h | remain paused；active + hard clocks frozen；only lifecycle closeout ends idle |
| shutdown request DB write fails | closeRunner/post-merge returns blocked/partial；no tmux/worktree teardown |
| shutdown ack fails/times out while controller heartbeat advances | lifecycle closeout remains partial；no row delete/Done |
| shutdown controller heartbeat stops / pane dead or absent | use existing direct cleanup；never wait forever for an impossible ack |
| shutdown liveness probe indeterminate | fail closed/partial；no direct kill |
| close authority is lost/reopened | existing sticky authority check wins；stop teardown |
| FLY-1257 rebase conflict | retain separate gateHold/phaseHold tests；never merge booleans |
| 529 visible/runtime evidence fails | no ship；attach evidence and re-open code review after fix |

## Acceptance Criteria

1. Codex Design handoff后至少 60s仍显示 `parked-alive`，同 execution/thread 可 re-engage。
2. Implement `needs_review` 后继续作为 context holder；QA handback唤醒同一 Implement。
3. park期间 native goal paused，无自动 turn/token增长；mailbox wake才恢复。
4. 所有 resumed phase 在 worktree mutation前重新执行 TURN并只接受 `yours`。
5. shipped/canceled/founder-close均通过 shared close helper；live controller必须
   request/ack且 backend drain后才 cleanup，proven orphan走 direct cleanup，transient
   DB/probe error不误杀。
6. QA/ship 后 Design/Implement/QA 三段一起下线，无 orphan app-server/socket/session row。
7. Claude three-stage、single-session Codex、Auto-QA、keepalive kill switch OFF行为不变。
8. FLY-1257 gate hold保持独立；两套 latch可同时存在、restart不互相清除。
9. affected package tests/typechecks全绿，cross-family code review通过，529 E2E PASS。
