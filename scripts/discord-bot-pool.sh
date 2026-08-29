#!/bin/bash
# FLY-882: Discord bot token pool CLI.
#
# Manages a local pool of pre-created blank Discord bot identities so
# claiming a Discord identity for a new Lead/agent doesn't require creating a
# fresh Application in the Developer Portal every time. Discord has no API
# to create an Application/Bot from scratch — that step is always a
# Developer Portal browser action done once, in bulk, ahead of time (see
# doc/reference/discord-bot-pool-claim-guide.md). This CLI only manages what
# happens after a blank bot + token already exist locally.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/discord-bot-pool-lib.sh"

usage() {
  cat <<'EOF'
Usage: discord-bot-pool.sh <command> [args]

Commands:
  init                                    create pool dir + empty pool.json (idempotent)
  add-slot <slot> <app_id> <bot_user_id>  register a slot (token must already be at
                                           <pool-dir>/<slot>/token)
  list                                    show all slots (token shown masked, never raw)
  verify <slot|--all>                     read-only GET /users/@me liveness check
  rename <slot> <new-username>            PATCH bot username
  invite-url <slot> [permissions] [guild_id]
                                           print the OAuth2 invite URL for a slot
  claim <slot> <claimed-by>                mark a slot claimed (does NOT invite it into a server)
EOF
}

cmd="${1:-}"
[ $# -gt 0 ] && shift

case "$cmd" in
  init) pool_init ;;
  add-slot) pool_add_slot "$@" ;;
  list) pool_list ;;
  verify)
    slot="${1:-}"
    if [ "$slot" = "--all" ]; then
      pool_require_jq
      rc=0
      while IFS= read -r s; do
        pool_verify "$s" || rc=1
      done < <(jq -r '.slots[].slot' "$(pool_json_path)")
      exit $rc
    else
      pool_verify "$slot"
    fi
    ;;
  rename) pool_rename "$@" ;;
  invite-url) pool_invite_url "$@" ;;
  claim) pool_claim "$@" ;;
  -h|--help|"") usage ;;
  *) echo "unknown command: $cmd" >&2; usage; exit 2 ;;
esac
