#!/usr/bin/env bash
# FLY-1680: bespoke Codex hard-clear remains bounded and target-scoped.
set -u

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

lead_restart_process_start_identity() {
  LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null
}
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
  [ -n "$zombie_start" ] && [ "$zombie_rc" -eq 1 ] \
    && pass "zombie tuple is classified dead" \
    || fail "zombie tuple classification mismatch (pid=$zombie_pid rc=$zombie_rc)"
fi

INVENTORY=""
PARENT_TABLE=""
DEAD_PIDS=""
SIGNAL_CALLS=""
TMUX_CALLS=""
KILLED_WINDOWS=""
TERM_IMMUNE=0
INVENTORY_FAIL_AT_CALLS=""
PARENT_FAILURES=0
INVENTORY_CALLS=0
PARENT_FAILURES_FILE="$TEST_ROOT/parent-failures"
INVENTORY_CALLS_FILE="$TEST_ROOT/inventory-calls"

fixture_start() {
  case "$1" in
    201) printf '%s\n' "Mon Aug  4 10:00:03 2026" ;;
    202) printf '%s\n' "Mon Aug  4 10:00:04 2026" ;;
    203) printf '%s\n' "Mon Aug  4 10:00:05 2026" ;;
    *) return 1 ;;
  esac
}

lead_body_process_start_identity() { fixture_start "$1"; }
lead_body_process_state() {
  case " $DEAD_PIDS " in *" $1 "*) return 1 ;; esac
  fixture_start "$1" >/dev/null 2>&1 || return 1
  printf '%s\n' S
}
lead_body_process_alive() {
  case " $DEAD_PIDS " in *" $1 "*) return 1 ;; esac
  fixture_start "$1" >/dev/null 2>&1
}
lead_body_process_parent_table() {
	local remaining
	remaining="$(cat "$PARENT_FAILURES_FILE" 2>/dev/null || echo 0)"
	if [ "$remaining" -gt 0 ]; then
		printf '%s\n' "$((remaining - 1))" > "$PARENT_FAILURES_FILE"
		return 1
	fi
  printf '%s\n' "$PARENT_TABLE"
}
lead_body_signal() {
  local signal="$1" pid="$2"
  SIGNAL_CALLS="${SIGNAL_CALLS}${signal}:${pid}"$'\n'
  [ "$TERM_IMMUNE" -eq 1 ] && [ "$signal" = TERM ] && return 0
  DEAD_PIDS="${DEAD_PIDS} ${pid}"
}
lead_body_sleep() { return 0; }
lead_body_pane_inventory() {
	local window_id window_name pane_id pane_pid pane_dead call_count
	call_count="$(cat "$INVENTORY_CALLS_FILE" 2>/dev/null || echo 0)"
	call_count=$((call_count + 1))
	printf '%s\n' "$call_count" > "$INVENTORY_CALLS_FILE"
	case " $INVENTORY_FAIL_AT_CALLS " in *" $call_count "*) return 2 ;; esac
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
  fi
}

reset_fixture() {
  INVENTORY=""
  PARENT_TABLE=""
  DEAD_PIDS=""
  SIGNAL_CALLS=""
  TMUX_CALLS=""
  KILLED_WINDOWS=""
  TERM_IMMUNE=0
  INVENTORY_FAIL_AT_CALLS=""
	PARENT_FAILURES=0
	INVENTORY_CALLS=0
	printf '0\n' > "$PARENT_FAILURES_FILE"
	printf '0\n' > "$INVENTORY_CALLS_FILE"
  LEAD_BODY_CLEAR_TERM_ATTEMPTS=1
  LEAD_BODY_CLEAR_KILL_ATTEMPTS=1
  LEAD_BODY_CLEAR_INTERVAL=0
}

echo "Test: retired Claude hard-clear is rejected without mutation"
reset_fixture
rc=0
lead_body_hard_clear proj lead claude-code || rc=$?
[ "$rc" -eq 2 ] && [ -z "$SIGNAL_CALLS$TMUX_CALLS" ] \
  && pass "Claude hard-clear is unavailable" \
  || fail "Claude hard-clear mutated or passed (rc=$rc)"

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

echo "Test: transient initial census loss converges"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0'
PARENT_TABLE=$'201 1\n203 201'
PARENT_FAILURES=1
printf '1\n' > "$PARENT_FAILURES_FILE"
rc=0
lead_body_hard_clear proj lead codex-app-server || rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$SIGNAL_CALLS" | grep -q '^TERM:203$' \
  && pass "transient census failure retries" \
  || fail "transient census failure latched (rc=$rc signals=$SIGNAL_CALLS)"

echo "Test: persistent initial census loss is fail-closed"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0'
PARENT_TABLE=$'201 1'
PARENT_FAILURES=20
printf '20\n' > "$PARENT_FAILURES_FILE"
rc=0
lead_body_hard_clear proj lead codex-app-server || rc=$?
[ "$rc" -eq 2 ] && [ -z "$SIGNAL_CALLS$TMUX_CALLS" ] \
  && pass "persistent census failure does not mutate" \
  || fail "persistent census failure mutated or passed (rc=$rc)"

echo "Test: TERM-immune descendants receive bounded KILL"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0'
PARENT_TABLE=$'201 1\n203 201'
TERM_IMMUNE=1
rc=0
lead_body_hard_clear proj lead codex-app-server || rc=$?
if [ "$rc" -eq 0 ] \
  && printf '%s' "$SIGNAL_CALLS" | grep -q '^KILL:201$' \
  && printf '%s' "$SIGNAL_CALLS" | grep -q '^KILL:203$'; then
  pass "Codex hard-clear escalates from TERM to KILL"
else
  fail "Codex escalation mismatch (rc=$rc signals=$SIGNAL_CALLS)"
fi

echo "Test: persistent re-census loss blocks KILL"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0'
PARENT_TABLE=$'201 1'
TERM_IMMUNE=1
INVENTORY_FAIL_AT_CALLS="3 4"
rc=0
lead_body_hard_clear proj lead codex-app-server || rc=$?
[ "$rc" -eq 2 ] && ! printf '%s' "$SIGNAL_CALLS" | grep -q '^KILL:' \
  && pass "persistent re-census loss remains fail-closed" \
  || fail "re-census loss widened (rc=$rc signals=$SIGNAL_CALLS)"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
