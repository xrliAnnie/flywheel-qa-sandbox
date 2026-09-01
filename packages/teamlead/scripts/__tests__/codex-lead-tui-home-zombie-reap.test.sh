#!/bin/bash
# FLY-1955 — stale zombie daemon recovery regression harness.
# shellcheck disable=SC2015,SC2016 # assertion idioms + inner bash source snippets are intentional

set -uo pipefail

# This harness runs inside Codex Lead panes too. Keep runner-owned daemon and
# alert overrides from escaping into fixture homes.
unset FLYWHEEL_CODEX_BIN FLYWHEEL_CODEX_LEAD_PROFILE FLYWHEEL_CODEX_TUI_HOME \
  FLYWHEEL_CODEX_TUI_CWD FLYWHEEL_LEAD_ALERT_SH FLYWHEEL_TUI_HOME_REEXEC

if [ "${FLY1955_ENV_ISOLATION_PROBE:-0}" = 1 ]; then
  [ -z "${FLYWHEEL_CODEX_BIN+x}" ] \
    && [ -z "${FLYWHEEL_CODEX_LEAD_PROFILE+x}" ] \
    && [ -z "${FLYWHEEL_LEAD_ALERT_SH+x}" ]
  exit
fi

PASS=0
FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/codex-lead-tui-home.sh"
TMP="$(mktemp -d /tmp/fly1955.XXXXX)"
OWNED_PIDS="$TMP/owned-pids"
: > "$OWNED_PIDS"
cleanup() {
  while IFS= read -r pid; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill "$pid" 2>/dev/null || true
  done < "$OWNED_PIDS"
  rm -rf "$TMP"
}
trap cleanup EXIT

MODERN_BASH=""
for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash /usr/bin/bash /bin/bash; do
  [ -x "$candidate" ] || continue
  if "$candidate" -c 'exit $(( ${BASH_VERSINFO:-0} < 4 ))' 2>/dev/null; then
    MODERN_BASH="$candidate"
    break
  fi
done
[ -n "$MODERN_BASH" ] || { echo "No bash >=4 found" >&2; exit 1; }

if FLY1955_ENV_ISOLATION_PROBE=1 \
  FLYWHEEL_CODEX_BIN=/production/codex \
  FLYWHEEL_CODEX_LEAD_PROFILE=full-access \
  FLYWHEEL_LEAD_ALERT_SH=/production/lead-alert.sh \
  "$MODERN_BASH" "$0"; then
  pass "hostile inherited Codex/alert env is isolated"
else
  fail "harness must isolate inherited Codex/alert env"
fi

# RED 1: the SUT must be sourceable so process probes can be replaced by the
# deterministic fault-injection cases below. Before FLY-1955, the unconditional
# dispatcher exits while sourcing.
if FLYWHEEL_CODEX_TUI_HOME="$TMP/source-home" "$MODERN_BASH" -c '
  source "$1"
  declare -F reap_zombie_daemon_if_proven >/dev/null
' _ "$SUT" >/dev/null 2>&1; then
  pass "SUT is sourceable and exposes the zombie recovery function"
else
  fail "SUT must be sourceable and expose reap_zombie_daemon_if_proven"
fi

# T0: every managed updater must inherit an install destination inside its own
# Lead home. Codex's native updater passes this through to install.sh; without
# it, install.sh defaults to the real $HOME/.local/bin and rewrites the global
# codex axis even when CODEX_HOME itself is an isolated experiment directory.
MISSING_HOME="$TMP/missing-standalone"
mkdir -p "$MISSING_HOME"
printf '%s\n' '{}' > "$MISSING_HOME/auth.json"
MISSING_OUTPUT="$(FLYWHEEL_CODEX_TUI_HOME="$MISSING_HOME" \
  FLYWHEEL_CODEX_TUI_CWD=/work "$MODERN_BASH" "$SUT" ensure-home 2>&1 || true)"
if grep -Fq "CODEX_INSTALL_DIR='$MISSING_HOME/.local/bin'" <<< "$MISSING_OUTPUT"; then
  pass "missing standalone instructions preserve the home-scoped install target"
else
  fail "missing standalone instructions must use the Lead-home install target"
fi

ISOLATED_USER_HOME="$TMP/updater-user"
ISOLATED_LEAD_HOME="$TMP/updater-lead"
ISOLATED_ENV_LOG="$TMP/updater-env.log"
mkdir -p "$ISOLATED_USER_HOME/.local/bin" "$ISOLATED_USER_HOME/neutral" \
  "$ISOLATED_LEAD_HOME/packages/standalone/current"
printf '#!/bin/sh\n' > "$ISOLATED_USER_HOME/neutral/codex"
chmod +x "$ISOLATED_USER_HOME/neutral/codex"
ln -s "$ISOLATED_USER_HOME/neutral/codex" "$ISOLATED_USER_HOME/.local/bin/codex"
cat > "$ISOLATED_LEAD_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
printf '%s|%s\n' "${CODEX_INSTALL_DIR:-}" "$CODEX_HOME" > "$ISOLATED_ENV_LOG"
mkdir -p "$CODEX_HOME/app-server-control"
python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
MOCK
chmod +x "$ISOLATED_LEAD_HOME/packages/standalone/current/codex"
GLOBAL_AXIS_BEFORE="$(readlink "$ISOLATED_USER_HOME/.local/bin/codex")"
if HOME="$ISOLATED_USER_HOME" FLYWHEEL_CODEX_TUI_HOME="$ISOLATED_LEAD_HOME" \
  ISOLATED_ENV_LOG="$ISOLATED_ENV_LOG" "$MODERN_BASH" "$SUT" ensure-daemon \
  >/dev/null 2>&1 \
  && [ "$(cat "$ISOLATED_ENV_LOG")" = "$ISOLATED_LEAD_HOME/.local/bin|$ISOLATED_LEAD_HOME" ] \
  && [ "$(readlink "$ISOLATED_USER_HOME/.local/bin/codex")" = "$GLOBAL_AXIS_BEFORE" ]; then
  pass "managed updater install target is home-scoped and global axis stays neutral"
else
  fail "managed updater must not inherit the real global install target"
fi

# T2: healthy companion and full-access behavior is byte-for-byte pinned before
# the recovery-only branch. No alert or process probe may run on this fast path.
golden_case() {
  local profile="$1" home="$TMP/golden-$1" log="$TMP/golden-$1.log"
  local out="$TMP/golden-$1.out" err="$TMP/golden-$1.err"
  mkdir -p "$home/packages/standalone/current"
  cat > "$home/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
echo "$@" >> "$MOCK_LOG"
if [ "$1 $2 $3" = "remote-control start --json" ]; then
  mkdir -p "$CODEX_HOME/app-server-control"
  python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
  echo '{"status":"connected"}'
fi
MOCK
  chmod +x "$home/packages/standalone/current/codex"
  if [ "$profile" = companion ]; then
    mkdir -p "$home/app-server-daemon"
    printf '%s\n' '{"pid":999999,"processStartTime":"Thu Jan  1 00:00:00 1970"}' \
      > "$home/app-server-daemon/app-server.pid"
  fi
  : > "$log"
  if [ "$profile" = full-access ]; then
    FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$home" MOCK_LOG="$log" \
      "$MODERN_BASH" "$SUT" ensure-daemon > "$out" 2> "$err"
    expected_commands=$'remote-control stop --json\nremote-control start --json'
    expected_stderr=$'[codex-lead-tui-home] stopped any running daemon so it re-reads the full-access config\n[codex-lead-tui-home] daemon OK: '"$home"'/app-server-control/app-server-control.sock'
  else
    FLYWHEEL_CODEX_TUI_HOME="$home" MOCK_LOG="$log" \
      "$MODERN_BASH" "$SUT" ensure-daemon > "$out" 2> "$err"
    expected_commands='remote-control start --json'
    expected_stderr='[codex-lead-tui-home] daemon OK: '"$home"'/app-server-control/app-server-control.sock'
  fi
  if [ "$(cat "$out")" = '{"status":"connected"}' ] \
    && [ "$(cat "$err")" = "$expected_stderr" ] \
    && [ "$(cat "$log")" = "$expected_commands" ] \
    && [ ! -e "$home/.flywheel-ensure-daemon-failcount" ]; then
    pass "healthy $profile path remains byte-for-byte compatible"
  else
    fail "healthy $profile golden drifted"
  fi
}
golden_case companion
golden_case full-access

# Rework RED: an unreadable auth snapshot cannot justify an auth or zombie
# diagnosis, but it must still park the hot loop and explain the uncertainty in
# the third-failure safety-net alert without changing the integer counter.
SNAPSHOT_HOME="$TMP/snapshot-unavailable-home"
SNAPSHOT_ALERT_LOG="$TMP/snapshot-unavailable-alert.log"
SNAPSHOT_SLEEP_LOG="$TMP/snapshot-unavailable-sleep.log"
SNAPSHOT_ERR="$TMP/snapshot-unavailable.err"
mkdir -p "$SNAPSHOT_HOME/packages/standalone/current" \
  "$SNAPSHOT_HOME/app-server-daemon/app-server.stderr.log"
printf '%s\n' 2 > "$SNAPSHOT_HOME/.flywheel-ensure-daemon-failcount"
cat > "$SNAPSHOT_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
exit 1
MOCK
chmod +x "$SNAPSHOT_HOME/packages/standalone/current/codex"
: > "$SNAPSHOT_ALERT_LOG"
: > "$SNAPSHOT_SLEEP_LOG"
if FLYWHEEL_CODEX_TUI_HOME="$SNAPSHOT_HOME" SNAPSHOT_ALERT_LOG="$SNAPSHOT_ALERT_LOG" \
  SNAPSHOT_SLEEP_LOG="$SNAPSHOT_SLEEP_LOG" "$MODERN_BASH" -c '
    source "$1"
    emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$SNAPSHOT_ALERT_LOG"; }
    fly1955_sleep() { echo "$1" >> "$SNAPSHOT_SLEEP_LOG"; }
    fly1955_ps() { echo 4242; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2> "$SNAPSHOT_ERR"; then
  fail "snapshot-unavailable ensure must fail loud after bounded parking"
else
  snapshot_slices="$(grep -c '^30$' "$SNAPSHOT_SLEEP_LOG" || true)"
  if [ "$snapshot_slices" -eq 30 ] \
    && [ "$(cat "$SNAPSHOT_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 3 ] \
    && [ "$(grep -c '^crash_loop|severe|fly1955-ensure-daemon-failing|' "$SNAPSHOT_ALERT_LOG" || true)" -eq 1 ] \
    && grep -q 'reason=snapshot_unavailable' "$SNAPSHOT_ALERT_LOG" \
    && ! grep -q 'stale-daemon' "$SNAPSHOT_ALERT_LOG" \
    && ! grep -q '^login_expired|' "$SNAPSHOT_ALERT_LOG" \
    && grep -q 'snapshot unavailable' "$SNAPSHOT_ERR"; then
    pass "snapshot-unavailable failure parks and reports an honest third-failure reason"
  else
    fail "snapshot-unavailable failure must park and avoid a stale-daemon diagnosis"
  fi
fi

# A1 RED: production auth-dead rewrites app-server.stderr.log in place. Only
# bytes written by this start attempt may classify the failure, and the alert
# must carry the fixed matched code rather than the untrusted log line.
AUTH_HOME="$TMP/auth-truncate-home"
AUTH_START_LOG="$TMP/auth-truncate-start.log"
AUTH_ALERT_LOG="$TMP/auth-truncate-alert.log"
AUTH_SLEEP_LOG="$TMP/auth-truncate-sleep.log"
AUTH_KILL_LOG="$TMP/auth-truncate-kill.log"
AUTH_ERR="$TMP/auth-truncate.err"
mkdir -p "$AUTH_HOME/packages/standalone/current" "$AUTH_HOME/app-server-daemon"
printf '%s\n' 'old daemon stderr' > "$AUTH_HOME/app-server-daemon/app-server.stderr.log"
cat > "$AUTH_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
echo "$@" >> "$AUTH_START_LOG"
if [ "$1 $2 $3" = "remote-control start --json" ]; then
  : > "$CODEX_HOME/app-server-daemon/app-server.stderr.log"
  printf '%s\n' 'token_revoked sensitive-log-context' \
    > "$CODEX_HOME/app-server-daemon/app-server.stderr.log"
  mkdir -p "$CODEX_HOME/app-server-control"
  if [ ! -S "$CODEX_HOME/app-server-control/app-server-control.sock" ]; then
    python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
  fi
fi
exit 1
MOCK
chmod +x "$AUTH_HOME/packages/standalone/current/codex"
: > "$AUTH_START_LOG"
: > "$AUTH_ALERT_LOG"
: > "$AUTH_SLEEP_LOG"
: > "$AUTH_KILL_LOG"
if FLYWHEEL_CODEX_TUI_HOME="$AUTH_HOME" AUTH_START_LOG="$AUTH_START_LOG" \
  AUTH_ALERT_LOG="$AUTH_ALERT_LOG" AUTH_SLEEP_LOG="$AUTH_SLEEP_LOG" \
  AUTH_KILL_LOG="$AUTH_KILL_LOG" "$MODERN_BASH" -c '
    source "$1"
    emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$AUTH_ALERT_LOG"; }
    fly1955_sleep() { echo "$1" >> "$AUTH_SLEEP_LOG"; }
    fly1955_ps() { echo 4242; }
    fly1955_kill() { echo "$*" >> "$AUTH_KILL_LOG"; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2> "$AUTH_ERR"; then
  fail "auth-dead ensure must fail loud after bounded parking"
else
  auth_starts="$(grep -c '^remote-control start --json$' "$AUTH_START_LOG" || true)"
  auth_slices="$(grep -c '^30$' "$AUTH_SLEEP_LOG" || true)"
  if [ "$auth_starts" -eq 1 ] \
    && [ "$auth_slices" -eq 30 ] \
    && grep -q '^login_expired|severe|fly1955-codex-auth-dead|' "$AUTH_ALERT_LOG" \
    && grep -q 'token_revoked' "$AUTH_ALERT_LOG" \
    && ! grep -q 'sensitive-log-context' "$AUTH_ALERT_LOG" \
    && grep -q 'auth revoked' "$AUTH_ERR" \
    && [ ! -s "$AUTH_KILL_LOG" ] \
    && [ "$(cat "$AUTH_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 1 ]; then
    pass "fresh truncate-rewrite auth evidence alerts, parks, and records one failure"
  else
    fail "fresh truncate-rewrite auth evidence must take the bounded auth-dead path"
  fi
fi

# A1b/A1c/A2/A2b/A3/A11: direct, parameterized checks pin the evidence
# boundary independently of the integrated parking path above.
auth_classifier_case() {
  local scenario="$1" expected="$2" description="$3"
  local home="$TMP/auth-classifier-$1-home" actual
  mkdir -p "$home/app-server-daemon"
  case "$scenario" in
    append-auth|read-race) printf '%s\n' 'old daemon stderr' > "$home/app-server-daemon/app-server.stderr.log" ;;
    unchanged-stale|append-nonauth-stale) printf '%s\n' 'token_revoked old evidence' > "$home/app-server-daemon/app-server.stderr.log" ;;
  esac
  actual="$(FLYWHEEL_CODEX_TUI_HOME="$home" AUTH_SCENARIO="$scenario" \
    "$MODERN_BASH" -c '
      source "$1"
      snapshot_auth_log
      case "$AUTH_SCENARIO" in
        append-auth) printf "%s\n" token_revoked >> "$HOME_DIR/app-server-daemon/app-server.stderr.log" ;;
        new-auth) printf "%s\n" token_revoked > "$HOME_DIR/app-server-daemon/app-server.stderr.log" ;;
        append-nonauth-stale) printf "%s\n" "connection is errored" >> "$HOME_DIR/app-server-daemon/app-server.stderr.log" ;;
        new-network) printf "%s\n" "connection is errored" > "$HOME_DIR/app-server-daemon/app-server.stderr.log" ;;
        read-race) rm -f "$HOME_DIR/app-server-daemon/app-server.stderr.log"; mkdir "$HOME_DIR/app-server-daemon/app-server.stderr.log" ;;
      esac
      if classify_auth_dead; then printf "matched:%s" "$AUTH_DEAD_CODE"; else printf unclassified; fi
    ' _ "$SUT")"
  [ "$actual" = "$expected" ] && pass "$description" || fail "$description (got '$actual')"
}
auth_classifier_case append-auth matched:token_revoked "pure append scans only fresh auth evidence"
auth_classifier_case new-auth matched:token_revoked "new stderr file scans its current auth evidence"
auth_classifier_case unchanged-stale unclassified "unchanged stale auth evidence is ignored"
auth_classifier_case append-nonauth-stale unclassified "non-auth append cannot revive stale auth evidence"
auth_classifier_case new-network unclassified "fresh network-only failure is not auth-dead"
auth_classifier_case read-race unclassified "stderr stat/read drift fails classification closed"

# A7: auth-dead failures participate in the same consecutive-failure episode.
AUTH_REPEAT_HOME="$TMP/auth-repeat-home"
AUTH_REPEAT_ALERT_LOG="$TMP/auth-repeat-alert.log"
AUTH_REPEAT_SEQ="$TMP/auth-repeat-seq"
mkdir -p "$AUTH_REPEAT_HOME/packages/standalone/current" "$AUTH_REPEAT_HOME/app-server-daemon"
printf '%s\n' 'old stderr' > "$AUTH_REPEAT_HOME/app-server-daemon/app-server.stderr.log"
printf '%s\n' 0 > "$AUTH_REPEAT_SEQ"
cat > "$AUTH_REPEAT_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
round=$(cat "$AUTH_REPEAT_SEQ")
round=$((round + 1))
echo "$round" > "$AUTH_REPEAT_SEQ"
printf 'token_revoked round=%s\n' "$round" > "$CODEX_HOME/app-server-daemon/app-server.stderr.log"
exit 1
MOCK
chmod +x "$AUTH_REPEAT_HOME/packages/standalone/current/codex"
: > "$AUTH_REPEAT_ALERT_LOG"
for _ in 1 2 3; do
  FLYWHEEL_CODEX_TUI_HOME="$AUTH_REPEAT_HOME" AUTH_REPEAT_ALERT_LOG="$AUTH_REPEAT_ALERT_LOG" \
    AUTH_REPEAT_SEQ="$AUTH_REPEAT_SEQ" "$MODERN_BASH" -c '
      source "$1"
      emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$AUTH_REPEAT_ALERT_LOG"; }
      fly1955_sleep() { :; }
      fly1955_ps() { echo 4242; }
      ensure_daemon
    ' _ "$SUT" >/dev/null 2>&1 || true
done
if [ "$(cat "$AUTH_REPEAT_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 3 ] \
  && [ "$(grep -c '^login_expired|severe|fly1955-codex-auth-dead|' "$AUTH_REPEAT_ALERT_LOG" || true)" -eq 3 ] \
  && [ "$(grep -c '^crash_loop|severe|fly1955-ensure-daemon-failing|' "$AUTH_REPEAT_ALERT_LOG" || true)" -eq 1 ]; then
  pass "third auth-dead failure emits both specific and safety-net alerts"
else
  fail "auth-dead failures must advance the shared safety-net counter"
fi

# A8: parking exits as soon as the original parent identity disappears,
# including reparent-to-init, another parent, or a failed probe.
auth_hold_parent_case() {
  local mode="$1" slices="$TMP/auth-hold-$1-slices" probes="$TMP/auth-hold-$1-probes"
  : > "$slices"
  printf '%s\n' 0 > "$probes"
  if FLYWHEEL_CODEX_TUI_HOME="$TMP/auth-hold-$1-home" HOLD_MODE="$mode" \
    HOLD_SLICES="$slices" HOLD_PROBES="$probes" "$MODERN_BASH" -c '
      source "$1"
      fly1955_sleep() { echo "$1" >> "$HOLD_SLICES"; }
      fly1955_ps() {
        local n
        n=$(cat "$HOLD_PROBES"); n=$((n + 1)); echo "$n" > "$HOLD_PROBES"
        if [ "$n" -ge 4 ]; then
          case "$HOLD_MODE" in init) echo 1 ;; changed) echo 999 ;; error) return 2 ;; esac
        else
          echo 4242
        fi
      }
      auth_dead_hold
    ' _ "$SUT" >/dev/null 2>&1; then
    fail "$mode parent drift must stop auth parking"
  elif [ "$(wc -l < "$slices" | tr -d ' ')" -eq 3 ]; then
    pass "$mode parent drift stops parking after the current slice"
  else
    fail "$mode parent drift must stop within one 30-second slice"
  fi
}
auth_hold_parent_case init
auth_hold_parent_case changed
auth_hold_parent_case error

# A4 RED: every daemon failure advances one shared counter. The third and all
# later failures attempt the day-deduplicated crash-loop safety-net alert.
COUNT_HOME="$TMP/failcount-threshold-home"
COUNT_ALERT_LOG="$TMP/failcount-threshold-alert.log"
mkdir -p "$COUNT_HOME"
: > "$COUNT_ALERT_LOG"
for round in 1 2 3 4; do
  FLYWHEEL_CODEX_TUI_HOME="$COUNT_HOME" COUNT_ALERT_LOG="$COUNT_ALERT_LOG" \
    "$MODERN_BASH" -c '
      source "$1"
      emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$COUNT_ALERT_LOG"; }
      daemon_die "fixture failure"
    ' _ "$SUT" >/dev/null 2>&1 || true
  count_alerts="$(grep -c '^crash_loop|severe|fly1955-ensure-daemon-failing|' "$COUNT_ALERT_LOG" || true)"
  case "$round:$count_alerts" in
    1:0|2:0|3:1|4:2) : ;;
    *) fail "failure-count alert threshold drifted at round $round" ;;
  esac
done
if [ "$(cat "$COUNT_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 4 ] \
  && grep -q 'consecutive=3' "$COUNT_ALERT_LOG" \
  && grep -q 'consecutive=4' "$COUNT_ALERT_LOG"; then
  pass "third and later daemon failures attempt the crash-loop safety-net alert"
else
  fail "daemon failure count must persist and surface at the third failure"
fi

# A5 RED: any healthy ensure result breaks the consecutive-failure episode.
RESET_HOME="$TMP/failcount-reset-home"
RESET_ALERT_LOG="$TMP/failcount-reset-alert.log"
mkdir -p "$RESET_HOME/packages/standalone/current"
cat > "$RESET_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
mkdir -p "$CODEX_HOME/app-server-control"
if [ ! -S "$CODEX_HOME/app-server-control/app-server-control.sock" ]; then
  python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
fi
exit 0
MOCK
chmod +x "$RESET_HOME/packages/standalone/current/codex"
: > "$RESET_ALERT_LOG"
for _ in 1 2; do
  FLYWHEEL_CODEX_TUI_HOME="$RESET_HOME" RESET_ALERT_LOG="$RESET_ALERT_LOG" \
    "$MODERN_BASH" -c '
      source "$1"
      emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$RESET_ALERT_LOG"; }
      daemon_die "fixture failure"
    ' _ "$SUT" >/dev/null 2>&1 || true
done
FLYWHEEL_CODEX_TUI_HOME="$RESET_HOME" "$MODERN_BASH" "$SUT" ensure-daemon \
  >/dev/null 2>&1 || fail "healthy ensure must succeed while clearing failure count"
for _ in 1 2; do
  FLYWHEEL_CODEX_TUI_HOME="$RESET_HOME" RESET_ALERT_LOG="$RESET_ALERT_LOG" \
    "$MODERN_BASH" -c '
      source "$1"
      emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$RESET_ALERT_LOG"; }
      daemon_die "fixture failure"
    ' _ "$SUT" >/dev/null 2>&1 || true
done
if [ "$(cat "$RESET_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 2 ] \
  && ! grep -q '^crash_loop|severe|fly1955-ensure-daemon-failing|' "$RESET_ALERT_LOG"; then
  pass "a healthy ensure resets the consecutive daemon-failure count"
else
  fail "healthy ensure must reset the failure episode before later failures"
fi

# A6: a corrupt or truncated regular counter restarts the episode at one.
for corrupt_value in bad ''; do
  CORRUPT_HOME="$TMP/failcount-corrupt-${corrupt_value:-empty}-home"
  CORRUPT_ALERT_LOG="$TMP/failcount-corrupt-${corrupt_value:-empty}-alert.log"
  mkdir -p "$CORRUPT_HOME"
  printf '%s' "$corrupt_value" > "$CORRUPT_HOME/.flywheel-ensure-daemon-failcount"
  : > "$CORRUPT_ALERT_LOG"
  FLYWHEEL_CODEX_TUI_HOME="$CORRUPT_HOME" CORRUPT_ALERT_LOG="$CORRUPT_ALERT_LOG" \
    "$MODERN_BASH" -c '
      source "$1"
      emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$CORRUPT_ALERT_LOG"; }
      daemon_die "fixture corrupt counter"
    ' _ "$SUT" >/dev/null 2>&1 || true
  if [ "$(cat "$CORRUPT_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 1 ] \
    && [ ! -s "$CORRUPT_ALERT_LOG" ]; then
    pass "${corrupt_value:-truncated} regular counter restarts safely at one"
  else
    fail "corrupt regular counter must be tolerated without an I/O alert"
  fi
done

# A4b RED: the safety net wraps ensure_daemon's existing failure exits too,
# rather than only the new auth-dead branch.
ALL_DIE_HOME="$TMP/all-die-home"
ALL_DIE_ALERT_LOG="$TMP/all-die-alert.log"
mkdir -p "$ALL_DIE_HOME/packages/standalone/current"
printf '#!/bin/bash\nexit 1\n' > "$ALL_DIE_HOME/packages/standalone/current/codex"
chmod +x "$ALL_DIE_HOME/packages/standalone/current/codex"
: > "$ALL_DIE_ALERT_LOG"
for _ in 1 2 3; do
  FLYWHEEL_CODEX_TUI_HOME="$ALL_DIE_HOME" ALL_DIE_ALERT_LOG="$ALL_DIE_ALERT_LOG" \
    "$MODERN_BASH" -c '
      source "$1"
      emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$ALL_DIE_ALERT_LOG"; }
      ensure_daemon
    ' _ "$SUT" >/dev/null 2>&1 || true
done
if [ "$(cat "$ALL_DIE_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 3 ] \
  && [ "$(grep -c '^crash_loop|severe|fly1955-ensure-daemon-failing|' "$ALL_DIE_ALERT_LOG" || true)" -eq 1 ]; then
  pass "existing ensure-daemon failure exits share the consecutive-failure safety net"
else
  fail "every ensure-daemon failure exit must advance the safety-net counter"
fi

# A9 RED: the failure-count safety net must fail visibly without following or
# replacing a hostile target, and every daemon_die has one I/O-alert exit.
failcount_io_case() {
  local mode="$1" home="$TMP/failcount-io-$1-home"
  local counter="$home/.flywheel-ensure-daemon-failcount"
  local alerts="$TMP/failcount-io-$1-alert.log" err="$TMP/failcount-io-$1.err"
  local target="$home/symlink-target"
  mkdir -p "$home"
  : > "$alerts"
  case "$mode" in
    write) printf '%s\n' 7 > "$counter" ;;
    directory) mkdir "$counter"; printf '%s\n' keep > "$counter/sentinel" ;;
    symlink) printf '%s\n' 9 > "$target"; ln -s "$target" "$counter" ;;
  esac
  if FLYWHEEL_CODEX_TUI_HOME="$home" IO_ALERT_LOG="$alerts" \
    "$MODERN_BASH" -c '
      source "$1"
      emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$IO_ALERT_LOG"; }
      [ "$2" != write ] || fly1955_write_failcount() { return 1; }
      daemon_die "fixture io failure"
    ' _ "$SUT" "$mode" >/dev/null 2> "$err"; then
    fail "$mode failcount fault must still die"
    return
  fi
  io_alerts="$(grep -c '^crash_loop|severe|fly1955-failcount-io|' "$alerts" || true)"
  temps="$(find "$home" -maxdepth 1 -name '.flywheel-ensure-daemon-failcount.*' -print | wc -l | tr -d ' ')"
  preserved=0
  case "$mode" in
    write) [ "$(cat "$counter" 2>/dev/null)" = 7 ] && preserved=1 ;;
    directory) [ -d "$counter" ] && [ "$(cat "$counter/sentinel" 2>/dev/null)" = keep ] && preserved=1 ;;
    symlink) [ -L "$counter" ] && [ "$(cat "$target" 2>/dev/null)" = 9 ] && preserved=1 ;;
  esac
  if [ "$io_alerts" -eq 1 ] && [ "$temps" -eq 0 ] && [ "$preserved" -eq 1 ] \
    && grep -q 'fixture io failure' "$err"; then
    pass "$mode failcount fault emits once, preserves its target, and still dies"
  else
    fail "$mode failcount fault must converge on one preserving I/O-alert path"
  fi
}
failcount_io_case write
failcount_io_case directory
failcount_io_case symlink

# A10 RED: clearing stale episode state is best-effort on a healthy daemon.
CLEAR_HOME="$TMP/failcount-clear-home"
CLEAR_ALERT_LOG="$TMP/failcount-clear-alert.log"
CLEAR_ERR="$TMP/failcount-clear.err"
mkdir -p "$CLEAR_HOME/packages/standalone/current"
printf '%s\n' 2 > "$CLEAR_HOME/.flywheel-ensure-daemon-failcount"
cat > "$CLEAR_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
mkdir -p "$CODEX_HOME/app-server-control"
python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
exit 0
MOCK
chmod +x "$CLEAR_HOME/packages/standalone/current/codex"
: > "$CLEAR_ALERT_LOG"
if FLYWHEEL_CODEX_TUI_HOME="$CLEAR_HOME" CLEAR_ALERT_LOG="$CLEAR_ALERT_LOG" \
  "$MODERN_BASH" -c '
    source "$1"
    fly1955_remove_failcount() { return 1; }
    emit_lead_alert() { printf "%s|%s|%s|%s|%s\n" "$@" >> "$CLEAR_ALERT_LOG"; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2> "$CLEAR_ERR" \
  && [ "$(cat "$CLEAR_HOME/.flywheel-ensure-daemon-failcount" 2>/dev/null)" = 2 ] \
  && [ "$(grep -c '^crash_loop|severe|fly1955-failcount-io|' "$CLEAR_ALERT_LOG" || true)" -eq 1 ] \
  && grep -q 'failed to clear daemon failcount' "$CLEAR_ERR"; then
  pass "failcount clear failure alerts without breaking a healthy daemon"
else
  fail "failcount clear failure must stay visible and non-blocking"
fi

# RED 2: a proven reap must trigger exactly one retry, verify the new socket,
# and report recovery. The process-evidence function is replaced here so this
# case tests only ensure_daemon's state machine; dedicated cases exercise the
# proof and signal fences.
HOME_DIR="$TMP/retry-home"
mkdir -p "$HOME_DIR/packages/standalone/current"
MOCK_LOG="$TMP/codex.log"
ALERT_LOG="$TMP/alert.log"
cat > "$HOME_DIR/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
echo "$@" >> "$MOCK_LOG"
starts=$(grep -c '^remote-control start --json$' "$MOCK_LOG" || true)
if [ "$1 $2 $3" = "remote-control start --json" ] && [ "$starts" -eq 2 ]; then
  mkdir -p "$CODEX_HOME/app-server-control"
  python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
  echo '{"status":"connected"}'
  exit 0
fi
echo "simulated missing control socket" >&2
exit 1
MOCK
chmod +x "$HOME_DIR/packages/standalone/current/codex"

if FLYWHEEL_CODEX_TUI_HOME="$HOME_DIR" MOCK_LOG="$MOCK_LOG" ALERT_LOG="$ALERT_LOG" \
  "$MODERN_BASH" -c '
    source "$1"
    reap_zombie_daemon_if_proven() {
      REAP_OUTCOME=reaped
      REAP_OLD_UPDATER_PID=101
      REAP_OLD_UPDATER_LSTART=old
      REAP_OLD_UPDATER_COMMAND=old
    }
    assert_recovery_shape() { return 0; }
    emit_zombie_alert() { printf "%s\n" "$1" >> "$ALERT_LOG"; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2>&1; then
  starts=$(grep -c '^remote-control start --json$' "$MOCK_LOG" || true)
  if [ "$starts" -eq 2 ] && grep -qx 'recovered' "$ALERT_LOG"; then
    pass "proven reap retries once and reports recovered"
  else
    fail "recovery must retry exactly once and emit recovered"
  fi
else
  fail "ensure_daemon must recover after a proven zombie reap"
fi

# F2: a recovered socket is not enough to announce recovery. If the daemon or
# updater postcondition is incomplete, service stays up but the alert is stuck.
rm -f "$HOME_DIR/app-server-control/app-server-control.sock"
: > "$MOCK_LOG"
: > "$ALERT_LOG"
if FLYWHEEL_CODEX_TUI_HOME="$HOME_DIR" MOCK_LOG="$MOCK_LOG" ALERT_LOG="$ALERT_LOG" \
  "$MODERN_BASH" -c '
    source "$1"
    reap_zombie_daemon_if_proven() {
      REAP_OUTCOME=reaped
      REAP_OLD_UPDATER_PID=101
      REAP_OLD_UPDATER_LSTART=old
      REAP_OLD_UPDATER_COMMAND=old
    }
    assert_recovery_shape() { return 1; }
    emit_zombie_alert() { printf "%s\n" "$1" >> "$ALERT_LOG"; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2>&1; then
  starts=$(grep -c '^remote-control start --json$' "$MOCK_LOG" || true)
  if [ "$starts" -eq 2 ] && [ "$(cat "$ALERT_LOG")" = stuck ]; then
    pass "incomplete recovery shape reports stuck while preserving service"
  else
    fail "post-recovery assertion failure must emit stuck"
  fi
else
  fail "post-recovery assertion failure must not restart the crash loop"
fi

# T3/T6-T11: deterministic process-table model for every safety fence. It
# models ps/kill only; socket and pid-file evidence remain real filesystem
# objects so the branch conditions match production.
mock_reap() {
  local scenario="$1" home="$TMP/mock-$1-home"
  [ "$scenario" = near-home ] && home="$TMP/.codex[+]mufasa"
  mkdir -p "$home/app-server-daemon"
  printf '%s\n' '{"pid":200,"processStartTime":"Thu Aug 20 14:15:00 2026"}' \
    > "$home/app-server-daemon/app-server.pid"
  if [ "$scenario" = race ]; then
    mkdir -p "$home/app-server-control"
    python3 - "$home/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
  fi
  FLYWHEEL_CODEX_TUI_HOME="$home" SCENARIO="$scenario" \
    KILL_LOG="$TMP/mock-$scenario-kill.log" COUNT_FILE="$TMP/mock-$scenario-count" \
    "$MODERN_BASH" -c '
      source "$1"
      : > "$KILL_LOG"
      echo 0 > "$COUNT_FILE"
      AFTER_TERM=0
      MOCK_UPDATER_COMMAND="$HOME_DIR/packages/standalone/0.149.0/codex app-server daemon pid-update-loop"
      fly1955_ps() {
        local args="$*" pid="${!#}" n
        if [ "$pid" = 200 ]; then
          if [ "$AFTER_TERM" -eq 1 ] && [ "$SCENARIO" = success ]; then return 1; fi
          case "$args" in
            *state=*) [ "$SCENARIO" = live ] && echo S || echo Z ;;
            *lstart=*) [ "$SCENARIO" = start-mismatch ] \
              && echo "Thu Aug 20 14:15:01 2026" \
              || echo "Thu Aug 20 14:15:00 2026" ;;
            *ppid=*)
              if [ "$AFTER_TERM" -eq 1 ] && [ "$SCENARIO" = post-drift ]; then echo 301; else echo 300; fi
              ;;
            *) return 2 ;;
          esac
          return 0
        fi
        if [ "$pid" = 300 ]; then
          if [ "$AFTER_TERM" -eq 1 ] && [ "$SCENARIO" = success ]; then return 1; fi
          case "$args" in
            *lstart=*) echo "Thu Aug 20 14:09:00 2026" ;;
            *command=*)
              n=$(cat "$COUNT_FILE"); n=$((n + 1)); echo "$n" > "$COUNT_FILE"
              case "$SCENARIO" in
                bad-command) echo "/tmp/foreign/codex app-server daemon pid-update-loop" ;;
                bad-prefix) echo "bash $MOCK_UPDATER_COMMAND" ;;
                near-home) echo "${HOME_DIR/\[/X} app-server daemon pid-update-loop" ;;
                pre-drift)
                  [ "$n" -ge 2 ] \
                    && echo "$HOME_DIR/packages/standalone/0.150.0/codex app-server daemon pid-update-loop" \
                    || echo "$MOCK_UPDATER_COMMAND"
                  ;;
                *) echo "$MOCK_UPDATER_COMMAND" ;;
              esac
              ;;
            *) return 2 ;;
          esac
          return 0
        fi
        return 1
      }
      fly1955_kill() {
        echo "$1" >> "$KILL_LOG"
        if [ "$SCENARIO" = kill-stuck ] && [ "$1" = -KILL ]; then return 1; fi
        AFTER_TERM=1
        return 0
      }
      fly1955_sleep() { :; }
      reap_zombie_daemon_if_proven
      printf "%s|" "$REAP_OUTCOME"
      paste -sd, "$KILL_LOG"
    ' _ "$SUT"
}

assert_mock_reap() {
  local scenario="$1" expected="$2" description="$3" actual
  actual="$(mock_reap "$scenario")"
  if [ "$actual" = "$expected" ]; then pass "$description"; else fail "$description (got '$actual')"; fi
}

assert_mock_reap success 'reaped|-TERM' "proven snapshot sends TERM and reaches reaped"
assert_mock_reap live 'not_proven|' "live daemon is never signalled"
assert_mock_reap start-mismatch 'not_proven|' "pid start-time mismatch is never signalled"
assert_mock_reap bad-command 'not_proven|' "foreign updater command is never signalled"
assert_mock_reap bad-prefix 'not_proven|' "updater command with leading shell junk is never signalled"
assert_mock_reap pre-drift 'not_proven|' "pre-TERM identity drift is silent and sends no signal"
assert_mock_reap post-drift 'action_stuck|-TERM' "post-TERM child drift stops before KILL"
assert_mock_reap race 'race_self_healed|' "socket race self-heal sends no signal"
assert_mock_reap near-home 'not_proven|' "metacharacter near-home path cannot cross the literal fence"
assert_mock_reap kill-stuck 'action_stuck|-TERM,-KILL' "failed bounded KILL returns action_stuck"

# T12: alert delivery is explicitly non-blocking after a successful recovery.
ALERT_FAIL_HOME="$TMP/alert-fail-home"
mkdir -p "$ALERT_FAIL_HOME/packages/standalone/current"
cat > "$ALERT_FAIL_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
echo "$@" >> "$MOCK_LOG"
starts=$(grep -c '^remote-control start --json$' "$MOCK_LOG" || true)
if [ "$starts" -eq 2 ]; then
  mkdir -p "$CODEX_HOME/app-server-control"
  python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
  exit 0
fi
exit 1
MOCK
chmod +x "$ALERT_FAIL_HOME/packages/standalone/current/codex"
cat > "$TMP/failing-alert" <<'ALERT'
#!/bin/bash
echo "$@" >> "$ALERT_LOG"
printf '%s|%s|%s\n' "$FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID" \
  "$FLYWHEEL_ALERT_SENDER_TOKEN_ENV" "${!FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" \
  > "$ALERT_ROUTE_LOG"
exit 1
ALERT
chmod +x "$TMP/failing-alert"
: > "$TMP/alert-fail-start.log"
: > "$TMP/alert-fail.log"
: > "$TMP/alert-route.log"
if FLYWHEEL_CODEX_TUI_HOME="$ALERT_FAIL_HOME" MOCK_LOG="$TMP/alert-fail-start.log" \
  FLYWHEEL_LEAD_ID=fixture-lead FLYWHEEL_PROJECT_NAME=fixture \
  FLYWHEEL_LEAD_ALERT_SH="$TMP/failing-alert" ALERT_LOG="$TMP/alert-fail.log" \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=alerts \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV=DISCORD_BOT_TOKEN \
  DISCORD_BOT_TOKEN=fleet-secret ALERT_ROUTE_LOG="$TMP/alert-route.log" \
  "$MODERN_BASH" -c '
    source "$1"
    reap_zombie_daemon_if_proven() {
      REAP_OUTCOME=reaped
      REAP_OLD_UPDATER_PID=101
      REAP_OLD_UPDATER_LSTART=old
      REAP_OLD_UPDATER_COMMAND=old
    }
    assert_recovery_shape() { return 0; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2>&1 \
  && grep -q 'fly1955-zombie-recovered|' "$TMP/alert-fail.log" \
  && [ "$(cat "$TMP/alert-route.log")" = 'alerts|DISCORD_BOT_TOKEN|fleet-secret' ]; then
  pass "governed alert route reaches lead-alert and delivery failure stays non-fatal"
else
  fail "alert failure must remain non-fatal"
fi

# T13: the recovery state machine grants one retry, never a third attempt.
RETRY_FAIL_HOME="$TMP/retry-fail-home"
mkdir -p "$RETRY_FAIL_HOME/packages/standalone/current"
cat > "$RETRY_FAIL_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
echo "$@" >> "$MOCK_LOG"
exit 1
MOCK
chmod +x "$RETRY_FAIL_HOME/packages/standalone/current/codex"
: > "$TMP/retry-fail-start.log"
: > "$TMP/retry-fail-alert.log"
if FLYWHEEL_CODEX_TUI_HOME="$RETRY_FAIL_HOME" MOCK_LOG="$TMP/retry-fail-start.log" \
  ALERT_LOG="$TMP/retry-fail-alert.log" "$MODERN_BASH" -c '
    source "$1"
    reap_zombie_daemon_if_proven() { REAP_OUTCOME=reaped; }
    emit_zombie_alert() { echo "$1" >> "$ALERT_LOG"; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2>&1; then
  fail "failed recovery retry must fail loud"
else
  starts="$(grep -c '^remote-control start --json$' "$TMP/retry-fail-start.log" || true)"
  if [ "$starts" -eq 2 ] && [ "$(cat "$TMP/retry-fail-alert.log")" = stuck ]; then
    pass "failed recovery stops after exactly one retry and reports stuck"
  else
    fail "failed recovery must attempt start exactly twice"
  fi
fi

# T14/T17: full-access keeps stop→start→start ordering; the race-self-healed
# branch also requires a socket after the successful retry.
RACE_HOME="$TMP/race-retry-home"
mkdir -p "$RACE_HOME/packages/standalone/current"
cat > "$RACE_HOME/packages/standalone/current/codex" <<'MOCK'
#!/bin/bash
echo "$@" >> "$MOCK_LOG"
if [ "$1 $2" = "remote-control stop" ]; then exit 0; fi
starts=$(grep -c '^remote-control start --json$' "$MOCK_LOG" || true)
if [ "$starts" -eq 2 ] && [ "${MAKE_SOCKET:-0}" = 1 ]; then
  mkdir -p "$CODEX_HOME/app-server-control"
  python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
  exit 0
fi
[ "$starts" -eq 2 ] && exit 0
exit 1
MOCK
chmod +x "$RACE_HOME/packages/standalone/current/codex"
: > "$TMP/race-sequence.log"
if FLYWHEEL_CODEX_TUI_HOME="$RACE_HOME" FLYWHEEL_CODEX_LEAD_PROFILE=full-access \
  MOCK_LOG="$TMP/race-sequence.log" MAKE_SOCKET=1 "$MODERN_BASH" -c '
    source "$1"
    reap_zombie_daemon_if_proven() { REAP_OUTCOME=race_self_healed; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2>&1 \
  && [ "$(cat "$TMP/race-sequence.log")" = $'remote-control stop --json\nremote-control start --json\nremote-control start --json' ]; then
  pass "full-access recovery preserves stop→start→single-retry ordering"
else
  fail "full-access recovery command order drifted"
fi

rm -f "$RACE_HOME/app-server-control/app-server-control.sock"
: > "$TMP/race-sequence.log"
if FLYWHEEL_CODEX_TUI_HOME="$RACE_HOME" FLYWHEEL_CODEX_LEAD_PROFILE=full-access \
  MOCK_LOG="$TMP/race-sequence.log" MAKE_SOCKET=0 "$MODERN_BASH" -c '
    source "$1"
    reap_zombie_daemon_if_proven() { REAP_OUTCOME=race_self_healed; }
    emit_zombie_alert() { echo unexpected >> "$ALERT_LOG"; }
    ensure_daemon
  ' _ "$SUT" >/dev/null 2>&1; then
  fail "race retry without a socket must fail loud"
else
  pass "race retry exit 0 with a missing socket is rejected"
fi

# T15: FLY-513's existing warning now emits the governed alert only when the
# global path resolves into this Lead home.
FLY513_USER="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP")/fly513-user"
FLY513_HOME="$FLY513_USER/lead-home"
mkdir -p "$FLY513_USER/.local/bin" "$FLY513_HOME/packages/standalone/current"
printf '%s\n' '{}' > "$FLY513_HOME/auth.json"
printf '#!/bin/sh\n' > "$FLY513_HOME/packages/standalone/current/codex"
chmod +x "$FLY513_HOME/packages/standalone/current/codex"
ln -s "$FLY513_HOME/packages/standalone/current/codex" "$FLY513_USER/.local/bin/codex"
cat > "$TMP/fly513-alert" <<'ALERT'
#!/bin/bash
echo "$@" >> "$ALERT_LOG"
ALERT
chmod +x "$TMP/fly513-alert"
: > "$TMP/fly513-alert.log"
if HOME="$FLY513_USER" FLYWHEEL_CODEX_TUI_HOME="$FLY513_HOME" FLYWHEEL_CODEX_TUI_CWD=/work \
  FLYWHEEL_LEAD_ID=fixture-lead FLYWHEEL_PROJECT_NAME=fixture \
  FLYWHEEL_LEAD_ALERT_SH="$TMP/fly513-alert" ALERT_LOG="$TMP/fly513-alert.log" \
  "$MODERN_BASH" "$SUT" ensure-home >/dev/null 2> "$TMP/fly513.err" \
  && grep -q -- '--kind bin_integrity_drift' "$TMP/fly513-alert.log" \
  && grep -q 'fly513-global-codex|' "$TMP/fly513-alert.log"; then
  pass "FLY-513 Lead-home global path emits one bin_integrity_drift alert"
else
  fail "FLY-513 warning branch must emit the governed alert (alert='$(cat "$TMP/fly513-alert.log")' err='$(cat "$TMP/fly513.err")')"
fi
mkdir -p "$FLY513_USER/neutral"
printf '#!/bin/sh\n' > "$FLY513_USER/neutral/codex"
chmod +x "$FLY513_USER/neutral/codex"
ln -sfn "$FLY513_USER/neutral/codex" "$FLY513_USER/.local/bin/codex"
: > "$TMP/fly513-alert.log"
if HOME="$FLY513_USER" FLYWHEEL_CODEX_TUI_HOME="$FLY513_HOME" FLYWHEEL_CODEX_TUI_CWD=/work \
  FLYWHEEL_LEAD_ID=fixture-lead FLYWHEEL_PROJECT_NAME=fixture \
  FLYWHEEL_LEAD_ALERT_SH="$TMP/fly513-alert" ALERT_LOG="$TMP/fly513-alert.log" \
  "$MODERN_BASH" "$SUT" ensure-home >/dev/null 2>&1 \
  && [ ! -s "$TMP/fly513-alert.log" ]; then
  pass "neutral global Codex emits no FLY-513 alert"
else
  fail "neutral global Codex must succeed without alerting"
fi

# T16: unset override resolves from the SUT definition path, not harness $0.
EXPECTED_ALERT="$(cd "$SCRIPT_DIR/../../.." && pwd)/scripts/lead-alert.sh"
RESOLVED_ALERT="$(FLYWHEEL_CODEX_TUI_HOME="$TMP/resolver-home" "$MODERN_BASH" -c '
  unset FLYWHEEL_LEAD_ALERT_SH
  source "$1"
  resolve_lead_alert_sh
' _ "$SUT")"
[ "$RESOLVED_ALERT" = "$EXPECTED_ALERT" ] \
  && pass "default alert resolver uses the SUT BASH_SOURCE repo root" \
  || fail "default alert resolver returned '$RESOLVED_ALERT'"

# T1: reproduce E3 with a real zombie and real PPID relationship. A compiled
# executable named codex gives ps the production argv on both macOS and Linux.
if ! /bin/ps -p $$ -o pid= >/dev/null 2>&1; then
  [ -z "${CI:-}" ] || fail "real E3 requires process-table inspection in CI"
  echo "  - SKIP real E3: sandbox denies process-table inspection"
else
REAL_HOME="$TMP/real-e3-home"
PROCESS_EXE="$REAL_HOME/packages/standalone/0.149.0/codex"
mkdir -p "$(dirname "$PROCESS_EXE")" "$REAL_HOME/app-server-daemon"
cat > "$TMP/fly1955-codex.c" <<'C'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  const char *mode = getenv("FLY1955_FIXTURE_MODE");
  const char *pid_file = getenv("FLY1955_FIXTURE_PID_FILE");
  const char *child_file = getenv("FLY1955_FIXTURE_CHILD_FILE");
  FILE *file = fopen(pid_file, "w");
  if (!file) return 2;
  fprintf(file, "%d\n", getpid());
  fclose(file);
  if (mode && strcmp(mode, "updater-zombie") == 0) {
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) _exit(0);
    file = fopen(child_file, "w");
    if (!file) return 4;
    fprintf(file, "%d\n", child);
    fclose(file);
  }
  for (;;) pause();
}
C
cc "$TMP/fly1955-codex.c" -o "$PROCESS_EXE" || exit 1

OLD_UPDATER_FILE="$TMP/old-updater.pid"
OLD_DAEMON_FILE="$TMP/old-daemon.pid"
PROCESS_TITLE="$PROCESS_EXE app-server daemon pid-update-loop"
FLY1955_FIXTURE_MODE=updater-zombie FLY1955_FIXTURE_PID_FILE="$OLD_UPDATER_FILE" \
  FLY1955_FIXTURE_CHILD_FILE="$OLD_DAEMON_FILE" \
  "$PROCESS_EXE" app-server daemon pid-update-loop &
OLD_UPDATER=$!
echo "$OLD_UPDATER" >> "$OWNED_PIDS"
for _ in $(seq 1 50); do
  [ -s "$OLD_DAEMON_FILE" ] && break
  sleep 0.02
done
OLD_DAEMON="$(cat "$OLD_DAEMON_FILE" 2>/dev/null || true)"
ACTUAL_TITLE="$(LC_ALL=C /bin/ps -ww -o command= -p "$OLD_UPDATER" 2>/dev/null || true)"
if [ "$ACTUAL_TITLE" != "$PROCESS_TITLE" ] || [ -z "$OLD_DAEMON" ]; then
  fail "real E3 fixture must expose the production updater argv (got '$ACTUAL_TITLE')"
else
  for _ in $(seq 1 50); do
    state="$(LC_ALL=C /bin/ps -o state= -p "$OLD_DAEMON" 2>/dev/null || true)"
    case "$state" in *Z*) break ;; esac
    sleep 0.02
  done
  OLD_START="$(LC_ALL=C /bin/ps -o lstart= -p "$OLD_DAEMON" 2>/dev/null || true)"
  OLD_START="${OLD_START#"${OLD_START%%[![:space:]]*}"}"
  OLD_START="${OLD_START%"${OLD_START##*[![:space:]]}"}"
  python3 - "$OLD_DAEMON" "$OLD_START" "$REAL_HOME/app-server-daemon/app-server.pid" <<'PY'
import json, sys
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump({"pid": int(sys.argv[1]), "processStartTime": sys.argv[2]}, f)
PY

  REAL_CODEX="$TMP/real-codex-stub"
  REAL_START_LOG="$TMP/real-start.log"
  REAL_ALERT="$TMP/real-alert"
  NEW_UPDATER_FILE="$TMP/new-updater.pid"
  NEW_DAEMON_FILE="$TMP/new-daemon.pid"
  cat > "$REAL_CODEX" <<'MOCK'
#!/bin/bash
echo "$@" >> "$REAL_START_LOG"
starts=$(grep -c '^remote-control start --json$' "$REAL_START_LOG" || true)
if [ "$starts" -eq 1 ]; then
  echo "simulated E3 ENOENT" >&2
  exit 1
fi
FLY1955_FIXTURE_MODE=live FLY1955_FIXTURE_PID_FILE="$NEW_UPDATER_FILE" \
  "$PROCESS_EXE" app-server daemon pid-update-loop &
echo "$!" >> "$OWNED_PIDS"
FLY1955_FIXTURE_MODE=live FLY1955_FIXTURE_PID_FILE="$NEW_DAEMON_FILE" \
  "$PROCESS_EXE" fixture-daemon &
echo "$!" >> "$OWNED_PIDS"
for _ in $(seq 1 50); do
  [ -s "$NEW_UPDATER_FILE" ] && [ -s "$NEW_DAEMON_FILE" ] && break
  sleep 0.02
done
daemon=$(cat "$NEW_DAEMON_FILE")
started=$(LC_ALL=C /bin/ps -o lstart= -p "$daemon")
started="${started#"${started%%[![:space:]]*}"}"
started="${started%"${started##*[![:space:]]}"}"
mkdir -p "$CODEX_HOME/app-server-daemon" "$CODEX_HOME/app-server-control"
python3 - "$daemon" "$started" "$CODEX_HOME/app-server-daemon/app-server.pid" <<'PY'
import json, sys
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump({"pid": int(sys.argv[1]), "processStartTime": sys.argv[2]}, f)
PY
python3 - "$CODEX_HOME/app-server-control/app-server-control.sock" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
PY
echo '{"status":"connected"}'
MOCK
  chmod +x "$REAL_CODEX"
  cat > "$REAL_ALERT" <<'ALERT'
#!/bin/bash
echo "$@" >> "$REAL_ALERT_LOG"
ALERT
  chmod +x "$REAL_ALERT"
  : > "$REAL_START_LOG"
  : > "$TMP/real-alert.log"

  if FLYWHEEL_CODEX_TUI_HOME="$REAL_HOME" FLYWHEEL_CODEX_BIN="$REAL_CODEX" \
    FLYWHEEL_LEAD_ID=fixture-lead FLYWHEEL_PROJECT_NAME=fixture \
    FLYWHEEL_LEAD_ALERT_SH="$REAL_ALERT" REAL_ALERT_LOG="$TMP/real-alert.log" \
    REAL_START_LOG="$REAL_START_LOG" PROCESS_EXE="$PROCESS_EXE" PROCESS_TITLE="$PROCESS_TITLE" \
    NEW_UPDATER_FILE="$NEW_UPDATER_FILE" NEW_DAEMON_FILE="$NEW_DAEMON_FILE" OWNED_PIDS="$OWNED_PIDS" \
    "$MODERN_BASH" "$SUT" ensure-daemon >/dev/null 2>&1; then
    starts="$(grep -c '^remote-control start --json$' "$REAL_START_LOG" || true)"
    if [ "$starts" -eq 2 ] \
      && ! /bin/ps -p "$OLD_UPDATER" >/dev/null 2>&1 \
      && ! /bin/ps -p "$OLD_DAEMON" >/dev/null 2>&1 \
      && grep -q -- '--kind crash_loop' "$TMP/real-alert.log" \
      && grep -q 'fly1955-zombie-recovered|' "$TMP/real-alert.log"; then
      pass "real E3 zombie is reaped, retried once, and reported recovered"
    else
      fail "real E3 recovery postconditions failed"
    fi
  else
    fail "real E3 recovery must succeed"
  fi
fi
fi

echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
