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

# Read launcher configuration into this shell without exporting it wholesale.
# claude-lead.sh is sourced below and can materialize only its approved child
# environment; the parent tmux server never receives these secrets.
ENV_FILE="${FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/.env}"
if [ -f "$ENV_FILE" ]; then
  set +a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

LEAD_ID="$(jq -er '.leadId' "$MANIFEST")"
PROJECT_DIR="$(jq -er '.projectDir' "$MANIFEST")"
PROJECT_NAME="$(jq -er '.projectName' "$MANIFEST")"
SUBDIR="$(jq -r '.subdir // ""' "$MANIFEST")"
BOT_TOKEN_ENV="$(jq -r '.botTokenEnv // "DISCORD_BOT_TOKEN"' "$MANIFEST")"
[[ "$BOT_TOKEN_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
  || { echo "[lead-body] ERROR: invalid botTokenEnv: $BOT_TOKEN_ENV" >&2; exit 1; }
# Loading .env may overwrite a global DISCORD_BOT_TOKEN inherited from the
# private server. Reproject the exact manifest-selected credential afterwards,
# matching the v1 wrapper's boundary and preventing cross-Lead identity drift.
export DISCORD_BOT_TOKEN="${!BOT_TOKEN_ENV:-}"

ARGS=("$LEAD_ID" "$PROJECT_DIR" "$PROJECT_NAME")
[ -z "$SUBDIR" ] || ARGS+=(--subdir "$SUBDIR")
ARGS+=(--bot-token-env "$BOT_TOKEN_ENV")

export FLYWHEEL_LEAD_BODY_V2=1
# shellcheck source=claude-lead.sh
source "$SCRIPT_DIR/claude-lead.sh" "${ARGS[@]}"
