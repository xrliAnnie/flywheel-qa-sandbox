#!/bin/bash
# GEO-151 C10 — find-window.sh tests via mock osascript.
#
# Verifies the contract:
#   - On valid integer result → echo it + exit 0
#   - On empty result → empty stdout + exit 1 (no window found / all minimized)
#   - On osascript non-zero exit → empty stdout + stderr + exit 2
#   - On garbage osascript output → empty stdout + stderr + exit 2
#   - On missing $1 → usage to stderr + exit 2
#
# The mock osascript is a tiny shell script that respects the
# FIND_WINDOW_MOCK_BEHAVIOR env var so each test case configures it
# differently. find-window.sh respects FIND_WINDOW_OSASCRIPT to pick up
# our mock instead of the real /usr/bin/osascript.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIND_WINDOW="$SCRIPT_DIR/../find-window.sh"
TMP_DIR="$(mktemp -d -t find-window-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASSED=0
FAILED=0
ERRORS=""

log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() {
  echo "  ✗ $*" >&2
  FAILED=$((FAILED + 1))
  ERRORS="${ERRORS}\n  - $*"
}

# Make a mock osascript that emits a configurable response.
make_mock() {
  local behavior="$1"
  local mock="$TMP_DIR/osascript-mock-$$.sh"
  cat > "$mock" <<EOF
#!/bin/bash
case "$behavior" in
  echo-integer)
    echo "12345"
    exit 0
    ;;
  echo-integer-with-whitespace)
    printf "  98765 \n"
    exit 0
    ;;
  empty)
    echo ""
    exit 0
    ;;
  garbage)
    echo "not-an-integer"
    exit 0
    ;;
  fail-exit)
    echo "syntax error" >&2
    exit 1
    ;;
  *)
    echo "unknown behavior: $behavior" >&2
    exit 99
    ;;
esac
EOF
  chmod +x "$mock"
  echo "$mock"
}

# ─── Test 1: valid integer → exit 0, stdout = integer ───────────────────
log_test "valid integer result"
MOCK="$(make_mock echo-integer)"
OUT="$(FIND_WINDOW_OSASCRIPT="$MOCK" "$FIND_WINDOW" cmux 2>&1)"
RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "12345" ]; then
  log_pass "echo 12345 + exit 0"
else
  log_fail "echo-integer: got rc=$RC out=[$OUT], expected rc=0 out=12345"
fi

# ─── Test 2: whitespace around integer is trimmed ───────────────────────
log_test "whitespace trimmed"
MOCK="$(make_mock echo-integer-with-whitespace)"
OUT="$(FIND_WINDOW_OSASCRIPT="$MOCK" "$FIND_WINDOW" cmux 2>&1)"
RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "98765" ]; then
  log_pass "whitespace trimmed"
else
  log_fail "echo-integer-with-whitespace: got rc=$RC out=[$OUT], expected rc=0 out=98765"
fi

# ─── Test 3: empty result → exit 1, empty stdout ────────────────────────
log_test "empty result (no window found)"
MOCK="$(make_mock empty)"
OUT_FILE="$TMP_DIR/out-empty"
ERR_FILE="$TMP_DIR/err-empty"
FIND_WINDOW_OSASCRIPT="$MOCK" "$FIND_WINDOW" cmux >"$OUT_FILE" 2>"$ERR_FILE"
RC=$?
OUT="$(cat "$OUT_FILE")"
if [ "$RC" = "1" ] && [ -z "$OUT" ]; then
  log_pass "empty + exit 1"
else
  log_fail "empty: got rc=$RC out=[$OUT], expected rc=1 out=[]"
fi

# ─── Test 4: garbage output → exit 2, stderr, empty stdout ─────────────
log_test "garbage osascript output"
MOCK="$(make_mock garbage)"
OUT_FILE="$TMP_DIR/out-garbage"
ERR_FILE="$TMP_DIR/err-garbage"
FIND_WINDOW_OSASCRIPT="$MOCK" "$FIND_WINDOW" cmux >"$OUT_FILE" 2>"$ERR_FILE"
RC=$?
OUT="$(cat "$OUT_FILE")"
ERR="$(cat "$ERR_FILE")"
if [ "$RC" = "2" ] && [ -z "$OUT" ] && [[ "$ERR" == *unexpected* ]]; then
  log_pass "garbage → exit 2 + stderr"
else
  log_fail "garbage: got rc=$RC out=[$OUT] err=[$ERR], expected rc=2 + stderr"
fi

# ─── Test 5: osascript exit ≠ 0 → exit 2, empty stdout ─────────────────
log_test "osascript fail-exit"
MOCK="$(make_mock fail-exit)"
OUT_FILE="$TMP_DIR/out-fail"
ERR_FILE="$TMP_DIR/err-fail"
FIND_WINDOW_OSASCRIPT="$MOCK" "$FIND_WINDOW" cmux >"$OUT_FILE" 2>"$ERR_FILE"
RC=$?
OUT="$(cat "$OUT_FILE")"
ERR="$(cat "$ERR_FILE")"
if [ "$RC" = "2" ] && [ -z "$OUT" ] && [[ "$ERR" == *exited* ]]; then
  log_pass "osascript fail → exit 2 + stderr"
else
  log_fail "fail-exit: got rc=$RC out=[$OUT] err=[$ERR], expected rc=2 + stderr"
fi

# ─── Test 6: missing query arg → exit 2 with usage ─────────────────────
log_test "missing query arg"
OUT_FILE="$TMP_DIR/out-noarg"
ERR_FILE="$TMP_DIR/err-noarg"
"$FIND_WINDOW" >"$OUT_FILE" 2>"$ERR_FILE"
RC=$?
OUT="$(cat "$OUT_FILE")"
ERR="$(cat "$ERR_FILE")"
if [ "$RC" = "2" ] && [ -z "$OUT" ] && [[ "$ERR" == *usage* ]]; then
  log_pass "no arg → exit 2 + usage"
else
  log_fail "no-arg: got rc=$RC out=[$OUT] err=[$ERR], expected rc=2 + usage"
fi

# ─── Summary ───────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
if [ "$FAILED" -gt 0 ]; then
  echo -e "Failures:$ERRORS" >&2
  exit 1
fi
exit 0
