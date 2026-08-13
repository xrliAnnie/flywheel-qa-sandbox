#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/restart-voice-bridge.sh"
RESTART_SCRIPT="$REPO_ROOT/scripts/restart-services.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

if [[ ! -f "$LIB" ]]; then
  echo "missing $LIB" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$LIB"

CONFIGURED=true
LOADED=true
KEEPALIVE=true
PHASE=old
HEALTH_OK=true
OLD_SURVIVES=false
VANISHED_PID=""
UNVERIFIABLE_PID=""
RESTART_CALLS=0
SLEEP_CALLS=0

voice_bridge_is_configured() { [[ "$CONFIGURED" == true ]]; }
voice_bridge_supervisor_loaded() { [[ "$LOADED" == true ]]; }
voice_bridge_supervisor_keepalive() { [[ "$KEEPALIVE" == true ]]; }
voice_bridge_supervisor_restart() { RESTART_CALLS=$((RESTART_CALLS + 1)); PHASE=new; }
voice_bridge_read_pid() {
  if [[ "$PHASE" == old ]]; then printf '101\n'; else printf '201\n'; fi
}
voice_bridge_process_start() {
  [[ "$1" != "$VANISHED_PID" && "$1" != "$UNVERIFIABLE_PID" ]] || return 1
  case "$1" in
    101) printf 'old-root\n' ;;
    102) printf 'old-headless\n' ;;
    103) printf 'old-resident\n' ;;
    104) printf 'old-nested\n' ;;
    201) printf 'new-root\n' ;;
    *) return 1 ;;
  esac
}
voice_bridge_child_pids() {
  case "$1" in
    101) printf '102\n103\n' ;;
    102) printf '104\n' ;;
  esac
}
voice_bridge_process_alive() {
  [[ "$1" != "$VANISHED_PID" ]] || return 1
  case "$1" in
    201) [[ "$PHASE" == new ]] ;;
    101|102|103|104) [[ "$PHASE" == old || "$OLD_SURVIVES" == true ]] ;;
    *) return 1 ;;
  esac
}
voice_bridge_health_ok() { [[ "$HEALTH_OK" == true ]]; }
voice_bridge_sleep() { SLEEP_CALLS=$((SLEEP_CALLS + 1)); }

reset_case() {
  CONFIGURED=true
  LOADED=true
  KEEPALIVE=true
  PHASE=old
  HEALTH_OK=true
  OLD_SURVIVES=false
  VANISHED_PID=""
  UNVERIFIABLE_PID=""
  RESTART_CALLS=0
  SLEEP_CALLS=0
  VOICE_BRIDGE_RESTART_STATE=""
  VOICE_BRIDGE_RESTART_DETAIL=""
  VOICE_BRIDGE_OLD_TUPLES=""
}

reset_case
if restart_voice_bridge_managed; then
  pass "healthy managed replacement succeeds"
else
  fail "healthy managed replacement succeeds: $VOICE_BRIDGE_RESTART_DETAIL"
fi
[[ "$RESTART_CALLS" == 1 ]] && pass "healthy path mutates through supervisor once" || fail "restart calls=$RESTART_CALLS"
[[ "$VOICE_BRIDGE_RESTART_STATE" == healthy ]] && pass "healthy path records state" || fail "state=$VOICE_BRIDGE_RESTART_STATE"
[[ "$VOICE_BRIDGE_OLD_TUPLES" == *$'101\told-root'* \
  && "$VOICE_BRIDGE_OLD_TUPLES" == *$'102\told-headless'* \
  && "$VOICE_BRIDGE_OLD_TUPLES" == *$'103\told-resident'* \
  && "$VOICE_BRIDGE_OLD_TUPLES" == *$'104\told-nested'* ]] \
  && pass "capture records daemon and recursive child PID+start tuples" \
  || fail "captured tuples: $VOICE_BRIDGE_OLD_TUPLES"

reset_case
VANISHED_PID=104
if restart_voice_bridge_managed; then
  pass "capture treats a descendant that exits after pgrep as already reclaimed"
else
  fail "transient descendant exit should not fail deploy: $VOICE_BRIDGE_RESTART_DETAIL"
fi
[[ "$RESTART_CALLS" == 1 && "$VOICE_BRIDGE_OLD_TUPLES" != *$'104\t'* ]] \
  && pass "vanished descendant is omitted while managed replacement proceeds" \
  || fail "vanished descendant capture/calls: $VOICE_BRIDGE_OLD_TUPLES / $RESTART_CALLS"

reset_case
UNVERIFIABLE_PID=104
if restart_voice_bridge_managed; then
  fail "a still-live descendant with no start tuple must fail closed"
else
  pass "a still-live descendant with no start tuple fails capture closed"
fi
[[ "$RESTART_CALLS" == 0 && "$VOICE_BRIDGE_RESTART_DETAIL" == old_tree_capture_failed:* ]] \
  && pass "unverifiable live descendant blocks mutation with capture evidence" \
  || fail "unverifiable descendant detail/calls: $VOICE_BRIDGE_RESTART_DETAIL / $RESTART_CALLS"

reset_case
CONFIGURED=false
LOADED=false
if restart_voice_bridge_managed; then
  pass "unconfigured and unloaded voice service is a deterministic no-op"
else
  fail "unconfigured no-op: $VOICE_BRIDGE_RESTART_DETAIL"
fi
[[ "$RESTART_CALLS" == 0 && "$VOICE_BRIDGE_RESTART_STATE" == not_configured ]] \
  && pass "no-op never mutates supervisor" || fail "unexpected no-op mutation/state"

reset_case
KEEPALIVE=false
if restart_voice_bridge_managed; then
  fail "missing keepalive contract fails closed"
else
  pass "missing keepalive contract fails closed"
fi
[[ "$RESTART_CALLS" == 0 ]] && pass "keepalive refusal happens before mutation" || fail "keepalive path restarted"

reset_case
HEALTH_OK=false
FLYWHEEL_VOICE_HEALTH_TRIES=2
if restart_voice_bridge_managed; then
  fail "voice health failure fails the managed replacement"
else
  pass "voice health failure fails the managed replacement"
fi
[[ "$RESTART_CALLS" == 1 && "$VOICE_BRIDGE_RESTART_DETAIL" == health_timeout* ]] \
  && pass "health failure is recorded after one managed restart" \
  || fail "health failure detail=$VOICE_BRIDGE_RESTART_DETAIL calls=$RESTART_CALLS"
unset FLYWHEEL_VOICE_HEALTH_TRIES

reset_case
OLD_SURVIVES=true
FLYWHEEL_VOICE_HEALTH_TRIES=2
if restart_voice_bridge_managed; then
  fail "surviving old child tuple fails replacement proof"
else
  pass "surviving old child tuple fails replacement proof"
fi
[[ "$VOICE_BRIDGE_RESTART_DETAIL" == old_tree_survived* ]] \
  && pass "old-tree failure carries exact tuple evidence" \
  || fail "old-tree detail=$VOICE_BRIDGE_RESTART_DETAIL"
unset FLYWHEEL_VOICE_HEALTH_TRIES

# Transaction wiring: deploy must gate deployed-sha on voice success and invoke
# rollback on failure; rollback must itself restart/verify voice from old bytes.
deploy_body="$(awk '/^deploy_and_verify\(\)/,/^}/' "$RESTART_SCRIPT")"
rollback_body="$(awk '/^rollback_and_restart\(\)/,/^}/' "$RESTART_SCRIPT")"
voice_line="$(grep -n 'ensure_voice_bridge_for_deploy' <<<"$deploy_body" | head -1 | cut -d: -f1)"
sha_line="$(grep -n 'deployed-sha updated' <<<"$deploy_body" | head -1 | cut -d: -f1)"
if [[ "$voice_line" =~ ^[0-9]+$ && "$sha_line" =~ ^[0-9]+$ ]] && (( voice_line < sha_line )); then
  pass "deploy gates deployed-sha advancement on voice transaction"
else
  fail "voice/deployed-sha ordering missing"
fi
grep -A18 '^ensure_voice_bridge_for_deploy()' "$RESTART_SCRIPT" | grep -q 'rollback_and_restart' \
  && pass "deploy voice failure enters rollback path" || fail "deploy voice rollback path missing"
grep -q 'restart_voice_bridge_managed' <<<"$rollback_body" \
  && pass "rollback performs a managed old-build voice replacement" \
  || fail "rollback voice replacement missing"
grep -A8 'restart_voice_bridge_managed' <<<"$rollback_body" | grep -q 'return 1' \
  && pass "rollback voice verification fails closed" || fail "rollback voice fail-close missing"

printf '\n[TEST] restart-services-voice-bridge: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
