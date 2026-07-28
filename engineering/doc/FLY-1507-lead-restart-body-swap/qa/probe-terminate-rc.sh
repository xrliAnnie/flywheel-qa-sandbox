#!/bin/bash
# Why does lead_body_terminate return 2 on the orphan scenario even though the
# orphan is really killed? Instrument each sub-step. Throwaway QA label only.
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

# shellcheck disable=SC1091
source "$W/packages/teamlead/scripts/lib/lead-identity-preflight.sh"
# shellcheck disable=SC1091
source "$W/packages/teamlead/scripts/lib/tmux-supervisor-guard.sh"
# shellcheck disable=SC1091
source "$W/scripts/lib/lead-body-sweep.sh"

cleanup() { launchctl bootout "$TARGET" >/dev/null 2>&1 || true; $T -S "$SOCKET" kill-server >/dev/null 2>&1 || true; }
trap cleanup EXIT

launchctl bootout "$TARGET" >/dev/null 2>&1 || true
$T -S "$SOCKET" kill-server >/dev/null 2>&1 || true
sed -i '' 's/"resolvedModel":"[^"]*"/"resolvedModel":"claude-opus-4-8[1m]"/' "$H/.flywheel/manifests/${PROJECT}-${LEAD}.json"
launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1
for i in $(seq 1 60); do
  BODY=$($T -S "$SOCKET" list-panes -s -t '=flywheel' -F '#{window_name} #{pane_pid} #{pane_dead}' 2>/dev/null | awk -v w="$WINDOW" '$1==w && $3=="0"{print $2;exit}')
  [ -n "${BODY:-}" ] && break; sleep 0.5
done
kill -KILL "$(cat "$PIDFILE")" 2>/dev/null || true
sleep 1
echo "orphan body = ${BODY:-none}"
echo "== process table matches for --agent $LEAD =="
ps -axo pid=,command= | grep -- "--agent $LEAD" | grep -v grep | cut -c1-150

TF="$SB/probe.targets"
rc=0; lead_body_collect_targets "$PROJECT" "$LEAD" claude-code "$ARCHIVE" "$TF" || rc=$?
echo "== collect rc=$rc; targets =="
cat "$TF"

echo "== step-by-step terminate =="
project="$(sed -n 's/^#project=//p' "$TF")"; backend="$(sed -n 's/^#backend=//p' "$TF")"
r=0; _lead_body_send_interrupts "$TF" "$project" "$LEAD" "$backend" || r=$?; echo "  send_interrupts rc=$r"
r=0; _lead_body_wait_stage "$TF" "$project" "$LEAD" "$backend" 10 0.5 || r=$?; echo "  wait(C-c) rc=$r"
r=0; _lead_body_signal_full_targets "$TF" TERM "$project" "$LEAD" "$backend" || r=$?; echo "  signal TERM rc=$r"
r=0; _lead_body_wait_stage "$TF" "$project" "$LEAD" "$backend" 10 0.5 || r=$?; echo "  wait(TERM) rc=$r"
r=0; _lead_body_signal_full_targets "$TF" KILL "$project" "$LEAD" "$backend" || r=$?; echo "  signal KILL rc=$r"
r=0; _lead_body_wait_stage "$TF" "$project" "$LEAD" "$backend" 4 0.5 || r=$?; echo "  wait(KILL) rc=$r"
r=0; _lead_body_any_full_alive "$TF" "$project" "$LEAD" "$backend" || r=$?; echo "  any_full_alive rc=$r  (0=alive 1=none 2=sensor-err)"
r=0; _lead_body_has_live_detect "$TF" && r=1; echo "  has_live_detect=$r"
r=0; _lead_body_cleanup_windows "$TF" "$project" "$LEAD" || r=$?; echo "  cleanup_windows rc=$r"
r=0; _lead_body_cleanup_archive "$ARCHIVE" || r=$?; echo "  cleanup_archive rc=$r"
echo "orphan alive now: $(kill -0 "${BODY:-0}" 2>/dev/null && echo YES || echo no)"
echo "panes now:"; $T -S "$SOCKET" list-panes -s -t '=flywheel' -F '  #{window_name} #{pane_pid} #{pane_dead}' 2>/dev/null
