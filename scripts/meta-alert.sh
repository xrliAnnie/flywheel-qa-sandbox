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
# FLY-1577: require a non-empty REGULAR marker. A successful write is never
# empty, so a zero-byte file is a previous failure, not a recent delivery —
# debouncing on it would swallow this alert on top of the one already lost.
if [ -f "$MARKER" ] && [ -s "$MARKER" ]; then
  # GNU (-c %Y) FIRST. GNU's `-f` means "file system status", so `stat -f %m FILE`
  # there does not fail cleanly — it prints a multi-line filesystem block, and
  # `mtime` becomes text like `  File: "..."`. The arithmetic below then evaluates
  # `File` as a variable and, under `set -u`, KILLS this script: on Linux any
  # second alert for the same reason died at this line with
  # `File: unbound variable`, exiting non-zero with nothing delivered — the exact
  # opposite of this file's "always exit 0, never break the caller" contract.
  # Same ordering as scripts/flywheel-setup.sh::_fs_perm.
  mtime=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER" 2>/dev/null || echo 0)
  # And never feed an unmeasured value to arithmetic: anything non-numeric means
  # the read failed, which is "no usable timestamp", not "a timestamp of zero
  # that happens to parse".
  case "$mtime" in ''|*[!0-9]*) mtime=0 ;; esac
  now=$(date +%s)
  if [ $(( now - mtime )) -lt "$DEBOUNCE_S" ]; then
    exit 0
  fi
fi

# File channel (always — audit + visible).
primary_ok=0
if printf '[%s] %s\nreason=%s\n\n%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TITLE" "$REASON" "$BODY" > "$MARKER" 2>/dev/null; then
  primary_ok=1
fi

# FLY-1577: if the durable channel could not be written, say so somewhere that
# does not depend on the caller's stderr. Measured on 2026-08-01: when the marker
# directory is unwritable AND the desktop channel is down, this script delivers
# nothing and still exits 0; the only trace is a shell redirect error, and every
# launch-path caller runs us as `... >/dev/null 2>&1 || true`, so that trace is
# discarded. Zero delivery then reads exactly like success.
#
# The trigger is THIS write's own result plus its postcondition — not whatever
# happens to sit at the pathname. A stale non-empty marker from an earlier alert
# would otherwise mask a failed write and suppress the fallback, which is exactly
# the loss this block exists to catch.
#
# Deliberately NOT changed: the exit status stays 0 and the caller's redirect
# stays as it is. This script sits on launchd launch paths — FLY-1501 built
# bounded-run precisely so a notifier can never wedge the service it is reporting
# on, and making it fail loudly would trade a silent alert for a service that
# will not start. So the fix is an extra trace, not an extra failure mode.
if [ "$primary_ok" != "1" ] || [ ! -f "$MARKER" ] || [ ! -s "$MARKER" ]; then
  FALLBACK_DIR="${TMPDIR:-/tmp}"
  FALLBACK="${FALLBACK_DIR}/flywheel-meta-alert-undelivered-${SAFE_REASON}.txt"
  # Never open that predictable pathname directly. It lives in a shared,
  # world-writable directory: a symlink planted there would redirect this write
  # onto an unrelated file, and a FIFO would BLOCK the open — wedging the very
  # launch path this script is forbidden to wedge. Write a private 0600 temp
  # first, verify it, then rename over the destination; rename replaces the
  # directory entry itself and never follows a symlink sitting at it.
  if fb_tmp=$(umask 077; mktemp "${FALLBACK}.XXXXXX" 2>/dev/null); then
    if printf '[%s] META-ALERT UNDELIVERED\nreason=%s\ntitle=%s\nintended_marker=%s\n\n%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REASON" "$TITLE" "$MARKER" "$BODY" \
        > "$fb_tmp" 2>/dev/null && [ -s "$fb_tmp" ]; then
      mv -f "$fb_tmp" "$FALLBACK" 2>/dev/null || rm -f "$fb_tmp" 2>/dev/null
    else
      rm -f "$fb_tmp" 2>/dev/null
    fi
  fi
fi

# Desktop channel (best-effort). argv form → no AppleScript injection.
osascript \
  -e 'on run argv' \
  -e 'display notification (item 1 of argv) with title (item 2 of argv)' \
  -e 'end run' \
  "$BODY" "Flywheel: $TITLE" >/dev/null 2>&1 || true

exit 0
