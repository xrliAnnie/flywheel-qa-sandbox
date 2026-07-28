#!/bin/bash
# Pin down WHY _lead_body_wait_stage reports sensor-failure (rc=2) on a sweep
# that actually succeeds. Overrides the library's documented test seams to log
# every alive/lstart observation. Throwaway QA label only.
set -uo pipefail
ART="$HOME/.flywheel/qa-artifacts/FLY-1507"
SB="$ART/sandbox"; H="$SB/home"; SOCKET="$SB/s.sock"
PROJECT=fly1507qa; LEAD=drill-lead; WINDOW="${PROJECT}-${LEAD}"
LABEL="com.flywheel.lead.${PROJECT}-${LEAD}"; TARGET="gui/$(id -u)/$LABEL"
PLIST="$H/Library/LaunchAgents/${LABEL}.plist"
PIDFILE="$H/.flywheel/pids/${PROJECT}-${LEAD}.pid"
ARCHIVE="$H/.flywheel/pids/${PROJECT}-${LEAD}.claude.tmux"
W=/Users/xiaorongli/Dev/flywheel-FLY-1507
T=/usr/local/bin/tmux
export FLYWHEEL_TMUX_SOCKET_OVERRIDE="$SOCKET"
ROUNDS="${1:-5}"

# shellcheck disable=SC1091
source "$W/packages/teamlead/scripts/lib/lead-identity-preflight.sh"
# shellcheck disable=SC1091
source "$W/packages/teamlead/scripts/lib/tmux-supervisor-guard.sh"
# shellcheck disable=SC1091
source "$W/scripts/lib/lead-body-sweep.sh"

TRACE="$SB/sensor-trace.log"
lead_body_process_alive() {
  if kill -0 "$1" 2>/dev/null; then echo "alive($1)=yes" >> "$TRACE"; return 0; fi
  echo "alive($1)=no" >> "$TRACE"; return 1
}
lead_body_process_start_identity() {
  local out; out="$(LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  echo "lstart($1)='${out}' state=$(ps -p "$1" -o state= 2>/dev/null | tr -d ' ')" >> "$TRACE"
  printf '%s' "$out"
}

cleanup() { launchctl bootout "$TARGET" >/dev/null 2>&1 || true; $T -S "$SOCKET" kill-server >/dev/null 2>&1 || true; }
trap cleanup EXIT

two=0
for round in $(seq 1 "$ROUNDS"); do
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  $T -S "$SOCKET" kill-server >/dev/null 2>&1 || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1
  BODY=""
  for i in $(seq 1 60); do
    BODY=$($T -S "$SOCKET" list-panes -s -t '=flywheel' -F '#{window_name} #{pane_pid} #{pane_dead}' 2>/dev/null | awk -v w="$WINDOW" '$1==w && $3=="0"{print $2;exit}')
    [ -n "$BODY" ] && break; sleep 0.5
  done
  kill -KILL "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || true
  sleep 1
  TF="$SB/race.targets"
  lead_body_collect_targets "$PROJECT" "$LEAD" claude-code "$ARCHIVE" "$TF" >/dev/null 2>&1
  : > "$TRACE"
  r=0
  lead_body_terminate "$TF" "$LEAD" "$ARCHIVE" || r=$?
  alive_after=$(kill -0 "$BODY" 2>/dev/null && echo YES || echo no)
  [ "$r" = "2" ] && two=$((two+1))
  echo "round $round: body=$BODY terminate_rc=$r orphan_alive_after=$alive_after"
  echo "        trace: $(tr '\n' ' ' < "$TRACE" | cut -c1-200)"
done
echo
echo "terminate_rc==2 in $two / $ROUNDS rounds (rc=2 makes restart_lead report the Lead FAILED)"
