#!/bin/bash
# FLY-1185 §2.7 (prevention leg) — machine-level MCP on-demand default.
#
# Sets `enabledPlugins["playwright@claude-plugins-official"] = false` in the
# machine Claude settings so runner sessions do NOT spawn a playwright-mcp
# child by default. The positive opt-in channel (QA role / `playwright` label /
# `full-mcp` label → per-launch --settings enabledPluginsExtra) opens it back
# per session. This does NOT remove the marketplace registration (FLY-812:
# geoforge3d needs playwright — founder ruling; prevention ≠ physical removal).
#
# Contract (deliverable 19): idempotent · atomic write · preserves file mode ·
# refuses symlinks · refuses bad JSON (never clobbers) · backup only on change.
#
# Usage: setup-mcp-on-demand.sh [path-to-settings.json]
#        (default: ~/.claude/settings.json)
set -euo pipefail

SETTINGS="${1:-$HOME/.claude/settings.json}"
PLUGIN_KEY="playwright@claude-plugins-official"

if [ -L "$SETTINGS" ]; then
  echo "[setup-mcp-on-demand] REFUSE: $SETTINGS is a symlink" >&2
  exit 1
fi

if [ ! -f "$SETTINGS" ]; then
  echo "[setup-mcp-on-demand] REFUSE: $SETTINGS does not exist (won't create a machine settings file from scratch)" >&2
  exit 1
fi

# Validate JSON BEFORE touching anything — a corrupt settings file must never
# be "fixed" by this script (fail loud, leave the file byte-identical).
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$SETTINGS" 2>/dev/null; then
  echo "[setup-mcp-on-demand] REFUSE: $SETTINGS is not valid JSON — fix it manually first" >&2
  exit 1
fi

# Idempotence probe: already false → no write, no backup.
if python3 - "$SETTINGS" "$PLUGIN_KEY" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if d.get("enabledPlugins", {}).get(sys.argv[2]) is False else 1)
PY
then
  echo "[setup-mcp-on-demand] no-op: $PLUGIN_KEY already false in $SETTINGS"
  exit 0
fi

# Change needed → backup first (only on change), then atomic same-dir replace.
BACKUP="${SETTINGS}.bak-mcp-on-demand-$(date +%Y%m%d%H%M%S)"
cp -p "$SETTINGS" "$BACKUP"

TMP="$(mktemp "${SETTINGS}.tmp.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

python3 - "$SETTINGS" "$PLUGIN_KEY" > "$TMP" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d.setdefault("enabledPlugins", {})[sys.argv[2]] = False
json.dump(d, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
PY

# Preserve the original file mode on the replacement.
MODE="$(stat -f '%Lp' "$SETTINGS" 2>/dev/null || stat -c '%a' "$SETTINGS")"
chmod "$MODE" "$TMP"
mv "$TMP" "$SETTINGS"
trap - EXIT

echo "[setup-mcp-on-demand] set $PLUGIN_KEY=false in $SETTINGS (backup: $BACKUP)"
