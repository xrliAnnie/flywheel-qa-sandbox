#!/bin/bash
# FLY-1663: one-shot Claude Lead body.
# The proven Lead assembly remains in claude-lead.sh during the mixed-fleet
# migration, but this entry selects its launchd-native one-shot path. Source it
# so the long-lived wait parent remains this body pane process.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${1:?Usage: lead-body.sh <manifest-path>}"
command -v jq >/dev/null 2>&1 || { echo '[lead-body] ERROR: jq is required' >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "[lead-body] ERROR: manifest not found: $MANIFEST" >&2; exit 1; }

# Read launcher configuration into this body shell. Helper subprocesses used
# during assembly retain the v1 launcher's exported configuration, while the
# eventual Claude child still crosses claude-lead.sh's explicit env -i barrier.
ENV_FILE="${FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/.env}"
if [ -f "$ENV_FILE" ]; then
  _v2_body_allexport_was_on=false
  [[ "$-" == *a* ]] && _v2_body_allexport_was_on=true
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  [ "$_v2_body_allexport_was_on" = true ] || set +a
  unset _v2_body_allexport_was_on
fi

LEAD_ID="$(jq -er '.leadId' "$MANIFEST")"
PROJECT_DIR="$(jq -er '.projectDir' "$MANIFEST")"
PROJECT_NAME="$(jq -er '.projectName' "$MANIFEST")"
SUBDIR="$(jq -r '.subdir // ""' "$MANIFEST")"
BOT_TOKEN_ENV="$(jq -r '.botTokenEnv // "DISCORD_BOT_TOKEN"' "$MANIFEST")"
WORKSPACE="$(jq -er '(.workspace // "") | select(type == "string")' "$MANIFEST")" \
  || { echo '[lead-body] ERROR: invalid workspace' >&2; exit 1; }
MCP_EXCLUDE="$(jq -er '(.mcpExclude // "") | select(type == "string")' "$MANIFEST")" \
  || { echo '[lead-body] ERROR: invalid mcpExclude' >&2; exit 1; }
CHROME_ENABLED="$(jq -er \
  'if .chromeEnabled == null then "false"
   elif (.chromeEnabled | type) == "boolean" then (.chromeEnabled | tostring)
   else error("chromeEnabled must be boolean") end' "$MANIFEST")" \
  || { echo '[lead-body] ERROR: invalid chromeEnabled' >&2; exit 1; }
[[ "$BOT_TOKEN_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
  || { echo "[lead-body] ERROR: invalid botTokenEnv: $BOT_TOKEN_ENV" >&2; exit 1; }
# Loading .env may overwrite a global DISCORD_BOT_TOKEN inherited from the
# private server. Reproject the exact manifest-selected credential afterwards,
# matching the v1 wrapper's boundary and preventing cross-Lead identity drift.
export DISCORD_BOT_TOKEN="${!BOT_TOKEN_ENV:-}"
export FLYWHEEL_LEAD_CARRIER=v2
export FLYWHEEL_LEAD_MCP_EXCLUDE="$MCP_EXCLUDE"
export FLYWHEEL_LEAD_CHROME_ENABLED="$CHROME_ENABLED"
if [ -n "$WORKSPACE" ]; then
  export LEAD_WORKSPACE="$WORKSPACE"
fi

ARGS=("$LEAD_ID" "$PROJECT_DIR" "$PROJECT_NAME")
[ -z "$SUBDIR" ] || ARGS+=(--subdir "$SUBDIR")
ARGS+=(--bot-token-env "$BOT_TOKEN_ENV")

export FLYWHEEL_LEAD_BODY_V2=1
# shellcheck source=claude-lead.sh
source "$SCRIPT_DIR/claude-lead.sh" "${ARGS[@]}"
