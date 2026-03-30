#!/bin/bash
# GEO-285 B2: PostCompact hook — re-send bootstrap after auto-compact to replenish lost context.
# Requires FLYWHEEL_LEAD_ID and TEAMLEAD_API_TOKEN environment variables
# (exported by claude-lead.sh).
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
LEAD_ID="${FLYWHEEL_LEAD_ID:-}"
API_TOKEN="${TEAMLEAD_API_TOKEN:-}"

# Only skip if LEAD_ID is missing (not in Flywheel Lead context).
# Token may be empty in dev — fall through to no-auth branch (matches send_bootstrap()).
if [ -z "$LEAD_ID" ]; then
  exit 0
fi

bootstrap_curl() {
  # GEO-203: Increased timeout from 10→15s to account for dual-bucket memory recall
  local args=(-s -X POST "${BRIDGE_URL}/api/bootstrap/${LEAD_ID}" -H "Content-Type: application/json" --max-time 15 -w '\n%{http_code}')
  [ -n "$API_TOKEN" ] && args+=(-H "Authorization: Bearer ${API_TOKEN}")

  local response
  response=$(curl "${args[@]}" 2>/dev/null) || {
    echo "[post-compact-hook] WARNING: Bootstrap request failed (curl error)" >&2
    return 0  # Non-fatal — Lead can rehydrate via Bridge API queries
  }

  local http_code
  http_code=$(echo "$response" | tail -1)
  if [ "$http_code" -ge 400 ] 2>/dev/null; then
    echo "[post-compact-hook] WARNING: Bootstrap returned HTTP ${http_code}" >&2
  fi
}
bootstrap_curl
