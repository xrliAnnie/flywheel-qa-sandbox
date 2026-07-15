# FLY-1286 Codex Resident Three-Stage 529 E2E Implementation Plan

> **For Flywheel phases:** Execute through the existing Design → Implement → QA controllers on the shared branch. Do not dispatch subagents, do not add production behavior, and do not substitute static tests for the real-machine evidence gates below.

**Goal:** 在 test-slot-2 以修复后的 fresh root 真实跑通并证明 Design=Codex → Implement=Codex xhigh → QA=Opus，同时验证 Codex phase 的 paused hold、预算冻结、mailbox wake、daemon crash recovery、TURN 交接与 issue-terminal cooperative shutdown。

**Architecture:** 真实 phase chain 是被测系统；StateStore、CommDB、Codex session state、native goal DB、tmux/app-server 构成多平面证据。Implement 对 parked Design 做一次有前置保护的 daemon crash 与一次 Lead-routed mailbox wake；QA 独立复核；issue 外的 FLY-1269 收尾会话在终态前启动 observer，捕获会被 cleanup 删除的 shutdown request/ack 窗口。

**Tech Stack:** TypeScript/Node.js, pnpm, Vitest, SQLite/`sqlite3`, jq, tmux, Flywheel Comm CLI, Codex app-server native goals, qa-sandbox GitHub remote.

---

## Constraints

- 以下 mutable-scope 约束适用于 FLY-1286 的 Design/Implement/QA phase。Task 9 是 issue 外
  FLY-1269 closing session 的 terminal closeout，不授权任一 phase agent 写 production
  branch；其 Step 4–5 只能由该 external owner 在自己的 authority/worktree 下执行。
- Mutable scope 仅限以下显式 allowlist：
  - `/tmp/flywheel-test-slot-2/**`
  - `/Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db*`
  - successful FLY-1286 exec 的
    `$CODEX_SESSION_ROOT/<exec>/**`，其中 root 从 `FLYWHEEL_CODEX_SESSION_DIR` 解析，
    未设置时才使用 `/Users/xiaorongli/.flywheel/state/codex-sessions`
  - successful FLY-1286 exec 的
    `$CODEX_HOMES_ROOT/<exec>/**`，其中 root 从 `FLYWHEEL_CODEX_HOMES_ROOT` 解析，
    未设置时才使用 `/Users/xiaorongli/.flywheel/codex-homes`
  - execution hash 对应的
    `$CODEX_SOCKET_ROOT/<sha1(exec)[0:16]>.sock*`，其中 root 从
    `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` 解析，未设置时才使用
    `/Users/xiaorongli/.flywheel/cdx-sock`
  - 本次 gate/review round 的
    `/Users/xiaorongli/.flywheel/state/codex-gates/<question>.json` 与
    `/Users/xiaorongli/.flywheel/state/review-requests/<request>.json`
  - `xrliAnnie/flywheel-qa-sandbox` 的 `flywheel-FLY-1269` branch/PR
- 不得把上述 execution-private protocol state 误报为 production mutation；同时不得写其他
  project CommDB、其他 execution state、production repo/branch。
- 不修改 `packages/**` production source；candidate defect 必须 FAIL 回 FLY-1269 修。
- 所有 phase 在触碰 worktree 前运行本次 prompt 给出的 `turn --exec-id`，只接受 `yours`。
- successful chain root 固定为 Design execution
  `464064c0-a711-4aa7-9426-5633dcef590d`；旧 Design `c552669e-…` / Implement
  `e854cc74-…` 的 A2 FAIL 链与更早 blocked/terminated attempts 只进 `priorAttempts`。
- production runtime candidate 固定为 PR #604 head `cad61a078`，其中 parked-boundary fix
  为 `7d20e4a76`；shared evidence rerun baseline 固定为 `ec78d792`。
- 缺少任一 acceptance oracle 的权威证据即 FAIL；不得用 stage label、自报、旧 unit test、
  issue title 或单一 screenshot 补洞。
- Design/Implement 不得在 phase handoff 后自行关闭；它们必须 park 到 issue terminal。

## Deliverables

**Design process docs:**

- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/exploration.md`
- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/research.md`
- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/plan.md`
- `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/progress.md`

**FLY-1269 E2E evidence（已由首次链创建，本次只更新/复用）:**

- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`
- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`
- Reuse: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs`
- Test: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs`
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
  --exec-id 464064c0-a711-4aa7-9426-5633dcef590d \
  --no-block \
  "Review the FLY-1286 529 real-machine E2E plan for evidence completeness, isolation, crash/wake safety, and terminal shutdown observability")
QUESTION_ID=$(printf '%s' "$GATE_JSON" | jq -er .questionId)

REQUEST_JSON=$(node "$FLYWHEEL_COMM_CLI" request-review \
  --type design \
  --question-id "$QUESTION_ID" \
  --plan engineering/doc/FLY-1286-codex-phase-keepalive-e2e/plan.md)
REQUEST_ID=$(printf '%s' "$REQUEST_JSON" | jq -er .requestId)
```

Freeze the reviewed plan while this round is pending. Poll and parse the structured envelope:

```bash
CHECK_JSON=$(node "$FLYWHEEL_COMM_CLI" check "$QUESTION_ID" --json)
test "$(printf '%s' "$CHECK_JSON" | jq -r .status)" = answered
RESPONSE=$(printf '%s' "$CHECK_JSON" | jq -er '.content | fromjson')
test "$(printf '%s' "$RESPONSE" | jq -r .requestId)" = "$REQUEST_ID"
VERDICT=$(printf '%s' "$RESPONSE" | jq -r .reviewVerdict)
case "$VERDICT" in
  APPROVED) ;;
  CHANGES_REQUESTED) exit 3 ;;
  SKIPPED) exit 4 ;;
  *) exit 5 ;;
esac
ROUND=$(printf '%s' "$RESPONSE" | jq -er .round)
REVIEW_JOB=$(sqlite3 -readonly -json /tmp/flywheel-test-slot-2/teamlead.db \
  "PRAGMA query_only=1; SELECT request_id,review_type,round,target_path,frozen_head_sha,status FROM codex_review_job WHERE request_id='$REQUEST_ID';")
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].request_id')" = "$REQUEST_ID"
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].review_type')" = design
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].round')" = "$ROUND"
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].target_path')" = \
  engineering/doc/FLY-1286-codex-phase-keepalive-e2e/plan.md
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].frozen_head_sha')" = null
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].status')" = done
```

Expected: exact `APPROVED` for this request id. A Design review does not carry a frozen head SHA;
its binding is the request id plus the unchanged plan. On `CHANGES_REQUESTED`, edit docs only, open
a new question/request, and repeat. `SKIPPED`, unknown/malformed content, or a changed plan is FAIL.

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
  --exec-id 464064c0-a711-4aa7-9426-5633dcef590d \
  --reason "three-stage design parked until ship"
```

Expected: phase controller remains alive; this Design turn ends without implement/PR/ship work.

### Task 2: Implement bootstrap, runtime attestation, and observer regression

**Files:**

- Test: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs`
- Read: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs`
- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json`
- Modify: `engineering/doc/FLY-1269-codex-phase-keepalive/qa-report.md`

- [ ] **Step 1: Acquire Implement TURN and pin safe paths**

Run `turn` first with the Implement execution id from its environment. Then:

```bash
export STATE_DB=/tmp/flywheel-test-slot-2/teamlead.db
export COMM_DB=/Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db
export DESIGN_EXEC=464064c0-a711-4aa7-9426-5633dcef590d
export PINNED_CANDIDATE_SHA=cad61a07894a98d808aea5b948830f12cfdcff83
export CODEX_SESSION_ROOT="${FLYWHEEL_CODEX_SESSION_DIR:-/Users/xiaorongli/.flywheel/state/codex-sessions}"
export CODEX_HOMES_ROOT="${FLYWHEEL_CODEX_HOMES_ROOT:-/Users/xiaorongli/.flywheel/codex-homes}"
export CODEX_SOCKET_ROOT="${FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT:-/Users/xiaorongli/.flywheel/cdx-sock}"
export DESIGN_STATE="$CODEX_SESSION_ROOT/$DESIGN_EXEC/session.json"
export DESIGN_HOME="$CODEX_HOMES_ROOT/$DESIGN_EXEC"
export DESIGN_EPOCH=$(sqlite3 -readonly "$COMM_DB" \
  "PRAGMA query_only=1; SELECT epoch FROM turn_source_history WHERE issue_id='FLY-1286' AND to_role='design' AND source_event_id='turn:spawn:$DESIGN_EXEC' ORDER BY id DESC LIMIT 1;")
export IMPLEMENT_EPOCH=$(sqlite3 -readonly "$COMM_DB" \
  "PRAGMA query_only=1; SELECT epoch FROM three_stage_turn WHERE issue_id='FLY-1286' AND holder_exec_id='$FLYWHEEL_EXEC_ID' AND phase='implement';")
test "$DESIGN_EPOCH" -ge 1
test "$IMPLEMENT_EPOCH" -gt "$DESIGN_EPOCH"
test -f "$DESIGN_STATE"
test -d "$DESIGN_HOME"
test -d "$CODEX_SOCKET_ROOT"
test "$(gh repo view --json nameWithOwner -q .nameWithOwner)" = xrliAnnie/flywheel-qa-sandbox
test "$FLYWHEEL_ISSUE_ID" = FLY-1286
```

Expected: all tests exit 0. Record both captured epochs in the successful-chain manifest. They are
relative chain evidence, not globally fixed numbers. Any path/project mismatch stops the E2E before
mutation.

- [ ] **Step 2: Prove the current listener loaded the fixed candidate**

Read current listener cwd with `lsof`, fetch `/health`, and record source/dist mtimes plus content:

```bash
HEALTH=$(curl -fsS http://127.0.0.1:19872/health)
printf '%s' "$HEALTH" | jq -e '.ok == true and .uptime > 0'
LISTENER_PID=$(lsof -nP -t -iTCP:19872 -sTCP:LISTEN)
test -n "$LISTENER_PID"
test "$(lsof -a -p "$LISTENER_PID" -d cwd -Fn | sed -n 's/^n//p')" = \
  /Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269
NOW_S=$(date +%s)
UPTIME_S=$(printf '%s' "$HEALTH" | jq -r .uptime)
START_S=$(node -e 'process.stdout.write(String(Math.floor(Number(process.argv[1])-Number(process.argv[2]))))' \
  "$NOW_S" "$UPTIME_S")
SRC_MTIME=$(stat -f %m \
  /Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269/packages/claude-runner/src/codex-daemon-client.ts)
DIST_MTIME=$(stat -f %m \
  /Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269/packages/claude-runner/dist/codex-daemon-client.js)
test "$START_S" -ge "$SRC_MTIME"
test "$START_S" -ge "$DIST_MTIME"
stat -f '%m %N' \
  /Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269/packages/claude-runner/src/codex-daemon-client.ts \
  /Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269/packages/claude-runner/dist/codex-daemon-client.js
export CANDIDATE_ROOT=/Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269
export CANDIDATE_DIST="$CANDIDATE_ROOT/packages/claude-runner/dist/codex-daemon-client.js"
node - "$CANDIDATE_DIST" <<'NODE'
const { readFileSync } = require("node:fs");
const source = readFileSync(process.argv[2], "utf8");
const boundaries = [...source.matchAll(/observeBoundary\(\)/g)].map((match) => match.index);
const branchIsPresent = boundaries.some((start) => {
  const branch = source.slice(start, start + 800);
  const parked = branch.indexOf('kind === "parked"');
  const hold = branch.indexOf("await enterPhaseHold()", parked);
  return parked >= 0 && hold > parked;
});
if (!branchIsPresent) process.exit(1);
NODE
PROD_HEAD=$(gh pr view 604 --repo xrliAnnie/flywheel --json headRefOid -q .headRefOid)
test "$PROD_HEAD" = "$PINNED_CANDIDATE_SHA"
test "$(git -C "$CANDIDATE_ROOT" rev-parse HEAD)" = "$PINNED_CANDIDATE_SHA"
git -C "$CANDIDATE_ROOT" merge-base --is-ancestor \
  7d20e4a76d718efd6d6fbb440dec2dd8bdf66c6d "$PINNED_CANDIDATE_SHA"
```

Expected: listener cwd is the FLY-1269 QA worktree; its estimated start time from health uptime is
later than both artifact mtimes; the bounded semantic check finds `observeBoundary()` followed by a
`parked` branch and then `enterPhaseHold()` in the same compiled control-flow neighborhood. Design
preflight already verified this shape against the pinned candidate dist; the run repeats it rather
than betting on one exact TypeScript expression form. Production PR #604 and the candidate worktree
must both still equal the manifest's pinned SHA, which must descend from `7d20e4a76`. A stale
`bridge.log` boot line is not accepted as current-process evidence, and refreshing the candidate
worktree after this attestation invalidates the run.

- [ ] **Step 3: Re-run the already-built observer tests**

The previous failed chain already created the observer under TDD. Do not rewrite it during this
no-production-change rerun. Run:

```bash
node --check \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.mjs
node --test \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs
```

Expected: syntax passes and all 9 tests pass. Any failure stops the live rerun until the observer is
fixed on FLY-1269 and reviewed; do not weaken assertions in the sandbox branch.

- [ ] **Step 4: Initialize the fresh manifest and validate real read-only `--once` mode**

Move the immutable old chain under `priorAttempts`, set `successfulChain.design.executionId` to
`464064c0-a711-4aa7-9426-5633dcef590d`, and leave Implement/QA ids empty until their real spawn.
Preserve every top-level field not shown below. Use `apply_patch` so the semantic delta is reviewable;
the resulting fields must have this minimum shape. In the same patch, write the captured numeric
`$DESIGN_EPOCH` to `successfulChain.design.turnEpoch`; when Implement is registered, write captured
numeric `$IMPLEMENT_EPOCH` to `successfulChain.implement.turnEpoch`. Never copy an expected literal
epoch from this document:

```json
{
  "candidateSha": "cad61a07894a98d808aea5b948830f12cfdcff83",
  "priorAttempts": [
    {
      "kind": "a2_failed_chain",
      "evidenceCommit": "ec78d79239f3cb61916f876f58855dcfccb89679",
      "designExecutionId": "c552669e-611b-47fc-98ca-63371c81cbe8",
      "implementExecutionId": "e854cc74-39dc-4c75-b78b-d2e220a08cbe",
      "failedOracle": "A2"
    }
  ],
  "successfulChain": {
    "design": {
      "executionId": "464064c0-a711-4aa7-9426-5633dcef590d",
      "threadId": "019f654c-e651-71c2-9ab9-c4e68bcdcfd5",
      "goalId": "d05c8f51-0db3-4029-982d-d293e4347044",
      "adapterType": "codex-tmux",
      "model": "gpt-5.6-sol"
    },
    "implement": null,
    "qa": null
  },
  "verdict": {
    "status": "IN_PROGRESS",
    "pendingOracles": ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]
  }
}
```

Then run:

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
  --socket-root "$CODEX_SOCKET_ROOT" \
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
the current Implement exec at captured `$IMPLEMENT_EPOCH`, tmux target live, control socket
connectable, and heartbeat advancing. The handoff
event and native goal completion are not ordered, so an early missing `phaseHold` is “not ready yet”,
not an immediate FAIL. Timeout or identity drift is FAIL.

After the bounded wait succeeds, capture:

```bash
export DESIGN_THREAD=$(jq -r .threadId "$DESIGN_STATE")
export DESIGN_PID=$(jq -r .daemonPid "$DESIGN_STATE")
export DESIGN_GOAL_DB=$DESIGN_HOME/goals_1.sqlite
export DESIGN_SOCKET_HASH=$(node -e 'const {createHash}=require("node:crypto");process.stdout.write(createHash("sha1").update(process.argv[1]).digest("hex").slice(0,16))' "$DESIGN_EXEC")
export DESIGN_SOCKET="$CODEX_SOCKET_ROOT/$DESIGN_SOCKET_HASH.sock"
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
- current TURN is Implement / captured `$IMPLEMENT_EPOCH` / current Implement exec, and that epoch
  is strictly greater than `$DESIGN_EPOCH`.

- [ ] **Step 2: Capture two samples at least 60 seconds apart**

Poll every 5 seconds for 13 iterations; append JSON snapshots to the chain evidence. Compare first
and last sample. Expected:

- heartbeat advances;
- goal id/status/token_budget/tokens_used/time_used_seconds/updated_at_ms unchanged;
- `phaseHold.enteredAt`, `deadlineRemainingMs`, `hardDeadlineRemainingMs` unchanged;
- shim pid/process group, socket holder group, and Design execution/thread unchanged;
- TURN remains Implement at the captured `$IMPLEMENT_EPOCH`.

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
- TURN stays Implement at the captured `$IMPLEMENT_EPOCH`;
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
FLY-1286 E2E action: please send one instruction to Design execution 464064c0-a711-4aa7-9426-5633dcef590d with this content: FLY-1286 WAKE_PROBE — run TURN first, do not touch the worktree, report the current holder, then re-park; if this stable instruction is redelivered, report only and do not repeat side effects. Please reply with the CommDB instruction id.
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
WHERE execution_id = '464064c0-a711-4aa7-9426-5633dcef590d'
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
git diff --name-only ec78d79239f3cb61916f876f58855dcfccb89679 HEAD
git status --short
```

Expected: changes are limited to the FLY-1286 Design docs and FLY-1269 qa/evidence files. Any
`packages/**`, runtime config, workflow, or production script change fails scope.

- [ ] **Step 2: Run observer tests and candidate regression tests**

```bash
node --test engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs
CANDIDATE_ROOT=/Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269
PINNED_CANDIDATE_SHA=cad61a07894a98d808aea5b948830f12cfdcff83
PROD_HEAD=$(gh pr view 604 --repo xrliAnnie/flywheel --json headRefOid -q .headRefOid)
test "$PROD_HEAD" = "$PINNED_CANDIDATE_SHA"
test "$(git -C "$CANDIDATE_ROOT" rev-parse HEAD)" = "$PINNED_CANDIDATE_SHA"
pnpm -C "$CANDIDATE_ROOT" --filter flywheel-claude-runner exec vitest run \
  test/codex-phase-lifecycle.test.ts \
  test/codex-daemon-client.test.ts \
  test/codex-daemon-goal-runtime.test.ts
pnpm -C "$CANDIDATE_ROOT" --filter flywheel-config exec vitest run \
  src/__tests__/three-stage-phases.test.ts
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
`request-review --type code` flow, retaining its `QUESTION_ID` and `REQUEST_ID`. Poll with
`check "$QUESTION_ID" --json`, require `.status == "answered"`, decode `.content | fromjson`, and
require its `.requestId == $REQUEST_ID`. The payload has no head field; query the head binding from
the authoritative StateStore job row. The only passing result is:

```bash
CHECK_JSON=$(node "$FLYWHEEL_COMM_CLI" check "$QUESTION_ID" --json)
test "$(printf '%s' "$CHECK_JSON" | jq -r .status)" = answered
RESPONSE=$(printf '%s' "$CHECK_JSON" | jq -er '.content | fromjson')
test "$(printf '%s' "$RESPONSE" | jq -r .requestId)" = "$REQUEST_ID"
test "$(printf '%s' "$RESPONSE" | jq -r .reviewVerdict)" = APPROVED
STATE_DB=${STATE_DB:-/tmp/flywheel-test-slot-2/teamlead.db}
REVIEW_JOB=$(sqlite3 -readonly -json "$STATE_DB" \
  "PRAGMA query_only=1; SELECT request_id,review_type,frozen_head_sha,status FROM codex_review_job WHERE request_id='$REQUEST_ID';")
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].request_id')" = "$REQUEST_ID"
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].review_type')" = code
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].status')" = done
test "$(printf '%s' "$REVIEW_JOB" | jq -r '.[0].frozen_head_sha')" = "$(git rev-parse HEAD)"
```

Expected reviewer family: Claude, exact verdict `APPROVED`, and reviewed head equal to the current
head. On `CHANGES_REQUESTED`, fix evidence/harness only, push, and open a new question/request.
`SKIPPED`, unknown/malformed content, registration failure, or head mismatch is FAIL.

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

```bash
export STATE_DB="${STATE_DB:-/tmp/flywheel-test-slot-2/teamlead.db}"
export COMM_DB="${COMM_DB:-/Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db}"
export CODEX_SESSION_ROOT="${FLYWHEEL_CODEX_SESSION_DIR:-/Users/xiaorongli/.flywheel/state/codex-sessions}"
export CODEX_HOMES_ROOT="${FLYWHEEL_CODEX_HOMES_ROOT:-/Users/xiaorongli/.flywheel/codex-homes}"
export CODEX_SOCKET_ROOT="${FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT:-/Users/xiaorongli/.flywheel/cdx-sock}"
export IMPLEMENT_EPOCH=$(jq -er .successfulChain.implement.turnEpoch \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-e2e-chain.json)
export QA_EPOCH=$(sqlite3 -readonly "$COMM_DB" \
  "PRAGMA query_only=1; SELECT epoch FROM three_stage_turn WHERE issue_id='FLY-1286' AND holder_exec_id='$FLYWHEEL_EXEC_ID' AND phase='qa';")
test "$QA_EPOCH" -gt "$IMPLEMENT_EPOCH"
```

- `adapter_type=claude-tmux`
- `chat_thread_role=qa`
- `runner_model=claude-opus-4-8`
- current TURN holder is QA exec, phase `qa`, at captured `$QA_EPOCH`; it remains unchanged during
  QA verification and is strictly greater than the captured Implement epoch

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
oracle rows from research.md. Confirm current git diff from rerun baseline `ec78d792` contains only Design docs and
FLY-1269 qa/evidence files. Also compare the pre-run/post-run runtime path inventory: every changed
path must be one of the manifest's exact successful exec session/CODEX_HOME/socket paths, this
round's gate/review marker, test-slot-2 CommDB, or `/tmp/flywheel-test-slot-2/**`. Any other project
CommDB, execution state, or production repo/branch path is A8 FAIL. Do not infer a system-global
filesystem diff from concurrent unrelated Flywheel activity; each allowed path must be positively
bound to this issue/exec/question/request id.

- [ ] **Step 5: Run full narrow regression set**

```bash
node --test engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs
CANDIDATE_ROOT=/Users/xiaorongli/Dev/flywheel-FLY-1269/worktrees/qa-e2e-1269
PINNED_CANDIDATE_SHA=cad61a07894a98d808aea5b948830f12cfdcff83
PROD_HEAD=$(gh pr view 604 --repo xrliAnnie/flywheel --json headRefOid -q .headRefOid)
test "$PROD_HEAD" = "$PINNED_CANDIDATE_SHA"
test "$(git -C "$CANDIDATE_ROOT" rev-parse HEAD)" = "$PINNED_CANDIDATE_SHA"
pnpm -C "$CANDIDATE_ROOT" --filter flywheel-claude-runner exec vitest run \
  test/codex-phase-lifecycle.test.ts \
  test/codex-daemon-client.test.ts \
  test/codex-daemon-goal-runtime.test.ts
pnpm -C "$CANDIDATE_ROOT" --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/codex-phase-shutdown.test.ts \
  src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts \
  src/bridge/__tests__/phase-orchestrator.fly939-wake-not-respawn.test.ts \
  src/__tests__/phase-orchestrator.fly921-adversarial.test.ts
pnpm -C "$CANDIDATE_ROOT" --filter flywheel-config exec vitest run \
  src/__tests__/three-stage-phases.test.ts
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
export CODEX_SOCKET_ROOT="${FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT:-/Users/xiaorongli/.flywheel/cdx-sock}"
node ./529-terminal-observer.mjs \
  --state-db /tmp/flywheel-test-slot-2/teamlead.db \
  --comm-db /Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db \
  --issue FLY-1286 \
  --design-exec 464064c0-a711-4aa7-9426-5633dcef590d \
  --implement-exec "$IMPLEMENT_EXEC" \
  --qa-exec "$QA_EXEC" \
  --socket-root "$CODEX_SOCKET_ROOT" \
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

Task 9 is executed only by the issue-external FLY-1269 closing session after the three FLY-1286
phases have finished their evidence duties. Design/Implement/QA must not perform these production
branch/report writes; they hand the observer artifacts and Lead report to that owner.

**Files:**

- Runtime read: `/tmp/flywheel-test-slot-2/FLY-1286-terminal-observer.jsonl`
- External-owner-only final production-branch update:
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

Within the FLY-1286 Design/Implement/QA scope, stop immediately and report FAIL without broadening
scope when any of these occurs. Task 9's explicitly external production-branch write is governed by
the FLY-1269 closing session's separate authority and is not an exception available to phase agents:

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
