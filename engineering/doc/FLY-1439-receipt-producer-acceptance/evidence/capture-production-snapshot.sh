#!/usr/bin/env bash
# Stable, secret-free snapshot used before/after FLY-1439 QA. No timestamps:
# byte-identical output is the production-zero-write proof.
set -euo pipefail

CLAUDE_ROOT="${HOME}/.claude"
FLYWHEEL_ROOT="${HOME}/.flywheel"
INSTALLED="${CLAUDE_ROOT}/plugins/installed_plugins.json"
KNOWN="${CLAUDE_ROOT}/plugins/known_marketplaces.json"
MKT="${CLAUDE_ROOT}/plugins/marketplaces/claude-plugins-official/external_plugins/discord"
FORK_REPO="${FLYWHEEL_ROOT}/repos/claude-plugins-official"
PROD_DB="${FLYWHEEL_ROOT}/teamlead.db"

sha() {
  if [[ -f "$1" ]]; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf 'MISSING'
  fi
}

CACHE="$(jq -r '.plugins["discord@claude-plugins-official"][0].installPath // empty' "$INSTALLED")"
printf 'installed_plugins_sha256=%s\n' "$(sha "$INSTALLED")"
printf 'known_marketplaces_sha256=%s\n' "$(sha "$KNOWN")"
printf 'active_cache=%s\n' "$CACHE"
printf 'cache_server_sha256=%s\n' "$(sha "$CACHE/server.ts")"
printf 'cache_fork_sha256=%s\n' "$(sha "$CACHE/.fork-sha")"
printf 'marketplace_server_sha256=%s\n' "$(sha "$MKT/server.ts")"
printf 'marketplace_fork_sha256=%s\n' "$(sha "$MKT/.fork-sha")"

if [[ -d "$FORK_REPO/.git" ]]; then
  printf 'fork_repo_head=%s\n' "$(git -C "$FORK_REPO" rev-parse HEAD)"
  FORK_STATUS="$(git -C "$FORK_REPO" status --porcelain)"
  printf 'fork_repo_status_lines=%s\n' "$(printf '%s\n' "$FORK_STATUS" | sed '/^$/d' | wc -l | tr -d ' ')"
  printf 'fork_repo_status_sha256=%s\n' "$(printf '%s' "$FORK_STATUS" | shasum -a 256 | awk '{print $1}')"
else
  printf 'fork_repo_head=MISSING\nfork_repo_status_lines=MISSING\nfork_repo_status_sha256=MISSING\n'
fi

MARKER="$(sqlite3 -readonly "$PROD_DB" \
  "SELECT state || '|' || COALESCE(active_secret_id,'') || '|' || COALESCE(prepared_secret_id,'') FROM delivery_secret_state WHERE singleton=1;" \
  2>/dev/null || true)"
printf 'delivery_marker=%s\n' "${MARKER:-MISSING}"
find "$FLYWHEEL_ROOT" -maxdepth 1 -type f -name 'delivery-secret.*' -print0 \
  | sort -z \
  | while IFS= read -r -d '' secret; do
      printf 'delivery_file=%s sha256=%s mode=%s\n' \
        "$(basename "$secret")" \
        "$(sha "$secret")" \
        "$(stat -f '%Lp' "$secret")"
    done
