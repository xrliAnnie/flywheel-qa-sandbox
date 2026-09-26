#!/usr/bin/env bash
# FLY-529 roundtable-mirror smoke — proves the QA Room can host >=2 test leads
# in an isolated roundtable channel + the Bridge-side auto-thread manager fires,
# with the runs table and inbound cursor isolated from production.
#
# AC1: deploy host(1)+member(2) --mode roundtable; a topic posted by the member
#      (non-host) bot makes the host Bridge auto-create a thread + a
#      roundtable_topic_threads row.
# AC2: the inbound cursor lands under the slot dir; production cursor untouched.
# AC3: the manager adds the member bot to the new thread (room usable by 2 leads).
#
# Requires: ~/.flywheel/test-slots.json with a setup roundtableChannel
# (run scripts/setup-roundtable-channel.sh first) + TEST_BOT_TOKEN_* in
# ~/.flywheel/.env + LINEAR_API_KEY (test-deploy preflight).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${HOME}/.flywheel/.env"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
PROD_CURSOR="${HOME}/.flywheel/roundtable-inbound-cursor.json"

log() { echo "[qa-529-rt] $(date +%H:%M:%S) $*"; }
fail() { echo "[qa-529-rt] FAIL: $*" >&2; FAILED=1; }
FAILED=0

[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: ${SLOTS_FILE} missing" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: ${ENV_FILE} missing" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

RT_CHANNEL=$(jq -r '.roundtableChannel.channelId // empty' "$SLOTS_FILE")
if [[ -z "$RT_CHANNEL" || "$RT_CHANNEL" == "<test-leads-roundtable-channel-id>" ]]; then
  echo "ERROR: roundtableChannel not configured. Run scripts/setup-roundtable-channel.sh <channel-id> first." >&2
  exit 2
fi
HOST_SLOT=$(jq -r '.roundtableChannel.hostSlot // 1' "$SLOTS_FILE")
MEMBER_SLOT=$(jq -r '.roundtableChannel.memberSlots[0] // 2' "$SLOTS_FILE")
MEMBER_TOKEN_VAR=$(jq -r --argjson i "$((MEMBER_SLOT - 1))" '.slots[$i].tokenEnvVar' "$SLOTS_FILE")
MEMBER_BOT_ID=$(jq -r --argjson i "$((MEMBER_SLOT - 1))" '.slots[$i].botAppId' "$SLOTS_FILE")
MEMBER_TOKEN="${!MEMBER_TOKEN_VAR:-}"
HOST_DB="/tmp/flywheel-test-slot-${HOST_SLOT}/teamlead.db"
HOST_CURSOR="/tmp/flywheel-test-slot-${HOST_SLOT}/roundtable-inbound-cursor.json"

cleanup() {
  log "teardown"
  bash "${SCRIPT_DIR}/test-teardown.sh" "$HOST_SLOT"  >/dev/null 2>&1 || true
  bash "${SCRIPT_DIR}/test-teardown.sh" "$MEMBER_SLOT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Baseline production cursor mtime (isolation check).
PROD_CURSOR_MTIME_BEFORE="missing"
[[ -f "$PROD_CURSOR" ]] && PROD_CURSOR_MTIME_BEFORE=$(stat -f %m "$PROD_CURSOR" 2>/dev/null || echo "err")

log "deploy host slot ${HOST_SLOT} (--mode roundtable)"
bash "${SCRIPT_DIR}/test-deploy.sh" --mode roundtable "$HOST_SLOT" >/dev/null || { echo "deploy host failed" >&2; exit 1; }
log "deploy member slot ${MEMBER_SLOT} (--mode roundtable)"
bash "${SCRIPT_DIR}/test-deploy.sh" --mode roundtable "$MEMBER_SLOT" >/dev/null || { echo "deploy member failed" >&2; exit 1; }

# Post a topic with the MEMBER (non-host) bot — the manager skips its own
# (host) bot's top-level messages (echo immunity), so a host-authored topic
# would not fire (FLY-529 / Codex R1 #3).
log "post topic in roundtable as member bot (slot ${MEMBER_SLOT})"
TOPIC="📋 QA-529 roundtable smoke $(date +%s) — auto-thread please"
POST=$(curl -s -X POST -H "Authorization: Bot ${MEMBER_TOKEN}" -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$TOPIC" '{content:$c}')" \
  "https://discord.com/api/v10/channels/${RT_CHANNEL}/messages" 2>/dev/null || echo "")
TOPIC_MSG_ID=$(jq -r '.id // empty' <<<"$POST" 2>/dev/null || echo "")
[[ -n "$TOPIC_MSG_ID" ]] || { echo "ERROR: could not post topic — ${POST}" >&2; exit 1; }
log "topic msg id ${TOPIC_MSG_ID}; waiting for auto-thread..."

# AC1: poll the host runs table for the row keyed by (channel, source message).
ROW_OK=0; THREAD_ID=""
for _ in $(seq 1 40); do
  if [[ -f "$HOST_DB" ]]; then
    THREAD_ID=$(sqlite3 "$HOST_DB" \
      "SELECT thread_id FROM roundtable_topic_threads WHERE channel_id='${RT_CHANNEL}' AND source_message_id='${TOPIC_MSG_ID}';" 2>/dev/null || echo "")
    [[ -n "$THREAD_ID" ]] && { ROW_OK=1; break; }
  fi
  sleep 3
done
if (( ROW_OK )); then
  log "PASS AC1: roundtable_topic_threads row present (thread ${THREAD_ID})"
else
  fail "AC1: no roundtable_topic_threads row for msg ${TOPIC_MSG_ID} in ${HOST_DB}"
fi

# AC1 (Discord): the thread exists.
if [[ -n "$THREAD_ID" ]]; then
  TH=$(curl -s -H "Authorization: Bot ${MEMBER_TOKEN}" \
    "https://discord.com/api/v10/channels/${THREAD_ID}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
  [[ "$TH" == "200" ]] && log "PASS AC1: Discord thread ${THREAD_ID} exists" || fail "AC1: thread ${THREAD_ID} not reachable (HTTP ${TH})"

  # AC3: member bot is a thread member (manager added it).
  TM=$(curl -s -H "Authorization: Bot ${MEMBER_TOKEN}" \
    "https://discord.com/api/v10/channels/${THREAD_ID}/thread-members/${MEMBER_BOT_ID}" \
    -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
  [[ "$TM" == "200" ]] && log "PASS AC3: member bot ${MEMBER_BOT_ID} is in the thread" \
    || fail "AC3: member bot ${MEMBER_BOT_ID} not added to thread (HTTP ${TM})"
fi

# AC2: cursor isolation — host cursor under slot dir; production cursor untouched.
[[ -f "$HOST_CURSOR" ]] && log "PASS AC2: host cursor at ${HOST_CURSOR}" \
  || fail "AC2: expected isolated cursor at ${HOST_CURSOR}"
PROD_CURSOR_MTIME_AFTER="missing"
[[ -f "$PROD_CURSOR" ]] && PROD_CURSOR_MTIME_AFTER=$(stat -f %m "$PROD_CURSOR" 2>/dev/null || echo "err")
if [[ "$PROD_CURSOR_MTIME_BEFORE" == "$PROD_CURSOR_MTIME_AFTER" ]]; then
  log "PASS AC2: production cursor untouched (mtime ${PROD_CURSOR_MTIME_BEFORE})"
else
  fail "AC2: production cursor changed (${PROD_CURSOR_MTIME_BEFORE} -> ${PROD_CURSOR_MTIME_AFTER})"
fi

echo
[[ "$FAILED" -eq 0 ]] && { log "ROUNDTABLE SMOKE: PASS"; exit 0; } || { log "ROUNDTABLE SMOKE: FAIL"; exit 1; }
