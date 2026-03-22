#!/bin/bash
# GEO-195: Manual supervisor script for Claude Lead session.
# Usage: ./scripts/claude-lead.sh <lead-id> <project-dir>
#
# Run inside a tmux session:
#   tmux new -s product-lead
#   ./scripts/claude-lead.sh product-lead /Users/xiaorongli/Dev/geoforge3d
#
# On crash: up-arrow + enter to restart.
set -euo pipefail

LEAD_ID="${1:?Usage: claude-lead.sh <lead-id> <project-dir>}"
PROJECT_DIR="${2:?Usage: claude-lead.sh <lead-id> <project-dir>}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
BRIDGE_TOKEN="${TEAMLEAD_API_TOKEN:-}"
SESSION_DIR="${HOME}/.flywheel/claude-sessions"
SESSION_ID_FILE="${SESSION_DIR}/${LEAD_ID}.session-id"

mkdir -p "$SESSION_DIR"

# Send bootstrap via Bridge API
echo "[lead] Sending bootstrap for ${LEAD_ID}..."
if [ -n "$BRIDGE_TOKEN" ]; then
  curl -s -X POST "${BRIDGE_URL}/api/bootstrap/${LEAD_ID}" \
    -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
    -H "Content-Type: application/json" || echo "[lead] Bootstrap failed (non-fatal)"
else
  curl -s -X POST "${BRIDGE_URL}/api/bootstrap/${LEAD_ID}" \
    -H "Content-Type: application/json" || echo "[lead] Bootstrap failed (non-fatal)"
fi

# Wait for bootstrap message to arrive in Discord
sleep 3

# Launch Claude in the project directory
cd "$PROJECT_DIR"

# Resume if we have a session ID, otherwise start fresh
if [ -f "$SESSION_ID_FILE" ]; then
  SESSION_ID=$(cat "$SESSION_ID_FILE")
  echo "[lead] Resuming session ${SESSION_ID}..."
  echo "[lead] (To clear session: rm ${SESSION_ID_FILE})"
  claude --resume "$SESSION_ID" \
    --channels "plugin:discord@claude-plugins-official" \
    --dangerously-skip-permissions
else
  echo "[lead] Starting fresh session..."
  echo "[lead] After Claude starts, save the session ID with:"
  echo "[lead]   echo '<session-id>' > ${SESSION_ID_FILE}"
  echo "[lead] You can find it in ~/.claude/projects/*/sessions/"
  claude \
    --channels "plugin:discord@claude-plugins-official" \
    --dangerously-skip-permissions \
    | tee >(
      # Attempt to capture session ID from Claude's startup output
      grep -m1 -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        > "$SESSION_ID_FILE" 2>/dev/null || true
    )
  # If the grep captured a session ID, log it
  if [ -f "$SESSION_ID_FILE" ] && [ -s "$SESSION_ID_FILE" ]; then
    echo "[lead] Auto-captured session ID: $(cat "$SESSION_ID_FILE")"
  fi
fi
