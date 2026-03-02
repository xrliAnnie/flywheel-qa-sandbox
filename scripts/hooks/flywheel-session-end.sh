#!/bin/bash
set -euo pipefail
# Flywheel SessionEnd hook — writes completion marker for TmuxRunner.
# Inert when Flywheel is not running (marker dir absent).
MARKER_DIR="${FLYWHEEL_MARKER_DIR:-/tmp/flywheel/sessions}"
[ -d "$MARKER_DIR" ] || exit 0

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Validate: must be a UUID format
if [ -z "$SESSION_ID" ] || ! echo "$SESSION_ID" | grep -qE '^[0-9a-f-]{36}$'; then
  exit 0
fi

# Write completion marker with session metadata
echo "$INPUT" > "$MARKER_DIR/$SESSION_ID.done"
