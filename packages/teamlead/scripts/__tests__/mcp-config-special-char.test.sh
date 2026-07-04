#!/bin/bash
# FLY-102 Round 3 Step 6: verify `.mcp.json` generation survives tokens
# containing JSON-special characters (", \, newline). Pre-FLY-102 the
# Lead script used bash string concatenation, which produced invalid JSON
# when TEAMLEAD_API_TOKEN contained any of these characters. The jq-based
# pipeline in claude-lead.sh (FLY-102) must escape them correctly.
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

TMP_DIR="$(mktemp -d -t fly102-mcp-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ════════════════════════════════════════════════════════════════
# Helper: run the same jq pipeline claude-lead.sh uses to build
# the terminal server fragment + merge into .mcp.json.
# Inputs: $1 = token value (may contain ", \, newlines)
# Output: path to generated .mcp.json
# ════════════════════════════════════════════════════════════════

build_mcp_config() {
  local token="$1"
  local out="$TMP_DIR/mcp-$$-$RANDOM.json"

  local terminal_server inbox_server gbrain_server
  terminal_server=$(jq -n \
    --arg bin "/fake/path/terminal-mcp/index.js" \
    --arg projectName "flywheel" \
    --arg leadId "lead-a" \
    --arg bridgeUrl "http://127.0.0.1:3456" \
    --arg apiToken "$token" \
    '{
      "flywheel-terminal": {
        command: "node",
        args: [$bin],
        env: {
          FLYWHEEL_PROJECT_NAME: $projectName,
          FLYWHEEL_LEAD_ID: $leadId,
          BRIDGE_URL: $bridgeUrl,
          TEAMLEAD_API_TOKEN: $apiToken
        }
      }
    }')
  inbox_server='{}'
  gbrain_server='{}'

  jq -n \
    --argjson terminal "$terminal_server" \
    --argjson inbox "$inbox_server" \
    --argjson gbrain "$gbrain_server" \
    '{mcpServers: ($terminal + $inbox + $gbrain)}' \
    > "$out"

  echo "$out"
}

# ════════════════════════════════════════════════════════════════
# Test 1: token with embedded double-quote
# ════════════════════════════════════════════════════════════════
log_test "Test 1: token with embedded double-quote"
TOKEN_1='tok"en-with-quote'
OUT_1=$(build_mcp_config "$TOKEN_1")

if jq empty "$OUT_1" >/dev/null 2>&1; then
  pass "jq empty: .mcp.json is valid JSON"
else
  fail "jq empty rejected the generated .mcp.json"
fi

ROUND_TRIP_1=$(jq -r '.mcpServers["flywheel-terminal"].env.TEAMLEAD_API_TOKEN' "$OUT_1")
if [ "$ROUND_TRIP_1" = "$TOKEN_1" ]; then
  pass "double-quote round-trips exactly"
else
  fail "double-quote mangled: expected=[$TOKEN_1] got=[$ROUND_TRIP_1]"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: token with backslash
# ════════════════════════════════════════════════════════════════
log_test "Test 2: token with backslash"
TOKEN_2='tok\en-with-backslash'
OUT_2=$(build_mcp_config "$TOKEN_2")

if jq empty "$OUT_2" >/dev/null 2>&1; then
  pass "jq empty: backslash .mcp.json is valid JSON"
else
  fail "jq empty rejected the backslash .mcp.json"
fi

ROUND_TRIP_2=$(jq -r '.mcpServers["flywheel-terminal"].env.TEAMLEAD_API_TOKEN' "$OUT_2")
if [ "$ROUND_TRIP_2" = "$TOKEN_2" ]; then
  pass "backslash round-trips exactly"
else
  fail "backslash mangled: expected=[$TOKEN_2] got=[$ROUND_TRIP_2]"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: token with newline
# ════════════════════════════════════════════════════════════════
log_test "Test 3: token with newline"
TOKEN_3=$'line1\nline2'
OUT_3=$(build_mcp_config "$TOKEN_3")

if jq empty "$OUT_3" >/dev/null 2>&1; then
  pass "jq empty: newline .mcp.json is valid JSON"
else
  fail "jq empty rejected the newline .mcp.json"
fi

ROUND_TRIP_3=$(jq -r '.mcpServers["flywheel-terminal"].env.TEAMLEAD_API_TOKEN' "$OUT_3")
if [ "$ROUND_TRIP_3" = "$TOKEN_3" ]; then
  pass "newline round-trips exactly"
else
  fail "newline mangled: expected=[${TOKEN_3@Q}] got=[${ROUND_TRIP_3@Q}]"
fi

# ════════════════════════════════════════════════════════════════
# Test 4: token with ALL special chars combined
# ════════════════════════════════════════════════════════════════
log_test "Test 4: token with \", \\, and newline combined"
TOKEN_4=$'evil"token\\with\nall-three'
OUT_4=$(build_mcp_config "$TOKEN_4")

if jq empty "$OUT_4" >/dev/null 2>&1; then
  pass "jq empty: combined .mcp.json is valid JSON"
else
  fail "jq empty rejected the combined .mcp.json"
fi

ROUND_TRIP_4=$(jq -r '.mcpServers["flywheel-terminal"].env.TEAMLEAD_API_TOKEN' "$OUT_4")
if [ "$ROUND_TRIP_4" = "$TOKEN_4" ]; then
  pass "combined special chars round-trip exactly"
else
  fail "combined mangled: expected=[${TOKEN_4@Q}] got=[${ROUND_TRIP_4@Q}]"
fi

# ════════════════════════════════════════════════════════════════
# Test 5: structural sanity — mcpServers contains flywheel-terminal key
# ════════════════════════════════════════════════════════════════
log_test "Test 5: structural sanity"
HAS_KEY=$(jq -r '.mcpServers | has("flywheel-terminal")' "$OUT_4")
if [ "$HAS_KEY" = "true" ]; then
  pass "flywheel-terminal key present"
else
  fail "flywheel-terminal key missing"
fi

CMD=$(jq -r '.mcpServers["flywheel-terminal"].command' "$OUT_4")
if [ "$CMD" = "node" ]; then
  pass "command is 'node'"
else
  fail "command wrong: got=[$CMD]"
fi

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════
echo
echo "────────────────────────────────────────"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo -e "Errors:${ERRORS}"
  exit 1
fi
echo "All MCP config special-char tests passed."
exit 0
