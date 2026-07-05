#!/bin/bash
# GEO-151 C10 — verify claude-lead.sh respects LEAD_DISABLE_SCREENCAPTURE_SKILL.
#
# Why a separate test from find-window.test.sh? The launcher contract is
# orthogonal to the helper script: this verifies the launcher
#   - appends `screencapture-l3-skill.md` to CLAUDE_ARGS by default,
#   - SKIPS the append when LEAD_DISABLE_SCREENCAPTURE_SKILL=1.
#
# We don't run the full launcher (it spawns claude, mounts MCP, etc.) — we
# extract the screencapture block and run it in isolation with stubs.
# Approach mirrors the existing rollback-args-gate.test.sh pattern.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/../claude-lead.sh"

PASSED=0
FAILED=0

log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); }

# Extract the screencapture block from the launcher (between the section
# header comment and the next ════ divider). Then evaluate it in a
# subshell with the minimal env it needs.
EXTRACT_BLOCK() {
  awk '
    /GEO-151 L3: macOS screencapture skill/ { in_block = 1 }
    in_block { print }
    in_block && /^# ════════════════════════════════════════════════════════════════$/ && lines > 2 { exit }
    in_block { lines++ }
  ' "$LAUNCHER"
}

run_block() {
  local disable_var="$1"
  local block
  block="$(EXTRACT_BLOCK)"
  # Provide the variables the block needs.
  bash -c "
    set -uo pipefail
    SCRIPT_DIR='$(dirname "$LAUNCHER")'
    CLAUDE_ARGS=()
    log() { echo \"[lead] \$*\"; }
    ${disable_var:+export $disable_var}
    $block
    echo \"---CLAUDE_ARGS---\"
    printf '%s\n' \"\${CLAUDE_ARGS[@]}\"
  "
}

# ─── Test 1: default → skill appended ────────────────────────────────────
log_test "default (no env var) — appends skill"
OUT="$(run_block "" 2>&1)"
if [[ "$OUT" == *"--append-system-prompt-file"* ]] \
   && [[ "$OUT" == *"screencapture-l3-skill.md"* ]] \
   && [[ "$OUT" == *"Appending L3 screencapture skill"* ]]; then
  log_pass "default appends skill"
else
  log_fail "default: expected --append-system-prompt-file + skill path + 'Appending' log, got:"
  echo "$OUT" | sed 's/^/    /'
fi

# ─── Test 2: LEAD_DISABLE_SCREENCAPTURE_SKILL=1 → skip ─────────────────
log_test "LEAD_DISABLE_SCREENCAPTURE_SKILL=1 — skipped"
OUT="$(run_block "LEAD_DISABLE_SCREENCAPTURE_SKILL=1" 2>&1)"
if [[ "$OUT" != *"--append-system-prompt-file"* ]] \
   && [[ "$OUT" == *"disabled via LEAD_DISABLE_SCREENCAPTURE_SKILL=1"* ]]; then
  log_pass "env-gate skips append"
else
  log_fail "disabled: expected NO --append-system-prompt-file + 'disabled' log, got:"
  echo "$OUT" | sed 's/^/    /'
fi

# ─── Test 3: LEAD_DISABLE_SCREENCAPTURE_SKILL=0 → appended ─────────────
log_test "LEAD_DISABLE_SCREENCAPTURE_SKILL=0 — appended"
OUT="$(run_block "LEAD_DISABLE_SCREENCAPTURE_SKILL=0" 2>&1)"
if [[ "$OUT" == *"--append-system-prompt-file"* ]] \
   && [[ "$OUT" == *"screencapture-l3-skill.md"* ]]; then
  log_pass "explicit '0' still appends"
else
  log_fail "explicit '0': expected append, got:"
  echo "$OUT" | sed 's/^/    /'
fi

# ─── Test 4: exports FLYWHEEL_TEAMLEAD_SCRIPT_DIR ──────────────────────
log_test "exports FLYWHEEL_TEAMLEAD_SCRIPT_DIR"
OUT="$(bash -c "
  set -uo pipefail
  SCRIPT_DIR='$(dirname "$LAUNCHER")'
  CLAUDE_ARGS=()
  log() { :; }
  $(EXTRACT_BLOCK)
  echo \"FTSD=\$FLYWHEEL_TEAMLEAD_SCRIPT_DIR\"
" 2>&1)"
if [[ "$OUT" == *"FTSD=$(dirname "$LAUNCHER")"* ]]; then
  log_pass "FLYWHEEL_TEAMLEAD_SCRIPT_DIR exported"
else
  log_fail "FLYWHEEL_TEAMLEAD_SCRIPT_DIR not exported correctly, got:"
  echo "$OUT" | sed 's/^/    /'
fi

# ─── Summary ───────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
exit "$FAILED"
