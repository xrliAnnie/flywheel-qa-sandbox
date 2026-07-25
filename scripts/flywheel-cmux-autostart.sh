#!/bin/bash
# flywheel-cmux-autostart.sh — launchd cmux watcher entry + shell job guard
# Called from .zshrc when CMUX_WORKSPACE_ID is detected.
#
# FLY-1446: launchd com.flywheel.cmux-watcher (KeepAlive) is the sole normal
# --watch starter. The .zshrc path only verifies/bootstrap the launchd job; it
# never falls back to a second watcher. The FLY-129 lease remains defense in
# depth inside flywheel-cmux-sync.sh. Do NOT re-add lock logic here.

LOG="/tmp/flywheel-cmux-watcher.log"
SYNC_SCRIPT="$HOME/.flywheel/bin/flywheel-cmux-sync"
ENV_FILE="$HOME/.flywheel/.env"
MAINTENANCE_MARKER="${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-$HOME/.flywheel/state/cmux-maintenance}"

# FLY-1272/1364/1446: extract only declared cmux bool flags. Never source the whole .env — it
# may contain unrelated shell syntax/secrets, and autostart needs only these
# literals. Precedence: inherited env > .env > the caller-supplied safe
# default. Any non-0/1 value falls back to that default.
load_cmux_bool_flag() {
  local name="$1" default="${2:-1}" raw="" inherited=""
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
  case "$raw" in 0|1) ;; *) raw="$default" ;; esac
  export "${name}=${raw}"
}

load_cmux_bool_flag FLYWHEEL_CMUX_LINKED_VIEW 1
load_cmux_bool_flag FLYWHEEL_CMUX_VIEW_INVARIANT 1
load_cmux_bool_flag FLYWHEEL_CMUX_STRICT_VIEW 1
load_cmux_bool_flag FLYWHEEL_CMUX_WAL_QUARANTINE 1
load_cmux_bool_flag FLYWHEEL_CMUX_ROSTER 1
load_cmux_bool_flag FLYWHEEL_CMUX_AUTOSTART_EXEC 0

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

# ── Run watcher or guard the launchd job ──
#
# FLY-177: under launchd, `exec` so the KeepAlive-managed PID is the real
# watcher. FLY-1446: every unsupervised invocation is only a job guard. The
# explicit AUTOSTART_EXEC=1 escape exists for incident response; the
# maintenance marker above still wins.
if [[ "${FLYWHEEL_CMUX_SUPERVISED:-0}" == "1" || "$FLYWHEEL_CMUX_AUTOSTART_EXEC" == "1" ]]; then
  exec "$SYNC_SCRIPT" --watch >> "$LOG" 2>&1
fi

WATCHER_LABEL="com.flywheel.cmux-watcher"
WATCHER_TARGET="gui/$(id -u)/${WATCHER_LABEL}"
WATCHER_PLIST="${FLYWHEEL_CMUX_WATCHER_PLIST:-$HOME/Library/LaunchAgents/${WATCHER_LABEL}.plist}"

if launchctl print "$WATCHER_TARGET" >/dev/null 2>&1; then
  exit 0
fi

if [[ ! -f "$WATCHER_PLIST" ]]; then
  echo "flywheel-cmux-autostart: ${WATCHER_LABEL} is not loaded and ${WATCHER_PLIST} is missing; run scripts/flywheel-cmux-install.sh" >&2
  exit 0
fi

if launchctl bootstrap "gui/$(id -u)" "$WATCHER_PLIST" >/dev/null 2>&1; then
  echo "flywheel-cmux-autostart: bootstrapped launchd KeepAlive job ${WATCHER_LABEL}" >&2
else
  # Interactive shell startup must not fail, and—critically—must never turn a
  # launchd control-plane problem into a second direct watcher instance.
  echo "flywheel-cmux-autostart: launchctl bootstrap failed for ${WATCHER_LABEL}; inspect with: launchctl print ${WATCHER_TARGET}" >&2
fi
exit 0
