#!/usr/bin/env bash
# FLY-2131 — read-only, fail-closed gate before Raya is registered or started.
# The fixture PR must be an existing compliant summary PR (open or merged).
set -euo pipefail

die() {
	echo "[raya-activation-preflight] FAIL: $1" >&2
	exit 1
}

TEAMLEAD_ROOT="${FLYWHEEL_TEAMLEAD_ROOT:-/Users/xiaorongli/Dev/flywheel/packages/teamlead}"
COMM_CLI="${FLYWHEEL_COMM_CLI:-$(cd "${TEAMLEAD_ROOT}/.." && pwd)/flywheel-comm/dist/index.js}"
COMM_DIST="$(cd "$(dirname "$COMM_CLI")" && pwd)"
PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
LAUNCHER="${TEAMLEAD_ROOT}/scripts/run-codex-lead-raya-tui-fullaccess.sh"
RAYA_LEAD_WORKSPACE="${RAYA_LEAD_WORKSPACE:-${HOME}/Dev/raya-lead-workspace}"
FIXTURE_PR="${RAYA_SUMMARY_FIXTURE_PR:-}"

command -v node >/dev/null 2>&1 || die "node is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -f "$COMM_CLI" ]] || die "installed flywheel-comm CLI is missing: $COMM_CLI"
[[ -f "$COMM_DIST/summary-pr-merge.js" ]] || die "installed summary merge implementation is missing"
[[ -f "$PROJECTS_FILE" ]] || die "projects registry is missing: $PROJECTS_FILE"
[[ -r "$LAUNCHER" ]] || die "Raya launcher is missing: $LAUNCHER"
[[ -d "$RAYA_LEAD_WORKSPACE" ]] || die "Raya workspace is missing: $RAYA_LEAD_WORKSPACE"
[[ -d "$RAYA_LEAD_WORKSPACE/state" ]] || die "Raya workspace state directory is missing"
[[ -r "$RAYA_LEAD_WORKSPACE/memory/MEMORY.md" ]] || die "Raya memory is missing or unreadable"
[[ "$FIXTURE_PR" =~ ^[1-9][0-9]*$ ]] || die "RAYA_SUMMARY_FIXTURE_PR must be a positive PR number"

if ! jq -e '
	[.[] | select(.projectName == "raya") | (.leads // [])[] | select(.agentId == "raya")] as $matches |
	($matches | length) == 1 and
	$matches[0].backend == "codex-app-server" and
	$matches[0].codexProfile == "full-access" and
	$matches[0].canSpawnRunners == false and
	($matches[0].companion // false) == false
' "$PROJECTS_FILE" >/dev/null; then
	die "canonical Raya registry must be full-access, non-companion, and unable to spawn runners"
fi

identity_json="$(node "$COMM_CLI" lead-identity resolve \
	--projects-file "$PROJECTS_FILE" --project raya --lead raya --format json)" \
	|| die "canonical Raya identity did not resolve"
if ! jq -e '
	.leadId == "raya" and
	.projectName == "raya" and
	.backend == "codex-app-server" and
	.summaryRole == "recipient" and
	.role == "cos" and
	.botUserId == "1542068543645024257" and
	.botTokenEnv == "RAYA_BOT_TOKEN" and
	.model == "gpt-5.6-sol" and
	.effort == "xhigh" and
	.modelContextWindow == 1000000 and
	.hasSummaryDuty == false and
	(.summaryGranularity == "per-lead" or .summaryGranularity == "per-project")
' >/dev/null <<<"$identity_json"; then
	die "canonical Raya identity does not match the approved activation contract"
fi

export FLYWHEEL_PROJECT_NAME="raya"
export FLYWHEEL_LEAD_ID="raya"
export FLYWHEEL_LEAD_SUMMARY_ROLE="recipient"
export FLYWHEEL_LEAD_HAS_SUMMARY_DUTY="0"
export FLYWHEEL_SUMMARY_GRANULARITY
FLYWHEEL_SUMMARY_GRANULARITY="$(jq -er '.summaryGranularity' <<<"$identity_json")" \
	|| die "canonical summary granularity is unavailable"
summary_json="$(
	cd "$RAYA_LEAD_WORKSPACE"
	node "$COMM_CLI" summary merge --repo xrliAnnie/raya --pr "$FIXTURE_PR" \
		--round activation-preflight --dry-run
)" || die "installed mechanical summary merge dry-run failed"
if ! jq -e '
	.dryRun == true and
	(.action == "would-merge" or .action == "would-reconcile") and
	(.verifiedHeadSha | type == "string" and test("^[a-fA-F0-9]{40}$"))
' >/dev/null <<<"$summary_json"; then
	die "summary merge dry-run returned an unsafe or malformed result"
fi

launcher_output="$(
	env \
	-u FLYWHEEL_CANONICAL_IDENTITY_RESOLVED \
	-u FLYWHEEL_LEAD_ID -u LEAD_ID \
	-u FLYWHEEL_PROJECT_NAME -u PROJECT_NAME \
	-u FLYWHEEL_LEAD_KEY -u FLYWHEEL_LEAD_BACKEND \
	-u FLYWHEEL_LEAD_MODEL -u FLYWHEEL_LEAD_EFFORT \
	-u FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW \
	-u FLYWHEEL_LEAD_ROLE -u FLYWHEEL_LEAD_SUMMARY_ROLE \
	-u FLYWHEEL_LEAD_HAS_SUMMARY_DUTY \
	-u FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST \
	-u FLYWHEEL_LEAD_IDENTITY_DIGEST -u FLYWHEEL_LEAD_PROJECTS_DIGEST \
	-u DISCORD_STATE_DIR -u DISCORD_EXPECTED_BOT_USER_ID \
	-u DISCORD_IDENTITY_MODE -u DISCORD_BOT_TOKEN \
	-u FLYWHEEL_CODEX_LEAD_PROJECT_DIR -u FLYWHEEL_CODEX_TUI_CWD \
	-u FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES \
	FLYWHEEL_LEAD_DRY_RUN=1 \
	FLYWHEEL_TEAMLEAD_ROOT="$TEAMLEAD_ROOT" \
	FLYWHEEL_COMM_CLI="$COMM_CLI" \
	FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
	RAYA_LEAD_WORKSPACE="$RAYA_LEAD_WORKSPACE" \
	/bin/bash "$LAUNCHER"
)" || die "Raya full-access TUI launcher dry-run failed"
grep -Fq "[codex-lead-tui-runtime] DRY-RUN" <<<"$launcher_output" \
	|| die "Raya launcher did not reach the side-effect-free runtime dry-run"

echo "[raya-activation-preflight] PASS: summary latch, canonical identity, workspace, and TUI launcher"
