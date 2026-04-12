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

exec "$SYNC_SCRIPT" --watch >> "$LOG" 2>&1
