#!/bin/bash
# FLY-222: scheduled-learning tick — launchd entry wrapper.
#
# FLY-286: post-hoc model wired (the scheduler now passes review_channel /
# first_run_cap / first_run_analyze_limit / auto_create). Code is ready; INSTALLING
# this into launchd + the FIRST live run is the GATED pilot (CoS + Annie present,
# safe machine load — never self-triggered). Sources env, takes a FLY-176 re-entry
# lock (no overlapping ticks), truncates its log, then runs the thin TS scheduler
# (which spawns Runners via the Bridge and returns quickly — it does NOT wait for
# Runners). Do NOT load the plist against a production Bridge before that pilot.
set -euo pipefail

FLYWHEEL_DIR="${FLYWHEEL_DIR:-$HOME/Dev/flywheel}"
LOG="/tmp/flywheel-xhs-scheduler.log"
LOCKDIR="${TMPDIR:-/tmp}/flywheel-xhs-scheduler.lock"
LOCK_STALE_SECS=3600 # a tick is short (spawn-and-return); 1h => crashed holder

# launchd hands us a minimal PATH — make node/npx resolvable.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

log() { echo "[xhs-tick $(date '+%Y-%m-%dT%H:%M:%S%z')] $*" >>"$LOG"; }

# Truncate the log if it grew beyond ~1MB (keep the tail).
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 262144 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

# ── FLY-176 re-entry guard: atomic mkdir lock; stale (crashed) holder reaped ──
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  if [ -d "$LOCKDIR" ]; then
    # Stale? compare lock dir mtime age.
    now=$(date +%s)
    mt=$(stat -f %m "$LOCKDIR" 2>/dev/null || stat -c %Y "$LOCKDIR" 2>/dev/null || echo "$now")
    if [ $((now - mt)) -gt "$LOCK_STALE_SECS" ]; then
      log "stale lock ($((now - mt))s) — reaping and retrying"
      rm -rf "$LOCKDIR"
      mkdir "$LOCKDIR" 2>/dev/null || { log "lost stale-reap race — exiting"; exit 0; }
    else
      log "another tick is running (lock held) — exiting"
      exit 0
    fi
  else
    log "mkdir lock failed for a non-EEXIST reason — exiting"
    exit 1
  fi
fi
trap 'rm -rf "$LOCKDIR"' EXIT

# ── env: BRIDGE_URL / TEAMLEAD_API_TOKEN / LINEAR_API_KEY ──
if [ -f "$HOME/.flywheel/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$HOME/.flywheel/.env"
  set +a
fi

cd "$FLYWHEEL_DIR" || { log "cannot cd to $FLYWHEEL_DIR"; exit 1; }

log "tick start"
if npx tsx scripts/xiaohongshu-scheduler.ts >>"$LOG" 2>&1; then
  log "tick ok"
else
  rc=$?
  log "tick exited rc=$rc (see above)"
  exit "$rc"
fi
