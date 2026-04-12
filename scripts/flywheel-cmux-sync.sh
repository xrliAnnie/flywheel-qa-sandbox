#!/bin/bash
# flywheel-cmux-sync.sh — Sync flywheel tmux windows to cmux workspaces
# Must be run from inside cmux (requires CMUX socket access).
set -euo pipefail

FLYWHEEL_SESSION="flywheel"
VIEW_PREFIX="cmux-"  # Linked session naming: cmux-<window_name>

# ── Functions ──

log() { echo "[cmux-sync $(date '+%H:%M:%S')] $*"; }

get_tmux_agent_windows() {
  # Returns: session_name|window_id|window_name per line
  # Scans both 'flywheel' (Leads) and 'runner-*' (Runners) sessions.
  # Excludes default shell windows (zsh/bash).
  local all_windows=""

  # 1. Flywheel session (Leads)
  all_windows+=$(tmux list-windows -t "$FLYWHEEL_SESSION" -F "#{session_name}|#{window_id}|#{window_name}" 2>/dev/null || true)

  # 2. Runner sessions: runner-<projectName> (e.g., runner-geoforge3d)
  local runner_sessions
  runner_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^runner-' || true)
  if [[ -n "$runner_sessions" ]]; then
    while read -r rsess; do
      local rwindows
      rwindows=$(tmux list-windows -t "$rsess" -F "#{session_name}|#{window_id}|#{window_name}" 2>/dev/null || true)
      if [[ -n "$rwindows" ]]; then
        all_windows+=$'\n'"$rwindows"
      fi
    done <<< "$runner_sessions"
  fi

  # Filter out default shell windows
  echo "$all_windows" | grep -v '|zsh$' | grep -v '|bash$' | grep -v '^$' || true
}

get_cmux_workspaces() {
  # Returns raw workspace list from cmux
  cmux list-workspaces 2>/dev/null || true
}

workspace_exists_for() {
  local window_name="$1"
  # Exact match: workspace title must match exactly (not substring)
  # cmux list-workspaces format: "* workspace:N  <title>  [selected]" or "  workspace:N  <title>"
  # Strip leading "* " or spaces → normalize to "workspace:N <title> [selected]?"
  get_cmux_workspaces | sed 's/^[* ]*//' | awk -v name="$window_name" '{
    if ($2 == name) { found=1; exit }
  } END { exit !found }'
}

get_workspace_ref_for() {
  local window_name="$1"
  # Return workspace:N ref for a given title (for targeted operations)
  # After stripping "* "/spaces: $1=workspace:N, $2=title
  get_cmux_workspaces | sed 's/^[* ]*//' | awk -v name="$window_name" '{
    if ($2 == name) { print $1; exit }
  }'
}

get_all_workspace_refs() {
  # Return sorted list of all workspace:N refs
  get_cmux_workspaces | sed 's/^[* ]*//' | awk '{print $1}' | sort
}

linked_session_exists() {
  local session_name="$1"
  tmux has-session -t "=$session_name" 2>/dev/null
}

create_workspace_for_window() {
  local source_session="$1"
  local window_id="$2"
  local window_name="$3"
  local view_session="${VIEW_PREFIX}${window_name}"

  log "Creating workspace for: $window_name ($window_id) from session $source_session"

  # 1. Create linked session (shares windows with source session, independent current-window)
  if ! linked_session_exists "$view_session"; then
    tmux new-session -d -t "$source_session" -s "$view_session" 2>/dev/null || true
  fi

  # 2. Select the target window in the linked session
  tmux select-window -t "${view_session}:${window_id}" 2>/dev/null || true

  # 3. Snapshot workspace refs before creation
  local refs_before
  refs_before=$(get_all_workspace_refs)

  # 4. Create cmux workspace attaching to the linked session
  cmux new-workspace --command "tmux attach -t '=${view_session}'"

  # 5. Find the new workspace ref by diffing before/after (no selection-state dependency)
  local refs_after new_ref
  refs_after=$(get_all_workspace_refs)
  new_ref=$(grep -vFxf <(echo "$refs_before") <(echo "$refs_after") | head -1 || true)

  # 6. Rename using the exact ref — immune to user tab switching
  if [[ -n "$new_ref" ]]; then
    cmux rename-workspace --workspace "$new_ref" "$window_name" 2>/dev/null || true
  fi
}

cleanup_stale_workspaces() {
  # Get current tmux window names (exact list, field 3 in session|wid|wname format)
  local active_names
  active_names=$(get_tmux_agent_windows | cut -d'|' -f3)

  # Check each linked session — if its window no longer exists, clean up fully
  local linked_sessions
  linked_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${VIEW_PREFIX}" || true)
  [[ -z "$linked_sessions" ]] && return 0

  while read -r sess; do
    local agent_name="${sess#${VIEW_PREFIX}}"
    # Exact match check (not substring)
    if ! echo "$active_names" | grep -qx "$agent_name"; then
      log "Cleaning stale: $sess (tmux window '$agent_name' gone)"

      # 1. Close the corresponding cmux workspace (so it doesn't linger as dead tab)
      local ws_ref
      ws_ref=$(get_workspace_ref_for "$agent_name")
      if [[ -n "$ws_ref" ]]; then
        cmux close-workspace --workspace "$ws_ref" 2>/dev/null || true
      fi

      # 2. Kill the linked session
      tmux kill-session -t "=$sess" 2>/dev/null || true
    fi
  done <<< "$linked_sessions"
}

reconcile_existing_workspaces() {
  # For workspaces that exist but have no linked session (e.g., after Lead restart
  # or cmux reopen with stale workspace), close the broken workspace and let the
  # create phase rebuild it from scratch. This is more reliable than respawn-pane,
  # which may not work on all pane states.
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0

  while IFS='|' read -r src_sess wid wname; do
    local view_session="${VIEW_PREFIX}${wname}"
    # Workspace exists but linked session doesn't → close workspace (create phase will rebuild)
    if workspace_exists_for "$wname" && ! linked_session_exists "$view_session"; then
      log "Reconciling: closing stale workspace for '$wname' (linked session dead)"
      local ws_ref
      ws_ref=$(get_workspace_ref_for "$wname")
      if [[ -n "$ws_ref" ]]; then
        cmux close-workspace --workspace "$ws_ref" 2>/dev/null || true
      fi
    fi
  done <<< "$tmux_windows"
}

sync_once() {
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)

  if [[ -z "$tmux_windows" ]]; then
    # No agent windows in any session — just cleanup stale
    cleanup_stale_workspaces
    return 0
  fi

  # 1. Reconcile: close workspaces with dead linked sessions (create phase will rebuild)
  reconcile_existing_workspaces

  # 2. Create missing workspaces
  while IFS='|' read -r src_sess wid wname; do
    if workspace_exists_for "$wname"; then
      continue
    fi
    create_workspace_for_window "$src_sess" "$wid" "$wname"
  done <<< "$tmux_windows"

  # 3. Cleanup stale (dead windows → close workspace + kill linked session)
  cleanup_stale_workspaces
}

# ── Main ──

case "${1:-}" in
  --watch)
    log "Watch mode: syncing every 10s"
    sync_once
    while true; do
      sleep 10
      sync_once
    done
    ;;
  --once|"")
    sync_once
    ;;
  *)
    echo "Usage: flywheel-cmux-sync [--once|--watch]"
    exit 1
    ;;
esac
