#!/bin/bash
# FLY-109: Tests for expect-dev-channels.exp — two-stage dev-channels dialog auto-confirm.
#
# Verifies:
#   1. Dialog appears → send "1\r", log confirmed=1, exit 0
#   2. Dialog never appears (short timeout) → do NOT send "1\r", log DEV_CHANNELS_DIALOG_NOT_SEEN
#   3. Dialog appears with trailing output → single send, no duplicate
#
# Prerequisites: expect must be installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECT_SCRIPT="${SCRIPT_DIR}/../expect-dev-channels.exp"
PASSED=0
FAILED=0
ERRORS=""

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  ✗ $1"; log_test "✗ $1"; }

if ! command -v expect >/dev/null 2>&1; then
  echo "ERROR: expect is required for these tests"
  exit 1
fi

if [ ! -f "$EXPECT_SCRIPT" ]; then
  echo "ERROR: expect script not found at $EXPECT_SCRIPT"
  exit 1
fi

TMPDIR_TEST="$(mktemp -d -t flywheel-expect-test-XXXXXX)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

MOCK_CHILD="${TMPDIR_TEST}/mock-claude.sh"
cat > "$MOCK_CHILD" <<'MOCK_EOF'
#!/bin/bash
# Mock Claude child for expect tests. Emits controlled output then reads stdin.
set -e
case "${1:-}" in
  dialog-normal)
    echo "Claude Code starting..."
    echo "Loading development channels from --dangerously-load-development-channels flag"
    echo "  • I am using this for local development"
    echo "Press Enter to confirm · Esc to cancel"
    # Read one line from stdin; expect should send "1\r" after seeing marker
    if IFS= read -r -t 5 line; then
      if [ "$line" = "1" ]; then
        echo "CONFIRMED_1" > "${MARKER_FILE:-/tmp/expect-test-marker}"
      fi
    fi
    sleep 0.1
    exit 0
    ;;
  dialog-never)
    echo "bypass permissions enabled"
    # Sleep long enough that expect stage-1 timeout hits first
    sleep 3
    exit 0
    ;;
  dialog-with-trailing)
    echo "Loading development channels"
    echo "  • I am using this for local development"
    if IFS= read -r -t 5 line; then
      if [ "$line" = "1" ]; then
        echo "CONFIRMED_1" >> "${MARKER_FILE:-/tmp/expect-test-marker}"
      fi
    fi
    # Continue emitting output to test that expect does NOT send again
    echo "> More output after dialog"
    echo "> Another trailing line"
    sleep 0.2
    exit 0
    ;;
  *)
    echo "unknown scenario: ${1:-}" >&2
    exit 2
    ;;
esac
MOCK_EOF
chmod +x "$MOCK_CHILD"

# ════════════════════════════════════════════════════════════════
# Test 1: dialog-normal — marker seen, 1\r sent, confirmed
# ════════════════════════════════════════════════════════════════

log_test "Test 1: dialog appears → send 1 once, confirmed=1"
MARKER_FILE="${TMPDIR_TEST}/marker1"
LOG_FILE="${TMPDIR_TEST}/startup1.log"
FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC=2 \
  FLYWHEEL_EXPECT_LOG="$LOG_FILE" \
  MARKER_FILE="$MARKER_FILE" \
  expect "$EXPECT_SCRIPT" "$MOCK_CHILD" dialog-normal >/dev/null 2>&1
EXIT_CODE=$?

if [ "$EXIT_CODE" = "0" ]; then
  pass "Test 1: exit code 0"
else
  fail "Test 1: exit code was $EXIT_CODE, expected 0"
fi

if [ -f "$MARKER_FILE" ] && grep -q "CONFIRMED_1" "$MARKER_FILE"; then
  pass "Test 1: child received '1' on stdin (marker present)"
else
  fail "Test 1: child did NOT receive '1' (marker missing)"
fi

if [ -f "$LOG_FILE" ] && grep -q "confirmed=1" "$LOG_FILE"; then
  pass "Test 1: startup log contains confirmed=1"
else
  fail "Test 1: startup log missing confirmed=1 (content: $(cat "$LOG_FILE" 2>/dev/null))"
fi

if [ -f "$LOG_FILE" ] && grep -q "DEV_CHANNELS_DIALOG_NOT_SEEN" "$LOG_FILE"; then
  fail "Test 1: startup log incorrectly contains DEV_CHANNELS_DIALOG_NOT_SEEN"
else
  pass "Test 1: DEV_CHANNELS_DIALOG_NOT_SEEN NOT logged"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: dialog-never — short timeout, must NOT send 1\r
# ════════════════════════════════════════════════════════════════

log_test "Test 2: dialog never appears → must NOT send 1, log NOT_SEEN"
MARKER_FILE="${TMPDIR_TEST}/marker2"
LOG_FILE="${TMPDIR_TEST}/startup2.log"
FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC=1 \
  FLYWHEEL_EXPECT_LOG="$LOG_FILE" \
  MARKER_FILE="$MARKER_FILE" \
  expect "$EXPECT_SCRIPT" "$MOCK_CHILD" dialog-never >/dev/null 2>&1
EXIT_CODE=$?

# Child exits 0 after its sleep. expect should propagate child exit code.
if [ "$EXIT_CODE" = "0" ]; then
  pass "Test 2: exit code 0 (propagated from child)"
else
  fail "Test 2: exit code was $EXIT_CODE, expected 0"
fi

if [ ! -f "$MARKER_FILE" ]; then
  pass "Test 2: child did NOT receive '1' (marker correctly absent)"
else
  fail "Test 2: child wrongly received '1' — expect should NOT blind-send"
fi

if [ -f "$LOG_FILE" ] && grep -q "DEV_CHANNELS_DIALOG_NOT_SEEN" "$LOG_FILE"; then
  pass "Test 2: startup log contains DEV_CHANNELS_DIALOG_NOT_SEEN"
else
  fail "Test 2: startup log missing DEV_CHANNELS_DIALOG_NOT_SEEN (content: $(cat "$LOG_FILE" 2>/dev/null))"
fi

if [ -f "$LOG_FILE" ] && grep -q "confirmed=1" "$LOG_FILE"; then
  fail "Test 2: startup log incorrectly contains confirmed=1"
else
  pass "Test 2: confirmed=1 NOT logged (correct — nothing to confirm)"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: dialog-with-trailing — single send, no duplicate on trailing output
# ════════════════════════════════════════════════════════════════

log_test "Test 3: dialog + trailing output → single send, no duplicate"
MARKER_FILE="${TMPDIR_TEST}/marker3"
LOG_FILE="${TMPDIR_TEST}/startup3.log"
FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC=2 \
  FLYWHEEL_EXPECT_LOG="$LOG_FILE" \
  MARKER_FILE="$MARKER_FILE" \
  expect "$EXPECT_SCRIPT" "$MOCK_CHILD" dialog-with-trailing >/dev/null 2>&1
EXIT_CODE=$?

if [ "$EXIT_CODE" = "0" ]; then
  pass "Test 3: exit code 0"
else
  fail "Test 3: exit code was $EXIT_CODE, expected 0"
fi

# Marker file should have exactly one "CONFIRMED_1" line — not two
if [ -f "$MARKER_FILE" ]; then
  MARKER_COUNT=$(grep -c "CONFIRMED_1" "$MARKER_FILE" || true)
  if [ "$MARKER_COUNT" = "1" ]; then
    pass "Test 3: '1' sent exactly once (no duplicate)"
  else
    fail "Test 3: '1' sent $MARKER_COUNT times (expected 1)"
  fi
else
  fail "Test 3: marker file missing — send never happened"
fi

if [ -f "$LOG_FILE" ] && grep -q "confirmed=1" "$LOG_FILE"; then
  pass "Test 3: startup log contains confirmed=1"
else
  fail "Test 3: startup log missing confirmed=1"
fi

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then
  echo -e "Errors:$ERRORS"
  exit 1
fi
exit 0
