#!/bin/bash
# FLY-1285: generation-bound Lead tmux archive and process takeover.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LEAD_SH="$(cd "$SCRIPT_DIR/.." && pwd)/claude-lead.sh"
LIB="$(cd "$SCRIPT_DIR/../lib" && pwd)/tmux-supervisor-guard.sh"
TMP_DIR="$(mktemp -d -t fly1285-supervisor.XXXXXX)" || exit 1
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "[TEST] ✓ $*"; }
bad() { FAIL=$((FAIL + 1)); echo "[TEST] ✗ $*" >&2; }

if [ ! -f "$LIB" ]; then
  bad "tmux-supervisor-guard.sh is missing"
  echo "Results: ${PASS} passed, ${FAIL} failed"
  exit 1
fi

# shellcheck source=../lib/tmux-supervisor-guard.sh
source "$LIB"

ARCHIVE="$TMP_DIR/lead.tmux"

echo "[TEST] process start identity pins ps output to the C locale"
LOCALE_BIN="$TMP_DIR/locale-bin"
mkdir -p "$LOCALE_BIN"
# This single-quoted line is emitted verbatim into the ps shim for runtime expansion.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/bin/sh' \
  '[ "${LC_ALL:-}" = "C" ] || { printf "wrong LC_ALL=%s\n" "${LC_ALL:-unset}" >&2; exit 17; }' \
  'printf "Tue Jul 21 08:00:00 2026\n"' \
  > "$LOCALE_BIN/ps"
chmod +x "$LOCALE_BIN/ps"
LOCALE_START="$(
  export LC_ALL=en_US.UTF-8
  export PATH="$LOCALE_BIN:$PATH"
  tmux_supervisor_process_start_identity 4242
)"
LOCALE_RC=$?
if [ "$LOCALE_RC" -eq 0 ] && [ "$LOCALE_START" = "Tue Jul 21 08:00:00 2026" ]; then
  ok "start-identity producer overrides ambient locale with LC_ALL=C"
else
  bad "start-identity producer inherited ambient locale: rc=$LOCALE_RC output=$LOCALE_START"
fi

echo "[TEST] archive atomically preserves the server/pane generation tuple"
tmux_supervisor_archive_write "$ARCHIVE" 4100 4200 "start identity" '@7'
if tmux_supervisor_archive_read "$ARCHIVE" \
  && [ "$TMUX_ARCHIVE_SERVER_PID" = "4100" ] \
  && [ "$TMUX_ARCHIVE_PANE_PID" = "4200" ] \
  && [ "$TMUX_ARCHIVE_PANE_START" = "start identity" ] \
  && [ "$TMUX_ARCHIVE_WINDOW_ID" = "@7" ]; then
  ok "archive round-trips the four generation-bound fields"
else
  bad "archive tuple did not round-trip"
fi

echo "[TEST] archived-process state keeps sensor failure distinct from positive death"
sleep 30 &
SENSOR_PID=$!
SENSOR_START="sensor-start"
_tmux_supervisor_process_presence_state() {
  jobs -r -p | grep -Fxq "$1"
}
tmux_supervisor_process_start_identity() { printf '%s\n' "$SENSOR_START"; }
tmux_supervisor_archive_write "$ARCHIVE" 4100 "$SENSOR_PID" "$SENSOR_START" '@7'
_tmux_supervisor_process_command() {
  [ "$1" = "$SENSOR_PID" ] && printf '%s\n' 'claude --agent test-lead --resume abc'
}
TMUX_SUPERVISOR_ARCHIVED_STATE=""
tmux_supervisor_archived_process_state "$ARCHIVE" test-lead
LIVE_STATE_RC=$?
if [ "$LIVE_STATE_RC" -eq 0 ] \
  && [ "$TMUX_SUPERVISOR_ARCHIVED_STATE" = live_exact ]; then
  ok "exact live archive has a typed live state"
else
  bad "exact live archive state was rc=$LIVE_STATE_RC state=${TMUX_SUPERVISOR_ARCHIVED_STATE:-missing}"
fi

tmux_supervisor_process_start_identity() { return 2; }
TMUX_SUPERVISOR_ARCHIVED_STATE=""
tmux_supervisor_archived_process_state "$ARCHIVE" test-lead
SENSOR_STATE_RC=$?
tmux_supervisor_reap_archived_process "$ARCHIVE" test-lead
SENSOR_REAP_RC=$?
if [ "$SENSOR_STATE_RC" -eq 2 ] \
  && [ "$TMUX_SUPERVISOR_ARCHIVED_STATE" = indeterminate ] \
  && [ "$SENSOR_REAP_RC" -eq 2 ] \
  && [ -f "$ARCHIVE" ] \
  && kill -0 "$SENSOR_PID" 2>/dev/null; then
  ok "sensor failure preserves the live process and archive evidence"
else
  bad "sensor failure collapsed into death: state_rc=$SENSOR_STATE_RC state=${TMUX_SUPERVISOR_ARCHIVED_STATE:-missing} reap_rc=$SENSOR_REAP_RC archive=$([ -f "$ARCHIVE" ] && echo yes || echo no)"
fi
kill "$SENSOR_PID" 2>/dev/null || true
wait "$SENSOR_PID" 2>/dev/null || true

echo "[TEST] PID reuse never authorizes a signal"
sleep 30 &
REUSED_PID=$!
_tmux_supervisor_test_start="actual start"
tmux_supervisor_process_start_identity() { printf '%s\n' "$_tmux_supervisor_test_start"; }
ACTUAL_START="$(tmux_supervisor_process_start_identity "$REUSED_PID")"
tmux_supervisor_archive_write "$ARCHIVE" 4100 "$REUSED_PID" "different start" '@7'
tmux_supervisor_reap_archived_process "$ARCHIVE" test-lead
REUSE_RC=$?
if [ "$REUSE_RC" -eq 0 ] && kill -0 "$REUSED_PID" 2>/dev/null \
  && [ ! -f "$ARCHIVE" ] && [ -n "$ACTUAL_START" ]; then
  ok "start-identity mismatch clears only the stale archive"
else
  bad "PID reuse path signalled a live unrelated process or kept stale state"
fi
kill "$REUSED_PID" 2>/dev/null || true
wait "$REUSED_PID" 2>/dev/null || true

echo "[TEST] a proven archived Claude is TERM then identity-rechecked before KILL"
bash -c 'trap "" TERM; while true; do sleep 1; done' &
CLAUDE_PID=$!
_tmux_supervisor_test_killed_pid=""
kill() {
  local _kill_arg _kill_last=""
  for _kill_arg in "$@"; do _kill_last="$_kill_arg"; done
  case "${1:-}" in
    -KILL|-9) _tmux_supervisor_test_killed_pid="$_kill_last" ;;
  esac
  builtin kill "$@"
}
_tmux_supervisor_process_presence_state() {
  [ "$1" = "$_tmux_supervisor_test_killed_pid" ] && return 1
  jobs -r -p | grep -Fxq "$1"
}
_tmux_supervisor_test_start="claude start"
CLAUDE_START="$(tmux_supervisor_process_start_identity "$CLAUDE_PID")"
tmux_supervisor_archive_write "$ARCHIVE" 4100 "$CLAUDE_PID" "$CLAUDE_START" '@7'
_tmux_supervisor_process_command() {
  [ "$1" = "$CLAUDE_PID" ] && printf '%s\n' 'claude --agent test-lead --resume abc'
}
export FLYWHEEL_TMUX_TAKEOVER_WAIT_ATTEMPTS=1
export FLYWHEEL_TMUX_TAKEOVER_WAIT_SEC=0.05
tmux_supervisor_reap_archived_process "$ARCHIVE" test-lead
REAP_RC=$?
unset FLYWHEEL_TMUX_TAKEOVER_WAIT_ATTEMPTS FLYWHEEL_TMUX_TAKEOVER_WAIT_SEC
if [ "$REAP_RC" -eq 0 ] && ! kill -0 "$CLAUDE_PID" 2>/dev/null \
  && [ ! -f "$ARCHIVE" ]; then
  ok "proven stale Claude is reaped without leaving a duplicate"
else
  bad "proven stale Claude takeover failed: rc=$REAP_RC"
  kill -9 "$CLAUDE_PID" 2>/dev/null || true
fi
wait "$CLAUDE_PID" 2>/dev/null || true

echo "[TEST] production launcher wires guarded socket and archive primitives"
if rg -q 'source .*tmux-server-rescue\.sh' "$LEAD_SH" \
  && rg -q 'source .*tmux-supervisor-guard\.sh' "$LEAD_SH" \
  && rg -q 'tmux_socket_ensure' "$LEAD_SH" \
  && rg -q 'tmux_socket_recover' "$LEAD_SH" \
  && rg -q 'tmux_supervisor_archive_write' "$LEAD_SH" \
  && rg -q 'tmux_supervisor_reap_archived_process' "$LEAD_SH"; then
  ok "claude-lead.sh consumes the shared guard libraries"
else
  bad "claude-lead.sh is missing one or more guarded runtime seams"
fi

echo "[TEST] supervisor is observation-only and carries the Bridge incident ack"
if rg -q '/api/tmux-hold-observation' "$LEAD_SH" \
  && rg -q 'heldSinceTs' "$LEAD_SH" \
  && rg -q '_tmux_normalize_hold_kind' "$LEAD_SH" \
  && rg -q 'TMUX_HOLD_BRIDGE_ACKED' "$LEAD_SH" \
  && ! rg -q '/api/tmux-hold/resolve' "$LEAD_SH"; then
  ok "hold reporting uses the canonical observation endpoint without resolving Bridge state"
else
  bad "hold reporting can bypass the Bridge-owned reconciliation contract"
fi

echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
