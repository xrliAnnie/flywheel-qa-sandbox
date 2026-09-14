#!/bin/bash
# Durable customer updater entry. The shell command owns locking and recovery.
set -uo pipefail
STATE_DIR="${1:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}}"
export FLYWHEEL_STATE_DIR="$STATE_DIR"
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
unset FLYWHEEL_LICENSE_KEY FLYWHEEL_ALLOW_LICENSE_KEY_ENV
mkdir -p "$STATE_DIR/logs" || exit 1
LOG="$STATE_DIR/logs/auto-update.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 262144 ]; then
  # Keep the existing log inode so a concurrent lock refusal still appends to it.
  if ! tail -c 262144 "$LOG" > "$LOG.tmp.$$" || ! cat "$LOG.tmp.$$" > "$LOG"; then
    rm -f "$LOG.tmp.$$"
    exit 1
  fi
  rm -f "$LOG.tmp.$$"
fi
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"; }
if [ -e "$STATE_DIR/auto-update.off" ]; then log disabled; exit 0; fi
if ! command -v node >/dev/null 2>&1; then log node_missing; exit 0; fi
SHELL_ENTRY="$STATE_DIR/shell/current/bin/flywheel-onboard.js"
if [ ! -r "$SHELL_ENTRY" ]; then log shell_missing; exit 0; fi
exec node "$SHELL_ENTRY" update --unattended >> "$LOG" 2>&1
