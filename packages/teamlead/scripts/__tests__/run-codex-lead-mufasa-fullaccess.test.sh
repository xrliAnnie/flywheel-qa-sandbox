#!/bin/bash
# shellcheck disable=SC2015  # test assertions intentionally use cmd && pass || fail
# FLY-3083 — minimal dry-run contract for run-codex-lead-mufasa-fullaccess.sh (the
# HEADLESS full-access launcher kept for tests / QA / rollback, FLY-398). It execs
# the runtime directly (bypassing codex-lead.sh), so it must export
# FLYWHEEL_LEAD_ALERT_SCRIPT itself. A PATH-injected mock `node` captures the env.
set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/run-codex-lead-mufasa-fullaccess.sh"
[ -f "$SUT" ] || { echo "FATAL: $SUT missing"; exit 1; }
REAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

T=$(mktemp -d /tmp/clmfa.XXXXX) || { echo "FATAL: mktemp"; exit 1; }
trap 'rm -rf "$T"' EXIT

unset FLYWHEEL_LEAD_ALERT_SCRIPT FLYWHEEL_CODEX_LEAD_PROFILE FLYWHEEL_CODEX_LEAD_SANDBOX \
	FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES FLYWHEEL_CODEX_LEAD_PROJECT_DIR

RT="$T/teamlead"
mkdir -p "$RT/dist/lead-backends/codex"
printf '// stub\n' > "$RT/dist/lead-backends/codex/codex-lead-runtime.js"
ln -s "$REAL_ROOT/lead-rules-base" "$RT/lead-rules-base"

mkdir -p "$T/bin" "$T/proj"
cat > "$T/bin/node" <<'EOF'
#!/bin/bash
env > "$ENVDUMP"
exit 0
EOF
chmod +x "$T/bin/node"

ENVDUMP="$T/envdump"
export ENVDUMP
PATH="$T/bin:$PATH" FLYWHEEL_TEAMLEAD_ROOT="$RT" FLYWHEEL_LEAD_DRY_RUN=1 \
	FLYWHEEL_CODEX_LEAD_PROJECT_DIR="$T/proj" MUFASA_BOT_TOKEN=DRY \
	/bin/bash "$SUT" >/dev/null 2>&1
envval() { grep "^$2=" "$1" | head -1 | cut -d= -f2-; }

if [ -f "$ENVDUMP" ]; then
	[ "$(envval "$ENVDUMP" FLYWHEEL_CODEX_LEAD_PROFILE)" = "full-access" ] && pass "PROFILE=full-access" || fail "PROFILE not full-access"
	sp=$(envval "$ENVDUMP" FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)
	case "$sp" in *runner-channel-contract.md*) pass "governance bundle carries the Runner channel contract" ;; *) fail "runner-channel-contract.md not in SYSTEM_PROMPT_FILES ($sp)" ;; esac
	las=$(envval "$ENVDUMP" FLYWHEEL_LEAD_ALERT_SCRIPT)
	case "$las" in
		/*/scripts/lead-alert.sh) [ -f "$las" ] && pass "FLYWHEEL_LEAD_ALERT_SCRIPT = existing canonical lead-alert.sh" || fail "FLYWHEEL_LEAD_ALERT_SCRIPT points at a missing file ($las)" ;;
		*) fail "FLYWHEEL_LEAD_ALERT_SCRIPT not exported ($las)" ;;
	esac
else
	fail "dry-run did not exec mock node (no env dump)"
fi

echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
