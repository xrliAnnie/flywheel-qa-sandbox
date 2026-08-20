#!/bin/bash
# GEO-151 QA cycle 1 — verify FLYWHEEL_TEAMLEAD_SCRIPT_DIR (and the L3
# skill's other expected env vars) survive `_launch_claude`'s env -i boundary.
#
# Why a separate test from screencap-skill-gate.test.sh?
#
# - screencap-skill-gate.test.sh verifies the launcher SHELL exports
#   FLYWHEEL_TEAMLEAD_SCRIPT_DIR after running the C10 block. It runs
#   the extracted block in a `bash -c` subshell that inherits exports
#   natively, so it cannot model the explicit child allowlist.
#
# - QA cycle 1 (2026-05-22) found that in production the Lead pane sees
#   `FLYWHEEL_TEAMLEAD_SCRIPT_DIR=` (empty) because the child boundary only
#   forwards what's explicitly in env_args. This test pins that allowlist
#   contract so a future refactor cannot silently drop it again.
#
# Test approach:
#   1. Static structural check — parse `_launch_claude` env_args block
#      and assert FLYWHEEL_TEAMLEAD_SCRIPT_DIR is a literal allowlist
#      entry. This catches "someone deleted the line" regressions.

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
log_test "_launch_claude child-env allowlist forwards FLYWHEEL_TEAMLEAD_SCRIPT_DIR"
BLOCK="$(EXTRACT_ENV_ARGS_BLOCK)"
if [ -z "$BLOCK" ]; then
  log_fail "could not extract env_args block from $LAUNCHER (parser broken or function renamed)"
elif echo "$BLOCK" | grep -qE '^[[:space:]]*-e[[:space:]]+"FLYWHEEL_TEAMLEAD_SCRIPT_DIR='; then
  log_pass "FLYWHEEL_TEAMLEAD_SCRIPT_DIR is in the child-env allowlist"
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

# FLY-1855: QA slots inject a slot-local StateStore path in the launch
# manifest. It must cross the explicit env -i boundary or the patrol snapshot
# silently falls back to the production $HOME/.flywheel/teamlead.db.
log_test "_launch_claude conditionally forwards TEAMLEAD_DB_PATH"
if grep -Fq 'env_args+=(-e "TEAMLEAD_DB_PATH=${TEAMLEAD_DB_PATH}")' "$LAUNCHER"; then
  log_pass "TEAMLEAD_DB_PATH crosses the child env boundary when set"
else
  log_fail "TEAMLEAD_DB_PATH is not conditionally forwarded through env -i"
fi

# FLY-1426: the Discord plugin and the Lead pane must read the same rollout
# priority windows. The plugin runs after the env -i boundary, so
# inherited launcher-shell values are not sufficient.
log_test "_launch_claude forwards the Discord chat delivery windows"
for var in \
  FLYWHEEL_RECEIPT_WINDOW_P0_MIN \
  FLYWHEEL_RECEIPT_WINDOW_P1_MIN \
  FLYWHEEL_RECEIPT_WINDOW_P2_MIN \
  FLYWHEEL_RECEIPT_WINDOW_P3_MIN; do
  if echo "$BLOCK" | grep -qE "^[[:space:]]*-e[[:space:]]+\"$var="; then
    log_pass "$var present in env_args"
  else
    log_fail "$var missing from env_args — chat delivery windows would drift inside the Lead pane"
  fi
done

# ─── Summary ───────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
exit "$FAILED"
