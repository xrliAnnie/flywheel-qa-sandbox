#!/bin/bash
# GEO-151 / FLY-1402: verify the launcher selects the screencapture prompt for
# the consolidated rules bundle unless LEAD_DISABLE_SCREENCAPTURE_SKILL=1.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/../claude-lead.sh"
PASSED=0
FAILED=0

log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); }

# Evaluate only the production GEO-151 selection block. Stop at FLY-1402's
# materialization block so this focused unit does not need supervisor state.
extract_block() {
  awk '
    /GEO-151 L3: macOS screencapture skill/ { in_block = 1 }
    in_block && /FLY-1402: one immutable per-supervisor rules bundle/ { exit }
    in_block { print }
  ' "$LAUNCHER"
}

run_block() {
  local disable_var="$1" block
  block="$(extract_block)"
  bash -c "
    set -uo pipefail
    SCRIPT_DIR='$(dirname "$LAUNCHER")'
    CLAUDE_ARGS=()
    SELECTED_RULES=()
    IS_COMPANION_ROLE=false
    IS_EXTERNAL_ROLE=false
    _LOCKED_ROLE_LABEL=Locked
    rules_bundle_add() { SELECTED_RULES+=(\"\$1:\$2\"); }
    log() { echo \"[lead] \$*\"; }
    ${disable_var:+export $disable_var}
    $block
    echo '---SELECTED_RULES---'
    printf '%s\\n' \"\${SELECTED_RULES[@]}\"
  "
}

log_test "default (no env var) — selects skill"
OUT="$(run_block "" 2>&1)"
if [[ "$OUT" == *"screencapture-l3-skill.md:launcher"* ]] \
  && [[ "$OUT" == *"Appending L3 screencapture skill"* ]]; then
  log_pass "default selects skill for bundle"
else
  log_fail "default: expected launcher-layer skill selection + log, got:"
  echo "$OUT" | sed 's/^/    /'
fi

log_test "LEAD_DISABLE_SCREENCAPTURE_SKILL=1 — skipped"
OUT="$(run_block "LEAD_DISABLE_SCREENCAPTURE_SKILL=1" 2>&1)"
if [[ "$OUT" != *"screencapture-l3-skill.md:launcher"* ]] \
  && [[ "$OUT" == *"disabled via LEAD_DISABLE_SCREENCAPTURE_SKILL=1"* ]]; then
  log_pass "env-gate skips selection"
else
  log_fail "disabled: expected no skill selection + disabled log, got:"
  echo "$OUT" | sed 's/^/    /'
fi

log_test "LEAD_DISABLE_SCREENCAPTURE_SKILL=0 — selected"
OUT="$(run_block "LEAD_DISABLE_SCREENCAPTURE_SKILL=0" 2>&1)"
if [[ "$OUT" == *"screencapture-l3-skill.md:launcher"* ]]; then
  log_pass "explicit '0' still selects"
else
  log_fail "explicit '0': expected selection, got:"
  echo "$OUT" | sed 's/^/    /'
fi

log_test "exports FLYWHEEL_TEAMLEAD_SCRIPT_DIR"
OUT="$(run_block "" 2>&1)"
if [[ "$OUT" == *"FLYWHEEL_TEAMLEAD_SCRIPT_DIR"* ]] \
  || grep -qF 'export FLYWHEEL_TEAMLEAD_SCRIPT_DIR="$SCRIPT_DIR"' "$LAUNCHER"; then
  log_pass "FLYWHEEL_TEAMLEAD_SCRIPT_DIR exported"
else
  log_fail "FLYWHEEL_TEAMLEAD_SCRIPT_DIR export missing"
fi

echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
exit "$FAILED"
