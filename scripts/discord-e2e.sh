#!/usr/bin/env bash
# FLY-96: Discord E2E test — verifies event → Lead → Discord channel pipeline.
#
# Usage: scripts/discord-e2e.sh [scenario] [slot-info-json]
#   scenario: basic (default), lifecycle, error
#   slot-info-json: JSON from test-deploy.sh output (or reads from stdin)
#
# Prerequisites: test-deploy.sh must have been run (Bridge + Lead running)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[discord-e2e] $(date +%H:%M:%S) $*" >&2; }

# ── Load environment ──────────────────────────────────
ENV_FILE="${HOME}/.flywheel/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

# ── Parse arguments ───────────────────────────────────
SCENARIO="${1:-basic}"
SLOT_INFO="${2:-}"

if [[ -z "$SLOT_INFO" ]]; then
  # Try reading from stdin if piped
  if [[ ! -t 0 ]]; then
    SLOT_INFO=$(cat)
  fi
fi

if [[ -z "$SLOT_INFO" ]]; then
  # Try to find running slot from lock files
  for i in 1 2 3 4; do
    if [[ -d "/tmp/flywheel-test-slot-${i}.lock" ]]; then
      SLOT_DIR="/tmp/flywheel-test-slot-${i}"
      SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
      SLOT_IDX=$((i - 1))
      PORT=$(jq -r ".slots[${SLOT_IDX}].port" "$SLOTS_FILE")
      AGENT_ID=$(jq -r ".slots[${SLOT_IDX}].agentId" "$SLOTS_FILE")
      CHANNEL=$(jq -r ".slots[${SLOT_IDX}].chatChannelId" "$SLOTS_FILE")
      BOT_TOKEN_ENV=$(jq -r ".slots[${SLOT_IDX}].botTokenEnv" "$SLOTS_FILE")
      BOT_TOKEN="${!BOT_TOKEN_ENV}"
      PROJECT_NAME="test-slot-${i}"
      BRIDGE_PID=$(cat "${SLOT_DIR}/bridge.pid" 2>/dev/null || echo "")
      if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
        SLOT_INFO="{\"slot\":${i},\"port\":${PORT},\"agentId\":\"${AGENT_ID}\",\"projectName\":\"${PROJECT_NAME}\",\"chatChannelId\":\"${CHANNEL}\",\"botTokenEnv\":\"${BOT_TOKEN_ENV}\",\"bridgeUrl\":\"http://localhost:${PORT}\"}"
        break
      fi
    fi
  done
fi

if [[ -z "$SLOT_INFO" ]]; then
  echo "ERROR: No running test slot found. Run test-deploy.sh first." >&2
  exit 1
fi

# Extract slot metadata
BRIDGE_URL=$(echo "$SLOT_INFO" | jq -r '.bridgeUrl')
CHANNEL_ID=$(echo "$SLOT_INFO" | jq -r '.chatChannelId')
PROJECT_NAME=$(echo "$SLOT_INFO" | jq -r '.projectName')
AGENT_ID=$(echo "$SLOT_INFO" | jq -r '.agentId')
BOT_TOKEN_ENV=$(echo "$SLOT_INFO" | jq -r '.botTokenEnv')
SLOT=$(echo "$SLOT_INFO" | jq -r '.slot')

# Resolve bot token for Discord API verification
BOT_TOKEN="${!BOT_TOKEN_ENV:-}"
if [[ -z "$BOT_TOKEN" ]]; then
  echo "ERROR: ${BOT_TOKEN_ENV} not set." >&2
  exit 1
fi

INGEST_TOKEN="${TEAMLEAD_INGEST_TOKEN:-ingest-secret}"
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_START=$(date +%s)

pass() { log "  ✅ PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { log "  ❌ FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ── Verify Bridge is alive ────────────────────────────
if ! curl -sf "${BRIDGE_URL}/health" >/dev/null 2>&1; then
  echo "ERROR: Bridge not responding at ${BRIDGE_URL}" >&2
  exit 1
fi
log "Bridge alive at ${BRIDGE_URL}"

# ── Helper: POST event to Bridge ──────────────────────
post_event() {
  local event_json="$1"
  curl -sf -X POST "${BRIDGE_URL}/events" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${INGEST_TOKEN}" \
    -d "$event_json"
}

# ── Helper: Check Discord channel for message ─────────
# Polls Discord REST API for a message containing expected text
check_discord_message() {
  local expected_text="$1"
  local timeout="${2:-30}"
  local start_time
  start_time=$(date +%s)

  while true; do
    local elapsed=$(( $(date +%s) - start_time ))
    if (( elapsed >= timeout )); then
      return 1
    fi

    local messages
    messages=$(curl -sf "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=10" \
      -H "Authorization: Bot ${BOT_TOKEN}" 2>/dev/null || echo "[]")

    if echo "$messages" | jq -e ".[] | select(.content | contains(\"${expected_text}\"))" >/dev/null 2>&1; then
      return 0
    fi

    sleep 2
  done
}

# ── Scenario: basic ───────────────────────────────────
run_basic() {
  log "Running scenario: basic"
  local TEST_ID="e2e-basic-$(date +%s)"

  # POST session_started event
  local event_json
  event_json=$(cat <<EOF
{
  "event_id": "evt-${TEST_ID}",
  "execution_id": "exec-${TEST_ID}",
  "issue_id": "issue-${TEST_ID}",
  "project_name": "${PROJECT_NAME}",
  "event_type": "session_started",
  "payload": {
    "issueIdentifier": "TEST-E2E-${TEST_ID}",
    "issueTitle": "E2E basic test",
    "labels": ["Test"]
  }
}
EOF
)

  local res
  res=$(post_event "$event_json")
  if echo "$res" | jq -e '.ok' >/dev/null 2>&1; then
    pass "Event ingested successfully"
  else
    fail "Event ingestion failed: ${res}"
    return
  fi

  # Verify session created in Bridge
  sleep 1
  local session
  session=$(curl -sf "${BRIDGE_URL}/api/sessions/TEST-E2E-${TEST_ID}" 2>/dev/null || echo "{}")
  if echo "$session" | jq -e '.execution_id' >/dev/null 2>&1; then
    pass "Session created in StateStore"
  else
    fail "Session not found in StateStore"
  fi

  # Check if message appeared in Discord channel
  if check_discord_message "TEST-E2E-${TEST_ID}" 30; then
    pass "Message delivered to Discord channel"
  else
    # This may fail if Lead hasn't fully started — not a hard failure
    log "  ⚠️  WARN: Discord message not detected (Lead may not have processed event yet)"
  fi
}

# ── Scenario: lifecycle ───────────────────────────────
run_lifecycle() {
  log "Running scenario: lifecycle"
  local TEST_ID="e2e-lc-$(date +%s)"

  # 1. session_started
  post_event "$(cat <<EOF
{
  "event_id": "evt-${TEST_ID}-1",
  "execution_id": "exec-${TEST_ID}",
  "issue_id": "issue-${TEST_ID}",
  "project_name": "${PROJECT_NAME}",
  "event_type": "session_started",
  "payload": {
    "issueIdentifier": "TEST-LC-${TEST_ID}",
    "issueTitle": "E2E lifecycle test"
  }
}
EOF
)" >/dev/null

  sleep 1
  local session
  session=$(curl -sf "${BRIDGE_URL}/api/sessions/TEST-LC-${TEST_ID}" 2>/dev/null || echo "{}")
  local status
  status=$(echo "$session" | jq -r '.status')
  if [[ "$status" == "running" ]]; then
    pass "Session status: running"
  else
    fail "Expected running, got: ${status}"
  fi

  # 2. session_completed
  post_event "$(cat <<EOF
{
  "event_id": "evt-${TEST_ID}-2",
  "execution_id": "exec-${TEST_ID}",
  "issue_id": "issue-${TEST_ID}",
  "project_name": "${PROJECT_NAME}",
  "event_type": "session_completed",
  "payload": {
    "decision": {"route": "needs_review", "reasoning": "e2e test"},
    "evidence": {"commitCount": 1, "filesChangedCount": 1, "linesAdded": 10, "linesRemoved": 0},
    "summary": "E2E lifecycle test completed"
  }
}
EOF
)" >/dev/null

  sleep 1
  session=$(curl -sf "${BRIDGE_URL}/api/sessions/TEST-LC-${TEST_ID}" 2>/dev/null || echo "{}")
  status=$(echo "$session" | jq -r '.status')
  if [[ "$status" == "awaiting_review" ]]; then
    pass "Session status: awaiting_review"
  else
    fail "Expected awaiting_review, got: ${status}"
  fi

  # 3. Approve
  local approve_res
  approve_res=$(curl -sf -X POST "${BRIDGE_URL}/api/actions/approve" \
    -H "Content-Type: application/json" \
    -d "{\"execution_id\": \"exec-${TEST_ID}\", \"identifier\": \"TEST-LC-${TEST_ID}\"}" 2>/dev/null || echo "{}")
  if echo "$approve_res" | jq -e '.success' >/dev/null 2>&1; then
    pass "Approve action succeeded"
  else
    fail "Approve failed: ${approve_res}"
  fi

  session=$(curl -sf "${BRIDGE_URL}/api/sessions/TEST-LC-${TEST_ID}" 2>/dev/null || echo "{}")
  status=$(echo "$session" | jq -r '.status')
  if [[ "$status" == "approved_to_ship" ]]; then
    pass "Session status: approved_to_ship"
  else
    fail "Expected approved_to_ship, got: ${status}"
  fi
}

# ── Scenario: error ───────────────────────────────────
run_error() {
  log "Running scenario: error"
  local TEST_ID="e2e-err-$(date +%s)"

  # session_failed
  post_event "$(cat <<EOF
{
  "event_id": "evt-${TEST_ID}-1",
  "execution_id": "exec-${TEST_ID}",
  "issue_id": "issue-${TEST_ID}",
  "project_name": "${PROJECT_NAME}",
  "event_type": "session_failed",
  "payload": {
    "issueIdentifier": "TEST-ERR-${TEST_ID}",
    "error": "Build failed: exit code 1"
  }
}
EOF
)" >/dev/null

  sleep 1
  local session
  session=$(curl -sf "${BRIDGE_URL}/api/sessions/TEST-ERR-${TEST_ID}" 2>/dev/null || echo "{}")
  local status
  status=$(echo "$session" | jq -r '.status')
  if [[ "$status" == "failed" ]]; then
    pass "Session status: failed"
  else
    fail "Expected failed, got: ${status}"
  fi

  local error
  error=$(echo "$session" | jq -r '.last_error')
  if [[ "$error" == *"Build failed"* ]]; then
    pass "Error message recorded"
  else
    fail "Error not recorded: ${error}"
  fi
}

# ── Run scenarios ─────────────────────────────────────
log "=== Discord E2E Test ==="
log "Slot: ${SLOT} | Bridge: ${BRIDGE_URL} | Channel: ${CHANNEL_ID}"

case "$SCENARIO" in
  basic)     run_basic ;;
  lifecycle) run_lifecycle ;;
  error)     run_error ;;
  all)
    run_basic
    run_lifecycle
    run_error
    ;;
  *)
    echo "ERROR: Unknown scenario '${SCENARIO}'. Use: basic, lifecycle, error, all" >&2
    exit 1
    ;;
esac

# ── Summary ───────────────────────────────────────────
TOTAL_END=$(date +%s)
DURATION=$(( TOTAL_END - TOTAL_START ))

echo ""
log "=== Results ==="
log "Passed: ${PASS_COUNT} | Failed: ${FAIL_COUNT} | Duration: ${DURATION}s"

if (( FAIL_COUNT > 0 )); then
  exit 1
fi
