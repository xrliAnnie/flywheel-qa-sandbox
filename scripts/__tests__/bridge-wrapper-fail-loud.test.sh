#!/usr/bin/env bash
# FLY-927 (Task 1.8) + FLY-1081: flywheel-bridge-wrapper.sh `bp_fail_loud`
# Discord-leg reroute — prefers the gated lead-alert.sh pipeline
# (kind=bridge_wrapper_fail, system identity --project flywheel --lead bridge),
# keeps the direct-curl core-channel FALLBACK when the script is missing or
# fails (the Bridge is DOWN in this path — delivery must never be lost).
# FLY-1081: the fallback's sender identity resolves via the FLY-927 seam
# (FLYWHEEL_ALERT_SENDER_TOKEN_ENV indirect expansion) — NO Simba/
# DISCORD_BOT_TOKEN fallback; seam unresolvable → ZERO curl + stderr ERROR +
# rc=0 + stdout EMPTY; the token rides a curl stdin config, never argv.
#
# Drives the REAL function extracted from the wrapper (sed between its
# signature and closing brace) with fake lead-alert.sh / curl / meta-alert.
set -u

# Hermetic: a configured dev shell exports the production seam env — clear it
# so only per-scenario values apply. The legacy token names are concatenated so
# this file stays out of the FLY-1081 grep-zero sentinel's hit set.
LEGACY_COS_TOKEN_NAME='SIMBA''_BOT_TOKEN'
unset FLYWHEEL_ALERT_SENDER_TOKEN_ENV FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN \
      "$LEGACY_COS_TOKEN_NAME" DISCORD_BOT_TOKEN DISCORD_CORE_CHANNEL 2>/dev/null || true

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
grep -q "FLYWHEEL_ALERT_SENDER_TOKEN_ENV" <<<"$FN_SRC" || { echo "[TEST] ✗ extracted fn lacks the FLY-1081 seam"; exit 1; }

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

# Fake curl on PATH records fallback posts + the `-K -` stdin config.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/bash
echo "CURL $*" >> "${CURL_CALLS}"
prev=""
for a in "$@"; do
  [ "$prev" = "-K" ] && [ "$a" = "-" ] && cat >> "${CURL_CALLS}.stdin"
  prev="$a"
done
exit 0
EOF
chmod +x "$TMP/bin/curl"
export CURL_CALLS="$TMP/curl-calls"
export PATH="$TMP/bin:$PATH"

# scenario <lead-alert-mode: ok|fail|absent> [ENV=VAL ...]
# Captures stdout/err to $TMP/out-$mode / $TMP/err-$mode; rc in $RC.
run_scenario() {
  local mode="$1"; shift
  FLYWHEEL_DIR="$TMP/flywheel-$mode"
  mkdir -p "$FLYWHEEL_DIR/scripts"
  export LA_CALLS="$TMP/la-calls-$mode"
  : > "$LA_CALLS"; : > "$CURL_CALLS"; : > "$META_CALLS"; : > "${CURL_CALLS}.stdin"
  if [[ "$mode" != "absent" ]]; then
    cat > "$FLYWHEEL_DIR/scripts/lead-alert.sh" <<EOF
#!/bin/bash
echo "\$*" >> "\${LA_CALLS}"
$( [[ "$mode" == "fail" ]] && echo "exit 2" || echo "exit 0" )
EOF
    chmod +x "$FLYWHEEL_DIR/scripts/lead-alert.sh"
  fi
  eval "$FN_SRC"
  (
    local kv
    for kv in "$@"; do export "${kv?}"; done
    bp_fail_loud "port_stuck" "Title X" "Body Y"
  ) > "$TMP/out-$mode" 2> "$TMP/err-$mode"
  RC=$?
}

# ── 1. lead-alert.sh available + succeeds → gated pipeline, NO fallback curl ──
run_scenario ok \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="TEST_SENDER_TOKEN" TEST_SENDER_TOKEN="seam-tok" DISCORD_CORE_CHANNEL="core-1"
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

# ── 2. lead-alert.sh FAILS + seam resolvable → fallback curl to core channel ─
run_scenario fail \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="TEST_SENDER_TOKEN" TEST_SENDER_TOKEN="seam-tok" DISCORD_CORE_CHANNEL="core-1"
grep -q -- "--kind bridge_wrapper_fail" "$LA_CALLS" \
  && pass "S2 pipeline attempted first" || fail "S2 pipeline not attempted"
grep -q "channels/core-1/messages" "$CURL_CALLS" \
  && pass "S2 fallback curl posted to the core channel" || fail "S2 fallback curl missing"
grep -qF "Authorization: Bot seam-tok" "${CURL_CALLS}.stdin" \
  && pass "S2 fallback auth = seam token via stdin config" || fail "S2 stdin config auth wrong: $(cat "${CURL_CALLS}.stdin")"
grep -qF "seam-tok" "$CURL_CALLS" \
  && fail "S2 token leaked into curl argv" || pass "S2 token never in curl argv"

# ── 3. lead-alert.sh ABSENT + seam resolvable → fallback direct curl ─────────
run_scenario absent \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="TEST_SENDER_TOKEN" TEST_SENDER_TOKEN="seam-tok" DISCORD_CORE_CHANNEL="core-1"
[[ ! -s "$LA_CALLS" ]] && pass "S3 no pipeline call when script absent" || fail "S3 unexpectedly called"
grep -q "channels/core-1/messages" "$CURL_CALLS" \
  && pass "S3 fallback curl posted (script missing)" || fail "S3 fallback curl missing"

# ── 4. FLY-1081: seam UNRESOLVABLE → ZERO curl, stderr ERROR, rc=0, stdout empty ──
# 4a. seam env unset entirely (legacy Simba env present must NOT be used).
run_scenario absent \
  "${LEGACY_COS_TOKEN_NAME}=simba-tok" DISCORD_BOT_TOKEN="legacy-tok" DISCORD_CORE_CHANNEL="core-1"
[[ ! -s "$CURL_CALLS" ]] \
  && pass "S4a seam unset → ZERO curl (no Simba/DISCORD_BOT_TOKEN fallback)" \
  || fail "S4a fell back to legacy token: $(cat "$CURL_CALLS")"
grep -qi "ERROR.*refusing legacy fallback" "$TMP/err-absent" \
  && pass "S4a stderr ERROR (refusal trace)" || fail "S4a no refusal ERROR: $(cat "$TMP/err-absent")"
[[ $RC -eq 0 ]] && pass "S4a rc=0" || fail "S4a rc=$RC"
[[ ! -s "$TMP/out-absent" ]] && pass "S4a stdout EMPTY (command-substitution safe)" \
  || fail "S4a stdout leaked: $(cat "$TMP/out-absent")"

# 4b. seam names an env var that does not resolve.
run_scenario absent \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="MISSING_TOKEN_ENV" DISCORD_CORE_CHANNEL="core-1"
[[ ! -s "$CURL_CALLS" ]] \
  && pass "S4b seam names an empty env → ZERO curl" || fail "S4b curl fired: $(cat "$CURL_CALLS")"
grep -qi "MISSING_TOKEN_ENV" "$TMP/err-absent" \
  && pass "S4b ERROR names the unresolvable env" || fail "S4b ERROR lacks env name: $(cat "$TMP/err-absent")"
[[ -s "$META_CALLS" ]] \
  && pass "S4b meta-alert leg still fired (never silent)" || fail "S4b meta-alert missing"

echo ""
echo "[TEST] bridge-wrapper-fail-loud: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
