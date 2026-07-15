#!/bin/bash
# shellcheck disable=SC2015  # test assertions intentionally use cmd && pass || fail
# FLY-259 PR-F — run-codex-lead-mufasa-tui.sh tests. A PATH-injected mock `node`
# captures the env the launcher composes, so we can assert the cutover contract
# WITHOUT a real runtime/daemon. Run with /bin/bash.
#
# Contracts asserted (plan v1.44.0 §3 D3a / §4 PR-F):
#   - MEMORY CONTINUITY: state dir pins to .../codex-lead/mufasa-lead (NOT the
#     codex-lead.sh hex dir) so the TUI resumes Mufasa's existing thread.
#   - TUI mode markers: MODE=tui, TUI_CWD set, standalone codex bin.
#   - D3a: outbound defaults to bridge; bridge REQUIRES BRIDGE_URL + API_TOKEN
#     (fail-loud early, before any side-effecting ensure); direct is overridable.
#   - fail-loud: runtime artifact missing → non-zero before exec.
set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/run-codex-lead-mufasa-tui.sh"
[ -x "$SUT" ] || { echo "FATAL: $SUT not executable"; exit 1; }

T=$(mktemp -d /tmp/clmt.XXXXX) || { echo "FATAL: mktemp"; exit 1; }
trap 'rm -rf "$T"' EXIT

# R3 LOW-3: scrub launcher-behavior-changing vars from the AMBIENT parent env ONCE,
# so a case that doesn't set them sees a clean baseline. Cases that WANT a var still
# set it via inheritance into run_dry (which passes inherited env through). Without
# this, a parent shell carrying FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS (e.g. a Lead
# session) flips bridge cases to the cross-dept-conflict path (Codex R2/R3 finding).
unset FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS FLYWHEEL_CODEX_LEAD_PROFILE \
	FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES FLYWHEEL_CODEX_LEAD_OUTBOUND

# Fake worktree with the built runtime + the tui-home script (a no-op stub; ensures
# are skipped in dry-run, but the launcher checks the file exists).
WT="$T/wt"
mkdir -p "$WT/packages/teamlead/dist/lead-backends/codex" "$WT/packages/teamlead/scripts"
printf '// stub\n' > "$WT/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js"
printf '#!/bin/bash\nexit 0\n' > "$WT/packages/teamlead/scripts/codex-lead-tui-home.sh"
chmod +x "$WT/packages/teamlead/scripts/codex-lead-tui-home.sh"

# Mock `node`: dump the env it was exec'd with to $ENVDUMP, then exit 0.
mkdir -p "$T/bin"
cat > "$T/bin/node" <<'EOF'
#!/bin/bash
env > "$ENVDUMP"
echo "MOCK_NODE_RAN $*"
exit 0
EOF
chmod +x "$T/bin/node"

# run the launcher in dry-run with the mock node first on PATH; capture env dump.
run_dry() {
	ENVDUMP="$T/envdump.$$.$RANDOM"
	export ENVDUMP
	PATH="$T/bin:$PATH" FLY224_WORKTREE="$WT" FLYWHEEL_LEAD_DRY_RUN=1 \
		FLYWHEEL_CODEX_TUI_CWD="$T/cwd" \
		"$@" /bin/bash "$SUT" >/dev/null 2>&1
	echo "$ENVDUMP"
}
envval() { grep "^$2=" "$1" | head -1 | cut -d= -f2-; }

# ── 1. dry-run env composition (default = direct, no bridge env needed) ─────
D=$(run_dry env)
if [ -f "$D" ]; then
	sd=$(envval "$D" FLYWHEEL_CODEX_LEAD_STATE_DIR)
	case "$sd" in
		*/codex-lead/mufasa-lead) pass "state dir pinned to mufasa-lead (memory continuity)" ;;
		*) fail "state dir not pinned to mufasa-lead (got: $sd)" ;;
	esac
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_MODE)" = "tui" ] && pass "MODE=tui" || fail "MODE not tui"
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_PROFILE)" = "companion" ] && pass "PROFILE=companion" || fail "PROFILE not companion"
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_SANDBOX)" = "read-only" ] && pass "SANDBOX=read-only" || fail "SANDBOX not read-only"
	[ "$(envval "$D" FLYWHEEL_LEAD_ID)" = "mufasa-lead" ] && pass "LEAD_ID=mufasa-lead" || fail "LEAD_ID wrong"
	[ "$(envval "$D" FLYWHEEL_PROJECT_NAME)" = "growth" ] && pass "PROJECT_NAME=growth" || fail "PROJECT_NAME wrong"
	[ "$(envval "$D" FLYWHEEL_CODEX_LEAD_OUTBOUND)" = "direct" ] && pass "outbound defaults to direct (zero-regression, preserves roundtable)" || fail "outbound not direct"
	[ "$(envval "$D" FLYWHEEL_CODEX_TUI_CWD)" = "$T/cwd" ] && pass "TUI_CWD passed through" || fail "TUI_CWD wrong"
	cb=$(envval "$D" FLYWHEEL_CODEX_BIN)
	case "$cb" in
		*/packages/standalone/current/codex) pass "CODEX_BIN points at standalone (daemon backend)" ;;
		*) fail "CODEX_BIN not standalone (got: $cb)" ;;
	esac
else
	fail "dry-run did not exec mock node (no env dump)"; fail "(skipped 6 dependent assertions)"
fi

# ── 2. fail-loud when the runtime artifact is missing ──────────────────────
EMPTY="$T/empty"; mkdir -p "$EMPTY"
out=$(FLY224_WORKTREE="$EMPTY" FLYWHEEL_LEAD_DRY_RUN=1 /bin/bash "$SUT" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "not built"; then
	pass "missing runtime artifact → non-zero + 'not built'"
else fail "missing runtime should fail loud (rc=$rc, out=$out)"; fi

# ── 3. bridge mode REQUIRES BRIDGE_URL + API_TOKEN (fail-loud early) ────────
out=$(PATH="$T/bin:$PATH" FLY224_WORKTREE="$WT" FLYWHEEL_LEAD_DRY_RUN=1 \
	FLYWHEEL_CODEX_TUI_CWD="$T/cwd" FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge \
	/bin/bash "$SUT" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "requires FLYWHEEL_BRIDGE_URL"; then
	pass "bridge mode without URL/token → fail-loud"
else fail "bridge mode should require URL/token (rc=$rc, out=$out)"; fi

# ── 4. explicit bridge opt-in (url+token, no cross-dept) → composes bridge ──
D=$(FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge FLYWHEEL_BRIDGE_URL=http://x FLYWHEEL_API_TOKEN=tok run_dry env)
if [ -f "$D" ] && [ "$(envval "$D" FLYWHEEL_CODEX_LEAD_OUTBOUND)" = "bridge" ]; then
	pass "explicit bridge opt-in (url+token, no cross-dept) → composes bridge (exactly-once)"
else fail "explicit bridge not composed"; fi

# ── 5. state dir is HARD-pinned — a stray env override is IGNORED (Codex HIGH-2) ──
# A FLYWHEEL_CODEX_LEAD_STATE_DIR in the sourced .env must NEVER redirect Mufasa
# onto a fresh thread (= memory loss). The pin wins unconditionally.
D=$(FLYWHEEL_CODEX_LEAD_STATE_DIR="$T/evil-override" run_dry env)
sd=$(envval "$D" FLYWHEEL_CODEX_LEAD_STATE_DIR)
case "$sd" in
	*/codex-lead/mufasa-lead) pass "state dir hard-pinned — env override ignored (memory safety)" ;;
	*) fail "state dir override was NOT ignored (got: $sd)" ;;
esac

# ── 6. bridge mode is fail-loud when cross-dept channels are set (Codex HIGH-1) ──
# bridge ⊕ cross-dept are mutually exclusive (runtime throws); the launcher must
# surface it early, not let the job crash at runtime.
out=$(PATH="$T/bin:$PATH" FLY224_WORKTREE="$WT" FLYWHEEL_LEAD_DRY_RUN=1 \
	FLYWHEEL_CODEX_TUI_CWD="$T/cwd" FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge \
	FLYWHEEL_BRIDGE_URL=http://x FLYWHEEL_API_TOKEN=tok \
	FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=123,456 \
	/bin/bash "$SUT" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "INCOMPATIBLE with cross-dept"; then
	pass "bridge + cross-dept channels → fail-loud early"
else fail "bridge+cross-dept should fail loud (rc=$rc, out=$out)"; fi

# ── 7. direct mode with cross-dept channels set → OK (no conflict) ─────────────
D=$(FLYWHEEL_CODEX_LEAD_OUTBOUND=direct FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=123 run_dry env)
if [ -f "$D" ] && [ "$(envval "$D" FLYWHEEL_CODEX_LEAD_OUTBOUND)" = "direct" ]; then
	pass "direct + cross-dept → no conflict (roundtable preserved)"
else fail "direct + cross-dept should be allowed"; fi

# ── 8. invalid outbound value → fail-loud (Codex R2 MED; typo must not silently direct) ──
out=$(PATH="$T/bin:$PATH" FLY224_WORKTREE="$WT" FLYWHEEL_LEAD_DRY_RUN=1 \
	FLYWHEEL_CODEX_TUI_CWD="$T/cwd" FLYWHEEL_CODEX_LEAD_OUTBOUND=bridg \
	/bin/bash "$SUT" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "invalid — must be 'direct' or 'bridge'"; then
	pass "invalid outbound (typo 'bridg') → fail-loud"
else fail "invalid outbound should fail loud (rc=$rc, out=$out)"; fi

# ── 9. companion contract is selected ─────────────────────────────────────
D=$(run_dry env)
if [ -f "$D" ]; then
	spf=$(envval "$D" FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)
	case "$spf" in
		*companion-safety-contract.md) pass "default → companion contract (byte-compat)" ;;
		*) fail "default should load companion contract (got: $spf)" ;;
	esac
else fail "default dry-run produced no env dump"; fi

# ── 10. FLY-1241: hostile ambient profile is overridden — pure companion pin ──
# This launcher is the rollback/companion path. It pins PROFILE=companion +
# SANDBOX=read-only unconditionally, so an invocation from an environment carrying
# an ambient full-access profile (e.g. a parent full-access Lead session) must NOT
# select the wrong runtime tier or trip the full-access guards.
D=$(FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_LEAD_SANDBOX=workspace-write run_dry env)
if [ -f "$D" ]; then
	p=$(envval "$D" FLYWHEEL_CODEX_LEAD_PROFILE); s=$(envval "$D" FLYWHEEL_CODEX_LEAD_SANDBOX)
	[ "$p" = "companion" ] && pass "hostile ambient full-access → pinned back to companion" || fail "ambient full-access leaked (profile=$p)"
	[ "$s" = "read-only" ] && pass "hostile ambient workspace-write → pinned back to read-only" || fail "ambient sandbox leaked (sandbox=$s)"
	spf=$(envval "$D" FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)
	case "$spf" in *companion-safety-contract.md) pass "hostile ambient still loads companion contract" ;; *) fail "wrong contract under hostile ambient ($spf)" ;; esac
else fail "hostile-ambient dry-run produced no env dump"; fi

echo ""
echo "run-codex-lead-mufasa-tui.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
