#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="${FLY2266_SUT:-$ROOT/scripts/flywheel-cmux-sync.sh}"
SB="$(mktemp -d -t fly2266-cmux-XXXXXX)"
trap 'rm -rf "$SB"' EXIT

export HOME="$SB/home"
export ATTACH_HEAL_STATE="$SB/attach-heal"
export ROSTER_EPISODE_STATE="$SB/roster-episodes"
export FLYWHEEL_CMUX_ATTACH_RETRIES=4
export FLYWHEEL_CMUX_ALERT_BIN=/usr/bin/true
export FLYWHEEL_CMUX_LEAD_ATTACH_BIN="$SB/lead-attach"
mkdir -p "$HOME" "$SB/bin"
printf '#!/bin/sh\nexit 0\n' >"$FLYWHEEL_CMUX_LEAD_ATTACH_BIN"
chmod +x "$FLYWHEEL_CMUX_LEAD_ATTACH_BIN"

for writable_path in "$HOME" "$ATTACH_HEAL_STATE" "$ROSTER_EPISODE_STATE"; do
  case "$writable_path" in
    "$SB"|"$SB"/*) ;;
    *) printf 'FATAL: writable test path escaped sandbox: %s\n' "$writable_path" >&2; exit 99 ;;
  esac
done

# shellcheck source=../flywheel-cmux-sync.sh
source "$SUT"
set +e

passed=0 failed=0
pass() { passed=$((passed + 1)); printf 'PASS: %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL: %s\n' "$1" >&2; }

LOGS="" ALERTS="" CMUX_OPS="" ENSURE_CALLS=0 LATCH_CLEAR=1
log() { LOGS+="${LOGS:+$'\n'}$*"; }
_alert_cmux_cleanup() {
  ALERTS+="${ALERTS:+$'\n'}$1|$2|$3"
}
_attach_cmux_mutation() {
  CMUX_OPS+="${CMUX_OPS:+$'\n'}$*"
  return 0
}
watcher_mutation_latch_clear() { [[ "$LATCH_CLEAR" == 1 ]]; }
ensure_v2_lead_workspace() { ENSURE_CALLS=$((ENSURE_CALLS + 1)); return 0; }

SOCKET_A="$SB/demo-a.sock"
SOCKET_B="$SB/demo-b.sock"
CLIENTS_A=1 CLIENTS_B=1 SCREEN_READS=0
workspace_terminal_screen() {
  SCREEN_READS=$((SCREEN_READS + 1))
  printf '%s\n' '⚡demo-b-lead ctx 74% — stale photograph'
}
_private_session_client_count() {
  local value
  case "$1" in
    "$SOCKET_A") value="$CLIENTS_A" ;;
    "$SOCKET_B") value="$CLIENTS_B" ;;
    *) return 1 ;;
  esac
  [[ "$value" != error ]] || return 1
  printf '%s\n' "$value"
}
set_full_roster() {
  LEAD_ROSTER_STATE=ok
  LEAD_ROSTER_ROWS="claude-private|com.flywheel.lead.demo-a-lead|demo-a-lead|$SOCKET_A"$'\n'"claude-private|com.flywheel.lead.demo-b-lead|demo-b-lead|$SOCKET_B"
}
set_a_only_roster() {
  LEAD_ROSTER_STATE=ok
  LEAD_ROSTER_ROWS="claude-private|com.flywheel.lead.demo-a-lead|demo-a-lead|$SOCKET_A"
}
alert_count() { printf '%s\n' "$ALERTS" | grep -cF "$1" || true; }
episode_state() {
  awk -F'|' -v kind="$1" -v subject="$2" \
    '$1 == kind && $2 == subject { print $4; exit }' "$ROSTER_EPISODE_STATE" 2>/dev/null
}

echo 'Test: persisted bare retry exhaustion reaches the v2 alert branch'
now="$(date +%s)"
printf 'generation-a|workspace:9|demo-b-lead|v2|4|retrying|%s|%s|100-1\n' \
  "$now" "$now" >"$ATTACH_HEAL_STATE"
recover_attach_surface v2 generation-a workspace:9 demo-b-lead surface:9 \
  attach-command "$SOCKET_B" bare
if [[ "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e1')" == 1 \
    && "$(awk -F'|' '{print $5 "|" $6}' "$ATTACH_HEAL_STATE")" == '4|dead' ]]; then
  pass 'persisted v2 bare retry exhaustion alerts without another census pass'
else
  fail "v2 bare terminal branch stayed silent alerts=[$ALERTS] state=[$(cat "$ATTACH_HEAL_STATE")]"
fi

rm -f "$ATTACH_HEAL_STATE" "$ROSTER_EPISODE_STATE"
ALERTS="" LOGS="" CMUX_OPS=""
set_full_roster

echo 'Test: cmux restart followed by fleet restart is counted from live tmux clients'
reconcile_v2_lead_workspaces
if [[ "$LOGS" == *'lead-attach census expected=2 attached=2 missing=none'* ]]; then
  pass 'initial cmux surfaces report an exact 2/2 census'
else
  fail "initial census missing logs=[$LOGS]"
fi

# Fleet restart: both old servers lose their clients. The stale screen keeps the
# old Lead name, but the liveness oracle must not inspect it.
CLIENTS_A=0 CLIENTS_B=0 LOGS=""
reconcile_v2_lead_workspaces
CLIENTS_A=1
limit="$(_attach_retry_limit)"
threshold=$((10#$limit + 1))
pass_number=2
while (( pass_number < threshold )); do
  reconcile_v2_lead_workspaces
  pass_number=$((pass_number + 1))
done
if [[ "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e1')" == 0 ]]; then
  pass 'census escalation waits until every configured reconnect attempt has run'
else
  fail "census alerted before retry budget plus one alerts=[$ALERTS]"
fi

LOGS=""
reconcile_v2_lead_workspaces
if [[ "$LOGS" == *'lead-attach census expected=2 attached=1 missing=demo-b-lead'* \
    && "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e1')" == 1 \
    && "$SCREEN_READS" == 0 ]]; then
  pass 'post-restart partial attach names the missing Lead and alerts once without reading stale pixels'
else
  fail "partial attach evidence drifted logs=[$LOGS] alerts=[$ALERTS] screen_reads=$SCREEN_READS"
fi
reconcile_v2_lead_workspaces
if [[ "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e1')" == 1 ]]; then
  pass 'an unchanged unhealthy episode does not repeat the alert'
else
  fail "unhealthy episode repeated alerts=[$ALERTS]"
fi

echo 'Test: roster absence and real recovery independently re-arm the episode'
set_a_only_roster
reconcile_v2_lead_workspaces
if [[ "$(episode_state lead-attach-missing demo-b-lead)" == healthy ]]; then
  pass 'a Lead absent from the derived roster re-arms its old episode'
else
  fail "roster absence did not re-arm state=[$(cat "$ROSTER_EPISODE_STATE" 2>/dev/null)]"
fi

set_full_roster
pass_number=1
while (( pass_number < threshold )); do
  reconcile_v2_lead_workspaces
  pass_number=$((pass_number + 1))
done
if [[ "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e2')" == 0 ]]; then
  pass 'roster absence also clears the consecutive-pass streak'
else
  fail "streak survived roster absence alerts=[$ALERTS]"
fi
reconcile_v2_lead_workspaces
if [[ "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e2')" == 1 ]]; then
  pass 'the reappearing missing Lead starts a fresh episode after a full threshold'
else
  fail "reappearing Lead did not alert alerts=[$ALERTS]"
fi

CLIENTS_B=1
reconcile_v2_lead_workspaces
CLIENTS_B=0
pass_number=1
while (( pass_number < threshold )); do
  reconcile_v2_lead_workspaces
  pass_number=$((pass_number + 1))
done
if [[ "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e3')" == 0 ]]; then
  pass 'a positive client count re-arms and clears the streak'
else
  fail "healthy client did not reset the streak alerts=[$ALERTS]"
fi
reconcile_v2_lead_workspaces
if [[ "$(alert_count 'cmux_cleanup|lead-attach-missing|demo-b-lead|e3')" == 1 ]]; then
  pass 'a second post-recovery failure produces a new episode'
else
  fail "post-recovery episode missing alerts=[$ALERTS]"
fi

echo 'Test: query failure is missing, and mutation latch cannot hide the census'
CLIENTS_A=1 CLIENTS_B=error LOGS=""
reconcile_v2_lead_workspaces
if [[ "$LOGS" == *'lead-attach census expected=2 attached=1 missing=demo-b-lead'* ]]; then
  pass 'tmux query failure is never counted as attached'
else
  fail "query failure census drifted logs=[$LOGS]"
fi

CLIENTS_B=1 LATCH_CLEAR=0 LOGS="" ENSURE_CALLS=0
reconcile_v2_lead_workspaces
if [[ "$LOGS" == *'lead-attach census expected=2 attached=2 missing=none'* \
    && "$ENSURE_CALLS" == 0 ]]; then
  pass 'read-only census runs before a mutation-latch refusal'
else
  fail "latch hid census or allowed mutation logs=[$LOGS] ensures=$ENSURE_CALLS"
fi

printf '\nFLY-2266 cmux Lead attach health: %s passed, %s failed\n' "$passed" "$failed"
[[ "$failed" == 0 ]]
