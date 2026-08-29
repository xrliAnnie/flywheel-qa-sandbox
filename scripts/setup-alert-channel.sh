#!/usr/bin/env bash
# FLY-529 alert-channel setup helper.
#
# Why manual: the test bots cannot create channels (no MANAGE_CHANNELS). Create
# the isolated alert channel (mirrors #flywheel-alerts) by hand and invite the
# repair bot, then this helper validates View + Send and patches
# ~/.flywheel/test-slots.json so `test-deploy.sh --alerts` routes test alerts
# there (never the production #flywheel-alerts).
#
# Usage:
#   scripts/setup-alert-channel.sh                  # print setup steps
#   scripts/setup-alert-channel.sh <channel-id>     # validate + install
#
# Exit codes: 0 ok / instructions, 1 usage / pre-req, 2 channel verification failed
set -euo pipefail

ENV_FILE="${HOME}/.flywheel/.env"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"

# Repair bot defaults to slot 1's token env (alertChannel.repairBotTokenEnv
# overrides). An existing alertChannel block is respected on re-run.
REPAIR_BOT_TOKEN_ENV="TEST_BOT_TOKEN_1"
if [[ -f "$SLOTS_FILE" ]]; then
  REPAIR_BOT_TOKEN_ENV=$(jq -r '.alertChannel.repairBotTokenEnv // "TEST_BOT_TOKEN_1"' "$SLOTS_FILE")
fi

print_setup_steps() {
  local guild_disp category_disp
  if [[ -f "$SLOTS_FILE" ]]; then
    guild_disp=$(jq -r '.guildId // "<set guildId>"' "$SLOTS_FILE")
    category_disp=$(jq -r '.categoryId // "<set categoryId>"' "$SLOTS_FILE")
  else
    guild_disp="<see ${SLOTS_FILE}>"; category_disp="<see ${SLOTS_FILE}>"
  fi
  cat <<EOF
FLY-529 alert channel setup — Annie one-time steps in Discord
=============================================================

Step 1 — create the channel (Discord client)
  Guild ID:    ${guild_disp}
  Category ID: ${category_disp}
  Right-click the QA Testing category → Create Channel → Text Channel
  Name:        test-flywheel-alerts

Step 2 — add the repair bot (token env ${REPAIR_BOT_TOKEN_ENV}) + any slot bots
  you will run with --alerts: View Channel · Send Messages · Read Message History.

Step 3 — copy the channel ID (Developer Mode on) → right-click → Copy Channel ID

Step 4 — run this script with the channel ID
  scripts/setup-alert-channel.sh <pasted-channel-id>

It probes View + Send for the repair bot, then writes alertChannel into
test-slots.json. After that 'scripts/test-deploy.sh --alerts <N>' works.
EOF
}

if (( $# == 0 )); then print_setup_steps; exit 0; fi

[[ -f "$ENV_FILE" ]] || { echo "ERROR: ${ENV_FILE} missing" >&2; exit 1; }
[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: ${SLOTS_FILE} missing" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

CHANNEL_ID="${1:?channel-id required}"
if ! [[ "$CHANNEL_ID" =~ ^[0-9]{15,21}$ ]]; then
  echo "ERROR: '${CHANNEL_ID}' is not a Discord channel ID (15-21 digit snowflake)." >&2
  exit 1
fi

REPAIR_TOKEN="${!REPAIR_BOT_TOKEN_ENV:-}"
[[ -n "$REPAIR_TOKEN" ]] || { echo "ERROR: ${REPAIR_BOT_TOKEN_ENV} not set in ${ENV_FILE}" >&2; exit 1; }

echo "Validating alert channel ${CHANNEL_ID} for repair bot (${REPAIR_BOT_TOKEN_ENV}) ..."
HTTP=$(curl -s -H "Authorization: Bot ${REPAIR_TOKEN}" \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
if [[ "$HTTP" != "200" ]]; then
  echo "ERROR: HTTP ${HTTP} — repair bot is not a member or lacks View Channel." >&2
  exit 2
fi
POST=$(curl -s -X POST -H "Authorization: Bot ${REPAIR_TOKEN}" -H "Content-Type: application/json" \
  -d "$(jq -n '{content:"__qa-fly-529-alert-probe__"}')" \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" 2>/dev/null || echo "")
MID=$(jq -r '.id // empty' <<<"$POST" 2>/dev/null || echo "")
if [[ -z "$MID" ]]; then
  echo "ERROR: repair bot cannot Send Messages — ${POST}" >&2
  exit 2
fi
curl -s -X DELETE -H "Authorization: Bot ${REPAIR_TOKEN}" \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MID}" >/dev/null 2>&1 || true
echo "  View + Send OK (probe msg ${MID} cleaned)"

# ── Patch test-slots.json (idempotent) ──────────────────────────────────────
EXISTING=$(jq -r '.alertChannel.channelId // empty' "$SLOTS_FILE")
if [[ "$EXISTING" == "$CHANNEL_ID" ]]; then
  echo "test-slots.json already records alertChannel.channelId=${CHANNEL_ID}; nothing to write."
else
  [[ -n "$EXISTING" ]] && echo "Updating alertChannel.channelId: ${EXISTING} -> ${CHANNEL_ID}" \
    || echo "Adding alertChannel block to ${SLOTS_FILE}"
  TMP=$(mktemp)
  jq --arg id "$CHANNEL_ID" --arg rb "$REPAIR_BOT_TOKEN_ENV" '
    .alertChannel = (.alertChannel // {}) + {
      channelId: $id, channelName: "test-flywheel-alerts", repairBotTokenEnv: $rb
    }
  ' "$SLOTS_FILE" > "$TMP" && mv "$TMP" "$SLOTS_FILE"
fi

echo
echo "DONE. You can now run e.g.:"
echo "  scripts/test-deploy.sh --alerts 1"
echo "  scripts/qa-fly-529-alert-smoke.sh"
