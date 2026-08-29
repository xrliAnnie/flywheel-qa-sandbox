#!/bin/bash
# QA FLY-944 N-to-N Discord driver — post as a test bot / fetch channel messages
# via the Discord REST API. Sourced by the harness.
set -uo pipefail
API="https://discord.com/api/v10"

# post_as <bot-token> <channel-id> <content>  → prints the created message id
post_as() {
  local tok="$1" ch="$2" content="$3"
  local body
  body=$(jq -n --arg c "$content" '{content:$c, allowed_mentions:{parse:["users"]}}')
  curl -s -X POST "$API/channels/$ch/messages" \
    -H "Authorization: Bot $tok" -H "Content-Type: application/json" \
    -d "$body" | jq -r '.id // ("ERR:" + (.message // "unknown"))'
}

# fetch_after <bot-token> <channel-id> <after-message-id>  → JSONL {author,bot,content,mentions}
fetch_after() {
  local tok="$1" ch="$2" after="$3"
  curl -s "$API/channels/$ch/messages?after=$after&limit=50" \
    -H "Authorization: Bot $tok" \
    | jq -r 'reverse[] | {id, author: .author.username, authorId: .author.id, bot: .author.bot, content, mentions: [.mentions[].id]} | @json'
}

# channel_link <guild> <channel>
channel_link() { echo "https://discord.com/channels/$1/$2"; }

"$@"
