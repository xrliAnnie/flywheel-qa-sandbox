#!/bin/bash
# FLY-1482: cross-script lock, claim-fence, and timezone contracts.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEARDOWN="$ROOT/scripts/test-teardown.sh"
WATCHER="$ROOT/scripts/flywheel-cmux-sync.sh"
TMP_ROOT=$(mktemp -d)
BIN_DIR="$TMP_ROOT/bin"
LEASE="$TMP_ROOT/cmux-mutator.lock"
MARKER="$TMP_ROOT/cmux-maintenance"
CLAIM="${MARKER}.qa-teardown"
HOLDER_PID=""
FENCE_PARENT_PID=""
FENCE_CHILD_PID=""
PASS=0
FAIL=0

cleanup() {
  for pid in "$HOLDER_PID" "$FENCE_PARENT_PID" "$FENCE_CHILD_PID"; do
    [[ -n "$pid" ]] || continue
    kill -KILL "$pid" 2>/dev/null || true
  done
  wait "$HOLDER_PID" 2>/dev/null || true
  wait "$FENCE_PARENT_PID" 2>/dev/null || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

mkdir -p "$BIN_DIR" "$TMP_ROOT/home/.flywheel"

# Empty process census, but timezone-sensitive lstart output. Production code
# must force TZ=UTC/LC_ALL=C, so ambient TZ never changes the persisted value.
printf '%s\n' '#!/bin/bash' \
  'if [[ "$*" == *"-axo pid=,ppid=,command="* ]]; then exit 0; fi' \
  'if [[ "$*" == *"lstart="* ]]; then' \
  '  case "${TZ:-unset}" in' \
  '    UTC) printf "  Sat Aug  1 16:45:06 2026  \\n" ;;' \
  '    Asia/Tokyo) printf "Sun Aug  2 01:45:06 2026\\n" ;;' \
  '    *) printf "Sat Aug  1 10:45:06 2026\\n" ;;' \
  '  esac' \
  'fi' > "$BIN_DIR/ps"
printf '%s\n' '#!/bin/bash' \
  'if [[ "$*" == *"#{pid}"* ]]; then echo 4242; exit 0; fi' \
  'if [[ "$*" == *"#{socket_path}"* ]]; then echo /tmp/fly1482-test.sock; exit 0; fi' \
  'exit 1' > "$BIN_DIR/tmux"
chmod +x "$BIN_DIR/ps" "$BIN_DIR/tmux"

export HOME="$TMP_ROOT/home"
export PATH="$BIN_DIR:$PATH"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$LEASE"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$MARKER"
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="lease-contract-incarnation"
export FLYWHEEL_CMUX_ALERT_BIN=/usr/bin/true

reset_lock() {
  rm -rf "$LEASE" "${LEASE}.reap" "$CLAIM" "$MARKER"
  HOLDER_PID=""
}

wait_for_file() {
  local file="$1"
  for _ in $(seq 1 50); do
    [[ -e "$file" ]] && return 0
    sleep 0.1
  done
  return 1
}

echo "Test: FLY-1482 reap mutex is one retained advisory-lock file across both scripts"
reset_lock
ready="$TMP_ROOT/teardown-holder.ready"
/bin/bash -c '
  source "$1"
  cmux_acquire_reap_mutex
  : > "$2"
  sleep 10
' _ "$TEARDOWN" "$ready" &
HOLDER_PID=$!
wait_for_file "$ready"
watcher_busy_rc=0
/bin/bash -c 'source "$1"; _snapshot_live_mutator_processes() { return 0; }; _acquire_reap_mutex' \
  _ "$WATCHER" >/dev/null 2>&1 || watcher_busy_rc=$?
kill -TERM "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
if [[ "$watcher_busy_rc" -eq 1 && -f "${LEASE}.reap" && ! -d "${LEASE}.reap" ]]; then
  pass "watcher sees teardown's retained-file lock as busy"
else
  fail "watcher did not share teardown mutex rc=$watcher_busy_rc shape=$(test -f "${LEASE}.reap" && echo file || echo other)"
fi

reset_lock
ready="$TMP_ROOT/watcher-holder.ready"
/bin/bash -c '
  source "$1"
  _snapshot_live_mutator_processes() { return 0; }
  _acquire_reap_mutex
  : > "$2"
  sleep 10
' _ "$WATCHER" "$ready" &
HOLDER_PID=$!
wait_for_file "$ready"
teardown_busy_rc=0
/bin/bash -c 'source "$1"; cmux_snapshot_live_mutator_processes() { return 0; }; cmux_acquire_reap_mutex' \
  _ "$TEARDOWN" >/dev/null 2>&1 || teardown_busy_rc=$?
kill -TERM "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
if [[ "$teardown_busy_rc" -eq 1 && -f "${LEASE}.reap" && ! -d "${LEASE}.reap" ]]; then
  pass "teardown sees watcher's retained-file lock as busy"
else
  fail "teardown did not share watcher mutex rc=$teardown_busy_rc"
fi

echo "Test: FLY-1482 both implementations upgrade legacy mkdir mutex and reject symlinks"
legacy_ok=1
for impl in teardown watcher; do
  reset_lock
  mkdir "${LEASE}.reap"
  rc=0
  if [[ "$impl" == "teardown" ]]; then
    /bin/bash -c 'source "$1"; cmux_snapshot_live_mutator_processes() { return 0; }; cmux_acquire_reap_mutex; cmux_release_reap_mutex' \
      _ "$TEARDOWN" >/dev/null 2>&1 || rc=$?
  else
    /bin/bash -c 'source "$1"; _snapshot_live_mutator_processes() { return 0; }; _acquire_reap_mutex; _release_reap_mutex' \
      _ "$WATCHER" >/dev/null 2>&1 || rc=$?
  fi
  [[ "$rc" -eq 0 && -f "${LEASE}.reap" && ! -d "${LEASE}.reap" ]] || legacy_ok=0

  reset_lock
  ln -s "$TMP_ROOT/foreign" "${LEASE}.reap"
  rc=0
  if [[ "$impl" == "teardown" ]]; then
    /bin/bash -c 'source "$1"; cmux_acquire_reap_mutex' _ "$TEARDOWN" >/dev/null 2>&1 || rc=$?
  else
    /bin/bash -c 'source "$1"; _acquire_reap_mutex' _ "$WATCHER" >/dev/null 2>&1 || rc=$?
  fi
  [[ "$rc" -eq 2 && -L "${LEASE}.reap" ]] || legacy_ok=0
done
if [[ "$legacy_ok" == "1" ]]; then
  pass "legacy directories converge to files; unsafe nodes stay fail-closed on both sides"
else
  fail "legacy/symlink cross-implementation contract diverged"
fi

echo "Test: FLY-1482 teardown process and tmux identities are timezone-stable"
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE=""
process_tokyo=$(TZ=Asia/Tokyo /bin/bash -c 'source "$1"; cmux_process_incarnation 4242' _ "$TEARDOWN")
process_denver=$(TZ=America/Denver /bin/bash -c 'source "$1"; cmux_process_incarnation 4242' _ "$TEARDOWN")
tmux_tokyo=$(TZ=Asia/Tokyo FLYWHEEL_CMUX_TMUX_GENERATION= /bin/bash -c 'source "$1"; cmux_tmux_generation' _ "$TEARDOWN")
tmux_denver=$(TZ=America/Denver FLYWHEEL_CMUX_TMUX_GENERATION= /bin/bash -c 'source "$1"; cmux_tmux_generation' _ "$TEARDOWN")
if [[ "$process_tokyo" == "$process_denver" && "$process_tokyo" == "Sat Aug  1 16:45:06 2026" \
    && "$tmux_tokyo" == "$tmux_denver" \
    && "$tmux_tokyo" == "/tmp/fly1482-test.sock|4242|Sat Aug  1 16:45:06 2026" ]]; then
  pass "both teardown identity reads pin UTC/C and trim only edge whitespace"
else
  fail "timezone identity drift process=[$process_tokyo]/[$process_denver] tmux=[$tmux_tokyo]/[$tmux_denver]"
fi

echo "Test: FLY-1482 watcher producer and verifier agree on right-padded macOS lstart"
reset_lock
watcher_owner_probe=$(/bin/bash -c '
  source "$1"
  acquire_rc=0; self_rc=0
  acquire_mutator_lease watch || acquire_rc=$?
  mutator_lease_owned_by_self || self_rc=$?
  printf "%s|%s|%s\n" "$acquire_rc" "$self_rc" "$([[ -d "$WATCHER_LOCK_DIR" ]] && echo present || echo absent)"
' _ "$WATCHER")
if [[ "$watcher_owner_probe" == "0|0|present" ]]; then
  pass "the production identity producer and owner reader normalize the same bytes"
else
  fail "watcher producer/reader identity mismatch probe=[$watcher_owner_probe]"
fi

echo "Test: FLY-1482 teardown retries unverifiable lease rounds within its budget"
teardown_retry_probe=$(/bin/bash -c '
  source "$1"
  tries=0
  acquire_cmux_teardown_lease_once() {
    tries=$((tries + 1))
    (( tries == 1 )) && return 2
    return 0
  }
  sleep() { :; }
  rc=0
  FLYWHEEL_QA_TEARDOWN_LEASE_WAIT_S=2 acquire_cmux_teardown_lease || rc=$?
  printf "%s|%s\n" "$rc" "$tries"
' _ "$TEARDOWN" 2>/dev/null)
if [[ "$teardown_retry_probe" == "0|2" ]]; then
  pass "a transient unverifiable census consumes one poll, not the entire teardown attempt"
else
  fail "teardown did not retry unverifiable state probe=[$teardown_retry_probe]"
fi

echo "Test: FLY-1775 a full lease timeout gets exactly one fresh acquisition attempt"
teardown_outer_retry_probe=$(/bin/bash -c '
  source "$1"
  tries=0
  acquire_cmux_teardown_lease() {
    tries=$((tries + 1))
    (( tries == 1 )) && return 1
    return 0
  }
  sleep() { :; }
  rc=0
  acquire_cmux_teardown_lease_with_retry || rc=$?
  printf "%s|%s\n" "$rc" "$tries"
' _ "$TEARDOWN" 2>/dev/null)
teardown_outer_fail_probe=$(/bin/bash -c '
  source "$1"
  tries=0
  acquire_cmux_teardown_lease() { tries=$((tries + 1)); return 1; }
  sleep() { :; }
  rc=0
  acquire_cmux_teardown_lease_with_retry || rc=$?
  printf "%s|%s\n" "$rc" "$tries"
' _ "$TEARDOWN" 2>/dev/null)
if [[ "$teardown_outer_retry_probe" == "0|2" && "$teardown_outer_fail_probe" == "1|2" ]]; then
  pass "lease timeout retries once, succeeds transiently, and never spins a third time"
else
  fail "outer lease retry contract mismatch success=[$teardown_outer_retry_probe] fail=[$teardown_outer_fail_probe]"
fi
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="lease-contract-incarnation"

echo "Test: FLY-1482 claim fence survives parent SIGKILL while foreground child lives"
reset_lock
parent_file="$TMP_ROOT/fence.parent"
child_file="$TMP_ROOT/fence.child"
ready="$TMP_ROOT/fence.ready"
/bin/bash -c '
  source "$1"
  acquire_cmux_qa_teardown_claim
  printf "%s\n" "$$" > "$2"
  sleep 4 &
  printf "%s\n" "$!" > "$3"
  : > "$4"
  wait
' _ "$TEARDOWN" "$parent_file" "$child_file" "$ready" &
FENCE_PARENT_PID=$!
wait_for_file "$ready"
FENCE_CHILD_PID=$(cat "$child_file" 2>/dev/null || true)
kill -KILL "$FENCE_PARENT_PID" 2>/dev/null || true
wait "$FENCE_PARENT_PID" 2>/dev/null || true
FENCE_PARENT_PID=""
busy_probe=$(FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="lease-contract-incarnation" \
  /bin/bash -c '
    source "$1"
    _snapshot_live_mutator_processes() { return 0; }
    first=0; second=0
    _reap_stale_qa_teardown_claim || first=$?
    _reap_stale_qa_teardown_claim || second=$?
    printf "%s|%s|%s\n" "$first" "$second" "$([[ -e "$CMUX_QA_TEARDOWN_CLAIM" ]] && echo present || echo absent)"
  ' _ "$WATCHER")
for _ in $(seq 1 60); do
  kill -0 "$FENCE_CHILD_PID" 2>/dev/null || break
  sleep 0.1
done
FENCE_CHILD_PID=""
free_probe=$(FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="lease-contract-incarnation" \
  /bin/bash -c '
    source "$1"
    _snapshot_live_mutator_processes() { return 0; }
    first=0; second=0
    _reap_stale_qa_teardown_claim || first=$?
    _reap_stale_qa_teardown_claim || second=$?
    printf "%s|%s|%s\n" "$first" "$second" "$([[ -e "$CMUX_QA_TEARDOWN_CLAIM" ]] && echo present || echo absent)"
  ' _ "$WATCHER")
if [[ "$busy_probe" == "1|1|present" && "$free_probe" == "1|0|absent" ]]; then
  pass "child-held fence prevents reap; claim is reaped only after the child exits"
else
  fail "activity fence contract mismatch busy=[$busy_probe] free=[$free_probe]"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
