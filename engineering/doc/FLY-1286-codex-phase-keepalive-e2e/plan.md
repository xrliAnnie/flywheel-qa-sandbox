# FLY-1286 Codex Resident Three-Stage 529 E2E Implementation Plan

> **For Flywheel phases:** Execute through the existing Design → Implement → QA controllers on the shared branch. Do not dispatch subagents, do not add production behavior, and do not substitute static tests for the real-machine evidence gates below.

**Goal:** 在 test-slot-2 真实跑通并证明 Design=Codex → Implement=Codex xhigh → QA=Opus，同时验证 Codex phase 的 paused hold、预算冻结、mailbox wake、daemon crash recovery、TURN 交接与 issue-terminal cooperative shutdown。

**Architecture:** 真实 phase chain 是被测系统；StateStore、CommDB、Codex session state、native goal DB、tmux/app-server 构成多平面证据。Implement 对 parked Design 做一次有前置保护的 daemon crash 与一次 Lead-routed mailbox wake；QA 独立复核；issue 外的 FLY-1269 收尾会话在终态前启动 observer，捕获会被 cleanup 删除的 shutdown request/ack 窗口。

**Tech Stack:** TypeScript/Node.js, pnpm, Vitest, SQLite/`sqlite3`, jq, tmux, Flywheel Comm CLI, Codex app-server native goals, qa-sandbox GitHub remote.

---

## Constraints

- Mutable scope 仅限以下显式 allowlist：
  - `/tmp/flywheel-test-slot-2/**`
  - `/Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db*`
  - successful FLY-1286 exec 的
    `/Users/xiaorongli/.flywheel/state/codex-sessions/<exec>/**`
  - successful FLY-1286 exec 的
    `/Users/xiaorongli/.flywheel/codex-homes/<exec>/**`
  - execution hash 对应的
    `/Users/xiaorongli/.flywheel/cdx-sock/<sha1(exec)[0:16]>.sock*`
  - 本次 gate/review round 的
    `/Users/xiaorongli/.flywheel/state/codex-gates/<question>.json` 与
    `/Users/xiaorongli/.flywheel/state/review-requests/<request>.json`
  - `xrliAnnie/flywheel-qa-sandbox` 的 `flywheel-FLY-1269` branch/PR
- 不得把上述 execution-private protocol state 误报为 production mutation；同时不得写其他
  project CommDB、其他 execution state、production repo/branch。
- 不修改 `packages/**` production source；candidate defect 必须 FAIL 回 FLY-1269 修。
- 所有 phase 在触碰 worktree 前运行本次 prompt 给出的 `turn --exec-id`，只接受 `yours`。
- successful chain root 固定为 Design execution
  `c552669e-611b-47fc-98ca-63371c81cbe8`；旧 blocked/terminated attempts 只存档。
- 缺少任一 acceptance oracle 的权威证据即 FAIL；不得用 stage label、自报、旧 unit test、
  issue title 或单一 screenshot 补洞。
- Design/Implement 不得在 phase handoff 后自行关闭；它们必须 park 到 issue terminal。

## Deliverables

**Design process docs:**

- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/exploration.md`
- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/research.md`
- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/plan.md`
- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/progress.md`

**FLY-1269 E2E evidence:**

- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`
- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`
- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs`
- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs`
- Runtime output outside the disposable worktree:
  `/tmp/flywheel-test-slot-2/FLY-1286-terminal-observer.jsonl`

`qa-report.md` 在 terminal handshake 完成前只能写
`PHASE PASS — TERMINAL CLOSEOUT PENDING`；FINAL PASS 由 issue 外收尾会话补齐。

### Task 1: Design phase handoff

**Files:**

- Modify: `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/progress.md`
- Commit: the four Design process docs above

- [ ] **Step 1: Self-review the Design docs**

Run:

```bash
rg -n '\x54\x42\x44|\x54\x4f\x44\x4f|implement[ ]later|fill[ ]in|Similar[ ]to[ ]Task' \
  engineering/doc/FLY-1286-codex-phase-keepalive-e2e
git diff --check
```

Expected: `rg` has no unresolved placeholder hit; `git diff --check` exits 0.

- [ ] **Step 2: Run the mandatory cross-family design review**

Run the exact request-driven Codex-author flow from the Design prompt:

```bash
GATE_JSON=$(node "$FLYWHEEL_COMM_CLI" gate review_design \
  --lead flywheel-test-2 \
  --exec-id c552669e-611b-47fc-98ca-63371c81cbe8 \
  --no-block \
  "Review the FLY-1286 529 real-machine E2E plan for evidence completeness, isolation, crash/wake safety, and terminal shutdown observability")
QUESTION_ID=$(printf '%s' "$GATE_JSON" | jq -er .questionId)

node "$FLYWHEEL_COMM_CLI" request-review \
  --type design \
  --question-id "$QUESTION_ID" \
  --plan engineering/doc/FLY-1286-codex-phase-keepalive-e2e/plan.md
```

Poll `node "$FLYWHEEL_COMM_CLI" check "$QUESTION_ID"` across turns. Expected:
`APPROVED`. On `CHANGES_REQUESTED`, edit docs only, open a new review question, and repeat.

- [ ] **Step 3: Commit and push Design docs**

```bash
git add \
  engineering/doc/FLY-1286-codex-phase-keepalive-e2e/exploration.md \
  engineering/doc/FLY-1286-codex-phase-keepalive-e2e/research.md \
  engineering/doc/FLY-1286-codex-phase-keepalive-e2e/plan.md \
  engineering/doc/FLY-1286-codex-phase-keepalive-e2e/progress.md
git commit -m "docs(FLY-1286): design resident three-stage E2E"
git push origin HEAD:flywheel-FLY-1269
```

Expected: push updates only the qa-sandbox remote branch. Verify with
`gh repo view --json nameWithOwner -q .nameWithOwner` =
`xrliAnnie/flywheel-qa-sandbox` before pushing.

- [ ] **Step 4: Complete and park Design**

```bash
node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete
node "$FLYWHEEL_COMM_CLI" park \
  --exec-id c552669e-611b-47fc-98ca-63371c81cbe8 \
  --reason "three-stage design parked until ship"
```

Expected: phase controller remains alive; this Design turn ends without implement/PR/ship work.

### Task 2: Implement bootstrap and observer TDD

**Files:**

- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs`
- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs`
- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`
- Create: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`

- [ ] **Step 1: Acquire Implement TURN and pin safe paths**

Run `turn` first with the Implement execution id from its environment. Then:

```bash
export STATE_DB=/tmp/flywheel-test-slot-2/teamlead.db
export COMM_DB=/Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db
export DESIGN_EXEC=c552669e-611b-47fc-98ca-63371c81cbe8
export DESIGN_STATE=/Users/xiaorongli/.flywheel/state/codex-sessions/$DESIGN_EXEC/session.json
export DESIGN_HOME=/Users/xiaorongli/.flywheel/codex-homes/$DESIGN_EXEC
test "$(gh repo view --json nameWithOwner -q .nameWithOwner)" = xrliAnnie/flywheel-qa-sandbox
test "$FLYWHEEL_ISSUE_ID" = FLY-1286
```

Expected: all tests exit 0. Any path/project mismatch stops the E2E before mutation.

- [ ] **Step 2: Write the failing observer tests**

The test must create disposable StateStore/CommDB SQLite fixtures, fake tmux/lsof/socket probes, and
spawn the observer with `--interval-ms 10 --timeout-ms 2000`. Cover exactly:

```js
test("records requested then acked before lifecycle rows disappear", async () => {
  // Seed design + implement successful-chain rows and a TURN.
  // Transition both shutdown rows requested -> acked -> deleted.
  // Delete the successful-chain StateStore/CommDB sessions and TURN.
  // Assert exit 0 and one final verdict frame with pass=true.
  // Assert each exec history contains requested and acked in that order.
});

test("corroborates a cadence-missed ack with the durable graceful-close event", async () => {
  // Expose requested, then atomically delete lifecycle rows without an observable ack frame.
  // Insert lead_close_runner with payload.phaseShutdownRequestId = observed request id.
  // Assert graceful_corroborated rather than a false failure.
});

test("fails a live fresh cleanup without ack or matching durable event", async () => {
  // Keep heartbeat fresh and tmux live, expose requested, then delete rows without ack/event.
  // Assert non-zero exit and reason contains missing_shutdown_ack_corroboration.
});

test("classifies a proven direct path instead of pretending it was graceful", async () => {
  // Make heartbeat stale and tmux target provably absent before lifecycle deletion.
  // Assert direct_proven classification, no fabricated requested/acked history, and rerunRequired.
});

test("fails closed when direct-path liveness is indeterminate", async () => {
  // Make tmux/lsof probe unreadable and delete lifecycle rows without a handshake.
  // Assert non-zero exit with liveness_indeterminate.
});

test("ignores old failed FLY-1286 attempts outside the manifest", async () => {
  // Leave an unrelated blocked/terminated row for the same issue.
  // Assert the successful chain can still pass.
});

test("requires TURN deletion and QA successful-chain session cleanup", async () => {
  // Ack both Codex phases but keep either TURN or QA row.
  // Assert timeout/non-zero rather than a false PASS.
});

test("requires no socket listener or holder after cleanup", async () => {
  // Delete lifecycle rows but keep bounded-connect success or an lsof holder.
  // Assert orphan_socket/orphan_holder; missing or unreadable lsof is indeterminate.
});

test("opens both WAL databases readonly", async () => {
  // Assert every sqlite child receives -readonly plus PRAGMA query_only=1.
  // Snapshot fixture db/wal/shm metadata and assert the observer does not mutate it.
});
```

Run:

```bash
node --test \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs
```

Expected RED: module missing or assertions fail because observer behavior is not implemented.

- [ ] **Step 3: Implement the minimum observer**

The observer CLI must accept:

```text
--state-db PATH
--comm-db PATH
--issue FLY-1286
--design-exec UUID
--implement-exec UUID
--qa-exec UUID
--socket-root PATH
--out PATH
--interval-ms 50
--timeout-ms 900000
```

Implementation requirements:

1. use `execFileSync("sqlite3", ["-readonly", "-json", dbPath,
   "PRAGMA query_only=1;" + sql])`, never shell interpolation;
2. append one JSONL frame on every changed snapshot, including UTC timestamp;
3. retain each Codex exec's shutdown states/request id plus StateStore heartbeat age, saved tmux target,
   and durable `session_events` rows; a missed ack is corroborated only by `lead_close_runner` with
   the same `payload.phaseShutdownRequestId`;
4. classify lifecycle paths: live + heartbeat-fresh requires graceful evidence; target gone/dead or
   heartbeat stale may be `direct_proven`; indeterminate is never PASS. `direct_proven` sets
   `rerunRequired:true` because this injected E2E still needs handshake evidence;
5. derive each execution-private socket as `<socket-root>/<sha1(exec)[0:16]>.sock`; after cleanup,
   bounded connect must fail and `lsof -t -- <socket>` must report no holder. Missing/unreadable lsof
   is indeterminate, never “no orphan”;
6. require successful-chain StateStore rows and CommDB session rows gone, QA row gone, TURN gone,
   and saved tmux targets absent;
7. ignore same-issue sessions not named by the three manifest execution ids;
8. exit 0 only after all cleanup conditions and write a classified verdict; FINAL handshake PASS
   additionally requires neither Codex exec has `rerunRequired:true`;
9. timeout, missing/out-of-order uncorroborated handshake, live socket/holder, or indeterminate probe
   writes `{kind:"verdict",pass:false,reason}` and exits 1;
10. never write either database or signal any process.

Run the test again. Expected GREEN: 9 tests pass.

- [ ] **Step 4: Refactor and validate real read-only `--once` mode**

Add `--once` to emit one snapshot without waiting or changing state. Run:

```bash
node --check \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs
node engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs \
  --state-db "$STATE_DB" \
  --comm-db "$COMM_DB" \
  --issue FLY-1286 \
  --design-exec "$DESIGN_EXEC" \
  --implement-exec "$FLYWHEEL_EXEC_ID" \
  --qa-exec not-spawned-yet \
  --socket-root /Users/xiaorongli/.flywheel/cdx-sock \
  --out /tmp/flywheel-test-slot-2/FLY-1286-observer-once.jsonl \
  --once
```

Expected: syntax passes; the output contains Design/Implement snapshots and no mutation. Compare
StateStore/CommDB/WAL/SHM metadata before/after `--once`; any observer-caused write is FAIL.

### Task 3: Prove the parked Design hold and budget freeze

**Files:**

- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`
- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`

- [ ] **Step 1: Bounded-wait for the Design hold, then resolve socket/group identity**

For at most 120 seconds, poll every 2 seconds until the same Design execution has all of:
`design_done`, declared `parked`, `phaseHold.state=paused`, native goal `paused`, current TURN held by
Implement epoch 2, tmux target live, control socket connectable, and heartbeat advancing. The handoff
event and native goal completion are not ordered, so an early missing `phaseHold` is “not ready yet”,
not an immediate FAIL. Timeout or identity drift is FAIL.

After the bounded wait succeeds, capture:

```bash
export DESIGN_THREAD=$(jq -r .threadId "$DESIGN_STATE")
export DESIGN_PID=$(jq -r .daemonPid "$DESIGN_STATE")
export DESIGN_GOAL_DB=$DESIGN_HOME/goals_1.sqlite
export DESIGN_SOCKET_HASH=$(node -e 'const {createHash}=require("node:crypto");process.stdout.write(createHash("sha1").update(process.argv[1]).digest("hex").slice(0,16))' "$DESIGN_EXEC")
export DESIGN_SOCKET=/Users/xiaorongli/.flywheel/cdx-sock/$DESIGN_SOCKET_HASH.sock
export DESIGN_LSOF=$(lsof -n -Fpg -- "$DESIGN_SOCKET")
export DESIGN_SOCKET_HOLDERS=$(printf '%s\n' "$DESIGN_LSOF" | sed -n 's/^p//p' | sort -nu)
export DESIGN_SOCKET_PGIDS=$(printf '%s\n' "$DESIGN_LSOF" | sed -n 's/^g//p' | sort -nu)

sqlite3 -readonly -json "$STATE_DB" \
  "SELECT execution_id,status,adapter_type,chat_thread_role,runner_model,heartbeat_at FROM sessions WHERE execution_id='$DESIGN_EXEC';"
sqlite3 -readonly -json "$COMM_DB" \
  "SELECT * FROM three_stage_turn WHERE issue_id='FLY-1286'; SELECT * FROM runner_declared_states WHERE execution_id='$DESIGN_EXEC';"
jq '{executionId,issueId,threadId,daemonPid,phaseHold}' "$DESIGN_STATE"
sqlite3 -readonly -json "$DESIGN_GOAL_DB" \
  "SELECT thread_id,goal_id,status,token_budget,tokens_used,time_used_seconds,updated_at_ms FROM thread_goals WHERE thread_id='$DESIGN_THREAD';"
kill -0 "$DESIGN_PID"
kill -0 -- "-$DESIGN_PID"
test -n "$DESIGN_SOCKET_HOLDERS"
printf '%s\n' "$DESIGN_SOCKET_PGIDS" | grep -qx "$DESIGN_PID"
node -e 'const net=require("node:net");const s=net.createConnection(process.argv[1]);const t=setTimeout(()=>{s.destroy();process.exit(2)},2000);s.once("connect",()=>{clearTimeout(t);s.destroy();process.exit(0)});s.once("error",()=>{clearTimeout(t);process.exit(1)})' "$DESIGN_SOCKET"
```

Expected:

- Design StateStore row is `design_done`, `codex-tmux`, role `design`, same exec;
- declared state is `parked`;
- `phaseHold.state=paused` and role `design`;
- native goal is `paused`;
- recorded shim is the detached group leader, at least one socket holder belongs to that group, and
  the socket accepts a bounded connection (`kill -0` alone is not app-server evidence). Record any
  foreign/client holder PGIDs separately; they do not invalidate ownership;
- current TURN is Implement / epoch 2 / current Implement exec.

- [ ] **Step 2: Capture two samples at least 60 seconds apart**

Poll every 5 seconds for 13 iterations; append JSON snapshots to the chain evidence. Compare first
and last sample. Expected:

- heartbeat advances;
- goal id/status/token_budget/tokens_used/time_used_seconds/updated_at_ms unchanged;
- `phaseHold.enteredAt`, `deadlineRemainingMs`, `hardDeadlineRemainingMs` unchanged;
- shim pid/process group, socket holder group, and Design execution/thread unchanged;
- TURN remains Implement epoch 2.

If any model/goal/budget field moves during the hold, record exact samples and stop with FAIL.

- [ ] **Step 3: Capture liveness evidence**

```bash
export DESIGN_TMUX=$(jq -r .tmuxWindow "$DESIGN_STATE")
tmux display-message -p -t "$DESIGN_TMUX" '#{session_name}:#{window_name}:#{pane_dead}'
tmux capture-pane -p -t "$DESIGN_TMUX" -S -120
```

Expected: same Design window exists and is not a dead pane. Save the capture with secrets redacted;
do not copy environment variables or auth/config content.

### Task 4: Prove parked-daemon crash recovery

**Files:**

- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`
- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`

- [ ] **Step 1: Re-run all fault-injection preconditions**

Immediately before the signal, assert:

```bash
test "$(jq -r .executionId "$DESIGN_STATE")" = "$DESIGN_EXEC"
test "$(jq -r .issueId "$DESIGN_STATE")" = FLY-1286
test "$(jq -r .phaseHold.state "$DESIGN_STATE")" = paused
test "$(sqlite3 -readonly "$DESIGN_GOAL_DB" "PRAGMA query_only=1; SELECT status FROM thread_goals WHERE thread_id='$DESIGN_THREAD';")" = paused
test "$(sqlite3 -readonly "$COMM_DB" "PRAGMA query_only=1; SELECT holder_exec_id FROM three_stage_turn WHERE issue_id='FLY-1286';")" = "$FLYWHEEL_EXEC_ID"
kill -0 "$DESIGN_PID"
kill -0 -- "-$DESIGN_PID"
node -e 'const net=require("node:net");const s=net.createConnection(process.argv[1]);const t=setTimeout(()=>{s.destroy();process.exit(2)},2000);s.once("connect",()=>{clearTimeout(t);s.destroy();process.exit(0)});s.once("error",()=>{clearTimeout(t);process.exit(1)})' "$DESIGN_SOCKET"
CURRENT_LSOF=$(lsof -n -Fpg -- "$DESIGN_SOCKET")
CURRENT_HOLDERS=$(printf '%s\n' "$CURRENT_LSOF" | sed -n 's/^p//p' | sort -nu)
CURRENT_PGIDS=$(printf '%s\n' "$CURRENT_LSOF" | sed -n 's/^g//p' | sort -nu)
test -n "$CURRENT_HOLDERS"
printf '%s\n' "$CURRENT_PGIDS" | grep -qx "$DESIGN_PID"
```

Expected: all exit 0 and independently prove that the persisted shim pid is the leader of at least
one execution-private socket-holder group. This mirrors production's `holders.some(...)` ownership
predicate; record other client/race holders but do not treat them as ownership failure. A missing
`lsof`, permission error, empty/unparseable value, or no holder in the target PGID is indeterminate:
do not signal anything.

- [ ] **Step 2: Kill only the proven Design daemon process group**

```bash
export OLD_DESIGN_PID=$DESIGN_PID
export OLD_DESIGN_PGID=$DESIGN_PID
kill -KILL -- "-$OLD_DESIGN_PGID"
```

The negative pid is intentional: `daemonPid` is the detached rotation-shim group leader, while the
real app-server is its child and owns the socket. Killing only the positive shim pid would orphan the
app-server and never close the transport. Do not signal adapter/TUI/tmux/Bridge, do not use process
name matching, and never signal a group unless every Step 1 proof passed immediately beforehand.

- [ ] **Step 3: Poll bounded recovery**

Every 2 seconds for at most 120 seconds, re-read `session.json`. Success requires:

- `daemonPid` becomes a different positive shim pid/PGID, that pid is its own group leader, the
  execution-private socket accepts a bounded connection, and at least one `lsof` holder belongs to
  the new group; record any foreign/client holder separately;
- the old socket-holder group is gone; no holder remains in `OLD_DESIGN_PGID`;
- execution id, issue id, thread id remain identical;
- `phaseHold.state` returns/remains `paused`;
- native goal id/status/token budget remain identical and paused;
- no new successful/live Design StateStore session appears;
- TURN stays Implement epoch 2;
- no wake row was created by the crash.

While the killed app-server's WAL is dirty, a read-only open of `goals_1.sqlite` may transiently
return `SQLITE_READONLY_RECOVERY`/`CANTOPEN` until the replacement app-server reopens it read-write
and recovers WAL. Treat that specific crash-window error as “not ready yet” and retry within the same
120-second bound. It becomes FAIL only if it persists after the new socket is live, or the recovered
goal id/status/budget differs.

On timeout or identity drift, stop with FAIL and do not attempt another kill.

- [ ] **Step 4: Re-run the 60-second freeze window**

Repeat Task 3 Step 2 against the new group/socket holder. Expected: budget fields remain frozen and
heartbeat continues. Record old/new shim pid/PGID, old/new socket holder pids, and recovery latency.

### Task 5: Prove real mailbox wake and re-hold

**Files:**

- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`
- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`

- [ ] **Step 1: Ask the Lead to send one bounded probe**

Use the non-blocking Lead channel from the Implement prompt. Send exactly one request:

```text
FLY-1286 E2E action: please send one instruction to Design execution c552669e-611b-47fc-98ca-63371c81cbe8 with this content: FLY-1286 WAKE_PROBE — run TURN first, do not touch the worktree, report the current holder, then re-park; if this stable instruction is redelivered, report only and do not repeat side effects. Please reply with the CommDB instruction id.
```

Continue assembling passive evidence, and poll `check` for the reply. Do not impersonate the Lead by
calling `send --from flywheel-test-2` from the Implement runner.

After the Lead confirms the send, resolve the durable id from CommDB and require exactly one matching
instruction:

```bash
export WAKE_INSTRUCTION_ID=$(sqlite3 -readonly "$COMM_DB" \
  "PRAGMA query_only=1; SELECT id FROM messages WHERE to_agent='$DESIGN_EXEC' AND type='instruction' AND content LIKE 'FLY-1286 WAKE_PROBE%' ORDER BY created_at DESC LIMIT 1;")
test -n "$WAKE_INSTRUCTION_ID"
test "$(sqlite3 -readonly "$COMM_DB" "PRAGMA query_only=1; SELECT count(*) FROM messages WHERE id='$WAKE_INSTRUCTION_ID' AND to_agent='$DESIGN_EXEC' AND type='instruction';")" = 1
```

- [ ] **Step 2: Observe durable intake and activation**

Poll the Design rows:

```sql
SELECT id,to_agent,delivered_at,read_at,content
FROM messages
WHERE id = '$WAKE_INSTRUCTION_ID';

SELECT queue_seq,execution_id,message_id,source_instruction_id,state,
       queued_at,started_at,finished_at
FROM runner_phase_wakes
WHERE execution_id = 'c552669e-611b-47fc-98ca-63371c81cbe8'
ORDER BY queue_seq;
```

Expected:

- instruction is addressed to Design exec and delivered;
- one wake row binds `source_instruction_id` to it;
- row reaches `pending → started → finished` with ordered timestamps;
- Design thread id and goal id never change;
- TURN remains Implement; Design does not acquire it;
- Design goal consumes tokens/time only during the bounded wake, then returns paused;
- new `phaseHold.enteredAt` is later than the pre-wake hold;
- a second 60-second sample proves the new hold freezes again.

If Lead returns no instruction id, the binding is wrong, or no new hold appears, FAIL. Do not resend
with a new instruction until the first row is understood; duplicate sends would muddy the stable-id test.

### Task 6: Implement evidence commit, sandbox PR, cross-family review, and park

**Files:**

- Modify: all FLY-1269 E2E evidence deliverables

- [ ] **Step 1: Verify no production source changed**

```bash
git diff --name-only c833f78b552b0df54fb49d8f0d7c79331513ea28 HEAD
git status --short
```

Expected: changes are limited to the FLY-1286 Design docs and FLY-1269 qa/evidence files. Any
`packages/**`, runtime config, workflow, or production script change fails scope.

- [ ] **Step 2: Run observer tests and candidate regression tests**

```bash
node --test engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-phase-lifecycle.test.ts \
  test/codex-daemon-client.test.ts \
  test/codex-daemon-goal-runtime.test.ts
pnpm --filter flywheel-config exec vitest run src/__tests__/three-stage-phases.test.ts
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Commit and push only evidence work**

```bash
git add \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs
git commit -m "test(FLY-1269): capture resident phase E2E evidence"
git push origin HEAD:flywheel-FLY-1269
```

- [ ] **Step 4: Reuse or create the qa-sandbox PR**

```bash
gh pr list --state open --head flywheel-FLY-1269 \
  --json number,url,headRefOid
```

If none exists, create one against `main` in `xrliAnnie/flywheel-qa-sandbox`. Never address
production PR #604 through the qa-sandbox remote. Record the sandbox PR number/url in the manifest.

- [ ] **Step 5: Complete mandatory cross-family code review**

Run the Implement prompt's `gate review_code --no-block` and
`request-review --type code` flow. Expected reviewer family: Claude, verdict APPROVED for the exact
current head. On changes, fix evidence/harness only, push, and open a new review round.

- [ ] **Step 6: Open the review gate, complete, and park**

Run the Implement prompt's `approve_to_ship` gate, capture its returned question id, then run
`complete --route needs_review` with the actual sandbox PR number and that question id. Then:

```bash
node "$FLYWHEEL_COMM_CLI" park \
  --exec-id "$FLYWHEEL_EXEC_ID" \
  --reason "three-stage implement parked awaiting QA"
```

Expected: same Implement execution/thread/goal remains alive and paused for QA to verify.

### Task 7: QA Opus independently verifies the successful chain

**Files:**

- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`
- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`

- [ ] **Step 1: Acquire QA TURN and prove QA routing**

Run QA `turn` first. Query its StateStore row. Expected:

- `adapter_type=claude-tmux`
- `chat_thread_role=qa`
- `runner_model=claude-opus-4-8`
- current TURN holder is QA exec, phase `qa`, epoch 3

If QA is Codex, Fable, Sonnet, or any non-Opus Claude model, FAIL immediately.

- [ ] **Step 2: Prove Implement routing and xhigh from runtime**

Find the successful Implement exec from the manifest/StateStore. Require:

- `adapter_type=codex-tmux`, role `implement`, model `gpt-5.6-sol`;
- process argv contains the two argv elements equivalent to
  `-c model_reasoning_effort="xhigh"`;
- live TUI capture displays `gpt-5.6-sol xhigh`;
- no Implement fallback/retry execution replaced the manifest exec.

Use `ps -p "$IMPLEMENT_PID" -o command=` and `tmux capture-pane` from QA's real-machine surface.
If OS permissions prevent argv evidence, FAIL as an environment/evidence block; do not downgrade to
the phase table or issue title.

- [ ] **Step 3: Prove both Codex phases are resident and frozen**

For Design and Implement separately, repeat Task 3's five-plane check and a 60-second two-sample
window. Expected: same successful exec/thread/goal, paused `phaseHold`, declared parked, live TUI,
execution-private socket connectable with at least one holder in the persisted shim-led group,
foreign/client holders recorded, heartbeat advancing, and goal budget fields frozen. A positive
`kill -0 daemonPid` is only corroboration and cannot substitute for the socket/holder oracle.

- [ ] **Step 4: Re-audit crash, wake, TURN, and isolation evidence**

Independently query raw DB/session files; do not trust the Implement summary. Require all A1–A6/A8
oracle rows from research.md. Confirm current git diff from candidate contains only Design docs and
FLY-1269 qa/evidence files. Also compare the pre-run/post-run runtime path inventory: every changed
path must be one of the manifest's exact successful exec session/CODEX_HOME/socket paths, this
round's gate/review marker, test-slot-2 CommDB, or `/tmp/flywheel-test-slot-2/**`. Any other project
CommDB, execution state, or production repo/branch path is A8 FAIL. Do not infer a system-global
filesystem diff from concurrent unrelated Flywheel activity; each allowed path must be positively
bound to this issue/exec/question/request id.

- [ ] **Step 5: Run full narrow regression set**

```bash
node --test engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs
pnpm --filter flywheel-claude-runner exec vitest run \
  test/codex-phase-lifecycle.test.ts \
  test/codex-daemon-client.test.ts \
  test/codex-daemon-goal-runtime.test.ts
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/codex-phase-shutdown.test.ts \
  src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts \
  src/bridge/__tests__/phase-orchestrator.fly939-wake-not-respawn.test.ts \
  src/__tests__/phase-orchestrator.fly921-adversarial.test.ts
pnpm --filter flywheel-config exec vitest run src/__tests__/three-stage-phases.test.ts
```

Expected: all pass. Record command, count, duration, SHA, and UTC timestamp.

- [ ] **Step 6: Write the pre-terminal verdict**

If A1–A6/A8 pass, write exactly:

```text
PHASE PASS — TERMINAL CLOSEOUT PENDING
```

List terminal A7 as the only pending item. On any other missing evidence, write FAIL and use the QA
FAIL/kickback path; do not open founder approval.

### Task 8: Arm the external observer before QA opens terminal approval

**Files:**

- Runtime output: `/tmp/flywheel-test-slot-2/FLY-1286-terminal-observer.jsonl`

- [ ] **Step 1: QA asks the Lead/FLY-1269 closing session to arm the observer**

Send one non-blocking ask containing Design, Implement, QA execution ids, sandbox PR url, current
head, and the exact command from Step 2. Poll `check` until the Lead explicitly returns
`observer_armed` plus observer pid/output path. This is a hard evidence prerequisite; no reply means
QA waits/parks, not that A7 is waived.

- [ ] **Step 2: External owner copies and starts the observer outside the disposable worktree**

```bash
rm -f /tmp/flywheel-test-slot-2/FLY-1286-terminal-observer.jsonl
install -m 0555 \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs \
  /tmp/flywheel-test-slot-2/529-terminal-observer.mjs
test "$(shasum -a 256 engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs | awk '{print $1}')" = \
  "$(shasum -a 256 /tmp/flywheel-test-slot-2/529-terminal-observer.mjs | awk '{print $1}')"
cd /tmp/flywheel-test-slot-2
node ./529-terminal-observer.mjs \
  --state-db /tmp/flywheel-test-slot-2/teamlead.db \
  --comm-db /Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db \
  --issue FLY-1286 \
  --design-exec c552669e-611b-47fc-98ca-63371c81cbe8 \
  --implement-exec "$IMPLEMENT_EXEC" \
  --qa-exec "$QA_EXEC" \
  --socket-root /Users/xiaorongli/.flywheel/cdx-sock \
  --out /tmp/flywheel-test-slot-2/FLY-1286-terminal-observer.jsonl \
  --interval-ms 50 \
  --timeout-ms 900000
```

The external owner keeps this process supervised. Expected initial frame: both Codex phases are
present/parked with live/fresh heartbeat and live socket-holder groups, QA is present, TURN is QA,
and no shutdown request exists yet. Observer startup also records the allowlisted absolute paths and
proves both SQLite handles are `-readonly`/`query_only`. The process executable and cwd are now both
under `/tmp/flywheel-test-slot-2`, so later disposable-worktree removal cannot invalidate them.

- [ ] **Step 3: QA emits PASS and opens approve gate only after observer confirmation**

QA commits/pushes its evidence, emits `qa-result --status pass`, then follows its mandatory
`approve_to_ship --no-block` + `complete --route needs_review` + `park` flow. Head must not move after
this binding.

### Task 9: External terminal closeout and FINAL PASS

**Files:**

- Runtime read: `/tmp/flywheel-test-slot-2/FLY-1286-terminal-observer.jsonl`
- Final production-branch update:
  `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`

- [ ] **Step 1: Let the authorized ship workflow reach issue terminal**

No phase self-merges. Follow verified approval and the project deploy workflow only. The observer must
remain alive throughout closeout.

- [ ] **Step 2: Require the observer verdict**

For the planned live/fresh chain, expected ordered evidence for Design and Implement is:

```text
present/parked → shutdown requested → shutdown acked → lifecycle rows absent/process dead
```

If 50ms sampling misses only the ack frame, accept `graceful_corroborated` only when a durable
`session_events` `lead_close_runner` row carries the exact observed
`payload.phaseShutdownRequestId`; the event is written only after graceful ack + target-gone
confirmation. No matching id means no corroboration.

If the controller was already proven target-gone/dead or heartbeat-stale before the shutdown
decision, classify the no-handshake outcome as `direct_proven` with the exact evidence frames. Do not
call it a graceful PASS and do not call it a protocol defect merely because requested/acked are
absent. Because this issue explicitly injects the handshake E2E, `direct_proven` means
`rerunRequired:true` and cannot produce FINAL PASS. Indeterminate liveness is fail-closed.

Also require QA successful-chain session/process absent and `three_stage_turn` for FLY-1286 absent.
The old blocked/terminated preflight rows may remain and must be labeled as non-chain history.

- [ ] **Step 3: Audit no orphan resources**

Using manifest tmux targets, socket paths, shim/PGIDs, state paths and session ids, require:

- each Design/Implement control socket rejects a bounded connection;
- `lsof -t -- <socket>` reports no holder; missing/unreadable `lsof` is indeterminate, not PASS;
- saved shim/group pids are gone as corroboration, never as the primary app-server oracle;
- Design/Implement/QA tmux targets gone;
- successful-chain StateStore and CommDB session rows gone;
- successful-chain phaseHold/session files removed or no longer live-owned;
- TURN row gone;
- no second live phase execution for FLY-1286.

- [ ] **Step 4: Write the final FLY-1269 QA report**

The FLY-1269 closing session copies the observer trace summary, exact ids/SHA/timestamps, phase
evidence matrix, PASS/FAIL per A1–A8, known preflight noise, and raw evidence path into
`engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md` on the real FLY-1269 branch.

FINAL PASS is allowed only when A1–A8 all have direct evidence. For A7, that means captured
requested→acked or a captured request with same-id durable graceful-close corroboration; a correctly
classified `direct_proven` path is not blamed as a candidate defect but requires an E2E rerun. A live
socket/holder, live/fresh controller with uncorroborated missing handshake, wrong vendor/model/effort,
identity drift, indeterminate probe, or observer timeout is FINAL FAIL and blocks FLY-1269 ship.

- [ ] **Step 5: Report completion through the Lead channel**

Send one self-contained DONE report with final SHA(s), sandbox PR URL, production PR #604 reference,
observer verdict/path, and A1–A8 matrix. Terminal output alone is not a report.

## Stop Conditions

Stop immediately and report FAIL without broadening scope when any of these occurs:

1. TURN is not owned by the acting phase;
2. a target path/database/repo is outside test-slot-2 or qa-sandbox;
3. Design/Implement execution or thread/goal identity changes unexpectedly;
4. hold tokens/time advance, phaseHold disappears, or goal is active while no wake is running;
5. crash preconditions are not all true or recovery exceeds 120 seconds;
6. wake source binding is absent/wrong or stable-id bookkeeping does not finish;
7. Implement argv/TUI does not prove xhigh;
8. QA is not Opus;
9. observer is not armed before terminal approval;
10. a live/fresh shutdown request/ack is missing, out of order, failed, or lacks same-id durable
    corroboration; a proven direct path is classified + rerun rather than misreported;
11. a terminal socket remains connectable, `lsof` reports a holder, or liveness is indeterminate;
12. any production source/config change appears in this E2E branch;
13. any write escapes the explicit per-exec/gate/test-slot-2/qa-sandbox allowlist.
