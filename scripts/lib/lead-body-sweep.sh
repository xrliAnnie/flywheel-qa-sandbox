#!/bin/bash
# FLY-1634/FLY-1680: bounded cleanup for bespoke Codex shared-tmux bodies.
# Source-only, bash 3.2 safe.

lead_body_process_start_identity() {
  lead_restart_process_start_identity "$1"
}

lead_body_process_state() {
  ps -p "$1" -o state= 2>/dev/null
}

lead_body_process_parent_table() {
  LC_ALL=C ps -axo pid=,ppid= 2>/dev/null
}

lead_body_process_alive() {
  kill -0 "$1" 2>/dev/null
}

lead_body_signal() {
  kill "-$1" "$2" 2>/dev/null
}

lead_body_sleep() {
  sleep "$1"
}

_sweep_tmux() {
  if [ -n "${FLYWHEEL_TMUX_SOCKET_OVERRIDE:-}" ]; then
    tmux -S "$FLYWHEEL_TMUX_SOCKET_OVERRIDE" "$@"
  else
    tmux "$@"
  fi
}

# Inventory stays session-scoped so QA/Runner sessions cannot enter a restart.
lead_body_pane_inventory() {
  local raw="" raw_rc=0
  local window_id window_name pane_id pane_pid pane_dead
  raw="$(_sweep_tmux list-panes -s -t =flywheel \
    -F '#{window_id}|#{window_name}|#{pane_id}|#{pane_pid}|#{pane_dead}' 2>/dev/null)" \
    || raw_rc=$?
  [ "$raw_rc" -eq 0 ] || return "$raw_rc"
  while IFS='|' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ -n "$window_id$window_name$pane_id$pane_pid$pane_dead" ] || continue
    case "$window_id" in @|@*[!0-9]*|"") return 2 ;; @*) ;; *) return 2 ;; esac
    [ -n "$window_name" ] || return 2
    case "$pane_id" in %|%*[!0-9]*|"") return 2 ;; %*) ;; *) return 2 ;; esac
    case "$pane_pid" in ''|0|*[!0-9]*) return 2 ;; esac
    case "$pane_dead" in 0|1) ;; *) return 2 ;; esac
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$window_id" "$window_name" "$pane_id" "$pane_pid" "$pane_dead"
  done <<EOF
$raw
EOF
}

# rc: 0 exact executable tuple; 1 dead/reused/zombie; 2 sensor failure.
_lead_body_tuple_state() {
  local pid="$1" expected_start="$2" actual_start="" raw_state="" state=""
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  lead_body_process_alive "$pid" || return 1
  actual_start="$(lead_body_process_start_identity "$pid")" || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  [ -n "$actual_start" ] || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  raw_state="$(lead_body_process_state "$pid")" || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  state="$(printf '%s\n' "$raw_state" | awk 'NF { print substr($1, 1, 1); exit }')"
  [ -n "$state" ] || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  [ "$state" = Z ] && return 1
  [ "$actual_start" = "$expected_start" ] && return 0
  return 1
}

_lead_body_target_windows() {
  local project="$1" lead_id="$2" inventory="" rc=0
  local window_id window_name pane_id pane_pid pane_dead
  inventory="$(lead_body_pane_inventory)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ "$window_name" = "${project}-${lead_id}" ] || continue
    printf '%s\t%s\t%s\n' "$window_id" "$pane_pid" "$pane_dead"
  done <<EOF
$inventory
EOF
}

_lead_body_codex_tuples() {
  local windows="$1" parents="" rc=0 pids="" changed=1
  local window_id pane_pid pane_dead pid ppid _rest start
  while IFS=$'\t' read -r window_id pane_pid pane_dead; do
    [ -n "$window_id" ] || continue
    [ "$pane_dead" = 0 ] || continue
    case " $pids " in *" $pane_pid "*) ;; *) pids="${pids} ${pane_pid}" ;; esac
  done <<EOF
$windows
EOF
  parents="$(lead_body_process_parent_table)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  while [ "$changed" -eq 1 ]; do
    changed=0
    while read -r pid ppid _rest; do
      case "$pid:$ppid" in *[!0-9:]*) continue ;; esac
      case " $pids " in
        *" $pid "*) ;;
        *)
          case " $pids " in *" $ppid "*) pids="${pids} ${pid}"; changed=1 ;; esac
          ;;
      esac
    done <<EOF
$parents
EOF
  done
  for pid in $pids; do
    start="$(lead_body_process_start_identity "$pid")" || {
      lead_body_process_alive "$pid" && return 2
      continue
    }
    printf '%s\t%s\n' "$pid" "$start"
  done
}

_lead_body_signal_tuples() {
  local tuples="$1" signal="$2" pid start tuple_rc
  while IFS=$'\t' read -r pid start; do
    [ -n "$pid" ] || continue
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    case "$tuple_rc" in
      0) lead_body_signal "$signal" "$pid" || true ;;
      1) ;;
      *) return 2 ;;
    esac
  done <<EOF
$tuples
EOF
}

_lead_body_kill_windows() {
  local windows="$1" seen="" window_id pane_pid pane_dead
  while IFS=$'\t' read -r window_id pane_pid pane_dead; do
    [ -n "$window_id" ] || continue
    case " $seen " in *" $window_id "*) continue ;; esac
    seen="${seen} ${window_id}"
    _sweep_tmux kill-window -t "=${window_id}" >/dev/null 2>&1 || true
  done <<EOF
$windows
EOF
}

# rc: 0 clear, 1 executable target remains, 2 sensor failure.
_lead_body_restart_observe() {
  local project="$1" lead_id="$2" tuples="$3"
  local windows="" rc=0 pid start tuple_rc saw_alive=0
  windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  [ -z "$windows" ] || saw_alive=1
  while IFS=$'\t' read -r pid start; do
    [ -n "$pid" ] || continue
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    [ "$tuple_rc" -eq 2 ] && return 2
    [ "$tuple_rc" -eq 0 ] && saw_alive=1
  done <<EOF
$tuples
EOF
  [ "$saw_alive" -eq 0 ]
}

# Usage: lead_body_hard_clear <project> <lead_id> codex-app-server
lead_body_hard_clear() {
  local project="$1" lead_id="$2" backend="$3"
  local windows="" tuples="" rc=0 attempt=0 observe_rc=0
  local term_attempts="${LEAD_BODY_CLEAR_TERM_ATTEMPTS:-10}"
  local kill_attempts="${LEAD_BODY_CLEAR_KILL_ATTEMPTS:-10}"
  local interval="${LEAD_BODY_CLEAR_INTERVAL:-0.5}"
  [ "$backend" = codex-app-server ] || return 2

  while [ "$attempt" -lt "$((term_attempts + kill_attempts))" ]; do
    rc=0
    windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
    [ "$rc" -ne 0 ] || tuples="$(_lead_body_codex_tuples "$windows")" || rc=$?
    [ "$rc" -eq 0 ] && break
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ "$rc" -eq 0 ] || return 2
  _lead_body_kill_windows "$windows"
  _lead_body_signal_tuples "$tuples" TERM || true

  attempt=0
  while [ "$attempt" -lt "$term_attempts" ]; do
    observe_rc=0
    _lead_body_restart_observe "$project" "$lead_id" "$tuples" || observe_rc=$?
    [ "$observe_rc" -eq 0 ] && return
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done

  attempt=0
  while [ "$attempt" -lt "$((term_attempts + kill_attempts))" ]; do
    rc=0
    windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
    [ "$rc" -eq 0 ] && break
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ "$rc" -eq 0 ] || return 2
  _lead_body_kill_windows "$windows"
  _lead_body_signal_tuples "$tuples" KILL || true

  attempt=0
  while [ "$attempt" -lt "$kill_attempts" ]; do
    observe_rc=0
    _lead_body_restart_observe "$project" "$lead_id" "$tuples" || observe_rc=$?
    [ "$observe_rc" -eq 0 ] && return
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ "$observe_rc" -eq 2 ] && return 2
  return 1
}
