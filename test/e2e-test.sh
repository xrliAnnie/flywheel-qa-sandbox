#!/bin/bash
# E2E test for Phase 0: send simulated prompts to a tmux pane, verify TTS fires.
# Usage: ./test/e2e-test.sh [pane_target]
# Default pane: voiceloop-test:0.0

PANE="${1:-voiceloop-test:0.0}"

# Create test session if it doesn't exist
if ! tmux has-session -t voiceloop-test 2>/dev/null; then
    echo "Creating test tmux session: voiceloop-test"
    tmux new-session -d -s voiceloop-test
fi

echo "Using pane: $PANE"
echo "Make sure Voice Loop is running with this pane configured."
echo ""

sleep 1

echo "=== Test 1: Numbered menu (N) format) ==="
tmux send-keys -t "$PANE" "echo '
Please choose an action:
1) Approve all changes
2) Reject and explain
3) View diff first
'" Enter
echo "  -> Expected: TTS announces 3 choices"
sleep 6

echo "=== Test 2: Numbered menu (N. format) ==="
tmux send-keys -t "$PANE" "echo '
Select an option:
1. Run tests
2. Skip tests
3. Run with coverage
'" Enter
echo "  -> Expected: TTS announces 3 choices"
sleep 6

echo "=== Test 3: Yes/No ==="
tmux send-keys -t "$PANE" "echo 'Do you want to continue? (yes/no)'" Enter
echo "  -> Expected: TTS announces yes or no"
sleep 6

echo "=== Test 4: Approve/Reject ==="
tmux send-keys -t "$PANE" "echo 'Approve or Reject this change?'" Enter
echo "  -> Expected: TTS announces approve or reject"
sleep 6

echo "=== Test 5: Not a prompt (should NOT trigger TTS) ==="
tmux send-keys -t "$PANE" "echo 'Build completed successfully.
Files changed: 3
Lines added: 42
Lines removed: 15'" Enter
echo "  -> Expected: NO TTS (not a choice prompt)"
sleep 4

echo ""
echo "=== Tests complete ==="
echo "Check ~/.claude/voice-loop/logs/events.jsonl for logged events."
