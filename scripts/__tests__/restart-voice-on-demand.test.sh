#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

FIXTURE_REPO="$ROOT/repo"
FIXTURE_HOME="$ROOT/home"
SOURCE="$FIXTURE_REPO/scripts/launchd/com.flywheel.voice.plist"
INSTALLED="$FIXTURE_HOME/Library/LaunchAgents/com.flywheel.voice.plist"
WRAPPER="$FIXTURE_REPO/scripts/flywheel-voice-wrapper.sh"
mkdir -p "$(dirname "$SOURCE")" "$(dirname "$INSTALLED")"
cp "$REPO_ROOT/scripts/flywheel-voice-wrapper.sh" "$WRAPPER"
chmod +x "$WRAPPER"
sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
  "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
cp "$SOURCE" "$INSTALLED"

# restart_voice_managed derives its own domain from the running uid, so the stub
# must too: hardcoding 501 passes locally and fails on any other runner.
UID_NOW="$(id -u)"
DOMAIN="gui/${UID_NOW}"
LAUNCHCTL_MODE=valid
LAUNCHCTL_DISABLED_MODE=enabled
LAUNCHCTL_STATE="$ROOT/launchctl-state"
mkdir -p "$LAUNCHCTL_STATE"
launchctl() {
  printf '%s\n' "$*" >> "$ROOT/launchctl-calls"
  case "$1" in
    bootout)
      local ticks=0
      [[ -f "$LAUNCHCTL_STATE/teardown-ticks" ]] &&
        ticks="$(cat "$LAUNCHCTL_STATE/teardown-ticks")"
      if [[ "$ticks" -gt 0 ]]; then
        printf '%s\n' "$ticks" > "$LAUNCHCTL_STATE/teardown-left"
      else
        : > "$LAUNCHCTL_STATE/absent"
      fi
      return 0
      ;;
    bootstrap)
      local count=0 remaining=0
      [[ -f "$LAUNCHCTL_STATE/bootstrap-count" ]] &&
        count="$(cat "$LAUNCHCTL_STATE/bootstrap-count")"
      printf '%s\n' "$((count + 1))" > "$LAUNCHCTL_STATE/bootstrap-count"
      if [[ -f "$LAUNCHCTL_STATE/teardown-left" || -f "$LAUNCHCTL_STATE/bootstrap-fail-always" ]]; then
        echo 'Bootstrap failed: 5: Input/output error' >&2
        return 5
      fi
      if [[ -f "$LAUNCHCTL_STATE/bootstrap-registers-on-error" ]]; then
        rm -f "$LAUNCHCTL_STATE/absent" "$LAUNCHCTL_STATE/teardown-left"
        : > "$LAUNCHCTL_STATE/loaded"
        echo 'Bootstrap failed: 5: Input/output error' >&2
        return 5
      fi
      [[ -f "$LAUNCHCTL_STATE/bootstrap-failures-left" ]] &&
        remaining="$(cat "$LAUNCHCTL_STATE/bootstrap-failures-left")"
      if [[ "$remaining" -gt 0 ]]; then
        printf '%s\n' "$((remaining - 1))" > "$LAUNCHCTL_STATE/bootstrap-failures-left"
        echo 'Bootstrap failed: 5: Input/output error' >&2
        return 5
      fi
      rm -f "$LAUNCHCTL_STATE/absent" "$LAUNCHCTL_STATE/teardown-left"
      if [[ -f "$LAUNCHCTL_STATE/registration-lag-ticks" ]]; then
        cp "$LAUNCHCTL_STATE/registration-lag-ticks" \
          "$LAUNCHCTL_STATE/registration-lag-left"
      fi
      : > "$LAUNCHCTL_STATE/loaded"
      return 0
      ;;
    print-disabled)
      [[ "$2" == "$DOMAIN" ]] || return 90
      if [[ "$LAUNCHCTL_DISABLED_MODE" == unreadable ]]; then
        echo 'launchctl transport unavailable' >&2
        return 1
      fi
      printf '%s\n' 'disabled services = {'
      if [[ "$LAUNCHCTL_DISABLED_MODE" == disabled ]]; then
        printf '%s\n' $'\t"com.flywheel.voice" => disabled'
      fi
      printf '%s\n' '}'
      ;;
    print)
      [[ "$2" == "${DOMAIN}/com.flywheel.voice" ]] || return 90
      if [[ -f "$LAUNCHCTL_STATE/teardown-left" ]]; then
        local left
        left="$(cat "$LAUNCHCTL_STATE/teardown-left")"
        if [[ "$left" -le 1 ]]; then
          rm -f "$LAUNCHCTL_STATE/teardown-left"
          : > "$LAUNCHCTL_STATE/absent"
        else
          printf '%s\n' "$((left - 1))" > "$LAUNCHCTL_STATE/teardown-left"
        fi
      fi
      if [[ "$LAUNCHCTL_MODE" == missing || -f "$LAUNCHCTL_STATE/absent" ]]; then
        echo 'Could not find service "com.flywheel.voice" in domain for user' >&2
        return 113
      fi
      if [[ -f "$LAUNCHCTL_STATE/registration-lag-left" ]]; then
        local lag
        lag="$(cat "$LAUNCHCTL_STATE/registration-lag-left")"
        if [[ "$lag" -gt 1 ]]; then
          printf '%s\n' "$((lag - 1))" > "$LAUNCHCTL_STATE/registration-lag-left"
          echo 'Could not find service "com.flywheel.voice" in domain for user' >&2
          return 113
        fi
        rm -f "$LAUNCHCTL_STATE/registration-lag-left"
      fi
      [[ "$LAUNCHCTL_MODE" == valid ]] || return 113
      printf '%s\n' \
        "${DOMAIN}/com.flywheel.voice = {" \
        $'\tpath = '"$INSTALLED" \
        $'\tprogram = /bin/bash' \
        $'\targuments = {' \
        $'\t\t/bin/bash' \
        $'\t\t'"$WRAPPER" \
        $'\t}' \
        $'\tstate = not running' \
        $'\tlast exit code = 0' \
        '}'
      ;;
    *) return 90 ;;
  esac
}

# shellcheck source=../lib/voice-on-demand.sh
source "$REPO_ROOT/scripts/lib/voice-on-demand.sh"

voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"
[[ "$(cat "$ROOT/launchctl-calls")" == "print ${DOMAIN}/com.flywheel.voice" ]]

printf '\n<!-- drift -->\n' >> "$INSTALLED"
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"; then
  echo "FAIL: installed byte drift was accepted" >&2
  exit 1
fi
cp "$SOURCE" "$INSTALLED"

python3 - "$SOURCE" "$INSTALLED" <<'PY'
import plistlib,sys
for path in sys.argv[1:]:
    p=plistlib.load(open(path,'rb'))
    p['RunAtLoad']=True
    p['KeepAlive']={'SuccessfulExit':False}
    p['ThrottleInterval']=30
    plistlib.dump(p,open(path,'wb'))
PY
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"; then
  echo "FAIL: resident launchd bytes were accepted as on-demand" >&2
  exit 1
fi

sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
  "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
cp "$SOURCE" "$INSTALLED"
LAUNCHCTL_MODE=missing
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"; then
  echo "FAIL: an unregistered unit was accepted" >&2
  exit 1
fi

# ── FLY-2701 review R3 HIGH: the deploy must migrate the host's legacy resident
# plist, not fail closed on it. Today's host still runs the resident contract,
# so a managed restart that only refuses would roll back every deploy of this
# head and the on-demand lifecycle would never take effect.
LAUNCHCTL_MODE=valid
MIGRATION_STATE_DIR="$ROOT/state"
mkdir -p "$MIGRATION_STATE_DIR"
seed_sessions() {
  python3 - "$MIGRATION_STATE_DIR/teamlead.db" "$1" <<'SEED_PY'
import sqlite3,sys
con=sqlite3.connect(sys.argv[1])
con.execute("DROP TABLE IF EXISTS voice_sessions")
con.execute("CREATE TABLE voice_sessions (session_id TEXT PRIMARY KEY, state TEXT NOT NULL)")
if sys.argv[2] != "none":
    con.execute("INSERT INTO voice_sessions VALUES ('s1', ?)", (sys.argv[2],))
con.commit()
SEED_PY
}
install_resident_bytes() {
  sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
    "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
  cp "$SOURCE" "$INSTALLED"
  python3 - "$INSTALLED" <<'RESIDENT_PY'
import plistlib,sys
p=plistlib.load(open(sys.argv[1],'rb'))
p['RunAtLoad']=True
p['KeepAlive']={'SuccessfulExit':False}
p['ThrottleInterval']=30
plistlib.dump(p,open(sys.argv[1],'wb'))
RESIDENT_PY
}

SUPERVISOR_LOADED=1
supervisor_is_loaded() { [[ "${SUPERVISOR_LOADED:-1}" == 1 ]]; }
log() { printf '%s\n' "$*" >> "$ROOT/voice-restart.log"; }
sleep() { printf '%s\n' "$1" >> "$ROOT/sleeps"; }
export FLYWHEEL_DIR="$FIXTURE_REPO"
export FLYWHEEL_STATE_DIR="$MIGRATION_STATE_DIR"
HOME="$FIXTURE_HOME"
# shellcheck source=../lib/restart-voice.sh
source "$REPO_ROOT/scripts/lib/restart-voice.sh"

reset_fly2819_launchctl_state() {
  rm -rf "$LAUNCHCTL_STATE"
  mkdir -p "$LAUNCHCTL_STATE"
  : > "$ROOT/launchctl-calls"
  : > "$ROOT/sleeps"
  : > "$ROOT/voice-restart.log"
  LAUNCHCTL_MODE=valid
  LAUNCHCTL_DISABLED_MODE=enabled
  SUPERVISOR_LOADED=1
  VOICE_RESTART_STATE=not_attempted
  VOICE_RESTART_DETAIL=""
}

install_on_demand_bytes() {
  sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
    "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
  cp "$SOURCE" "$INSTALLED"
}

# A live call must never be interrupted by a migration: defer, do not fail.
install_resident_bytes
seed_sessions live
: > "$ROOT/launchctl-calls"
if ! restart_voice_managed; then
  echo "FAIL: an active call must defer the migration, not fail the deploy" >&2
  exit 1
fi
[[ "$VOICE_RESTART_STATE" == "deferred" ]] || {
  echo "FAIL: expected deferred, got $VOICE_RESTART_STATE" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: deferred migration must not bootout a unit serving a call" >&2
  exit 1
fi

# Unknown session state is not proof that nobody is talking.
install_resident_bytes
rm -f "$MIGRATION_STATE_DIR/teamlead.db"
: > "$ROOT/launchctl-calls"
restart_voice_managed
[[ "$VOICE_RESTART_STATE" == "deferred" ]] || {
  echo "FAIL: unreadable session state must defer, got $VOICE_RESTART_STATE" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: unproven quiet host must not be booted out" >&2
  exit 1
fi

# No call in progress: migrate the resident unit to the on-demand contract.
install_resident_bytes
seed_sessions none
: > "$ROOT/launchctl-calls"
if ! restart_voice_managed; then
  echo "FAIL: a quiet host must migrate, got $VOICE_RESTART_DETAIL" >&2
  exit 1
fi
[[ "$VOICE_RESTART_STATE" == "migrated" ]] || {
  echo "FAIL: expected migrated, got $VOICE_RESTART_STATE" >&2; exit 1; }
grep -q "bootout ${DOMAIN}/com.flywheel.voice" "$ROOT/launchctl-calls" || {
  echo "FAIL: the resident daemon was never stopped" >&2; exit 1; }
grep -q "bootstrap ${DOMAIN} $INSTALLED" "$ROOT/launchctl-calls" || {
  echo "FAIL: the on-demand unit was never registered" >&2; exit 1; }
cmp -s "$SOURCE" "$INSTALLED" || {
  echo "FAIL: installed bytes are not the on-demand contract" >&2; exit 1; }

# Already on-demand: no bootout, no reinstall, stays dormant.
: > "$ROOT/launchctl-calls"
restart_voice_managed
[[ "$VOICE_RESTART_STATE" == "registered" ]] || {
  echo "FAIL: expected registered, got $VOICE_RESTART_STATE" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: a current on-demand registration must not be restarted" >&2
  exit 1
fi

# Unknown drift is neither the legacy contract nor current: keep failing closed.
printf '\n<!-- unknown drift -->\n' >> "$INSTALLED"
seed_sessions none
: > "$ROOT/launchctl-calls"
if restart_voice_managed; then
  echo "FAIL: unknown installed drift must still refuse" >&2
  exit 1
fi
[[ "$VOICE_RESTART_DETAIL" == "on_demand_contract_mismatch" ]] || {
  echo "FAIL: expected contract mismatch, got $VOICE_RESTART_DETAIL" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: unknown drift must not be booted out blindly" >&2
  exit 1
fi

# ── FLY-2701 review R1 MEDIUM: "legacy shaped" is not "the legacy contract".
# The predicate claimed to recognise the known resident bytes exactly, but only
# compared four fields — so an installed unit running somebody else's program,
# or carrying extra keys, was booted out and overwritten as if it were ours.
# That is precisely the unknown drift this seam exists to refuse.
assert_refuses_drift() {
  local label="$1"
  seed_sessions none
  : > "$ROOT/launchctl-calls"
  if restart_voice_managed; then
    echo "FAIL: ${label} must not be treated as the known legacy contract" >&2
    exit 1
  fi
  [[ "$VOICE_RESTART_DETAIL" == "on_demand_contract_mismatch" ]] || {
    echo "FAIL: ${label} expected contract mismatch, got $VOICE_RESTART_DETAIL" >&2
    exit 1
  }
  if grep -q bootout "$ROOT/launchctl-calls"; then
    echo "FAIL: ${label} must not be booted out blindly" >&2
    exit 1
  fi
}

install_resident_bytes
python3 - "$INSTALLED" <<'EXTRA_PY'
import plistlib,sys
p=plistlib.load(open(sys.argv[1],'rb'))
p['EnvironmentVariables']={'FLYWHEEL_TOKEN':'someone-elses'}
plistlib.dump(p,open(sys.argv[1],'wb'))
EXTRA_PY
assert_refuses_drift "a legacy-shaped unit carrying an extra key"

install_resident_bytes
python3 - "$INSTALLED" <<'PROGRAM_PY'
import plistlib,sys
p=plistlib.load(open(sys.argv[1],'rb'))
p['ProgramArguments']=['/bin/bash','/tmp/not-our-wrapper.sh']
plistlib.dump(p,open(sys.argv[1],'wb'))
PROGRAM_PY
assert_refuses_drift "a legacy-shaped unit running a different program"

install_resident_bytes
python3 - "$INSTALLED" <<'KEEPALIVE_PY'
import plistlib,sys
p=plistlib.load(open(sys.argv[1],'rb'))
p['KeepAlive']=True
plistlib.dump(p,open(sys.argv[1],'wb'))
KEEPALIVE_PY
assert_refuses_drift "a legacy-shaped unit with a KeepAlive we never shipped"

# The loaded job must be the one the file describes. A plist that reads as the
# legacy contract while launchd is running something else is not ours to stop.
install_resident_bytes
seed_sessions none
LAUNCHCTL_MODE=invalid
: > "$ROOT/launchctl-calls"
if restart_voice_managed; then
  echo "FAIL: an unreadable loaded identity must not authorise a bootout" >&2
  exit 1
fi
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: migration ran without proving the loaded job identity" >&2
  exit 1
fi
LAUNCHCTL_MODE=valid

# Negative control: the genuine legacy contract still migrates.
install_resident_bytes
seed_sessions none
: > "$ROOT/launchctl-calls"
restart_voice_managed
[[ "$VOICE_RESTART_STATE" == "migrated" ]] || {
  echo "FAIL: the real legacy contract must still migrate, got $VOICE_RESTART_STATE" >&2
  exit 1
}

fly2819_waits_for_absent_before_bootstrap() {
  local first_print bootstrap
  reset_fly2819_launchctl_state
  install_resident_bytes
  printf '2\n' > "$LAUNCHCTL_STATE/teardown-ticks"
  voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  first_print="$(grep -n '^print ' "$ROOT/launchctl-calls" | head -1 | cut -d: -f1)"
  bootstrap="$(grep -n '^bootstrap ' "$ROOT/launchctl-calls" | head -1 | cut -d: -f1)"
  [[ -n "$first_print" && -n "$bootstrap" && "$first_print" -lt "$bootstrap" ]]
}

fly2819_retries_transient_bootstrap_failures() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  printf '2\n' > "$LAUNCHCTL_STATE/bootstrap-failures-left"
  voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  [[ "$(cat "$LAUNCHCTL_STATE/bootstrap-count")" == 3 ]] || return 1
  [[ "$(cat "$ROOT/sleeps")" == $'1\n2' ]]
}

fly2819_reports_exhausted_bootstrap_error() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  : > "$LAUNCHCTL_STATE/bootstrap-fail-always"
  if voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN"; then return 1; fi
  [[ "$(cat "$LAUNCHCTL_STATE/bootstrap-count")" == 5 ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'rc=5'* ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'Bootstrap failed: 5: Input/output error'* ]] || return 1
  grep -q 'Bootstrap failed: 5: Input/output error' "$ROOT/voice-restart.log"
}

fly2819_waits_for_registered_contract_visibility() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  printf '2\n' > "$LAUNCHCTL_STATE/registration-lag-ticks"
  voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  [[ "$(cat "$LAUNCHCTL_STATE/bootstrap-count")" == 1 ]] || return 1
  [[ "$(grep -c '^print ' "$ROOT/launchctl-calls")" -ge 3 ]]
}

fly2819_keeps_visibility_grace_with_one_bootstrap_attempt() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  printf '2\n' > "$LAUNCHCTL_STATE/registration-lag-ticks"
  FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS=1
  if ! voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN"; then
    unset FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS
    return 1
  fi
  unset FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS
  [[ "$(cat "$LAUNCHCTL_STATE/bootstrap-count")" == 1 ]] || return 1
  [[ "$(grep -c '^print ' "$ROOT/launchctl-calls")" -ge 3 ]]
}

fly2819_recovers_installed_but_unregistered_contract() {
  reset_fly2819_launchctl_state
  install_on_demand_bytes
  : > "$LAUNCHCTL_STATE/absent"
  SUPERVISOR_LOADED=0
  restart_voice_managed || return 1
  [[ "$VOICE_RESTART_STATE" == registered ]] || return 1
  [[ "$(cat "$LAUNCHCTL_STATE/bootstrap-count")" == 1 ]] || return 1
  voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"
}

fly2819_reports_unregistered_recovery_failure() {
  reset_fly2819_launchctl_state
  install_on_demand_bytes
  : > "$LAUNCHCTL_STATE/absent"
  : > "$LAUNCHCTL_STATE/bootstrap-fail-always"
  SUPERVISOR_LOADED=0
  if restart_voice_managed; then return 1; fi
  [[ "$VOICE_RESTART_STATE" == failed ]] || return 1
  [[ "$(cat "$LAUNCHCTL_STATE/bootstrap-count")" == 5 ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'rc=5'* ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'Bootstrap failed: 5: Input/output error'* ]]
}

fly2819_respects_explicitly_disabled_voice() {
  reset_fly2819_launchctl_state
  install_on_demand_bytes
  : > "$LAUNCHCTL_STATE/absent"
  SUPERVISOR_LOADED=0
  LAUNCHCTL_DISABLED_MODE=disabled
  restart_voice_managed || return 1
  [[ "$VOICE_RESTART_STATE" == not_loaded ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'explicitly disabled'* ]] || return 1
  ! grep -q '^bootstrap ' "$ROOT/launchctl-calls"
}

fly2819_fails_closed_when_disabled_overrides_are_unreadable() {
  reset_fly2819_launchctl_state
  install_on_demand_bytes
  : > "$LAUNCHCTL_STATE/absent"
  SUPERVISOR_LOADED=0
  LAUNCHCTL_DISABLED_MODE=unreadable
  restart_voice_managed || return 1
  [[ "$VOICE_RESTART_STATE" == not_loaded ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'disabled overrides unreadable'* ]] || return 1
  ! grep -q '^bootstrap ' "$ROOT/launchctl-calls"
}

fly2819_accepts_registration_after_bootstrap_error() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  : > "$LAUNCHCTL_STATE/bootstrap-registers-on-error"
  voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  [[ "$(cat "$LAUNCHCTL_STATE/bootstrap-count")" == 1 ]] || return 1
  voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"
}

fly2819_lazy_loads_contract_helpers_for_recovery() {
  reset_fly2819_launchctl_state
  install_on_demand_bytes
  : > "$LAUNCHCTL_STATE/absent"
  SUPERVISOR_LOADED=0
  (
    unset -f voice_on_demand_contract_check voice_on_demand_disk_contract_check
    # shellcheck source=../lib/restart-voice.sh
    source "$REPO_ROOT/scripts/lib/restart-voice.sh"
    restart_voice_managed || return 1
    declare -F voice_on_demand_contract_check >/dev/null || return 1
    declare -F voice_on_demand_disk_contract_check >/dev/null || return 1
    [[ "$VOICE_RESTART_STATE" == registered ]]
  )
}

fly2819_invalid_tuning_warns_and_uses_default() {
  local value
  reset_fly2819_launchctl_state
  FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS=invalid
  value="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS 5 '^[1-9][0-9]*$')"
  unset FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS
  [[ "$value" == 5 ]] || return 1
  grep -q "invalid FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS='invalid'; using default 5" \
    "$ROOT/voice-restart.log"
}

fly2819_lazy_loads_when_only_disk_helper_is_missing() {
  reset_fly2819_launchctl_state
  install_on_demand_bytes
  : > "$LAUNCHCTL_STATE/absent"
  SUPERVISOR_LOADED=0
  (
    voice_on_demand_contract_check() { return 1; }
    unset -f voice_on_demand_disk_contract_check
    # shellcheck source=../lib/restart-voice.sh
    source "$REPO_ROOT/scripts/lib/restart-voice.sh"
    restart_voice_managed || return 1
    declare -F voice_on_demand_disk_contract_check >/dev/null || return 1
    [[ "$VOICE_RESTART_STATE" == registered ]]
  )
}

fly2819_delegates_tuning_to_supervisor_helper() {
  local value
  reset_fly2819_launchctl_state
  _sup_tuning() {
    printf '%s|%s|%s\n' "$1" "$2" "$3" > "$ROOT/sup-tuning-call"
    printf '7\n'
  }
  value="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS 5 '^[1-9][0-9]*$')"
  unset -f _sup_tuning
  [[ "$value" == 7 ]] || return 1
  [[ "$(cat "$ROOT/sup-tuning-call")" == \
    'FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS|5|^[1-9][0-9]*$' ]]
}

FLY2819_FAILED=0
run_fly2819_case() {
  local name="$1" function_name="$2"
  if "$function_name"; then
    echo "FLY-2819 PASS: $name"
  else
    echo "FLY-2819 FAIL: $name" >&2
    FLY2819_FAILED=$((FLY2819_FAILED + 1))
  fi
}

run_fly2819_case "waits for absent before bootstrap" fly2819_waits_for_absent_before_bootstrap
run_fly2819_case "retries transient bootstrap failures" fly2819_retries_transient_bootstrap_failures
run_fly2819_case "reports exhausted bootstrap stderr and rc" fly2819_reports_exhausted_bootstrap_error
run_fly2819_case "waits for registered contract visibility" fly2819_waits_for_registered_contract_visibility
run_fly2819_case "keeps registration visibility grace with one bootstrap attempt" fly2819_keeps_visibility_grace_with_one_bootstrap_attempt
run_fly2819_case "recovers installed but unregistered contract" fly2819_recovers_installed_but_unregistered_contract
run_fly2819_case "reports unregistered recovery failure" fly2819_reports_unregistered_recovery_failure
run_fly2819_case "respects an explicitly disabled voice unit" fly2819_respects_explicitly_disabled_voice
run_fly2819_case "fails closed on unreadable disabled overrides" fly2819_fails_closed_when_disabled_overrides_are_unreadable
run_fly2819_case "accepts registration after bootstrap reports an error" fly2819_accepts_registration_after_bootstrap_error
run_fly2819_case "lazy-loads both contract helpers" fly2819_lazy_loads_contract_helpers_for_recovery
run_fly2819_case "warns and defaults invalid tuning" fly2819_invalid_tuning_warns_and_uses_default
run_fly2819_case "lazy-loads missing disk helper" fly2819_lazy_loads_when_only_disk_helper_is_missing
run_fly2819_case "delegates tuning to supervisor helper" fly2819_delegates_tuning_to_supervisor_helper

if [[ "$FLY2819_FAILED" -ne 0 ]]; then
  echo "restart-voice-on-demand: FAIL ($FLY2819_FAILED FLY-2819 scenarios)" >&2
  exit 1
fi

echo "restart-voice-on-demand: PASS"
