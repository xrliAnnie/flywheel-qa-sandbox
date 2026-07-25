#!/bin/bash
# FLY-1364 Fix G: real-lock timing, episode suppression, and abnormal exits.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/scripts/lib/tmux-server-rescue.sh"
TEST_ROOT="$(mktemp -d -t fly1364-rescue.XXXXXX)" || exit 1
trap 'rm -rf "$TEST_ROOT"' EXIT
export HOME="$TEST_ROOT/home"
mkdir -p "$HOME/.flywheel/locks" "$HOME/.flywheel/state" "$HOME/.flywheel/logs"

ALERTS="$TEST_ROOT/alerts"
LOCK_PROBES="$TEST_ROOT/lock-probes"
ALERT_BIN="$TEST_ROOT/alert-bin"
printf '%s\n' '#!/bin/bash' \
  '/usr/bin/python3 - "$FLYWHEEL_TEST_LOCK_FILE" "$FLYWHEEL_TEST_LOCK_PROBES" <<'"'"'PY'"'"'' \
  'import fcntl, os, sys' \
  'fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)' \
  'try:' \
  '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)' \
  '    result = "available"' \
  'except BlockingIOError:' \
  '    result = "held"' \
  'with open(sys.argv[2], "a", encoding="utf-8") as out:' \
  '    out.write(result + "\n")' \
  'PY' \
  'printf "%s\\n" "$*" >> "$FLYWHEEL_TEST_ALERTS"' > "$ALERT_BIN"
chmod +x "$ALERT_BIN"
export FLYWHEEL_TMUX_RESCUE_ALERT_BIN="$ALERT_BIN"
export FLYWHEEL_TEST_ALERTS="$ALERTS"
export FLYWHEEL_TEST_LOCK_PROBES="$LOCK_PROBES"
export FLYWHEEL_TMUX_RESCUE_HOLD_WARN_SEC=0.4
export FLYWHEEL_TMUX_RESCUE_NORMAL_STREAK=2

# shellcheck source=../lib/tmux-server-rescue.sh
source "$LIB"

# Production resolves this at the first instruction after the backend returns;
# tests inject it so release accounting is independent of host scheduling.
_tmux_rescue_release_now() {
  if [ -n "${FLYWHEEL_TEST_RELEASE_END:-}" ]; then
    printf '%s\n' "$FLYWHEEL_TEST_RELEASE_END"
  else
    _tmux_rescue_now
  fi
}

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "[TEST] ✓ $*"; }
bad() { FAIL=$((FAIL + 1)); echo "[TEST] ✗ $*" >&2; }

SOCKET="$TEST_ROOT/tmux.sock"
LOCK_FILE="$TEST_ROOT/rescue.lockf"
: > "$SOCKET"
: > "$LOCK_FILE"
export FLYWHEEL_TEST_LOCK_FILE="$LOCK_FILE"

CRITICAL="$TEST_ROOT/critical.sh"
printf '%s\n' '#!/bin/bash' \
  'source "$1"' \
  'if [ -n "${FLYWHEEL_TEST_FAKE_HOLD:-}" ]; then' \
  '  _tmux_rescue_now() {' \
  '    if mkdir "$FLYWHEEL_TEST_CLOCK_MARKER" 2>/dev/null; then printf "100.000000\\n"; else printf "%s\\n" "$FLYWHEEL_TEST_FAKE_END"; fi' \
  '  }' \
  'fi' \
  'case "$4" in' \
  '  kill-after-decision-prepare) _tmux_rescue_after_decision_prepare() { kill -KILL $$; } ;;' \
  '  kill-after-state-commit) _tmux_rescue_after_state_commit() { kill -KILL $$; } ;;' \
  'esac' \
  '_tmux_rescue_begin_acquisition "$2"' \
  'case "$4" in kill) kill -KILL $$ ;; *) sleep "$3" ;; esac' \
  '_tmux_rescue_finish_acquisition "$2" 0' > "$CRITICAL"
chmod +x "$CRITICAL"

HOLDER="$TEST_ROOT/holder.sh"
printf '%s\n' '#!/bin/bash' 'touch "$1"' 'sleep "$2"' > "$HOLDER"
chmod +x "$HOLDER"

OUTER_CRASH="$TEST_ROOT/outer-crash.sh"
printf '%s\n' '#!/bin/bash' \
  'source "$1"' \
  '_tmux_rescue_prepare_lock_instrumentation "$2" recover outer-crash-test "$3"' \
  'export FLYWHEEL_TEST_FAKE_HOLD=2' \
  'export FLYWHEEL_TEST_FAKE_END=102.000000' \
  'export FLYWHEEL_TEST_CLOCK_MARKER="$5/clock-${_TMUX_RESCUE_TOKEN}"' \
  '_tmux_rescue_python_lock 3 "$3" "$4" "$1" "$2" 0 normal' \
  'kill -KILL $$' > "$OUTER_CRASH"
chmod +x "$OUTER_CRASH"

run_instrumented() {
  local caller="$1" hold="$2" mode="${3:-normal}" fake_hold="${4:-}" fake_release_hold release_end rc=0
  fake_release_hold="${5:-$fake_hold}"
  _tmux_rescue_prepare_lock_instrumentation "$SOCKET" recover "$caller" "$LOCK_FILE"
  if [ -n "$fake_hold" ]; then
    export FLYWHEEL_TEST_FAKE_HOLD="$fake_hold"
    export FLYWHEEL_TEST_FAKE_END
    FLYWHEEL_TEST_FAKE_END="$(awk -v h="$fake_hold" 'BEGIN { printf "%.6f", 100+h }')"
    export FLYWHEEL_TEST_CLOCK_MARKER="$TEST_ROOT/clock-${_TMUX_RESCUE_TOKEN}"
    export FLYWHEEL_TEST_RELEASE_END
    FLYWHEEL_TEST_RELEASE_END="$(awk -v h="$fake_release_hold" 'BEGIN { printf "%.6f", 100+h }')"
  else
    unset FLYWHEEL_TEST_FAKE_HOLD FLYWHEEL_TEST_FAKE_END FLYWHEEL_TEST_CLOCK_MARKER FLYWHEEL_TEST_RELEASE_END
  fi
  _tmux_rescue_python_lock 3 "$LOCK_FILE" "$CRITICAL" "$LIB" "$SOCKET" "$hold" "$mode" || rc=$?
  release_end="$(_tmux_rescue_release_now 2>/dev/null || date +%s)"
  # Production replays older committed decisions only after this acquisition
  # proves the kernel lock was reached and released, and excludes its own
  # decision so ordinary classification still runs through _after_lock.
  if type _tmux_rescue_replay_pending_decisions >/dev/null 2>&1; then
    _tmux_rescue_replay_pending_decisions "$SOCKET" "$_TMUX_RESCUE_DECISION_FILE"
  fi
  _tmux_rescue_after_lock "$SOCKET" "$rc" "$release_end"
  unset FLYWHEEL_TEST_FAKE_HOLD FLYWHEEL_TEST_FAKE_END FLYWHEEL_TEST_CLOCK_MARKER FLYWHEEL_TEST_RELEASE_END
  return "$rc"
}

echo "[TEST] Bash 3.2 records the live outer process, not a command-substitution child"
_tmux_rescue_prepare_lock_instrumentation "$SOCKET" recover outer-pid-test "$LOCK_FILE"
RECORDED_OUTER_PID="$_TMUX_RESCUE_OUTER_PID"
RECORDED_OUTER_START="$_TMUX_RESCUE_OUTER_START_IDENTITY"
OBSERVED_OUTER_START="$(_tmux_rescue_process_start_identity "$RECORDED_OUTER_PID" || true)"
if kill -0 "$RECORDED_OUTER_PID" 2>/dev/null \
    && { [ -z "$RECORDED_OUTER_START" ] \
      || [ "$OBSERVED_OUTER_START" = "$RECORDED_OUTER_START" ]; }; then
  ok "outer delivery identity points at the still-live invocation incarnation"
else
  bad "outer delivery identity is already dead or unverifiable pid=$RECORDED_OUTER_PID recorded=[$RECORDED_OUTER_START] observed=[$OBSERVED_OUTER_START]"
fi

echo "[TEST] crash-stranded Bash 3.2 PID probes are swept safely and boundedly"
PROBE_DIR="$HOME/.flywheel/locks"
for i in $(seq 1 40); do
  printf '99999\n' > "$PROBE_DIR/.tmux-crash-${i}.outer-pid"
  touch -t 200001010000 "$PROBE_DIR/.tmux-crash-${i}.outer-pid"
done
printf '99999\n' > "$PROBE_DIR/.tmux-fresh.outer-pid"
printf 'keep\n' > "$PROBE_DIR/probe-symlink-target"
ln -s "$PROBE_DIR/probe-symlink-target" "$PROBE_DIR/.tmux-symlink.outer-pid"
printf '99999\n' > "$PROBE_DIR/.tmux-bad!token.outer-pid"
touch -t 200001010000 "$PROBE_DIR/.tmux-bad!token.outer-pid"
_tmux_rescue_prepare_lock_instrumentation "$SOCKET" recover probe-sweep-test "$LOCK_FILE"
REMAINING_OLD=$(find "$PROBE_DIR" -type f -name '.tmux-crash-*.outer-pid' | wc -l | tr -d ' ')
if [ "$REMAINING_OLD" = "8" ] \
    && [ -f "$PROBE_DIR/.tmux-fresh.outer-pid" ] \
    && [ -L "$PROBE_DIR/.tmux-symlink.outer-pid" ] \
    && [ -f "$PROBE_DIR/.tmux-bad!token.outer-pid" ]; then
  ok "one invocation removes at most 32 old valid probes and preserves fresh/symlink/malformed controls"
else
  bad "probe sweep was unbounded or unsafe remaining=$REMAINING_OLD"
fi
rm -f "$PROBE_DIR"/.tmux-crash-*.outer-pid "$PROBE_DIR/.tmux-fresh.outer-pid" \
  "$PROBE_DIR/.tmux-symlink.outer-pid" "$PROBE_DIR/.tmux-bad!token.outer-pid" \
  "$PROBE_DIR/probe-symlink-target"

echo "[TEST] lock wait is excluded from hold duration"
MARKER="$TEST_ROOT/holder-ready"
export FLYWHEEL_TMUX_RESCUE_HOLD_WARN_SEC=1
_tmux_rescue_python_lock 2 "$LOCK_FILE" "$HOLDER" "$MARKER" 1.2 &
HOLDER_PID=$!
for _ in $(seq 1 100); do [ -e "$MARKER" ] && break; sleep 0.01; done
# The holder's real sleep proves blocking semantics only. Hold classification is
# driven entirely by the injected acquisition/end timestamps so host load can
# never move this assertion across the threshold.
run_instrumented wait-exclusion 0 normal 0.05
WAIT_RC=$?
wait "$HOLDER_PID"
AUDIT="$HOME/.flywheel/logs/tmux-rescue-audit.log"
if [ "$WAIT_RC" -eq 0 ] && [ ! -s "$ALERTS" ] \
    && grep -q 'holdSec=0.050000.*caller=wait-exclusion.*shouldAlert=0' "$AUDIT"; then
  ok "a real long queue wait plus injected 50ms hold emits no alert"
else
  bad "queue wait leaked into injected hold classification rc=$WAIT_RC alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(tail -5 "$AUDIT" 2>/dev/null)"
fi
export FLYWHEEL_TMUX_RESCUE_HOLD_WARN_SEC=0.4

echo "[TEST] release-side clock includes instrumentation tail in hold classification"
: > "$ALERTS"
run_instrumented tail-accounting 0 normal 0.05 0.75
TAIL_RC=$?
if [ "$TAIL_RC" -eq 0 ] && [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "1" ] \
  && grep -q 'holdSec=0.750000.*caller=tail-accounting.*shouldAlert=1' "$AUDIT"; then
  ok "injected post-decision tail is charged through kernel-lock release"
else
  bad "release tail was under-reported rc=$TAIL_RC alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(tail -5 "$AUDIT" 2>/dev/null)"
fi

echo "[TEST] replay latency is excluded from the released lock hold"
: > "$ALERTS"
REPLAY_MARKER="$TEST_ROOT/replay-latency-marker"
rm -f "$REPLAY_MARKER"
(
  flock() { return 0; }
  _tmux_rescue_select_lock_backend() { printf 'flock'; }
  _tmux_rescue_prepare_lock_instrumentation() {
    _TMUX_RESCUE_TOKEN="replay-latency-token"
    _TMUX_RESCUE_VERB="recover"
    _TMUX_RESCUE_CALLER="replay-latency"
    _TMUX_RESCUE_SOCKET="$SOCKET"
    _TMUX_RESCUE_ACQUISITION_FILE="$TEST_ROOT/replay-latency.acquired"
    _TMUX_RESCUE_DECISION_FILE="$TEST_ROOT/replay-latency.decision"
    _TMUX_RESCUE_EPISODE_FILE="$TEST_ROOT/replay-latency.episode"
    _TMUX_RESCUE_TAIL_FILE="$TEST_ROOT/replay-latency.tail"
    printf '%s\n' \
      'token=replay-latency-token' \
      'acquiredAt=100.000000' \
      'verb=recover' \
      'caller=replay-latency' \
      'outerPid=999999' \
      'outerStartIdentity=test' > "$_TMUX_RESCUE_ACQUISITION_FILE"
    printf '%s\n' \
      'token=replay-latency-token' \
      'holdSec=0.050000' \
      'shouldAlert=0' \
      'episodeCounter=0' \
      'backendRc=0' \
      'stateCommitted=1' \
      'tailShouldAlert=0' \
      'tailEpisodeCounter=0' \
      'episodeState=normal' > "$_TMUX_RESCUE_DECISION_FILE"
  }
  _tmux_rescue_replay_pending_decisions() {
    touch "$REPLAY_MARKER"
  }
  _tmux_rescue_release_now() {
    if [ -e "$REPLAY_MARKER" ]; then
      printf '100.750000\n'
    else
      printf '100.050000\n'
    fi
  }
  _tmux_rescue_run_with_lock _recover_locked "$SOCKET"
)
REPLAY_LATENCY_RC=$?
if [ "$REPLAY_LATENCY_RC" -eq 0 ] && [ ! -s "$ALERTS" ] \
    && grep -q 'holdSec=0.050000.*caller=replay-latency.*shouldAlert=0' "$AUDIT"; then
  ok "a slow prior-decision replay cannot inflate the completed lock hold"
else
  bad "replay latency leaked into hold classification rc=$REPLAY_LATENCY_RC alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(tail -5 "$AUDIT" 2>/dev/null)"
fi

echo "[TEST] policy-enforce owns a distinct acquisition and long-hold episode"
: > "$ALERTS"
_tmux_rescue_prepare_lock_instrumentation "$SOCKET" policy-enforce policy-seed-test "$LOCK_FILE"
POLICY_TOKEN="$_TMUX_RESCUE_TOKEN"
POLICY_EPISODE_FILE="$_TMUX_RESCUE_EPISODE_FILE"
POLICY_VERB="$_TMUX_RESCUE_VERB"
export FLYWHEEL_TEST_FAKE_HOLD=2
export FLYWHEEL_TEST_FAKE_END=102.000000
export FLYWHEEL_TEST_CLOCK_MARKER="$TEST_ROOT/clock-${POLICY_TOKEN}"
_tmux_rescue_python_lock 3 "$LOCK_FILE" "$CRITICAL" "$LIB" "$SOCKET" 0 normal
POLICY_LOCK_RC=$?
POLICY_RELEASE_END="$(_tmux_rescue_release_now 2>/dev/null || date +%s)"
_tmux_rescue_after_lock "$SOCKET" "$POLICY_LOCK_RC" "$POLICY_RELEASE_END"
unset FLYWHEEL_TEST_FAKE_HOLD FLYWHEEL_TEST_FAKE_END FLYWHEEL_TEST_CLOCK_MARKER
if [ "$POLICY_LOCK_RC" -eq 0 ] \
  && [ "$POLICY_VERB" = "policy-enforce" ] \
  && [ -f "$POLICY_EPISODE_FILE" ] \
  && grep -q 'verb=policy-enforce.*caller=policy-seed-test' "$AUDIT" \
  && grep -q 'verb=policy-enforce.*caller=policy-seed-test' "$ALERTS"; then
  ok "policy seed receipts and alerts remain distinguishable from ensure/recover"
else
  bad "policy verb fell out of instrumentation rc=$POLICY_LOCK_RC verb=$POLICY_VERB alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(tail -5 "$AUDIT" 2>/dev/null)"
fi

echo "[TEST] release-tail episodes persist, suppress, recover, and increment"
: > "$ALERTS"
run_instrumented tail-episode 0 normal 0.05 0.75
run_instrumented tail-episode 0 normal 0.05 0.75
run_instrumented tail-episode 0 normal 0.05 0.05
run_instrumented tail-episode 0 normal 0.05 0.05
run_instrumented tail-episode 0 normal 0.05 0.75
if [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "2" ] \
    && grep -q 'episode=1' "$ALERTS" && grep -q 'episode=2' "$ALERTS"; then
  ok "tail-only overruns share durable episodes and re-arm monotonically"
else
  bad "tail episode state was not durable: alerts=$(tr '\n' ';' < "$ALERTS")"
fi

echo "[TEST] release-tail alert decision replays after a post-commit crash"
: > "$ALERTS"
export FLYWHEEL_TEST_TAIL_CRASH_AFTER_COMMIT=1
run_instrumented tail-commit-crash 0 normal 0.05 0.75
TAIL_CRASH_FIRST_ALERTS="$(wc -l < "$ALERTS" | tr -d ' ')"
unset FLYWHEEL_TEST_TAIL_CRASH_AFTER_COMMIT
run_instrumented tail-commit-crash 0 normal 0.05 0.75
if [ "$TAIL_CRASH_FIRST_ALERTS" = "0" ] \
    && [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "1" ] \
    && grep -q 'tail=1.*episode=1' "$ALERTS"; then
  ok "a committed tail episode remains replayable until its alert is attempted"
else
  bad "tail post-commit crash swallowed or prematurely emitted its alert: first=$TAIL_CRASH_FIRST_ALERTS alerts=$(tr '\n' ';' < "$ALERTS")"
fi

echo "[TEST] an unrelated main alert cannot acknowledge a pending tail replay"
: > "$ALERTS"
export FLYWHEEL_TEST_TAIL_CRASH_AFTER_COMMIT=1
run_instrumented tail-main-overlap 0 normal 0.05 0.75
unset FLYWHEEL_TEST_TAIL_CRASH_AFTER_COMMIT
# This invocation enters a main in-lock episode while the prior tail decision
# is still pending. It may emit only the main signature and must leave the tail
# pending for a later attempt.
run_instrumented tail-main-overlap 0 normal 0.75 0.75
run_instrumented tail-main-overlap 0 normal 0.05 0.05
if [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "2" ] \
    && [ "$(grep -c 'tail=1' "$ALERTS" || true)" = "1" ]; then
  ok "main and tail episodes are attempted independently across crash replay"
else
  bad "main alert discarded a pending tail replay: alerts=$(tr '\n' ';' < "$ALERTS")"
fi

echo "[TEST] one alert per episode, recovery re-arms a monotonic counter"
: > "$ALERTS"; : > "$LOCK_PROBES"
run_instrumented episode-test 0 normal 2
run_instrumented episode-test 0 normal 2
run_instrumented episode-test 0 normal 0
run_instrumented episode-test 0 normal 0
run_instrumented episode-test 0 normal 2
if [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "2" ] \
  && grep -q 'episode=1' "$ALERTS" && grep -q 'episode=2' "$ALERTS" \
  && [ "$(grep -c '^available$' "$LOCK_PROBES" || true)" = "2" ]; then
  ok "sustained holds suppress; recovery plus re-entry alerts after lock release"
else
  bad "episode state or post-release alert drifted: alerts=$(tr '\n' ';' < "$ALERTS") probes=$(tr '\n' ';' < "$LOCK_PROBES")"
fi

echo "[TEST] SIGKILL after acquisition leaves state/counter untouched"
: > "$ALERTS"
STATE_BEFORE=$(find "$HOME/.flywheel/state" -type f -maxdepth 2 -print -exec shasum -a 256 {} \; 2>/dev/null | sort)
run_instrumented abnormal-test 0 kill
ABNORMAL_RC=$?
STATE_AFTER=$(find "$HOME/.flywheel/state" -type f -maxdepth 2 -print -exec shasum -a 256 {} \; 2>/dev/null | sort)
if [ "$ABNORMAL_RC" -eq 137 ] && [ "$STATE_BEFORE" = "$STATE_AFTER" ] \
  && [ ! -s "$ALERTS" ] && grep -q 'decision_missing_due_to_abnormal_exit' "$AUDIT"; then
  ok "abnormal in-lock exit is local-audit only and cannot invent a counter"
else
  bad "abnormal-exit contract drifted rc=$ABNORMAL_RC alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(cat "$AUDIT" 2>/dev/null)"
fi

echo "[TEST] SIGKILL after prepared decision leaves episode state untouched"
: > "$ALERTS"
STATE_BEFORE=$(find "$HOME/.flywheel/state" -type f -maxdepth 2 -print -exec shasum -a 256 {} \; 2>/dev/null | sort)
run_instrumented prepared-crash-test 0 kill-after-decision-prepare 2
PREPARED_RC=$?
STATE_AFTER=$(find "$HOME/.flywheel/state" -type f -maxdepth 2 -print -exec shasum -a 256 {} \; 2>/dev/null | sort)
if [ "$PREPARED_RC" -eq 137 ] && [ "$STATE_BEFORE" = "$STATE_AFTER" ] \
  && [ ! -s "$ALERTS" ] && grep -q 'decision_uncommitted_before_state' "$AUDIT"; then
  ok "prepared decision cannot masquerade as a committed episode transition"
else
  bad "prepared-decision crash drifted rc=$PREPARED_RC alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(tail -5 "$AUDIT" 2>/dev/null)"
fi

echo "[TEST] SIGKILL after episode commit recovers the prepared decision"
: > "$ALERTS"
run_instrumented committed-crash-test 0 kill-after-state-commit 2
COMMITTED_RC=$?
if [ "$COMMITTED_RC" -eq 137 ] \
  && [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "1" ] \
  && grep -q 'episode=1' "$ALERTS" && grep -q 'decision_commit_recovered' "$AUDIT"; then
  ok "committed episode transition retains its token-scoped alert decision"
else
  bad "post-state crash drifted rc=$COMMITTED_RC alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(tail -5 "$AUDIT" 2>/dev/null)"
fi

echo "[TEST] outer-process SIGKILL after lock release replays the committed main alert"
: > "$ALERTS"
OUTER_RC=0
"$OUTER_CRASH" "$LIB" "$SOCKET" "$LOCK_FILE" "$CRITICAL" "$TEST_ROOT" \
  >/dev/null 2>&1 || OUTER_RC=$?
PENDING_BEFORE=$(find "$HOME/.flywheel/locks" -type f -name '*.decision' | wc -l | tr -d ' ')
run_instrumented outer-crash-trigger 0 normal 0.05
REPLAY_RC=$?
PENDING_AFTER=$(find "$HOME/.flywheel/locks" -type f -name '*.decision' | wc -l | tr -d ' ')
if [ "$OUTER_RC" -eq 137 ] && [ "$PENDING_BEFORE" -eq 1 ] \
  && [ "$REPLAY_RC" -eq 0 ] && [ "$PENDING_AFTER" -eq 0 ] \
  && [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "1" ] \
  && grep -q 'caller=outer-crash-test' "$ALERTS" \
  && grep -q 'episode=1' "$ALERTS" \
  && grep -q 'pending_decision_replayed' "$AUDIT"; then
  ok "a later lock holder replays and acknowledges the exact committed decision"
else
  bad "outer-crash replay drifted outer=$OUTER_RC replay=$REPLAY_RC pending=$PENDING_BEFORE/$PENDING_AFTER alerts=$(cat "$ALERTS" 2>/dev/null) audit=$(tail -8 "$AUDIT" 2>/dev/null)"
fi

echo "[TEST] concurrent contenders share the in-lock episode upper bound repeatedly"
: > "$LOCK_PROBES"
CONCURRENT_RC=0
for round in 1 2 3 4; do
  : > "$ALERTS"
  PIDS=""
  for i in 1 2 3 4 5; do
    (run_instrumented "concurrent-test-${round}" 0 normal 2) &
    PIDS="$PIDS $!"
  done
  for pid in $PIDS; do wait "$pid" || CONCURRENT_RC=1; done
  [ "$(wc -l < "$ALERTS" | tr -d ' ')" = "1" ] || CONCURRENT_RC=1
done
if [ "$CONCURRENT_RC" -eq 0 ]; then
  ok "four independent five-contender episodes each emit exactly one alert"
else
  bad "a repeated concurrent episode lost or duplicated delivery rc=$CONCURRENT_RC alerts=$(tr '\n' ';' < "$ALERTS")"
fi

echo "[TEST] deployed script without alert library preserves verb stdout and rc"
DEPLOY="$TEST_ROOT/deployed"
mkdir -p "$DEPLOY"
ln -s "$LIB" "$DEPLOY/tmux-server-rescue"
MISSING_STDOUT="$TEST_ROOT/missing.stdout"
MISSING_STDERR="$TEST_ROOT/missing.stderr"
/bin/bash "$DEPLOY/tmux-server-rescue" inspect relative > "$MISSING_STDOUT" 2> "$MISSING_STDERR"
INSPECT_RC=$?
INSPECT_OUT="$(cat "$MISSING_STDOUT")"
/bin/bash "$DEPLOY/tmux-server-rescue" recover relative > "$MISSING_STDOUT" 2>> "$MISSING_STDERR"
RECOVER_RC=$?
RECOVER_OUT="$(cat "$MISSING_STDOUT")"
/bin/bash "$DEPLOY/tmux-server-rescue" ensure relative extra > "$MISSING_STDOUT" 2>> "$MISSING_STDERR"
ENSURE_RC=$?
ENSURE_OUT="$(cat "$MISSING_STDOUT")"
/bin/bash "$DEPLOY/tmux-server-rescue" policy-enforce relative > "$MISSING_STDOUT" 2>> "$MISSING_STDERR"
POLICY_RC=$?
POLICY_OUT="$(cat "$MISSING_STDOUT")"
if [ "$INSPECT_RC" -eq 0 ] \
  && [ "$INSPECT_OUT" = '{"verdict":"unknown","socketPresent":false,"socketPath":"","reachablePid":null,"candidatePids":[],"scanComplete":false,"timedOut":false}' ] \
  && [ "$RECOVER_RC" -eq 64 ] && [ -z "$RECOVER_OUT" ] \
  && [ "$ENSURE_RC" -eq 64 ] && [ -z "$ENSURE_OUT" ] \
  && [ "$POLICY_RC" -eq 64 ] && [ -z "$POLICY_OUT" ] \
  && [ "$(grep -c 'optional alert library unavailable' "$MISSING_STDERR" || true)" -eq 4 ]; then
  ok "inspect/recover/ensure/policy-enforce retain stdout and rc in the deploy gap"
else
  bad "missing-library verb contract drifted inspect=$INSPECT_RC/$INSPECT_OUT recover=$RECOVER_RC/$RECOVER_OUT ensure=$ENSURE_RC/$ENSURE_OUT policy=$POLICY_RC/$POLICY_OUT stderr=$(tr '\n' ';' < "$MISSING_STDERR")"
fi

echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
