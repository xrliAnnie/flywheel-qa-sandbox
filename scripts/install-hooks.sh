#!/bin/bash
set -euo pipefail
# Install Flywheel hooks into ~/.claude/settings.json (atomic write)
SETTINGS="$HOME/.claude/settings.json"
HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/hooks/flywheel-session-end.sh"

# Ensure hook script is executable
chmod +x "$HOOK_SCRIPT"

# Read existing settings (or empty object)
if [ -f "$SETTINGS" ]; then
  # Validate existing JSON (validate file directly — pipe through echo can lose data)
  if ! jq empty "$SETTINGS" 2>/dev/null; then
    echo "ERROR: $SETTINGS is not valid JSON. Backup and fix manually." >&2
    exit 1
  fi
  EXISTING=$(cat "$SETTINGS")
else
  EXISTING="{}"
  mkdir -p "$(dirname "$SETTINGS")"
fi

# Merge Flywheel hooks (preserves existing hooks) → write to temp file
TMPFILE=$(mktemp "${SETTINGS}.XXXXXX")
trap 'rm -f "$TMPFILE"' EXIT

echo "$EXISTING" | jq --arg cmd "$HOOK_SCRIPT" '
  .hooks.SessionEnd //= [] |
  if (.hooks.SessionEnd | map(select(.hooks[]?.command == $cmd)) | length) == 0
  then .hooks.SessionEnd += [{"hooks": [{"type": "command", "command": $cmd}]}]
  else .
  end
' > "$TMPFILE"

# Validate output before atomic move
if ! jq empty "$TMPFILE" 2>/dev/null; then
  echo "ERROR: Generated settings JSON is invalid. Aborting." >&2
  exit 1
fi

mv "$TMPFILE" "$SETTINGS"
trap - EXIT
echo "Flywheel hooks installed in $SETTINGS"
