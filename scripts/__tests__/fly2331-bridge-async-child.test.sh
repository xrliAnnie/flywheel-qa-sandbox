#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2331-acceptance.XXXXXX")"
FAKE_BIN="$TMP_ROOT/bin"
CALL_LOG="$TMP_ROOT/git-calls.log"
PID_LOG="$TMP_ROOT/group-pids.log"
ASYNC_LOG="$TMP_ROOT/async-guard.log"
SYNC_LOG="$TMP_ROOT/sync-guard.log"
ASYNC_OUT="$TMP_ROOT/async.out"
SYNC_OUT="$TMP_ROOT/sync.out"
GROUP_OUT="$TMP_ROOT/group.out"
REAP_OUT="$TMP_ROOT/reap.out"

cleanup() {
  if [[ -n "${ARM_PID:-}" ]]; then kill -KILL "$ARM_PID" 2>/dev/null || true; fi
  if [[ -n "${WATCHDOG_PID:-}" ]]; then kill "$WATCHDOG_PID" 2>/dev/null || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$FAKE_BIN" "$TMP_ROOT/state" "$TMP_ROOT/syncop"
cat > "$FAKE_BIN/git" <<'FAKE_GIT'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FLY2331_CALL_LOG"
if [ "${FLY2331_GROUP_FIXTURE:-0}" = "1" ]; then
  printf '%s\n' "$$" > "$FLY2331_PID_LOG"
  /bin/sleep 30 &
  printf '%s\n' "$!" >> "$FLY2331_PID_LOG"
  wait
fi
/bin/sleep "${FLY2331_SLEEP_SECONDS:-70}"
printf 'fake-git-complete\n'
FAKE_GIT
chmod +x "$FAKE_BIN/git"

export FLYWHEEL_STATE_DIR="$TMP_ROOT/state"
export FLYWHEEL_BRIDGE_SYNCOP_DIR="$TMP_ROOT/syncop"
export FLY2331_CALL_LOG="$CALL_LOG"
export FLY2331_PID_LOG="$PID_LOG"
unset FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS
unset FLYWHEEL_BRIDGE_LOOP_GUARD_HEARTBEAT_MS
unset FLYWHEEL_BRIDGE_LOOP_GUARD_CHECK_MS
unset FLYWHEEL_BRIDGE_LOOP_GUARD_LOG

cd "$REPO_ROOT"
if ! pnpm --filter flywheel-claude-runner build >"$TMP_ROOT/runner-build.log" 2>&1; then
  cat "$TMP_ROOT/runner-build.log" >&2
  exit 1
fi
if ! pnpm --filter flywheel-teamlead build >"$TMP_ROOT/teamlead-build.log" 2>&1; then
  cat "$TMP_ROOT/teamlead-build.log" >&2
  exit 1
fi
export PATH="$FAKE_BIN:$PATH"

run_bounded() {
  local limit="$1"
  local output="$2"
  shift 2
  "$@" >"$output" 2>&1 &
  ARM_PID=$!
  node -e '
const pid = Number(process.argv[1]);
const delayMs = Number(process.argv[2]);
setTimeout(() => {
  try { process.kill(pid, "SIGKILL"); } catch {}
}, delayMs);
' "$ARM_PID" "$((limit * 1000))" &
  WATCHDOG_PID=$!
  set +e
  wait "$ARM_PID"
  ARM_STATUS=$?
  set -e
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  ARM_PID=""
  WATCHDOG_PID=""
}

START_SECONDS=$SECONDS
export FLY2331_SLEEP_SECONDS="${FLY2331_ACCEPTANCE_SLEEP_SECONDS:-70}"
MIN_HEARTBEATS="${FLY2331_MIN_HEARTBEATS:-60}"
run_bounded 90 "$ASYNC_OUT" node scripts/fixtures/fly2331-guard-arm.mjs async "$ASYNC_LOG"
if [[ "$ARM_STATUS" -ne 0 ]]; then
  echo "async arm failed with status $ARM_STATUS" >&2
  cat "$ASYNC_OUT" >&2
  exit 1
fi
grep -q '"mode":"async"' "$ASYNC_OUT"
grep -q '"child":"fake-git-complete"' "$ASYNC_OUT"
ASYNC_HEARTBEATS="$(sed -n 's/.*"heartbeats":\([0-9][0-9]*\).*/\1/p' "$ASYNC_OUT")"
if [[ -z "$ASYNC_HEARTBEATS" || "$ASYNC_HEARTBEATS" -lt "$MIN_HEARTBEATS" ]]; then
  echo "async arm heartbeat denominator too small: ${ASYNC_HEARTBEATS:-missing}" >&2
  exit 1
fi
if [[ -s "$ASYNC_LOG" ]] && grep -q 'bridge_event_loop_stall' "$ASYNC_LOG"; then
  echo "async arm triggered the loop guard" >&2
  cat "$ASYNC_LOG" >&2
  exit 1
fi
grep -q 'worktree add fake-target' "$CALL_LOG"
ASYNC_SECONDS=$((SECONDS - START_SECONDS))

: > "$CALL_LOG"
START_SECONDS=$SECONDS
run_bounded 80 "$SYNC_OUT" node scripts/fixtures/fly2331-guard-arm.mjs sync "$SYNC_LOG"
if [[ "$ARM_STATUS" -ne 0 ]]; then
  echo "sync observation arm failed to survive: status $ARM_STATUS" >&2
  cat "$SYNC_OUT" >&2
  exit 1
fi
grep -q '"mode":"sync"' "$SYNC_OUT"
grep -q '"child":"fake-git-complete"' "$SYNC_OUT"
SYNC_HEARTBEATS="$(sed -n 's/.*"heartbeats":\([0-9][0-9]*\).*/\1/p' "$SYNC_OUT")"
if [[ "$SYNC_HEARTBEATS" != "0" ]]; then
  echo "sync arm unexpectedly remained responsive: ${SYNC_HEARTBEATS:-missing}" >&2
  exit 1
fi
node --input-type=module - "$SYNC_LOG" <<'CHECK_SYNC'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const records = readFileSync(process.argv[2], "utf8").trim().split("\n").map((line) => JSON.parse(line));
assert.deepEqual(records.map((record) => record.event), ["bridge_event_loop_stall", "stall_recovered_after_freeze"]);
assert.equal(records[1].recovered_via, "heartbeat");
assert.equal(records[0].pid, records[1].pid);
assert.equal(records[0].bootTs, records[1].bootTs);
assert.ok(records[0].stall_age_ms > records[0].threshold_ms);
CHECK_SYNC
grep -q 'worktree add fake-target' "$CALL_LOG"
SYNC_SECONDS=$((SECONDS - START_SECONDS))

export FLY2331_GROUP_FIXTURE=1
export FLY2331_SLEEP_SECONDS=0
run_bounded 10 "$GROUP_OUT" node scripts/fixtures/fly2331-guard-arm.mjs group "$TMP_ROOT/group-guard.log"
unset FLY2331_GROUP_FIXTURE
if [[ "$ARM_STATUS" -ne 0 ]] || ! grep -q '"mode":"group"' "$GROUP_OUT"; then
  echo "process-group arm failed" >&2
  cat "$GROUP_OUT" >&2
  exit 1
fi

run_bounded 10 "$REAP_OUT" node scripts/fixtures/fly2331-guard-arm.mjs reap "$TMP_ROOT/reap-guard.log"
if [[ "$ARM_STATUS" -ne 0 ]] || ! grep -q '"exitObserved":true,"absent":true' "$REAP_OUT"; then
  echo "detached reap arm failed" >&2
  cat "$REAP_OUT" >&2
  exit 1
fi

printf 'PASS fly2331 async=%ss sync-observed=%ss async-heartbeats=%s sync-heartbeats=0 evidence=stall+recovery group=2/2 reap=1/1\n' \
  "$ASYNC_SECONDS" "$SYNC_SECONDS" "$ASYNC_HEARTBEATS"
