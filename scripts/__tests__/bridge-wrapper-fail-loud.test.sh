#!/usr/bin/env bash
# FLY-927 (Task 1.8): flywheel-bridge-wrapper.sh `bp_fail_loud` Discord-leg
# reroute — prefers the gated lead-alert.sh pipeline (kind=bridge_wrapper_fail,
# system identity --project flywheel --lead bridge), keeps the direct-curl
# core-channel FALLBACK when the script is missing or fails (the Bridge is DOWN
# in this path — delivery must never be lost).
#
# Drives the REAL function extracted from the wrapper (sed between its
# signature and closing brace) with fake lead-alert.sh / curl / meta-alert.
set -u

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="${SCRIPT_DIR}/../flywheel-bridge-wrapper.sh"
[[ -f "$WRAPPER" ]] || { echo "[TEST] ✗ wrapper not found"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly927-wrap.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ── Extract the REAL bp_fail_loud from the wrapper (guard: non-empty) ────────
FN_SRC="$(sed -n '/^  bp_fail_loud() {/,/^  }/p' "$WRAPPER")"
[[ -n "$FN_SRC" ]] || { echo "[TEST] ✗ could not extract bp_fail_loud from wrapper"; exit 1; }
grep -q "bridge_wrapper_fail" <<<"$FN_SRC" || { echo "[TEST] ✗ extracted fn lacks the FLY-927 reroute"; exit 1; }

# Seams the function body references.
log() { echo "[test-log] $*"; }
META_ALERT="$TMP/meta-alert.sh"
cat > "$META_ALERT" <<'EOF'
#!/bin/bash
echo "$1" >> "${META_CALLS}"
exit 0
EOF
chmod +x "$META_ALERT"
export META_CALLS="$TMP/meta-calls"

# Fake curl on PATH records fallback posts.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/bash
echo "CURL $*" >> "${CURL_CALLS}"
exit 0
EOF
chmod +x "$TMP/bin/curl"
export CURL_CALLS="$TMP/curl-calls"
export PATH="$TMP/bin:$PATH"

# scenario <name> <lead-alert-mode: ok|fail|absent>
run_scenario() {
  local mode="$1"
  FLYWHEEL_DIR="$TMP/flywheel-$mode"
  mkdir -p "$FLYWHEEL_DIR/scripts"
  export LA_CALLS="$TMP/la-calls-$mode"
  : > "$LA_CALLS"; : > "$CURL_CALLS"; : > "$META_CALLS"
  if [[ "$mode" != "absent" ]]; then
    cat > "$FLYWHEEL_DIR/scripts/lead-alert.sh" <<EOF
#!/bin/bash
echo "\$*" >> "\${LA_CALLS}"
$( [[ "$mode" == "fail" ]] && echo "exit 2" || echo "exit 0" )
EOF
    chmod +x "$FLYWHEEL_DIR/scripts/lead-alert.sh"
  fi
  eval "$FN_SRC"
  SIMBA_BOT_TOKEN="tok" DISCORD_CORE_CHANNEL="core-1" \
    bp_fail_loud "port_stuck" "Title X" "Body Y" >/dev/null 2>&1
}

# ── 1. lead-alert.sh available + succeeds → gated pipeline, NO fallback curl ──
run_scenario ok
grep -q -- "--kind bridge_wrapper_fail" "$LA_CALLS" \
  && pass "S1 routed through lead-alert.sh with kind=bridge_wrapper_fail" \
  || fail "S1 lead-alert.sh not invoked correctly: $(cat "$LA_CALLS")"
grep -q -- "--project flywheel --lead bridge" "$LA_CALLS" \
  && pass "S1 conventional system identity (--project flywheel --lead bridge)" \
  || fail "S1 identity args wrong"
grep -q -- "--signature port_stuck-" "$LA_CALLS" \
  && pass "S1 minute-level reason signature passed" || fail "S1 signature missing"
[[ ! -s "$CURL_CALLS" ]] \
  && pass "S1 no direct-curl fallback when the pipeline succeeded" \
  || fail "S1 fallback curl fired despite pipeline success"
[[ -s "$META_CALLS" ]] \
  && pass "S1 meta-alert leg untouched (still fires)" || fail "S1 meta-alert not fired"

# ── 2. lead-alert.sh FAILS → fallback direct curl to core channel ────────────
run_scenario fail
grep -q -- "--kind bridge_wrapper_fail" "$LA_CALLS" \
  && pass "S2 pipeline attempted first" || fail "S2 pipeline not attempted"
grep -q "channels/core-1/messages" "$CURL_CALLS" \
  && pass "S2 fallback curl posted to the core channel" || fail "S2 fallback curl missing"

# ── 3. lead-alert.sh ABSENT → fallback direct curl ───────────────────────────
run_scenario absent
[[ ! -s "$LA_CALLS" ]] && pass "S3 no pipeline call when script absent" || fail "S3 unexpectedly called"
grep -q "channels/core-1/messages" "$CURL_CALLS" \
  && pass "S3 fallback curl posted (script missing)" || fail "S3 fallback curl missing"

echo ""
echo "[TEST] bridge-wrapper-fail-loud: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
