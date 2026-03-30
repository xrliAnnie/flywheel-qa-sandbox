#!/bin/bash
# GEO-285: Smoke test for supervisor utilities.
# Tests PostCompact hook install idempotency, malformed input handling,
# old path cleanup, and kill -0 guard.
# Run: bash packages/teamlead/scripts/test-rotation.sh
set -euo pipefail

PASS=0; FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (expected '$2', got '$1')"
  fi
}

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Production jq filter — must match claude-lead.sh install_post_compact_hook()
STABLE_CMD="$HOME/.flywheel/bin/post-compact-bootstrap.sh"
prod_jq_filter='
  .hooks.PostCompact = (if .hooks.PostCompact | type == "array" then .hooks.PostCompact else [] end) |
  .hooks.PostCompact = [.hooks.PostCompact[] | select(any(.hooks[]?.command // ""; endswith("post-compact-bootstrap.sh")) | not)] |
  if (.hooks.PostCompact | map(select(any(.hooks[]?.command // ""; . == $cmd))) | length) == 0
  then .hooks.PostCompact += [{"hooks": [{"type": "command", "command": $cmd}]}]
  else .
  end
'

echo "=== Test 1: Hook install idempotency ==="
TEST_SETTINGS="$TMPDIR/settings.json"
echo '{}' > "$TEST_SETTINGS"
# First install
echo '{}' | jq --arg cmd "$STABLE_CMD" "$prod_jq_filter" > "$TEST_SETTINGS"
COUNT1=$(jq '.hooks.PostCompact | length' "$TEST_SETTINGS")
# Second install (idempotent)
cat "$TEST_SETTINGS" | jq --arg cmd "$STABLE_CMD" "$prod_jq_filter" > "$TEST_SETTINGS.tmp" && mv "$TEST_SETTINGS.tmp" "$TEST_SETTINGS"
COUNT2=$(jq '.hooks.PostCompact | length' "$TEST_SETTINGS")
assert_eq "$COUNT1" "1" "first install creates one entry"
assert_eq "$COUNT2" "1" "second install is idempotent"
# Verify nested schema
SCHEMA=$(jq -r '.hooks.PostCompact[0].hooks[0].type' "$TEST_SETTINGS")
assert_eq "$SCHEMA" "command" "nested hooks schema correct"

echo ""
echo "=== Test 2: Malformed PostCompact regression ==="
# Object instead of array — the original bug from Codex Round 3
echo '{"hooks":{"PostCompact":{}}}' | jq --arg cmd "$STABLE_CMD" "$prod_jq_filter" > "$TEST_SETTINGS" 2>/dev/null
assert_eq "$(jq '.hooks.PostCompact | length' "$TEST_SETTINGS")" "1" "PostCompact:{} reset to array + install"
# null PostCompact
echo '{"hooks":{"PostCompact":null}}' | jq --arg cmd "$STABLE_CMD" "$prod_jq_filter" > "$TEST_SETTINGS" 2>/dev/null
assert_eq "$(jq '.hooks.PostCompact | length' "$TEST_SETTINGS")" "1" "PostCompact:null reset to array + install"
# string PostCompact
echo '{"hooks":{"PostCompact":"bad"}}' | jq --arg cmd "$STABLE_CMD" "$prod_jq_filter" > "$TEST_SETTINGS" 2>/dev/null
assert_eq "$(jq '.hooks.PostCompact | length' "$TEST_SETTINGS")" "1" "PostCompact:string reset to array + install"
# missing hooks entirely
echo '{}' | jq --arg cmd "$STABLE_CMD" "$prod_jq_filter" > "$TEST_SETTINGS" 2>/dev/null
assert_eq "$(jq '.hooks.PostCompact | length' "$TEST_SETTINGS")" "1" "missing hooks → create + install"

echo ""
echo "=== Test 3: Old path cleanup (worktree/clone dedup) ==="
# Pre-populate with two old repo-local entries and one unrelated hook
OLD_SETTINGS='{"hooks":{"PostCompact":[
  {"hooks":[{"type":"command","command":"/Users/me/Dev/flywheel/packages/teamlead/scripts/post-compact-bootstrap.sh"}]},
  {"hooks":[{"type":"command","command":"/Users/me/Dev/flywheel-geo-285/packages/teamlead/scripts/post-compact-bootstrap.sh"}]},
  {"hooks":[{"type":"command","command":"/some/other/hook.sh"}]}
]}}'
echo "$OLD_SETTINGS" | jq --arg cmd "$STABLE_CMD" "$prod_jq_filter" > "$TEST_SETTINGS"
# Should have 2 entries: the unrelated hook + the new stable-path entry
assert_eq "$(jq '.hooks.PostCompact | length' "$TEST_SETTINGS")" "2" "old paths removed, unrelated kept"
# Verify the stable path is the one registered
assert_eq "$(jq -r '.hooks.PostCompact[-1].hooks[0].command' "$TEST_SETTINGS")" "$STABLE_CMD" "stable path entry present"
# Verify the unrelated hook survived
assert_eq "$(jq -r '.hooks.PostCompact[0].hooks[0].command' "$TEST_SETTINGS")" "/some/other/hook.sh" "unrelated hook preserved"

echo ""
echo "=== Test 4: kill -0 guard under set -e ==="
# Verify that guarded kill doesn't abort under set -e
sleep 0.01 &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true
# This pattern must NOT abort under set -e:
if kill -0 "$DEAD_PID" 2>/dev/null; then
  kill "$DEAD_PID" 2>/dev/null || true
  wait "$DEAD_PID" 2>/dev/null || true
fi
assert_eq "survived" "survived" "kill -0 guard safe under set -e"

echo ""
echo "════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════════"
[ "$FAIL" -eq 0 ]
