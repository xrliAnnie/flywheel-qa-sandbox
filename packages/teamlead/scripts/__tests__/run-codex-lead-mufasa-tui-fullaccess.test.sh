#!/bin/bash
# shellcheck disable=SC2015  # test assertions intentionally use cmd && pass || fail
# FLY-398 — run-codex-lead-mufasa-tui-fullaccess.sh tests. A PATH-injected mock `node`
# captures the env the windowed-full-access TUI launcher composes, so we can assert the
# cutover contract WITHOUT a real runtime/daemon. Run with /bin/bash.
#
# Contracts asserted:
#   - full-access tier markers: PROFILE=full-access, SANDBOX=workspace-write,
#     PROJECT_DIR set.
#   - WINDOWED: MODE=tui, outbound=direct (preserves #leads-roundtable).
#   - MEMORY CONTINUITY: state dir pins to .../codex-lead/mufasa-lead.
#   - GOVERNANCE: founder-only-authority appended to SYSTEM_PROMPT_FILES (after persona).
#   - lead_actions MCP coords (MAIN_JS, STATE_DIR) composed.
#   - fail-loud: runtime artifact missing → non-zero before exec.
set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/run-codex-lead-mufasa-tui-fullaccess.sh"
[ -x "$SUT" ] || { echo "FATAL: $SUT not executable"; exit 1; }
REAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)" # the real teamlead package root (for lead-rules-base)

T=$(mktemp -d /tmp/clfa.XXXXX) || { echo "FATAL: mktemp"; exit 1; }
trap 'rm -rf "$T"' EXIT

# Scrub launcher-behavior-changing vars from the ambient env (a parent Lead session
# may carry them) so a clean baseline is seen.
unset FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS FLYWHEEL_CODEX_LEAD_PROFILE \
	FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES FLYWHEEL_CODEX_LEAD_OUTBOUND \
	FLYWHEEL_CODEX_LEAD_PROJECT_DIR \
	FLYWHEEL_CODEX_LEAD_SANDBOX

# Fake TEAMLEAD_ROOT: stub dist runtime + lead-actions + tui-home; REAL lead-rules-base
# (symlinked) so assemble_full_access_governance resolves founder-only-authority for real.
RT="$T/teamlead"
mkdir -p "$RT/dist/lead-backends/codex/lead-actions" "$RT/scripts"
printf '// stub\n' > "$RT/dist/lead-backends/codex/codex-lead-tui-runtime.js"
printf '// stub\n' > "$RT/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
printf '#!/bin/bash\nexit 0\n' > "$RT/scripts/codex-lead-tui-home.sh"
chmod +x "$RT/scripts/codex-lead-tui-home.sh"
ln -s "$REAL_ROOT/lead-rules-base" "$RT/lead-rules-base"

# Mock `node`: dump the env it was exec'd with, then exit 0.
mkdir -p "$T/bin"
cat > "$T/bin/node" <<'EOF'
#!/bin/bash
env > "$ENVDUMP"
exit 0
EOF
chmod +x "$T/bin/node"
mkdir -p "$T/proj"

run_dry() {
	ENVDUMP="$T/envdump.$$.$RANDOM"
	export ENVDUMP
	PATH="$T/bin:$PATH" FLYWHEEL_TEAMLEAD_ROOT="$RT" FLYWHEEL_LEAD_DRY_RUN=1 \
		FLYWHEEL_CODEX_TUI_CWD="$T/proj" FLYWHEEL_CODEX_LEAD_PROJECT_DIR="$T/proj" \
		MUFASA_BOT_TOKEN=DRY \
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
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_OUTBOUND)" = "direct" ] && pass "outbound=direct (preserves roundtable)" || fail "outbound not direct"
	pd=$(envval "$D" FLYWHEEL_CODEX_LEAD_PROJECT_DIR)
	[ "$pd" = "$T/proj" ] && pass "PROJECT_DIR set" || fail "PROJECT_DIR wrong ($pd)"
	# Codex R1 HIGH-2: TUI_CWD is DERIVED from PROJECT_DIR (single source of truth) so the
	# founder cwd, the daemon writable_roots, and the validated project root are one path.
	tc=$(envval "$D" FLYWHEEL_CODEX_TUI_CWD)
	[ "$tc" = "$pd" ] && pass "TUI_CWD == PROJECT_DIR (single source of truth)" || fail "TUI_CWD diverged from PROJECT_DIR (tc=$tc pd=$pd)"

# ── HIGH-2: a divergent TUI_CWD override is IGNORED — PROJECT_DIR is the single source ──
D2=$(FLYWHEEL_CODEX_TUI_CWD="$T/EVIL-divergent" run_dry env)
if [ -f "$D2" ]; then
	tc2=$(envval "$D2" FLYWHEEL_CODEX_TUI_CWD); pd2=$(envval "$D2" FLYWHEEL_CODEX_LEAD_PROJECT_DIR)
	[ "$tc2" = "$pd2" ] && pass "divergent TUI_CWD override ignored (TUI_CWD forced to PROJECT_DIR)" || fail "divergent TUI_CWD leaked (tc2=$tc2 pd2=$pd2)"
else
	fail "divergent-override dry-run did not exec mock node"
fi
	la=$(envval "$D" FLYWHEEL_LEAD_ACTIONS_MAIN_JS)
	case "$la" in */lead-actions/lead-actions-main.js) pass "lead_actions MAIN_JS composed" ;; *) fail "MAIN_JS wrong ($la)" ;; esac
	sd=$(envval "$D" FLYWHEEL_LEAD_ACTIONS_STATE_DIR)
	case "$sd" in */codex-lead/mufasa-lead) pass "lead_actions STATE_DIR = pinned mufasa state" ;; *) fail "STATE_DIR wrong ($sd)" ;; esac
	csd=$(envval "$D" FLYWHEEL_CODEX_LEAD_STATE_DIR)
	case "$csd" in */codex-lead/mufasa-lead) pass "state dir pinned (memory continuity)" ;; *) fail "state dir not pinned ($csd)" ;; esac
	sp=$(envval "$D" FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)
	case "$sp" in *founder-only-authority.md*) pass "governance: founder-only-authority appended" ;; *) fail "founder-only-authority not in SYSTEM_PROMPT_FILES ($sp)" ;; esac
	case "$sp" in *identity.md*) pass "persona: identity.md present (before governance)" ;; *) fail "identity.md missing ($sp)" ;; esac
else
	fail "dry-run did not exec mock node (no env dump)"
fi

# ── fail-loud when the runtime artifact is missing ──────────────────────────
EMPTY="$T/empty"; mkdir -p "$EMPTY/scripts"; ln -s "$REAL_ROOT/lead-rules-base" "$EMPTY/lead-rules-base"
out=$(FLYWHEEL_TEAMLEAD_ROOT="$EMPTY" FLYWHEEL_LEAD_DRY_RUN=1 MUFASA_BOT_TOKEN=DRY /bin/bash "$SUT" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "not built"; then
	pass "missing runtime artifact → non-zero + 'not built'"
else fail "missing runtime should fail loud (rc=$rc, out=$out)"; fi

echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
