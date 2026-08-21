#!/bin/bash
# Flywheel Runner Inbox Check — PostToolUse Hook (GEO-266)
#
# Checks CommDB for unread Lead instructions and question responses via the
# sqlite3 CLI and injects them as additionalContext into Claude's conversation.
# No-op when FLYWHEEL_EXEC_ID is not set, making it safe for non-Runner sessions.
#
# FLY-142 PR 1.4: When the mailbox sentinel
# `~/.flywheel/runner-state/<execId>/mailbox-active` exists, this hook
# short-circuits to a no-op. Lead → Runner delivery uses claude-code's stock
# `useInboxPoller` (mailbox path).
#
# FLY-142 (Option 1, this change): the CommDB fallback below reads BOTH
# `type='instruction'` AND `type='response'`. It previously dropped responses,
# so a `flywheel-comm respond` to a parked/idle runner (the GEO-371 incident)
# was never delivered and the runner never woke. Responses are injected with
# their parent question's id + text so the runner knows what it is answering.
#
# Rollback (FLYWHEEL_COMM_BACKEND=commdb): TmuxAdapter still writes the
# sentinel by default; ops must `rm -f ~/.flywheel/runner-state/<execId>/mailbox-active`
# OR set FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 to re-enable the CommDB
# polling path for that Runner.
#
# Dependencies: sqlite3 (macOS built-in), jq (brew install jq)
# Env vars:    FLYWHEEL_EXEC_ID  — Runner execution ID (set by TmuxAdapter)
#              FLYWHEEL_COMM_DB  — CommDB path (set by TmuxAdapter)
#              FLYWHEEL_RUNNER_STATE_DIR — Runner state dir (set by TmuxAdapter PR 1.4)
#              FLYWHEEL_DISABLE_MAILBOX_SENTINEL — set to "1" to ignore sentinel
#                  and force legacy CommDB polling (rollback only)
#
# Deployed to: ~/.flywheel/hooks/inbox-check.sh (via /setup-flywheel-hooks)

set -euo pipefail

EXEC_ID="${FLYWHEEL_EXEC_ID:-}"
DB_PATH="${FLYWHEEL_COMM_DB:-}"

# Quick exit for non-Runner sessions (zero overhead)
if [ -z "$EXEC_ID" ] || [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# FLY-142 PR 1.4: mailbox sentinel — short-circuit if present (default path).
# Resolve the sentinel path with explicit env override → exec-id-derived
# fallback so this hook works on Runners spawned before TmuxAdapter set
# FLYWHEEL_RUNNER_STATE_DIR (existing live sessions during rollout).
if [ "${FLYWHEEL_DISABLE_MAILBOX_SENTINEL:-}" != "1" ]; then
  SENTINEL_DIR="${FLYWHEEL_RUNNER_STATE_DIR:-${HOME}/.flywheel/runner-state/${EXEC_ID}}"
  if [ -f "${SENTINEL_DIR}/mailbox-active" ]; then
    # Mailbox path active — Lead writes go straight to claude-code's mailbox,
    # picked up by stock useInboxPoller. Hook is intentionally inert here.
    exit 0
  fi
fi

# Helper: run sqlite3 with busy_timeout via -cmd flag (no stdout noise)
sq_ro() { sqlite3 -readonly -cmd ".timeout 5000" "$DB_PATH" "$1" 2>/dev/null; }
sq()    { sqlite3 -cmd ".timeout 5000" "$DB_PATH" "$1" 2>/dev/null; }

# Check for unread instructions + responses (read-only for speed)
COUNT=$(sq_ro "SELECT COUNT(*) FROM mailbox WHERE to_agent='${EXEC_ID}' AND type IN ('instruction','response') AND state IN ('QUEUED','LEASED') AND datetime(expires_at) > datetime('now');" || echo "0")

if [ "$COUNT" -eq "0" ] 2>/dev/null; then
  exit 0
fi

# Read unread messages as JSON to safely handle multi-line content. For a
# response (type='response') we LEFT JOIN its parent question so the runner is
# told WHAT it is answering (parent id + question text). instruction rows have
# no parent and carry null parent_id/parent_content.
JSON_ROWS=$(sq "SELECT json_group_array(json_object('id', id, 'from_agent', from_agent, 'type', type, 'content', content, 'parent_id', parent_id, 'parent_content', parent_content)) FROM (SELECT m.id AS id, m.from_agent AS from_agent, m.type AS type, m.content AS content, m.ref_id AS parent_id, q.content AS parent_content FROM mailbox m LEFT JOIN mailbox q ON q.id = m.ref_id WHERE m.to_agent='${EXEC_ID}' AND m.type IN ('instruction','response') AND m.state IN ('QUEUED','LEASED') AND datetime(m.expires_at) > datetime('now') ORDER BY m.seq ASC);") || exit 0

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
if ! sq "UPDATE mailbox SET state='ACKED', acked_at=COALESCE(acked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')), delivered_at=COALESCE(delivered_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')), claimed_by=NULL, claim_expires_at=NULL, next_retry_at=NULL WHERE id IN (${IDS}) AND state IN ('QUEUED','LEASED');"; then
  exit 0
fi

# Build display messages from JSON (handles multi-line content safely).
# Responses are annotated with the parent question so the runner has context
# for what is being answered; instructions keep their original format.
DISPLAY_MSGS=$(echo "$JSON_ROWS" | jq -r '
  .[] |
  if .type == "response" then
    "[" + .from_agent + "] (answer to your question"
      + (if .parent_id then " [" + .parent_id + "]" else "" end)
      + (if .parent_content then ": \"" + .parent_content + "\"" else "" end)
      + "): " + .content
  else
    "[" + .from_agent + "]: " + .content
  end' 2>/dev/null)

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
