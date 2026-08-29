#!/bin/bash
# FLY-879: PostCompact hook external early-exit test (mirrors the FLY-231 companion
# case). The global ~/.claude/settings.json PostCompact hook runs
# post-compact-bootstrap.sh for EVERY Lead session. claude-lead.sh skips INSTALLING
# it for external agents, but the already-installed global hook still fires — so the
# stable script itself must early-exit for external (gated on the
# FLYWHEEL_LEAD_EXTERNAL=1 pane marker) BEFORE any bootstrap curl (an external agent
# has no Bridge access and must never receive the engineering bootstrap). Runs the
# REAL script with a fake `curl` on PATH that records invocation, and asserts:
#   - external (marker=1)  → exits 0, curl NEVER called.
#   - standard (no marker) → attempts the bootstrap curl (curl called).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$(cd "${SCRIPT_DIR}/.." && pwd)/post-compact-bootstrap.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

TMP=$(mktemp -d "/tmp/fly879-pc.XXXXXX")
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
  if [ "$marker_env" = "external" ]; then
    env PATH="$TMP/bin:$PATH" CURL_MARKER="$CURL_MARKER" \
      FLYWHEEL_LEAD_ID="anna-interviewer-lead" FLYWHEEL_LEAD_EXTERNAL=1 \
      BRIDGE_URL="http://127.0.0.1:9" bash "$HOOK"
  else
    env PATH="$TMP/bin:$PATH" CURL_MARKER="$CURL_MARKER" \
      FLYWHEEL_LEAD_ID="product-lead" \
      BRIDGE_URL="http://127.0.0.1:9" bash "$HOOK"
  fi
  return $?
}

# ── external: must NOT call curl, must exit 0 ──
run_hook external; rc=$?
[ "$rc" -eq 0 ] && ok "external hook exits 0" || bad "external hook exit ($rc)"
[ -f "$TMP/curl-called" ] && bad "external hook called curl (bootstrap leaked)" || ok "external hook did NOT call curl"

# ── standard: must attempt curl (proves the fake harness + non-external path) ──
run_hook standard; rc=$?
[ "$rc" -eq 0 ] && ok "standard hook exits 0" || bad "standard hook exit ($rc)"
[ -f "$TMP/curl-called" ] && ok "standard hook called curl (bootstrap attempted)" || bad "standard hook did NOT call curl"

rm -rf "$TMP"
echo ""
echo "FLY-879 PostCompact external test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
