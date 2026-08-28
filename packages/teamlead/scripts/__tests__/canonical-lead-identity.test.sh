#!/bin/bash
set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "[TEST] ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="${SCRIPT_DIR}/../lib/canonical-lead-identity.sh"
TMP="$(mktemp -d -t fly1726-codex-identity-XXXXXX)" || exit 1
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
printf '%s\n' \
  '#!/bin/bash' \
  'printf "%s\n" "$*" >> "$RESOLVE_CALLS"' \
  'printf "%s\n" "$RESOLVED_IDENTITY_JSON"' \
  > "$TMP/bin/node"
chmod +x "$TMP/bin/node"
printf '%s\n' '// test stub' > "$TMP/flywheel-comm.js"

export RESOLVE_CALLS="$TMP/resolve-calls"
export RESOLVED_IDENTITY_JSON="$(printf '{"schemaVersion":1,"leadId":"product-lead","projectName":"flywheel","leadKey":"flywheel-product-lead","agentTeamName":"product-lead","botUserId":"12345678901234567","botTokenEnv":"PRODUCT_TOKEN","discordStateDir":"%s/discord-product","backend":"codex-app-server","role":"dept","summaryRole":"producer","summaryGranularity":"per-lead","hasSummaryDuty":true,"summaryAssignmentDigest":"%s","projectsDigest":"%s","identityDigest":"%s"}' "$TMP" "$(printf 'c%.0s' {1..64})" "$(printf 'b%.0s' {1..64})" "$(printf 'a%.0s' {1..64})")"

SUCCESS_ENV="$TMP/success-env"
(
  unset LEAD_ID FLYWHEEL_LEAD_ID PROJECT_NAME FLYWHEEL_PROJECT_NAME \
    FLYWHEEL_LEAD_KEY FLYWHEEL_LEAD_BACKEND FLYWHEEL_LEAD_ROLE \
    FLYWHEEL_LEAD_SUMMARY_ROLE FLYWHEEL_LEAD_HAS_SUMMARY_DUTY \
    FLYWHEEL_SUMMARY_GRANULARITY FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST \
    FLYWHEEL_LEAD_IDENTITY_DIGEST FLYWHEEL_LEAD_PROJECTS_DIGEST \
    DISCORD_STATE_DIR DISCORD_EXPECTED_BOT_USER_ID DISCORD_IDENTITY_MODE FLYWHEEL_LEAD_BOT_USER_ID
  export PATH="$TMP/bin:$PATH"
  export FLYWHEEL_COMM_CLI="$TMP/flywheel-comm.js"
  export FLYWHEEL_PROJECTS_FILE="$TMP/projects.json"
  export PRODUCT_TOKEN="secret-token"
  # shellcheck source=../lib/canonical-lead-identity.sh
  . "$SUT" || exit 1
  canonical_lead_identity_resolve "flywheel" "product-lead" || exit 1
  env > "$SUCCESS_ENV"
)
rc=$?
if [ "$rc" -eq 0 ]; then pass "canonical projection succeeds"; else fail "canonical projection failed"; fi

envval() { grep "^$2=" "$1" | head -1 | cut -d= -f2-; }
[ "$(envval "$SUCCESS_ENV" FLYWHEEL_LEAD_KEY)" = "flywheel-product-lead" ] \
  && pass "projects canonical leadKey" || fail "leadKey missing"
[ "$(envval "$SUCCESS_ENV" DISCORD_EXPECTED_BOT_USER_ID)" = "12345678901234567" ] \
  && pass "projects canonical bot id" || fail "bot id missing"
[ "$(envval "$SUCCESS_ENV" DISCORD_IDENTITY_MODE)" = "managed" ] \
  && pass "managed Discord identity mode projected" || fail "identity mode missing"
[ "$(envval "$SUCCESS_ENV" FLYWHEEL_LEAD_IDENTITY_DIGEST)" = "$(printf 'a%.0s' {1..64})" ] \
  && pass "identity digest projected" || fail "identity digest missing"
[ "$(envval "$SUCCESS_ENV" FLYWHEEL_LEAD_SUMMARY_ROLE)" = "producer" ] \
  && [ "$(envval "$SUCCESS_ENV" FLYWHEEL_LEAD_HAS_SUMMARY_DUTY)" = "1" ] \
  && [ "$(envval "$SUCCESS_ENV" FLYWHEEL_SUMMARY_GRANULARITY)" = "per-lead" ] \
  && [ "$(envval "$SUCCESS_ENV" FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST)" = "$(printf 'c%.0s' {1..64})" ] \
  && pass "summary assignment projection exported" || fail "summary assignment projection missing"
[ "$(envval "$SUCCESS_ENV" DISCORD_BOT_TOKEN)" = "secret-token" ] \
  && pass "named token projected only as generic token" || fail "generic token missing"
if grep -q '^PRODUCT_TOKEN=' "$SUCCESS_ENV"; then
  fail "named token leaked into child environment"
else
  pass "named token selector scrubbed"
fi
[ "$(wc -l < "$RESOLVE_CALLS" | tr -d ' ')" = "1" ] \
  && pass "resolver called exactly once" || fail "resolver call count was not one"

if (
  export PATH="$TMP/bin:$PATH" FLYWHEEL_COMM_CLI="$TMP/flywheel-comm.js" \
    FLYWHEEL_PROJECTS_FILE="$TMP/projects.json" PRODUCT_TOKEN="secret-token" \
    LEAD_ID="eng-lead"
  . "$SUT"
  canonical_lead_identity_resolve "flywheel" "product-lead"
) >/dev/null 2>"$TMP/conflict.err"; then
  fail "ambient Lead identity conflict was accepted"
elif grep -q 'identity_env_conflict' "$TMP/conflict.err"; then
  pass "ambient Lead identity conflict fails closed"
else
  fail "ambient conflict lacked structured diagnostic"
fi
if grep -q 'lead-identity record-failure.*--code identity_env_conflict' "$RESOLVE_CALLS"; then
  pass "post-resolve conflict records a durable failure marker"
else
  fail "post-resolve conflict did not invoke failure marker writer"
fi

echo "canonical-lead-identity.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
