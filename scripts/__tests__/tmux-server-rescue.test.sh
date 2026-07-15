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
[ "${FAKE_LSOF_FAIL:-0}" = "1" ] && exit 2
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then pid="$2"; break; fi
  shift
done
case ",${FAKE_SOCKET_PIDS:-}," in
  *",${pid},"*) echo "n${FAKE_LSOF_SOCKET_PATH:-$TEST_SOCKET}" ;;
esac
SH

cat > "$BIN_DIR/flock" <<'SH'
#!/bin/bash
[ "$1" = "-w" ] || exit 70
shift 3
exec "$@"
SH

chmod +x "$BIN_DIR/tmux" "$BIN_DIR/ps" "$BIN_DIR/lsof" "$BIN_DIR/flock"
export PATH="$BIN_DIR:/usr/bin:/bin"
REQUEST_SOCKET="$TMP_DIR/default.sock"
: > "$REQUEST_SOCKET"
export TEST_SOCKET="$(cd -P "$(dirname "$REQUEST_SOCKET")" && pwd)/$(basename "$REQUEST_SOCKET")"
export FAKE_LSOF_FAIL=0
export TMUX_CALL_LOG="$TMP_DIR/tmux-calls.log"
: > "$TMUX_CALL_LOG"
export FAKE_STATE_FILE=""
export FAKE_CREATE_SETS_PID=""
export FAKE_VERIFY_SLEEP=""
export FAKE_LSOF_SOCKET_PATH=""
MACOS_TMUX_COMMAND='tmux -S /private/tmp/fly1285-fixture.sock new-session -Ad -s flywheel'

# shellcheck source=../lib/tmux-server-rescue.sh
source "$LIB"

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

echo "[TEST] an unnormalizable lsof path is incomplete evidence, not proof of absence"
export FAKE_LSOF_SOCKET_PATH="$TMP_DIR/missing-parent/socket"
_tmux_rescue_pid_has_socket 9301 "$TEST_SOCKET"
LSOF_PATH_RC=$?
if [ "$LSOF_PATH_RC" -eq 2 ]; then
  pass "an unresolved owner path makes the process scan fail closed"
else
  fail "unresolved lsof path was treated as definitive non-ownership: rc=$LSOF_PATH_RC"
fi
export FAKE_LSOF_SOCKET_PATH=""

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

if [ "$ABSENT" = false ] && [ "$VALID" = true ] && [ "$SYMLINK" = false ] \
  && [ "$BAD_FILE" = false ] && [ "$BAD_PARENT" = false ]; then
  pass "only a non-symlink marker with safe owner and modes activates rescue"
else
  fail "marker gate mismatch: absent=$ABSENT valid=$VALID symlink=$SYMLINK bad_file=$BAD_FILE bad_parent=$BAD_PARENT"
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
if [ "$ENSURE_RC" -eq 4 ] && [ "$ELAPSED" -lt 2 ] \
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
  && [ "$SPLIT_RC" -eq 3 ] \
  && [ "$(printf '%s' "$SPLIT_OUT" | jq -r '.action')" = "hold_split_brain" ] \
  && [ "$AMBIG_RC" -eq 3 ] \
  && [ "$(printf '%s' "$AMBIG_OUT" | jq -r '.action')" = "hold_ambiguous" ] \
  && [ "$UNKNOWN_RC" -eq 4 ] \
  && [ "$(printf '%s' "$UNKNOWN_OUT" | jq -r '.action')" = "hold_unknown" ]; then
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

echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
