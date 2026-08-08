#!/bin/bash
# FLY-1659 frozen positive-control fixture.
# source-commit: 4857d999e353c7f3c0ed043208402943f4a0e9b8
# source-path: packages/teamlead/scripts/claude-lead.sh
# function: _prepare_lead_launch
# function-sha256: 56c879bf53f8dcef800747562501c8d3213e9f4e9d4453fb26ded3baa83fa46e
# Extracted once from the incident-era stack. Keep the function body byte-for-
# byte stable; shallow CI checkouts rely on this committed provenance artifact.

_prepare_lead_launch() {
  local window_name="${PROJECT_NAME}-${LEAD_ID}" target pane_row pane_dead
  target="=flywheel:=${window_name}"
  ENSURE_HOLD_KIND=""
  ENSURE_HOLD_EVIDENCE=""

  if [ -f "$TMUX_ARCHIVE_FILE" ]; then
    if ! tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE"; then
      rm -f "$TMUX_ARCHIVE_FILE" 2>/dev/null || true
    elif tmux_supervisor_archived_process_alive "$TMUX_ARCHIVE_FILE"; then
      if [ "$TMUX_RELAUNCH_PROVEN" -eq 1 ]; then
        tmux_supervisor_reap_archived_process "$TMUX_ARCHIVE_FILE" "$LEAD_ID" || return 1
      else
        if [ "$TMUX_ARCHIVE_SERVER_PID" = "$TMUX_SERVER_PID" ]; then
          ENSURE_HOLD_KIND="ambiguous"
          ENSURE_HOLD_EVIDENCE="{\"reason\":\"existing_archived_lead_alive\",\"originalServerPid\":${TMUX_ARCHIVE_SERVER_PID}}"
        else
          ENSURE_HOLD_KIND="split_brain"
          ENSURE_HOLD_EVIDENCE="{\"reason\":\"archived_lead_on_other_generation\",\"originalServerPid\":${TMUX_ARCHIVE_SERVER_PID},\"reachablePid\":${TMUX_SERVER_PID}}"
        fi
        return 3
      fi
    else
      # The archived process is positively gone (or its PID identity changed).
      # Clearing metadata cannot affect a live process.
      rm -f "$TMUX_ARCHIVE_FILE" 2>/dev/null || true
    fi
  fi
  TMUX_RELAUNCH_PROVEN=0

  # Pre-FLY-1285 dead windows have no archive. A dead pane on the generation we
  # just verified is safe to remove; a live pane is held for human/takeover
  # evidence rather than killed by name.
  if _tmux_generation_is_current "$TMUX_SERVER_PID"; then
    pane_row="$(_tmux list-panes -t "$target" -F '#{pane_pid}	#{pane_dead}' 2>/dev/null | head -1 || true)"
    if [ -n "$pane_row" ]; then
      pane_dead="${pane_row#*$'\t'}"
      if [ "$pane_dead" = "1" ] && _tmux_generation_is_current "$TMUX_SERVER_PID"; then
        _tmux kill-window -t "$target" 2>/dev/null || true
      else
        ENSURE_HOLD_KIND="ambiguous"
        ENSURE_HOLD_EVIDENCE='{"reason":"unarchived_live_lead_window"}'
        return 3
      fi
    fi
  fi
  return 0
}
