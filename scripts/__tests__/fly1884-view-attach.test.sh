#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HELPER="$ROOT/scripts/flywheel-view-attach.sh"
NODE_HELPER="$ROOT/scripts/flywheel-node-status.sh"
TMP=$(mktemp -d)
PID=""
NODE_PID=""
cleanup() {
  [[ -z "$PID" ]] || kill "$PID" 2>/dev/null || true
  [[ -z "$NODE_PID" ]] || kill "$NODE_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if "$HELPER" not-a-view >/dev/null 2>&1; then
  echo "FAIL: non-view session accepted" >&2
  exit 1
elif [[ "$?" -ne 64 ]]; then
  echo "FAIL: non-view session did not return EX_USAGE" >&2
  exit 1
fi

MOCK_TMUX="$TMP/tmux"
printf '%s\n' \
  '#!/bin/bash' \
  'case "$1" in' \
  '  has-session) [[ -f "$FLYWHEEL_TEST_SESSION_READY" ]] ;;' \
  '  attach-session) printf "%s\n" "$*" >> "$FLYWHEEL_TEST_TMUX_LOG" ;;' \
  '  *) exit 2 ;;' \
  'esac' > "$MOCK_TMUX"
chmod +x "$MOCK_TMUX"
export FLYWHEEL_CMUX_ATTACH_TMUX_BIN="$MOCK_TMUX"
export FLYWHEEL_TEST_SESSION_READY="$TMP/ready"
export FLYWHEEL_TEST_TMUX_LOG="$TMP/tmux.log"

TERM=dumb "$HELPER" cmux-FLY-1884-qa > "$TMP/output" 2>&1 &
PID=$!
sleep 1
grep -q '等待重建后自动重连' "$TMP/output" || {
  echo "FAIL: disconnected state was not founder-visible" >&2
  exit 1
}
touch "$FLYWHEEL_TEST_SESSION_READY"
sleep 3
grep -q "^attach-session -t =cmux-FLY-1884-qa$" "$FLYWHEEL_TEST_TMUX_LOG" || {
  echo "FAIL: helper did not attach after the view session appeared" >&2
  exit 1
}

kill "$PID"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "FAIL: helper PID survived surface shutdown" >&2
  exit 1
fi
wait "$PID" 2>/dev/null || true
PID=""

STATUS="$TMP/node.status"
printf '节点: FLY-1884 implement\n状态: 等待重生\n' > "$STATUS"
TERM=dumb "$NODE_HELPER" "$STATUS" > "$TMP/node-output" 2>&1 &
NODE_PID=$!
sleep 1
grep -q '状态: 等待重生' "$TMP/node-output" || {
  echo "FAIL: node helper did not render the initial status" >&2
  exit 1
}
printf '节点: FLY-1884 implement\n状态: 已完成\n' > "$STATUS"
sleep 3
grep -q '状态: 已完成' "$TMP/node-output" || {
  echo "FAIL: node helper did not refresh the status file" >&2
  exit 1
}
kill "$NODE_PID"
wait "$NODE_PID" 2>/dev/null || true
NODE_PID=""

echo "PASS: view reconnect and node-status helpers remain visible and exit with their surfaces"
