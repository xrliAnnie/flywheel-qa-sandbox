#!/usr/bin/env bash
# Start the slot-1 Lead supervisor from a tmux-spawned process. This keeps the
# production split-brain/process-table safety checks intact when the invoking
# Codex shell itself is process-table sandboxed.
set -euo pipefail

SLOT_DIR="/tmp/flywheel-test-slot-1"
REPO_ROOT="/Users/xiaorongli/Dev/flywheel-FLY-1439"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
ENV_FILE="${HOME}/.flywheel/.env"
PROJECT="test-slot-1"
LEAD_ID="flywheel-test-1"
TOKEN_ENV="TEST_BOT_TOKEN_1"

# shellcheck disable=SC1090
source "$ENV_FILE"
TOKEN="${!TOKEN_ENV:?TEST_BOT_TOKEN_1 is required}"
GUILD_ID="$(jq -r '.guildId' "$SLOTS_FILE")"
PROJECTS="$(<"${SLOT_DIR}/flywheel-projects.json")"

exec env \
  -u LEAD_WORKSPACE \
  -u FLYWHEEL_LEAD_MODEL \
  -u FLYWHEEL_LEAD_EFFORT \
  DISCORD_BOT_TOKEN="$TOKEN" \
  DISCORD_GUILD_ID="$GUILD_ID" \
  BRIDGE_URL="http://localhost:19871" \
  DISCORD_STATE_DIR="${SLOT_DIR}/discord-state" \
  AGENT_SOURCE="${SLOT_DIR}/test-identity.md" \
  FLYWHEEL_LEAD_ROLE="cos" \
  FLYWHEEL_PROJECTS="$PROJECTS" \
  LEAD_WORKSPACE="${SLOT_DIR}/lead-workspace" \
  CLAUDE_CONFIG_DIR="${SLOT_DIR}/claude-config" \
  TEST_SKIP_PLUGIN_FORK_CHECK=1 \
  TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="${SLOT_DIR}/claude-config" \
  FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0 \
  FLYWHEEL_RECEIPT_WINDOW_P0_MIN=2 \
  FLYWHEEL_RECEIPT_WINDOW_P1_MIN=2 \
  FLYWHEEL_DELIVERY_SECRET_PATH="${SLOT_DIR}/delivery-secret" \
  bash "${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh" \
    "$LEAD_ID" "${SLOT_DIR}/project-slot-1" "$PROJECT"
