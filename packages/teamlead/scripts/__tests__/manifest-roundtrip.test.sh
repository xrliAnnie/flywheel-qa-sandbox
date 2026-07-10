#!/bin/bash
# FLY-143: verify the per-Lead MCP scope fields (`mcpExclude`, `chromeEnabled`)
# survive a manifest rewrite cycle.
#
# Background (Codex code-review r1, must-fix #1): pre-fix, claude-lead.sh
# wrote the manifest with only the legacy fields, which silently widened
# every Lead's MCP scope on the next launchd restart. The fix preserves
# manifest values when the env vars are not explicitly set, so the launchd
# wrapper → claude-lead.sh → manifest-rewrite cycle is idempotent.
#
# This test isolates the fragment of `claude-lead.sh` that does the rewrite
# and exercises three scenarios:
#   A) Pre-existing manifest with mcpExclude + chromeEnabled, env unset → preserved
#   B) Pre-existing manifest, env set with new values → env wins
#   C) No pre-existing manifest, env set → env values written
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

TMP_DIR="$(mktemp -d -t fly143-manifest-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Helper: extracted from claude-lead.sh:312-345 — the manifest write block.
# Inputs (env): LEAD_ID, PROJECT_DIR, PROJECT_NAME, LEAD_SUBDIR, LEAD_WORKSPACE,
#               BOT_TOKEN_ENV_NAME, FLYWHEEL_LEAD_MCP_EXCLUDE, FLYWHEEL_LEAD_CHROME_ENABLED
#               MANIFEST_FILE
# Mirror exactly the production code (any divergence → false-positive test).
write_manifest() {
  local _existing_mcp_exclude=""
  local _existing_chrome_enabled="false"
  if [ -f "$MANIFEST_FILE" ]; then
    _existing_mcp_exclude=$(jq -r '.mcpExclude // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
    _existing_chrome_enabled=$(jq -r '.chromeEnabled // false' "$MANIFEST_FILE" 2>/dev/null || echo "false")
  fi
  local _final_mcp_exclude="${FLYWHEEL_LEAD_MCP_EXCLUDE-$_existing_mcp_exclude}"
  local _final_chrome_enabled
  if [ "${FLYWHEEL_LEAD_CHROME_ENABLED:-}" = "true" ]; then
    _final_chrome_enabled=true
  elif [ "${FLYWHEEL_LEAD_CHROME_ENABLED:-}" = "false" ]; then
    _final_chrome_enabled=false
  else
    _final_chrome_enabled="$_existing_chrome_enabled"
  fi
  jq -n \
    --arg leadId "$LEAD_ID" \
    --arg projectDir "$PROJECT_DIR" \
    --arg projectName "$PROJECT_NAME" \
    --arg subdir "${LEAD_SUBDIR:-}" \
    --arg workspace "$LEAD_WORKSPACE" \
    --arg botTokenEnv "${BOT_TOKEN_ENV_NAME:-DISCORD_BOT_TOKEN}" \
    --arg pid "$$" \
    --arg mcpExclude "$_final_mcp_exclude" \
    --argjson chromeEnabled "$_final_chrome_enabled" \
    '{
       leadId: $leadId, projectDir: $projectDir, projectName: $projectName,
       subdir: $subdir, workspace: $workspace, botTokenEnv: $botTokenEnv,
       mcpExclude: $mcpExclude, chromeEnabled: $chromeEnabled,
       pid: ($pid | tonumber)
     }' \
    > "$MANIFEST_FILE"
}

LEAD_ID="cos-lead"
PROJECT_DIR="/tmp/fake-project"
PROJECT_NAME="test"
LEAD_SUBDIR="cos"
LEAD_WORKSPACE="/tmp/fake-ws"
BOT_TOKEN_ENV_NAME="TEST_COS_BOT_TOKEN"

# ════════════════════════════════════════════════════════════════
# Scenario A: pre-existing manifest with fields, env unset → preserved
# ════════════════════════════════════════════════════════════════
log_test "Scenario A: env unset preserves existing manifest values"
MANIFEST_FILE="$TMP_DIR/manifest-A.json"
cat > "$MANIFEST_FILE" <<'EOF'
{
  "leadId": "cos-lead",
  "projectDir": "/tmp/fake-project",
  "projectName": "test",
  "subdir": "cos",
  "workspace": "/tmp/fake-ws",
  "botTokenEnv": "TEST_COS_BOT_TOKEN",
  "mcpExclude": "bambu-h2d,xiaohongshu-mcp,pencil",
  "chromeEnabled": true,
  "pid": 99999
}
EOF
unset FLYWHEEL_LEAD_MCP_EXCLUDE
unset FLYWHEEL_LEAD_CHROME_ENABLED
write_manifest
EXC_A=$(jq -r '.mcpExclude' "$MANIFEST_FILE")
CHR_A=$(jq -r '.chromeEnabled' "$MANIFEST_FILE")
if [ "$EXC_A" = "bambu-h2d,xiaohongshu-mcp,pencil" ]; then
  pass "mcpExclude preserved across rewrite (env unset)"
else
  fail "mcpExclude lost: expected [bambu-h2d,xiaohongshu-mcp,pencil], got [$EXC_A]"
fi
if [ "$CHR_A" = "true" ]; then
  pass "chromeEnabled preserved across rewrite (env unset)"
else
  fail "chromeEnabled lost: expected true, got [$CHR_A]"
fi

# ════════════════════════════════════════════════════════════════
# Scenario B: env set with new values → env wins (operator override)
# ════════════════════════════════════════════════════════════════
log_test "Scenario B: env values override existing manifest"
MANIFEST_FILE="$TMP_DIR/manifest-B.json"
cat > "$MANIFEST_FILE" <<'EOF'
{"leadId":"cos-lead","mcpExclude":"old-value","chromeEnabled":false,"pid":1}
EOF
FLYWHEEL_LEAD_MCP_EXCLUDE="bambu-h2d" \
  FLYWHEEL_LEAD_CHROME_ENABLED=true \
  write_manifest
EXC_B=$(jq -r '.mcpExclude' "$MANIFEST_FILE")
CHR_B=$(jq -r '.chromeEnabled' "$MANIFEST_FILE")
if [ "$EXC_B" = "bambu-h2d" ]; then
  pass "mcpExclude env override wins"
else
  fail "expected mcpExclude=bambu-h2d, got [$EXC_B]"
fi
if [ "$CHR_B" = "true" ]; then
  pass "chromeEnabled env override wins"
else
  fail "expected chromeEnabled=true, got [$CHR_B]"
fi

# ════════════════════════════════════════════════════════════════
# Scenario C: no pre-existing manifest, env set → env values written
# ════════════════════════════════════════════════════════════════
log_test "Scenario C: env writes values into fresh manifest"
MANIFEST_FILE="$TMP_DIR/manifest-C.json"
[ -f "$MANIFEST_FILE" ] && rm -f "$MANIFEST_FILE"
FLYWHEEL_LEAD_MCP_EXCLUDE="audible,bambu-h2d" \
  FLYWHEEL_LEAD_CHROME_ENABLED=true \
  write_manifest
EXC_C=$(jq -r '.mcpExclude' "$MANIFEST_FILE")
CHR_C=$(jq -r '.chromeEnabled' "$MANIFEST_FILE")
if [ "$EXC_C" = "audible,bambu-h2d" ]; then
  pass "fresh manifest with env values written"
else
  fail "fresh manifest mcpExclude wrong: [$EXC_C]"
fi
if [ "$CHR_C" = "true" ]; then
  pass "fresh manifest chromeEnabled written"
else
  fail "fresh manifest chromeEnabled wrong: [$CHR_C]"
fi

# ════════════════════════════════════════════════════════════════
# Scenario D: no manifest, no env → defaults to empty/false (legacy compat)
# ════════════════════════════════════════════════════════════════
log_test "Scenario D: legacy launch with no env, no prior manifest → defaults"
MANIFEST_FILE="$TMP_DIR/manifest-D.json"
unset FLYWHEEL_LEAD_MCP_EXCLUDE
unset FLYWHEEL_LEAD_CHROME_ENABLED
write_manifest
EXC_D=$(jq -r '.mcpExclude' "$MANIFEST_FILE")
CHR_D=$(jq -r '.chromeEnabled' "$MANIFEST_FILE")
if [ "$EXC_D" = "" ]; then
  pass "fresh launch defaults mcpExclude=\"\""
else
  fail "expected mcpExclude=\"\", got [$EXC_D]"
fi
if [ "$CHR_D" = "false" ]; then
  pass "fresh launch defaults chromeEnabled=false"
else
  fail "expected chromeEnabled=false, got [$CHR_D]"
fi

echo
echo "────────────────────────────────────────"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo -e "Errors:${ERRORS}"
  exit 1
fi
echo "All FLY-143 manifest-roundtrip tests passed."
exit 0
