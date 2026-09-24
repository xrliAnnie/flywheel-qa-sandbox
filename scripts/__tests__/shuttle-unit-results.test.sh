#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2669-units.XXXXXX")"
cleanup() {
  chmod -R u+w "$TMP" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

TEST_FLYWHEEL_HOME="$TMP/home/.flywheel"
export FLYWHEEL_HOME="$TEST_FLYWHEEL_HOME"
export FLYWHEEL_STATE_DIR="$FLYWHEEL_HOME"
export SHUTTLE_OBSERVATION_ALLOW_TEST_ROOT=1
export SHUTTLE_OBSERVATION_STATE_ROOT="$TMP/observation"
export SELF_SHIP_URGENT_DIR="$FLYWHEEL_HOME/self-ship-urgent.d"
export SELF_SHIP_LOCK_DIR="$FLYWHEEL_HOME/updater.lock.d"
export DEPLOYED_SHA_FILE="$FLYWHEEL_HOME/deployed-sha"
export ENV_FILE=/dev/null
export UPDATE_FLYWHEEL_SOURCED=1
export FLYWHEEL_DIR="$ROOT"
export RAYA_HOME="$TMP/raya"
export RAYA_CODE_DIR="$RAYA_HOME/code"
export RAYA_DEPLOYED_SHA_FILE="$RAYA_HOME/deployed-sha"
mkdir -p "$FLYWHEEL_HOME" "$SELF_SHIP_URGENT_DIR"

# The incident shape that motivated FLY-2669: the migration manifest target is
# only 2 commits ahead while the current carrier origin/main is 105 ahead.
# Observation must report the carrier drift, not the frozen migration target.
mkdir -p "$RAYA_CODE_DIR"
git -C "$RAYA_CODE_DIR" init -q
git -C "$RAYA_CODE_DIR" config user.email fixture@example.invalid
git -C "$RAYA_CODE_DIR" config user.name "FLY-2669 fixture"
RAYA_EMPTY_TREE="$(git -C "$RAYA_CODE_DIR" mktree </dev/null)"
RAYA_DEPLOYED_SHA="$(printf 'deployed\n' | git -C "$RAYA_CODE_DIR" commit-tree "$RAYA_EMPTY_TREE")"
RAYA_HISTORY_SHA="$RAYA_DEPLOYED_SHA"
RAYA_MANIFEST_TARGET=""
for index in $(seq 1 105); do
  RAYA_HISTORY_SHA="$(printf 'commit %s\n' "$index" | git -C "$RAYA_CODE_DIR" commit-tree "$RAYA_EMPTY_TREE" -p "$RAYA_HISTORY_SHA")"
  if [[ "$index" == 2 ]]; then RAYA_MANIFEST_TARGET="$RAYA_HISTORY_SHA"; fi
done
RAYA_ORIGIN_SHA="$RAYA_HISTORY_SHA"
git -C "$RAYA_CODE_DIR" update-ref refs/remotes/origin/main "$RAYA_ORIGIN_SHA"
printf '%s\n' "$RAYA_DEPLOYED_SHA" >"$RAYA_DEPLOYED_SHA_FILE"
[[ "$(git -C "$RAYA_CODE_DIR" rev-list --count "$RAYA_DEPLOYED_SHA..$RAYA_MANIFEST_TARGET")" == 2 ]]
[[ "$(git -C "$RAYA_CODE_DIR" rev-list --count "$RAYA_DEPLOYED_SHA..$RAYA_ORIGIN_SHA")" == 105 ]]

ALERT_CAPTURE="$TMP/alerts"
cat >"$TMP/lead-alert.sh" <<'ALERT'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$ALERT_CAPTURE"
printf '\n' >>"$ALERT_CAPTURE"
printf 'sent channel_id=100000000000000001 binding_digest=%064d message_id=300000000000000001\n' 0
ALERT
chmod +x "$TMP/lead-alert.sh"
export ALERT_CAPTURE
export SHUTTLE_LEAD_ALERT_BIN="$TMP/lead-alert.sh"

OLD_SHA=0000000000000000000000000000000000000000
NEW_SHA=1111111111111111111111111111111111111111
printf '%s\n' "$OLD_SHA" >"$DEPLOYED_SHA_FILE"
printf '%s\n' '[{"projectName":"flywheel","projectRoot":"/fixture/flywheel","leads":[{"agentId":"flywheel-eng-lead","chatChannel":"1516209714097291335","match":{"labels":["Engineering"]},"summaryRole":"aggregator"}]}]' >"$FLYWHEEL_HOME/projects.json"

# shellcheck source=/dev/null
source "$ROOT/scripts/update-flywheel.sh"

updater_converge_bin() { :; }
updater_sync_fable_model() { :; }
updater_sync_opus_model() { :; }
updater_launchd_pass() { :; }
updater_fetch_origin() { :; }
updater_remote_sha() { printf '%s\n' "$NEW_SHA"; }
deployed_sha() { printf '%s\n' "$OLD_SHA"; }
raya_host_capable() { return 0; }
raya_lock_release() { :; }
lead_restart_collect_candidates() {
  printf 'flywheel-flywheel-eng-lead\tflywheel\tflywheel-eng-lead\t/fixture/manifest.json\trestart\tmanifest\n' >"$4"
}

fixture_deploy() {
  local receipt="$TMP/project-receipt.json"
  shuttle_observation_record_values "$SHUTTLE_OBSERVATION_CYCLE_ID" \
    flywheel project_repo flywheel "flywheel Lead config" up_to_date up-to-date \
    project-lead-check flywheel-updater.log#project "$NEW_SHA" "$NEW_SHA" 0 unknown "$receipt"
  shuttle_observation_record_values "$SHUTTLE_OBSERVATION_CYCLE_ID" \
    flywheel lead flywheel:flywheel-eng-lead "flywheel/flywheel-eng-lead" deployed deployed \
    lead-verify flywheel-updater.log#lead "$NEW_SHA" "$NEW_SHA" 0 unknown "$receipt"
  return 0
}
SELF_SHIP_DEPLOY_CMD=fixture_deploy

updater_raya_pass() {
  RAYA_DEPLOY_STATE=prestop-failed
  RAYA_DEPLOY_DETAIL=prestop-validation-failed
  RAYA_TARGET="$RAYA_MANIFEST_TARGET"
  return 2
}

LOG="$TMP/updater.log"
# Keep the harness EXIT trap outside the updater's trap lifecycle. An updater
# abort (notably Bash 3.2 nounset failures) must reach the assertions below
# instead of terminating through updater_cleanup with a false-green status.
( trap - EXIT; update_main >"$LOG" 2>&1 )

EXPORT="$TMP/export.json"
python3 "$ROOT/scripts/lib/shuttle-observation.py" \
  --state-root "$SHUTTLE_OBSERVATION_STATE_ROOT" \
  --catalog "$ROOT/scripts/lib/shuttle-reasons.json" \
  export --after-change-seq 0 --limit 200 >"$EXPORT"

jq -e --arg rayaOrigin "$RAYA_ORIGIN_SHA" '
  ([.units[] | {kind:.unitKind,outcome:.outcome,reason:.reason}] | sort_by(.kind)) as $units |
  any($units[]; .kind == "core_repo" and .outcome == "deployed") and
  any($units[]; .kind == "project_repo" and .outcome == "up_to_date") and
  any($units[]; .kind == "lead" and .outcome == "deployed") and
  any(.units[]; .unitKind == "external_repo" and .outcome == "failed" and
    .reason == "prestop-validation-failed" and .targetSha == $rayaOrigin and .behindCommits == 105) and
  any(.units[]; .unitKind == "external_repo" and any(.notificationIntents[]; .deliveryState == "sent")) and
  any(.changes[]; .payload.kind == "cycle_summary" and .payload.result == "partial_failure" and .payload.legacyResult == "scheduled_deployed")
' "$EXPORT" >/dev/null

[[ "$(wc -l <"$ALERT_CAPTURE" | tr -d ' ')" == 1 ]]
grep -Fq -- '--kind shuttle_unit_unhealthy' "$ALERT_CAPTURE"
grep -Fq -- '--shuttle-intent' "$ALERT_CAPTURE"

CYCLE_LOG="$(grep -E 'updater cycle: wake=scheduled legacyResult=scheduled_deployed result=partial_failure' "$LOG")"
COUNTS_JSON="${CYCLE_LOG##* counts=}"
printf '%s\n' "$COUNTS_JSON" | jq -e '
  .deployed == 2 and .up_to_date == 2 and .skipped == 0 and .failed == 1
' >/dev/null

# The real Raya migration helper returns 2 for awaiting states and emits
# underscore-form details. The updater deliberately preserves its legacy
# return code, but the observation path must still classify and alert each
# non-expected skip with its stable catalog reason.
FIXTURE_RAYA_STATE=""
FIXTURE_RAYA_DETAIL=""
updater_raya_pass() {
  RAYA_DEPLOY_STATE="$FIXTURE_RAYA_STATE"
  RAYA_DEPLOY_DETAIL="$FIXTURE_RAYA_DETAIL"
  return 2
}

run_awaiting_case() { # $1=state $2=raw detail $3=stable reason $4=consecutive/alert count
  FIXTURE_RAYA_STATE="$1"
  FIXTURE_RAYA_DETAIL="$2"
  local stable_reason="$3" count="$4"
  local case_log="$TMP/updater-${FIXTURE_RAYA_DETAIL}.log"
  local case_export="$TMP/export-${FIXTURE_RAYA_DETAIL}.json"
  ( trap - EXIT; update_main >"$case_log" 2>&1 )
  python3 "$ROOT/scripts/lib/shuttle-observation.py" \
    --state-root "$SHUTTLE_OBSERVATION_STATE_ROOT" \
    --catalog "$ROOT/scripts/lib/shuttle-reasons.json" \
    export --after-change-seq 0 --limit 200 >"$case_export"
  jq -e --arg reason "$stable_reason" --argjson count "$count" '
    any(.units[]; .unitKind == "external_repo" and .outcome == "skipped" and
      .reason == $reason and .consecutiveScheduledBad == $count and
      .founderAware == true) and
    any(.changes[]; .payload.kind == "cycle_summary" and
      .payload.result == "partial_failure" and
      .payload.legacyResult == "scheduled_deployed" and
      .payload.counts.skipped == 1)
  ' "$case_export" >/dev/null
  [[ "$(wc -l <"$ALERT_CAPTURE" | tr -d ' ')" == "$count" ]]
  grep -Eq 'updater cycle: wake=scheduled legacyResult=scheduled_deployed result=partial_failure .*"skipped":1' "$case_log"
}

run_awaiting_case awaiting_proof awaiting_rebind awaiting-rebind 2
run_awaiting_case awaiting_rebind awaiting_pre_activation_rebind awaiting-pre-activation-rebind 3
run_awaiting_case awaiting_proof awaiting_rebind_proof awaiting-rebind-proof 4

# A side-producer observation error must not suppress unit alerts whose facts
# and notification intents were already committed by finish-cycle. Use a fresh
# ledger so same-day delivery dedupe from the cases above cannot mask dispatch.
SHUTTLE_OBSERVATION_STATE_ROOT="$TMP/observation-error"
ALERT_CAPTURE="$TMP/alerts-observation-error"
export SHUTTLE_OBSERVATION_STATE_ROOT ALERT_CAPTURE
: >"$ALERT_CAPTURE"
updater_alert_scheduled() { :; }
updater_alert_observation() { :; }
updater_raya_pass() {
  RAYA_DEPLOY_STATE=prestop-failed
  RAYA_DEPLOY_DETAIL=prestop-validation-failed
  RAYA_TARGET="$RAYA_MANIFEST_TARGET"
  touch "$SHUTTLE_OBSERVATION_ERROR_FILE"
  return 2
}
OBSERVATION_ERROR_LOG="$TMP/updater-observation-error.log"
( trap - EXIT; update_main >"$OBSERVATION_ERROR_LOG" 2>&1 )
[[ "$(wc -l <"$ALERT_CAPTURE" | tr -d ' ')" == 1 ]]
grep -Fq -- '--kind shuttle_unit_unhealthy' "$ALERT_CAPTURE"
grep -Eq 'updater cycle: wake=scheduled legacyResult=scheduled_deployed result=observation_incomplete' \
  "$OBSERVATION_ERROR_LOG"

# Raya's canonical manifest points at its Lead workspace, while the deployable
# checkout is the separately observed external_repo. The workspace must not
# create a second project_repo unit or a permanent ref-unresolved incident.
RAYA_INVENTORY_PROJECTS="$TMP/raya-inventory-projects.json"
RAYA_INVENTORY="$TMP/raya-inventory.json"
printf '%s\n' '[{"projectName":"flywheel","leads":[]},{"projectName":"raya","leads":[{"agentId":"raya"}]}]' \
  >"$RAYA_INVENTORY_PROJECTS"
shuttle_observation_build_inventory "$RAYA_INVENTORY_PROJECTS" "$RAYA_INVENTORY"
if jq -e 'any(.[]; .projectName == "raya" and .unitKind == "project_repo")' \
  "$RAYA_INVENTORY" >/dev/null; then
  echo "Raya Lead workspace was incorrectly registered as a project_repo" >&2
  exit 1
fi
jq -e 'any(.[]; .projectName == "raya" and .unitKind == "external_repo")' \
  "$RAYA_INVENTORY" >/dev/null

RESTART_PROJECT_FUNCTIONS="$(sed -n \
  -e '/^resolve_main_repo() {/,/^}/p' \
  -e '/^check_project_lead_changes() {/,/^}/p' \
  "$ROOT/scripts/restart-services.sh")"
SAVED_HOME="$HOME"
HOME="$TMP/restart-home"
mkdir -p "$HOME/.flywheel/manifests" "$HOME/raya-workspace" "$HOME/demo-workspace"
git -C "$HOME/raya-workspace" init -q
printf '%s\n' "{\"projectName\":\"raya\",\"projectDir\":\"$HOME/raya-workspace\"}" \
  >"$HOME/.flywheel/manifests/raya-raya.json"
printf '%s\n' "{\"projectName\":\"demo\",\"projectDir\":\"$HOME/demo-workspace\"}" \
  >"$HOME/.flywheel/manifests/demo-demo.json"
PROJECT_SHA_UPDATES_FILE="$TMP/restart-project-updates.tsv"
PROJECT_SHA_DIR="$HOME/.flywheel/project-deployed-sha"
DRY_RUN=true
RESTART_RECORDS="$TMP/restart-project-records.tsv"
: >"$RESTART_RECORDS"
log() { :; }
restart_shuttle_record() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$RESTART_RECORDS"; }
eval "$RESTART_PROJECT_FUNCTIONS"
check_project_lead_changes
HOME="$SAVED_HOME"
if grep -q $'^raya\tproject_repo\t' "$RESTART_RECORDS"; then
  echo "Raya Lead workspace produced a permanent project_repo failure" >&2
  exit 1
fi
grep -q $'^demo\tproject_repo\tdemo\tdemo Lead config\tfailed\tref-unresolved\tproject-repo-unresolved' \
  "$RESTART_RECORDS"

LEGACY="$ROOT/scripts/__tests__/fixtures/fly2669-raya-silent.txt"
grep -Fq 'raya: prestop-failed prestop-validation-failed' "$LEGACY"
grep -Fq 'raya shuttle: prestop-failed prestop-validation-failed' "$LEGACY"
grep -Fq 'updater cycle: wake=scheduled result=scheduled_deployed' "$LEGACY"
if grep -Eq 'shuttle_unit_unhealthy|partial_failure' "$LEGACY"; then
  echo "legacy replay fixture unexpectedly contains the new visibility result" >&2
  exit 1
fi

printf '[PASS] per-unit results preserve Raya failures and return-2 awaiting skips over legacy scheduled_deployed\n'
