#!/usr/bin/env bash
# Reproducible FLY-2523 QA-room driver: one overdue severe alert followed by
# one upstream-control-plane warning. All writable state stays in the selected
# /tmp/flywheel-test-slot-N tree; the production projects registry is read only
# by lead-alert.sh's channel-collision guard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
	echo "FLY2523_QA_ALERT_DRIVER unavailable reason=$1" >&2
	exit 1
}

trusted_slot_file() {
	local path="$1" metadata owner mode
	[ -f "$path" ] && [ ! -L "$path" ] || return 1
	metadata=$(stat -f '%u %Lp' "$path" 2>/dev/null \
		|| stat -c '%u %a' "$path" 2>/dev/null) || return 1
	owner=${metadata%% *}
	mode=${metadata##* }
	[ "$owner" = "$(id -u)" ] && [ "$mode" = "600" ]
}

slot="${1:-}"
[[ "$slot" =~ ^[1-9][0-9]*$ ]] || fail slot_invalid
[ "$#" -eq 1 ] || fail usage
slot_root="/tmp/flywheel-test-slot-${slot}"
slot_lock="${slot_root}.lock/pid"
[ -d "$slot_root" ] && [ ! -L "$slot_root" ] || fail slot_root_unavailable
slot_pid=$(cat "$slot_lock" 2>/dev/null) || fail slot_lock_unavailable
if [[ ! "$slot_pid" =~ ^[1-9][0-9]*$ ]] \
		|| ! kill -0 "$slot_pid" 2>/dev/null; then
	fail slot_not_live
fi

project="test-slot-${slot}"
projects="$slot_root/flywheel-projects.json"
env_file="$slot_root/q/$slot/.env"
trusted_slot_file "$projects" || fail projects_untrusted
trusted_slot_file "$env_file" || fail env_untrusted
/bin/bash -n "$env_file" >/dev/null 2>&1 || fail env_invalid

binding=$(jq -cer --arg project "$project" '
  [ .[] | select(.projectName == $project) as $p
    | $p.leads[]?
    | select((.alertChannel // "") | test("^[0-9]{17,20}$"))
    | {leadId:.agentId, channelId:.alertChannel,
       tokenEnv:(.alertBotTokenEnv // .botTokenEnv // "")} ]
  | if length == 1 then .[0] else error("expected one slot alert Lead") end
  | select((.leadId | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")) and
           (.tokenEnv | test("^[A-Za-z_][A-Za-z0-9_]*$")))
' "$projects") || fail lead_binding_invalid
lead=$(jq -r '.leadId' <<<"$binding")
channel=$(jq -r '.channelId' <<<"$binding")
token_env=$(jq -r '.tokenEnv' <<<"$binding")

# The mode-0600 wrapper env is the slot's credential authority. Do not print it
# or copy its token into a generated artifact.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
[ -n "${!token_env:-}" ] || fail token_binding_unresolved

run_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$-$RANDOM"
driver_root="$slot_root/state/fly2523-alert-driver"
run_root="$driver_root/runs/$run_id"
state_root="$run_root/state-root"
runner_home="$run_root/runner-home"
canonical_home="$run_root/canonical-home"
project_root="$run_root/project"
policy="$run_root/policy.json"
approved="$run_root/approved-homes.json"
reconcile="$run_root/reconcile.sh"
mkdir -p "$state_root/codex-quota/home-migration/attempts" \
	"$runner_home" "$canonical_home" "$project_root" \
	"$run_root/alert-queue" "$run_root/alert-deadletter" "$run_root/alerts"
chmod 700 "$driver_root" "$driver_root/runs" "$run_root" "$state_root" \
	"$runner_home" "$canonical_home" "$project_root" \
	"$run_root/alert-queue" "$run_root/alert-deadletter" "$run_root/alerts"
printf '%s\n' '{"project":"fixture","role":"implement"}' \
	> "$runner_home/.flywheel-agent-home.json"
printf '%s\n' '{}' > "$canonical_home/auth.json"
chmod 600 "$runner_home/.flywheel-agent-home.json" "$canonical_home/auth.json"

runner_relative="state/fly2523-alert-driver/runs/${run_id}/runner-home"
cat > "$policy" <<JSON
{"schemaVersion":1,"enabled":true,"overdueDays":1,"runnerHomes":[{"id":"fixture/implement","project":"fixture","role":"implement","relativeHome":"$runner_relative","pendingAt":"2020-01-01T00:00:00.000Z"}]}
JSON
cat > "$reconcile" <<'SH'
#!/usr/bin/env bash
# Leave the prebuilt overdue state intact, then exercise the cycle's unproven
# child branch after it has delivered the severe alert.
exit 75
SH
chmod 600 "$policy"
chmod 700 "$reconcile"

inventory_digest=$(node - "$runner_home" <<'NODE'
const crypto = require("crypto");
const home = process.argv[2];
process.stdout.write(crypto.createHash("sha256")
  .update(JSON.stringify([{home, ownership:"managed"}])).digest("hex"));
NODE
)
cat > "$state_root/codex-quota/home-migration/state.json" <<JSON
{"schemaVersion":1,"inventoryDigest":"$inventory_digest","overdueDays":1,"enrolledAt":"2020-01-01T00:00:00.000Z","homes":[{"id":"fixture/implement","home":"$runner_home","ownership":"managed","enrolledAt":"2020-01-01T00:00:00.000Z"}]}
JSON
chmod 600 "$state_root/codex-quota/home-migration/state.json"

production_projects="${FLYWHEEL_CODEX_PRODUCTION_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
build_sha=$(git -C "$ROOT" rev-parse HEAD)
common_env=(
	"HOME=$HOME"
	"FLYWHEEL_BUILD_SHA=$build_sha"
	"FLYWHEEL_CODEX_HOME_RECONCILE_SLOT=1"
	"FLYWHEEL_ISOLATION_ROOT=$slot_root"
	"FLYWHEEL_STATE_DIR=$state_root"
	"FLYWHEEL_CODEX_HOME_RECONCILE_PROJECT=$project"
	"FLYWHEEL_CODEX_HOME_RECONCILE_LEAD=$lead"
	"TEAMLEAD_DEFAULT_LEAD_AGENT=$lead"
	"FLYWHEEL_CODEX_PROJECTS_FILE=$projects"
	"FLYWHEEL_PROJECTS_FILE=$projects"
	"FLYWHEEL_CODEX_PRODUCTION_PROJECTS_FILE=$production_projects"
	"FLYWHEEL_CODEX_HOME_POLICY=$policy"
	"FLYWHEEL_CODEX_APPROVED_HOMES=$approved"
	"FLYWHEEL_CODEX_RECONCILE_BIN=$reconcile"
	"FLYWHEEL_CODEX_ALERT_BIN=$ROOT/scripts/lead-alert.sh"
	"FLYWHEEL_CODEX_SOURCE_HOME=$canonical_home"
	"FLYWHEEL_ALERT_QUEUE_DIR=$run_root/alert-queue"
	"FLYWHEEL_ALERT_DEADLETTER_DIR=$run_root/alert-deadletter"
	"FLYWHEEL_CLAIMS_DB=$run_root/alerts/claims.db"
)

set +e
severe_output=$(env -u FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID \
	-u FLYWHEEL_ALERT_SENDER_TOKEN_ENV "${common_env[@]}" \
	node "$ROOT/scripts/codex-home-reconcile-cycle.mjs" --source updater 2>&1)
severe_rc=$?
set -e
[ "$severe_rc" -eq 75 ] || { printf '%s\n' "$severe_output" >&2; fail severe_cycle_unexpected; }
severe_id=$(printf '%s\n' "$severe_output" \
	| sed -n 's/^sent message_id=\([0-9][0-9]*\)$/\1/p' | tail -n 1)
[[ "$severe_id" =~ ^[0-9]{17,20}$ ]] || fail severe_delivery_unproven

# The second run corrupts an upstream input deliberately. The existing overdue
# obligation makes the cycle emit its warning-only degradation alert.
printf '%s\n' '{}' > "$policy"
chmod 600 "$policy"
set +e
warning_output=$(env -u FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID \
	-u FLYWHEEL_ALERT_SENDER_TOKEN_ENV "${common_env[@]}" \
	node "$ROOT/scripts/codex-home-reconcile-cycle.mjs" --source updater 2>&1)
warning_rc=$?
set -e
[ "$warning_rc" -ne 0 ] || fail warning_cycle_unexpected
warning_id=$(printf '%s\n' "$warning_output" \
	| sed -n 's/^sent message_id=\([0-9][0-9]*\)$/\1/p' | tail -n 1)
[[ "$warning_id" =~ ^[0-9]{17,20}$ ]] || { printf '%s\n' "$warning_output" >&2; fail warning_delivery_unproven; }

jq -cn --argjson slot "$slot" --arg project "$project" --arg lead "$lead" \
	--arg channelId "$channel" --arg severe "$severe_id" \
	--arg warning "$warning_id" --arg runRoot "$run_root" \
	'{schemaVersion:1,slot:$slot,project:$project,lead:$lead,channelId:$channelId,
	  severe:{severity:"severe",messageId:$severe},
	  warning:{severity:"warning",messageId:$warning},runRoot:$runRoot}'
