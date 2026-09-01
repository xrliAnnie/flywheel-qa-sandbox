#!/usr/bin/env bash
set -uo pipefail

ROOT=$(mktemp -d /tmp/fly2207-cleanup.XXXXXX)
trap 'rm -rf "$ROOT"' EXIT
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=../flywheel-cmux-sync.sh
source "$REPO_ROOT/scripts/flywheel-cmux-sync.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1" >&2; }

NODE_REGISTRY="$ROOT/node-registry"
NODE_LEDGER="$ROOT/node-ledger"
VIEW_LEDGER="$ROOT/view-ledger"
CLEANUP_SNAPSHOT="$ROOT/cleanup-snapshot"
CLEANUP_SNAPSHOT_EPISODE_STATE="$ROOT/cleanup-snapshot-episode"
CLEANUP_PENDING="$ROOT/cleanup-pending"
TERMINAL_TEARDOWN_STATE="$ROOT/terminal-teardown"
CLOSE_REQUEST_FILE="$ROOT/close-request"
: > "$NODE_REGISTRY"
: > "$NODE_LEDGER"
: > "$VIEW_LEDGER"

cmux_socket_identity() { printf 'cmux-generation\n'; }
node_registry_valid() { return 0; }
node_workspace_ready() { return 0; }
ALERTS=""
_alert_cmux_cleanup() {
  ALERTS+="${ALERTS:+$'\n'}$1|$2|$3"
}

printf 'Test: complete cleanup snapshots advance by the authoritative tuple\n'
date() { [[ "${1:-}" == '+%s' ]] && printf '100\n' || command date "$@"; }
CMUX_ADDITIVE_ROUND_ID=100-1
node_write_cleanup_snapshot
first=$(head -1 "$CLEANUP_SNAPSHOT")
CMUX_ADDITIVE_ROUND_ID=100-2
node_write_cleanup_snapshot
second=$(head -1 "$CLEANUP_SNAPSHOT")
CMUX_ADDITIVE_ROUND_ID=100-1
if ! node_write_cleanup_snapshot 2>/dev/null && [[ "$(head -1 "$CLEANUP_SNAPSHOT")" == "$second" ]] \
    && [[ "$first" != "$second" ]]; then
  pass 'an older tuple is refused without replacing the last valid snapshot'
else
  fail 'snapshot tuple did not advance strictly'
fi
unset -f date

printf 'Test: linked viewer rows collapse to one exact runner source identity\n'
INVENTORY_MODE=linked
tmux() {
  [[ "$1" == list-windows ]] || return 1
  if [[ "$INVENTORY_MODE" == linked ]]; then
    printf 'runner-fly-2207\t@7\tFLY-2207-runner\texec-2207\ncmux-FLY-2207-runner\t@7\tFLY-2207-runner\texec-2207\n'
  else
    printf 'runner-fly-2207\t@7\tFLY-2207-runner\texec-2207\nrunner-retry\t@8\tFLY-2207-runner\texec-2207\n'
  fi
}
read_runner_tmux_node_inventory
linked_inventory="$RUNNER_NODE_TMUX_ROWS"
INVENTORY_MODE=duplicate
read_runner_tmux_node_inventory
duplicate_inventory="$RUNNER_NODE_TMUX_ROWS"
if [[ "$linked_inventory" == 'exec-2207|present|@7|FLY-2207-runner|runner-fly-2207' \
    && "$duplicate_inventory" == 'exec-2207|indeterminate|-|-|-' ]]; then
  pass 'linked view is not mistaken for a second source; true source duplicates refuse'
else
  fail "source inventory linked=[$linked_inventory] duplicate=[$duplicate_inventory]"
fi
unset -f tmux

printf 'Test: terminal teardown requires one registry owner for the mirror title\n'
printf 'exec-2207|node:a|a|terminal-summary|1|1-1|0|0|2|1|FLY-2207-runner|1-1|1\n' > "$NODE_REGISTRY"
single_owner=0; node_mirror_has_unique_execution_owner exec-2207 FLY-2207-runner || single_owner=$?
printf 'exec-other|node:b|b|active-windowed|1|1-1|2|0|0|0|FLY-2207-runner|1-1|0\n' >> "$NODE_REGISTRY"
duplicate_owner=0; node_mirror_has_unique_execution_owner exec-2207 FLY-2207-runner || duplicate_owner=$?
if [[ "$single_owner" == 0 && "$duplicate_owner" != 0 ]]; then
  pass 'a second execution mapped to the title removes teardown authority'
else
  fail "registry ownership single=$single_owner duplicate=$duplicate_owner"
fi
printf 'exec-2207|node:a|a|terminal-summary|1|1-1|0|0|2|1|FLY-2207-runner|1-1|1\n' > "$NODE_REGISTRY"

printf 'Test: failed snapshot publication uses the existing cleanup alert route\n'
node_write_cleanup_snapshot() { return 1; }
ALERTS=""
if ! node_publish_cleanup_snapshot && [[ "$ALERTS" == *'cleanup snapshot publish failed'* ]]; then
  pass 'publication failure is visible instead of swallowed'
else
  fail 'publication failure was not alerted'
fi
unset -f node_write_cleanup_snapshot

printf 'Test: blocked cleanup alerts once per no-progress episode and rearms on progress\n'
printf 'snapshot|200|1|200|complete\n' > "$CLEANUP_SNAPSHOT"
FAKE_NOW=90000
date() { [[ "${1:-}" == '+%s' ]] && printf '%s\n' "$FAKE_NOW" || command date "$@"; }
ALERTS=""
cleanup_snapshot_stall_observe 2 1
cleanup_snapshot_stall_observe 2 1
first_alerts=$(printf '%s\n' "$ALERTS" | grep -c 'cleanup snapshot progress stalled' || true)
printf 'snapshot|200|2|90001|complete\n' > "$CLEANUP_SNAPSHOT"
cleanup_snapshot_stall_observe 0 0
FAKE_NOW=180002
cleanup_snapshot_stall_observe 1 90001
second_alerts=$(printf '%s\n' "$ALERTS" | grep -c 'cleanup snapshot progress stalled' || true)
if [[ "$first_alerts" == 1 && "$second_alerts" == 2 ]]; then
  pass 'persistent dedupe alerts once and valid tuple progress rearms it'
else
  fail "stall episode alert counts were $first_alerts then $second_alerts"
fi
unset -f date

printf 'Test: exact terminal evidence tears down a live lingering source on round three\n'
EXEC_ID='exec-2207'
TERMINAL_ROW="$EXEC_ID|node-1|FLY-2207|implement|completed|codex|-|done|-|needs_review|1|-"
RUNNER_EXPECTED_STATE=ok
RUNNER_ACTIVE_ROWS=""
RUNNER_TERMINAL_STATE=ok
RUNNER_TERMINAL_ROWS="$TERMINAL_ROW"
RUNNER_NODE_TMUX_STATE=ok
RUNNER_NODE_TMUX_ROWS="$EXEC_ID|present|@7|FLY-2207-runner|runner-fly-2207"
FLYWHEEL_CMUX_TMUX_GENERATION='tmux-generation'
VIEW_UUID='11111111-1111-4111-8111-111111111111'
SOURCE_GONE=0
KILLS=0
fetch_active_runner_roster() { RUNNER_EXPECTED_STATE=ok; RUNNER_ACTIVE_ROWS=""; }
fetch_recent_terminal_runner_roster() { RUNNER_TERMINAL_STATE=ok; RUNNER_TERMINAL_ROWS="$TERMINAL_ROW"; }
read_runner_tmux_node_inventory() {
  RUNNER_NODE_TMUX_STATE=ok
  if [[ "$SOURCE_GONE" == 1 ]]; then
    RUNNER_NODE_TMUX_ROWS=""
  else
    RUNNER_NODE_TMUX_ROWS="$EXEC_ID|present|@7|FLY-2207-runner|runner-fly-2207"
  fi
}
ledger_refs_for_title() { printf 'workspace:7\n'; }
ledger_exact_receipt_state() { printf 'committed\n'; }
ledger_exact_receipt_uuid() { printf '%s\n' "$VIEW_UUID"; }
workspace_identity_matches() { return 0; }
watcher_mutation_latch_clear() { return 0; }
tmux() {
  case "$1" in
    display-message)
      [[ "$SOURCE_GONE" == 0 ]] || return 1
      printf 'runner-fly-2207|@7|FLY-2207-runner|exec-2207|0\n'
      ;;
    kill-window)
      KILLS=$((KILLS + 1)); SOURCE_GONE=1
      ;;
    list-windows)
      [[ "$SOURCE_GONE" == 1 ]] && return 0
      printf 'runner-fly-2207|@7|FLY-2207-runner|exec-2207\n'
      ;;
    *) return 1 ;;
  esac
}

for sequence in 1 2 3; do
  CMUX_ADDITIVE_ROUND_ID="300-$sequence"
  terminal_teardown_observe "$EXEC_ID" "$TERMINAL_ROW" 'FLY-2207-runner'
done
if [[ "$KILLS" == 1 && "$SOURCE_GONE" == 1 \
    && "$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)" == 'FLY-2207-runner' ]]; then
  pass 'pane_dead=0 does not cancel terminal teardown; exact source and marker complete'
else
  fail "terminal transaction kills=$KILLS source_gone=$SOURCE_GONE marker=$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null || true)"
fi

WORKSPACE_GONE=0
workspace_refs_for() { printf 'workspace:7\n'; }
close_orphan_workspace_pin_if_still_orphan() { WORKSPACE_GONE=1; return 0; }
cmux_call() { return 0; }
process_close_requests
if [[ "$WORKSPACE_GONE" == 1 && ! -e "$CLOSE_REQUEST_FILE" ]]; then
  pass 'the ordinary close-request path removes the exact terminal workspace'
else
  fail 'terminal source teardown did not converge through the ordinary workspace close path'
fi

printf 'Test: crash gap after source teardown replays the close marker\n'
rm -f "$CLOSE_REQUEST_FILE"
printf 'terminalv1|%s|%s|3|400-3|source-closed|FLY-2207-runner|-|-|-|-|-|-\n' \
  "$EXEC_ID" "$(_cmux_alert_hash "$TERMINAL_ROW")" > "$TERMINAL_TEARDOWN_STATE"
CMUX_ADDITIVE_ROUND_ID=400-4
terminal_teardown_observe "$EXEC_ID" "$TERMINAL_ROW" 'FLY-2207-runner'
if [[ "$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)" == 'FLY-2207-runner' \
    && ! -s "$TERMINAL_TEARDOWN_STATE" ]]; then
  pass 'durable source-closed episode closes the crash gap on the next scan'
else
  fail 'source-closed episode did not replay the marker'
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
