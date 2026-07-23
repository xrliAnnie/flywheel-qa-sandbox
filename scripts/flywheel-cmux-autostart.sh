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
ENV_FILE="$HOME/.flywheel/.env"
MAINTENANCE_MARKER="${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-$HOME/.flywheel/state/cmux-maintenance}"

# FLY-1272/1364: extract only the three cmux topology bool flags. Never source the whole .env — it
# may contain unrelated shell syntax/secrets, and autostart needs only these
# literals. Precedence: inherited env > .env > default-on. Any non-0/1 value
# fails safe to 1.
load_cmux_bool_flag() {
  local name="$1" raw="" inherited=""
  eval "inherited=\${${name}+set}"
  if [[ "$inherited" == "set" ]]; then
    eval "raw=\${${name}}"
  elif [[ -f "$ENV_FILE" ]]; then
    raw=$(awk -v key="$name" '
      /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
        line=$0
        sub(/^[[:space:]]*export[[:space:]]+/, "", line)
        lhs=line; sub(/[[:space:]]*=.*/, "", lhs)
        if (lhs == key) {
          sub(/^[^=]*=[[:space:]]*/, "", line)
          sub(/[[:space:]]*#.*/, "", line)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          if ((line ~ /^".*"$/) || (line ~ /^'\''.*'\''$/)) {
            line=substr(line, 2, length(line)-2)
          }
          value=line
        }
      }
      END { if (value != "") print value }
    ' "$ENV_FILE")
  fi
  case "$raw" in 0|1) ;; *) raw=1 ;; esac
  export "${name}=${raw}"
}

load_cmux_bool_flag FLYWHEEL_CMUX_LINKED_VIEW
load_cmux_bool_flag FLYWHEEL_CMUX_VIEW_INVARIANT
load_cmux_bool_flag FLYWHEEL_CMUX_STRICT_VIEW

if [[ -e "$MAINTENANCE_MARKER" && "${FLYWHEEL_CMUX_SUPERVISED:-0}" != "1" ]]; then
  echo "flywheel-cmux-autostart: maintenance marker present; watcher not started" >&2
  exit 0
fi

# ── PATH for launchd (FLY-177) ──
#
# This wrapper is the entry for BOTH the `.zshrc` autostart path AND the launchd
# plist (com.flywheel.cmux-watcher). launchd gives a process only the minimal
# PATH `/usr/bin:/bin:/usr/sbin:/sbin`; the watcher shells out to `cmux`
# (/opt/homebrew/bin) and `tmux` (/usr/local/bin). Prepend Homebrew/local so the
# launchd-spawned watcher can find them. Idempotent + harmless on the `.zshrc`
# path (that shell already has a full PATH). Mirrors flywheel-lead-wrapper.sh.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

# ── Run watcher ──
#
# FLY-177: `exec` the sync script so the watcher process REPLACES this wrapper.
# Under launchd (KeepAlive) the managed PID must be the real watcher, not a
# wrapper shell — otherwise `bootout`/`kickstart -k`/TERM would signal the
# wrapper and could leave the child watcher orphaned (still holding the lock →
# respawn churn). The single-instance lock + its release trap live INSIDE
# flywheel-cmux-sync.sh (FLY-129), so no wrapper-side EXIT trap is needed.
# `.zshrc`'s `flywheel-cmux-autostart &!` still works with exec — it just
# backgrounds the real watcher instead of a wrapper shell.
exec "$SYNC_SCRIPT" --watch >> "$LOG" 2>&1
