#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-layers.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

renderer="$ROOT/scripts/lib/qa-launchd-env.py"
env_file="$TMP/lead.env"
hostile="value with spaces and 'quotes'"
if python3 "$renderer" --output "$env_file" \
    "TEST_BOT_TOKEN_7=$hostile" \
    'FLYWHEEL_PROJECTS_FILE=/tmp/flywheel-test-slot-7/q/7/projects.json' \
    'CODEX_HOME=/tmp/flywheel-test-slot-7/cdxh/flywheel-test-7' \
    'QA_SENTINEL_SECRET=projected-arbitrary-value' \
    && [ "$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file")" = 600 ]; then
  unset TEST_BOT_TOKEN_7 FLYWHEEL_PROJECTS_FILE CODEX_HOME QA_SENTINEL_SECRET
  # shellcheck disable=SC1090
  set -a; source "$env_file"; set +a
  if [[ "$TEST_BOT_TOKEN_7" == "$hostile" ]] \
      && [[ "$FLYWHEEL_PROJECTS_FILE" == /tmp/flywheel-test-slot-7/q/7/projects.json ]] \
      && [[ "$CODEX_HOME" == /tmp/flywheel-test-slot-7/cdxh/flywheel-test-7 ]] \
      && [[ "$QA_SENTINEL_SECRET" == projected-arbitrary-value ]]; then
    pass "Codex env renderer shell-quotes arbitrary non-resolver assignments atomically"
  else
    fail "Codex env renderer value round trip"
  fi
else
  fail "Codex env renderer successful projection"
fi

resolver_names=(
  LEAD_ID PROJECT_NAME FLYWHEEL_LEAD_ID FLYWHEEL_PROJECT_NAME FLYWHEEL_LEAD_KEY
  FLYWHEEL_LEAD_BACKEND FLYWHEEL_LEAD_BOT_USER_ID FLYWHEEL_LEAD_ROLE
  FLYWHEEL_LEAD_MODEL FLYWHEEL_LEAD_EFFORT FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW
  FLYWHEEL_LEAD_SUMMARY_ROLE FLYWHEEL_LEAD_HAS_SUMMARY_DUTY
  FLYWHEEL_SUMMARY_GRANULARITY FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST
  FLYWHEEL_LEAD_IDENTITY_DIGEST FLYWHEEL_LEAD_PROJECTS_DIGEST
  FLYWHEEL_CANONICAL_IDENTITY_RESOLVED FLYWHEEL_CODEX_LEAD_ID
  FLYWHEEL_CODEX_LEAD_PROJECT FLYWHEEL_CODEX_LEAD_BOT_TOKEN_ENV
  DISCORD_STATE_DIR DISCORD_EXPECTED_BOT_USER_ID DISCORD_IDENTITY_MODE
  DISCORD_BOT_TOKEN FLYWHEEL_PROJECTS FLYWHEEL_SUMMARY_CONFIG_HOME
  FLYWHEEL_CODEX_LEAD_STATE_DIR FLYWHEEL_LEAD_DRY_RUN
)
deny_ok=1
for resolver_name in "${resolver_names[@]}"; do
  candidate="$TMP/deny-${resolver_name}.env"
  secret_value="must-not-print-${resolver_name}"
  if python3 "$renderer" --output "$candidate" \
      "${resolver_name}=${secret_value}" >"$TMP/deny.out" 2>"$TMP/deny.err"; then
    deny_ok=0
  fi
  if [[ -e "$candidate" ]] \
      || ! grep -Fq "$resolver_name" "$TMP/deny.err" \
      || grep -Fq "$secret_value" "$TMP/deny.err" \
      || [[ -s "$TMP/deny.out" ]]; then
    deny_ok=0
  fi
done
if [[ "$deny_ok" == 1 ]]; then
  pass "Codex env renderer rejects every canonical identity/resolver-owned name without values"
else
  fail "Codex env renderer resolver deny set"
fi

printf '%s\n' 'preserve-existing-output' > "$TMP/unchanged.env"
duplicate_secret='duplicate-secret-must-not-print'
negative_ok=1
if python3 "$renderer" --output "$TMP/duplicate.env" \
    'TEST_BOT_TOKEN_7=first' "TEST_BOT_TOKEN_7=$duplicate_secret" \
    >"$TMP/duplicate.out" 2>"$TMP/duplicate.err"; then
  negative_ok=0
fi
if [[ -e "$TMP/duplicate.env" ]] \
    || ! grep -Fq 'TEST_BOT_TOKEN_7' "$TMP/duplicate.err" \
    || grep -Fq "$duplicate_secret" "$TMP/duplicate.err"; then
  negative_ok=0
fi
if python3 "$renderer" --output "$TMP/invalid.env" \
    'BAD-NAME=invalid-secret-must-not-print' >"$TMP/invalid.out" 2>"$TMP/invalid.err"; then
  negative_ok=0
fi
if [[ -e "$TMP/invalid.env" ]] \
    || ! grep -Fq 'BAD-NAME' "$TMP/invalid.err" \
    || grep -Fq 'invalid-secret-must-not-print' "$TMP/invalid.err"; then
  negative_ok=0
fi
if python3 "$renderer" --output "$TMP/unchanged.env" \
    'FLYWHEEL_LEAD_ID=replace-secret-must-not-print' >/dev/null 2>&1; then
  negative_ok=0
fi
if [[ "$(cat "$TMP/unchanged.env")" != preserve-existing-output ]] \
    || find "$TMP" -name '*.tmp.*' -print -quit | grep -q .; then
  negative_ok=0
fi
if [[ "$negative_ok" == 1 ]]; then
  pass "Codex env renderer rejects duplicates and invalid names without partial replacement"
else
  fail "Codex env renderer negative assignment matrix"
fi

if python3 "$renderer" --check 'A=one' 'B=two words' >/dev/null 2>&1 \
    && ! python3 "$renderer" --check 'A=one' 'A=two' >/dev/null 2>&1; then
  pass "Codex env renderer supports a side-effect-free preflight before home minting"
else
  fail "Codex env renderer side-effect-free preflight"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
