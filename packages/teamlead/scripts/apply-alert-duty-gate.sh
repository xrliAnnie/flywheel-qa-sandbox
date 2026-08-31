#!/bin/bash
# FLY-2076 — put the single Claw duty seat on the existing Alerts intake.
# Only an already-provisioned Alerts group is changed. The patch is additive,
# atomic, backed up, optimistic against the plugin's own hot-reload writer, and
# fail-closed on malformed JSON.

set -uo pipefail

ACCESS_FILE=""
CHANNEL_ID=""
ALLOW_BOT=""
DRY_RUN=0
LEAD="${LEAD_ID:-unknown}"

usage() {
  echo "Usage: apply-alert-duty-gate.sh --access-file <path> --channel-id <id> [--allow-bot <id>] [--lead-id <id>] [--dry-run]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --access-file) ACCESS_FILE="${2:-}"; shift 2 ;;
    --channel-id) CHANNEL_ID="${2:-}"; shift 2 ;;
    --allow-bot) ALLOW_BOT="${2:-}"; shift 2 ;;
    --lead-id) LEAD="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[alert-duty-gate] ERROR: unknown argument '$1'" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$ACCESS_FILE" ] || [ -z "$CHANNEL_ID" ]; then
  echo "[alert-duty-gate] ERROR: --access-file and --channel-id are required" >&2
  usage
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[alert-duty-gate] ERROR: jq is required" >&2
  exit 2
fi

summary() {
  local status="$1" bot="none"
  [ -n "$ALLOW_BOT" ] && bot="$ALLOW_BOT"
  echo "[alert-duty-gate] ${LEAD}: channel=${CHANNEL_ID} requireMention=false allowFrom=[] allowBots+=${bot} (${status})"
}

if [ ! -f "$ACCESS_FILE" ]; then
  summary "skipped:no_access_file"
  exit 0
fi
if ! jq -e . "$ACCESS_FILE" >/dev/null; then
  echo "[alert-duty-gate] ERROR: invalid JSON, original left untouched: $ACCESS_FILE" >&2
  exit 1
fi
if ! jq -e --arg ch "$CHANNEL_ID" \
  '(.groups | type == "object") and (.groups | has($ch))' \
  "$ACCESS_FILE" >/dev/null; then
  summary "skipped:no_alert_group"
  exit 0
fi
if [ -n "$ALLOW_BOT" ] && ! jq -e \
  '(.allowBots == null) or (.allowBots | type == "array")' \
  "$ACCESS_FILE" >/dev/null; then
  echo "[alert-duty-gate] ERROR: allowBots is not an array, refusing to overwrite it" >&2
  exit 1
fi

if jq -e --arg ch "$CHANNEL_ID" --arg bot "$ALLOW_BOT" '
  (.groups[$ch].requireMention == false) and
  ((.groups[$ch].allowFrom // []) == []) and
  ($bot == "" or ((.allowBots // []) | index($bot)) != null)
' "$ACCESS_FILE" >/dev/null; then
  summary "noop"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  summary "changed"
  exit 0
fi

hash_file() {
  cksum "$1" 2>/dev/null | awk '{print $1"-"$2}'
}

backup_seq=0
swapped=0
for _attempt in 1 2 3 4 5; do
  pre_hash="$(hash_file "$ACCESS_FILE")"
  temp_file="${ACCESS_FILE}.tmp.$$"
  if ! jq --arg ch "$CHANNEL_ID" --arg bot "$ALLOW_BOT" '
    .groups[$ch].requireMention = false |
    .groups[$ch].allowFrom = [] |
    if $bot == "" then .
    elif ((.allowBots // []) | index($bot)) != null then .
    else .allowBots = ((.allowBots // []) + [$bot])
    end
  ' "$ACCESS_FILE" > "$temp_file"; then
    rm -f "$temp_file"
    sleep 0.2
    continue
  fi
  if ! jq -e . "$temp_file" >/dev/null; then
    echo "[alert-duty-gate] ERROR: patch produced invalid JSON" >&2
    rm -f "$temp_file"
    exit 1
  fi

  backup_seq=$((backup_seq + 1))
  backup_file="${ACCESS_FILE}.bak.$(date +%s).$$.${backup_seq}"
  if ! cp -p "$ACCESS_FILE" "$backup_file"; then
    echo "[alert-duty-gate] ERROR: backup failed, original left untouched" >&2
    rm -f "$temp_file" "$backup_file"
    exit 1
  fi
  if [ "$(hash_file "$ACCESS_FILE")" != "$pre_hash" ]; then
    rm -f "$temp_file" "$backup_file"
    sleep 0.2
    continue
  fi
  if ! mv "$temp_file" "$ACCESS_FILE"; then
    echo "[alert-duty-gate] ERROR: atomic rename failed (backup: $backup_file)" >&2
    rm -f "$temp_file"
    exit 1
  fi
  swapped=1
  break
done

if [ "$swapped" -ne 1 ]; then
  echo "[alert-duty-gate] ERROR: access file changed during all five attempts" >&2
  exit 1
fi

summary "changed"
