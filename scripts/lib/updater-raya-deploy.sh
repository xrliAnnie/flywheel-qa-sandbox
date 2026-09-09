#!/usr/bin/env bash
# FLY-2445: source-only, resumable Raya deployment through the standard Lead.
# The scheduled Flywheel updater owns the outer singleton; this library owns the
# narrower Raya lock and the P0-P7 migration receipt. Sourcing it has no effects.

RAYA_STANDARD_LABEL="com.flywheel.lead.raya-raya"
RAYA_FETCH_TIMEOUT_SECONDS="${RAYA_FETCH_TIMEOUT_SECONDS:-20}"
RAYA_INSTALL_TIMEOUT_SECONDS="${RAYA_INSTALL_TIMEOUT_SECONDS:-600}"
RAYA_BUILD_TIMEOUT_SECONDS="${RAYA_BUILD_TIMEOUT_SECONDS:-600}"
RAYA_LOCK_OWNED="${RAYA_LOCK_OWNED:-0}"
RAYA_LOCK_FAILURE="${RAYA_LOCK_FAILURE:-}"
RAYA_DEPLOY_STATE="${RAYA_DEPLOY_STATE:-not_run}"
RAYA_DEPLOY_DETAIL="${RAYA_DEPLOY_DETAIL:-}"
RAYA_CHECKOUT_BEFORE="${RAYA_CHECKOUT_BEFORE:-}"
RAYA_TARGET="${RAYA_TARGET:-}"
RAYA_NEW_HEAD="${RAYA_NEW_HEAD:-}"
RAYA_LEDGER_STATE="${RAYA_LEDGER_STATE:-}"
RAYA_ROLLBACK_SHA="${RAYA_ROLLBACK_SHA:-}"
RAYA_PREFLIGHT_RC="${RAYA_PREFLIGHT_RC:-}"

_RAYA_UPDATER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAYA_STANDARD_MIGRATION_LIB="${RAYA_STANDARD_MIGRATION_LIB:-${_RAYA_UPDATER_LIB_DIR}/raya-standard-migration.sh}"
if [[ -f "$RAYA_STANDARD_MIGRATION_LIB" && ! -L "$RAYA_STANDARD_MIGRATION_LIB" ]]; then
  # shellcheck source=raya-standard-migration.sh
  source "$RAYA_STANDARD_MIGRATION_LIB"
fi

raya_configure_runtime_paths() {
  local base="${FLYWHEEL_HOME:-${HOME}/.flywheel}"
  if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" != 1 ]]; then
    base="${HOME}/.flywheel"
    RAYA_HOME="${base}/raya"
    RAYA_CODE_DIR="${RAYA_HOME}/code"
    RAYA_DEPLOYED_SHA_FILE="${RAYA_HOME}/deployed-sha"
    RAYA_DEPLOY_RECEIPT="${RAYA_HOME}/deploy-receipt.json"
    RAYA_DEPLOY_LOCK_DIR="${RAYA_HOME}/deploy.lock.d"
    RAYA_CANONICAL_MANIFEST="${base}/manifests/raya-raya.json"
    RAYA_MIGRATION_MANIFEST="${RAYA_HOME}/migrations/FLY-2445-standard-lead/manifest.json"
    RAYA_STANDARD_PROOF_FILE="${RAYA_HOME}/migrations/FLY-2445-standard-lead/proof.json"
    RAYA_WORKSPACE="${HOME}/Dev/raya-lead-workspace"
    FLYWHEEL_DEPLOYED_SHA_FILE="${base}/deployed-sha"
    FLYWHEEL_TEAMLEAD_ROOT="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}/packages/teamlead"
    FLYWHEEL_LEAD_BIN="${base}/bin/flywheel-lead.sh"
    RAYA_STANDARD_NODE_BIN="${UPDATER_NODE:-node}"
    RAYA_STANDARD_SEED_TOOL="${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/seed-lead-inbound-cursor.js"
    return
  fi
  : "${RAYA_HOME:=${base}/raya}"
  : "${RAYA_CODE_DIR:=${RAYA_HOME}/code}"
  : "${RAYA_DEPLOYED_SHA_FILE:=${RAYA_HOME}/deployed-sha}"
  : "${RAYA_DEPLOY_RECEIPT:=${RAYA_HOME}/deploy-receipt.json}"
  : "${RAYA_DEPLOY_LOCK_DIR:=${RAYA_HOME}/deploy.lock.d}"
  : "${RAYA_CANONICAL_MANIFEST:=${base}/manifests/raya-raya.json}"
  : "${RAYA_MIGRATION_MANIFEST:=${RAYA_HOME}/migrations/FLY-2445-standard-lead/manifest.json}"
  : "${RAYA_STANDARD_PROOF_FILE:=${RAYA_HOME}/migrations/FLY-2445-standard-lead/proof.json}"
  : "${RAYA_WORKSPACE:=${HOME}/Dev/raya-lead-workspace}"
  : "${FLYWHEEL_DEPLOYED_SHA_FILE:=${base}/deployed-sha}"
  : "${FLYWHEEL_TEAMLEAD_ROOT:=${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}/packages/teamlead}"
  : "${FLYWHEEL_LEAD_BIN:=${base}/bin/flywheel-lead.sh}"
  : "${RAYA_STANDARD_NODE_BIN:=${UPDATER_NODE:-node}}"
  : "${RAYA_STANDARD_SEED_TOOL:=${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/seed-lead-inbound-cursor.js}"
}

raya_log() {
  if declare -F log >/dev/null 2>&1; then log "raya: $*"; else
    printf '[flywheel-updater] raya: %s\n' "$*"
  fi
}
raya_alert() {
  if declare -F raya_alert_dispatch >/dev/null 2>&1; then
    raya_alert_dispatch "$@"
  else
    raya_log "$1 $2: $4"
  fi
}
raya_now() { date +%s; }
raya_now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
raya_is_sha40() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }
raya_is_sha256() { [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]]; }
raya_git() { git -C "$RAYA_CODE_DIR" "$@"; }
raya_sha256() { shasum -a 256 "$1" 2>/dev/null | awk 'NF == 2 {print $1}'; }
raya_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
raya_owner_file() {
  local mode=""
  [[ -f "$1" && ! -L "$1" ]] || return 1
  mode="$(raya_mode "$1")" || return 1
  [[ "$mode" == 600 || "$mode" == 400 ]]
}

raya_validate_canonical_manifest() {
  [[ -f "$RAYA_CANONICAL_MANIFEST" && ! -L "$RAYA_CANONICAL_MANIFEST" ]] || return 1
  jq -e '
    .projectName == "raya" and .leadId == "raya" and
    .leadBackend.backendId == "codex-app-server" and
    (.projectDir | type == "string" and startswith("/"))
  ' "$RAYA_CANONICAL_MANIFEST" >/dev/null 2>&1 || return 1
  local root
  root="$(jq -r .projectDir "$RAYA_CANONICAL_MANIFEST")" || return 1
  [[ -d "$root" && ! -L "$root" ]]
}
raya_host_capable() { raya_validate_canonical_manifest; }

raya_process_start() {
  LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
raya_lock_clear() {
  rm -f "$RAYA_DEPLOY_LOCK_DIR/pid" "$RAYA_DEPLOY_LOCK_DIR/start" 2>/dev/null || true
  rmdir "$RAYA_DEPLOY_LOCK_DIR" 2>/dev/null
}
raya_lock_acquire() {
  local owner="" recorded="" actual=""
  RAYA_LOCK_FAILURE=""
  mkdir -p "$RAYA_HOME" || { RAYA_LOCK_FAILURE=home; return 75; }
  if mkdir "$RAYA_DEPLOY_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$RAYA_DEPLOY_LOCK_DIR/pid" || return 75
    raya_process_start "$$" > "$RAYA_DEPLOY_LOCK_DIR/start" || return 75
    RAYA_LOCK_OWNED=1
    return 0
  fi
  owner="$(sed -n '1p' "$RAYA_DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  recorded="$(sed -n '1p' "$RAYA_DEPLOY_LOCK_DIR/start" 2>/dev/null || true)"
  if [[ "$owner" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner" 2>/dev/null; then
    actual="$(raya_process_start "$owner" 2>/dev/null || true)"
    if [[ -n "$actual" && "$actual" == "$recorded" ]]; then
      RAYA_LOCK_FAILURE=live
      return 75
    fi
  fi
  raya_lock_clear || { RAYA_LOCK_FAILURE=state; return 75; }
  mkdir "$RAYA_DEPLOY_LOCK_DIR" 2>/dev/null || { RAYA_LOCK_FAILURE=state; return 75; }
  printf '%s\n' "$$" > "$RAYA_DEPLOY_LOCK_DIR/pid" || return 75
  raya_process_start "$$" > "$RAYA_DEPLOY_LOCK_DIR/start" || return 75
  RAYA_LOCK_OWNED=1
}
raya_lock_release() {
  local owner=""
  owner="$(sed -n '1p' "$RAYA_DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$RAYA_LOCK_OWNED" == 1 && "$owner" == "$$" ]]; then raya_lock_clear || true; fi
  RAYA_LOCK_OWNED=0
}

raya_atomic_replace() {
  local source="$1" target="$2"
  "$RAYA_STANDARD_NODE_BIN" - "$source" "$target" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [source, target] = process.argv.slice(2);
const file = fs.openSync(source, "r");
try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
fs.renameSync(source, target);
const directory = fs.openSync(path.dirname(target), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
NODE
}

raya_atomic_symlink_replace() {
  local source="$1" target="$2"
  "$RAYA_STANDARD_NODE_BIN" - "$source" "$target" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [source, target] = process.argv.slice(2);
if (!fs.lstatSync(source).isSymbolicLink()) process.exit(1);
fs.renameSync(source, target);
const directory = fs.openSync(path.dirname(target), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
NODE
}

raya_manifest_base_valid() {
  raya_owner_file "$RAYA_MIGRATION_MANIFEST" || return 1
  jq -e '
    .schemaVersion == 1 and
    (.migration_id | type == "string" and length > 0) and
    (.checkpoint | IN("P2","P3","P4b","P5","P6","P7")) and
    (.unresolved | type == "array")
  ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1
}

raya_manifest_transform() {
  local expected="$1" next="$2" filter="$3" before="" temp=""
  shift 3
  raya_manifest_base_valid || return 1
  [[ "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" == "$expected" ]] || return 1
  before="$(raya_sha256 "$RAYA_MIGRATION_MANIFEST")" || return 1
  temp="${RAYA_MIGRATION_MANIFEST}.tmp.$$"
  jq "$@" --arg next "$next" "$filter | .checkpoint = \$next" \
    "$RAYA_MIGRATION_MANIFEST" > "$temp" || { rm -f "$temp"; return 1; }
  chmod 600 "$temp" || { rm -f "$temp"; return 1; }
  [[ "$(raya_sha256 "$RAYA_MIGRATION_MANIFEST")" == "$before" ]] \
    || { rm -f "$temp"; return 1; }
  raya_atomic_replace "$temp" "$RAYA_MIGRATION_MANIFEST" \
    || { rm -f "$temp"; return 1; }
}

raya_legacy_plist_matches() {
  local plist="$1" app="$2" expected_label="$3"
  python3 - "$plist" "$RAYA_CODE_DIR/apps/$app/dist/cli.js" \
    "$expected_label" "$RAYA_CODE_DIR" "$RAYA_HOME/raya.env" <<'PY'
import os, plistlib, sys
path, cli, expected_label, cwd, env_file = sys.argv[1:]
try:
    with open(path, "rb") as handle:
        value = plistlib.load(handle)
except (OSError, plistlib.InvalidFileException):
    raise SystemExit(1)
args = value.get("ProgramArguments")
environment = value.get("EnvironmentVariables")
if value.get("Label") != expected_label or value.get("WorkingDirectory") != cwd:
    raise SystemExit(1)
if not isinstance(args, list) or len(args) != 3 or args[1:] != [cli, "run"]:
    raise SystemExit(1)
if not os.path.isfile(args[0]) or os.path.islink(args[0]) or not os.access(args[0], os.X_OK):
    raise SystemExit(1)
if not isinstance(environment, dict) or environment.get("RAYA_ENV_FILE") != env_file:
    raise SystemExit(1)
PY
}

raya_quiesce_legacy_owner() {
  local app="" label="" plist="" found=0
  for app in brain voice; do
    label="com.xrli.raya.$app"
    plist="${RAYA_LEGACY_PLIST_DIR:-${HOME}/Library/LaunchAgents}/${label}.plist"
    if [[ -e "$plist" || -L "$plist" ]] || launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      found=1
      [[ "${RAYA_MIGRATION_ALLOW_LEGACY_STOP:-0}" == 1 ]] || return 1
      [[ -f "$plist" && ! -L "$plist" ]] || return 1
      raya_legacy_plist_matches "$plist" "$app" "$label" || return 1
      launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || return 1
      launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && return 1
    fi
  done
  [[ "$found" == 0 || "${RAYA_MIGRATION_ALLOW_LEGACY_STOP:-0}" == 1 ]]
}

raya_ensure_legacy_quiesced() {
  local stopped_at=""
  raya_manifest_base_valid || return 1
  jq -e '.checkpoint == "P2" and (.unresolved | length) == 0' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
  if jq -e '(.old_stopped_at | type == "string" and length > 0)' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
    return 0
  fi
  jq -e '(.old_stopped_at // null) == null' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
  raya_quiesce_legacy_owner || return 1
  stopped_at="$(raya_now_iso)" || return 1
  raya_manifest_transform P2 P2 '.old_stopped_at = $stopped' \
    --arg stopped "$stopped_at"
}

raya_bridge_token_ready() {
  jq -e '
    .bridge.token_env == "RAYA_BOT_TOKEN" and .bridge.token_resolved == true and
    (.bridge.bot_user_id | type == "string" and test("^[0-9]{17,20}$")) and
    .bridge.bot_user_id == .lead_bot_user_id and
    (.bridge.alert_channel_id | type == "string" and length > 0)
  ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1
}

raya_standard_lead() { /bin/bash "$FLYWHEEL_LEAD_BIN" "$@"; }

raya_manifest_record_cursor() {
  local receipt="$1" digest="" status="" seeded_at=""
  digest="$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' <<<"$receipt")" || return 1
  status="$(jq -er '.status | select(IN("seeded","already_seeded","already_advanced"))' <<<"$receipt")" || return 1
  [[ "$status" != already_advanced ]] || return 1
  [[ "$(jq -r .migrationId <<<"$receipt")" == "$(jq -r .migration_id "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  seeded_at="$(raya_now_iso)" || return 1
  raya_manifest_transform P3 P4b \
    '.cursor.status = $status | .cursor.sha256 = $digest | .cursor.seeded_at = $seeded' \
    --arg status "$status" --arg digest "$digest" --arg seeded "$seeded_at"
}

raya_standard_cutover() {
  local checkpoint="" stopped_at="" cursor="" input="" receipt="" activated=""
  raya_manifest_base_valid || return 1
  jq -e '(.unresolved | length) == 0' "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
  while :; do
    checkpoint="$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" || return 1
    case "$checkpoint" in
      P2)
        raya_ensure_legacy_quiesced || return 1
        stopped_at="$(jq -er '.old_stopped_at | select(type == "string" and length > 0)' \
          "$RAYA_MIGRATION_MANIFEST")" || return 1
        raya_manifest_transform P2 P3 '.old_stopped_at = $stopped' --arg stopped "$stopped_at" || return 1
        ;;
      P3)
        cursor="$(jq -er '.cursor.path | select(type == "string" and startswith("/"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
        input="$(jq -er '.cursor.seed_input | select(type == "string" and startswith("/"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
        receipt="$(raya_standard_seed_inbound_cursor "$cursor" "$input")" || return 1
        raya_manifest_record_cursor "$receipt" || return 1
        ;;
      P4b)
        cursor="$(jq -er .cursor.path "$RAYA_MIGRATION_MANIFEST")" || return 1
        raya_standard_preinstall_ready "$RAYA_MIGRATION_MANIFEST" "$cursor" || return 1
        raya_bridge_token_ready || return 1
        raya_standard_lead preflight "$RAYA_CANONICAL_MANIFEST"
        RAYA_PREFLIGHT_RC=$?
        (( RAYA_PREFLIGHT_RC == 0 )) || return 1
        raya_standard_lead install --project raya --lead raya || return 1
        raya_standard_lead verify --stage installed "$RAYA_CANONICAL_MANIFEST" || return 1
        activated="$(raya_now_iso)" || return 1
        raya_manifest_transform P4b P5 '.activated_at = $activated' --arg activated "$activated" || return 1
        ;;
      P5|P6|P7) return 0 ;;
      *) return 1 ;;
    esac
  done
}

raya_validate_proof() {
  local proof="$1"
  raya_owner_file "$proof" || return 1
  jq -e --arg migration "$(jq -r .migration_id "$RAYA_MIGRATION_MANIFEST")" \
    --arg raya "$(jq -r .raya_sha "$RAYA_MIGRATION_MANIFEST")" \
    --arg flywheel "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" '
    .migration_id == $migration and .raya_sha == $raya and
    .flywheel_deployed_sha == $flywheel and
    (.lead | type == "object") and (.business | type == "object") and
    (.checks | type == "object") and (.cutover | type == "object")
  ' "$proof" >/dev/null 2>&1
}

raya_p6_evidence_valid() {
  local manifest="$1"
  jq -e '
    (.checkpoint == "P6" or .checkpoint == "P7") and (.unresolved | length) == 0 and
    (.raya_sha | test("^[0-9a-f]{40}$")) and
    (.flywheel_deployed_sha | test("^[0-9a-f]{40}$")) and
    (.registry_digest | test("^[0-9a-f]{64}$")) and
    (.summary_receipt_digest | test("^[0-9a-f]{64}$")) and
    (.canonical_manifest_digest | test("^[0-9a-f]{64}$")) and
    .lead.project == "raya" and .lead.id == "raya" and .lead.key == "raya-raya" and
    .lead.registry_digest == .registry_digest and
    .lead.summary_receipt_digest == .summary_receipt_digest and
    .lead.manifest_digest == .canonical_manifest_digest and
    (.lead.pid | type == "number" and . > 0) and
    (.lead.process_started_at | type == "string" and length > 0) and
    (.lead.activation_id | type == "string" and length > 0) and
    (.lead.thread_id | type == "string" and length > 0) and .lead.tui_visible == true and
    .business.source_sha == .raya_sha and
    .business.artifact_digest == .artifact.digest and
    .business.persona_digest == .artifact.persona_digest and
    .business.workspace == .artifact.workspace and
    (.business.state_schema_version | type == "number") and
    .checks.preflight == true and .checks.unique_owner == true and .checks.pump == true and
    .checks.mailbox_acked == true and .checks.bridge_sent == true and
    .checks.bridge_identity_verified == true and .checks.alert_reachable == true and
    ([.checks.text_delivery_id,.checks.outbound_message_id,.checks.summary_round_id,
      .checks.summary_delivery_id,.checks.alert_channel_id,.checks.alert_delivery_id]
      | all(type == "string" and length > 0)) and
    .cutover.seed_digest == .cursor.sha256 and
    .cutover.activation_id == .lead.activation_id and
    .cutover.unresolved_count == 0 and
    ([.cutover.seeded_at,.cutover.old_stopped_at,.cutover.activated_at,
      .cutover.window_message_id,.cutover.window_delivery_id,.cutover.window_outbound_message_id]
      | all(type == "string" and length > 0)) and
    (.cutover.channels | type == "array" and length > 0 and
      all(.[]; (.channel_id | type == "string" and length > 0) and
        (.seeded_after | type == "string" and length > 0)))
  ' "$manifest" >/dev/null 2>&1
}

raya_standard_collect_proof() {
  local checkpoint="" before="" temp=""
  raya_manifest_base_valid || return 1
  checkpoint="$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")"
  [[ "$checkpoint" == P5 ]] || { [[ "$checkpoint" == P6 || "$checkpoint" == P7 ]]; return; }
  [[ -e "$RAYA_STANDARD_PROOF_FILE" || -L "$RAYA_STANDARD_PROOF_FILE" ]] || return 2
  raya_validate_proof "$RAYA_STANDARD_PROOF_FILE" || return 1
  before="$(raya_sha256 "$RAYA_MIGRATION_MANIFEST")" || return 1
  temp="${RAYA_MIGRATION_MANIFEST}.tmp.$$"
  jq --slurpfile proof "$RAYA_STANDARD_PROOF_FILE" '
    .lead = $proof[0].lead | .business = $proof[0].business |
    .checks = $proof[0].checks | .cutover = $proof[0].cutover |
    .checkpoint = "P6"
  ' "$RAYA_MIGRATION_MANIFEST" > "$temp" || { rm -f "$temp"; return 1; }
  chmod 600 "$temp" || { rm -f "$temp"; return 1; }
  raya_p6_evidence_valid "$temp" || { rm -f "$temp"; return 1; }
  [[ "$(raya_sha256 "$RAYA_MIGRATION_MANIFEST")" == "$before" ]] \
    || { rm -f "$temp"; return 1; }
  raya_atomic_replace "$temp" "$RAYA_MIGRATION_MANIFEST" \
    || { rm -f "$temp"; return 1; }
}

raya_validate_p6_manifest() {
  raya_manifest_base_valid || return 1
  raya_p6_evidence_valid "$RAYA_MIGRATION_MANIFEST" || return 1
  local recorded_raya="" recorded_flywheel="" recorded_manifest="" current_flywheel=""
  local workspace="" version_root="" pointer="" artifact="" persona=""
  recorded_raya="$(jq -r .raya_sha "$RAYA_MIGRATION_MANIFEST")" || return 1
  recorded_flywheel="$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" || return 1
  recorded_manifest="$(jq -r .canonical_manifest_digest "$RAYA_MIGRATION_MANIFEST")" || return 1
  current_flywheel="$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  [[ "$recorded_raya" == "$RAYA_TARGET" ]] || return 1
  [[ "$recorded_flywheel" == "$current_flywheel" ]] || return 1
  [[ "$recorded_manifest" == "$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" ]] || return 1
  workspace="$(jq -r .artifact.workspace "$RAYA_MIGRATION_MANIFEST")" || return 1
  [[ "$workspace" == "$(jq -r .projectDir "$RAYA_CANONICAL_MANIFEST")" ]] || return 1
  version_root="$workspace/.flywheel-managed/versions/$recorded_raya"
  pointer="$workspace/business/current"
  [[ -d "$version_root" && ! -L "$version_root" && -L "$pointer" ]] || return 1
  [[ "$(readlink "$pointer" 2>/dev/null || true)" == "$version_root" ]] || return 1
  artifact="$(jq -r .artifact.digest "$RAYA_MIGRATION_MANIFEST")" || return 1
  persona="$(jq -r .artifact.persona_digest "$RAYA_MIGRATION_MANIFEST")" || return 1
  [[ "$artifact" == "$(raya_tree_digest "$version_root")" ]] || return 1
  [[ "$persona" == "$(raya_sha256 "$workspace/.lead/raya/identity.md")" ]]
}

raya_receipt_keys_valid() {
  local receipt="$1"
  jq -e '
    if .schemaVersion == 1 then
      keys == ["brain_pid","checked_at","checkout_before","deployed_sha","failure","gen_before","generation","head","identity","interrupt_notice","ledger","node_bin","origin_main","outcome","preflight_rc","rollback_sha","schemaVersion","session_at_cutover","session_grace","state","voice","voice_pid"]
    elif .schemaVersion == 2 then
      keys == ["brain_pid","business","carrier","checked_at","checkout_before","checks","cutover","deployed_sha","failure","flywheel_deployed_sha","gen_before","generation","head","identity","interrupt_notice","lead","ledger","migration_id","node_bin","origin_main","outcome","preflight_rc","rollback_sha","rollback_target","schemaVersion","session_at_cutover","session_grace","state","voice","voice_pid"]
    else false end
  ' "$receipt" >/dev/null 2>&1
}

raya_previous_standard_target() {
  [[ -f "$RAYA_DEPLOY_RECEIPT" && ! -L "$RAYA_DEPLOY_RECEIPT" ]] || { printf 'null\n'; return; }
  raya_receipt_keys_valid "$RAYA_DEPLOY_RECEIPT" || { printf 'null\n'; return; }
  local digest=""
  digest="$(raya_sha256 "$RAYA_DEPLOY_RECEIPT")" || { printf 'null\n'; return; }
  jq -c --arg digest "$digest" --arg current "$RAYA_TARGET" \
    --arg current_flywheel "$(jq -r '.flywheel_deployed_sha // empty' "$RAYA_MIGRATION_MANIFEST" 2>/dev/null || true)" '
    if .schemaVersion == 2 and .carrier == "standard-lead" and
      (.outcome == "deployed" or .outcome == "current") and
      (.deployed_sha | test("^[0-9a-f]{40}$")) and
      (.flywheel_deployed_sha | test("^[0-9a-f]{40}$")) and
      (.lead.manifest_digest | test("^[0-9a-f]{64}$")) and
      (.business.artifact_digest | test("^[0-9a-f]{64}$"))
    then
      if .deployed_sha == $current and .flywheel_deployed_sha == $current_flywheel
      then (.rollback_target // null)
      else {carrier:"standard-lead",raya_sha:.deployed_sha,flywheel_sha:.flywheel_deployed_sha,
        manifest_digest:.lead.manifest_digest,artifact_digest:.business.artifact_digest,
        receipt_digest:$digest} end
    else null end
  ' "$RAYA_DEPLOY_RECEIPT" 2>/dev/null || printf 'null\n'
}

raya_write_standard_receipt() {
  local state="$1" detail="$2" outcome="refused" success=false checked=0
  local temp="${RAYA_DEPLOY_RECEIPT}.tmp.$$" rollback="null" previous="" head="" node=""
  case "$state" in
    deployed|current) outcome="$state"; success=true ;;
    rolled_back) outcome=rolled_back ;;
    failed) outcome=failed ;;
  esac
  checked="$(raya_now)" || return 1
  mkdir -p "$(dirname "$RAYA_DEPLOY_RECEIPT")" || return 1
  rollback="$(raya_previous_standard_target)" || rollback=null
  previous="$(sed -n '1p' "$RAYA_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  raya_is_sha40 "$previous" || previous=""
  head="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  node="$(command -v "$RAYA_STANDARD_NODE_BIN" 2>/dev/null || true)"
  if [[ "$success" == true ]]; then raya_validate_p6_manifest || return 1; fi
  jq -n --slurpfile migration "$RAYA_MIGRATION_MANIFEST" \
    --argjson checked "$checked" --arg outcome "$outcome" --arg state "$state" \
    --arg detail "$detail" --arg checkout "$RAYA_CHECKOUT_BEFORE" --arg head "$head" \
    --arg origin "$RAYA_TARGET" --arg ledger "$RAYA_LEDGER_STATE" --arg rollbackSha "$previous" \
    --arg node "$node" --arg preflight "$RAYA_PREFLIGHT_RC" --argjson success "$success" \
    --argjson rollback "$rollback" '
      def nullable: if . == "" then null else . end;
      def number_or_null: if . == "" then null else tonumber end;
      ($migration[0] // {}) as $m |
      {
        schemaVersion:2, checked_at:$checked, outcome:$outcome, state:$state,
        failure:(if $success then null else $detail end),
        checkout_before:($checkout|nullable), head:($head|nullable), origin_main:($origin|nullable),
        ledger:($ledger|nullable), rollback_sha:($rollbackSha|nullable),
        deployed_sha:(if $success then $m.raya_sha else null end),
        identity:null, session_grace:null, session_at_cutover:null,
        generation:null, gen_before:null, interrupt_notice:null,
        brain_pid:null, voice:null, voice_pid:null,
        node_bin:($node|nullable), preflight_rc:($preflight|number_or_null),
        flywheel_deployed_sha:(if $success then $m.flywheel_deployed_sha else null end),
        migration_id:($m.migration_id // "unavailable"), carrier:"standard-lead",
        lead:(if $success then $m.lead else null end),
        business:(if $success then $m.business else null end),
        checks:(if $success then $m.checks else null end),
        cutover:(if $success then $m.cutover else null end),
        rollback_target:$rollback
      }
    ' > "$temp" || { rm -f "$temp"; return 1; }
  chmod 600 "$temp" || { rm -f "$temp"; return 1; }
  raya_receipt_keys_valid "$temp" || { rm -f "$temp"; return 1; }
  raya_atomic_replace "$temp" "$RAYA_DEPLOY_RECEIPT" || { rm -f "$temp"; return 1; }
}

raya_write_deployed_sha() {
  local value="$1" temp="${RAYA_DEPLOYED_SHA_FILE}.tmp.$$"
  raya_is_sha40 "$value" || return 1
  printf '%s\n' "$value" > "$temp" || { rm -f "$temp"; return 1; }
  chmod 600 "$temp" || { rm -f "$temp"; return 1; }
  raya_atomic_replace "$temp" "$RAYA_DEPLOYED_SHA_FILE" || { rm -f "$temp"; return 1; }
}

raya_standard_finalize() {
  local current=""
  raya_validate_p6_manifest || return 1
  raya_verify_frozen_source || return 1
  raya_standard_lead verify --stage live "$RAYA_CANONICAL_MANIFEST" || return 1
  current="$(sed -n '1p' "$RAYA_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  if [[ "$current" == "$RAYA_TARGET" ]]; then
    raya_write_standard_receipt current "standard Lead evidence reverified" || return 1
  else
    raya_write_standard_receipt deployed "standard Lead activated" || return 1
  fi
  raya_write_deployed_sha "$RAYA_TARGET" || return 1
  if [[ "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" == P6 ]]; then
    raya_manifest_transform P6 P7 '.committed_at = $committed' --arg committed "$(raya_now_iso)" || return 1
  fi
}

raya_run_bounded_in_checkout() {
  local timeout="$1" runner="${UPDATER_BOUNDED_RUN:-${_RAYA_UPDATER_LIB_DIR}/bounded-run.sh}"
  shift
  [[ -x "$runner" ]] || return 127
  (cd "$RAYA_CODE_DIR" && "$runner" "$timeout" "$@")
}
raya_git_fetch_bounded() {
  local runner="${UPDATER_BOUNDED_RUN:-${_RAYA_UPDATER_LIB_DIR}/bounded-run.sh}"
  [[ -x "$runner" ]] || return 127
  GIT_TERMINAL_PROMPT=0 "$runner" "$RAYA_FETCH_TIMEOUT_SECONDS" \
    git -C "$RAYA_CODE_DIR" fetch origin '+refs/heads/main:refs/remotes/origin/main' --quiet
}

raya_tree_digest() {
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || return 1
  (cd "$root" && find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    case "$file" in *$'\n'*) exit 1 ;; esac
    printf '%s  %s\n' "$(raya_sha256 "$file")" "$file"
  done) | shasum -a 256 | awk 'NF == 2 {print $1}'
}

raya_verify_materialized_artifact() {
  local recorded_raya="" workspace="" version_root="" pointer="" artifact="" persona=""
  recorded_raya="$(jq -er '.raya_sha | select(test("^[0-9a-f]{40}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  workspace="$(jq -er '.artifact.workspace | select(type == "string" and startswith("/"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  [[ "$workspace" == "$(jq -r .projectDir "$RAYA_CANONICAL_MANIFEST")" ]] || return 1
  version_root="$workspace/.flywheel-managed/versions/$recorded_raya"
  pointer="$workspace/business/current"
  [[ -d "$version_root" && ! -L "$version_root" && -L "$pointer" ]] || return 1
  [[ "$(readlink "$pointer" 2>/dev/null || true)" == "$version_root" ]] || return 1
  artifact="$(jq -er '.artifact.digest | select(test("^[0-9a-f]{64}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  persona="$(jq -er '.artifact.persona_digest | select(test("^[0-9a-f]{64}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  [[ "$artifact" == "$(raya_tree_digest "$version_root")" ]] || return 1
  [[ "$persona" == "$(raya_sha256 "$workspace/.lead/raya/identity.md")" ]]
}

raya_verify_frozen_source() {
  local branch="" dirty="" current="" recorded="" flywheel_sha="" manifest_sha=""
  raya_validate_canonical_manifest || return 1
  raya_manifest_base_valid || return 1
  branch="$(raya_git symbolic-ref --short HEAD 2>/dev/null || true)"
  [[ "$branch" == main ]] || return 1
  dirty="$(raya_git status --porcelain 2>/dev/null)" || return 1
  [[ -z "$dirty" ]] || return 1
  current="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  recorded="$(jq -er '.raya_sha | select(test("^[0-9a-f]{40}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  [[ "$current" == "$recorded" ]] || return 1
  flywheel_sha="$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  [[ "$flywheel_sha" == "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  manifest_sha="$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" || return 1
  [[ "$manifest_sha" == "$(jq -r .canonical_manifest_digest "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  raya_verify_materialized_artifact
}

raya_verify_previous_standard() {
  local previous_raya="" previous_flywheel="" previous_manifest="" previous_artifact=""
  local current="" anchor=""
  raya_manifest_base_valid || return 1
  [[ "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" == P7 ]] || return 1
  raya_validate_canonical_manifest || return 1
  raya_receipt_keys_valid "$RAYA_DEPLOY_RECEIPT" || return 1
  previous_raya="$(jq -er '.raya_sha | select(test("^[0-9a-f]{40}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  previous_flywheel="$(jq -er '.flywheel_deployed_sha | select(test("^[0-9a-f]{40}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  previous_manifest="$(jq -er '.canonical_manifest_digest | select(test("^[0-9a-f]{64}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  previous_artifact="$(jq -er '.artifact.digest | select(test("^[0-9a-f]{64}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
  current="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  anchor="$(sed -n '1p' "$RAYA_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  [[ "$current" == "$previous_raya" && "$anchor" == "$previous_raya" ]] || return 1
  jq -e --arg raya "$previous_raya" --arg flywheel "$previous_flywheel" \
    --arg manifest "$previous_manifest" --arg artifact "$previous_artifact" '
      .schemaVersion == 2 and .carrier == "standard-lead" and
      (.outcome == "deployed" or .outcome == "current") and
      .deployed_sha == $raya and .flywheel_deployed_sha == $flywheel and
      .lead.manifest_digest == $manifest and .business.artifact_digest == $artifact
    ' "$RAYA_DEPLOY_RECEIPT" >/dev/null 2>&1 || return 1
  RAYA_TARGET="$previous_raya"
  raya_verify_materialized_artifact
}

raya_begin_followup_transaction() {
  local previous_raya="" previous_flywheel="" previous_manifest=""
  local target="" flywheel_sha="" manifest_sha="" remote=""
  raya_verify_previous_standard || return 1
  previous_raya="$RAYA_TARGET"
  previous_flywheel="$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" || return 1
  previous_manifest="$(jq -r .canonical_manifest_digest "$RAYA_MIGRATION_MANIFEST")" || return 1
  remote="$(raya_git remote get-url origin 2>/dev/null || true)"
  case "$remote" in https://github.com/xrliAnnie/raya.git|git@github.com:xrliAnnie/raya.git) ;;
    file://*|/*) [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" == 1 ]] || return 1 ;;
    *) return 1 ;;
  esac
  raya_git_fetch_bounded || return 1
  target="$(raya_git rev-parse origin/main 2>/dev/null || true)"
  flywheel_sha="$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  manifest_sha="$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" || return 1
  raya_is_sha40 "$target" && raya_is_sha40 "$flywheel_sha" \
    && raya_is_sha256 "$manifest_sha" || return 1
  if [[ "$target" == "$previous_raya" && "$flywheel_sha" == "$previous_flywheel" \
    && "$manifest_sha" == "$previous_manifest" ]]; then
    RAYA_TARGET="$previous_raya"
    raya_verify_frozen_source
    return
  fi
  raya_git merge-base --is-ancestor "$previous_raya" "$target" || return 1
  raya_manifest_transform P7 P2 '
    .migration_id = (.migration_id + "-update-" + ($target[0:8]) + "-" + ($flywheel[0:8])) |
    .mode = "standard-update" |
    .previous_standard = {raya_sha:$previous_raya,flywheel_sha:$previous_flywheel,
      manifest_digest:$previous_manifest,artifact_digest:.artifact.digest} |
    .target_raya_sha = $target | .target_flywheel_sha = $flywheel |
    .target_manifest_digest = $manifest |
    .old_stopped_at = (.cutover.old_stopped_at // .old_stopped_at) |
    .lead = null | .business = null | .checks = null
  ' --arg previous_raya "$previous_raya" --arg previous_flywheel "$previous_flywheel" \
    --arg previous_manifest "$previous_manifest" --arg target "$target" \
    --arg flywheel "$flywheel_sha" --arg manifest "$manifest_sha"
}

raya_materialize_business() {
  local workspace="" source_identity="" version_root="" temp="" digest="" persona=""
  workspace="$(jq -er .projectDir "$RAYA_CANONICAL_MANIFEST")" || return 1
  [[ "$workspace" == "$RAYA_WORKSPACE" && -d "$workspace" && ! -L "$workspace" ]] || return 1
  source_identity="$RAYA_CODE_DIR/.lead/raya/identity.md"
  [[ -f "$source_identity" && ! -L "$source_identity" && -d "$RAYA_CODE_DIR/packages/cos" ]] || return 1
  version_root="$workspace/.flywheel-managed/versions/$RAYA_NEW_HEAD"
  temp="${version_root}.tmp.$$"
  mkdir -p "$workspace/.flywheel-managed/versions" "$workspace/.lead/raya" "$workspace/business" || return 1
  if [[ ! -d "$version_root" ]]; then
    [[ -f "$RAYA_CODE_DIR/packages/cos/package.json" \
      && -d "$RAYA_CODE_DIR/packages/cos/dist" ]] || return 1
    mkdir -p "$temp/.lead/raya" "$temp/packages/cos" || return 1
    cp "$source_identity" "$temp/.lead/raya/identity.md" \
      || { rm -rf "$temp"; return 1; }
    cp "$RAYA_CODE_DIR/packages/cos/package.json" "$temp/packages/cos/package.json" \
      || { rm -rf "$temp"; return 1; }
    cp -R "$RAYA_CODE_DIR/packages/cos/dist" "$temp/packages/cos/dist" \
      || { rm -rf "$temp"; return 1; }
    mv "$temp" "$version_root" || { rm -rf "$temp"; return 1; }
  fi
  digest="$(raya_tree_digest "$version_root")" || return 1
  persona="$(raya_sha256 "$source_identity")" || return 1
  local projected="$workspace/.lead/raya/identity.md" previous="" projected_digest=""
  if [[ -e "$projected" || -L "$projected" ]]; then
    [[ -f "$projected" && ! -L "$projected" ]] || return 1
    projected_digest="$(raya_sha256 "$projected")" || return 1
    previous="$(jq -r '.business.persona_digest // empty' "$RAYA_DEPLOY_RECEIPT" 2>/dev/null || true)"
    [[ "$projected_digest" == "$persona" \
      || ( -n "$previous" && "$projected_digest" == "$previous" ) ]] || return 1
  fi
  local projected_tmp="${projected}.tmp.$$"
  cp "$source_identity" "$projected_tmp" || return 1
  chmod 600 "$projected_tmp" || { rm -f "$projected_tmp"; return 1; }
  raya_atomic_replace "$projected_tmp" "$projected" || { rm -f "$projected_tmp"; return 1; }
  local pointer_tmp="$workspace/business/.current.$$"
  ln -s "$version_root" "$pointer_tmp" || return 1
  raya_atomic_symlink_replace "$pointer_tmp" "$workspace/business/current" \
    || { rm -f "$pointer_tmp"; return 1; }
  RAYA_ARTIFACT_DIGEST="$digest"
  RAYA_PERSONA_DIGEST="$persona"
}

raya_prepare_source() {
  local branch="" dirty="" remote="" attempt=1 fetch_rc=0 flywheel_sha="" manifest_sha="" checkpoint=""
  raya_validate_canonical_manifest || return 1
  raya_git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  branch="$(raya_git symbolic-ref --short HEAD 2>/dev/null || true)"
  [[ "$branch" == main ]] || return 1
  dirty="$(raya_git status --porcelain 2>/dev/null)" || return 1
  [[ -z "$dirty" ]] || return 1
  RAYA_CHECKOUT_BEFORE="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  raya_is_sha40 "$RAYA_CHECKOUT_BEFORE" || return 1
  raya_manifest_base_valid || return 1
  checkpoint="$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" || return 1
  if [[ "$checkpoint" == P7 ]]; then
    raya_begin_followup_transaction || return 1
    checkpoint="$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" || return 1
    if [[ "$checkpoint" == P7 ]]; then
      RAYA_NEW_HEAD="$RAYA_CHECKOUT_BEFORE"
      return 0
    fi
  fi
  if [[ "$checkpoint" != P2 ]]; then
    RAYA_TARGET="$(jq -er '.raya_sha | select(test("^[0-9a-f]{40}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
    RAYA_NEW_HEAD="$RAYA_CHECKOUT_BEFORE"
    raya_verify_frozen_source
    return
  fi
  raya_ensure_legacy_quiesced || return 1
  remote="$(raya_git remote get-url origin 2>/dev/null || true)"
  case "$remote" in https://github.com/xrliAnnie/raya.git|git@github.com:xrliAnnie/raya.git) ;;
    file://*|/*) [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" == 1 ]] || return 1 ;;
    *) return 1 ;;
  esac
  while (( attempt <= 3 )); do
    raya_git_fetch_bounded; fetch_rc=$?
    (( fetch_rc == 0 )) && break
    attempt=$((attempt + 1))
  done
  (( fetch_rc == 0 )) || return 1
  RAYA_TARGET="$(raya_git rev-parse origin/main 2>/dev/null || true)"
  raya_is_sha40 "$RAYA_TARGET" || return 1
  if [[ "$(jq -r '.mode // "migration"' "$RAYA_MIGRATION_MANIFEST")" == standard-update ]]; then
    [[ "$RAYA_TARGET" == "$(jq -r .target_raya_sha "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  fi
  raya_git merge-base --is-ancestor "$RAYA_CHECKOUT_BEFORE" "$RAYA_TARGET" || return 1
  [[ "$RAYA_CHECKOUT_BEFORE" == "$RAYA_TARGET" ]] || raya_git merge --ff-only "$RAYA_TARGET" --quiet || return 1
  RAYA_NEW_HEAD="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  [[ "$RAYA_NEW_HEAD" == "$RAYA_TARGET" ]] || return 1
  raya_run_bounded_in_checkout "$RAYA_INSTALL_TIMEOUT_SECONDS" pnpm install --frozen-lockfile || return 1
  raya_run_bounded_in_checkout "$RAYA_BUILD_TIMEOUT_SECONDS" pnpm build || return 1
  raya_materialize_business || return 1
  flywheel_sha="$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  raya_is_sha40 "$flywheel_sha" || return 1
  manifest_sha="$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" || return 1
  raya_is_sha256 "$manifest_sha" || return 1
  if [[ "$(jq -r '.mode // "migration"' "$RAYA_MIGRATION_MANIFEST")" == standard-update ]]; then
    [[ "$flywheel_sha" == "$(jq -r .target_flywheel_sha "$RAYA_MIGRATION_MANIFEST")" \
      && "$manifest_sha" == "$(jq -r .target_manifest_digest "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
    raya_standard_lead preflight "$RAYA_CANONICAL_MANIFEST"
    RAYA_PREFLIGHT_RC=$?
    (( RAYA_PREFLIGHT_RC == 0 )) || return 1
    raya_standard_lead install --project raya --lead raya || return 1
    raya_standard_lead verify --stage installed "$RAYA_CANONICAL_MANIFEST" || return 1
    raya_manifest_transform P2 P5 '
      .raya_sha = $raya | .flywheel_deployed_sha = $flywheel |
      .canonical_manifest_digest = $manifest |
      .artifact = {digest:$artifact,persona_digest:$persona,workspace:$workspace,state_schema_version:1} |
      .activated_at = $activated
    ' --arg raya "$RAYA_TARGET" --arg flywheel "$flywheel_sha" --arg manifest "$manifest_sha" \
      --arg artifact "$RAYA_ARTIFACT_DIGEST" --arg persona "$RAYA_PERSONA_DIGEST" \
      --arg workspace "$RAYA_WORKSPACE" --arg activated "$(raya_now_iso)" || return 1
  elif [[ "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST" 2>/dev/null || true)" == P2 ]]; then
    raya_manifest_transform P2 P2 '
      .raya_sha = $raya | .flywheel_deployed_sha = $flywheel |
      .canonical_manifest_digest = $manifest |
      .artifact = {digest:$artifact,persona_digest:$persona,workspace:$workspace,state_schema_version:1}
    ' --arg raya "$RAYA_TARGET" --arg flywheel "$flywheel_sha" --arg manifest "$manifest_sha" \
      --arg artifact "$RAYA_ARTIFACT_DIGEST" --arg persona "$RAYA_PERSONA_DIGEST" \
      --arg workspace "$RAYA_WORKSPACE" || return 1
  fi
}

raya_fail() {
  local detail="$1" rc="${2:-1}"
  RAYA_DEPLOY_STATE=failed
  RAYA_DEPLOY_DETAIL="$detail"
  raya_write_standard_receipt failed "$detail" >/dev/null 2>&1 || true
  raya_alert severe raya-standard-deploy-failed "Raya deploy failed" "$detail"
  raya_lock_release
  return "$rc"
}

updater_raya_pass() {
  local proof_rc=0
  raya_configure_runtime_paths
  RAYA_DEPLOY_STATE=not_run
  RAYA_DEPLOY_DETAIL=""
  RAYA_LOCK_OWNED=0
  RAYA_PREFLIGHT_RC=""
  if ! raya_host_capable; then
    RAYA_DEPLOY_STATE=not_configured
    RAYA_DEPLOY_DETAIL=canonical-standard-lead-absent
    return 1
  fi
  raya_lock_acquire || {
    RAYA_DEPLOY_STATE=locked
    RAYA_DEPLOY_DETAIL="lock-${RAYA_LOCK_FAILURE:-unknown}"
    return 1
  }
  raya_prepare_source || { raya_fail source-prepare-failed 2; return; }
  raya_standard_cutover || { raya_fail cutover-failed 3; return; }
  raya_standard_collect_proof; proof_rc=$?
  if (( proof_rc == 2 )); then
    RAYA_DEPLOY_STATE=awaiting_proof
    RAYA_DEPLOY_DETAIL=p5-awaiting-real-p6-evidence
    raya_write_standard_receipt refused "$RAYA_DEPLOY_DETAIL" >/dev/null 2>&1 || true
    raya_lock_release
    return 2
  fi
  (( proof_rc == 0 )) || { raya_fail proof-invalid 3; return; }
  raya_standard_finalize || { raya_fail finalize-failed 3; return; }
  RAYA_DEPLOY_STATE=deployed
  RAYA_DEPLOY_DETAIL="standard-lead:${RAYA_TARGET:0:8}"
  raya_lock_release
  raya_log "$RAYA_DEPLOY_STATE $RAYA_DEPLOY_DETAIL"
}
