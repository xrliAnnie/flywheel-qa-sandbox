#!/usr/bin/env bash
# FLY-1081 sentinel: the Simba notify-path migration must not regress.
#
# Three assertions (Codex R1#5 — precise scope, resistant to equivalent
# fallback rewrites):
#   1. SIMBA-token env name is grep-zero across git-tracked scripts/ +
#      packages/ (the pattern is concatenated below so this file never
#      matches itself).
#   2. update-flywheel.sh and flywheel-bridge-wrapper.sh carry ZERO
#      DISCORD-BOT-TOKEN literals — whole-file ban, so no fallback chain of
#      any spelling can creep back into those two notify paths.
#   3. restart-services.sh carries EXACTLY ONE occurrence and it is the
#      byte-exact legitimate per-lead injection form
#      "DISCORD_BOT_TOKEN=${!bot_token_env}" — blocking ANY equivalent
#      fallback rewrite, not just the historical ':-${DISCORD…}' shape.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

SIMBA_PATTERN='SIMBA''_BOT_TOKEN'          # concatenated: never self-matches
DBT_PATTERN='DISCORD''_BOT_TOKEN'

# ── 1. SIMBA token env grep-zero (git-tracked scripts/ + packages/) ──────────
hits="$(git ls-files scripts packages | xargs grep -l "$SIMBA_PATTERN" 2>/dev/null || true)"
if [[ -z "$hits" ]]; then
	pass "no git-tracked file under scripts/ or packages/ references the Simba token env"
else
	fail "Simba token env re-appeared in: $(echo "$hits" | tr '\n' ' ')"
fi

# ── 2. update-flywheel.sh + flywheel-bridge-wrapper.sh: whole-file ban ───────
for f in scripts/update-flywheel.sh scripts/flywheel-bridge-wrapper.sh; do
	n="$(grep -c "$DBT_PATTERN" "$f" || true)"
	if [[ "$n" == "0" ]]; then
		pass "$f carries zero ${DBT_PATTERN} literals"
	else
		fail "$f references ${DBT_PATTERN} ${n}x (fallback creep?): $(grep -n "$DBT_PATTERN" "$f" | tr '\n' ' ')"
	fi
done

# ── 3. restart-services.sh: exactly the ONE legitimate per-lead injection ────
n="$(grep -c "$DBT_PATTERN" scripts/restart-services.sh || true)"
if [[ "$n" == "1" ]]; then
	pass "restart-services.sh has exactly 1 ${DBT_PATTERN} occurrence"
else
	fail "restart-services.sh has ${n} ${DBT_PATTERN} occurrences (expected exactly 1): $(grep -n "$DBT_PATTERN" scripts/restart-services.sh | tr '\n' ' ')"
fi
if grep -qF "\"${DBT_PATTERN}=\${!bot_token_env}\"" scripts/restart-services.sh; then
	pass "the single occurrence is the byte-exact per-lead injection form"
else
	fail "the ${DBT_PATTERN} occurrence is NOT the legitimate per-lead injection form"
fi

echo ""
echo "[TEST] simba-grep-zero: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]]
