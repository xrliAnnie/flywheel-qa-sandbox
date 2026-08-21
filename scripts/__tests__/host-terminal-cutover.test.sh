#!/usr/bin/env bash
# FLY-1944: hermetic contract tests for the founder-gated host cutover CLI.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/host-terminal-cutover.sh"
TMP="$(mktemp -d -t fly1944-cutover.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -u
args="$*"
if [[ "$args" == *"/api/admission/quiescence"* ]]; then
  count_file="${CUTOVER_TEST_CURL_COUNT:?}"
  count=0
  [[ -f "$count_file" ]] && count=$(cat "$count_file")
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file"
  printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1999},"components":{"readoptCandidateSessions":0,"dispatcherInflight":0,"durableLaunchClaims":0,"admissionCrossing":{"start":0,"dispatch":0,"total":0}},"total":0,"quiescent":true}'
elif [[ "$args" == *"/api/admission/resume"* ]]; then
  printf '%s\n' '{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0}}'
elif [[ "$args" == *"-X POST"* && "$args" == *"/api/admission/pause"* ]]; then
  printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":2000}}'
elif [[ "$args" == *"/api/admission/pause"* ]]; then
  printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1999}}'
else
  printf 'unexpected curl args: %s\n' "$args" >&2
  exit 22
fi
MOCK
chmod +x "$TMP/bin/curl"

export CUTOVER_CURL_BIN="$TMP/bin/curl"
export CUTOVER_TEST_CURL_COUNT="$TMP/curl-count"
export FLYWHEEL_HOST_CUTOVER_RECEIPT="$TMP/receipt.json"
export TEAMLEAD_API_TOKEN="test-token"
export FLYWHEEL_BRIDGE_URL="http://127.0.0.1:9999"
export CUTOVER_QUIESCENCE_INTERVAL_SECONDS=0

echo "Test: pause receipt is active and protected by two clocks"
if "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason test >/dev/null \
  && jq -e '.status == "paused"
    and .pause.expiryMonotonicSeconds > .pause.startedMonotonicSeconds
    and .pause.expiryWallClockEpochSeconds > .pause.startedWallClockEpochSeconds' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "authenticated pause writes a dual-clock machine receipt"
else
  fail "pause receipt contract"
fi

echo "Test: caller cannot weaken the fixed initial budget"
if "$SCRIPT" pause-admission --duration 2000 --minimum 1700 --reason test >/dev/null 2>&1; then
  fail "pause accepted a minimum below the fixed transaction budget"
else
  pass "fixed transaction budget cannot be overridden downward"
fi

echo "Test: quiescence requires two consecutive authoritative zero snapshots"
if "$SCRIPT" quiescence >/dev/null \
  && [[ "$(cat "$CUTOVER_TEST_CURL_COUNT")" == "2" ]] \
  && jq -e '.events[-1].kind == "quiescence" and .events[-1].stableZero == true' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "two stable-zero polls are recorded"
else
  fail "stable-zero quiescence contract"
fi

echo "Test: bounded run-step records success and enforces receipt budget"
if "$SCRIPT" run-step --name brew-upgrade --timeout 2 -- /usr/bin/true >/dev/null \
  && jq -e '.events[-1].kind == "run-step" and .events[-1].status == "completed"' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "run-step records the bounded command outcome"
else
  fail "run-step success receipt"
fi

echo "Test: bounded run-step records timeout evidence"
if "$SCRIPT" run-step --name automated-verification --timeout 1 -- /bin/sleep 5 >/dev/null 2>&1; then
  fail "timed-out command returned success"
elif jq -e '.events[-1].kind == "run-step"
  and .events[-1].status == "timeout"
  and .events[-1].exitCode == 124' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "timeout is process-bounded and recorded in the receipt"
else
  fail "timeout receipt evidence"
fi

echo "Test: insufficient budget fails closed before a command starts"
now=$(python3 -c 'import time; print(int(time.monotonic()))')
jq --argjson expiry "$((now + 100))" '.pause.expiryMonotonicSeconds = $expiry' \
  "$FLYWHEEL_HOST_CUTOVER_RECEIPT" > "$TMP/short.json"
mv "$TMP/short.json" "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
touch "$TMP/must-not-run"
rm "$TMP/must-not-run"
if "$SCRIPT" run-step --name brew-upgrade --timeout 2 -- /usr/bin/touch "$TMP/must-not-run" >/dev/null 2>&1; then
  fail "short receipt incorrectly admitted a destructive step"
elif [[ ! -e "$TMP/must-not-run" ]]; then
  pass "budget rejection happens before command execution"
else
  fail "command ran despite budget rejection"
fi

echo "Test: resume verifies active=false"
if "$SCRIPT" resume-admission >/dev/null \
  && jq -e '.status == "resumed" and .events[-1].kind == "resume"' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "resume receipt records the distinct active=false predicate"
else
  fail "resume predicate"
fi

echo "Test: preflight proves the exact image extractor and bottle manifest"
mkdir -p "$TMP/.flywheel/backup/tmux-3.5a/bin" "$TMP/tmux-3.7c/bin" "$TMP/cache"
cat > "$TMP/.flywheel/backup/tmux-3.5a/bin/tmux" <<'MOCK_TMUX'
#!/usr/bin/env bash
if [[ "${1:-}" == "-V" ]]; then printf 'tmux 3.5a\n'; exit 0; fi
if [[ "$*" == *"display-message"* ]]; then printf '12345\n'; exit 0; fi
exit 0
MOCK_TMUX
cat > "$TMP/tmux-3.7c/bin/tmux" <<'MOCK_TMUX'
#!/usr/bin/env bash
if [[ "${1:-}" == "-V" ]]; then printf 'tmux 3.7c\n'; exit 0; fi
exit 0
MOCK_TMUX
cat > "$TMP/bin/lsof" <<'MOCK_LSOF'
#!/usr/bin/env bash
printf 'p12345\n'
printf 'n%s\n' "${FLYWHEEL_TMUX_3_5A_BIN:?}"
MOCK_LSOF
cat > "$TMP/bin/pgrep" <<'MOCK_PGREP'
#!/usr/bin/env bash
exit 1
MOCK_PGREP
cat > "$TMP/bin/file" <<'MOCK_FILE'
#!/usr/bin/env bash
printf 'Mach-O 64-bit executable arm64\n'
MOCK_FILE
cat > "$TMP/bin/brew" <<'MOCK_BREW'
#!/usr/bin/env bash
case "${1:-}" in
  --prefix) printf '%s\n' "${CUTOVER_TEST_BREW_PREFIX:?}" ;;
  deps) printf 'libevent\n' ;;
  --cache) printf '%s/%s.bottle\n' "${CUTOVER_TEST_CACHE_DIR:?}" "${2:?}" ;;
  *) exit 1 ;;
esac
MOCK_BREW
chmod +x "$TMP/.flywheel/backup/tmux-3.5a/bin/tmux" "$TMP/tmux-3.7c/bin/tmux" \
  "$TMP/bin/lsof" "$TMP/bin/pgrep" "$TMP/bin/file" "$TMP/bin/brew"
touch "$TMP/cache/tmux.bottle" "$TMP/cache/libevent.bottle"
export PATH="$TMP/bin:$PATH"
export FLYWHEEL_TMUX_3_5A_BIN="$TMP/.flywheel/backup/tmux-3.5a/bin/tmux"
export FLYWHEEL_TMUX_3_7C_BIN="$TMP/tmux-3.7c/bin/tmux"
export FLYWHEEL_INTEL_BREW_BIN="$TMP/bin/brew"
export FLYWHEEL_ARM_BREW_BIN="$TMP/bin/brew"
export CUTOVER_TEST_BREW_PREFIX="$TMP/brew-prefix"
export CUTOVER_TEST_CACHE_DIR="$TMP/cache"
if "$SCRIPT" preflight-receipt >/dev/null \
  && jq -e '.status == "preparatory"
    and .preflight.extractorPositiveControl.passed == true
    and .preflight.processInventory == []
    and .preflight.missingBottleCount == 0' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "preflight records exact extractor proof and complete cached dependencies"
else
  fail "preflight extractor and bottle receipt"
fi

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
