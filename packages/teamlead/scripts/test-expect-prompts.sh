#!/bin/bash
# FLY-83: replay blocked-prompt fixtures through the expect wrapper embedded
# in claude-lead.sh and assert exit codes. Lets us tweak regex anchors /
# bounded distances without firing up real Claude Code sessions.
#
# Usage: ./test-expect-prompts.sh
#
# The expect script body is pulled live from claude-lead.sh (heredoc between
# `cat > "$_EXPECT_SCRIPT" <<'EXPECT_EOF'` and `EXPECT_EOF`) so tests stay
# in lockstep with the supervisor's real behaviour.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURE_DIR="${SCRIPT_DIR}/test-fixtures/lead-prompts"
SOURCE="${SCRIPT_DIR}/claude-lead.sh"

if ! command -v expect >/dev/null 2>&1; then
  echo "SKIP: expect not found in PATH" >&2
  exit 0
fi

# Extract the expect heredoc body into a temp .exp file.
EXP_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-expect-test.XXXXXX.exp")
trap 'rm -f "$EXP_FILE"' EXIT

awk '
  /cat > "\$_EXPECT_SCRIPT" <<.EXPECT_EOF./ { capture=1; next }
  /^EXPECT_EOF$/ { capture=0 }
  capture == 1 { print }
' "$SOURCE" > "$EXP_FILE"

if [ ! -s "$EXP_FILE" ]; then
  echo "FAIL: could not extract expect script from $SOURCE" >&2
  exit 1
fi
chmod +x "$EXP_FILE"

pass=0
fail=0

run_case() {
  local fixture="$1"
  local expected="$2"
  local label="$3"

  if [ ! -f "$fixture" ]; then
    echo "  [SKIP] $label — missing fixture $fixture"
    return 0
  fi

  # expect spawns its argv via eval, so we quote to keep cat's path intact.
  # `cat` is not interactive — expect sees the fixture bytes on the PTY,
  # matches regex, and either exits with a sentinel or reaches EOF (exit 0).
  local actual=0
  expect "$EXP_FILE" cat "$fixture" >/dev/null 2>&1 || actual=$?

  if [ "$actual" = "$expected" ]; then
    echo "  [PASS] $label → exit $actual"
    pass=$((pass + 1))
  else
    echo "  [FAIL] $label → expected $expected, got $actual"
    fail=$((fail + 1))
  fi
}

echo "Running expect prompt regression ($EXP_FILE)"
run_case "${FIXTURE_DIR}/rate-limit.ansi"     100 "rate_limit"
run_case "${FIXTURE_DIR}/usage-limit.ansi"    100 "usage_limit"
run_case "${FIXTURE_DIR}/login-expired.ansi"  101 "login_expired"
run_case "${FIXTURE_DIR}/permission-file.ansi" 102 "permission_blocked"
run_case "${FIXTURE_DIR}/normal-running.ansi" 0   "no_blocked_prompt"

echo ""
echo "Result: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ]
