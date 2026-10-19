#!/usr/bin/env bash
# FLY-127: hermetic contract test for scripts/inject-linear-issue.sh.
# Proves the QA caller binds slot.botName as leadId and renders typed 403
# department-scope diagnostics. No real Bridge, Linear API, or user HOME.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
INJECT="${REPO_ROOT}/scripts/inject-linear-issue.sh"

for tool in jq mktemp; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "SKIP: required tool '$tool' not in PATH" >&2
    exit 0
  }
done

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/inject-lead-id.XXXXXX")"
SLOT=97
SLOT_ROOT="/tmp/flywheel-test-slot-${SLOT}"
OWN_SLOT=0

# A fixed slot path is part of the production contract. Claim it atomically;
# never reuse or remove a directory another process already owns.
if mkdir "$SLOT_ROOT" 2>/dev/null; then
  OWN_SLOT=1
else
  echo "FAIL: refusing to reuse existing ${SLOT_ROOT}" >&2
  rm -rf "$TMP"
  exit 1
fi

cleanup() {
  if [[ "$OWN_SLOT" == "1" ]]; then
    rm -rf "$SLOT_ROOT"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

TEST_HOME="${TMP}/home"
FAKE_BIN="${TMP}/bin"
REAL_MKTEMP="$(command -v mktemp)"
mkdir -p "${TEST_HOME}/.flywheel" "$FAKE_BIN"

jq -n \
  --argjson slot "$SLOT" \
  --argjson port 19997 \
  --arg leadId "qa-slot-97-lead" \
  '{slots: [range(0; $slot) as $i |
    if $i == ($slot - 1)
    then {bridgePort: $port, botName: $leadId}
    else {}
    end]}' > "${TEST_HOME}/.flywheel/test-slots.json"

# Health probes succeed without recording a POST. The start request records
# its -d payload, writes the configured response body, and returns its status.
cat > "${FAKE_BIN}/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -u
for arg in "$@"; do
  if [[ "$arg" == */health ]]; then
    exit 0
  fi
done

out=""
payload=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    -w|-H) shift 2 ;;
    *) shift ;;
  esac
done

printf '%s' "$payload" > "$CURL_CAPTURE"
printf '%s' "$CURL_RESPONSE_BODY" > "$out"
printf '%s' "$CURL_RESPONSE_STATUS"
FAKE_CURL
chmod +x "${FAKE_BIN}/curl"

# BSD `mktemp -t` ignores TMPDIR under the managed sandbox. Keep production's
# call shape while redirecting that one form into the test-owned temp root.
cat > "${FAKE_BIN}/mktemp" <<'FAKE_MKTEMP'
#!/usr/bin/env bash
if [[ "${1:-}" == "-t" ]]; then
  exec "$REAL_MKTEMP" "${TMPDIR%/}/${2}"
fi
exec "$REAL_MKTEMP" "$@"
FAKE_MKTEMP
chmod +x "${FAKE_BIN}/mktemp"

echo "== identity payload =="
CAPTURE_OK="${TMP}/payload-ok.json"
if env \
  PATH="${FAKE_BIN}:${PATH}" \
  HOME="$TEST_HOME" \
  TMPDIR="$TMP" \
  REAL_MKTEMP="$REAL_MKTEMP" \
  CURL_CAPTURE="$CAPTURE_OK" \
  CURL_RESPONSE_STATUS=200 \
  CURL_RESPONSE_BODY='{"success":true,"executionId":"exec-test"}' \
  bash "$INJECT" "$SLOT" "FLY-127" --role qa \
  >"${TMP}/ok.out" 2>"${TMP}/ok.err"; then
  pass "injector accepts the stubbed Bridge response"
else
  fail "injector should succeed: $(cat "${TMP}/ok.err")"
fi

if jq -e \
  --arg issueId "FLY-127" \
  --arg projectName "test-slot-${SLOT}" \
  --arg role "qa" \
  --arg leadId "qa-slot-97-lead" \
  '.issueId == $issueId and
   .projectName == $projectName and
   .sessionRole == $role and
   .leadId == $leadId' \
  "$CAPTURE_OK" >/dev/null 2>&1; then
  pass "POST payload carries issue/project/role plus slot botName as leadId"
else
  fail "POST payload is missing bound identity: $(cat "$CAPTURE_OK" 2>/dev/null)"
fi

echo "== typed department reject =="
CAPTURE_403="${TMP}/payload-403.json"
set +e
env \
  PATH="${FAKE_BIN}:${PATH}" \
  HOME="$TEST_HOME" \
  TMPDIR="$TMP" \
  REAL_MKTEMP="$REAL_MKTEMP" \
  CURL_CAPTURE="$CAPTURE_403" \
  CURL_RESPONSE_STATUS=403 \
  CURL_RESPONSE_BODY='{"success":false,"code":"DEPT_SCOPE_REJECT","reason":"label_mismatch","canonicalLeadId":"ops-lead","silent":false}' \
  bash "$INJECT" "$SLOT" "FLY-366" \
  >"${TMP}/reject.out" 2>"${TMP}/reject.err"
REJECT_RC=$?
set -e

if [[ "$REJECT_RC" -ne 0 ]]; then
  pass "HTTP 403 exits nonzero"
else
  fail "HTTP 403 must not report success"
fi

if grep -q 'code=DEPT_SCOPE_REJECT' "${TMP}/reject.err" &&
   grep -q 'reason=label_mismatch' "${TMP}/reject.err" &&
   grep -q 'canonicalLeadId=ops-lead' "${TMP}/reject.err"; then
  pass "403 stderr includes code, reason, and canonicalLeadId"
else
  fail "typed 403 diagnostics missing: $(cat "${TMP}/reject.err")"
fi

echo
echo "FLY-127 injector identity: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
