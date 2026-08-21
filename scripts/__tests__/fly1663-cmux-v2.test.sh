#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/flywheel-cmux-sync.sh"
ATTACH="$ROOT/scripts/flywheel-lead-attach.sh"
TMP="$(mktemp -d /tmp/f1663-c.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

export HOME="$TMP/home"
export FLYWHEEL_STATE_DIR="$HOME/.flywheel"
export FLYWHEEL_DIR="$ROOT"
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
mkdir -p "$HOME/.flywheel/manifests" "$HOME/Library/LaunchAgents"

for writable_path in \
  "$HOME" "$FLYWHEEL_STATE_DIR" "$VIEW_WAL_DIR" "$VIEW_LEDGER" \
  "$KEEPER_INVENTORY" "$VIEW_ABSENT_STATE" "$CMUX_FLAG_STATE" \
  "$LEDGER_CONFLICT_STATE" "$ROSTER_EPISODE_STATE"; do
  case "$writable_path" in
    "$TMP"|"$TMP"/*) ;;
    *) echo "FATAL: writable test path escaped sandbox: $writable_path" >&2; exit 99 ;;
  esac
done

# shellcheck source=../flywheel-cmux-sync.sh
source "$SUT"
set +e

if [[ -x "$ATTACH" ]] \
    && grep -qF 'attach-session -t "=main"' "$ATTACH" \
    && grep -qF 'sleep 2' "$ATTACH"; then
  pass "display helper persistently reconnects to the one private main session"
else
  fail "persistent Lead attach helper contract"
fi

if [[ "$(classify_lead_carrier flywheel-lead-wrapper-v2.sh claude-code)" == "claude-private" ]]; then
  pass "closed carrier matrix recognizes only the canonical v2 wrapper"
else
  fail "v2 carrier classification"
fi

socket="$(derive_lead_socket demo/ops-lead "$HOME/.flywheel")"
expected="env -u TMUX '$HOME/.flywheel/bin/flywheel-lead-attach.sh' '$socket'"
if [[ "$(build_lead_attach_command "$socket")" == "$expected" ]]; then
  pass "v2 cmux command is a canonical direct-socket reconnect command"
else
  fail "v2 canonical attach command"
fi

touch "$HOME/Library/LaunchAgents/com.flywheel.lead.demo-ops-lead.plist"
printf '%s\n' \
  '{"projectName":"demo","leadId":"ops-lead","leadBackend":{"backendId":"claude-code"},"socketPath":"'"$socket"'"}' \
  > "$HOME/.flywheel/manifests/demo-ops-lead.json"
lead_job_loaded() { return 0; }
lead_plist_wrapper_basename() { printf '%s\n' flywheel-lead-wrapper-v2.sh; }
if derive_lead_roster \
    && grep -qxF "claude-private|com.flywheel.lead.demo-ops-lead|demo-ops-lead|$socket" \
      <<< "$LEAD_ROSTER_ROWS"; then
  pass "authoritative Lead roster carries the private socket address"
else
  fail "v2 authoritative roster row: state=$LEAD_ROSTER_STATE rows=[$LEAD_ROSTER_ROWS]"
fi

rm -f "$ROSTER_EPISODE_STATE"
read_roster_tmux_inventory() { return 1; }
tmux() {
  [[ "$1" == "-S" && "$2" == "$socket" ]] || return 1
  case "$3" in has-session|list-clients) return 0 ;; *) return 1 ;; esac
}
reconcile_lead_roster
if ! grep -qE '^(roster-blind|lead-window-missing)\|' "$ROSTER_EPISODE_STATE" 2>/dev/null; then
  pass "private Lead health is independent of the shared tmux inventory"
else
  fail "v2 health was coupled to shared tmux: [$(cat "$ROSTER_EPISODE_STATE")]"
fi

calls="$TMP/direct-calls"
counter="$TMP/json-counter"
: > "$calls"
printf '0\n' > "$counter"
workspace_title=""
surface_title=""
cmux_socket_identity() { printf '%s\n' gen-1; }
get_cmux_workspaces_json() {
  local n
  n=$(cat "$counter")
  n=$((n + 1))
  printf '%s\n' "$n" > "$counter"
  if (( n < 3 )); then
    printf '%s\n' '{"workspaces":[]}'
  else
    printf '{"workspaces":[{"ref":"workspace:9","title":"%s"}]}\n' "$expected"
  fi
}
workspace_title_for_ref() { printf '%s\n' "$workspace_title"; }
workspace_single_surface_title() { printf '%s\n' "$surface_title"; }
workspace_terminal_surface_ref() { return 1; }
ledger_candidate_receipt_state() { printf '%s\n' none; }
_ledger_upsert() { printf 'ledger:%s:%s\n' "$1" "$3" >> "$calls"; return 0; }
cmux_call_guarded() {
  local guard="$1" op="$2"
  shift 2
  GUARD_WAS_BLOCKED=0
  "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
  printf 'cmux:%s\n' "$op" >> "$calls"
  case "$op" in
    new-workspace) workspace_title="$expected"; surface_title="$expected" ;;
    rename-workspace) workspace_title="demo-ops-lead" ;;
    rename-tab) surface_title="demo-ops-lead" ;;
  esac
}
if ensure_v2_lead_workspace demo-ops-lead "$socket" \
    && [[ "$(tr '\n' ',' < "$calls")" == \
      "cmux:new-workspace,ledger:prepared:workspace:9,cmux:rename-workspace,cmux:rename-tab,ledger:committed:workspace:9," ]]; then
  pass "direct workspace create is receipt-backed and names the same exact ref"
else
  fail "direct workspace transaction: [$(tr '\n' ',' < "$calls")]"
fi

: > "$calls"
workspace_title="demo-ops-lead"
surface_title="demo-ops-lead"
get_cmux_workspaces_json() {
  printf '%s\n' '{"workspaces":[{"ref":"workspace:9","title":"demo-ops-lead"}]}'
}
ledger_candidate_receipt_state() { printf '%s\n' committed; }
printf '%s\n' 'committed|gen-1|workspace:9|demo-ops-lead' > "$VIEW_LEDGER"
workspace_terminal_surface_ref() { printf '%s\n' surface:3; }
surface_looks_like_bare_shell() { return 0; }
if ensure_v2_lead_workspace demo-ops-lead "$socket" \
    && grep -qxF 'cmux:send' "$calls" \
    && ! grep -qxF 'cmux:new-workspace' "$calls"; then
  pass "v1-to-v2 cutover keeps the receipted workspace ref and injects direct reconnect only into a bare shell"
else
  fail "same-ref reconnect transaction: [$(tr '\n' ',' < "$calls")]"
fi

: > "$calls"
get_cmux_workspaces_json() {
  printf '%s\n' '{"workspaces":[{"ref":"workspace:9","title":"demo-ops-lead"},{"ref":"workspace:10","title":"'"$expected"'"}]}'
}
ledger_candidate_receipt_state() {
  [[ "$2" == "workspace:9" ]] && printf '%s\n' committed || printf '%s\n' none
}
if _v2_lead_cleanup_duplicates gen-1 workspace:9 demo-ops-lead "$socket" "$expected" \
    && [[ "$(tr '\n' ',' < "$calls")" == "cmux:close-workspace," ]]; then
  pass "committed v2 keeper safely removes only an exact raw duplicate"
else
  fail "v2 duplicate cleanup: [$(tr '\n' ',' < "$calls")]"
fi

get_cmux_workspaces_json() {
  printf '%s\n' '{"workspaces":[{"ref":"workspace:9","title":"demo-ops-lead"}]}'
}
ledger_candidate_receipt_state() { printf '%s\n' committed; }

if [[ "$(list_lead_refs)" == "workspace:9" ]]; then
  pass "--list-lead-refs includes private roster Leads without a shared tmux window"
else
  fail "private Lead ref listing"
fi

order="$TMP/order"
: > "$order"
maintenance_requested() { return 1; }
reconcile_roster_read_phase() { printf 'roster\n' >> "$order"; }
watcher_mutation_latch_clear() { return 0; }
reconcile_v2_lead_workspaces() { printf 'v2\n' >> "$order"; }
register_hooks_on_new_sessions() { printf 'hooks\n' >> "$order"; }
get_tmux_agent_windows() { printf '%s\n' 'runner-demo|@1|FLY-1-runner'; }
refresh_linked_sessions() { printf 'runner-refresh\n' >> "$order"; return 1; }
sync_additive
if [[ "$(sed -n '1,3p' "$order" | tr '\n' ',')" == "roster,v2,hooks," ]]; then
  pass "v2 Lead visibility reconciles before any Runner linked-view wedge"
else
  fail "mixed visibility ordering: [$(tr '\n' ',' < "$order")]"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
