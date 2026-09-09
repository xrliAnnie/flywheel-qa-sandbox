#!/bin/bash
# FLY-2388 · workflow preflight stops after endpoint/toolchain/repository/
# registry-pin checks; exact-tarball occupancy and content gates live in the
# helper. Founder-local retains its stricter version-reuse backstop.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$ROOT/scripts/release/shell-publish-preflight.sh"
SANDBOX="$(mktemp -d -t fly2388-preflight-modes-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
SHIM="$SANDBOX/bin"; mkdir -p "$SHIM"

cat > "$SHIM/npm" <<'SH'
#!/bin/bash
case "$1 $2 $3" in
  "--version  ") echo 11.9.0; exit 0 ;;
  "config get registry") echo https://registry.npmjs.org/; exit 0 ;;
  "config get @flywheel-ai:registry") echo undefined; exit 0 ;;
esac
if [ "$1" = "view" ]; then
  echo "VIEW_REACHED" >> "$TRACE"
  case "${VIEW_MODE:-exists}" in
    exists) echo 0.1.0; exit 0 ;;
    missing) echo 'npm error code E404' >&2; exit 1 ;;
  esac
fi
echo "unexpected npm $*" >&2
exit 99
SH
chmod +x "$SHIM/npm"

TRACE="$SANDBOX/workflow.trace" PATH="$SHIM:$PATH" \
  bash "$PREFLIGHT" --workflow >"$SANDBOX/workflow.out" 2>&1
WORKFLOW_RC=$?
if [ "$WORKFLOW_RC" -eq 0 ] && grep -q "PREFLIGHT PASS" "$SANDBOX/workflow.out" \
   && [ ! -e "$SANDBOX/workflow.trace" ]; then
  pass "M1 --workflow passes gate 2 and never probes version occupancy/content"
else
  fail "M1 workflow mode did not stop after gate 2 (rc=$WORKFLOW_RC): $(tail -4 "$SANDBOX/workflow.out")"
fi

MODE_OUT="$(PATH="$SHIM:$PATH" bash "$PREFLIGHT" --workflow --founder-local 2>&1)"; MODE_RC=$?
if [ "$MODE_RC" -ne 0 ] && grep -q "mutually exclusive" <<<"$MODE_OUT"; then
  pass "M2 preflight modes are mutually exclusive"
else
  fail "M2 mixed modes were not refused (rc=$MODE_RC): $MODE_OUT"
fi

TRACE="$SANDBOX/founder.trace" VIEW_MODE=exists PATH="$SHIM:$PATH" \
  bash "$PREFLIGHT" --founder-local >"$SANDBOX/founder.out" 2>&1
FOUNDER_RC=$?
if [ "$FOUNDER_RC" -ne 0 ] && grep -q "already exists" "$SANDBOX/founder.out" \
   && grep -q VIEW_REACHED "$SANDBOX/founder.trace"; then
  pass "M3 founder-local still refuses a version already present"
else
  fail "M3 founder-local version backstop drifted (rc=$FOUNDER_RC): $(tail -4 "$SANDBOX/founder.out")"
fi

TRACE="$SANDBOX/tag.trace" VIEW_MODE=missing npm_config_tag=next PATH="$SHIM:$PATH" \
  bash "$PREFLIGHT" --founder-local >"$SANDBOX/tag.out" 2>&1
TAG_RC=$?
if [ "$TAG_RC" -ne 0 ] && grep -q "npm_config_tag" "$SANDBOX/tag.out" \
   && [ ! -e "$SANDBOX/tag.trace" ]; then
  pass "M4 founder-local lifecycle refuses a dist-tag that disagrees with the shared parser"
else
  fail "M4 mismatched npm_config_tag did not fail before registry/content checks (rc=$TAG_RC): $(tail -4 "$SANDBOX/tag.out")"
fi

echo ""
echo "shell-publish-preflight-modes: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
