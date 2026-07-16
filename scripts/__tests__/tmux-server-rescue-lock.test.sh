#!/bin/bash
# FLY-1285: real-process advisory-lock behavior for tmux-server-rescue.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/scripts/lib/tmux-server-rescue.sh"
TMP_DIR="$(mktemp -d -t fly1285-lock.XXXXXX)" || exit 1
trap 'rm -rf "$TMP_DIR"' EXIT

# shellcheck source=../lib/tmux-server-rescue.sh
source "$LIB"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "[TEST] ✓ $*"; }
bad() { FAIL=$((FAIL + 1)); echo "[TEST] ✗ $*" >&2; }

CRITICAL="$TMP_DIR/critical.sh"
apply_critical() {
  printf '%s\n' '#!/bin/bash' \
    'set -eu' \
    'state="$1"' \
    'hold="$2"' \
    'current=0' \
    '[ -s "$state" ] && current="$(cat "$state")"' \
    'current=$((current + 1))' \
    'printf "%s" "$current" > "$state"' \
    'printf "enter:%s\n" "$$" >> "${state}.log"' \
    '[ "$current" -le 1 ] || printf "overlap\n" >> "${state}.log"' \
    'sleep "$hold"' \
    'current="$(cat "$state")"' \
    'printf "%s" "$((current - 1))" > "$state"' \
    'printf "exit:%s\n" "$$" >> "${state}.log"' > "$CRITICAL"
  chmod +x "$CRITICAL"
}
apply_critical

if ! _tmux_rescue_has_python_fcntl; then
  echo "[TEST] python fcntl unavailable; cannot verify the required fallback" >&2
  exit 1
fi

echo "[TEST] two real contenders serialize the critical section"
STATE="$TMP_DIR/state"
printf '0' > "$STATE"
_tmux_rescue_python_lock 3 "$TMP_DIR/lockf" "$CRITICAL" "$STATE" 0.3 &
P1=$!
_tmux_rescue_python_lock 3 "$TMP_DIR/lockf" "$CRITICAL" "$STATE" 0.1 &
P2=$!
wait "$P1"; RC1=$?
wait "$P2"; RC2=$?
if [ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] \
  && [ "$(cat "$STATE")" = "0" ] \
  && ! grep -q overlap "${STATE}.log"; then
  ok "advisory lock keeps maximum concurrency at one"
else
  bad "critical sections overlapped or failed: rc=$RC1/$RC2 state=$(cat "$STATE") log=$(tr '\n' ';' < "${STATE}.log")"
fi

echo "[TEST] SIGKILL of the lock owner releases the kernel lock"
HOLDER="$TMP_DIR/holder.sh"
printf '%s\n' '#!/bin/bash' 'printf "%s" "$$" > "$1"' 'exec sleep 30' > "$HOLDER"
chmod +x "$HOLDER"
OWNER_FILE="$TMP_DIR/owner"
_tmux_rescue_python_lock 3 "$TMP_DIR/kill.lockf" "$HOLDER" "$OWNER_FILE" &
WRAPPER_PID=$!
for _ in $(seq 1 50); do [ -s "$OWNER_FILE" ] && break; sleep 0.02; done
OWNER_PID="$(cat "$OWNER_FILE" 2>/dev/null)"
kill -9 "$OWNER_PID" 2>/dev/null || true
wait "$WRAPPER_PID" 2>/dev/null || true
START=$SECONDS
_tmux_rescue_python_lock 1 "$TMP_DIR/kill.lockf" /usr/bin/true
NEXT_RC=$?
ELAPSED=$((SECONDS - START))
kill "$OWNER_PID" 2>/dev/null || true
if [ "$NEXT_RC" -eq 0 ] && [ "$ELAPSED" -lt 2 ]; then
  ok "kernel lock is recoverable after an ungraceful owner exit"
else
  bad "lock remained unavailable after SIGKILL: rc=$NEXT_RC elapsed=$ELAPSED"
fi

echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
