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

# FLY-231: companion Leads (Mufasa/Belle) deliberately do NOT receive the
# engineering bootstrap (it carries "## Bootstrap — Lead" / sessions / Runner
# questions — engineering-toned content that pollutes a companion persona).
# claude-lead.sh skips the INITIAL bootstrap for companions, but THIS hook is
# installed globally in ~/.claude/settings.json and fires post-compact for every
# session — so skipping the install is not enough (Codex R3 BLOCKER-2). The
# companion's pane carries FLYWHEEL_LEAD_COMPANION=1; honor it and exit BEFORE any
# bootstrap curl. Non-companion behavior is byte-identical (var absent → no skip).
if [ "${FLYWHEEL_LEAD_COMPANION:-}" = "1" ]; then
  exit 0
fi

# FLY-879: external (customer-facing) Leads — Anna the interviewer — likewise get
# NO engineering bootstrap: it carries internal engineering content that must never
# reach a customer-facing agent, and Anna has no Bridge access anyway (the token is
# emptied in its pane). claude-lead.sh skips the INITIAL bootstrap for external, but
# this globally-installed hook fires post-compact for every session — so honor the
# FLYWHEEL_LEAD_EXTERNAL=1 pane marker and exit BEFORE any bootstrap curl. Non-external
# behavior is byte-identical (var absent → no skip).
if [ "${FLYWHEEL_LEAD_EXTERNAL:-}" = "1" ]; then
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
