#!/usr/bin/env bash
# Source-only cmux watcher restart state machine (FLY-1482).
# Compatible with macOS Bash 3.2. Outcomes are returned in:
#   CMUX_WATCHER_RESTART_STATE  healthy|missing_plist|bootstrap_failed|
#                               probe_failed|unverifiable
#   CMUX_WATCHER_RESTART_DETAIL operator-readable evidence

_CRW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_crw_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$*"
  else
    echo "[cmux-watcher-restart] $*" >&2
  fi
}

_CMUX_PROCESS_CENSUS_LIB="$_CRW_LIB_DIR/cmux-mutator-process-census.sh"
if [[ ! -r "$_CMUX_PROCESS_CENSUS_LIB" ]]; then
  _crw_log "ERROR: required cmux process census library unavailable"
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=cmux-mutator-process-census.sh
if ! source "$_CMUX_PROCESS_CENSUS_LIB"; then
  _crw_log "ERROR: required cmux process census library unavailable"
  return 1 2>/dev/null || exit 1
fi
unset _CMUX_PROCESS_CENSUS_LIB

_crw_set_outcome() {
  CMUX_WATCHER_RESTART_STATE="$1"
  CMUX_WATCHER_RESTART_DETAIL="$2"
}

_crw_watcher_pids() {
  cmux_watcher_process_pids "$@"
}

_crw_read_watch_owner_pid() {
  local file="$1" bytes line fields pid incarnation mode nonce
  [[ -e "$file" || -L "$file" ]] || return 1
  [[ -f "$file" && ! -L "$file" ]] || return 2
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ') || return 2
  case "$bytes" in ''|*[!0-9]*) return 2 ;; esac
  (( bytes <= 4096 )) || return 2
  [[ "$(wc -l < "$file" 2>/dev/null | tr -d ' ')" == "1" ]] || return 2
  line=$(cat "$file" 2>/dev/null) || return 2
  fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
  [[ "$fields" == "4" ]] || return 2
  IFS='|' read -r pid incarnation mode nonce <<< "$line"
  case "$pid" in ''|*[!0-9]*) return 2 ;; esac
  [[ "$mode" == "watch" && -n "$incarnation" ]] || return 2
  case "$nonce" in ''|*[!A-Za-z0-9_.-]*) return 2 ;; esac
  printf '%s\n' "$pid"
}

_crw_lease_dir() {
  printf '%s\n' "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR:-/tmp/flywheel-cmux-watcher.lock}"
}

restart_cmux_watcher() {
  local label="com.flywheel.cmux-watcher"
  local domain="gui/$(id -u)" plist sync_script lease_dir owner_file
  local old_pids="" old_rc=0 remaining="" remaining_rc=0 bootout_rc=0 wait_rc=0
  local tries interval i new_pids="" new_rc=0 new_count=0 new_pid=""
  local owner_pid="" owner_rc=0 last_observation="not-probed"

  _crw_set_outcome unverifiable "watcher restart did not run"
  plist="${FLYWHEEL_CMUX_WATCHER_PLIST:-${HOME}/Library/LaunchAgents/${label}.plist}"
  sync_script="${FLYWHEEL_DIR}/scripts/flywheel-cmux-sync.sh"
  lease_dir=$(_crw_lease_dir)
  owner_file="${lease_dir}/owner"
  tries="${FLYWHEEL_CMUX_WATCHER_PROBE_TRIES:-20}"
  interval="${FLYWHEEL_CMUX_WATCHER_PROBE_INTERVAL:-0.5}"
  case "$tries" in ''|*[!0-9]*) tries=20 ;; esac
  (( tries >= 1 && tries <= 120 )) || tries=20
  [[ "$interval" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] || interval=0.5

  if [[ ! -f "$plist" || -L "$plist" ]]; then
    _crw_set_outcome missing_plist "watcher plist missing or unsafe: $plist"
    _crw_log "WARNING: ${CMUX_WATCHER_RESTART_DETAIL}"
    return 0
  fi
  if [[ ! -x "$sync_script" ]]; then
    _crw_set_outcome unverifiable "repo-pinned watcher helper is not executable: $sync_script"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
    return 0
  fi

  old_pids=$(_crw_watcher_pids) || old_rc=$?
  if [[ "$old_rc" -eq 2 ]]; then
    _crw_set_outcome unverifiable "pre-restart watcher process census failed"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}; refusing bootout"
    return 0
  fi
  [[ "$old_rc" -eq 1 ]] && old_pids=""

  launchctl bootout "${domain}/${label}" >/dev/null 2>&1 || bootout_rc=$?
  "$sync_script" --wait-for-watcher-exit >/dev/null 2>&1 || wait_rc=$?
  if [[ "$wait_rc" -ne 0 ]]; then
    _crw_set_outcome unverifiable "repo-pinned watcher shutdown verification failed rc=$wait_rc bootout_rc=$bootout_rc"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}; bootstrap skipped"
    return 0
  fi

  remaining=$(_crw_watcher_pids) || remaining_rc=$?
  if [[ "$remaining_rc" -eq 0 && -n "$remaining" ]]; then
    _crw_set_outcome unverifiable "watcher survived shutdown verification pids=$(printf '%s' "$remaining" | tr '\n' ',')"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}; bootstrap skipped"
    return 0
  elif [[ "$remaining_rc" -eq 2 ]]; then
    _crw_set_outcome unverifiable "post-shutdown watcher process census failed"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}; bootstrap skipped"
    return 0
  fi

  if ! launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then
    _crw_set_outcome bootstrap_failed "launchctl bootstrap failed for ${domain}/${label}"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
    return 0
  fi

  for ((i = 1; i <= tries; i++)); do
    new_rc=0; new_pids=$(_crw_watcher_pids) || new_rc=$?
    if [[ "$new_rc" -eq 2 ]]; then
      last_observation="process census unavailable"
    elif [[ "$new_rc" -eq 1 ]]; then
      last_observation="no watcher process"
    else
      new_count=$(printf '%s\n' "$new_pids" | grep -c . || true)
      new_pid=$(printf '%s\n' "$new_pids" | head -1)
      owner_rc=0; owner_pid=$(_crw_read_watch_owner_pid "$owner_file") || owner_rc=$?
      if [[ "$new_count" != "1" ]]; then
        last_observation="watcher process count=$new_count"
      elif [[ -n "$old_pids" && $'\n'"$old_pids"$'\n' == *$'\n'"$new_pid"$'\n'* ]]; then
        last_observation="watcher PID did not change pid=$new_pid"
      elif [[ "$owner_rc" -eq 1 ]]; then
        last_observation="watch lease owner missing"
      elif [[ "$owner_rc" -ne 0 ]]; then
        last_observation="watch lease owner malformed or unreadable"
      elif [[ "$owner_pid" != "$new_pid" ]]; then
        last_observation="watch lease owner pid=$owner_pid does not match watcher pid=$new_pid"
      else
        _crw_set_outcome healthy "pid=$new_pid owns verified mode=watch lease (old=${old_pids:-none}, bootout_rc=$bootout_rc)"
        _crw_log "cmux watcher restart healthy: ${CMUX_WATCHER_RESTART_DETAIL}"
        return 0
      fi
    fi
    (( i < tries )) && sleep "$interval"
  done

  _crw_set_outcome probe_failed "post-bootstrap watcher probe failed after $tries attempts: $last_observation"
  _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
  return 0
}
