#!/bin/bash
# flywheel-cmux-sync.sh — Sync flywheel tmux windows to cmux workspaces
# --once: full sync (tmux + cmux workspace management, with aggressive cleanup). Manual use.
# --watch: event-signaled polling (15s event drain + 60s additive scan). Must run from inside cmux.
# --refresh: tmux-only linked session repair. Safe to call from anywhere (no cmux socket needed).
#
# FLY-102: --watch uses event-signaled polling architecture:
#   - tmux hooks (after-new-window, pane-exited, session-created) write events to $EVENT_FILE
#   - watcher drains events every 15s and performs cmux operations
#   - additive-only polling (60s) creates missing workspaces, conservative cleanup (5min)
#   - hooks themselves never call cmux CLI (they lack cmux socket context)
set -euo pipefail

FLYWHEEL_SESSION="flywheel"
VIEW_PREFIX="cmux-"  # Linked session naming: cmux-<window_name>

# FLY-102: Event-signaled polling state files.
# Paths are overridable for tests (${VAR:-default} preserves pre-set values).
EVENT_FILE="${EVENT_FILE:-/tmp/flywheel-cmux-events}"
CLEANUP_PENDING="${CLEANUP_PENDING:-/tmp/flywheel-cmux-cleanup-pending}"
STALE_STATE="${STALE_STATE:-/tmp/flywheel-cmux-stale.state}"
CLEANUP_DELAY_SECONDS="${FLYWHEEL_CMUX_CLEANUP_DELAY:-30}"
CONSERVATIVE_CLEANUP_SECONDS="${FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP:-300}"

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

is_pane_alive() {
  # FLY-102: Check whether the source pane for a given window name is still alive.
  # Since Runner and Lead both set `remain-on-exit on`, the tmux window persists
  # after the pane process dies (displaying exit code). We therefore cannot rely on
  # window existence — we must check #{pane_dead} on the source pane itself.
  # Returns 0 (alive) if at least one matching window has a live pane.
  # Returns 1 (dead / missing) otherwise.
  local wname="$1"
  local sessions
  sessions=$(get_tmux_agent_windows | grep "|${wname}\$" || true)
  [[ -z "$sessions" ]] && return 1

  while IFS='|' read -r sess wid name; do
    [[ -z "$sess" || -z "$name" ]] && continue
    local dead
    dead=$(tmux display-message -p -t "=${sess}:=${name}" "#{pane_dead}" 2>/dev/null || echo "1")
    if [[ "$dead" == "0" ]]; then
      return 0
    fi
  done <<< "$sessions"
  return 1
}

cleanup_workspace_for() {
  # FLY-102: Clean up a single cmux workspace + linked session by window name.
  # Extracted from cleanup_stale_workspaces so event-signaled cleanup can reuse it.
  # Safe to call even if workspace or linked session no longer exists.
  local agent_name="$1"
  local view_session="${VIEW_PREFIX}${agent_name}"

  # 1. Close cmux workspace (if it exists)
  local ws_ref
  ws_ref=$(get_workspace_ref_for "$agent_name")
  if [[ -n "$ws_ref" ]]; then
    cmux close-workspace --workspace "$ws_ref" 2>/dev/null || true
  fi

  # 2. Kill the linked session (never kill the source session)
  tmux kill-session -t "=$view_session" 2>/dev/null || true
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

  # 2. Select the target window in the linked session (by exact name, not ID)
  # FLY-98: use =name exact match to survive window ID changes across restarts
  tmux select-window -t "=${view_session}:=${window_name}" 2>/dev/null || true

  # 3. Snapshot workspace refs before creation
  local refs_before
  refs_before=$(get_all_workspace_refs)

  # 4. Create cmux workspace attaching to the linked session
  # FLY-98: protect against SIGPIPE/exit 141 when cmux is unavailable
  if ! cmux new-workspace --command "tmux attach -t '=${view_session}'" 2>/dev/null; then
    log "WARNING: cmux new-workspace failed for $window_name (cmux not running?)"
    return 0
  fi

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
      cleanup_workspace_for "$agent_name"
    fi
  done <<< "$linked_sessions"
}

refresh_linked_sessions() {
  # FLY-98: tmux-only repair — re-select correct window by name in existing linked sessions.
  # Safe to call from outside cmux (no cmux CLI dependency).
  # Fixes stale current-window pointers after Lead restart (window ID changed, name unchanged).
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0

  while IFS='|' read -r src_sess wid wname; do
    local view_session="${VIEW_PREFIX}${wname}"
    if linked_session_exists "$view_session"; then
      # Re-select window by exact name — idempotent, harmless if already correct
      tmux select-window -t "=${view_session}:=${wname}" 2>/dev/null || true
    fi
  done <<< "$tmux_windows"
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

# ── FLY-102: Event-Signaled Polling ──

register_session_hooks() {
  # Register per-session tmux hooks that write events to $EVENT_FILE.
  # Scope: flywheel (Leads) and runner-* (Runners) sessions only.
  # Idempotent: repeated registration overwrites the same array index [500].
  local session="$1"
  case "$session" in
    flywheel|runner-*) ;;
    *) return 0 ;;
  esac

  # after-new-window: fires when a new window is created in this session.
  # pane-exited: fires when the pane process exits (independent of remain-on-exit).
  # Array index [500] avoids overwriting other tools' hooks (unindexed set-hook
  # would clear the whole hook array in tmux 3.5a).
  # No $(date ...) inside the hook command string — it would be shell-expanded at
  # registration time. Timestamps are added when the watcher drains events.
  #
  # Variable names: use plain #{session_name} / #{window_id} / #{window_name}
  # rather than the #{hook_*} variants. In tmux 3.5a under `run-shell -b`, the
  # #{hook_session_name} / #{hook_window} / #{hook_window_name} vars expand to
  # EMPTY for after-new-window and pane-exited (even though the man page lists
  # them). The plain names correctly resolve to the session/window where the
  # hook fired. Empirically verified + enforced by integration test.
  tmux set-hook -t "$session" 'after-new-window[500]' \
    "run-shell -b 'echo \"create|#{session_name}|#{window_id}|#{window_name}\" >> $EVENT_FILE'" 2>/dev/null || true
  tmux set-hook -t "$session" 'pane-exited[500]' \
    "run-shell -b 'echo \"exited|#{session_name}|#{window_name}\" >> $EVENT_FILE'" 2>/dev/null || true
  log "Hooks registered on session: $session"
}

register_global_hooks() {
  # Global session-created hook fires for every new tmux session.
  # The watcher filters by name (only flywheel / runner-*) during event drain.
  # Use #{session_name} rather than #{hook_session_name} for consistency with
  # after-new-window / pane-exited (see register_session_hooks comment).
  tmux set-hook -g 'session-created[500]' \
    "run-shell -b 'echo \"register|#{session_name}\" >> $EVENT_FILE'" 2>/dev/null || true
}

register_hooks_on_new_sessions() {
  # Scan live sessions and register hooks on any flywheel/runner-* that lack them.
  # Called at startup and during each 60s additive poll as a safety net for
  # sessions that existed before the watcher started, or whose hooks were cleared.
  local sessions
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  [[ -z "$sessions" ]] && return 0

  while read -r sess; do
    case "$sess" in
      flywheel|runner-*) register_session_hooks "$sess" ;;
    esac
  done <<< "$sessions"
}

mark_for_cleanup() {
  # Record a window name as pending cleanup with the timestamp of the exit event.
  # Idempotent: only adds if no pending entry exists for this window name.
  local wname="$1" ts="$2"
  [[ -z "$wname" ]] && return 0
  touch "$CLEANUP_PENDING"
  grep -q "^${wname}|" "$CLEANUP_PENDING" 2>/dev/null || \
    echo "${wname}|${ts}" >> "$CLEANUP_PENDING"
}

process_pending_cleanups() {
  # Walk the cleanup-pending file. For each entry:
  #   - if the source pane is alive again → drop the entry (restart detected)
  #   - else if < CLEANUP_DELAY_SECONDS since exit → keep the entry
  #   - else → cleanup_workspace_for + drop the entry
  [[ ! -f "$CLEANUP_PENDING" ]] && return 0

  local now remaining=""
  now=$(date +%s)

  while IFS='|' read -r wname ts; do
    [[ -z "$wname" || -z "$ts" ]] && continue
    # Pane alive again → cancel cleanup. Uses #{pane_dead} (not window existence)
    # because `remain-on-exit on` means window lingers after pane dies.
    if is_pane_alive "$wname"; then
      continue
    fi
    # Still within delay window → keep entry for next tick
    if (( now - ts < CLEANUP_DELAY_SECONDS )); then
      remaining+="${wname}|${ts}"$'\n'
      continue
    fi
    # Delay elapsed + pane confirmed dead → clean up
    log "Event cleanup: '$wname' (exited $((now - ts))s ago)"
    cleanup_workspace_for "$wname"
  done < "$CLEANUP_PENDING"

  if [[ -n "$remaining" ]]; then
    printf '%s' "$remaining" > "$CLEANUP_PENDING"
  else
    rm -f "$CLEANUP_PENDING"
  fi
}

drain_events() {
  # Consume $EVENT_FILE: mv → read → process.
  # Hooks writing via `>>` are POSIX-atomic for writes smaller than PIPE_BUF,
  # so the worst a concurrent writer can do is put its event in the next batch.
  #
  # Crash recovery: if a previous drain was interrupted, $EVENT_FILE.processing
  # still holds unprocessed events. Replay it FIRST as its own batch, then do
  # the normal mv + drain for any current events. Processing leftover and live
  # events separately avoids the TOCTOU race where rebuilding $EVENT_FILE via
  # `cat ... > merged && mv merged $EVENT_FILE` would drop concurrent hook
  # appends that landed on the old inode between snapshot and mv (Codex Round 2).
  local tmp_events="${EVENT_FILE}.processing"

  # Phase 1 — crash recovery: drain the leftover .processing file if present.
  if [[ -f "$tmp_events" ]]; then
    _drain_file "$tmp_events"
    rm -f "$tmp_events"
  fi

  # Phase 2 — normal drain: atomically rename live event file, then drain it.
  [[ ! -f "$EVENT_FILE" ]] && return 0
  mv "$EVENT_FILE" "$tmp_events" 2>/dev/null || return 0
  _drain_file "$tmp_events"
  rm -f "$tmp_events"
}

_drain_file() {
  # Process every event line in a single frozen batch file. Factored out so
  # drain_events can reuse it for both crash-recovery replay and normal drain.
  local source_file="$1"
  [[ ! -f "$source_file" ]] && return 0

  # Generate the event timestamp at drain time. If we tried to embed $(date +%s)
  # in the hook command string, tmux/shell would evaluate it at registration
  # time, producing a fixed constant. Using drain-time ~ event-arrival-time is
  # acceptable: events drain within 15s of firing, and replay after crash still
  # assigns a meaningful (though slightly-late) timestamp.
  local now
  now=$(date +%s)

  while IFS='|' read -r etype arg1 arg2 arg3; do
    case "$etype" in
      create)
        local session="$arg1" wid="$arg2" wname="$arg3"
        [[ -z "$wname" ]] && continue
        # Skip default shell windows
        [[ "$wname" == "zsh" || "$wname" == "bash" ]] && continue
        # Only handle windows from flywheel/runner-* sessions
        case "$session" in
          flywheel|runner-*) ;;
          *) continue ;;
        esac
        if ! workspace_exists_for "$wname"; then
          create_workspace_for_window "$session" "$wid" "$wname"
        fi
        ;;
      exited)
        local session="$arg1" wname="$arg2"
        [[ -z "$wname" ]] && continue
        [[ "$wname" == "zsh" || "$wname" == "bash" ]] && continue
        case "$session" in
          flywheel|runner-*) ;;
          *) continue ;;
        esac
        mark_for_cleanup "$wname" "$now"
        ;;
      register)
        local session="$arg1"
        [[ -z "$session" ]] && continue
        register_session_hooks "$session"
        ;;
    esac
  done < "$source_file"
}

cleanup_stale_conservative() {
  # Polling fallback for cleanup. Cleans up a linked session after its source
  # pane has been dead (or its window missing) for CONSERVATIVE_CLEANUP_SECONDS
  # (default 5 minutes). This is belt-and-suspenders for event-drop scenarios.
  #
  # Uses is_pane_alive() rather than window-existence so it handles BOTH the
  # "window gone" case AND the "remain-on-exit on — window lingers with dead
  # pane" case. Without this, a lost `exited` event combined with remain-on-exit
  # would keep the corresponding cmux workspace / linked session alive forever.
  local linked_sessions
  linked_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${VIEW_PREFIX}" || true)
  [[ -z "$linked_sessions" ]] && return 0

  local now
  now=$(date +%s)
  touch "$STALE_STATE"

  while read -r sess; do
    local agent_name="${sess#${VIEW_PREFIX}}"
    if ! is_pane_alive "$agent_name"; then
      local first_stale
      first_stale=$(grep "^${agent_name}|" "$STALE_STATE" 2>/dev/null | cut -d'|' -f2 || true)
      if [[ -z "$first_stale" ]]; then
        echo "${agent_name}|${now}" >> "$STALE_STATE"
      elif (( now - first_stale >= CONSERVATIVE_CLEANUP_SECONDS )); then
        log "Conservative cleanup: $sess (stale for $((now - first_stale))s)"
        cleanup_workspace_for "$agent_name"
        sed -i '' "/^${agent_name}|/d" "$STALE_STATE" 2>/dev/null || true
      fi
    else
      # Pane is alive again → clear stale marker
      sed -i '' "/^${agent_name}|/d" "$STALE_STATE" 2>/dev/null || true
    fi
  done <<< "$linked_sessions"
}

sync_additive_bootstrap() {
  # Run once at `--watch` startup. Additive-only: never performs aggressive
  # cleanup. This prevents a watcher restart from killing healthy Runner
  # workspaces while the event file is empty.
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0

  # 1. Preserve FLY-98 reconcile repair: close broken workspaces (workspace
  #    exists but linked session is dead) so the create phase can rebuild.
  reconcile_existing_workspaces

  # 2. Refresh linked sessions — fix stale current-window pointers (FLY-98).
  refresh_linked_sessions

  # 3. Create missing workspaces. No cleanup of existing ones.
  while IFS='|' read -r src_sess wid wname; do
    if ! workspace_exists_for "$wname"; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done <<< "$tmux_windows"
}

sync_additive() {
  # Called every 60s. Mirrors bootstrap, plus conservative cleanup + hook
  # top-up for sessions that existed before the watcher started.
  register_hooks_on_new_sessions

  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  if [[ -z "$tmux_windows" ]]; then
    cleanup_stale_conservative
    return 0
  fi

  reconcile_existing_workspaces
  refresh_linked_sessions

  while IFS='|' read -r src_sess wid wname; do
    if ! workspace_exists_for "$wname"; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done <<< "$tmux_windows"

  cleanup_stale_conservative
}

watch_loop() {
  # Polling loop for --watch mode. Wrapped in a function so `local` is legal.
  local tick=0
  while true; do
    sleep 15
    tick=$((tick + 1))
    drain_events
    process_pending_cleanups
    if (( tick % 4 == 0 )); then
      sync_additive
    fi
  done
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

  # 2. Refresh linked sessions — fix stale current-window pointers (FLY-98)
  refresh_linked_sessions

  # 3. Create missing workspaces
  while IFS='|' read -r src_sess wid wname; do
    if workspace_exists_for "$wname"; then
      continue
    fi
    create_workspace_for_window "$src_sess" "$wid" "$wname"
  done <<< "$tmux_windows"

  # 4. Cleanup stale (dead windows → close workspace + kill linked session)
  cleanup_stale_workspaces
}

# ── Main ──
# Guard: only run the case dispatcher when invoked directly (not sourced for tests).
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0 2>/dev/null || true
fi

case "${1:-}" in
  --watch)
    log "Watch mode: event-signaled polling (${CLEANUP_DELAY_SECONDS}s cleanup delay, ${CONSERVATIVE_CLEANUP_SECONDS}s conservative cleanup)"
    # 1. Install hooks (global + per-session)
    register_global_hooks
    register_hooks_on_new_sessions
    # 2. Additive-only bootstrap — never do aggressive cleanup on startup
    sync_additive_bootstrap
    # 3. Polling loop:
    #    - every 15s: drain events + process pending cleanups
    #    - every 60s (tick % 4): additive scan + conservative stale cleanup
    watch_loop
    ;;
  --refresh)
    # FLY-98: tmux-only repair — safe to call from outside cmux
    refresh_linked_sessions
    ;;
  --once|"")
    sync_once
    ;;
  *)
    echo "Usage: flywheel-cmux-sync [--once|--watch|--refresh]"
    echo "  --once    Full sync with aggressive cleanup (cmux + tmux). Manual use from inside cmux."
    echo "  --watch   Event-signaled polling (hooks + 15s drain + 60s additive). From inside cmux."
    echo "  --refresh tmux-only linked session repair. Safe from anywhere."
    exit 1
    ;;
esac
