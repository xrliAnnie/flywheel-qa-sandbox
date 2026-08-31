#!/bin/bash
# FLY-1461: Guard test for the 529 QA Room real-Discord-N-to-N mandate in the QA
# executor role .md file.
#
# The QA node prompt (.flywheel/agents/nodes/qa.md) is injected
# verbatim into the QA Runner system prompt (readAgentFile, truncated at 40k CHARS —
# Blueprint.ts). It is prompt text, not runtime code, so there is no vitest surface:
# this is a CHEAP SMOKE SENTINEL, not a behavior test — grep anchors can only prove
# the byte budget + the hard-rule's process anchors survive an edit, NOT that a Runner
# actually runs the 529 N-to-N. The real proof is behavioral (a downstream Discord-
# capable QA auto-runs the 529 N-to-N without a Lead reminder — FLY-1461 acceptance).
#
# This guard defends Annie's FLY-1461 directive: the "Discord-capable change → real
# Discord N-to-N in the 529 QA Room is part of QA-done" rule lives in the QA Runner's
# OWN instructions (not the Lead's memory) and cannot be silently deleted in an edit.
# Needles carry NO backticks (zsh command-substitution footgun, FLY-372).
# Run: bash scripts/__tests__/test-qa-executor-529-nton-contract.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QA_MD="${SCRIPT_DIR}/../../.flywheel/agents/nodes/qa.md"

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
  # $1 file, $2 max, $3 label. wc -c (bytes) is a deliberately-stricter byte-budget
  # SENTINEL for the runtime 40000-CHAR slice — multi-byte chars make bytes > chars,
  # so passing the byte check guarantees the char check.
  local n; n=$(wc -c < "$1" | tr -d ' ')
  if [ "$n" -lt "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3 (${n} < $2 bytes)"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (${n} >= $2 bytes — past injection-truncation red line)"
  fi
}

echo "Test: qa node 529 QA Room N-to-N mandate (FLY-1461)"

assert_file_exists "$QA_MD" "qa.md exists (runtime-loaded QA node)"
assert_max_bytes "$QA_MD" 40000 "under 40k byte-budget sentinel (readAgentFile truncation)"

# ── the mandate section + its heading survive ──
assert_contains "$QA_MD" "529 QA Room" "529 QA Room named"
assert_contains "$QA_MD" "N-to-N" "real Discord N-to-N named"
assert_contains "$QA_MD" "MANDATORY, self-owned" "rule is MANDATORY and self-owned (not Lead-remembered)"
assert_contains "$QA_MD" "you own it, not your Lead" "self-ownership stated (durable, not memory-dependent)"

# ── the Discord-capable judgment criteria ──
assert_contains "$QA_MD" "Discord-capable judgment" "judgment-criteria anchor present"
assert_contains "$QA_MD" "cross-Lead or cross-Runner coordination" "coordination is in the Discord-capable set"

# ── the anti-pattern (never frame live e2e as a post-deploy / deploy-gate step) ──
assert_contains "$QA_MD" "deploy gate" "anti-pattern anchor: NEVER a deploy gate"
assert_contains "$QA_MD" "WITHOUT touching production" "529 = test real Discord without touching production"

# ── the mechanism the runner needs (candidate head → isolated slot → real Discord) ──
assert_contains "$QA_MD" "test-deploy.sh" "mechanism: test-deploy.sh"
assert_contains "$QA_MD" "--from-branch" "mechanism: candidate PR head via --from-branch"
assert_contains "$QA_MD" "--extra-lead" "mechanism: second real Lead (N-to-N topology) via --extra-lead"
assert_contains "$QA_MD" "inject-linear-issue.sh" "mechanism: real Runner injection driver"
assert_contains "$QA_MD" "Claude-in-Chrome" "mechanism: founder-side via Claude-in-Chrome"
assert_contains "$QA_MD" "FLYWHEEL_DELIVERY_SECRET_PATH" "isolation guardrail: delivery-secret path"

# ── the exemption is explicit, never a silent skip ──
assert_contains "$QA_MD" "no N-to-N surface" "exemption wording present"
assert_contains "$QA_MD" "never silently skip" "exemption is a stated declaration, not a silent skip"

# ── the existing Real-machine E2E bullet cross-links the new section ──
assert_contains "$QA_MD" "Real-machine E2E for user-facing flows" "existing E2E bullet preserved"

# ── the file did not lose its reporting contract ──
assert_contains "$QA_MD" "flywheel-comm" "reporting channel preserved (flywheel-comm)"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
