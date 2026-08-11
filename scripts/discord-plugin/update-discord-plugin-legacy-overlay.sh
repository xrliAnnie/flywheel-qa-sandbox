#!/bin/bash
# FLY-1676 recovery only. Normal operation uses update-discord-plugin.sh.
# This intentionally owns a dedicated deploy clone and never resets a developer checkout.
set -euo pipefail

FORK_URL="https://github.com/xrliAnnie/claude-plugins-official.git"
DEPLOY_REPO="${FLYWHEEL_DISCORD_LEGACY_REPO_DIR:-${HOME}/.flywheel/repos/claude-plugins-official-deploy}"
CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
REGISTRY="${CLAUDE_ROOT}/plugins/installed_plugins.json"

if [ -d "$DEPLOY_REPO/.git" ]; then
  ORIGIN_URL="$(git -C "$DEPLOY_REPO" remote get-url origin)"
  [ "$ORIGIN_URL" = "$FORK_URL" ] \
    || { echo "ERROR: recovery clone origin is not the Flywheel fork: $ORIGIN_URL" >&2; exit 1; }
  git -C "$DEPLOY_REPO" fetch --prune origin main
else
  [ ! -e "$DEPLOY_REPO" ] \
    || { echo "ERROR: recovery clone path exists but is not a git repository: $DEPLOY_REPO" >&2; exit 1; }
  mkdir -p "$(dirname "$DEPLOY_REPO")"
  git clone --branch main --single-branch "$FORK_URL" "$DEPLOY_REPO"
fi
git -C "$DEPLOY_REPO" switch --force-create main origin/main

CACHE_DIR="$(python3 - "$REGISTRY" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    entries = json.load(handle).get("plugins", {}).get("discord@claude-plugins-official", [])
if len(entries) != 1 or entries[0].get("scope") != "user":
    raise SystemExit(1)
print(entries[0].get("installPath", ""))
PY
)" || { echo "ERROR: expected one legacy user installation" >&2; exit 1; }
[ -d "$CACHE_DIR" ] || { echo "ERROR: legacy cache target is missing: $CACHE_DIR" >&2; exit 1; }

SOURCE_DIR="${DEPLOY_REPO}/external_plugins/discord"
MARKETPLACE_DIR="${CLAUDE_ROOT}/plugins/marketplaces/claude-plugins-official/external_plugins/discord"
[ -d "$SOURCE_DIR" ] || { echo "ERROR: fork Discord source is missing" >&2; exit 1; }
[ -d "$MARKETPLACE_DIR" ] || { echo "ERROR: legacy marketplace target is missing" >&2; exit 1; }

for target in "$CACHE_DIR" "$MARKETPLACE_DIR"; do
  rsync -a --delete --exclude=node_modules "$SOURCE_DIR/" "$target/"
  (cd "$target" && bun install --no-summary)
  git -C "$DEPLOY_REPO" rev-parse HEAD > "$target/.fork-sha"
done

echo "RECOVERED: legacy cache and marketplace overlays now match fork main"
