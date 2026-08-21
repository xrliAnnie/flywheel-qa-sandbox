#!/bin/bash
# FLY-1884: execution-scoped cmux node presence and cleanup-fence regressions.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly1884-node-XXXXXX)"
trap 'rm -rf "$SB"' EXIT

export FLYWHEEL_CMUX_NODE_PRESENCE=1
export NODE_LEDGER="$SB/node-ledger"
export NODE_REGISTRY="$SB/node-registry"
export NODE_STATUS_DIR="$SB/status"
export CLEANUP_SNAPSHOT="$SB/cleanup-snapshot"
export CLEANUP_PENDING="$SB/cleanup-pending"
export VIEW_LEDGER="$SB/view-ledger"
export CMUX_ADDITIVE_ROUND_STATE="$SB/round"
export FLYWHEEL_CMUX_NODE_STATUS_BIN="$ROOT/scripts/flywheel-node-status.sh"
export FLYWHEEL_CMUX_ALERT_BIN=/usr/bin/true

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"

pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

title_a="$(node_allocate_authority_title exec-alpha FLY-1884 qa)"
title_b="$(node_allocate_authority_title exec-beta FLY-1884 qa)"
if [[ "$title_a" == node:* && "$title_b" == node:* && "$title_a" != "$title_b" ]]; then
  ok "execution identity produces distinct node titles"
else
  bad "node titles must be distinct: a=$title_a b=$title_b"
fi

printf 'exec-alpha|%s|FLY-1884-qa|active-windowless|1|1-1|0|2|0|0|-|1-1|0\n' "$title_a" > "$NODE_REGISTRY"
if [[ "$(node_allocate_authority_title exec-alpha renamed implement)" == "$title_a" ]]; then
  ok "authority title stays stable after display metadata changes"
else
  bad "authority title drifted after registration"
fi

if [[ "$(node_status_label completed terminal-summary claude-tmux)" == "已结束" ]]; then
  ok "terminal summary uses the founder-visible completed label"
else
  bad "terminal summary was mislabeled as an active windowless node"
fi
if [[ "$(node_status_label last-known unresolved-summary claude-tmux)" == "失联 · 无法确认终态" ]]; then
  ok "unresolved summaries do not claim terminal completion"
else
  bad "unresolved summary was not visibly distinguished"
fi

live_json='{"count":2,"sessions":[{"execution_id":"pending-exec","status":"pending"},{"execution_id":"design-exec","status":"design_done"}]}'
if [[ "$(printf '%s' "$live_json" | _parse_runner_roster_json live | wc -l | tr -d ' ')" == 2 ]]; then
  ok "pending and design_done are accepted by the live roster parser"
else
  bad "live roster parser dropped a non-terminal workflow state"
fi

marker_epoch=100
printf 'snapshot|100|2|101|complete\n' > "$CLEANUP_SNAPSHOT"
if node_cleanup_freshness_allows FLY-1884-qa-codex "$marker_epoch" 100 1; then
  ok "newer complete empty snapshot authorizes negative cleanup"
else
  bad "complete negative snapshot should authorize cleanup"
fi
printf 'snapshot|100|2|101|complete\nprotected|FLY-1884-qa-codex|exec-alpha\n' > "$CLEANUP_SNAPSHOT"
if node_cleanup_freshness_allows FLY-1884-qa-codex "$marker_epoch" 100 1; then
  bad "protected title crossed cleanup fence"
else
  ok "protected title blocks cleanup"
fi
printf 'broken\n' > "$CLEANUP_SNAPSHOT"
if node_cleanup_freshness_allows never-seen "$marker_epoch" 100 1; then
  bad "malformed snapshot authorized cleanup"
else
  ok "malformed snapshot fails closed"
fi

# Exercise the real node receipt/create/default-title recovery/close path with
# a minimal mutation-faithful cmux model. New workspaces intentionally start as
# `Terminal 52`, matching the production rename-lag incident.
WS_FILE="$SB/workspaces"; SURFACE_FILE="$SB/surfaces"; : > "$WS_FILE"; : > "$SURFACE_FILE"
assert_or_reuse_owned_lease() { return 0; }
cmux_socket_identity() { printf 'generation-node-test\n'; }
tmux() {
  [[ "$1" == display-message ]] || return 1
  printf '@77|FLY-1884-qa-codex|exec-short-lived\n'
}
get_cmux_workspaces_json() {
  python3 - "$WS_FILE" <<'PY'
import json,sys
rows=[]
for raw in open(sys.argv[1], encoding="utf-8"):
    ref,title=raw.rstrip("\n").split("|",1)
    rows.append({"ref":ref,"title":title})
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
      printf 'workspace:52|Terminal 52\n' >> "$WS_FILE"
      printf 'workspace:52|%s\n' "$2" >> "$SURFACE_FILE"
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
      for tmp in "$WS_FILE" "$SURFACE_FILE"; do
        awk -F'|' -v r="$ref" '$1!=r {print}' "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp"
      done
      ;;
    *) return 1 ;;
  esac
}
if admit_node_identity_for_window runner-flywheel @77 FLY-1884-qa-codex \
   && grep -q '^exec-short-lived|-|-|admitted|.*|FLY-1884-qa-codex|' "$NODE_REGISTRY"; then
  ok "event path admits exact execution identity before cmux mutation"
else
  bad "short-lived event identity was not durably admitted"
fi
status_a="$(node_status_path exec-alpha)"; mkdir -p "$(dirname "$status_a")"; printf 'ready\n' > "$status_a"
if ensure_node_workspace exec-alpha "$title_a" "$status_a" \
   && [[ "$(cat "$WS_FILE")" == "workspace:52|$title_a" ]] \
   && [[ "$(cat "$SURFACE_FILE")" == "workspace:52|$title_a" ]] \
   && grep -qxF "committed|generation-node-test|workspace:52|exec-alpha|$title_a" "$NODE_LEDGER"; then
  ok "default Terminal title is retried and committed under exact node receipt"
else
  bad "node workspace did not recover default title: ws=[$(cat "$WS_FILE")] ledger=[$(cat "$NODE_LEDGER" 2>/dev/null)]"
fi
printf 'workspace:52|shell changed its title\n' > "$SURFACE_FILE"
if node_workspace_ready exec-alpha "$title_a"; then
  ok "committed node authority tolerates a dynamic surface title"
else
  bad "dynamic surface title incorrectly invalidated committed node authority"
fi
printf 'workspace:52|%s\n' "$title_a" > "$SURFACE_FILE"
printf 'exec-alpha|%s|FLY-1884-qa|active-windowless|1|100-2|0|2|0|0|FLY-1884-qa-codex|100-2|0\n' "$title_a" > "$NODE_REGISTRY"
printf 'snapshot|100|3|102|complete\n' > "$CLEANUP_SNAPSHOT"
if node_cleanup_freshness_allows FLY-1884-qa-codex 101 100 2; then
  ok "committed placeholder releases the dead mirror cleanup fence"
else
  bad "ready placeholder did not release mirror cleanup"
fi
printf 'exec-alpha|%s|FLY-1884-qa|active-windowed|1|100-2|2|0|0|0|FLY-1884-qa-codex|100-2|0\n' "$title_a" > "$NODE_REGISTRY"
if node_cleanup_freshness_allows FLY-1884-qa-codex 101 100 2; then
  bad "active-windowed execution authorized mirror cleanup"
else
  ok "active-windowed execution stays protected until placeholder takeover"
fi
if close_node_workspace exec-alpha "$title_a" superseded-by-mirror \
   && [[ ! -s "$WS_FILE" && ! -s "$NODE_LEDGER" ]]; then
  ok "exact committed node surface closes only after mirror supersede state"
else
  bad "guarded node close did not converge"
fi

RUNNER_EXPECTED_STATE=ok
RUNNER_NODE_TMUX_STATE=ok
RUNNER_TERMINAL_STATE=ok
RUNNER_TERMINAL_ROWS=""
RUNNER_NODE_TMUX_ROWS=""
RUNNER_ACTIVE_ROWS=""
i=1
while [[ "$i" -le 31 ]]; do
  RUNNER_ACTIVE_ROWS+="${RUNNER_ACTIVE_ROWS:+$'\n'}exec-$i|implement|FLY-$i|implement|running|remote-control|2026-08-20 00:00:00|node $i|2026-08-20 00:00:00|-|-|-"
  i=$((i + 1))
done
ENSURED=""
ensure_node_workspace() { ENSURED+="${ENSURED:+$'\n'}$1|$2"; return 0; }
node_mirror_surface_ready() { return 1; }
close_node_workspace() { return 0; }

printf 'missing-exec|node:missing|FLY-missing|active-windowless|1|1-1|0|2|0|0|-|1-1|0\n' > "$NODE_REGISTRY"
mutator_lease_owned_by_self() { return 0; }
begin_cmux_additive_round
round_one="$CMUX_ADDITIVE_ROUND_ID"
reconcile_node_presence
begin_cmux_additive_round
round_two="$CMUX_ADDITIVE_ROUND_ID"
reconcile_node_presence
if [[ "$round_one" == *-* && "$round_two" == *-* && "$round_one" != "$round_two" ]]; then
  ok "production additive rounds expose epoch-sequence identities"
else
  bad "additive rounds did not produce distinct production identities: $round_one $round_two"
fi
missing_status="$(node_status_path missing-exec)"
if [[ "$(awk -F'|' '$1 == "missing-exec" {print $4}' "$NODE_REGISTRY")" == unresolved-summary ]] \
   && grep -q '^状态: 失联 · 无法确认终态$' "$missing_status"; then
  ok "two complete negative rounds retain a visible unresolved summary"
else
  bad "missing execution was silently removed or falsely marked terminal"
fi
: > "$NODE_REGISTRY"

CMUX_ADDITIVE_ROUND_ID="$round_one"
reconcile_node_presence
CMUX_ADDITIVE_ROUND_ID="$round_two"
reconcile_node_presence
if [[ "$(printf '%s\n' "$ENSURED" | awk -F'|' '$1 ~ /^exec-[0-9]+$/ && !seen[$1]++ {n++} END {print n+0}')" == 31 ]]; then
  ok "all 31 active windowless nodes receive individual surfaces"
else
  bad "active-node cap swallowed a surface"
fi

: > "$CLEANUP_PENDING"
CMUX_ADDITIVE_ROUND_ID="$round_two"
mark_for_cleanup FLY-1884-qa-codex 100
IFS='-' read -r round_epoch round_sequence <<< "$round_two"
if grep -qxF "FLY-1884-qa-codex|100|$round_epoch|$round_sequence" "$CLEANUP_PENDING"; then
  ok "cleanup marker stores round epoch and sequence separately"
else
  bad "cleanup marker did not preserve the production round identity"
fi

if node_write_cleanup_snapshot \
   && grep -q "^snapshot|$round_epoch|$round_sequence|[0-9][0-9]*|complete$" "$CLEANUP_SNAPSHOT"; then
  ok "cleanup snapshot stores round epoch and sequence separately"
else
  bad "cleanup snapshot rejected the production round identity"
fi

DISMANTLED=""; DRAIN_FAIL=0
watcher_mutation_latch_clear() { return 0; }
is_pane_alive() { return 1; }
dismantle_view_display() { DISMANTLED+="${DISMANTLED:+$'\n'}$1"; return 0; }
drain_stale_state_row() { [[ "$DRAIN_FAIL" == 0 ]]; }
process_pending_cleanups || true
if [[ "$DISMANTLED" == FLY-1884-qa-codex && ! -e "$CLEANUP_PENDING" ]]; then
  ok "default-on cleanup consumes the production marker and dismantles its view"
else
  bad "default-on cleanup dropped or refused the production marker"
fi

FLYWHEEL_CMUX_NODE_PRESENCE=0
DISMANTLED=""; mark_for_cleanup control-off 100; process_pending_cleanups || true
if [[ "$DISMANTLED" == control-off && ! -e "$CLEANUP_PENDING" ]]; then
  ok "node-presence-off cleanup control still dismantles its view"
else
  bad "node-presence-off cleanup control regressed"
fi

FLYWHEEL_CMUX_NODE_PRESENCE=1
DRAIN_FAIL=1; : > "$CLEANUP_PENDING"; CMUX_ADDITIVE_ROUND_ID="$round_two"
mark_for_cleanup retry-on-refusal 100
process_pending_cleanups || true
if grep -q '^retry-on-refusal|' "$CLEANUP_PENDING"; then
  ok "downstream cleanup refusal preserves its pending marker"
else
  bad "downstream cleanup refusal silently consumed its pending marker"
fi

printf '\nFLY-1884 node presence: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
