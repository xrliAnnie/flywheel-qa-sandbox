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
    RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL="${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/raya-summary-presentation-migrate.js"
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
  : "${RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL:=${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/raya-summary-presentation-migrate.js}"
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
raya_wait() { sleep "$1"; }
raya_is_sha40() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }
raya_is_sha256() { [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]]; }
raya_git() { git -C "$RAYA_CODE_DIR" "$@"; }
raya_sha256() { shasum -a 256 "$1" 2>/dev/null | awk 'NF == 2 {print $1}'; }

# FLY-2654 QA2 rework: the migration ledger freezes only Raya's own identity
# rows of projects.json (scripts/lib/raya-registry-identity.jq), never the
# whole-file sha256. On 2026-09-19 an unrelated Lead model edit (trailing
# newline only) made every shuttle refuse with awaiting_pre_activation_rebind.
# An unrelated Lead edit, a new Lead row or a serialization-only difference must
# still deploy; a Raya identity change fails closed with the changed paths.
RAYA_REGISTRY_IDENTITY_JQ="${RAYA_REGISTRY_IDENTITY_JQ:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/raya-registry-identity.jq}"
RAYA_REBIND_REFUSAL=""
RAYA_REGISTRY_IDENTITY_MIGRATE=""
raya_registry_identity_projection() {
  [[ -f "$1" && ! -L "$1" && -f "$RAYA_REGISTRY_IDENTITY_JQ" && ! -L "$RAYA_REGISTRY_IDENTITY_JQ" ]] || return 1
  jq -c -f "$RAYA_REGISTRY_IDENTITY_JQ" "$1" 2>/dev/null
}
raya_registry_identity_drift() {
  jq -rn --argjson a "$1" --argjson b "$2" '
    def leaves: [paths(scalars) as $p | {p: ($p | map(tostring) | join(".")), v: getpath($p)}];
    ($a | leaves) as $x | ($b | leaves) as $y |
    ([$x[] | select(. as $e | ($y | any(. == $e) | not)) | .p] +
     [$y[] | select(. as $e | ($x | any(. == $e) | not)) | .p]) | unique | join(",")'
}
# Returns 0 when Raya's registry identity is unchanged. Sets RAYA_REBIND_REFUSAL
# with the named reason on refusal, and RAYA_REGISTRY_IDENTITY_MIGRATE with the
# projection to record when a legacy whole-file ledger can be upgraded in place.
raya_registry_identity_check() {
  local registry="$1" stored="" current="" drift="" bot="" root="" backend=""
  RAYA_REBIND_REFUSAL=""
  RAYA_REGISTRY_IDENTITY_MIGRATE=""
  current="$(raya_registry_identity_projection "$registry")" \
    || { RAYA_REBIND_REFUSAL=raya-registry-unreadable; return 1; }
  stored="$(jq -c '.registry_identity // empty' "$RAYA_MIGRATION_MANIFEST" 2>/dev/null)" || stored=""
  if [[ -n "$stored" ]]; then
    jq -n --argjson a "$stored" --argjson b "$current" -e '$a == $b' >/dev/null 2>&1 && return 0
    drift="$(raya_registry_identity_drift "$stored" "$current" 2>/dev/null)" || drift=""
    RAYA_REBIND_REFUSAL="raya-registry-identity-drift:${drift:-unknown}"
    return 1
  fi
  # Legacy ledger (whole-file digest only). Unchanged bytes remain proof; a
  # byte change is accepted only when Raya's own rows still match the facts the
  # migration froze independently (bot identity, workspace, canonical carrier).
  bot="$(jq -r '.lead_bot_user_id // empty' "$RAYA_MIGRATION_MANIFEST" 2>/dev/null)" || bot=""
  root="$(jq -r '.projectDir // empty' "$RAYA_CANONICAL_MANIFEST" 2>/dev/null)" || root=""
  backend="$(jq -r '.leadBackend.backendId // empty' "$RAYA_CANONICAL_MANIFEST" 2>/dev/null)" || backend=""
  if [[ "$(raya_sha256 "$registry")" != "$(jq -r '.registry_digest // empty' "$RAYA_MIGRATION_MANIFEST")" ]]; then
    if [[ -z "$bot" || -z "$root" || -z "$backend" ]] || ! jq -n --argjson p "$current" \
        --arg bot "$bot" --arg root "$root" --arg backend "$backend" -e '
        ($p | length) == 1 and ($p[0].leads | length) == 1 and
        $p[0].projectRoot == $root and $p[0].leads[0].botUserId == $bot and
        $p[0].leads[0].botTokenEnv == "RAYA_BOT_TOKEN" and
        (($p[0].leads[0].backend // "claude-code") == $backend)' >/dev/null 2>&1; then
      RAYA_REBIND_REFUSAL="raya-registry-identity-unverifiable:legacy-whole-file-digest-mismatch"
      return 1
    fi
  fi
  if jq -n --argjson p "$current" -e '($p | length) == 1 and ($p[0].leads | length) == 1' >/dev/null 2>&1; then
    RAYA_REGISTRY_IDENTITY_MIGRATE="$current"
  fi
  return 0
}
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
raya_process_command() {
  LC_ALL=C ps -ww -o command= -p "$1" 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
raya_process_snapshot() {
  LC_ALL=C ps -ww -axo pid=,command= 2>/dev/null
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

raya_legacy_stop_authorized() {
  raya_manifest_base_valid || return 1
  if jq -e '
    def snowflake: type == "string" and test("^[0-9]{17,20}$");
    (.target_raya_sha | type == "string" and test("^[0-9a-f]{40}$")) and
    .authorization.legacy_stop == true and .authorization.granted_by == "founder" and
    (.authorization.evidence_message_id | snowflake) and
    (.authorization.evidence_channel_id | snowflake) and
    (.authorization.evidence_author_id | snowflake) and
    (.authorization.content_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    .authorization.canonical_line ==
      ("FLY-2496 AUTHORIZE register cutover=" + .target_raya_sha[0:8] +
       " urgent-restart baseline=quiet15m")
  ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
    return 0
  fi
  jq -e '
    .authorization.legacy_stop == true and
    .authorization.granted_by == "standing-carve-out" and
    .authorization.entry_id == "raya-carrier-follow-main/v1" and
    (.authorization.entry_digest | type == "string" and test("^[0-9a-f]{64}$")) and
    (.authorization.activation_manifest_digest | type == "string" and test("^[0-9a-f]{64}$")) and
    (.authorization.manifest_revision | type == "number" and . >= 1 and floor == .) and
    (.authorization.mechanism_version | type == "string" and length > 0) and
    (.authorization.execution_package_digest | type == "string" and test("^[0-9a-f]{64}$")) and
    .authorization.confirmed_by == "flywheel-cos-lead" and
    (.authorization.confirmation_receipt_id | type == "string" and length > 0) and
    .authorization.issued_by == "flywheel-eng-lead" and
    (.authorization | has("canonical_line") | not)
  ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
  "$RAYA_STANDARD_NODE_BIN" "$FLYWHEEL_TEAMLEAD_ROOT/dist/bin/raya-migration-manifest.js" \
    verify-standing --migration-manifest "$RAYA_MIGRATION_MANIFEST" >/dev/null
}

# A bootout alone does not survive login: ignored legacy dist can still run.
raya_legacy_disabled() {
  local disabled=""
  disabled="$(launchctl print-disabled "gui/$(id -u)" 2>/dev/null)" || return 1
  printf '%s\n' "$disabled" | awk -v key="\"$1\"" '
    $1 == key { seen++; if ($2 == "=>" && ($3 == "disabled" || $3 == "true")) enabled++ }
    END { exit !(seen == 1 && enabled == 1) }'
}

raya_verify_legacy_retired() {
  local app="" label=""
  jq -e '([.legacy_owner[].label] | sort) == ["com.xrli.raya.brain","com.xrli.raya.voice"] and
    all(.legacy_owner[]; (.disabled_at_ms | type == "number") and (.stopped_at_ms | type == "number"))' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
  for app in brain voice; do
    label="com.xrli.raya.$app"
    raya_legacy_process_census_clear "$app" || return 1
    raya_legacy_disabled "$label" || return 1
    local observation=""
    if observation="$(launchctl print "gui/$(id -u)/$label" 2>&1)"; then return 1; fi
    case "$observation" in *"Could not find service"*|*"Could not find specified service"*) ;; *) return 1 ;; esac
  done
}

raya_legacy_recorded_owner_gone() {
  local label="$1" pid="" recorded_start="" current_start=""
  pid="$(jq -er --arg label "$label" '
    [.legacy_owner[] | select(.label == $label)] |
    select(length == 1) | .[0].pid | select(type == "number" and . > 0)
  ' "$RAYA_MIGRATION_MANIFEST")" || return 1
  recorded_start="$(jq -er --arg label "$label" '
    .legacy_owner[] | select(.label == $label) | .start |
    select(type == "string" and length > 0)
  ' "$RAYA_MIGRATION_MANIFEST")" || return 1
  kill -0 "$pid" 2>/dev/null || return 0
  current_start="$(raya_process_start "$pid")" || return 1
  [[ -n "$current_start" && "$current_start" != "$recorded_start" ]]
}

raya_legacy_launchd_not_running() {
  printf '%s\n' "$1" | awk '
    $1 == "pid" && $2 == "=" { pid++ }
    $1 == "state" && $2 == "=" && !seen++ { state = $3 " " $4 }
    END { exit !(pid == 0 && state == "not running") }'
}

raya_legacy_process_matches() {
  local plist="$1" pid="$2" command=""
  command="$(raya_process_command "$pid")" || return 1
  [[ -n "$command" ]] || return 1
  python3 - "$plist" "$command" <<'PY'
import os, plistlib, shlex, sys
path, command = sys.argv[1:]
try:
    with open(path, "rb") as handle:
        expected = plistlib.load(handle).get("ProgramArguments")
    actual = shlex.split(command)
except (OSError, plistlib.InvalidFileException, ValueError):
    raise SystemExit(1)
if (not isinstance(expected, list) or len(expected) != 3 or len(actual) != 3 or
        os.path.basename(actual[0]) != os.path.basename(expected[0]) or
        actual[1:] != expected[1:]):
    raise SystemExit(1)
PY
}

raya_legacy_process_census_clear() {
  local app="$1" allowed_pid="${2:-}" snapshot="" expected_cli=""
  [[ "$app" == brain || "$app" == voice ]] || return 1
  expected_cli="$RAYA_CODE_DIR/apps/$app/dist/cli.js"
  snapshot="$(raya_process_snapshot)" || return 1
  printf '%s\n' "$snapshot" | python3 -c '
import os, shlex, sys

expected_cli, allowed_pid = sys.argv[1:]
if not os.path.isabs(expected_cli):
    raise SystemExit(1)
if allowed_pid and (not allowed_pid.isdigit() or int(allowed_pid) < 1):
    raise SystemExit(1)

for line in sys.stdin:
    fields = line.strip().split(None, 1)
    if len(fields) != 2 or not fields[0].isdigit():
        continue
    try:
        actual = shlex.split(fields[1])
    except ValueError:
        continue
    if (len(actual) == 3 and
            os.path.basename(actual[0]) == "node" and
            actual[1:] == [expected_cli, "run"] and fields[0] != allowed_pid):
        raise SystemExit(1)
' "$expected_cli" "$allowed_pid"
}

raya_quiesce_legacy_owner() {
  # Only the verified ledger grants this call authority. Never trust inherited
  # environment state, even when this function is invoked outside the pass.
  local RAYA_MIGRATION_ALLOW_LEGACY_STOP=0
  if raya_legacy_stop_authorized; then RAYA_MIGRATION_ALLOW_LEGACY_STOP=1; fi
  raya_verify_legacy_owners || return 1
  local app="" label="" plist="" found=0 loaded="" pid="" start="" digest="" now="" already_missing=0 loaded_not_running=0
  for app in brain voice; do
    label="com.xrli.raya.$app"
    plist="${RAYA_LEGACY_PLIST_DIR:-${HOME}/Library/LaunchAgents}/${label}.plist"
    if [[ -e "$plist" || -L "$plist" ]] || launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      found=1
      [[ "${RAYA_MIGRATION_ALLOW_LEGACY_STOP:-0}" == 1 ]] || return 1
      [[ -f "$plist" && ! -L "$plist" ]] || return 1
      raya_legacy_plist_matches "$plist" "$app" "$label" || return 1
      digest="$(raya_sha256 "$plist")" || return 1
      jq -e --arg label "$label" --arg digest "$digest" '
        [.legacy_owner[] | select(.label == $label)] |
        length == 1 and .[0].plist_sha256 == $digest
      ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
      if loaded="$(launchctl print "gui/$(id -u)/$label" 2>/dev/null)"; then
        pid="$(printf '%s\n' "$loaded" | awk '$1 == "pid" && $2 == "=" {print $3}')"
        if [[ -z "$pid" ]]; then
          raya_legacy_launchd_not_running "$loaded" || return 1
          loaded_not_running=1
          already_missing=1
        else
          [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
          start="$(raya_process_start "$pid")" || return 1
          [[ -n "$start" ]] || return 1
          raya_legacy_process_matches "$plist" "$pid" || return 1
          jq -e --arg label "$label" '
            .legacy_owner[] | select(.label == $label) |
            .stopped_at_ms == null
          ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
          now="$("$RAYA_STANDARD_NODE_BIN" -p 'Date.now()')" || return 1
          raya_manifest_transform P2 P2 '
            (.legacy_owner[] | select(.label == $label)) |=
              (.pid = $pid | .start = $start | .stop_started_at_ms //= $now)
          ' --arg label "$label" --argjson pid "$pid" --arg start "$start" \
            --argjson now "$now" || return 1
          launchctl disable "gui/$(id -u)/$label" >/dev/null 2>&1 || return 1
          raya_legacy_disabled "$label" || return 1
          raya_manifest_transform P2 P2 '
            (.legacy_owner[] | select(.label == $label)).disabled_at_ms //= $now
          ' --arg label "$label" --argjson now "$now" || return 1
          launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || return 1
          launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && return 1
        fi
      else
        loaded="$(launchctl print "gui/$(id -u)/$label" 2>&1 || true)"
        case "$loaded" in *"Could not find service"*|*"Could not find specified service"*) ;; *) return 1 ;; esac
        jq -e --arg label "$label" '
          .legacy_owner[] | select(.label == $label) |
          .pid == null or .stop_started_at_ms != null or .stopped_at_ms != null
        ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 \
          || raya_legacy_recorded_owner_gone "$label" || return 1
        if jq -e --arg label "$label" '
          .legacy_owner[] | select(.label == $label) |
          .stop_started_at_ms == null and .stopped_at_ms == null
        ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
          already_missing=1
        fi
      fi
      # Also disable an already unloaded job; a crash after bootout must not
      # allow its RunAtLoad plist and ignored runtime to revive at login.
      if ! raya_legacy_disabled "$label"; then
        launchctl disable "gui/$(id -u)/$label" >/dev/null 2>&1 || return 1
        raya_legacy_disabled "$label" || return 1
      fi
      if [[ "$loaded_not_running" == 1 ]]; then
        launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || return 1
        launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && return 1
      fi
      # An already unloaded matching job is a completed stop, including a
      # crash after bootout but before recording its receipt.
      now="$("$RAYA_STANDARD_NODE_BIN" -p 'Date.now()')" || return 1
      raya_manifest_transform P2 P2 '
        (.legacy_owner[] | select(.label == $label)) |=
          (.stop_started_at_ms //= $now | .disabled_at_ms //= $now | .stopped_at_ms //= $now)
      ' --arg label "$label" --argjson now "$now" || return 1
      if [[ "$already_missing" == 1 ]]; then
        raya_alert warning raya-legacy-owner-already-exited \
          "Raya legacy owner already exited" \
          "$label was absent before quiesce; recorded its observed retirement at $now." || true
      fi
      already_missing=0
      loaded_not_running=0
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
    raya_verify_legacy_retired
    return
  fi
  jq -e '(.old_stopped_at // null) == null' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
  raya_quiesce_legacy_owner || return 1
  jq -e '
    .legacy_owner == null or
    (([.legacy_owner[].label] | sort) == ["com.xrli.raya.brain", "com.xrli.raya.voice"] and
     all(.legacy_owner[]; (.stop_started_at_ms | type == "number") and
       (.stopped_at_ms | type == "number") and .stopped_at_ms >= .stop_started_at_ms))
  ' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
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

raya_shuttle_step() {
  "$RAYA_STANDARD_NODE_BIN" "$FLYWHEEL_TEAMLEAD_ROOT/dist/bin/raya-migration-manifest.js" \
    "$1" --lock-owner "$$"
}
raya_emit_window_probe() { raya_shuttle_step cutover-probe; }
raya_compute_seed_boundary() { raya_shuttle_step seed-boundary; }

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

raya_manifest_record_preexisting_cursor() {
  local receipt="$1" observed="" boundary="" seeded_at=""
  observed="$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' <<<"$receipt")" || return 1
  boundary="$(jq -er '.seedSha256 | select(test("^[0-9a-f]{64}$"))' <<<"$receipt")" || return 1
  [[ "$(jq -r .status <<<"$receipt")" == preexisting ]] || return 1
  [[ "$(jq -r .migrationId <<<"$receipt")" == "$(jq -r .migration_id "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  seeded_at="$(raya_now_iso)" || return 1
  raya_manifest_transform P3 P4b \
    '.cursor.status = "preexisting" | .cursor.sha256 = $boundary |
      .cursor.observed_sha256 = $observed | .cursor.seeded_at = $seeded' \
    --arg boundary "$boundary" --arg observed "$observed" --arg seeded "$seeded_at"
}

raya_standard_lead_wait_live() {
  local attempt=1
  for (( attempt=1; attempt<=30; attempt++ )); do
    if raya_standard_lead verify --stage live "$RAYA_CANONICAL_MANIFEST"; then return 0; fi
    (( attempt < 30 )) && raya_wait 2
  done
  return 1
}

# FLY-2758: `flywheel-lead.sh install` boots the live standard Lead out before
# it bootstraps the rendered plist. When bootstrap then fails, the only
# conversational carrier is gone (the legacy brain/voice owners were retired at
# P2). Observe that and put the standard Lead back through the same public verb
# so a failed cutover never leaves Raya with nobody loaded. Sets
# RAYA_RESTORE_STATE to not_needed | restored | not_restored.
RAYA_STANDARD_LEAD_LABEL="com.flywheel.lead.raya-raya"
# launchd's own answer to "is a carrier loaded": exactly one running pid for
# the standard Lead label. The full `verify --stage live` also needs a healthy
# Bridge, an API token and an inbox nudge, so it alone must not decide OFFLINE.
raya_standard_lead_loaded() {
  local out=""
  out="$(launchctl print "gui/$(id -u)/$RAYA_STANDARD_LEAD_LABEL" 2>/dev/null)" || return 1
  [[ "$(grep -cE '^[[:space:]]*state = running[[:space:]]*$' <<<"$out")" == 1 ]] \
    && grep -qE '^[[:space:]]*pid = [1-9][0-9]*[[:space:]]*$' <<<"$out"
}

# Sets RAYA_RESTORE_STATE to one of:
#   not_needed      install failed before unloading the Lead; live verify passes
#   loaded_not_live launchd shows the Lead running but live verify fails
#                   (Bridge/pump side); no carrier churn, not an outage
#   restored        the Lead was gone, the public install brought it back live
#   not_restored    launchd shows no standard Lead after the restore attempt
raya_recover_standard_lead_after_install_failure() {
  RAYA_RESTORE_STATE=not_restored
  if raya_standard_lead verify --stage live "$RAYA_CANONICAL_MANIFEST"; then
    RAYA_RESTORE_STATE=not_needed
    raya_log "install failed before unloading the standard Lead; it is still live"
    return 0
  fi
  if raya_standard_lead_loaded; then
    RAYA_RESTORE_STATE=loaded_not_live
    raya_log "standard Lead is loaded in launchd but not live after the failed install; leaving it in place"
    return 0
  fi
  raya_log "standard Lead is not loaded after a failed install; restoring it"
  if raya_standard_lead install --project raya --lead raya && raya_standard_lead_wait_live; then
    RAYA_RESTORE_STATE=restored
    raya_log "standard Lead restored and live after the failed install"
    return 0
  fi
  if raya_standard_lead_loaded; then
    RAYA_RESTORE_STATE=loaded_not_live
    raya_log "standard Lead is loaded in launchd after the restore install but not yet live"
    return 0
  fi
  raya_log "standard Lead could NOT be restored after the failed install; launchd has no carrier loaded"
  return 1
}

# The standard-update arm of raya_prepare_source restarts the Lead through the
# same public verb and needs the same recovery when its install fails.
raya_standard_update_install() {
  raya_standard_lead preflight "$RAYA_CANONICAL_MANIFEST"
  RAYA_PREFLIGHT_RC=$?
  (( RAYA_PREFLIGHT_RC == 0 )) || return 1
  raya_standard_lead install --project raya --lead raya \
    || { raya_recover_standard_lead_after_install_failure || true; return 1; }
  raya_standard_lead verify --stage installed "$RAYA_CANONICAL_MANIFEST" || return 1
}

raya_standard_cutover() {
  local checkpoint="" stopped_at="" cursor="" input="" receipt="" activated="" installed=""
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
        raya_emit_window_probe || return 1
        raya_compute_seed_boundary || return 1
        cursor="$(jq -er '.cursor.path | select(type == "string" and startswith("/"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
        input="$(jq -er '.cursor.seed_input | select(type == "string" and startswith("/"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
        if [[ "$(jq -r '.cursor.status // empty' "$RAYA_MIGRATION_MANIFEST")" == preexisting ]]; then
          receipt="$(raya_standard_seed_inbound_cursor "$cursor" "$input" preexisting)" || return 1
          raya_manifest_record_preexisting_cursor "$receipt" || return 1
        else
          receipt="$(raya_standard_seed_inbound_cursor "$cursor" "$input")" || return 1
          raya_manifest_record_cursor "$receipt" || return 1
        fi
        ;;
      P4b)
        cursor="$(jq -er .cursor.path "$RAYA_MIGRATION_MANIFEST")" || return 1
        raya_standard_preinstall_ready "$RAYA_MIGRATION_MANIFEST" "$cursor" || return 1
        raya_bridge_token_ready || return 1
        if [[ "$(jq -r .cursor.status "$RAYA_MIGRATION_MANIFEST")" == preexisting ]]; then
          if [[ "$(jq -r '.lead_restart_installed_at // empty' "$RAYA_MIGRATION_MANIFEST")" == "" ]]; then
            if ! raya_standard_lead verify --stage live "$RAYA_CANONICAL_MANIFEST"; then
              RAYA_DEPLOY_DETAIL=awaiting_standard_lead_pre_restart
              return 1
            fi
            raya_standard_lead install --project raya --lead raya \
              || { raya_recover_standard_lead_after_install_failure || true; return 1; }
            installed="$(raya_now_iso)" || return 1
            raya_manifest_transform P4b P4b '.lead_restart_installed_at = $installed' \
              --arg installed "$installed" || return 1
          fi
          if ! raya_standard_lead_wait_live; then
            RAYA_DEPLOY_DETAIL=awaiting_standard_lead_readiness
            return 1
          fi
          if [[ "$(jq -r '.activated_at // empty' "$RAYA_MIGRATION_MANIFEST")" == "" ]]; then
            jq -e '
              (.cutover_probe.intent.nonce | type == "string" and length > 0) and
              (.cutover_probe.message_id | type == "string" and test("^[0-9]{17,20}$"))
            ' "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
            activated="$(raya_now_iso)" || return 1
            raya_manifest_transform P4b P4b '
              .activated_at = $activated |
              .seed_probe = .cutover_probe |
              .probe_resets = ((.probe_resets // []) + [{
                nonce:.cutover_probe.intent.nonce,
                at:$activated,
                reason:"preexisting-post-activation"
              }]) |
              del(.cutover_probe)
            ' --arg activated "$activated" || return 1
          fi
          jq -e '
            (.activated_at | type == "string" and length > 0) and
            (.seed_probe.intent.nonce | type == "string" and length > 0) and
            (.seed_probe.message_id | type == "string" and test("^[0-9]{17,20}$"))
          ' "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
          raya_emit_window_probe || return 1
          raya_manifest_transform P4b P5 '.' || return 1
        else
          raya_standard_lead preflight "$RAYA_CANONICAL_MANIFEST"
          RAYA_PREFLIGHT_RC=$?
          (( RAYA_PREFLIGHT_RC == 0 )) || return 1
          raya_standard_lead install --project raya --lead raya \
            || { raya_recover_standard_lead_after_install_failure || true; return 1; }
          raya_standard_lead verify --stage installed "$RAYA_CANONICAL_MANIFEST" || return 1
          activated="$(raya_now_iso)" || return 1
          raya_manifest_transform P4b P5 '.activated_at = $activated' --arg activated "$activated" || return 1
        fi
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
  raya_verify_legacy_retired || return 1
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
  raya_verify_legacy_retired || return 1
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

raya_verify_legacy_owners() {
  if jq -e 'all(.legacy_owner[]; .stopped_at_ms != null)' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
    raya_verify_legacy_retired
    return
  fi
  local app="" label="" plist="" loaded="" pid="" start="" hash="" allowed_pid=""
  raya_legacy_stop_authorized || return 1
  jq -e '([.legacy_owner[].label] | sort) == ["com.xrli.raya.brain","com.xrli.raya.voice"]' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
  for app in brain voice; do
    allowed_pid=""
    label="com.xrli.raya.$app"
    plist="${RAYA_LEGACY_PLIST_DIR:-${HOME}/Library/LaunchAgents}/${label}.plist"
    [[ -f "$plist" && ! -L "$plist" ]] || return 1
    raya_legacy_plist_matches "$plist" "$app" "$label" || return 1
    hash="$(raya_sha256 "$plist")" || return 1
    jq -e --arg label "$label" --arg hash "$hash" '.legacy_owner[] | select(.label==$label) | .plist_sha256==$hash' \
      "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
    if loaded="$(launchctl print "gui/$(id -u)/$label" 2>&1)"; then
      pid="$(printf '%s\n' "$loaded" | awk '$1 == "pid" && $2 == "=" {print $3}')"
      if [[ -z "$pid" ]]; then
        raya_legacy_launchd_not_running "$loaded" || return 1
      else
        [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
        start="$(raya_process_start "$pid")" || return 1
        [[ -n "$start" ]] || return 1
        raya_legacy_process_matches "$plist" "$pid" || return 1
        allowed_pid="$pid"
        jq -e --arg label "$label" '
          .legacy_owner[] | select(.label==$label) | .stopped_at_ms==null
        ' "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
      fi
    else
      case "$loaded" in *"Could not find service"*|*"Could not find specified service"*) ;; *) return 1 ;; esac
      jq -e --arg label "$label" '
        .legacy_owner[] | select(.label==$label) |
        .pid==null or .stop_started_at_ms!=null or .stopped_at_ms!=null
      ' "$RAYA_MIGRATION_MANIFEST" >/dev/null \
        || raya_legacy_recorded_owner_gone "$label" || return 1
    fi
    raya_legacy_process_census_clear "$app" "$allowed_pid" || return 1
  done
}

raya_verify_candidate_artifact() {
  local candidate="$RAYA_HOME/build-check/$RAYA_TARGET.export" persona="" artifact=""
  [[ "$(jq -r .prepared_candidate.path "$RAYA_MIGRATION_MANIFEST")" == "$candidate" ]] || return 1
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ -z "$(find "$candidate" -type l -print)" ]] || return 1
  artifact="$(raya_tree_digest "$candidate")" || return 1
  persona="$(raya_sha256 "$candidate/.lead/raya/identity.md")" || return 1
  local version="$RAYA_WORKSPACE/.flywheel-managed/versions/$RAYA_TARGET"
  if [[ -e "$version" || -L "$version" ]]; then
    [[ -d "$version" && ! -L "$version" && -z "$(find "$version" -type l -print)" \
      && "$(raya_tree_digest "$version")" == "$artifact" ]] || return 1
  fi
  [[ "$artifact" == "$(jq -r .prepared_candidate.digest "$RAYA_MIGRATION_MANIFEST")" \
    && "$persona" == "$(jq -r .prepared_candidate.persona_digest "$RAYA_MIGRATION_MANIFEST")" \
    && "$persona" == "$(raya_sha256 "$RAYA_WORKSPACE/.lead/raya/identity.md")" \
    && "$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" == "$(jq -r .canonical_manifest_digest "$RAYA_MIGRATION_MANIFEST")" ]]
}

raya_verify_candidate() {
  raya_verify_candidate_artifact || return 1
  [[ "$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE")" == "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" ]]
}

raya_prestop_prepare() {
  local scratch="" candidate="" remote="" remote_head="" flywheel="" canonical="" persona="" artifact=""
  raya_legacy_stop_authorized || return 1
  raya_verify_legacy_owners || return 1
  RAYA_TARGET="$(jq -r .target_raya_sha "$RAYA_MIGRATION_MANIFEST")"
  scratch="$RAYA_HOME/build-check/$RAYA_TARGET"
  candidate="$scratch.export"
  remote="$(raya_git remote get-url origin 2>/dev/null || true)"
  case "$remote" in https://github.com/xrliAnnie/raya.git|git@github.com:xrliAnnie/raya.git) ;;
    file://*|/*) [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" == 1 ]] || return 1 ;;
    *) return 1 ;;
  esac
  raya_git_fetch_bounded || return 1
  remote_head="$(raya_git rev-parse origin/main 2>/dev/null || true)"
  raya_is_sha40 "$remote_head" || return 1
  raya_git merge-base --is-ancestor "$RAYA_TARGET" "$remote_head" || return 1
  if [[ "$remote_head" != "$RAYA_TARGET" ]] \
    && [[ "$(jq -r '.authorization.granted_by // ""' "$RAYA_MIGRATION_MANIFEST")" == standing-carve-out ]]; then
    jq -e 'all(.legacy_owner[]?; .stop_started_at_ms == null and .stopped_at_ms == null) and
      (.old_stopped_at // null) == null and (.prestop_probe // null) == null' \
      "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
    raya_manifest_transform P2 P2 '
      .target_raya_sha = $target |
      .target_revision = ((.target_revision // 1) + 1) |
      del(.prepared_candidate,.prestop_probe) |
      .prestop_retry = true
    ' --arg target "$remote_head" || return 1
    RAYA_TARGET="$remote_head"
  fi
  raya_git merge-base --is-ancestor "$RAYA_CHECKOUT_BEFORE" "$RAYA_TARGET" || return 1
  [[ ! -L "$RAYA_HOME/build-check" && ! -L "$scratch" && ! -L "$candidate" ]] || return 1
  mkdir -p "$RAYA_HOME/build-check" || return 1
  if [[ ! -d "$scratch" ]]; then raya_git worktree add --detach "$scratch" "$RAYA_TARGET" || return 1; fi
  [[ "$(git -C "$scratch" rev-parse HEAD)" == "$RAYA_TARGET" \
    && -z "$(git -C "$scratch" status --porcelain)" ]] || return 1
  (
    local RAYA_CODE_DIR="$scratch"
    raya_run_bounded_in_checkout "$RAYA_INSTALL_TIMEOUT_SECONDS" pnpm install --frozen-lockfile || exit 1
    raya_run_bounded_in_checkout "$RAYA_BUILD_TIMEOUT_SECONDS" pnpm build
  ) || return 1
  [[ "$(git -C "$scratch" rev-parse HEAD)" == "$RAYA_TARGET" \
    && -z "$(git -C "$scratch" status --porcelain)" \
    && -f "$scratch/.lead/raya/identity.md" && ! -L "$scratch/.lead/raya/identity.md" \
    && -f "$scratch/packages/cos/package.json" && ! -L "$scratch/packages/cos/package.json" \
    && -d "$scratch/packages/cos/dist" && ! -L "$scratch/packages/cos/dist" \
    && -z "$(find "$scratch/packages/cos/dist" -type l -print)" ]] || return 1
  persona="$(raya_sha256 "$scratch/.lead/raya/identity.md")" || return 1
  [[ -f "$RAYA_WORKSPACE/.lead/raya/identity.md" && ! -L "$RAYA_WORKSPACE/.lead/raya/identity.md" \
    && "$persona" == "$(raya_sha256 "$RAYA_WORKSPACE/.lead/raya/identity.md")" ]] || return 1
  # This bounded export is prepared before any bootout and reused after a crash.
  rm -rf "$candidate" || return 1
  mkdir -p "$candidate/.lead/raya" "$candidate/packages/cos" || return 1
  cp "$scratch/.lead/raya/identity.md" "$candidate/.lead/raya/identity.md" || return 1
  cp "$scratch/packages/cos/package.json" "$candidate/packages/cos/package.json" || return 1
  cp -R "$scratch/packages/cos/dist" "$candidate/packages/cos/dist" || return 1
  "$RAYA_STANDARD_NODE_BIN" - "$candidate" <<'NODE' || return 1
const fs = require('node:fs'), path = require('node:path');
function syncTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('candidate-file-invalid');
  if (stat.isDirectory()) for (const child of fs.readdirSync(root)) syncTree(path.join(root, child));
  const fd = fs.openSync(root, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
syncTree(process.argv[2]);
const parent = fs.openSync(path.dirname(process.argv[2]), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
  artifact="$(raya_tree_digest "$candidate")" || return 1
  flywheel="$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE")" || return 1
  canonical="$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" || return 1
  raya_is_sha40 "$flywheel" && raya_is_sha256 "$artifact" && raya_is_sha256 "$canonical" || return 1
  raya_shuttle_step prestop-probe || return 1
  raya_shuttle_step quiet-check || return 1
  raya_manifest_transform P2 P2 '
    .raya_sha=$raya | .flywheel_deployed_sha=$flywheel | .canonical_manifest_digest=$canonical |
    .prepared_candidate={path:$path,digest:$artifact,persona_digest:$persona}
  ' --arg raya "$RAYA_TARGET" --arg flywheel "$flywheel" --arg canonical "$canonical" \
    --arg path "$candidate" --arg artifact "$artifact" --arg persona "$persona" || return 1
  [[ "$RAYA_CHECKOUT_BEFORE" == "$RAYA_TARGET" ]] || raya_git merge --ff-only "$RAYA_TARGET" --quiet || return 1
  RAYA_NEW_HEAD="$(raya_git rev-parse HEAD)" || return 1
  [[ "$RAYA_NEW_HEAD" == "$RAYA_TARGET" && -z "$(raya_git status --porcelain)" ]] || return 1
  raya_verify_candidate || return 1
  raya_verify_legacy_owners || return 1
  raya_shuttle_step quiet-check
}

raya_promote_candidate() {
  raya_verify_candidate || return 1
  local RAYA_CODE_DIR="$RAYA_HOME/build-check/$RAYA_TARGET.export"
  raya_materialize_business || return 1
  [[ "$RAYA_ARTIFACT_DIGEST" == "$(jq -r .prepared_candidate.digest "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  raya_manifest_transform P2 P2 '
    .artifact={digest:$artifact,persona_digest:$persona,workspace:$workspace,state_schema_version:1}
  ' --arg artifact "$RAYA_ARTIFACT_DIGEST" --arg persona "$RAYA_PERSONA_DIGEST" --arg workspace "$RAYA_WORKSPACE"
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
    raya_verify_legacy_retired || return 1
    RAYA_TARGET="$(jq -er '.raya_sha | select(test("^[0-9a-f]{40}$"))' "$RAYA_MIGRATION_MANIFEST")" || return 1
    RAYA_NEW_HEAD="$RAYA_CHECKOUT_BEFORE"
    raya_verify_frozen_source
    return
  fi
  if [[ "$(jq -r '.mode // "migration"' "$RAYA_MIGRATION_MANIFEST")" != standard-update ]]; then
    if jq -e 'any(.legacy_owner[]?; .stop_started_at_ms != null)' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
      RAYA_TARGET="$(jq -r .target_raya_sha "$RAYA_MIGRATION_MANIFEST")"
      RAYA_NEW_HEAD="$RAYA_CHECKOUT_BEFORE"
      raya_is_sha40 "$RAYA_TARGET" && [[ "$RAYA_NEW_HEAD" == "$RAYA_TARGET" ]] || return 1
      raya_verify_candidate || return 1
    else
      if ! raya_prestop_prepare; then
        RAYA_DEPLOY_STATE=prestop-failed
        RAYA_DEPLOY_DETAIL=prestop-validation-failed
        raya_manifest_transform P2 P2 '.prestop_retry=true' >/dev/null 2>&1 || true
        return 1
      fi
    fi
    raya_ensure_legacy_quiesced || return 1
    raya_promote_candidate
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
  raya_git merge-base --is-ancestor "$RAYA_CHECKOUT_BEFORE" "$RAYA_TARGET" || return 1
  flywheel_sha="$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  raya_is_sha40 "$flywheel_sha" || return 1
  manifest_sha="$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" || return 1
  raya_is_sha256 "$manifest_sha" || return 1
  [[ "$flywheel_sha" == "$(jq -r .target_flywheel_sha "$RAYA_MIGRATION_MANIFEST")" \
    && "$manifest_sha" == "$(jq -r .target_manifest_digest "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  [[ "$RAYA_CHECKOUT_BEFORE" == "$RAYA_TARGET" ]] || raya_git merge --ff-only "$RAYA_TARGET" --quiet || return 1
  RAYA_NEW_HEAD="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  [[ "$RAYA_NEW_HEAD" == "$RAYA_TARGET" ]] || return 1
  raya_run_bounded_in_checkout "$RAYA_INSTALL_TIMEOUT_SECONDS" pnpm install --frozen-lockfile || return 1
  raya_run_bounded_in_checkout "$RAYA_BUILD_TIMEOUT_SECONDS" pnpm build || return 1
  [[ "$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE" 2>/dev/null || true)" == "$flywheel_sha" \
    && "$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" == "$manifest_sha" ]] || return 1
  raya_materialize_business || return 1
  if [[ "$(jq -r '.mode // "migration"' "$RAYA_MIGRATION_MANIFEST")" == standard-update ]]; then
    raya_migrate_summary_presentation || return 1
    raya_standard_update_install || return 1
    raya_manifest_transform P2 P5 '
      .target_raya_sha = $raya | .raya_sha = $raya | .flywheel_deployed_sha = $flywheel |
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

# FLY-2619: install the data-first presentation gate before the updated Raya
# process can consume a summary round. The adapter is idempotent and bounded to
# the canonical workspace plus the current authoritative teamlead database.
raya_migrate_summary_presentation() {
  local project="" lead="" db="" ledger="" decisions="" output=""
  project="$(jq -er .projectName "$RAYA_CANONICAL_MANIFEST")" || return 1
  lead="$(jq -er .leadId "$RAYA_CANONICAL_MANIFEST")" || return 1
  [[ "$project" == raya && "$lead" == raya ]] || return 1
  db="${TEAMLEAD_DB_PATH:-${FLYWHEEL_HOME:-${HOME}/.flywheel}/teamlead.db}"
  ledger="$RAYA_WORKSPACE/state/summary-merge-receipts.jsonl"
  decisions="$RAYA_WORKSPACE/state/summary-presentation-migration-decisions.jsonl"
  [[ -f "$RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL" \
    && ! -L "$RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL" \
    && -f "$db" && ! -L "$db" \
    && -f "$ledger" && ! -L "$ledger" ]] || return 1
  if [[ -e "$decisions" || -L "$decisions" ]]; then
    [[ -f "$decisions" && ! -L "$decisions" ]] || return 1
    output="$("$RAYA_STANDARD_NODE_BIN" "$RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL" \
      --db "$db" --workspace "$RAYA_WORKSPACE" --project "$project" --lead "$lead" \
      --ledger "$ledger" --decisions "$decisions")" || return 1
  else
    output="$("$RAYA_STANDARD_NODE_BIN" "$RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL" \
      --db "$db" --workspace "$RAYA_WORKSPACE" --project "$project" --lead "$lead" \
      --ledger "$ledger")" || return 1
  fi
  jq -e '.state == "complete" and (.boundarySeq | type == "number") and
    (.cursorSeq == .boundarySeq)' <<<"$output" >/dev/null 2>&1
}

raya_fail() {
  local detail="$1" rc="${2:-1}" body="" alert_class=raya-standard-deploy-failed
  body="$detail"
  # FLY-2758: say what the failure left running. The receipt stays `failed`
  # (a restored Lead runs the freshly materialized artifact, nothing was rolled
  # back); the alert body carries the carrier state, and an unloaded carrier
  # pages under its own class so daily dedup of routine failures cannot
  # swallow the outage.
  case "${RAYA_RESTORE_STATE:-}" in
    not_needed) body="$detail; standard Lead was never unloaded and is still live" ;;
    loaded_not_live)
      body="$detail; standard Lead is loaded in launchd but did not pass live verify (check Bridge health and the inbox pump); not treated as an outage" ;;
    restored)
      body="$detail; standard Lead restored and live — Raya remains conversational; the shuttle retries next window" ;;
    not_restored)
      alert_class=raya-standard-lead-offline
      body="$detail; standard Lead is NOT loaded in launchd — Raya is OFFLINE; run flywheel-lead.sh install --project raya --lead raya" ;;
  esac
  RAYA_DEPLOY_STATE=failed
  RAYA_DEPLOY_DETAIL="$detail"
  [[ -z "${RAYA_RESTORE_STATE:-}" ]] || raya_log "deploy failed; recovery state: $RAYA_RESTORE_STATE; detail: $detail"
  raya_write_standard_receipt failed "$detail" >/dev/null 2>&1 || true
  raya_alert severe "$alert_class" "Raya deploy failed" "$body"
  raya_lock_release
  return "$rc"
}

# Called only while holding the shared deploy lock. A healthy fleet restart
# changes the process and Flywheel build, but not the Raya activation transaction.
raya_rebind_flywheel() {
  local current="$1" checkpoint="" status="" health="" loaded="" pid="" start="" recorded="" stale=""
  [[ "$RAYA_LOCK_OWNED" == 1 ]] || return 1
  raya_is_sha40 "$current" || return 1
  checkpoint="$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" || return 1
  [[ "$checkpoint" == P5 || "$checkpoint" == P6 ]] || return 1
  status="$(dirname "$FLYWHEEL_DEPLOYED_SHA_FILE")/leads-restart-status.json"
  [[ -f "$status" && ! -L "$status" ]] || return 1
  jq -e --arg sha "$current" '
    .schemaVersion == 1 and .codeDeployedSha == $sha and
    .leadsRestartStatus == "healthy" and .failed == 0 and .skipped == 0 and .total == 17
  ' "$status" >/dev/null 2>&1 || return 1
  health="$(curl -q -fsS --max-time 5 "${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}/health")" || return 1
  jq -e --arg sha "$current" '.ok == true and .buildSha == $sha' <<<"$health" >/dev/null 2>&1 || return 1
  raya_standard_lead verify --stage live "$RAYA_CANONICAL_MANIFEST" >/dev/null 2>&1 || return 1
  loaded="$(launchctl print "gui/$(id -u)/$RAYA_STANDARD_LABEL" 2>/dev/null)" || return 1
  pid="$(printf '%s\n' "$loaded" | awk '$1 == "pid" && $2 == "=" {print $3}')"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  start="$(raya_process_start "$pid")" || return 1
  [[ -n "$start" ]] || return 1
  recorded="$(jq -er '.recordedAt | select(type == "string")' "$status")" || return 1
  "$RAYA_STANDARD_NODE_BIN" - "$RAYA_MIGRATION_MANIFEST" "$recorded" "$start" <<'NODE' || return 1
const fs = require("node:fs");
const [file, recorded, start] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const activation = Date.parse(manifest.activated_at);
const rebinds = manifest.flywheel_rebinds;
if (rebinds !== undefined && !Array.isArray(rebinds)) process.exit(1);
const bound = rebinds?.length ? Date.parse(rebinds[rebinds.length - 1].at) : activation;
const restart = Date.parse(recorded);
const processStart = Date.parse(start);
if (![activation, bound, restart, processStart].every(Number.isFinite) ||
    restart <= activation || restart <= bound || processStart <= bound || processStart >= restart) process.exit(1);
NODE
  [[ "$(raya_git rev-parse HEAD 2>/dev/null)" == "$(jq -r .raya_sha "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  [[ -z "$(raya_git status --porcelain)" ]] || return 1
  [[ "$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" == "$(jq -r .canonical_manifest_digest "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  raya_verify_materialized_artifact || return 1
  # Quarantine first: a crash here leaves the old ledger eligible for rebind.
  # The reverse order would leave a stale proof attached to a new SHA owner.
  if [[ -e "$RAYA_STANDARD_PROOF_FILE" || -L "$RAYA_STANDARD_PROOF_FILE" ]]; then
    raya_owner_file "$RAYA_STANDARD_PROOF_FILE" || return 1
    stale="$(dirname "$RAYA_STANDARD_PROOF_FILE")/proof.stale-$(raya_sha256 "$RAYA_STANDARD_PROOF_FILE").json"
    raya_atomic_replace "$RAYA_STANDARD_PROOF_FILE" "$stale" || return 1
  fi
  raya_manifest_transform "$checkpoint" P5 '
    .flywheel_rebinds += [{from:.flywheel_deployed_sha,to:$sha,at:$at,
      lead_pid:$pid,restart_recorded_at:$recorded}] |
    .flywheel_deployed_sha=$sha | .lead=null | .checks=null | .cutover=null
  ' --arg sha "$current" --arg at "$(raya_now_iso)" --argjson pid "$pid" --arg recorded "$recorded"
}

# Before activation there may be no installed Raya process. Keep the frozen
# Raya/registry/artifact bindings, prove the current Bridge and registered
# carrier, then resume the same checkpoint under the new Flywheel build.
raya_rebind_before_activation() {
  local current="$1" checkpoint="" root="" health="" registry="" summary=""
  [[ "$RAYA_LOCK_OWNED" == 1 ]] || return 1
  raya_is_sha40 "$current" || return 1
  raya_legacy_stop_authorized || return 1
  checkpoint="$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" || return 1
  [[ "$checkpoint" == P2 || "$checkpoint" == P3 || "$checkpoint" == P4b ]] || return 1
  jq -e '.mode != "standard-update" and
    (.checkpoint != "P2" or any(.legacy_owner[]?; .stop_started_at_ms != null)) and
    (.pre_activation_rebinds == null or (.pre_activation_rebinds | type == "array"))' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1 || return 1
  raya_validate_canonical_manifest || return 1
  RAYA_TARGET="$(jq -r .target_raya_sha "$RAYA_MIGRATION_MANIFEST")"
  [[ "$(raya_git symbolic-ref --short HEAD)" == main && -z "$(raya_git status --porcelain)" \
    && "$(raya_git rev-parse HEAD)" == "$RAYA_TARGET" \
    && "$(jq -r .raya_sha "$RAYA_MIGRATION_MANIFEST")" == "$RAYA_TARGET" \
    && "$(raya_sha256 "$RAYA_CANONICAL_MANIFEST")" == "$(jq -r .canonical_manifest_digest "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  root="$(dirname "$FLYWHEEL_DEPLOYED_SHA_FILE")"
  registry="$root/projects.json"
  summary="$root/state/summary-registry/migration-receipt.json"
  [[ -f "$registry" && ! -L "$registry" && -f "$summary" && ! -L "$summary" \
    && "$(raya_sha256 "$summary")" == "$(jq -r .summary_receipt_digest "$RAYA_MIGRATION_MANIFEST")" ]] || return 1
  raya_registry_identity_check "$registry" || return 1
  if [[ "$checkpoint" == P2 ]]; then
    raya_verify_candidate_artifact || return 1
  else
    raya_verify_materialized_artifact || return 1
  fi
  health="$(curl -q -fsS --max-time 5 "${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}/health")" || return 1
  jq -e --arg sha "$current" '.ok == true and .buildSha == $sha' <<<"$health" >/dev/null 2>&1 || return 1
  raya_standard_lead verify --stage registered "$RAYA_CANONICAL_MANIFEST" >/dev/null 2>&1 || return 1
  [[ "$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE")" == "$current" ]] || return 1
  raya_manifest_transform "$checkpoint" "$checkpoint" '
    .pre_activation_rebinds += [{from:.flywheel_deployed_sha,to:$sha,at:$at,checkpoint:.checkpoint}] |
    .flywheel_deployed_sha=$sha |
    if $identity != null then
      .registry_identity = $identity | .registry_digest = $registry_digest |
      .registry_identity_recorded_at = $at
    else . end
  ' --arg sha "$current" --arg at "$(raya_now_iso)" \
    --argjson identity "${RAYA_REGISTRY_IDENTITY_MIGRATE:-null}" \
    --arg registry_digest "$(raya_sha256 "$registry")"
}

updater_raya_pass() {
  local proof_rc=0 checkpoint="" current_flywheel=""
  unset RAYA_MIGRATION_ALLOW_LEGACY_STOP
  raya_configure_runtime_paths
  RAYA_DEPLOY_STATE=not_run
  RAYA_DEPLOY_DETAIL=""
  RAYA_DEPLOY_REASON=""
  RAYA_LOCK_OWNED=0
  RAYA_PREFLIGHT_RC=""
  RAYA_RESTORE_STATE=""
  if ! raya_host_capable; then
    RAYA_DEPLOY_STATE=not_configured
    RAYA_DEPLOY_DETAIL=canonical-standard-lead-absent
    return 1
  fi
  if ! raya_manifest_base_valid; then
    RAYA_DEPLOY_STATE=not_configured
    RAYA_DEPLOY_DETAIL=migration-ledger-absent
    return 1
  fi
  raya_lock_acquire || {
    RAYA_DEPLOY_STATE=locked
    RAYA_DEPLOY_DETAIL="lock-${RAYA_LOCK_FAILURE:-unknown}"
    return 1
  }
  checkpoint="$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")"
  current_flywheel="$(sed -n '1p' "$FLYWHEEL_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  if [[ "$current_flywheel" != "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" ]] \
    && jq -e '.mode != "standard-update" and
      (.checkpoint == "P3" or .checkpoint == "P4b" or
       (.checkpoint == "P2" and any(.legacy_owner[]?; .stop_started_at_ms != null)))' \
      "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
    RAYA_REBIND_REFUSAL=""
    if ! raya_rebind_before_activation "$current_flywheel"; then
      RAYA_DEPLOY_STATE=awaiting_rebind
      RAYA_DEPLOY_DETAIL=awaiting_pre_activation_rebind
      # The named reason (e.g. raya-registry-identity-drift:<paths>) travels in
      # the receipt and the shuttle log; the state/detail pair stays exact for
      # the observation classifier.
      RAYA_DEPLOY_REASON="$RAYA_REBIND_REFUSAL"
      raya_write_standard_receipt refused "${RAYA_DEPLOY_DETAIL}${RAYA_DEPLOY_REASON:+:$RAYA_DEPLOY_REASON}" >/dev/null 2>&1 || true
      raya_lock_release
      return 2
    fi
  fi
  if [[ ( "$checkpoint" == P5 || "$checkpoint" == P6 ) \
    && "$current_flywheel" != "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" ]]; then
    RAYA_DEPLOY_STATE=awaiting_proof
    RAYA_DEPLOY_DETAIL=awaiting_rebind
    RAYA_TARGET="$(jq -r .raya_sha "$RAYA_MIGRATION_MANIFEST")"
    if raya_rebind_flywheel "$current_flywheel"; then RAYA_DEPLOY_DETAIL=awaiting_rebind_proof; fi
    raya_write_standard_receipt refused "$RAYA_DEPLOY_DETAIL" >/dev/null 2>&1 || true
    raya_lock_release
    return 2
  fi
  if ! raya_prepare_source; then
    if [[ "$RAYA_DEPLOY_STATE" == prestop-failed ]]; then
      raya_log "$RAYA_DEPLOY_STATE $RAYA_DEPLOY_DETAIL"
      raya_lock_release
      return 2
    fi
    raya_fail source-prepare-failed 2
    return
  fi
  if ! raya_standard_cutover; then
    if jq -e '.checkpoint == "P3" and (.unresolved | length) > 0' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
      RAYA_DEPLOY_STATE=awaiting_reconciliation
      RAYA_DEPLOY_DETAIL=p3-unresolved-window
      raya_write_standard_receipt refused "$RAYA_DEPLOY_DETAIL" >/dev/null 2>&1 || true
      raya_lock_release
      return 2
    fi
    if [[ "$RAYA_DEPLOY_DETAIL" == awaiting_standard_lead_readiness \
      || "$RAYA_DEPLOY_DETAIL" == awaiting_standard_lead_pre_restart ]]; then
      RAYA_DEPLOY_STATE=awaiting_lead
      raya_write_standard_receipt refused "$RAYA_DEPLOY_DETAIL" >/dev/null 2>&1 || true
      raya_lock_release
      return 2
    fi
    raya_fail cutover-failed 3
    return
  fi
  raya_standard_collect_proof; proof_rc=$?
  if (( proof_rc == 2 )); then
    RAYA_DEPLOY_STATE=awaiting_proof
    RAYA_DEPLOY_DETAIL=p5-awaiting-real-p6-evidence
    if jq -e '(.flywheel_rebinds // [] | length) > 0' "$RAYA_MIGRATION_MANIFEST" >/dev/null 2>&1; then
      RAYA_DEPLOY_DETAIL=awaiting_rebind_proof
    fi
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
