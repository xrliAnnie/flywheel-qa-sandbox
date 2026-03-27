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

# Read instructions as JSON to safely handle multi-line content
# sqlite3 -json returns: [{"id":"...","from_agent":"...","content":"..."}]
JSON_ROWS=$(sq "SELECT json_group_array(json_object('id', id, 'from_agent', from_agent, 'content', content)) FROM (SELECT id, from_agent, content FROM messages WHERE to_agent='${EXEC_ID}' AND type='instruction' AND read_at IS NULL AND expires_at > datetime('now') ORDER BY created_at ASC);") || exit 0

if [ -z "$JSON_ROWS" ] || [ "$JSON_ROWS" = "[[]]" ] || [ "$JSON_ROWS" = "[null]" ]; then
  exit 0
fi

# Extract IDs for targeted read-marking
IDS=$(echo "$JSON_ROWS" | jq -r '.[] | .id' 2>/dev/null | sed "s/.*/'&'/" | paste -sd, -)

if [ -z "$IDS" ]; then
  exit 0
fi

# Mark retrieved IDs as read BEFORE outputting additionalContext.
# If marking fails (SQLITE_BUSY), do NOT output — prevents repeated injection.
if ! sq "UPDATE messages SET read_at=datetime('now') WHERE id IN (${IDS});"; then
  exit 0
fi

# Build display messages from JSON (handles multi-line content safely)
DISPLAY_MSGS=$(echo "$JSON_ROWS" | jq -r '.[] | "[" + .from_agent + "]: " + .content' 2>/dev/null)

if [ -z "$DISPLAY_MSGS" ]; then
  exit 0
fi

# Build additionalContext
HEADER="LEAD INSTRUCTION — Read and act on these instructions"

# Output JSON for Claude Code hook system
jq -n --arg header "$HEADER" --arg msgs "$DISPLAY_MSGS" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ($header + "\n\n" + $msgs + "\n\nAfter processing, briefly acknowledge what you received and how you will act on it.")
  }
}'

exit 0
