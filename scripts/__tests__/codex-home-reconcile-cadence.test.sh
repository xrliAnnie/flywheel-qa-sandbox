#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESTART="$ROOT/scripts/restart-services.sh"
UPDATER="$ROOT/scripts/update-flywheel.sh"
PLUGIN="$ROOT/packages/teamlead/src/bridge/plugin.ts"
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
if git -C "$ROOT" diff --name-only --diff-filter=A | grep -Eq '(^|/)(LaunchAgents|LaunchDaemons)/|\.plist$|crontab|cron\.'; then
	echo "FLY-2523 added a forbidden scheduler artifact" >&2
	exit 1
fi

echo "PASS Codex home reconcile existing cadence and restart fence"
