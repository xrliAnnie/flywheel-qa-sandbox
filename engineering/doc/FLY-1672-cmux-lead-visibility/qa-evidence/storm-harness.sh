#!/bin/bash
# FLY-1672 independent QA — real-tmux storm harness.
#
# Runs the REAL product drain path (real flywheel-cmux-sync.sh, real tmux on a
# PRIVATE socket) against a synthetic backlog of create events that point at
# windows which no longer exist, plus one control row pointing at a window that
# is genuinely alive.
#
# Only the `cmux` CLI is shimmed (recorder) — creating hundreds of real
# workspaces in the founder's cmux would be destructive. Every liveness decision
# under test is made by REAL tmux.
#
# Usage: storm-harness.sh <path-to-cmux-sync.sh> <label> <stale-count>
set -uo pipefail

SCRIPT_UNDER_TEST="$1"
LABEL="$2"
STALE_COUNT="${3:-200}"

ROOT=$(mktemp -d "/tmp/fly1672-qa-${LABEL}.XXXXXX")
SOCK="$ROOT/tmux.sock"
QA_SESSION="runner-fly1672qa"
OPS_FILE="$ROOT/cmux-ops.log"
: > "$OPS_FILE"

cleanup() {
  command tmux -S "$SOCK" kill-server 2>/dev/null || true
}
trap cleanup EXIT

# ---- isolated state (never touches production watcher state) ----
export EVENT_FILE="$ROOT/events"
export CLEANUP_PENDING="$ROOT/cleanup-pending"
export STALE_STATE="$ROOT/stale.state"
export HEAL_STATE="$ROOT/heal.state"
export CREATE_STATE="$ROOT/create.state"
export CMUX_SOCK_IDENT_FILE="$ROOT/sock-ident"
export ORPHAN_PIN_STATE="$ROOT/orphan-pin.state"
export ADOPTION_STATE="$ROOT/adoption.state"
export FLYWHEEL_CMUX_CLOSE_REQUEST_FILE="$ROOT/close-requested"
export HUSK_STATE="$ROOT/husk.state"
export VIEW_WAL_DIR="$ROOT/view-wal"
export VIEW_LEDGER="$ROOT/view-ledger"
export KEEPER_INVENTORY="$ROOT/keeper-inventory"
export RESTORED_STATE="$ROOT/restored-adoption"
export VIEW_ABSENT_STATE="$ROOT/view-absent.state"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$ROOT/cmux-maintenance"
export FLYWHEEL_CMUX_REBUILD_REPORT_DIR="$ROOT/cmux-rebuild-reports"
export CMUX_FLAG_STATE="$ROOT/cmux-flag-state"
export LEDGER_CONFLICT_STATE="$ROOT/ledger-conflict.state"
export ROSTER_EPISODE_STATE="$ROOT/roster-episodes.state"
export CMUX_LOG_EPISODE_STATE="$ROOT/cmux-log-episodes.state"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$ROOT/watcher.lock"
export FLYWHEEL_CMUX_ALERT_BIN="/usr/bin/true"
export FLYWHEEL_LEAD_PLIST_DIR="$ROOT/lead-plists"
export FLYWHEEL_MANIFEST_DIR="$ROOT/manifests"
mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
LOG_CAPTURE="$ROOT/watcher.log"

# A real AF_UNIX socket so cmux_socket_identity/-present behave normally
# against an ISOLATED path instead of the founder's live cmux socket.
export CMUX_SOCKET_PATH="$ROOT/cmux.sock"
python3 - "$CMUX_SOCKET_PATH" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
PY

# ---- real tmux fixture on a private socket ----
command tmux -S "$SOCK" -f /dev/null new-session -d -s "$QA_SESSION" -n FLY1672QA-live-control 'sleep 900' 2>/dev/null
LIVE_ID=$(command tmux -S "$SOCK" display-message -p -t "=${QA_SESSION}:FLY1672QA-live-control" '#{window_id}')

# Create then kill N windows so their ids are genuinely vanished — exactly the
# production shape (windows that existed when the hook fired, gone by drain).
STALE_IDS=""
i=1
while [[ "$i" -le "$STALE_COUNT" ]]; do
  wid=$(command tmux -S "$SOCK" new-window -d -P -F '#{window_id}' \
    -t "=${QA_SESSION}:" -n "FLY1672QA-stale-$i" 'sleep 900' 2>/dev/null)
  command tmux -S "$SOCK" kill-window -t "=${QA_SESSION}:${wid}" 2>/dev/null
  STALE_IDS="${STALE_IDS}${wid} "
  i=$((i + 1))
done

# The live window must be the session's current window so the vanished-id
# fallback lands on a LIVE pane — the exact production trap (@1362 zsh).
command tmux -S "$SOCK" select-window -t "=${QA_SESSION}:${LIVE_ID}" 2>/dev/null
ACTIVE_AFTER=$(command tmux -S "$SOCK" display-message -p -t "=${QA_SESSION}" '#{window_id}|#{pane_dead}')

# ---- seed the backlog: N stale rows + 1 live control row ----
: > "$EVENT_FILE"
i=1
for wid in $STALE_IDS; do
  printf 'create|%s|%s|FLY1672QA-stale-%s\n' "$QA_SESSION" "$wid" "$i" >> "$EVENT_FILE"
  i=$((i + 1))
done
printf 'create|%s|%s|FLY1672QA-live-control\n' "$QA_SESSION" "$LIVE_ID" >> "$EVENT_FILE"
SEEDED=$(grep -c '' "$EVENT_FILE")

# ---- source the product script (BASH_SOURCE guard prevents main dispatch) ----
# shellcheck disable=SC1090
. "$SCRIPT_UNDER_TEST"

# ---- boundary shims: real tmux on the private socket, recorded cmux ----
tmux() { command tmux -S "$SOCK" -N "$@"; }
cmux() {
  printf '%s\n' "$*" >> "$OPS_FILE"
  [[ "${1:-}" == "--socket" ]] && shift 2
  local json=0
  [[ "${1:-}" == "--json" ]] && { json=1; shift; }
  case "${1:-}" in
    list-workspaces)
      if [[ "$json" == 1 ]]; then echo '{"workspaces":[]}'; else echo ""; fi ;;
    new-workspace) echo "workspace:9999" ;;
    list-surfaces) echo "" ;;
    *) return 0 ;;
  esac
}
START=$(date +%s)
drain_events >/dev/null 2>"$LOG_CAPTURE"
END=$(date +%s)

STALE_CREATE_LOGS=$(grep -c 'Creating workspace for: FLY1672QA-stale-' "$LOG_CAPTURE" 2>/dev/null || true)
LIVE_CREATE_LOGS=$(grep -c 'Creating workspace for: FLY1672QA-live-control' "$LOG_CAPTURE" 2>/dev/null || true)
STALE_NEW_WS=$(grep 'new-workspace' "$OPS_FILE" 2>/dev/null | grep -c 'FLY1672QA-stale-' || true)
LIVE_NEW_WS=$(grep 'new-workspace' "$OPS_FILE" 2>/dev/null | grep -c 'FLY1672QA-live-control' || true)
TOTAL_CMUX_OPS=$(grep -c '' "$OPS_FILE" 2>/dev/null || true)
LEFTOVER=0
[[ -e "${EVENT_FILE}.processing" ]] && LEFTOVER=1

cat <<EOF
=== FLY-1672 storm harness :: ${LABEL} ===
script_under_test   : ${SCRIPT_UNDER_TEST}
tmux_version        : $(command tmux -V)
seeded_event_rows   : ${SEEDED} (${STALE_COUNT} vanished + 1 live control)
session_current_win : ${ACTIVE_AFTER}   <- what a vanished id falls back to
live_control_id     : ${LIVE_ID}
drain_wall_seconds  : $((END - START))
creates_logged_stale: ${STALE_CREATE_LOGS}     <- MUST be 0
creates_logged_live : ${LIVE_CREATE_LOGS}     <- MUST be 1
cmux new-workspace stale: ${STALE_NEW_WS}   <- MUST be 0
cmux new-workspace live : ${LIVE_NEW_WS}   <- MUST be 1
total_cmux_ops      : ${TOTAL_CMUX_OPS}
processing_leftover : ${LEFTOVER}   <- MUST be 0 (batch fully consumed)
evidence_dir        : ${ROOT}
EOF
