#!/bin/bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SUT="$ROOT/scripts/flywheel-cmux-sync.sh"
TMP=$(mktemp -d /tmp/fly1446-roster.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

pass() { echo "[TEST] ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "[TEST] ✗ $1"; FAIL=$((FAIL + 1)); }

export HOME="$TMP/home"
export FLYWHEEL_LEAD_STATE_DIR="$TMP/s"
export VIEW_WAL_DIR="$TMP/view-wal"
export VIEW_LEDGER="$TMP/view-ledger"
export KEEPER_INVENTORY="$TMP/keeper"
export VIEW_ABSENT_STATE="$TMP/view-absent"
export CMUX_FLAG_STATE="$TMP/cmux-flags"
export LEDGER_CONFLICT_STATE="$TMP/ledger-conflicts"
export ROSTER_EPISODE_STATE="$TMP/roster-episodes"
export FLYWHEEL_ENV_FILE="$TMP/home/.flywheel/.env"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMP/maintenance"
export FLYWHEEL_CMUX_ALERT_BIN="/usr/bin/true"
mkdir -p "$HOME/.flywheel/manifests" "$HOME/Library/LaunchAgents" "$(dirname "$FLYWHEEL_ENV_FILE")" "$FLYWHEEL_LEAD_STATE_DIR"

# shellcheck source=../flywheel-cmux-sync.sh
source "$SUT"
set +e

ALERTS="$TMP/alerts"
: > "$ALERTS"
_alert_cmux_cleanup() {
  printf '%s|%s\n' "$1" "$3" >> "$ALERTS"
  return 0
}

expect_eq() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] && pass "$label" || fail "$label (got=[$actual] expected=[$expected])"
}

echo "Test: FLY-1446 A-Lead carrier matrix is closed"
expect_eq "$(classify_lead_carrier flywheel-lead-wrapper-v2.sh claude-code)" "claude-private" \
  "v2 wrapper + Claude backend is rostered"
expect_eq "$(classify_lead_carrier flywheel-lead-wrapper-v2.sh codex)" "config-drift" \
  "v2 wrapper + Codex backend is config drift"
expect_eq "$(classify_lead_carrier flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh '')" "codex-tui-cmux" \
  "Mufasa dedicated TUI wrapper is allowlisted"
expect_eq "$(classify_lead_carrier flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh '')" "codex-tui-cmux" \
  "Raya dedicated resident TUI wrapper is allowlisted"
expect_eq "$(classify_lead_carrier flywheel-codex-lead-wrapper-codex-infra-bot.sh '')" "codex-tui-cmux" \
  "infra-bot wrapper is allowlisted despite lacking a tui suffix"
expect_eq "$(classify_lead_carrier future-wrapper.sh claude-code)" "config-drift" \
  "unknown wrapper/backend combinations fail loud"

touch "$HOME/Library/LaunchAgents/com.flywheel.lead.flywheel-eng-lead.plist"
touch "$HOME/Library/LaunchAgents/com.flywheel.lead.growth-mufasa-lead.plist"
touch "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"
jq -n --arg socket "$(derive_lead_socket "flywheel/eng-lead" "$FLYWHEEL_LEAD_STATE_DIR")" \
  '{projectName:"flywheel",leadId:"eng-lead",socketPath:$socket,leadBackend:{backendId:"claude-code"}}' \
  > "$HOME/.flywheel/manifests/flywheel-eng-lead.json"
jq -n --arg socket "$(derive_lead_socket "growth/mufasa-lead" "$FLYWHEEL_LEAD_STATE_DIR")" \
  '{projectName:"growth",leadId:"mufasa-lead",socketPath:$socket,leadBackend:{backendId:"codex"}}' \
  > "$HOME/.flywheel/manifests/growth-mufasa-lead.json"
jq -n --arg socket "$(derive_lead_socket "raya/raya" "$FLYWHEEL_LEAD_STATE_DIR")" \
  '{projectName:"raya",leadId:"raya",socketPath:$socket,leadBackend:{backendId:"codex"}}' \
  > "$HOME/.flywheel/manifests/raya-raya.json"
lead_job_loaded() { return 0; }
lead_plist_wrapper_basename() {
  case "$1" in
    *flywheel-eng-lead.plist) printf '%s\n' flywheel-lead-wrapper-v2.sh ;;
    *growth-mufasa-lead.plist) printf '%s\n' flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh ;;
    *raya-raya.plist) printf '%s\n' flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh ;;
    *) return 1 ;;
  esac
}
derive_lead_roster
expect_eq "$LEAD_ROSTER_STATE" "ok" "valid loaded jobs produce one complete roster snapshot"
if grep -qE '^claude-private\|com\.flywheel\.lead\.flywheel-eng-lead\|flywheel-eng-lead\|.+\.sock$' <<< "$LEAD_ROSTER_ROWS" \
    && grep -qx 'codex-tui-cmux|com.flywheel.lead.growth-mufasa-lead|growth-mufasa-lead|' <<< "$LEAD_ROSTER_ROWS" \
    && grep -qx 'codex-tui-cmux|com.flywheel.lead.raya-raya|raya-raya|' <<< "$LEAD_ROSTER_ROWS"; then
  pass "derived roster uses manifest projectName/leadId and the TUI label identity"
else
  fail "derived roster rows mismatch: [$LEAD_ROSTER_ROWS]"
fi

touch "$HOME/Library/LaunchAgents/com.flywheel.lead.bad-lead.plist"
printf '%s\n' '{bad-json' > "$HOME/.flywheel/manifests/bad-lead.json"
lead_plist_wrapper_basename() {
  case "$1" in
    *flywheel-eng-lead.plist) printf '%s\n' flywheel-lead-wrapper-v2.sh ;;
    *growth-mufasa-lead.plist) printf '%s\n' flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh ;;
    *raya-raya.plist) printf '%s\n' flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh ;;
    *bad-lead.plist) printf '%s\n' flywheel-lead-wrapper-v2.sh ;;
    *) return 1 ;;
  esac
}
derive_lead_roster
if [[ "$LEAD_ROSTER_STATE" == "indeterminate" && -z "$LEAD_ROSTER_ROWS" ]]; then
  pass "one malformed loaded manifest invalidates the entire Lead snapshot"
else
  fail "Lead derivation leaked a partial roster state=$LEAD_ROSTER_STATE rows=[$LEAD_ROSTER_ROWS]"
fi
rm -f "$HOME/Library/LaunchAgents/com.flywheel.lead.bad-lead.plist"

echo "Test: FLY-1446 typed tmux inventory distinguishes empty from unreadable"
TMUX_MODE=nonempty
tmux() {
  case "$TMUX_MODE:$1" in
    fail:list-sessions) return 1 ;;
    empty:list-sessions) return 0 ;;
    nonempty:list-sessions) printf '%s\n' flywheel runner-flywheel unrelated ;;
    partial:list-sessions) printf '%s\n' flywheel runner-flywheel ;;
    *:list-windows)
      local target=""
      while [[ $# -gt 0 ]]; do
        case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac
      done
      if [[ "$TMUX_MODE" == "partial" && "$target" == "runner-flywheel" ]]; then return 1; fi
      case "$target" in
        flywheel) printf '%s\n' 'flywheel|@7|flywheel-eng-lead' ;;
        runner-flywheel) printf '%s\n' 'runner-flywheel|@8|FLY-1446-implement' ;;
      esac
      ;;
    *) return 1 ;;
  esac
}
read_roster_tmux_inventory
expect_eq "$ROSTER_TMUX_STATE" "ok_nonempty" "complete inventory is typed nonempty"
expect_eq "$ROSTER_TMUX_WINDOWS" $'flywheel|@7|flywheel-eng-lead\nrunner-flywheel|@8|FLY-1446-implement' \
  "complete typed inventory publishes atomically parsed rows"
TMUX_MODE=empty; read_roster_tmux_inventory
expect_eq "$ROSTER_TMUX_STATE" "ok_empty" "successful zero-session read is conclusive empty"
TMUX_MODE=fail; read_roster_tmux_inventory
expect_eq "$ROSTER_TMUX_STATE" "indeterminate" "tmux IPC failure is not interpreted as empty"
TMUX_MODE=partial; read_roster_tmux_inventory
expect_eq "$ROSTER_TMUX_STATE" "indeterminate" "one runner-session read failure invalidates the whole snapshot"

echo "Test: FLY-1446 roster episodes re-arm after recovery"
rm -f "$ROSTER_EPISODE_STATE"; : > "$ALERTS"
roster_alert_unhealthy lead-window-missing flywheel-eng-lead "missing" "missing"
roster_alert_unhealthy lead-window-missing flywheel-eng-lead "missing" "missing"
roster_mark_healthy lead-window-missing flywheel-eng-lead
roster_alert_unhealthy lead-window-missing flywheel-eng-lead "missing" "missing"
if [[ "$(grep -c 'lead-window-missing|flywheel-eng-lead|e1' "$ALERTS")" == "1" \
    && "$(grep -c 'lead-window-missing|flywheel-eng-lead|e2' "$ALERTS")" == "1" ]]; then
  pass "unhealthy repeats are quiet; healthy recovery creates a new alert episode"
else
  fail "episode signatures mismatch: [$(cat "$ALERTS")]"
fi

echo "Test: FLY-1446 Lead reconciliation alerts exact missing/config subjects"
rm -f "$ROSTER_EPISODE_STATE"; : > "$ALERTS"
LEAD_FIXTURE_WINDOWS='flywheel|@7|flywheel-eng-lead'
derive_lead_roster() {
  LEAD_ROSTER_STATE=ok
  LEAD_ROSTER_ROWS=$'claude-tmux|com.flywheel.lead.flywheel-eng-lead|flywheel-eng-lead\ncodex-tui-cmux|com.flywheel.lead.growth-mufasa-lead|growth-mufasa-lead\nconfig-drift|com.flywheel.lead.bad|bad-lead'
}
read_roster_tmux_inventory() {
  ROSTER_TMUX_STATE=ok_nonempty
  ROSTER_TMUX_WINDOWS="$LEAD_FIXTURE_WINDOWS"
}
reconcile_lead_roster
reconcile_lead_roster
LEAD_FIXTURE_WINDOWS+=$'\n''flywheel|@8|growth-mufasa-lead'
reconcile_lead_roster
LEAD_FIXTURE_WINDOWS='flywheel|@7|flywheel-eng-lead'
reconcile_lead_roster
if [[ "$(grep -c 'lead-window-missing|growth-mufasa-lead|e1' "$ALERTS")" == "1" \
    && "$(grep -c 'lead-window-missing|growth-mufasa-lead|e2' "$ALERTS")" == "1" \
    && "$(grep -c 'config-drift|com.flywheel.lead.bad|e1' "$ALERTS")" == "1" ]]; then
  pass "Lead subjects page once per unhealthy episode; config drift is explicit, not silently exempt"
else
  fail "Lead reconciliation episode mismatch: [$(cat "$ALERTS")]"
fi

echo "Test: FLY-1446 Bridge URL and token transport are fail-closed"
for valid in 'http://127.0.0.1:9876' 'http://localhost:1234'; do
  validate_loopback_bridge_url "$valid" || fail "valid loopback URL rejected: $valid"
done
for invalid in 'https://127.0.0.1:9876' 'http://example.com:9876' \
  'http://user@127.0.0.1:9876' 'http://127.0.0.1:9876/api' \
  'http://127.0.0.1:9876?x=1' 'http://127.0.0.1:9876?' \
  'http://127.0.0.1:9876#fragment' 'http://127.0.0.1:99999'; do
  if validate_loopback_bridge_url "$invalid"; then fail "unsafe Bridge URL accepted: $invalid"; fi
done
printf '%s\n' 'TEAMLEAD_API_TOKEN=secret-roster-token' 'TEAMLEAD_PORT=9988' > "$FLYWHEEL_ENV_FILE"
CURL_ARGV="$TMP/curl-argv"; CURL_STDIN="$TMP/curl-stdin"
CURL_RESPONSE='{"sessions":[{"execution_id":"exec-a","status":"running"}],"count":1}'
curl() {
  printf '%s\n' "$*" > "$CURL_ARGV"
  cat > "$CURL_STDIN"
  printf '%s\n' "$CURL_RESPONSE"
}
fetch_active_runner_roster
if [[ "$RUNNER_EXPECTED_STATE" == "ok" && "$RUNNER_EXPECTED_EXEC_IDS" == "exec-a" \
    && "$(cat "$CURL_ARGV")" != *'secret-roster-token'* \
    && "$(cat "$CURL_ARGV")" == *'--config -'* \
    && "$(cat "$CURL_STDIN")" == *'Authorization: Bearer secret-roster-token'* ]]; then
  pass "runner roster uses validated loopback URL and sends Bearer only through curl stdin config"
else
  fail "runner fetch contract mismatch state=$RUNNER_EXPECTED_STATE ids=[$RUNNER_EXPECTED_EXEC_IDS] argv=[$(cat "$CURL_ARGV")]"
fi
CURL_RESPONSE='{"sessions":[{"execution_id":"dup","status":"running"},{"execution_id":"dup","status":"ship_parked"}],"count":2}'
if fetch_active_runner_roster; then
  fail "duplicate execution ids must invalidate the entire Bridge snapshot"
else
  pass "duplicate execution ids fail closed with zero expected-runner publication"
fi
printf '%s\n' 'TEAMLEAD_API_TOKEN=secret-roster-token' \
  'UNRELATED=$(touch '"$TMP"'/must-not-run)' > "$FLYWHEEL_ENV_FILE"
load_flywheel_env_value TEAMLEAD_API_TOKEN 0
if [[ "$FLYWHEEL_ENV_VALUE" == "secret-roster-token" && ! -e "$TMP/must-not-run" ]]; then
  pass "key-specific env parsing never evaluates unrelated shell syntax"
else
  fail "env parser executed or lost the token"
fi

echo "Test: FLY-1446 runner window identity merges aliases by exact window id"
TMUX_EXEC_ROWS=$'runner-flywheel\t@8\texec-a\ncmux-alias\t@8\texec-a\nrunner-flywheel\t@9\texec-b\nrunner-other\t@10\texec-b'
tmux() {
  [[ "$1" == "list-windows" && "$2" == "-a" ]] || return 1
  printf '%s\n' "$TMUX_EXEC_ROWS"
}
read_runner_tmux_exec_inventory
if grep -qx 'exec-a|present|@8' <<< "$RUNNER_TMUX_EXEC_ROWS" \
    && grep -qx 'exec-b|indeterminate|@10,@9' <<< "$RUNNER_TMUX_EXEC_ROWS"; then
  pass "same-window aliases collapse; one exec on two distinct windows is indeterminate"
else
  fail "runner exec inventory mismatch state=$RUNNER_TMUX_STATE rows=[$RUNNER_TMUX_EXEC_ROWS]"
fi
TMUX_EXEC_ROWS='malformed-row'
if read_runner_tmux_exec_inventory; then
  fail "malformed global tmux rows must not publish a partial exec inventory"
else
  pass "malformed global tmux inventory is typed indeterminate"
fi

echo "Test: FLY-1446 active runner orphan alerts use execution identity episodes"
rm -f "$ROSTER_EPISODE_STATE"; : > "$ALERTS"
RUNNER_FIXTURE_WINDOWS=""
fetch_active_runner_roster() {
  RUNNER_EXPECTED_STATE=ok
  RUNNER_EXPECTED_EXEC_IDS=1234567890123456
}
read_runner_tmux_exec_inventory() {
  RUNNER_TMUX_STATE=ok
  RUNNER_TMUX_EXEC_ROWS="$RUNNER_FIXTURE_WINDOWS"
}
reconcile_runner_roster
reconcile_runner_roster
RUNNER_FIXTURE_WINDOWS='1234567890123456|present|@8'
reconcile_runner_roster
RUNNER_FIXTURE_WINDOWS=""
reconcile_runner_roster
if [[ "$(grep -c 'runner-orphan|123456789012|e1' "$ALERTS")" == "1" \
    && "$(grep -c 'runner-orphan|123456789012|e2' "$ALERTS")" == "1" ]]; then
  pass "missing exact exec id pages once, re-arms on window recovery, and pages a new episode"
else
  fail "runner orphan episode mismatch: [$(cat "$ALERTS")]"
fi

echo "Test: FLY-1446 additive pass keeps R phase alive when M phase is blocked"
ORDER="$TMP/order"; : > "$ORDER"
reconcile_roster_read_phase() { printf 'R\n' >> "$ORDER"; }
get_tmux_agent_windows() { printf '%s\n' 'flywheel|@7|flywheel-eng-lead'; }
register_hooks_on_new_sessions() { printf 'hooks\n' >> "$ORDER"; }
refresh_linked_sessions() { printf 'refresh\n' >> "$ORDER"; return 1; }
reconcile_existing_workspaces() { printf 'reconcile\n' >> "$ORDER"; }
create_workspace_for_window() { printf 'create\n' >> "$ORDER"; }
sync_additive
if [[ "$(sed -n '1p' "$ORDER")" == "R" ]] && ! grep -qx 'create' "$ORDER" \
    && ! grep -qx 'reconcile' "$ORDER"; then
  pass "read-only roster runs first; failed durable-state gate authorizes zero downstream mutation"
else
  fail "two-phase ordering mismatch: [$(tr '\n' ',' < "$ORDER")]"
fi

: > "$ORDER"
get_tmux_agent_windows() { return 0; }
sync_additive
if [[ "$(sed -n '1p' "$ORDER")" == "R" && "$(grep -c '^refresh$' "$ORDER")" == "1" ]] \
    && ! grep -Eq '^(create|reconcile)$' "$ORDER"; then
  pass "conclusive-empty source round still runs R and WAL recovery, then emits zero mutation on recovery failure"
else
  fail "empty-round two-phase ordering mismatch: [$(tr '\n' ',' < "$ORDER")]"
fi

: > "$ORDER"
touch "$FLYWHEEL_CMUX_MAINTENANCE_MARKER"
sync_additive
if [[ ! -s "$ORDER" ]]; then
  pass "maintenance marker suppresses roster derivation, alerts, and all mutations for the round"
else
  fail "maintenance marker allowed work: [$(cat "$ORDER")]"
fi

echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
