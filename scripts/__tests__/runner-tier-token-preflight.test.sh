#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/runner-tier-token-preflight.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1715-token-preflight.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

run_case() {
  local name="$1" content="$2"
  local env_file="$ROOT/$name.env"
  printf '%s\n' "$content" > "$env_file"
  set +e
  CASE_OUTPUT="$(TEAMLEAD_API_TOKEN=inherited-master \
    TEAMLEAD_INGEST_TOKEN=inherited-ingest \
    TEAMLEAD_GEMINI_AGENT_TOKEN=inherited-gemini \
    bash "$SCRIPT" "$env_file" 2>"$ROOT/$name.err")"
  CASE_RC=$?
  set -e
}

run_case valid 'TEAMLEAD_API_TOKEN=master-secret
TEAMLEAD_INGEST_TOKEN=ingest-secret
TEAMLEAD_GEMINI_AGENT_TOKEN=gemini-secret'
[[ "$CASE_RC" == 0 ]] && pass "valid three-tier configuration passes" || fail "valid rc=$CASE_RC"
jq -e '.master_present and .ingest_present and .gemini_present and .pairwise_distinct and (.master_padded == false) and .ok' <<<"$CASE_OUTPUT" >/dev/null \
  && pass "valid output contains only required boolean verdicts" || fail "valid output=$CASE_OUTPUT"
if grep -qE 'master-secret|ingest-secret|gemini-secret' <<<"$CASE_OUTPUT"; then
  fail "valid output leaks token bytes"
else
  pass "valid output never echoes token bytes"
fi

run_case missing 'UNRELATED=value'
[[ "$CASE_RC" != 0 ]] && pass "missing required tokens fails" || fail "missing tokens passed"
jq -e '(.master_present == false) and (.ingest_present == false) and (.gemini_present == false) and (.ok == false)' <<<"$CASE_OUTPUT" >/dev/null \
  && pass "inherited credentials cannot mask an empty config file" || fail "missing output=$CASE_OUTPUT"

run_case padded 'TEAMLEAD_API_TOKEN=" padded-master "
TEAMLEAD_INGEST_TOKEN=ingest-secret'
[[ "$CASE_RC" != 0 ]] && pass "outer whitespace on master fails" || fail "padded master passed"
jq -e '.master_present and .ingest_present and .master_padded and (.ok == false)' <<<"$CASE_OUTPUT" >/dev/null \
  && pass "master_padded verdict is explicit" || fail "padded output=$CASE_OUTPUT"

run_case collision 'TEAMLEAD_API_TOKEN=master-secret
TEAMLEAD_INGEST_TOKEN=" master-secret "
TEAMLEAD_GEMINI_AGENT_TOKEN=gemini-secret'
[[ "$CASE_RC" != 0 ]] && pass "normalized credential collision fails" || fail "collision passed"
jq -e '(.pairwise_distinct == false) and (.ok == false)' <<<"$CASE_OUTPUT" >/dev/null \
  && pass "collision output reports only the boolean boundary failure" || fail "collision output=$CASE_OUTPUT"

printf '\n[TEST] runner-tier-token-preflight: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
