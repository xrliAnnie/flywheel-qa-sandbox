#!/bin/bash
# Lead Progress Check — PostToolUse Hook (GEO-292)
# Dependencies: sqlite3, jq
# Env vars: FLYWHEEL_LEAD_ID (set by claude-lead.sh)
#           FLYWHEEL_COMM_DB (set by claude-lead.sh)

set -euo pipefail

LEAD_ID="${FLYWHEEL_LEAD_ID:-}"
DB_PATH="${FLYWHEEL_COMM_DB:-}"

# Quick exit for non-Lead sessions
if [ -z "$LEAD_ID" ] || [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Sanitize LEAD_ID: only allow alphanumeric, dash, underscore (prevent SQL injection)
if ! echo "$LEAD_ID" | grep -qE '^[a-zA-Z0-9_-]+$'; then
  exit 0
fi

sq_ro() { sqlite3 -readonly -cmd ".timeout 5000" "$DB_PATH" "$1" 2>/dev/null; }
sq()    { sqlite3 -cmd ".timeout 5000" "$DB_PATH" "$1" 2>/dev/null; }

COUNT=$(sq_ro "SELECT COUNT(*) FROM messages WHERE to_agent='${LEAD_ID}' AND type='progress' AND read_at IS NULL AND expires_at > datetime('now');" || echo "0")

if [ "$COUNT" -eq "0" ] 2>/dev/null; then exit 0; fi

# Read progress as JSON
JSON_ROWS=$(sq "SELECT json_group_array(json_object('id', id, 'from_agent', from_agent, 'content', content)) FROM (SELECT id, from_agent, content FROM messages WHERE to_agent='${LEAD_ID}' AND type='progress' AND read_at IS NULL AND expires_at > datetime('now') ORDER BY created_at ASC, rowid ASC);") || exit 0

if [ -z "$JSON_ROWS" ] || [ "$JSON_ROWS" = "[[]]" ] || [ "$JSON_ROWS" = "[null]" ]; then exit 0; fi

IDS=$(echo "$JSON_ROWS" | jq -r '.[] | .id' 2>/dev/null | sed "s/.*/'&'/" | paste -sd, -)
if [ -z "$IDS" ]; then exit 0; fi

# Mark as read BEFORE outputting
if ! sq "UPDATE messages SET read_at=datetime('now') WHERE id IN (${IDS});"; then exit 0; fi

# Format progress messages (parse JSON content from each message)
DISPLAY_MSGS=$(echo "$JSON_ROWS" | jq -r '.[] |
  (.content | fromjson?) as $p |
  if $p then "[Runner Progress] " + ($p.issueId // "unknown") + " " + $p.stage + " " + $p.status + (if $p.artifact then " (artifact: " + $p.artifact + ")" else "" end)
  else "[Runner Progress] " + .content
  end' 2>/dev/null)

if [ -z "$DISPLAY_MSGS" ]; then exit 0; fi

jq -n --arg msgs "$DISPLAY_MSGS" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("RUNNER PROGRESS UPDATE — For your awareness, no action needed unless stuck\n\n" + $msgs)
  }
}'
