#!/usr/bin/env bash
# Daily Standup — called by launchd at 3:00 AM Pacific
# GEO-288: Triggers Bridge standup API to generate system status report.
set -euo pipefail

# Source environment (TEAMLEAD_API_TOKEN, STANDUP_CHANNEL, etc.)
# Same pattern as packages/teamlead/scripts/claude-lead.sh
ENV_FILE="${HOME}/.flywheel/.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"

# Build curl args — use bash array to avoid shell quoting issues
CURL_ARGS=(-sf -X POST "$BRIDGE_URL/api/standup/trigger" -H "Content-Type: application/json" -d '{}')
if [ -n "${TEAMLEAD_API_TOKEN:-}" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer $TEAMLEAD_API_TOKEN")
fi

curl "${CURL_ARGS[@]}" \
  || { code=$?; echo "[daily-standup] Bridge API call failed (exit $code)" >&2; exit $code; }
