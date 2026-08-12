#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1634-controlled-wave.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$ROOT/scripts/lib/lead-restart-lifecycle.sh"

MARKER="$TMP_ROOT/flywheel-eng-lead.json"
ATTEMPT="11111111-1111-4111-8111-111111111111"
printf '{"attempt_id":"%s"}\n' "$ATTEMPT" > "$MARKER"
AUTHORITY_OK=1
ARM_MODE=race-once
CALL_LOG="$TMP_ROOT/gate.calls"
DIGEST_FILE="$TMP_ROOT/marker.digest"
printf '%s\n' fixture-digest > "$DIGEST_FILE"

lead_restart_file_digest() { cat "$DIGEST_FILE"; }
lead_restart_authority_unchanged() { [ "$AUTHORITY_OK" -eq 1 ]; }
lead_restart_gate_exec() {
  local timeout="$1" command="$2" arm_count
  shift 2
  printf '%s\t%s\t%s\n' "$timeout" "$command" "$*" >> "$CALL_LOG"
  case "$command" in
    status)
      if [ "$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG" || true)" -eq 0 ]; then
        printf '%s\n' '{"state":"held_alert_attempted","last_resumed_seq":0,"episode_key":"lead.flywheel-eng-lead__20260802T120000Z__1","window_start":"2026-08-02T12:00:00.000Z","ledger_seq":4}'
      else
        printf '%s\n' '{"state":"active","last_resumed_seq":0,"ledger_seq":5}'
      fi
      ;;
    arm-controlled-wave)
      arm_count="$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG" || true)"
      if [ "$ARM_MODE" = always-race ] || [ "$arm_count" -eq 1 ]; then
        printf '%s\n' '{"status":"not_armed","reason":"seq_changed","expectedSeq":4,"ledgerSeq":5}'
        return 3
      fi
      printf '{"status":"armed","attemptId":"%s","ledgerSeq":5,"markerDigest":"digest"}\n' "$ATTEMPT"
      ;;
    *) return 4 ;;
  esac
}

if lead_restart_arm_controlled_wave \
  flywheel-eng-lead "$MARKER" "$ATTEMPT" "$TMP_ROOT/ledger" \
  && [ "$(grep -c $'\tstatus\t' "$CALL_LOG")" -eq 2 ] \
  && [ "$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG")" -eq 2 ]; then
  pass "controlled-wave arm resamples one sequence race"
else
  fail "controlled-wave arm did not converge"
fi

: > "$CALL_LOG"
ARM_MODE=always-race
if lead_restart_arm_controlled_wave \
  flywheel-eng-lead "$MARKER" "$ATTEMPT" "$TMP_ROOT/ledger" >/dev/null 2>&1; then
  fail "three sequence races were armed"
elif [ "$(grep -c $'\tarm-controlled-wave\t' "$CALL_LOG")" -eq 3 ] \
  && [ "$LEAD_RESTART_GATE_FAILURE_REASON" = seq_changed_exhausted ]; then
  pass "controlled-wave arm fails closed after bounded races"
else
  fail "controlled-wave race exhaustion lost its typed reason"
fi

MANIFEST="$TMP_ROOT/manifest.json"
PLIST="$TMP_ROOT/lead.plist"
PROJECTS="$TMP_ROOT/projects.json"
MARKER_DIR="$TMP_ROOT/replacements"
printf '%s\n' '{"leadId":"eng-lead","projectDir":"/tmp/project","projectName":"flywheel","projectsFile":"/tmp/projects.json","leadBackend":{"backendId":"claude-code"},"pid":999,"model":"volatile"}' > "$MANIFEST"
printf '%s\n' '<plist/>' > "$PLIST"
printf '%s\n' '[]' > "$PROJECTS"
LEAD_RESTART_MANIFEST_FILE="$MANIFEST"
LEAD_RESTART_PLIST_FILE="$PLIST"
LEAD_RESTART_PROJECTS_FILE="$PROJECTS"
LEAD_RESTART_PLIST_DIGEST="$(shasum -a 256 "$PLIST" | awk '{print $1}')"
LEAD_RESTART_PROJECTS_DIGEST="$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
FLYWHEEL_LEAD_REPLACEMENT_DIR="$MARKER_DIR"

if lead_restart_write_replacement_marker \
  flywheel-eng-lead com.flywheel.lead.flywheel-eng-lead 700 old-start \
  && [ -f "$LEAD_RESTART_MARKER_FILE" ] \
  && [ "$(_lead_restart_file_mode "$LEAD_RESTART_MARKER_FILE")" = 600 ] \
  && jq -e --arg attempt "$LEAD_RESTART_ATTEMPT_ID" \
       '.schema_version == 1 and .attempt_id == $attempt and .phase == "bootout"
        and .old_supervisor_tuple.pid == 700
        and (has("lease_baseline") | not)
        and .authority.manifest.semantic_identity.projectsFile == "/tmp/projects.json"
        and (.authority.manifest.semantic_identity | has("botTokenEnv") | not)
        and (.authority.manifest.semantic_identity | has("pid") | not)
        and (.authority.manifest.semantic_identity | has("model") | not)' \
       "$LEAD_RESTART_MARKER_FILE" >/dev/null; then
  pass "replacement marker is a 0600 breadcrumb without lease proof"
else
  fail "replacement marker breadcrumb contract failed"
fi

if lead_restart_update_marker_phase \
  "$LEAD_RESTART_MARKER_FILE" "$LEAD_RESTART_ATTEMPT_ID" bootstrap \
  && [ "$(jq -r .phase "$LEAD_RESTART_MARKER_FILE")" = bootstrap ] \
  && lead_restart_remove_marker \
    "$LEAD_RESTART_MARKER_FILE" "$LEAD_RESTART_ATTEMPT_ID" \
  && [ ! -e "$LEAD_RESTART_MARKER_FILE" ]; then
  pass "replacement breadcrumb updates and removes atomically"
else
  fail "replacement breadcrumb lifecycle failed"
fi

for removed in \
  lead_restart_verify_bound \
  lead_restart_progress_snapshot \
  lead_restart_replacement_progressed \
  lead_restart_classify_wave_gate \
  lead_restart_load_replacement_marker \
  lead_restart_marker_retired; do
  if type "$removed" >/dev/null 2>&1; then
    fail "obsolete restart verdict helper remains: $removed"
  else
    pass "obsolete restart verdict helper removed: $removed"
  fi
done

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
