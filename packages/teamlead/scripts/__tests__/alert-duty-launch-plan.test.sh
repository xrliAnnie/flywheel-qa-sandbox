#!/bin/bash
set -uo pipefail

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
LEAD_SH="$TEST_DIR/../claude-lead.sh"
ROOT="$(cd "$TEST_DIR/../../../.." && pwd)"
DIST="$ROOT/packages/teamlead/dist"
[ -f "$DIST/ProjectConfig.js" ] || { echo "SKIP: build teamlead first"; exit 0; }

HOME_DIR="$(mktemp -d -t alert-duty-launch.XXXXXX)" || exit 1
trap 'rm -rf "$HOME_DIR"' EXIT
PROJECT_DIR="$HOME_DIR/flywheel"
mkdir -p "$PROJECT_DIR/.lead/claude-infra-bot-lead" "$PROJECT_DIR/.lead/flywheel-eng-lead"
printf '%s\n' '---' 'name: claude-infra-bot-lead' '---' 'Claw' > "$PROJECT_DIR/.lead/claude-infra-bot-lead/identity.md"
printf '%s\n' '---' 'name: flywheel-eng-lead' '---' 'Tadashi' > "$PROJECT_DIR/.lead/flywheel-eng-lead/identity.md"

PROJECTS="$(printf '[{"projectName":"flywheel","projectRoot":"%s","leads":[{"agentId":"claude-infra-bot-lead","chatChannel":"claw","alertChannel":"alerts","botUserId":"10000000000000001","match":{"labels":["infra"]}},{"agentId":"flywheel-eng-lead","chatChannel":"eng","alertChannel":"alerts","botUserId":"10000000000000002","match":{"labels":["eng"]}}]}]' "$PROJECT_DIR")"
CANARY="DUTY_CANARY_$$"

run_plan() {
  local lead="$1"
  env -i HOME="$HOME_DIR" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$PROJECTS" \
    DISCORD_BOT_TOKEN=bot-token TEAMLEAD_API_TOKEN=shared-token \
    FLYWHEEL_ALERT_DUTY_TOKEN="$CANARY" \
    bash "$LEAD_SH" "$lead" "$PROJECT_DIR" flywheel 2>&1
}

passed=0
failed=0
pass() { echo "  ✓ $1"; passed=$((passed + 1)); }
fail() { echo "  ✗ $1" >&2; failed=$((failed + 1)); }

echo "[TEST] alert duty launch capability"
claw_output="$(run_plan claude-infra-bot-lead)"
claw_plan="$(printf '%s\n' "$claw_output" | sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p')"
if grep -qF $'PANE_ENV\tFLYWHEEL_ALERT_DUTY_TOKEN\tset' <<<"$claw_plan"; then
  pass "Claw pane receives the duty capability"
else
  fail "Claw pane is missing the duty capability"
fi
if grep -qF $'PANE_ENV\tFLYWHEEL_DIR\tset' <<<"$claw_plan"; then
  pass "Claw pane receives the repository path used by the contact book"
else
  fail "Claw pane is missing FLYWHEEL_DIR for the contact book"
fi
if grep -qF "$CANARY" <<<"$claw_output"; then
  fail "launch output leaked the duty token value"
else
  pass "launch plan redacts the duty token value"
fi

eng_plan="$(run_plan flywheel-eng-lead | sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p')"
if grep -qF 'FLYWHEEL_ALERT_DUTY_TOKEN' <<<"$eng_plan" \
	|| grep -qF $'PANE_ENV\tFLYWHEEL_DIR\t' <<<"$eng_plan"; then
	fail "non-seat pane received the duty capability or repository path"
else
	pass "non-seat pane receives neither duty capability nor repository path"
fi

if grep -qF 'FLYWHEEL_ALERT_DUTY_TOKEN' "$ROOT/packages/teamlead/scripts/lead-body.sh" \
  && grep -qF 'FLYWHEEL_ALERT_DUTY_TOKEN' "$ROOT/scripts/flywheel-lead-wrapper-v2.sh" \
  && grep -qF 'lead-duty-provision.sh' "$ROOT/packages/teamlead/scripts/claude-lead.sh"; then
  pass "wrapper, body reload, and startup provisioning seams are all explicit"
else
  fail "one of the three launch seams is missing"
fi

echo "[RESULT] passed=$passed failed=$failed"
[ "$failed" -eq 0 ]
