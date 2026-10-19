#!/bin/bash
# FLY-3083: lead-alert-env.sh ships in the npm payload and degrades there.
#
# claude-lead.sh / codex-lead.sh source packages/teamlead/scripts/lead-alert-env.sh
# under `set -euo pipefail`, so a payload without it would stop every packaged
# Lead at launch. This test:
#   1. assembles a minimal payload with the REAL file-asset copy loop
#      (po_copy_asset_files) and the DEFAULT PO_PACKAGE_ASSET_FILES whitelist
#      against this repo → node_modules/flywheel-teamlead/scripts/lead-alert-env.sh
#      exists;
#   2. runs the REAL po_gate on that payload → "release gates: PASS" (gate② proves
#      the path is registered in scripts/package-onboard-files.allow — no widened
#      class pattern);
#   3. sources the helper INSIDE the payload tree under `set -e`: scripts/lead-alert.sh
#      absent (as in every real payload — FLY-1062 audit: not shipped) → WARN,
#      FLYWHEEL_LEAD_ALERT_SCRIPT unset, rc 0; a stub scripts/lead-alert.sh placed
#      in the payload → the variable is its absolute path.
# No full build, no pack, no publish.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PO="$REPO_ROOT/scripts/package-onboard.sh"
SANDBOX="$(mktemp -d -t fly3083-po-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
TREE="$SANDBOX/package"
mkdir -p "$TREE"

# ── 1. real copy loop, default whitelist
if env PACKAGE_ONBOARD_SOURCED=1 bash -c 'source "$1"; po_copy_asset_files "$2" "$3"' _ \
    "$PO" "$REPO_ROOT" "$TREE" >"$SANDBOX/copy.log" 2>&1; then
  pass "po_copy_asset_files (default PO_PACKAGE_ASSET_FILES) assembled the teamlead launcher closure"
else
  fail "po_copy_asset_files failed: $(cat "$SANDBOX/copy.log")"
fi
HELPER="$TREE/node_modules/flywheel-teamlead/scripts/lead-alert-env.sh"
[ -f "$HELPER" ] && pass "payload carries node_modules/flywheel-teamlead/scripts/lead-alert-env.sh" \
  || fail "lead-alert-env.sh missing from the payload (not in PO_PACKAGE_ASSET_FILES?)"
[ -f "$TREE/node_modules/flywheel-teamlead/scripts/claude-lead.sh" ] \
  && pass "payload carries claude-lead.sh (the helper's consumer)" || fail "claude-lead.sh missing"

# ── 2. real release gate on the minimal payload
VER="$(env PACKAGE_ONBOARD_SOURCED=1 bash -c 'source "$1"; po_version "$2"' _ "$PO" "$REPO_ROOT")"
jq -n --arg v "$VER" '{name: "flywheel-onboard-fly3083-probe", version: $v}' >"$TREE/package.json"
printf '%s\n' "$VER" >"$TREE/.flywheel-prebuilt"
if env PACKAGE_ONBOARD_SOURCED=1 bash -c 'source "$1"; po_gate "$2" "$3"' _ \
    "$PO" "$TREE" "$REPO_ROOT" >"$SANDBOX/gate.log" 2>&1 \
   && grep -q "release gates: PASS" "$SANDBOX/gate.log"; then
  pass "real po_gate passes on the payload (gate② path registered)"
else
  fail "po_gate failed: $(tail -20 "$SANDBOX/gate.log")"
fi
# negative control: the SAME payload against an allowlist without the helper row fails gate②
grep -vF "node_modules/flywheel-teamlead/scripts/lead-alert-env.sh" \
  "$REPO_ROOT/scripts/package-onboard-files.allow" >"$SANDBOX/no-helper.allow"
if env PACKAGE_ONBOARD_SOURCED=1 PO_FILES_ALLOWLIST="$SANDBOX/no-helper.allow" \
    bash -c 'source "$1"; po_gate "$2" "$3"' _ "$PO" "$TREE" "$REPO_ROOT" >"$SANDBOX/gate-neg.log" 2>&1; then
  fail "po_gate should reject the helper when its .allow row is missing"
else
  grep -q "lead-alert-env.sh" "$SANDBOX/gate-neg.log" \
    && pass "negative control: without the .allow row gate② names the helper" \
    || fail "negative control failed for another reason: $(tail -5 "$SANDBOX/gate-neg.log")"
fi

# ── 3. the helper inside the payload tree, under set -e
SCRIPTS_DIR="$TREE/node_modules/flywheel-teamlead/scripts"
out=$(env -u FLYWHEEL_LEAD_ALERT_SCRIPT bash -c '
  set -euo pipefail
  export FLYWHEEL_LEAD_ALERT_SCRIPT=/stale/inherited/value
  source "$1/lead-alert-env.sh"
  export_lead_alert_script_env "$1"
  echo "RC=$? VAR=${FLYWHEEL_LEAD_ALERT_SCRIPT:-<unset>}"
' _ "$SCRIPTS_DIR" 2>&1); rc=$?
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "RC=0 VAR=<unset>" && printf '%s' "$out" | grep -q "WARNING"; then
  pass "payload without scripts/lead-alert.sh → WARN, variable unset (stale value dropped), rc 0"
else
  fail "missing-target degradation: rc=$rc out=$out"
fi
mkdir -p "$TREE/scripts"
printf '#!/bin/bash\necho sent\n' >"$TREE/scripts/lead-alert.sh"
chmod +x "$TREE/scripts/lead-alert.sh"
WANT="$(cd "$TREE/scripts" && pwd -P)/lead-alert.sh"
out=$(env -u FLYWHEEL_LEAD_ALERT_SCRIPT bash -c '
  set -euo pipefail
  source "$1/lead-alert-env.sh"
  export_lead_alert_script_env "$1"
  echo "VAR=${FLYWHEEL_LEAD_ALERT_SCRIPT:-<unset>}"
' _ "$SCRIPTS_DIR" 2>/dev/null)
[ "$out" = "VAR=$WANT" ] && pass "stub lead-alert.sh in the payload → exported as its absolute path" \
  || fail "stub target: got '$out', want 'VAR=$WANT'"

echo ""
echo "[package-onboard-fly3083] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
