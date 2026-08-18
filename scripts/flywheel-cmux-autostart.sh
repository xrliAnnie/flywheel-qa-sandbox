#!/bin/bash
# flywheel-cmux-autostart.sh — launchd cmux watcher entry + shell job guard
# Called from .zshrc when CMUX_WORKSPACE_ID is detected.
#
# FLY-1446: launchd com.flywheel.cmux-watcher (KeepAlive) is the sole normal
# --watch starter. The .zshrc path only verifies/bootstrap the launchd job; it
# never falls back to a second watcher. The FLY-129 lease remains defense in
# depth inside flywheel-cmux-sync.sh. Do NOT re-add lock logic here.

LOG="/tmp/flywheel-cmux-watcher.log"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$HOME/.flywheel/bin/flywheel-cmux-sync"
MAINTENANCE_MARKER="${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-$HOME/.flywheel/state/cmux-maintenance}"
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
# path (that shell already has a full PATH). Mirrors the Lead launch wrapper.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

# ── Run watcher or guard the launchd job ──
#
# FLY-177: under launchd, `exec` so the KeepAlive-managed PID is the real
# watcher. Every unsupervised invocation is only a job guard.
if [[ "${FLYWHEEL_CMUX_SUPERVISED:-0}" == "1" ]]; then
  RESTART_STORM_GATE_BIN="${FLYWHEEL_RESTART_STORM_GATE_BIN:-$SELF_DIR/restart-storm-gate.py}"
  # `set -e` aborts on a bare non-zero command, so the exit code must be
  # captured in an errexit-exempt `||` list — otherwise a held brake would
  # kill this wrapper with the gate's status and launchd would read the
  # hold as a crash.
  RESTART_STORM_RC=0
  "$RESTART_STORM_GATE_BIN" gate cmux-watcher || RESTART_STORM_RC=$?
  if [ "$RESTART_STORM_RC" -ne 0 ]; then
    if [ "$RESTART_STORM_RC" -eq 126 ] || [ "$RESTART_STORM_RC" -eq 127 ]; then
      # Bounded and synchronous, via the shared helper. Unbounded would let a
      # hung osascript inside meta-alert.sh pin this launch path so launchd
      # never retries once the brake is restored; detached would let launchd
      # kill the notifier with the job's process group before it writes its
      # marker, restoring the silence this branch removes.
      "$SELF_DIR/lib/bounded-run.sh" \
        "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
        "${FLYWHEEL_META_ALERT_BIN:-$SELF_DIR/meta-alert.sh}" \
        restart_storm_gate_unavailable_cmux-watcher \
        "Restart brake unavailable" \
        "restart-storm-gate.py is missing or not executable (exit ${RESTART_STORM_RC}); the cmux watcher will not launch until it is restored." \
        >/dev/null 2>&1 || true
      echo "flywheel-cmux-autostart: restart brake missing or not executable (exit ${RESTART_STORM_RC}) — refusing to launch the cmux watcher" >&2
    else
      echo "flywheel-cmux-autostart: restart-storm gate held/refused watcher startup" >&2
    fi
    exit 0
  fi
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
