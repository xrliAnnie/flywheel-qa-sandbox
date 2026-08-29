#!/bin/bash
set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/run-codex-lead-raya-tui-fullaccess.sh"
REAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
T=$(mktemp -d /tmp/raya-tui.XXXXX) || exit 1
trap 'rm -rf "$T"' EXIT

unset FLYWHEEL_LEAD_MODEL FLYWHEEL_LEAD_EFFORT \
	FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES \
	FLYWHEEL_CODEX_LEAD_PROJECT_DIR FLYWHEEL_CODEX_TUI_CWD RAYA_METRICS_DIR \
	FLYWHEEL_LEAD_ID LEAD_ID FLYWHEEL_PROJECT_NAME PROJECT_NAME \
	FLYWHEEL_LEAD_KEY FLYWHEEL_LEAD_BACKEND FLYWHEEL_LEAD_ROLE \
	FLYWHEEL_LEAD_SUMMARY_ROLE FLYWHEEL_LEAD_HAS_SUMMARY_DUTY \
	FLYWHEEL_SUMMARY_GRANULARITY FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST \
	FLYWHEEL_LEAD_IDENTITY_DIGEST FLYWHEEL_LEAD_PROJECTS_DIGEST \
	DISCORD_STATE_DIR DISCORD_EXPECTED_BOT_USER_ID DISCORD_IDENTITY_MODE

RT="$T/teamlead"
mkdir -p "$RT/dist/lead-backends/codex/lead-actions" "$RT/scripts/lib" \
	"$T/flywheel-comm/dist" "$T/raya-code" "$T/workspace/memory" \
	"$T/workspace/state" "$T/metrics" "$T/codex-home"
printf '// stub\n' > "$RT/dist/lead-backends/codex/codex-lead-tui-runtime.js"
printf '// stub\n' > "$RT/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
printf '// stub\n' > "$T/flywheel-comm/dist/index.js"
printf '# Raya\n' > "$T/raya-code/IDENTITY.md"
printf '# Memory\n' > "$T/workspace/memory/MEMORY.md"
printf '#!/bin/bash\nexit 0\n' > "$RT/scripts/codex-lead-tui-home.sh"
chmod +x "$RT/scripts/codex-lead-tui-home.sh"
ln -s "$REAL_ROOT/lead-rules-base" "$RT/lead-rules-base"
ln -s "$REAL_ROOT/scripts/lib/canonical-lead-identity.sh" "$RT/scripts/lib/canonical-lead-identity.sh"

mkdir -p "$T/bin"
cat > "$T/bin/node" <<'EOF'
#!/bin/bash
if [[ " $* " == *" lead-identity resolve "* ]]; then
  printf '%s\n' "$CANONICAL_JSON"
  exit 0
fi
env > "$ENVDUMP"
EOF
chmod +x "$T/bin/node"

ENVDUMP="$T/envdump" PATH="$T/bin:$PATH" \
	FLYWHEEL_TEAMLEAD_ROOT="$RT" FLYWHEEL_LEAD_DRY_RUN=1 \
	FLYWHEEL_COMM_CLI="$T/flywheel-comm/dist/index.js" \
	RAYA_CODE_ROOT="$T/raya-code" RAYA_LEAD_WORKSPACE="$T/workspace" \
	RAYA_METRICS_DIR="$T/metrics" CODEX_HOME="$T/codex-home" \
	RAYA_BOT_TOKEN=DRY ENVDUMP="$T/envdump" \
	CANONICAL_JSON='{"schemaVersion":1,"leadId":"raya","projectName":"raya","leadKey":"raya-raya","agentTeamName":"raya","botUserId":"1542068543645024257","botTokenEnv":"RAYA_BOT_TOKEN","discordStateDir":"/tmp/discord-raya","backend":"codex-app-server","model":"gpt-5.6-sol","effort":"xhigh","modelContextWindow":1000000,"role":"cos","summaryRole":"recipient","summaryGranularity":"per-lead","hasSummaryDuty":false,"summaryAssignmentDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","projectsDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
	/bin/bash "$SUT" >/dev/null 2>&1
rc=$?

envval() { grep "^$2=" "$1" | head -1 | cut -d= -f2-; }
if [ "$rc" -ne 0 ] || [ ! -f "$T/envdump" ]; then
	fail "dry-run reaches runtime (rc=$rc)"
else
	[ "$(envval "$T/envdump" FLYWHEEL_CODEX_LEAD_PROFILE)" = full-access ] && pass "full-access profile" || fail "profile"
	[ "$(envval "$T/envdump" FLYWHEEL_CODEX_LEAD_MODE)" = tui ] && pass "windowed TUI mode" || fail "mode"
	[ "$(envval "$T/envdump" FLYWHEEL_LEAD_MODEL)" = gpt-5.6-sol ] && pass "canonical model" || fail "model"
	[ "$(envval "$T/envdump" FLYWHEEL_LEAD_EFFORT)" = xhigh ] && pass "canonical effort" || fail "effort"
	[ "$(envval "$T/envdump" FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW)" = 1000000 ] && pass "canonical context window" || fail "context window"
	[ "$(envval "$T/envdump" FLYWHEEL_CODEX_TUI_CWD)" = "$T/workspace" ] && pass "workspace is TUI cwd" || fail "workspace cwd"
	[ "$(envval "$T/envdump" RAYA_METRICS_DIR)" = "$T/metrics" ] && pass "metrics path projected" || fail "metrics"
	sp=$(envval "$T/envdump" FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)
	case "$sp" in "$T/raya-code/IDENTITY.md,$T/workspace/memory/MEMORY.md,"*founder-only-authority.md*) pass "identity + memory + governance order" ;; *) fail "prompt order ($sp)" ;; esac
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
