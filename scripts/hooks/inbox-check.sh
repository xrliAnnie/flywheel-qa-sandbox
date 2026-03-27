#!/bin/bash
# Flywheel Runner Inbox Check — PostToolUse Hook (GEO-266)
#
# Checks CommDB for unread Lead instructions via sqlite3 CLI and injects them
# as additionalContext into Claude's conversation. No-op when FLYWHEEL_EXEC_ID
# is not set, making it safe for non-Runner sessions.
#
# Dependencies: sqlite3 (macOS built-in), jq (brew install jq)
# Env vars:    FLYWHEEL_EXEC_ID  — Runner execution ID (set by TmuxAdapter)
#              FLYWHEEL_COMM_DB  — CommDB path (set by TmuxAdapter)
#
# Deployed to: ~/.flywheel/hooks/inbox-check.sh (via /setup-flywheel-hooks)

set -euo pipefail

EXEC_ID="${FLYWHEEL_EXEC_ID:-}"
DB_PATH="${FLYWHEEL_COMM_DB:-}"

# Quick exit for non-Runner sessions (zero overhead)
if [ -z "$EXEC_ID" ] || [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Helper: run sqlite3 with busy_timeout via -cmd flag (no stdout noise)
sq_ro() { sqlite3 -readonly -cmd ".timeout 5000" "$DB_PATH" "$1" 2>/dev/null; }
sq()    { sqlite3 -cmd ".timeout 5000" "$DB_PATH" "$1" 2>/dev/null; }

# Check for unread instructions (read-only for speed)
COUNT=$(sq_ro "SELECT COUNT(*) FROM messages WHERE to_agent='${EXEC_ID}' AND type='instruction' AND read_at IS NULL AND expires_at > datetime('now');" || echo "0")

if [ "$COUNT" -eq "0" ] 2>/dev/null; then
  exit 0
fi

# Read specific instruction IDs and content (not blanket — avoids race condition)
# Output format: id|from_agent|content  (one per line)
ROWS=$(sq "SELECT id || '|' || from_agent || '|' || content FROM messages WHERE to_agent='${EXEC_ID}' AND type='instruction' AND read_at IS NULL AND expires_at > datetime('now') ORDER BY created_at ASC;") || exit 0

if [ -z "$ROWS" ]; then
  exit 0
fi

# Extract IDs for targeted read-marking (only mark what we actually retrieved)
IDS=""
DISPLAY_MSGS=""
while IFS='|' read -r id from_agent content; do
  if [ -n "$id" ]; then
    if [ -n "$IDS" ]; then
      IDS="${IDS},'${id}'"
    else
      IDS="'${id}'"
    fi
    DISPLAY_MSGS="${DISPLAY_MSGS}[${from_agent}]: ${content}
"
  fi
done <<< "$ROWS"

if [ -z "$IDS" ]; then
  exit 0
fi

# Mark only the retrieved IDs as read (not blanket update)
sq "UPDATE messages SET read_at=datetime('now') WHERE id IN (${IDS});" || true

# Build additionalContext
HEADER="LEAD INSTRUCTION — Read and act on these instructions"

# Output JSON for Claude Code hook system
jq -n --arg header "$HEADER" --arg msgs "$DISPLAY_MSGS" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ($header + "\n\n" + $msgs + "\nAfter processing, briefly acknowledge what you received and how you will act on it.")
  }
}'

exit 0
