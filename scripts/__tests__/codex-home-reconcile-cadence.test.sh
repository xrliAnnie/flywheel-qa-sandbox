#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESTART="$ROOT/scripts/restart-services.sh"
UPDATER="$ROOT/scripts/update-flywheel.sh"
PLUGIN="$ROOT/packages/teamlead/src/bridge/plugin.ts"
TEST_DEPLOY="$ROOT/scripts/test-deploy.sh"
TMP="$(mktemp -d /tmp/fly2523-cadence.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

sed -n '/^codex_home_reconcile_restart_window()/,/^}/p' "$RESTART" > "$TMP/restart-function.sh"
log() { :; }
FLYWHEEL_DIR="$ROOT"
FLYWHEEL_CODEX_RECONCILE_CYCLE_BIN="$TMP/cycle.mjs"
: > "$FLYWHEEL_CODEX_RECONCILE_CYCLE_BIN"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NODE_CALLS"
exit "${NODE_RC:-0}"
SH
chmod +x "$TMP/bin/node"
export PATH="$TMP/bin:$PATH" NODE_CALLS="$TMP/node-calls"
# shellcheck disable=SC1091
source "$TMP/restart-function.sh"

NODE_RC=0 codex_home_reconcile_restart_window flywheel/implement
NODE_RC=1 codex_home_reconcile_restart_window flywheel/implement
set +e
NODE_RC=75 codex_home_reconcile_restart_window flywheel/implement
unproven_rc=$?
set -e
[ "$unproven_rc" -eq 75 ]
[ "$(wc -l < "$NODE_CALLS" | tr -d ' ')" -eq 3 ]
grep -F -- '--source restart-window --home-id flywheel/implement' "$NODE_CALLS" >/dev/null

# The stopped Lead path refuses to arm/bootstrap after exit_unproven and first
# enters its existing recovery gate. The fleet path returns before Bridge start.
sed -n '/^restart_lead()/,/^}/p' "$RESTART" > "$TMP/restart-lead.body"
lead_guard="$(grep -n 'if ! codex_home_reconcile_restart_window "${project_name}/${lead_id}"; then' "$TMP/restart-lead.body" | cut -d: -f1)"
lead_recover="$(grep -n 'restart_lead_recover_job_after_failure' "$TMP/restart-lead.body" | awk -F: -v floor="$lead_guard" '$1 > floor { print $1; exit }')"
lead_arm="$(grep -n 'lead_restart_arm_controlled_wave' "$TMP/restart-lead.body" | cut -d: -f1)"
[ -n "$lead_guard" ] && [ -n "$lead_recover" ] && [ -n "$lead_arm" ]
[ "$lead_guard" -lt "$lead_recover" ] && [ "$lead_recover" -lt "$lead_arm" ]

sed -n '/^deploy_and_verify()/,/^}/p' "$RESTART" > "$TMP/deploy.body"
fleet_guard="$(grep -n 'if ! codex_home_reconcile_restart_window; then' "$TMP/deploy.body" | cut -d: -f1)"
bridge_start="$(grep -n '^[[:space:]]*start_bridge$' "$TMP/deploy.body" | head -1 | cut -d: -f1)"
[ -n "$fleet_guard" ] && [ -n "$bridge_start" ] && [ "$fleet_guard" -lt "$bridge_start" ]

# All callers ride existing updater, GatePoller health, or restart rhythms.
grep -Fq 'if ! updater_codex_home_reconcile; then' "$UPDATER"
grep -Fq 'updater_run_cycle' "$UPDATER"
grep -Fq 'createCodexHomeReconcileHealthRider' "$PLUGIN"
grep -Fq 'onHealthTick' "$PLUGIN"
grep -Fq 'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_HOME_RECONCILE_ENABLED=0")' "$TEST_DEPLOY"
grep -Fq 'CODEX_HOME_RECONCILE=0' "$TEST_DEPLOY"
grep -Fq -- '--codex-home-reconcile)' "$TEST_DEPLOY"
grep -Fq -- '--codex-home-reconcile requires --alerts' "$TEST_DEPLOY"
grep -Fq 'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_HOME_RECONCILE_ENABLED=1")' "$TEST_DEPLOY"
grep -Fq 'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_HOME_RECONCILE_SLOT=1")' "$TEST_DEPLOY"
grep -Fq 'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_HOME_RECONCILE_PROJECT=${TEST_PROJECT_NAME}")' "$TEST_DEPLOY"
grep -Fq 'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_HOME_RECONCILE_LEAD=${AGENT_ID}")' "$TEST_DEPLOY"
grep -Fq 'FLYWHEEL_STATE_DIR' "$ROOT/scripts/lib/qa-slot-env-contract.json"
[ -x "$ROOT/scripts/qa-fly-2523-529-alerts.sh" ]

# The opt-in fails before slot allocation unless the isolated alert route is
# explicitly requested too.
DEPLOY_HOME="$TMP/deploy-home"
mkdir -p "$DEPLOY_HOME/.flywheel"
: > "$DEPLOY_HOME/.flywheel/.env"
printf '%s\n' '{"guildId":"111111111111111111","slots":[]}' \
	> "$DEPLOY_HOME/.flywheel/test-slots.json"
set +e
HOME="$DEPLOY_HOME" bash "$TEST_DEPLOY" 1 --codex-home-reconcile \
	> "$TMP/deploy-negative.out" 2>&1
deploy_negative_rc=$?
set -e
[ "$deploy_negative_rc" -ne 0 ]
grep -F -- '--codex-home-reconcile requires --alerts' \
	"$TMP/deploy-negative.out" >/dev/null
if git -C "$ROOT" diff --name-only --diff-filter=A | grep -Eq '(^|/)(LaunchAgents|LaunchDaemons)/|\.plist$|crontab|cron\.'; then
	echo "FLY-2523 added a forbidden scheduler artifact" >&2
	exit 1
fi

echo "PASS Codex home reconcile existing cadence and restart fence"
