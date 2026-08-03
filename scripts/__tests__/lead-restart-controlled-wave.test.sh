#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1602-controlled-wave.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$ROOT/scripts/lib/lead-restart-lifecycle.sh"

MARKER="$TMP_ROOT/flywheel-eng-lead.json"
printf '{"attempt_id":"11111111-1111-4111-8111-111111111111"}\n' > "$MARKER"
ATTEMPT="11111111-1111-4111-8111-111111111111"
AUTHORITY_OK=1
MARKER_DIGEST="fixture-digest"
STATUS_CALLS=0
ARM_CALLS=0
ARM_MODE=race-once
CALL_LOG="$TMP_ROOT/gate.calls"
DIGEST_FILE="$TMP_ROOT/marker.digest"
printf '%s\n' "$MARKER_DIGEST" > "$DIGEST_FILE"

lead_restart_file_digest() { cat "$DIGEST_FILE"; }
lead_restart_authority_unchanged() { [[ "$AUTHORITY_OK" -eq 1 ]]; }
lead_restart_gate_exec() { # timeout args...
  local timeout="$1" command="$2"
  shift 2
  printf '%s\t%s\t%s\n' "$timeout" "$command" "$*" >> "$CALL_LOG"
  case "$command" in
    status)
      if [[ "$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG" || true)" -eq 0 ]]; then
        printf '{"state":"held_alert_attempted","last_resumed_seq":0,"episode_key":"lead.flywheel-eng-lead__20260802T120000Z__1","window_start":"2026-08-02T12:00:00.000Z","ledger_seq":4}\n'
      else
        printf '{"state":"active","last_resumed_seq":0,"ledger_seq":5}\n'
      fi
      ;;
    arm-controlled-wave)
      local arm_count
      arm_count="$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG" || true)"
      case "$ARM_MODE:$arm_count" in
        race-once:1|always-race:*)
          printf '{"status":"not_armed","reason":"seq_changed","expectedSeq":4,"ledgerSeq":5}\n'
          return 3
          ;;
        *)
          printf '{"status":"armed","attemptId":"%s","ledgerSeq":5,"markerDigest":"digest"}\n' "$ATTEMPT"
          ;;
      esac
      ;;
    *) return 4 ;;
  esac
}

if lead_restart_arm_controlled_wave \
  flywheel-eng-lead "$MARKER" "$ATTEMPT" "$TMP_ROOT/ledger" \
  && [[ "$(grep -c $'\tstatus\t' "$CALL_LOG")" -eq 2 ]] \
  && [[ "$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG")" -eq 2 ]] \
  && grep -q 'arm-controlled-wave.*--expected-seq 4' "$CALL_LOG" \
  && grep -q 'arm-controlled-wave.*--expected-seq 5' "$CALL_LOG"; then
  pass "seq_changed is resampled once and converges under the same marker/authority"
else
  fail "controlled-wave seq resampling did not converge"
fi

: > "$CALL_LOG"
STATUS_CALLS=0
ARM_CALLS=0
ARM_MODE=always-race
if lead_restart_arm_controlled_wave \
  flywheel-eng-lead "$MARKER" "$ATTEMPT" "$TMP_ROOT/ledger" >/dev/null 2>&1; then
  fail "three seq races were armed"
elif [[ "$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG")" -eq 3 ]] \
  && [[ "$LEAD_RESTART_GATE_FAILURE_REASON" == seq_changed_exhausted ]]; then
  pass "three seq races fail closed with typed exhaustion"
else
  fail "seq race exhaustion reason/counter was wrong"
fi

STATUS_CALLS=0
ARM_CALLS=0
ARM_MODE=always-race
MARKER_DIGEST=before
printf '%s\n' before > "$DIGEST_FILE"
lead_restart_gate_exec() {
  local timeout="$1" command="$2"
  shift 2
  case "$command" in
    status)
      printf '{"state":"active","last_resumed_seq":0,"ledger_seq":1}\n'
      ;;
    arm-controlled-wave)
      printf '%s\n' after > "$DIGEST_FILE"
      printf '{"status":"not_armed","reason":"seq_changed","expectedSeq":1,"ledgerSeq":2}\n'
      return 3
      ;;
  esac
}
if lead_restart_arm_controlled_wave \
  flywheel-eng-lead "$MARKER" "$ATTEMPT" "$TMP_ROOT/ledger" >/dev/null 2>&1; then
  fail "marker drift after seq race was armed"
elif [[ "$LEAD_RESTART_GATE_FAILURE_REASON" == marker_changed ]]; then
  pass "marker drift during resampling fails closed"
else
  fail "marker drift did not preserve its typed reason"
fi

# N5 verifier contract: only rc 0 + exact verified JSON is success; typed rc 3
# remains evidence mismatch and every malformed/control outcome is fail closed.
VERIFY_MODE=ok
lead_restart_verify_exec() {
  case "$VERIFY_MODE" in
    ok) printf '{"status":"verified","generation":9}\n' ;;
    mismatch) printf '{"status":"mismatch","reason":"holder_mismatch"}\n'; return 3 ;;
    malformed) printf '{"status":"verified"}\n' ;;
    missing) return 127 ;;
  esac
}
if lead_restart_verify_bound \
  flywheel-eng-lead 100 sup-start 200 body-start \
  && [[ "$LEAD_RESTART_VERIFIED_GENERATION" == 9 ]]; then
  pass "N5 accepts only a valid verified generation"
else
  fail "N5 rejected valid bound evidence"
fi
VERIFY_MODE=mismatch
rc=0
lead_restart_verify_bound flywheel-eng-lead 100 sup-start 200 body-start || rc=$?
if [[ "$rc" -eq 3 && "$LEAD_RESTART_VERIFY_REASON" == holder_mismatch ]]; then
  pass "N5 preserves typed lease evidence mismatch"
else
  fail "N5 collapsed evidence mismatch into a generic failure"
fi
for mode in malformed missing; do
  VERIFY_MODE="$mode"
  rc=0
  lead_restart_verify_bound flywheel-eng-lead 100 sup-start 200 body-start || rc=$?
  if [[ "$rc" -eq 2 && "$LEAD_RESTART_VERIFY_REASON" == lease_control_failure ]]; then
    pass "N5 $mode output is a lease-control failure"
  else
    fail "N5 $mode output escaped fail-closed control classification"
  fi
done

PROGRESS_MODE=absent
lead_restart_progress_exec() {
  case "$PROGRESS_MODE" in
    absent) printf '{"status":"absent"}\n' ;;
    valid) printf '{"status":"present","rowFormat":"version_valid","generation":3,"supervisorPid":100,"supervisorStart":"sup","supervisorGeneration":3,"holderPid":200,"holderStart":"body","boundAt":"2026-08-02T12:00:01.000Z","acquiredAt":"2026-08-02T12:00:00.000Z"}\n' ;;
    malformed-row) printf '{"status":"present","rowFormat":"malformed","generation":3,"supervisorPid":100,"supervisorStart":null,"supervisorGeneration":3,"holderPid":200,"holderStart":"body","boundAt":"2026-08-02T12:00:01.000Z","acquiredAt":"2026-08-02T12:00:00.000Z"}\n' ;;
    bad-json) printf '{"status":"present"}\n' ;;
    unavailable) return 127 ;;
  esac
}
if lead_restart_progress_snapshot eng-lead flywheel \
  && [[ "$(printf '%s' "$LEAD_RESTART_LEASE_BASELINE" | jq -r .status)" == absent ]]; then
  pass "lease baseline accepts an atomic absent snapshot"
else
  fail "lease absent baseline was rejected"
fi
PROGRESS_MODE=valid
if lead_restart_progress_snapshot eng-lead flywheel \
  && [[ "$(printf '%s' "$LEAD_RESTART_LEASE_BASELINE" | jq -r .rowFormat)" == version_valid ]]; then
  pass "lease baseline accepts exact version-valid evidence"
else
  fail "lease version-valid baseline was rejected"
fi
for mode in malformed-row bad-json unavailable; do
  PROGRESS_MODE="$mode"
  rc=0
  lead_restart_progress_snapshot eng-lead flywheel || rc=$?
  if [[ "$mode" == malformed-row && "$rc" -eq 3 \
    && "$LEAD_RESTART_BASELINE_REASON" == lease_data_malformed ]]; then
    pass "malformed lease row blocks before replacement mutation"
  elif [[ "$mode" != malformed-row && "$rc" -eq 2 \
    && "$LEAD_RESTART_BASELINE_REASON" == lease_control_failure ]]; then
    pass "$mode lease baseline is a control failure"
  else
    fail "$mode lease baseline escaped fail-closed classification"
  fi
done

MANIFEST="$TMP_ROOT/manifest.json"
PLIST="$TMP_ROOT/lead.plist"
PROJECTS="$TMP_ROOT/projects.json"
MARKER_DIR="$TMP_ROOT/replacements"
printf '%s\n' '{"leadId":"eng-lead","projectDir":"/tmp/project","projectName":"flywheel","botTokenEnv":"TEST_TOKEN","leadBackend":{"backendId":"claude-code"},"pid":999,"model":"volatile"}' > "$MANIFEST"
printf '%s\n' '<plist/>' > "$PLIST"
printf '%s\n' '[]' > "$PROJECTS"
LEAD_RESTART_MANIFEST_FILE="$MANIFEST"
LEAD_RESTART_PLIST_FILE="$PLIST"
LEAD_RESTART_PROJECTS_FILE="$PROJECTS"
LEAD_RESTART_PLIST_DIGEST="$(shasum -a 256 "$PLIST" | awk '{print $1}')"
LEAD_RESTART_PROJECTS_DIGEST="$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
LEAD_RESTART_LEASE_BASELINE='{"status":"absent"}'
FLYWHEEL_LEAD_REPLACEMENT_DIR="$MARKER_DIR"
if lead_restart_write_replacement_marker \
  flywheel-eng-lead com.flywheel.lead.flywheel-eng-lead 700 old-start \
  && [[ -f "$LEAD_RESTART_MARKER_FILE" && ! -L "$LEAD_RESTART_MARKER_FILE" ]] \
  && [[ "$(stat -f %Lp "$LEAD_RESTART_MARKER_FILE" 2>/dev/null || stat -c %a "$LEAD_RESTART_MARKER_FILE")" == 600 ]] \
  && jq -e --arg attempt "$LEAD_RESTART_ATTEMPT_ID" \
       '.schema_version == 1 and .attempt_id == $attempt and .phase == "bootout"
        and .old_supervisor_tuple.pid == 700
        and (.authority.manifest.semantic_identity | has("pid") | not)
        and (.authority.manifest.semantic_identity | has("model") | not)' \
       "$LEAD_RESTART_MARKER_FILE" >/dev/null; then
  pass "replacement intent marker is atomic 0600 and excludes volatile manifest evidence"
else
  fail "replacement intent marker contract was not materialized"
fi

BASELINE='{"status":"present","rowFormat":"version_valid","generation":3,"supervisorPid":100,"supervisorStart":"old","supervisorGeneration":3,"holderPid":200,"holderStart":"old-body","boundAt":"2026-08-02T12:00:01.000Z","acquiredAt":"2026-08-02T12:00:00.000Z"}'
PROGRESS_JSON='{"status":"present","rowFormat":"version_valid","generation":4,"supervisorPid":101,"supervisorStart":"new","supervisorGeneration":4,"holderPid":201,"holderStart":"new-body","boundAt":"2026-08-02T12:01:01.000Z","acquiredAt":"2026-08-02T12:01:00.000Z"}'
lead_restart_progress_snapshot() {
  LEAD_RESTART_BASELINE_REASON=""
  LEAD_RESTART_LEASE_BASELINE="$PROGRESS_JSON"
}
if lead_restart_replacement_progressed \
  "$BASELINE" "2026-08-02T12:00:30.000Z" eng-lead flywheel 101 new; then
  pass "new exact supervisor generation is honest replacement progress"
else
  fail "new exact supervisor generation was not recognized"
fi
for mutation in stale foreign legacy; do
  case "$mutation" in
    stale) PROGRESS_JSON="$BASELINE" ;;
    foreign) PROGRESS_JSON='{"status":"present","rowFormat":"version_valid","generation":4,"supervisorPid":999,"supervisorStart":"foreign","supervisorGeneration":4,"holderPid":201,"holderStart":"new-body","boundAt":"2026-08-02T12:01:01.000Z","acquiredAt":"2026-08-02T12:01:00.000Z"}' ;;
    legacy) PROGRESS_JSON='{"status":"present","rowFormat":"legacy","generation":4,"supervisorPid":101,"supervisorStart":"new","supervisorGeneration":null,"holderPid":201,"holderStart":"new-body","boundAt":"2026-08-02T12:01:01.000Z","acquiredAt":"2026-08-02T12:01:00.000Z"}' ;;
  esac
  if lead_restart_replacement_progressed \
    "$BASELINE" "2026-08-02T12:00:30.000Z" eng-lead flywheel 101 new; then
    fail "$mutation lease evidence was widened into replacement progress"
  else
    pass "$mutation lease evidence is not replacement progress"
  fi
done

GATE_POST_STATE=active
GATE_POST_SEQ=6
GATE_POST_RC=0
_lead_restart_gate_snapshot() {
  if [[ "$GATE_POST_RC" -ne 0 ]]; then
    LEAD_RESTART_GATE_FAILURE_REASON=status_rc_2
    return 1
  fi
  LEAD_RESTART_GATE_LAST_STATE="$GATE_POST_STATE"
  LEAD_RESTART_GATE_LAST_SEQ="$GATE_POST_SEQ"
  return 0
}
if lead_restart_classify_wave_gate "$TMP_ROOT/ledger" lead.flywheel-eng-lead 5 \
  && [[ "$LEAD_RESTART_GATE_ATTRIBUTION" == gate_executed ]]; then
  pass "active plus advanced seq attributes the wave to N0-N5 diagnosis"
else
  fail "advanced active gate event was not recognized"
fi
GATE_POST_STATE=held_alert_attempted
GATE_POST_SEQ=6
rc=0
lead_restart_classify_wave_gate "$TMP_ROOT/ledger" lead.flywheel-eng-lead 5 || rc=$?
if [[ "$rc" -eq 3 && "$LEAD_RESTART_GATE_ATTRIBUTION" == gate_held ]]; then
  pass "held post-state has priority over seq advancement"
else
  fail "held post-state lost attribution priority"
fi
GATE_POST_STATE=resumed
GATE_POST_SEQ=5
rc=0
lead_restart_classify_wave_gate "$TMP_ROOT/ledger" lead.flywheel-eng-lead 5 || rc=$?
if [[ "$rc" -eq 4 && "$LEAD_RESTART_GATE_ATTRIBUTION" == wrapper_event_unproven ]]; then
  pass "unchanged seq avoids claiming that wrapper dispatch never happened"
else
  fail "unchanged seq was over-attributed"
fi
GATE_POST_STATE=active
GATE_POST_SEQ=4
rc=0
lead_restart_classify_wave_gate "$TMP_ROOT/ledger" lead.flywheel-eng-lead 5 || rc=$?
if [[ "$rc" -eq 2 && "$LEAD_RESTART_GATE_ATTRIBUTION" == gate_control_failure ]]; then
  pass "regressed ledger seq is a gate-control failure"
else
  fail "regressed ledger seq was accepted"
fi
GATE_POST_RC=1
rc=0
lead_restart_classify_wave_gate "$TMP_ROOT/ledger" lead.flywheel-eng-lead 5 || rc=$?
if [[ "$rc" -eq 2 && "$LEAD_RESTART_GATE_ATTRIBUTION" == gate_control_failure ]]; then
  pass "unreadable post-status is a gate-control failure"
else
  fail "unreadable post-status escaped fail-closed attribution"
fi

RECON_DIR="$TMP_ROOT/reconcile"
RECON_MARKERS="$RECON_DIR/markers"
RECON_MANIFEST="$RECON_DIR/flywheel-eng-lead.json"
RECON_PLIST="$RECON_DIR/com.flywheel.lead.flywheel-eng-lead.plist"
RECON_PROJECTS="$RECON_DIR/projects.json"
lead_restart_file_digest() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  shasum -a 256 "$1" | awk '{print $1}'
}
LEAD_RESTART_MARKER_LOAD_REASON=""
LEAD_RESTART_LOADED_MARKER_DAEMON_KEY=""
LEAD_RESTART_LOADED_MARKER_PROJECT=""
LEAD_RESTART_LOADED_MARKER_LEAD_ID=""
mkdir -p "$RECON_DIR"
printf '%s\n' \
  '{"leadId":"eng-lead","projectDir":"/tmp/project","projectName":"flywheel","botTokenEnv":"TEST_TOKEN","leadBackend":{"backendId":"claude-code"},"pid":1,"model":"volatile"}' \
  > "$RECON_MANIFEST"
printf '%s\n' \
  '[{"projectName":"flywheel","leads":[{"agentId":"eng-lead","backend":"claude-code"}]}]' \
  > "$RECON_PROJECTS"
printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.flywheel.lead.flywheel-eng-lead</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>/tmp/flywheel-lead-wrapper.sh</string><string>'"$RECON_MANIFEST"'</string></array></dict></plist>' \
  > "$RECON_PLIST"
if lead_restart_validate_authority \
  "$RECON_MANIFEST" "$RECON_PLIST" "$RECON_PROJECTS" \
  com.flywheel.lead.flywheel-eng-lead; then
  FLYWHEEL_LEAD_REPLACEMENT_DIR="$RECON_MARKERS"
  LEAD_RESTART_LEASE_BASELINE='{"status":"absent"}'
  lead_restart_write_replacement_marker \
    flywheel-eng-lead com.flywheel.lead.flywheel-eng-lead 700 old-start
  RECON_MARKER="$LEAD_RESTART_MARKER_FILE"
else
  RECON_MARKER=""
fi
if [[ -n "$RECON_MARKER" ]] \
  && lead_restart_load_replacement_marker "$RECON_MARKER" \
  && [[ "$LEAD_RESTART_LOADED_MARKER_DAEMON_KEY" == flywheel-eng-lead \
    && "$LEAD_RESTART_LOADED_MARKER_PROJECT" == flywheel \
    && "$LEAD_RESTART_LOADED_MARKER_LEAD_ID" == eng-lead ]]; then
  pass "reconcile marker strict load restores exact carrier authority"
else
  fail "valid reconcile marker could not restore authority"
fi
jq '.pid = 2 | .model = "new-volatile"' "$RECON_MANIFEST" > "$RECON_MANIFEST.tmp"
mv "$RECON_MANIFEST.tmp" "$RECON_MANIFEST"
if lead_restart_load_replacement_marker "$RECON_MARKER"; then
  pass "reconcile authority ignores volatile manifest evidence"
else
  fail "volatile manifest evidence caused false reconcile drift"
fi
jq '.leadId = "foreign-lead"' "$RECON_MANIFEST" > "$RECON_MANIFEST.tmp"
mv "$RECON_MANIFEST.tmp" "$RECON_MANIFEST"
if lead_restart_load_replacement_marker "$RECON_MARKER"; then
  fail "semantic authority drift was accepted during reconcile"
elif [[ "$LEAD_RESTART_MARKER_LOAD_REASON" == authority_changed ]]; then
  pass "semantic authority drift preserves the marker and fails closed"
else
  fail "semantic authority drift lost its typed reconcile reason"
fi
rm -f "$RECON_MANIFEST" "$RECON_PLIST"
printf '%s\n' '[]' > "$RECON_PROJECTS"
if lead_restart_marker_retired "$RECON_MARKER"; then
  pass "canonical inventory can positively retire an unloaded removed Lead marker"
else
  fail "removed Lead marker could not be positively classified as retired"
fi

SCHEDULER_LOCK="$TMP_ROOT/scheduler-repair.lock.d"
if lead_restart_wait_scheduler_mutation "$SCHEDULER_LOCK" 1; then
  pass "global restart proceeds when no scheduler mutation is active"
else
  fail "missing scheduler mutation lock blocked the global restart"
fi

mkdir "$SCHEDULER_LOCK"
chmod 700 "$SCHEDULER_LOCK"
printf '%s\n' '{"pid":9999,"pid_lstart":"stale-start","created_at":"2026-08-02T00:00:00.000Z"}' \
  > "$SCHEDULER_LOCK/owner.json"
chmod 600 "$SCHEDULER_LOCK/owner.json"
lead_restart_process_start_identity() { return 1; }
if lead_restart_wait_scheduler_mutation "$SCHEDULER_LOCK" 1 \
  && [[ ! -e "$SCHEDULER_LOCK" ]]; then
  pass "global restart reclaims an exact dead scheduler owner"
else
  fail "dead scheduler owner was not reclaimed exactly"
fi

mkdir "$SCHEDULER_LOCK"
chmod 700 "$SCHEDULER_LOCK"
printf '%s\n' '{"pid":8888,"pid_lstart":"live-start","created_at":"2026-08-02T00:00:00.000Z"}' \
  > "$SCHEDULER_LOCK/owner.json"
chmod 600 "$SCHEDULER_LOCK/owner.json"
lead_restart_process_start_identity() { printf '%s\n' live-start; }
if lead_restart_wait_scheduler_mutation "$SCHEDULER_LOCK" 0; then
  fail "live scheduler mutation escaped the bounded wait"
elif [[ "$LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON" == live_owner_timeout \
  && -d "$SCHEDULER_LOCK" ]]; then
  pass "live scheduler mutation times out fail closed without deletion"
else
  fail "live scheduler mutation timeout lost its typed evidence"
fi
rm -f "$SCHEDULER_LOCK/owner.json"
rmdir "$SCHEDULER_LOCK"

mkdir "$SCHEDULER_LOCK"
chmod 700 "$SCHEDULER_LOCK"
printf '%s\n' '{"pid":"bad"}' > "$SCHEDULER_LOCK/owner.json"
chmod 600 "$SCHEDULER_LOCK/owner.json"
if lead_restart_wait_scheduler_mutation "$SCHEDULER_LOCK" 0; then
  fail "malformed scheduler owner was accepted"
elif [[ "$LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON" == owner_malformed \
  && -d "$SCHEDULER_LOCK" ]]; then
  pass "malformed scheduler owner fails closed without cleanup"
else
  fail "malformed scheduler owner lost its typed evidence"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
