#!/usr/bin/env bash
# FLY-1634: the Lead body cleanup contract is one bounded hard-clear operation.
# Source-level harness; production remains compatible with macOS bash 3.2.
set -u

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
ORIGINAL_HOME="$HOME"
trap 'HOME="$ORIGINAL_HOME"; rm -rf "$TEST_ROOT"' EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# shellcheck source=../../packages/teamlead/scripts/lib/lead-identity-preflight.sh
source "$ROOT/packages/teamlead/scripts/lib/lead-identity-preflight.sh"
# shellcheck source=../../packages/teamlead/scripts/lib/tmux-supervisor-guard.sh
source "$ROOT/packages/teamlead/scripts/lib/tmux-supervisor-guard.sh"
# shellcheck source=../lib/lead-body-sweep.sh
source "$ROOT/scripts/lib/lead-body-sweep.sh"

echo "Test: a real zombie is dead for executable-body purposes"
if ps -p $$ -o state= >/dev/null 2>&1; then
  zombie_pid_file="$TEST_ROOT/zombie.pid"
  python3 -c '
import os, sys, time
child = os.fork()
if child == 0:
    os._exit(0)
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(str(child))
time.sleep(30)
' "$zombie_pid_file" &
  zombie_parent=$!
  zombie_pid=""
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    zombie_pid="$(cat "$zombie_pid_file" 2>/dev/null || true)"
    if [ -n "$zombie_pid" ] \
      && [ "$(ps -p "$zombie_pid" -o state= 2>/dev/null | awk '{print substr($1,1,1)}')" = Z ]; then
      break
    fi
    sleep 0.1
  done
  zombie_start="$(lead_body_process_start_identity "$zombie_pid" 2>/dev/null || true)"
  zombie_rc=0
  _lead_body_tuple_state "$zombie_pid" "$zombie_start" || zombie_rc=$?
  kill "$zombie_parent" 2>/dev/null || true
  wait "$zombie_parent" 2>/dev/null || true
  if [ -n "$zombie_start" ] && [ "$zombie_rc" -eq 1 ]; then
    pass "zombie tuple is classified dead instead of sensor-failed"
  else
    fail "zombie tuple classification mismatch (pid=$zombie_pid rc=$zombie_rc)"
  fi
else
  echo "  - real process-table probe unavailable in this sandbox; synthetic Z+ case follows"
fi

if ! type lead_body_hard_clear >/dev/null 2>&1; then
  fail "lead_body_hard_clear exists"
  echo ""
  echo "Results: ${PASS} passed, ${FAIL} failed"
  exit 1
fi
pass "lead_body_hard_clear exists"

HOME="$TEST_ROOT/home"
mkdir -p "$HOME/.flywheel/pids"

INVENTORY=""
PROCESS_TABLE=""
PARENT_TABLE=""
DEAD_PIDS=""
PROCESS_STATE_OVERRIDE=""
SIGNAL_CALLS=""
TMUX_CALLS=""
KILLED_WINDOWS=""
EXACT_COMMAND_OVERRIDE=""
PROCESS_TABLE_FAILURES_FILE="$TEST_ROOT/process-table-failures"
PARENT_TABLE_FAILURES_FILE="$TEST_ROOT/parent-table-failures"

fixture_start() {
  case "$1" in
    101) printf '%s\n' "Mon Aug  4 10:00:01 2026" ;;
    102) printf '%s\n' "Mon Aug  4 10:00:02 2026" ;;
    201) printf '%s\n' "Mon Aug  4 10:00:03 2026" ;;
    202) printf '%s\n' "Mon Aug  4 10:00:04 2026" ;;
    203) printf '%s\n' "Mon Aug  4 10:00:05 2026" ;;
    *) return 1 ;;
  esac
}

fixture_command() {
  case "$1" in
    101)
      printf '%s\n' "claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/proj-lead.1.md --resume session-a"
      ;;
    102)
      printf '%s\n' "claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/other-lead.1.md --resume session-b"
      ;;
    201|202)
      printf '%s\n' "codex resume --remote unix:///tmp/codex/app-server-control/app-server-control.sock -C /tmp/work -s workspace-write -c approval_policy=never 11111111-1111-1111-1111-111111111111"
      ;;
    203) printf '%s\n' "codex app-server --listen stdio://" ;;
    *) return 1 ;;
  esac
}

lead_body_process_start_identity() { fixture_start "$1"; }
lead_body_process_command() {
  if [ -n "$EXACT_COMMAND_OVERRIDE" ]; then
    printf '%s\n' "$EXACT_COMMAND_OVERRIDE"
  else
    fixture_command "$1"
  fi
}
lead_body_process_state() {
  if [ -n "$PROCESS_STATE_OVERRIDE" ]; then
    printf '%s\n' "$PROCESS_STATE_OVERRIDE"
    return 0
  fi
  case " $DEAD_PIDS " in *" $1 "*) return 1 ;; esac
  fixture_start "$1" >/dev/null 2>&1 || return 1
  printf '%s\n' S
}
lead_body_process_alive() {
  case " $DEAD_PIDS " in *" $1 "*) return 1 ;; esac
  fixture_start "$1" >/dev/null 2>&1
}
lead_body_process_table() {
  local remaining=0
  remaining="$(cat "$PROCESS_TABLE_FAILURES_FILE" 2>/dev/null || echo 0)"
  if [ "$remaining" -gt 0 ]; then
    printf '%s\n' "$((remaining - 1))" > "$PROCESS_TABLE_FAILURES_FILE"
    return 1
  fi
  printf '%s\n' "$PROCESS_TABLE"
}
lead_body_process_parent_table() {
  local remaining=0
  remaining="$(cat "$PARENT_TABLE_FAILURES_FILE" 2>/dev/null || echo 0)"
  if [ "$remaining" -gt 0 ]; then
    printf '%s\n' "$((remaining - 1))" > "$PARENT_TABLE_FAILURES_FILE"
    return 1
  fi
  printf '%s\n' "$PARENT_TABLE"
}
lead_body_signal() {
  local signal="$1" pid="$2"
  SIGNAL_CALLS="${SIGNAL_CALLS}${signal}:${pid}"$'\n'
  DEAD_PIDS="${DEAD_PIDS} ${pid}"
}
lead_body_sleep() { return 0; }
lead_body_pane_inventory() {
  local window_id window_name pane_id pane_pid pane_dead
  while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ -n "$window_id" ] || continue
    case " $KILLED_WINDOWS " in *" $window_id "*) continue ;; esac
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$window_id" "$window_name" "$pane_id" "$pane_pid" "$pane_dead"
  done <<EOF
$INVENTORY
EOF
}
_sweep_tmux() {
  TMUX_CALLS="${TMUX_CALLS}$*"$'\n'
  if [ "${1:-}" = kill-window ]; then
    KILLED_WINDOWS="${KILLED_WINDOWS} ${3#=}" 
    return 0
  fi
  return 0
}

echo "Test: state values beginning with Z are non-executable"
PROCESS_STATE_OVERRIDE="Z+"
synthetic_zombie_rc=0
_lead_body_tuple_state 101 "$(fixture_start 101)" || synthetic_zombie_rc=$?
PROCESS_STATE_OVERRIDE=""
if [ "$synthetic_zombie_rc" -eq 1 ]; then
  pass "Z+ tuple is classified dead"
else
  fail "Z+ tuple classification mismatch (rc=$synthetic_zombie_rc)"
fi

echo "Test: orphan session identity is recovered from one exact flag"
session_id="$(_lead_body_session_identity "$(fixture_command 101)")"
if [ "$session_id" = session-a ] \
  && ! _lead_body_session_identity \
    "claude --agent lead --resume session-a --session-id session-b" >/dev/null 2>&1; then
  pass "session recovery accepts one identity and rejects ambiguity"
else
  fail "session recovery did not preserve the exact identity contract"
fi

reset_fixture() {
  INVENTORY=""
  PROCESS_TABLE=""
  PARENT_TABLE=""
  DEAD_PIDS=""
  PROCESS_STATE_OVERRIDE=""
  SIGNAL_CALLS=""
  TMUX_CALLS=""
  KILLED_WINDOWS=""
  EXACT_COMMAND_OVERRIDE=""
  printf '0\n' > "$PROCESS_TABLE_FAILURES_FILE"
  printf '0\n' > "$PARENT_TABLE_FAILURES_FILE"
  LEAD_BODY_CLEAR_TERM_ATTEMPTS=1
  LEAD_BODY_CLEAR_KILL_ATTEMPTS=1
  LEAD_BODY_CLEAR_INTERVAL=0
}

echo "Test: Claude hard-clear signals only project-proven bodies"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t101\t0\n@2\tother-lead\t%2\t102\t0'
PROCESS_TABLE="101 $(fixture_command 101)"$'\n'"102 $(fixture_command 102)"
rc=0
lead_body_hard_clear proj lead claude-code || rc=$?
if [ "$rc" -eq 0 ] \
  && printf '%s' "$SIGNAL_CALLS" | grep -q '^TERM:101$' \
  && ! printf '%s' "$SIGNAL_CALLS" | grep -q ':102$' \
  && printf '%s' "$TMUX_CALLS" | grep -q 'kill-window -t =@1' \
  && ! printf '%s' "$TMUX_CALLS" | grep -q '=@2'; then
  pass "Claude hard-clear is project-scoped"
else
  fail "Claude hard-clear scope mismatch (rc=$rc signals=$SIGNAL_CALLS tmux=$TMUX_CALLS)"
fi

echo "Test: transient sensor loss retries without a latched failure"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t101\t0'
PROCESS_TABLE="101 $(fixture_command 101)"
printf '1\n' > "$PROCESS_TABLE_FAILURES_FILE"
rc=0
lead_body_hard_clear proj lead claude-code || rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$SIGNAL_CALLS" | grep -q ':101$'; then
  pass "transient census failure converges"
else
  fail "transient census failure latched (rc=$rc signals=$SIGNAL_CALLS)"
fi

echo "Test: persistent sensor loss fails closed without mutation"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t101\t0'
PROCESS_TABLE="101 $(fixture_command 101)"
printf '20\n' > "$PROCESS_TABLE_FAILURES_FILE"
rc=0
lead_body_hard_clear proj lead claude-code || rc=$?
if [ "$rc" -ne 0 ] && [ -z "$SIGNAL_CALLS" ] && [ -z "$TMUX_CALLS" ]; then
  pass "persistent census failure is bounded and fail-closed"
else
  fail "persistent census failure mutated or passed (rc=$rc signals=$SIGNAL_CALLS tmux=$TMUX_CALLS)"
fi

echo "Test: Codex hard-clear snapshots only target-window descendants"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0\n@2\tother-lead\t%2\t202\t0'
PARENT_TABLE=$'201 1\n203 201\n202 1'
rc=0
lead_body_hard_clear proj lead codex-app-server || rc=$?
if [ "$rc" -eq 0 ] \
  && printf '%s' "$SIGNAL_CALLS" | grep -q '^TERM:201$' \
  && printf '%s' "$SIGNAL_CALLS" | grep -q '^TERM:203$' \
  && ! printf '%s' "$SIGNAL_CALLS" | grep -q ':202$' \
  && printf '%s' "$TMUX_CALLS" | grep -q 'kill-window -t =@1' \
  && ! printf '%s' "$TMUX_CALLS" | grep -q '=@2'; then
  pass "Codex target set excludes the other Lead"
else
  fail "Codex isolation mismatch (rc=$rc signals=$SIGNAL_CALLS tmux=$TMUX_CALLS)"
fi

echo "Test: exact-tuple mode never signals a reused PID"
reset_fixture
PROCESS_TABLE="101 $(fixture_command 101)"
rc=0
lead_body_hard_clear proj lead claude-code 101 "OLD START" || rc=$?
if [ "$rc" -eq 0 ] && [ -z "$SIGNAL_CALLS" ]; then
  pass "reused exact tuple is already clear"
else
  fail "reused exact tuple was signalled or failed (rc=$rc signals=$SIGNAL_CALLS)"
fi

echo "Test: exact-tuple mode clears only the proven orphan holder"
reset_fixture
EXACT_COMMAND_OVERRIDE="claude --agent lead --resume session-a"
rc=0
lead_body_hard_clear proj lead claude-code 101 "$(fixture_start 101)" || rc=$?
if [ "$rc" -eq 0 ] \
  && [ "$(printf '%s' "$SIGNAL_CALLS" | grep -c '^TERM:101$')" -eq 1 ] \
  && ! printf '%s' "$SIGNAL_CALLS" | grep -q ':102$'; then
  pass "exact orphan holder is hard-cleared without widening"
else
  fail "exact orphan clear widened or failed (rc=$rc signals=$SIGNAL_CALLS)"
fi

echo "Test: supervisor orphan fallback restores session and closes bound-body states"
EXACT_COMMAND_OVERRIDE=""
SUPERVISOR_FUNCTIONS="$(awk '
  /^_lead_restore_orphan_session\(\)/ { capture=1 }
  capture && /^# FLY-231:/ { exit }
  capture { print }
' "$ROOT/packages/teamlead/scripts/claude-lead.sh")"
if [ -n "$SUPERVISOR_FUNCTIONS" ]; then
  eval "$SUPERVISOR_FUNCTIONS"
  SESSION_ID_FILE="$TEST_ROOT/orphan.session-id"
  PROJECT_NAME=proj
  LEAD_ID=lead
  LEAD_LEASE_ORPHAN_HOLDER_PID=101
  LEAD_LEASE_ORPHAN_HOLDER_START="$(fixture_start 101)"
  if _lead_restore_orphan_session \
    && [ "$(cat "$SESSION_ID_FILE")" = session-a ]; then
    pass "orphan session identity is persisted before hard clear"
  else
    fail "orphan session identity was not restored"
  fi

  BOUND_TUPLE_RC=0
  BOUND_ARCHIVE_OK=1
  _lead_body_tuple_state() { return "$BOUND_TUPLE_RC"; }
  _tmux_target_matches_archive() { [ "$BOUND_ARCHIVE_OK" -eq 1 ]; }
  LEAD_WINDOW_ID=@1
  TMUX_ARCHIVE_PANE_PID=101
  TMUX_ARCHIVE_PANE_START="$LEAD_LEASE_ORPHAN_HOLDER_START"
  bound_rc=0
  _lead_bound_body_ready || bound_rc=$?
  if [ "$bound_rc" -eq 0 ]; then
    pass "live exact bound body remains monitored"
  else
    fail "live exact bound body was not recognized (rc=$bound_rc)"
  fi

  BOUND_TUPLE_RC=1
  bound_rc=0
  _lead_bound_body_ready || bound_rc=$?
  [ "$bound_rc" -eq 1 ] \
    && pass "dead or zombie bound body enters hard-clear reacquire" \
    || fail "dead bound body state was folded (rc=$bound_rc)"

  BOUND_TUPLE_RC=2
  bound_rc=0
  _lead_bound_body_ready || bound_rc=$?
  [ "$bound_rc" -eq 2 ] \
    && pass "bound-body sensor failure remains a HOLD" \
    || fail "bound-body sensor failure was folded (rc=$bound_rc)"

  BOUND_TUPLE_RC=0
  BOUND_ARCHIVE_OK=0
  bound_rc=0
  _lead_bound_body_ready || bound_rc=$?
  [ "$bound_rc" -eq 3 ] \
    && pass "live body with window/archive drift remains a HOLD" \
    || fail "window/archive drift was accepted (rc=$bound_rc)"
else
  fail "supervisor orphan fallback functions were not found"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
