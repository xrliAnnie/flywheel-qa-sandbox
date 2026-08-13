#!/bin/bash
# FLY-1676 recovery only: verify the pre-pointer overlay installation.
set -euo pipefail

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
REGISTRY="${CLAUDE_ROOT}/plugins/installed_plugins.json"
DEPLOY_REPO="${FLYWHEEL_DISCORD_LEGACY_REPO_DIR:-${HOME}/.flywheel/repos/claude-plugins-official-deploy}"

if [ ! -f "$REGISTRY" ] || [ ! -d "$DEPLOY_REPO/.git" ]; then
  echo "MISSING: legacy registry or dedicated recovery clone is absent" >&2
  exit 1
fi

CACHE_DIR="$(python3 - "$REGISTRY" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    entries = json.load(handle).get("plugins", {}).get("discord@claude-plugins-official", [])
if len(entries) != 1 or entries[0].get("scope") != "user":
    raise SystemExit(1)
print(entries[0].get("installPath", ""))
PY
)" || { echo "INVALID: expected one legacy user installation" >&2; exit 1; }

EXPECTED_SHA="$(git -C "$DEPLOY_REPO" rev-parse HEAD)"
MARKETPLACE_DIR="${CLAUDE_ROOT}/plugins/marketplaces/claude-plugins-official/external_plugins/discord"
for target in "$CACHE_DIR" "$MARKETPLACE_DIR"; do
  [ -d "$target" ] || { echo "MISSING: legacy overlay target $target" >&2; exit 1; }
  [ "$(cat "$target/.fork-sha" 2>/dev/null)" = "$EXPECTED_SHA" ] \
    || { echo "STALE: legacy overlay SHA mismatch in $target" >&2; exit 1; }
  for marker in 'allowBots' '[reply-guard]'; do
    grep -Fq "$marker" "$target/server.ts" \
      || { echo "VANILLA: legacy target $target misses $marker" >&2; exit 1; }
  done
  if ! grep -Fq 'ChatReceiptRuntime' "$target/server.ts" \
      && ! grep -Fq 'ChatIngestRuntime' "$target/server.ts"; then
    echo "VANILLA: legacy target $target misses a fork runtime marker" >&2
    exit 1
  fi
done

echo "OK: recovery overlay matches dedicated fork clone (${EXPECTED_SHA})"
