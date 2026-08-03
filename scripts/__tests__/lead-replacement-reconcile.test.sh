#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1602-reconcile.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$ROOT/scripts/lib/lead-restart-lifecycle.sh"
FUNCTION_SOURCE="$(sed -n '/^lead_replacement_reconcile_ready()/,/^}/p' \
  "$ROOT/scripts/restart-services.sh")"
[[ -n "$FUNCTION_SOURCE" ]] || { printf 'missing reconcile function\n' >&2; exit 1; }
eval "$FUNCTION_SOURCE"

export HOME="$TEST_ROOT/home"
mkdir -p "$HOME/.flywheel/pids"
MARKER="$TEST_ROOT/flywheel-eng-lead.json"
printf '%s\n' '{"intent":"fixture"}' > "$MARKER"
printf '%s\n' 101 > "$HOME/.flywheel/pids/flywheel-eng-lead.pid"

LEAD_RESTART_MANIFEST_FILE="$TEST_ROOT/manifest.json"
printf '%s\n' '{}' > "$LEAD_RESTART_MANIFEST_FILE"
LEAD_RESTART_LOADED_MARKER_DAEMON_KEY=flywheel-eng-lead
LEAD_RESTART_LOADED_MARKER_LABEL=com.flywheel.lead.flywheel-eng-lead
LEAD_RESTART_LOADED_MARKER_ATTEMPT=11111111-1111-4111-8111-111111111111
LEAD_RESTART_LOADED_MARKER_PROJECT=flywheel
LEAD_RESTART_LOADED_MARKER_LEAD_ID=eng-lead
LEAD_RESTART_LOADED_MARKER_BACKEND=claude-code
LEAD_RESTART_LOADED_MARKER_OLD_PID=100
LEAD_RESTART_LOADED_MARKER_OLD_START=old-start
LEAD_RESTART_LOADED_MARKER_BASELINE='{"status":"absent"}'
LEAD_RESTART_LOADED_MARKER_TS=2026-08-02T00:00:00.000Z

id() { printf '%s\n' 501; }
lead_restart_load_replacement_marker() { return 0; }
_lead_restart_gate_snapshot() {
  LEAD_RESTART_GATE_LAST_STATE=active
  LEAD_RESTART_GATE_FAILURE_REASON=""
  return 0
}
lead_restart_launchd_probe() { printf 'loaded\t101\n'; }
lead_restart_process_start_identity() { printf '%s\n' new-start; }
lead_restart_progress_snapshot() {
  LEAD_RESTART_LEASE_BASELINE='{"status":"present","rowFormat":"version_valid","generation":4,"supervisorPid":101,"supervisorStart":"new-start","supervisorGeneration":4,"holderPid":201,"holderStart":"body-start","boundAt":"2026-08-02T00:01:01.000Z","acquiredAt":"2026-08-02T00:01:00.000Z"}'
  return 0
}
lead_body_adoption_evidence() {
  printf '#status=complete\n'
  printf '201\tbody-start\tfull\twindow\t@1\t%%1\tsession-1\n'
}
lead_body_model_evidence() { printf '%s\n' claude-opus-4-6; }
lead_restart_verify_bound() {
  LEAD_RESTART_VERIFIED_GENERATION=4
  return 0
}
lead_restart_replacement_progressed() { return 1; }

if lead_replacement_reconcile_ready "$MARKER" \
  && [[ "$VERIFIED_LEAD_PID" == 101 && "$VERIFIED_BODY_PID" == 201 \
    && "$VERIFIED_LEASE_GENERATION" == 4 && -f "$MARKER" ]]; then
  pass "reconcile resolves only a full positive N0-N5 closure and preserves deletion authority"
else
  fail "full reconcile closure was not recognized"
fi

printf '%s\n' 999 > "$HOME/.flywheel/pids/flywheel-eng-lead.pid"
lead_restart_replacement_progressed() { return 0; }
rc=0
lead_replacement_reconcile_ready "$MARKER" || rc=$?
if [[ "$rc" -eq 4 && "$LEAD_REPLACEMENT_RECONCILE_REASON" == pid_file_mismatch ]]; then
  pass "exact lease progress yields converging without widening PID-file readiness"
else
  fail "reconcile progress did not preserve the failed positive predicate"
fi

lead_restart_launchd_probe() { printf '%s\n' unloaded; }
lead_restart_replacement_progressed() { return 1; }
rc=0
lead_replacement_reconcile_ready "$MARKER" || rc=$?
if [[ "$rc" -eq 1 && "$LEAD_REPLACEMENT_RECONCILE_REASON" == supervisor_unloaded ]]; then
  pass "unloaded retained intent is not reported as resolved"
else
  fail "unloaded retained intent escaped the no-progress state"
fi

lead_restart_launchd_probe() { printf 'loaded\t0\n'; }
rc=0
lead_replacement_reconcile_ready "$MARKER" || rc=$?
if [[ "$rc" -eq 1 \
  && "$LEAD_REPLACEMENT_RECONCILE_REASON" == supervisor_not_started ]]; then
  pass "launchd loaded without a positive PID falls through to normal lifecycle"
else
  fail "loaded-zero launchd state was misreported as resolved or blocked"
fi

_lead_restart_gate_snapshot() {
  LEAD_RESTART_GATE_FAILURE_REASON=status_rc_2
  return 1
}
rc=0
lead_replacement_reconcile_ready "$MARKER" || rc=$?
if [[ "$rc" -eq 2 \
  && "$LEAD_REPLACEMENT_RECONCILE_REASON" == gate_control_status_rc_2 ]]; then
  pass "gate sensor failure blocks reconcile with typed evidence"
else
  fail "gate sensor failure was collapsed into an ordinary retry"
fi

# A retained marker belongs to an earlier replacement transaction. Resolving
# it at the start of a later deploy must not exempt that Lead from the later
# deploy's full-fleet restart wave (or it keeps running the pre-build code).
RESTART_ROOT="$TEST_ROOT/restart-wave"
RESTART_CALLS="$RESTART_ROOT/restart-calls"
mkdir -p "$RESTART_ROOT/repo/scripts" "$RESTART_ROOT/home" \
  "$RESTART_ROOT/markers" "$RESTART_ROOT/tmp"
printf '%s\n' 'exit 0' > "$RESTART_ROOT/repo/scripts/converge-flywheel-bin.sh"
printf '%s\n' '{}' > "$RESTART_ROOT/manifest.json"
printf '%s\n' '{}' > "$RESTART_ROOT/markers/flywheel-eng-lead.json"

(
  DO_RESTART_SOURCE="$(sed -n '/^do_restart_all_leads()/,/^}/p' \
    "$ROOT/scripts/restart-services.sh")"
  [[ -n "$DO_RESTART_SOURCE" ]] || exit 2
  eval "$DO_RESTART_SOURCE"

  export HOME="$RESTART_ROOT/home"
  export TMPDIR="$RESTART_ROOT/tmp"
  export FLYWHEEL_DIR="$RESTART_ROOT/repo"
  export FLYWHEEL_LEAD_REPLACEMENT_DIR="$RESTART_ROOT/markers"

  log() { :; }
  alert_warning() { :; }
  alert_severe() { :; }
  register_restart_transient_file() { :; }
  lead_restart_collect_candidates() {
    printf 'flywheel-eng-lead\tflywheel\teng-lead\t%s\trestart\tmanifest\n' \
      "$RESTART_ROOT/manifest.json" > "$4"
  }
  lead_restart_load_replacement_marker() {
    LEAD_RESTART_LOADED_MARKER_DAEMON_KEY=flywheel-eng-lead
    LEAD_RESTART_LOADED_MARKER_LABEL=com.flywheel.lead.flywheel-eng-lead
    LEAD_RESTART_LOADED_MARKER_ATTEMPT=11111111-1111-4111-8111-111111111111
    LEAD_RESTART_LOADED_MARKER_PROJECT=flywheel
    LEAD_RESTART_LOADED_MARKER_LEAD_ID=eng-lead
    LEAD_RESTART_LOADED_MARKER_BACKEND=claude-code
    LEAD_RESTART_LOADED_MARKER_OLD_PID=100
    LEAD_RESTART_LOADED_MARKER_OLD_START=old-start
    LEAD_RESTART_MANIFEST_FILE="$RESTART_ROOT/manifest.json"
    LEAD_RESTART_PLIST_FILE="$RESTART_ROOT/lead.plist"
    return 0
  }
  lead_restart_launchd_probe() { printf 'loaded\t101\n'; }
  lead_replacement_reconcile_ready() {
    VERIFIED_LEAD_PID=101
    VERIFIED_BODY_PID=201
    VERIFIED_LEASE_GENERATION=4
    return 0
  }
  lead_restart_remove_marker() { return 0; }
  restart_lead() { printf '%s\n' "$1" >> "$RESTART_CALLS"; }

  do_restart_all_leads >/dev/null
)
if [[ -f "$RESTART_CALLS" && "$(wc -l < "$RESTART_CALLS")" -eq 1 ]]; then
  pass "reconciled retained intent still enters the current full-fleet restart wave"
else
  fail "reconciled retained intent incorrectly skipped the current restart wave"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
