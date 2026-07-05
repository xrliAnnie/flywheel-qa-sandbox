#!/bin/bash
# Spike: Validate tmux + Claude Code + git detection flow
# This script proves the core operational assumptions for TmuxRunner:
# 1. tmux session/window creation
# 2. Claude Code interactive TUI in tmux
# 3. --session-id flag in interactive mode
# 4. remain-on-exit + pane_dead detection
# 5. Git SHA-range commit detection
# 6. SessionEnd hook marker file (if hooks installed)
#
# Usage: ./scripts/spike-tmux-runner.sh [project-dir]
# Default project-dir: current directory

set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
SESSION="flywheel-spike"
WINDOW="SPIKE-001"
CLAUDE_SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
MARKER_DIR="/tmp/flywheel/sessions"

echo "=== Flywheel Spike: tmux + Claude Code + git ==="
echo "Project dir: $PROJECT_DIR"
echo "tmux session: $SESSION"
echo "tmux window:  $WINDOW"
echo "Claude session ID: $CLAUDE_SESSION_ID"
echo ""

# 1. Verify tmux is available
if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux is not installed"
  exit 1
fi
echo "[1/8] tmux $(tmux -V) ✓"

# 2. Capture git baseline
cd "$PROJECT_DIR"
BASE_SHA=$(git rev-parse HEAD)
echo "[2/8] Baseline SHA: $BASE_SHA"

# 3. Create tmux session (idempotent)
tmux has-session -t "$SESSION" 2>/dev/null || tmux new-session -d -s "$SESSION"
echo "[3/8] tmux session '$SESSION' ready"

# 4. Set remain-on-exit so dead panes stay visible
tmux set-option -t "$SESSION" remain-on-exit on
echo "[4/8] remain-on-exit enabled"

# 5. Set up marker directory for SessionEnd hook
mkdir -p "$MARKER_DIR"
echo "[5/8] Hook marker directory: $MARKER_DIR"

# 6. Launch Claude in new window with cwd and session-id
tmux new-window -t "$SESSION" -n "$WINDOW" -c "$PROJECT_DIR" \
  "claude --session-id $CLAUDE_SESSION_ID \
    'Create a branch spike-test, add spike-test.txt with hello flywheel, commit, then exit.'"
echo "[6/8] Claude launched in tmux window '$WINDOW'"
echo "       Attach with: tmux attach -t $SESSION"

# 7. Poll for completion: hook marker OR pane_dead (dual-path)
echo "[7/8] Waiting for Claude to exit (hook marker OR pane_dead)..."
DETECTED_VIA="unknown"
while true; do
  # Primary: check for hook-written marker file
  if ls "$MARKER_DIR"/*.done 1>/dev/null 2>&1; then
    echo "       Completion detected via SessionEnd hook marker!"
    DETECTED_VIA="hook"
    break
  fi
  # Fallback: check pane_dead
  PANE_DEAD=$(tmux list-panes -t "$SESSION:$WINDOW" -F '#{pane_dead}' 2>/dev/null || echo "gone")
  if [ "$PANE_DEAD" = "1" ] || [ "$PANE_DEAD" = "gone" ]; then
    echo "       Completion detected via pane_dead polling"
    DETECTED_VIA="pane_dead"
    break
  fi
  sleep 3
done

# 8. Check git result
NEW_COMMITS=$(git rev-list --count "$BASE_SHA"..HEAD 2>/dev/null || echo 0)
FILES_CHANGED=$(git diff --shortstat "$BASE_SHA"..HEAD 2>/dev/null || echo "none")
EXIT_STATUS=$(tmux list-panes -t "$SESSION:$WINDOW" -F '#{pane_dead_status}' 2>/dev/null || echo "unknown")

echo ""
echo "[8/8] Results:"
echo "  Detection method: $DETECTED_VIA"
echo "  New commits: $NEW_COMMITS"
echo "  Files changed: $FILES_CHANGED"
echo "  Claude exit status: $EXIT_STATUS"
echo ""

# Cleanup
if [ "$NEW_COMMITS" -gt 0 ]; then
  echo "SUCCESS: $NEW_COMMITS commit(s) detected. Cleaning up window."
  tmux kill-window -t "$SESSION:$WINDOW" 2>/dev/null || true
else
  echo "FAILURE: No commits. Window preserved for inspection."
  echo "  Inspect: tmux attach -t $SESSION"
fi

# Clean up marker files
rm -f "$MARKER_DIR"/*.done 2>/dev/null || true
