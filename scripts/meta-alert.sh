#!/bin/bash
# FLY-182 Track B §4.5.1 — shared Discord-INDEPENDENT meta-alert.
#
# "LeadAlert must never fail silently" (Annie). This is the shell-side twin of
# MetaAlertNotifier, used by scripts/lead-alert.sh (the Bridge-independent
# crash-loop path) so that even when the Bridge is down, a permanent alert
# failure still surfaces to Annie via a channel that does NOT depend on Discord.
#
# Channels: macOS desktop notification (osascript) + a high-visibility local
# file under <FLYWHEEL_STATE_DIR>/meta-alert/<reason>.txt (overwritten per
# reason — never an unbounded queue). Debounced per reason.
#
# Usage: meta-alert.sh <reason> <title> <body>
# Exit: always 0 (best-effort — must never break the caller).
set -uo pipefail

REASON="${1:-}"
TITLE="${2:-}"
BODY="${3:-}"
if [ -z "$REASON" ] || [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  echo "[meta-alert] usage: meta-alert.sh <reason> <title> <body>" >&2
  exit 0
fi

STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel/state}"
META_DIR="$STATE_DIR/meta-alert"
mkdir -p "$META_DIR" 2>/dev/null || true

# Sanitize reason for use as a filename (single safe component).
SAFE_REASON=$(printf '%s' "$REASON" | tr -c 'a-zA-Z0-9_-' '-')
MARKER="$META_DIR/${SAFE_REASON}.txt"

# Debounce: skip if the marker was written within the window (default 10min).
DEBOUNCE_MS="${FLYWHEEL_META_ALERT_DEBOUNCE_MS:-600000}"
DEBOUNCE_S=$(( DEBOUNCE_MS / 1000 ))
if [ -f "$MARKER" ]; then
  mtime=$(stat -f %m "$MARKER" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $(( now - mtime )) -lt "$DEBOUNCE_S" ]; then
    exit 0
  fi
fi

# File channel (always — audit + visible).
printf '[%s] %s\nreason=%s\n\n%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TITLE" "$REASON" "$BODY" > "$MARKER" 2>/dev/null || true

# Desktop channel (best-effort). argv form → no AppleScript injection.
osascript \
  -e 'on run argv' \
  -e 'display notification (item 1 of argv) with title (item 2 of argv)' \
  -e 'end run' \
  "$BODY" "Flywheel: $TITLE" >/dev/null 2>&1 || true

exit 0
