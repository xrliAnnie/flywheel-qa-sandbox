#!/usr/bin/env bash
# FLY-727 (Codex R9): daily-digest.sh env-override regression.
# A caller's staging Bridge URL / channel / token MUST win over a production .env
# (else a QA-Room staging digest would render from — or DELIVER to — production).
# Production path (nothing pre-set) must be byte-equivalent to just sourcing .env.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/daily-digest.sh"
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dd.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"

# A production-shaped env file: sets BOTH bridge aliases + a prod channel + prod token.
PROD_ENV="$TMP/prod.env"
cat >"$PROD_ENV" <<'EOF'
FLYWHEEL_BRIDGE_URL=http://prod-bridge:9876
BRIDGE_URL=http://prod-bridge:9876
FLYWHEEL_DIGEST_CHANNEL=111111111111111111
TEAMLEAD_API_TOKEN=prod-token
EOF

# Resolve config only (DIGEST_PRINT_CONFIG exits before any lock/health/render).
# `env -i` gives a CLEAN environment (only HOME/PATH + what we pass) so the test
# harness's own inherited BRIDGE_URL / TEAMLEAD_API_TOKEN (this dev box sources
# ~/.flywheel/.env from the shell profile) can't leak in and look like a caller override.
run_cfg() {
	env -i HOME="$HOME" PATH="$PATH" ENV_FILE="$PROD_ENV" DIGEST_PRINT_CONFIG=1 "$@" \
		bash "$SCRIPT" 2>/dev/null
}
field() { printf '%s\n' "$1" | grep "^$2=" | cut -d= -f2-; }

# ── T1: caller sets FLYWHEEL_BRIDGE_URL + channel + token → all staging win ──
out="$(run_cfg FLYWHEEL_BRIDGE_URL=http://stage:19871 FLYWHEEL_DIGEST_CHANNEL=999 TEAMLEAD_API_TOKEN=stage-tok)"
[ "$(field "$out" BRIDGE_URL)" = "http://stage:19871" ] && pass "T1 FLYWHEEL_BRIDGE_URL override wins" || fail "T1 bridge=$(field "$out" BRIDGE_URL)"
[ "$(field "$out" CHANNEL)" = "999" ] && pass "T1b channel override wins" || fail "T1b channel=$(field "$out" CHANNEL)"
[ "$(field "$out" TOKEN)" = "stage-tok" ] && pass "T1c token override wins" || fail "T1c token=$(field "$out" TOKEN)"

# ── T2 (Codex R9 core): caller sets only the BRIDGE_URL alias → still beats the
#        production FLYWHEEL_BRIDGE_URL from .env ────────────────────────────────
out="$(run_cfg BRIDGE_URL=http://stage:19871 FLYWHEEL_DIGEST_CHANNEL=999)"
[ "$(field "$out" BRIDGE_URL)" = "http://stage:19871" ] && pass "T2 BRIDGE_URL alias beats .env FLYWHEEL_BRIDGE_URL" || fail "T2 bridge=$(field "$out" BRIDGE_URL) (prod leaked)"

# ── T3 (Codex R9 danger): caller sets a staging CHANNEL → never the prod channel ─
out="$(run_cfg FLYWHEEL_BRIDGE_URL=http://stage:19871 FLYWHEEL_DIGEST_CHANNEL=999)"
[ "$(field "$out" CHANNEL)" = "999" ] && pass "T3 staging channel never falls back to prod .env channel" || fail "T3 channel=$(field "$out" CHANNEL) (would deliver to PROD)"

# ── T4: production path — nothing pre-set → .env production values (byte-compat) ─
out="$(run_cfg)"
[ "$(field "$out" BRIDGE_URL)" = "http://prod-bridge:9876" ] && pass "T4 no override → prod bridge (byte-compat)" || fail "T4 bridge=$(field "$out" BRIDGE_URL)"
[ "$(field "$out" CHANNEL)" = "111111111111111111" ] && pass "T4b no override → prod channel" || fail "T4b channel=$(field "$out" CHANNEL)"
[ "$(field "$out" TOKEN)" = "prod-token" ] && pass "T4c no override → prod token" || fail "T4c token=$(field "$out" TOKEN)"

echo ""
echo "daily-digest-env-override: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
