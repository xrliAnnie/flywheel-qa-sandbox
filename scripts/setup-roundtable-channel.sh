#!/usr/bin/env bash
# FLY-529 roundtable-channel setup helper.
#
# Why this isn't fully automated: the test bots in the QA guild only have View
# Channel + Send Messages + Read Message History (perms 68608), and none have
# MANAGE_CHANNELS — so they cannot create the channel. Worse, the roundtable
# auto-thread manager (RoundtableThreadManager) creates a Discord thread off
# each topic message via POST /channels/{id}/messages/{msgId}/threads, which
# needs CREATE_PUBLIC_THREADS + SEND_MESSAGES_IN_THREADS. Those must be granted
# to the HOST bot by a user with manage perms — Annie. This helper validates
# the result (incl. a real thread create/send round-trip) and patches
# ~/.flywheel/test-slots.json.
#
# Usage:
#   scripts/setup-roundtable-channel.sh                 # print setup steps
#   scripts/setup-roundtable-channel.sh <channel-id>    # validate + install
#
# Exit codes: 0 ok / instructions, 1 usage / pre-req, 2 channel verification failed
set -euo pipefail

ENV_FILE="${HOME}/.flywheel/.env"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"

# Defaults match the 2-lead room (host slot 1 + member slot 2); an existing
# roundtableChannel block overrides them so re-runs respect prior config.
HOST_SLOT=1
MEMBER_SLOTS_JSON='[2]'
if [[ -f "$SLOTS_FILE" ]]; then
  HOST_SLOT=$(jq -r '.roundtableChannel.hostSlot // 1' "$SLOTS_FILE")
  MEMBER_SLOTS_JSON=$(jq -c '.roundtableChannel.memberSlots // [2]' "$SLOTS_FILE")
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
FLY-529 roundtable channel setup — Annie one-time steps in Discord
=================================================================

Why manual: the test bots cannot create channels, and the auto-thread manager
needs thread permissions the bots do not have by default.

Step 1 — create the channel (Discord client)
  Guild ID:    ${guild_disp}
  Category ID: ${category_disp}
  Right-click the QA Testing category → Create Channel → Text Channel
  Name:        test-leads-roundtable

Step 2 — add the bots + grant permissions
  Right-click #test-leads-roundtable → Edit Channel → Permissions → Add member:
    * HOST bot (slot ${HOST_SLOT}): View Channel · Send Messages · Read Message
      History · **Create Public Threads** · **Send Messages in Threads**
    * MEMBER bot(s) (slots ${MEMBER_SLOTS_JSON}): View Channel · Send Messages ·
      Read Message History (so the manager can add them to topic threads)

Step 3 — copy the channel ID (Developer Mode on) → right-click → Copy Channel ID

Step 4 — run this script with the channel ID
  scripts/setup-roundtable-channel.sh <pasted-channel-id>

It probes the host bot's thread-create + send-in-thread permission with a real
(self-cleaning) round-trip, then writes roundtableChannel into test-slots.json.
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

token_for_slot() {
  local slot="$1" var
  var=$(jq -r --argjson i "$((slot - 1))" '.slots[$i].tokenEnvVar // empty' "$SLOTS_FILE")
  [[ -n "$var" ]] && printf '%s' "${!var:-}"
}

echo "Validating roundtable channel ${CHANNEL_ID} ..."
ALL_OK=1

# ── Member slots: View Channel + Send Messages ──────────────────────────────
mapfile_compat() { jq -r '.[]' <<<"$1"; }
for s in $(mapfile_compat "$MEMBER_SLOTS_JSON"); do
  TOKEN=$(token_for_slot "$s")
  if [[ -z "$TOKEN" ]]; then echo "  [member slot $s] FAIL: token env not set"; ALL_OK=0; continue; fi
  HTTP=$(curl -s -H "Authorization: Bot ${TOKEN}" \
    "https://discord.com/api/v10/channels/${CHANNEL_ID}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
  if [[ "$HTTP" == "200" ]]; then
    POST=$(curl -s -X POST -H "Authorization: Bot ${TOKEN}" -H "Content-Type: application/json" \
      -d "$(jq -n --arg c "__qa-fly-529-member-probe-${s}__" '{content:$c}')" \
      "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" 2>/dev/null || echo "")
    MID=$(jq -r '.id // empty' <<<"$POST" 2>/dev/null || echo "")
    if [[ -n "$MID" ]]; then
      echo "  [member slot $s] View + Send OK"
      curl -s -X DELETE -H "Authorization: Bot ${TOKEN}" \
        "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MID}" >/dev/null 2>&1 || true
    else
      echo "  [member slot $s] FAIL: cannot Send Messages — ${POST}"; ALL_OK=0
    fi
  else
    echo "  [member slot $s] FAIL: HTTP ${HTTP} (not a member / no View Channel)"; ALL_OK=0
  fi
done

# ── Host slot: full thread create + send-in-thread round-trip ───────────────
HOST_TOKEN=$(token_for_slot "$HOST_SLOT")
if [[ -z "$HOST_TOKEN" ]]; then
  echo "  [host slot ${HOST_SLOT}] FAIL: token env not set"; ALL_OK=0
else
  SEED=$(curl -s -X POST -H "Authorization: Bot ${HOST_TOKEN}" -H "Content-Type: application/json" \
    -d "$(jq -n '{content:"__qa-fly-529-thread-perm-probe__"}')" \
    "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" 2>/dev/null || echo "")
  SEED_ID=$(jq -r '.id // empty' <<<"$SEED" 2>/dev/null || echo "")
  if [[ -z "$SEED_ID" ]]; then
    echo "  [host slot ${HOST_SLOT}] FAIL: cannot Send Messages — ${SEED}"; ALL_OK=0
  else
    THREAD=$(curl -s -X POST -H "Authorization: Bot ${HOST_TOKEN}" -H "Content-Type: application/json" \
      -d "$(jq -n '{name:"qa-fly-529-perm-probe"}')" \
      "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${SEED_ID}/threads" 2>/dev/null || echo "")
    THREAD_ID=$(jq -r '.id // empty' <<<"$THREAD" 2>/dev/null || echo "")
    if [[ -z "$THREAD_ID" ]]; then
      echo "  [host slot ${HOST_SLOT}] FAIL: missing CREATE_PUBLIC_THREADS — ${THREAD}"; ALL_OK=0
    else
      INTH=$(curl -s -X POST -H "Authorization: Bot ${HOST_TOKEN}" -H "Content-Type: application/json" \
        -d "$(jq -n '{content:"thread send probe"}')" \
        "https://discord.com/api/v10/channels/${THREAD_ID}/messages" 2>/dev/null || echo "")
      if [[ -n "$(jq -r '.id // empty' <<<"$INTH" 2>/dev/null)" ]]; then
        echo "  [host slot ${HOST_SLOT}] Create Public Threads + Send in Threads OK"
      else
        echo "  [host slot ${HOST_SLOT}] FAIL: missing SEND_MESSAGES_IN_THREADS — ${INTH}"; ALL_OK=0
      fi
      # Cleanup the probe thread, verifying the result. DELETE needs
      # MANAGE_THREADS (the host bot may lack it) → fall back to archiving the
      # thread (the creator can), and warn loudly with the id if neither works.
      DEL=$(curl -s -X DELETE -H "Authorization: Bot ${HOST_TOKEN}" \
        "https://discord.com/api/v10/channels/${THREAD_ID}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
      if [[ "$DEL" != "20"* && "$DEL" != "404" ]]; then
        ARC=$(curl -s -X PATCH -H "Authorization: Bot ${HOST_TOKEN}" -H "Content-Type: application/json" \
          -d "$(jq -n '{archived:true,locked:true}')" \
          "https://discord.com/api/v10/channels/${THREAD_ID}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
        [[ "$ARC" == "20"* ]] \
          && echo "  [host] probe thread ${THREAD_ID} archived (delete HTTP ${DEL}, no MANAGE_THREADS)" \
          || echo "  [host] WARN: could not delete (HTTP ${DEL}) or archive (HTTP ${ARC}) probe thread ${THREAD_ID} — clean it up manually" >&2
      fi
    fi
    DELS=$(curl -s -X DELETE -H "Authorization: Bot ${HOST_TOKEN}" \
      "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${SEED_ID}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
    [[ "$DELS" == "20"* || "$DELS" == "404" ]] \
      || echo "  [host] WARN: could not delete probe seed message ${SEED_ID} (HTTP ${DELS}) — clean it up manually" >&2
  fi
fi

if ! (( ALL_OK )); then
  echo >&2
  echo "ERROR: channel ${CHANNEL_ID} not ready — re-check the Annie steps (esp. host-bot thread perms)." >&2
  exit 2
fi

# ── Patch test-slots.json — ALWAYS normalize the full block ─────────────────
# Idempotent = re-running yields the same complete block (channelId + hostSlot +
# memberSlots + triggerMode), even when channelId is unchanged. A partial block
# with only channelId would otherwise pass setup yet deploy a host manager with
# no FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS (AC3 fails). Codex code R1 #4.
TMP=$(mktemp)
jq --arg id "$CHANNEL_ID" --argjson host "$HOST_SLOT" --argjson members "$MEMBER_SLOTS_JSON" '
  .roundtableChannel = {
    channelId: $id, channelName: "test-leads-roundtable",
    hostSlot: $host, memberSlots: $members,
    triggerMode: (.roundtableChannel.triggerMode // "any_top_level")
  }
' "$SLOTS_FILE" > "$TMP"
if diff -q "$TMP" "$SLOTS_FILE" >/dev/null 2>&1; then
  echo "test-slots.json roundtableChannel already normalized (channel ${CHANNEL_ID}); no change."
  rm -f "$TMP"
else
  echo "Writing normalized roundtableChannel block (channel ${CHANNEL_ID}, host ${HOST_SLOT}, members ${MEMBER_SLOTS_JSON})."
  mv "$TMP" "$SLOTS_FILE"
fi

echo
echo "DONE. You can now run:"
echo "  scripts/test-deploy.sh --mode roundtable ${HOST_SLOT}"
for s in $(mapfile_compat "$MEMBER_SLOTS_JSON"); do echo "  scripts/test-deploy.sh --mode roundtable ${s}"; done
echo "  scripts/qa-fly-529-roundtable-smoke.sh"
