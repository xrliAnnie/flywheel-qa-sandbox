#!/usr/bin/env bash
# FLY-2654: launchd-driven Flywheel updater with exactly two trigger sources:
#   1. local 00:00 / 12:00 schedule, deploying only when deployed-sha is behind;
#   2. founder-direct current-main or authenticated Lead closeout standing-authority
#      urgent tickets,
#      each validated and claimed once before one restart attempt.
#
# QueueDirectories watches only the urgent directory. There is no per-merge
# marker, acknowledgement, retry receipt, blocked queue, or in-process loop.
set -uo pipefail

FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

updater_standing_package_reject() {
  printf '[flywheel-updater] standing-package-verification-failed reason=%s\n' "$1" >&2
  return 78
}

updater_enter_active_package() {
  local state_root="${FLYWHEEL_STANDING_AUTHORITY_STATE_DIR:-${HOME}/.flywheel/state/standing-authority}"
  local pointer="${state_root}/active-package.json" root="" package_digest=""
  local manifest="" cli_rel="packages/teamlead/dist/bin/standing-authority-package-cli.js"
  local cli="" expected_cli_digest="" actual_cli_digest="" verified_digest="" entry=""
  local current_script="" current_root="" receipt="" ledger="" recorded_digest=""
  if [[ ! -e "$pointer" ]]; then
    [[ "${FLYWHEEL_STANDING_PACKAGE_ACTIVE:-0}" != 1 ]] && return 0
    updater_standing_package_reject active-package-pointer-missing
    return 78
  fi
  if [[ ! -f "$pointer" || -L "$pointer" ]]; then
    updater_standing_package_reject active-package-pointer-invalid
    return 78
  fi
  root="$(jq -er '.immutableRoot | select(type == "string" and startswith("/") and (contains("..") | not))' "$pointer" 2>/dev/null)" || {
    updater_standing_package_reject active-package-root-invalid
    return 78
  }
  package_digest="$(jq -er '.packageDigest | select(test("^[a-f0-9]{64}$"))' "$pointer" 2>/dev/null)" || {
    updater_standing_package_reject active-package-digest-invalid
    return 78
  }
  # FLY-2654 review R7 round 2: the pointer is a request, not authority. Read
  # the Bridge confirmation ledger back (outside the candidate package) and
  # require the row for the pointer's receipt to bind this package digest.
  receipt="$(jq -er '.activatedByReceiptId | select(type == "string" and test("^[a-f0-9]{64}$"))' "$pointer" 2>/dev/null)" || {
      updater_standing_package_reject active-package-receipt-invalid
      return 78
  }
  ledger="${TEAMLEAD_DB_PATH:-${HOME}/.flywheel/teamlead.db}"
  if [[ ! -f "$ledger" || -L "$ledger" ]]; then
      updater_standing_package_reject confirmation-ledger-unavailable
      return 78
  fi
  # Plain open on purpose: the StateStore is WAL and a clean Bridge close removes
  # the -wal/-shm sidecars; the sqlite3 CLI in read-only mode cannot recreate
  # them and fails with SQLITE_CANTOPEN (14) exactly when the Bridge is down.
  # The statement is a SELECT; same-uid sidecar creation is what better-sqlite3
  # readers do too.
  recorded_digest="$(sqlite3 "$ledger" "SELECT package_digest FROM standing_authority_confirmation WHERE receipt_id = '${receipt}' LIMIT 1;" 2>/dev/null)" || {
      updater_standing_package_reject confirmation-ledger-unavailable
      return 78
  }
  if [[ -z "$recorded_digest" ]]; then
      updater_standing_package_reject confirmation-record-missing
      return 78
  fi
  if [[ "$recorded_digest" != "$package_digest" ]]; then
      updater_standing_package_reject confirmation-record-mismatch
      return 78
  fi
  manifest="${root}/standing-authority-package.json"
  cli="${root}/${cli_rel}"
  if [[ ! -f "$manifest" || -L "$manifest" || ! -f "$cli" || -L "$cli" ]]; then
    updater_standing_package_reject active-package-files-invalid
    return 78
  fi
  if [[ "$(jq -r '.packageDigest // empty' "$manifest" 2>/dev/null)" != "$package_digest" ]]; then
    updater_standing_package_reject active-package-manifest-digest-mismatch
    return 78
  fi
  expected_cli_digest="$(jq -er --arg path "$cli_rel" '[.files[] | select(.path == $path) | .sha256] | select(length == 1) | .[0]' "$manifest" 2>/dev/null)" || {
    updater_standing_package_reject active-package-cli-digest-missing
    return 78
  }
  actual_cli_digest="$(shasum -a 256 "$cli" 2>/dev/null | awk 'NF == 2 {print $1}')"
  if [[ "$actual_cli_digest" != "$expected_cli_digest" ]]; then
    updater_standing_package_reject active-package-cli-digest-mismatch
    return 78
  fi
  verified_digest="$(node "$cli" verify --root "$root" --manifest "$manifest" 2>/dev/null | jq -er '.packageDigest')" || {
    updater_standing_package_reject active-package-verification-failed
    return 78
  }
  if [[ "$verified_digest" != "$package_digest" ]]; then
    updater_standing_package_reject active-package-verified-digest-mismatch
    return 78
  fi
  entry="$(node "$cli" resolve --root "$root" --manifest "$manifest" --path scripts/update-flywheel.sh 2>/dev/null)" || {
    updater_standing_package_reject active-package-entry-unresolved
    return 78
  }
  if [[ ! -f "$entry" || -L "$entry" ]]; then
    updater_standing_package_reject active-package-entry-invalid
    return 78
  fi
  if [[ "${FLYWHEEL_STANDING_PACKAGE_ACTIVE:-0}" == 1 ]]; then
    current_script="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")" || {
      updater_standing_package_reject active-package-script-unresolved
      return 78
    }
    current_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || {
      updater_standing_package_reject active-package-current-root-unresolved
      return 78
    }
    if [[ "${FLYWHEEL_STANDING_PACKAGE_ROOT:-}" != "$root" ]]; then
      updater_standing_package_reject active-package-root-mismatch
      return 78
    fi
    if [[ -L "${BASH_SOURCE[0]}" || ! -f "$current_script" || "$current_root" != "$root" || "$current_script" != "$entry" ]]; then
      updater_standing_package_reject active-package-script-mismatch
      return 78
    fi
    return 0
  fi
  exec env \
    FLYWHEEL_STANDING_PACKAGE_ACTIVE=1 \
    FLYWHEEL_STANDING_PACKAGE_ROOT="$root" \
    FLYWHEEL_TEAMLEAD_ROOT="$root/packages/teamlead" \
    FLYWHEEL_DIR="$FLYWHEEL_DIR" \
    bash "$entry" "$@"
}

if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" != 1 ]]; then
  updater_enter_active_package "$@" || exit $?
fi
UPDATER_RUNTIME_SCRIPT_DIR="${UPDATER_RUNTIME_SCRIPT_DIR:-${FLYWHEEL_DIR}/scripts}"
if [[ "${FLYWHEEL_STANDING_PACKAGE_ACTIVE:-0}" == 1 ]]; then
  UPDATER_RUNTIME_SCRIPT_DIR="$SCRIPT_DIR"
fi

# FLY-1062: packaged installs do not have the monorepo git-pull deployment path.
if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" != 1 ]] && [[ -f "$SCRIPT_DIR/../.flywheel-prebuilt" ]]; then
  echo "这台机器上的 Flywheel 是安装包形态,不能用这个老的更新方式。" >&2
  echo "要更新的话,运行你当初安装时用的那条命令,在后面加上 update 就可以了。" >&2
  exit 3
fi

ENV_FILE="${ENV_FILE:-${HOME}/.flywheel/.env}"
DEPLOYED_SHA_FILE="${DEPLOYED_SHA_FILE:-${HOME}/.flywheel/deployed-sha}"
_UPDATER_LAUNCH_HOME="$HOME"
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }

# These defaults used to arrive through the deleted queue library. Keep them
# explicit in the surviving consumer. Production must match the plist and the
# founder producer exactly; overrides belong only to sourced harnesses.
updater_configure_runtime_paths() {
  if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" == 1 ]]; then
    : "${FLYWHEEL_HOME:=${HOME}/.flywheel}"
		SELF_SHIP_URGENT_DIR="${SELF_SHIP_URGENT_DIR:-${FLYWHEEL_HOME}/self-ship-urgent.d}"
		SELF_SHIP_LOCK_DIR="${SELF_SHIP_LOCK_DIR:-${FLYWHEEL_HOME}/self-ship-updater.lock.d}"
		RESTART_REQUEST_INDEX="${RESTART_REQUEST_INDEX:-${FLYWHEEL_HOME}/restart-request-index.json}"
		RESTART_REQUEST_AUDIT_DIR="${RESTART_REQUEST_AUDIT_DIR:-${FLYWHEEL_HOME}/restart-request-audit}"
		RESTART_WAVE_ACTIVE_TICKET="${RESTART_WAVE_ACTIVE_TICKET:-${FLYWHEEL_HOME}/restart-wave-active-ticket.json}"
		return
  fi
  HOME="$_UPDATER_LAUNCH_HOME"
  FLYWHEEL_HOME="${HOME}/.flywheel"
	SELF_SHIP_URGENT_DIR="${FLYWHEEL_HOME}/self-ship-urgent.d"
	SELF_SHIP_LOCK_DIR="${FLYWHEEL_HOME}/self-ship-updater.lock.d"
	RESTART_REQUEST_INDEX="${FLYWHEEL_HOME}/restart-request-index.json"
	RESTART_REQUEST_AUDIT_DIR="${FLYWHEEL_HOME}/restart-request-audit"
	RESTART_WAVE_ACTIVE_TICKET="${FLYWHEEL_HOME}/restart-wave-active-ticket.json"
}
UPDATER_GIT="${UPDATER_GIT:-git}"
UPDATER_NODE="${UPDATER_NODE:-node}"
UPDATER_RESTART_REQUEST_CLI="${UPDATER_RESTART_REQUEST_CLI:-${FLYWHEEL_TEAMLEAD_ROOT:-${FLYWHEEL_DIR}/packages/teamlead}/dist/bin/restart-request.js}"
UPDATER_BOUNDED_RUN="${UPDATER_BOUNDED_RUN:-${SCRIPT_DIR}/lib/bounded-run.sh}"
# Deliberately shorter than restart-services' one-shot 120s fetch: this periodic
# updater gets three 20s noninteractive attempts before consuming urgent intent.
# Worktree mutation is local and unbounded by this network timeout.
UPDATER_FETCH_TIMEOUT_SECONDS="${UPDATER_FETCH_TIMEOUT_SECONDS:-20}"

# shellcheck source=lib/discord-pointer-guard.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/discord-pointer-guard.sh"
# shellcheck source=lib/conditional-restart.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/conditional-restart.sh"
LAUNCHD_CENSUS_SOURCED=1
# shellcheck source=launchd-census.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/launchd-census.sh"
# shellcheck source=lib/updater-raya-deploy.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/updater-raya-deploy.sh"
# shellcheck source=lib/shuttle-observation.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/shuttle-observation.sh"
# launchd-census is a shared entrypoint and sources .env for standalone use.
# Re-pin afterward so no direct path override can diverge this consumer from
# the plist and founder producer in production.
updater_configure_runtime_paths
raya_configure_runtime_paths

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [flywheel-updater] $*"; }
updater_now() { printf '%s\n' "${UPDATER_NOW:-$(date +%s)}"; }
updater_is_sha40() { [[ "${1:-}" =~ ^[0-9a-fA-F]{40}$ ]]; }
updater_utc_day() {
  if [[ -n "${UPDATER_UTC_DAY:-}" ]]; then printf '%s\n' "$UPDATER_UTC_DAY"; else date -u +%Y%m%d; fi
}
updater_urgent_signature() { printf 'urgent-%s-%s\n' "$1" "$2"; }
updater_scheduled_signature() { printf '%s-scheduled-%s\n' "$1" "$(updater_utc_day)"; }

# lead-alert.sh owns durable dedup. Callers choose bounded identities: urgent
# alerts are token-specific; unattended schedule alerts repeat once per UTC day.
severe_alert() { # $1=complete signature, $2=body
  local signature="$1" body="$2"
  local alert_args=(
    --project flywheel --lead updater
    --kind deploy_failed --severity severe
    --title "Flywheel deploy failed" --body "$body"
    --signature "$signature"
  )
  log "SEVERE: $body"
  if [[ -z "${FLYWHEEL_FOUNDER_USER_ID:-}" ]]; then
    log "WARNING: FLYWHEEL_FOUNDER_USER_ID not set — deploy_failed alert will NOT @-mention the founder" >&2
  else
    alert_args+=(--mention-user "$FLYWHEEL_FOUNDER_USER_ID")
  fi
  "${UPDATER_RUNTIME_SCRIPT_DIR}/lead-alert.sh" "${alert_args[@]}" 1>&2 || true
}

updater_alert_urgent() { # $1=class $2=basename $3=body
  severe_alert "$(updater_urgent_signature "$1" "$2")" "$3"
}
updater_alert_scheduled() { # $1=class $2=body
  severe_alert "$(updater_scheduled_signature "$1")" "$2"
}

updater_alert_observation() { # $1=class $2=body
  local class="$1" body="$2"
  local alert_args=(
    --project flywheel --lead updater
    --kind deploy_degraded --severity warning
    --title "Shuttle observation degraded" --body "$body"
    --signature "$(updater_scheduled_signature "$class")"
  )
  log "WARNING: Shuttle observation degraded: $body"
  "${UPDATER_RUNTIME_SCRIPT_DIR}/lead-alert.sh" "${alert_args[@]}" 1>&2 || true
}

raya_alert_dispatch() { # $1=severity $2=class $3=requested title $4=body
  local severity="$1" class="$2" body="$4" kind="" title="" level=""
  local alert_args=()
  case "$severity" in
    severe) kind=deploy_failed; title="Raya deploy failed"; level=SEVERE ;;
    warning) kind=deploy_degraded; title="Raya deploy degraded"; level=WARNING ;;
    *) return 2 ;;
  esac
  alert_args=(
    --project flywheel --lead updater
    --kind "$kind" --severity "$severity"
    --title "$title" --body "$body"
    --signature "$(updater_scheduled_signature "$class")"
  )
  log "$level: $title: $body"
  if [[ "$severity" == severe && -n "${FLYWHEEL_FOUNDER_USER_ID:-}" ]]; then
    alert_args+=(--mention-user "$FLYWHEEL_FOUNDER_USER_ID")
  fi
  "${UPDATER_RUNTIME_SCRIPT_DIR}/lead-alert.sh" "${alert_args[@]}" 1>&2 || true
}

UPDATER_OBSERVATION_STATE=not_started
UPDATER_OBSERVATION_FINALIZED=0
UPDATER_OBSERVATION_ERROR=0
UPDATER_AGGREGATE_RESULT=observation_incomplete
UPDATER_AGGREGATE_COUNTS='{}'
UPDATER_TARGET_SHA=""
UPDATER_BEHIND_COMMITS=""

updater_observation_record() { # project kind owner display outcome reason evidence log deployed target behind drift
  [[ "$UPDATER_OBSERVATION_STATE" == active ]] || return 0
  local receipt_dir="" receipt="" rc=0
  receipt_dir="$(shuttle_observation_state_root)/runtime"
  mkdir -p "$receipt_dir" 2>/dev/null || rc=$?
  if (( rc == 0 )); then
    chmod 700 "$receipt_dir" 2>/dev/null || rc=$?
  fi
  if (( rc == 0 )); then
    receipt="$(mktemp "$receipt_dir/record.XXXXXX")" || rc=$?
  fi
  if (( rc == 0 )); then
    shuttle_observation_record_values "$SHUTTLE_OBSERVATION_CYCLE_ID" "$@" "$receipt" || rc=$?
  fi
  [[ -z "$receipt" ]] || rm -f -- "$receipt" 2>/dev/null || true
  if (( rc != 0 )); then
    UPDATER_OBSERVATION_ERROR=1
    log "WARNING: shuttle observation result write failed (rc=$rc)"
    updater_alert_observation observation-write-failed \
      "Shuttle deployment observation could not record a unit result (rc=$rc). Deployment semantics were not changed; inspect flywheel-updater.log and the fixed page will remain unavailable." || true
  fi
  return 0
}

updater_observation_begin() {
  local runtime_dir="" candidates="" inventory="" receipt="" inventory_rc=0 rc=0
  runtime_dir="$(shuttle_observation_state_root)/runtime"
  mkdir -p "$runtime_dir" 2>/dev/null || rc=$?
  if (( rc == 0 )); then chmod 700 "$runtime_dir" 2>/dev/null || rc=$?; fi
  if (( rc == 0 )); then candidates="$(mktemp "$runtime_dir/candidates.XXXXXX")" || rc=$?; fi
  if (( rc == 0 )); then inventory="$(mktemp "$runtime_dir/inventory.XXXXXX")" || rc=$?; fi
  if (( rc == 0 )); then receipt="$(mktemp "$runtime_dir/begin.XXXXXX")" || rc=$?; fi
  if (( rc == 0 )) && declare -F lead_restart_collect_candidates >/dev/null 2>&1; then
    lead_restart_collect_candidates \
      "$FLYWHEEL_HOME/manifests" "$HOME/Library/LaunchAgents" \
      "$FLYWHEEL_HOME/projects.json" "$candidates" >/dev/null 2>&1 || inventory_rc=$?
  fi
  if (( rc == 0 )) && ! shuttle_observation_build_inventory \
      "$FLYWHEEL_HOME/projects.json" "$inventory" "$candidates"; then
    rc=$?
    (( rc == 0 )) && rc=2
  fi
  if (( rc == 0 )) && ! shuttle_observation_begin "$UPDATER_WAKE_KIND" "$inventory" "$receipt"; then
    rc=$?
    (( rc == 0 )) && rc=2
  fi
  [[ -z "$candidates" ]] || rm -f -- "$candidates" 2>/dev/null || true
  [[ -z "$inventory" ]] || rm -f -- "$inventory" 2>/dev/null || true
  [[ -z "$receipt" ]] || rm -f -- "$receipt" 2>/dev/null || true
  if (( rc != 0 )); then
    UPDATER_OBSERVATION_STATE=incomplete
    updater_alert_observation observation-init-failed \
      "Shuttle deployment observation initialization failed (rc=$rc). The deployment cycle will continue unchanged, but per-unit status is unavailable." || true
    return 0
  fi
  UPDATER_OBSERVATION_STATE=active
  UPDATER_OBSERVATION_FINALIZED=0
  UPDATER_OBSERVATION_ERROR=0
  SHUTTLE_OBSERVATION_ERROR_FILE="$(shuttle_observation_state_root)/runtime/error-${SHUTTLE_OBSERVATION_CYCLE_ID}"
  rm -f -- "$SHUTTLE_OBSERVATION_ERROR_FILE" 2>/dev/null || true
  export SHUTTLE_OBSERVATION_ERROR_FILE
  if (( inventory_rc == 0 )); then
    updater_observation_record flywheel inventory deployment-inventory \
      "Deployment inventory" up_to_date up-to-date inventory-snapshot \
      flywheel-updater.log#inventory "" "" "" unknown
  else
    updater_observation_record flywheel inventory deployment-inventory \
      "Deployment inventory" failed inventory-unavailable inventory-snapshot \
      flywheel-updater.log#inventory "" "" "" unknown
  fi
}

updater_observation_record_core() {
  local outcome=failed reason=unclassified-result deployed="" target="$UPDATER_TARGET_SHA"
  local behind="$UPDATER_BEHIND_COMMITS"
  if [[ -z "$target" ]]; then
    target="$(deployed_sha 2>/dev/null || true)"
    [[ "$target" =~ ^[0-9a-f]{40}$ ]] || target=""
  fi
  case "${UPDATER_CYCLE_RESULT:-unknown}" in
    scheduled_deployed|urgent_deployed)
      outcome=deployed; reason=deployed; deployed="$target" ;;
    scheduled_current)
      outcome=up_to_date; reason=up-to-date; deployed="$target"; behind=0 ;;
    fetch_failed) outcome=failed; reason=fetch-failed ;;
    scheduled_failed|urgent_failed) outcome=failed; reason=deploy-failed ;;
    *) outcome=skipped; reason=upstream-step-failed ;;
  esac
  updater_observation_record flywheel core_repo flywheel "Flywheel core" \
    "$outcome" "$reason" deployed-sha flywheel-updater.log#core \
    "$deployed" "$target" "$behind" unknown
}

updater_observation_fill_downstream() {
  [[ "$UPDATER_OBSERVATION_STATE" == active ]] || return 0
  local reason=upstream-step-failed receipt="" rc=0
  case "${UPDATER_CYCLE_RESULT:-unknown}" in
    scheduled_current) reason=not-in-deploy-wave ;;
    scheduled_deployed|urgent_deployed) return 0 ;;
  esac
  receipt="$(mktemp "$(shuttle_observation_state_root)/runtime/fill.XXXXXX")" || rc=$?
  if (( rc == 0 )); then
    shuttle_observation_fill "$SHUTTLE_OBSERVATION_CYCLE_ID" "$reason" project_repo lead >"$receipt" || rc=$?
  fi
  [[ -z "$receipt" ]] || rm -f -- "$receipt" 2>/dev/null || true
  if (( rc != 0 )); then
    UPDATER_OBSERVATION_ERROR=1
    log "WARNING: shuttle downstream result fill failed (rc=$rc)"
  fi
}

updater_observation_record_raya() {
  local state="${RAYA_DEPLOY_STATE:-not_run}" detail="${RAYA_DEPLOY_DETAIL:-}"
  local outcome=failed reason=unclassified-result deployed="" target="" behind=""
  case "$state" in
    deployed) outcome=deployed; reason=deployed ;;
    prestop-failed) outcome=failed; reason=prestop-validation-failed ;;
    not_configured)
      outcome=skipped
      case "$detail" in
        host-capability-absent|canonical-standard-lead-absent|migration-ledger-absent) reason="$detail" ;;
        *) reason=unclassified-result; outcome=failed ;;
      esac
      ;;
    locked) outcome=skipped; reason=unit-lock-held ;;
    awaiting_rebind|awaiting_proof|awaiting_reconciliation)
      outcome=skipped
      case "$detail" in
        awaiting_pre_activation_rebind) reason=awaiting-pre-activation-rebind ;;
        awaiting_rebind) reason=awaiting-rebind ;;
        awaiting_rebind_proof) reason=awaiting-rebind-proof ;;
        awaiting-pre-activation-rebind|awaiting-rebind|awaiting-rebind-proof|p5-awaiting-real-p6-evidence|p3-unresolved-window) reason="$detail" ;;
        *) reason=unclassified-result; outcome=failed ;;
      esac
      ;;
    not_run)
      if [[ "${UPDATER_WAKE_KIND:-unknown}" == urgent ]]; then
        outcome=skipped; reason=wake-out-of-scope
      else
        outcome=failed; reason=unclassified-result
      fi
      ;;
    *)
      case "$detail" in
        source-prepare-failed|cutover-failed|proof-invalid|finalize-failed)
          outcome=failed; reason="$detail" ;;
      esac
      ;;
  esac
  if [[ -f "${RAYA_DEPLOYED_SHA_FILE:-}" ]]; then
    deployed="$(sed -n '1p' "$RAYA_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  fi
  [[ "$deployed" =~ ^[0-9a-f]{40}$ ]] || deployed=""
  if [[ -d "${RAYA_CODE_DIR:-}" ]]; then
    target="$(git -C "$RAYA_CODE_DIR" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)"
  fi
  [[ "$target" =~ ^[0-9a-f]{40}$ ]] || target=""
  if [[ -n "$deployed" && -n "$target" && -d "${RAYA_CODE_DIR:-}" ]]; then
    behind="$(git -C "$RAYA_CODE_DIR" rev-list --count "${deployed}..${target}" 2>/dev/null || true)"
    [[ "$behind" =~ ^[0-9]+$ ]] || behind=""
  fi
  updater_observation_record raya external_repo raya-repo Raya \
    "$outcome" "$reason" "raya:${state}" flywheel-updater.log#raya \
    "$deployed" "$target" "$behind" "$([[ -n "$behind" ]] && printf first_observed_behind || printf unknown)"
}

updater_observation_finish() {
  [[ "$UPDATER_OBSERVATION_STATE" == active && "$UPDATER_OBSERVATION_FINALIZED" == 0 ]] || return 0
  local receipt="" rc=0
  receipt="$(mktemp "$(shuttle_observation_state_root)/runtime/finish.XXXXXX")" || rc=$?
  if (( rc == 0 )); then
    shuttle_observation_finish "$SHUTTLE_OBSERVATION_CYCLE_ID" \
      "${UPDATER_CYCLE_RESULT:-unknown}" >"$receipt" || rc=$?
  fi
  if [[ -n "${SHUTTLE_OBSERVATION_ERROR_FILE:-}" && -f "$SHUTTLE_OBSERVATION_ERROR_FILE" ]]; then
    UPDATER_OBSERVATION_ERROR=1
  fi
  if (( rc == 0 )); then
    UPDATER_AGGREGATE_RESULT="$(jq -er .result "$receipt")" || rc=$?
    UPDATER_AGGREGATE_COUNTS="$(jq -c .counts "$receipt")" || rc=$?
  fi
  [[ -z "$receipt" ]] || rm -f -- "$receipt" 2>/dev/null || true
  UPDATER_OBSERVATION_FINALIZED=1
  if (( rc != 0 || UPDATER_OBSERVATION_ERROR != 0 )); then
    UPDATER_OBSERVATION_STATE=incomplete
    UPDATER_AGGREGATE_RESULT=observation_incomplete
    UPDATER_AGGREGATE_COUNTS='{}'
    updater_alert_observation observation-finish-failed \
      "Shuttle deployment observation finalization failed (rc=$rc). Deployment semantics were not changed; the aggregate is observation_incomplete." || true
  fi
  return 0
}

updater_observation_dispatch() {
  [[ "$UPDATER_OBSERVATION_FINALIZED" == 1 ]] || return 0
  [[ "$UPDATER_OBSERVATION_STATE" == active || "$UPDATER_OBSERVATION_STATE" == incomplete ]] || return 0
  [[ -n "${SHUTTLE_OBSERVATION_CYCLE_ID:-}" ]] || return 0
  local receipt="" rc=0 project="" batch="" batch_id="" origin="" alert_result=""
  local state="" channel="" message="" binding="" alert_bin=""
  local copy_projects=()
  receipt="$(mktemp "$(shuttle_observation_state_root)/runtime/dispatch.XXXXXX")" || rc=$?
  if (( rc == 0 )) && [[ -f "$FLYWHEEL_HOME/projects.json" ]]; then
    while IFS= read -r project; do
      [[ -z "$project" ]] || copy_projects+=("$project")
    done < <(jq -r '.[] | select(.shuttleEngineeringLeadId != null) | .projectName' \
      "$FLYWHEEL_HOME/projects.json" 2>/dev/null || true)
  fi
  if (( rc == 0 )); then
    shuttle_observation_prepare_dispatch "$SHUTTLE_OBSERVATION_CYCLE_ID" \
      ${copy_projects[@]+"${copy_projects[@]}"} >"$receipt" || rc=$?
  fi
  if (( rc != 0 )); then
    [[ -z "$receipt" ]] || rm -f -- "$receipt" 2>/dev/null || true
    UPDATER_OBSERVATION_ERROR=1
    log "WARNING: shuttle notification dispatch preparation failed (rc=$rc)"
    updater_alert_observation observation-dispatch-failed \
      "Shuttle unit failures were recorded, but notification intents could not be prepared (rc=$rc). Inspect the fixed page and flywheel-updater.log." || true
    return 0
  fi
  alert_bin="${SHUTTLE_LEAD_ALERT_BIN:-$UPDATER_RUNTIME_SCRIPT_DIR/lead-alert.sh}"
  while IFS= read -r batch; do
    [[ -n "$batch" ]] || continue
    batch_id="$(printf '%s' "$batch" | jq -er .batchId 2>/dev/null || true)"
    origin="$(printf '%s' "$batch" | jq -er .originProject 2>/dev/null || true)"
    state=delivery_unknown; channel=""; message=""; binding=""; alert_result=""
    if [[ "$batch_id" =~ ^[0-9a-f]{64}$ && -n "$origin" && -x "$alert_bin" ]]; then
      alert_result="$("$alert_bin" --project "$origin" --lead updater \
        --kind shuttle_unit_unhealthy --severity warning \
        --shuttle-intent "$batch_id" --strict-delivery || true)"
      state="${alert_result%% *}"
      for field in $alert_result; do
        case "$field" in
          channel_id=*) channel="${field#channel_id=}" ;;
          message_id=*) message="${field#message_id=}" ;;
          binding_digest=*) binding="${field#binding_digest=}" ;;
        esac
      done
      case "$state" in
        sent)
          if [[ ! "$message" =~ ^[0-9]{17,20}$ || ! "$channel" =~ ^[0-9]{17,20}$ ]]; then
            state=delivery_unknown
          fi
          ;;
        queued_transient|delivery_unknown|dead_lettered|config_error) ;;
        *) state=delivery_unknown ;;
      esac
    else
      state=config_error
    fi
    if ! shuttle_observation_delivery "$batch_id" "$state" "$message" "$channel" "$binding" >/dev/null; then
      UPDATER_OBSERVATION_ERROR=1
      log "WARNING: shuttle delivery receipt write failed intent=${batch_id:0:12} state=$state"
    fi
  done < <(jq -c '.batches[]?' "$receipt")
  rm -f -- "$receipt" 2>/dev/null || true
  return 0
}

# A token has already left QueueDirectories when this helper is called. Expose
# it to signal cleanup until the primary alert returns so a catchable
# interruption cannot silently lose founder intent.
updater_alert_consumed_no_deploy() { # $1=class $2=basename $3=body
  local class="$1" base="$2" body="$3"
  local previous_claimed="$UPDATER_CLAIMED"
  local previous_completed="$UPDATER_COMPLETED"
  local previous_alerted="$UPDATER_ALERTED"
  local previous_basenames=()
  previous_basenames=(${UPDATER_CLAIMED_BASENAMES[@]+"${UPDATER_CLAIMED_BASENAMES[@]}"})
  UPDATER_CLAIMED=1
  UPDATER_COMPLETED=0
  UPDATER_ALERTED=0
  UPDATER_CLAIMED_BASENAMES=("$base")
  updater_alert_urgent "$class" "$base" "$body"
  UPDATER_ALERTED=1
  UPDATER_CLAIMED="$previous_claimed"
  UPDATER_COMPLETED="$previous_completed"
  UPDATER_ALERTED="$previous_alerted"
  UPDATER_CLAIMED_BASENAMES=(${previous_basenames[@]+"${previous_basenames[@]}"})
}

# Pull main and perform the existing full restart. The return classes remain
# useful for diagnosis even though FLY-1959 deliberately does not auto-retry.
default_deploy() {
  local remote_rc=0 expected_target=""
  if [[ -n "$("$UPDATER_GIT" -C "$FLYWHEEL_DIR" status --porcelain 2>/dev/null)" ]]; then
    log "main checkout dirty — refusing deploy (single-writer preflight)"
    return 3
  fi
  updater_fetch_origin
  remote_rc=$?
  if (( remote_rc != 0 )); then
    if (( remote_rc == 127 )); then
      log "bounded runner is unavailable at $UPDATER_BOUNDED_RUN"
      return 127
    fi
    log "git fetch failed (transient)"
    return 2
  fi
  expected_target="$(updater_remote_sha)" || return 3
	if [[ -n "$UPDATER_ACTIVE_TICKET" ]]; then
		if ! updater_token_is_founder_direct "$UPDATER_ACTIVE_TICKET" \
		  && [[ "$(updater_token_target "$UPDATER_ACTIVE_TICKET")" != "$expected_target" ]]; then
			log "urgent target changed after claim — refusing checkout mutation"
			return 82
		fi
		if ! updater_token_is_founder_direct "$UPDATER_ACTIVE_TICKET" \
		  && ! updater_export_conditional_restart_env "$UPDATER_ACTIVE_TICKET"; then
			log "conditional restart evidence could not be loaded before checkout mutation"
			return 82
		fi
	fi
  if discord_pointer_cutover_required; then
    log "origin/main selects discord@flywheel-plugins but the live checker is still legacy — refusing to pull before the guarded FLY-1676 cutover"
    return 3
  fi
  if ! updater_host_tmux_gate; then
    log "host tmux selection gate refused the frozen target — no fast-forward attempted"
    return 3
  fi
  if ! updater_auto_narrow_rollback_precheck; then
    log "auto narrow rollback precheck refused target — no merge or restart attempted"
    return 3
  fi
  updater_merge_remote "$expected_target"
  remote_rc=$?
  if (( remote_rc != 0 )); then
    log "local git merge --ff-only failed (untracked collision / non-ff)"
    return 2
  fi
  updater_restart_services
  remote_rc=$?
  if (( remote_rc == 0 )); then
    return 0
  fi
  if (( remote_rc == 82 )) && [[ -n "$UPDATER_ACTIVE_TICKET" ]]; then
    if conditional_restart_restore_premerge; then
      log "urgent final check failed before service stop; restored pre-merge checkout"
    else
      log "urgent final check failed and pre-merge checkout restore was refused"
      return 83
    fi
    return 82
  fi
  log "restart-services.sh failed (deterministic)"
  return 3
}
# Read-only compatibility check before replacing the running projector. Paths
# are pinned by updater_configure_runtime_paths; only sourced tests override them.
updater_auto_narrow_rollback_precheck() {
  local target_source=""
  target_source="$("$UPDATER_GIT" -C "$FLYWHEEL_DIR" show origin/main:packages/teamlead/src/StateStore.ts 2>/dev/null)" || target_source=""
  if [[ "$target_source" == *'autoNarrowEnvelope = parseAutoNarrowSourceEnvelope(payload)'* ]]; then
    return 0
  fi
  python3 - "$FLYWHEEL_HOME" <<'PY_NARROW'
import json
import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])

def open_readonly(path):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)

def has_table(db, name):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

try:
    pending = []
    for path in sorted((root / 'comm').glob('*/comm.db')):
        with open_readonly(path) as comm:
            if not has_table(comm, 'workflow_source_event'):
                continue
            for project, event_id, payload in comm.execute("SELECT project, source_event_id, payload FROM workflow_source_event WHERE kind='founder_approval'"):
                document = json.loads(payload)
                if event_id.startswith('auto-narrow:') or document.get('decision_source') == 'auto_narrow_gate':
                    pending.append((project, event_id))
    if pending:
        with open_readonly(root / 'teamlead.db') as state:
            if not has_table(state, 'workflow_source_receipt'):
                raise RuntimeError('unprojected_auto_narrow_source: receipt table missing')
            for project, event_id in pending:
                if not state.execute('SELECT 1 FROM workflow_source_receipt WHERE project=? AND source_event_id=?', (project, event_id)).fetchone():
                    raise RuntimeError('unprojected_auto_narrow_source: wait for projection before rollback')
except Exception as error:
    print('auto narrow rollback refused: ' + str(error), file=sys.stderr)
    sys.exit(1)
PY_NARROW
}

SELF_SHIP_DEPLOY_CMD="${SELF_SHIP_DEPLOY_CMD:-default_deploy}"

deployed_sha() { cat "$DEPLOYED_SHA_FILE" 2>/dev/null || echo ""; }
updater_git_bounded() {
  [[ -x "$UPDATER_BOUNDED_RUN" ]] || return 127
  GIT_TERMINAL_PROMPT=0 "$UPDATER_BOUNDED_RUN" "$UPDATER_FETCH_TIMEOUT_SECONDS" \
    "$UPDATER_GIT" -C "$FLYWHEEL_DIR" "$@" 2>/dev/null
}
updater_fetch_origin_once() {
  updater_git_bounded fetch origin main --quiet
}
updater_retry_sleep() { sleep 1; }
updater_fetch_origin() {
  local attempt=1 rc=0
  while (( attempt <= 3 )); do
    updater_fetch_origin_once
    rc=$?
    (( rc == 0 )) && return 0
    (( rc == 127 )) && return 127
    (( attempt == 3 )) && return 1
    log "origin/main fetch attempt $attempt/3 failed; retrying in-process"
    updater_retry_sleep
    attempt=$((attempt + 1))
  done
  return 1
}
updater_export_conditional_restart_env() {
	local ticket="$1" target="" from="" pre_merge="" trigger=""
	[[ -n "$ticket" ]] || return 1
	target="$(updater_token_target "$ticket")" || return 1
	from="$(updater_token_from_sha "$ticket")" || return 1
	pre_merge="$(updater_token_pre_merge_head "$ticket")" || return 1
	trigger="$(updater_token_trigger_sha "$ticket")" || return 1
	updater_is_sha40 "$target" && updater_is_sha40 "$from" \
		&& updater_is_sha40 "$pre_merge" && updater_is_sha40 "$trigger" || return 1
	FLYWHEEL_URGENT_RESTART_TICKET="$ticket"
	FLYWHEEL_URGENT_RESTART_INDEX="$RESTART_REQUEST_INDEX"
	FLYWHEEL_URGENT_RESTART_WAVE_ID="$UPDATER_ACTIVE_WAVE_ID"
	FLYWHEEL_URGENT_RESTART_TARGET_SHA="$target"
	FLYWHEEL_URGENT_RESTART_FROM_SHA="$from"
	FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD="$pre_merge"
	FLYWHEEL_URGENT_RESTART_TRIGGER_SHA="$trigger"
	FLYWHEEL_URGENT_RESTART_NODE="$UPDATER_NODE"
	FLYWHEEL_URGENT_RESTART_CLI="$UPDATER_RESTART_REQUEST_CLI"
	export FLYWHEEL_URGENT_RESTART_TICKET FLYWHEEL_URGENT_RESTART_INDEX \
		FLYWHEEL_URGENT_RESTART_WAVE_ID FLYWHEEL_URGENT_RESTART_TARGET_SHA \
		FLYWHEEL_URGENT_RESTART_FROM_SHA FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD \
		FLYWHEEL_URGENT_RESTART_TRIGGER_SHA FLYWHEEL_URGENT_RESTART_NODE \
		FLYWHEEL_URGENT_RESTART_CLI
}
updater_restart_services() {
	local ticket="${UPDATER_ACTIVE_TICKET:-}"
  if [[ -z "$ticket" ]] || updater_token_is_founder_direct "$ticket"; then
    FLYWHEEL_RESTART_FOREGROUND=1 "${SCRIPT_DIR}/restart-services.sh" --reason updater
		return $?
	fi
	updater_export_conditional_restart_env "$ticket" || return 82
	FLYWHEEL_RESTART_FOREGROUND=1 \
		"${SCRIPT_DIR}/restart-services.sh" --reason updater
}
updater_codex_home_reconcile() {
  "$UPDATER_NODE" "${SCRIPT_DIR}/codex-home-reconcile-cycle.mjs" --source updater
}
updater_remote_sha() { git -C "$FLYWHEEL_DIR" rev-parse origin/main 2>/dev/null; }
updater_host_tmux_gate() {
  local target="" gate_bin="${FLYWHEEL_HOME}/bin/host-tmux-selection-gate.sh" rc=0
  target="$(updater_remote_sha)" || return 2
  updater_is_sha40 "$target" || return 2
  if [[ ! -x "$gate_bin" ]]; then
    gate_bin="${UPDATER_RUNTIME_SCRIPT_DIR}/host-tmux-selection-gate.sh"
  fi
  [[ -f "$gate_bin" && ! -L "$gate_bin" && -x "$gate_bin" ]] || return 127
  (
    unset FLYWHEEL_HOST_TMUX_GATE_TEST_MODE \
      FLYWHEEL_HOST_TMUX_POST_S1_PATH \
      FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH \
      FLYWHEEL_HOST_TMUX_FILE_BIN \
      FLYWHEEL_HOST_TMUX_HOST_ID \
      FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH \
      FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS \
      FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY \
      FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR \
      FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR
    FLYWHEEL_STATE_DIR="$FLYWHEEL_HOME" \
    FLYWHEEL_HOST_TMUX_TARGET_SHA="$target" \
    FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="updater-fast-forward:$target" \
    FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/update-flywheel.sh:before-ff" \
      "$gate_bin" gate updater || rc=$?
    if (( rc == 0 )); then
      FLYWHEEL_STATE_DIR="$FLYWHEEL_HOME" \
      FLYWHEEL_HOST_TMUX_TARGET_SHA="$target" \
      FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="updater-fast-forward:$target" \
      FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/update-flywheel.sh:before-ff" \
        "$gate_bin" verify updater || rc=$?
    fi
    exit "$rc"
  )
}
updater_merge_remote() {
  local target="${1:-}"
  [[ -n "$target" ]] || target="$(updater_remote_sha)" || return 2
  updater_is_sha40 "$target" || return 2
  [[ "$target" == "$(updater_remote_sha)" ]] || return 2
  GIT_TERMINAL_PROMPT=0 "$UPDATER_GIT" -C "$FLYWHEEL_DIR" \
    merge --ff-only "$target" --quiet
}
updater_converge_bin() { bash "${SCRIPT_DIR}/converge-flywheel-bin.sh" >/dev/null 2>&1; }

# FLY-2238: the existing twice-daily singleton is the only model-family watch.
# The compiled CLI owns bounded probing, atomic authority mutation, verification,
# and success notification. Every outcome is advisory to the deploy shuttle.
updater_sync_fable_model() {
  local cli="${FLYWHEEL_FABLE_MODEL_SYNC_CLI:-${FLYWHEEL_TEAMLEAD_ROOT:-${FLYWHEEL_DIR}/packages/teamlead}/dist/account-heal/fable-model-sync-cli.js}"
  local alert_bin="${FLYWHEEL_LEAD_ALERT_BIN:-${UPDATER_RUNTIME_SCRIPT_DIR}/lead-alert.sh}"
  [[ -f "$cli" && ! -L "$cli" ]] || return 127
  "$UPDATER_NODE" "$cli" \
    --authority "${FLYWHEEL_HOME}/models.json" \
    --alert-bin "$alert_bin"
}

# FLY-2775: the Opus line follows its latest release. Same singleton and
# advisory contract as the Fable sync; discovery asks the local claude CLI what
# `opus` / `opus[1m]` launch. The managed flag opus_model_sync_disabled is the
# kill switch, read by the CLI from the flag store; version-change alerts are
# still derived from models.json while it is on. FLYWHEEL_CLAUDE_BIN overrides the probed binary.
updater_sync_opus_model() {
  # Same verified package roots as the Fable sync — never the mutable checkout.
  local cli="${FLYWHEEL_OPUS_MODEL_SYNC_CLI:-${FLYWHEEL_TEAMLEAD_ROOT:-${FLYWHEEL_DIR}/packages/teamlead}/dist/account-heal/opus-model-sync-cli.js}"
  local alert_bin="${FLYWHEEL_LEAD_ALERT_BIN:-${UPDATER_RUNTIME_SCRIPT_DIR}/lead-alert.sh}"
  [[ -f "$cli" && ! -L "$cli" ]] || return 127
  "$UPDATER_NODE" "$cli" \
    --authority "${FLYWHEEL_HOME}/models.json" \
    --db "${TEAMLEAD_DB_PATH:-${FLYWHEEL_HOME}/teamlead.db}" \
    --alert-bin "$alert_bin"
}

# FLY-1814: keep the updater's existing daemon convergence/census floor.
updater_launchd_pass() {
  if [[ -d "${HOME}/.flywheel/restart.lock.d" ]]; then
    log "launchd convergence/census skipped: restart transaction is active"
    return 0
  fi

  converge_nonlead_daemons || true
  log "launchd convergence: ${NONLEAD_DAEMON_CONVERGE_STATE:-unverifiable} ${NONLEAD_DAEMON_CONVERGE_DETAIL:-unavailable}"
  census_launchd_fleet || true
  log "launchd census: ${LAUNCHD_CENSUS_STATE:-unverifiable} ${LAUNCHD_CENSUS_SUMMARY:-unavailable}"
  if [[ "${LAUNCHD_CENSUS_DETAIL:-healthy}" != healthy ]]; then
    log "launchd census detail: ${LAUNCHD_CENSUS_DETAIL}"
  fi
  local detail="${LAUNCHD_CENSUS_DETAIL:-unavailable}"
  local key="${LAUNCHD_CENSUS_ALERT_KEY:-}"
  if [[ "${NONLEAD_DAEMON_CONVERGE_STATE:-unverifiable}" != healthy ]]; then
    detail="${detail}${detail:+; }convergence=${NONLEAD_DAEMON_CONVERGE_STATE:-unverifiable}: ${NONLEAD_DAEMON_CONVERGE_DETAIL:-unavailable}"
    [[ -n "$key" ]] || key="convergence:${NONLEAD_DAEMON_CONVERGE_STATE:-unverifiable}"
  fi
  [[ -n "$key" ]] || key="census-state:${LAUNCHD_CENSUS_STATE:-unverifiable}"
  if [[ "${LAUNCHD_CENSUS_ANOMALY:-1}" == 1 \
    || "${NONLEAD_DAEMON_CONVERGE_STATE:-unverifiable}" != healthy ]]; then
    if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" == 1 ]]; then
      log "sourced test path: launchd census alert suppressed"
    else
      census_alert "${LAUNCHD_CENSUS_SUMMARY:-unavailable}" "$detail" "$key"
    fi
  fi
}

updater_init_dirs() {
  mkdir -p "$FLYWHEEL_HOME" "$SELF_SHIP_URGENT_DIR" || return 1
  chmod 700 "$FLYWHEEL_HOME" "$SELF_SHIP_URGENT_DIR" || return 1
}

updater_pid_alive() { kill -0 "$1" 2>/dev/null; }
updater_pid_command() { ps -o command= -p "$1" 2>/dev/null; }

_updater_lock_write_owner() {
  printf '%s\n' "$$" > "${SELF_SHIP_LOCK_DIR}/pid" || return 1
  printf '%s\n' "${1:-update-flywheel}" > "${SELF_SHIP_LOCK_DIR}/ident" || return 1
  updater_now > "${SELF_SHIP_LOCK_DIR}/created" || return 1
}

_updater_lock_clear() {
  rm -f "${SELF_SHIP_LOCK_DIR}/pid" "${SELF_SHIP_LOCK_DIR}/ident" \
    "${SELF_SHIP_LOCK_DIR}/created" 2>/dev/null || true
  rmdir "$SELF_SHIP_LOCK_DIR" 2>/dev/null
}

updater_lock_acquire() {
  local ident="${1:-update-flywheel}" owner="" cmd="" stale=0
  if mkdir "$SELF_SHIP_LOCK_DIR" 2>/dev/null; then
    _updater_lock_write_owner "$ident"
    return $?
  fi
  owner="$(cat "${SELF_SHIP_LOCK_DIR}/pid" 2>/dev/null || echo "")"
  if [[ -z "$owner" ]] || ! updater_pid_alive "$owner"; then
    stale=1
  else
    cmd="$(updater_pid_command "$owner" 2>/dev/null || echo "")"
    # A live uninspectable owner is never evicted. Only an inspectable identity
    # mismatch proves PID reuse; a matching command is the active updater.
    if [[ -n "$cmd" && "$cmd" != *"$ident"* ]]; then stale=1; fi
  fi
  if (( stale == 1 )); then
    log "reclaiming stale updater lock (owner='${owner}')"
    _updater_lock_clear || return 75
    if mkdir "$SELF_SHIP_LOCK_DIR" 2>/dev/null; then
      _updater_lock_write_owner "$ident"
      return $?
    fi
  fi
  return 75
}

updater_lock_release() {
  local owner=""
  owner="$(cat "${SELF_SHIP_LOCK_DIR}/pid" 2>/dev/null || echo "")"
  [[ "$owner" == "$$" ]] && _updater_lock_clear || true
}

updater_token_is_founder_direct() {
	jq -e '
		.schemaVersion == 1 and
		.kind == "founder-urgent-restart" and
		(.targetSha | type == "string" and test("^[0-9a-f]{40}$")) and
		(.createdAt | type == "number") and
		(keys | sort) == ["createdAt","kind","schemaVersion","targetSha"]
	' "$1" >/dev/null 2>&1
}

updater_token_is_v2() {
	jq -e '.schemaVersion == 2 and .kind == "authorized-urgent-restart"' "$1" >/dev/null 2>&1
}

updater_token_is_closeout_v3() {
	jq -e '.schemaVersion == 3 and .kind == "lead-closeout-restart"' "$1" >/dev/null 2>&1
}

updater_token_shape_valid() {
	local path="$1" base="" target=""
	base="$(basename "$path")"
	[[ "$base" =~ ^[A-Za-z0-9._-]+\.urgent\.json$ ]] || return 1
	if updater_token_is_founder_direct "$path"; then
		target="$(jq -r .targetSha "$path" 2>/dev/null)"
		updater_is_sha40 "$target"
		return $?
	fi
	jq -e '
		((
			.schemaVersion == 2 and
			.kind == "authorized-urgent-restart" and
			.authority.kind == "founder-per-instance" and
			(.requestId | type == "string" and test("^[0-9a-fA-F-]{36}$")) and
			(.trigger.evidence.mergedCommit | type == "string" and test("^[0-9a-f]{40}$")) and
			(keys | sort) == ["announcement","authority","createdAt","fromDeployedSha","kind","preMergeHead","requestDigest","requestId","requestedBy","schemaVersion","targetSha","trigger","validatedAt"]
		) or (
			.schemaVersion == 3 and
			.kind == "lead-closeout-restart" and
			.authority.kind == "standing-carve-out" and
			.authority.entryId == "lead-closeout-restart/v1" and
			(.decisionId | type == "string" and test("^[0-9a-fA-F-]{36}$")) and
			(.waveId | type == "string" and length > 0 and length <= 200) and
			(.revision | type == "number" and floor == . and . >= 1) and
			(keys | sort) == ["announcement","authority","createdAt","decisionId","executionPackage","fromDeployedSha","intent","kind","preMergeHead","readiness","requestDigest","requestedBy","revision","schemaVersion","scopeSnapshot","targetSha","validatedAt","waveId"]
		)) and
		(.targetSha | type == "string" and test("^[0-9a-f]{40}$")) and
		(.fromDeployedSha | type == "string" and test("^[0-9a-f]{40}$")) and
		(.preMergeHead | type == "string" and test("^[0-9a-f]{40}$")) and
		(.requestDigest | type == "string" and test("^[0-9a-f]{64}$"))
	' "$path" >/dev/null 2>&1 || return 1
  target="$(jq -r .targetSha "$path" 2>/dev/null)"
  updater_is_sha40 "$target"
}

updater_token_target() { jq -r .targetSha "$1" 2>/dev/null; }
updater_token_request_id() { jq -r 'if .schemaVersion == 3 then .decisionId else .requestId end' "$1" 2>/dev/null; }
updater_token_from_sha() { jq -r .fromDeployedSha "$1" 2>/dev/null; }
updater_token_pre_merge_head() { jq -r .preMergeHead "$1" 2>/dev/null; }
updater_token_trigger_sha() { jq -r 'if .schemaVersion == 3 then .targetSha else .trigger.evidence.mergedCommit end' "$1" 2>/dev/null; }
updater_token_founder_ref() {
	jq -r 'if .schemaVersion == 3 then "channel=" + .intent.messageRef.channelId + " message=" + .intent.messageRef.messageId else "channel=" + .authority.messageRef.channelId + " message=" + .authority.messageRef.messageId end' "$1" 2>/dev/null
}
updater_token_lead_ref() {
	jq -r '"project=" + .requestedBy.projectName + " lead=" + .requestedBy.leadId + " instanceDigest=" + .requestedBy.instanceId' "$1" 2>/dev/null
}

updater_token_wave_id() {
	if updater_token_is_closeout_v3 "$1"; then
		jq -er '.waveId | select(type == "string" and length > 0)' "$1" 2>/dev/null
	else
		updater_v2_started_wave_id "$1"
	fi
}

# Prints valid, invalid, or indeterminate after a successful origin/main fetch.
updater_token_target_state() {
	local path="$1" target="" remote="" rc=0
	target="$(updater_token_target "$path")" || { printf 'indeterminate\n'; return; }
	remote="$(updater_remote_sha)" || { printf 'indeterminate\n'; return; }
	if ! git -C "$FLYWHEEL_DIR" cat-file -e "${target}^{commit}" 2>/dev/null; then
		printf 'invalid\n'
		return
	fi
	if updater_token_is_founder_direct "$path"; then
		git -C "$FLYWHEEL_DIR" merge-base --is-ancestor "$target" "$remote" 2>/dev/null
		rc=$?
		case "$rc" in
			0) printf 'valid\n' ;;
			1) printf 'invalid\n' ;;
			*) printf 'indeterminate\n' ;;
		esac
		return
	fi
	if [[ "$target" == "$remote" ]]; then printf 'valid\n'; else printf 'invalid\n'; fi
}

updater_verify_restart_ticket() {
	local path="$1" target="" from="" pre_merge="" trigger="" deployed="" head="" intent_state=""
	[[ -f "$UPDATER_RESTART_REQUEST_CLI" && ! -L "$UPDATER_RESTART_REQUEST_CLI" ]] || return 127
	# The durable intent state is checked before Discord/GitHub revalidation. A
	# deterministic revoked state therefore stops here without any natural-
	# language scan or remote-message dependency.
	intent_state="$("$UPDATER_NODE" "$UPDATER_RESTART_REQUEST_CLI" intent-state \
		--ticket "$path" --index "$RESTART_REQUEST_INDEX" 2>/dev/null)" || return 1
	if updater_token_is_v2 "$path"; then
		[[ "$intent_state" == started ]] || return 1
	else
		[[ "$intent_state" == prepared ]] || return 1
	fi
	target="$(updater_token_target "$path")" || return 1
	from="$(updater_token_from_sha "$path")" || return 1
	pre_merge="$(updater_token_pre_merge_head "$path")" || return 1
	trigger="$(updater_token_trigger_sha "$path")" || return 1
	deployed="$(deployed_sha)"
	head="$($UPDATER_GIT -C "$FLYWHEEL_DIR" rev-parse HEAD 2>/dev/null)" || return 1
	[[ "$target" == "$(updater_remote_sha)" && "$from" == "$deployed" && "$pre_merge" == "$head" ]] || return 1
	$UPDATER_GIT -C "$FLYWHEEL_DIR" merge-base --is-ancestor "$trigger" "$target" 2>/dev/null || return 1
	local verify_args=(verify \
		--ticket "$path" --home "$HOME" \
		--deployed-sha "$deployed" --remote-sha "$target" \
		--pre-merge-head "$pre_merge" --contains-trigger)
	if updater_token_is_v2 "$path"; then
		verify_args+=(--allow-started-v2-recovery --index "$RESTART_REQUEST_INDEX")
	fi
	"$UPDATER_NODE" "$UPDATER_RESTART_REQUEST_CLI" "${verify_args[@]}" >/dev/null
}

updater_v2_started_wave_id() {
	local path="$1" request_id="" digest=""
	request_id="$(jq -er .requestId "$path" 2>/dev/null)" || return 1
	digest="$(jq -er .requestDigest "$path" 2>/dev/null)" || return 1
	jq -er --arg request_id "$request_id" --arg digest "$digest" '
		[.intents[] | select(.requestId == $request_id and .requestDigest == $digest and .state == "started") | .waveId] |
		select(length == 1) | .[0] | select(type == "string" and length > 0)
	' "$RESTART_REQUEST_INDEX" 2>/dev/null
}

updater_retire_unstarted_v2() {
	local ticket="$1" base="$2" dir="" fingerprint="" preserved="" receipt="" tmp=""
	dir="${RESTART_REQUEST_AUDIT_DIR}/retired-conditional-authority"
	mkdir -p "$dir" || return 1
	[[ ! -L "$dir" ]] || return 1
	chmod 700 "$dir" || return 1
	fingerprint="$(shasum -a 256 "$ticket" | awk '{print $1}')" || return 1
	preserved="${dir}/${fingerprint}.ticket.json"
	receipt="${dir}/${fingerprint}.receipt.json"
	if [[ -e "$preserved" ]]; then
		[[ -f "$preserved" && ! -L "$preserved" ]] && cmp -s "$ticket" "$preserved" || return 1
	else
		cp "$ticket" "$preserved" && chmod 600 "$preserved" || return 1
	fi
	if [[ ! -e "$receipt" ]]; then
		tmp="$(mktemp "${dir}/.retired.XXXXXX")" || return 1
		jq -n --arg occurredAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			--arg ticket "$preserved" --arg queueEntry "$base" --arg fingerprint "$fingerprint" \
			'{schemaVersion:1,event:"restart-request-retired",result:"retired-conditional-authority",occurredAt:$occurredAt,queueEntry:$queueEntry,ticketFingerprint:$fingerprint,preservedTicket:$ticket,zeroDeploySideEffects:true}' > "$tmp" \
			&& chmod 600 "$tmp" && mv "$tmp" "$receipt" || { rm -f "$tmp"; return 1; }
	fi
	printf '%s\n' "$receipt"
}

updater_transition_restart_intent() {
	local path="$1" state="$2" wave_id="${3:-}" zero_side_effects="${4:-0}"
	local args=(transition --ticket "$path" --index "$RESTART_REQUEST_INDEX" --state "$state" --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
	[[ -z "$wave_id" ]] || args+=(--wave-id "$wave_id")
	[[ "$zero_side_effects" == 1 ]] && args+=(--zero-side-effects)
	[[ -f "$UPDATER_RESTART_REQUEST_CLI" && ! -L "$UPDATER_RESTART_REQUEST_CLI" ]] || return 127
	"$UPDATER_NODE" "$UPDATER_RESTART_REQUEST_CLI" "${args[@]}" >/dev/null
}

updater_mark_consumed_no_deploy_if_v3() {
	local path="$1" wave_id=""
	updater_token_is_closeout_v3 "$path" || return 0
	wave_id="$(updater_token_wave_id "$path")" || return 1
	updater_transition_restart_intent "$path" consumed-no-deploy "$wave_id" 1
}

updater_claim_token() { # $1=watched path $2=claim directory
  local path="$1" claim_dir="$2" base=""
  base="$(basename "$path")"
  mv "$path" "${claim_dir}/${base}"
}

updater_clear_wave_marker() {
	local ticket="$1"
	if [[ -f "$RESTART_WAVE_ACTIVE_TICKET" && ! -L "$RESTART_WAVE_ACTIVE_TICKET" ]] \
		&& cmp -s "$ticket" "$RESTART_WAVE_ACTIVE_TICKET"; then
		rm -f "$RESTART_WAVE_ACTIVE_TICKET"
	fi
}

updater_audit_wave_duplicate() {
	local duplicate="$1" primary="$2" dir="" tmp="" final=""
	dir="${RESTART_REQUEST_AUDIT_DIR}/restart-wave-duplicates"
	mkdir -p "$dir" || return 1
	[[ ! -L "$dir" ]] || return 1
	chmod 700 "$dir" || return 1
	tmp="$(mktemp "${dir}/.coalesced.XXXXXX")" || return 1
	if ! jq -n \
			--arg occurredAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			--arg duplicate "$(basename "$duplicate")" \
			--arg primary "$(basename "$primary")" \
			--arg duplicateTarget "$(updater_token_target "$duplicate")" \
			--arg primaryTarget "$(updater_token_target "$primary")" \
			'{schemaVersion:1,event:"restart-wave-duplicate",result:"coalesced-into-active-wave",occurredAt:$occurredAt,duplicate:{ticket:$duplicate,targetSha:$duplicateTarget},active:{ticket:$primary,targetSha:$primaryTarget}}' \
			> "$tmp"; then
		rm -f "$tmp"
		return 1
	fi
	chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
	final="${dir}/coalesced.$(date +%s).$$.${RANDOM}.json"
	mv "$tmp" "$final"
}

updater_coalesce_late_wave_tickets() {
	local primary="$1" candidate="" base="" claimed=""
	for candidate in "$SELF_SHIP_URGENT_DIR"/*.urgent.json; do
		[[ -f "$candidate" && ! -L "$candidate" ]] || continue
		# Invalid entries cannot authorize a restart and remain for the ordinary
		# invalid-entry consumer. Every valid entry created inside this active
		# lifecycle is absorbed before the lifecycle marker is released.
		updater_token_shape_valid "$candidate" || continue
		base="$(basename "$candidate")"
		claimed="${UPDATER_CLAIM_DIR}/late.$(date +%s).${RANDOM}.${base}"
		mv "$candidate" "$claimed" || return 1
		if updater_token_is_v2 "$claimed"; then
			local v2_state=""
			v2_state="$("$UPDATER_NODE" "$UPDATER_RESTART_REQUEST_CLI" intent-state \
				--ticket "$claimed" --index "$RESTART_REQUEST_INDEX" 2>/dev/null)" || v2_state=""
			if [[ "$v2_state" != started ]]; then
				updater_retire_unstarted_v2 "$claimed" "$base" >/dev/null || return 1
				updater_clear_wave_marker "$claimed" || true
				log "urgent restart: retired late unstarted v2 ticket $base"
				continue
			fi
		fi
		updater_mark_consumed_no_deploy_if_v3 "$claimed" || return 1
		updater_clear_wave_marker "$claimed" || true
		updater_audit_wave_duplicate "$claimed" "$primary" || return 1
		log "urgent restart: coalesced in-flight duplicate ticket $base into $(basename "$primary")"
	done
}

UPDATER_CLAIM_DIR=""
UPDATER_CLAIMED=0
UPDATER_COMPLETED=0
UPDATER_ALERTED=0
UPDATER_CLEANUP_DONE=0
UPDATER_CLAIMED_BASENAMES=()
UPDATER_WAKE_KIND=unknown
UPDATER_CYCLE_RESULT=unknown
UPDATER_ACTIVE_TICKET=""
UPDATER_ACTIVE_WAVE_ID=""
UPDATER_INTENT_STARTED=0

updater_cleanup() {
  (( UPDATER_CLEANUP_DONE == 0 )) || return 0
  UPDATER_CLEANUP_DONE=1
	if (( UPDATER_CLAIMED == 1 && UPDATER_COMPLETED == 0 && UPDATER_ALERTED == 0 )); then
		if (( UPDATER_INTENT_STARTED == 1 )) && [[ -f "$UPDATER_ACTIVE_TICKET" ]]; then
			updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" unknown "$UPDATER_ACTIVE_WAVE_ID" || true
		fi
    local base
    for base in ${UPDATER_CLAIMED_BASENAMES[@]+"${UPDATER_CLAIMED_BASENAMES[@]}"}; do
      updater_alert_urgent interrupted "$base" \
        "Founder urgent restart token $base was claimed but this updater invocation ended before deploy completion. Re-submit only after checking updater logs."
    done
	fi
	if [[ -n "$UPDATER_ACTIVE_TICKET" && -f "$UPDATER_ACTIVE_TICKET" ]]; then
		updater_clear_wave_marker "$UPDATER_ACTIVE_TICKET" || true
	fi
  case "$UPDATER_CLAIM_DIR" in
    "${FLYWHEEL_HOME}"/.urgent-claim.*)
      rm -rf -- "$UPDATER_CLAIM_DIR" 2>/dev/null || true
      ;;
  esac
  raya_lock_release || true
  updater_observation_finish || true
  updater_lock_release
}

updater_signal_cleanup() {
  updater_cleanup
  exit 130
}

updater_snapshot_tokens() {
  UPDATER_SNAPSHOT=()
  local had_nullglob=0 had_dotglob=0
  shopt -q nullglob && had_nullglob=1
  shopt -q dotglob && had_dotglob=1
  shopt -s nullglob dotglob
  UPDATER_SNAPSHOT=("${SELF_SHIP_URGENT_DIR}"/*)
  (( had_nullglob == 1 )) || shopt -u nullglob
  (( had_dotglob == 1 )) || shopt -u dotglob
}

updater_run_cycle() {
  local path="" base="" state="" remote="" claimed="" rc=0 fetch_rc=0
  local duplicate="" duplicate_base="" late_coalesce_rc=0
  local founder_direct=0 intent_state=""
  local had_invalid=0 had_indeterminate=0
  local had_consumed_indeterminate=0
  local shape_valid=() valid=()

UPDATER_WAKE_KIND=unknown
UPDATER_CYCLE_RESULT=unknown
  updater_snapshot_tokens
  if (( ${#UPDATER_SNAPSHOT[@]} == 0 )); then
    UPDATER_WAKE_KIND=scheduled
  else
    UPDATER_WAKE_KIND=urgent
  fi
  updater_observation_begin
  UPDATER_CLAIM_DIR="$(mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX")" || {
    UPDATER_CYCLE_RESULT=claim_dir_failed
    updater_alert_scheduled claim-dir-failed "Updater could not create its same-filesystem claim directory. No restart was attempted."
    return 1
  }

  # Schema-invalid files are provably not founder intent and do not require git.
  for path in ${UPDATER_SNAPSHOT[@]+"${UPDATER_SNAPSHOT[@]}"}; do
    base="$(basename "$path")"
    if updater_token_shape_valid "$path"; then
			if updater_token_is_v2 "$path"; then
				state="$("$UPDATER_NODE" "$UPDATER_RESTART_REQUEST_CLI" intent-state \
					--ticket "$path" --index "$RESTART_REQUEST_INDEX" 2>/dev/null)" || state=""
				if [[ "$state" == started ]]; then
					shape_valid+=("$path")
					continue
				fi
				if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
					claimed="${UPDATER_CLAIM_DIR}/${base}"
					if updater_retire_unstarted_v2 "$claimed" "$base" >/dev/null; then
						had_invalid=1
						updater_clear_wave_marker "$claimed" || true
						updater_alert_consumed_no_deploy retired-conditional-authority "$base" \
							"Retired unstarted v2 conditional-authority ticket $base with its original bytes preserved in the audit ledger. No deploy or restart was attempted."
					else
						had_indeterminate=1
						mv "$claimed" "$path" 2>/dev/null || true
						updater_alert_urgent retirement-audit-failed "$base" \
							"Could not preserve the mandatory retirement audit for v2 ticket $base; it was not authorized to execute and no restart was attempted."
					fi
				else
					had_indeterminate=1
					updater_alert_urgent claim-failed "$base" \
						"Could not claim retired v2 conditional-authority ticket $base; no restart was attempted."
				fi
				continue
			fi
      shape_valid+=("$path")
      continue
    fi
    if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
      had_invalid=1
      updater_clear_wave_marker "${UPDATER_CLAIM_DIR}/${base}" || true
      updater_alert_consumed_no_deploy invalid "$base" \
        "Ignored invalid founder urgent token $base (bad basename/schema/kind). It was removed from the watched directory without restarting."
    else
      had_indeterminate=1
      updater_alert_urgent claim-failed "$base" \
        "Could not move invalid urgent entry $base out of the watched directory; no restart was attempted."
    fi
  done

  updater_fetch_origin
  fetch_rc=$?
  if (( fetch_rc != 0 )); then
    if (( ${#shape_valid[@]} == 0 )); then
      if (( fetch_rc == 127 )); then
        updater_alert_scheduled fetch-runtime-missing \
          "Scheduled updater cannot execute its bounded runner at $UPDATER_BOUNDED_RUN; no restart was attempted."
      else
        updater_alert_scheduled fetch-failed "Scheduled updater could not fetch origin/main; no restart was attempted."
      fi
    else
	for path in ${shape_valid[@]+"${shape_valid[@]}"}; do
        base="$(basename "$path")"
        [[ -e "$path" ]] || continue
        if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
          had_consumed_indeterminate=1
          updater_mark_consumed_no_deploy_if_v3 "${UPDATER_CLAIM_DIR}/${base}" || true
          updater_clear_wave_marker "${UPDATER_CLAIM_DIR}/${base}" || true
          if (( fetch_rc == 127 )); then
            updater_alert_consumed_no_deploy probe-runtime-missing "$base" \
              "Cannot execute the updater bounded runner at $UPDATER_BOUNDED_RUN while validating urgent token $base. The ticket was consumed without restarting."
          else
            updater_alert_consumed_no_deploy probe-indeterminate "$base" \
              "Could not fetch origin/main while validating urgent token $base. The ticket was consumed without restarting and will not auto-retry."
          fi
        else
          updater_alert_urgent claim-failed "$base" \
            "Could not consume indeterminate urgent token $base after fetch failure; no restart was attempted."
        fi
      done
    fi
    if [[ "$UPDATER_WAKE_KIND" == scheduled ]]; then
      UPDATER_CYCLE_RESULT=fetch_failed
    elif (( had_invalid == 1 )); then
      UPDATER_CYCLE_RESULT=invalid
    else
      UPDATER_CYCLE_RESULT=indeterminate
    fi
    (( fetch_rc == 127 )) && return 127
    return 2
  fi

  for path in ${shape_valid[@]+"${shape_valid[@]}"}; do
    [[ -e "$path" ]] || continue
    base="$(basename "$path")"
		state="$(updater_token_target_state "$path")"
		case "$state" in
			valid)
				if updater_token_is_founder_direct "$path" \
					|| updater_verify_restart_ticket "$path"; then
					valid+=("$path")
				elif updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
					had_invalid=1
					updater_mark_consumed_no_deploy_if_v3 "${UPDATER_CLAIM_DIR}/${base}" || true
					updater_clear_wave_marker "${UPDATER_CLAIM_DIR}/${base}" || true
					updater_alert_consumed_no_deploy evidence-invalid "$base" \
						"Consumed urgent ticket $base without restart because its founder instruction, Lead identity, trigger, announcement, version, or withdrawal evidence no longer verified."
				else
					had_indeterminate=1
					updater_alert_urgent claim-failed "$base" \
						"Could not claim unverifiable urgent ticket $base; no restart was attempted."
				fi
				;;
      invalid)
        if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
          had_invalid=1
          updater_mark_consumed_no_deploy_if_v3 "${UPDATER_CLAIM_DIR}/${base}" || true
          updater_clear_wave_marker "${UPDATER_CLAIM_DIR}/${base}" || true
          updater_alert_consumed_no_deploy invalid "$base" \
            "Ignored founder urgent token $base because its target is provably outside origin/main. No restart was attempted."
        else
          had_indeterminate=1
          updater_alert_urgent claim-failed "$base" \
            "Could not claim invalid urgent token $base; no restart was attempted."
        fi
        ;;
      *)
        if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
          had_consumed_indeterminate=1
          updater_mark_consumed_no_deploy_if_v3 "${UPDATER_CLAIM_DIR}/${base}" || true
          updater_clear_wave_marker "${UPDATER_CLAIM_DIR}/${base}" || true
          updater_alert_consumed_no_deploy probe-indeterminate "$base" \
            "Git could not determine whether urgent token $base belongs to origin/main. The ticket was consumed without restarting and will not auto-retry."
        else
          had_indeterminate=1
          updater_alert_urgent claim-failed "$base" \
            "Could not consume indeterminate urgent token $base; no restart was attempted."
        fi
        ;;
    esac
  done

  # Only an entry that could not be atomically moved remains watched. Do not
  # execute a valid subset while that filesystem failure still re-arms launchd.
  if (( had_indeterminate != 0 )); then
    UPDATER_CYCLE_RESULT=indeterminate
    return 2
  fi

	if (( ${#valid[@]} > 0 )); then
		# Full-fleet waves are serialized. Leave any later valid tickets watched so
		# launchd runs a fresh validation cycle only after this wave releases locks.
		path="${valid[0]}"
		base="$(basename "$path")"
		if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
			UPDATER_CLAIMED=1
			UPDATER_CLAIMED_BASENAMES+=("$base")
			UPDATER_ACTIVE_TICKET="${UPDATER_CLAIM_DIR}/${base}"
		else
			updater_alert_urgent claim-failed "$base" \
				"Could not claim authorized urgent ticket $base; no restart was attempted."
			UPDATER_CYCLE_RESULT=indeterminate
			return 1
		fi
		# A single fleet restart is the unit of idempotency, independent of SHA.
		# Consume every other already-valid snapshot entry into this wave so
		# pre-hardening or concurrent legacy tickets cannot arm follow-on waves.
		for duplicate in ${valid[@]+"${valid[@]}"}; do
			[[ "$duplicate" != "$path" && -e "$duplicate" ]] || continue
			duplicate_base="$(basename "$duplicate")"
			if ! updater_claim_token "$duplicate" "$UPDATER_CLAIM_DIR"; then
				updater_alert_urgent claim-failed "$duplicate_base" \
					"Could not merge duplicate urgent ticket $duplicate_base into the active restart wave; no restart was attempted."
				UPDATER_CYCLE_RESULT=indeterminate
				return 1
			fi
			duplicate="${UPDATER_CLAIM_DIR}/${duplicate_base}"
			updater_mark_consumed_no_deploy_if_v3 "$duplicate" || true
			updater_clear_wave_marker "$duplicate" || true
			if ! updater_audit_wave_duplicate "$duplicate" "$UPDATER_ACTIVE_TICKET"; then
				updater_alert_urgent duplicate-audit-failed "$duplicate_base" \
					"Duplicate urgent ticket $duplicate_base was consumed, but its merge audit failed; no restart was attempted."
				UPDATER_CYCLE_RESULT=indeterminate
				return 1
			fi
			log "urgent restart: coalesced duplicate ticket $duplicate_base into $base"
		done
		if updater_token_is_founder_direct "$UPDATER_ACTIVE_TICKET"; then
			founder_direct=1
			UPDATER_ACTIVE_WAVE_ID="restart-$$-$(date +%s)-founder-direct"
			log "urgent restart: direct founder request; target=$(updater_token_target "$UPDATER_ACTIVE_TICKET")"
		else
			UPDATER_ACTIVE_WAVE_ID="$(updater_token_wave_id "$UPDATER_ACTIVE_TICKET")" || {
				updater_clear_wave_marker "$UPDATER_ACTIVE_TICKET" || true
				updater_mark_consumed_no_deploy_if_v3 "$UPDATER_ACTIVE_TICKET" || true
				updater_alert_consumed_no_deploy wave-binding-invalid "$base" \
					"Consumed authorized urgent ticket $base without restart because its bound wave could not be recovered."
				UPDATER_ALERTED=1
				UPDATER_CYCLE_RESULT=indeterminate
				return 1
			}
			if updater_token_is_v2 "$UPDATER_ACTIVE_TICKET"; then
				# Recovery-only v2 tickets already crossed the irreversible ledger
				# boundary before this process. Never mint or re-start a v2 wave.
				UPDATER_INTENT_STARTED=1
			fi
			if updater_token_is_closeout_v3 "$UPDATER_ACTIVE_TICKET"; then
				log "urgent restart: founder closeout intent $(updater_token_founder_ref "$UPDATER_ACTIVE_TICKET"); Lead standing-authority decision $(updater_token_lead_ref "$UPDATER_ACTIVE_TICKET"); target=$(updater_token_target "$UPDATER_ACTIVE_TICKET")"
			else
				log "urgent restart: founder instruction $(updater_token_founder_ref "$UPDATER_ACTIVE_TICKET"); Lead initiation $(updater_token_lead_ref "$UPDATER_ACTIVE_TICKET"); target=$(updater_token_target "$UPDATER_ACTIVE_TICKET")"
			fi
		fi
		"$SELF_SHIP_DEPLOY_CMD" "$UPDATER_ACTIVE_TICKET"
		rc=$?
		if (( founder_direct == 0 )); then
			intent_state="$("$UPDATER_NODE" "$UPDATER_RESTART_REQUEST_CLI" intent-state \
				--ticket "$UPDATER_ACTIVE_TICKET" --index "$RESTART_REQUEST_INDEX" 2>/dev/null)" || intent_state=""
			[[ "$intent_state" == started ]] && UPDATER_INTENT_STARTED=1
		fi
		updater_coalesce_late_wave_tickets "$UPDATER_ACTIVE_TICKET" || late_coalesce_rc=$?
		if (( late_coalesce_rc != 0 )); then
			updater_alert_urgent duplicate-audit-failed "$base" \
				"The active restart wave returned, but an in-flight duplicate could not be consumed and audited. Treat the lifecycle outcome as unknown."
			UPDATER_ALERTED=1
			UPDATER_CYCLE_RESULT=urgent_unknown
			return 2
		fi
		if (( rc == 0 )); then
			if (( founder_direct == 0 )) \
				&& ! updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" succeeded "$UPDATER_ACTIVE_WAVE_ID"; then
				updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" unknown "$UPDATER_ACTIVE_WAVE_ID" || true
				updater_alert_urgent result-ledger-failed "$base" \
					"Urgent restart returned success, but its one-use ledger result could not be recorded. Treat the outcome as unknown and do not retry."
				UPDATER_ALERTED=1
				UPDATER_CYCLE_RESULT=urgent_unknown
				updater_clear_wave_marker "$UPDATER_ACTIVE_TICKET" || true
				return 2
			fi
			UPDATER_COMPLETED=1
			UPDATER_CYCLE_RESULT=urgent_deployed
			updater_clear_wave_marker "$UPDATER_ACTIVE_TICKET" || true
			return 0
		fi
		if (( founder_direct == 0 )); then
			if (( rc == 82 )) && updater_token_is_closeout_v3 "$UPDATER_ACTIVE_TICKET" \
				&& [[ "$intent_state" == prepared ]]; then
				updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" consumed-no-deploy "$UPDATER_ACTIVE_WAVE_ID" 1 || true
			elif (( rc == 82 )); then
				# A legacy v2 recovery wave is already `started`; its refusal is a
				# plain `failed` (review round 6): the zero-side-effect flag is only
				# provable before start and the ledger refuses it here.
				updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" failed "$UPDATER_ACTIVE_WAVE_ID" || true
			else
				updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" failed "$UPDATER_ACTIVE_WAVE_ID" || true
			fi
		fi
		updater_alert_urgent deploy-failed "$base" \
			"Founder-direct or Lead standing-authority urgent ticket $base was claimed, but the single deploy attempt failed (rc=$rc). It will not auto-retry; inspect the one-use audit before submitting a revised request."
		UPDATER_ALERTED=1
    UPDATER_CYCLE_RESULT=urgent_failed
		updater_clear_wave_marker "$UPDATER_ACTIVE_TICKET" || true
    return "$rc"
  fi

  if (( had_invalid != 0 )); then
    UPDATER_CYCLE_RESULT=invalid
    return 1
  fi
  if (( had_consumed_indeterminate != 0 )); then
    UPDATER_CYCLE_RESULT=indeterminate
    return 2
  fi
  remote="$(updater_remote_sha)" || {
    UPDATER_CYCLE_RESULT=scheduled_failed
    updater_alert_scheduled probe-failed "Scheduled updater fetched origin/main but could not resolve its SHA; no restart was attempted."
    return 2
  }
  UPDATER_TARGET_SHA="$remote"
  UPDATER_BEHIND_COMMITS="$(git -C "$FLYWHEEL_DIR" rev-list --count "$(deployed_sha)..${remote}" 2>/dev/null || true)"
  [[ "$UPDATER_BEHIND_COMMITS" =~ ^[0-9]+$ ]] || UPDATER_BEHIND_COMMITS=""
  if [[ "$(deployed_sha)" == "$remote" ]]; then
    log "scheduled shuttle: deployed-sha already matches origin/main (${remote:0:7})"
    UPDATER_CYCLE_RESULT=scheduled_current
    return 0
  fi
  log "scheduled shuttle: deployed-sha is behind origin/main (${remote:0:7}) — deploying once"
  "$SELF_SHIP_DEPLOY_CMD"
  rc=$?
  if (( rc != 0 )); then
    updater_alert_scheduled deploy-failed \
      "Scheduled Flywheel deploy failed (rc=$rc, target=${remote:0:12}). The next daily alert/shuttle remains available."
    UPDATER_CYCLE_RESULT=scheduled_failed
  else
    UPDATER_CYCLE_RESULT=scheduled_deployed
  fi
  return "$rc"
}

# Preserve the FLY-1814 launchd convergence/census floor ahead of either
# surviving updater source. Fetch/probe/deploy failures in the cycle must not
# suppress that independent health pass.
updater_run_launchd_then_cycle() {
  updater_launchd_pass || true
  if ! updater_codex_home_reconcile; then
    log "Codex home reconciliation was unavailable (non-fatal; receipts/alerts retain the obligation)"
  fi
  updater_run_cycle
}

update_main() {
  local lock_rc=0 aggregate_counts=""
  UPDATER_WAKE_KIND=unknown
  UPDATER_CYCLE_RESULT=unknown
  UPDATER_OBSERVATION_STATE=not_started
  UPDATER_OBSERVATION_FINALIZED=0
  UPDATER_OBSERVATION_ERROR=0
  UPDATER_AGGREGATE_RESULT=observation_incomplete
  UPDATER_AGGREGATE_COUNTS='{}'
  UPDATER_TARGET_SHA=""
  UPDATER_BEHIND_COMMITS=""
  if ! updater_init_dirs; then
    log "could not initialize updater state directories"
    updater_alert_scheduled init-failed \
      "Updater could not create or secure its state and urgent directories. No restart was attempted."
    return 1
  fi
  updater_lock_acquire update-flywheel
  lock_rc=$?
  case "$lock_rc" in
    0) ;;
    75)
      log "another live updater holds the singleton lock — exiting without consuming tokens"
      return 0
      ;;
    *)
      log "could not persist singleton lock owner (rc=$lock_rc) — refusing to consume tokens"
      updater_alert_scheduled lock-state-failed \
        "Updater could not persist its singleton lock owner (rc=$lock_rc). No restart was attempted."
      _updater_lock_clear || true
      return "$lock_rc"
      ;;
  esac

  UPDATER_CLAIM_DIR=""
  UPDATER_CLAIMED=0
  UPDATER_COMPLETED=0
  UPDATER_ALERTED=0
  UPDATER_CLEANUP_DONE=0
	UPDATER_CLAIMED_BASENAMES=()
	UPDATER_ACTIVE_TICKET=""
	UPDATER_ACTIVE_WAVE_ID=""
	UPDATER_INTENT_STARTED=0
  local previous_exit previous_int previous_term rc=0
  previous_exit="$(trap -p EXIT)"
  previous_int="$(trap -p INT)"
  previous_term="$(trap -p TERM)"
  trap 'updater_cleanup' EXIT
  trap 'updater_signal_cleanup' INT TERM

  if ! updater_converge_bin; then
    log "converge-flywheel-bin reported unhealthy state (non-fatal; continuing)"
  fi
  if ! updater_sync_fable_model; then
    log "Fable model authority sync was unavailable (non-fatal; continuing)"
  fi
  if ! updater_sync_opus_model; then
    log "Opus model authority sync was unavailable (non-fatal; continuing)"
  fi
  updater_run_launchd_then_cycle
  rc=$?
  updater_observation_record_core
  updater_observation_fill_downstream
  case "${UPDATER_WAKE_KIND:-unknown}" in
    scheduled)
      if raya_host_capable; then
        updater_raya_pass || true
      else
        RAYA_DEPLOY_STATE=not_configured
        RAYA_DEPLOY_DETAIL=host-capability-absent
        log "raya shuttle: host capability absent — skipped"
      fi
      ;;
    urgent)
      if [[ "${UPDATER_CYCLE_RESULT:-unknown}" == urgent_deployed ]]; then
        if raya_host_capable; then
          updater_raya_pass || true
        else
          RAYA_DEPLOY_STATE=not_configured
          RAYA_DEPLOY_DETAIL=host-capability-absent
          log "raya shuttle: host capability absent — skipped"
        fi
      else
        log "raya shuttle: skipped wake=urgent result=${UPDATER_CYCLE_RESULT:-unknown}"
      fi
      ;;
    *) log "raya shuttle: skipped wake=unknown (fail closed)" ;;
  esac
  log "raya shuttle: ${RAYA_DEPLOY_STATE:-not_run} ${RAYA_DEPLOY_DETAIL:-}${RAYA_DEPLOY_REASON:+ reason=$RAYA_DEPLOY_REASON}"
  updater_observation_record_raya
  updater_observation_finish
  updater_observation_dispatch
  aggregate_counts="${UPDATER_AGGREGATE_COUNTS:-}"
  [[ -n "$aggregate_counts" ]] || aggregate_counts='{}'
  log "updater cycle: wake=${UPDATER_WAKE_KIND:-unknown} legacyResult=${UPDATER_CYCLE_RESULT:-unknown} result=${UPDATER_AGGREGATE_RESULT:-observation_incomplete} counts=${aggregate_counts}"
  updater_cleanup

  if [[ -n "$previous_exit" ]]; then eval "$previous_exit"; else trap - EXIT; fi
  if [[ -n "$previous_int" ]]; then eval "$previous_int"; else trap - INT; fi
  if [[ -n "$previous_term" ]]; then eval "$previous_term"; else trap - TERM; fi
  return "$rc"
}

if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" != 1 ]]; then
  update_main
  exit $?
fi
