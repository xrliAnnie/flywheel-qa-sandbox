#!/usr/bin/env bash
# FLY-142 spike β/γ: prove claude CLI useInboxPoller wakes Runner from mailbox.
#
# Usage: bash scripts/spike-mailbox-wake.sh
#
# This script is an end-to-end smoke for the v1.27 plan claim:
# "stock claude CLI's useInboxPoller will deliver mailbox messages to Runner
#  REPL as user turns when started with --agent-id/--agent-name/--team-name
#  + CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1."
#
# Strategy:
#   1. Set up an isolated $HOME with a fresh team file.
#   2. Spawn a Runner inside a tmux pane (interactive claude, NOT --print).
#   3. Wait until Runner's REPL is up (sentinel poll).
#   4. Write a "Reply with the literal word ALPHA-OK and nothing else." message
#      to the Runner's mailbox via writeToMailbox-equivalent (raw JSON append).
#   5. Capture the tmux pane every 2s for 30s — pass if "ALPHA-OK" appears.
#   6. Cleanup tmux + temp $HOME.

set -euo pipefail

TEAM_NAME="fly142-spike-$$"
RUNNER_NAME="spike-runner"
LEAD_NAME="spike-lead"
SENTINEL_TOKEN="ALPHA-OK"
TMUX_SESSION="fly142-spike-$$"
TMUX_WINDOW="runner"
TIMEOUT_S=45

# Use real $HOME so theme + auth + trust settings are inherited
TEAMS_DIR="$HOME/.claude/teams/$TEAM_NAME"

cleanup() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  rm -rf "$TEAMS_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "[spike] preparing team file at $TEAMS_DIR"
rm -rf "$TEAMS_DIR"
mkdir -p "$TEAMS_DIR/inboxes"

# Team config — leader + runner as members
cat > "$TEAMS_DIR/config.json" <<EOF
{
  "teamName": "$TEAM_NAME",
  "leadAgentId": "$LEAD_NAME@$TEAM_NAME",
  "members": [
    { "name": "$LEAD_NAME", "agentId": "$LEAD_NAME@$TEAM_NAME", "color": "red" },
    { "name": "$RUNNER_NAME", "agentId": "$RUNNER_NAME@$TEAM_NAME", "color": "cyan" }
  ],
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "teammates": {}
}
EOF

# Empty inbox files
echo "[]" > "$TEAMS_DIR/inboxes/$RUNNER_NAME.json"
echo "[]" > "$TEAMS_DIR/inboxes/$LEAD_NAME.json"

echo "[spike] launching Runner in tmux: session=$TMUX_SESSION"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -n "$TMUX_WINDOW" -x 200 -y 50

# Pass env + identity flags. We DON'T pass --agent-teams CLI flag because v2.1.132
# rejects it; the env var alone is sufficient (spike α confirmed).
tmux send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" \
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 command claude \\
    --agent-id '$RUNNER_NAME@$TEAM_NAME' \\
    --agent-name '$RUNNER_NAME' \\
    --team-name '$TEAM_NAME' \\
    --permission-mode bypassPermissions" Enter

echo "[spike] waiting 12s for Runner REPL to initialize..."
sleep 12

# Capture pane to confirm REPL is up (looking for the ✻ idle prompt or > input box)
tmux capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p | tail -10
echo "[spike] --- pane snapshot above ---"

# Write a sentinel message to Runner's inbox
echo "[spike] writing sentinel message to mailbox"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$TEAMS_DIR/inboxes/$RUNNER_NAME.json" <<EOF
[
  {
    "from": "$LEAD_NAME",
    "text": "Reply with the literal word $SENTINEL_TOKEN and nothing else.",
    "summary": "spike test sentinel",
    "timestamp": "$TIMESTAMP",
    "read": false,
    "color": "red"
  }
]
EOF

echo "[spike] mailbox written. Polling pane for '$SENTINEL_TOKEN' (timeout=$TIMEOUT_S s)..."
elapsed=0
poll_interval=2
result=""
while [ $elapsed -lt $TIMEOUT_S ]; do
  pane=$(tmux capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p)
  if echo "$pane" | grep -q "$SENTINEL_TOKEN"; then
    result="PASS"
    break
  fi
  sleep $poll_interval
  elapsed=$((elapsed + poll_interval))
  echo "[spike]   ... ${elapsed}s elapsed"
done

echo "==============================="
echo "[spike] FINAL pane snapshot:"
tmux capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p | tail -25
echo "==============================="

# Inspect mailbox file: was message marked read?
echo "[spike] mailbox file after test:"
cat "$TEAMS_DIR/inboxes/$RUNNER_NAME.json"
echo

if [ "$result" = "PASS" ]; then
  echo "[spike] β PASS — useInboxPoller delivered sentinel; Runner echoed $SENTINEL_TOKEN"
  exit 0
else
  echo "[spike] β FAIL — Runner did NOT echo $SENTINEL_TOKEN within $TIMEOUT_S s"
  exit 1
fi
