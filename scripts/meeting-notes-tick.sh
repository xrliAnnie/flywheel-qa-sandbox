#!/bin/bash
# FLY-2033: two-minute meeting artifact reconciliation tick.
set -euo pipefail

FLYWHEEL_DIR="${FLYWHEEL_DIR:-/Users/xiaorongli/Dev/flywheel}"
LOG="${FLYWHEEL_MEETING_NOTES_LOG:-/tmp/flywheel-meeting-notes.log}"
LOCKDIR="${FLYWHEEL_MEETING_NOTES_LOCKDIR:-${TMPDIR:-/tmp}/flywheel-meeting-notes.lock}"
ENV_FILE="${FLYWHEEL_ENV_FILE:-${HOME}/.flywheel/.env}"
CONFIG_FILE="${FLYWHEEL_MEETING_NOTES_CONFIG:-${FLYWHEEL_DIR}/.flywheel/meeting-notes.yaml}"
PNPM_BIN="${FLYWHEEL_MEETING_NOTES_PNPM:-pnpm}"
LOCK_STALE_SECS=900
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

log() { printf '[meeting-notes-tick %s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

alert_wrapper_failure() {
  local detail="$1" failure_class="${2:-config}" result rc=0
  result=$(bash "$FLYWHEEL_DIR/scripts/lead-alert.sh" \
    --lead claude-infra-bot-lead --project flywheel \
    --kind meeting_notes_failed --severity warning \
    --title "会议留痕管线故障" \
    --body "subject=preflight failureClass=$failure_class detail=$detail" \
    --signature "preflight:$failure_class:$(TZ="${FLYWHEEL_FOUNDER_TZ:-America/Los_Angeles}" date '+%Y%m%d')" \
    --strict-delivery 2>>"$LOG") || rc=$?
  if [ "$result" != "sent" ] && [ "$result" != "queued_transient" ]; then
    log "alert delivery unproven rc=$rc receipt=${result:-empty}"
    return 1
  fi
}

if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 262144 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  if [ ! -d "$LOCKDIR" ]; then
    log "lock path exists but is not a directory"
    alert_wrapper_failure "lock path invalid" || true
    exit 1
  fi
  now=$(date +%s)
  modified=$(stat -c %Y "$LOCKDIR" 2>/dev/null || stat -f %m "$LOCKDIR" 2>/dev/null || echo "$now")
  age=$((now - modified))
  if [ "$age" -le "$LOCK_STALE_SECS" ]; then
    log "another tick is running (lock age=${age}s); skip"
    exit 0
  fi
  if ! rmdir "$LOCKDIR" 2>/dev/null || ! mkdir "$LOCKDIR" 2>/dev/null; then
    log "stale lock could not be reaped or reacquired"
    alert_wrapper_failure "stale lock recovery failed" || true
    exit 1
  fi
  log "reaped stale lock age=${age}s"
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

if [ ! -f "$CONFIG_FILE" ]; then
  log "config missing: $CONFIG_FILE"
  alert_wrapper_failure "meeting-notes config missing" || true
  exit 1
fi
if [ ! -f "$FLYWHEEL_DIR/packages/teamlead/dist/meeting-notes-scheduler.js" ] \
  || [ ! -f "$FLYWHEEL_DIR/packages/teamlead/dist/meeting-notes-config.js" ]; then
  log "compiled meeting-notes modules missing"
  alert_wrapper_failure "compiled meeting-notes modules missing" || true
  exit 1
fi

export FLYWHEEL_DIR FLYWHEEL_MEETING_NOTES_CONFIG="$CONFIG_FILE"
cd "$FLYWHEEL_DIR"
log "tick start"
if "$PNPM_BIN" exec tsx scripts/meeting-notes-scheduler.ts >>"$LOG" 2>&1; then
  log "tick ok"
else
  rc=$?
  log "tick failed rc=$rc"
	if [ "$rc" -eq 2 ]; then
		log "scheduler failed after delivering its own alert; wrapper fallback suppressed"
	else
		alert_wrapper_failure "scheduler exited rc=$rc" bridge || true
	fi
  exit "$rc"
fi
