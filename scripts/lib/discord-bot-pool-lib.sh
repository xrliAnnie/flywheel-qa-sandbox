#!/bin/bash
# FLY-882: shared helpers for the Discord bot token pool.
#
# Manages a local, never-committed pool of pre-created blank Discord bot
# identities under ~/.flywheel/discord-bot-pool/ so claiming a Discord
# identity for a new Lead/agent no longer requires creating a fresh
# Application in the Developer Portal each time.
#
# RED LINES (FLY-882):
#   - a token is NEVER printed in full by any function here (list/verify only
#     ever show a masked tail) and NEVER stored anywhere but
#     <pool-dir>/<slot>/token (0600).
#   - pool.json stores metadata only (slot/app_id/status/timestamps) — never
#     the token value.
#   - every write path chmods 700 (dirs) / 600 (files) right after creating
#     them.
#
# There is deliberately no "create a Discord application" function here:
# Discord has no API for that — it is always a Developer Portal browser
# action (see doc/reference/discord-bot-pool-claim-guide.md). This library
# only manages state AFTER a blank bot + token already exist.
[ -n "${DISCORD_BOT_POOL_LIB_SOURCED:-}" ] && return 0
DISCORD_BOT_POOL_LIB_SOURCED=1

DISCORD_API_BASE="${DISCORD_API_BASE:-https://discord.com/api/v10}"
DISCORD_POOL_DEFAULT_PERMISSIONS="277025459264"
DISCORD_POOL_DEFAULT_GUILD="1485787271192907816"

pool_dir() { echo "${DISCORD_BOT_POOL_HOME:-$HOME/.flywheel/discord-bot-pool}"; }
pool_json_path() { echo "$(pool_dir)/pool.json"; }
pool_slot_dir() { echo "$(pool_dir)/$1"; }
pool_token_path() { echo "$(pool_slot_dir "$1")/token"; }

pool_require_jq() {
  command -v jq >/dev/null 2>&1 || { echo "discord-bot-pool: jq is required" >&2; return 1; }
}

# pool_mask_token <token>
#   NEVER echoes a full token, even for pathologically short input — below
#   9 chars there's no non-trivial tail left to mask, so show a flat
#   "(present)" instead of degrading toward printing the whole thing.
pool_mask_token() {
  local t="$1" len
  len=${#t}
  if [ "$len" -eq 0 ]; then echo "(none)"; return 0; fi
  if [ "$len" -lt 9 ]; then echo "(present)"; return 0; fi
  echo "…${t: -4}"
}

# _pool_valid_slot_name <slot>
#   Slot names are interpolated directly into filesystem paths that then get
#   chmod'd/mkdir'd/rm'd — restrict to a safe charset so a stray "../x" or
#   absolute path can never escape the pool directory.
_pool_valid_slot_name() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$1" != "." ]] && [[ "$1" != ".." ]]
}

_pool_file_mode() {
  # GNU (-c) must be tried FIRST. GNU stat's -f flag means "file system
  # status" (a totally different, unrelated mode), not "format" as it does
  # on BSD/macOS stat — so `stat -f '%Lp' "$1"` on Linux doesn't fail
  # cleanly, it silently runs in file-system mode and leaks a multi-line
  # filesystem-info block onto stdout instead of a clean permission string
  # (caught live: CI on ubuntu-latest — every 600/700 comparison broke).
  # BSD stat has no -c flag at all and fails cleanly (nonzero, stderr only,
  # no stdout), so trying -c first and falling back to -f is safe on both.
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

# _pool_valid_token_charset <token>
#   Real Discord bot tokens are base64url-ish (alnum + . _ -) with no
#   whitespace. Rejecting anything else means a token file that somehow
#   contains a quote or an embedded newline (e.g. clobbered by a stray
#   multi-line paste) can never reach _pool_curl_authed's `-K -` stdin
#   config, where such characters could break out of the `header = "..."`
#   line and inject an extra curl config directive.
_pool_valid_token_charset() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]
}

# _pool_curl_authed <token> <curl-args...>
#   Wraps curl so the bot token never appears in this (or any other local
#   process's) `ps`-visible argv — it goes to curl via a -K stdin config
#   line instead of an -H argv flag. Discord bot tokens are base64url-ish
#   (alnum + . _ -), so no quoting hazard in the config-file value.
_pool_curl_authed() {
  local tok="$1"; shift
  printf 'header = "Authorization: Bot %s"\n' "$tok" | curl -sS -K - "$@"
}

# _pool_load_token <slot>
#   Reads and validates a slot's token file before any caller trusts it for
#   a real Discord API call: must exist, be exactly mode 600, and be a
#   plausible length (>=50 chars — real Discord bot tokens are ~59+).
#   add_slot enforces/self-heals this once at registration time; this is
#   the stricter, non-healing check every *subsequent* read (verify/rename)
#   uses, so a token file that got corrupted or replaced after registration
#   (e.g. another stray `pbpaste` clobbering it) is refused instead of
#   silently sent to Discord. Prints the token to stdout on success (still
#   only ever consumed via command substitution into a local variable —
#   never echoed anywhere a human would see it).
_pool_load_token() {
  local slot="$1" tok_path mode tok
  tok_path="$(pool_token_path "$slot")"
  if [ ! -s "$tok_path" ]; then
    echo "$slot: FAIL (no token on file)" >&2
    return 1
  fi
  mode="$(_pool_file_mode "$tok_path")"
  if [ "$mode" != "600" ]; then
    echo "$slot: FAIL (token file $tok_path has mode $mode, expected 600 — refusing to use it)" >&2
    return 1
  fi
  tok="$(cat "$tok_path")"
  if [ "${#tok}" -lt 50 ]; then
    echo "$slot: FAIL (token implausibly short — ${#tok} chars, refusing to use it)" >&2
    return 1
  fi
  if ! _pool_valid_token_charset "$tok"; then
    echo "$slot: FAIL (token contains unexpected characters — refusing to use it)" >&2
    return 1
  fi
  printf '%s' "$tok"
}

# _pool_with_lock <fn> [args...]
#   Serializes pool.json read-modify-write across concurrent invocations of
#   this CLI with a portable mkdir-based lock (mkdir is atomic on POSIX
#   filesystems; no flock(1) dependency, which macOS lacks by default).
#   Without this, two concurrent `claim` calls on the same slot both read
#   status=unclaimed before either writes — confirmed live as a real lost
#   update, not just a theoretical race. `"$@" || rc=$?` (not a bare `"$@"`)
#   is required because the CLI wrapper runs under `set -e`: a bare failing
#   command would abort the script before reaching `rmdir`, wedging the
#   lock for every future invocation.
_pool_with_lock() {
  local lockdir waited=0
  lockdir="$(pool_dir)/.lock"
  while ! mkdir "$lockdir" 2>/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
    if [ "$waited" -gt 100 ]; then
      echo "discord-bot-pool: could not acquire pool.json lock after 10s (stale lock at $lockdir?)" >&2
      return 1
    fi
  done
  local rc=0
  "$@" || rc=$?
  rmdir "$lockdir" 2>/dev/null
  return $rc
}

# pool_init
#   Idempotent. Creates the pool directory (0700) and an empty pool.json
#   (0600) if missing. Never overwrites an existing pool.json.
pool_init() {
  pool_require_jq || return 1
  local dir pj
  dir="$(pool_dir)"
  mkdir -p "$dir"
  chmod 700 "$dir"
  pj="$(pool_json_path)"
  if [ ! -f "$pj" ]; then
    printf '{"slots":[]}\n' > "$pj"
    chmod 600 "$pj"
  fi
}

# pool_slot_exists <slot>
pool_slot_exists() {
  pool_require_jq || return 1
  local slot="$1"
  [ -f "$(pool_json_path)" ] || return 1
  jq -e --arg s "$slot" '.slots[] | select(.slot == $s)' "$(pool_json_path)" >/dev/null 2>&1
}

# pool_add_slot <slot> <app_id> <bot_user_id>
#   Registers a slot that was already created via the Developer Portal AND
#   whose token has already been written to <pool-dir>/<slot>/token (this
#   function does not talk to Discord — it only registers local state, and
#   enforces the token file's permissions before trusting it).
pool_add_slot() {
  pool_require_jq || return 1
  local slot="$1" app_id="$2" bot_user_id="${3:-}"
  if [ -z "$slot" ] || [ -z "$app_id" ]; then
    echo "usage: pool_add_slot <slot> <app_id> <bot_user_id>" >&2
    return 2
  fi
  if ! _pool_valid_slot_name "$slot"; then
    echo "discord-bot-pool: invalid slot name: $slot (must match ^[A-Za-z0-9._-]+\$, no path separators)" >&2
    return 2
  fi
  pool_init
  # Fast pre-check outside the lock: gives a quick, cheap error for the
  # common case before we bother validating the token file below. NOT
  # authoritative by itself — _pool_add_slot_write repeats this check while
  # holding the lock, which is what actually prevents two concurrent
  # add-slot calls for the same slot from both winning (Codex review round 2
  # reproduced this as a real lost-update: two concurrent `add-slot
  # flywheel-pool-01 ...` calls both returned 0 and left two duplicate slot
  # entries in pool.json when only this outer check existed).
  if pool_slot_exists "$slot"; then
    echo "discord-bot-pool: slot already registered: $slot" >&2
    return 1
  fi
  local tok_path; tok_path="$(pool_token_path "$slot")"
  if [ ! -s "$tok_path" ]; then
    echo "discord-bot-pool: token file missing/empty: $tok_path (write it first, e.g. via pbpaste)" >&2
    return 1
  fi
  # Real Discord bot tokens are ~59+ chars. A short file here almost always
  # means the clipboard Copy click silently failed and pbpaste picked up
  # stale/unrelated clipboard content instead (observed live: a leftover
  # 16-byte snippet from earlier in the session). Catch that before it gets
  # registered as if it were a working token.
  local tok_len; tok_len=$(wc -c < "$tok_path" | tr -d ' ')
  if [ "$tok_len" -lt 50 ]; then
    echo "discord-bot-pool: token file implausibly short ($tok_len bytes) — Copy likely didn't land in the clipboard; re-copy and retry" >&2
    return 1
  fi
  local tok_content; tok_content="$(cat "$tok_path")"
  if ! _pool_valid_token_charset "$tok_content"; then
    echo "discord-bot-pool: token file contains unexpected characters (expected only alnum . _ -) — refusing to register, check for copy/paste corruption" >&2
    return 1
  fi
  chmod 700 "$(pool_slot_dir "$slot")"
  chmod 600 "$tok_path"
  local mode; mode="$(_pool_file_mode "$tok_path")"
  if [ "$mode" != "600" ]; then
    echo "discord-bot-pool: could not enforce 600 on $tok_path (got $mode)" >&2
    return 1
  fi
  _pool_with_lock _pool_add_slot_write "$slot" "$app_id" "$bot_user_id"
}

# _pool_add_slot_write <slot> <app_id> <bot_user_id>
#   Runs INSIDE the _pool_with_lock lock. Repeats the "already registered"
#   check right before writing — the only place that check is authoritative.
#   pool_add_slot's outer pool_slot_exists check (before the lock) is just a
#   fast pre-check; without this inner re-check, two concurrent add-slot
#   calls for the same slot could both pass the outer check before either
#   acquires the lock, and both append a duplicate slot entry (Codex review
#   round 2 reproduced this live).
_pool_add_slot_write() {
  local slot="$1" app_id="$2" bot_user_id="$3" now pj tmp
  pj="$(pool_json_path)"
  if jq -e --arg s "$slot" '.slots[] | select(.slot == $s)' "$pj" >/dev/null 2>&1; then
    echo "discord-bot-pool: slot already registered: $slot" >&2
    return 1
  fi
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$(mktemp)"
  jq --arg slot "$slot" --arg app_id "$app_id" --arg bot_user_id "$bot_user_id" --arg now "$now" \
    '.slots += [{slot:$slot, app_id:$app_id, bot_user_id:$bot_user_id, display_name:$slot, status:"unclaimed", created_at:$now, claimed_by:null, claimed_at:null, invited_at:null}]' \
    "$pj" > "$tmp" && mv "$tmp" "$pj"
  chmod 600 "$pj"
  echo "$slot: registered (app_id=$app_id)"
}

# pool_list
#   Prints a table. NEVER prints raw token content — only whether a token
#   file exists and a masked tail.
pool_list() {
  pool_require_jq || return 1
  local pj; pj="$(pool_json_path)"
  if [ ! -f "$pj" ]; then
    echo "(pool not initialized — run: discord-bot-pool.sh init)" >&2
    return 1
  fi
  printf '%-20s %-28s %-10s %s\n' "SLOT" "STATUS" "TOKEN" "INVITED"
  local slot status invited_at tokpath masked
  while IFS=$'\t' read -r slot status invited_at; do
    tokpath="$(pool_token_path "$slot")"
    if [ -s "$tokpath" ]; then
      masked="$(pool_mask_token "$(cat "$tokpath")")"
    else
      masked="(missing)"
    fi
    [ "$invited_at" = "null" ] && invited_at="-"
    printf '%-20s %-28s %-10s %s\n' "$slot" "$status" "$masked" "$invited_at"
  done < <(jq -r '.slots[] | [.slot, .status, (.invited_at // "null")] | @tsv' "$pj")
}

# pool_verify <slot>
#   Read-only against Discord (GET /users/@me only — never writes anything
#   back to Discord). Returns 0 + prints "<slot>: OK (username)" on 200;
#   returns 1 + prints failure otherwise. Never prints the token.
#   Side effect (local only): on success, backfills pool.json's bot_user_id
#   for this slot from the response's `id` field if it's still empty — this
#   is the only place that liveness check happens, so it's also the only
#   place that can attest the real bot_user_id.
_pool_backfill_bot_user_id() {
  local slot="$1" botid="$2" pj tmp
  pj="$(pool_json_path)"; tmp="$(mktemp)"
  jq --arg s "$slot" --arg bid "$botid" \
    '(.slots[] | select(.slot==$s and (.bot_user_id // "") == "")) |= (.bot_user_id = $bid)' \
    "$pj" > "$tmp" && mv "$tmp" "$pj"
  chmod 600 "$pj"
}

pool_verify() {
  local slot="$1"
  if ! _pool_valid_slot_name "$slot"; then
    echo "discord-bot-pool: invalid slot name: $slot" >&2
    return 2
  fi
  local tok; tok="$(_pool_load_token "$slot")" || return 1
  local body code
  body="$(mktemp)"
  code=$(_pool_curl_authed "$tok" -o "$body" -w '%{http_code}' \
    -H "User-Agent: DiscordBot (flywheel, 1.0)" \
    "${DISCORD_API_BASE}/users/@me")
  if [ "$code" = "200" ]; then
    local uname botid; uname=$(jq -r '.username // "?"' "$body" 2>/dev/null)
    botid=$(jq -r '.id // empty' "$body" 2>/dev/null)
    if [ -n "$botid" ] && pool_require_jq && [ -f "$(pool_json_path)" ] && pool_slot_exists "$slot"; then
      _pool_with_lock _pool_backfill_bot_user_id "$slot" "$botid"
    fi
    echo "$slot: OK ($uname)"
    rm -f "$body"
    return 0
  fi
  echo "$slot: FAIL (http $code)" >&2
  rm -f "$body"
  return 1
}

# pool_rename <slot> <new-username>
#   PATCH /users/@me {"username": new-username} — changes only the bot's
#   Discord username. The Developer Portal "Application name" field requires
#   an OAuth2 bearer token (different auth flow) and is out of scope here;
#   it stays a manual, optional Portal step.
pool_rename() {
  local slot="$1" new_name="${2:-}"
  if [ -z "$slot" ] || [ -z "$new_name" ]; then
    echo "usage: pool_rename <slot> <new-username>" >&2
    return 2
  fi
  if ! _pool_valid_slot_name "$slot"; then
    echo "discord-bot-pool: invalid slot name: $slot" >&2
    return 2
  fi
  local tok; tok="$(_pool_load_token "$slot")" || return 1
  local body payload code
  body="$(mktemp)"
  payload=$(jq -n --arg u "$new_name" '{username:$u}')
  code=$(_pool_curl_authed "$tok" -o "$body" -w '%{http_code}' -X PATCH \
    -H "Content-Type: application/json" \
    -H "User-Agent: DiscordBot (flywheel, 1.0)" \
    -d "$payload" \
    "${DISCORD_API_BASE}/users/@me")
  rm -f "$body"
  if [ "$code" = "200" ]; then
    echo "$slot: renamed to $new_name"
    return 0
  fi
  echo "$slot: FAIL rename (http $code)" >&2
  return 1
}

# pool_invite_url <slot> [permissions] [guild_id]
pool_invite_url() {
  pool_require_jq || return 1
  local slot="$1"
  local perms="${2:-$DISCORD_POOL_DEFAULT_PERMISSIONS}"
  local guild="${3:-$DISCORD_POOL_DEFAULT_GUILD}"
  local app_id
  app_id=$(jq -r --arg s "$slot" '.slots[] | select(.slot==$s) | .app_id' "$(pool_json_path)" 2>/dev/null)
  if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
    echo "discord-bot-pool: unknown slot: $slot" >&2
    return 1
  fi
  echo "https://discord.com/oauth2/authorize?client_id=${app_id}&scope=bot&permissions=${perms}&guild_id=${guild}&disable_guild_select=true"
}

# _pool_claim_write <slot> <claimed-by>
#   The actual read-check-write, run only while _pool_with_lock holds the
#   pool.json lock — this is what makes the unclaimed-status check and the
#   write atomic w.r.t. other concurrent `claim` calls. Codex's review
#   reproduced a real lost-update race here: two concurrent `claim` calls on
#   the same slot both read status=unclaimed before either wrote, so both
#   "succeeded" and the second silently overwrote the first claimant.
_pool_claim_write() {
  local slot="$1" claimed_by="$2" pj current now tmp
  pj="$(pool_json_path)"
  current=$(jq -r --arg s "$slot" '.slots[] | select(.slot==$s) | .status' "$pj")
  if [ "$current" != "unclaimed" ]; then
    echo "discord-bot-pool: slot $slot is not unclaimed (status=$current)" >&2
    return 1
  fi
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$(mktemp)"
  jq --arg s "$slot" --arg cb "$claimed_by" --arg now "$now" \
    '(.slots[] | select(.slot==$s)) |= (.status = ("claimed-by-" + $cb) | .claimed_by = $cb | .claimed_at = $now)' \
    "$pj" > "$tmp" && mv "$tmp" "$pj"
  chmod 600 "$pj"
  echo "$slot: claimed by $claimed_by"
}

# pool_claim <slot> <claimed-by>
#   Marks a slot claimed. Refuses if not currently unclaimed. invited_at is
#   left untouched — inviting the bot into the server is a separate,
#   deliberate step (see doc/reference/discord-bot-pool-claim-guide.md).
pool_claim() {
  pool_require_jq || return 1
  local slot="$1" claimed_by="${2:-}"
  if [ -z "$slot" ] || [ -z "$claimed_by" ]; then
    echo "usage: pool_claim <slot> <claimed-by>" >&2
    return 2
  fi
  if ! pool_slot_exists "$slot"; then
    echo "discord-bot-pool: unknown slot: $slot" >&2
    return 1
  fi
  _pool_with_lock _pool_claim_write "$slot" "$claimed_by"
}
