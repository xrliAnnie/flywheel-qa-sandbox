#!/bin/bash
# FLY-83: Independent Lead alert emitter.
#
# Called by claude-lead.sh supervisor on blocked-prompt exits (100/101/102)
# and on crash-loop escalation. Lives in shell so it works even when the
# Bridge (Node.js) is down.
#
# Responsibilities:
#   1. Resolve alert channel + bot token from ~/.flywheel/projects.json.
#   2. Generate eventId = sha1(leadId + kind + 10min-bucket).
#   3. Claim dedup via ~/.flywheel/alerts/claims.db (single sqlite3 tx,
#      BEGIN IMMEDIATE + INSERT OR IGNORE + SELECT changes()).
#   4. Post to Discord; on failure spill to ~/.flywheel/alert-queue/.
#
# Usage:
#   lead-alert.sh \
#     --lead <lead-id> --project <project-name> \
#     --kind <rate_limit|login_expired|permission_blocked|crash_loop|pane_hash_stuck> \
#     --severity <info|warning|severe> \
#     --title <string> --body <string>
#
# Exit codes:
#   0 — posted or already claimed (both are success: no double-alert)
#   1 — unrecoverable config error (missing projects.json, unknown lead, etc.)
#   2 — Discord POST failed, payload queued for later drain
set -euo pipefail

log() {
  echo "[lead-alert] $(date '+%H:%M:%S') $*" >&2
}

usage() {
  sed -n '3,30p' "$0" >&2
  exit 1
}

LEAD_ID=""
PROJECT_NAME=""
KIND=""
SEVERITY="warning"
TITLE=""
BODY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --lead)     LEAD_ID="${2:?--lead requires a value}"; shift 2 ;;
    --project)  PROJECT_NAME="${2:?--project requires a value}"; shift 2 ;;
    --kind)     KIND="${2:?--kind requires a value}"; shift 2 ;;
    --severity) SEVERITY="${2:?--severity requires a value}"; shift 2 ;;
    --title)    TITLE="${2:?--title requires a value}"; shift 2 ;;
    --body)     BODY="${2:?--body requires a value}"; shift 2 ;;
    -h|--help)  usage ;;
    *)
      log "ERROR: unknown flag '$1'"
      usage
      ;;
  esac
done

if [ -z "$LEAD_ID" ] || [ -z "$PROJECT_NAME" ] || [ -z "$KIND" ] || [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  log "ERROR: --lead, --project, --kind, --title, --body are all required"
  usage
fi

case "$KIND" in
  rate_limit|login_expired|permission_blocked|crash_loop|pane_hash_stuck) ;;
  *)
    log "ERROR: unknown --kind '$KIND'"
    exit 1
    ;;
esac

case "$SEVERITY" in
  info|warning|severe) ;;
  *)
    log "ERROR: unknown --severity '$SEVERITY' (must be info|warning|severe)"
    exit 1
    ;;
esac

# ── Tool preflight ──────────────────────────────────────────
for tool in jq sqlite3 curl shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "ERROR: required tool '$tool' not found in PATH"
    exit 1
  fi
done

# ── Config resolution (projects.json SSOT) ──────────────────
PROJECTS_JSON="${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
if [ ! -f "$PROJECTS_JSON" ]; then
  log "ERROR: projects.json not found at $PROJECTS_JSON"
  exit 1
fi

LEAD_CFG=$(jq -c --arg p "$PROJECT_NAME" --arg l "$LEAD_ID" '
  .[] | select(.projectName == $p) as $proj
  | $proj.leads[] | select(.agentId == $l)
  | { alertChannel: .alertChannel,
      alertBotTokenEnv: .alertBotTokenEnv,
      alertDmUserId: .alertDmUserId,
      alertFallbackToCore: (.alertFallbackToCore // false),
      botTokenEnv: .botTokenEnv,
      generalChannel: $proj.generalChannel }' "$PROJECTS_JSON" 2>/dev/null)

if [ -z "$LEAD_CFG" ] || [ "$LEAD_CFG" = "null" ]; then
  log "ERROR: lead '$LEAD_ID' not found in project '$PROJECT_NAME' (projects.json)"
  exit 1
fi

ALERT_CHANNEL=$(printf '%s' "$LEAD_CFG" | jq -r '.alertChannel // ""')
FALLBACK_TO_CORE=$(printf '%s' "$LEAD_CFG" | jq -r '.alertFallbackToCore')
GENERAL_CHANNEL=$(printf '%s' "$LEAD_CFG" | jq -r '.generalChannel // ""')
ALERT_BOT_TOKEN_ENV=$(printf '%s' "$LEAD_CFG" | jq -r '.alertBotTokenEnv // ""')
LEAD_BOT_TOKEN_ENV=$(printf '%s' "$LEAD_CFG" | jq -r '.botTokenEnv // ""')

# Resolve channel: alertChannel → generalChannel (if alertFallbackToCore).
CHANNEL_ID=""
if [ -n "$ALERT_CHANNEL" ]; then
  CHANNEL_ID="$ALERT_CHANNEL"
elif [ "$FALLBACK_TO_CORE" = "true" ] && [ -n "$GENERAL_CHANNEL" ]; then
  CHANNEL_ID="$GENERAL_CHANNEL"
  log "WARNING: no alertChannel configured, falling back to generalChannel ($CHANNEL_ID)"
fi

# Resolve token: alertBotTokenEnv → botTokenEnv. Fallback warned once.
TOKEN=""
if [ -n "$ALERT_BOT_TOKEN_ENV" ]; then
  TOKEN="${!ALERT_BOT_TOKEN_ENV:-}"
fi
if [ -z "$TOKEN" ] && [ -n "$LEAD_BOT_TOKEN_ENV" ]; then
  TOKEN="${!LEAD_BOT_TOKEN_ENV:-}"
  if [ -n "$TOKEN" ]; then
    log "WARNING: alert token env '$ALERT_BOT_TOKEN_ENV' empty, using '$LEAD_BOT_TOKEN_ENV'"
  fi
fi

# ── Event ID (sha1 of leadId|kind|10min-bucket) ────────────
NOW_EPOCH=$(date +%s)
BUCKET=$((NOW_EPOCH / 600))
EVENT_ID=$(printf '%s:%s:%s' "$LEAD_ID" "$KIND" "$BUCKET" | shasum -a 1 | awk '{print $1}')

# ── Cross-process claim via claims.db ──────────────────────
# Single sqlite3 connection + BEGIN IMMEDIATE + SELECT changes() in the
# same transaction. Fresh sqlite3 invocations would each see changes()=0.
CLAIMS_DB="${FLYWHEEL_CLAIMS_DB:-${HOME}/.flywheel/alerts/claims.db}"
mkdir -p "$(dirname "$CLAIMS_DB")"

CLAIM_SQL=$(cat <<SQL
.timeout 5000
CREATE TABLE IF NOT EXISTS alert_claims (
  event_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
BEGIN IMMEDIATE;
INSERT OR IGNORE INTO alert_claims VALUES ('${EVENT_ID}', '${LEAD_ID}', '${KIND}', strftime('%s','now'));
SELECT changes();
COMMIT;
SQL
)

CLAIM_RESULT=$(sqlite3 "$CLAIMS_DB" <<<"$CLAIM_SQL" 2>&1) || {
  log "WARNING: sqlite3 claim failed: $CLAIM_RESULT"
  # If claim infrastructure is broken, fall through and try to post anyway —
  # a duplicate alert is better than a silent failure.
  CLAIM_RESULT="1"
}

# Last non-empty stdout line is the SELECT changes() result.
CLAIMED=$(printf '%s\n' "$CLAIM_RESULT" | awk 'NF' | tail -n 1)
if [ "$CLAIMED" != "1" ]; then
  log "already claimed event_id=$EVENT_ID lead=$LEAD_ID kind=$KIND, skipping"
  exit 0
fi

# ── Build Discord message payload ──────────────────────────
case "$SEVERITY" in
  severe)  EMOJI="🚨" ;;
  warning) EMOJI="⚠️" ;;
  info|*)  EMOJI="ℹ️" ;;
esac

CONTENT=$(printf '%s **%s** (%s / %s)\n%s' "$EMOJI" "$TITLE" "$LEAD_ID" "$KIND" "$BODY")

# Spill to queue for later drain. Keep fields aligned with LeadAlertNotifier.
QUEUE_DIR="${HOME}/.flywheel/alert-queue"
mkdir -p "$QUEUE_DIR"
QUEUE_PATH="${QUEUE_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${LEAD_ID}-${KIND}.json"

enqueue() {
  local reason="$1"
  jq -n \
    --arg leadId "$LEAD_ID" \
    --arg projectName "$PROJECT_NAME" \
    --arg eventId "$EVENT_ID" \
    --arg eventType "$KIND" \
    --arg title "$TITLE" \
    --arg body "$BODY" \
    --arg severity "$SEVERITY" \
    --arg queuedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg queueReason "$reason" \
    '{leadId: $leadId, projectName: $projectName, eventId: $eventId,
      eventType: $eventType, title: $title, body: $body,
      severity: $severity, queuedAt: $queuedAt, queueReason: $queueReason}' \
    > "$QUEUE_PATH"
  log "queued to $QUEUE_PATH (reason=$reason)"
}

if [ -z "$CHANNEL_ID" ]; then
  enqueue "no-channel"
  exit 2
fi
if [ -z "$TOKEN" ]; then
  enqueue "no-token"
  exit 2
fi

# ── POST to Discord ────────────────────────────────────────
BODY_JSON=$(jq -n --arg c "$CONTENT" '{content: $c}')
HTTP_CODE=$(curl -s -o /tmp/lead-alert-$$.out -w '%{http_code}' \
  --max-time 15 \
  -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
  -H "Authorization: Bot ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$BODY_JSON" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  rm -f /tmp/lead-alert-$$.out
  log "sent lead=$LEAD_ID kind=$KIND channel=$CHANNEL_ID (HTTP $HTTP_CODE)"
  exit 0
fi

RESP_BODY=$(cat /tmp/lead-alert-$$.out 2>/dev/null || true)
rm -f /tmp/lead-alert-$$.out
log "Discord POST failed HTTP=$HTTP_CODE body=$RESP_BODY"
enqueue "discord-${HTTP_CODE}"
exit 2
