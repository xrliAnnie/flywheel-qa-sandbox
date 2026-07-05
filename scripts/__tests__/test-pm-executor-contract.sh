#!/bin/bash
# FLY-880: Guard test for the internal PM agent role .md
# (.flywheel/agents/engineering/product-designer-executor.md).
#
# The role .md is injected verbatim into the Runner system prompt (readAgentFile,
# truncated at 40k chars — Blueprint.ts). It is prompt text, not runtime code, so
# there is no vitest surface; this lite guard defends the two real risks:
#   1. the file grows past the 40k injection-truncation red line, or
#   2. the product-co-creation contract (mode A) OR the inherited docs/design
#      contract (mode B) silently regresses.
# Run: bash scripts/__tests__/test-pm-executor-contract.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLE_MD="${SCRIPT_DIR}/../../.flywheel/agents/engineering/product-designer-executor.md"

PASS=0; FAIL=0
assert_file_exists() {
  if [ -f "$1" ]; then
    PASS=$((PASS+1)); echo "  PASS: $2"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $2 (file not found: $1)"
  fi
}
assert_contains() {
  # $1 file, $2 needle, $3 label
  if grep -qF -- "$2" "$1"; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (missing: '$2')"
  fi
}
assert_max_bytes() {
  # $1 file, $2 max, $3 label
  local n; n=$(wc -c < "$1" | tr -d ' ')
  if [ "$n" -lt "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3 (${n} < $2 bytes)"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (${n} >= $2 bytes — past injection-truncation red line)"
  fi
}

echo "Test: PM executor role .md contract"
assert_file_exists "$ROLE_MD" "role .md exists"

# ── injection-truncation red line ──
# readAgentFile truncates the injected role at 40000 chars; stay well under.
assert_max_bytes "$ROLE_MD" 40000 "role .md under 40k injection-truncation red line"

# ── Mode A: product co-creation (FLY-880 new body) ──
assert_contains "$ROLE_MD" "产品共创"        "mode A anchor: 产品共创 (product co-creation)"
assert_contains "$ROLE_MD" "有定见"          "探定见 protocol: 有定见 / 发挥 (opinion vs run-with-it)"
assert_contains "$ROLE_MD" "gate question"   "interaction primitive: gate question (one-question-per-round)"
# The interaction loop is the BLOCKING gate, DISTINCT from the non-blocking
# `flywheel-comm ask` reporting channel (Codex R1 conflated them). Assert BOTH
# sides of the contrast so a future edit can't keep "BLOCKING gate" yet silently
# drop the "different from ask" clause (Codex R2). Needles carry no backticks
# (zsh command-substitution footgun, FLY-372).
assert_contains "$ROLE_MD" "BLOCKING gate"    "interaction primitive named as the BLOCKING gate"
assert_contains "$ROLE_MD" "non-blocking"     "the ask reporting channel is called out as non-blocking"
assert_contains "$ROLE_MD" "different* primitive from" \
                "gate named a DIFFERENT primitive from ask (loop-is-gate-not-ask)"
assert_contains "$ROLE_MD" "the interaction loop is the blocking" \
                "loop is explicitly the blocking gate (not the ask channel)"
assert_contains "$ROLE_MD" "prd.md"          "PRD output location: prd.md"
assert_contains "$ROLE_MD" "no-three-stage"  "dispatch discipline: no-three-stage label"
assert_contains "$ROLE_MD" "create-issue"    "handoff: create-issue (break PRD into build issues)"

# ── boundary preserved: PM acceptance gate is out of scope (FLY-830) ──
assert_contains "$ROLE_MD" "FLY-830"         "boundary: PM acceptance / pipeline shape = FLY-830 (not here)"

# ── Mode B: inherited docs/design responsibility must NOT be deleted ──
assert_contains "$ROLE_MD" "codex-design-review" "mode B survives: codex-design-review for design specs"
assert_contains "$ROLE_MD" "design"          "mode B survives: docs/design labels"

# ── critical reporting rule preserved (FLY-208 / FLY-270) ──
assert_contains "$ROLE_MD" "flywheel-comm ask" "reporting: flywheel-comm ask (not stock SendMessage)"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
