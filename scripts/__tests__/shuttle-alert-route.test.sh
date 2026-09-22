#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2669-route.XXXXXX")"
cleanup() {
  chmod -R u+w "$TMP" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

PROJECTS="$TMP/projects.json"
printf '%s\n' '[
  {"projectName":"flywheel","projectRoot":"/fixture/flywheel","shuttlePrimaryEngineeringLeadId":"infra-lead","leads":[{"agentId":"infra-lead","chatChannel":"100000000000000001","botTokenEnv":"INFRA_TOKEN","botUserId":"200000000000000001","match":{"labels":["Engineering"]},"summaryRole":"aggregator"}]},
  {"projectName":"alpha","projectRoot":"/fixture/alpha","shuttleEngineeringLeadId":"alpha-lead","leads":[{"agentId":"alpha-lead","chatChannel":"100000000000000002","botTokenEnv":"ALPHA_TOKEN","botUserId":"200000000000000002","match":{"labels":["Engineering"]},"summaryRole":"none"}]},
  {"projectName":"beta","projectRoot":"/fixture/beta","leads":[{"agentId":"beta-lead","chatChannel":"100000000000000003","match":{"labels":["Engineering"]},"summaryRole":"none"}]}
]' >"$PROJECTS"

CHECK="$TMP/check.json"
node "$ROOT/scripts/shuttle-route-bindings.mjs" --check --projects-file "$PROJECTS" >"$CHECK"
jq -e '.ok == true and .primary.leadId == "infra-lead" and .copyProjects == ["alpha"]' "$CHECK" >/dev/null

PRIMARY="$TMP/primary.json"
COPY="$TMP/copy.json"
node "$ROOT/scripts/shuttle-route-bindings.mjs" --resolve --projects-file "$PROJECTS" \
  --origin-project beta --route-key primary >"$PRIMARY"
node "$ROOT/scripts/shuttle-route-bindings.mjs" --resolve --projects-file "$PROJECTS" \
  --origin-project alpha --route-key project_copy >"$COPY"
jq -e '.channelId == "100000000000000001" and .deliveryProject == "flywheel"' "$PRIMARY" >/dev/null
jq -e '.channelId == "100000000000000002" and .deliveryProject == "alpha"' "$COPY" >/dev/null

# The shell sender must delegate the new kind to the same resolver rather than
# grow a second hard-coded identity/channel map.
grep -Fq 'shuttle-route-bindings.mjs' "$ROOT/scripts/lead-alert.sh"
grep -Fq 'shuttle_unit_unhealthy' "$ROOT/scripts/lead-alert.sh"

# Exercise the real shell sender with an isolated observation ledger, a local
# permission witness, and a captured Discord POST. No production channel or
# token is touched.
TEST_FLYWHEEL_HOME="$TMP/home/.flywheel"
export FLYWHEEL_HOME="$TEST_FLYWHEEL_HOME"
export FLYWHEEL_PROJECTS_FILE="$PROJECTS"
export FLYWHEEL_STATE_DIR="$TEST_FLYWHEEL_HOME"
export FLYWHEEL_CLAIMS_DB="$TEST_FLYWHEEL_HOME/alerts/claims.db"
export FLYWHEEL_ALERT_QUEUE_DIR="$TEST_FLYWHEEL_HOME/alert-queue"
export FLYWHEEL_ALERT_DEADLETTER_DIR="$TEST_FLYWHEEL_HOME/alert-deadletter"
export FLYWHEEL_SYSTEM_ALERT_ENV_FILE=/dev/null
export FLYWHEEL_DEPLOYED_SHA_FILE="$TEST_FLYWHEEL_HOME/deployed-sha"
export INFRA_TOKEN=fixture-token
export UNIFIED_ALERT_TOKEN=fixture-unified-token
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV=UNIFIED_ALERT_TOKEN
export SHUTTLE_ROUTE_PERMISSION_FIXTURE="$TMP/permissions.json"
mkdir -p "$FLYWHEEL_HOME" "$TMP/bin"
printf '%s\n' '{"guildId":"900000000000000001","memberId":"200000000000000009","memberRoleIds":[],"roles":[{"id":"900000000000000001","permissions":"3072"}],"overwrites":[]}' >"$SHUTTLE_ROUTE_PERMISSION_FIXTURE"
printf '%s\n' '[{"projectName":"beta","unitKind":"external_repo","ownerKey":"beta-repo","displayName":"Beta external"}]' >"$TMP/inventory.json"

# A unified alert sender is intentionally not the Lead bot. Preflight must
# validate the selected sender's permissions without requiring its id to equal
# the route Lead's botUserId.
node "$ROOT/scripts/shuttle-route-bindings.mjs" --resolve --projects-file "$PROJECTS" \
  --origin-project beta --route-key primary --permission-preflight \
  --permission-fixture "$SHUTTLE_ROUTE_PERMISSION_FIXTURE" \
  --sender-token-env UNIFIED_ALERT_TOKEN >"$TMP/unified-preflight.json"
jq -e '.permissionPreflight.checked == true and
  .permissionPreflight.botUserId == "200000000000000009"' \
  "$TMP/unified-preflight.json" >/dev/null
cat >"$TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
out="" url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    -K) cat >/dev/null; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\n' "$url" >>"$CURL_CAPTURE"
printf '%s\n' '{"id":"300000000000000001"}' >"$out"
printf '200'
CURL
chmod +x "$TMP/bin/curl"
export CURL_CAPTURE="$TMP/curl-capture"
export PATH="$TMP/bin:$PATH"

HELPER="$ROOT/scripts/lib/shuttle-observation.py"
CATALOG="$ROOT/scripts/lib/shuttle-reasons.json"
CYCLE_JSON="$TMP/cycle.json"
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-17T12:06:23Z \
  begin --wake-kind scheduled --inventory "$TMP/inventory.json" \
  --owner-pid $$ --owner-start fixture >"$CYCLE_JSON"
CYCLE_ID="$(jq -r .cycleId "$CYCLE_JSON")"
printf '%s\n' '{"projectName":"beta","unitKind":"external_repo","ownerKey":"beta-repo","displayName":"Beta external","outcome":"failed","reason":"prestop-validation-failed","evidenceRef":"external:prestop","logRef":"flywheel-updater.log#external","deployedSha":null,"targetSha":null,"behindCommits":105,"driftBasis":"first_observed_behind"}' >"$TMP/result.json"
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-17T12:06:23Z \
  record --cycle-id "$CYCLE_ID" --result "$TMP/result.json" >/dev/null
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-17T12:06:24Z \
  finish --cycle-id "$CYCLE_ID" --legacy-result scheduled_deployed >/dev/null
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-17T12:06:24Z \
  prepare-dispatch --cycle-id "$CYCLE_ID" >"$TMP/dispatch.json"
BATCH_ID="$(jq -r '.batches[0].batchId' "$TMP/dispatch.json")"

DELIVERY="$(/bin/bash "$ROOT/scripts/lead-alert.sh" --project beta --lead updater \
  --kind shuttle_unit_unhealthy --severity warning --shuttle-intent "$BATCH_ID" \
  --strict-delivery)"
[[ "$DELIVERY" == sent\ channel_id=100000000000000001\ binding_digest=*\ message_id=300000000000000001 ]]
grep -Fq 'https://discord.com/api/v10/channels/100000000000000001/messages' "$CURL_CAPTURE"

# A transient queue receipt must carry the resolved Lead/project identity, not
# the synthetic updater caller, so the legacy (non-unified) Bridge drain can
# resolve and deliver it later.
SECOND_CYCLE_JSON="$TMP/cycle-2.json"
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-18T00:06:23Z \
  begin --wake-kind scheduled --inventory "$TMP/inventory.json" \
  --owner-pid $$ --owner-start fixture-2 >"$SECOND_CYCLE_JSON"
SECOND_CYCLE_ID="$(jq -r .cycleId "$SECOND_CYCLE_JSON")"
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-18T00:06:23Z \
  record --cycle-id "$SECOND_CYCLE_ID" --result "$TMP/result.json" >/dev/null
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-18T00:06:24Z \
  finish --cycle-id "$SECOND_CYCLE_ID" --legacy-result scheduled_deployed >/dev/null
python3 "$HELPER" --catalog "$CATALOG" --now 2026-09-18T00:06:24Z \
  prepare-dispatch --cycle-id "$SECOND_CYCLE_ID" >"$TMP/dispatch-2.json"
SECOND_BATCH_ID="$(jq -r '.batches[0].batchId' "$TMP/dispatch-2.json")"
export FLYWHEEL_ALERT_RATE_PER_MIN=0
QUEUED_DELIVERY="$(/bin/bash "$ROOT/scripts/lead-alert.sh" --project beta --lead updater \
  --kind shuttle_unit_unhealthy --severity warning --shuttle-intent "$SECOND_BATCH_ID" \
  --strict-delivery || true)"
[[ "$QUEUED_DELIVERY" == queued_transient* ]]
QUEUE_RECORD="$(find "$FLYWHEEL_ALERT_QUEUE_DIR" -maxdepth 1 -name '*.json' -print -quit)"
jq -e '.leadId == "infra-lead" and .projectName == "flywheel" and
  .deliveryChannelId == "100000000000000001"' "$QUEUE_RECORD" >/dev/null

printf '[PASS] shuttle primary/copy bindings are configurable and shell uses the canonical resolver\n'
