#!/usr/bin/env bash
# FLY-1439 token-safe Discord REST driver.
#
# Reads the selected bot token from ~/.flywheel/.env, never prints response
# headers, and emits only the message fields used as QA evidence.
set -euo pipefail

action="${1:-}"
shift || true

env_file="${FLYWHEEL_ENV_FILE:-$HOME/.flywheel/.env}"
token_env="${FLY1439_DRIVER_TOKEN_ENV:-TEST_BOT_TOKEN_2}"
channel_id="${FLY1439_DISCORD_CHANNEL_ID:-1504277055406211142}"
api_root="https://discord.com/api/v10"

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

token="${!token_env:-}"
if [[ -z "$token" ]]; then
  printf 'missing Discord token env: %s\n' "$token_env" >&2
  exit 64
fi

discord_get() {
  curl --fail --silent --show-error \
    -H "Authorization: Bot $token" \
    "$1"
}

case "$action" in
  send)
    content="${1:?usage: discord-driver.sh send CONTENT}"
    payload="$(jq -cn --arg content "$content" '{content:$content}')"
    curl --fail --silent --show-error \
      -H "Authorization: Bot $token" \
      -H 'Content-Type: application/json' \
      -X POST \
      --data "$payload" \
      "$api_root/channels/$channel_id/messages" |
      jq '{
        id,
        channel_id,
        author:(.author | {id,username,bot}),
        content,
        message_reference
      }'
    ;;
  get)
    message_id="${1:?usage: discord-driver.sh get MESSAGE_ID}"
    discord_get "$api_root/channels/$channel_id/messages/$message_id" |
      jq '{
        id,
        channel_id,
        author:(.author | {id,username,bot}),
        content,
        message_reference
      }'
    ;;
  after)
    message_id="${1:?usage: discord-driver.sh after MESSAGE_ID}"
    discord_get "$api_root/channels/$channel_id/messages?after=$message_id&limit=100" |
      jq '[.[] | {
        id,
        channel_id,
        author:(.author | {id,username,bot}),
        content,
        message_reference
      }]'
    ;;
  wait-reference)
    message_id="${1:?usage: discord-driver.sh wait-reference MESSAGE_ID [SECONDS]}"
    timeout_seconds="${2:-180}"
    deadline=$((SECONDS + timeout_seconds))
    while (( SECONDS < deadline )); do
      result="$(
        discord_get \
          "$api_root/channels/$channel_id/messages?after=$message_id&limit=100" |
          jq -c --arg id "$message_id" '
            [.[] | select(.message_reference.message_id == $id)] |
            sort_by(.id) |
            last //
            empty |
            {
              id,
              channel_id,
              author:(.author | {id,username,bot}),
              content,
              message_reference
            }
          '
      )"
      if [[ -n "$result" ]]; then
        printf '%s\n' "$result"
        exit 0
      fi
      sleep 2
    done
    printf 'no reply reference found for %s within %ss\n' \
      "$message_id" "$timeout_seconds" >&2
    exit 1
    ;;
  *)
    printf 'usage: discord-driver.sh send|get|after|wait-reference ...\n' >&2
    exit 64
    ;;
esac
