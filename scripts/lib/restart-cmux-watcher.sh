#!/usr/bin/env bash
# Source-only cmux watcher restart state machine (FLY-1482).
# Compatible with macOS Bash 3.2. Outcomes are returned in:
#   CMUX_WATCHER_RESTART_STATE  healthy|parked|missing_plist|bootstrap_failed|
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

_crw_read_watch_owner_tuple() {
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
  printf '%s\n' "$line"
}

_crw_read_watch_owner_pid() {
  local tuple pid _incarnation _mode _nonce
  tuple=$(_crw_read_watch_owner_tuple "$1") || return $?
  IFS='|' read -r pid _incarnation _mode _nonce <<< "$tuple"
  printf '%s\n' "$pid"
}

_crw_process_incarnation() {
  local pid="$1" started
  started=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//') || return 1
  [[ -n "$started" ]] || return 1
  printf '%s\n' "$started"
}

_crw_expected_owner_is_live() {
  local expected="$1" owner_file tuple pid incarnation mode nonce observed
  owner_file="$(_crw_lease_dir)/owner"
  tuple=$(_crw_read_watch_owner_tuple "$owner_file") || return 1
  [[ "$tuple" == "$expected" ]] || return 1
  IFS='|' read -r pid incarnation mode nonce <<< "$tuple"
  kill -0 "$pid" 2>/dev/null || return 1
  observed=$(_crw_process_incarnation "$pid") || return 1
  [[ "$observed" == "$incarnation" ]]
}

_crw_read_heartbeat_pid() {
  local file="$1" bytes line pid _sequence _state
  [[ -f "$file" && ! -L "$file" ]] || return 1
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ') || return 1
  case "$bytes" in ''|*[!0-9]*) return 1 ;; esac
  (( bytes >= 1 && bytes <= 4096 )) || return 1
  line=$(cat "$file" 2>/dev/null) || return 1
  IFS='|' read -r pid _sequence _state <<< "$line"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$pid"
}

_crw_lease_dir() {
  printf '%s\n' "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR:-/tmp/flywheel-cmux-watcher.lock}"
}

_crw_probe_managed_watcher() {
  local replaced_pid="${1:-}" context="${2:-restart}" lease_dir owner_file heartbeat_file
  local tries interval i tuple pid incarnation _mode _nonce observed heartbeat_pid heartbeat_rc=0
  local census="" census_rc=0 census_detail="none" last_observation="not-probed"
  lease_dir=$(_crw_lease_dir)
  owner_file="${lease_dir}/owner"
  heartbeat_file="${FLYWHEEL_CMUX_WATCHER_HEARTBEAT:-${HOME}/.flywheel/state/cmux-watcher-heartbeat}"
  tries="${FLYWHEEL_CMUX_WATCHER_PROBE_TRIES:-20}"
  interval="${FLYWHEEL_CMUX_WATCHER_PROBE_INTERVAL:-0.5}"
  case "$tries" in ''|*[!0-9]*) tries=20 ;; esac
  (( tries >= 1 && tries <= 120 )) || tries=20
  [[ "$interval" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] || interval=0.5

  for ((i = 1; i <= tries; i++)); do
    tuple=$(_crw_read_watch_owner_tuple "$owner_file") || tuple=""
    if [[ -z "$tuple" ]]; then
      last_observation="watch lease owner missing, malformed, or unreadable"
    else
      IFS='|' read -r pid incarnation _mode _nonce <<< "$tuple"
      observed=$(_crw_process_incarnation "$pid") || observed=""
      heartbeat_rc=0; heartbeat_pid=$(_crw_read_heartbeat_pid "$heartbeat_file") || heartbeat_rc=$?
      if [[ -n "$replaced_pid" && "$pid" == "$replaced_pid" ]]; then
        last_observation="watcher PID did not change pid=$pid"
      elif [[ -z "$observed" || "$observed" != "$incarnation" ]]; then
        last_observation="watch lease owner pid=$pid is not live with incarnation=$incarnation"
      elif [[ "$heartbeat_rc" -ne 0 ]]; then
        last_observation="fresh watcher heartbeat missing or malformed"
      elif [[ "$heartbeat_pid" != "$pid" ]]; then
        last_observation="heartbeat pid=$heartbeat_pid does not match watcher pid=$pid"
      else
        census_rc=0; census=$(_crw_watcher_pids) || census_rc=$?
        if [[ "$census_rc" -eq 0 ]]; then
          census_detail=$(printf '%s' "$census" | tr '\n' ',')
        elif [[ "$census_rc" -eq 2 ]]; then
          census_detail="unavailable"
        fi
        _crw_set_outcome healthy "pid=$pid owns verified mode=watch lease and fresh heartbeat context=$context census=${census_detail:-none}"
        _crw_log "cmux watcher restart healthy: ${CMUX_WATCHER_RESTART_DETAIL}"
        return 0
      fi
    fi
    (( i < tries )) && sleep "$interval"
  done

  _crw_set_outcome probe_failed "managed watcher probe failed after $tries attempts: $last_observation"
  _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
  return 0
}

_crw_recover_loaded_watcher() {
  local expected_owner="$1" expected_pid _incarnation _mode _nonce
  local label="com.flywheel.cmux-watcher" domain="gui/$(id -u)"
  _crw_set_outcome unverifiable "watcher recovery did not run"
  if ! _crw_expected_owner_is_live "$expected_owner"; then
    _crw_set_outcome unverifiable "expected watcher owner tuple is no longer live; recovery signalled nothing"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
    return 0
  fi
  IFS='|' read -r expected_pid _incarnation _mode _nonce <<< "$expected_owner"
  if ! launchctl kickstart -k "${domain}/${label}" >/dev/null 2>&1; then
    _crw_set_outcome unverifiable "launchctl kickstart failed for ${domain}/${label}"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
    return 0
  fi
  _crw_probe_managed_watcher "$expected_pid" kickstart
}

_crw_active_park_marker() {
  local marker="${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-${HOME}/.flywheel/state/cmux-maintenance}" candidate
  for candidate in "$marker" "${marker}.qa-teardown" "${marker}.ops-rebuild"; do
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

rebuild_cmux_watcher() {
  local label="com.flywheel.cmux-watcher" domain="gui/$(id -u)" plist park="" bootstrap_rc=0
  _crw_set_outcome unverifiable "watcher rebuild did not run"
  plist="${FLYWHEEL_CMUX_WATCHER_PLIST:-${HOME}/Library/LaunchAgents/${label}.plist}"
  if [[ ! -f "$plist" || -L "$plist" ]]; then
    _crw_set_outcome missing_plist "watcher plist missing or unsafe: $plist"
    _crw_log "WARNING: ${CMUX_WATCHER_RESTART_DETAIL}"
    return 0
  fi
  park=$(_crw_active_park_marker) || park=""
  if [[ -n "$park" ]]; then
    _crw_set_outcome parked "maintenance marker is active: $park"
    return 0
  fi
  if launchctl print "${domain}/${label}" >/dev/null 2>&1; then
    _crw_probe_managed_watcher "" already-loaded
    return 0
  fi
  park=$(_crw_active_park_marker) || park=""
  if [[ -n "$park" ]]; then
    _crw_set_outcome parked "maintenance marker appeared before bootstrap: $park"
    return 0
  fi
  launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || bootstrap_rc=$?
  if [[ "$bootstrap_rc" -ne 0 ]] \
      && ! launchctl print "${domain}/${label}" >/dev/null 2>&1; then
    _crw_set_outcome bootstrap_failed "launchctl bootstrap failed for ${domain}/${label} rc=$bootstrap_rc"
    _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
    return 0
  fi
  _crw_probe_managed_watcher "" rebuild
}

restart_cmux_watcher() {
  local label="com.flywheel.cmux-watcher"
  local domain="gui/$(id -u)" plist sync_script lease_dir owner_file
  local old_pids="" old_rc=0 remaining="" remaining_rc=0 bootout_rc=0 wait_rc=0
  local tries interval i new_pids="" new_rc=0 new_count=0 new_pid=""
  local owner_pid="" owner_rc=0 heartbeat_pid="" heartbeat_rc=0 last_observation="not-probed"
  local heartbeat_file

  _crw_set_outcome unverifiable "watcher restart did not run"
  if [[ -n "${1:-}" ]]; then
    _crw_recover_loaded_watcher "$1"
    return 0
  fi
  plist="${FLYWHEEL_CMUX_WATCHER_PLIST:-${HOME}/Library/LaunchAgents/${label}.plist}"
  sync_script="${FLYWHEEL_DIR}/scripts/flywheel-cmux-sync.sh"
  lease_dir=$(_crw_lease_dir)
  owner_file="${lease_dir}/owner"
  heartbeat_file="${FLYWHEEL_CMUX_WATCHER_HEARTBEAT:-${HOME}/.flywheel/state/cmux-watcher-heartbeat}"
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

  if [[ "$wait_rc" -ne 0 ]]; then
    _crw_set_outcome unverifiable "repo-pinned watcher shutdown verification failed rc=$wait_rc bootout_rc=$bootout_rc"
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
      heartbeat_rc=0; heartbeat_pid=$(_crw_read_heartbeat_pid "$heartbeat_file") || heartbeat_rc=$?
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
      elif [[ "$heartbeat_rc" -ne 0 ]]; then
        last_observation="fresh watcher heartbeat missing or malformed"
      elif [[ "$heartbeat_pid" != "$new_pid" ]]; then
        last_observation="heartbeat pid=$heartbeat_pid does not match watcher pid=$new_pid"
      else
        _crw_set_outcome healthy "pid=$new_pid owns verified mode=watch lease and fresh heartbeat (old=${old_pids:-none}, bootout_rc=$bootout_rc)"
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

_crw_bounded_cli() {
  local operation="$1" deadline marker worker watchdog rc=0 monitor_was_enabled=0
  shift
  deadline="${FLYWHEEL_CMUX_WATCHER_RECOVER_DEADLINE:-120}"
  case "$deadline" in ''|*[!0-9]*) deadline=120 ;; esac
  (( deadline >= 1 && deadline <= 600 )) || deadline=120
  marker=$(mktemp "${TMPDIR:-/tmp}/cmux-watcher-recover.XXXXXX") || return 1
  : > "$marker"
  case "$-" in *m*) monitor_was_enabled=1 ;; esac
  set -m
  (
    "$operation" "$@"
    printf 'state=%s detail=%q\n' "$CMUX_WATCHER_RESTART_STATE" "$CMUX_WATCHER_RESTART_DETAIL"
    [[ "$CMUX_WATCHER_RESTART_STATE" == "healthy" ]]
  ) &
  worker=$!
  (
    sleep "$deadline"
    if kill -0 "$worker" 2>/dev/null; then
      printf 'timeout\n' > "$marker"
      kill -TERM -- "-$worker" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$worker" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$worker" || rc=$?
  kill -TERM -- "-$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  [[ $monitor_was_enabled -eq 1 ]] || set +m
  if [[ -s "$marker" ]]; then
    printf 'state=timed_out detail=internal_deadline_%ss\n' "$deadline"
    rm -f "$marker"
    return 124
  fi
  rm -f "$marker"
  return "$rc"
}

_crw_recover_cli() {
  _crw_bounded_cli restart_cmux_watcher "$1"
}

_crw_rebuild_cli() {
  _crw_bounded_cli rebuild_cmux_watcher
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    --recover)
      if [[ "${2:-}" != "--expected-owner" || -z "${3:-}" || -n "${4:-}" ]]; then
        echo "Usage: restart-cmux-watcher.sh --recover --expected-owner 'pid|incarnation|watch|nonce'" >&2
        exit 2
      fi
      _crw_recover_cli "$3"
      exit $?
      ;;
    --rebuild)
      if [[ -n "${2:-}" ]]; then
        echo "Usage: restart-cmux-watcher.sh --rebuild" >&2
        exit 2
      fi
      _crw_rebuild_cli
      exit $?
      ;;
    *)
      echo "Usage: restart-cmux-watcher.sh --recover --expected-owner 'pid|incarnation|watch|nonce' | --rebuild" >&2
      exit 2
      ;;
  esac
fi
