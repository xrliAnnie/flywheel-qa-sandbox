#!/bin/bash
# FLY-1285: generation-bound Lead tmux archive and duplicate-process takeover.
# Source-only library; intentionally does not install traps or shell options.

tmux_supervisor_process_start_identity() {
  local pid="$1"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  ps -p "$pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
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

tmux_supervisor_archived_process_matches() {
  local archive="$1" lead_id="$2" actual_start command
  tmux_supervisor_archive_read "$archive" || return 1
  kill -0 "$TMUX_ARCHIVE_PANE_PID" 2>/dev/null || return 1
  actual_start="$(tmux_supervisor_process_start_identity "$TMUX_ARCHIVE_PANE_PID")" || return 1
  [ -n "$actual_start" ] && [ "$actual_start" = "$TMUX_ARCHIVE_PANE_START" ] || return 1
  command="$(_tmux_supervisor_process_command "$TMUX_ARCHIVE_PANE_PID")" || return 1
  case "$command" in
    *claude*"--agent ${lead_id}"*|*claude*"--agent=${lead_id}"*) return 0 ;;
  esac
  return 1
}

tmux_supervisor_archived_process_alive() {
  local archive="$1"
  tmux_supervisor_archive_read "$archive" || return 1
  kill -0 "$TMUX_ARCHIVE_PANE_PID" 2>/dev/null || return 1
  [ "$(tmux_supervisor_process_start_identity "$TMUX_ARCHIVE_PANE_PID")" \
    = "$TMUX_ARCHIVE_PANE_START" ]
}

tmux_supervisor_reap_archived_process() {
  local archive="$1" lead_id="$2" attempt=0
  local attempts="${FLYWHEEL_TMUX_TAKEOVER_WAIT_ATTEMPTS:-20}"
  local wait_sec="${FLYWHEEL_TMUX_TAKEOVER_WAIT_SEC:-0.5}"

  tmux_supervisor_archive_read "$archive" || {
    rm -f "$archive" 2>/dev/null || true
    return 0
  }
  if ! tmux_supervisor_archived_process_matches "$archive" "$lead_id"; then
    # Dead process, PID reuse, corrupt command, or identity drift: never signal.
    # The caller reached this helper only after positive window-death evidence,
    # so the stale archive itself may be cleared.
    rm -f "$archive" 2>/dev/null || true
    return 0
  fi

  kill -TERM "$TMUX_ARCHIVE_PANE_PID" 2>/dev/null || true
  while [ "$attempt" -lt "$attempts" ]; do
    tmux_supervisor_archived_process_matches "$archive" "$lead_id" || break
    sleep "$wait_sec"
    attempt=$((attempt + 1))
  done

  # Re-run the full PID + start identity + argv proof immediately before KILL.
  if tmux_supervisor_archived_process_matches "$archive" "$lead_id"; then
    kill -KILL "$TMUX_ARCHIVE_PANE_PID" 2>/dev/null || return 1
  fi
  rm -f "$archive" 2>/dev/null || true
  return 0
}
