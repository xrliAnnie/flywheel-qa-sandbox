#!/bin/bash
# FLY-1463: cheap static guard for the QA-owned ship-report HTML contract.
# This proves only that the runtime-loaded role and reusable template retain
# their hard anchors; the real proof remains downstream hosted/Discord QA.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QA_MD="${SCRIPT_DIR}/../../.flywheel/agents/nodes/qa.md"
TEMPLATE="${SCRIPT_DIR}/../../.flywheel/templates/ship-report-template.html"

PASS=0; FAIL=0
assert_file_exists() {
  if [ -f "$1" ]; then
    PASS=$((PASS+1)); echo "  PASS: $2"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $2 (file not found: $1)"
  fi
}
assert_contains() {
  if grep -qF -- "$2" "$1"; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (missing: '$2')"
  fi
}
assert_not_contains() {
  if grep -qF -- "$2" "$1"; then
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (forbidden: '$2')"
  else
    PASS=$((PASS+1)); echo "  PASS: $3"
  fi
}
assert_max_bytes() {
  local n; n=$(wc -c < "$1" | tr -d ' ')
  if [ "$n" -lt "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3 (${n} < $2 bytes)"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (${n} >= $2 bytes)"
  fi
}

echo "Test: QA PASS ship-report HTML mandate (FLY-1463)"

assert_file_exists "$QA_MD" "qa node prompt exists"
assert_max_bytes "$QA_MD" 40000 "qa node prompt stays under runtime byte budget"
assert_contains "$QA_MD" "QA PASS opens the founder ship gate" "mandate heading survives"
assert_contains "$QA_MD" "you own it, not your Lead" "QA owns the report"
assert_contains "$QA_MD" "BEFORE emitting qa-result --status pass" "pipeline PASS ordering survives"
assert_contains "$QA_MD" "before reporting PASS to the Lead" "manual PASS ordering survives"
assert_contains "$QA_MD" "publish-report --html" "publish command survives"
assert_contains "$QA_MD" "--issue" "parent issue targeting survives"
assert_contains "$QA_MD" "Mermaid" "Mermaid authoring survives"
assert_contains "$QA_MD" "inline SVG" "pre-rendered diagram format survives"
assert_contains "$QA_MD" "reacting ✅ on the ship card" "card-only approval guidance survives"
assert_not_contains "$QA_MD" "SHIP-VERDICT" "obsolete verdict token is absent"
assert_contains "$QA_MD" "529 thread link" "529 evidence link survives"
assert_contains "$QA_MD" "honest boundary" "untested-boundary disclosure survives"
assert_contains "$QA_MD" "SHIP-REPORT publish-failed" "publish fallback survives"
assert_contains "$QA_MD" "never silently skip" "silent omission remains forbidden"

assert_file_exists "$TEMPLATE" "ship-report template exists"
if [ -f "$TEMPLATE" ]; then
  assert_contains "$TEMPLATE" "__CSP_NONCE__" "CSP nonce placeholder survives"
  assert_contains "$TEMPLATE" "color-scheme:light only" "Apple light-only rendering survives"
  assert_contains "$TEMPLATE" "仅认 founder 在 ship 卡片上的 ✅ reaction" "template points approval to the card"
  assert_not_contains "$TEMPLATE" "SHIP-VERDICT" "template does not export an obsolete verdict token"
  assert_contains "$TEMPLATE" "data-k=" "section-keyed comments survive"
  assert_contains "$TEMPLATE" "location.pathname" "localStorage is isolated per report path"
  assert_contains "$TEMPLATE" "529 thread" "529 evidence slot survives"
  assert_not_contains "$TEMPLATE" "prefers-color-scheme" "no dark-mode media override"
  assert_not_contains "$TEMPLATE" "onclick=" "no CSP-blocked inline handlers"
fi

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
