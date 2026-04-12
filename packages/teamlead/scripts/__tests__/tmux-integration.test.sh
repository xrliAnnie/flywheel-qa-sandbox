#!/bin/bash
# FLY-88: Integration tests for tmux-based Lead launch.
# Tests the tmux primitives used by claude-lead.sh.
#
# Prerequisites: tmux must be installed.
# These tests create/destroy ephemeral tmux sessions — no impact on production.
set -euo pipefail

TEST_SESSION="flywheel-test-$$"
PASSED=0
FAILED=0
ERRORS=""

# ── Helpers ──

log_test() {
  echo "[TEST] $*"
}

pass() {
  PASSED=$((PASSED + 1))
  log_test "✓ $1"
}

fail() {
  FAILED=$((FAILED + 1))
  ERRORS="${ERRORS}\n  ✗ $1"
  log_test "✗ $1"
}

cleanup_test_session() {
  tmux kill-session -t "=${TEST_SESSION}" 2>/dev/null || true
}

# ── Pre-flight ──

if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux is required for these tests"
  exit 1
fi

# Cleanup on exit
trap cleanup_test_session EXIT

# ════════════════════════════════════════════════════════════════
# Test 1: ensure_tmux_session (race-safe create)
# ════════════════════════════════════════════════════════════════

log_test "Test 1: ensure_tmux_session — race-safe create"

cleanup_test_session

# First call: creates session
tmux new-session -Ad -s "$TEST_SESSION" -x 200 -y 50 2>/dev/null || true
if tmux has-session -t "=${TEST_SESSION}" 2>/dev/null; then
  pass "Session created on first call"
else
  fail "Session NOT created on first call"
fi

# Second call: idempotent (no error)
tmux new-session -Ad -s "$TEST_SESSION" -x 200 -y 50 2>/dev/null || true
if tmux has-session -t "=${TEST_SESSION}" 2>/dev/null; then
  pass "Session persists on second call (idempotent)"
else
  fail "Session gone after second call"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: new-window with -P -F captures window_id
# ════════════════════════════════════════════════════════════════

log_test "Test 2: new-window with -P -F captures window_id"

WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' \
  -t "=${TEST_SESSION}" \
  -n "test-lead" \
  -c "/tmp" \
  sleep 30)

if [[ "$WINDOW_ID" =~ ^@[0-9]+$ ]]; then
  pass "Window ID captured: ${WINDOW_ID}"
else
  fail "Window ID format unexpected: '${WINDOW_ID}'"
fi

# Verify window exists by name
WINDOW_NAME=$(tmux list-windows -t "=${TEST_SESSION}" -F '#{window_id} #{window_name}' \
  | grep "^${WINDOW_ID} " | awk '{print $2}')
if [ "$WINDOW_NAME" = "test-lead" ]; then
  pass "Window name matches: test-lead"
else
  fail "Window name mismatch: expected 'test-lead', got '${WINDOW_NAME}'"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: Environment injection via -e
# ════════════════════════════════════════════════════════════════

log_test "Test 3: Environment injection via -e"

ENV_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' \
  -t "=${TEST_SESSION}" \
  -e "TEST_VAR_FLY88=hello_flywheel" \
  -n "test-env" \
  -c "/tmp" \
  bash -c 'echo "ENV=$TEST_VAR_FLY88"; sleep 30')

sleep 1
CAPTURED=$(tmux capture-pane -t "${ENV_WINDOW_ID}" -p 2>/dev/null | grep "ENV=" | head -1)
if [[ "$CAPTURED" == *"hello_flywheel"* ]]; then
  pass "Environment variable injected correctly"
else
  fail "Environment variable not found in output: '${CAPTURED}'"
fi

# ════════════════════════════════════════════════════════════════
# Test 4: remain-on-exit + pane_dead detection
# ════════════════════════════════════════════════════════════════

log_test "Test 4: remain-on-exit + pane_dead detection"

# Create a window that exits with code 42 (sleep 1 to ensure window is created)
DEAD_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' \
  -t "=${TEST_SESSION}" \
  -n "test-dead" \
  -c "/tmp" \
  bash -c 'sleep 1; exit 42')

# Enable remain-on-exit on THIS window (per-window option, required for tmux 3.5+)
tmux set-window-option -t "$DEAD_WINDOW_ID" remain-on-exit on 2>/dev/null || true

# Wait for process to die
sleep 3

DEAD_FLAG=$(tmux list-panes -t "${DEAD_WINDOW_ID}" -F '#{pane_dead}' 2>/dev/null | head -1)
if [ "$DEAD_FLAG" = "1" ]; then
  pass "pane_dead=1 detected after process exit"
else
  fail "pane_dead not set: '${DEAD_FLAG}'"
fi

EXIT_CODE=$(tmux list-panes -t "${DEAD_WINDOW_ID}" -F '#{pane_dead_status}' 2>/dev/null | head -1)
if [ "$EXIT_CODE" = "42" ]; then
  pass "pane_dead_status=42 (correct exit code)"
else
  fail "pane_dead_status mismatch: expected '42', got '${EXIT_CODE}'"
fi

# Cleanup dead window
tmux kill-window -t "${DEAD_WINDOW_ID}" 2>/dev/null || true

# ════════════════════════════════════════════════════════════════
# Test 5: send-keys to window_id
# ════════════════════════════════════════════════════════════════

log_test "Test 5: send-keys to window_id (auto-confirm simulation)"

SEND_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' \
  -t "=${TEST_SESSION}" \
  -n "test-send" \
  -c "/tmp" \
  bash -c 'read -p "Press Enter: " && echo "CONFIRMED" && sleep 5')

sleep 1
# Send Enter (simulates auto-confirm)
tmux send-keys -t "${SEND_WINDOW_ID}" Enter 2>/dev/null || true
sleep 1

SEND_OUTPUT=$(tmux capture-pane -t "${SEND_WINDOW_ID}" -p 2>/dev/null | grep "CONFIRMED" | head -1)
if [[ "$SEND_OUTPUT" == *"CONFIRMED"* ]]; then
  pass "send-keys Enter delivered correctly"
else
  fail "send-keys Enter not received: '${SEND_OUTPUT}'"
fi

# ════════════════════════════════════════════════════════════════
# Test 6: kill-window by window_id
# ════════════════════════════════════════════════════════════════

log_test "Test 6: kill-window by window_id"

KILL_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' \
  -t "=${TEST_SESSION}" \
  -n "test-kill" \
  -c "/tmp" \
  sleep 60)

tmux kill-window -t "${KILL_WINDOW_ID}" 2>/dev/null || true
if ! tmux list-panes -t "${KILL_WINDOW_ID}" &>/dev/null; then
  pass "Window killed successfully by ID"
else
  fail "Window still exists after kill"
fi

# ════════════════════════════════════════════════════════════════
# Test 7: Stale window cleanup by name
# ════════════════════════════════════════════════════════════════

log_test "Test 7: Kill stale window by name"

tmux new-window -d -t "=${TEST_SESSION}" -n "stale-lead" sleep 60

# Kill by name (simulates cleanup of previous crash)
tmux kill-window -t "=${TEST_SESSION}:=stale-lead" 2>/dev/null || true
if ! tmux list-windows -t "=${TEST_SESSION}" -F '#{window_name}' | grep -q "^stale-lead$"; then
  pass "Stale window cleaned up by name"
else
  fail "Stale window still exists after cleanup"
fi

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════

echo ""
echo "════════════════════════════════════════"
echo "Results: ${PASSED} passed, ${FAILED} failed"
if [ "$FAILED" -gt 0 ]; then
  echo -e "Failures:${ERRORS}"
  echo "════════════════════════════════════════"
  exit 1
fi
echo "════════════════════════════════════════"
exit 0
