#!/usr/bin/env bash
# FLY-96: Deploy a test slot (Bridge + Lead) for Discord E2E testing.
#
# Usage: scripts/test-deploy.sh [slot-number]
#   If slot-number is provided, claims that specific slot.
#   If omitted, claims the first available slot from the pool.
#
# Output: JSON with slot metadata (slot, port, channel, pids)
# Prerequisites: ~/.flywheel/.env with TEST_BOT_TOKEN_N, ~/.flywheel/test-slots.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load environment ──────────────────────────────────
ENV_FILE="${HOME}/.flywheel/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: ${ENV_FILE} not found. Create it with TEST_BOT_TOKEN_N values." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
if [[ ! -f "$SLOTS_FILE" ]]; then
  echo "ERROR: ${SLOTS_FILE} not found. Copy from scripts/test-slots.example.json and fill in values." >&2
  exit 1
fi

GUILD_ID=$(jq -r '.guildId' "$SLOTS_FILE")
TOTAL_SLOTS=$(jq '.slots | length' "$SLOTS_FILE")

log() { echo "[test-deploy] $(date +%H:%M:%S) $*" >&2; }

# ── Slot allocation ───────────────────────────────────
claim_slot() {
  local slot_num="$1"
  local lockfile="/tmp/flywheel-test-slot-${slot_num}.lock"

  if mkdir "$lockfile" 2>/dev/null; then
    # PID is updated later to Bridge PID (long-lived) — see Step 5
    echo "claiming" > "$lockfile/pid"
    return 0
  fi

  # Check if existing lock is stale (Bridge PID dead)
  local lock_pid
  lock_pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
  if [[ "$lock_pid" == "claiming" ]]; then
    # Another deploy is in-progress — check if lock is old (>5 min = likely crashed deploy)
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -f %m "$lockfile/pid" 2>/dev/null || echo "0") ))
    if (( lock_age > 300 )); then
      log "Reclaiming stale claiming lock ${slot_num} (${lock_age}s old) — running full teardown first"
      # A prior deploy crashed before writing Bridge PID — Lead supervisor may still be
      # running from Step 1. Teardown clears Lead/session/workspace/CommDB.
      if ! bash "${SCRIPT_DIR}/test-teardown.sh" "$slot_num" >&2; then
        log "WARN: teardown of stale claiming slot ${slot_num} reported errors — continuing"
      fi
      mkdir "$lockfile" 2>/dev/null || return 1
      echo "claiming" > "$lockfile/pid"
      return 0
    fi
    return 1
  fi
  if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
    log "Reclaiming stale slot ${slot_num} (PID ${lock_pid} dead) — running full teardown first"
    # Bridge is dead but Lead supervisor, session-id, CommDB, workspace may still exist.
    # Reusing the slot without clearing them lets the new Bridge inherit the old Lead's
    # inbox-ready lease, --resume into the prior Claude session, and mix CommDB state
    # across tests. Run full teardown to guarantee a clean slot before reclaiming.
    if ! bash "${SCRIPT_DIR}/test-teardown.sh" "$slot_num" >&2; then
      log "WARN: teardown of stale slot ${slot_num} reported errors — continuing"
    fi
    # Teardown removed the lock; recreate it as "claiming".
    mkdir "$lockfile" 2>/dev/null || return 1
    echo "claiming" > "$lockfile/pid"
    return 0
  fi

  return 1
}

REQUESTED_SLOT="${1:-}"
SLOT=""

if [[ -n "$REQUESTED_SLOT" ]]; then
  if claim_slot "$REQUESTED_SLOT"; then
    SLOT="$REQUESTED_SLOT"
  else
    echo "ERROR: Slot ${REQUESTED_SLOT} is in use." >&2
    exit 1
  fi
else
  for i in $(seq 1 "$TOTAL_SLOTS"); do
    if claim_slot "$i"; then
      SLOT="$i"
      break
    fi
  done
fi

# Cleanup trap: release slot lock if deploy fails before Bridge PID is written
cleanup_on_failure() {
  local lock="/tmp/flywheel-test-slot-${SLOT}.lock"
  local lock_pid
  lock_pid=$(cat "$lock/pid" 2>/dev/null || echo "")
  # Only clean up if still in "claiming" state (Bridge PID not yet written)
  if [[ "$lock_pid" == "claiming" ]]; then
    log "Deploy interrupted — releasing slot ${SLOT} lock"
    rm -rf "$lock"
  fi
}
trap cleanup_on_failure EXIT

if [[ -z "$SLOT" ]]; then
  echo "ERROR: All ${TOTAL_SLOTS} test slots are in use." >&2
  exit 1
fi

log "Claimed slot ${SLOT}"

# ── Read slot config ──────────────────────────────────
# Schema matches ~/.flywheel/test-slots.json (FLY-96):
#   bridgePort, botName, tokenEnvVar, botAppId, channelId
# AGENT_ID is derived from botName (1:1) — simple and deterministic.
SLOT_IDX=$((SLOT - 1))
SLOT_PORT=$(jq -r ".slots[${SLOT_IDX}].bridgePort" "$SLOTS_FILE")
AGENT_ID=$(jq -r ".slots[${SLOT_IDX}].botName" "$SLOTS_FILE")
BOT_TOKEN_ENV=$(jq -r ".slots[${SLOT_IDX}].tokenEnvVar" "$SLOTS_FILE")
BOT_ID=$(jq -r ".slots[${SLOT_IDX}].botAppId" "$SLOTS_FILE")
CHAT_CHANNEL_ID=$(jq -r ".slots[${SLOT_IDX}].channelId" "$SLOTS_FILE")

# Validate required fields (jq returns literal "null" string when missing)
for pair in "bridgePort:${SLOT_PORT}" "botName:${AGENT_ID}" "tokenEnvVar:${BOT_TOKEN_ENV}" "botAppId:${BOT_ID}" "channelId:${CHAT_CHANNEL_ID}"; do
  field="${pair%%:*}"
  value="${pair#*:}"
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo "ERROR: slots[${SLOT_IDX}].${field} missing or null in ${SLOTS_FILE}" >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
done

# Resolve bot token from env var name
TEST_BOT_TOKEN="${!BOT_TOKEN_ENV:-}"
if [[ -z "$TEST_BOT_TOKEN" ]]; then
  echo "ERROR: ${BOT_TOKEN_ENV} not set in environment." >&2
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# ── Create temp directories ───────────────────────────
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
mkdir -p "${SLOT_DIR}/discord-state"
mkdir -p "${SLOT_DIR}/project"

# ── Generate DISCORD_STATE_DIR files ──────────────────
# .env with test bot token
cat > "${SLOT_DIR}/discord-state/.env" <<EOF
DISCORD_BOT_TOKEN=${TEST_BOT_TOKEN}
EOF
chmod 600 "${SLOT_DIR}/discord-state/.env"

# access.json — only the test channel
cat > "${SLOT_DIR}/discord-state/access.json" <<EOF
{"dmPolicy":"allowlist","allowFrom":[],"allowBots":["${BOT_ID}"],"groups":{"${CHAT_CHANNEL_ID}":{"requireMention":false,"allowFrom":[]}},"pending":{}}
EOF

# ── Generate test identity.md ─────────────────────────
cat > "${SLOT_DIR}/test-identity.md" <<EOF
# Test Lead: ${AGENT_ID}

You are a test Lead agent running in slot ${SLOT}.
Your only channel is <#${CHAT_CHANNEL_ID}>.
This is an automated test environment — do not interact with production channels.
EOF

# ── Generate FLYWHEEL_PROJECTS JSON ───────────────────
TEST_PROJECT_NAME="test-slot-${SLOT}"
FLYWHEEL_PROJECTS="[{
  \"projectName\": \"${TEST_PROJECT_NAME}\",
  \"projectRoot\": \"${SLOT_DIR}/project\",
  \"projectRepo\": \"test/test-slot-${SLOT}\",
  \"leads\": [{
    \"agentId\": \"${AGENT_ID}\",
    \"chatChannel\": \"${CHAT_CHANNEL_ID}\",
    \"match\": {\"labels\": [\"*\"]}
  }]
}]"

log "Starting test Lead: ${AGENT_ID} (project: ${TEST_PROJECT_NAME})"

# ── Step 1: Start test Lead (background) ─────────────
# env -u clears inherited production token, then sets test token explicitly (D8)
env -u DISCORD_BOT_TOKEN \
  DISCORD_BOT_TOKEN="${TEST_BOT_TOKEN}" \
  DISCORD_GUILD_ID="${GUILD_ID}" \
  BRIDGE_URL="http://localhost:${SLOT_PORT}" \
  DISCORD_STATE_DIR="${SLOT_DIR}/discord-state" \
  AGENT_SOURCE="${SLOT_DIR}/test-identity.md" \
  bash "${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh" \
    "${AGENT_ID}" "${SLOT_DIR}/project" "${TEST_PROJECT_NAME}" &
LEAD_BG_PID=$!
log "Lead background PID: ${LEAD_BG_PID}"

# ── Step 2: Wait for Lead inbox-ready lease ───────────
LEASE_DIR="${HOME}/.flywheel/comm/${TEST_PROJECT_NAME}"
LEASE_FILE="${LEASE_DIR}/.inbox-ready-${AGENT_ID}"
log "Waiting for lease: ${LEASE_FILE}"

LEAD_READY=false
for i in $(seq 1 60); do
  if [[ -f "$LEASE_FILE" ]]; then
    LEASE_PID=$(jq -r '.pid' "$LEASE_FILE" 2>/dev/null || echo "")
    if [[ -n "$LEASE_PID" ]] && kill -0 "$LEASE_PID" 2>/dev/null; then
      log "Lead ${AGENT_ID} ready (lease alive, PID ${LEASE_PID})"
      LEAD_READY=true
      break
    fi
  fi
  # Check if Lead process died
  if ! kill -0 "$LEAD_BG_PID" 2>/dev/null; then
    log "ERROR: Lead process died before becoming ready"
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
  sleep 2
done

if [[ "$LEAD_READY" != "true" ]]; then
  log "ERROR: Lead did not become ready within 120 seconds"
  kill "$LEAD_BG_PID" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# ── Step 3: Start test Bridge (fixed port, :memory: StateStore) ──
# Unset TEAMLEAD_API_TOKEN so /api/* routes don't require auth in test
log "Starting test Bridge on port ${SLOT_PORT}"
env -u TEAMLEAD_API_TOKEN \
  TEAMLEAD_PORT="${SLOT_PORT}" \
  TEAMLEAD_DB_PATH=":memory:" \
  FLYWHEEL_PROJECTS="${FLYWHEEL_PROJECTS}" \
  npx tsx "${REPO_ROOT}/scripts/run-bridge.ts" &
BRIDGE_PID=$!
echo "$BRIDGE_PID" > "${SLOT_DIR}/bridge.pid"
# Update slot lock with long-lived Bridge PID (prevents stale-lock misdetection)
echo "$BRIDGE_PID" > "/tmp/flywheel-test-slot-${SLOT}.lock/pid"
# Bridge PID written — disable failure cleanup trap
trap - EXIT
log "Bridge PID: ${BRIDGE_PID}"

# ── Step 4: Wait for Bridge HTTP ready ────────────────
BRIDGE_READY=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${SLOT_PORT}/health" >/dev/null 2>&1; then
    log "Bridge ready on port ${SLOT_PORT}"
    BRIDGE_READY=true
    break
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "ERROR: Bridge process died"
    kill "$LEAD_BG_PID" 2>/dev/null || true
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
  sleep 1
done

if [[ "$BRIDGE_READY" != "true" ]]; then
  log "ERROR: Bridge did not become ready within 30 seconds"
  kill "$BRIDGE_PID" 2>/dev/null || true
  kill "$LEAD_BG_PID" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# ── Step 5: Record PIDs ──────────────────────────────
# Lead supervisor PID is written by claude-lead.sh to:
#   ~/.flywheel/pids/<project-name>-<lead-id>.pid
# We also record Bridge PID locally.
LEAD_PID_FILE="${HOME}/.flywheel/pids/${TEST_PROJECT_NAME}-${AGENT_ID}.pid"

log "Test environment ready!"
log "  Slot: ${SLOT}"
log "  Port: ${SLOT_PORT}"
log "  Agent: ${AGENT_ID}"
log "  Channel: ${CHAT_CHANNEL_ID}"
log "  Bridge PID: ${BRIDGE_PID}"
log "  Lead PID file: ${LEAD_PID_FILE}"

# Output JSON for downstream scripts
cat <<EOF
{
  "slot": ${SLOT},
  "port": ${SLOT_PORT},
  "agentId": "${AGENT_ID}",
  "projectName": "${TEST_PROJECT_NAME}",
  "chatChannelId": "${CHAT_CHANNEL_ID}",
  "botTokenEnv": "${BOT_TOKEN_ENV}",
  "bridgePid": ${BRIDGE_PID},
  "leadPidFile": "${LEAD_PID_FILE}",
  "slotDir": "${SLOT_DIR}",
  "bridgeUrl": "http://localhost:${SLOT_PORT}"
}
EOF
