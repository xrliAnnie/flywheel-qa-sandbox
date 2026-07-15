#!/usr/bin/env bash
# FLY-281: Set a Flywheel lead bot's Discord avatar via PATCH /users/@me.
#
# Reads the bot token from an env var BY NAME — the token is never hardcoded,
# never passed on the command line, and never printed (only a redacted form is
# ever echoed). Each lead bot has its own token env var (e.g. CASS_BOT_TOKEN,
# TADASHI_BOT_TOKEN) already present in ~/.flywheel/.env.
#
# Usage:
#   scripts/set-lead-avatar.sh --bot cass     --image /path/to/avatar.png
#   scripts/set-lead-avatar.sh --bot tadashi  --image /path/to/avatar.png
#   scripts/set-lead-avatar.sh --token-env CASS_BOT_TOKEN --image /path/to/avatar.png
#
#   Add --dry-run to validate everything and print the request that WOULD be
#   sent (token redacted) WITHOUT calling Discord. Use it to sanity-check before
#   the real apply.
#
# Source the env first so the token vars are present, e.g.:
#   set -a; source ~/.flywheel/.env; set +a
#
# Discord accepts PNG, JPEG and GIF avatars (GIF only takes effect for bots with
# the right perms; a static frame is used otherwise).
set -euo pipefail

DISCORD_API="${DISCORD_API:-https://discord.com/api/v10}"

log()     { echo "[set-lead-avatar] $*"; }
log_err() { echo "[set-lead-avatar] ERROR: $*" >&2; }

# detect_mime <file> — echo the image mime type from magic bytes (extension is
# ignored on purpose). Echoes nothing + returns 1 for unsupported types.
detect_mime() {
  local file="$1" mime
  mime=$(file -b --mime-type "$file" 2>/dev/null || true)
  case "$mime" in
    image/png|image/jpeg|image/gif) echo "$mime"; return 0 ;;
    *) return 1 ;;
  esac
}

# build_data_uri <file> — echo a single-line `data:<mime>;base64,<data>` URI.
build_data_uri() {
  local file="$1" mime b64
  mime=$(detect_mime "$file") || return 1
  # base64 output is stripped of newlines for portability (BSD vs GNU wrapping).
  b64=$(base64 < "$file" | tr -d '\n')
  printf 'data:%s;base64,%s' "$mime" "$b64"
}

# resolve_token_env <bot> — map a friendly bot name to its token env var name.
resolve_token_env() {
  case "$1" in
    cass)    echo "CASS_BOT_TOKEN" ;;
    tadashi) echo "TADASHI_BOT_TOKEN" ;;
    *) log_err "unknown bot '$1' (known: cass, tadashi). Use --token-env to name the env var explicitly."; return 1 ;;
  esac
}

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
  local bot="" token_env="" image="" dry_run=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --bot)        bot="${2:-}"; shift 2 ;;
      --token-env)  token_env="${2:-}"; shift 2 ;;
      --image)      image="${2:-}"; shift 2 ;;
      --dry-run)    dry_run=true; shift ;;
      -h|--help)    usage; return 0 ;;
      *) log_err "unknown argument: $1"; usage >&2; return 2 ;;
    esac
  done

  # Resolve the token env var name (from --token-env or --bot).
  if [ -z "$token_env" ]; then
    [ -n "$bot" ] || { log_err "need --bot <cass|tadashi> or --token-env <VAR>"; return 2; }
    token_env=$(resolve_token_env "$bot") || return 2
  fi

  # Validate image.
  [ -n "$image" ] || { log_err "need --image <path>"; return 2; }
  [ -f "$image" ] || { log_err "image not found: $image"; return 2; }
  local mime
  mime=$(detect_mime "$image") || { log_err "unsupported image type for '$image' (need PNG/JPEG/GIF)"; return 2; }

  # Resolve the token from the named env var WITHOUT printing it.
  local token="${!token_env:-}"
  if [ -z "$token" ]; then
    log_err "env var \$$token_env is unset or empty — source ~/.flywheel/.env first"
    return 2
  fi

  local data_uri payload
  data_uri=$(build_data_uri "$image") || { log_err "failed to encode image"; return 1; }
  # Build JSON safely. jq if available, else a printf fallback (the data URI is
  # JSON-safe: base64 alphabet + the fixed prefix contain no chars needing escape).
  if command -v jq >/dev/null 2>&1; then
    payload=$(jq -n --arg a "$data_uri" '{avatar:$a}')
  else
    payload="{\"avatar\":\"$data_uri\"}"
  fi

  log "bot token env : \$$token_env (len ${#token}, value redacted)"
  log "image         : $image ($mime, payload ${#payload} bytes)"
  log "request       : PATCH $DISCORD_API/users/@me"

  if [ "$dry_run" = true ]; then
    log "DRY RUN — not calling Discord. Authorization: Bot <redacted>"
    return 0
  fi

  # Real apply. Write BOTH the payload and the auth header to temp files
  # (mode 600) so neither the token nor the large payload ever appears in
  # curl's argv — argv is world-visible to other processes via `ps`/proc while
  # the request runs. curl reads the header from the file with `-H @file`
  # (curl >= 7.55) and the body with `--data @file`.
  local body_file hdr_file resp http_code
  body_file=$(mktemp); hdr_file=$(mktemp); resp=$(mktemp)
  chmod 600 "$hdr_file" "$body_file"
  # shellcheck disable=SC2064
  trap "rm -f '$body_file' '$hdr_file' '$resp'" RETURN
  printf '%s' "$payload" > "$body_file"
  printf 'Authorization: Bot %s\n' "$token" > "$hdr_file"

  http_code=$(curl -sS -o "$resp" -w '%{http_code}' \
    -X PATCH "$DISCORD_API/users/@me" \
    -H @"$hdr_file" \
    -H "Content-Type: application/json" \
    --data @"$body_file") || { log_err "curl failed"; return 1; }

  if [ "$http_code" = "200" ]; then
    local who
    who=$(jq -r '.username // "?"' "$resp" 2>/dev/null || echo "?")
    log "OK — avatar updated for bot '$who' (HTTP 200)"
    return 0
  else
    log_err "Discord returned HTTP $http_code:"
    cat "$resp" >&2
    return 1
  fi
}

# Only run main when executed directly (lets tests source the helpers).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
