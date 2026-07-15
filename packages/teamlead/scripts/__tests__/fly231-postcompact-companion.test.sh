#!/bin/bash
# FLY-231: PostCompact hook companion early-exit test (Codex R3 BLOCKER-2).
#
# The global ~/.claude/settings.json PostCompact hook runs post-compact-bootstrap.sh
# for EVERY Lead session. claude-lead.sh skips INSTALLING it for companions, but the
# already-installed global hook still fires — so the stable script itself must
# early-exit for companions (gated on the FLYWHEEL_LEAD_COMPANION=1 pane marker)
# BEFORE any bootstrap curl. This test runs the REAL script with a fake `curl` on
# PATH that records invocation, and asserts:
#   - companion (marker=1)  → exits 0, curl NEVER called.
#   - standard (no marker)  → attempts the bootstrap curl (curl called).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$(cd "${SCRIPT_DIR}/.." && pwd)/post-compact-bootstrap.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

TMP=$(mktemp -d "/tmp/fly231-pc.XXXXXX")
# Fake curl: records that it was called, then succeeds with an HTTP 200 trailer
# (matches the `-w '\n%{http_code}'` the hook expects).
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'FAKE'
#!/bin/bash
echo "called" >> "$CURL_MARKER"
printf '\n200\n'
exit 0
FAKE
chmod +x "$TMP/bin/curl"

run_hook() { # marker_value
  local marker_env="$1"
  CURL_MARKER="$TMP/curl-called"
  rm -f "$CURL_MARKER"
  if [ "$marker_env" = "companion" ]; then
    env PATH="$TMP/bin:$PATH" CURL_MARKER="$CURL_MARKER" \
      FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_LEAD_COMPANION=1 \
      BRIDGE_URL="http://127.0.0.1:9" bash "$HOOK"
  else
    env PATH="$TMP/bin:$PATH" CURL_MARKER="$CURL_MARKER" \
      FLYWHEEL_LEAD_ID="product-lead" \
      BRIDGE_URL="http://127.0.0.1:9" bash "$HOOK"
  fi
  return $?
}

# ── companion: must NOT call curl, must exit 0 ──
run_hook companion; rc=$?
[ "$rc" -eq 0 ] && ok "companion hook exits 0" || bad "companion hook exit ($rc)"
[ -f "$TMP/curl-called" ] && bad "companion hook called curl (bootstrap leaked)" || ok "companion hook did NOT call curl"

# ── standard: must attempt curl (proves the fake harness + non-companion path) ──
run_hook standard; rc=$?
[ "$rc" -eq 0 ] && ok "standard hook exits 0" || bad "standard hook exit ($rc)"
[ -f "$TMP/curl-called" ] && ok "standard hook called curl (bootstrap attempted)" || bad "standard hook did NOT call curl"

rm -rf "$TMP"
echo ""
echo "FLY-231 PostCompact companion test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
