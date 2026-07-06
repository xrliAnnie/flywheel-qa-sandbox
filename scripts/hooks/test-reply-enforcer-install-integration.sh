#!/bin/bash
# Integration test: run the REAL install_discord_reply_enforcer_hook() from
# claude-lead.sh against a throwaway HOME and assert end-to-end behavior
# (cp + chmod + fine-grained jq merge + mv), sibling preservation, idempotency.
# Complements the isolated jq-filter unit test (FLY-387).
#
# Usage: bash scripts/hooks/test-reply-enforcer-install-integration.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_SH="${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1: $2"; }

# Extract just the function body (its closing brace is the only one at col 0).
FUNC=$(sed -n '/^install_discord_reply_enforcer_hook()/,/^}/p' "$LEAD_SH")
[ -n "$FUNC" ] || { echo "ERROR: could not extract function from $LEAD_SH"; exit 1; }

# Minimal harness env the function needs.
export FLYWHEEL_ROOT="$REPO_ROOT"
export FLYWHEEL_LEAD_DRY_RUN=0
log() { :; }                 # silence the function's log() calls
eval "$FUNC"                 # define install_discord_reply_enforcer_hook

TMP_HOME="$(mktemp -d)"
cleanup() { rm -rf "$TMP_HOME"; }
trap cleanup EXIT

mkdir -p "$TMP_HOME/.claude"
# Pre-existing settings: an OLD manual enforcer + an unrelated SIBLING in the
# same Stop group + an unrelated PostCompact hook (must all be respected).
cat > "$TMP_HOME/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "Stop": [
      {"hooks": [
        {"type": "command", "command": "python3 /Users/x/.claude/hooks/discord-reply-enforcer.py"},
        {"type": "command", "command": "/Users/x/.claude/hooks/other-guard.sh"}
      ]}
    ],
    "PostCompact": [
      {"hooks": [{"type": "command", "command": "/Users/x/.flywheel/bin/post-compact-bootstrap.sh"}]}
    ]
  }
}
EOF

HOME="$TMP_HOME" install_discord_reply_enforcer_hook
HOME="$TMP_HOME" install_discord_reply_enforcer_hook   # twice → idempotent

S="$TMP_HOME/.claude/settings.json"
STABLE="python3 ${TMP_HOME}/.flywheel/bin/discord-reply-enforcer.py"

# 1. hook script copied + executable
if [ -x "${TMP_HOME}/.flywheel/bin/discord-reply-enforcer.py" ]; then
  pass "I1 hook copied to stable path + executable"
else
  fail "I1" "stable hook not installed/executable"
fi

# 2. exactly one enforcer entry (idempotent), old manual one gone
N=$(jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") | endswith("discord-reply-enforcer.py"))] | length' "$S")
HASOLD=$(jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") == "python3 /Users/x/.claude/hooks/discord-reply-enforcer.py")] | length' "$S")
HASNEW=$(jq --arg c "$STABLE" '[.hooks.Stop[]?.hooks[]? | select((.command // "") == $c)] | length' "$S")
if [ "$N" = "1" ] && [ "$HASOLD" = "0" ] && [ "$HASNEW" = "1" ]; then
  pass "I2 idempotent: one stable enforcer, old manual removed"
else
  fail "I2" "n=$N hasold=$HASOLD hasnew=$HASNEW"
fi

# 3. sibling in the same group preserved
SIB=$(jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") == "/Users/x/.claude/hooks/other-guard.sh")] | length' "$S")
[ "$SIB" = "1" ] && pass "I3 same-group sibling preserved" || fail "I3" "sibling count=$SIB"

# 4. unrelated PostCompact hook untouched
PC=$(jq '[.hooks.PostCompact[]?.hooks[]? | select((.command // "") == "/Users/x/.flywheel/bin/post-compact-bootstrap.sh")] | length' "$S")
[ "$PC" = "1" ] && pass "I4 PostCompact hook untouched" || fail "I4" "pc=$PC"

# 5. result is valid JSON
[ -n "$(jq -c . "$S" 2>/dev/null)" ] && pass "I5 settings.json still valid JSON" || fail "I5" "invalid JSON after install"

# 6. malformed settings → fail-open, file left untouched
echo '{ broken json not valid' > "$S"
BEFORE=$(cat "$S")
HOME="$TMP_HOME" install_discord_reply_enforcer_hook
AFTER=$(cat "$S")
[ "$BEFORE" = "$AFTER" ] && pass "I6 malformed settings left untouched (fail-open)" || fail "I6" "file was modified"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
