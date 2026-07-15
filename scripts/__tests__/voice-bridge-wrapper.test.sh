#!/usr/bin/env bash
# FLY-545 P6: voice-bridge wrapper discipline checks. The port-preflight LOGIC
# is hermetically tested in bridge-port.test.sh (shared lib); this test pins
# the WRAPPER's own contract lines so a refactor cannot silently drop one of
# the Bridge-wrapper disciplines (Codex R1 #7): fail-closed host-config, .env
# sourcing with set -a, launchd PATH expansion, port preflight wiring, PID
# guard, and exec handover.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="${SCRIPT_DIR}/../flywheel-voice-bridge-wrapper.sh"
PLIST="${SCRIPT_DIR}/../launchd/com.flywheel.voice-bridge.plist"

[[ -f "$WRAPPER" ]] && pass "wrapper exists" || fail "wrapper missing: $WRAPPER"
[[ -f "$PLIST" ]] && pass "plist exists" || fail "plist missing: $PLIST"

# syntax must parse
if bash -n "$WRAPPER" 2>/dev/null; then pass "bash -n parses"; else fail "bash -n parse error"; fi

check() { # <desc> <pattern>
  if grep -qE "$2" "$WRAPPER"; then pass "$1"; else fail "$1 (missing: $2)"; fi
}

check "strict mode" '^set -euo pipefail'
check "fail-closed host-config" 'host_config_load'
check "env file fail-fast" 'ENV_FILE'
check ".env sourced with set -a" '^set -a'
check "launchd PATH expansion" '/opt/homebrew/bin'
check "port preflight via shared lib" 'bp_launcher_preflight'
check "double-start guard exits 0 on healthy peer" 'already-healthy'
check "stuck port refuses to start" 'stuck\)'
check "PID guard file" 'voice-bridge\.pid'
check "PID cleanup trap" "trap 'rm -f"
check "exec handover to tsx entry" '^exec npx tsx scripts/run-voice-bridge.ts'

# plist discipline
if grep -q '<key>KeepAlive</key><true/>' "$PLIST"; then pass "plist KeepAlive"; else fail "plist KeepAlive"; fi
if grep -q '<key>ThrottleInterval</key>' "$PLIST"; then pass "plist ThrottleInterval"; else fail "plist ThrottleInterval"; fi
if grep -q 'flywheel-voice-bridge-wrapper.sh' "$PLIST"; then pass "plist points at wrapper"; else fail "plist wrapper path"; fi

# secrets must never be inlined: the wrapper may reference env NAMES only
if grep -qE '(BOT_TOKEN|API_KEY)=[A-Za-z0-9]' "$WRAPPER"; then fail "no literal secrets in wrapper"; else pass "no literal secrets in wrapper"; fi

echo
echo "[voice-bridge-wrapper.test] passed=$PASSED failed=$FAILED"
[[ $FAILED -eq 0 ]] || exit 1
