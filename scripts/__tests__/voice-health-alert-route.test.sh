#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2693-alert.XXXXXX")"
cleanup() {
  chmod -R u+w "$TMP" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

STATE_ROOT="$TMP/home/.flywheel"
PROJECTS="$TMP/projects.json"
PERMISSIONS="$TMP/permissions.json"
CAPTURE="$TMP/curl-capture"
RESPONSE_MODE="$TMP/curl-response"
mkdir -p "$STATE_ROOT" "$TMP/bin"
chmod 700 "$STATE_ROOT"

printf '%s\n' '[
  {"projectName":"flywheel","projectRoot":"/fixture/flywheel","shuttlePrimaryEngineeringLeadId":"infra-lead","leads":[{"agentId":"infra-lead","chatChannel":"100000000000000001","botTokenEnv":"INFRA_TOKEN","botUserId":"200000000000000001","match":{"labels":["Engineering"]},"summaryRole":"aggregator"}]},
  {"projectName":"alpha","projectRoot":"/fixture/alpha","shuttleEngineeringLeadId":"alpha-lead","leads":[{"agentId":"alpha-lead","chatChannel":"100000000000000002","match":{"labels":["Engineering"]},"summaryRole":"none"}]}
]' >"$PROJECTS"
printf '%s\n' '{"guildId":"900000000000000001","memberId":"200000000000000009","memberRoleIds":[],"roles":[{"id":"900000000000000001","permissions":"3072"}],"overwrites":[]}' >"$PERMISSIONS"

cat >"$TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
out="" url="" body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    -K) cat >/dev/null; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\t%s\n' "$url" "$body" >>"$CURL_CAPTURE"
case "$(cat "$CURL_RESPONSE_MODE")" in
  sent)
    printf '%s\n' '{"id":"300000000000000001"}' >"$out"
    printf '200'
    ;;
  rate)
    printf '%s\n' '{"message":"rate limited"}' >"$out"
    printf '429'
    ;;
  unknown)
    : >"$out"
    printf '000'
    exit 7
    ;;
esac
CURL
chmod +x "$TMP/bin/curl"

REAL_PYTHON="$(command -v python3)"
export REAL_PYTHON
cat >"$TMP/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${*: -1}" == record-delivery && "${REWRITE_SENT_RECEIPT:-0}" == 1 ]]; then
  payload="$(cat)"
  if jq -e '.state == "sent"' <<<"$payload" >/dev/null; then
    jq -c '.state = "queued_transient" | del(.channelId, .messageId)' <<<"$payload" |
      exec "$REAL_PYTHON" "$@"
  fi
  printf '%s' "$payload" | exec "$REAL_PYTHON" "$@"
fi
exec "$REAL_PYTHON" "$@"
PYTHON
chmod +x "$TMP/bin/python3"

export FLYWHEEL_STATE_DIR="$STATE_ROOT"
export FLYWHEEL_PROJECTS_FILE="$PROJECTS"
export FLYWHEEL_SYSTEM_ALERT_ENV_FILE=/dev/null
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV=UNIFIED_ALERT_TOKEN
export UNIFIED_ALERT_TOKEN=fixture-token-never-print
export INFRA_TOKEN=fixture-route-token-never-print
export SHUTTLE_ROUTE_PERMISSION_FIXTURE="$PERMISSIONS"
export CURL_CAPTURE="$CAPTURE"
export CURL_RESPONSE_MODE="$RESPONSE_MODE"
export PATH="$TMP/bin:$PATH"

HELPER="$ROOT/scripts/lib/voice-health.py"
helper() {
  local command="$1" payload="$2"
  printf '%s' "$payload" | python3 "$HELPER" --state-root "$STATE_ROOT" "$command"
}

helper init '{}' >/dev/null
BOOT="$(helper register-boot '{"bootId":"11111111-1111-4111-8111-111111111111","bootAt":"2026-09-18T20:00:00.000Z"}')"
GENERATION="$(printf '%s' "$BOOT" | jq -r .generation)"
SOURCE_ID="$(printf '%s' "$BOOT" | jq -r .sourceId)"
DEMAND_IDENTITIES='[{"demandId":"meeting-1"}]'
DEMAND_DIGEST="$(printf '%s' "$DEMAND_IDENTITIES" | shasum -a 256 | awk '{print $1}')"
helper record-demand "{\"demandSourceId\":\"22222222-2222-4222-8222-222222222222\",\"revision\":1,\"observedAt\":\"2026-09-18T20:00:01.000Z\",\"state\":\"required\",\"digest\":\"$DEMAND_DIGEST\",\"identities\":$DEMAND_IDENTITIES}" >/dev/null
for seq in 1 2 3; do
  OPENED="$(helper record-result "{\"generation\":$GENERATION,\"producerEventSeq\":$seq,\"resultKind\":\"poll_failed\",\"observedAt\":\"2026-09-18T20:00:0$((seq + 1)).000Z\",\"reasonClass\":\"bridge_connect_failed\",\"operation\":\"desired\"}")"
done
INTENT_ID="$(printf '%s' "$OPENED" | jq -r .notification.intentId)"

# The source appends bounded heartbeat/demand changes over time. Alert delivery
# must page to the final authoritative projection instead of assuming it is in
# the first 200 changes.
for _change in $(seq 1 205); do
  helper record-demand "{\"demandSourceId\":\"22222222-2222-4222-8222-222222222222\",\"revision\":1,\"observedAt\":\"2026-09-18T20:00:05.000Z\",\"state\":\"required\",\"digest\":\"$DEMAND_DIGEST\",\"identities\":$DEMAND_IDENTITIES,\"refreshObservedAt\":true}" >/dev/null
done
# Seed older valid observations in one helper transaction. Delivery must not
# acquire a permanent age limit when the history exceeds 32 pages either.
python3 - "$HELPER" "$STATE_ROOT" <<'PY'
import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("voice_health", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with module.open_store(Path(sys.argv[2])) as (database, _, service_id, _):
    def append_history():
        for _ in range(6400):
            module._append_change(database, service_id, "2026-09-18T20:00:05.000Z")
        return {}
    module._write_transaction(database, append_history)
PY

send_voice() {
  /bin/bash "$ROOT/scripts/lead-alert.sh" --project flywheel --lead voice-health \
    --kind voice_daemon_unhealthy --severity warning --voice-intent "$INTENT_ID" \
    --strict-delivery
}

export_final() {
  local cursor=0 page
  for _page in $(seq 1 32); do
    page="$(helper export "{\"sourceId\":\"$SOURCE_ID\",\"afterCursor\":$cursor,\"limit\":200}")"
    if [[ "$(jq -r .hasMore <<<"$page")" == false ]]; then
      printf '%s' "$page"
      return 0
    fi
    cursor="$(jq -r .eventHighWater <<<"$page")"
  done
  return 1
}

# A definitive 429 remains in the voice source ledger for retry and never
# creates a generic LeadAlertNotifier queue record.
printf 'rate\n' >"$RESPONSE_MODE"
RATE_RECEIPT="$(send_voice || true)"
case "$RATE_RECEIPT" in
  "queued_transient channel_id=100000000000000001 binding_digest="*) ;;
  *) echo "unexpected rate receipt: $RATE_RECEIPT" >&2; exit 1 ;;
esac
if find "$STATE_ROOT/state/release-readiness/gaps" -type f -name '*.intent.json' -print -quit 2>/dev/null | grep -q .; then
  echo "voice delivery must not create a release-readiness capture gap" >&2
  exit 1
fi
EXPORT="$(export_final)"
jq -e --arg id "$INTENT_ID" '.notifications[] | select(.intentId == $id and .state == "queued_transient")' <<<"$EXPORT" >/dev/null
if find "$STATE_ROOT" -path '*/alert-queue/*.json' -print -quit | grep -q .; then
  echo "voice delivery must not trust the generic persisted alert queue" >&2
  exit 1
fi

# A Discord POST whose source receipt cannot be recorded as sent must not claim
# that its parsed message id was durably recorded.
printf 'sent\n' >"$RESPONSE_MODE"
export REWRITE_SENT_RECEIPT=1
UNKNOWN_RECEIPT="$(send_voice || true)"
case "$UNKNOWN_RECEIPT" in
  "delivery_unknown channel_id=100000000000000001 binding_digest="*)
    if [[ "$UNKNOWN_RECEIPT" == *message_id=* ]]; then
      echo "non-sent receipt must not claim a message id: $UNKNOWN_RECEIPT" >&2
      exit 1
    fi
    ;;
  *) echo "unexpected unknown receipt: $UNKNOWN_RECEIPT" >&2; exit 1 ;;
esac
unset REWRITE_SENT_RECEIPT
EXPORT="$(export_final)"
jq -e --arg id "$INTENT_ID" '.notifications[] | select(.intentId == $id and .state == "queued_transient" and .messageId == null)' <<<"$EXPORT" >/dev/null

# Retry posts once, parses the Discord message id, and records a real source
# receipt. Repeating the same episode cannot post again.
SENT_RECEIPT="$(send_voice)"
case "$SENT_RECEIPT" in
  "sent channel_id=100000000000000001 binding_digest="*" message_id=300000000000000001") ;;
  *) echo "unexpected sent receipt: $SENT_RECEIPT" >&2; exit 1 ;;
esac
EXPORT="$(export_final)"
jq -e --arg id "$INTENT_ID" '.notifications[] | select(.intentId == $id and .state == "sent" and .channelId == "100000000000000001" and .messageId == "300000000000000001")' <<<"$EXPORT" >/dev/null
SECOND_RECEIPT="$(send_voice || true)"
case "$SECOND_RECEIPT" in
  "duplicate channel_id=100000000000000001 binding_digest="*) ;;
  *) echo "unexpected duplicate receipt: $SECOND_RECEIPT" >&2; exit 1 ;;
esac
DISCORD_POSTS="$(grep -c '^https://discord.com/api/v10/channels/100000000000000001/messages' "$CAPTURE")"
if [[ "$DISCORD_POSTS" != 3 ]]; then
  echo "expected 3 Discord POSTs, got $DISCORD_POSTS" >&2
  exit 1
fi
grep -Fq 'Voice daemon unhealthy' "$CAPTURE"
if grep -Eq 'fixture-token-never-print|fixture-route-token-never-print' "$CAPTURE"; then
  echo "voice alert exposed a sender token" >&2
  exit 1
fi

# A recovered episode is cancelled in the source and cannot be revived by a
# delayed sender invocation.
helper record-result "{\"generation\":$GENERATION,\"producerEventSeq\":4,\"resultKind\":\"idle_success\",\"observedAt\":\"2026-09-18T20:00:14.000Z\",\"countDelta\":1}" >/dev/null
for seq in 5 6 7; do
  RECOVERY_OPEN="$(helper record-result "{\"generation\":$GENERATION,\"producerEventSeq\":$seq,\"resultKind\":\"poll_failed\",\"observedAt\":\"2026-09-18T20:00:$((seq + 10)).000Z\",\"reasonClass\":\"bridge_connect_failed\",\"operation\":\"desired\"}")"
done
NEXT_INTENT="$(printf '%s' "$RECOVERY_OPEN" | jq -r '.notification.intentId // empty')"
if [[ -n "$NEXT_INTENT" ]]; then
  helper record-result "{\"generation\":$GENERATION,\"producerEventSeq\":8,\"resultKind\":\"idle_success\",\"observedAt\":\"2026-09-18T20:00:30.000Z\",\"countDelta\":1}" >/dev/null
  INTENT_ID="$NEXT_INTENT"
  RECOVERED_RECEIPT="$(send_voice || true)"
  case "$RECOVERED_RECEIPT" in
    "duplicate channel_id=100000000000000001 binding_digest="*) ;;
    *) echo "unexpected recovered receipt: $RECOVERED_RECEIPT" >&2; exit 1 ;;
  esac
  DISCORD_POSTS="$(grep -c '^https://discord.com/api/v10/channels/100000000000000001/messages' "$CAPTURE")"
  if [[ "$DISCORD_POSTS" != 3 ]]; then
    echo "recovered intent posted unexpectedly" >&2
    exit 1
  fi
fi

printf '[PASS] voice health intent validates source, route, permission, receipt, retry, and recovery\n'
