#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC_DIR="$ROOT/engineering/doc/FLY-1272-cmux-tab-pane-mismatch"
TEST_SUMMARY="$ROOT/scripts/test-cmux-sync.sh"
TMP_ROOT=$(mktemp -d)
PASS=0
FAIL=0
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

filter_active_contract() {
  awk '
    BEGIN { history=0 }
    /^## 10\./ { history=1 }
    history { next }
    /不建|已撤|撤除|descope|禁词|修正史/ { next }
    /P8|文档验证 grep/ { next }
    { print }
  ' "$@"
}

contains_banned_contract() {
  rg -ni 'manifest|fence|request-id|verified_ready|迁移辅助命令|converge_view_for_title|repair_create' "$1" >/dev/null
}

active="$TMP_ROOT/active.md"
filter_active_contract "$DOC_DIR/plan.md" "$DOC_DIR/research.md" > "$active"

echo "Test: FLY-1272 active docs contain no withdrawn protocol contract"
if ! contains_banned_contract "$active"; then
  pass "withdrawn protocol keywords have zero active hits"
else
  fail "withdrawn contract leaked into active docs: $(rg -ni 'manifest|fence|request-id|verified_ready|迁移辅助命令|converge_view_for_title|repair_create' "$active" | tr '\n' ';')"
fi

echo "Test: FLY-1272 active docs make no unqualified fast-rebuild claim"
if ! rg -n '≤ ?15s|15s.{0,30}(建|重建)|重生.{0,40}正确会话' "$active" >/dev/null; then
  pass "fast/rebirth claims have zero unqualified hits"
else
  fail "unqualified convergence claim found: $(rg -n '≤ ?15s|15s.{0,30}(建|重建)|重生.{0,40}正确会话' "$active" | tr '\n' ';')"
fi

echo "Test: FLY-1272 named R19-R22 regressions are executable test anchors"
anchor_hits=0
rg -q 'pre-existing orphan client \+ new attach failure never false-greens' "$TEST_SUMMARY" && anchor_hits=$((anchor_hits + 1))
rg -q 'attach failure \+ post-create read failure \(pre=0 and nonzero variants\) retains ref' "$TEST_SUMMARY" && anchor_hits=$((anchor_hits + 1))
rg -q 'B-foreign: A closes, B stays visible/unmodified, no substitute ref, keyed warning' "$TEST_SUMMARY" && anchor_hits=$((anchor_hits + 1))
if [[ "$anchor_hits" -eq 3 ]]; then
  pass "all three named attachment/foreign regressions are present"
else
  fail "expected 3 named regression anchors, found $anchor_hits"
fi

echo "Test: FLY-1272 doc gate mutation fixture turns red"
mutant="$TMP_ROOT/mutant.md"
cp "$active" "$mutant"
printf '\nrefresh verified_ready ACK contract\n' >> "$mutant"
if contains_banned_contract "$mutant"; then
  pass "injected withdrawn ACK contract is rejected"
else
  fail "mutation fixture did not turn the gate red"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
