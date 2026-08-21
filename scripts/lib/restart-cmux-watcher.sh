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

# Re-read + re-prove the exact pid/incarnation/mode/nonce tuple immediately
# before every explicit signal. A KeepAlive replacement or PID reuse therefore
# turns the operation into a safe refusal instead of signalling the newcomer.
_crw_signal_expected_owner() {
  local signal="$1" expected="$2" pid _incarnation _mode _nonce
  _crw_expected_owner_is_live "$expected" || return 1
  IFS='|' read -r pid _incarnation _mode _nonce <<< "$expected"
  kill "-$signal" "$pid" 2>/dev/null
}

_crw_wait_for_expected_owner_exit() {
  local expected="$1" pid _incarnation _mode _nonce i
  IFS='|' read -r pid _incarnation _mode _nonce <<< "$expected"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  _crw_signal_expected_owner TERM "$expected" || return 2
  for i in 1 2; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  _crw_signal_expected_owner KILL "$expected" || return 2
  sleep 0.2
  kill -0 "$pid" 2>/dev/null && return 1
  return 0
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

restart_cmux_watcher() {
  local label="com.flywheel.cmux-watcher"
  local domain="gui/$(id -u)" plist sync_script lease_dir owner_file
  local old_pids="" old_rc=0 remaining="" remaining_rc=0 bootout_rc=0 wait_rc=0
  local tries interval i new_pids="" new_rc=0 new_count=0 new_pid=""
  local owner_pid="" owner_rc=0 heartbeat_pid="" heartbeat_rc=0 last_observation="not-probed"
  local expected_owner="${1:-}" heartbeat_file

  _crw_set_outcome unverifiable "watcher restart did not run"
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

  if [[ -n "$expected_owner" ]]; then
    if ! _crw_expected_owner_is_live "$expected_owner"; then
      _crw_set_outcome unverifiable "expected watcher owner tuple is no longer live; recovery signalled nothing"
      _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
      return 0
    fi
    local expected_pid _expected_incarnation _expected_mode _expected_nonce
    IFS='|' read -r expected_pid _expected_incarnation _expected_mode _expected_nonce <<< "$expected_owner"
    if [[ $'\n'"$old_pids"$'\n' != *$'\n'"$expected_pid"$'\n'* ]]; then
      _crw_set_outcome unverifiable "expected owner pid=$expected_pid is absent from the verified watcher census"
      _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
      return 0
    fi
  fi

  launchctl bootout "${domain}/${label}" >/dev/null 2>&1 || bootout_rc=$?
  if [[ -n "$expected_owner" ]]; then
    if [[ "$bootout_rc" -ne 0 ]]; then
      _crw_set_outcome unverifiable "launchctl bootout failed rc=$bootout_rc; tuple-bound signals skipped"
      _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}"
      return 0
    fi
    _crw_wait_for_expected_owner_exit "$expected_owner" || wait_rc=$?
  else
    "$sync_script" --wait-for-watcher-exit >/dev/null 2>&1 || wait_rc=$?
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

  if [[ "$wait_rc" -ne 0 ]]; then
    if [[ -n "$expected_owner" && "$bootout_rc" -eq 0 && "$remaining_rc" -eq 1 ]]; then
      # The tuple can disappear between launchctl's successful job-wide
      # bootout and the tuple-bound waiter. A conclusive empty watcher census
      # proves bootstrap cannot create a second watcher, so restore the now
      # unloaded KeepAlive job instead of stranding it.
      _crw_log "WARNING: tuple-bound shutdown verification drifted rc=$wait_rc; empty post-bootout census permits bootstrap"
    else
      _crw_set_outcome unverifiable "repo-pinned watcher shutdown verification failed rc=$wait_rc bootout_rc=$bootout_rc"
      _crw_log "ERROR: ${CMUX_WATCHER_RESTART_DETAIL}; bootstrap skipped"
      return 0
    fi
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

_crw_recover_cli() {
  local expected_owner="$1" deadline marker worker watchdog rc=0 monitor_was_enabled=0
  deadline="${FLYWHEEL_CMUX_WATCHER_RECOVER_DEADLINE:-120}"
  case "$deadline" in ''|*[!0-9]*) deadline=120 ;; esac
  (( deadline >= 1 && deadline <= 600 )) || deadline=120
  marker=$(mktemp "${TMPDIR:-/tmp}/cmux-watcher-recover.XXXXXX") || return 1
  : > "$marker"
  case "$-" in *m*) monitor_was_enabled=1 ;; esac
  set -m
  (
    restart_cmux_watcher "$expected_owner"
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
    *)
      echo "Usage: restart-cmux-watcher.sh --recover --expected-owner 'pid|incarnation|watch|nonce'" >&2
      exit 2
      ;;
  esac
fi
