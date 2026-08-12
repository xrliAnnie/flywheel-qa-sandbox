#!/bin/bash
# FLY-1715: voice-bridge participation in the managed full-fleet transaction.
# Source-only; callers already own the global restart lock.

VOICE_BRIDGE_RESTART_STATE="${VOICE_BRIDGE_RESTART_STATE:-not_attempted}"
VOICE_BRIDGE_RESTART_DETAIL="${VOICE_BRIDGE_RESTART_DETAIL:-}"
VOICE_BRIDGE_OLD_TUPLES="${VOICE_BRIDGE_OLD_TUPLES:-}"

voice_bridge_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$*"
  else
    printf '[voice-bridge-restart] %s\n' "$*"
  fi
}

voice_bridge_state_dir() {
  printf '%s\n' "${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
}

voice_bridge_is_configured() {
  local projects_file
  projects_file="${FLYWHEEL_PROJECTS_FILE:-$(voice_bridge_state_dir)/projects.json}"
  [[ -f "$projects_file" ]] || return 1
  jq -e 'any(.[]?; (.huddle? | type) == "object")' "$projects_file" >/dev/null 2>&1
}

voice_bridge_supervisor_loaded() {
  type supervisor_is_loaded >/dev/null 2>&1 || return 1
  supervisor_is_loaded voice-bridge service >/dev/null 2>&1
}

voice_bridge_supervisor_keepalive() {
  type supervisor_assert_keepalive >/dev/null 2>&1 || return 1
  supervisor_assert_keepalive voice-bridge
}

voice_bridge_supervisor_restart() {
  supervisor_restart voice-bridge service >/dev/null 2>&1
}

voice_bridge_read_pid() {
  local status pid
  type supervisor_status >/dev/null 2>&1 || return 1
  status="$(supervisor_status voice-bridge service 2>/dev/null)" || return 1
  pid="$(printf '%s\n' "$status" | awk '
    /pid =/ { print $NF; exit }
    /Main PID:/ { print $3; exit }
  ')"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

voice_bridge_process_alive() {
  kill -0 "$1" 2>/dev/null
}

voice_bridge_process_start() {
  LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

voice_bridge_child_pids() {
  pgrep -P "$1" 2>/dev/null || true
}

voice_bridge_health_ok() {
  local url="${FLYWHEEL_VOICE_BRIDGE_URL:-http://127.0.0.1:${FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT:-9878}}"
  curl -sf --max-time 2 "${url}/health" \
    | jq -e '.ok == true and .shuttingDown == false and .service == "voice-bridge"' >/dev/null 2>&1
}

voice_bridge_sleep() {
  sleep "$1"
}

voice_bridge_capture_tuple_tree() {
  local pid="$1" start children child
  start="$(voice_bridge_process_start "$pid")" || return 1
  [[ -n "$start" ]] || return 1
  printf '%s\t%s\n' "$pid" "$start"
  children="$(voice_bridge_child_pids "$pid")"
  for child in $children; do
    [[ "$child" =~ ^[1-9][0-9]*$ ]] || continue
    voice_bridge_capture_tuple_tree "$child" || return 1
  done
}

voice_bridge_capture_old_tree() {
  local old_pid tuples
  VOICE_BRIDGE_OLD_TUPLES=""
  old_pid="$(voice_bridge_read_pid 2>/dev/null || true)"
  if [[ -z "$old_pid" ]] || ! voice_bridge_process_alive "$old_pid"; then
    return 0
  fi
  if ! tuples="$(voice_bridge_capture_tuple_tree "$old_pid")"; then
    VOICE_BRIDGE_RESTART_DETAIL="old_tree_capture_failed:pid=${old_pid}"
    return 1
  fi
  VOICE_BRIDGE_OLD_TUPLES="$tuples"
}

voice_bridge_old_tree_absent() {
  local pid expected_start actual_start
  [[ -n "$VOICE_BRIDGE_OLD_TUPLES" ]] || return 0
  while IFS=$'\t' read -r pid expected_start; do
    [[ -n "$pid" && -n "$expected_start" ]] || continue
    if voice_bridge_process_alive "$pid"; then
      actual_start="$(voice_bridge_process_start "$pid" 2>/dev/null || true)"
      if [[ -z "$actual_start" ]]; then
        VOICE_BRIDGE_RESTART_DETAIL="old_tree_unverifiable:pid=${pid}"
        return 1
      fi
      if [[ "$actual_start" == "$expected_start" ]]; then
        VOICE_BRIDGE_RESTART_DETAIL="old_tree_survived:pid=${pid};start=${expected_start}"
        return 1
      fi
    fi
  done <<< "$VOICE_BRIDGE_OLD_TUPLES"
  return 0
}

voice_bridge_fresh_daemon_observed() {
  local new_pid new_start old_root_pid="" old_root_start=""
  new_pid="$(voice_bridge_read_pid 2>/dev/null || true)"
  [[ "$new_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  voice_bridge_process_alive "$new_pid" || return 1
  new_start="$(voice_bridge_process_start "$new_pid" 2>/dev/null || true)"
  [[ -n "$new_start" ]] || return 1
  if [[ -n "$VOICE_BRIDGE_OLD_TUPLES" ]]; then
    IFS=$'\t' read -r old_root_pid old_root_start <<< "${VOICE_BRIDGE_OLD_TUPLES%%$'\n'*}"
    if [[ "$new_pid" == "$old_root_pid" && "$new_start" == "$old_root_start" ]]; then
      return 1
    fi
  fi
  return 0
}

voice_bridge_wait_for_replacement() {
  local tries="${FLYWHEEL_VOICE_HEALTH_TRIES:-30}"
  local interval="${FLYWHEEL_VOICE_HEALTH_INTERVAL:-2}"
  local fresh_seen=false health_seen=false old_absent=false i
  [[ "$tries" =~ ^[1-9][0-9]*$ ]] || tries=30
  [[ "$interval" =~ ^[0-9]+$ ]] || interval=2

  for ((i = 1; i <= tries; i++)); do
    fresh_seen=false
    health_seen=false
    old_absent=false
    voice_bridge_fresh_daemon_observed && fresh_seen=true
    voice_bridge_health_ok && health_seen=true
    voice_bridge_old_tree_absent && old_absent=true
    if [[ "$fresh_seen" == true && "$health_seen" == true && "$old_absent" == true ]]; then
      return 0
    fi
    (( i < tries )) && voice_bridge_sleep "$interval"
  done

  if ! voice_bridge_old_tree_absent; then
    return 1
  fi
  if [[ "$fresh_seen" != true ]]; then
    VOICE_BRIDGE_RESTART_DETAIL="replacement_not_observed"
  elif [[ "$health_seen" != true ]]; then
    VOICE_BRIDGE_RESTART_DETAIL="health_timeout:${tries}x${interval}s"
  else
    VOICE_BRIDGE_RESTART_DETAIL="replacement_unverified"
  fi
  return 1
}

restart_voice_bridge_managed() {
  VOICE_BRIDGE_RESTART_STATE="not_attempted"
  VOICE_BRIDGE_RESTART_DETAIL=""
  VOICE_BRIDGE_OLD_TUPLES=""

  if ! voice_bridge_supervisor_loaded && ! voice_bridge_is_configured; then
    VOICE_BRIDGE_RESTART_STATE="not_configured"
    VOICE_BRIDGE_RESTART_DETAIL="no loaded supervisor and no huddle project"
    voice_bridge_log "voice-bridge not configured or loaded; managed restart is a no-op"
    return 0
  fi
  if ! voice_bridge_supervisor_keepalive; then
    VOICE_BRIDGE_RESTART_STATE="failed"
    VOICE_BRIDGE_RESTART_DETAIL="keepalive_contract_missing"
    voice_bridge_log "ERROR: voice-bridge is configured/loaded without a managed KeepAlive supervisor"
    return 1
  fi
  if ! voice_bridge_capture_old_tree; then
    VOICE_BRIDGE_RESTART_STATE="failed"
    voice_bridge_log "ERROR: cannot capture voice-bridge PID+start tree before mutation (${VOICE_BRIDGE_RESTART_DETAIL})"
    return 1
  fi
  if ! voice_bridge_supervisor_restart; then
    VOICE_BRIDGE_RESTART_STATE="failed"
    VOICE_BRIDGE_RESTART_DETAIL="supervisor_restart_failed"
    voice_bridge_log "ERROR: managed voice-bridge restart failed"
    return 1
  fi
  if ! voice_bridge_supervisor_keepalive; then
    VOICE_BRIDGE_RESTART_STATE="failed"
    VOICE_BRIDGE_RESTART_DETAIL="keepalive_contract_lost"
    voice_bridge_log "ERROR: voice-bridge lost its KeepAlive contract after restart"
    return 1
  fi
  if ! voice_bridge_wait_for_replacement; then
    VOICE_BRIDGE_RESTART_STATE="failed"
    voice_bridge_log "ERROR: voice-bridge replacement verification failed (${VOICE_BRIDGE_RESTART_DETAIL})"
    return 1
  fi

  VOICE_BRIDGE_RESTART_STATE="healthy"
  VOICE_BRIDGE_RESTART_DETAIL="fresh daemon healthy; old PID+start tree absent"
  voice_bridge_log "voice-bridge managed replacement healthy; old process tree reclaimed"
  return 0
}
