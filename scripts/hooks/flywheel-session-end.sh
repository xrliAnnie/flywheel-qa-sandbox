#!/bin/bash
set -euo pipefail
# Flywheel SessionEnd hook — notifies orchestrator of session completion.
# Two modes: HTTP callback (v0.2) and marker file (v0.1.1 fallback).

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Validate: must be a UUID format
if [ -z "$SESSION_ID" ] || ! echo "$SESSION_ID" | grep -qE '^[0-9a-f-]{36}$'; then
  exit 0
fi

# Primary: HTTP callback (v0.2) — env vars injected by TmuxRunner
if [ -n "${FLYWHEEL_CALLBACK_PORT:-}" ] && [ -n "${FLYWHEEL_CALLBACK_TOKEN:-}" ]; then
  curl -s -X POST \
    "http://127.0.0.1:${FLYWHEEL_CALLBACK_PORT}/hook/complete?token=${FLYWHEEL_CALLBACK_TOKEN}&sessionId=${SESSION_ID}&issueId=${FLYWHEEL_ISSUE_ID:-unknown}&eventType=SessionEnd" \
    --max-time 5 || true
fi

# Fallback: marker file (v0.1.1 compat) — only if marker dir exists
MARKER_DIR="${FLYWHEEL_MARKER_DIR:-/tmp/flywheel/sessions}"
if [ -d "$MARKER_DIR" ]; then
  echo "$INPUT" > "$MARKER_DIR/$SESSION_ID.done"
fi
