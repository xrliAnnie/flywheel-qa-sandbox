#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/codex-home-reconcile-cycle.mjs"
TMP="$(mktemp -d /tmp/fly2523-cycle.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

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
	FLYWHEEL_BUILD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
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

# Registered authority failure is fail-loud and cannot replace the last roster.
before="$(shasum -a 256 "$APPROVED" | awk '{print $1}')"
cat > "$AUTHORITY" <<'SH'
#!/usr/bin/env bash
exit 1
SH
set +e
run_cycle updater > "$TMP/failure.out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ]
[ "$(shasum -a 256 "$APPROVED" | awk '{print $1}')" = "$before" ]

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
