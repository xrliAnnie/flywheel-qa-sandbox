#!/usr/bin/env bash
# FLY-1393: executable truth-check positive/negative controls.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
pass() { echo "[TEST] ✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "[TEST] ✗ $1"; FAILED=$((FAILED + 1)); }

printf '%s\n' 'FLYWHEEL_MERGE_APPROVAL_GATE=1' > "$TMP/valid.env"
if "$REPO_ROOT/scripts/check-flag-truth.ts" --env-file "$TMP/valid.env" > "$TMP/valid.out" 2>&1 \
  && grep -q 'flag truth OK' "$TMP/valid.out"; then
  pass "valid registered env passes via executable shebang"
else
  fail "valid env failed: $(cat "$TMP/valid.out")"
fi

printf '%s\n' 'FLYWHEEL_CMUX_LINKED_VIEW=1' > "$TMP/tombstone.env"
if "$REPO_ROOT/scripts/check-flag-truth.ts" --env-file "$TMP/tombstone.env" > "$TMP/tombstone.out" 2>&1; then
  fail "retired tombstone unexpectedly passed"
elif grep -q 'FLYWHEEL_CMUX_LINKED_VIEW.*已退役假开关' "$TMP/tombstone.out"; then
  pass "retired tombstone fails with an actionable error"
else
  fail "retired tombstone failed without the expected error: $(cat "$TMP/tombstone.out")"
fi

echo ""
echo "check-flag-truth: PASSED=$PASSED FAILED=$FAILED"
(( FAILED == 0 ))
