#!/bin/bash
# FLY-1659: store-authorized supervisor adoption unit contract.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$*" >&2; }

ADOPT_SRC="$(sed -n '/^_lead_try_adopt_body()/,/^}/p' "$LEAD_SH")"
if [ -z "$ADOPT_SRC" ]; then
  fail "production launcher is missing _lead_try_adopt_body"
  printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi
eval "$ADOPT_SRC"

TMUX_ARCHIVE_FILE=/tmp/fly1659-fixture.tmux
LEAD_ID=eng-lead
LEAD_WINDOW_ID=""
TMUX_SERVER_PID=""
LEAD_BODY_PROVENANCE=""
FIXTURE_SERVER_PID=4100
FIXTURE_PANE_PID=4200
FIXTURE_PANE_START=pane-start
FIXTURE_WINDOW_ID=@7
FIXTURE_ARCHIVE_RC=0
FIXTURE_PROCESS_RC=0
FIXTURE_TARGET_RC=0
FIXTURE_CONFLICT_RC=1
FIXTURE_TOCTOU=0

tmux_supervisor_archive_read() {
  [ "$FIXTURE_ARCHIVE_RC" -eq 0 ] || return "$FIXTURE_ARCHIVE_RC"
  TMUX_ARCHIVE_SERVER_PID="$FIXTURE_SERVER_PID"
  TMUX_ARCHIVE_PANE_PID="$FIXTURE_PANE_PID"
  TMUX_ARCHIVE_PANE_START="$FIXTURE_PANE_START"
  TMUX_ARCHIVE_WINDOW_ID="$FIXTURE_WINDOW_ID"
}
tmux_supervisor_archived_process_state() {
  case "$FIXTURE_PROCESS_RC" in
    0) TMUX_SUPERVISOR_ARCHIVED_STATE=live_exact ;;
    1) TMUX_SUPERVISOR_ARCHIVED_STATE=positive_dead_or_mismatch ;;
    *) TMUX_SUPERVISOR_ARCHIVED_STATE=indeterminate ;;
  esac
  return "$FIXTURE_PROCESS_RC"
}
_tmux_target_matches_archive() {
  [ "$FIXTURE_TARGET_RC" -eq 0 ] || return "$FIXTURE_TARGET_RC"
  if [ "$FIXTURE_TOCTOU" -eq 1 ]; then
    TMUX_ARCHIVE_WINDOW_ID=@8
  fi
  return 0
}
_lead_identity_conflict_excluding() { return "$FIXTURE_CONFLICT_RC"; }
log() { :; }
# FLY-1671 evidence is deliberately observational; these adoption unit tests
# exercise the pre-existing state machine without requiring its sidecar writer.
record_lead_body_evidence_best_effort() { :; }

echo "[TEST] holder_orphaned adoption requires the exact frozen body tuple"
_lead_try_adopt_body 4200 pane-start
ADOPT_RC=$?
if [ "$ADOPT_RC" -eq 0 ] \
  && [ "$LEAD_WINDOW_ID" = @7 ] \
  && [ "$TMUX_SERVER_PID" = 4100 ] \
  && [ "$LEAD_BODY_PROVENANCE" = adopted ]; then
  pass "matching bound holder is adopted into KeepAlive monitoring"
else
  fail "matching holder was not adopted: rc=$ADOPT_RC window=$LEAD_WINDOW_ID server=$TMUX_SERVER_PID provenance=$LEAD_BODY_PROVENANCE"
fi

echo "[TEST] adoption has distinct mismatch, conflict, and indeterminate exits"
_lead_try_adopt_body 4201 pane-start >/dev/null 2>&1
MISMATCH_RC=$?
FIXTURE_PROCESS_RC=1
_lead_try_adopt_body 4200 pane-start >/dev/null 2>&1
PROCESS_MISMATCH_RC=$?
FIXTURE_PROCESS_RC=0
FIXTURE_CONFLICT_RC=0
_lead_try_adopt_body 4200 pane-start >/dev/null 2>&1
CONFLICT_RC=$?
FIXTURE_CONFLICT_RC=2
_lead_try_adopt_body 4200 pane-start >/dev/null 2>&1
SENSOR_RC=$?
FIXTURE_CONFLICT_RC=1
FIXTURE_TOCTOU=1
_lead_try_adopt_body 4200 pane-start >/dev/null 2>&1
TOCTOU_RC=$?
if [ "$MISMATCH_RC" -eq 1 ] \
  && [ "$PROCESS_MISMATCH_RC" -eq 1 ] \
  && [ "$CONFLICT_RC" -eq 2 ] \
  && [ "$SENSOR_RC" -eq 3 ] \
  && [ "$TOCTOU_RC" -eq 3 ]; then
  pass "only positive mismatch authorizes replacement; conflict/uncertainty hold"
else
  fail "typed adoption exits drifted: tuple=$MISMATCH_RC process=$PROCESS_MISMATCH_RC conflict=$CONFLICT_RC sensor=$SENSOR_RC toctou=$TOCTOU_RC"
fi

echo "[TEST] cold case-5 restores archive identity without stealing launcher teardown rights"
BOUND_SRC="$(sed -n '/^_lead_bound_body_ready()/,/^}/p' "$LEAD_SH")"
eval "$BOUND_SRC"
FIXTURE_TOCTOU=0
FIXTURE_PROCESS_RC=0
LEAD_LEASE_ORPHAN_HOLDER_PID=4200
LEAD_LEASE_ORPHAN_HOLDER_START=pane-start
_lead_body_tuple_state() { return 0; }
LEAD_WINDOW_ID=""
LEAD_BODY_PROVENANCE=""
_lead_bound_body_ready
BOUND_COLD_RC=$?
LEAD_WINDOW_ID=""
LEAD_BODY_PROVENANCE=launched
_lead_bound_body_ready
BOUND_LAUNCHED_RC=$?
if [ "$BOUND_COLD_RC" -eq 0 ] \
  && [ "$BOUND_LAUNCHED_RC" -eq 0 ] \
  && [ "$LEAD_BODY_PROVENANCE" = launched ]; then
  pass "case-5 restores the archived window and preserves launched provenance"
else
  fail "case-5 restore/provenance drifted: cold=$BOUND_COLD_RC launched=$BOUND_LAUNCHED_RC provenance=$LEAD_BODY_PROVENANCE"
fi

echo "[TEST] fresh lease replaces exact stale body while sensor uncertainty preserves evidence"
PREPARE_SRC="$(sed -n '/^_prepare_lead_launch()/,/^}/p' "$LEAD_SH")"
eval "$PREPARE_SRC"
PREPARE_ARCHIVE="$(mktemp -t fly1659-prepare.XXXXXX)"
TMUX_ARCHIVE_FILE="$PREPARE_ARCHIVE"
PROJECT_NAME=flywheel
FIXTURE_WINDOW_ID=@7
TMUX_SERVER_PID=4100
TMUX_RELAUNCH_PROVEN=0
LEAD_LEASE_FRESH=1
ENSURE_HOLD_KIND=""
ENSURE_HOLD_EVIDENCE=""
REAP_CALLS=0
tmux_supervisor_reap_archived_process() { REAP_CALLS=$((REAP_CALLS + 1)); return 0; }
tmux_supervisor_archived_process_alive() { [ "$FIXTURE_PROCESS_RC" -eq 0 ]; }
_tmux_generation_is_current() { return 1; }
_tmux() { return 1; }
FIXTURE_PROCESS_RC=0
_prepare_lead_launch
FRESH_PREPARE_RC=$?

printf 'archive\n' > "$PREPARE_ARCHIVE"
FIXTURE_PROCESS_RC=2
LEAD_LEASE_FRESH=0
_prepare_lead_launch >/dev/null 2>&1
SENSOR_PREPARE_RC=$?
if [ "$FRESH_PREPARE_RC" -eq 0 ] \
  && [ "$REAP_CALLS" -eq 1 ] \
  && [ "$SENSOR_PREPARE_RC" -eq 3 ] \
  && [ -f "$PREPARE_ARCHIVE" ]; then
  pass "only fresh+exact evidence replaces; indeterminate archive remains held"
else
  fail "prepare disposition drifted: fresh_rc=$FRESH_PREPARE_RC reaps=$REAP_CALLS sensor_rc=$SENSOR_PREPARE_RC archive=$([ -f "$PREPARE_ARCHIVE" ] && echo yes || echo no)"
fi
rm -f "$PREPARE_ARCHIVE"

echo "[TEST] production loop and cleanup wire adoption before destructive actions"
if rg -U -q '4\)[\s\S]{0,500}_lead_try_adopt_body[\s\S]{0,700}_lead_clear_orphan_body' "$LEAD_SH" \
  && rg -q '^LEAD_BODY_PROVENANCE=""' "$LEAD_SH" \
  && rg -q 'LEAD_BODY_PROVENANCE.*launched' "$LEAD_SH" \
  && rg -q '\[ "\$LEAD_BODY_PROVENANCE" = launched \]' "$LEAD_SH"; then
  pass "rc4 adoption and graceful teardown provenance are wired"
else
  fail "production loop can still clear before adoption or tear down an adopted body"
fi

echo "[TEST] monitor sensor uncertainty cannot mint relaunch authority or enter rescue"
WAIT_SRC="$(sed -n '/^_wait_tmux_window()/,/^}/p' "$LEAD_SH")"
eval "$WAIT_SRC"
LEAD_WINDOW_ID=@7
TMUX_ARCHIVE_FILE=/tmp/fly1659-wait.tmux
TMUX_ARCHIVE_SERVER_PID=4100
TMUX_RELAUNCH_PROVEN=0
SHOULD_EXIT=0
RECOVER_CALLS=0
ENSURE_HOLD_KIND=""
ENSURE_HOLD_EVIDENCE=""
_tmux_target_matches_archive() { return 1; }
_tmux_target_matches_archive_fast() { return 1; }
tmux_supervisor_archived_process_alive() { return 1; }
tmux_supervisor_archived_process_state() {
  TMUX_SUPERVISOR_ARCHIVED_STATE=indeterminate
  return 2
}
tmux_socket_recover() { RECOVER_CALLS=$((RECOVER_CALLS + 1)); return 4; }
_tmux_socket_path() { printf '/tmp/fly1659.sock\n'; }
_tmux_report_hold() { return 0; }
_tmux_report_hold_resolved() { return 0; }
interruptible_sleep() { SHOULD_EXIT=1; }
_hold_sleep_and_advance() { SHOULD_EXIT=1; }
log() { :; }
_wait_tmux_window
if [ "$TMUX_RELAUNCH_PROVEN" -eq 0 ] \
  && [ "$RECOVER_CALLS" -eq 0 ] \
  && [ "$ENSURE_HOLD_KIND" = unknown ]; then
  pass "indeterminate process evidence holds without relaunch or locked rescue"
else
  fail "monitor sensor error authorized mutation: relaunch=$TMUX_RELAUNCH_PROVEN recover=$RECOVER_CALLS hold=$ENSURE_HOLD_KIND"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
