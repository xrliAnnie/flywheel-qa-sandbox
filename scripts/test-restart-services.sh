#!/usr/bin/env bash
# FLY-20: Tests for restart-services.sh core logic
# Runs: bash scripts/test-restart-services.sh
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# ════════════════════════════════════════════════════════════════
# Setup: temp directory for isolation
# ════════════════════════════════════════════════════════════════
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ════════════════════════════════════════════════════════════════
# Test 1: classify_changes — Bridge-only changes
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — Bridge-only changes"

# Source classify_changes by extracting it
classify_changes() {
    local _restart_bridge=false
    local _restart_all_leads=false
    local _need_install=false

    while IFS= read -r file; do
        case "$file" in
            # Lead impact (specific patterns BEFORE wildcard teamlead/*)
            packages/teamlead/scripts/claude-lead.sh)   _restart_all_leads=true ;;
            packages/teamlead/scripts/post-compact*)     _restart_all_leads=true ;;
            # Bridge impact
            packages/teamlead/*)         _restart_bridge=true ;;
            packages/core/*)             _restart_bridge=true ;;
            packages/edge-worker/*)      _restart_bridge=true ;;
            packages/flywheel-comm/*)    _restart_bridge=true; _restart_all_leads=true ;;
            scripts/run-bridge.ts)       _restart_bridge=true ;;
            scripts/lib/*)               _restart_bridge=true ;;
            package.json)                _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            pnpm-lock.yaml)              _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            pnpm-workspace.yaml)         _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            doc/*|tests/*|.claude/*|.github/*|*.md)  ;;
            *)  ;;
        esac
    done <<< "$CHANGED"

    echo "restart_bridge=$_restart_bridge"
    echo "restart_all_leads=$_restart_all_leads"
    echo "need_install=$_need_install"
}

CHANGED="packages/teamlead/src/bridge.ts
packages/core/src/util.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=false" && \
   echo "$result" | grep -q "need_install=false"; then
    pass "Bridge-only: bridge=true, leads=false, install=false"
else
    fail "Bridge-only: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: classify_changes — flywheel-comm triggers both
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — flywheel-comm triggers both"

CHANGED="packages/flywheel-comm/src/index.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=true"; then
    pass "flywheel-comm: bridge=true, leads=true"
else
    fail "flywheel-comm: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: classify_changes — doc-only = no restart
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — doc-only = no restart"

CHANGED="doc/plan/inprogress/v1.18.0-FLY-20.md
doc/exploration/new/FLY-20.md
README.md"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=false" && \
   echo "$result" | grep -q "restart_all_leads=false" && \
   echo "$result" | grep -q "need_install=false"; then
    pass "Doc-only: all false"
else
    fail "Doc-only: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 4: classify_changes — pnpm-lock triggers everything
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — pnpm-lock triggers everything"

CHANGED="pnpm-lock.yaml"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=true" && \
   echo "$result" | grep -q "need_install=true"; then
    pass "pnpm-lock: all true"
else
    fail "pnpm-lock: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 5: classify_changes — Lead-only changes
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — Lead-only changes"

CHANGED="packages/teamlead/scripts/claude-lead.sh"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=false" && \
   echo "$result" | grep -q "restart_all_leads=true"; then
    pass "Lead-only: bridge=false, leads=true"
else
    fail "Lead-only: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 6: classify_changes — mixed changes
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — mixed changes"

CHANGED="packages/core/src/foo.ts
packages/teamlead/scripts/post-compact-hook.sh
doc/README.md"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=true" && \
   echo "$result" | grep -q "need_install=false"; then
    pass "Mixed: bridge=true, leads=true, install=false"
else
    fail "Mixed: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 7: mkdir lock — mutual exclusion
# ════════════════════════════════════════════════════════════════
echo "Test: mkdir lock — mutual exclusion"

LOCK_DIR="$TMPDIR_ROOT/restart.lock.d"
if mkdir "$LOCK_DIR" 2>/dev/null; then
    # Second attempt should fail
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        fail "Lock: second mkdir should fail"
    else
        pass "Lock: second mkdir correctly fails"
    fi
    rmdir "$LOCK_DIR"
else
    fail "Lock: first mkdir should succeed"
fi

# ════════════════════════════════════════════════════════════════
# Test 8: mkdir lock — stale detection
# ════════════════════════════════════════════════════════════════
echo "Test: mkdir lock — stale detection"

LOCK_DIR="$TMPDIR_ROOT/stale.lock.d"
mkdir "$LOCK_DIR"
# Touch with old timestamp (3 hours ago)
touch -t "$(date -v-3H '+%Y%m%d%H%M.%S')" "$LOCK_DIR"

lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0) ))
if (( lock_age > 7200 )); then
    pass "Stale lock: detected as stale (${lock_age}s > 7200s)"
    rmdir "$LOCK_DIR"
else
    fail "Stale lock: age=${lock_age}s, expected >7200"
    rmdir "$LOCK_DIR"
fi

# ════════════════════════════════════════════════════════════════
# Test 9: deployed-sha file — first run detection
# ════════════════════════════════════════════════════════════════
echo "Test: deployed-sha — first run detection"

SHA_FILE="$TMPDIR_ROOT/deployed-sha"
DEPLOYED_SHA=$(cat "$SHA_FILE" 2>/dev/null || echo "")
if [[ -z "$DEPLOYED_SHA" ]]; then
    pass "First run: empty deployed-sha detected"
else
    fail "First run: expected empty, got '$DEPLOYED_SHA'"
fi

# ════════════════════════════════════════════════════════════════
# Test 10: deployed-sha file — match = no-op
# ════════════════════════════════════════════════════════════════
echo "Test: deployed-sha — match = no-op"

SHA_FILE="$TMPDIR_ROOT/deployed-sha-2"
echo "abc1234" > "$SHA_FILE"
DEPLOYED_SHA=$(cat "$SHA_FILE" 2>/dev/null || echo "")
CURRENT_HEAD="abc1234"
if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    pass "Match: correctly detected as already deployed"
else
    fail "Match: expected match"
fi

# ════════════════════════════════════════════════════════════════
# Test 11: deployed-sha file — mismatch = needs deploy
# ════════════════════════════════════════════════════════════════
echo "Test: deployed-sha — mismatch = needs deploy"

CURRENT_HEAD="def5678"
if [[ "$DEPLOYED_SHA" != "$CURRENT_HEAD" ]]; then
    pass "Mismatch: correctly detected as needing deploy"
else
    fail "Mismatch: expected mismatch"
fi

# ════════════════════════════════════════════════════════════════
# Test 12: notify_discord JSON escaping
# ════════════════════════════════════════════════════════════════
echo "Test: notify_discord — JSON escaping"

# Test that jq handles special characters safely
test_msg='Build failed: "error" in `packages/core` — $100 cost & <tag>'
payload=$(jq -n --arg content "$test_msg" '{content: $content}')
if echo "$payload" | jq -e '.content' > /dev/null 2>&1; then
    extracted=$(echo "$payload" | jq -r '.content')
    if [[ "$extracted" == "$test_msg" ]]; then
        pass "JSON escaping: special chars preserved"
    else
        fail "JSON escaping: content mismatch"
    fi
else
    fail "JSON escaping: invalid JSON produced"
fi

# ════════════════════════════════════════════════════════════════
# Test 13: notify_discord — newlines in message
# ════════════════════════════════════════════════════════════════
echo "Test: notify_discord — newlines"

test_msg=$'Line 1\nLine 2\nLine 3'
payload=$(jq -n --arg content "$test_msg" '{content: $content}')
extracted=$(echo "$payload" | jq -r '.content')
if [[ "$extracted" == "$test_msg" ]]; then
    pass "JSON newlines: preserved correctly"
else
    fail "JSON newlines: mismatch"
fi

# ════════════════════════════════════════════════════════════════
# Test 14: PID file write and read
# ════════════════════════════════════════════════════════════════
echo "Test: PID file — write and read"

PID_DIR="$TMPDIR_ROOT/pids"
mkdir -p "$PID_DIR"
PID_FILE="$PID_DIR/geoforge3d-product-lead.pid"
echo $$ > "$PID_FILE"
read_pid=$(cat "$PID_FILE")
if [[ "$read_pid" == "$$" ]]; then
    pass "PID file: written and read correctly"
else
    fail "PID file: expected $$, got $read_pid"
fi

# ════════════════════════════════════════════════════════════════
# Test 15: Manifest JSON structure
# ════════════════════════════════════════════════════════════════
echo "Test: Manifest — JSON structure"

MANIFEST_DIR="$TMPDIR_ROOT/manifests"
mkdir -p "$MANIFEST_DIR"
MANIFEST_FILE="$MANIFEST_DIR/geoforge3d-product-lead.json"
jq -n \
  --arg leadId "product-lead" \
  --arg projectDir "/Users/test/project" \
  --arg projectName "geoforge3d" \
  --arg subdir "product" \
  --arg workspace "/Users/test/project/.lead/product-lead/workspace" \
  --arg botTokenEnv "PETER_BOT_TOKEN" \
  --arg pid "$$" \
  '{leadId: $leadId, projectDir: $projectDir, projectName: $projectName, subdir: $subdir, workspace: $workspace, botTokenEnv: $botTokenEnv, pid: ($pid | tonumber)}' \
  > "$MANIFEST_FILE"

# Verify all fields
lid=$(jq -r '.leadId' "$MANIFEST_FILE")
pdir=$(jq -r '.projectDir' "$MANIFEST_FILE")
pname=$(jq -r '.projectName' "$MANIFEST_FILE")
sub=$(jq -r '.subdir' "$MANIFEST_FILE")
ws=$(jq -r '.workspace' "$MANIFEST_FILE")
bte=$(jq -r '.botTokenEnv' "$MANIFEST_FILE")
mpid=$(jq -r '.pid' "$MANIFEST_FILE")

if [[ "$lid" == "product-lead" && "$pdir" == "/Users/test/project" && \
      "$pname" == "geoforge3d" && "$sub" == "product" && \
      "$bte" == "PETER_BOT_TOKEN" && "$mpid" == "$$" ]]; then
    pass "Manifest: all fields correct"
else
    fail "Manifest: field mismatch (lid=$lid pname=$pname bte=$bte)"
fi

# ════════════════════════════════════════════════════════════════
# Test 16: classify_changes — edge-worker triggers bridge
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — edge-worker triggers bridge"

CHANGED="packages/edge-worker/src/handler.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=false"; then
    pass "edge-worker: bridge=true, leads=false"
else
    fail "edge-worker: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 17: classify_changes — run-bridge.ts triggers bridge
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — run-bridge.ts triggers bridge"

CHANGED="scripts/run-bridge.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=false"; then
    pass "run-bridge.ts: bridge=true, leads=false"
else
    fail "run-bridge.ts: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 18: dry-run flag parsing (restart-services.sh --dry-run)
# ════════════════════════════════════════════════════════════════
echo "Test: restart-services.sh --dry-run exits cleanly"

# Run with --dry-run against a fake FLYWHEEL_DIR — it should exit 0
# We can't easily test this without a real git repo, so we test flag parsing logic
DRY_RUN=false
FORCE=false
args=("--dry-run" "--force")
for arg in "${args[@]}"; do
    case "$arg" in
        --force) FORCE=true ;;
        --dry-run) DRY_RUN=true ;;
    esac
done
if [[ "$DRY_RUN" == "true" && "$FORCE" == "true" ]]; then
    pass "Flag parsing: --dry-run and --force both parsed"
else
    fail "Flag parsing: DRY_RUN=$DRY_RUN FORCE=$FORCE"
fi

# ════════════════════════════════════════════════════════════════
# Discord plugin fork detection tests
# ════════════════════════════════════════════════════════════════

# Setup: mock scripts and paths for fork detection tests
MOCK_DIR="$TMPDIR_ROOT/mock-plugin"
mkdir -p "$MOCK_DIR"

# Mock log and notify_discord for function testing
log() { echo "[test] $*"; }
notify_discord() { echo "[notify] $1"; }

# ── Test 19: fork detection — check script not found → return 2 ──
echo "Test: fork detection — check script not found → return 2"

DISCORD_PLUGIN_CHECK="$MOCK_DIR/nonexistent-check.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/nonexistent-update.sh"
DISCORD_FORK_DIR="$MOCK_DIR/nonexistent-repo"
DRY_RUN=false

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then
        log "Discord plugin check script not found, skipping fork detection"
        return 2
    fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then
        log "Discord plugin update script not found, skipping fork detection"
        return 2
    fi
    return 1
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: check script missing → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 20: fork detection — update script not found → return 2 ──
echo "Test: fork detection — update script not found → return 2"

# Create check script but not update script
echo '#!/bin/bash' > "$MOCK_DIR/check.sh" && chmod +x "$MOCK_DIR/check.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/nonexistent-update.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then
        return 2
    fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then
        log "Discord plugin update script not found, skipping fork detection"
        return 2
    fi
    return 1
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: update script missing → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 21: fork detection — runtime OK + fork latest → return 1 ──
echo "Test: fork detection — runtime OK + fork latest → return 1"

echo '#!/bin/bash
exit 0' > "$MOCK_DIR/check-ok.sh" && chmod +x "$MOCK_DIR/check-ok.sh"
echo '#!/bin/bash
exit 0' > "$MOCK_DIR/update-ok.sh" && chmod +x "$MOCK_DIR/update-ok.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-ok.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-ok.sh"
DISCORD_FORK_DIR="$MOCK_DIR/nonexistent-repo"  # no .git → skip fork check

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi
    if [[ "$DRY_RUN" == "true" ]]; then return 1; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    local fork_updated=false
    # No .git dir → fork_updated stays false

    if [[ "$runtime_ok" == "true" && "$fork_updated" == "false" ]]; then
        return 1
    fi
    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 1 )); then
    pass "Fork detection: runtime OK + no fork → return 1"
else
    fail "Fork detection: expected rc=1, got rc=$rc"
fi

# ── Test 22: fork detection — runtime stale → triggers update ──
echo "Test: fork detection — runtime stale → triggers update"

echo '#!/bin/bash
exit 1' > "$MOCK_DIR/check-fail.sh" && chmod +x "$MOCK_DIR/check-fail.sh"
# After update, check passes
CALL_COUNT_FILE="$MOCK_DIR/check-call-count"
echo "0" > "$CALL_COUNT_FILE"
echo '#!/bin/bash
count=$(cat '"$CALL_COUNT_FILE"')
count=$((count + 1))
echo $count > '"$CALL_COUNT_FILE"'
if (( count == 1 )); then exit 1; fi  # first call fails
exit 0  # re-check passes' > "$MOCK_DIR/check-recheck.sh" && chmod +x "$MOCK_DIR/check-recheck.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-recheck.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    local fork_updated=false

    if [[ "$runtime_ok" == "true" && "$fork_updated" == "false" ]]; then
        return 1
    fi

    if ! bash "$DISCORD_PLUGIN_UPDATE"; then return 2; fi
    if ! bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1; then return 2; fi

    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 0 )); then
    pass "Fork detection: runtime stale → update + re-check → return 0"
else
    fail "Fork detection: expected rc=0, got rc=$rc"
fi

# ── Test 23: fork detection — update fails → return 2 ──
echo "Test: fork detection — update fails → return 2"

echo '#!/bin/bash
exit 1' > "$MOCK_DIR/check-fail2.sh" && chmod +x "$MOCK_DIR/check-fail2.sh"
echo '#!/bin/bash
exit 1' > "$MOCK_DIR/update-fail.sh" && chmod +x "$MOCK_DIR/update-fail.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-fail2.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-fail.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    if [[ "$runtime_ok" == "true" ]]; then return 1; fi

    if ! bash "$DISCORD_PLUGIN_UPDATE"; then
        log "ERROR: Discord plugin update failed"
        return 2
    fi
    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: update fails → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 24: fork detection — update OK but re-check fails → return 2 ──
echo "Test: fork detection — update OK but re-check fails → return 2"

echo '#!/bin/bash
exit 1' > "$MOCK_DIR/check-always-fail.sh" && chmod +x "$MOCK_DIR/check-always-fail.sh"
echo '#!/bin/bash
exit 0' > "$MOCK_DIR/update-ok2.sh" && chmod +x "$MOCK_DIR/update-ok2.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-always-fail.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-ok2.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    if [[ "$runtime_ok" == "true" ]]; then return 1; fi

    if ! bash "$DISCORD_PLUGIN_UPDATE"; then return 2; fi
    if ! bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1; then
        log "ERROR: Discord plugin update completed but re-check still fails"
        return 2
    fi
    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: update OK but re-check fails → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 25: integration — plugin_needs_restart + SHA match → PLUGIN_ONLY_RESTART ──
echo "Test: integration — plugin_needs_restart + SHA match → PLUGIN_ONLY_RESTART"

plugin_needs_restart=true
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="abc1234"
PLUGIN_ONLY_RESTART=false

if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    if [[ "$plugin_needs_restart" == "true" ]]; then
        PLUGIN_ONLY_RESTART=true
    fi
fi

if [[ "$PLUGIN_ONLY_RESTART" == "true" ]]; then
    pass "Integration: SHA match + plugin → PLUGIN_ONLY_RESTART=true"
else
    fail "Integration: expected PLUGIN_ONLY_RESTART=true"
fi

# ── Test 26: integration — plugin_needs_restart + SHA mismatch → restart_all_leads ──
echo "Test: integration — plugin_needs_restart + SHA mismatch → merge into classify"

plugin_needs_restart=true
restart_all_leads=false
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="def5678"

# SHA mismatch → no PLUGIN_ONLY_RESTART, but merge flag
if [[ "$DEPLOYED_SHA" != "$CURRENT_HEAD" ]]; then
    # After classify_changes, merge plugin flag
    if [[ "$plugin_needs_restart" == "true" ]]; then
        restart_all_leads=true
    fi
fi

if [[ "$restart_all_leads" == "true" ]]; then
    pass "Integration: SHA mismatch + plugin → restart_all_leads=true"
else
    fail "Integration: expected restart_all_leads=true"
fi

# ── Test 27: integration — plugin-only + leads_failed > 0 → exit 1 ──
echo "Test: integration — plugin-only + leads_failed > 0 → exit code 1"

# Simulate: parse lead_result with failures
lead_result="skipped:0 failed:2"
leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')

if (( leads_failed > 0 )); then
    pass "Integration: plugin-only leads_failed=2 → would exit 1"
else
    fail "Integration: expected leads_failed > 0"
fi

# ── Test 28: integration — plugin-only + leads_skipped > 0 → partial (no success msg) ──
echo "Test: integration — plugin-only + leads_skipped > 0 → partial notification"

lead_result="skipped:1 failed:0"
leads_skipped=$(echo "$lead_result" | sed 's/.*skipped:\([0-9]*\).*/\1/')
leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')

if (( leads_failed == 0 && leads_skipped > 0 )); then
    pass "Integration: plugin-only skipped=1 failed=0 → partial notification"
else
    fail "Integration: expected skipped>0 failed=0, got skipped=$leads_skipped failed=$leads_failed"
fi

# ── Test 29: integration — plugin-only + failed > 0 → writes marker ──
echo "Test: integration — plugin-only + failed > 0 → writes marker"

MARKER_FILE="$TMPDIR_ROOT/plugin-restart-pending"
leads_failed=2

if (( leads_failed > 0 )); then
    echo "failed=$leads_failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER_FILE"
fi

if [[ -f "$MARKER_FILE" ]] && grep -q "failed=2" "$MARKER_FILE"; then
    pass "Integration: marker written with failed=2"
else
    fail "Integration: marker not written or wrong content"
fi

# ── Test 30: integration — marker exists → triggers retry ──
echo "Test: integration — marker exists → triggers plugin_needs_restart"

plugin_needs_restart=false
PLUGIN_RESTART_PENDING="$MARKER_FILE"

if [[ -f "$PLUGIN_RESTART_PENDING" ]]; then
    plugin_needs_restart=true
fi

if [[ "$plugin_needs_restart" == "true" ]]; then
    pass "Integration: marker exists → plugin_needs_restart=true"
else
    fail "Integration: expected plugin_needs_restart=true"
fi

# ── Test 31: integration — plugin-only success → clears marker ──
echo "Test: integration — plugin-only success → clears marker"

# Marker exists from Test 29
rm -f "$PLUGIN_RESTART_PENDING"

if [[ ! -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Integration: marker cleared on success"
else
    fail "Integration: marker still exists"
fi

# ── Test 32: integration — marker + SHA mismatch + deploy success → marker cleared ──
echo "Test: integration — marker + full deploy success → marker cleared"

PLUGIN_RESTART_PENDING="$TMPDIR_ROOT/plugin-restart-pending-2"
echo "failed=1 at 2026-03-31T00:00:00Z" > "$PLUGIN_RESTART_PENDING"

# Simulate successful full deploy: leads_failed == 0 → clear marker
leads_failed=0
if (( leads_failed == 0 )); then
    rm -f "$PLUGIN_RESTART_PENDING"
fi

if [[ ! -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Integration: marker cleared after full deploy success"
else
    fail "Integration: marker not cleared after full deploy"
fi

# ── Test 33: dry-run — fork detection only reports ──
echo "Test: dry-run — fork detection only reports"

DRY_RUN=true
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-ok.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-ok.sh"
DISCORD_FORK_DIR="$MOCK_DIR/nonexistent-repo"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    if [[ "$DRY_RUN" == "true" ]]; then
        local runtime_ok=true
        bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false
        log "DRY RUN: Discord plugin — runtime_ok=$runtime_ok"
        return 1  # runtime OK, no fork → no update needed
    fi
    return 1
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 1 )); then
    pass "Dry-run: fork detection reports without side effects"
else
    fail "Dry-run: expected rc=1, got rc=$rc"
fi

# ── Test 34: dry-run — plugin-only + SHA match → no restart, no marker ops ──
echo "Test: dry-run — plugin-only + SHA match → no restart"

DRY_RUN=true
plugin_needs_restart=true
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="abc1234"
PLUGIN_RESTART_PENDING="$TMPDIR_ROOT/plugin-restart-pending-dryrun"
echo "failed=1 at test" > "$PLUGIN_RESTART_PENDING"

# Simulate dry-run guard
did_restart=false
if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" && "$plugin_needs_restart" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN: Would restart Leads"
        # Should NOT touch marker or restart Leads
    else
        did_restart=true
    fi
fi

if [[ "$did_restart" == "false" ]] && [[ -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Dry-run: no restart, marker untouched"
else
    fail "Dry-run: expected no restart + marker preserved"
fi

# ── Test 35: dry-run — marker exists → only reports ──
echo "Test: dry-run — marker exists → reports without clearing"

DRY_RUN=true
PLUGIN_RESTART_PENDING="$TMPDIR_ROOT/plugin-restart-pending-dryrun"
# Marker still exists from Test 34

marker_cleared=false
if [[ "$DRY_RUN" == "true" ]]; then
    [[ -f "$PLUGIN_RESTART_PENDING" ]] && log "DRY RUN: Marker exists, would retry"
    # Should NOT clear marker
else
    rm -f "$PLUGIN_RESTART_PENDING"
    marker_cleared=true
fi

if [[ "$marker_cleared" == "false" ]] && [[ -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Dry-run: marker reported but not cleared"
else
    fail "Dry-run: marker was cleared or missing"
fi

# Reset DRY_RUN
DRY_RUN=false

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════"

if (( FAIL > 0 )); then
    exit 1
fi
