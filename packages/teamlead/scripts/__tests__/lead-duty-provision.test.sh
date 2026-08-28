#!/bin/bash
set -uo pipefail

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$TEST_DIR/../lead-duty-provision.sh"
TEMP_DIR="$(mktemp -d -t lead-duty-provision.XXXXXX)" || exit 1
trap 'rm -rf "$TEMP_DIR"' EXIT

passed=0
failed=0
pass() { echo "  ✓ $1"; passed=$((passed + 1)); }
fail() { echo "  ✗ $1" >&2; failed=$((failed + 1)); }

CLI="$TEMP_DIR/seat-cli.js"
APPLY="$TEMP_DIR/apply.sh"
CALLS="$TEMP_DIR/apply.calls"
printf '%s\n' '#!/bin/bash' 'printf "%s\n" "$*" >> "$APPLY_CALLS"' \
  'echo "[alert-duty-gate] claw: channel=alerts requireMention=false allowFrom=[] allowBots+=dispatcher (changed)"' > "$APPLY"
chmod +x "$APPLY"

run_source() {
  local cli_mode="$1" token_mode="$2"
  : > "$CALLS"
  case "$cli_mode" in
    seat) printf '%s\n' 'console.log(JSON.stringify({isDutySeat:true,alertChannelId:"alerts",dispatcherBotUserId:"dispatcher"}))' > "$CLI" ;;
    nonseat) printf '%s\n' 'console.log(JSON.stringify({isDutySeat:false,alertChannelId:null,dispatcherBotUserId:"dispatcher"}))' > "$CLI" ;;
    unreachable) printf '%s\n' 'console.error("bridge unreachable"); console.log(JSON.stringify({isDutySeat:true,alertChannelId:"alerts",dispatcherBotUserId:null}))' > "$CLI" ;;
  esac
  local token=""
  [ "$token_mode" = set ] && token=duty-secret
  LEAD_ID=claude-infra-bot-lead PROJECT_NAME=flywheel \
  DISCORD_STATE_DIR="$TEMP_DIR/state" SCRIPT_DIR="$TEST_DIR/.." \
  FLYWHEEL_ALERT_DUTY_TOKEN="$token" \
  FLYWHEEL_ALERT_DUTY_SEAT_CLI="$CLI" \
  FLYWHEEL_ALERT_DUTY_GATE_SCRIPT="$APPLY" \
  APPLY_CALLS="$CALLS" \
    bash -c 'source "$1"; if [ -n "${FLYWHEEL_ALERT_DUTY_TOKEN:-}" ]; then echo TOKEN=set; else echo TOKEN=unset; fi' bash "$HELPER"
}

echo "[TEST] lead-duty-provision"

output="$(run_source seat set)"
if [[ "$output" == *"seat=true lead=claude-infra-bot-lead channel=alerts gate=changed dispatcher=dispatcher token=set"* ]] \
  && [[ "$(cat "$CALLS")" == *"--allow-bot dispatcher"* ]] \
  && [[ "$(cat "$CALLS")" == *"--channel-id alerts"* ]]; then
  pass "duty seat applies once with dispatcher allow-bot and token=set"
else
  fail "duty seat provisioning output or apply argv is wrong"
fi

output="$(run_source nonseat set)"
if [[ "$output" == *"seat=false"* ]] && [[ "$output" == *"TOKEN=unset"* ]] && [ ! -s "$CALLS" ]; then
  pass "non-seat never applies and scrubs the duty token"
else
  fail "non-seat retained token or invoked the gate"
fi

output="$(run_source seat unset)"
if [[ "$output" == *"gate=skipped:no_duty_token"* ]] \
  && [[ "$output" == *"token=unset"* ]] && [ ! -s "$CALLS" ]; then
  pass "seat without capability stays off and leaves access untouched"
else
  fail "tokenless seat did not fail closed"
fi

output="$(run_source unreachable set 2>"$TEMP_DIR/unreachable.err")"
if [[ "$output" == *"dispatcher=unresolved:bridge_unreachable"* ]] \
  && [[ "$output" == *"gate=changed"* ]] \
  && [[ "$(cat "$CALLS")" != *"--allow-bot"* ]] \
  && grep -q 'bridge unreachable' "$TEMP_DIR/unreachable.err"; then
  pass "unreachable Bridge keeps stderr and still opens the existing human-message gate"
else
  fail "Bridge-unreachable degradation is wrong"
fi

output="$(LEAD_ID=claude-infra-bot-lead PROJECT_NAME=flywheel \
  DISCORD_STATE_DIR="$TEMP_DIR/state" SCRIPT_DIR="$TEST_DIR/.." \
  FLYWHEEL_ALERT_DUTY_TOKEN=duty-secret \
  FLYWHEEL_ALERT_DUTY_SEAT_CLI="$TEMP_DIR/missing-cli.js" \
  FLYWHEEL_ALERT_DUTY_GATE_SCRIPT="$APPLY" APPLY_CALLS="$CALLS" \
  bash -c 'source "$1"; [ -z "${FLYWHEEL_ALERT_DUTY_TOKEN:-}" ] && echo TOKEN=unset' bash "$HELPER" 2>"$TEMP_DIR/missing.err")"
if [[ "$output" == *"gate=skipped:cli_missing"* ]] \
  && [[ "$output" == *"TOKEN=unset"* ]] \
  && grep -q 'CLI missing' "$TEMP_DIR/missing.err"; then
  pass "missing CLI is loud, skipped, and token-scrubbed"
else
  fail "missing CLI handling is wrong"
fi

echo "[RESULT] passed=$passed failed=$failed"
[ "$failed" -eq 0 ]
