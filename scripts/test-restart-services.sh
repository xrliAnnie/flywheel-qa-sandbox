#!/usr/bin/env bash
# FLY-20: Tests for restart-services.sh core logic
# Runs: bash scripts/test-restart-services.sh
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

file_mtime_epoch() {
    local path="$1" mtime
    if mtime=$(stat -f %m "$path" 2>/dev/null) && [[ "$mtime" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$mtime"
        return 0
    fi
    if mtime=$(stat -c %Y "$path" 2>/dev/null) && [[ "$mtime" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$mtime"
        return 0
    fi
    return 1
}

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

CHANGED="doc/engineer/plan/inprogress/v1.18.0-FLY-20.md
doc/engineer/exploration/new/FLY-20.md
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
python3 - "$LOCK_DIR" <<'PY'
import os
import sys
import time

old = time.time() - 3 * 60 * 60
os.utime(sys.argv[1], (old, old))
PY

lock_mtime=$(file_mtime_epoch "$LOCK_DIR" 2>/dev/null || echo 0)
lock_age=$(( $(date +%s) - lock_mtime ))
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

# ── Test 27: integration — Lead failures remain independently parseable ──
echo "Test: integration — Lead failure count remains independently parseable"

# Simulate: parse lead_result with failures
lead_result="skipped:0 failed:2"
leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')

if (( leads_failed > 0 )); then
    pass "Integration: leads_failed=2 → degraded status can be recorded independently"
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
# FLY-43: Project repo .lead/ change detection tests
# ════════════════════════════════════════════════════════════════

# Setup: temp file for SHA updates + temp git repo
PROJECT_SHA_UPDATES_FILE="$TMPDIR_ROOT/project-sha-updates"
: > "$PROJECT_SHA_UPDATES_FILE"

# Setup: create a temp git repo to simulate a project repo
PROJECT_REPO="$TMPDIR_ROOT/project-repo"
mkdir -p "$PROJECT_REPO"
git -C "$PROJECT_REPO" init -q
git -C "$PROJECT_REPO" checkout -q -b main

# Create initial .lead/ structure and commit
mkdir -p "$PROJECT_REPO/.lead/shared" "$PROJECT_REPO/.lead/product-lead"
echo "# Common rules v1" > "$PROJECT_REPO/.lead/shared/common-rules.md"
echo "# Identity v1" > "$PROJECT_REPO/.lead/product-lead/identity.md"
git -C "$PROJECT_REPO" add -A
git -C "$PROJECT_REPO" commit -q -m "initial .lead/ setup"
INITIAL_SHA=$(git -C "$PROJECT_REPO" rev-parse HEAD)

# Source helper functions from restart-services.sh
PROJECT_SHA_DIR="$TMPDIR_ROOT/project-deployed-sha"
PROJECT_SHA_UPDATES=""

resolve_main_repo() {
    local dir="$1"
    [[ -d "$dir" ]] || return 1
    local common_dir
    common_dir=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || return 1
    if [[ "$common_dir" == ".git" ]]; then
        echo "$dir"
    else
        dirname "$common_dir"
    fi
}

# ── Test 36: resolve_main_repo — main repo returns itself ──
echo "Test: FLY-43 — resolve_main_repo — main repo returns itself"

result=$(resolve_main_repo "$PROJECT_REPO")
if [[ "$result" == "$PROJECT_REPO" ]]; then
    pass "resolve_main_repo: main repo → itself"
else
    fail "resolve_main_repo: expected $PROJECT_REPO, got $result"
fi

# ── Test 37: resolve_main_repo — nonexistent dir fails ──
echo "Test: FLY-43 — resolve_main_repo — nonexistent dir fails"

rc=0
resolve_main_repo "$TMPDIR_ROOT/nonexistent" > /dev/null 2>&1 || rc=$?
if (( rc != 0 )); then
    pass "resolve_main_repo: nonexistent dir → failure"
else
    fail "resolve_main_repo: expected failure for nonexistent dir"
fi

# ── Test 38: resolve_main_repo — worktree resolves to main ──
echo "Test: FLY-43 — resolve_main_repo — worktree resolves to main"

WORKTREE_DIR="$TMPDIR_ROOT/project-worktree"
git -C "$PROJECT_REPO" worktree add -q "$WORKTREE_DIR" -b test-branch 2>/dev/null
result=$(resolve_main_repo "$WORKTREE_DIR")
# Normalize both paths (macOS /var → /private/var symlink)
expected_normalized=$(cd "$PROJECT_REPO" && pwd -P)
result_normalized=$(cd "$result" 2>/dev/null && pwd -P)
if [[ "$result_normalized" == "$expected_normalized" ]]; then
    pass "resolve_main_repo: worktree → main repo"
else
    fail "resolve_main_repo: expected $expected_normalized, got $result_normalized"
fi
# Cleanup worktree
git -C "$PROJECT_REPO" worktree remove "$WORKTREE_DIR" 2>/dev/null || true

# ── Test 39: check_project_lead_changes — no manifests → skip ──
echo "Test: FLY-43 — check_project_lead_changes — no manifests → skip"

check_project_lead_changes() {
    project_lead_changed=false
    : > "$PROJECT_SHA_UPDATES_FILE"

    shopt -s nullglob
    local manifests=("$TMPDIR_ROOT/empty-manifests/"*.json)
    shopt -u nullglob

    if (( ${#manifests[@]} == 0 )); then
        log "No manifests found, skipping project repo check"
        return
    fi
}

mkdir -p "$TMPDIR_ROOT/empty-manifests"
project_lead_changed=true  # set to true to verify it gets reset
check_project_lead_changes
if [[ "$project_lead_changed" == "false" ]]; then
    pass "check_project_lead_changes: no manifests → project_lead_changed=false"
else
    fail "check_project_lead_changes: expected false"
fi

# ── Test 40: check_project_lead_changes — first run → records SHA, no restart ──
echo "Test: FLY-43 — check_project_lead_changes — first run → records SHA"

# Create a bare remote so we can test origin/main
REMOTE_REPO="$TMPDIR_ROOT/remote-repo.git"
git -C "$PROJECT_REPO" clone -q --bare "$PROJECT_REPO" "$REMOTE_REPO" 2>/dev/null || \
    git clone -q --bare "$PROJECT_REPO" "$REMOTE_REPO"
git -C "$PROJECT_REPO" remote remove origin 2>/dev/null || true
git -C "$PROJECT_REPO" remote add origin "$REMOTE_REPO"
git -C "$PROJECT_REPO" fetch origin main --quiet 2>/dev/null

# Create manifest pointing to this project
MANIFEST_DIR_43="$TMPDIR_ROOT/manifests-43"
mkdir -p "$MANIFEST_DIR_43"
jq -n \
  --arg projectDir "$PROJECT_REPO" \
  --arg projectName "test-project" \
  --arg leadId "product-lead" \
  --arg botTokenEnv "TEST_TOKEN" \
  '{leadId: $leadId, projectDir: $projectDir, projectName: $projectName, subdir: "", botTokenEnv: $botTokenEnv}' \
  > "$MANIFEST_DIR_43/test-product-lead.json"

# Full check_project_lead_changes with real manifests
check_project_lead_changes() {
    project_lead_changed=false
    : > "$PROJECT_SHA_UPDATES_FILE"

    shopt -s nullglob
    local manifests=("$MANIFEST_DIR_43/"*.json)
    shopt -u nullglob

    if (( ${#manifests[@]} == 0 )); then return; fi

    local seen_names=""
    local project_names=()
    local project_dirs=()

    for mf in "${manifests[@]}"; do
        local pname pdir
        pname=$(jq -r '.projectName' "$mf")
        pdir=$(jq -r '.projectDir' "$mf")
        case " $seen_names " in *" $pname "*) continue ;; esac

        local main_repo
        if main_repo=$(resolve_main_repo "$pdir"); then
            project_names+=("$pname")
            project_dirs+=("$main_repo")
            seen_names="$seen_names $pname"
        fi
    done

    local i
    for (( i=0; i<${#project_names[@]}; i++ )); do
        local pname="${project_names[$i]}"
        local repo="${project_dirs[$i]}"
        local sha_file="${PROJECT_SHA_DIR}/${pname}"
        local stored_sha
        stored_sha=$(cat "$sha_file" 2>/dev/null || echo "")

        local current_sha
        current_sha=$(git -C "$repo" rev-parse origin/main 2>/dev/null) || continue

        printf '%s\t%s\n' "$pname" "$current_sha" >> "$PROJECT_SHA_UPDATES_FILE"

        if [[ "$stored_sha" == "$current_sha" ]]; then continue; fi

        if [[ -z "$stored_sha" ]]; then
            log "Project $pname: first run, recording SHA ${current_sha:0:7}"
            mkdir -p "$PROJECT_SHA_DIR"
            echo "$current_sha" > "$sha_file"
            continue
        fi

        # Fail-safe: if git diff fails, treat as changed
        local lead_changes
        local diff_ok=true
        lead_changes=$(git -C "$repo" diff --name-only "$stored_sha" "$current_sha" -- .lead/ 2>/dev/null) || diff_ok=false
        if [[ "$diff_ok" == "false" ]]; then
            project_lead_changed=true
        elif [[ -n "$lead_changes" ]]; then
            project_lead_changed=true
        fi
    done
}

# Ensure no prior SHA exists
rm -rf "$PROJECT_SHA_DIR"

check_project_lead_changes

if [[ "$project_lead_changed" == "false" ]] && [[ -f "$PROJECT_SHA_DIR/test-project" ]]; then
    stored=$(cat "$PROJECT_SHA_DIR/test-project")
    expected=$(git -C "$PROJECT_REPO" rev-parse origin/main)
    if [[ "$stored" == "$expected" ]]; then
        pass "check_project_lead_changes: first run → SHA recorded, no restart"
    else
        fail "check_project_lead_changes: SHA mismatch (stored=$stored expected=$expected)"
    fi
else
    fail "check_project_lead_changes: first run failed (changed=$project_lead_changed, sha_file exists=$(test -f "$PROJECT_SHA_DIR/test-project" && echo yes || echo no))"
fi

# ── Test 41: check_project_lead_changes — no .lead/ changes → false ──
echo "Test: FLY-43 — check_project_lead_changes — no .lead/ changes → false"

# SHA already recorded, no new commits → should report no changes
check_project_lead_changes

if [[ "$project_lead_changed" == "false" ]]; then
    pass "check_project_lead_changes: same SHA → no changes"
else
    fail "check_project_lead_changes: expected false on same SHA"
fi

# ── Test 42: check_project_lead_changes — .lead/ changed → true ──
echo "Test: FLY-43 — check_project_lead_changes — .lead/ changed → true"

# Make a new commit with .lead/ changes
echo "# Identity v2 — updated" > "$PROJECT_REPO/.lead/product-lead/identity.md"
git -C "$PROJECT_REPO" add -A
git -C "$PROJECT_REPO" commit -q -m "update identity.md"
git -C "$PROJECT_REPO" push -q origin main 2>/dev/null
git -C "$PROJECT_REPO" fetch origin main --quiet 2>/dev/null

check_project_lead_changes

if [[ "$project_lead_changed" == "true" ]]; then
    pass "check_project_lead_changes: .lead/ changed → true"
else
    fail "check_project_lead_changes: expected true after .lead/ change"
fi

# ── Test 43: check_project_lead_changes — non-.lead/ changes → false ──
echo "Test: FLY-43 — check_project_lead_changes — non-.lead/ changes → false"

# First, update SHA to current state
update_project_shas() {
    [[ ! -s "$PROJECT_SHA_UPDATES_FILE" ]] && return
    mkdir -p "$PROJECT_SHA_DIR"
    while IFS=$'\t' read -r pname sha; do
        [[ -z "$pname" || -z "$sha" ]] && continue
        echo "$sha" > "${PROJECT_SHA_DIR}/${pname}"
    done < "$PROJECT_SHA_UPDATES_FILE"
}
update_project_shas

# Make a new commit that does NOT touch .lead/
echo "# README" > "$PROJECT_REPO/README.md"
git -C "$PROJECT_REPO" add -A
git -C "$PROJECT_REPO" commit -q -m "update README only"
git -C "$PROJECT_REPO" push -q origin main 2>/dev/null
git -C "$PROJECT_REPO" fetch origin main --quiet 2>/dev/null

check_project_lead_changes

if [[ "$project_lead_changed" == "false" ]]; then
    pass "check_project_lead_changes: non-.lead/ change → false"
else
    fail "check_project_lead_changes: expected false for non-.lead/ change"
fi

# ── Test 44: update_project_shas — writes SHA files ──
echo "Test: FLY-43 — update_project_shas — writes SHA files"

# PROJECT_SHA_UPDATES should have been populated by last check
update_project_shas
stored=$(cat "$PROJECT_SHA_DIR/test-project" 2>/dev/null || echo "")
expected=$(git -C "$PROJECT_REPO" rev-parse origin/main)
if [[ "$stored" == "$expected" ]]; then
    pass "update_project_shas: SHA file updated correctly"
else
    fail "update_project_shas: stored=$stored expected=$expected"
fi

# ── Test 45: integration — project_lead_changed + SHA match → PLUGIN_ONLY_RESTART ──
echo "Test: FLY-43 — integration — project_lead_changed + SHA match → lead-only restart"

project_lead_changed=true
plugin_needs_restart=false
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="abc1234"
PLUGIN_ONLY_RESTART=false

if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    if [[ "$plugin_needs_restart" == "true" || "$project_lead_changed" == "true" ]]; then
        PLUGIN_ONLY_RESTART=true
    fi
fi

if [[ "$PLUGIN_ONLY_RESTART" == "true" ]]; then
    pass "Integration: project_lead_changed + SHA match → lead-only restart"
else
    fail "Integration: expected PLUGIN_ONLY_RESTART=true"
fi

# ── Test 46: integration — project_lead_changed merges into restart_all_leads ──
echo "Test: FLY-43 — integration — project_lead_changed merges into restart_all_leads"

project_lead_changed=true
plugin_needs_restart=false
restart_all_leads=false

if [[ "$plugin_needs_restart" == "true" || "$project_lead_changed" == "true" ]]; then
    restart_all_leads=true
fi

if [[ "$restart_all_leads" == "true" ]]; then
    pass "Integration: project_lead_changed → restart_all_leads=true"
else
    fail "Integration: expected restart_all_leads=true"
fi

# ── Test 47: MAX_WAIT_SECONDS — default is 300 ──
echo "Test: FLY-43 — MAX_WAIT_SECONDS default is 300"

unset RESTART_MAX_WAIT
MAX_WAIT_SECONDS="${RESTART_MAX_WAIT:-300}"
if [[ "$MAX_WAIT_SECONDS" == "300" ]]; then
    pass "MAX_WAIT_SECONDS: default is 300 (5 minutes)"
else
    fail "MAX_WAIT_SECONDS: expected 300, got $MAX_WAIT_SECONDS"
fi

# ── Test 48: MAX_WAIT_SECONDS — env override ──
echo "Test: FLY-43 — MAX_WAIT_SECONDS env override"

RESTART_MAX_WAIT=120
MAX_WAIT_SECONDS="${RESTART_MAX_WAIT:-300}"
if [[ "$MAX_WAIT_SECONDS" == "120" ]]; then
    pass "MAX_WAIT_SECONDS: env override to 120"
else
    fail "MAX_WAIT_SECONDS: expected 120, got $MAX_WAIT_SECONDS"
fi
unset RESTART_MAX_WAIT

# ── Test 49: resolve_main_repo — non-git dir fails ──
echo "Test: FLY-43 — resolve_main_repo — non-git dir fails"

NON_GIT_DIR="$TMPDIR_ROOT/not-a-repo"
mkdir -p "$NON_GIT_DIR"
rc=0
resolve_main_repo "$NON_GIT_DIR" > /dev/null 2>&1 || rc=$?
if (( rc != 0 )); then
    pass "resolve_main_repo: non-git dir → failure"
else
    fail "resolve_main_repo: expected failure for non-git dir"
fi

# ── Test 50: check_project_lead_changes — manifest with dead worktree skipped ──
echo "Test: FLY-43 — check_project_lead_changes — dead worktree manifest skipped"

# Add a second manifest pointing to a non-existent worktree (same project)
jq -n \
  --arg projectDir "$TMPDIR_ROOT/dead-worktree" \
  --arg projectName "test-project" \
  --arg leadId "ops-lead" \
  --arg botTokenEnv "OPS_TOKEN" \
  '{leadId: $leadId, projectDir: $projectDir, projectName: $projectName, subdir: "", botTokenEnv: $botTokenEnv}' \
  > "$MANIFEST_DIR_43/test-ops-lead.json"

# Reset SHA to trigger check
rm -f "$PROJECT_SHA_DIR/test-project"

check_project_lead_changes

# Should still work (product-lead manifest has valid dir)
if [[ -f "$PROJECT_SHA_DIR/test-project" ]]; then
    pass "check_project_lead_changes: dead worktree skipped, valid manifest used"
else
    fail "check_project_lead_changes: failed to process any manifest"
fi

# ── Test 51: git diff fail-safe — bad SHA triggers restart ──
echo "Test: FLY-43 — git diff fail-safe — bad SHA triggers restart"

# Write a garbage SHA to trigger git diff failure
mkdir -p "$PROJECT_SHA_DIR"
echo "0000000000000000000000000000000000000000" > "$PROJECT_SHA_DIR/test-project"

check_project_lead_changes

if [[ "$project_lead_changed" == "true" ]]; then
    pass "git diff fail-safe: bad SHA → project_lead_changed=true"
else
    fail "git diff fail-safe: expected true when git diff fails"
fi

# ── Test 52: update_project_shas — handles project names via file ──
echo "Test: FLY-43 — update_project_shas — file-based SHA tracking"

# Reset
rm -rf "$PROJECT_SHA_DIR"
: > "$PROJECT_SHA_UPDATES_FILE"
printf 'test-project\tabc123def456\n' >> "$PROJECT_SHA_UPDATES_FILE"
printf 'another-project\t789xyz000111\n' >> "$PROJECT_SHA_UPDATES_FILE"

update_project_shas

stored1=$(cat "$PROJECT_SHA_DIR/test-project" 2>/dev/null || echo "")
stored2=$(cat "$PROJECT_SHA_DIR/another-project" 2>/dev/null || echo "")
if [[ "$stored1" == "abc123def456" && "$stored2" == "789xyz000111" ]]; then
    pass "update_project_shas: file-based multi-project SHA update"
else
    fail "update_project_shas: stored1=$stored1 stored2=$stored2"
fi

# ════════════════════════════════════════════════════════════════
# FLY-239: Bridge-stop targeting — locate the real Bridge by listening
# port, never cross-kill a QA-slot worktree Bridge, walk its own tree.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-239 stop_bridge targeting"

# Copies of the targeting helpers from restart-services.sh (the real script
# top-level-execs, so we can't source it). Seams (_listeners_on_port/_ppid_of/
# _args_of) are overridden below with a fake process table.
bridge_port() {
    local p
    p="$(printf '%s' "$BRIDGE_URL" | sed -E 's#^.*:([0-9]+).*$#\1#')"
    if [[ "$p" =~ ^[0-9]+$ ]]; then printf '%s\n' "$p"; else printf '9876\n'; fi
}
collect_bridge_tree() {
    local pid="$1" cur ppid args
    [[ -z "$pid" ]] && return 0
    args="$(_args_of "$pid")"
    case "$args" in *worktrees/*) return 0 ;; esac
    printf '%s\n' "$pid"
    cur="$pid"
    while :; do
        ppid="$(_ppid_of "$cur")"
        [[ -z "$ppid" || "$ppid" == 0 || "$ppid" == 1 ]] && break
        args="$(_args_of "$ppid")"
        case "$args" in
            *worktrees/*)   break ;;
            *run-bridge.ts*) printf '%s\n' "$ppid"; cur="$ppid" ;;
            *)              break ;;
        esac
    done
}
bridge_target_pids() {
    local port listener
    port="$(bridge_port)"
    {
        while IFS= read -r listener; do
            [[ -z "$listener" ]] && continue
            collect_bridge_tree "$listener"
        done < <(_listeners_on_port "$port")
    } | awk 'NF && !seen[$0]++'
}

# Fake process table:
#   PROD : 100(listener,:9876) → 101(tsx) → 102(npm wrapper) → launchd(1)
#   QA   : 200(listener,:9999, worktrees/) → 201(tsx,worktrees/) → 202(npm,worktrees/) → 1
# Note 100's own args have NO "run-bridge.ts" (mirrors the real tsx node), and
# 201/202 DO contain "run-bridge.ts" — exactly what made `pgrep -f run-bridge.ts`
# cross-kill the QA Bridge. Port-based selection must ignore them.
_listeners_on_port() {
    case "$1" in
        9876) echo 100 ;;
        9999) echo 200 ;;
        *)    : ;;
    esac
}
_ppid_of() {
    case "$1" in
        100) echo 101 ;; 101) echo 102 ;; 102) echo 1 ;;
        200) echo 201 ;; 201) echo 202 ;; 202) echo 1 ;;
        *)   echo "" ;;
    esac
}
_args_of() {
    case "$1" in
        100) echo "/opt/node --require /Users/x/Dev/flywheel/node_modules/.../tsx/preflight.cjs --import .../loader.mjs" ;;
        101) echo "node /Users/x/Dev/flywheel/node_modules/.bin/../tsx/dist/cli.mjs scripts/run-bridge.ts" ;;
        102) echo "npm exec tsx scripts/run-bridge.ts" ;;
        200) echo "/opt/node --require /Users/x/Dev/flywheel/worktrees/qa-slot/node_modules/.../preflight.cjs" ;;
        201) echo "node /Users/x/Dev/flywheel/worktrees/qa-slot/node_modules/.../tsx/cli.mjs worktrees/qa-slot/scripts/run-bridge.ts" ;;
        202) echo "npm exec tsx /Users/x/Dev/flywheel/worktrees/qa-slot/scripts/run-bridge.ts" ;;
        *)   echo "" ;;
    esac
}

# 1) bridge_port parses BRIDGE_URL; falls back to 9876.
BRIDGE_URL="http://localhost:9876"; [[ "$(bridge_port)" == "9876" ]] \
    && pass "bridge_port: parses :9876" || fail "bridge_port: got $(bridge_port)"
BRIDGE_URL="http://localhost"; [[ "$(bridge_port)" == "9876" ]] \
    && pass "bridge_port: fallback 9876 when no port" || fail "bridge_port fallback: got $(bridge_port)"
BRIDGE_URL="http://127.0.0.1:9999"; [[ "$(bridge_port)" == "9999" ]] \
    && pass "bridge_port: parses :9999" || fail "bridge_port: got $(bridge_port)"

# 2) collect_bridge_tree walks the prod tree (listener + tsx + npm wrapper).
tree="$(collect_bridge_tree 100 | tr '\n' ' ' | sed 's/ $//')"
[[ "$tree" == "100 101 102" ]] \
    && pass "collect_bridge_tree: prod tree = 100 101 102" \
    || fail "collect_bridge_tree prod: got '$tree'"

# 3) collect_bridge_tree refuses a worktree listener (QA Bridge).
tree="$(collect_bridge_tree 200 | tr '\n' ' ' | sed 's/ $//')"
[[ -z "$tree" ]] \
    && pass "collect_bridge_tree: worktree listener yields nothing" \
    || fail "collect_bridge_tree worktree: got '$tree'"

# 4) REGRESSION: with the prod port, target set is ONLY the prod tree — the QA
#    Bridge (200/201/202) is never selected even though 201/202 match run-bridge.ts.
BRIDGE_URL="http://localhost:9876"
targets="$(bridge_target_pids | tr '\n' ' ' | sed 's/ $//')"
if [[ "$targets" == "100 101 102" ]]; then
    pass "bridge_target_pids: prod port selects only prod tree (no QA cross-kill)"
else
    fail "bridge_target_pids: got '$targets' (expected '100 101 102')"
fi
if echo "$targets" | grep -qE '\b20[012]\b'; then
    fail "bridge_target_pids: LEAKED a QA-slot PID into kill set: '$targets'"
else
    pass "bridge_target_pids: no QA-slot PID in kill set"
fi

# 5) Empty when nothing listens on the configured port.
BRIDGE_URL="http://localhost:1234"
[[ -z "$(bridge_target_pids)" ]] \
    && pass "bridge_target_pids: empty when port has no listener" \
    || fail "bridge_target_pids: expected empty for unused port"

# 6) REGRESSION (Codex R1 HIGH): the TERM→wait loop must NOT abort under
#    `set -euo pipefail`. `((wait_count++))` exits 1 on the first pass (n=0),
#    which `set -e` turns into a mid-stop deploy abort. The assignment idiom
#    must complete all iterations. Run the exact loop shape in a clean shell.
if out=$(bash -c '
    set -euo pipefail
    wait_count=0
    pids="999999991 999999992"   # non-existent PIDs → kill -0 fails fast
    while (( wait_count < 3 )); do
        alive=0
        for p in $pids; do kill -0 "$p" 2>/dev/null && { alive=1; break; }; done
        # force the wait path regardless of liveness for this regression
        wait_count=$((wait_count + 1))
    done
    echo "LOOP_COMPLETED:$wait_count"
' 2>/dev/null) && [[ "$out" == "LOOP_COMPLETED:3" ]]; then
    pass "stop_bridge wait loop: set -e safe increment completes (no mid-stop abort)"
else
    fail "stop_bridge wait loop: aborted under set -e (out='$out')"
fi
# Negative control: prove the OLD `((wait_count++))` idiom WOULD abort.
if bash -c 'set -euo pipefail; n=0; ((n++)); echo ok' >/dev/null 2>&1; then
    fail "negative control: ((n++)) did NOT abort under set -e (test assumption broken)"
else
    pass "negative control: ((n++)) aborts under set -e (confirms the regression)"
fi

# restore for any later tests
BRIDGE_URL="http://localhost:9876"

# ════════════════════════════════════════════════════════════════
# FLY-1434: unified restart — REAL top-level execution order, hermetic.
# The actual restart-services.sh runs end-to-end against a fake HOME
# (fake git repo at $HOME/Dev/flywheel, PATH shims recording every
# launchctl/pnpm invocation in $HOME/.local/bin — the FIRST dir the
# script prepends, so shims always win). Asserts the sanctioned
# Every legal invocation restarts Bridge + Leads, while no-code deltas skip
# build. The removed --bridge-only flag is tested only as a rejected input.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1434 unified restart top-level order (hermetic)"

REAL_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BO_HOME="$TMPDIR_ROOT/bridge-only-home"
BO_FLYWHEEL="$BO_HOME/Dev/flywheel"
BO_SHIMS="$BO_HOME/.local/bin"
BO_CALLS="$TMPDIR_ROOT/bridge-only-calls"
mkdir -p "$BO_FLYWHEEL/scripts/lib" "$BO_HOME/.flywheel/manifests" "$BO_SHIMS" "$BO_CALLS"
cp "$REAL_REPO_ROOT/scripts/restart-services.sh" "$BO_FLYWHEEL/scripts/"
cp "$REAL_REPO_ROOT/scripts/lib/bridge-port.sh" \
   "$REAL_REPO_ROOT/scripts/lib/restart-candidate.sh" "$BO_FLYWHEEL/scripts/lib/"
cat > "$BO_FLYWHEEL/scripts/converge-flywheel-bin.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$BO_FLYWHEEL/scripts/converge-flywheel-bin.sh"
git -C "$BO_FLYWHEEL" init -q
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
BO_HEAD_1=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)

cat > "$BO_SHIMS/launchctl" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/launchctl.calls"
if [[ "\${1:-}" == "print" ]]; then
  echo "state = running"
  echo "pid = \${FAKE_LAUNCHD_PID:-424242}"
fi
exit 0
EOF
cat > "$BO_SHIMS/tmux" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/tmux.calls"
if [[ "\${FAKE_LEAD_SESSION_DEAD:-0}" == "1" ]]; then
  echo "flywheel-eng 1"
else
  echo "flywheel-eng 0"
fi
EOF
cat > "$BO_SHIMS/sleep" <<'EOF'
#!/bin/bash
if [[ "${FAKE_FAST_SLEEP:-0}" == "1" ]]; then
  exit 0
fi
exec /bin/sleep "$@"
EOF
cat > "$BO_SHIMS/pnpm" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/pnpm.calls"
exit 0
EOF
cat > "$BO_SHIMS/node" <<'EOF'
#!/bin/bash
echo -n ok
EOF
cat > "$BO_SHIMS/curl" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/curl.calls"
echo '{"ok":true,"sessions_count":0}'
EOF
cat > "$BO_SHIMS/lsof" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$BO_SHIMS"/*
cat > "$BO_HOME/.flywheel/manifests/flywheel-eng.json" <<EOF
{"leadId":"eng","projectDir":"$BO_FLYWHEEL","projectName":"flywheel","botTokenEnv":"TEST_BOT_TOKEN"}
EOF

bo_run() {
    rm -f "$BO_CALLS"/*.calls
    HOME="$BO_HOME" PATH="$BO_SHIMS:$PATH" \
        CLAUDE_INFRA_BOT_TOKEN="" FLYWHEEL_NOTIFY_CHANNEL="" \
        FLYWHEEL_FOUNDER_USER_ID="" TEST_BOT_TOKEN="test-token" \
        FAKE_FAST_SLEEP="${FAKE_FAST_SLEEP:-0}" \
        FAKE_LEAD_SESSION_DEAD="${FAKE_LEAD_SESSION_DEAD:-0}" \
        RESTART_LEAD_STOP_WAIT_SECONDS="${RESTART_LEAD_STOP_WAIT_SECONDS:-60}" \
        RESTART_LEAD_VERIFY_ATTEMPTS="${RESTART_LEAD_VERIFY_ATTEMPTS:-2}" \
        RESTART_LEAD_VERIFY_INTERVAL="${RESTART_LEAD_VERIFY_INTERVAL:-0}" \
        bash "$BO_FLYWHEEL/scripts/restart-services.sh" "$@" 2>&1
}
bo_calls() { cat "$BO_CALLS/$1.calls" 2>/dev/null || true; }

# ── 1) SHA match skips build but still performs the one full restart ──
echo "$BO_HEAD_1" > "$BO_HOME/.flywheel/deployed-sha"
out=$(bo_run) && rc=0 || rc=$?
if (( rc == 0 )) && echo "$out" | grep -q "skipping build, continuing full restart" \
   && [[ -z "$(bo_calls pnpm)" ]] \
   && bo_calls launchctl | grep -q "com.flywheel.bridge" \
   && bo_calls launchctl | grep -q "com.flywheel.lead.flywheel-eng"; then
    pass "FLY-1434 order: SHA match skips build and restarts Bridge + Leads"
else
    fail "FLY-1434 order: SHA match — rc=$rc launchctl='$(bo_calls launchctl)' out tail: $(echo "$out" | tail -3)"
fi

# ── 2) doc-only delta also skips build but never skips restart ──
echo "new doc" > "$BO_FLYWHEEL/README.md"
git -C "$BO_FLYWHEEL" add README.md
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "docs: readme"
BO_HEAD_2=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
out=$(bo_run) && rc=0 || rc=$?
if (( rc == 0 )) && echo "$out" | grep -q "Build skipped" \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$BO_HEAD_2" ]] \
   && [[ -z "$(bo_calls pnpm)" ]] \
   && bo_calls launchctl | grep -q "com.flywheel.bridge" \
   && bo_calls launchctl | grep -q "com.flywheel.lead.flywheel-eng"; then
    pass "FLY-1434 order: doc-only delta skips build and restarts the full fleet"
else
    fail "FLY-1434 order: doc-only mismatch — rc=$rc sha=$(cat "$BO_HOME/.flywheel/deployed-sha") out tail: $(echo "$out" | tail -3)"
fi

# ── 3) dry-run exposes full scope + reason with no side effects ──
echo "failed=1" > "$BO_HOME/.flywheel/plugin-restart-pending"
out=$(bo_run --dry-run --reason env-change) && rc=0 || rc=$?
if (( rc == 0 )) && echo "$out" | grep -q "Would restart Bridge + all Leads" \
   && echo "$out" | grep -q "reason=env-change" \
   && [[ -z "$(bo_calls launchctl)" && -z "$(bo_calls pnpm)" ]] \
   && [[ -f "$BO_HOME/.flywheel/plugin-restart-pending" ]]; then
    pass "FLY-1434 dry-run: full scope + reason, zero service side effects"
else
    fail "FLY-1434 dry-run: rc=$rc out tail: $(echo "$out" | tail -3)"
fi
rm -f "$BO_HOME/.flywheel/plugin-restart-pending"

# ── 4) removed split-mode flag is rejected before side effects ──
echo "stale-sha-must-not-change" > "$BO_HOME/.flywheel/deployed-sha"
out=$(bo_run --bridge-only --dry-run) && rc=0 || rc=$?
if (( rc == 1 )) && echo "$out" | grep -q "Unknown argument '--bridge-only'" \
   && [[ -z "$(bo_calls launchctl)" && -z "$(bo_calls pnpm)" && -z "$(bo_calls curl)" ]] \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "stale-sha-must-not-change" ]]; then
    pass "FLY-1434 --bridge-only: rejected before all side effects"
else
    fail "FLY-1434 --bridge-only rejection: rc=$rc launchctl='$(bo_calls launchctl)' out tail: $(echo "$out" | tail -2)"
fi

# ── 5) env-only invocation performs full restart and automatic notices ──
echo "failed=1" > "$BO_HOME/.flywheel/plugin-restart-pending"
mkdir -p "$BO_HOME/.flywheel/project-deployed-sha"
echo "proj-sha-frozen" > "$BO_HOME/.flywheel/project-deployed-sha/someproj"
echo "$BO_HEAD_2" > "$BO_HOME/.flywheel/deployed-sha"
out=$(bo_run --reason env-change) && rc=0 || rc=$?
bo_ok=true
(( rc == 0 )) || bo_ok=false
echo "$out" | grep -q "Done." || bo_ok=false
echo "$out" | grep -q "reason=env-change" || bo_ok=false
bo_calls launchctl | grep -q "kickstart -k gui/$(id -u)/com.flywheel.bridge" || bo_ok=false
bo_calls launchctl | grep -q "com.flywheel.lead.flywheel-eng" || bo_ok=false
[[ -z "$(bo_calls pnpm)" ]] || bo_ok=false
bo_calls curl | grep -q "/health" || bo_ok=false
[[ ! -f "$BO_HOME/.flywheel/plugin-restart-pending" ]] || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1434 env-change: build skipped, Bridge + Leads restarted, reason notified"
else
    fail "FLY-1434 env-change: rc=$rc launchctl='$(bo_calls launchctl)' pnpm='$(bo_calls pnpm)' out tail: $(echo "$out" | tail -3)"
fi
rm -f "$BO_HOME/.flywheel/plugin-restart-pending"

# ── 6) a slow old supervisor is judged by the replacement outcome ──
echo "restart outcome" > "$BO_FLYWHEEL/restart-outcome.md"
git -C "$BO_FLYWHEEL" add restart-outcome.md
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "docs: restart outcome"
BO_HEAD_3=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
echo "$BO_HEAD_2" > "$BO_HOME/.flywheel/deployed-sha"
bash -c 'trap "" TERM; while :; do /bin/sleep 1; done' &
BO_STUCK_OLD_PID=$!
/bin/sleep 0.1
mkdir -p "$BO_HOME/.flywheel/pids"
echo "$BO_STUCK_OLD_PID" > "$BO_HOME/.flywheel/pids/flywheel-eng.pid"
out=$(FAKE_FAST_SLEEP=1 RESTART_LEAD_STOP_WAIT_SECONDS=0 bo_run --reason supervisor-timeout) && rc=0 || rc=$?
kill -KILL "$BO_STUCK_OLD_PID" 2>/dev/null || true
wait "$BO_STUCK_OLD_PID" 2>/dev/null || true
bo_status="$BO_HOME/.flywheel/leads-restart-status.json"
if (( rc == 0 )) \
   && echo "$out" | grep -q "continuing with launchd kickstart" \
   && bo_calls launchctl | grep -q "kickstart -k gui/$(id -u)/com.flywheel.lead.flywheel-eng" \
   && bo_calls tmux | grep -q "display-message" \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$BO_HEAD_3" ]] \
   && jq -e --arg sha "$BO_HEAD_3" \
        '.codeDeployedSha == $sha and .leadsRestartStatus == "healthy" and .failed == 0' \
        "$bo_status" >/dev/null; then
    pass "FLY-1434 outcome: stale old supervisor + successful kickstart/session is healthy and advances ledger"
else
    fail "FLY-1434 outcome: rc=$rc sha=$(cat "$BO_HOME/.flywheel/deployed-sha") status=$(cat "$bo_status" 2>/dev/null || echo missing) out tail: $(echo "$out" | tail -5)"
fi

# ── 7) final session re-probe can degrade Leads without losing code truth ──
echo "degraded outcome" > "$BO_FLYWHEEL/restart-degraded.md"
git -C "$BO_FLYWHEEL" add restart-degraded.md
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "docs: restart degraded"
BO_HEAD_4=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
echo "$BO_HEAD_3" > "$BO_HOME/.flywheel/deployed-sha"
out=$(FAKE_FAST_SLEEP=1 FAKE_LEAD_SESSION_DEAD=1 RESTART_LEAD_VERIFY_ATTEMPTS=2 bo_run --reason degraded-probe) && rc=0 || rc=$?
tmux_probes=$(bo_calls tmux | grep -c "display-message" || true)
if (( rc == 0 && tmux_probes >= 3 )) \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$BO_HEAD_4" ]] \
   && jq -e --arg sha "$BO_HEAD_4" \
        '.codeDeployedSha == $sha and .leadsRestartStatus == "degraded" and .failed == 1' \
        "$bo_status" >/dev/null \
   && echo "$out" | grep -q "code deployed; Lead restart status is degraded"; then
    pass "FLY-1434 degraded: final re-probe runs, code ledger advances, Lead status stays explicit"
else
    fail "FLY-1434 degraded: rc=$rc probes=$tmux_probes sha=$(cat "$BO_HOME/.flywheel/deployed-sha") status=$(cat "$bo_status" 2>/dev/null || echo missing) out tail: $(echo "$out" | tail -5)"
fi

# ── 8) --bridge-only --wait-idle with a BUSY first idle-poll → waits QUIETLY ──
# FLY-1142 (Codex code R1 MEDIUM-1): wait_for_idle's busy-progress notice
# rode notify_routine — a Discord post — violating the "no deploy
# notifications" contract. The stateful curl shim reports 3 active sessions
# on the FIRST /health poll and 0 afterwards, so the run exercises the busy
# branch (one 30s poll interval) and must log locally instead of notifying.
# FLY-1224: the idle wait is now OPT-IN — this test enters via --wait-idle
# (the default-skip behavior has its own tests below).
echo "Test: FLY-1142 --bridge-only --wait-idle busy idle-wait stays quiet (~35s)"
bo_busy_curl_shim() {
    cat > "$BO_SHIMS/curl" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/curl.calls"
n=\$(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0)
n=\$((n + 1)); echo "\$n" > "$BO_CALLS/health.n"
if (( n <= 1 )); then
    echo '{"ok":true,"sessions_count":3}'
else
    echo '{"ok":true,"sessions_count":0}'
fi
EOF
    chmod +x "$BO_SHIMS/curl"
    rm -f "$BO_CALLS/health.n"
}
bo_busy_curl_shim
out=$(bo_run --bridge-only --wait-idle) && rc=0 || rc=$?
bo_ok=true
(( rc == 1 )) || bo_ok=false
echo "$out" | grep -q "Unknown argument '--bridge-only'" || bo_ok=false
[[ -z "$(bo_calls launchctl)" ]] || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1434 removed split mode stays rejected with --wait-idle"
else
    fail "FLY-1142 --bridge-only --wait-idle busy wait: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ════════════════════════════════════════════════════════════════
# FLY-1224 (T12): idle-wait is DEFAULT-OFF (founder directive).
# Behavior-level, real top-level runs against the hermetic HOME —
# NOT dry-run text (R1 #4: both dry-runs exit before the gates, so a
# dry-run wording assertion is a false green). The busy-once curl shim
# means a REGRESSED gate would visibly wait ("Waiting for idle…" log)
# — exactly what these tests assert the absence/presence of.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1224 idle-wait default-off matrix"

# ── 7) default --bridge-only under a busy /health → NO idle wait ──
bo_busy_curl_shim
out=$(bo_run --bridge-only) && rc=0 || rc=$?
bo_ok=true
(( rc == 1 )) || bo_ok=false
echo "$out" | grep -q "Unknown argument '--bridge-only'" || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1434 default --bridge-only remains rejected"
else
    fail "FLY-1224 default --bridge-only: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ── 8) env FLYWHEEL_RESTART_WAIT_IDLE=1 restores the full-fleet wait ──
bo_busy_curl_shim
out=$(FLYWHEEL_RESTART_WAIT_IDLE=1 bo_run) && rc=0 || rc=$?
bo_ok=true
(( rc == 0 )) || bo_ok=false
echo "$out" | grep -q "Waiting for idle sessions before restart" || bo_ok=false
(( $(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0) >= 2 )) || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 env wait restores the full-fleet idle gate"
else
    fail "FLY-1224 env wait restore: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ── 9) --force wins over CLI + env idle-wait requests ──
bo_busy_curl_shim
out=$(FLYWHEEL_RESTART_WAIT_IDLE=1 bo_run --force --wait-idle) && rc=0 || rc=$?
bo_ok=true
(( rc == 0 )) || bo_ok=false
echo "$out" | grep -q -- "--force wins over --wait-idle/FLYWHEEL_RESTART_WAIT_IDLE" || bo_ok=false
echo "$out" | grep -q "Waiting for idle sessions before restart" && bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 force wins over CLI + env idle-wait requests"
else
    fail "FLY-1224 force-wins: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ── 10) FULL restart (core diff → restart_bridge=true) default → gate skipped ──
# A packages/teamlead diff classifies restart_bridge=true, so the run reaches
# the FULL-restart idle gate (:673 region) — the busy shim proves the gate is
# skipped by default (no "Waiting for idle sessions before restart" log) while
# the run demonstrably got PAST the gate location (build via the pnpm shim).
mkdir -p "$BO_FLYWHEEL/packages/teamlead"
echo "export {};" > "$BO_FLYWHEEL/packages/teamlead/fly1224.ts"
git -C "$BO_FLYWHEEL" add packages/teamlead/fly1224.ts
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "feat: core delta"
git -C "$BO_FLYWHEEL" rev-parse HEAD~1 > "$BO_HOME/.flywheel/deployed-sha"
bo_busy_curl_shim
out=$(bo_run) && rc=0 || rc=$?
bo_ok=true
echo "$out" | grep -q "Waiting for idle sessions before restart" && bo_ok=false
# got PAST the gate: the build ran (pnpm shim recorded a call)
[[ -n "$(bo_calls pnpm)" ]] || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 default FULL restart: idle gate skipped, build proceeded (rc=$rc)"
else
    fail "FLY-1224 default FULL restart: rc=$rc pnpm='$(bo_calls pnpm)' out tail: $(echo "$out" | tail -4)"
fi

# ── 11) FULL restart --wait-idle → gate waits ──
# NOTE: on the FULL lane the busy-progress notice rides notify_routine (a
# Discord post, dropped when unconfigured) — the bridge-only local log line
# does NOT appear here. The behavior evidence is the gate's own log line plus
# the /health poll count: the busy-once shim answers 3 sessions on poll #1, so
# a REAL wait polls /health at least twice (busy → idle).
git -C "$BO_FLYWHEEL" rev-parse HEAD~1 > "$BO_HOME/.flywheel/deployed-sha"
bo_busy_curl_shim
out=$(bo_run --wait-idle) && rc=0 || rc=$?
bo_ok=true
echo "$out" | grep -q "Waiting for idle sessions before restart" || bo_ok=false
(( $(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0) >= 2 )) || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 FULL restart --wait-idle: idle gate waits (~35s, rc=$rc)"
else
    fail "FLY-1224 FULL restart --wait-idle: rc=$rc health.n=$(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0) out tail: $(echo "$out" | tail -4)"
fi

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
