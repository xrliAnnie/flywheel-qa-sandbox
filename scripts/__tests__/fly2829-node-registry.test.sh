#!/bin/bash
# FLY-2829: stale node registry must shrink, never mint mirrors for dead
# sessions, honor the maintenance marker inside a round, and rate-limit
# workspace creation across restarts. Runs under /bin/bash 3.2.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly2829-node-XXXXXX)"
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"
mkdir -p "$HOME"

export NODE_LEDGER="$SB/node-ledger"
export NODE_REGISTRY="$SB/node-registry"
export NODE_STATUS_DIR="$HOME/.flywheel/state/cmux-node-status"
export NODE_CREATE_LEDGER="$SB/create-ledger"
export NODE_RUNAWAY_LATCH="$SB/runaway"
export CLEANUP_SNAPSHOT="$SB/cleanup-snapshot"
export CLEANUP_SNAPSHOT_EPISODE_STATE="$SB/cleanup-snapshot-episode"
export CLEANUP_PENDING="$SB/cleanup-pending"
export VIEW_LEDGER="$SB/view-ledger"
export CMUX_ADDITIVE_ROUND_STATE="$SB/round"
export PREPARED_STALL_STATE="$SB/prepared-stall"
export TERMINAL_TEARDOWN_STATE="$SB/terminal-teardown"
export FLYWHEEL_CMUX_CLOSE_REQUEST_FILE="$SB/close-request"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$SB/cmux-maintenance"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$SB/watcher.lock"
export FLYWHEEL_ENV_FILE="$SB/flywheel.env"
export FLYWHEEL_CMUX_NODE_STATUS_BIN="$ROOT/scripts/flywheel-node-status.sh"
export FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=120
export FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES=3
export FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES=5
ALERT_LOG="$SB/alerts.log"
cat > "$SB/alert-bin" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "${FLY2829_ALERT_LOG}"
SH
chmod +x "$SB/alert-bin"
export FLY2829_ALERT_LOG="$ALERT_LOG"
export FLYWHEEL_CMUX_ALERT_BIN="$SB/alert-bin"
LOG_FILE="$SB/watcher.log"

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"
eval "$(declare -f cmux_socket_identity | sed '1s/^cmux_socket_identity/cmux_socket_identity_real/')"

pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }
log() { echo "[cmux-sync test] $*" >> "$LOG_FILE"; }

# ── mutation-faithful cmux model ──────────────────────────────────────────
WS_FILE="$SB/workspaces"; SURFACE_FILE="$SB/surfaces"; : > "$WS_FILE"; : > "$SURFACE_FILE"
NEXT_WS=50
NEW_WS_CALLS=0
CLOSE_CALLS=0
JSON_UNAVAILABLE=0
CREATE_KILL_SELF=0
assert_or_reuse_owned_lease() { return 0; }
mutator_lease_owned_by_self() { return 0; }
cmux_socket_identity() { printf 'generation-2829\n'; }
tmux() { return 1; }
node_publish_cleanup_snapshot() { return 0; }
get_cmux_workspaces_json() {
  [[ "$JSON_UNAVAILABLE" == 0 ]] || return 1
  python3 - "$WS_FILE" <<'PY'
import json,sys
rows=[]
for raw in open(sys.argv[1], encoding="utf-8"):
    ref,title=raw.rstrip("\n").split("|",1)
    rows.append({"ref":ref,"title":title,"id":"uuid-"+ref.split(":")[1]})
print(json.dumps({"workspaces":rows}))
PY
}
workspace_title_for_ref() { awk -F'|' -v r="$1" '$1==r {sub(/^[^|]*\|/,""); print; found=1} END {exit(found?0:1)}' "$WS_FILE"; }
workspace_single_surface_title() { awk -F'|' -v r="$1" '$1==r {sub(/^[^|]*\|/,""); print; found=1} END {exit(found?0:1)}' "$SURFACE_FILE"; }
cmux_call_guarded() {
  local guard="$1" command="$2" ref title tmp; shift 2
  GUARD_WAS_BLOCKED=0
  "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
  case "$command" in
    new-workspace)
      [[ "$1" == --command ]] || return 1
      NEW_WS_CALLS=$((NEW_WS_CALLS + 1))
      NEXT_WS=$((NEXT_WS + 1))
      if [[ "$CREATE_KILL_SELF" == 1 ]]; then kill -KILL "$$"; fi
      printf 'workspace:%s|Terminal %s\n' "$NEXT_WS" "$NEXT_WS" >> "$WS_FILE"
      printf 'workspace:%s|%s\n' "$NEXT_WS" "$2" >> "$SURFACE_FILE"
      ;;
    rename-workspace)
      [[ "$1" == --workspace ]] || return 1; ref="$2"; title="$3"; tmp="$WS_FILE.tmp"
      awk -F'|' -v OFS='|' -v r="$ref" -v t="$title" '$1==r {$2=t} {print}' "$WS_FILE" > "$tmp" && mv "$tmp" "$WS_FILE"
      ;;
    rename-tab)
      [[ "$1" == --workspace ]] || return 1; ref="$2"; title="$3"; tmp="$SURFACE_FILE.tmp"
      awk -F'|' -v OFS='|' -v r="$ref" -v t="$title" '$1==r {$2=t} {print}' "$SURFACE_FILE" > "$tmp" && mv "$tmp" "$SURFACE_FILE"
      ;;
    close-workspace)
      [[ "$1" == --workspace ]] || return 1; ref="$2"
      CLOSE_CALLS=$((CLOSE_CALLS + 1))
      for tmp in "$WS_FILE" "$SURFACE_FILE"; do
        awk -F'|' -v r="$ref" '$1!=r {print}' "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp"
      done
      ;;
    *) return 1 ;;
  esac
}

# ── Bridge roster fixture ─────────────────────────────────────────────────
LIVE_EXECS=""        # newline-separated exec ids reported live
LIVE_FETCH_FAIL=0    # 1 → every live fetch fails (indeterminate)
LIVE_FETCHES=0
live_json() {
  python3 -c '
import json,sys
ids=[x for x in sys.argv[1].split("\n") if x]
rows=[{"execution_id":x,"status":"running","identifier":"FLY-"+x,"session_role":"implement","adapter_type":"remote-control","issue_title":"node "+x} for x in ids]
print(json.dumps({"count":len(rows),"sessions":rows}))
' "$LIVE_EXECS"
}
_fetch_runner_roster_json() {
  case "$1" in
    mode=live*)
      LIVE_FETCHES=$((LIVE_FETCHES + 1))
      [[ "$LIVE_FETCH_FAIL" == 0 ]] || return 1
      live_json ;;
    mode=recent_terminal*) printf '{"count":0,"sessions":[]}\n' ;;
    *) return 1 ;;
  esac
}
prime_roster() {
  fetch_active_runner_roster || RUNNER_EXPECTED_STATE=indeterminate
  RUNNER_NODE_TMUX_STATE=ok; RUNNER_NODE_TMUX_ROWS=""
  RUNNER_TERMINAL_STATE=ok; RUNNER_TERMINAL_ROWS=""
}
begin_pass() {
  MUTATOR_LEASE_MODE="${1:-once}"
  WATCHER_PASS_ACTIVE=1; WATCHER_AUTHORITY_LOST=0; WATCHER_MAINTENANCE_STOP=0
  WATCHER_PASS_SEQ=$((${WATCHER_PASS_SEQ:-0} + 1))
}
run_round() {
  begin_pass "${1:-once}"
  begin_cmux_additive_round
  prime_roster
  reconcile_node_presence
}
reset_world() {
  : > "$WS_FILE"; : > "$SURFACE_FILE"; rm -f "$NODE_LEDGER" "$NODE_REGISTRY" "$NODE_CREATE_LEDGER" "$NODE_RUNAWAY_LATCH" \
    "$PREPARED_STALL_STATE" "$TERMINAL_TEARDOWN_STATE" "$CLOSE_REQUEST_FILE" "$FLYWHEEL_CMUX_MAINTENANCE_MARKER" "$ALERT_LOG" "$LOG_FILE" \
    "${NODE_REGISTRY}.pre-FLY-2829"
  rm -rf "$NODE_STATUS_DIR"
  NEW_WS_CALLS=0; CLOSE_CALLS=0; NEXT_WS=50; JSON_UNAVAILABLE=0; LIVE_EXECS=""; LIVE_FETCH_FAIL=0; LIVE_FETCHES=0
  CREATE_GATE_PASS=""; CREATE_GATE_STATE=uninitialized; WATCHER_PASS_SEQ=""
  CMUX_CLEANUP_ALERT_LATCH=""; CMUX_CLEANUP_ALERT_LATCH_COUNT=0
  unset FLYWHEEL_CMUX_CREATE_BURST_MAX FLYWHEEL_CMUX_CREATE_BURST_SECONDS FLYWHEEL_CMUX_CREATE_WINDOW_SECONDS \
    FLYWHEEL_CMUX_CREATE_WINDOW_MAX FLYWHEEL_CMUX_WORKSPACE_CEILING FLYWHEEL_CMUX_PRUNE_CRASH_AT
}
ws_count() { grep -c . "$WS_FILE" 2>/dev/null || true; }
terminal_count() { grep -c '|Terminal [0-9]*$' "$WS_FILE" 2>/dev/null || true; }
registry_state() { awk -F'|' -v e="$1" '$1==e {print $4}' "$NODE_REGISTRY" 2>/dev/null; }
registry_title() { awk -F'|' -v e="$1" '$1==e {print $2}' "$NODE_REGISTRY" 2>/dev/null; }
row() {
  # row exec title state last_seen [terminal_epoch] [missing]
  printf '%s|%s|alias-%s|%s|%s|1-1|0|0|%s|0|-|1-1|%s\n' "$1" "$2" "$1" "$3" "$4" "${6:-0}" "${5:-0}"
}
status_of() { node_status_path "$1"; }
seed_status() { local p; p=$(status_of "$1"); mkdir -p "$(dirname "$p")"; printf 'seeded\n' > "$p"; }
NOW=$(date +%s)
OLD=$((NOW - 30 * 3600))

# ══════════════════════════════════════════════════════════════════════════
printf '\n== Founder A: live executions no longer receive node status cards ==\n'
reset_world
LIVE_EXECS='exec-live'
run_round; run_round
if [[ "$NEW_WS_CALLS" == 0 && ! -s "$NODE_LEDGER" && "$(registry_title exec-live)" == - \
      && ! -e "$NODE_STATUS_DIR" ]]; then
  ok "a running execution is represented only by its terminal mirror"
else
  bad "node card still created: creates=$NEW_WS_CALLS title=$(registry_title exec-live) ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] status_dir=$([[ -e $NODE_STATUS_DIR ]] && echo present || echo absent)"
fi

printf '\n== Founder A: an existing receipted node card is retired ==\n'
reset_world
LIVE_EXECS='exec-live'
printf 'workspace:61|node:legacy\n' > "$WS_FILE"
printf 'workspace:61|node:legacy\n' > "$SURFACE_FILE"
printf 'committed|generation-2829|workspace:61|exec-live|node:legacy\n' > "$NODE_LEDGER"
row exec-live node:legacy active-windowless "$NOW" > "$NODE_REGISTRY"
seed_status exec-live
saved_node_status_bin="$FLYWHEEL_CMUX_NODE_STATUS_BIN"
export FLYWHEEL_CMUX_NODE_STATUS_BIN="$SB/retired-node-status-helper"
run_round
export FLYWHEEL_CMUX_NODE_STATUS_BIN="$saved_node_status_bin"
if [[ ! -s "$WS_FILE" && ! -s "$NODE_LEDGER" && "$(registry_title exec-live)" == - \
      && ! -e "$(status_of exec-live)" ]]; then
  ok "the watcher closes the old node card without the retired helper and removes its status file"
else
  bad "legacy node card survived: ws=[$(cat "$WS_FILE")] ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] title=$(registry_title exec-live) status=$([[ -e $(status_of exec-live) ]] && echo present || echo absent)"
fi

printf '\n== Founder A hard boundary: a founder ~ workspace is never renamed or closed ==\n'
reset_world
LIVE_EXECS='exec-founder'
printf 'workspace:62|~\n' > "$WS_FILE"
printf 'workspace:62|node:founder\n' > "$SURFACE_FILE"
printf 'prepared|generation-2829|workspace:62|exec-founder|node:founder\n' > "$NODE_LEDGER"
row exec-founder node:founder active-windowless "$NOW" > "$NODE_REGISTRY"
run_round
if [[ "$(cat "$WS_FILE")" == 'workspace:62|~' \
      && "$(cat "$NODE_LEDGER")" == 'prepared|generation-2829|workspace:62|exec-founder|node:founder' \
      && "$CLOSE_CALLS" == 0 ]]; then
  ok "founder ~ remains byte-for-byte untouched despite stale node receipt"
else
  bad "founder ~ was mutated: ws=[$(cat "$WS_FILE")] ledger=[$(cat "$NODE_LEDGER")] close=$CLOSE_CALLS"
fi

printf '\n== Founder A: terminal execution with an already-absent tmux source closes its mirror ==\n'
reset_world
terminal_teardown_roster_still_exact_saved=$(declare -f terminal_teardown_roster_still_exact)
node_mirror_has_unique_execution_owner_saved=$(declare -f node_mirror_has_unique_execution_owner)
read_runner_tmux_node_inventory_saved=$(declare -f read_runner_tmux_node_inventory)
ledger_refs_for_title_saved=$(declare -f ledger_refs_for_title)
ledger_exact_receipt_state_saved=$(declare -f ledger_exact_receipt_state)
ledger_exact_receipt_uuid_saved=$(declare -f ledger_exact_receipt_uuid)
workspace_identity_matches_saved=$(declare -f workspace_identity_matches)
tmux_server_generation_saved=$(declare -f tmux_server_generation)
terminal_teardown_roster_still_exact() { return 0; }
node_mirror_has_unique_execution_owner() { return 0; }
read_runner_tmux_node_inventory() { RUNNER_NODE_TMUX_STATE=ok; RUNNER_NODE_TMUX_ROWS=""; return 0; }
tmux_server_generation() { printf 'tmux-generation-2829\n'; }
ledger_refs_for_title() { printf 'workspace:70\n'; }
ledger_exact_receipt_state() { printf 'committed\n'; }
ledger_exact_receipt_uuid() { printf '11111111-1111-4111-8111-111111111111\n'; }
workspace_identity_matches() { return 0; }
terminal_row='exec-ended|qa|FLY-2829|qa|completed|codex|2026-09-24 00:00:00|ended|2026-09-24 00:00:00|needs_review|1311|-'
for round in 1 2 3; do
  CMUX_ADDITIVE_ROUND_ID="2829-$round"
  terminal_teardown_observe exec-ended "$terminal_row" FLY-2829-qa-codex || true
done
if [[ "$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)" == 'FLY-2829-qa-codex' \
    && ! -s "$TERMINAL_TEARDOWN_STATE" ]]; then
  ok "three exact terminal rounds queue an already-absent source through the guarded mirror close path"
else
  bad "terminal mirror was not queued: marker=[$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)] state=[$(cat "$TERMINAL_TEARDOWN_STATE" 2>/dev/null)]"
fi
eval "$terminal_teardown_roster_still_exact_saved"
eval "$node_mirror_has_unique_execution_owner_saved"
eval "$read_runner_tmux_node_inventory_saved"
eval "$ledger_refs_for_title_saved"
eval "$ledger_exact_receipt_state_saved"
eval "$ledger_exact_receipt_uuid_saved"
eval "$workspace_identity_matches_saved"
eval "$tmux_server_generation_saved"

# ══════════════════════════════════════════════════════════════════════════
printf '\n== C1: ensure_node_workspace refuses non-authority titles before any cmux call ==\n'
reset_world
for bad_title in '-' '' 'Terminal 3' 'FLY-1-qa'; do
  NEW_WS_CALLS=0
  status_x=$(status_of exec-c1); mkdir -p "$(dirname "$status_x")"; printf 'x\n' > "$status_x"
  rc=0; ensure_node_workspace exec-c1 "$bad_title" "$status_x" || rc=$?
  if [[ "$rc" == 1 && "$NEW_WS_CALLS" == 0 && ! -s "$NODE_LEDGER" ]] \
     && grep -q 'node workspace refused: title is not a node authority title' "$LOG_FILE"; then
    ok "title [$bad_title] refused with zero cmux calls and an empty ledger"
  else
    bad "title [$bad_title] rc=$rc new_ws=$NEW_WS_CALLS ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)]"
  fi
done

printf '\n== Positive control: the pre-fix birth point reproduces unreceipted Terminal shells ==\n'
reset_world
begin_pass; begin_cmux_additive_round
# declare -f drops comments and reflows the guard into a 4-line block, so the
# block is cut by its opening test and closing brace, not by the comment.
eval "$(declare -f ensure_node_workspace \
  | sed '1s/^ensure_node_workspace/ensure_node_workspace_unguarded/; /"\$title" == node:\* \]\] || {/,/^ *};$/d')"
if declare -f ensure_node_workspace_unguarded | grep -q 'title is not a node authority title'; then
  bad "positive control could not remove the guard from the copied function"
fi
# The production incident row: admitted by the event path, title never minted.
row exec-unguarded - unresolved-summary "$OLD" "$OLD" 2 > "$NODE_REGISTRY"
status_u=$(status_of exec-unguarded); mkdir -p "$(dirname "$status_u")"; printf 'x\n' > "$status_u"
for _ in 1 2 3; do ensure_node_workspace_unguarded exec-unguarded - "$status_u" || true; done
if [[ "$(terminal_count)" == 3 && ! -s "$NODE_LEDGER" ]]; then
  ok "unguarded birth point mints 3 unreceipted Terminal shells (bug reproduced)"
else
  bad "positive control did not reproduce: terminals=$(terminal_count) ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)]"
fi
unset -f ensure_node_workspace_unguarded
reset_world
begin_pass; begin_cmux_additive_round
status_u=$(status_of exec-guarded); mkdir -p "$(dirname "$status_u")"; printf 'x\n' > "$status_u"
rcs=""
for _ in 1 2 3; do rc=0; ensure_node_workspace exec-guarded - "$status_u" || rc=$?; rcs+="$rc"; done
if [[ "$(ws_count)" == 0 && "$rcs" == 111 ]]; then
  ok "guarded function mints nothing for title - and returns 1 every time"
else
  bad "guarded function leaked: ws=$(ws_count) rcs=$rcs"
fi

printf '\n== Founder A: loop 1 keeps registry-only rows and never mints node titles ==\n'
reset_world
LIVE_EXECS=$'exec-x\nexec-y'
row exec-x - admitted "$NOW" > "$NODE_REGISTRY"
row exec-y - admitted "$NOW" >> "$NODE_REGISTRY"
ENSURED=""
eval "$(declare -f ensure_node_workspace | sed '1s/^ensure_node_workspace/ensure_node_workspace_real/')"
ensure_node_workspace() { ENSURED+="${ENSURED:+$'\n'}$1|$2"; return 0; }
run_round; run_round
tx=$(registry_title exec-x); ty=$(registry_title exec-y)
if [[ "$tx" == - && "$ty" == - && -z "$ENSURED" ]]; then
  ok "admitted rows remain registry-only and never enter the node create path"
else
  bad "node cards leaked: x=$tx y=$ty ensured=[$ENSURED]"
fi
if [[ "$(awk -F'|' '$1=="exec-x"{print $3}' "$NODE_REGISTRY")" == "FLY-exec-x-implement" ]]; then
  ok "alias is recomputed with node_display_alias alongside the minted title"
else
  bad "alias not recomputed: $(awk -F'|' '$1=="exec-x"{print $3}' "$NODE_REGISTRY")"
fi

printf '\n== C3: loop 2 never creates for rows outside the live roster ==\n'
reset_world
row exec-dead - admitted "$OLD" > "$NODE_REGISTRY"
row exec-term node:term admitted "$NOW" >> "$NODE_REGISTRY"
ENSURED=""
run_round; run_round
if [[ -z "$ENSURED" && "$(registry_state exec-term)" == unresolved-summary \
      && "$(registry_title exec-term)" == - && ! -e "$(status_of exec-term)" ]]; then
  ok "non-live rows remain internal summaries with no node card or status file"
else
  bad "loop 2 created or misclassified: ensured=[$ENSURED] state=$(registry_state exec-term)"
fi
if [[ "$NODE_SUMMARY_CREATE_POLICY" == never ]]; then
  ok "NODE_SUMMARY_CREATE_POLICY is the explicit never constant"
else
  bad "NODE_SUMMARY_CREATE_POLICY=$NODE_SUMMARY_CREATE_POLICY"
fi
# A committed summary tab is still reclaimed by TTL.
reset_world
printf 'workspace:7|node:ttl\n' > "$WS_FILE"; printf 'workspace:7|node:ttl\n' > "$SURFACE_FILE"
printf 'committed|generation-2829|workspace:7|exec-ttl|node:ttl\n' > "$NODE_LEDGER"
row exec-ttl node:ttl unresolved-summary "$OLD" "$OLD" 2 > "$NODE_REGISTRY"
seed_status exec-ttl
run_round
if [[ ! -s "$WS_FILE" && ! -s "$NODE_REGISTRY" && ! -e "$(status_of exec-ttl)" ]]; then
  ok "committed summary past TTL is still closed by gc_node_summary"
else
  bad "TTL gc regressed: ws=[$(cat "$WS_FILE")] reg=[$(cat "$NODE_REGISTRY")]"
fi
eval "$(declare -f ensure_node_workspace_real | sed '1s/^ensure_node_workspace_real/ensure_node_workspace/')"
unset -f ensure_node_workspace_real

printf '\n== C5: the maintenance marker is honored between rows of one round ==\n'
reset_world
LIVE_EXECS=$'exec-1\nexec-2\nexec-3\nexec-4\nexec-5'
UPSERTED_N=0
eval "$(declare -f node_registry_upsert_row | sed '1s/^node_registry_upsert_row/node_registry_upsert_row_real/')"
node_registry_upsert_row() {
  node_registry_upsert_row_real "$@" || return 1
  UPSERTED_N=$((UPSERTED_N + 1))
  [[ "$UPSERTED_N" == 2 ]] && touch "$FLYWHEEL_CMUX_MAINTENANCE_MARKER"
}
run_round watch
if [[ "$UPSERTED_N" == 2 && "$WATCHER_MAINTENANCE_STOP" == 1 ]] \
   && grep -q 'aborting remaining mutation at safe boundary' "$LOG_FILE"; then
  ok "marker placed mid-round stops after exactly 2 registry rows"
else
  bad "latch ignored: upserted=$UPSERTED_N stop=$WATCHER_MAINTENANCE_STOP"
fi
eval "$(declare -f node_registry_upsert_row_real | sed '1s/^node_registry_upsert_row_real/node_registry_upsert_row/')"
unset -f node_registry_upsert_row_real

# ══════════════════════════════════════════════════════════════════════════
# Recorder for the retired create path. Founder A requires every remaining
# registry/prune scenario below to prove that reconciliation never calls it.
eval "$(declare -f ensure_node_workspace | sed '1s/^ensure_node_workspace/ensure_node_workspace_real/')"
ENSURED=""; ENSURED_WS_AT_FIRST_CALL=""
ensure_node_workspace() {
  [[ -n "$ENSURED_WS_AT_FIRST_CALL" ]] || ENSURED_WS_AT_FIRST_CALL=$(ws_count)
  ENSURED+="${ENSURED:+$'\n'}$1|$2"; return 0
}
use_real_ensure() { eval "$(declare -f ensure_node_workspace_real | sed '1s/^ensure_node_workspace_real/ensure_node_workspace/')"; }
use_recorder_ensure() {
  ensure_node_workspace() {
    [[ -n "$ENSURED_WS_AT_FIRST_CALL" ]] || ENSURED_WS_AT_FIRST_CALL=$(ws_count)
    ENSURED+="${ENSURED:+$'\n'}$1|$2"; return 0
  }
}
# Fake clock: only `date +%s` is redirected, and only while FAKE_NOW is set.
FAKE_NOW=""
date() { if [[ "${1:-}" == "+%s" && -n "$FAKE_NOW" ]]; then printf '%s\n' "$FAKE_NOW"; else command date "$@"; fi; }
CLOSE_FAIL=0
eval "$(declare -f cmux_call_guarded | sed '1s/^cmux_call_guarded/cmux_call_guarded_model/')"
cmux_call_guarded() {
  if [[ "$2" == close-workspace && "$CLOSE_FAIL" == 1 ]]; then GUARD_WAS_BLOCKED=0; return 1; fi
  cmux_call_guarded_model "$@"
}

printf '\n== C4: round-start prune removes only stale, non-live, receipt-free rows ==\n'
reset_world; ENSURED=""
LIVE_EXECS="exec-live"
row exec-live node:live active-windowless "$OLD" > "$NODE_REGISTRY"
row exec-fresh node:fresh admitted "$NOW" >> "$NODE_REGISTRY"
row exec-stale - admitted "$OLD" >> "$NODE_REGISTRY"
seed_status exec-stale
run_round
if [[ -n "$(registry_state exec-live)" && -n "$(registry_state exec-fresh)" && -z "$(registry_state exec-stale)" \
      && ! -e "$(status_of exec-stale)" ]] \
   && grep -q '\[audit\] node prune exec=exec-stale title=- state=admitted age=[0-9]*s receipt=none' "$LOG_FILE"; then
  ok "three-row registry: only the stale receipt-free row is pruned, with an audit line"
else
  bad "prune selection wrong: live=$(registry_state exec-live) fresh=$(registry_state exec-fresh) stale=$(registry_state exec-stale)"
fi

printf '\n== C4: stale row with exactly one committed receipt is closed then removed ==\n'
reset_world; ENSURED=""
printf 'workspace:9|node:old\n' > "$WS_FILE"; printf 'workspace:9|node:old\n' > "$SURFACE_FILE"
printf 'committed|generation-2829|workspace:9|exec-old|node:old\n' > "$NODE_LEDGER"
row exec-old node:old active-windowless "$OLD" > "$NODE_REGISTRY"; seed_status exec-old
run_round
if [[ ! -s "$WS_FILE" && ! -s "$NODE_LEDGER" && ! -s "$NODE_REGISTRY" && ! -e "$(status_of exec-old)" ]] \
   && grep -q '\[audit\] node close exec=exec-old title=node:old ref=workspace:9 reason=retired-node-card' "$LOG_FILE" \
   && grep -q '\[audit\] node prune exec=exec-old .*receipt=none' "$LOG_FILE"; then
  ok "committed stale row: workspace closed, ledger/registry/status all cleared"
else
  bad "committed prune did not converge: ws=[$(cat "$WS_FILE")] ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] reg=[$(cat "$NODE_REGISTRY")]"
fi
reset_world; ENSURED=""
printf 'workspace:9|node:old\n' > "$WS_FILE"; printf 'workspace:9|node:old\n' > "$SURFACE_FILE"
printf 'committed|generation-2829|workspace:9|exec-old|node:old\n' > "$NODE_LEDGER"
row exec-old node:old active-windowless "$OLD" > "$NODE_REGISTRY"; seed_status exec-old
CLOSE_FAIL=1; run_round; CLOSE_FAIL=0
if [[ -s "$WS_FILE" && -s "$NODE_LEDGER" && -n "$(registry_state exec-old)" && -e "$(status_of exec-old)" ]] \
   && grep -q 'node prune deferred: close refused exec=exec-old' "$LOG_FILE"; then
  ok "failed close leaves workspace, ledger, registry and status untouched"
else
  bad "failed close mutated state: ws=[$(cat "$WS_FILE")] ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] reg=[$(cat "$NODE_REGISTRY")]"
fi

printf '\n== C4: prepared current cards retire; stale-generation receipts defer ==\n'
reset_world; ENSURED=""
printf 'workspace:11|Terminal 11\n' > "$WS_FILE"; printf 'workspace:11|node:prep\n' > "$SURFACE_FILE"
printf 'prepared|generation-2829|workspace:11|exec-prep|node:prep\n' > "$NODE_LEDGER"
row exec-prep node:prep admitted "$OLD" > "$NODE_REGISTRY"; seed_status exec-prep
run_round
if [[ -z "$(registry_state exec-prep)" && ! -e "$(status_of exec-prep)" && "$(ws_count)" == 0 \
      && ! -s "$NODE_LEDGER" ]]; then
  ok "prepared current-generation node card is retired without title migration"
else
  bad "prepared node card survived: reg=$(registry_state exec-prep) ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] ws=$(ws_count)"
fi
reset_world; ENSURED=""
printf 'workspace:12|node:oldgen\n' > "$WS_FILE"; printf 'workspace:12|node:oldgen\n' > "$SURFACE_FILE"
printf 'committed|generation-previous|workspace:12|exec-oldgen|node:oldgen\n' > "$NODE_LEDGER"
row exec-oldgen node:oldgen admitted "$OLD" > "$NODE_REGISTRY"; seed_status exec-oldgen
run_round
if [[ -n "$(registry_state exec-oldgen)" && "$(ws_count)" == 1 ]] \
   && grep -qxF 'committed|generation-previous|workspace:12|exec-oldgen|node:oldgen' "$NODE_LEDGER" \
   && grep -q 'node prune deferred: receipt pending exec=exec-oldgen' "$LOG_FILE"; then
  ok "stale-generation receipt whose ref still exists: zero mutation, deferred"
else
  bad "stale-generation receipt row was mutated: reg=$(registry_state exec-oldgen) ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)]"
fi

printf '\n== C4: liveness is re-read at the mutation boundary ==\n'
reset_world; ENSURED=""
row exec-race - admitted "$OLD" > "$NODE_REGISTRY"; seed_status exec-race
begin_pass; begin_cmux_additive_round; prime_roster
LIVE_EXECS="exec-race"   # turns live after the roster snapshot
reconcile_node_presence
seen=$(awk -F'|' '$1=="exec-race"{print $5}' "$NODE_REGISTRY")
if [[ -n "$seen" && "$seen" -ge "$NOW" && ! -e "$(status_of exec-race)" && "$(ws_count)" == 0 ]]; then
  ok "exec that became live after the snapshot is kept without recreating node status"
else
  bad "race lost: last_seen=$seen status=$([[ -e $(status_of exec-race) ]] && echo present || echo absent)"
fi
reset_world; ENSURED=""
row exec-blind - admitted "$OLD" > "$NODE_REGISTRY"; seed_status exec-blind
begin_pass; begin_cmux_additive_round; prime_roster
LIVE_FETCH_FAIL=1
reconcile_node_presence
LIVE_FETCH_FAIL=0
if [[ "$(awk -F'|' '$1=="exec-blind"{print $5}' "$NODE_REGISTRY")" == "$OLD" \
      && ! -e "$(status_of exec-blind)" && "$(registry_title exec-blind)" == - ]]; then
  ok "re-check fetch failure preserves liveness evidence while retiring node-status state"
else
  bad "blind re-check mutated: reg=[$(cat "$NODE_REGISTRY")]"
fi

printf '\n== C4: unreadable cmux JSON skips node: rows but still deletes - rows ==\n'
reset_world; ENSURED=""
row exec-j1 node:j1 admitted "$OLD" > "$NODE_REGISTRY"
row exec-j2 - admitted "$OLD" >> "$NODE_REGISTRY"
begin_pass; begin_cmux_additive_round; prime_roster
JSON_UNAVAILABLE=1
reconcile_node_presence
JSON_UNAVAILABLE=0
if [[ -n "$(registry_state exec-j1)" && -z "$(registry_state exec-j2)" ]]; then
  ok "node: row preserved under JSON outage; receipt-free - row pruned"
else
  bad "json outage handling wrong: j1=$(registry_state exec-j1) j2=$(registry_state exec-j2)"
fi
reset_world; ENSURED=""
printf 'workspace:13|node:dup\n' > "$WS_FILE"
row exec-dup node:dup admitted "$OLD" > "$NODE_REGISTRY"
run_round
if [[ -n "$(registry_state exec-dup)" && "$(ws_count)" == 1 ]] \
   && grep -q 'node prune deferred: unreceipted same-title workspace present exec=exec-dup' "$LOG_FILE"; then
  ok "an unreceipted same-title workspace blocks the direct delete"
else
  bad "same-title workspace did not block: reg=$(registry_state exec-dup)"
fi

printf '\n== C4: roster indeterminate → zero prune ==\n'
reset_world; ENSURED=""
row exec-ind - admitted "$OLD" > "$NODE_REGISTRY"
LIVE_FETCH_FAIL=1; run_round; LIVE_FETCH_FAIL=0
if [[ -n "$(registry_state exec-ind)" ]]; then ok "indeterminate roster prunes nothing"; else bad "pruned under indeterminate roster"; fi

printf '\n== C4: crash windows converge on later rounds ==\n'
# The seam kills the process in production; inside the test it is modelled as
# an immediate subshell exit with the SIGKILL status so the shared sandbox
# files are left exactly as a real kill would leave them.
crash_round() {
  ( node_prune_crash_point() { [[ "${FLYWHEEL_CMUX_PRUNE_CRASH_AT:-}" == "$1" ]] && exit 137; return 0; }
    export FLYWHEEL_CMUX_PRUNE_CRASH_AT="$1"; run_round >/dev/null 2>&1 )
}
for point in after-close-before-ledger-remove after-close after-status; do
  reset_world; ENSURED=""
  printf 'workspace:14|node:crash\n' > "$WS_FILE"; printf 'workspace:14|node:crash\n' > "$SURFACE_FILE"
  printf 'committed|generation-2829|workspace:14|exec-crash|node:crash\n' > "$NODE_LEDGER"
  row exec-crash node:crash admitted "$OLD" > "$NODE_REGISTRY"; seed_status exec-crash
  crash_rc=0; crash_round "$point" || crash_rc=$?
  FAKE_NOW="$NOW"
  for _ in 1 2 3 4 5; do FAKE_NOW=$((FAKE_NOW + 200)); run_round; done
  FAKE_NOW=""
  expected_rc=137; [[ "$point" == after-close ]] && expected_rc=0
  if [[ "$crash_rc" == "$expected_rc" && ! -s "$WS_FILE" && ! -s "$NODE_LEDGER" && -z "$(registry_state exec-crash)" && ! -e "$(status_of exec-crash)" ]]; then
    ok "crash at $point: later rounds clear workspace, ledger, registry and status"
  else
    bad "crash at $point did not converge: rc=$crash_rc ws=[$(cat "$WS_FILE")] ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] reg=[$(cat "$NODE_REGISTRY" 2>/dev/null)]"
  fi
done

printf '\n== C4: one-time backup before a bulk prune, never overwritten ==\n'
reset_world; ENSURED=""
: > "$NODE_REGISTRY"
i=1; while (( i <= 101 )); do row "exec-b$i" - admitted "$OLD" >> "$NODE_REGISTRY"; i=$((i + 1)); done
before_sum=$(shasum "$NODE_REGISTRY" | cut -d' ' -f1)
run_round
backup="${NODE_REGISTRY}.pre-FLY-2829"
if [[ -f "$backup" && "$(shasum "$backup" | cut -d' ' -f1)" == "$before_sum" && ! -s "$NODE_REGISTRY" ]]; then
  ok "101 stale rows: backup is byte-identical to the pre-prune registry and all rows pruned"
else
  bad "backup wrong: exists=$([[ -f $backup ]] && echo yes || echo no) remaining=$(grep -c . "$NODE_REGISTRY")"
fi
i=1; while (( i <= 101 )); do row "exec-c$i" - admitted "$OLD" >> "$NODE_REGISTRY"; i=$((i + 1)); done
run_round
if [[ "$(shasum "$backup" | cut -d' ' -f1)" == "$before_sum" && ! -s "$NODE_REGISTRY" ]]; then
  ok "second bulk prune does not overwrite the backup"
else
  bad "backup was overwritten or second prune incomplete"
fi

printf '\n== C4: batch cap of %s rows per round ==\n' "$PRUNE_BATCH_MAX"
reset_world; ENSURED=""
: > "$NODE_REGISTRY"
i=1; while (( i <= 220 )); do row "exec-k$i" - admitted "$OLD" >> "$NODE_REGISTRY"; i=$((i + 1)); done
run_round; after1=$(grep -c . "$NODE_REGISTRY")
run_round; after2=$(grep -c . "$NODE_REGISTRY" || true)
if [[ "$after1" == 20 && "$after2" == 0 ]] && grep -q 'node prune round candidates=220 pruned=200 ' "$LOG_FILE"; then
  ok "220 stale rows drain as 200 then 20 across two rounds"
else
  bad "batch cap wrong: $after1 $after2"
fi

printf '\n== C4: legacy summaries retire before the registry cap runs ==\n'
reset_world; ENSURED=""; ENSURED_WS_AT_FIRST_CALL=""
LIVE_EXECS="exec-probe"
: > "$NODE_REGISTRY"
i=1; while (( i <= 31 )); do
  printf 'workspace:%s|node:s%s\n' "$((100 + i))" "$i" >> "$WS_FILE"; printf 'workspace:%s|node:s%s\n' "$((100 + i))" "$i" >> "$SURFACE_FILE"
  printf 'committed|generation-2829|workspace:%s|exec-s%s|node:s%s\n' "$((100 + i))" "$i" "$i" >> "$NODE_LEDGER"
  row "exec-s$i" "node:s$i" unresolved-summary "$NOW" "$((NOW - i))" 2 >> "$NODE_REGISTRY"
  seed_status "exec-s$i"
  i=$((i + 1))
done
run_round
if [[ "$(ws_count)" == 0 && ! -s "$NODE_LEDGER" && -z "$ENSURED_WS_AT_FIRST_CALL" ]]; then
  ok "31 legacy node cards are all retired and no replacement is created"
else
  bad "legacy cards survived: workspaces=$(ws_count) ledger=$(grep -c . "$NODE_LEDGER" 2>/dev/null || true) create_call=$ENSURED_WS_AT_FIRST_CALL"
fi
reset_world; ENSURED=""
: > "$NODE_REGISTRY"
i=1; while (( i <= 31 )); do row "exec-f$i" "node:f$i" active-windowless "$NOW" 0 1 >> "$NODE_REGISTRY"; i=$((i + 1)); done
run_round
summaries=$(awk -F'|' '$4=="unresolved-summary"{n++} END{print n+0}' "$NODE_REGISTRY")
if (( summaries <= 30 )) && (( summaries >= 29 )); then
  ok "summaries minted by loop 2 in the same round are capped at round end ($summaries)"
else
  bad "round-end cap wrong: $summaries summaries remain"
fi

printf '\n== C4-b: committed-absent and prepared-absent receipts are GC'"'"'d after %s determinate passes ==\n' "$FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES"
for kind in committed prepared; do
  reset_world; ENSURED=""
  printf '%s|generation-2829|workspace:40|exec-ab|node:ab\n' "$kind" > "$NODE_LEDGER"
  FAKE_NOW="$NOW"
  rounds=0; while [[ -s "$NODE_LEDGER" && "$rounds" -lt 8 ]]; do FAKE_NOW=$((FAKE_NOW + 200)); run_round; rounds=$((rounds + 1)); done
  FAKE_NOW=""
  if [[ ! -s "$NODE_LEDGER" && "$rounds" == 4 && "$NEW_WS_CALLS" == 0 && "$CLOSE_CALLS" == 0 ]] \
     && ! grep -q '^node-absent|' "$PREPARED_STALL_STATE" 2>/dev/null \
     && grep -q '\[audit\] node ledger absent-gc generation=generation-2829 ref=workspace:40' "$LOG_FILE"; then
    ok "$kind-absent receipt removed on pass $rounds with zero workspace mutation and a clean sidecar"
  else
    bad "$kind-absent did not converge: rounds=$rounds ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] stall=[$(cat "$PREPARED_STALL_STATE" 2>/dev/null)] new=$NEW_WS_CALLS close=$CLOSE_CALLS"
  fi
done

printf '\n== C4-b: a ref that reappears clears its absent evidence ==\n'
reset_world; ENSURED=""
printf 'committed|generation-2829|workspace:41|exec-back|node:back\n' > "$NODE_LEDGER"
FAKE_NOW="$NOW"
FAKE_NOW=$((FAKE_NOW + 200)); run_round
FAKE_NOW=$((FAKE_NOW + 200)); run_round
had_evidence=0; grep -q '^node-absent|generation-2829|workspace:41|' "$PREPARED_STALL_STATE" && had_evidence=1
printf 'workspace:41|node:back\n' > "$WS_FILE"; printf 'workspace:41|node:back\n' > "$SURFACE_FILE"
FAKE_NOW=$((FAKE_NOW + 200)); run_round
FAKE_NOW=""
if [[ "$had_evidence" == 1 && ! -s "$NODE_LEDGER" && ! -s "$WS_FILE" ]] \
   && ! grep -q '^node-absent|' "$PREPARED_STALL_STATE"; then
  ok "reappearing legacy node card is retired and zeroes the absent sidecar"
else
  bad "reappear handling wrong: evidence=$had_evidence ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] stall=[$(cat "$PREPARED_STALL_STATE" 2>/dev/null)]"
fi

printf '\n== C4-b: drift alerts once, re-arms evidence, and never renames or closes ==\n'
drift_case() {
  local label="$1" kind="$2" ws_title="$3" surface_title="$4" alerts stall_count state_valid
  reset_world; ENSURED=""
  printf 'workspace:42|%s\n' "$ws_title" > "$WS_FILE"; printf 'workspace:42|%s\n' "$surface_title" > "$SURFACE_FILE"
  printf '%s|generation-2829|workspace:42|exec-dr|node:dr\n' "$kind" > "$NODE_LEDGER"
  row exec-dr node:dr admitted "$NOW" > "$NODE_REGISTRY"; seed_status exec-dr
  FAKE_NOW="$NOW"
  for _ in 1 2 3 4 5 6 7 8; do FAKE_NOW=$((FAKE_NOW + 200)); run_round; done
  alerts=$(grep -c 'node-receipt-drift' "$ALERT_LOG" 2>/dev/null || true)
  stall_count=$(awk -F'|' '$1 == "node-drift" && $2 == "generation-2829" && $3 == "workspace:42" { print $5 }' "$PREPARED_STALL_STATE" 2>/dev/null)
  state_valid=0; _prepared_stall_state_valid && state_valid=1
  FAKE_NOW=""
  if [[ "$alerts" == 1 && "$(cat "$WS_FILE")" == "workspace:42|$ws_title" && "$(cat "$SURFACE_FILE")" == "workspace:42|$surface_title" ]] \
     && grep -qxF "$kind|generation-2829|workspace:42|exec-dr|node:dr" "$NODE_LEDGER" && [[ "$CLOSE_CALLS" == 0 && "$state_valid" == 1 ]] \
     && { [[ -z "$stall_count" ]] || (( 10#$stall_count < 10#$FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES )); }; then
    ok "$label: one drift alert, evidence re-armed, receipt kept, titles untouched"
  else
    bad "$label: alerts=$alerts stall=$stall_count state_valid=$state_valid ws=[$(cat "$WS_FILE")] surface=[$(cat "$SURFACE_FILE")] ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)] close=$CLOSE_CALLS"
  fi
}
drift_case "committed drift (workspace renamed)" committed "founder renamed me" "node:dr"
drift_case "prepared drift (workspace renamed)" prepared "founder renamed me" "node:dr"
drift_case "prepared drift (surface-only rename)" prepared "node:dr" "my custom tab"

printf '\n== C4-b: stale-generation absent receipt is removed immediately ==\n'
reset_world; ENSURED=""
printf 'committed|generation-previous|workspace:43|exec-og|node:og\n' > "$NODE_LEDGER"
run_round
if [[ ! -s "$NODE_LEDGER" ]]; then ok "old-generation absent ref removed on the first round"; else bad "old-generation row survived: $(cat "$NODE_LEDGER")"; fi

printf '\n== C4-b: ensure_node_workspace declines a committed-absent receipt without removing it ==\n'
reset_world
printf 'committed|generation-2829|workspace:44|exec-ca|node:ca\n' > "$NODE_LEDGER"
row exec-ca node:ca admitted "$NOW" > "$NODE_REGISTRY"
begin_pass; begin_cmux_additive_round
status_ca=$(status_of exec-ca); mkdir -p "$(dirname "$status_ca")"; printf 'x\n' > "$status_ca"
rc=0; ensure_node_workspace_real exec-ca node:ca "$status_ca" || rc=$?
if [[ "$rc" == 1 && "$NEW_WS_CALLS" == 0 ]] && grep -qxF 'committed|generation-2829|workspace:44|exec-ca|node:ca' "$NODE_LEDGER"; then
  ok "committed-absent: rc=1, no create, receipt left for the round-start reconciler"
else
  bad "committed-absent branch regressed: rc=$rc new=$NEW_WS_CALLS ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)]"
fi

printf '\n== C4-b: orphan node-absent/node-drift sidecar rows are swept against the node ledger ==\n'
reset_world
printf 'committed|generation-2829|workspace:45|exec-keep|node:keep\n' > "$NODE_LEDGER"
printf 'node-absent|generation-2829|workspace:45|node:keep|1|%s|1-1\n' "$NOW" > "$PREPARED_STALL_STATE"
printf 'node-drift|generation-2829|workspace:46|node:gone|2|%s|1-1\n' "$NOW" >> "$PREPARED_STALL_STATE"
printf 'absent|generation-2829|workspace:47|view-gone|1|%s|1-1\n' "$NOW" >> "$PREPARED_STALL_STATE"
_prepared_stall_sweep_orphans generation-2829 || true
if grep -q '^node-absent|generation-2829|workspace:45|' "$PREPARED_STALL_STATE" \
   && ! grep -q '^node-drift|' "$PREPARED_STALL_STATE" && ! grep -q '^absent|' "$PREPARED_STALL_STATE"; then
  ok "live node evidence kept; orphan node and view evidence swept"
else
  bad "sweep wrong: $(cat "$PREPARED_STALL_STATE")"
fi

use_real_ensure

printf '\n== C6: GNU stat probes do not contaminate owner or socket identity ==\n'
stat() {
  case "${1:-}" in
    -f) printf '  File: "%s"\nBlock size: 4096\n' "${3:-unknown}"; return 1 ;;
    -c)
      case "${2:-}" in
        %u) printf '%s\n' "$(id -u)" ;;
        %d:%i:%W) printf '11:22:33\n' ;;
        *) return 1 ;;
      esac
      return 0
      ;;
    *) return 1 ;;
  esac
}
owner_uid=$(_create_ledger_owner_uid "$WS_FILE")
CMUX_SOCKET_PATH="$WS_FILE"
socket_identity=$(cmux_socket_identity_real)
CMUX_SOCKET_PATH="$SB/cmux.sock"
unset -f stat
if [[ "$owner_uid" == "$(id -u)" && "$socket_identity" == 11:22:33 ]]; then
  ok "GNU stat failure output is discarded from owner and socket identities"
else
  bad "GNU stat failure contaminated identity: owner=[$owner_uid] socket=[$socket_identity]"
fi

stat() { return 1; }
if missing_identity_output=$(
    set -e
    CMUX_SOCKET_PATH="$SB/missing-socket"
    missing_identity=$(cmux_socket_identity_real)
    printf 'survived:%s\n' "$missing_identity"
  ); then
  missing_identity_rc=0
else
  missing_identity_rc=$?
fi
unset -f stat
if [[ "$missing_identity_rc" == 0 && "$missing_identity_output" == survived: ]]; then
  ok "an unreadable socket returns empty without tripping an errexit caller"
else
  bad "unreadable socket killed an errexit caller: rc=$missing_identity_rc output=[$missing_identity_output]"
fi

# ══════════════════════════════════════════════════════════════════════════
printf '\n== C6: per-pass budget from the rolling burst window ==\n'
reset_world
LIVE_EXECS=""; i=1; while (( i <= 25 )); do LIVE_EXECS+="${LIVE_EXECS:+$'\n'}exec-n$i"; i=$((i + 1)); done
run_round
created=$(grep -c '\[audit\] node create ' "$LOG_FILE" || true)
refused=$(grep -c 'workspace create refused by gate kind=node' "$LOG_FILE" || true)
if [[ "$created" == 0 && "$refused" == 0 && ! -e "$NODE_CREATE_LEDGER" && "$(ws_count)" == 0 ]] \
   && [[ "$(awk -F'|' '$1 ~ /^exec-n[0-9]+$/ && $2 == "-" {n++} END{print n+0}' "$NODE_REGISTRY")" == 25 ]]; then
  ok "25 live nodes consume no create budget and remain registry-only"
else
  bad "node cards consumed create budget: created=$created refused=$refused ledger=$([[ -e $NODE_CREATE_LEDGER ]] && echo present || echo absent) ws=$(ws_count)"
fi
: > "$LOG_FILE"
run_round
if [[ "$(grep -c '\[audit\] node create ' "$LOG_FILE" || true)" == 0 && "$(ws_count)" == 0 \
      && ! -e "$NODE_CREATE_LEDGER" ]]; then
  ok "a second pass still creates no node cards"
else
  bad "second pass recreated node cards: ws=$(ws_count)"
fi

printf '\n== C6: budget boundaries (59/149 → 1, 150 → 0 + alert) ==\n'
ledger_line() { printf '%s|%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5" "$6"; }
reset_world; : > "$NODE_CREATE_LEDGER"
i=1; while (( i <= 59 )); do ledger_line $((NOW - 100)) view "v$i" "workspace:$i" 1-1 created >> "$NODE_CREATE_LEDGER"; i=$((i + 1)); done
begin_pass; workspace_create_gate_begin || true
if [[ "$CREATE_GATE_STATE" == open && "$CREATE_BUDGET_LEFT" == 1 && "$CREATE_NODE_RESERVE" == 1 && "$CREATE_VIEW_CAP" == 0 ]]; then
  ok "59 rows in the 600s window → budget 1, reserve 1, view cap 0"
else
  bad "59-row boundary: state=$CREATE_GATE_STATE budget=$CREATE_BUDGET_LEFT reserve=$CREATE_NODE_RESERVE viewcap=$CREATE_VIEW_CAP"
fi
reset_world
i=1; while (( i <= 149 )); do printf 'workspace:%s|w%s\n' "$i" "$i" >> "$WS_FILE"; i=$((i + 1)); done
begin_pass; workspace_create_gate_begin || true
if [[ "$CREATE_GATE_STATE" == open && "$CREATE_BUDGET_LEFT" == 1 ]]; then ok "149 workspaces → budget 1"; else bad "149 boundary: state=$CREATE_GATE_STATE budget=$CREATE_BUDGET_LEFT"; fi
printf 'workspace:150|w150\n' >> "$WS_FILE"
begin_pass; workspace_create_gate_begin || true
if [[ "$CREATE_GATE_STATE" == ceiling && "$CREATE_BUDGET_LEFT" == 0 ]] && grep -q 'workspace-ceiling|generation=generation-2829|ceiling=150' "$ALERT_LOG"; then
  ok "150 workspaces → ceiling state, budget 0, one alert with the generation in its signature"
else
  bad "150 boundary: state=$CREATE_GATE_STATE budget=$CREATE_BUDGET_LEFT alerts=[$(cat "$ALERT_LOG" 2>/dev/null)]"
fi

printf '\n== C6: 60 rows in the long window latch the process; the latch is operator-owned ==\n'
reset_world; : > "$NODE_CREATE_LEDGER"
i=1; while (( i <= 60 )); do ledger_line $((NOW - 100)) node "n$i" - 1-1 reserved >> "$NODE_CREATE_LEDGER"; i=$((i + 1)); done
LIVE_EXECS="exec-latched"
run_round
alerts=$(grep -c 'workspace-create-runaway' "$ALERT_LOG" || true)
if [[ -f "$NODE_RUNAWAY_LATCH" && "$alerts" == 1 && "$(ws_count)" == 0 && "$CREATE_GATE_STATE" == latched ]] \
   && grep -q '^runawayv1|[0-9]*|60|600|[0-9]*$' "$NODE_RUNAWAY_LATCH" \
   && grep -q 'flywheel-cmux-sync --probe-lease' "$ALERT_LOG"; then
  ok "window over budget: latch written, one alert carrying the recovery procedure, zero creates"
else
  bad "latch wrong: latch=$([[ -f $NODE_RUNAWAY_LATCH ]] && cat "$NODE_RUNAWAY_LATCH" || echo absent) alerts=$alerts ws=$(ws_count) state=$CREATE_GATE_STATE"
fi
run_round
if [[ "$(grep -c 'workspace-create-runaway' "$ALERT_LOG" || true)" == 1 && "$(ws_count)" == 0 ]]; then
  ok "an existing latch does not re-alert"
else
  bad "latched pass re-alerted or created: alerts=$(grep -c 'workspace-create-runaway' "$ALERT_LOG") ws=$(ws_count)"
fi
rm -f "$NODE_RUNAWAY_LATCH"
run_round
if [[ -f "$NODE_RUNAWAY_LATCH" && "$(ws_count)" == 0 ]]; then
  ok "removing the latch while the ledger is still over budget re-latches immediately"
else
  bad "rm latch alone reopened creation: latch=$([[ -f $NODE_RUNAWAY_LATCH ]] && echo present || echo absent) ws=$(ws_count)"
fi
rm -f "$NODE_RUNAWAY_LATCH"; : > "$NODE_CREATE_LEDGER"
begin_pass; workspace_create_gate_begin || true
if [[ ! -f "$NODE_RUNAWAY_LATCH" && "$CREATE_GATE_STATE" == open && "$CREATE_BUDGET_LEFT" == 20 ]]; then
  ok "latch removed after the ledger is truncated → generic create gate reopens"
else
  bad "procedure did not reopen the gate: latch=$([[ -f $NODE_RUNAWAY_LATCH ]] && echo present || echo absent) state=$CREATE_GATE_STATE budget=$CREATE_BUDGET_LEFT"
fi

printf '\n== C6: a reservation is durable before cmux is called ==\n'
reset_world
crash_rc=0
( CREATE_KILL_SELF=1; node_prune_crash_point() { return 0; }
  begin_pass; begin_cmux_additive_round; workspace_create_gate_begin || true
  _GUARD_CREATE_GENERATION=generation-2829
  cmux_call_guarded() {
    local guard="$1" command="$2"; shift 2
    GUARD_WAS_BLOCKED=0; "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
    [[ "$command" == new-workspace ]] && exit 137
    cmux_call_guarded_model "$guard" "$command" "$@"
  }
  reserved_new_workspace _create_generation_guard view crash-view -- --command noop >/dev/null 2>&1 ) || crash_rc=$?
reserved_rows=$(awk -F'|' '$2=="view" && $3=="crash-view" && $4=="-" && $6=="reserved"{n++} END{print n+0}' "$NODE_CREATE_LEDGER")
CREATE_GATE_PASS=""; CREATE_GATE_STATE=uninitialized; WATCHER_PASS_SEQ=""   # a fresh process
begin_pass; workspace_create_gate_begin || true
if [[ "$crash_rc" == 137 && "$reserved_rows" == 1 && "$CREATE_BUDGET_LEFT" == 19 ]]; then
  ok "crash inside new-workspace leaves a reserved row that a restarted process counts (budget 19)"
else
  bad "reservation not durable: rc=$crash_rc reserved=$reserved_rows budget=$CREATE_BUDGET_LEFT ledger=[$(cat "$NODE_CREATE_LEDGER" 2>/dev/null)]"
fi
reset_world
begin_pass; begin_cmux_additive_round; workspace_create_gate_begin || true
always_block() { return 1; }
rc=0; reserved_new_workspace always_block view blocked-view -- --command noop || rc=$?
if [[ "$rc" == 1 && "$GUARD_WAS_BLOCKED" == 1 && ! -s "$NODE_CREATE_LEDGER" && "$CREATE_BUDGET_LEFT" == 20 && "$NEW_WS_CALLS" == 0 ]]; then
  ok "a guard block cancels the reservation: ledger empty, budget unchanged"
else
  bad "guard block accounting: rc=$rc blocked=$GUARD_WAS_BLOCKED ledger=[$(cat "$NODE_CREATE_LEDGER" 2>/dev/null)] budget=$CREATE_BUDGET_LEFT"
fi

printf '\n== C6: rows older than 24h are trimmed before counting ==\n'
reset_world; : > "$NODE_CREATE_LEDGER"
i=1; while (( i <= 59 )); do ledger_line $((NOW - 100)) view "v$i" "workspace:$i" 1-1 created >> "$NODE_CREATE_LEDGER"; i=$((i + 1)); done
ledger_line $((NOW - 90000)) view old1 workspace:901 1-1 created >> "$NODE_CREATE_LEDGER"
ledger_line $((NOW - 90001)) node old2 - - reserved >> "$NODE_CREATE_LEDGER"
begin_pass; workspace_create_gate_begin || true
if [[ "$(grep -c . "$NODE_CREATE_LEDGER")" == 59 && "$CREATE_GATE_STATE" == open && ! -e "$NODE_RUNAWAY_LATCH" ]]; then
  ok "61 rows with 2 older than 24h → 59 kept, not latched"
else
  bad "trim wrong: rows=$(grep -c . "$NODE_CREATE_LEDGER") state=$CREATE_GATE_STATE"
fi

printf '\n== C6: malformed ledger, symlink latch, foreign owner → fail-closed ==\n'
reset_world
printf 'bad|row|here\n' > "$NODE_CREATE_LEDGER"
LIVE_EXECS="exec-mal"
run_round; run_round
if [[ "$(ws_count)" == 0 && "$CREATE_GATE_STATE" == fail-closed && "$(grep -c 'create-ledger-malformed' "$ALERT_LOG" || true)" == 1 ]] \
   && [[ "$(cat "$NODE_CREATE_LEDGER")" == 'bad|row|here' ]]; then
  ok "3-column ledger row: zero creation, one alert, ledger not rewritten"
else
  bad "malformed ledger: ws=$(ws_count) state=$CREATE_GATE_STATE alerts=$(grep -c 'create-ledger-malformed' "$ALERT_LOG") ledger=[$(cat "$NODE_CREATE_LEDGER")]"
fi
reset_world
ln -s /nonexistent "$NODE_RUNAWAY_LATCH"
LIVE_EXECS="exec-sym"
run_round
if [[ "$(ws_count)" == 0 && "$CREATE_GATE_STATE" == latched ]]; then ok "a symlink latch still latches"; else bad "symlink latch ignored: ws=$(ws_count) state=$CREATE_GATE_STATE"; fi
rm -f "$NODE_RUNAWAY_LATCH"
reset_world
ledger_line $((NOW - 100)) view v1 workspace:1 1-1 created > "$NODE_CREATE_LEDGER"
eval "$(declare -f _create_ledger_owner_uid | sed '1s/^_create_ledger_owner_uid/_create_ledger_owner_uid_real/')"
_create_ledger_owner_uid() { printf '%s\n' "$(( $(id -u) + 1 ))"; }
begin_pass; workspace_create_gate_begin || true
owner_state="$CREATE_GATE_STATE"
eval "$(declare -f _create_ledger_owner_uid_real | sed '1s/^_create_ledger_owner_uid_real/_create_ledger_owner_uid/')"
unset -f _create_ledger_owner_uid_real
if [[ "$owner_state" == fail-closed ]] && grep -q 'create-ledger-malformed' "$ALERT_LOG"; then
  ok "a ledger owned by another uid fails closed"
else
  bad "foreign owner accepted: state=$owner_state"
fi

printf '\n== C6: every pass entry has a sequence; no sequence → refuse ==\n'
reset_world
WATCHER_PASS_SEQ=""
if ! workspace_create_admitted node && [[ "$WORKSPACE_CREATE_REFUSED" == 1 ]]; then ok "empty WATCHER_PASS_SEQ refuses"; else bad "empty pass seq admitted a create"; fi
WATCHER_PASS_SEQ=""; MUTATOR_LEASE_MODE=""; WATCHER_PASS_ACTIVE=0
mutator_lease_owned_by_self() { return 1; }
watcher_begin_pass || true
seq_watch="$WATCHER_PASS_SEQ"
mutator_lease_owned_by_self() { return 0; }
# This assertion is about pass sequencing, not the host process-table proof
# used to mint a real lease. Keep the unrelated lease boundary hermetic: a
# restricted runner may correctly deny `ps -o lstart`, which makes production
# lease acquisition fail closed before the probe can observe the sequence.
eval "$(declare -f acquire_mutator_lease | sed '1s/^acquire_mutator_lease/acquire_mutator_lease_real/')"
acquire_mutator_lease() { MUTATOR_LEASE_MODE="$1"; return 0; }
ONCE_SEQ=""
once_probe() { ONCE_SEQ="$WATCHER_PASS_SEQ"; }
run_mutator_once once once_probe || true
eval "$(declare -f acquire_mutator_lease_real | sed '1s/^acquire_mutator_lease_real/acquire_mutator_lease/')"
unset -f acquire_mutator_lease_real
if [[ "$seq_watch" == 1 && "$ONCE_SEQ" == 2 ]] \
   && declare -f run_rebuild_views | grep -q 'WATCHER_PASS_SEQ=' ; then
  ok "watcher_begin_pass, run_mutator_once and run_rebuild_views each advance the pass sequence"
else
  bad "pass sequence wiring: watch=$seq_watch once=$ONCE_SEQ"
fi
MUTATOR_LEASE_MODE=""; MUTATOR_LEASE_NONCE=""; MUTATOR_LEASE_INCARNATION=""
reset_world
touch "$NODE_RUNAWAY_LATCH"
begin_pass
rc=0; reserved_new_workspace _create_generation_guard view lead-title -- --command 'x' || rc=$?
if [[ "$rc" == 1 && "$WORKSPACE_CREATE_REFUSED" == 1 && "$NEW_WS_CALLS" == 0 ]]; then
  ok "the shared wrapper refuses a view create under the latch (v2 Lead / view path)"
else
  bad "wrapper under latch: rc=$rc refused=$WORKSPACE_CREATE_REFUSED new=$NEW_WS_CALLS"
fi
reset_world
begin_pass; CMUX_ADDITIVE_ROUND_ID=""
workspace_create_gate_begin || true
workspace_create_reserve view rebuild-title || true
if grep -q '|view|rebuild-title|-|-|reserved$' "$NODE_CREATE_LEDGER" && _create_ledger_valid; then
  begin_pass; workspace_create_gate_begin || true
  if [[ "$CREATE_GATE_STATE" == open && "$CREATE_BUDGET_LEFT" == 19 ]]; then
    ok "a rebuild/event-drain reservation with round - is legal and counted by the next pass"
  else
    bad "round - row broke the next pass: state=$CREATE_GATE_STATE budget=$CREATE_BUDGET_LEFT"
  fi
else
  bad "round - reservation not written or invalid: $(cat "$NODE_CREATE_LEDGER" 2>/dev/null)"
fi

printf '\n== C6: fairness — views are capped, nodes keep a reserve, across passes ==\n'
reset_world
fair_ok=1
for pass_i in 1 2 3; do
  [[ -f "$NODE_CREATE_LEDGER" ]] && { awk -F'|' -v OFS='|' '{$1=$1-61; print}' "$NODE_CREATE_LEDGER" > "$NODE_CREATE_LEDGER.shift" && mv "$NODE_CREATE_LEDGER.shift" "$NODE_CREATE_LEDGER"; }
  begin_pass; begin_cmux_additive_round
  views=0; nodes=0
  i=1; while (( i <= 30 )); do
    if workspace_create_admitted view; then workspace_create_reserve view "view-$pass_i-$i"; views=$((views + 1)); fi
    i=$((i + 1))
  done
  i=1; while (( i <= 5 )); do
    if workspace_create_admitted node; then workspace_create_reserve node "node-$pass_i-$i"; nodes=$((nodes + 1)); fi
    i=$((i + 1))
  done
  (( views <= 18 && nodes >= 2 && views + nodes <= 20 )) || { fair_ok=0; bad "pass $pass_i: views=$views nodes=$nodes"; }
done
[[ "$fair_ok" == 1 ]] && ok "3 passes × (30 views + 5 nodes): views ≤ 18, nodes ≥ 2, total ≤ 20 each pass"

printf '\n== C6: static guard — exactly one guarded new-workspace, inside reserved_new_workspace ==\n'
SRC="$ROOT/scripts/flywheel-cmux-sync.sh"
hits=$(grep -cE 'cmux_call_guarded +"?\$?[A-Za-z_]+"? +new-workspace' "$SRC")
inside=$(awk '
  /^reserved_new_workspace\(\)/ { infn=1 }
  infn && /cmux_call_guarded +"?\$?[A-Za-z_]+"? +new-workspace/ { n++ }
  infn && /^}/ { infn=0 }
  END { print n+0 }' "$SRC")
if [[ "$hits" == 1 && "$inside" == 1 ]]; then
  ok "one guarded new-workspace spawn in the file and it lives in reserved_new_workspace"
else
  bad "chokepoint drift: total=$hits inside_wrapper=$inside"
fi
wrapped=$(grep -cE '^\s*reserved_new_workspace +_(node_workspace|create_generation|v2_lead_workspace)_guard' "$SRC")
if [[ "$wrapped" == 3 ]]; then ok "the three create paths call the wrapper"; else bad "expected 3 wrapper call sites, found $wrapped"; fi

printf '\nFLY-2829 node registry: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
