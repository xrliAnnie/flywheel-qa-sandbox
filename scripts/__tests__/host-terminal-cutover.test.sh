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
export CUTOVER_TEST_SYSTEM_STAT="$(command -v stat)"
export CUTOVER_TEST_STAT_STYLE="${CUTOVER_TEST_STAT_STYLE:-gnu}"
cat > "$TMP/bin/stat" <<'MOCK'
#!/usr/bin/env bash
set -u
real_stat_value() {
  local kind="$1" path="$2" value=""
  if [[ "$kind" == "mode" ]]; then
    value=$("${CUTOVER_TEST_SYSTEM_STAT:?}" -c %a "$path" 2>/dev/null || true)
    [[ "$value" =~ ^[0-7]{3,4}$ ]] \
      || value=$("$CUTOVER_TEST_SYSTEM_STAT" -f %Lp "$path" 2>/dev/null || true)
  else
    value=$("${CUTOVER_TEST_SYSTEM_STAT:?}" -c %u "$path" 2>/dev/null || true)
    [[ "$value" =~ ^[0-9]+$ ]] \
      || value=$("$CUTOVER_TEST_SYSTEM_STAT" -f %u "$path" 2>/dev/null || true)
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

case "${CUTOVER_TEST_STAT_STYLE:?}" in
  gnu)
    if [[ "${1:-}" == "-c" ]]; then
      case "${2:-}" in
        %a) real_stat_value mode "${3:?}"; exit $? ;;
        %u) real_stat_value owner "${3:?}"; exit $? ;;
      esac
    fi
    if [[ "${1:-}" == "-f" ]]; then
      printf '  File: %s\n  Type: mocked GNU filesystem query\n' "${3:-${2:-unknown}}"
      exit 1
    fi
    ;;
  bsd)
    [[ "${1:-}" != "-c" ]] || exit 1
    if [[ "${1:-}" == "-f" ]]; then
      case "${2:-}" in
        %Lp) real_stat_value mode "${3:?}"; exit $? ;;
        %u) real_stat_value owner "${3:?}"; exit $? ;;
      esac
    fi
    ;;
  *) printf 'unknown CUTOVER_TEST_STAT_STYLE: %s\n' "$CUTOVER_TEST_STAT_STYLE" >&2; exit 2 ;;
esac
exec "${CUTOVER_TEST_SYSTEM_STAT:?}" "$@"
MOCK
chmod +x "$TMP/bin/stat"
export PATH="$TMP/bin:$PATH"

cat > "$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -u
args="$*"
printf '%s\n' "${args//$'\n'/ }" >> "${CUTOVER_TEST_CURL_ARGS:?}"
if [[ "$args" == *"/api/admission/quiescence"* ]]; then
  count_file="${CUTOVER_TEST_CURL_COUNT:?}"
  count=0
  [[ -f "$count_file" ]] && count=$(cat "$count_file")
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file"
  printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1999},"components":{"readoptCandidateSessions":0,"dispatcherInflight":0,"durableLaunchClaims":0,"admissionCrossing":{"start":0,"dispatch":0,"total":0}},"total":0,"quiescent":true}'
elif [[ "$args" == *"/api/admission/resume"* ]]; then
  if [[ "${CUTOVER_TEST_RESUME_LAPSED:-0}" == "1" ]]; then
    printf '%s\n' '{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0,"wasActive":false,"leaseLapsed":true}}'
  else
    printf '%s\n' '{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0,"wasActive":true,"leaseLapsed":false}}'
  fi
elif [[ "$args" == *"-X POST"* && "$args" == *"/api/admission/pause"* ]]; then
  [[ "${CUTOVER_TEST_PAUSE_CONFLICT:-0}" != "1" ]] || exit 22
  if [[ "${CUTOVER_TEST_PAUSE_REACQUIRED:-0}" == "1" ]]; then
    printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":2000,"reacquiredAfterLapse":true,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}'
  else
    printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":2000,"reacquiredAfterLapse":false,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}'
  fi
elif [[ "$args" == *"/api/admission/pause"* ]]; then
  printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1999}}'
else
  printf 'unexpected curl args: %s\n' "$args" >&2
  exit 22
fi
MOCK
chmod +x "$TMP/bin/curl"

cat > "$TMP/bin/git" <<'MOCK'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "${CUTOVER_TEST_GIT_ARGS:?}"
if [[ "$*" == *" fetch "* ]]; then
  exit "${CUTOVER_TEST_GIT_FETCH_RC:-0}"
fi
if [[ "$*" == *"rev-parse origin/main"* ]]; then
  printf '%s\n' "${CUTOVER_TEST_GIT_OBSERVED:?}"
  exit 0
fi
printf 'unexpected git args: %s\n' "$*" >&2
exit 2
MOCK
chmod +x "$TMP/bin/git"

export CUTOVER_CURL_BIN="$TMP/bin/curl"
export CUTOVER_GIT_BIN="$TMP/bin/git"
export CUTOVER_TEST_CURL_COUNT="$TMP/curl-count"
export CUTOVER_TEST_CURL_ARGS="$TMP/curl-args"
export CUTOVER_TEST_GIT_ARGS="$TMP/git-args"
export FLYWHEEL_HOST_CUTOVER_RECEIPT="$TMP/receipt.json"
export TEAMLEAD_API_TOKEN="test-token"
export FLYWHEEL_BRIDGE_URL="http://127.0.0.1:9999"
export CUTOVER_QUIESCENCE_INTERVAL_SECONDS=0
: > "$CUTOVER_TEST_CURL_ARGS"
: > "$CUTOVER_TEST_GIT_ARGS"

echo "Test: shipped Bridge endpoint matches the production control API"
if grep -qF 'BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:9876}"' "$SCRIPT"; then
  pass "default Bridge endpoint is the production 9876 listener"
else
  fail "default Bridge endpoint is stale"
fi

echo "Test: pause receipt is active and protected by two clocks"
if "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason test >/dev/null \
  && jq -e '.status == "paused"
    and .pause.leaseId == "123e4567-e89b-42d3-a456-426614174000"
    and .pause.expiryMonotonicSeconds > .pause.startedMonotonicSeconds
    and .pause.expiryWallClockEpochSeconds > .pause.startedWallClockEpochSeconds' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "authenticated pause writes its owner id into the dual-clock receipt"
else
  fail "pause receipt contract"
fi

echo "Test: pause output does not expose the owner capability"
pause_public_output=$("$SCRIPT" pause-admission \
  --duration 2000 --minimum 1770 --reason public-output)
if printf '%s\n' "$pause_public_output" | jq -e \
  '.ok == true
    and .admissionPause.active == true
    and .admissionPause.remainingSeconds == 2000
    and (.admissionPause | has("leaseId") | not)' >/dev/null \
  && [[ "$pause_public_output" != *"123e4567-e89b-42d3-a456-426614174000"* ]]; then
  pass "pause output is redacted to public admission status"
else
  fail "pause output exposed its owner lease: $pause_public_output"
fi

echo "Test: renewal reuses the receipt owner and survives authoritative inspect"
if "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason renewal >/dev/null \
  && grep '/api/admission/pause' "$CUTOVER_TEST_CURL_ARGS" | tail -1 \
    | grep -q 'leaseId.*123e4567-e89b-42d3-a456-426614174000' \
  && "$SCRIPT" inspect-admission >/dev/null \
  && jq -e '.status == "paused"
    and .pause.leaseId == "123e4567-e89b-42d3-a456-426614174000"' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "same owner renews and inspect does not erase the durable capability"
else
  fail "pause renewal/inspect ownership contract"
fi

echo "Test: renewal after lease lapse records the continuity breach without exposing the owner"
lapse_public_output=$(CUTOVER_TEST_PAUSE_REACQUIRED=1 \
  "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason lapse)
lapse_rc=$?
if [[ "$lapse_rc" == "3" ]] \
  && printf '%s\n' "$lapse_public_output" | jq -e \
  '.admissionPause.reacquiredAfterLapse == true
    and (.admissionPause | has("leaseId") | not)' >/dev/null \
  && jq -e '.pause.reacquiredAfterLapse == true
    and .events[-1].kind == "pause"
    and .events[-1].reacquiredAfterLapse == true' \
    "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null \
  && [[ "$lapse_public_output" != *"123e4567-e89b-42d3-a456-426614174000"* ]]; then
  pass "lease lapse is durable and public while the owner capability stays redacted"
else
  fail "lease lapse signal was lost or exposed its owner"
fi

echo "Test: a restart-takeover lapse remains sticky across a later healthy renewal"
sticky_public_output=$(CUTOVER_TEST_PAUSE_REACQUIRED=0 \
  "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason sticky-lapse)
sticky_rc=$?
if [[ "$sticky_rc" == "3" ]] \
  && printf '%s\n' "$sticky_public_output" | jq -e \
    '.admissionPause.reacquiredAfterLapse == true' >/dev/null \
  && jq -e '.pause.reacquiredAfterLapse == true' \
    "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "historical admission lapse cannot be erased by a healthy renewal"
else
  fail "healthy renewal erased the historical admission lapse"
fi

echo "Test: foreign pause conflict preserves the owned receipt"
pause_before_conflict=$(jq -c '{status,pause}' "$FLYWHEEL_HOST_CUTOVER_RECEIPT")
if CUTOVER_TEST_PAUSE_CONFLICT=1 \
  "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason foreign >/dev/null 2>&1; then
  fail "foreign pause conflict returned success"
elif [[ "$(jq -c '{status,pause}' "$FLYWHEEL_HOST_CUTOVER_RECEIPT")" == "$pause_before_conflict" ]]; then
  pass "foreign conflict cannot overwrite the owned receipt"
else
  fail "foreign conflict mutated the owned receipt"
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
  && grep '/api/admission/resume' "$CUTOVER_TEST_CURL_ARGS" | tail -1 \
    | grep -q 'leaseId.*123e4567-e89b-42d3-a456-426614174000' \
  && jq -e '.status == "resumed" and .events[-1].kind == "resume"' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
  pass "owner-qualified resume records the distinct active=false predicate"
else
  fail "resume predicate"
fi

echo "Test: resume after expiry records that the admission lease lapsed"
jq '.status = "paused"' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" > "$TMP/lapsed-resume.json"
mv "$TMP/lapsed-resume.json" "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
chmod 600 "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
if CUTOVER_TEST_RESUME_LAPSED=1 "$SCRIPT" resume-admission >/dev/null; then
  fail "expired resume returned a clean success code"
else
  lapsed_resume_rc=$?
  if [[ "$lapsed_resume_rc" == "3" ]] \
    && jq -e '.status == "resumed"
    and .resume.wasActive == false
    and .resume.leaseLapsed == true
    and .events[-1].kind == "resume"
    and .events[-1].leaseLapsed == true' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
    pass "expired resume preserves a durable lease-lapse signal and non-zero status"
  else
    fail "expired resume hid the admission continuity breach"
  fi
fi

echo "Test: restart lease handoff is imported, renewed, and cleared only after resume"
handoff="$TMP/host-terminal-cutover.admission-lease-id"
jq '.status = "paused" | .pause = {leaseId:null,remainingSeconds:1800}' \
  "$FLYWHEEL_HOST_CUTOVER_RECEIPT" > "$TMP/legacy-receipt.json"
mv "$TMP/legacy-receipt.json" "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
chmod 600 "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
printf '%s\n' '123e4567-e89b-42d3-a456-426614174000' > "$handoff"
chmod 600 "$handoff"
if "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason handoff >/dev/null \
  && grep '/api/admission/pause' "$CUTOVER_TEST_CURL_ARGS" | tail -1 \
    | grep -q 'leaseId.*123e4567-e89b-42d3-a456-426614174000' \
  && jq -e '.status == "paused"
    and .pause.leaseId == "123e4567-e89b-42d3-a456-426614174000"' \
    "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null \
  && [[ -f "$handoff" ]] \
  && "$SCRIPT" resume-admission >/dev/null \
  && [[ ! -e "$handoff" ]]; then
  pass "host transaction imports the restart owner through GNU stat fallback and clears it after release"
else
  fail "restart-to-host lease handoff contract"
fi

echo "Test: legacy paused receipt without the owner handoff fails before API mutation"
jq '.status = "paused" | .pause = {leaseId:null,remainingSeconds:1800}' \
  "$FLYWHEEL_HOST_CUTOVER_RECEIPT" > "$TMP/missing-handoff-receipt.json"
mv "$TMP/missing-handoff-receipt.json" "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
chmod 600 "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
pause_calls_before=$(grep -c '/api/admission/pause' "$CUTOVER_TEST_CURL_ARGS" || true)
resume_calls_before=$(grep -c '/api/admission/resume' "$CUTOVER_TEST_CURL_ARGS" || true)
if "$SCRIPT" pause-admission --duration 2000 --minimum 1770 --reason missing >/dev/null 2>&1; then
  fail "legacy receipt without handoff acquired a new lease"
else
  pause_calls_after=$(grep -c '/api/admission/pause' "$CUTOVER_TEST_CURL_ARGS" || true)
  resume_calls_after=$(grep -c '/api/admission/resume' "$CUTOVER_TEST_CURL_ARGS" || true)
  if [[ "$pause_calls_after" == "$pause_calls_before" \
    && "$resume_calls_after" == "$resume_calls_before" ]]; then
    pass "missing owner handoff fails closed without pause or resume requests"
  else
    fail "missing owner handoff reached the admission API"
  fi
fi
jq '.status = "resumed"' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" > "$TMP/post-handoff.json"
mv "$TMP/post-handoff.json" "$FLYWHEEL_HOST_CUTOVER_RECEIPT"
chmod 600 "$FLYWHEEL_HOST_CUTOVER_RECEIPT"

echo "Test: assert-main-sha fetches before comparison and preserves transaction state"
expected_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export CUTOVER_TEST_GIT_OBSERVED="$expected_sha"
state_before_sha=$(jq -c '{status,pause}' "$FLYWHEEL_HOST_CUTOVER_RECEIPT")
if "$SCRIPT" assert-main-sha --expected "$expected_sha" >/dev/null \
  && jq -e --arg expected "$expected_sha" '.events[-1].kind == "assert-main-sha"
    and .events[-1].expected == $expected
    and .events[-1].observed == $expected
    and .events[-1].passed == true' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null \
  && [[ "$(jq -c '{status,pause}' "$FLYWHEEL_HOST_CUTOVER_RECEIPT")" == "$state_before_sha" ]] \
  && [[ "$(tail -2 "$CUTOVER_TEST_GIT_ARGS")" == *"fetch --quiet origin refs/heads/main:refs/remotes/origin/main"*$'\n'*"rev-parse origin/main" ]]; then
  pass "bounded fresh origin/main match is receipted without changing pause state"
else
  fail "assert-main-sha success contract"
fi

echo "Test: assert-main-sha mismatch records observed and fails closed"
mismatch_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export CUTOVER_TEST_GIT_OBSERVED="$mismatch_sha"
if "$SCRIPT" assert-main-sha --expected "$expected_sha" >/dev/null 2>&1; then
  fail "assert-main-sha accepted a mismatch"
elif jq -e --arg expected "$expected_sha" --arg observed "$mismatch_sha" \
  '.events[-1].expected == $expected and .events[-1].observed == $observed
    and .events[-1].passed == false' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null \
  && [[ "$(jq -c '{status,pause}' "$FLYWHEEL_HOST_CUTOVER_RECEIPT")" == "$state_before_sha" ]]; then
  pass "mismatch evidence is durable and transaction state is unchanged"
else
  fail "assert-main-sha mismatch receipt"
fi

echo "Test: fetch failure cannot pass from a stale origin/main ref"
rev_parse_before=$(grep -c 'rev-parse origin/main' "$CUTOVER_TEST_GIT_ARGS" || true)
if CUTOVER_TEST_GIT_FETCH_RC=9 \
  "$SCRIPT" assert-main-sha --expected "$expected_sha" >/dev/null 2>&1; then
  fail "assert-main-sha accepted a failed fetch"
else
  rev_parse_after=$(grep -c 'rev-parse origin/main' "$CUTOVER_TEST_GIT_ARGS" || true)
  if [[ "$rev_parse_after" == "$rev_parse_before" ]] \
    && jq -e '.events[-1].kind == "assert-main-sha"
      and .events[-1].observed == null and .events[-1].passed == false' \
      "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null; then
    pass "failed fetch records failure without reading the stale ref"
  else
    fail "failed fetch consulted stale origin/main or missed its receipt"
  fi
fi

echo "Test: assert-main-sha rejects missing and malformed expected SHA"
if "$SCRIPT" assert-main-sha >/dev/null 2>&1 \
  || "$SCRIPT" assert-main-sha --expected not-a-sha >/dev/null 2>&1; then
  fail "assert-main-sha accepted missing or malformed expected input"
elif [[ "$(jq -c '{status,pause}' "$FLYWHEEL_HOST_CUTOVER_RECEIPT")" == "$state_before_sha" ]]; then
  pass "invalid expected SHA fails before transaction state mutation"
else
  fail "invalid expected SHA changed transaction state"
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
printf '%s\n' "$*" >"${CUTOVER_TEST_PGREP_ARGS:?}"
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
CUTOVER_TEST_PGREP_ARGS="$TMP/pgrep.args"
export CUTOVER_TEST_PGREP_ARGS
if "$SCRIPT" preflight-receipt >/dev/null \
  && jq -e '.status == "preparatory"
    and .preflight.extractorPositiveControl.passed == true
    and .preflight.processInventory == []
    and .preflight.missingBottleCount == 0' "$FLYWHEEL_HOST_CUTOVER_RECEIPT" >/dev/null \
  && [ "$(cat "$CUTOVER_TEST_PGREP_ARGS")" = '-a -x tmux' ]; then
  pass "preflight records exact extractor proof and complete cached dependencies"
else
  fail "preflight extractor and bottle receipt"
fi

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
