#!/usr/bin/env bash
set -uo pipefail

ROOT=$(mktemp -d /tmp/fly2207-rebind.XXXXXX)
trap 'rm -rf "$ROOT"' EXIT
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=../flywheel-cmux-sync.sh
source "$REPO_ROOT/scripts/flywheel-cmux-sync.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1" >&2; }

TITLE=FLY-2207-runner-codex-G-rebind
EXEC_ID=exec-2207
SOURCE_SESSION=runner-flywheel
SOURCE_WID=@7
UUID=11111111-1111-4111-8111-111111111111
REF=workspace:7
REBIND_EPISODE_STATE="$ROOT/rebind-episode"
REBIND_CONTROL_STATE="$ROOT/rebind-disabled"
NODE_REGISTRY="$ROOT/node-registry"
VIEW_LEDGER="$ROOT/view-ledger"
VIEW_WAL_DIR="$ROOT/view-wal"
CMUX_ADDITIVE_ROUND_ID=100-1
CMUX_GENERATION=cmux-a
TMUX_GENERATION=tmux-a
SOURCE_ROWS=""
ACTIVE_ROWS=""
WORKSPACE_DUPLICATES=1
OWNERSHIP=birth
VIEW_EXISTS=0
CURRENT_RECEIPT=0
ATTACHED=0
BUILDS=0
ADOPTS=0
HEALS=0
ALERTS=""
BUILD_MODE=success

reset_case() {
  rm -f "$REBIND_EPISODE_STATE"
  rm -f "$REBIND_CONTROL_STATE"
  : > "$VIEW_LEDGER"
  printf '%s|node:a|a|active-windowed|1|100-1|2|0|0|0|%s|100-1|0\n' \
    "$EXEC_ID" "$TITLE" > "$NODE_REGISTRY"
  SOURCE_ROWS="$EXEC_ID|present|$SOURCE_WID|$TITLE|$SOURCE_SESSION"
  ACTIVE_ROWS="$EXEC_ID|node-a|FLY-2207|implement|running|codex|-|rebind|-|-|-|-"
  WORKSPACE_DUPLICATES=1
  OWNERSHIP=birth
  VIEW_EXISTS=0
  CURRENT_RECEIPT=0
  ATTACHED=0
  BUILDS=0
  ADOPTS=0
  HEALS=0
  ALERTS=""
  BUILD_MODE=success
  CMUX_GENERATION=cmux-a
  TMUX_GENERATION=tmux-a
}

fetch_active_runner_roster() {
  RUNNER_EXPECTED_STATE=ok
  RUNNER_ACTIVE_ROWS="$ACTIVE_ROWS"
  RUNNER_EXPECTED_EXEC_IDS=$(printf '%s\n' "$ACTIVE_ROWS" | cut -d'|' -f1)
}
read_runner_tmux_node_inventory() {
  RUNNER_NODE_TMUX_STATE=ok
  RUNNER_NODE_TMUX_ROWS="$SOURCE_ROWS"
}
window_source_pane_alive() { return 0; }
cmux_socket_identity() { printf '%s\n' "$CMUX_GENERATION"; }
tmux_server_generation() { printf '%s\n' "$TMUX_GENERATION"; }
watcher_mutation_latch_clear() { return 0; }
get_cmux_workspaces_json() {
  python3 - "$WORKSPACE_DUPLICATES" "$REF" "$UUID" "$TITLE" <<'PY'
import json,sys
count,ref,uuid,title=sys.argv[1:]
rows=[{"ref":ref,"id":uuid,"title":title}]
if count == "2": rows.append({"ref":"workspace:8","id":"22222222-2222-4222-8222-222222222222","title":title})
print(json.dumps({"workspaces":rows}))
PY
}
cmux_workspace_birth_record() {
  [[ "$OWNERSHIP" == birth ]] || return 1
  printf '%s|%s|%s|33333333-3333-4333-8333-333333333333|view|%s|fwtok1-11111111111111111111111111111111\n' \
    "$REF" "$UUID" "$(printf '%s' "$TITLE" | base64 | tr -d '\n')" \
    "$(printf 'cmux-%s' "$TITLE" | base64 | tr -d '\n')"
}
workspace_identity_matches() { [[ "$1|$2|$3" == "$REF|$TITLE|$UUID" ]]; }
create_or_replace_view_session() {
  BUILDS=$((BUILDS + 1))
  case "$BUILD_MODE" in
    pre-fail) return 1 ;;
    mutation-fail) VIEW_EXISTS=1; return 1 ;;
    disable) VIEW_EXISTS=1; : > "$REBIND_CONTROL_STATE"; return 0 ;;
    flip-cmux) VIEW_EXISTS=1; CMUX_GENERATION=cmux-b; return 0 ;;
    flip-window) VIEW_EXISTS=1; SOURCE_ROWS="$EXEC_ID|present|@8|$TITLE|$SOURCE_SESSION"; return 0 ;;
    *) VIEW_EXISTS=1; return 0 ;;
  esac
}
_linked_view_matches() { [[ "$VIEW_EXISTS" == 1 ]]; }
adopt_birth_candidate() { ADOPTS=$((ADOPTS + 1)); CURRENT_RECEIPT=1; return 0; }
rebind_adopt_stale_receipt() { ADOPTS=$((ADOPTS + 1)); CURRENT_RECEIPT=1; return 0; }
ledger_exact_receipt_state() { [[ "$CURRENT_RECEIPT" == 1 ]] && printf 'committed\n' || return 1; }
ledger_exact_receipt_uuid() { [[ "$CURRENT_RECEIPT" == 1 ]] && printf '%s\n' "$UUID" || return 1; }
workspace_terminal_surface_ref() { printf 'surface:7\n'; }
self_heal_workspace_ref() { HEALS=$((HEALS + 1)); ATTACHED=1; return 0; }
view_session_client_count() { printf '%s\n' "$ATTACHED"; }
_attach_state_write() { return 0; }
_alert_cmux_cleanup() { ALERTS+="${ALERTS:+$'\n'}$1|$2|$3"; }

printf 'Test: birth-owned workspace rebuilds its exact viewer and reconnects in one scan\n'
reset_case
rebind_missing_runner_view "$TITLE"
if [[ "$BUILDS|$ADOPTS|$HEALS|$ATTACHED" == '1|1|1|1' && ! -s "$REBIND_EPISODE_STATE" ]]; then
  pass 'WAL build, UUID receipt adoption, and attach heal converge once'
else
  fail "happy path builds=$BUILDS adopts=$ADOPTS heals=$HEALS attached=$ATTACHED state=$(cat "$REBIND_EPISODE_STATE" 2>/dev/null || true)"
fi

printf 'Test: kill switch is a true zero-mutation return\n'
reset_case
: > "$REBIND_CONTROL_STATE"
rebind_missing_runner_view "$TITLE"
if [[ "$BUILDS|$ADOPTS|$HEALS" == '0|0|0' && ! -e "$REBIND_EPISODE_STATE" ]]; then
  pass 'the projected FLYWHEEL_CMUX_REBIND_DISABLED marker suppresses the whole transaction'
else
  fail 'kill switch allowed rebind state or mutation'
fi

printf 'Test: founder same-title and duplicate workspace candidates stay untouched\n'
reset_case
OWNERSHIP=none
rebind_missing_runner_view "$TITLE"
founder_ops="$BUILDS|$ADOPTS|$HEALS"
reset_case
WORKSPACE_DUPLICATES=2
rebind_missing_runner_view "$TITLE"
if [[ "$founder_ops" == '0|0|0' && "$BUILDS|$ADOPTS|$HEALS" == '0|0|0' \
    && "$ALERTS" == *'rebind refused'* ]]; then
  pass 'workspace-side positive identity is mandatory and ambiguity alerts'
else
  fail "ownership refusal founder=$founder_ops duplicate=$BUILDS|$ADOPTS|$HEALS alerts=$ALERTS"
fi

printf 'Test: duplicate execution ownership refuses before mutation\n'
reset_case
printf 'exec-other|node:b|b|active-windowed|1|100-1|2|0|0|0|%s|100-1|0\n' "$TITLE" >> "$NODE_REGISTRY"
ACTIVE_ROWS+=$'\nexec-other|node-b|FLY-2207|qa|running|codex|-|other|-|-|-|-'
SOURCE_ROWS+=$'\nexec-other|present|@8|'"$TITLE"'|runner-other'
rebind_missing_runner_view "$TITLE"
if [[ "$BUILDS|$ADOPTS|$HEALS" == '0|0|0' ]]; then
  pass 'two active executions mapped to one title provide zero authority'
else
  fail 'duplicate execution crossed source identity guard'
fi

printf 'Test: stale registry ownership refuses before mutation\n'
reset_case
printf 'exec-retired|node:a|a|active-windowed|1|100-1|2|0|0|0|%s|100-1|0\n' \
  "$TITLE" > "$NODE_REGISTRY"
rebind_missing_runner_view "$TITLE"
if [[ "$BUILDS|$ADOPTS|$HEALS" == '0|0|0' ]]; then
  pass 'registry execution must still be the unique active owner'
else
  fail 'stale registry identity crossed source authority'
fi

printf 'Test: unique stale UUID receipt is adopted when birth evidence is gone\n'
reset_case
OWNERSHIP=stale
printf 'committed|cmux-old|%s|%s|%s\n' "$REF" "$TITLE" "$UUID" > "$VIEW_LEDGER"
rebind_missing_runner_view "$TITLE"
if [[ "$BUILDS|$ADOPTS|$HEALS|$ATTACHED" == '1|1|1|1' ]]; then
  pass 'stale receipt fallback converges without title-only ownership'
else
  fail 'unique stale receipt did not authorize bounded rebind'
fi

printf 'Test: pre-mutation failures retry; post-mutation failures latch for the key\n'
reset_case
BUILD_MODE=pre-fail
rebind_missing_runner_view "$TITLE"
BUILD_MODE=success
rebind_missing_runner_view "$TITLE"
pre_counts="$BUILDS|$ADOPTS|$HEALS|$ATTACHED"
reset_case
BUILD_MODE=mutation-fail
rebind_missing_runner_view "$TITLE"
rebind_missing_runner_view "$TITLE"
failed_phase=$(awk -F'|' '{print $10}' "$REBIND_EPISODE_STATE" 2>/dev/null || true)
if [[ "$pre_counts" == '2|1|1|1' && "$BUILDS" == 1 && "$failed_phase" == failed ]]; then
  pass 'retryability follows the first-mutation boundary and failed keys stay latched'
else
  fail "attempt semantics pre=$pre_counts post_builds=$BUILDS phase=$failed_phase"
fi

printf 'Test: durable viewer and receipt phases resume without repeating mutations\n'
reset_case
VIEW_EXISTS=1
printf 'rebindv1|%s|%s|%s|%s|%s|%s|%s|%s|viewer-ready|1\n' \
  "$(_cmux_alert_hash "$CMUX_GENERATION")" "$UUID" "$REF" \
  "$(_cmux_alert_hash "$TMUX_GENERATION")" "$EXEC_ID" "$TITLE" "$SOURCE_SESSION" "$SOURCE_WID" \
  > "$REBIND_EPISODE_STATE"
rebind_missing_runner_view "$TITLE"
viewer_replay="$BUILDS|$ADOPTS|$HEALS|$ATTACHED"
reset_case
VIEW_EXISTS=1
CURRENT_RECEIPT=1
printf 'rebindv1|%s|%s|%s|%s|%s|%s|%s|%s|receipt-ready|1\n' \
  "$(_cmux_alert_hash "$CMUX_GENERATION")" "$UUID" "$REF" \
  "$(_cmux_alert_hash "$TMUX_GENERATION")" "$EXEC_ID" "$TITLE" "$SOURCE_SESSION" "$SOURCE_WID" \
  > "$REBIND_EPISODE_STATE"
rebind_missing_runner_view "$TITLE"
if [[ "$viewer_replay" == '0|1|1|1' && "$BUILDS|$ADOPTS|$HEALS|$ATTACHED" == '0|0|1|1' ]]; then
  pass 'restart replay resumes at the first incomplete phase'
else
  fail "phase replay viewer=$viewer_replay receipt=$BUILDS|$ADOPTS|$HEALS|$ATTACHED"
fi

printf 'Test: generation and source-window flips stop later ledger/attach mutation\n'
reset_case
BUILD_MODE=flip-cmux
rebind_missing_runner_view "$TITLE"
cmux_counts="$ADOPTS|$HEALS"
reset_case
BUILD_MODE=flip-window
rebind_missing_runner_view "$TITLE"
if [[ "$cmux_counts" == '0|0' && "$ADOPTS|$HEALS" == '0|0' ]]; then
  pass 'post-build guard catches cmux generation and exact @id replacement'
else
  fail "identity flip crossed guard cmux=$cmux_counts window=$ADOPTS|$HEALS"
fi

printf 'Test: a kill-switch flip during rebuild stops the next mutation\n'
reset_case
BUILD_MODE=disable
rebind_missing_runner_view "$TITLE"
if [[ "$BUILDS|$ADOPTS|$HEALS" == '1|0|0' ]]; then
  pass 'each mutation guard rereads the projected control'
else
  fail "mid-transaction disable crossed guard: $BUILDS|$ADOPTS|$HEALS"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
