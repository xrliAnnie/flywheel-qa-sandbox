#!/bin/bash
# FLY-1364 capability QA: emit the real cmux_cleanup refusal path to the
# isolated FLY-529 test channel, locate the exact message, and GET it again by
# message id. This is intentionally not a CI test; it requires a provisioned
# test bot token and Discord network access.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SYNC="$ROOT/scripts/flywheel-cmux-sync.sh"
ENV_FILE="$HOME/.flywheel/.env"
SLOTS_FILE="$HOME/.flywheel/test-slots.json"
QA_ROOT="$(mktemp -d -t fly1364-discord.XXXXXX)"
PROD_ROOT="$HOME/.flywheel"

cleanup() {
  rm -rf "$QA_ROOT"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

snapshot_production_alert_state() {
  {
    for path in \
      "$PROD_ROOT/alert-queue" \
      "$PROD_ROOT/alert-deadletter" \
      "$PROD_ROOT/alerts/claims.db"; do
      if [ -d "$path" ]; then
        find "$path" -type f -maxdepth 2 -exec stat -f '%N|%m|%z' {} \; 2>/dev/null
      elif [ -f "$path" ]; then
        stat -f '%N|%m|%z' "$path" 2>/dev/null || true
      fi
    done
  } | LC_ALL=C sort | shasum -a 256 | awk '{print $1}'
}

[ -r "$ENV_FILE" ] || fail "missing provisioned test environment: $ENV_FILE"
[ -r "$SLOTS_FILE" ] || fail "missing test slot registry: $SLOTS_FILE"

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

CHANNEL_ID="$(jq -r '.alertChannel.channelId // empty' "$SLOTS_FILE")"
CHANNEL_NAME="$(jq -r '.alertChannel.channelName // empty' "$SLOTS_FILE")"
TOKEN_ENV="$(jq -r '.slots[0].tokenEnvVar // empty' "$SLOTS_FILE")"
case "$CHANNEL_ID" in ''|*[!0-9]*) fail "invalid isolated alert channel id" ;; esac
[ "$CHANNEL_NAME" = "test-flywheel-alerts" ] \
  || fail "refusing non-isolated Discord channel: $CHANNEL_NAME"
[ -n "$TOKEN_ENV" ] || fail "test slot has no token env name"
TOKEN_VALUE="${!TOKEN_ENV:-}"
[ -n "$TOKEN_VALUE" ] || fail "provisioned token env is empty: $TOKEN_ENV"

PROD_BEFORE="$(snapshot_production_alert_state)"
MARKER="fly1364-refusal-$(date +%s)-$$"
STOCK_TITLE="FLY-1364-qa-${MARKER}"

export HOME="$QA_ROOT/home"
mkdir -p "$HOME/.flywheel/state" "$QA_ROOT/queue" "$QA_ROOT/deadletter" "$QA_ROOT/alerts"
export FLYWHEEL_CMUX_ALERT_BIN="$ROOT/scripts/lead-alert.sh"
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="$CHANNEL_ID"
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV="$TOKEN_ENV"
export FLYWHEEL_ALERT_TICKETS=1
export FLYWHEEL_ALERT_QUEUE_DIR="$QA_ROOT/queue"
export FLYWHEEL_ALERT_DEADLETTER_DIR="$QA_ROOT/deadletter"
export FLYWHEEL_CLAIMS_DB="$QA_ROOT/alerts/claims.db"

# Avoid even read access to resident cmux/tmux state while sourcing the host.
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$QA_ROOT/watcher.lock"
export VIEW_LEDGER="$QA_ROOT/view-ledger"
export VIEW_WAL_DIR="$QA_ROOT/view-wal"
export KEEPER_INVENTORY="$QA_ROOT/keeper-inventory"
export VIEW_ABSENT_STATE="$QA_ROOT/view-absent"
export ADOPTION_STATE="$QA_ROOT/adoption"
export FLYWHEEL_CMUX_FLAG_STATE="$QA_ROOT/flag-state"
export FLYWHEEL_CMUX_STOCK_ADOPTION=1
export FLYWHEEL_CMUX_LINKED_VIEW=0
export FLYWHEEL_CMUX_ORPHAN_REAPER=0
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1364-discord-qa-$$"

# shellcheck source=../flywheel-cmux-sync.sh
source "$SYNC"

# Capture and assert the production state machine's exact alert contract before
# decorating the one real QA post. The source kind/title/signature are embedded
# verbatim in the isolated Discord payload so the GET receipt proves all three,
# rather than proving only that an arbitrary message carried our marker.
EXPECTED_EVIDENCE="$(/usr/bin/python3 - "$STOCK_TITLE" <<'PY'
import hashlib
import sys
title = sys.argv[1]
rows = sorted([
    f"workspace:1364001|{title}",
    f"workspace:1364002|{title}",
])
print(hashlib.sha256("\\n".join(rows).encode()).hexdigest())
PY
)"
EXPECTED_SOURCE_TITLE="cmux stock cleanup refused"
EXPECTED_SIGNATURE="cmux_cleanup|stock-adoption|generation=fly1364-discord-generation|ref=multiple|normalized=${STOCK_TITLE}|evidence_sha256=${EXPECTED_EVIDENCE}|reason=ambiguous-normalized-title"
QA_TITLE="[QA FLY-1364] ${EXPECTED_SOURCE_TITLE}"
ALERT_CONTRACT="$QA_ROOT/alert-contract.json"
eval "$(declare -f flywheel_alert | sed '1s/flywheel_alert/flywheel_alert_impl/')"
flywheel_alert() {
  jq -n \
    --arg kind "$1" --arg severity "$2" --arg title "$3" \
    --arg body "$4" --arg signature "$5" \
    '{kind:$kind,severity:$severity,title:$title,body:$body,signature:$signature}' \
    > "$ALERT_CONTRACT"
  [[ "$1" == "cmux_cleanup" && "$2" == "warning" \
      && "$3" == "$EXPECTED_SOURCE_TITLE" && "$5" == "$EXPECTED_SIGNATURE" ]] \
    || fail "production refusal alert kind/title/signature drifted before delivery"
  flywheel_alert_impl "$1" "$2" "$QA_TITLE" \
    "$4 [QA FLY-1364] kind=$1 title=$3 signature=$5" "$5"
}

# Drive the actual stock-refusal state machine: duplicate normalized managed
# titles are ambiguous, so the current-generation lease holder must emit the
# refusal and perform zero cmux mutation. The marker travels inside the
# normalized title and therefore inside the production alert body/signature.
cmux_socket_identity() { printf 'fly1364-discord-generation\n'; }
get_cmux_workspaces_json() {
  printf '{"workspaces":[{"ref":"workspace:1364001","title":"%s"},{"ref":"workspace:1364002","title":"%s"}]}' \
    "$STOCK_TITLE" "$STOCK_TITLE"
}
MUTATION_LOG="$QA_ROOT/cmux-mutations"
: > "$MUTATION_LOG"
cmux_call() {
  printf '%s\n' "$*" >> "$MUTATION_LOG"
  return 1
}
cmux_call_guarded() {
  printf 'guarded:%s\n' "$*" >> "$MUTATION_LOG"
  GUARD_WAS_BLOCKED=1
  return 1
}
cmux() {
  printf 'direct:%s\n' "$*" >> "$MUTATION_LOG"
  return 1
}

SENT_AT_MS=$(( $(date +%s) * 1000 ))
acquire_mutator_lease qa_teardown || fail "could not acquire isolated refusal lease"
reap_unledgered_stock_workspaces
release_mutator_lease
[ ! -s "$MUTATION_LOG" ] || fail "ambiguous stock refusal attempted a cmux mutation"
[ ! -s "$VIEW_LEDGER" ] || fail "ambiguous stock refusal minted cleanup authority"
jq -e \
  --arg kind "cmux_cleanup" \
  --arg severity "warning" \
  --arg title "$EXPECTED_SOURCE_TITLE" \
  --arg signature "$EXPECTED_SIGNATURE" \
  '.kind == $kind and .severity == $severity and .title == $title and .signature == $signature' \
  "$ALERT_CONTRACT" >/dev/null \
  || fail "production refusal alert kind/title/signature drifted"

discord_get() {
  local url="$1"
  curl --fail --silent --show-error -A 'fly1364-qa/1.0' -K - "$url" <<EOF
header = "Authorization: Bot ${TOKEN_VALUE}"
EOF
}

MESSAGE_ID=""
RECEIVED=""
attempt=0
while [ "$attempt" -lt 15 ]; do
  RECENT="$(discord_get "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=25")" \
    || fail "Discord recent-message GET failed"
  RECEIVED="$(printf '%s' "$RECENT" | jq -c \
    --arg marker "$MARKER" --arg qaTitle "$QA_TITLE" \
    '[.[] | select(((.content // "") | contains($marker)) and ((.content // "") | contains($qaTitle)))][0] // empty')"
  if [ -n "$RECEIVED" ] && [ "$RECEIVED" != "null" ]; then
    MESSAGE_ID="$(printf '%s' "$RECEIVED" | jq -r '.id // empty')"
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
[ -n "$MESSAGE_ID" ] || fail "refusal alert was not received within 30s (marker=$MARKER)"

REFETCHED="$(discord_get "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}")" \
  || fail "Discord exact-message GET failed for $MESSAGE_ID"
printf '%s' "$REFETCHED" | jq -e \
  --arg id "$MESSAGE_ID" \
  --arg marker "$MARKER" \
  --arg qaTitle "**${QA_TITLE}**" \
  --arg kindHeader "(flywheel-eng-lead / cmux_cleanup)" \
  --arg kind "kind=cmux_cleanup" \
  --arg title "title=${EXPECTED_SOURCE_TITLE}" \
  --arg signature "signature=${EXPECTED_SIGNATURE}" \
  '.id == $id
   and ((.content // "") | contains($marker))
   and ((.content // "") | contains($qaTitle))
   and ((.content // "") | contains($kindHeader))
   and ((.content // "") | contains($kind))
   and ((.content // "") | contains($title))
   and ((.content // "") | contains($signature))' >/dev/null \
  || fail "exact GET did not preserve the expected QA kind/title/signature payload"

PROD_AFTER="$(snapshot_production_alert_state)"
[ "$PROD_BEFORE" = "$PROD_AFTER" ] \
  || fail "production alert queue/deadletter/claims state changed during isolated send"

RECEIVED_AT_MS=$(( $(date +%s) * 1000 ))
LATENCY_MS=$((RECEIVED_AT_MS - SENT_AT_MS))
TIMESTAMP="$(printf '%s' "$REFETCHED" | jq -r '.timestamp // empty')"
AUTHOR_ID="$(printf '%s' "$REFETCHED" | jq -r '.author.id // empty')"

echo "[PASS] real cmux_cleanup refusal alert sent and received in isolated #$CHANNEL_NAME"
echo "[PASS] exact Discord GET receipt id=$MESSAGE_ID latency_ms=$LATENCY_MS"
echo "[PASS] exact source and Discord payload kind/title/signature verified"
echo "[PASS] production stock-refusal state machine performed zero cmux/ledger mutation"
echo "[PASS] production alert state remained byte-observationally unchanged"
jq -nc \
  --arg issue "FLY-1364" \
  --arg channelId "$CHANNEL_ID" \
  --arg channelName "$CHANNEL_NAME" \
  --arg messageId "$MESSAGE_ID" \
  --arg marker "$MARKER" \
  --arg sourceKind "cmux_cleanup" \
  --arg sourceTitle "$EXPECTED_SOURCE_TITLE" \
  --arg sourceSignature "$EXPECTED_SIGNATURE" \
  --arg qaTitle "$QA_TITLE" \
  --arg timestamp "$TIMESTAMP" \
  --arg authorId "$AUTHOR_ID" \
  --argjson latencyMs "$LATENCY_MS" \
  '{issue:$issue,channelId:$channelId,channelName:$channelName,messageId:$messageId,
    marker:$marker,sourceKind:$sourceKind,sourceTitle:$sourceTitle,
    sourceSignature:$sourceSignature,qaTitle:$qaTitle,
    timestamp:$timestamp,authorId:$authorId,latencyMs:$latencyMs,
    exactGetVerified:true,exactContractVerified:true,stateMachineTriggered:true,zeroMutationVerified:true,
    productionAlertStateUnchanged:true}'
