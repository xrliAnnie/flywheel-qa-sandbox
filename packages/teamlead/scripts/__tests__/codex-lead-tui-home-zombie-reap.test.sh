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
    && [ "$(cat "$log")" = "$expected_commands" ]; then
    pass "healthy $profile path remains byte-for-byte compatible"
  else
    fail "healthy $profile golden drifted"
  fi
}
golden_case companion
golden_case full-access

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
