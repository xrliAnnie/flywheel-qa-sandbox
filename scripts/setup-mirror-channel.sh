#!/usr/bin/env bash
# FLY-153 mirror-channel setup helper.
#
# Why this isn't fully automated: the four test bots in the FLY-96 QA guild
# only have View Channel + Send Messages + Read Message History (perms 68608).
# None of them have MANAGE_CHANNELS / MANAGE_GUILD, so they cannot create the
# `#test-core-mirror` channel or grant themselves channel-level overwrites.
# The Discord side of the setup (create channel + invite the 3 bots) MUST be
# done by a user with manage perms — Annie. After she does that one-off step
# this script validates the result and patches ~/.flywheel/test-slots.json.
#
# Usage:
#   scripts/setup-mirror-channel.sh                    # print setup steps
#   scripts/setup-mirror-channel.sh <channel-id>       # validate + install
#
# Prerequisites:
#   - ~/.flywheel/.env with TEST_BOT_TOKEN_1, TEST_BOT_TOKEN_2, TEST_BOT_TOKEN_3
#   - ~/.flywheel/test-slots.json with guildId + categoryId
#
# Exit codes:
#   0 — success (channel installed and verified, OR instructions printed)
#   1 — usage / pre-req error
#   2 — channel verification failed (channel missing, bot can't see it, etc.)
set -euo pipefail

ENV_FILE="${HOME}/.flywheel/.env"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
print_setup_steps() {
  # Degrade gracefully when test-slots.json is missing or has gaps —
  # someone running with no args may not have set up the env yet, and the
  # whole point of this script in that mode is to *tell* them what to set
  # up. Use placeholders for any field the file can't supply.
  local guild_disp category_disp bot1 bot2 bot3
  if [[ -f "$SLOTS_FILE" ]]; then
    guild_disp=$(jq -r '.guildId // "<set guildId in test-slots.json>"' "$SLOTS_FILE")
    category_disp=$(jq -r '.categoryId // "<set categoryId in test-slots.json>"' "$SLOTS_FILE")
    bot1=$(jq -r '.slots[0].botName // "flywheel-test-1"' "$SLOTS_FILE")
    bot2=$(jq -r '.slots[1].botName // "flywheel-test-2"' "$SLOTS_FILE")
    bot3=$(jq -r '.slots[2].botName // "flywheel-test-3"' "$SLOTS_FILE")
  else
    guild_disp="<see ${SLOTS_FILE}, file not present yet>"
    category_disp="<see ${SLOTS_FILE}, file not present yet>"
    bot1="flywheel-test-1"
    bot2="flywheel-test-2"
    bot3="flywheel-test-3"
  fi
  cat <<EOF
FLY-153 mirror channel setup — Annie one-time steps in Discord
==============================================================

Why this is manual: the test bots only have View/Send/Read perms in the
test guild. They cannot create channels or change channel-level overwrites
themselves; Discord requires MANAGE_CHANNELS to do that, which only you have.

Step 1 — create the channel (Discord client)
  Guild ID:     ${guild_disp}
  Category ID:  ${category_disp}
  Right-click the QA Testing category → Create Channel → Text Channel
  Name:         test-core-mirror

Step 2 — add the three test bots
  Right-click the new #test-core-mirror channel → Edit Channel → Permissions
  → Add member or role → search and add each of:
    * ${bot1}   (Simba role in mirror mode)
    * ${bot2}   (Peter role in mirror mode)
    * ${bot3}   (Oliver role in mirror mode)
  Per-bot grant: View Channel · Send Messages · Read Message History
  (No need for Mention Everyone — smoke uses <@bot-user-id> direct mentions.)

Step 3 — copy the channel ID
  Discord Settings → Advanced → Developer Mode (if not already on)
  Right-click #test-core-mirror → Copy Channel ID

Step 4 — run this script with the channel ID
  scripts/setup-mirror-channel.sh <pasted-channel-id>

That last command verifies all 3 bots can probe the channel and writes
mirrorChannel.channelId into ~/.flywheel/test-slots.json. After that
'scripts/test-deploy.sh --mode mirror N' works.
EOF
}

# No-arg usage prints setup steps even when the env / config files are
# missing — the whole point of that mode is to guide first-time setup.
if (( $# == 0 )); then
  print_setup_steps
  exit 0
fi

# Validation mode requires both files because we need GUILD_ID + bot tokens.
[[ -f "$ENV_FILE" ]] || { echo "ERROR: ${ENV_FILE} missing" >&2; exit 1; }
[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: ${SLOTS_FILE} missing" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

GUILD_ID=$(jq -r '.guildId' "$SLOTS_FILE")
CATEGORY_ID=$(jq -r '.categoryId' "$SLOTS_FILE")
[[ -n "$GUILD_ID" && "$GUILD_ID" != "null" ]] || { echo "ERROR: guildId missing in ${SLOTS_FILE}" >&2; exit 1; }

CHANNEL_ID="${1:?channel-id required}"

# Reject obvious typos / placeholder paste-overs early.
if ! [[ "$CHANNEL_ID" =~ ^[0-9]{15,21}$ ]]; then
  echo "ERROR: '${CHANNEL_ID}' does not look like a Discord channel ID (expected 15-21 digit snowflake)." >&2
  echo "  Did you accidentally paste the channel name or a partial ID?" >&2
  exit 1
fi

echo "Validating channel ${CHANNEL_ID} against test guild ${GUILD_ID} ..."

# Look up bot name from test-slots.json by 1-based slot number. Reads from
# config so renames in the guild don't drift away from this script. Avoids
# Bash 4 associative arrays (macOS default /bin/bash is 3.2.57).
bot_name_for_slot() {
  local slot="$1"
  local idx=$((slot - 1))
  jq -r --argjson i "$idx" '.slots[$i].botName // ("flywheel-test-" + ($i+1|tostring))' "$SLOTS_FILE"
}

# Step A: probe with each of the 3 mirror-relevant bots (1/2/3). Slot 4 is
# finance and intentionally not part of mirror mode.
ALL_OK=1
for s in 1 2 3; do
  BOT_NAME=$(bot_name_for_slot "$s")
  TOKEN_VAR="TEST_BOT_TOKEN_$s"
  TOKEN="${!TOKEN_VAR:-}"
  if [[ -z "$TOKEN" ]]; then
    echo "  [bot $s ${BOT_NAME}] FAIL: ${TOKEN_VAR} not set in ${ENV_FILE}"
    ALL_OK=0
    continue
  fi
  # See test-deploy.sh §4.5 fix: don't pass -f or curl will write a
  # non-zero exit AND the body, leaving "$PROBE_HTTP" looking like
  # "403000". Without -f we get a clean 3-digit code.
  PROBE_HTTP=$(curl -s -H "Authorization: Bot ${TOKEN}" \
    "https://discord.com/api/v10/channels/${CHANNEL_ID}" \
    -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
  [[ -z "$PROBE_HTTP" ]] && PROBE_HTTP="000"

  case "$PROBE_HTTP" in
    200)
      echo "  [bot $s ${BOT_NAME}] OK (HTTP 200, channel visible)"
      ;;
    403|404)
      echo "  [bot $s ${BOT_NAME}] FAIL: HTTP ${PROBE_HTTP} — bot is not a channel member or lacks View Channel"
      ALL_OK=0
      ;;
    *)
      echo "  [bot $s ${BOT_NAME}] FAIL: HTTP ${PROBE_HTTP} — network/auth error (verify ${TOKEN_VAR} is fresh)"
      ALL_OK=0
      ;;
  esac
done

# Step B: Send Messages permission — REST GET cannot prove this; do a
# tiny POST/DELETE round-trip per bot, idempotent and self-cleaning.
if (( ALL_OK )); then
  TS=$(date +%s)
  for s in 1 2 3; do
    BOT_NAME=$(bot_name_for_slot "$s")
    TOKEN_VAR="TEST_BOT_TOKEN_$s"
    TOKEN="${!TOKEN_VAR}"
    BODY=$(jq -n --arg c "__qa-fly-153-setup-probe-${s}-${TS}__" '{content:$c}')
    POST_RESP=$(curl -s -X POST \
      -H "Authorization: Bot ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" 2>/dev/null || echo "")
    MSG_ID=$(echo "$POST_RESP" | jq -r '.id // empty' 2>/dev/null || echo "")
    if [[ -z "$MSG_ID" ]]; then
      echo "  [bot $s ${BOT_NAME}] FAIL: cannot Send Messages — POST response: ${POST_RESP}"
      ALL_OK=0
    else
      echo "  [bot $s ${BOT_NAME}] Send Messages OK (probe msg ${MSG_ID} cleaned)"
      curl -s -X DELETE -H "Authorization: Bot ${TOKEN}" \
        "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MSG_ID}" >/dev/null 2>&1 || true
    fi
  done
fi

if ! (( ALL_OK )); then
  echo
  echo "ERROR: channel ${CHANNEL_ID} is not ready. Re-check Annie steps above." >&2
  exit 2
fi

# Step C: patch ~/.flywheel/test-slots.json. Idempotent — if mirrorChannel
# exists with the same ID we just confirm; if it differs we update; if it
# is missing we add it.
EXISTING=$(jq -r '.mirrorChannel.channelId // empty' "$SLOTS_FILE")
if [[ "$EXISTING" == "$CHANNEL_ID" ]]; then
  echo "test-slots.json already records mirrorChannel.channelId=${CHANNEL_ID}; nothing to write."
else
  if [[ -n "$EXISTING" ]]; then
    echo "Updating mirrorChannel.channelId: ${EXISTING} -> ${CHANNEL_ID}"
  else
    echo "Adding mirrorChannel block to ${SLOTS_FILE}"
  fi
  TMP=$(mktemp)
  jq --arg id "$CHANNEL_ID" '
    .mirrorChannel = (.mirrorChannel // {}) + {channelId: $id, channelName: "test-core-mirror"}
  ' "$SLOTS_FILE" > "$TMP" && mv "$TMP" "$SLOTS_FILE"
fi

echo
echo "DONE. You can now run:"
echo "  scripts/test-deploy.sh --mode mirror 1"
echo "  scripts/test-deploy.sh --mode mirror 2"
echo "  scripts/test-deploy.sh --mode mirror 3"
echo "  scripts/qa-fly-153-mirror-smoke.sh"
