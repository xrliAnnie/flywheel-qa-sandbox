#!/bin/bash
set -uo pipefail

PASS=0
FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/raya-activation-preflight.sh"
REAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
T="$(mktemp -d /tmp/raya-activation.XXXXX)" || exit 1
trap 'rm -rf "$T"' EXIT

RT="$T/teamlead"
COMM="$T/flywheel-comm/dist/index.js"
mkdir -p "$RT/dist/lead-backends/codex/lead-actions" "$RT/scripts/lib" \
	"$T/flywheel-comm/dist" "$T/code" "$T/workspace/memory" \
	"$T/workspace/state" "$T/metrics" "$T/bin" "$T/codex-home"
printf '// cli\n' > "$COMM"
printf '// merge implementation\n' > "$T/flywheel-comm/dist/summary-pr-merge.js"
printf '// runtime\n' > "$RT/dist/lead-backends/codex/codex-lead-tui-runtime.js"
printf '// actions\n' > "$RT/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
printf '# Raya\n' > "$T/code/IDENTITY.md"
printf '# Memory\n' > "$T/workspace/memory/MEMORY.md"
printf '{}\n' > "$T/projects.json"
printf '#!/bin/bash\nexit 0\n' > "$RT/scripts/codex-lead-tui-home.sh"
chmod +x "$RT/scripts/codex-lead-tui-home.sh"
ln -s "$REAL_ROOT/lead-rules-base" "$RT/lead-rules-base"
ln -s "$REAL_ROOT/scripts/lib/canonical-lead-identity.sh" "$RT/scripts/lib/canonical-lead-identity.sh"
ln -s "$REAL_ROOT/scripts/lead-rules-bundle.sh" "$RT/scripts/lead-rules-bundle.sh"
ln -s "$SCRIPT_DIR/run-codex-lead-raya-tui-fullaccess.sh" "$RT/scripts/run-codex-lead-raya-tui-fullaccess.sh"

cat > "$T/bin/node" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$NODE_CALLS"
case " $* " in
	*" lead-identity resolve "*) printf '%s\n' "$IDENTITY_JSON" ;;
	*" summary merge "*) printf '%s\n' "$SUMMARY_DRY_RUN_JSON" ;;
	*) env > "$RUNTIME_ENV"; printf '%s\n' '[codex-lead-tui-runtime] DRY-RUN' ;;
esac
EOF
chmod +x "$T/bin/node"

GOOD_IDENTITY='{"schemaVersion":1,"leadId":"raya","projectName":"raya","leadKey":"raya-raya","agentTeamName":"raya","botUserId":"1542068543645024257","botTokenEnv":"RAYA_BOT_TOKEN","discordStateDir":"/tmp/discord-raya","backend":"codex-app-server","model":"gpt-5.6-sol","effort":"xhigh","modelContextWindow":1000000,"role":"cos","summaryRole":"recipient","summaryGranularity":"per-lead","hasSummaryDuty":false,"summaryAssignmentDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","projectsDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
GOOD_SUMMARY='{"verifiedHeadSha":"0123456789012345678901234567890123456789","files":["summaries/p/2026-08-28--01.md"],"projects":["p"],"dryRun":true,"action":"would-merge","method":"merge"}'

run_preflight() {
	PATH="$T/bin:$PATH" NODE_CALLS="$T/node.calls" RUNTIME_ENV="$T/runtime.env" \
		IDENTITY_JSON="${IDENTITY_JSON:-$GOOD_IDENTITY}" \
		SUMMARY_DRY_RUN_JSON="${SUMMARY_DRY_RUN_JSON:-$GOOD_SUMMARY}" \
		FLYWHEEL_TEAMLEAD_ROOT="$RT" FLYWHEEL_COMM_CLI="$COMM" \
		FLYWHEEL_PROJECTS_FILE="$T/projects.json" RAYA_CODE_ROOT="$T/code" \
		RAYA_LEAD_WORKSPACE="$T/workspace" RAYA_METRICS_DIR="$T/metrics" \
		CODEX_HOME="$T/codex-home" RAYA_SUMMARY_FIXTURE_PR=42 \
		/bin/bash "$SUT" "$@"
}

happy_output="$(run_preflight 2>&1)"
happy_rc=$?
if [ "$happy_rc" -eq 0 ] \
		&& grep -Fq 'summary merge --repo xrliAnnie/raya --pr 42 --round activation-preflight --dry-run' "$T/node.calls" \
		&& grep -Fq 'codex-lead-tui-runtime.js' "$T/node.calls"; then
	pass "installed summary dry-run and Raya launcher both pass"
else
	fail "happy activation preflight (rc=$happy_rc output=$happy_output calls=$(cat "$T/node.calls" 2>/dev/null))"
fi

mv "$T/flywheel-comm/dist/summary-pr-merge.js" "$T/flywheel-comm/dist/summary-pr-merge.js.absent"
: > "$T/node.calls"
if run_preflight >/dev/null 2>&1; then
	fail "missing installed summary merge implementation"
elif [ ! -s "$T/node.calls" ]; then
	pass "missing installed summary merge implementation fails before commands"
else
	fail "missing implementation reached a command"
fi
mv "$T/flywheel-comm/dist/summary-pr-merge.js.absent" "$T/flywheel-comm/dist/summary-pr-merge.js"

: > "$T/node.calls"
SUMMARY_DRY_RUN_JSON='{"dryRun":false,"action":"merged"}'
if run_preflight >/dev/null 2>&1; then
	fail "mutating or malformed summary response"
elif ! grep -Fq 'codex-lead-tui-runtime.js' "$T/node.calls"; then
	pass "invalid summary dry-run response blocks launcher"
else
	fail "invalid summary response reached launcher"
fi
unset SUMMARY_DRY_RUN_JSON

: > "$T/node.calls"
IDENTITY_JSON="${GOOD_IDENTITY/\"xhigh\"/\"medium\"}"
if run_preflight >/dev/null 2>&1; then
	fail "noncanonical Raya effort"
elif ! grep -Fq 'summary merge' "$T/node.calls"; then
	pass "identity mismatch fails before summary smoke"
else
	fail "identity mismatch reached summary smoke"
fi
unset IDENTITY_JSON

unset RAYA_SUMMARY_FIXTURE_PR
if PATH="$T/bin:$PATH" FLYWHEEL_TEAMLEAD_ROOT="$RT" FLYWHEEL_COMM_CLI="$COMM" \
		FLYWHEEL_PROJECTS_FILE="$T/projects.json" /bin/bash "$SUT" >/dev/null 2>&1; then
	fail "missing fixture PR"
else
	pass "fixture PR is mandatory"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
