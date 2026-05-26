#!/bin/bash
# flywheel-cmux-autostart.sh — Auto-start cmux workspace watcher
# Called from .zshrc when CMUX_WORKSPACE_ID is detected.
#
# FLY-129 Phase 1: single-instance lock has been pushed DOWN into
# flywheel-cmux-sync.sh (acquire_watcher_lock / WATCHER_LOCK_DIR).
# That makes every entry path to `--watch` race-safe: autostart, manual
# invocation, supervisor respawn, etc. Do NOT re-add lock logic here.

LOG="/tmp/flywheel-cmux-watcher.log"
SYNC_SCRIPT="$HOME/.flywheel/bin/flywheel-cmux-sync"

# ── Run watcher ──
#
# FLY-129: do NOT `exec` the sync script. `exec` would replace this shell,
# which means our EXIT trap (if we ever add one) won't fire. Today the
# lock release lives inside the sync script's own EXIT trap, so this is
# mostly belt-and-suspenders — but keeping the wrapper shell alive means
# the autostart entry can grow side effects in the future without surgery.
#
# Tradeoff: 1 long-running bash wrapper per host (negligible — ~5MB RSS).

"$SYNC_SCRIPT" --watch >> "$LOG" 2>&1
exit_code=$?
exit "$exit_code"
