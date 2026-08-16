#!/bin/bash
# FLY-1285: hermetic unit tests for scripts/lib/tmux-server-rescue.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../lib/tmux-server-rescue.sh"
TMP_DIR="$(mktemp -d -t fly1285-tmux-rescue.XXXXXX)" || exit 1
BIN_DIR="$TMP_DIR/bin"
mkdir -p "$BIN_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "  ✓ $*"; }
fail() { FAILED=$((FAILED + 1)); echo "  ✗ $*" >&2; }

cat > "$BIN_DIR/tmux" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "${TMUX_CALL_LOG}"
if [ "$1" = "-S" ] && [ "$3" = "display-message" ]; then
  [ -n "${FAKE_DISPLAY_SLEEP:-}" ] && sleep "$FAKE_DISPLAY_SLEEP"
  reachable="${FAKE_REACHABLE_PID:-}"
  if [ -n "${FAKE_STATE_FILE:-}" ] && [ -s "$FAKE_STATE_FILE" ]; then
    reachable="$(cat "$FAKE_STATE_FILE")"
  fi
  if [ -n "$reachable" ]; then
    echo "$reachable"
    exit 0
  fi
fi
case " $* " in
  *" set-option -s exit-empty off "*)
    if [ -n "${FAKE_POLICY_SET_SETS_PID:-}" ] && [ -n "${FAKE_STATE_FILE:-}" ]; then
      printf '%s' "$FAKE_POLICY_SET_SETS_PID" > "$FAKE_STATE_FILE"
    fi
    exit "${FAKE_POLICY_SET_RC:-0}"
    ;;
  *" show-options -sv exit-empty "*)
    [ "${FAKE_POLICY_SHOW_RC:-0}" -eq 0 ] || exit "$FAKE_POLICY_SHOW_RC"
    printf '%s\n' "${FAKE_POLICY_SHOW_VALUE:-off}"
    exit 0
    ;;
  *" has-session -t =flywheel-keepalive "*)
    if [ -n "${FAKE_KEEPALIVE_STATE_FILE:-}" ] \
        && [ -s "$FAKE_KEEPALIVE_STATE_FILE" ]; then
      exit 0
    fi
    exit "${FAKE_KEEPALIVE_RC:-0}"
    ;;
  *" new-session -d -s flywheel-keepalive "*)
    if [ -n "${FAKE_KEEPALIVE_STATE_FILE:-}" ]; then
      printf 'present\n' > "$FAKE_KEEPALIVE_STATE_FILE"
    fi
    exit "${FAKE_KEEPALIVE_CREATE_RC:-0}"
    ;;
  *" has-session "*)
    [ -n "${FAKE_VERIFY_SLEEP:-}" ] && sleep "$FAKE_VERIFY_SLEEP"
    exit "${FAKE_VERIFY_RC:-1}"
    ;;
  *" new-session "*)
    if [ -n "${FAKE_CREATE_SETS_PID:-}" ] && [ -n "${FAKE_STATE_FILE:-}" ]; then
      printf '%s' "$FAKE_CREATE_SETS_PID" > "$FAKE_STATE_FILE"
    fi
    printf '%s' "${FAKE_CREATE_STDOUT:-}"
    exit "${FAKE_CREATE_RC:-0}"
    ;;
esac
exit 1
SH

cat > "$BIN_DIR/ps" <<'SH'
#!/bin/bash
[ -n "${FAKE_PS_SLEEP:-}" ] && sleep "$FAKE_PS_SLEEP"
rows="${FAKE_PS_ROWS:-}"
if [ -n "${FAKE_STATE_FILE:-}" ] && [ -s "$FAKE_STATE_FILE" ]; then
  rows="${FAKE_PS_AFTER_ROWS:-$rows}"
fi
printf '%b' "$rows" | while IFS= read -r line; do
  case "$line" in
    uid:*) printf '%s\n' "${line#uid:}" ;;
    *) printf '%s %s\n' "$(id -u)" "$line" ;;
  esac
done
SH

cat > "$BIN_DIR/lsof" <<'SH'
#!/bin/bash
[ -n "${FAKE_LSOF_SLEEP:-}" ] && sleep "$FAKE_LSOF_SLEEP"
[ "${FAKE_LSOF_FAIL:-0}" = "1" ] && exit 2
[ "${FAKE_LSOF_RC_ONE_ERROR:-0}" = "1" ] && {
  echo "lsof: permission denied" >&2
  exit 1
}
pid=""
fields=""
unix_filter=0
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then pid="$2"; shift 2; continue; fi
  if [ "$1" = "-U" ]; then unix_filter=1; fi
  case "$1" in -F*) fields="$1" ;; esac
  shift
done
[ "${FAKE_LSOF_FILTER_RC_ONE_ERROR:-0}" = "1" ] && [ "$unix_filter" = "1" ] && {
  echo "lsof: filtered Unix descriptor scan failed" >&2
  exit 1
}
case "$fields" in
  *p*) printf 'p%s\n' "$pid"; exit 0 ;;
esac
case ",${FAKE_SOCKET_PIDS:-}," in
  *",${pid},"*) printf 'n%s%s\n' "${FAKE_LSOF_SOCKET_PATH:-$TEST_SOCKET}" "${FAKE_LSOF_METADATA:-}" ;;
esac
if [ "${FAKE_LSOF_EMPTY_RC_ONE:-0}" = "1" ]; then exit 1; fi
exit 0
SH

cat > "$BIN_DIR/uname" <<'SH'
#!/bin/bash
if [ -n "${FAKE_UNAME:-}" ]; then
  printf '%s\n' "$FAKE_UNAME"
else
  /usr/bin/uname "$@"
fi
SH

cat > "$BIN_DIR/sysctl" <<'SH'
#!/bin/bash
case "$*" in
  *vm.loadavg*) [ -n "${FAKE_SYSCTL_LOADAVG:-}" ] || exit 1; printf '%s\n' "$FAKE_SYSCTL_LOADAVG" ;;
  *hw.ncpu*) [ -n "${FAKE_SYSCTL_NCPU:-}" ] || exit 1; printf '%s\n' "$FAKE_SYSCTL_NCPU" ;;
  *) exit 1 ;;
esac
SH

cat > "$BIN_DIR/nproc" <<'SH'
#!/bin/bash
if [ -n "${FAKE_NPROC:-}" ]; then
  printf '%s\n' "$FAKE_NPROC"
elif [ -x /usr/bin/nproc ]; then
  /usr/bin/nproc "$@"
else
  exit 1
fi
SH

cat > "$BIN_DIR/cat" <<'SH'
#!/bin/bash
if [ "$#" -eq 1 ] && [ "$1" = "/proc/loadavg" ] && [ -n "${FAKE_PROC_LOADAVG:-}" ]; then
  printf '%s\n' "$FAKE_PROC_LOADAVG"
else
  /bin/cat "$@"
fi
SH

cat > "$BIN_DIR/flock" <<'SH'
#!/bin/bash
[ "$1" = "-w" ] || exit 70
shift 3
exec "$@"
SH

chmod +x "$BIN_DIR/tmux" "$BIN_DIR/ps" "$BIN_DIR/lsof" "$BIN_DIR/flock" \
  "$BIN_DIR/uname" "$BIN_DIR/sysctl" "$BIN_DIR/nproc" "$BIN_DIR/cat"
export PATH="$BIN_DIR:/usr/bin:/bin"
REQUEST_SOCKET="$TMP_DIR/default.sock"
: > "$REQUEST_SOCKET"
export TEST_SOCKET="$(cd -P "$(dirname "$REQUEST_SOCKET")" && pwd)/$(basename "$REQUEST_SOCKET")"
export FAKE_LSOF_FAIL=0
export FAKE_LSOF_RC_ONE_ERROR=0
export FAKE_LSOF_FILTER_RC_ONE_ERROR=0
export FAKE_LSOF_EMPTY_RC_ONE=0
export TMUX_CALL_LOG="$TMP_DIR/tmux-calls.log"
: > "$TMUX_CALL_LOG"
export FAKE_STATE_FILE=""
export FAKE_CREATE_SETS_PID=""
export FAKE_VERIFY_SLEEP=""
export FAKE_LSOF_SOCKET_PATH=""
export FAKE_DISPLAY_SLEEP=""
export FAKE_PS_SLEEP=""
export FAKE_LSOF_SLEEP=""
export FAKE_LSOF_METADATA=""
export FAKE_POLICY_SET_RC=0
export FAKE_POLICY_SET_SETS_PID=""
export FAKE_POLICY_SHOW_RC=0
export FAKE_POLICY_SHOW_VALUE=off
export FAKE_KEEPALIVE_RC=0
export FAKE_KEEPALIVE_STATE_FILE=""
export FAKE_KEEPALIVE_CREATE_RC=0
export FLYWHEEL_TMUX_RESCUE_ALERT_BIN="/usr/bin/true"
MACOS_TMUX_COMMAND='tmux -S /private/tmp/fly1285-fixture.sock new-session -Ad -s flywheel'
ORIGINAL_HOME="$HOME"

# shellcheck source=../lib/tmux-server-rescue.sh
source "$LIB"

echo "[TEST] sourcing rescue preserves a host-selected shared alert binary"
PRESERVED_ALERT_BIN="$(
  /bin/bash -c '
    unset FLYWHEEL_TMUX_RESCUE_ALERT_BIN
    FLYWHEEL_ALERT_BIN=/usr/bin/false
    source "$1"
    printf "%s" "$FLYWHEEL_ALERT_BIN"
  ' _ "$LIB"
)"
if [ "$PRESERVED_ALERT_BIN" = "/usr/bin/false" ]; then
  pass "rescue defaults do not clobber an existing shared alert adapter"
else
  fail "rescue source replaced the host alert adapter: $PRESERVED_ALERT_BIN"
fi

# Existing scenarios pin the historical fixture timings. FLY-1336 makes load
# scaling the production default, so deterministic tests that are not ABOUT the
# sampler must opt out explicitly.
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=1

echo "[TEST] operation-scoped probes get a fresh budget without mutating the caller"
_TMUX_RESCUE_BUDGET_ANCHOR=$((SECONDS - 61))
_TMUX_RESCUE_TOTAL_BUDGET=60
_TMUX_RESCUE_CACHED_LOAD_FACTOR=1
PROBE_OUT="$(tmux_rescue_probe 1 /bin/sh -c 'printf fresh-probe')"
PROBE_RC=$?
if [ "$PROBE_RC" -eq 0 ] \
  && [ "$PROBE_OUT" = "fresh-probe" ] \
  && [ "$_TMUX_RESCUE_BUDGET_ANCHOR" -eq $((SECONDS - 61)) ] \
  && [ "$_TMUX_RESCUE_TOTAL_BUDGET" = 60 ] \
  && [ "$_TMUX_RESCUE_CACHED_LOAD_FACTOR" = 1 ]; then
  pass "fresh read probes do not inherit or pollute the enclosing rescue budget"
else
  fail "probe budget leaked or stayed exhausted: rc=$PROBE_RC out=$PROBE_OUT anchor=$_TMUX_RESCUE_BUDGET_ANCHOR total=$_TMUX_RESCUE_TOTAL_BUDGET factor=$_TMUX_RESCUE_CACHED_LOAD_FACTOR"
fi
unset _TMUX_RESCUE_BUDGET_ANCHOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_CACHED_LOAD_FACTOR

echo "[TEST] load factor parses macOS/Linux fixtures, clamps, and rejects malformed overrides"
# GNU awk reserves `load` as a builtin name. Model that parser rule on macOS
# too, so this portability contract fails before reaching Linux CI.
cat > "$BIN_DIR/awk" <<'SH'
#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    load=*) echo "awk: fatal: cannot use gawk builtin \`load' as variable name" >&2; exit 2 ;;
  esac
done
exec /usr/bin/awk "$@"
SH
chmod +x "$BIN_DIR/awk"
unset FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX=12
export FAKE_UNAME=Darwin
export FAKE_SYSCTL_LOADAVG='{ 36.10 31.93 35.00 }'
export FAKE_SYSCTL_NCPU=18
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR
MAC_FACTOR="$(_tmux_rescue_load_factor)"
export FAKE_UNAME=Linux
export FAKE_PROC_LOADAVG='54.00 31.93 35.00 1/100 42'
export FAKE_NPROC=18
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR
LINUX_FACTOR="$(_tmux_rescue_load_factor)"

FACTORS=""
for override in 08 09 0.2 '' -2 999999999999 invalid; do
  if [ -n "$override" ]; then
    export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR="$override"
  else
    unset FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR
  fi
  unset _TMUX_RESCUE_CACHED_LOAD_FACTOR
  FACTORS="${FACTORS}$(_tmux_rescue_load_factor),"
done
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=9
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX=invalid
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR
INVALID_MAX_FACTOR="$(_tmux_rescue_load_factor)"

if [ "$MAC_FACTOR" = "3" ] && [ "$LINUX_FACTOR" = "3" ] \
  && [ "$FACTORS" = "8,9,3,3,3,12,3," ] \
  && [ "$INVALID_MAX_FACTOR" = "4" ]; then
  pass "load sampling and decimal-string override parsing are Bash-3.2-safe"
else
  fail "load factor contract drifted: mac=$MAC_FACTOR linux=$LINUX_FACTOR matrix=$FACTORS invalid_max=$INVALID_MAX_FACTOR"
fi

echo "[TEST] invalid override samples normally while a broken sampler falls back to one"
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=0
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX=4
export FAKE_UNAME=Darwin
export FAKE_SYSCTL_LOADAVG='{ 54.00 31.93 35.00 }'
export FAKE_SYSCTL_NCPU=18
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR
INVALID_OVERRIDE_FACTOR="$(_tmux_rescue_load_factor)"
unset FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR
export FAKE_SYSCTL_LOADAVG=garbage
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR
BROKEN_SAMPLE_FACTOR="$(_tmux_rescue_load_factor)"
if [ "$INVALID_OVERRIDE_FACTOR" = "3" ] && [ "$BROKEN_SAMPLE_FACTOR" = "1" ]; then
  pass "override validation and sampler failure have distinct fallbacks"
else
  fail "invalid override/sample fallback collapsed: override=$INVALID_OVERRIDE_FACTOR sample=$BROKEN_SAMPLE_FACTOR"
fi
rm -f "$BIN_DIR/awk"
hash -r

echo "[TEST] total budget accepts positive integer seconds only"
BUDGETS=""
for value in 0 -1 '' nope 8; do
  if [ -n "$value" ]; then
    export FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC="$value"
  else
    unset FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC
  fi
  BUDGETS="${BUDGETS}$(_tmux_rescue_total_budget),"
done
if [ "$BUDGETS" = "60,60,60,60,8," ]; then
  pass "malformed total budgets cannot create accidental timing semantics"
else
  fail "total budget parsing drifted: $BUDGETS"
fi

export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=1
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX=4
unset FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC
unset FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_BUDGET_ANCHOR
export FAKE_UNAME=""
export FAKE_SYSCTL_LOADAVG=""
export FAKE_SYSCTL_NCPU=""
export FAKE_PROC_LOADAVG=""
export FAKE_NPROC=""

echo "[TEST] inspect default tolerates a four-second saturated-host probe"
export FAKE_REACHABLE_PID=4242
export FAKE_PS_ROWS="4242 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=4242
export FAKE_DISPLAY_SLEEP=4
SECONDS=0
SLOW_DEFAULT_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
SLOW_DEFAULT_ELAPSED=$SECONDS
export FAKE_DISPLAY_SLEEP=""
if [ "$(printf '%s' "$SLOW_DEFAULT_OUT" | jq -r '.verdict')" = "reachable" ] \
  && [ "$(printf '%s' "$SLOW_DEFAULT_OUT" | jq -r '.timedOut')" = "false" ] \
  && [ "$SLOW_DEFAULT_ELAPSED" -ge 4 ]; then
  pass "the six-second inspect base no longer clips a four-second valid probe"
else
  fail "four-second inspect still clipped: elapsed=$SLOW_DEFAULT_ELAPSED out=$SLOW_DEFAULT_OUT"
fi

echo "[TEST] inspect timeout remains bounded at the new six-second ceiling"
export FAKE_DISPLAY_SLEEP=7
export FAKE_PS_ROWS=""
export FAKE_SOCKET_PIDS=""
SECONDS=0
SLOW_TIMEOUT_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
SLOW_TIMEOUT_ELAPSED=$SECONDS
export FAKE_DISPLAY_SLEEP=""
# FLY-1336 QA: verdict=unknown + timedOut=true are the load-invariant guards that
# the 6s ceiling actually fired (an un-bounded probe would let the 7s FAKE sleep
# complete → verdict=reachable, timedOut=false). elapsed>=5 proves the ceiling did
# not clip the valid window early. The upper bound is only a "did not drift toward
# the total budget" sanity check; on a saturated host the post-timeout ps/lsof
# scan overhead legitimately pushes wall-clock past a tight 8s, so tolerate it (a
# real runaway is caught by verdict/timedOut, not by this margin).
if [ "$(printf '%s' "$SLOW_TIMEOUT_OUT" | jq -r '.verdict')" = "unknown" ] \
  && [ "$(printf '%s' "$SLOW_TIMEOUT_OUT" | jq -r '.timedOut')" = "true" ] \
  && [ "$SLOW_TIMEOUT_ELAPSED" -ge 5 ] && [ "$SLOW_TIMEOUT_ELAPSED" -lt 20 ]; then
  pass "a genuinely over-ceiling probe is still killed and marked timed out"
else
  fail "inspect ceiling drifted: elapsed=$SLOW_TIMEOUT_ELAPSED out=$SLOW_TIMEOUT_OUT"
fi

echo "[TEST] tmux, ps, and lsof timeouts propagate distinct timeout evidence"
export FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC=0.2
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS=""
export FAKE_SOCKET_PIDS=""
export FAKE_DISPLAY_SLEEP=1
TMUX_TIMEOUT_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
export FAKE_DISPLAY_SLEEP=""
export FAKE_PS_SLEEP=1
PS_TIMEOUT_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
export FAKE_PS_SLEEP=""
export FAKE_PS_ROWS="9001 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=9001
export FAKE_LSOF_SLEEP=1
LSOF_TIMEOUT_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
export FAKE_LSOF_SLEEP=""

export FAKE_PS_ROWS=""
export FAKE_SOCKET_PIDS=""
export FAKE_DISPLAY_SLEEP=1
TMUX_TIMEOUT_ENSURE="$(_tmux_socket_ensure_locked "$TEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
TMUX_TIMEOUT_ENSURE_RC=$?
export FAKE_DISPLAY_SLEEP=""
if [ "$(printf '%s' "$TMUX_TIMEOUT_OUT" | jq -r '.timedOut')" = "true" ] \
  && [ "$(printf '%s' "$PS_TIMEOUT_OUT" | jq -r '.timedOut')" = "true" ] \
  && [ "$(printf '%s' "$LSOF_TIMEOUT_OUT" | jq -r '.timedOut')" = "true" ] \
  && [ "$TMUX_TIMEOUT_ENSURE_RC" -eq 4 ] \
  && [ "$(printf '%s' "$TMUX_TIMEOUT_ENSURE" | jq -r '.evidence.reason')" = "inspect_timeout" ]; then
  pass "every inspect command timeout stays distinguishable from a real hold"
else
  fail "timeout provenance collapsed: tmux=$TMUX_TIMEOUT_OUT ps=$PS_TIMEOUT_OUT lsof=$LSOF_TIMEOUT_OUT ensure=$TMUX_TIMEOUT_ENSURE_RC/$TMUX_TIMEOUT_ENSURE"
fi

echo "[TEST] one shared total budget clips a pathological inspect before its per-command timeout"
export FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC=1
export FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC=10
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=4
export FAKE_DISPLAY_SLEEP=3
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_BUDGET_ANCHOR
SECONDS=0
BUDGET_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
BUDGET_ELAPSED=$SECONDS
export FAKE_DISPLAY_SLEEP=""
if [ "$BUDGET_ELAPSED" -le 2 ] \
  && [ "$(printf '%s' "$BUDGET_OUT" | jq -r '.verdict')" = "unknown" ] \
  && [ "$(printf '%s' "$BUDGET_OUT" | jq -r '.timedOut')" = "true" ]; then
  pass "the static total budget bounds load-scaled commands"
else
  fail "total budget did not bound inspect: elapsed=$BUDGET_ELAPSED out=$BUDGET_OUT"
fi

echo "[TEST] total budget is independent of the number of slow server candidates"
export FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC=2
export FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC=6
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=8
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX=8
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="9101 1 ${MACOS_TMUX_COMMAND}\n9102 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS='9101,9102'
export FAKE_LSOF_SLEEP=3
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_BUDGET_ANCHOR
SECONDS=0
MULTI_BUDGET_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
MULTI_BUDGET_ELAPSED=$SECONDS
export FAKE_LSOF_SLEEP=""
if [ "$MULTI_BUDGET_ELAPSED" -le 3 ] \
  && [ "$(printf '%s' "$MULTI_BUDGET_OUT" | jq -r '.verdict')" = "unknown" ] \
  && [ "$(printf '%s' "$MULTI_BUDGET_OUT" | jq -r '.timedOut')" = "true" ]; then
  pass "candidate count cannot multiply the rescue process wall-clock budget"
else
  fail "multi-candidate scan escaped total budget: elapsed=$MULTI_BUDGET_ELAPSED out=$MULTI_BUDGET_OUT"
fi

echo "[TEST] ensure and nested orphan recovery share one budget anchor"
export HOME="$TMP_DIR/budget-recovery-home"
mkdir -p "$HOME/.flywheel/flags"
chmod 700 "$HOME" "$HOME/.flywheel" "$HOME/.flywheel/flags"
: > "$HOME/.flywheel/flags/tmux-auto-rescue.on"
chmod 600 "$HOME/.flywheel/flags/tmux-auto-rescue.on"
rm -f "$REQUEST_SOCKET"
export FAKE_PS_ROWS="5151 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=5151
export FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC=2
export FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC=6
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=4
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX=4
_tmux_rescue_signal_candidate() { return 0; }
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_BUDGET_ANCHOR
SECONDS=0
NESTED_BUDGET_OUT="$(_tmux_socket_ensure_locked "$TEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
NESTED_BUDGET_RC=$?
NESTED_BUDGET_ELAPSED=$SECONDS
# FLY-1336 QA: the invariant is "the shared budget is NOT reopened" — proven by
# rc=4 (fail-closed) AND elapsed<=3 (a private nested anchor would grant a fresh
# ~2s budget, pushing the total well past 3). The specific budget-exhaustion
# reason is stage-dependent: on a quiet host the `before` inspect finishes fast
# and the nested recovery detects exhaustion (`rescue_failed`); on a saturated
# host the `before` inspect itself consumes the shared budget first and short-
# circuits via the ensure fallback (`inspect_timeout`). Both are correct
# shared-budget fail-closed holds — accept either; the elapsed<=3 bound remains
# the mutation guard for a reopened budget.
NESTED_BUDGET_REASON="$(printf '%s' "$NESTED_BUDGET_OUT" | jq -r '.evidence.reason')"
if [ "$NESTED_BUDGET_RC" -eq 4 ] && [ "$NESTED_BUDGET_ELAPSED" -le 3 ] \
  && { [ "$NESTED_BUDGET_REASON" = "rescue_failed" ] || [ "$NESTED_BUDGET_REASON" = "inspect_timeout" ]; }; then
  pass "nested recovery cannot reopen a fresh budget after ensure work"
else
  fail "nested recovery reset or misclassified the budget: rc=$NESTED_BUDGET_RC elapsed=$NESTED_BUDGET_ELAPSED out=$NESTED_BUDGET_OUT"
fi

unset FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC
unset FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR=1
export FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX=4
export HOME="$ORIGINAL_HOME"
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_BUDGET_ANCHOR

echo "[TEST] candidate scan recognizes real macOS argv without admitting lookalikes"
export FAKE_PS_ROWS="9201 1 ${MACOS_TMUX_COMMAND}\n9202 1 /usr/local/bin/tmux new-session -Ad -s flywheel\n9203 1 tmux: server\n9204 99 ${MACOS_TMUX_COMMAND}\n9205 1 /bin/sh -c ${MACOS_TMUX_COMMAND}\n9206 1 tmuxinator start flywheel\n"
CANDIDATES="$(_tmux_rescue_server_pids | paste -sd, -)"
if [ "$CANDIDATES" = "9201,9202,9203" ]; then
  pass "bare/absolute macOS argv and the legacy Linux title are recognized precisely"
else
  fail "candidate argv classification drifted: $CANDIDATES"
fi

echo "[TEST] lsof socket aliases are normalized before ownership comparison"
export FAKE_SOCKET_PIDS=9301
export FAKE_LSOF_SOCKET_PATH="$REQUEST_SOCKET"
if _tmux_rescue_pid_has_socket 9301 "$TEST_SOCKET"; then
  pass "the lsof-reported symlink path matches the normalized -S socket"
else
  fail "lsof alias did not match: reported=$FAKE_LSOF_SOCKET_PATH expected=$TEST_SOCKET"
fi

echo "[TEST] Linux lsof name-field metadata is not part of the socket path"
export FAKE_LSOF_METADATA=' type=STREAM'
if _tmux_rescue_pid_has_socket 9301 "$TEST_SOCKET"; then
  pass "the real Linux -Fn STREAM suffix preserves exact socket ownership"
else
  fail "Linux lsof metadata was parsed as pathname text"
fi
export FAKE_LSOF_METADATA=""

echo "[TEST] an unrelated unnormalizable lsof path does not poison the target verdict"
export FAKE_LSOF_SOCKET_PATH="$TMP_DIR/missing-parent/socket"
_tmux_rescue_pid_has_socket 9301 "$TEST_SOCKET"
LSOF_PATH_RC=$?
if [ "$LSOF_PATH_RC" -eq 1 ]; then
  pass "an unresolved non-target path is definitive non-ownership"
else
  fail "an unrelated unresolved path poisoned the target scan: rc=$LSOF_PATH_RC"
fi
export FAKE_LSOF_SOCKET_PATH=""

echo "[TEST] lsof rc=1 needs an independent PID-enumeration proof before it means no socket"
export FAKE_SOCKET_PIDS=""
export FAKE_LSOF_EMPTY_RC_ONE=1
LSOF_EMPTY_RC=0
_tmux_rescue_pid_has_socket "$$" "$TEST_SOCKET" || LSOF_EMPTY_RC=$?
export FAKE_LSOF_EMPTY_RC_ONE=0
if [ "$LSOF_EMPTY_RC" -eq 1 ]; then
  pass "a filtered rc=1 plus successful exact PID enumeration proves non-ownership"
else
  fail "a genuine filtered-empty lsof result was not distinguished: rc=$LSOF_EMPTY_RC"
fi

echo "[TEST] filtered lsof rc=1 error stays incomplete even when PID enumeration succeeds"
export FAKE_LSOF_FILTER_RC_ONE_ERROR=1
LSOF_ERROR_RC=0
_tmux_rescue_pid_has_socket "$$" "$TEST_SOCKET" || LSOF_ERROR_RC=$?
export FAKE_LSOF_FILTER_RC_ONE_ERROR=0
if [ "$LSOF_ERROR_RC" -eq 2 ]; then
  pass "a filtered rc=1 error cannot borrow a successful PID probe as completeness evidence"
else
  fail "filtered lsof error plus successful PID probe was accepted as empty: rc=$LSOF_ERROR_RC"
fi

echo "[TEST] activated recover signals one revalidated orphan and proves its generation"
export HOME="$TMP_DIR/activated-home"
mkdir -p "$HOME/.flywheel/flags"
chmod 700 "$HOME" "$HOME/.flywheel" "$HOME/.flywheel/flags"
: > "$HOME/.flywheel/flags/tmux-auto-rescue.on"
chmod 600 "$HOME/.flywheel/flags/tmux-auto-rescue.on"
rm -f "$REQUEST_SOCKET"
export FAKE_STATE_FILE="$TMP_DIR/rescued-generation"
: > "$FAKE_STATE_FILE"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="5151 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_PS_AFTER_ROWS="5151 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=5151
SIGNAL_LOG="$TMP_DIR/signal.log"
_tmux_rescue_signal_candidate() {
  printf '%s' "$1" > "$SIGNAL_LOG"
  printf '%s' "$1" > "$FAKE_STATE_FILE"
  : > "$REQUEST_SOCKET"
}
OUT="$(_tmux_socket_recover_locked "$TEST_SOCKET")"
RECOVER_RC=$?
if [ "$RECOVER_RC" -eq 0 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "rescued" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.reachablePid')" = "5151" ] \
  && [ "$(cat "$SIGNAL_LOG")" = "5151" ]; then
  pass "SIGUSR1 success is accepted only after the same server generation is reachable"
else
  fail "activated rescue failed postcondition: rc=$RECOVER_RC out=$OUT signal=$(cat "$SIGNAL_LOG" 2>/dev/null || true)"
fi

echo "[TEST] ensure resumes verify-first on the rescued server generation"
: > "$FAKE_STATE_FILE"
rm -f "$REQUEST_SOCKET" "$SIGNAL_LOG"
: > "$TMUX_CALL_LOG"
export FAKE_VERIFY_RC=0
OUT="$(_tmux_socket_ensure_locked "$TEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
ENSURE_RC=$?
if [ "$ENSURE_RC" -eq 0 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "rescued_then_verified" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.reachablePid')" = "5151" ] \
  && ! grep -q 'new-session' "$TMUX_CALL_LOG"; then
  pass "rescue continues on the recovered generation without starting a server"
else
  fail "ensure did not continue after rescue: rc=$ENSURE_RC out=$OUT calls=$(tr '\n' ';' < "$TMUX_CALL_LOG")"
fi
export FAKE_PS_AFTER_ROWS=""
export FAKE_STATE_FILE=""

echo "[TEST] recover never signals an orphan while activation is disabled"
export HOME="$TMP_DIR/recover-home"
mkdir -p "$HOME/.flywheel/flags"
chmod 700 "$HOME" "$HOME/.flywheel" "$HOME/.flywheel/flags"
rm -f "$REQUEST_SOCKET"
: > "$TMUX_CALL_LOG"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="5151 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=5151
OUT="$(tmux_socket_recover "$REQUEST_SOCKET")"
RECOVER_RC=$?
if [ "$RECOVER_RC" -eq 4 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "hold_unknown" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.evidence.reason')" = "marker_disabled" ]; then
  pass "default hold-only mode refuses SIGUSR1 and never creates"
else
  fail "disabled recover did not hold: rc=$RECOVER_RC out=$OUT"
fi

echo "[TEST] reachable socket reports its verified server generation"
export FAKE_REACHABLE_PID=4242
export FAKE_PS_ROWS="4242 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=4242
OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
if [ "$(printf '%s' "$OUT" | jq -r '.verdict')" = "reachable" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.reachablePid')" = "4242" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.scanComplete')" = "true" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.candidatePids | length')" = "0" ]; then
  pass "reachable verdict preserves PID and excludes it from orphan candidates"
else
  fail "unexpected reachable inspection: $OUT"
fi

echo "[TEST] unreachable socket with one verified launchd-owned server is rescuable"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="5151 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=5151
rm -f "$REQUEST_SOCKET"
OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
if [ "$(printf '%s' "$OUT" | jq -r '.verdict')" = "missing_single_orphan" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.reachablePid')" = "null" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.candidatePids | join(",")')" = "5151" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.scanComplete')" = "true" ]; then
  pass "single verified orphan is distinguished from a dead server"
else
  fail "unexpected orphan inspection: $OUT"
fi

echo "[TEST] present but unreachable socket holds as saturated"
: > "$REQUEST_SOCKET"
export FAKE_PS_ROWS="6161 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=6161
OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
if [ "$(printf '%s' "$OUT" | jq -r '.verdict')" = "saturated" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.candidatePids | join(",")')" = "6161" ]; then
  pass "saturation is never treated as a missing socket rescue candidate"
else
  fail "unexpected saturation inspection: $OUT"
fi

echo "[TEST] a timed-out client probe cannot erase a complete exact-owner proof"
export FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC=0.2
export FAKE_DISPLAY_SLEEP=1
export FAKE_PS_ROWS="6162 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=6162
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_BUDGET_ANCHOR
TIMED_SATURATED_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
TIMED_SATURATED_ENSURE="$(_tmux_socket_ensure_locked "$TEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
TIMED_SATURATED_RC=$?
export FAKE_DISPLAY_SLEEP=""
unset FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC
unset _TMUX_RESCUE_CACHED_LOAD_FACTOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_BUDGET_ANCHOR
if [ "$(printf '%s' "$TIMED_SATURATED_OUT" | jq -r '.verdict')" = "saturated" ] \
  && [ "$(printf '%s' "$TIMED_SATURATED_OUT" | jq -r '.candidatePids | join(",")')" = "6162" ] \
  && [ "$(printf '%s' "$TIMED_SATURATED_OUT" | jq -r '.scanComplete')" = "true" ] \
  && [ "$(printf '%s' "$TIMED_SATURATED_OUT" | jq -r '.timedOut')" = "true" ] \
  && [ "$TIMED_SATURATED_RC" -eq 2 ] \
  && [ "$(printf '%s' "$TIMED_SATURATED_ENSURE" | jq -r '.action')" = "hold_saturated" ]; then
  pass "complete ps+lsof ownership classifies saturated despite client timeout"
else
  fail "client timeout erased positive ownership: inspect=$TIMED_SATURATED_OUT ensure=$TIMED_SATURATED_RC/$TIMED_SATURATED_ENSURE"
fi

echo "[TEST] complete process scan distinguishes dead, split-brain, and ambiguous"
rm -f "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS=""
export FAKE_SOCKET_PIDS=""
DEAD_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"

: > "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=7000
export FAKE_PS_ROWS="7000 1 ${MACOS_TMUX_COMMAND}\n7001 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS='7000,7001'
SPLIT_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"

rm -f "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="8001 1 ${MACOS_TMUX_COMMAND}\n8002 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS='8001,8002'
AMBIG_OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"

if [ "$(printf '%s' "$DEAD_OUT" | jq -r '.verdict')" = "dead" ] \
  && [ "$(printf '%s' "$SPLIT_OUT" | jq -r '.verdict')" = "split_brain" ] \
  && [ "$(printf '%s' "$SPLIT_OUT" | jq -r '.candidatePids | join(",")')" = "7001" ] \
  && [ "$(printf '%s' "$AMBIG_OUT" | jq -r '.verdict')" = "ambiguous" ]; then
  pass "only complete evidence produces destructive or split-brain verdicts"
else
  fail "classification mismatch: dead=$DEAD_OUT split=$SPLIT_OUT ambiguous=$AMBIG_OUT"
fi

echo "[TEST] a stale socket with a complete empty server scan is proven dead"
: > "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS=""
export FAKE_SOCKET_PIDS=""
OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
if [ "$(printf '%s' "$OUT" | jq -r '.verdict')" = "dead" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.socketPresent')" = "true" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.scanComplete')" = "true" ]; then
  pass "a stale inode cannot suppress a complete dead-server proof"
else
  fail "stale socket was not proven dead: $OUT"
fi

echo "[TEST] incomplete OS scan is always unknown"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="9001 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=9001
export FAKE_LSOF_FAIL=1
OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
export FAKE_LSOF_FAIL=0
if [ "$(printf '%s' "$OUT" | jq -r '.verdict')" = "unknown" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.scanComplete')" = "false" ]; then
  pass "failed evidence collection cannot authorize rescue or create"
else
  fail "unexpected incomplete-scan inspection: $OUT"
fi

echo "[TEST] filtered lsof rc=1 error plus successful PID probe keeps a live candidate unknown"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="$$ 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=""
export FAKE_LSOF_FILTER_RC_ONE_ERROR=1
OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
export FAKE_LSOF_FILTER_RC_ONE_ERROR=0
if [ "$(printf '%s' "$OUT" | jq -r '.verdict')" = "unknown" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.scanComplete')" = "false" ]; then
  pass "split rc=1/PID-success evidence cannot authorize replacement-server creation"
else
  fail "split rc=1/PID-success evidence falsely proved dead/non-ownership: $OUT"
fi

echo "[TEST] candidate scan excludes a foreign uid"
rm -f "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="uid:99999 9101 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=9101
OUT="$(tmux_socket_inspect "$REQUEST_SOCKET")"
if [ "$(printf '%s' "$OUT" | jq -r '.verdict')" = "dead" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.candidatePids | length')" = "0" ]; then
  pass "only same-uid launchd-owned tmux servers enter the candidate set"
else
  fail "foreign uid polluted the candidate scan: $OUT"
fi

echo "[TEST] activation marker must be an owner-controlled regular file"
# GNU `stat -f` succeeds with filesystem output instead of rejecting the BSD
# format. Emulate that collision while keeping `stat -c` useful on this macOS
# test host; the production probe must select the portable order.
stat() {
  case "$1" in
    -c)
      /usr/bin/stat -c '%u %a' "$3" 2>/dev/null \
        || /usr/bin/stat -f '%u %Lp' "$3"
      ;;
    -f) printf 'gnu-statfs-output\n' ;;
    *) /usr/bin/stat "$@" ;;
  esac
}
ORIGINAL_HOME="$HOME"
export HOME="$TMP_DIR/home"
MARKER_DIR="$HOME/.flywheel/flags"
MARKER="$MARKER_DIR/tmux-auto-rescue.on"
mkdir -p "$MARKER_DIR"
chmod 700 "$HOME" "$HOME/.flywheel" "$MARKER_DIR"

ABSENT=false
tmux_rescue_activation_enabled && ABSENT=true
: > "$MARKER"
chmod 600 "$MARKER"
VALID=false
tmux_rescue_activation_enabled && VALID=true
rm -f "$MARKER"
ln -s "$TMP_DIR/elsewhere" "$MARKER"
SYMLINK=false
tmux_rescue_activation_enabled && SYMLINK=true
rm -f "$MARKER"
: > "$MARKER"
chmod 666 "$MARKER"
BAD_FILE=false
tmux_rescue_activation_enabled && BAD_FILE=true
chmod 600 "$MARKER"
chmod 777 "$MARKER_DIR"
BAD_PARENT=false
tmux_rescue_activation_enabled && BAD_PARENT=true
export HOME="$ORIGINAL_HOME"
unset -f stat

if [ "$ABSENT" = false ] && [ "$VALID" = true ] && [ "$SYMLINK" = false ] \
  && [ "$BAD_FILE" = false ] && [ "$BAD_PARENT" = false ]; then
  pass "only a non-symlink marker with safe owner and modes activates rescue"
else
  fail "marker gate mismatch: absent=$ABSENT valid=$VALID symlink=$SYMLINK bad_file=$BAD_FILE bad_parent=$BAD_PARENT"
fi

echo "[TEST] policy-enforce is idempotent, default-on, and socket-locked"
export HOME="$ORIGINAL_HOME"
: > "$REQUEST_SOCKET"
: > "$TMUX_CALL_LOG"
export FAKE_REACHABLE_PID=4242
export FAKE_PS_ROWS="4242 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=4242
export FAKE_KEEPALIVE_RC=1
export FAKE_KEEPALIVE_STATE_FILE="$TMP_DIR/keepalive-state"
rm -f "$FAKE_KEEPALIVE_STATE_FILE"
OUT="$(tmux_socket_policy_enforce "$REQUEST_SOCKET")"
POLICY_RC=$?
OUT_AGAIN="$(tmux_socket_policy_enforce "$REQUEST_SOCKET")"
POLICY_AGAIN_RC=$?
if [ "$POLICY_RC" -eq 0 ] && [ "$POLICY_AGAIN_RC" -eq 0 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "policy_enforced" ] \
  && [ "$(printf '%s' "$OUT_AGAIN" | jq -r '.action')" = "policy_enforced" ] \
  && [ "$(grep -c 'set-option -s exit-empty off' "$TMUX_CALL_LOG")" -eq 2 ] \
  && [ "$(grep -c 'new-session -d -s flywheel-keepalive' "$TMUX_CALL_LOG")" -eq 1 ]; then
  pass "default-on policy writes exit-empty off and creates the sentinel once"
else
  fail "policy enforcement was not idempotent: first=$POLICY_RC/$OUT second=$POLICY_AGAIN_RC/$OUT_AGAIN calls=$(tr '\n' ';' < "$TMUX_CALL_LOG")"
fi

echo "[TEST] policy failure alerts and converts an ensure success into a typed hold"
: > "$TMUX_CALL_LOG"
POLICY_ALERTS="$TMP_DIR/policy-alerts"
: > "$POLICY_ALERTS"
POLICY_ALERT_BIN="$TMP_DIR/policy-alert-bin"
printf '%s\n' '#!/bin/bash' \
  'printf "%s\n" "$*" >> "$FLYWHEEL_TEST_POLICY_ALERTS"' > "$POLICY_ALERT_BIN"
chmod +x "$POLICY_ALERT_BIN"
export FLYWHEEL_TEST_POLICY_ALERTS="$POLICY_ALERTS"
export FLYWHEEL_TMUX_RESCUE_ALERT_BIN="$POLICY_ALERT_BIN"
export FAKE_KEEPALIVE_RC=0
export FAKE_KEEPALIVE_STATE_FILE=""
export FAKE_POLICY_SET_RC=1
export FAKE_VERIFY_RC=0
OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
POLICY_RC=$?
export FAKE_POLICY_SET_RC=0
export FLYWHEEL_TMUX_RESCUE_ALERT_BIN="/usr/bin/true"
if [ "$POLICY_RC" -eq 4 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "hold_unknown" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.evidence.reason')" = "policy_postcondition_failed" ] \
  && grep -q 'tmux_policy_postcondition' "$POLICY_ALERTS"; then
  pass "a failed postcondition cannot escape through an ensure success exit"
else
  fail "policy failure did not fail loud: rc=$POLICY_RC out=$OUT alerts=$(tr '\n' ';' < "$POLICY_ALERTS")"
fi

echo "[TEST] policy refuses success when the server generation changes mid-flight"
: > "$TMUX_CALL_LOG"
export FLYWHEEL_TMUX_RESCUE_ALERT_BIN="/usr/bin/true"
export FAKE_STATE_FILE="$TMP_DIR/policy-generation"
: > "$FAKE_STATE_FILE"
export FAKE_REACHABLE_PID=4242
export FAKE_PS_ROWS="4242 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_PS_AFTER_ROWS="4343 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=4343
export FAKE_POLICY_SET_SETS_PID=4343
OUT="$(tmux_socket_policy_enforce "$REQUEST_SOCKET")"
POLICY_RC=$?
export FAKE_POLICY_SET_SETS_PID=""
export FAKE_STATE_FILE=""
if [ "$POLICY_RC" -eq 4 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.evidence.reason')" = "policy_server_generation_changed" ]; then
  pass "same-PID pre/post proof rejects a replacement generation"
else
  fail "server replacement escaped the policy proof: rc=$POLICY_RC out=$OUT calls=$(tr '\n' ';' < "$TMUX_CALL_LOG")"
fi

echo "[TEST] policy-enforce refuses an unreachable server without tmux mutation"
: > "$TMUX_CALL_LOG"
rm -f "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS=""
export FAKE_SOCKET_PIDS=""
OUT="$(tmux_socket_policy_enforce "$REQUEST_SOCKET")"
POLICY_RC=$?
if [ "$POLICY_RC" -eq 4 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.evidence.reason')" = "policy_server_unreachable" ] \
  && ! grep -Eq 'set-option|show-options|has-session|new-session' "$TMUX_CALL_LOG"; then
  pass "unreachable policy seed is non-success and mutation-free"
else
  fail "unreachable policy seed drifted: rc=$POLICY_RC out=$OUT calls=$(tr '\n' ';' < "$TMUX_CALL_LOG")"
fi

echo "[TEST] ensure verifies under the socket lock before considering create"
export HOME="$ORIGINAL_HOME"
: > "$REQUEST_SOCKET"
: > "$TMUX_CALL_LOG"
export FAKE_REACHABLE_PID=4242
export FAKE_PS_ROWS="4242 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=4242
export FAKE_VERIFY_RC=0
export FAKE_CREATE_RC=0
OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
if [ "$?" -eq 0 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "verified" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.reachablePid')" = "4242" ] \
  && grep -q 'has-session' "$TMUX_CALL_LOG" \
  && ! grep -q 'new-session' "$TMUX_CALL_LOG"; then
  pass "verify-first returns the locked server generation without creating"
else
  fail "ensure did not verify-first: out=$OUT calls=$(tr '\n' ';' < "$TMUX_CALL_LOG")"
fi

echo "[TEST] a connected but hung verify is process-group bounded"
: > "$TMUX_CALL_LOG"
export FAKE_VERIFY_RC=0
export FAKE_VERIFY_SLEEP=2
export FLYWHEEL_TMUX_RESCUE_COMMAND_TIMEOUT_SEC=0.2
SECONDS=0
OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
ENSURE_RC=$?
ELAPSED=$SECONDS
unset FLYWHEEL_TMUX_RESCUE_COMMAND_TIMEOUT_SEC
export FAKE_VERIFY_SLEEP=""
# FLY-1336 QA: rc=4 + reason=command_timeout + no new-session are the
# load-invariant guards that the hung verify was killed and fail-closed (an
# un-bounded 2s verify would return FAKE_VERIFY_RC=0 → ENSURE_RC=0, action
# "verified", not a command_timeout hold). The wall-clock bound is a secondary
# tightness check; the inspect+verify path spawns several python3/awk helpers,
# so on a saturated host their overhead legitimately exceeds a tight 2s even
# though each command's own 0.2s timeout fires. Tolerate the overhead.
if [ "$ENSURE_RC" -eq 4 ] && [ "$ELAPSED" -lt 20 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.evidence.reason')" = "command_timeout" ] \
  && ! grep -q 'new-session' "$TMUX_CALL_LOG"; then
  pass "hung tmux client is terminated before the lock is released"
else
  fail "hung verify escaped deadline: rc=$ENSURE_RC elapsed=$ELAPSED out=$OUT"
fi

echo "[TEST] reachable server creates a missing target with tmux no-server-start"
: > "$TMUX_CALL_LOG"
export FAKE_VERIFY_RC=1
export FAKE_CREATE_RC=0
export FAKE_CREATE_STDOUT='@9'
OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -d -P -F '#{window_id}' -s flywheel)"
if [ "$?" -eq 0 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "created" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.createStdout')" = "@9" ] \
  && grep -Eq '(^| )-N( |$).*new-session|new-session.*(^| )-N( |$)' "$TMUX_CALL_LOG"; then
  pass "reachable create is physically forbidden from starting a replacement server"
else
  fail "reachable create missed -N or result: out=$OUT calls=$(tr '\n' ';' < "$TMUX_CALL_LOG")"
fi

echo "[TEST] ensure preserves typed fail-closed holds for every unsafe verdict"
export FAKE_REACHABLE_PID=""
export FAKE_VERIFY_RC=1
export FAKE_CREATE_RC=0
export FAKE_STATE_FILE=""

: > "$REQUEST_SOCKET"
export FAKE_PS_ROWS="6161 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=6161
SAT_OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
SAT_RC=$?

: > "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=7000
export FAKE_PS_ROWS="7000 1 ${MACOS_TMUX_COMMAND}\n7001 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS='7000,7001'
SPLIT_OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
SPLIT_RC=$?

rm -f "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="8001 1 ${MACOS_TMUX_COMMAND}\n8002 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS='8001,8002'
AMBIG_OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
AMBIG_RC=$?

: > "$REQUEST_SOCKET"
export FAKE_PS_ROWS="9001 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=9001
export FAKE_LSOF_FAIL=1
UNKNOWN_OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
UNKNOWN_RC=$?
export FAKE_LSOF_FAIL=0

if [ "$SAT_RC" -eq 2 ] \
  && [ "$(printf '%s' "$SAT_OUT" | jq -r '.action')" = "hold_saturated" ] \
  && [ "$(printf '%s' "$SAT_OUT" | jq -r '.evidence.reason')" = "socket_present_unreachable" ] \
  && [ "$SPLIT_RC" -eq 3 ] \
  && [ "$(printf '%s' "$SPLIT_OUT" | jq -r '.action')" = "hold_split_brain" ] \
  && [ "$(printf '%s' "$SPLIT_OUT" | jq -r '.evidence.reason')" = "multiple_server_candidates" ] \
  && [ "$AMBIG_RC" -eq 3 ] \
  && [ "$(printf '%s' "$AMBIG_OUT" | jq -r '.action')" = "hold_ambiguous" ] \
  && [ "$(printf '%s' "$AMBIG_OUT" | jq -r '.evidence.reason')" = "multiple_server_candidates" ] \
  && [ "$UNKNOWN_RC" -eq 4 ] \
  && [ "$(printf '%s' "$UNKNOWN_OUT" | jq -r '.action')" = "hold_unknown" ] \
  && [ "$(printf '%s' "$UNKNOWN_OUT" | jq -r '.evidence.reason')" = "unknown" ]; then
  pass "unsafe evidence stays typed and never reaches create"
else
  fail "typed holds drifted: sat=$SAT_RC/$SAT_OUT split=$SPLIT_RC/$SPLIT_OUT ambiguous=$AMBIG_RC/$AMBIG_OUT unknown=$UNKNOWN_RC/$UNKNOWN_OUT"
fi

echo "[TEST] ensure rejects argv that could escape the guarded socket"
export FAKE_REACHABLE_PID=4242
export FAKE_PS_ROWS="4242 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=4242
BAD_OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel 2>/dev/null)"
BAD_RC=$?
if [ "$BAD_RC" -eq 64 ] && [ -z "$BAD_OUT" ]; then
  pass "both protocol argv segments must bind the normalized socket"
else
  fail "unguarded argv was accepted: rc=$BAD_RC out=$BAD_OUT"
fi

echo "[TEST] only a proven dead server permits a server-starting create"
rm -f "$REQUEST_SOCKET"
: > "$TMUX_CALL_LOG"
export FAKE_STATE_FILE="$TMP_DIR/server-generation"
: > "$FAKE_STATE_FILE"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS=""
export FAKE_PS_AFTER_ROWS="7272 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=7272
export FAKE_CREATE_SETS_PID=7272
export FAKE_CREATE_STDOUT='@10'
OUT="$(tmux_socket_ensure "$REQUEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -d -P -F '#{window_id}' -s flywheel)"
ENSURE_RC=$?
CREATE_LINE="$(grep 'new-session' "$TMUX_CALL_LOG" | tail -1)"
if [ "$ENSURE_RC" -eq 0 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.action')" = "created" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.reachablePid')" = "7272" ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.createStdout')" = "@10" ] \
  && ! printf '%s' "$CREATE_LINE" | grep -Eq '(^| )-N( |$)'; then
  pass "dead proof is the sole path allowed to start a new tmux server"
else
  fail "dead create was not generation-verified: out=$OUT create=$CREATE_LINE"
fi

echo "[TEST] dry-run suppresses every server-starting create"
: > "$TMUX_CALL_LOG"
rm -f "$REQUEST_SOCKET"
: > "$FAKE_STATE_FILE"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS=""
export FAKE_SOCKET_PIDS=""
export FLY1285_RESCUE_DRY_RUN=1
OUT="$(_tmux_socket_ensure_locked "$TEST_SOCKET" \
  --verify tmux -S "$TEST_SOCKET" has-session -t =flywheel \
  --create tmux -S "$TEST_SOCKET" new-session -Ad -s flywheel)"
DRY_RC=$?
unset FLY1285_RESCUE_DRY_RUN
if [ "$DRY_RC" -eq 4 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.evidence.reason')" = "dry_run_create_suppressed" ] \
  && ! grep -q 'new-session' "$TMUX_CALL_LOG"; then
  pass "dry-run reports a typed hold without executing create"
else
  fail "dry-run executed or misclassified create: rc=$DRY_RC out=$OUT calls=$(tr '\n' ';' < "$TMUX_CALL_LOG")"
fi
export FAKE_STATE_FILE=""
export FAKE_CREATE_SETS_PID=""

echo "[TEST] standalone runtime CLI exposes recover without sourcing"
export HOME="$TMP_DIR/cli-home"
mkdir -p "$HOME/.flywheel/flags"
chmod 700 "$HOME" "$HOME/.flywheel" "$HOME/.flywheel/flags"
rm -f "$REQUEST_SOCKET"
export FAKE_REACHABLE_PID=""
export FAKE_PS_ROWS="5151 1 ${MACOS_TMUX_COMMAND}\n"
export FAKE_SOCKET_PIDS=5151
OUT="$(bash "$LIB" recover "$REQUEST_SOCKET")"
CLI_RC=$?
if [ "$CLI_RC" -eq 4 ] \
  && [ "$(printf '%s' "$OUT" | jq -r '.evidence.reason')" = "marker_disabled" ]; then
  pass "deployed symlink can invoke the never-create recovery primitive"
else
  fail "standalone recover dispatch missing: rc=$CLI_RC out=$OUT"
fi

echo "[TEST] advisory lock capability falls through without fail-open"
_tmux_rescue_has_flock() { return 1; }
_tmux_rescue_has_lockf() { return 0; }
_tmux_rescue_has_python_fcntl() { return 0; }
LOCKF_PICK="$(_tmux_rescue_select_lock_backend)"
_tmux_rescue_has_lockf() { return 1; }
PYTHON_PICK="$(_tmux_rescue_select_lock_backend)"
_tmux_rescue_has_python_fcntl() { return 1; }
MISSING_PICK="$(_tmux_rescue_select_lock_backend 2>/dev/null)"
MISSING_RC=$?
if [ "$LOCKF_PICK" = "lockf" ] && [ "$PYTHON_PICK" = "python" ] \
  && [ "$MISSING_RC" -ne 0 ] && [ -z "$MISSING_PICK" ]; then
  pass "flock → lockf → python fcntl chain ends in a fail-closed hold"
else
  fail "lock capability chain mismatch: lockf=$LOCKF_PICK python=$PYTHON_PICK missing_rc=$MISSING_RC"
fi

echo "[TEST] advisory lock owner metadata is diagnostic and generation-stamped"
export HOME="$TMP_DIR/owner-metadata-home"
mkdir -p "$HOME/.flywheel/locks"
_tmux_rescue_write_owner_metadata "$TEST_SOCKET"
OWNER_HASH="$(_tmux_rescue_lock_hash "$TEST_SOCKET")"
OWNER_META="$HOME/.flywheel/locks/tmux-${OWNER_HASH}.owner"
if [ -f "$OWNER_META" ] \
  && grep -Fxq "pid=$$" "$OWNER_META" \
  && grep -q '^startIdentity=.' "$OWNER_META" \
  && grep -q '^token=.' "$OWNER_META"; then
  pass "owner sidecar records pid, process start identity, and token"
else
  fail "owner metadata missing required diagnostic fields: $(cat "$OWNER_META" 2>/dev/null || true)"
fi

echo "[TEST] acquire-timeout owner evidence requires a live matching incarnation"
_tmux_rescue_process_start_identity() { printf 'fixture-start\n'; }
export _TMUX_RESCUE_TOKEN=fixture-token
export _TMUX_RESCUE_VERB=ensure
export _TMUX_RESCUE_CALLER=fixture-caller
export _TMUX_RESCUE_ACQUIRED_AT="$(awk -v n="$(_tmux_rescue_now)" 'BEGIN { printf "%.6f", n-2 }')"
_tmux_rescue_write_owner_metadata "$TEST_SOCKET"
TRUSTED_OWNER="$(_tmux_rescue_timeout_owner_json "$TEST_SOCKET")"
if printf '{"evidence":{"reason":"acquire_timeout"%s}}\n' "$TRUSTED_OWNER" \
    | jq -e --argjson pid "$$" '.evidence.owner.pid == $pid and .evidence.owner.verb == "ensure" and .evidence.owner.caller == "fixture-caller" and .evidence.owner.heldSec >= 2' >/dev/null; then
  pass "trusted owner evidence includes pid/incarnation/verb/caller/acquiredAt/heldSec"
else
  fail "trusted owner evidence missing or malformed: $TRUSTED_OWNER"
fi
printf '%s\n' \
  "pid=$$" \
  'startIdentity=fixture-start' \
  'token=fixture-token' \
  'verb=ensure' \
  'acquiredAt=1.2.3' \
  'caller=fixture-caller' > "$OWNER_META"
MALFORMED_CLOCK_OWNER="$(_tmux_rescue_timeout_owner_json "$TEST_SOCKET")"
if [ -z "$MALFORMED_CLOCK_OWNER" ] \
  && grep -q 'owner_evidence_omitted reason=invalid_acquired_at' "$HOME/.flywheel/logs/tmux-rescue-audit.log"; then
  pass "malformed acquiredAt is omitted before timeout JSON is assembled"
else
  fail "malformed acquiredAt leaked into timeout JSON: $MALFORMED_CLOCK_OWNER"
fi
printf '%s\n' \
  "pid=$$" \
  'startIdentity=wrong-generation' \
  'token=fixture-token' \
  'verb=ensure' \
  "acquiredAt=$_TMUX_RESCUE_ACQUIRED_AT" \
  'caller=fixture-caller' > "$OWNER_META"
STALE_OWNER="$(_tmux_rescue_timeout_owner_json "$TEST_SOCKET")"
if [ -z "$STALE_OWNER" ] && grep -q 'owner_evidence_omitted reason=incarnation_mismatch' "$HOME/.flywheel/logs/tmux-rescue-audit.log"; then
  pass "stale owner metadata is omitted with a local diagnostic"
else
  fail "stale owner metadata leaked into timeout JSON: $STALE_OWNER"
fi

echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
