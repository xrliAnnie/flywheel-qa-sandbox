#!/bin/bash
# flywheel-cmux-autostart.sh — Auto-start cmux workspace watcher
# Called from .zshrc when CMUX_WORKSPACE_ID is detected.
# Uses mkdir lock (macOS has no flock).

LOCK_DIR="/tmp/flywheel-cmux-watcher.lock"
LOG="/tmp/flywheel-cmux-watcher.log"
SYNC_SCRIPT="$HOME/.flywheel/bin/flywheel-cmux-sync"

# ── Single instance via mkdir lock ──

cleanup_lock() {
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}

# Check if lock is stale (process dead)
if [[ -d "$LOCK_DIR" ]]; then
  LOCK_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    # Watcher already running
    exit 0
  fi
  # Stale lock — clean up
  cleanup_lock
fi

# Acquire lock
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Race: another instance grabbed it
  exit 0
fi
echo $$ > "$LOCK_DIR/pid"
trap cleanup_lock EXIT

# ── Run watcher ──
#
# FLY-129: do NOT `exec` the sync script. `exec` replaces this shell, which
# means the EXIT trap (cleanup_lock) won't fire when the sync exits. We need
# the trap so that fail-loud (sync exits 1 on auth-rejected IPC) actually
# releases /tmp/flywheel-cmux-watcher.lock — otherwise the next cmux-pane
# autostart would see a stale lock dir and skip spawning a fresh watcher.
#
# Tradeoff: 1 long-running bash wrapper per host (negligible — ~5MB RSS).

"$SYNC_SCRIPT" --watch >> "$LOG" 2>&1
exit_code=$?
exit "$exit_code"
