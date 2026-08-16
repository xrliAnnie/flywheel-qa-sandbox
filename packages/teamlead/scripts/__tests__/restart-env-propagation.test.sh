#!/bin/bash
# Verify the legacy restart path passes per-Lead MCP scope and workspace env
# through `env "${lead_env[@]}"` with explicit array elements.
set -euo pipefail

PASSED=0
FAILED=0
ERRORS=""

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  ✗ $1"; log_test "✗ $1"; }

TMP_DIR="$(mktemp -d -t fly143-env-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Mock claude-lead.sh — captures env to a file, exits 0.
MOCK_LEAD="$TMP_DIR/mock-claude-lead.sh"
cat > "$MOCK_LEAD" <<'EOF'
#!/bin/bash
# Capture relevant env vars + argv to dump file specified via $CAPTURE_FILE.
{
  echo "ARGV: $*"
  echo "DISCORD_STATE_DIR=${DISCORD_STATE_DIR:-<unset>}"
  echo "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-<unset>}"
  echo "FLYWHEEL_LEAD_MCP_EXCLUDE=${FLYWHEEL_LEAD_MCP_EXCLUDE:-<unset>}"
	echo "LEAD_WORKSPACE=${LEAD_WORKSPACE:-<unset>}"
} > "$CAPTURE_FILE"
EOF
chmod +x "$MOCK_LEAD"

# Helper that mirrors restart-services.sh:646-668 logic exactly.
# Inputs (all required): mcp_exclude, workspace, lead_id,
#                        project_dir, project_name, bot_token_env, subdir_args (opt),
#                        discord_state_dir
launch() {
  local lead_env=(
    "DISCORD_STATE_DIR=$discord_state_dir"
    "DISCORD_BOT_TOKEN=${!bot_token_env}"
    "FLYWHEEL_LEAD_MCP_EXCLUDE=$mcp_exclude"
    "CAPTURE_FILE=$CAPTURE_FILE"
  )
  if [[ -n "$workspace" && "$workspace" != "null" ]]; then
    lead_env+=("LEAD_WORKSPACE=$workspace")
  fi
  env "${lead_env[@]}" "$MOCK_LEAD" \
    "$lead_id" "$project_dir" "$project_name" $subdir_args \
    --bot-token-env "$bot_token_env"
}

# Common test fixtures
TEST_COS_BOT_TOKEN="test-bot-token-xyz"
export TEST_COS_BOT_TOKEN
discord_state_dir="/tmp/fake-discord"
lead_id="cos-lead"
project_dir="/tmp/fake-project"
project_name="test"
bot_token_env="TEST_COS_BOT_TOKEN"
subdir_args=""

# ════════════════════════════════════════════════════════════════
# Test 1: mcpExclude set + workspace set
# ════════════════════════════════════════════════════════════════
log_test "Test 1: mcpExclude + workspace propagate correctly"
CAPTURE_FILE="$TMP_DIR/capture-1.txt"
mcp_exclude="bambu-h2d,xiaohongshu-mcp"
workspace="/tmp/custom-ws"
launch
if grep -q "FLYWHEEL_LEAD_MCP_EXCLUDE=bambu-h2d,xiaohongshu-mcp" "$CAPTURE_FILE"; then
  pass "FLYWHEEL_LEAD_MCP_EXCLUDE propagated"
else
  fail "FLYWHEEL_LEAD_MCP_EXCLUDE wrong: $(grep EXCLUDE "$CAPTURE_FILE")"
fi
if grep -q "LEAD_WORKSPACE=/tmp/custom-ws" "$CAPTURE_FILE"; then
  pass "LEAD_WORKSPACE propagated"
else
  fail "LEAD_WORKSPACE wrong: $(grep WORKSPACE "$CAPTURE_FILE")"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: empty optional values remain harmless
# ════════════════════════════════════════════════════════════════
log_test "Test 2: empty optional values remain harmless"
CAPTURE_FILE="$TMP_DIR/capture-2.txt"
mcp_exclude=""
workspace=""
launch
if grep -q "FLYWHEEL_LEAD_MCP_EXCLUDE=$" "$CAPTURE_FILE" || grep -q "FLYWHEEL_LEAD_MCP_EXCLUDE=<unset>" "$CAPTURE_FILE"; then
  pass "Empty mcpExclude → empty env var (treated same as unset by claude-lead.sh)"
else
  # The mock prints "FLYWHEEL_LEAD_MCP_EXCLUDE=" when var is empty (default expansion shows empty)
  # That's fine — claude-lead.sh treats empty/unset the same.
  if grep -qE "FLYWHEEL_LEAD_MCP_EXCLUDE=$" "$CAPTURE_FILE"; then
    pass "Empty mcpExclude → empty env var"
  else
    fail "FLYWHEEL_LEAD_MCP_EXCLUDE wrong: $(grep EXCLUDE "$CAPTURE_FILE")"
  fi
fi

# ════════════════════════════════════════════════════════════════
# Test 3: bot token resolution via indirect ref
# ════════════════════════════════════════════════════════════════
log_test "Test 3: bot token resolves via indirect env ref"
if grep -q "DISCORD_BOT_TOKEN=test-bot-token-xyz" "$CAPTURE_FILE"; then
  pass "DISCORD_BOT_TOKEN correctly resolved from named env var"
else
  fail "DISCORD_BOT_TOKEN wrong: $(grep TOKEN "$CAPTURE_FILE")"
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
echo "All FLY-143 restart-env-propagation tests passed."
exit 0
