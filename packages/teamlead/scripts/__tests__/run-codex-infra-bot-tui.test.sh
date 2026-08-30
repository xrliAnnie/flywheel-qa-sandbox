#!/bin/bash
# shellcheck disable=SC2015  # test assertions intentionally use cmd && pass || fail
# FLY-1241 — run-codex-infra-bot-tui.sh contract test (the SECOND production windowed
# full-access launcher, alongside Mufasa). A PATH-injected mock `node` captures the env
# the launcher composes, so we assert the full-access + governance + lead-actions
# contract WITHOUT a real runtime/daemon. Run with /bin/bash.
#
# Contracts asserted (Codex design R3 #1):
#   - full-access tier: PROFILE=full-access, SANDBOX=workspace-write, MODE=tui, outbound=direct.
#   - project root pinned; lead_actions MCP coords (MAIN_JS, STATE_DIR) composed (token BY NAME).
#   - MEMORY CONTINUITY: state dir pins to .../codex-lead/codex-infra-bot-lead.
#   - GOVERNANCE: founder-only-authority appended to SYSTEM_PROMPT_FILES (after persona).
#   - FLY-1241: the retired FLYWHEEL_CODEX_LEAD_READ_DENY env pin is GONE (never emitted).
#   - FLY-1319: the founder-local-time rule is loaded AND its authority CLI
#     (FLYWHEEL_COMM_CLI) is bound — a rule without its CLI silently no-ops.
#   - fail-loud: runtime artifact missing → non-zero before exec.
set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Invoked via `/bin/bash "$SUT"` (below), so the launcher need not carry +x — a
# missing file is the only fatal precondition.
SUT="$SCRIPT_DIR/run-codex-infra-bot-tui.sh"
[ -f "$SUT" ] || { echo "FATAL: $SUT missing"; exit 1; }
REAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)" # real teamlead package root (for lead-rules-base)

T=$(mktemp -d /tmp/clibt.XXXXX) || { echo "FATAL: mktemp"; exit 1; }
trap 'rm -rf "$T"' EXIT

# Scrub launcher-behavior-changing vars from the ambient env (a parent Lead session
# may carry them) so a clean baseline is seen.
unset FLYWHEEL_CODEX_LEAD_PROFILE FLYWHEEL_CODEX_LEAD_SANDBOX \
	FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES FLYWHEEL_CODEX_LEAD_OUTBOUND \
	FLYWHEEL_CODEX_LEAD_PROJECT_DIR FLYWHEEL_CODEX_LEAD_READ_DENY FLYWHEEL_COMM_CLI \
	FLYWHEEL_LEAD_ID LEAD_ID FLYWHEEL_PROJECT_NAME PROJECT_NAME FLYWHEEL_LEAD_KEY \
	FLYWHEEL_LEAD_BACKEND FLYWHEEL_LEAD_ROLE FLYWHEEL_LEAD_IDENTITY_DIGEST \
	FLYWHEEL_LEAD_PROJECTS_DIGEST FLYWHEEL_LEAD_SUMMARY_ROLE \
	FLYWHEEL_LEAD_HAS_SUMMARY_DUTY FLYWHEEL_SUMMARY_GRANULARITY \
	FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST DISCORD_STATE_DIR DISCORD_EXPECTED_BOT_USER_ID \
	FLYWHEEL_LEAD_BOT_USER_ID FLYWHEEL_TUI_WINDOW_ALERT

# Fake TEAMLEAD_ROOT: stub dist runtime + lead-actions + tui-home; REAL lead-rules-base
# (symlinked) so assemble_full_access_governance resolves founder-only-authority for real.
RT="$T/teamlead"
mkdir -p "$RT/dist/lead-backends/codex/lead-actions" "$RT/scripts" \
	"$T/flywheel-comm/dist"
printf '// stub\n' > "$RT/dist/lead-backends/codex/codex-lead-tui-runtime.js"
printf '// stub\n' > "$RT/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
printf '// stub\n' > "$T/flywheel-comm/dist/index.js"
printf '#!/bin/bash\nexit 0\n' > "$RT/scripts/codex-lead-tui-home.sh"
chmod +x "$RT/scripts/codex-lead-tui-home.sh"
ln -s "$REAL_ROOT/lead-rules-base" "$RT/lead-rules-base"
# lead-rules-bundle.sh is sourced from SCRIPT_DIR (the launcher's own dir) — provide it.
ln -s "$REAL_ROOT/scripts/lead-rules-bundle.sh" "$RT/scripts/lead-rules-bundle.sh"
mkdir -p "$RT/scripts/lib"
ln -s "$REAL_ROOT/scripts/lib/canonical-lead-identity.sh" "$RT/scripts/lib/canonical-lead-identity.sh"

# Mock `node`: dump the env it was exec'd with, then exit 0.
mkdir -p "$T/bin"
cat > "$T/bin/node" <<'EOF'
#!/bin/bash
if [[ " $* " == *" lead-identity resolve "* ]]; then
  printf '%s\n' "$CANONICAL_JSON"
  exit 0
fi
env > "$ENVDUMP"
exit 0
EOF
chmod +x "$T/bin/node"
mkdir -p "$T/proj"

run_dry() {
	ENVDUMP="$T/envdump.$$.$RANDOM"
	export ENVDUMP
	PATH="$T/bin:$PATH" FLYWHEEL_TEAMLEAD_ROOT="$RT" FLYWHEEL_LEAD_DRY_RUN=1 \
		CANONICAL_JSON='{"schemaVersion":1,"leadId":"codex-infra-bot-lead","projectName":"flywheel","leadKey":"flywheel-codex-infra-bot-lead","agentTeamName":"codex-infra-bot-lead","botUserId":"12345678901234567","botTokenEnv":"CODEX_INFRA_BOT_TOKEN","discordStateDir":"/tmp/discord-infra","backend":"codex-app-server","role":"dept","summaryRole":"exempt","summaryGranularity":"per-lead","hasSummaryDuty":false,"summaryAssignmentDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","projectsDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
		FLYWHEEL_CODEX_LEAD_PROJECT_DIR="$T/proj" \
		FLYWHEEL_INFRA_BOT_USER_ID=U123 \
		FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID=C123 \
		FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=C456 \
		CODEX_INFRA_BOT_TOKEN=DRY \
		"$@" /bin/bash "$SUT" >/dev/null 2>&1
	echo "$ENVDUMP"
}
envval() { grep "^$2=" "$1" | head -1 | cut -d= -f2-; }

# ── full-access TUI env composition ─────────────────────────────────────────
D=$(run_dry env)
if [ -f "$D" ]; then
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_PROFILE)" = "full-access" ] && pass "PROFILE=full-access" || fail "PROFILE not full-access"
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_SANDBOX)" = "workspace-write" ] && pass "SANDBOX=workspace-write" || fail "SANDBOX wrong"
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_MODE)" = "tui" ] && pass "MODE=tui (windowed)" || fail "MODE not tui"
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_OUTBOUND)" = "direct" ] && pass "outbound=direct (preserves alerts channel)" || fail "outbound not direct"
	[ "$(envval "$D" FLYWHEEL_COMM_CLI)" = "$T/flywheel-comm/dist/index.js" ] \
		&& pass "founder-time CLI path reaches production TUI runtime" \
		|| fail "FLYWHEEL_COMM_CLI missing/wrong ($(envval "$D" FLYWHEEL_COMM_CLI))"
	pd=$(envval "$D" FLYWHEEL_CODEX_LEAD_PROJECT_DIR)
	[ "$pd" = "$T/proj" ] && pass "PROJECT_DIR set" || fail "PROJECT_DIR wrong ($pd)"
	la=$(envval "$D" FLYWHEEL_LEAD_ACTIONS_MAIN_JS)
	case "$la" in */lead-actions/lead-actions-main.js) pass "lead_actions MAIN_JS composed" ;; *) fail "MAIN_JS wrong ($la)" ;; esac
	sd=$(envval "$D" FLYWHEEL_LEAD_ACTIONS_STATE_DIR)
	case "$sd" in */codex-lead/codex-infra-bot-lead) pass "lead_actions STATE_DIR = pinned infra-bot state" ;; *) fail "STATE_DIR wrong ($sd)" ;; esac
	csd=$(envval "$D" FLYWHEEL_CODEX_LEAD_STATE_DIR)
	case "$csd" in */codex-lead/codex-infra-bot-lead) pass "state dir pinned (memory continuity)" ;; *) fail "state dir not pinned ($csd)" ;; esac
	# token BY NAME (env-token path; full-access has no broker) — the child receives DISCORD_BOT_TOKEN.
	[ -n "$(envval "$D" DISCORD_BOT_TOKEN)" ] && pass "DISCORD_BOT_TOKEN present (token by name, no broker)" || fail "DISCORD_BOT_TOKEN absent"
	sp=$(envval "$D" FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)
	case "$sp" in *founder-only-authority.md*) pass "governance: founder-only-authority appended" ;; *) fail "founder-only-authority not in SYSTEM_PROMPT_FILES ($sp)" ;; esac
	case "$sp" in *founder-local-time.md*) pass "governance: founder-local rule appended" ;; *) fail "founder-local rule not in SYSTEM_PROMPT_FILES ($sp)" ;; esac
	base_instructions=$(printf '%s' "$sp" | tr ',' '\n' | while IFS= read -r file; do
		[ -r "$file" ] && cat "$file"
	done)
	grep -q "UTC machine timestamp" <<<"$base_instructions" \
		&& pass "full-access baseInstructions contain founder-local rule body" \
		|| fail "full-access baseInstructions missing founder-local rule body"
	case "$sp" in *identity.md*) pass "persona: identity.md present (before governance)" ;; *) fail "identity.md missing ($sp)" ;; esac
	# FLY-1241: the retired read-deny env pin must NEVER be emitted (full-access has no read-deny).
	if grep -q "^FLYWHEEL_CODEX_LEAD_READ_DENY=" "$D"; then
		fail "retired FLYWHEEL_CODEX_LEAD_READ_DENY pin is still emitted"
	else pass "FLY-1241: no retired read-deny env pin"; fi
	if grep -q "^FLYWHEEL_TUI_WINDOW_ALERT=" "$D"; then
		fail "retired FLYWHEEL_TUI_WINDOW_ALERT pin is still emitted"
	else pass "FLY-2105: no retired TUI alert env pin"; fi
else
	fail "dry-run did not exec mock node (no env dump)"
fi

# ── fail-loud when the runtime artifact is missing ──────────────────────────
EMPTY="$T/empty"; mkdir -p "$EMPTY/scripts"
ln -s "$REAL_ROOT/lead-rules-base" "$EMPTY/lead-rules-base"
ln -s "$REAL_ROOT/scripts/lead-rules-bundle.sh" "$EMPTY/scripts/lead-rules-bundle.sh"
out=$(FLYWHEEL_TEAMLEAD_ROOT="$EMPTY" FLYWHEEL_LEAD_DRY_RUN=1 \
	FLYWHEEL_INFRA_BOT_USER_ID=U123 FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID=C123 \
	FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=C456 CODEX_INFRA_BOT_TOKEN=DRY \
	/bin/bash "$SUT" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "not built"; then
	pass "missing runtime artifact → non-zero + 'not built'"
else fail "missing runtime should fail loud (rc=$rc, out=$out)"; fi

echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
