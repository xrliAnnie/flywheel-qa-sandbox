#!/bin/bash
# FLY-2829 founder A: durable duplicate proof and proof-bound husk cleanup.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly2829-converge-XXXXXX)"
trap 'rm -rf "$SB"' EXIT

export HOME="$SB/home"
export NODE_STATUS_DIR="$HOME/.flywheel/state/cmux-node-status"
export DUPLICATE_STATE="$SB/duplicate-state"
export VIEW_LEDGER="$SB/view-ledger"
export NODE_LEDGER="$SB/node-ledger"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$SB/maintenance"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$SB/watcher.lock"
export FLYWHEEL_ENV_FILE="$SB/flywheel.env"
export FLYWHEEL_CMUX_ALERT_BIN=/usr/bin/true
: > "$FLYWHEEL_ENV_FILE"

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"

pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }
assert_or_reuse_owned_lease() { return 0; }
mutator_lease_owned_by_self() { return 0; }
cmux_socket_identity() { printf 'generation-2829\n'; }
watcher_mutation_latch_clear() { return 0; }
log() { :; }

printf '\n== Duplicate cleanup requires two distinct additive rounds ==\n'
if ! declare -F duplicate_proof_observe >/dev/null; then
  bad 'duplicate_proof_observe is missing'
else
  CMUX_ADDITIVE_ROUND_ID=100-1
  first=$(duplicate_proof_observe view generation-2829 FLY-2829-qa-codex workspace:10 workspace:11 live-dead 2>/dev/null || true)
  same=$(duplicate_proof_observe view generation-2829 FLY-2829-qa-codex workspace:10 workspace:11 live-dead 2>/dev/null || true)
  CMUX_ADDITIVE_ROUND_ID=100-2
  second=$(duplicate_proof_observe view generation-2829 FLY-2829-qa-codex workspace:10 workspace:11 live-dead 2>/dev/null || true)
  CMUX_ADDITIVE_ROUND_ID=100-3
  changed=$(duplicate_proof_observe view generation-2829 FLY-2829-qa-codex workspace:10 workspace:11 dead-live 2>/dev/null || true)
  if [[ "$first" == 1 && "$same" == 1 && "$second" == 2 && "$changed" == 1 ]]; then
    ok 'same-round samples do not advance; a second round does; relation changes re-arm'
  else
    bad "duplicate proof counts first=$first same=$same second=$second changed=$changed"
  fi
fi

printf '\n== Private Lead raw duplicates use the same two-round convergence fence ==\n'
: > "$DUPLICATE_STATE"
CLOSED=""
get_cmux_workspaces_json() {
  printf '%s\n' '{"workspaces":[{"ref":"workspace:10","title":"growth-rafiki-lead"},{"ref":"workspace:11","title":"raw-lead-command"}]}'
}
workspace_title_candidates() { printf 'raw|workspace:11|0|0|11\n'; }
cmux_attach_birth_records() { return 0; }
workspace_birth_candidate_rows() { return 0; }
workspace_attach_liveness() {
  [[ "$1" == workspace:10 ]] && printf 'live\n' || printf 'dead\n'
}
_v2_lead_roster_row_current() { return 0; }
ledger_candidate_receipt_state() {
  [[ "$2" == workspace:10 ]] && printf 'committed\n' || printf 'none\n'
}
tmux() { return 0; }
workspace_title_for_ref() { printf 'growth-rafiki-lead\n'; }
cmux_call_guarded_close_with_attach_reap() {
  local ref="$1" guard="$3"
  GUARD_WAS_BLOCKED=0
  "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
  CLOSED+="${CLOSED:+ }$ref"
}
CMUX_ADDITIVE_ROUND_ID='2829-1'
_v2_lead_cleanup_duplicates generation-2829 workspace:10 growth-rafiki-lead /tmp/growth.sock canonical || true
first="$CLOSED"
CMUX_ADDITIVE_ROUND_ID='2829-2'
_v2_lead_cleanup_duplicates generation-2829 workspace:10 growth-rafiki-lead /tmp/growth.sock canonical || true
if [[ -z "$first" && "$CLOSED" == workspace:11 ]]; then
  ok 'private Lead preserves the first sample and closes only the proven-dead duplicate on round two'
else
  bad "private Lead duplicate convergence drifted first=[$first] closed=[$CLOSED] proof=[$(cat "$DUPLICATE_STATE" 2>/dev/null)]"
fi

printf '\n== Terminal husks require a receipt or a birth-proven bare shell ==\n'
if ! declare -F reap_proven_managed_husks >/dev/null; then
  bad 'reap_proven_managed_husks is missing'
else
  WORKSPACES='{"workspaces":[{"ref":"workspace:1","title":"Terminal 1","id":"11111111-1111-4111-8111-111111111111"},{"ref":"workspace:2","title":"Terminal 2","id":"22222222-2222-4222-8222-222222222222"},{"ref":"workspace:3","title":"~","id":"33333333-3333-4333-8333-333333333333"},{"ref":"workspace:4","title":"Terminal 4","id":"44444444-4444-4444-8444-444444444444"},{"ref":"workspace:5","title":"Terminal 5","id":"55555555-5555-4555-8555-555555555555"},{"ref":"workspace:6","title":"Terminal 6","id":"66666666-6666-4666-8666-666666666666"}]}'
  printf 'prepared|generation-2829|workspace:1|exec-old|node:old\n' > "$NODE_LEDGER"
  : > "$VIEW_LEDGER"
  CLOSED=""
  SCREEN_READS=""
  # Production birth rows carry the terminal surface UUID (the persisted
  # session's focusedPanelId). workspace:6 is a bare shell whose live surface
  # is not the born one, so it must stay untouched.
  BIRTHS='workspace:4|44444444-4444-4444-8444-444444444444|VGVybWluYWwgNA==|A4A4A4A4-0000-4000-8000-000000000004|view|Y211eC1saXZl|fwtok1-44444444444444444444444444444444
workspace:5|55555555-5555-4555-8555-555555555555|VGVybWluYWwgNQ==|A5A5A5A5-0000-4000-8000-000000000005|view|Y211eC1odXNr|fwtok1-55555555555555555555555555555555
workspace:6|66666666-6666-4666-8666-666666666666|VGVybWluYWwgNg==|A6A6A6A6-0000-4000-8000-000000000006|view|Y211eC1vdGhlcg==|fwtok1-66666666666666666666666666666666'
  get_cmux_workspaces_json() { printf '%s\n' "$WORKSPACES"; }
  cmux_attach_birth_records() { printf '%s\n' "$BIRTHS"; }
  cmux_workspace_birth_record() {
    printf '%s\n' "$BIRTHS" | awk -F'|' -v r="$1" -v u="$2" '$1 == r && $2 == u { print; found=1 } END { exit(found ? 0 : 1) }'
  }
  # Real cmux list-pane-surfaces shapes: the default id format returns only
  # `surface:N` refs; `--id-format both` adds the surface and workspace UUIDs.
  cmux_call() {
    local both=0 ws="" arg prev=""
    for arg in "$@"; do
      [[ "$prev" == --id-format && "$arg" == both ]] && both=1
      [[ "$prev" == --workspace ]] && ws="$arg"
      prev="$arg"
    done
    case " $* " in *' list-pane-surfaces '*) ;; *) return 1 ;; esac
    local n="${ws#workspace:}" surface_uuid workspace_uuid
    case "$n" in
      4) surface_uuid=A4A4A4A4-0000-4000-8000-000000000004 ;;
      5) surface_uuid=A5A5A5A5-0000-4000-8000-000000000005 ;;
      6) surface_uuid=B6B6B6B6-0000-4000-8000-000000000006 ;;
      *) surface_uuid=C0C0C0C0-0000-4000-8000-00000000000$n ;;
    esac
    workspace_uuid=$(printf '%s' "$WORKSPACES" | python3 -c '
import json,sys
print(next(w["id"] for w in json.load(sys.stdin)["workspaces"] if w["ref"]==sys.argv[1]))' "$ws")
    if [[ "$both" == 1 ]]; then
      printf '{"surfaces":[{"title":"zsh","index":0,"type":"terminal","selected":true,"ref":"surface:%s","id":"%s"}],"pane_id":"D0D0D0D0-0000-4000-8000-000000000000","workspace_ref":"%s","workspace_id":"%s","window_ref":"window:1","pane_ref":"pane:%s"}\n' \
        "$((n + 170))" "$surface_uuid" "$ws" "$workspace_uuid" "$n"
    else
      printf '{"pane_ref":"pane:%s","surfaces":[{"selected":true,"ref":"surface:%s","type":"terminal","index":0,"title":"zsh"}],"workspace_ref":"%s","window_ref":"window:1"}\n' \
        "$n" "$((n + 170))" "$ws"
    fi
  }
  surface_looks_like_bare_shell() {
    SCREEN_READS+="${SCREEN_READS:+ }$1=$2"
    [[ "$1" == workspace:5 || "$1" == workspace:6 ]]
  }
  node_registry_row() { printf 'exec-old|node:old|old|terminal-summary|1|1-1|0|0|2|1|-|1-1|1\n'; }
  close_node_workspace() { CLOSED+="${CLOSED:+ }node:$1:$2:$3"; : > "$NODE_LEDGER"; return 0; }
  cmux_call_guarded_close_with_attach_reap() {
    local ref="$1" guard="$3"
    GUARD_WAS_BLOCKED=0
    "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
    CLOSED+="${CLOSED:+ }birth:$ref"
    return 0
  }
  reap_proven_managed_husks || true
  if [[ "$CLOSED" == 'node:exec-old:node:old:retired-node-card birth:workspace:5' ]]; then
    ok 'receipted and birth-proven bare husks close; live, unproven and founder terminals stay untouched'
  else
    bad "unexpected husk mutations: [$CLOSED]"
  fi
  # The born surface is matched by UUID but read through its live surface:N
  # handle; the mismatched workspace:6 bare shell is never read or closed.
  if [[ "$SCREEN_READS" == 'workspace:4=surface:174 workspace:5=surface:175 workspace:5=surface:175' ]]; then
    ok 'only UUID-matched born surfaces are screen-read, via their live surface refs'
  else
    bad "unexpected husk screen reads: [$SCREEN_READS]"
  fi
fi

printf '\n== Retired node-status state is removed when no node receipt remains ==\n'
rm -f "$NODE_LEDGER"
mkdir -p "$NODE_STATUS_DIR"
printf 'legacy\n' > "$NODE_STATUS_DIR/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.status"
if reconcile_node_ledger && [[ ! -e "$NODE_STATUS_DIR" ]]; then
  ok 'the obsolete node-status directory is removed after receipt retirement'
else
  bad "node-status state survived: [$(find "$NODE_STATUS_DIR" -maxdepth 1 -type f 2>/dev/null)]"
fi

printf '\nFLY-2829 workspace convergence: %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
