#!/usr/bin/env bash
# FLY-1959: launchd-driven Flywheel updater with exactly two trigger sources:
#   1. local 00:00 / 12:00 schedule, deploying only when deployed-sha is behind;
#   2. founder-only urgent tokens, each claimed once before one restart attempt.
#
# QueueDirectories watches only the urgent directory. There is no per-merge
# marker, acknowledgement, retry receipt, blocked queue, or in-process loop.
set -uo pipefail

FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
    return
  fi
  HOME="$_UPDATER_LAUNCH_HOME"
  FLYWHEEL_HOME="${HOME}/.flywheel"
  SELF_SHIP_URGENT_DIR="${FLYWHEEL_HOME}/self-ship-urgent.d"
  SELF_SHIP_LOCK_DIR="${FLYWHEEL_HOME}/self-ship-updater.lock.d"
}
UPDATER_GIT="${UPDATER_GIT:-git}"
UPDATER_NODE="${UPDATER_NODE:-node}"
UPDATER_BOUNDED_RUN="${UPDATER_BOUNDED_RUN:-${SCRIPT_DIR}/lib/bounded-run.sh}"
# Deliberately shorter than restart-services' one-shot 120s fetch: this periodic
# updater gets three 20s noninteractive attempts before consuming urgent intent.
# Worktree mutation is local and unbounded by this network timeout.
UPDATER_FETCH_TIMEOUT_SECONDS="${UPDATER_FETCH_TIMEOUT_SECONDS:-20}"

# shellcheck source=lib/discord-pointer-guard.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/discord-pointer-guard.sh"
LAUNCHD_CENSUS_SOURCED=1
# shellcheck source=launchd-census.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/launchd-census.sh"
# launchd-census is a shared entrypoint and sources .env for standalone use.
# Re-pin afterward so no direct path override can diverge this consumer from
# the plist and founder producer in production.
updater_configure_runtime_paths

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
  "${FLYWHEEL_DIR}/scripts/lead-alert.sh" "${alert_args[@]}" 1>&2 || true
}

updater_alert_urgent() { # $1=class $2=basename $3=body
  severe_alert "$(updater_urgent_signature "$1" "$2")" "$3"
}
updater_alert_scheduled() { # $1=class $2=body
  severe_alert "$(updater_scheduled_signature "$1")" "$2"
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
  local remote_rc=0
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
  if discord_pointer_cutover_required; then
    log "origin/main selects discord@flywheel-plugins but the live checker is still legacy — refusing to pull before the guarded FLY-1676 cutover"
    return 3
  fi
  if ! updater_host_tmux_gate; then
    log "host tmux selection gate refused the frozen target — no fast-forward attempted"
    return 3
  fi
  updater_merge_remote
  remote_rc=$?
  if (( remote_rc != 0 )); then
    log "local git merge --ff-only failed (untracked collision / non-ff)"
    return 2
  fi
  if updater_restart_services; then
    return 0
  fi
  log "restart-services.sh failed (deterministic)"
  return 3
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
updater_restart_services() {
  FLYWHEEL_RESTART_FOREGROUND=1 "${SCRIPT_DIR}/restart-services.sh" --reason updater
}
updater_remote_sha() { git -C "$FLYWHEEL_DIR" rev-parse origin/main 2>/dev/null; }
updater_host_tmux_gate() {
  local target="" gate_bin="${FLYWHEEL_HOME}/bin/host-tmux-selection-gate.sh" rc=0
  target="$(updater_remote_sha)" || return 2
  updater_is_sha40 "$target" || return 2
  if [[ ! -x "$gate_bin" ]]; then
    gate_bin="${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh"
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
  local target=""
  target="$(updater_remote_sha)" || return 2
  updater_is_sha40 "$target" || return 2
  GIT_TERMINAL_PROMPT=0 "$UPDATER_GIT" -C "$FLYWHEEL_DIR" \
    merge --ff-only "$target" --quiet
}
updater_converge_bin() { bash "${SCRIPT_DIR}/converge-flywheel-bin.sh" >/dev/null 2>&1; }

# FLY-2238: the existing twice-daily singleton is the only model-family watch.
# The compiled CLI owns bounded probing, atomic authority mutation, verification,
# and success notification. Every outcome is advisory to the deploy shuttle.
updater_sync_fable_model() {
  local cli="${FLYWHEEL_FABLE_MODEL_SYNC_CLI:-${FLYWHEEL_DIR}/packages/teamlead/dist/account-heal/fable-model-sync-cli.js}"
  local alert_bin="${FLYWHEEL_LEAD_ALERT_BIN:-${FLYWHEEL_DIR}/scripts/lead-alert.sh}"
  [[ -f "$cli" && ! -L "$cli" ]] || return 127
  "$UPDATER_NODE" "$cli" \
    --authority "${FLYWHEEL_HOME}/models.json" \
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

updater_token_shape_valid() {
  local path="$1" base="" target=""
  base="$(basename "$path")"
  [[ "$base" =~ ^[A-Za-z0-9._-]+\.urgent\.json$ ]] || return 1
  jq -e '
    .schemaVersion == 1 and
    .kind == "founder-urgent-restart" and
    (.targetSha | type == "string" and test("^[0-9a-fA-F]{40}$")) and
    (.createdAt | type == "number" and . == floor) and
    (keys | sort) == ["createdAt","kind","schemaVersion","targetSha"]
  ' "$path" >/dev/null 2>&1 || return 1
  target="$(jq -r .targetSha "$path" 2>/dev/null)"
  updater_is_sha40 "$target"
}

updater_token_target() { jq -r .targetSha "$1" 2>/dev/null; }

# Prints valid, invalid, or indeterminate after a successful origin/main fetch.
updater_token_target_state() {
  local path="$1" target="" rc=0
  target="$(updater_token_target "$path")" || { printf 'indeterminate\n'; return; }
  if ! git -C "$FLYWHEEL_DIR" cat-file -e "${target}^{commit}" 2>/dev/null; then
    printf 'invalid\n'
    return
  fi
  git -C "$FLYWHEEL_DIR" merge-base --is-ancestor "$target" origin/main 2>/dev/null
  rc=$?
  case "$rc" in
    0) printf 'valid\n' ;;
    1) printf 'invalid\n' ;;
    *) printf 'indeterminate\n' ;;
  esac
}

updater_claim_token() { # $1=watched path $2=claim directory
  local path="$1" claim_dir="$2" base=""
  base="$(basename "$path")"
  mv "$path" "${claim_dir}/${base}"
}

UPDATER_CLAIM_DIR=""
UPDATER_CLAIMED=0
UPDATER_COMPLETED=0
UPDATER_ALERTED=0
UPDATER_CLEANUP_DONE=0
UPDATER_CLAIMED_BASENAMES=()

updater_cleanup() {
  (( UPDATER_CLEANUP_DONE == 0 )) || return 0
  UPDATER_CLEANUP_DONE=1
  if (( UPDATER_CLAIMED == 1 && UPDATER_COMPLETED == 0 && UPDATER_ALERTED == 0 )); then
    local base
    for base in ${UPDATER_CLAIMED_BASENAMES[@]+"${UPDATER_CLAIMED_BASENAMES[@]}"}; do
      updater_alert_urgent interrupted "$base" \
        "Founder urgent restart token $base was claimed but this updater invocation ended before deploy completion. Re-submit only after checking updater logs."
    done
  fi
  case "$UPDATER_CLAIM_DIR" in
    "${FLYWHEEL_HOME}"/.urgent-claim.*)
      rm -rf -- "$UPDATER_CLAIM_DIR" 2>/dev/null || true
      ;;
  esac
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
  local path="" base="" state="" remote="" rc=0 fetch_rc=0
  local had_invalid=0 had_indeterminate=0
  local had_consumed_indeterminate=0
  local shape_valid=() valid=()

  updater_snapshot_tokens
  UPDATER_CLAIM_DIR="$(mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX")" || {
    updater_alert_scheduled claim-dir-failed "Updater could not create its same-filesystem claim directory. No restart was attempted."
    return 1
  }

  # Schema-invalid files are provably not founder intent and do not require git.
  for path in ${UPDATER_SNAPSHOT[@]+"${UPDATER_SNAPSHOT[@]}"}; do
    base="$(basename "$path")"
    if updater_token_shape_valid "$path"; then
      shape_valid+=("$path")
      continue
    fi
    if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
      had_invalid=1
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
    (( fetch_rc == 127 )) && return 127
    return 2
  fi

  for path in ${shape_valid[@]+"${shape_valid[@]}"}; do
    [[ -e "$path" ]] || continue
    base="$(basename "$path")"
    state="$(updater_token_target_state "$path")"
    case "$state" in
      valid) valid+=("$path") ;;
      invalid)
        if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
          had_invalid=1
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
  (( had_indeterminate == 0 )) || return 2

  if (( ${#valid[@]} > 0 )); then
    for path in ${valid[@]+"${valid[@]}"}; do
      base="$(basename "$path")"
      if updater_claim_token "$path" "$UPDATER_CLAIM_DIR"; then
        UPDATER_CLAIMED=1
        UPDATER_CLAIMED_BASENAMES+=("$base")
      else
        updater_alert_urgent claim-failed "$base" \
          "Could not claim founder urgent token $base; no restart was attempted."
        return 1
      fi
    done
    "$SELF_SHIP_DEPLOY_CMD"
    rc=$?
    if (( rc == 0 )); then
      UPDATER_COMPLETED=1
      return 0
    fi
    for base in ${UPDATER_CLAIMED_BASENAMES[@]+"${UPDATER_CLAIMED_BASENAMES[@]}"}; do
      updater_alert_urgent deploy-failed "$base" \
        "Founder urgent restart token $base was claimed, but the single deploy attempt failed (rc=$rc). It will not auto-retry; inspect logs before submitting a new ticket."
    done
    UPDATER_ALERTED=1
    return "$rc"
  fi

  (( had_invalid == 0 )) || return 1
  (( had_consumed_indeterminate == 0 )) || return 2
  remote="$(updater_remote_sha)" || {
    updater_alert_scheduled probe-failed "Scheduled updater fetched origin/main but could not resolve its SHA; no restart was attempted."
    return 2
  }
  if [[ "$(deployed_sha)" == "$remote" ]]; then
    log "scheduled shuttle: deployed-sha already matches origin/main (${remote:0:7})"
    return 0
  fi
  log "scheduled shuttle: deployed-sha is behind origin/main (${remote:0:7}) — deploying once"
  "$SELF_SHIP_DEPLOY_CMD"
  rc=$?
  if (( rc != 0 )); then
    updater_alert_scheduled deploy-failed \
      "Scheduled Flywheel deploy failed (rc=$rc, target=${remote:0:12}). The next daily alert/shuttle remains available."
  fi
  return "$rc"
}

# Preserve the FLY-1814 launchd convergence/census floor ahead of either
# surviving updater source. Fetch/probe/deploy failures in the cycle must not
# suppress that independent health pass.
updater_run_launchd_then_cycle() {
  updater_launchd_pass || true
  updater_run_cycle
}

update_main() {
  local lock_rc=0
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
  updater_run_launchd_then_cycle
  rc=$?
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
