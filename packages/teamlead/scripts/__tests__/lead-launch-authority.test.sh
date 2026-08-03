#!/bin/bash
set -u

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

# shellcheck source=../../../../scripts/lib/lead-restart-lifecycle.sh
source "$ROOT/scripts/lib/lead-restart-lifecycle.sh"
# shellcheck source=../lib/lead-launch-authority.sh
source "$SCRIPT_DIR/../lib/lead-launch-authority.sh"

MANIFEST="$TMP_ROOT/manifest.json"
PROJECTS="$TMP_ROOT/projects.json"
PLIST="$TMP_ROOT/lead.plist"
printf '{}\n' > "$MANIFEST"
printf '[]\n' > "$PROJECTS"

AUTHORITY_VALID=1
AUTHORITY_UNCHANGED=1
PROBE=$'loaded\t700'
ACTUAL_START="self-start"
PROCESS_ALIVE=1
lead_restart_validate_authority() { [ "$AUTHORITY_VALID" -eq 1 ]; }
lead_restart_authority_unchanged() { [ "$AUTHORITY_UNCHANGED" -eq 1 ]; }
lead_restart_launchd_probe() { printf '%s\n' "$PROBE"; }
lead_restart_process_start_identity() {
  [ -n "$ACTUAL_START" ] || return 1
  printf '%s\n' "$ACTUAL_START"
}
lead_restart_process_alive() { [ "$PROCESS_ALIVE" -eq 1 ]; }

if lead_launch_authority_prepare \
  "$MANIFEST" "$PLIST" "$PROJECTS" com.flywheel.lead.flywheel-eng \
  gui/501/com.flywheel.lead.flywheel-eng 700 self-start \
  && [ "$LEAD_LAUNCH_MANAGED" = false ]; then
  pass "absent plist preserves unmanaged normal-launch eligibility"
else
  fail "absent plist was not classified unmanaged"
fi

printf '<plist/>\n' > "$PLIST"
if lead_launch_authority_prepare \
  "$MANIFEST" "$PLIST" "$PROJECTS" com.flywheel.lead.flywheel-eng \
  gui/501/com.flywheel.lead.flywheel-eng 700 self-start \
  && [ "$LEAD_LAUNCH_MANAGED" = true ]; then
  pass "managed launchd authority proves exact self pid and lstart"
else
  fail "exact managed authority was rejected: $LEAD_LAUNCH_AUTHORITY_REASON"
fi

for fixture in error unloaded loaded-zero foreign sensor dead; do
  AUTHORITY_VALID=1
  ACTUAL_START="self-start"
  PROCESS_ALIVE=1
  case "$fixture" in
    error) PROBE=error; expected=launchd_probe_error ;;
    unloaded) PROBE=unloaded; expected=launchd_unloaded ;;
    loaded-zero) PROBE=$'loaded\t0'; expected=launchd_pid_missing ;;
    foreign) PROBE=$'loaded\t701'; expected=launchd_foreign_pid ;;
    sensor) PROBE=$'loaded\t700'; ACTUAL_START=""; expected=supervisor_start_sensor_degraded ;;
    dead) PROBE=$'loaded\t700'; PROCESS_ALIVE=0; expected=supervisor_not_alive ;;
  esac
  if lead_launch_authority_prepare \
    "$MANIFEST" "$PLIST" "$PROJECTS" com.flywheel.lead.flywheel-eng \
    gui/501/com.flywheel.lead.flywheel-eng 700 self-start >/dev/null 2>&1; then
    fail "$fixture managed authority was accepted"
  elif [ "$LEAD_LAUNCH_AUTHORITY_REASON" = "$expected" ]; then
    pass "$fixture managed authority HOLDs with typed reason"
  else
    fail "$fixture reason was '$LEAD_LAUNCH_AUTHORITY_REASON' expected '$expected'"
  fi
done

AUTHORITY_VALID=0
PROBE=$'loaded\t700'
ACTUAL_START=self-start
PROCESS_ALIVE=1
if lead_launch_authority_prepare \
  "$MANIFEST" "$PLIST" "$PROJECTS" com.flywheel.lead.flywheel-eng \
  gui/501/com.flywheel.lead.flywheel-eng 700 self-start >/dev/null 2>&1; then
  fail "invalid disk authority was accepted"
elif [ "$LEAD_LAUNCH_AUTHORITY_REASON" = disk_authority_unproven ]; then
  pass "invalid disk authority HOLDs before process ownership"
else
  fail "disk authority reason was '$LEAD_LAUNCH_AUTHORITY_REASON'"
fi

AUTHORITY_VALID=1
AUTHORITY_UNCHANGED=0
if lead_launch_authority_recheck >/dev/null 2>&1; then
  fail "changed authority passed pre-launch recheck"
elif [ "$LEAD_LAUNCH_AUTHORITY_REASON" = disk_authority_changed ]; then
  pass "pre-launch recheck rejects authority drift"
else
  fail "authority drift reason was '$LEAD_LAUNCH_AUTHORITY_REASON'"
fi

AUTHORITY_VALID=1
AUTHORITY_UNCHANGED=1
lead_launch_authority_prepare \
  "$MANIFEST" "$PLIST" "$PROJECTS" com.flywheel.lead.flywheel-eng \
  gui/501/com.flywheel.lead.flywheel-eng 700 self-start >/dev/null
rm -f "$PLIST"
AUTHORITY_VALID=0
if lead_launch_authority_refresh >/dev/null 2>&1; then
  fail "a removed managed plist downgraded into unmanaged mode"
elif [ "$LEAD_LAUNCH_MANAGED" = true ] \
  && [ "$LEAD_LAUNCH_AUTHORITY_REASON" = disk_authority_unproven ]; then
  pass "managed authority stays fail-closed when its plist disappears"
else
  fail "removed managed plist classification was unsafe"
fi

broken="$TMP_ROOT/broken.plist"
ln -s "$TMP_ROOT/missing-target" "$broken"
AUTHORITY_VALID=0
if lead_launch_authority_prepare \
  "$MANIFEST" "$broken" "$PROJECTS" com.flywheel.lead.flywheel-eng \
  gui/501/com.flywheel.lead.flywheel-eng 700 self-start >/dev/null 2>&1; then
  fail "broken plist symlink fell through as unmanaged"
elif [ "$LEAD_LAUNCH_MANAGED" = true ] \
  && [ "$LEAD_LAUNCH_AUTHORITY_REASON" = disk_authority_unproven ]; then
  pass "broken plist symlink stays managed and fail-closed"
else
  fail "broken plist symlink classification was unsafe"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
