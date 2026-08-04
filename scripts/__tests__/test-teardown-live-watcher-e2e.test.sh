#!/bin/bash
# FLY-1482: a live production-shaped cmux watcher must yield the shared
# mutator lease long enough for QA teardown, then reacquire it afterwards.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHER="$ROOT/scripts/flywheel-cmux-sync.sh"
TEARDOWN="$ROOT/scripts/test-teardown.sh"
TMP_ROOT=$(mktemp -d)
SLOT=14820
WATCHER_PID=""
SOCKET_PID=""
PASS=0
FAIL=0

cleanup() {
  if [[ -n "$WATCHER_PID" ]]; then
    kill -TERM "$WATCHER_PID" 2>/dev/null || true
    wait "$WATCHER_PID" 2>/dev/null || true
  fi
  if [[ -n "$SOCKET_PID" ]]; then
    kill -TERM "$SOCKET_PID" 2>/dev/null || true
    wait "$SOCKET_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT" "/tmp/flywheel-test-slot-${SLOT}" "/tmp/flywheel-test-slot-${SLOT}.lock"
}
trap cleanup EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

HOME_DIR="$TMP_ROOT/home"
BIN_DIR="$TMP_ROOT/bin"
LEASE="$TMP_ROOT/cmux-mutator.lock"
MARKER="$TMP_ROOT/cmux-maintenance"
CLAIM="${MARKER}.qa-teardown"
SOCKET="$TMP_ROOT/cmux.sock"
WATCHER_LOG="$TMP_ROOT/watcher.log"
TEARDOWN_LOG="$TMP_ROOT/teardown.log"
mkdir -p "$HOME_DIR/.flywheel" "$BIN_DIR" "$TMP_ROOT/view-wal"
printf '{"slots":[]}\n' > "$HOME_DIR/.flywheel/test-slots.json"
mkdir -p "/tmp/flywheel-test-slot-${SLOT}" "/tmp/flywheel-test-slot-${SLOT}.lock"
printf 'residue\n' > "/tmp/flywheel-test-slot-${SLOT}/bridge.pid"

# The dispatcher is real. Only its external tmux/cmux boundaries are replaced,
# keeping this test independent from the developer's production sessions.
printf '%s\n' '#!/bin/bash' \
  'case "${1:-}" in' \
  '  has-session) exit 1 ;;' \
  '  *) exit 0 ;;' \
  'esac' > "$BIN_DIR/tmux"
printf '%s\n' '#!/bin/bash' \
  'if [[ "${1:-}" == "--socket" ]]; then shift 2; fi' \
  'case "${1:-}" in' \
  '  ping) echo PONG ;;' \
  '  list-workspaces) printf '\''{"workspaces":[]}\\n'\'' ;;' \
  'esac' > "$BIN_DIR/cmux"
printf '%s\n' '#!/bin/bash' 'exit 1' > "$BIN_DIR/pgrep"
printf '%s\n' '#!/bin/bash' 'exit 1' > "$BIN_DIR/lsof"
chmod +x "$BIN_DIR/tmux" "$BIN_DIR/cmux" "$BIN_DIR/pgrep" "$BIN_DIR/lsof"

python3 -c '
import socket, sys, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
s.listen(1)
time.sleep(120)
' "$SOCKET" &
SOCKET_PID=$!
for _ in $(seq 1 50); do
  [[ -S "$SOCKET" ]] && break
  sleep 0.1
done

export HOME="$HOME_DIR"
export PATH="$BIN_DIR:$PATH"
export CMUX_SOCKET_PATH="$SOCKET"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$LEASE"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$MARKER"
export FLYWHEEL_CMUX_VIEW_WAL_DIR="$TMP_ROOT/view-wal"
export FLYWHEEL_CMUX_TMUX_GENERATION="test-generation"
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="live-watcher-e2e-incarnation"
export FLYWHEEL_CMUX_SUPERVISED=1
export FLYWHEEL_CMUX_SUPERVISED_WAIT=1
export FLYWHEEL_CMUX_MAINTENANCE_POLL_SECONDS=1
export FLYWHEEL_QA_TEARDOWN_LEASE_WAIT_S=30

/bin/bash "$WATCHER" --watch > "$WATCHER_LOG" 2>&1 &
WATCHER_PID=$!

watch_owner_ready=0
for _ in $(seq 1 100); do
  if [[ -f "$LEASE/owner" ]] && awk -F'|' '$3 == "watch" { found=1 } END { exit(found ? 0 : 1) }' "$LEASE/owner"; then
    watch_owner_ready=1
    break
  fi
  kill -0 "$WATCHER_PID" 2>/dev/null || break
  sleep 0.1
done

echo "Test: FLY-1482 live watcher yields for teardown and resumes"
teardown_rc=0
if [[ "$watch_owner_ready" == "1" ]]; then
  /bin/bash "$TEARDOWN" "$SLOT" > "$TEARDOWN_LOG" 2>&1 || teardown_rc=$?
else
  teardown_rc=99
fi

watch_resumed=0
if [[ "$watch_owner_ready" == "1" ]]; then
  for _ in $(seq 1 100); do
    if [[ -f "$LEASE/owner" ]] && awk -F'|' '$3 == "watch" { found=1 } END { exit(found ? 0 : 1) }' "$LEASE/owner"; then
      watch_resumed=1
      break
    fi
    sleep 0.1
  done
fi

if [[ "$teardown_rc" -eq 0 \
    && ! -e "/tmp/flywheel-test-slot-${SLOT}" \
    && ! -e "/tmp/flywheel-test-slot-${SLOT}.lock" \
    && ! -e "$CLAIM" \
    && "$watch_resumed" == "1" ]] \
    && kill -0 "$WATCHER_PID" 2>/dev/null; then
  pass "real watcher yielded, slot residue was removed, and watcher reacquired its lease"
else
  fail "teardown_rc=$teardown_rc owner_ready=$watch_owner_ready resumed=$watch_resumed slot_dir=$([[ -e /tmp/flywheel-test-slot-${SLOT} ]] && echo present || echo absent) claim=$([[ -e $CLAIM ]] && echo present || echo absent)"
  echo "--- teardown log ---"
  sed -n '1,160p' "$TEARDOWN_LOG" 2>/dev/null || true
  echo "--- watcher log ---"
  sed -n '1,200p' "$WATCHER_LOG" 2>/dev/null || true
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
