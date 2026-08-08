#!/bin/bash
# FLY-1285: generation-bound Lead tmux archive and duplicate-process takeover.
# Source-only library; intentionally does not install traps or shell options.

tmux_supervisor_process_start_identity() {
  local pid="$1"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

_tmux_supervisor_process_command() {
  ps -p "$1" -o command= 2>/dev/null
}

tmux_supervisor_archive_write() {
  local archive="$1" server_pid="$2" pane_pid="$3" pane_start="$4" window_id="$5"
  local parent tmp
  case "$server_pid:$pane_pid" in
    *[!0-9:]*|:*|*:) return 1 ;;
  esac
  [ -n "$pane_start" ] && [ -n "$window_id" ] || return 1
  case "$pane_start$window_id" in *$'\t'*|*$'\n'*) return 1 ;; esac
  parent="${archive%/*}"
  [ "$parent" != "$archive" ] || parent="."
  mkdir -p "$parent" || return 1
  tmp="${archive}.tmp.$$"
  umask 077
  printf '%s\t%s\t%s\t%s\n' \
    "$server_pid" "$pane_pid" "$pane_start" "$window_id" > "$tmp" \
    && chmod 600 "$tmp" \
    && mv "$tmp" "$archive"
}

tmux_supervisor_archive_read() {
  local archive="$1" extra=""
  TMUX_ARCHIVE_SERVER_PID=""
  TMUX_ARCHIVE_PANE_PID=""
  TMUX_ARCHIVE_PANE_START=""
  TMUX_ARCHIVE_WINDOW_ID=""
  [ -f "$archive" ] && [ ! -L "$archive" ] || return 1
  IFS=$'\t' read -r TMUX_ARCHIVE_SERVER_PID TMUX_ARCHIVE_PANE_PID \
    TMUX_ARCHIVE_PANE_START TMUX_ARCHIVE_WINDOW_ID extra < "$archive" || return 1
  case "$TMUX_ARCHIVE_SERVER_PID:$TMUX_ARCHIVE_PANE_PID" in
    *[!0-9:]*|:*|*:) return 1 ;;
  esac
  [ -n "$TMUX_ARCHIVE_PANE_START" ] \
    && [ -n "$TMUX_ARCHIVE_WINDOW_ID" ] \
    && [ -z "$extra" ]
}

_tmux_supervisor_process_presence_state() {
  # rc 0: positively live and non-zombie; rc 1: positively absent/zombie;
  # rc 2: the process sensor could not classify the tuple.
  local pid="$1" stat="" rc=0
  stat="$(LC_ALL=C ps -p "$pid" -o stat= 2>/dev/null)" || rc=$?
  stat="$(printf '%s' "$stat" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ "$rc" -eq 0 ] && [ -n "$stat" ]; then
    case "$stat" in Z*) return 1 ;; *) return 0 ;; esac
  fi
  [ "$rc" -eq 1 ] && [ -z "$stat" ] && return 1
  return 2
}

# Typed archive/body identity probe.
# rc 0 / live_exact: the pid+lstart+argv tuple is the archived Lead body.
# rc 1 / positive_dead_or_mismatch: absence, zombie, PID reuse, or argv drift.
# rc 2 / indeterminate: archive/process sensors could not produce hard evidence.
tmux_supervisor_archived_process_state() {
  local archive="$1" lead_id="$2" actual_start="" command="" rc=0
  TMUX_SUPERVISOR_ARCHIVED_STATE=indeterminate
  tmux_supervisor_archive_read "$archive" || return 2

  _tmux_supervisor_process_presence_state "$TMUX_ARCHIVE_PANE_PID" || rc=$?
  case "$rc" in
    1) TMUX_SUPERVISOR_ARCHIVED_STATE=positive_dead_or_mismatch; return 1 ;;
    2) return 2 ;;
  esac

  actual_start="$(tmux_supervisor_process_start_identity "$TMUX_ARCHIVE_PANE_PID")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$actual_start" ]; then
    _tmux_supervisor_process_presence_state "$TMUX_ARCHIVE_PANE_PID"
    rc=$?
    if [ "$rc" -eq 1 ]; then
      TMUX_SUPERVISOR_ARCHIVED_STATE=positive_dead_or_mismatch
      return 1
    fi
    return 2
  fi
  if [ "$actual_start" != "$TMUX_ARCHIVE_PANE_START" ]; then
    TMUX_SUPERVISOR_ARCHIVED_STATE=positive_dead_or_mismatch
    return 1
  fi

  rc=0
  command="$(_tmux_supervisor_process_command "$TMUX_ARCHIVE_PANE_PID")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$command" ]; then
    _tmux_supervisor_process_presence_state "$TMUX_ARCHIVE_PANE_PID"
    rc=$?
    if [ "$rc" -eq 1 ]; then
      TMUX_SUPERVISOR_ARCHIVED_STATE=positive_dead_or_mismatch
      return 1
    fi
    return 2
  fi
  if type lead_identity_command_matches >/dev/null 2>&1; then
    if ! lead_identity_command_matches "$command" "$lead_id"; then
      TMUX_SUPERVISOR_ARCHIVED_STATE=positive_dead_or_mismatch
      return 1
    fi
  else
    case "$command" in
      *claude*"--agent ${lead_id}"*|*claude*"--agent=${lead_id}"*) ;;
      *) TMUX_SUPERVISOR_ARCHIVED_STATE=positive_dead_or_mismatch; return 1 ;;
    esac
  fi

  TMUX_SUPERVISOR_ARCHIVED_STATE=live_exact
  return 0
}

tmux_supervisor_archived_process_matches() {
  tmux_supervisor_archived_process_state "$@"
}

tmux_supervisor_archived_process_alive() {
  local archive="$1"
  tmux_supervisor_archive_read "$archive" || return 1
  kill -0 "$TMUX_ARCHIVE_PANE_PID" 2>/dev/null || return 1
  [ "$(tmux_supervisor_process_start_identity "$TMUX_ARCHIVE_PANE_PID")" \
    = "$TMUX_ARCHIVE_PANE_START" ]
}

tmux_supervisor_reap_archived_process() {
  local archive="$1" lead_id="$2" attempt=0 state_rc=0
  local attempts="${FLYWHEEL_TMUX_TAKEOVER_WAIT_ATTEMPTS:-20}"
  local wait_sec="${FLYWHEEL_TMUX_TAKEOVER_WAIT_SEC:-0.5}"

  tmux_supervisor_archived_process_state "$archive" "$lead_id" || state_rc=$?
  case "$state_rc" in
    1) rm -f "$archive" 2>/dev/null || return 2; return 0 ;;
    2) return 2 ;;
  esac

  kill -TERM "$TMUX_ARCHIVE_PANE_PID" 2>/dev/null || true
  while [ "$attempt" -lt "$attempts" ]; do
    state_rc=0
    tmux_supervisor_archived_process_state "$archive" "$lead_id" || state_rc=$?
    case "$state_rc" in
      1) rm -f "$archive" 2>/dev/null || return 2; return 0 ;;
      2) return 2 ;;
    esac
    sleep "$wait_sec"
    attempt=$((attempt + 1))
  done

  # Re-run the full PID + start identity + argv proof immediately before KILL.
  state_rc=0
  tmux_supervisor_archived_process_state "$archive" "$lead_id" || state_rc=$?
  case "$state_rc" in
    1) rm -f "$archive" 2>/dev/null || return 2; return 0 ;;
    2) return 2 ;;
  esac
  kill -KILL "$TMUX_ARCHIVE_PANE_PID" 2>/dev/null || return 2

  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    state_rc=0
    tmux_supervisor_archived_process_state "$archive" "$lead_id" || state_rc=$?
    case "$state_rc" in
      1) rm -f "$archive" 2>/dev/null || return 2; return 0 ;;
      2) return 2 ;;
    esac
    sleep "$wait_sec"
    attempt=$((attempt + 1))
  done
  return 2
}
