#!/bin/bash
# FLY-1676: verify the CLI-managed Discord plugin is exactly the fork's main.
set -euo pipefail

PLUGIN_KEY="discord@flywheel-plugins"
FORK_URL="https://github.com/xrliAnnie/claude-plugins-official.git"
FORK_REF="refs/heads/main"
CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
REGISTRY="${CLAUDE_ROOT}/plugins/installed_plugins.json"
PRINT_INSTALL_PATH=false

case "${1:-}" in
  "") ;;
  --print-install-path) PRINT_INSTALL_PATH=true ;;
  --print-contract)
    printf 'discord@flywheel-plugins/v1\n'
    exit 0
    ;;
  *) echo "Usage: check-discord-plugin.sh [--print-install-path|--print-contract]" >&2; exit 2 ;;
esac

if [ ! -f "$REGISTRY" ]; then
  echo "MISSING: Claude plugin registry not found: $REGISTRY" >&2
  exit 1
fi

registry_result="$(python3 - "$REGISTRY" "$PLUGIN_KEY" "$CLAUDE_ROOT" <<'PY'
import json
import os
import re
import sys

registry, plugin_key, claude_root = sys.argv[1:]
try:
    with open(registry, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid registry: {error}")

entries = data.get("plugins", {}).get(plugin_key, [])
if len(entries) != 1 or entries[0].get("scope") != "user":
    raise SystemExit(f"expected exactly one user entry for {plugin_key}")

entry = entries[0]
sha = entry.get("gitCommitSha", "")
install_path = entry.get("installPath", "")
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise SystemExit("registry gitCommitSha is not a full lowercase commit SHA")
if not os.path.isabs(install_path) or not os.path.isdir(install_path):
    raise SystemExit("registry installPath is missing, relative, or not a directory")

cache_root = os.path.realpath(os.path.join(claude_root, "plugins", "cache"))
real_install_path = os.path.realpath(install_path)
try:
    contained = os.path.commonpath([cache_root, real_install_path]) == cache_root
except ValueError:
    contained = False
if not contained:
    raise SystemExit("registry installPath escapes the Claude plugin cache")

print(sha)
print(install_path)
PY
)" || {
  echo "INVALID: ${PLUGIN_KEY} registry entry is not authoritative" >&2
  exit 1
}

INSTALLED_SHA="$(printf '%s\n' "$registry_result" | sed -n '1p')"
INSTALL_PATH="$(printf '%s\n' "$registry_result" | sed -n '2p')"

SERVER_TS="${INSTALL_PATH}/server.ts"
if [ ! -f "$SERVER_TS" ]; then
  echo "INVALID: Discord server.ts missing at ${SERVER_TS}" >&2
  exit 1
fi
for marker in 'allowBots' '[reply-guard]'; do
  if ! grep -Fq "$marker" "$SERVER_TS"; then
    echo "VANILLA: required fork marker missing from server.ts: ${marker}" >&2
    exit 1
  fi
done
if ! grep -Fq 'ChatReceiptRuntime' "$SERVER_TS" \
    && ! grep -Fq 'ChatIngestRuntime' "$SERVER_TS"; then
  echo "VANILLA: required fork runtime marker missing from server.ts" >&2
  exit 1
fi

if ! REMOTE_SHA="$(python3 - "$FORK_URL" "$FORK_REF" <<'PY'
import subprocess
import sys

url, ref = sys.argv[1:]
try:
    result = subprocess.run(
        ["git", "ls-remote", url, ref],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
except (OSError, subprocess.SubprocessError) as error:
    raise SystemExit(f"could not resolve fork main: {error}")

lines = [line.split() for line in result.stdout.splitlines() if line.strip()]
matches = [fields[0] for fields in lines if len(fields) == 2 and fields[1] == ref]
if len(matches) != 1:
    raise SystemExit(f"expected one {ref} from git ls-remote")
print(matches[0])
PY
)"; then
  echo "WARNING: remote freshness unavailable; accepting marker-verified local fork bytes at ${INSTALLED_SHA}" >&2
  if [ "$PRINT_INSTALL_PATH" = true ]; then
    printf '%s\n' "$INSTALL_PATH"
  else
    echo "DEGRADED: ${PLUGIN_KEY} local fork markers verified; remote SHA unavailable"
  fi
  exit 0
fi

if [ "$INSTALLED_SHA" != "$REMOTE_SHA" ]; then
  echo "OUTDATED: installed=${INSTALLED_SHA} fork-main=${REMOTE_SHA}" >&2
  exit 1
fi

if [ "$PRINT_INSTALL_PATH" = true ]; then
  printf '%s\n' "$INSTALL_PATH"
else
  echo "OK: ${PLUGIN_KEY} matches fork main (${INSTALLED_SHA}) with all critical markers"
fi
