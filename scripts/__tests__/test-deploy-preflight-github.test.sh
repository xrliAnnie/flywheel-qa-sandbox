#!/usr/bin/env bash
# FLY-1624: the 529-room sandbox pre-flight must use REST and preserve the
# distinction between an absent/invisible repository and an unavailable probe.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$(mktemp -d /tmp/fly1624-preflight-XXXXXX)"
FIXTURE_HOME="$FIXTURE/home"
STUB_BIN="$FIXTURE/bin"
mkdir -p "$FIXTURE_HOME/.flywheel" "$STUB_BIN"
trap 'rm -rf "$FIXTURE"' EXIT

printf 'LINEAR_API_KEY=fixture-key\n' > "$FIXTURE_HOME/.flywheel/.env"
printf '%s\n' '{"guildId":"fixture","slots":[{"id":99,"bridgePort":29999,"botName":"fixture","tokenEnvVar":"TEST_BOT_TOKEN_99","botAppId":"99","channelId":"99","role":"lead"}]}' \
  > "$FIXTURE_HOME/.flywheel/test-slots.json"

GH_LOG="$FIXTURE/gh.log"
export FLY1624_GH_LOG="$GH_LOG"
cat > "$STUB_BIN/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FLY1624_GH_LOG"
if [[ "$1 $2" == "auth status" ]]; then exit 0; fi
if [[ "$1 $2" == "repo view" ]]; then exit 99; fi
if [[ "$1 $2" == "api rate_limit" ]]; then
  [[ "$FLY1624_SCENARIO" == "api_unavailable" ]] && exit 1
  printf '4998\n'
  exit 0
fi
if [[ "$1 $2" == "api repos/xrliAnnie/flywheel-qa-sandbox" ]]; then
  if [[ "$*" == *"--jq .permissions.push"* ]]; then
    printf 'false\n'
    exit 0
  fi
  [[ "$FLY1624_SCENARIO" == "rest_visible" ]] && { printf '{}\n'; exit 0; }
  exit 1
fi
exit 1
GH
chmod +x "$STUB_BIN/gh"

run_case() {
  local scenario="$1" output="$2"
  : > "$GH_LOG"
  HOME="$FIXTURE_HOME" \
    PATH="$STUB_BIN:$PATH" \
    FLY1624_SCENARIO="$scenario" \
    bash "$SCRIPT_DIR/test-deploy.sh" 99 >"$output" 2>&1
}

OUT_VISIBLE="$FIXTURE/visible.out"
if run_case rest_visible "$OUT_VISIBLE"; then
  fail "REST-visible fixture should stop at the deliberately false push permission"
elif grep -q '^api repos/xrliAnnie/flywheel-qa-sandbox$' "$GH_LOG" \
  && ! grep -q '^repo view' "$GH_LOG" \
  && grep -q 'no push permission' "$OUT_VISIBLE"; then
  pass "GraphQL failure is irrelevant: sandbox existence and permission use gh api"
else
  fail "REST-visible sandbox did not follow the expected pre-flight path"
fi

OUT_DOWN="$FIXTURE/down.out"
if run_case api_unavailable "$OUT_DOWN"; then
  fail "unavailable GitHub API must fail closed"
elif grep -q 'was NOT checked — this is not evidence that it is missing' "$OUT_DOWN" \
  && ! grep -qi 'fork-name\|sandbox repo xrliAnnie/flywheel-qa-sandbox missing' "$OUT_DOWN"; then
  pass "probe failure is reported as unverified, never as repository missing"
else
  fail "API-unavailable message collapsed probe failure into repository absence"
fi

OUT_HIDDEN="$FIXTURE/hidden.out"
if run_case repo_hidden "$OUT_HIDDEN"; then
  fail "repository invisible to current auth must fail closed"
elif grep -q 'is not reachable with the current gh auth' "$OUT_HIDDEN" \
  && grep -q 'gh api repos/xrliAnnie/flywheel-qa-sandbox' "$OUT_HIDDEN" \
  && ! grep -qi 'fork-name\|sandbox repo xrliAnnie/flywheel-qa-sandbox missing' "$OUT_HIDDEN"; then
  pass "confirmed REST reachability failure gives a runnable diagnostic, not a fork command"
else
  fail "repository visibility failure emitted a misleading recovery instruction"
fi

echo "[TEST] test-deploy-preflight-github: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
