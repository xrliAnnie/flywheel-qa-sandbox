#!/bin/bash
# FLY-83: Independent Lead alert emitter.
#
# Called by claude-lead.sh supervisor on crash-loop escalation. Lives in
# shell so it works even when the Bridge (Node.js) is down.
#
# Responsibilities:
#   1. Resolve alert channel + bot token from ~/.flywheel/projects.json.
#   2. Generate eventId = sha1(projectName|leadId|kind|signature).
#      - signature defaults to today's date (YYYYMMDD) so a crash-looping
#        Lead alerts at most once per day per (project, lead, kind).
#      - --signature lets callers override (e.g., a pane content hash for
#        future kinds that mirror the Bridge-side LeadWatchdog formula).
#   3. Claim dedup via ~/.flywheel/alerts/claims.db (single sqlite3 tx,
#      BEGIN IMMEDIATE + INSERT OR IGNORE + SELECT changes()) — the SAME
#      table the Bridge `LeadAlertNotifier.claimsClaimer` writes to.
#   4. Post to Discord; on failure spill to ~/.flywheel/alert-queue/.
#
# Usage:
#   lead-alert.sh \
#     --lead <lead-id> --project <project-name> \
#     --kind <rate_limit|usage_limit|login_expired|permission_blocked|crash_loop|pane_hash_stuck|companion_config_error|external_config_error|tui_window_lost|restart_guard_bypass|bin_integrity_drift> \
#     --severity <info|warning|severe> \
#     --title <string> --body <string> \
#     [--signature <string>] [--strict-delivery]
#
# Exit codes:
#   0 — posted or already claimed (both are success: no double-alert)
#   1 — unrecoverable config error (missing projects.json, unknown lead, etc.)
#   2 — Discord POST failed, payload queued for later drain
#
# --strict-delivery (FLY-913): print ONE machine-readable result line on stdout
#   (`sent|duplicate|queued_transient|dead_lettered|config_error`) so callers
#   can distinguish "transient failure, queued and WILL drain" from "permanently
#   undeliverable" — exit 2 alone conflates the two (Codex R1 #1). Without the
#   flag, behavior (stdout/stderr/exit codes) is byte-for-byte unchanged.
set -euo pipefail

log() {
  echo "[lead-alert] $(date '+%H:%M:%S') $*" >&2
}

usage() {
  sed -n '3,40p' "$0" >&2
  exit 1
}

LEAD_ID=""
PROJECT_NAME=""
KIND=""
SEVERITY="warning"
TITLE=""
BODY=""
SIGNATURE=""
STRICT_DELIVERY=0

# FLY-913: machine-readable delivery result on stdout, ONLY under
# --strict-delivery. log() writes to stderr, so this is the sole stdout line.
emit_result() {
  if [ "$STRICT_DELIVERY" = "1" ]; then
    printf '%s\n' "$1"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --lead)      LEAD_ID="${2:?--lead requires a value}"; shift 2 ;;
    --project)   PROJECT_NAME="${2:?--project requires a value}"; shift 2 ;;
    --kind)      KIND="${2:?--kind requires a value}"; shift 2 ;;
    --severity)  SEVERITY="${2:?--severity requires a value}"; shift 2 ;;
    --title)     TITLE="${2:?--title requires a value}"; shift 2 ;;
    --body)      BODY="${2:?--body requires a value}"; shift 2 ;;
    --signature) SIGNATURE="${2:?--signature requires a value}"; shift 2 ;;
    --strict-delivery) STRICT_DELIVERY=1; shift ;;
    -h|--help)   usage ;;
    *)
      log "ERROR: unknown flag '$1'"
      emit_result "config_error"
      usage
      ;;
  esac
done

if [ -z "$LEAD_ID" ] || [ -z "$PROJECT_NAME" ] || [ -z "$KIND" ] || [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  log "ERROR: --lead, --project, --kind, --title, --body are all required"
  emit_result "config_error"
  usage
fi

case "$KIND" in
  # FLY-871 §12 W2: tui_window_lost — the windowed Codex Lead's silent-no-pane
  # guard fires this via lead-alert.sh (Discord-independent path). Kept in the TS
  # AlertEventType union too (LeadAlertNotifier.ts) so the shared type face has no drift.
  # FLY-913: restart_guard_bypass — the flywheel-restart-guard PreToolUse hook's
  # mandatory bypass alert (every bypass MUST ring; the hook fail-closes on
  # anything but sent/queued_transient). Same TS-union parity convention.
  # FLY-954: bin_integrity_drift — converge-flywheel-bin.sh 检出 <state>/bin 与
  # repo 源漂移(修复成功/失败/源坏拒修均响)。Same TS-union parity convention.
  rate_limit|usage_limit|login_expired|permission_blocked|crash_loop|pane_hash_stuck|companion_config_error|external_config_error|tui_window_lost|restart_guard_bypass|bin_integrity_drift) ;;
  *)
    log "ERROR: unknown --kind '$KIND'"
    emit_result "config_error"
    exit 1
    ;;
esac

case "$SEVERITY" in
  info|warning|severe) ;;
  *)
    log "ERROR: unknown --severity '$SEVERITY' (must be info|warning|severe)"
    emit_result "config_error"
    exit 1
    ;;
esac

# ── Tool preflight ──────────────────────────────────────────
for tool in jq sqlite3 curl shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "ERROR: required tool '$tool' not found in PATH"
    emit_result "config_error"
    exit 1
  fi
done

# ── Discord-INDEPENDENT meta-alert escape (FLY-182 §4.5.1) ──
# Resolve our own dir early so the meta-alert escape is reachable from EVERY
# failure branch — including unknown-lead, which exits before the later
# dead_letter() definition. meta-alert.sh self-debounces per reason and
# OVERWRITES its marker, so repeated calls neither spam nor grow unbounded.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fire_meta_alert() {
  # $1 = reason, $2 = title, $3 = body. Best-effort; never breaks the caller.
  if [ -x "${SCRIPT_DIR}/meta-alert.sh" ]; then
    "${SCRIPT_DIR}/meta-alert.sh" "$1" "$2" "$3" || true
  fi
}

# Escape single quotes for sqlite3 string literals (parity with the TS
# sqlString() claimer). sqlite3-over-stdin can't bind params, so we double any
# embedded single quote to avoid breaking the claim transaction / local DB.
sql_quote() { printf '%s' "$1" | sed "s/'/''/g"; }

# ── Config resolution (projects.json SSOT) ──────────────────
PROJECTS_JSON="${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
if [ ! -f "$PROJECTS_JSON" ]; then
  log "ERROR: projects.json not found at $PROJECTS_JSON"
  # FLY-231 (Codex code-review HIGH-1): the companion fail-STOP path calls this
  # exactly when projects.json is missing/unreadable. Without a Discord-INDEPENDENT
  # meta-alert here, the alert is silently lost (the channel can't be resolved from
  # the very file that's gone). Surface it so Annie still learns a Lead won't start.
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "projects.json not found at ${PROJECTS_JSON}; alert (lead=${LEAD_ID} project=${PROJECT_NAME} kind=${KIND}) dropped — config missing."
  emit_result "config_error"
  exit 1
fi

# Capture jq failure (corrupt/unreadable JSON) explicitly — under `set -e` a bare
# `VAR=$(jq ...)` would abort BEFORE the emptiness check below, skipping the
# meta-alert (Codex code-review HIGH-1). `if ! VAR=$(...)` suppresses set -e and
# lets us route corrupt config to the Discord-independent escape too.
if ! LEAD_CFG=$(jq -c --arg p "$PROJECT_NAME" --arg l "$LEAD_ID" '
  .[] | select(.projectName == $p) as $proj
  | $proj.leads[] | select(.agentId == $l)
  | { alertChannel: .alertChannel,
      alertBotTokenEnv: .alertBotTokenEnv,
      alertDmUserId: .alertDmUserId,
      alertFallbackToCore: (.alertFallbackToCore // false),
      botTokenEnv: .botTokenEnv,
      generalChannel: $proj.generalChannel }' "$PROJECTS_JSON" 2>/dev/null); then
  log "ERROR: failed to parse projects.json at $PROJECTS_JSON (corrupt?)"
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "projects.json unreadable/corrupt at ${PROJECTS_JSON}; alert (lead=${LEAD_ID} project=${PROJECT_NAME} kind=${KIND}) dropped — config parse error."
  emit_result "config_error"
  exit 1
fi

if [ -z "$LEAD_CFG" ] || [ "$LEAD_CFG" = "null" ]; then
  log "ERROR: lead '$LEAD_ID' not found in project '$PROJECT_NAME' (projects.json)"
  # FLY-182: unknown-lead is a PERMANENT failure (config drift / renamed lead).
  # Surface it via the Discord-independent meta-alert so it never goes silent —
  # parity with LeadAlertNotifier, which dead-letters unknown-lead.
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "Lead '${LEAD_ID}' not found in project '${PROJECT_NAME}' (projects.json). Alert (kind=${KIND}) dropped — config drift or renamed lead."
  emit_result "config_error"
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

# ── Event ID (Fix 3: signature-based) ──────────────────────
# Formula: sha1(projectName|leadId|kind|signature).
# MUST match Bridge-side `computeEventId` in LeadWatchdog.ts (pipe
# separators, same field order, lowercase hex output) so cross-process
# dedup actually works.
#
# Default signature = today's date (UTC, YYYYMMDD). For crash-loop alerts
# this collapses repeated supervisor escalations within a day to one alert.
# Callers may pass --signature to mirror Bridge's pane-content-hash
# signature for kinds that have rich pane context (rare from shell side).
if [ -z "$SIGNATURE" ]; then
  SIGNATURE=$(LC_ALL=C date -u +%Y%m%d)
fi

EVENT_ID=$(LC_ALL=C printf '%s|%s|%s|%s' "$PROJECT_NAME" "$LEAD_ID" "$KIND" "$SIGNATURE" \
  | LC_ALL=C shasum -a 1 \
  | awk '{print $1}')
if [ -z "$EVENT_ID" ]; then
  log "ERROR: shasum failed to produce EVENT_ID (project=$PROJECT_NAME lead=$LEAD_ID kind=$KIND signature=$SIGNATURE)" >&2
  emit_result "config_error"
  exit 3
fi

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
INSERT OR IGNORE INTO alert_claims VALUES ('${EVENT_ID}', '$(sql_quote "$LEAD_ID")', '${KIND}', strftime('%s','now'));
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
  log "already claimed event_id=$EVENT_ID lead=$LEAD_ID kind=$KIND signature=$SIGNATURE, skipping"
  # NOTE (FLY-913 / Codex R2 #1): a claim row is written BEFORE the delivery
  # attempt, so `duplicate` does NOT prove the earlier alert was ever sent or
  # queued — strict callers must treat it as NOT-delivered.
  emit_result "duplicate"
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
# FLY-529: FLYWHEEL_ALERT_QUEUE_DIR isolates the QA Testing Room's shell-side
# alert queue to a slot-local dir so test alerts never land in the production
# queue the live Bridge drains. Unset → production default (byte-compat).
QUEUE_DIR="${FLYWHEEL_ALERT_QUEUE_DIR:-${HOME}/.flywheel/alert-queue}"
mkdir -p "$QUEUE_DIR"
QUEUE_PATH="${QUEUE_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${LEAD_ID}-${KIND}.json"

write_record() {
  # $1 = target path, $2 = reason
  jq -n \
    --arg leadId "$LEAD_ID" \
    --arg projectName "$PROJECT_NAME" \
    --arg eventId "$EVENT_ID" \
    --arg eventType "$KIND" \
    --arg title "$TITLE" \
    --arg body "$BODY" \
    --arg severity "$SEVERITY" \
    --arg queuedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg queueReason "$2" \
    '{leadId: $leadId, projectName: $projectName, eventId: $eventId,
      eventType: $eventType, title: $title, body: $body,
      severity: $severity, queuedAt: $queuedAt, queueReason: $queueReason}' \
    > "$1"
}

enqueue() {
  write_record "$QUEUE_PATH" "$1"
  log "queued to $QUEUE_PATH (reason=$1)"
}

# FLY-182 §4.5.1: PERMANENT failures (config gap, bad token, permanent 4xx)
# must NOT be queued for blind retry — that was the 1667-backlog root cause.
# Dead-letter (audit) + fire a Discord-INDEPENDENT meta-alert so the silent
# failure surfaces even when the Bridge is down.
DEAD_LETTER_DIR="${FLYWHEEL_ALERT_DEADLETTER_DIR:-${HOME}/.flywheel/alert-deadletter}"
dead_letter() {
  local reason="$1"
  mkdir -p "$DEAD_LETTER_DIR"
  local dl_path="${DEAD_LETTER_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${LEAD_ID}-${KIND}.json"
  write_record "$dl_path" "$reason"
  log "dead-lettered to $dl_path (reason=$reason)"
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "Lead '${LEAD_ID}' alert dead-lettered (reason=${reason}, kind=${KIND}). Discord alert path misconfigured/down."
}

if [ -z "$CHANNEL_ID" ]; then
  dead_letter "no-channel"
  emit_result "config_error"
  exit 2
fi
if [ -z "$TOKEN" ]; then
  dead_letter "no-token"
  emit_result "config_error"
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
  emit_result "sent"
  exit 0
fi

RESP_BODY=$(cat /tmp/lead-alert-$$.out 2>/dev/null || true)
rm -f /tmp/lead-alert-$$.out
log "Discord POST failed HTTP=$HTTP_CODE body=$RESP_BODY"

# Keep the claim — it marks "someone took responsibility for this eventId".
# Classify the failure (FLY-182 §4.2 parity with LeadAlertNotifier):
#   5xx / 429 / 000(network) → TRANSIENT → queue for Bridge drainQueue retry.
#   other 4xx (401/403/404 — bad token, forbidden, channel gone) → PERMANENT
#     → dead-letter + meta-alert (retry is pointless).
if [ "$HTTP_CODE" -ge 500 ] 2>/dev/null \
  || [ "$HTTP_CODE" = "429" ] || [ "$HTTP_CODE" = "000" ]; then
  enqueue "discord-${HTTP_CODE}"
  emit_result "queued_transient"
  exit 2
fi
dead_letter "discord-${HTTP_CODE}"
emit_result "dead_lettered"
exit 2
