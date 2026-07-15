#!/bin/bash
# GEO-151 QA cycle 1 — verify FLYWHEEL_TEAMLEAD_SCRIPT_DIR (and the L3
# skill's other expected env vars) survive the `tmux new-window -e`
# allowlist barrier in `_launch_claude`.
#
# Why a separate test from screencap-skill-gate.test.sh and
# tmux-integration.test.sh?
#
# - screencap-skill-gate.test.sh verifies the launcher SHELL exports
#   FLYWHEEL_TEAMLEAD_SCRIPT_DIR after running the C10 block. It runs
#   the extracted block in a `bash -c` subshell that inherits exports
#   natively, so it cannot model the tmux -e allowlist filter.
#
# - tmux-integration.test.sh verifies tmux primitives generically but
#   does not exercise the specific `_launch_claude` env_args allowlist.
#
# - QA cycle 1 (2026-05-22) found that in production the Lead pane sees
#   `FLYWHEEL_TEAMLEAD_SCRIPT_DIR=` (empty) because `tmux new-window -e`
#   only forwards what's explicitly in env_args. Adding the var to the
#   launcher's allowlist is the fix; this test pins that allowlist
#   contract so a future refactor cannot silently drop it again.
#
# Test approach:
#   1. Static structural check — parse `_launch_claude` env_args block
#      and assert FLYWHEEL_TEAMLEAD_SCRIPT_DIR is a literal allowlist
#      entry. This catches "someone deleted the line" regressions.
#   2. tmux integration check — when tmux is available, drive the same
#      `tmux new-window -e` primitive _launch_claude uses, asserting
#      the var lands non-empty in the child pane. Skipped gracefully
#      when tmux is unavailable (e.g. minimal CI image).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/../claude-lead.sh"

PASSED=0
FAILED=0

log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); }
# Detail lines for an already-counted failure (hints, dumps). Does NOT
# increment FAILED so a single failed assertion stays counted once.
log_detail() { echo "    $*" >&2; }

# Extract the env_args=( ... ) block inside _launch_claude. The block
# starts with `local env_args=(` and ends at the matching `)`. We use
# awk to pull just that span so later additions outside _launch_claude
# (e.g. conditional appends or other functions referencing env_args)
# cannot accidentally satisfy the assertion.
EXTRACT_ENV_ARGS_BLOCK() {
  # Use POSIX bracket classes (not `\s`) — BSD awk on macOS lacks the
  # PCRE shorthand and would silently never match the closing `)`,
  # running to EOF and dumping unrelated launcher code into the block.
  awk '
    /^_launch_claude\(\)/ { in_func = 1 }
    in_func && /local env_args=\(/ { in_block = 1; print; next }
    in_block { print }
    in_block && /^[[:space:]]*\)[[:space:]]*$/ { in_block = 0; in_func = 0; exit }
  ' "$LAUNCHER"
}

# ─── Test 1: env_args allowlist includes FLYWHEEL_TEAMLEAD_SCRIPT_DIR ──
log_test "_launch_claude env_args allowlist forwards FLYWHEEL_TEAMLEAD_SCRIPT_DIR"
BLOCK="$(EXTRACT_ENV_ARGS_BLOCK)"
if [ -z "$BLOCK" ]; then
  log_fail "could not extract env_args block from $LAUNCHER (parser broken or function renamed)"
elif echo "$BLOCK" | grep -qE '^[[:space:]]*-e[[:space:]]+"FLYWHEEL_TEAMLEAD_SCRIPT_DIR='; then
  log_pass "FLYWHEEL_TEAMLEAD_SCRIPT_DIR is in the tmux -e allowlist"
else
  log_fail "FLYWHEEL_TEAMLEAD_SCRIPT_DIR missing from env_args allowlist."
  log_detail "Lead pane will see empty value → L3 screencap skill falls back to 'find /' recursive scan."
  log_detail "Add: -e \"FLYWHEEL_TEAMLEAD_SCRIPT_DIR=\${FLYWHEEL_TEAMLEAD_SCRIPT_DIR:-}\" to env_args."
  log_detail "env_args block found:"
  echo "$BLOCK" | sed 's/^/      /' >&2
fi

# ─── Test 2: core comm/identity vars still in allowlist (regression net) ─
# Sanity-check that we're parsing the right block: a few vars that have
# been stable in the allowlist for many versions should still be present.
log_test "_launch_claude env_args allowlist still contains core identity vars"
for var in DISCORD_BOT_TOKEN FLYWHEEL_LEAD_ID FLYWHEEL_COMM_DB PATH HOME; do
  if echo "$BLOCK" | grep -qE "^[[:space:]]*-e[[:space:]]+\"$var="; then
    log_pass "$var present in env_args"
  else
    log_fail "$var missing from env_args — extractor may be parsing the wrong block"
  fi
done

# ─── Test 3: tmux integration — propagation survives the real barrier ──
log_test "tmux new-window -e propagates FLYWHEEL_TEAMLEAD_SCRIPT_DIR to child pane"
if ! command -v tmux >/dev/null 2>&1; then
  log_pass "SKIPPED (tmux not installed — static check above is sufficient)"
else
  TEST_SESSION="geo151-env-prop-$$"
  trap 'tmux kill-session -t "=${TEST_SESSION}" 2>/dev/null || true' EXIT

  # Mirror the _launch_claude invocation shape: start a detached session,
  # then a new-window with -e forwarding the var, running a small command
  # that echoes the value to a capture file.
  CAPTURE_FILE="$(mktemp -t geo151-env-XXXXXX)"
  trap 'rm -f "$CAPTURE_FILE"; tmux kill-session -t "=${TEST_SESSION}" 2>/dev/null || true' EXIT

  tmux new-session -Ad -s "$TEST_SESSION" -x 200 -y 50 2>/dev/null || true
  tmux new-window -d \
    -t "=${TEST_SESSION}" \
    -e "FLYWHEEL_TEAMLEAD_SCRIPT_DIR=/expected/launcher/path" \
    -n "env-test" \
    -c "/tmp" \
    bash -c "echo \"FTSD=\$FLYWHEEL_TEAMLEAD_SCRIPT_DIR\" > \"$CAPTURE_FILE\"; sleep 5"

  # Allow the bash inside the pane time to write the capture file.
  for _ in 1 2 3 4 5; do
    if [ -s "$CAPTURE_FILE" ]; then break; fi
    sleep 0.5
  done

  if grep -q '^FTSD=/expected/launcher/path$' "$CAPTURE_FILE"; then
    log_pass "var survives tmux -e barrier with non-empty value"
  else
    log_fail "var did NOT propagate through tmux -e"
    log_detail "capture file contents: $(cat "$CAPTURE_FILE" 2>/dev/null || echo '<empty>')"
  fi
fi

# ─── Summary ───────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
exit "$FAILED"
