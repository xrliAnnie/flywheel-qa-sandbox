#!/bin/bash
# FLY-143: tests for the user-scope MCP inheritance helper
# (packages/teamlead/scripts/lib/mcp-inherit.sh).
#
# Coverage (Codex r3/r4):
#   - happy path: Annie inventory, all envs present → 4 servers inherited
#   - missing LINEAR_API_KEY → linear-api skipped, others survive
#   - blacklist (`audible`) → skipped
#   - per-Lead exclude (`bambu-h2d,xiaohongshu-mcp`) with whitespace → both skipped
#   - reserved-name collision (Annie's user-scope `gbrain`) → warn + skip user version
#   - `~/.claude.json` missing → empty fragment, no abort
#   - `~/.claude.json` malformed → empty fragment, no abort
#   - `${VAR:-default}` env placeholder → not skipped when VAR unset
#   - `$$VAR` literal escape → not treated as required
#   - bare `$VAR` (no braces) → not treated as required
#   - multiple `${...}` in same string → all detected
#   - JSON string containing newline → scan still works
#   - atomic write produces 0600 mode JSON file with correct merge order
set -euo pipefail

PASSED=0
FAILED=0
ERRORS=""

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  ✗ $1"; log_test "✗ $1"; }

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required for these tests"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
HELPER="${LIB_DIR}/mcp-inherit.sh"

if [ ! -f "$HELPER" ]; then
  echo "ERROR: helper not found at ${HELPER}"
  exit 1
fi

# shellcheck source=../lib/mcp-inherit.sh
source "$HELPER"

TMP_DIR="$(mktemp -d -t fly143-mcp-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Helper: write a fixture ~/.claude.json. Pass JSON for top-level mcpServers.
fixture() {
  local target="$1"; shift
  cat > "$target"
}

# ════════════════════════════════════════════════════════════════
# Test 1: happy path — Annie inventory + all envs present
# ════════════════════════════════════════════════════════════════
log_test "Test 1: happy path — 5 user-scope servers, blacklist skips audible"
FIX_1="${TMP_DIR}/claude-1.json"
fixture "$FIX_1" <<'EOF'
{
  "mcpServers": {
    "linear-api": {"type": "http", "url": "https://mcp.linear.app/mcp", "headers": {"Authorization": "Bearer ${LINEAR_API_KEY}"}},
    "pencil":     {"command": "/Applications/Pencil.app/.../mcp-server", "args": ["--app", "desktop"]},
    "bambu-h2d":  {"command": "node", "args": ["/path/bambu/index.js"], "env": {"BAMBU_LAB_MQTT_PASSWORD": "secret"}},
    "xiaohongshu-mcp": {"type": "http", "url": "http://127.0.0.1:18060/mcp"},
    "audible":    {"command": "/path/.venv/bin/python", "args": ["server.py"]}
  },
  "projects": {
    "/Users/xiaorongli": {"mcpServers": {"slack": {"command": "npx", "env": {"SLACK_BOT_TOKEN": "xoxb-LEAK"}}}}
  }
}
EOF
LINEAR_API_KEY=lin_api_dummy \
OUT_1=$(build_user_mcp_fragment "$FIX_1" "flywheel-terminal,flywheel-inbox,gbrain" "audible" "")
KEYS_1=$(echo "$OUT_1" | jq -r 'keys | sort | join(",")')
if [ "$KEYS_1" = "bambu-h2d,linear-api,pencil,xiaohongshu-mcp" ]; then
  pass "happy path inherits 4 servers (audible blacklisted)"
else
  fail "expected 4 keys [bambu-h2d,linear-api,pencil,xiaohongshu-mcp], got [$KEYS_1]"
fi

# Confirm slack is NOT present (we never read .projects[])
if ! echo "$OUT_1" | jq -e '.["slack"]' >/dev/null 2>&1; then
  pass "local-scope slack server not inherited (.projects[] safely ignored)"
else
  fail "slack leaked from .projects[]!"
fi

# Confirm Bearer placeholder preserved literally
ACTUAL_AUTH=$(echo "$OUT_1" | jq -r '."linear-api".headers.Authorization')
if [ "$ACTUAL_AUTH" = 'Bearer ${LINEAR_API_KEY}' ]; then
  pass "Bearer placeholder preserved (Claude expander handles at startup)"
else
  fail "Authorization mangled: [$ACTUAL_AUTH]"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: LINEAR_API_KEY unset → linear-api skipped, others survive
# ════════════════════════════════════════════════════════════════
log_test "Test 2: LINEAR_API_KEY unset → only linear-api skipped"
unset LINEAR_API_KEY
OUT_2=$(build_user_mcp_fragment "$FIX_1" "flywheel-terminal,flywheel-inbox,gbrain" "audible" "")
KEYS_2=$(echo "$OUT_2" | jq -r 'keys | sort | join(",")')
if [ "$KEYS_2" = "bambu-h2d,pencil,xiaohongshu-mcp" ]; then
  pass "linear-api skipped (env gate), other 3 survive"
else
  fail "expected [bambu-h2d,pencil,xiaohongshu-mcp], got [$KEYS_2]"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: per-Lead exclude with whitespace
# ════════════════════════════════════════════════════════════════
log_test "Test 3: per-Lead exclude trims whitespace (Codex r4 nit)"
LINEAR_API_KEY=lin_api_dummy \
OUT_3=$(build_user_mcp_fragment "$FIX_1" "flywheel-terminal,flywheel-inbox,gbrain" "audible" "bambu-h2d, xiaohongshu-mcp ")
KEYS_3=$(echo "$OUT_3" | jq -r 'keys | sort | join(",")')
if [ "$KEYS_3" = "linear-api,pencil" ]; then
  pass "per-Lead exclude with spaces trims correctly"
else
  fail "expected [linear-api,pencil], got [$KEYS_3]"
fi

# ════════════════════════════════════════════════════════════════
# Test 4: reserved-name collision warn + skip user version
# ════════════════════════════════════════════════════════════════
log_test "Test 4: reserved-name collision (user has gbrain)"
FIX_4="${TMP_DIR}/claude-4.json"
fixture "$FIX_4" <<'EOF'
{
  "mcpServers": {
    "gbrain": {"command": "/some/path/imposter-gbrain"},
    "pencil": {"command": "/Applications/Pencil.app/mcp"}
  }
}
EOF
WARN_4=$(build_user_mcp_fragment "$FIX_4" "flywheel-terminal,flywheel-inbox,gbrain" "" "" 2>&1 1>/dev/null || true)
OUT_4=$(build_user_mcp_fragment "$FIX_4" "flywheel-terminal,flywheel-inbox,gbrain" "" "" 2>/dev/null)
KEYS_4=$(echo "$OUT_4" | jq -r 'keys | sort | join(",")')
if [ "$KEYS_4" = "pencil" ]; then
  pass "reserved-name collision: gbrain skipped, pencil survives"
else
  fail "expected [pencil], got [$KEYS_4]"
fi
if echo "$WARN_4" | grep -q "shadowed by Flywheel infra"; then
  pass "collision warning logged"
else
  fail "no collision warning in stderr: [$WARN_4]"
fi

# ════════════════════════════════════════════════════════════════
# Test 4b: reserved-name collision with flywheel-inbox (Codex code-review nit)
# ════════════════════════════════════════════════════════════════
log_test "Test 4b: reserved-name collision (user has flywheel-inbox)"
FIX_4B="${TMP_DIR}/claude-4b.json"
fixture "$FIX_4B" <<'EOF'
{
  "mcpServers": {
    "flywheel-inbox": {"command": "/some/path/imposter-inbox"},
    "linear-api": {"type": "http", "url": "https://x"}
  }
}
EOF
WARN_4B=$(build_user_mcp_fragment "$FIX_4B" "flywheel-terminal,flywheel-inbox,gbrain" "" "" 2>&1 1>/dev/null || true)
OUT_4B=$(build_user_mcp_fragment "$FIX_4B" "flywheel-terminal,flywheel-inbox,gbrain" "" "" 2>/dev/null)
KEYS_4B=$(echo "$OUT_4B" | jq -r 'keys | sort | join(",")')
if [ "$KEYS_4B" = "linear-api" ]; then
  pass "reserved collision (flywheel-inbox): user version skipped, linear-api survives"
else
  fail "expected [linear-api], got [$KEYS_4B]"
fi
if echo "$WARN_4B" | grep -q "User MCP 'flywheel-inbox' shadowed"; then
  pass "flywheel-inbox collision warning logged"
else
  fail "no flywheel-inbox warning: [$WARN_4B]"
fi

# ════════════════════════════════════════════════════════════════
# Test 5: ~/.claude.json missing
# ════════════════════════════════════════════════════════════════
log_test "Test 5: ~/.claude.json missing → empty fragment, no abort"
OUT_5=$(build_user_mcp_fragment "${TMP_DIR}/does-not-exist.json" "flywheel-terminal" "" "" 2>/dev/null)
if [ "$OUT_5" = "{}" ]; then
  pass "missing file → empty fragment {}"
else
  fail "expected {}, got [$OUT_5]"
fi

# ════════════════════════════════════════════════════════════════
# Test 6: malformed JSON
# ════════════════════════════════════════════════════════════════
log_test "Test 6: malformed ~/.claude.json → empty fragment, no abort"
FIX_6="${TMP_DIR}/claude-6.json"
echo "{ broken json " > "$FIX_6"
OUT_6=$(build_user_mcp_fragment "$FIX_6" "flywheel-terminal" "" "" 2>/dev/null)
if [ "$OUT_6" = "{}" ]; then
  pass "malformed file → empty fragment {}"
else
  fail "expected {}, got [$OUT_6]"
fi

# ════════════════════════════════════════════════════════════════
# Test 7: ${VAR:-default} → not skipped when VAR unset
# ════════════════════════════════════════════════════════════════
log_test "Test 7: \${VAR:-default} env placeholder ignored (has default)"
FIX_7="${TMP_DIR}/claude-7.json"
fixture "$FIX_7" <<'EOF'
{"mcpServers":{"with-default":{"command":"node","env":{"X":"${MISSING:-fallback}"}}}}
EOF
unset MISSING
OUT_7=$(build_user_mcp_fragment "$FIX_7" "" "" "" 2>/dev/null)
if echo "$OUT_7" | jq -e '."with-default"' >/dev/null 2>&1; then
  pass "\${VAR:-default} not skipped when VAR unset"
else
  fail "with-default should be inherited, got [$OUT_7]"
fi

# ════════════════════════════════════════════════════════════════
# Test 8: $$VAR literal escape (negative lookbehind in jq scan)
# ════════════════════════════════════════════════════════════════
log_test "Test 8: \$\${VAR} literal escape — not treated as required"
FIX_8="${TMP_DIR}/claude-8.json"
fixture "$FIX_8" <<'EOF'
{"mcpServers":{"escaped":{"command":"node","env":{"X":"$${LITERAL}"}}}}
EOF
unset LITERAL
OUT_8=$(build_user_mcp_fragment "$FIX_8" "" "" "" 2>/dev/null)
if echo "$OUT_8" | jq -e '."escaped"' >/dev/null 2>&1; then
  pass "\$\${VAR} treated as literal, not required env"
else
  fail "escaped should be inherited, got [$OUT_8]"
fi

# ════════════════════════════════════════════════════════════════
# Test 9: bare $VAR (no braces) — not treated as required
# ════════════════════════════════════════════════════════════════
log_test "Test 9: bare \$VAR (no braces) — not treated as Claude placeholder"
FIX_9="${TMP_DIR}/claude-9.json"
fixture "$FIX_9" <<'EOF'
{"mcpServers":{"bare":{"command":"echo","args":["$NOTPLACEHOLDER"]}}}
EOF
unset NOTPLACEHOLDER
OUT_9=$(build_user_mcp_fragment "$FIX_9" "" "" "" 2>/dev/null)
if echo "$OUT_9" | jq -e '."bare"' >/dev/null 2>&1; then
  pass "bare \$VAR not treated as required env"
else
  fail "bare should be inherited, got [$OUT_9]"
fi

# ════════════════════════════════════════════════════════════════
# Test 10: multiple ${...} in same string + JSON string with newline
# ════════════════════════════════════════════════════════════════
log_test "Test 10: multiple \${VAR} + JSON string with newline"
FIX_10="${TMP_DIR}/claude-10.json"
# JSON-encoded newline (\n inside a string) — both vars required
fixture "$FIX_10" <<'EOF'
{"mcpServers":{"multi":{"command":"sh","args":["-c","echo ${A}\n${B}"]}}}
EOF
A=set_a B=set_b \
OUT_10A=$(build_user_mcp_fragment "$FIX_10" "" "" "" 2>/dev/null)
unset A
B=set_b \
OUT_10B=$(build_user_mcp_fragment "$FIX_10" "" "" "" 2>&1 1>/dev/null || true)
if echo "$OUT_10A" | jq -e '."multi"' >/dev/null 2>&1; then
  pass "both vars set + newline → multi inherited"
else
  fail "multi should be inherited when both vars set, got [$OUT_10A]"
fi
if echo "$OUT_10B" | grep -q "requires env \$A"; then
  pass "missing first var detected even with newline + multi-var string"
else
  fail "missing var not detected: [$OUT_10B]"
fi

# ════════════════════════════════════════════════════════════════
# Test 11: write_atomic_mcp_config — output mode 0600 + correct merge
# ════════════════════════════════════════════════════════════════
log_test "Test 11: atomic write produces 0600 file with right-wins merge"
OUT_PATH="${TMP_DIR}/.mcp.json"
# Pre-create a 0644 file to verify the function fixes mode (not just creates fresh).
echo '{}' > "$OUT_PATH"
chmod 644 "$OUT_PATH"
write_atomic_mcp_config "$OUT_PATH" \
  '{"linear-api":{"type":"http","url":"https://x"}}' \
  '{"flywheel-terminal":{"command":"node"}}' \
  '{"flywheel-inbox":{"command":"node"}}' \
  '{"gbrain":{"command":"gbrain"}}'

MODE=$(stat -f '%Lp' "$OUT_PATH" 2>/dev/null || stat -c '%a' "$OUT_PATH" 2>/dev/null)
if [ "$MODE" = "600" ]; then
  pass "atomic write produced mode 0600 (was 0644 before)"
else
  fail "expected mode 600, got [$MODE]"
fi
KEYS_11=$(jq -r '.mcpServers | keys | sort | join(",")' "$OUT_PATH")
if [ "$KEYS_11" = "flywheel-inbox,flywheel-terminal,gbrain,linear-api" ]; then
  pass "atomic write merge: 4 servers present"
else
  fail "expected 4 keys, got [$KEYS_11]"
fi

# Test that infra wins on collision: pass user version of "gbrain" with a different command
write_atomic_mcp_config "$OUT_PATH" \
  '{"gbrain":{"command":"/some/imposter"}}' \
  '{"flywheel-terminal":{"command":"node"}}' \
  '{"flywheel-inbox":{"command":"node"}}' \
  '{"gbrain":{"command":"gbrain","args":["serve"]}}'
WIN_CMD=$(jq -r '.mcpServers.gbrain.command' "$OUT_PATH")
if [ "$WIN_CMD" = "gbrain" ]; then
  pass "infra wins on same-name collision (right-hand wins in jq +)"
else
  fail "expected infra command 'gbrain', got [$WIN_CMD]"
fi

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════
# ════════════════════════════════════════════════════════════════
# Test 12: list_required_envs — extracts ${VAR} placeholders from a final
# .mcp.json so claude-lead.sh can propagate them through tmux env_args.
# (QA-FLY-143 finding: tmux `new-window -e` doesn't inherit launcher env.)
# ════════════════════════════════════════════════════════════════
log_test "Test 12: list_required_envs — find required env from merged .mcp.json"
FIX_12="${TMP_DIR}/merged-mcp.json"
fixture "$FIX_12" <<'EOF'
{
  "mcpServers": {
    "linear-api": {"type": "http", "headers": {"Authorization": "Bearer ${LINEAR_API_KEY}"}},
    "two-vars":   {"command": "node", "env": {"A": "${VAR_A}", "B": "${VAR_B}"}},
    "with-default": {"command": "node", "env": {"X": "${OPTIONAL:-fallback}"}},
    "escaped":    {"command": "node", "env": {"X": "$${LITERAL}"}},
    "bare":       {"command": "node", "args": ["$NOTPLACEHOLDER"]},
    "no-env":     {"command": "node"}
  }
}
EOF
LIST_12=$(list_required_envs "$FIX_12" | tr '\n' ',' | sed 's/,$//')
if [ "$LIST_12" = "LINEAR_API_KEY,VAR_A,VAR_B" ]; then
  pass "list_required_envs returns 3 unique required vars (LINEAR_API_KEY, VAR_A, VAR_B)"
else
  fail "expected 'LINEAR_API_KEY,VAR_A,VAR_B', got '$LIST_12'"
fi

# Edge: file missing → empty + no error
LIST_12B=$(list_required_envs "$TMP_DIR/no-such.json" || echo "<errored>")
if [ -z "$LIST_12B" ]; then
  pass "list_required_envs missing file → empty + return 0 (no abort)"
else
  fail "expected empty, got '$LIST_12B'"
fi

# Edge: file with no mcpServers → empty
FIX_12C="${TMP_DIR}/no-servers.json"
echo '{}' > "$FIX_12C"
LIST_12C=$(list_required_envs "$FIX_12C")
if [ -z "$LIST_12C" ]; then
  pass "list_required_envs with no mcpServers → empty"
else
  fail "expected empty, got '$LIST_12C'"
fi

echo
echo "────────────────────────────────────────"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo -e "Errors:${ERRORS}"
  exit 1
fi
echo "All FLY-143 mcp-inherit tests passed."
exit 0
