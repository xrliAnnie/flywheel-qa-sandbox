#!/bin/bash
# FLY-247 WI-2: verify the fleet carrier fields (`model`, `leadBackend.backendId`)
# survive claude-lead.sh's boot-time manifest rewrite, are never injected from
# nothing, and that the self-write is atomic (temp + validate + rename).
#
# Background: fleet apply writes model/leadBackend into the canonical manifest;
# claude-lead.sh rewrites that manifest on EVERY boot (FLY-143 pattern). Without
# preserve, a plain launchd self-restart between two applies would silently drop
# the fields — and with them the FLYWHEEL_LEAD_MODEL plist env on the next
# `daemon install` (the exact FLY-241 wipe this issue root-cures).
#
# Scenarios:
#   A) existing manifest WITH model+leadBackend → rewrite → both survive
#   B) no existing manifest → fields NOT injected (absent stays absent)
#   C) existing manifest WITHOUT the fields → still absent after rewrite
#   D) regression: mcpExclude/chromeEnabled preserve behavior unchanged
#   E) atomicity: a failing write leaves the original manifest byte-intact
#      and no .tmp residue
#
# This mirrors packages/teamlead/scripts/claude-lead.sh's manifest write block
# (FLY-247 form). Any divergence → false-positive test; keep in sync.
set -uo pipefail

PASSED=0
FAILED=0

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

TMP_DIR="$(mktemp -d -t fly247-preserve-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

log() { :; }

# Mirror of claude-lead.sh's FLY-247 manifest write block.
# Inputs (env): LEAD_ID PROJECT_DIR PROJECT_NAME LEAD_SUBDIR LEAD_WORKSPACE
#   BOT_TOKEN_ENV_NAME FLYWHEEL_LEAD_MCP_EXCLUDE FLYWHEEL_LEAD_CHROME_ENABLED
#   MANIFEST_FILE JQ_BIN (test seam, defaults to jq)
write_manifest() {
  local JQ="${JQ_BIN:-jq}"
  local _existing_mcp_exclude=""
  local _existing_chrome_enabled="false"
  local _existing_model=""
  local _existing_lead_backend=""
  if [ -f "$MANIFEST_FILE" ]; then
    _existing_mcp_exclude=$(jq -r '.mcpExclude // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
    _existing_chrome_enabled=$(jq -r '.chromeEnabled // false' "$MANIFEST_FILE" 2>/dev/null || echo "false")
    _existing_model=$(jq -r '.model // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
    _existing_lead_backend=$(jq -r '.leadBackend.backendId // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
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

  local _manifest_tmp="${MANIFEST_FILE}.tmp.$$"
  "$JQ" -n \
    --arg leadId "$LEAD_ID" \
    --arg projectDir "$PROJECT_DIR" \
    --arg projectName "$PROJECT_NAME" \
    --arg subdir "${LEAD_SUBDIR:-}" \
    --arg workspace "$LEAD_WORKSPACE" \
    --arg botTokenEnv "${BOT_TOKEN_ENV_NAME:-DISCORD_BOT_TOKEN}" \
    --arg pid "$$" \
    --arg mcpExclude "$_final_mcp_exclude" \
    --argjson chromeEnabled "$_final_chrome_enabled" \
    --arg model "$_existing_model" \
    --arg leadBackendId "$_existing_lead_backend" \
    '{
       leadId: $leadId, projectDir: $projectDir, projectName: $projectName,
       subdir: $subdir, workspace: $workspace, botTokenEnv: $botTokenEnv,
       mcpExclude: $mcpExclude, chromeEnabled: $chromeEnabled,
       pid: ($pid | tonumber)
     }
     | (if $model != "" then . + {model: $model} else . end)
     | (if $leadBackendId != "" then . + {leadBackend: {backendId: $leadBackendId}} else . end)' \
    > "$_manifest_tmp" \
    && jq empty "$_manifest_tmp" 2>/dev/null \
    && mv "$_manifest_tmp" "$MANIFEST_FILE" \
    || { rm -f "$_manifest_tmp"; log "WARNING: manifest write failed — keeping previous manifest"; }
}

export LEAD_ID="product-lead"
export PROJECT_DIR="/tmp/geo"
export PROJECT_NAME="geo"
export LEAD_SUBDIR=""
export LEAD_WORKSPACE="/tmp/geo"
export BOT_TOKEN_ENV_NAME="DISCORD_BOT_TOKEN"
unset FLYWHEEL_LEAD_MCP_EXCLUDE 2>/dev/null || true
unset FLYWHEEL_LEAD_CHROME_ENABLED 2>/dev/null || true

# ── A) model + leadBackend survive the rewrite ────────────────────────────
export MANIFEST_FILE="$TMP_DIR/a.json"
jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",
        mcpExclude:"", chromeEnabled:false, pid: 999,
        model:"claude-fable-5", leadBackend:{backendId:"claude-code"}}' > "$MANIFEST_FILE"
write_manifest
if [ "$(jq -r '.model' "$MANIFEST_FILE")" = "claude-fable-5" ] \
  && [ "$(jq -r '.leadBackend.backendId' "$MANIFEST_FILE")" = "claude-code" ] \
  && [ "$(jq -r '.pid' "$MANIFEST_FILE")" = "$$" ]; then
  pass "A: model + leadBackend.backendId survive the boot rewrite (pid updated)"
else
  fail "A: fields dropped: $(cat "$MANIFEST_FILE")"
fi

# ── B) fresh manifest → fields not injected ───────────────────────────────
export MANIFEST_FILE="$TMP_DIR/b.json"
write_manifest
if ! jq -e 'has("model") or has("leadBackend")' "$MANIFEST_FILE" >/dev/null; then
  pass "B: no pre-existing manifest → model/leadBackend NOT injected"
else
  fail "B: fields appeared from nowhere: $(cat "$MANIFEST_FILE")"
fi

# ── C) existing manifest without fields → still absent ────────────────────
export MANIFEST_FILE="$TMP_DIR/c.json"
jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",
        mcpExclude:"", chromeEnabled:false, pid: 999}' > "$MANIFEST_FILE"
write_manifest
if ! jq -e 'has("model") or has("leadBackend")' "$MANIFEST_FILE" >/dev/null; then
  pass "C: pre-existing manifest without fleet fields → still absent"
else
  fail "C: fields injected: $(cat "$MANIFEST_FILE")"
fi

# ── D) regression: mcpExclude / chromeEnabled preserve unchanged ──────────
export MANIFEST_FILE="$TMP_DIR/d.json"
jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",
        mcpExclude:"chrome,pencil", chromeEnabled:true, pid: 999}' > "$MANIFEST_FILE"
write_manifest
if [ "$(jq -r '.mcpExclude' "$MANIFEST_FILE")" = "chrome,pencil" ] \
  && [ "$(jq -r '.chromeEnabled' "$MANIFEST_FILE")" = "true" ]; then
  pass "D: FLY-143 mcpExclude/chromeEnabled preserve behavior unchanged"
else
  fail "D: FLY-143 preserve regressed: $(cat "$MANIFEST_FILE")"
fi

# ── E) atomicity: failing write keeps the original + no temp residue ──────
export MANIFEST_FILE="$TMP_DIR/e.json"
jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",
        mcpExclude:"", chromeEnabled:false, pid: 999, model:"keep-me"}' > "$MANIFEST_FILE"
BEFORE_SHA=$(shasum -a 256 "$MANIFEST_FILE" | awk '{print $1}')
# jq stub that emits garbage and fails — simulates an interrupted/failed write.
JQ_FAIL="$TMP_DIR/jq-fail"
printf '#!/bin/bash\necho "GARBAGE{{{"\nexit 1\n' > "$JQ_FAIL"
chmod +x "$JQ_FAIL"
JQ_BIN="$JQ_FAIL" write_manifest 2>/dev/null
AFTER_SHA=$(shasum -a 256 "$MANIFEST_FILE" | awk '{print $1}')
RESIDUE=$(find "$TMP_DIR" -name "*.tmp.*" | wc -l | tr -d ' ')
if [ "$BEFORE_SHA" = "$AFTER_SHA" ] && [ "$RESIDUE" = "0" ]; then
  pass "E: failed write → original manifest byte-intact + zero temp residue"
else
  fail "E: atomicity broken (sha match: $([ "$BEFORE_SHA" = "$AFTER_SHA" ] && echo yes || echo no), residue: $RESIDUE)"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
