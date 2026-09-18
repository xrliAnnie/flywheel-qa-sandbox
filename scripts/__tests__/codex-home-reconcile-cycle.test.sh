#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/codex-home-reconcile-cycle.mjs"
TMP="$(mktemp -d /tmp/fly2523-cycle.XXXXXX)"
SLOT_NUMBER="$((910000 + $$))"
SLOT_ROOT="/tmp/flywheel-test-slot-${SLOT_NUMBER}"
trap 'rm -rf "$TMP" "$SLOT_ROOT"' EXIT

USER_HOME="$TMP/home"
STATE_ROOT="$USER_HOME/.flywheel"
PROJECTS="$STATE_ROOT/projects.json"
POLICY="$TMP/policy.json"
APPROVED="$STATE_ROOT/codex-quota/approved-homes.json"
RUNNER_HOME="$STATE_ROOT/codex-homes/agents/flywheel/implement"
LEAD_HOME="$USER_HOME/.codex-raya"
CALLS="$TMP/calls"
ALERT_CALLS="$TMP/alert-calls"
mkdir -p "$RUNNER_HOME" "$LEAD_HOME"
printf '%s\n' '{"project":"flywheel","role":"implement"}' > "$RUNNER_HOME/.flywheel-agent-home.json"
cat > "$PROJECTS" <<JSON
[{"projectName":"raya","projectRoot":"$TMP/raya","leads":[{"agentId":"raya","summaryRole":"producer","chatChannel":"1","match":{"labels":["Raya"]},"backend":"codex-app-server","codexProfile":"full-access","canSpawnRunners":false}]}]
JSON
cat > "$POLICY" <<'JSON'
{"schemaVersion":1,"enabled":true,"overdueDays":1,"runnerHomes":[{"id":"flywheel/implement","project":"flywheel","role":"implement","relativeHome":".flywheel/codex-homes/agents/flywheel/implement","pendingAt":"2026-09-11T17:58:38.000Z"}]}
JSON

AUTHORITY="$TMP/authority.sh"
cat > "$AUTHORITY" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '{"codexHome":"$LEAD_HOME"}'
SH
chmod +x "$AUTHORITY"

RECONCILE="$TMP/reconcile.sh"
cat > "$RECONCILE" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$CALLS"
if [ ! -f "$STATE_ROOT/codex-quota/home-migration/state.json" ]; then
  mkdir -p "$STATE_ROOT/codex-quota/home-migration"
  node - "$APPROVED" "$STATE_ROOT/codex-quota/home-migration/state.json" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const approved = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const normalized = approved.map(({home, ownership}) => ({home, ownership})).sort((a, b) => a.home.localeCompare(b.home, "en"));
const inventoryDigest = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
const enrolledAt = "2099-01-01T00:00:00.000Z";
fs.writeFileSync(process.argv[3], JSON.stringify({schemaVersion:1, inventoryDigest, overdueDays:1, enrolledAt, homes:approved.map(({id, home, ownership}) => ({id, home, ownership, enrolledAt}))}));
NODE
fi
SH
chmod +x "$RECONCILE"

ALERT="$TMP/alert.sh"
cat > "$ALERT" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "\$@" >> "$ALERT_CALLS"
printf '\n' >> "$ALERT_CALLS"
printf '%s\n' 'sent message_id=123456789012345678'
SH
chmod +x "$ALERT"

PROCESS_PS="$TMP/process-ps"
cat > "$PROCESS_PS" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'start-%s\n' "${*: -1}"
SH
PROCESS_PROBE="$TMP/process-probe"
cat > "$PROCESS_PROBE" <<'SH'
#!/usr/bin/env bash
kill -0 "$1" >/dev/null 2>&1 && exit 0
exit 1
SH
chmod +x "$PROCESS_PS" "$PROCESS_PROBE"

run_cycle() {
	HOME="$USER_HOME" \
	FLYWHEEL_BUILD_SHA="${FLYWHEEL_BUILD_SHA_OVERRIDE:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" \
	FLYWHEEL_CODEX_PROJECTS_FILE="$PROJECTS" \
	FLYWHEEL_CODEX_HOME_POLICY="$POLICY" \
	FLYWHEEL_CODEX_APPROVED_HOMES="$APPROVED" \
	FLYWHEEL_CODEX_LEAD_AUTHORITY_BIN="$AUTHORITY" \
	FLYWHEEL_CODEX_RECONCILE_BIN="$RECONCILE" \
	FLYWHEEL_CODEX_ALERT_BIN="$ALERT" \
	FLYWHEEL_CODEX_RECONCILE_PS_BIN="$PROCESS_PS" \
	FLYWHEEL_CODEX_RECONCILE_GROUP_PROBE_BIN="$PROCESS_PROBE" \
	FLYWHEEL_CODEX_RECONCILE_NOW_MS="${FLYWHEEL_CODEX_RECONCILE_NOW_MS:-1000000}" \
	node "$SUT" --source "$1"
}

run_cycle health
jq -e --arg runner "$RUNNER_HOME" --arg lead "$LEAD_HOME" '
  length == 2 and
  map(.id) == ["flywheel/implement", "raya/raya"] and
  .[0].home == $runner and .[0].pendingAt == "2026-09-11T17:58:38.000Z" and
  .[1].home == $lead and .[1].leadTuple == "raya/raya"
' "$APPROVED" >/dev/null
[ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 1 ]
grep -F -- "--approved-homes $APPROVED --state-root $STATE_ROOT --source health" "$CALLS" >/dev/null

# Same health hour is a durable no-op, including after a fresh process launch.
run_cycle health
[ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 1 ]

# Updater is an explicit existing-cadence opportunity and may run early.
run_cycle updater
[ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 2 ]

# An enrolled home with no attempt receipt pages at the exact N-day boundary.
cat > "$AUTHORITY" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '{"codexHome":"$LEAD_HOME"}'
SH
chmod +x "$AUTHORITY"
inventory_digest="$(node - "$APPROVED" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const homes = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
  .map(({home, ownership}) => ({home, ownership}))
  .sort((a, b) => a.home.localeCompare(b.home, "en"));
process.stdout.write(crypto.createHash("sha256").update(JSON.stringify(homes)).digest("hex"));
NODE
)"
mkdir -p "$STATE_ROOT/codex-quota/home-migration/attempts"
cat > "$STATE_ROOT/codex-quota/home-migration/state.json" <<JSON
{"schemaVersion":1,"inventoryDigest":"$inventory_digest","overdueDays":1,"enrolledAt":"2026-09-11T17:58:38.000Z","homes":[{"id":"flywheel/implement","home":"$RUNNER_HOME","ownership":"managed","enrolledAt":"2026-09-11T17:58:38.000Z"},{"id":"raya/raya","home":"$LEAD_HOME","ownership":"managed","enrolledAt":"2026-09-12T17:58:38.000Z"}]}
JSON

# Failure-mutation family: once the durable state is overdue, no upstream
# control-plane failure may silently suppress the alert pipeline. System faults
# are warning-only, never mention a user, and leave a local delivery receipt.
valid_policy="$(cat "$POLICY")"
valid_projects="$(cat "$PROJECTS")"
valid_state="$(cat "$STATE_ROOT/codex-quota/home-migration/state.json")"
before="$(shasum -a 256 "$APPROVED" | awk '{print $1}')"
PIPELINE_RECEIPTS="$STATE_ROOT/codex-quota/home-migration/alert-pipeline-receipts"

assert_pipeline_degradation() {
	local layer="$1" reason="$2" receipt
	[ "$(wc -l < "$ALERT_CALLS" | tr -d ' ')" -eq 1 ]
	grep -F -- "--kind codex_home_migration_overdue --severity warning" "$ALERT_CALLS" >/dev/null
	grep -F -- "--title Codex\\ home\\ alert\\ pipeline\\ unavailable" "$ALERT_CALLS" >/dev/null
	grep -F -- "layer=$layer" "$ALERT_CALLS" >/dev/null
	grep -F -- "reason=$reason" "$ALERT_CALLS" >/dev/null
	grep -F -- "--signature alert-pipeline:approved-home-roster:$layer:$reason:20260912" "$ALERT_CALLS" >/dev/null
	if grep -F -- "--mention-user" "$ALERT_CALLS" >/dev/null; then
		echo "pipeline degradation alert must not mention a user" >&2
		exit 1
	fi
	receipt="$PIPELINE_RECEIPTS/20260912-$layer-$reason.json"
	jq -e --arg layer "$layer" --arg reason "$reason" '
	  .schemaVersion == 1 and .severity == "warning" and .mentionUserId == null and
	  .layer == $layer and .reason == $reason and .delivery.outcome == "sent"
	' "$receipt" >/dev/null
}

run_expected_failure() {
	local layer="$1" reason="$2"
	shift 2
	: > "$ALERT_CALLS"
	set +e
	FLYWHEEL_CODEX_RECONCILE_NOW_MS=1789235918000 "$@" > "$TMP/$layer.out" 2>&1
	local rc=$?
	set -e
	[ "$rc" -ne 0 ]
	assert_pipeline_degradation "$layer" "$reason"
}

cat > "$AUTHORITY" <<'SH'
#!/usr/bin/env bash
exit 1
SH
run_expected_failure roster roster_unavailable run_cycle updater
[ "$(shasum -a 256 "$APPROVED" | awk '{print $1}')" = "$before" ]
cat > "$AUTHORITY" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '{"codexHome":"$LEAD_HOME"}'
SH
chmod +x "$AUTHORITY"

printf '%s\n' '{}' > "$POLICY"
run_expected_failure policy policy_invalid run_cycle updater
printf '%s\n' "$valid_policy" > "$POLICY"

printf '%s\n' '{' > "$PROJECTS"
run_expected_failure projects projects_invalid run_cycle updater
printf '%s\n' "$valid_projects" > "$PROJECTS"

: > "$ALERT_CALLS"
set +e
FLYWHEEL_BUILD_SHA_OVERRIDE=invalid \
	FLYWHEEL_CODEX_RECONCILE_NOW_MS=1789235918000 run_cycle updater \
	> "$TMP/build.out" 2>&1
build_rc=$?
set -e
[ "$build_rc" -ne 0 ]
assert_pipeline_degradation build build_sha_invalid

printf '%s\n' '{' > "$STATE_ROOT/codex-quota/home-migration/state.json"
run_expected_failure overdue_evaluation migration_state_invalid run_cycle updater
printf '%s\n' "$valid_state" > "$STATE_ROOT/codex-quota/home-migration/state.json"

: > "$ALERT_CALLS"
FLYWHEEL_CODEX_RECONCILE_NOW_MS=1789235917999 run_cycle updater
[ ! -s "$ALERT_CALLS" ]
FLYWHEEL_CODEX_RECONCILE_NOW_MS=1789235918000 run_cycle updater
[ "$(wc -l < "$ALERT_CALLS" | tr -d ' ')" -eq 1 ]

# An unproven managed child exit is distinct from an ordinary failed attempt so
# stopped restart windows can remain closed.
UNPROVEN_MANAGER="$TMP/unproven-manager.sh"
cat > "$UNPROVEN_MANAGER" <<'SH'
#!/usr/bin/env bash
exit 75
SH
chmod +x "$UNPROVEN_MANAGER"
set +e
FLYWHEEL_CODEX_RECONCILE_PROCESS_BIN="$UNPROVEN_MANAGER" \
	FLYWHEEL_CODEX_RECONCILE_NOW_MS=1789235918000 run_cycle updater \
	> "$TMP/unproven.out" 2>&1
unproven_rc=$?
set -e
[ "$unproven_rc" -eq 75 ]
grep -F 'reason=reconcile_exit_unproven' "$TMP/unproven.out" >/dev/null
grep -F -- "--lead flywheel-eng-lead --project flywheel --kind codex_home_migration_overdue --severity severe" "$ALERT_CALLS" >/dev/null
grep -F -- "--signature $inventory_digest:flywheel/implement:2026-09-12T17:58:38.000Z:20260912" "$ALERT_CALLS" >/dev/null
grep -F -- "flywheel/implement" "$ALERT_CALLS" >/dev/null
grep -F -- "raya/raya" "$ALERT_CALLS" >/dev/null
grep -F -- "--source manual --home-id flywheel/implement" "$ALERT_CALLS" >/dev/null

# A durable current-inventory satisfying receipt suppresses the overdue page.
cat > "$STATE_ROOT/codex-quota/home-migration/attempts/8e237eaa-b23c-432f-a507-ad28052b51bc.json" <<JSON
{"schemaVersion":1,"attemptId":"8e237eaa-b23c-432f-a507-ad28052b51bc","at":"2026-09-12T17:58:38.000Z","homeId":"flywheel/implement","home":"$RUNNER_HOME","inventoryDigest":"$inventory_digest","source":"updater","buildSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","result":"done","reason":"linked","satisfied":true,"backupRef":null,"postcondition":{"credentialShared":true,"pending":false}}
JSON
FLYWHEEL_CODEX_RECONCILE_NOW_MS=1789235918000 run_cycle updater
[ "$(wc -l < "$ALERT_CALLS" | tr -d ' ')" -eq 2 ]

# Once every current-digest home is satisfied, the same existing cadence emits
# the deployment readiness receipt without a separate human-scheduled step.
mkdir -p "$USER_HOME/.codex"
printf '{}' > "$USER_HOME/.codex/auth.json"
chmod 600 "$USER_HOME/.codex/auth.json"
ln -s "$USER_HOME/.codex/auth.json" "$RUNNER_HOME/auth.json"
ln -s "$USER_HOME/.codex/auth.json" "$LEAD_HOME/auth.json"
cat > "$STATE_ROOT/codex-quota/home-migration/attempts/62fbdc95-5825-4f0b-a654-6938b1825faa.json" <<JSON
{"schemaVersion":1,"attemptId":"62fbdc95-5825-4f0b-a654-6938b1825faa","at":"2026-09-12T17:58:38.000Z","homeId":"raya/raya","home":"$LEAD_HOME","inventoryDigest":"$inventory_digest","source":"updater","buildSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","result":"already-satisfied","reason":"canonical_link_verified","satisfied":true,"backupRef":null,"postcondition":{"credentialShared":true,"pending":false}}
JSON
FLYWHEEL_CODEX_RECONCILE_NOW_MS=1789235918000 run_cycle updater
jq -e --arg digest "$inventory_digest" '.inventoryDigest == $digest and (.homes | length) == 2' \
	"$STATE_ROOT/codex-quota/readiness-receipt.json" >/dev/null

# Explicit QA-slot mode keeps every writable cycle coordinate under the slot
# root and rewrites both severe and warning alert tuples to the slot project.
SLOT_PROJECT="test-slot-${SLOT_NUMBER}"
SLOT_LEAD="cos-test-${SLOT_NUMBER}"
SLOT_FIXTURE="$SLOT_ROOT/state/fly2523-alert-driver"
SLOT_PROJECTS="$SLOT_ROOT/flywheel-projects.json"
SLOT_POLICY="$SLOT_FIXTURE/policy.json"
SLOT_APPROVED="$SLOT_FIXTURE/approved-homes.json"
SLOT_RUNNER_HOME="$SLOT_FIXTURE/runner-home"
SLOT_CANONICAL_HOME="$SLOT_FIXTURE/canonical-home"
SLOT_ALERT_CALLS="$SLOT_FIXTURE/alert-calls"
SLOT_ALERT="$SLOT_FIXTURE/alert.sh"
SLOT_RECONCILE="$SLOT_FIXTURE/reconcile.sh"
mkdir -p "$SLOT_RUNNER_HOME" "$SLOT_CANONICAL_HOME"
printf '%s\n' '{"project":"fixture","role":"implement"}' \
	> "$SLOT_RUNNER_HOME/.flywheel-agent-home.json"
cat > "$SLOT_PROJECTS" <<JSON
[{"projectName":"$SLOT_PROJECT","projectRoot":"$SLOT_FIXTURE/repo","generalChannel":"777777777777777777","leads":[{"agentId":"$SLOT_LEAD","summaryRole":"producer","chatChannel":"777777777777777777","match":{"labels":["*"]}}]}]
JSON
cat > "$SLOT_POLICY" <<JSON
{"schemaVersion":1,"enabled":true,"overdueDays":1,"runnerHomes":[{"id":"fixture/implement","project":"fixture","role":"implement","relativeHome":"state/fly2523-alert-driver/runner-home","pendingAt":"2026-09-11T17:58:38.000Z"}]}
JSON
cat > "$SLOT_RECONCILE" <<'SH'
#!/usr/bin/env bash
exit 75
SH
cat > "$SLOT_ALERT" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "\$@" >> "$SLOT_ALERT_CALLS"
printf '\n' >> "$SLOT_ALERT_CALLS"
printf '%s\n' 'sent message_id=123456789012345678'
SH
chmod +x "$SLOT_RECONCILE" "$SLOT_ALERT"
slot_inventory_digest="$(node - "$SLOT_RUNNER_HOME" <<'NODE'
const crypto = require("crypto");
const home = process.argv[2];
process.stdout.write(crypto.createHash("sha256").update(JSON.stringify([{home, ownership:"managed"}])).digest("hex"));
NODE
)"
mkdir -p "$SLOT_ROOT/codex-quota/home-migration/attempts"
cat > "$SLOT_ROOT/codex-quota/home-migration/state.json" <<JSON
{"schemaVersion":1,"inventoryDigest":"$slot_inventory_digest","overdueDays":1,"enrolledAt":"2026-09-11T17:58:38.000Z","homes":[{"id":"fixture/implement","home":"$SLOT_RUNNER_HOME","ownership":"managed","enrolledAt":"2026-09-11T17:58:38.000Z"}]}
JSON

run_slot_cycle() {
	HOME="$USER_HOME" \
	FLYWHEEL_BUILD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
	FLYWHEEL_CODEX_HOME_RECONCILE_SLOT=1 \
	FLYWHEEL_ISOLATION_ROOT="$SLOT_ROOT" \
	FLYWHEEL_STATE_DIR="$SLOT_ROOT" \
	FLYWHEEL_CODEX_HOME_RECONCILE_PROJECT="$SLOT_PROJECT" \
	FLYWHEEL_CODEX_HOME_RECONCILE_LEAD="$SLOT_LEAD" \
	TEAMLEAD_DEFAULT_LEAD_AGENT="$SLOT_LEAD" \
	FLYWHEEL_CODEX_PROJECTS_FILE="$SLOT_PROJECTS" \
	FLYWHEEL_CODEX_HOME_POLICY="$SLOT_POLICY" \
	FLYWHEEL_CODEX_APPROVED_HOMES="${FLYWHEEL_CODEX_APPROVED_HOMES_OVERRIDE:-$SLOT_APPROVED}" \
	FLYWHEEL_CODEX_RECONCILE_BIN="$SLOT_RECONCILE" \
	FLYWHEEL_CODEX_ALERT_BIN="$SLOT_ALERT" \
	FLYWHEEL_CODEX_RECONCILE_PS_BIN="$PROCESS_PS" \
	FLYWHEEL_CODEX_RECONCILE_GROUP_PROBE_BIN="$PROCESS_PROBE" \
	FLYWHEEL_CODEX_SOURCE_HOME="$SLOT_CANONICAL_HOME" \
	FLYWHEEL_CODEX_RECONCILE_NOW_MS="1789235918000" \
		node "$SUT" --source updater
}

: > "$SLOT_ALERT_CALLS"
set +e
run_slot_cycle > "$TMP/slot-severe.out" 2>&1
slot_severe_rc=$?
set -e
[ "$slot_severe_rc" -eq 75 ]
grep -F -- "--lead $SLOT_LEAD --project $SLOT_PROJECT --kind codex_home_migration_overdue --severity severe" \
	"$SLOT_ALERT_CALLS" >/dev/null

# A distinct upstream control-plane failure routes a warning to the same slot.
printf '%s\n' '{}' > "$SLOT_POLICY"
set +e
run_slot_cycle > "$TMP/slot-warning.out" 2>&1
slot_warning_rc=$?
set -e
[ "$slot_warning_rc" -ne 0 ]
grep -F -- "--lead $SLOT_LEAD --project $SLOT_PROJECT --kind codex_home_migration_overdue --severity warning" \
	"$SLOT_ALERT_CALLS" >/dev/null

tree_snapshot() {
	node - "$1" <<'NODE'
const { createHash } = require("crypto");
const { lstatSync, readFileSync, readdirSync } = require("fs");
const { join, relative } = require("path");
const root = process.argv[2];
const rows = [];
function walk(path) {
  const stat = lstatSync(path);
  const row = [relative(root, path) || ".", stat.ino, stat.mode, stat.size,
    stat.mtimeMs, stat.ctimeMs];
  if (stat.isFile()) row.push(createHash("sha256").update(readFileSync(path)).digest("hex"));
  rows.push(row);
  if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
}
walk(root);
process.stdout.write(JSON.stringify(rows));
NODE
}

# A malformed slot coordinate is rejected before mkdir/chmod/lock/schedule and
# cannot alter the production migration fixture tree.
production_before="$(tree_snapshot "$STATE_ROOT/codex-quota/home-migration")"
set +e
FLYWHEEL_CODEX_APPROVED_HOMES_OVERRIDE="$TMP/outside-approved.json" \
	run_slot_cycle > "$TMP/slot-escape.out" 2>&1
slot_escape_rc=$?
set -e
[ "$slot_escape_rc" -ne 0 ]
[ "$(tree_snapshot "$STATE_ROOT/codex-quota/home-migration")" = "$production_before" ]
grep -F 'reason=slot_path_outside_isolation' "$TMP/slot-escape.out" >/dev/null

RESTART="$ROOT/scripts/restart-services.sh"
deploy_body="$TMP/deploy-body"
lead_body="$TMP/lead-body"
sed -n '/^deploy_and_verify()/,/^}/p' "$RESTART" > "$deploy_body"
sed -n '/^restart_lead()/,/^}/p' "$RESTART" > "$lead_body"
build_line="$(grep -n 'if ! build_project' "$deploy_body" | head -1 | cut -d: -f1)"
managed_line="$(grep -n 'if ! codex_home_reconcile_restart_window; then' "$deploy_body" | head -1 | cut -d: -f1)"
bridge_line="$(grep -n '^[[:space:]]*start_bridge$' "$deploy_body" | head -1 | cut -d: -f1)"
[ -n "$build_line" ] && [ -n "$managed_line" ] && [ -n "$bridge_line" ]
[ "$build_line" -lt "$managed_line" ] && [ "$managed_line" -lt "$bridge_line" ]
clear_line="$(grep -n 'lead_body_hard_clear' "$lead_body" | head -1 | cut -d: -f1)"
target_line="$(grep -n 'if ! codex_home_reconcile_restart_window "${project_name}/${lead_id}"; then' "$lead_body" | head -1 | cut -d: -f1)"
arm_line="$(grep -n 'lead_restart_arm_controlled_wave' "$lead_body" | head -1 | cut -d: -f1)"
[ -n "$clear_line" ] && [ -n "$target_line" ] && [ -n "$arm_line" ]
[ "$clear_line" -lt "$target_line" ] && [ "$target_line" -lt "$arm_line" ]

echo "PASS Codex home reconcile existing-cadence cycle"
