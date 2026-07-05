#!/bin/bash
# FLY-247 WI-5: fleet report — HTML generation + publish-report invocation.
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly247-report-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

export HOME="$SANDBOX"
mkdir -p "$SANDBOX/.flywheel/manifests" "$SANDBOX/Library/LaunchAgents" "$SANDBOX/proj/geo"

jq -n '[{projectName: "geo", projectRoot: "'"$SANDBOX"'/proj/geo",
  leads: [{agentId: "product-lead", chatChannel: "1", match: {labels: ["P"]}, model: "claude-fable-5"}]}]' \
  > "$SANDBOX/.flywheel/projects.json"

# publish-report stub records its argv
PUB="$SANDBOX/publish-stub"
cat > "$PUB" <<'EOF'
#!/bin/bash
echo "$@" > "${PUBLISH_LOG:?}"
exit 0
EOF
chmod +x "$PUB"
export PUBLISH_LOG="$SANDBOX/publish.log"

OUT_HTML="$SANDBOX/report.html"
FLYWHEEL_FLEET_PUBLISH_BIN="$PUB" FLYWHEEL_DAEMON_LAUNCHCTL=/usr/bin/true \
  bash "$REPO_ROOT/scripts/flywheel-fleet-report.sh" --project geo --channel 123 --out "$OUT_HTML" >/dev/null 2>&1
RC=$?

if [ "$RC" -eq 0 ] && [ -f "$OUT_HTML" ] \
  && grep -q "geo-product-lead" "$OUT_HTML" \
  && grep -q "claude-fable-5" "$OUT_HTML" \
  && grep -q "not yet wired" "$OUT_HTML"; then
  pass "R1: HTML generated with lead row + honest Increment-2 note"
else
  fail "R1: rc=$RC"
fi

if grep -q -- "publish-report --html ${OUT_HTML} --project geo --channel 123" "$PUBLISH_LOG" 2>/dev/null; then
  pass "R2: publish-report invoked with --html/--project/--channel"
else
  fail "R2: $(cat "$PUBLISH_LOG" 2>/dev/null)"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
