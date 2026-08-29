#!/usr/bin/env bash
#
# FLY-614 — one-time setup: find-or-create the `cost-dashboard` Discord channel that
# the daily token-usage report is posted to, and print its channel ID.
#
# Creating a channel needs the bot's MANAGE_CHANNELS permission, so this is a DEPLOY-time
# step (run with the founder/operator present) — NOT done by the daily job. The daily
# job only READS the channel ID via FLYWHEEL_TOKEN_USAGE_CHANNEL.
#
# Idempotent: if a `cost-dashboard` channel already exists in the guild, its ID is
# reused (no duplicate created).
#
# Env (from ~/.flywheel/.env or the shell):
#   DISCORD_BOT_TOKEN        bot token with MANAGE_CHANNELS in the target guild
#                            (override the var name via DISCORD_BOT_TOKEN_VAR)
#   FLYWHEEL_GUILD_ID        target Discord guild (server) id
#   COST_DASHBOARD_NAME      channel name (default: cost-dashboard)
set -euo pipefail

ENV_FILE="${FLYWHEEL_ENV_FILE:-$HOME/.flywheel/.env}"
NAME="${COST_DASHBOARD_NAME:-cost-dashboard}"
API="https://discord.com/api/v10"

if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
fi

# Allow pointing at a differently-named bot-token env var.
TOKEN_VAR="${DISCORD_BOT_TOKEN_VAR:-DISCORD_BOT_TOKEN}"
TOKEN="${!TOKEN_VAR:-}"
GUILD="${FLYWHEEL_GUILD_ID:-}"

if [ -z "$TOKEN" ]; then
	echo "ERROR: bot token not set (\$$TOKEN_VAR). Set it in $ENV_FILE or the shell." >&2
	exit 1
fi
if [ -z "$GUILD" ]; then
	echo "ERROR: FLYWHEEL_GUILD_ID not set (target Discord server id)." >&2
	exit 1
fi

# Emit a curl config carrying the auth headers, fed to curl via `-K -` (stdin) so the
# bot token NEVER appears in argv / `ps` output (Codex R5 HIGH).
curl_cfg() {
	printf 'header = "Authorization: Bot %s"\nheader = "User-Agent: flywheel-token-usage (FLY-614)"\n' "$TOKEN"
}

# 1) Look for an existing channel with this name (idempotent).
existing=$(curl_cfg | curl -sf -K - "${API}/guilds/${GUILD}/channels" \
	| jq -r --arg n "$NAME" '.[] | select(.type==0 and .name==$n) | .id' | head -1 || true)

if [ -n "$existing" ]; then
	echo "Found existing #${NAME}: ${existing}" >&2
	id="$existing"
else
	echo "Creating #${NAME} in guild ${GUILD} ..." >&2
	id=$(curl_cfg | curl -sf -K - -H "Content-Type: application/json" \
		-X POST "${API}/guilds/${GUILD}/channels" \
		-d "$(jq -n --arg n "$NAME" '{name:$n, type:0, topic:"FLY-614 每日 Token 用量报告 (cost dashboard)"}')" \
		| jq -r '.id')
fi

if [ -z "$id" ] || [ "$id" = "null" ]; then
	echo "ERROR: failed to find or create #${NAME}" >&2
	exit 1
fi

# Print the channel id to stdout; suggest the env line for the daily job.
echo "$id"
echo "→ add to ${ENV_FILE}:  FLYWHEEL_TOKEN_USAGE_CHANNEL=${id}" >&2
