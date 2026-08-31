#!/bin/bash
# FLY-102: Tests for flywheel-cmux-sync.sh event-signaled polling logic.
# Runs: /bin/bash scripts/test-cmux-sync.sh
#
# FLY-129 Phase 1 (R2-8): explicit `#!/bin/bash` (not `/usr/bin/env bash`).
# Production cmux watcher runs under macOS `/bin/bash` 3.2; a local invocation
# under Homebrew bash 4+ would mask bash-3.2-incompatible constructs (declare
# -A, BASHPID, etc.). The default preflight therefore still requires 3.2.
# Linux CI additionally runs the same behavior matrix under its system Bash via
# an explicit compatibility-pass opt-in; local release verification MUST keep
# running this file once through /bin/bash without that opt-in.

case "${BASH_VERSION:-}" in
  3.2*) ;;
  *)
    if [[ "${FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH:-0}" != "1" ]]; then
      echo "test-cmux-sync.sh requires /bin/bash 3.2 (macOS system bash)" >&2
      echo "  detected: BASH_VERSION=${BASH_VERSION:-<unset>}" >&2
      echo "  run as: /bin/bash $0" >&2
      exit 1
    fi
    echo "[TEST] modern-Bash compatibility pass: ${BASH_VERSION:-<unset>}" >&2
    ;;
esac
#
# Strategy: source the script (guarded against main dispatcher), then override
# tmux/cmux with bash functions so we can exercise the logic without touching
# real tmux sessions or a real cmux instance.
set -uo pipefail  # not -e: we want to keep going on test failures

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export FLYWHEEL_CMUX_VIEW_HELPER_BIN="$SCRIPT_DIR/flywheel-view-attach.sh"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# Isolate file-based state in a tempdir
TMPDIR_ROOT=$(mktemp -d)
TMUX_INT_SOCKET=""
export FLYWHEEL_LEAD_PLIST_DIR="$TMPDIR_ROOT/lead-plists"
export FLYWHEEL_MANIFEST_DIR="$TMPDIR_ROOT/manifests"
mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
cleanup_test_state() {
  if [[ -n "$TMUX_INT_SOCKET" ]] && command -v tmux >/dev/null 2>&1; then
    command tmux -S "$TMUX_INT_SOCKET" kill-server 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup_test_state EXIT

export EVENT_FILE="$TMPDIR_ROOT/events"
export CLEANUP_PENDING="$TMPDIR_ROOT/cleanup-pending"
export STALE_STATE="$TMPDIR_ROOT/stale.state"
export HEAL_STATE="$TMPDIR_ROOT/heal.state"  # FLY-169
export ATTACH_HEAL_STATE="$TMPDIR_ROOT/attach-heal.state"  # FLY-1884
export CREATE_STATE="$TMPDIR_ROOT/create.state"  # FLY-825
export CMUX_SOCK_IDENT_FILE="$TMPDIR_ROOT/sock-ident"  # FLY-254
export ORPHAN_PIN_STATE="$TMPDIR_ROOT/orphan-pin.state"  # FLY-293
export ADOPTION_STATE="$TMPDIR_ROOT/adoption.state"  # FLY-1364 R6
export FLYWHEEL_CMUX_CLOSE_REQUEST_FILE="$TMPDIR_ROOT/close-requested"  # FLY-685
export HUSK_STATE="$TMPDIR_ROOT/husk.state"  # FLY-867
export VIEW_WAL_DIR="$TMPDIR_ROOT/view-wal"  # FLY-1272
export VIEW_LEDGER="$TMPDIR_ROOT/view-ledger"  # FLY-1272
export KEEPER_INVENTORY="$TMPDIR_ROOT/keeper-inventory"  # FLY-1272
export RESTORED_STATE="$TMPDIR_ROOT/restored-adoption"  # FLY-1596
export VIEW_ABSENT_STATE="$TMPDIR_ROOT/view-absent.state"  # FLY-1272
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMPDIR_ROOT/cmux-maintenance"  # FLY-1272
export FLYWHEEL_CMUX_WATCHER_HEARTBEAT="$TMPDIR_ROOT/cmux-watcher-heartbeat"  # FLY-1944
export FLYWHEEL_CMUX_REBUILD_REPORT_DIR="$TMPDIR_ROOT/cmux-rebuild-reports"  # FLY-1596
export FLYWHEEL_CMUX_SESSION_STATE="$TMPDIR_ROOT/cmux-session.json"  # FLY-1944 birth evidence
export CMUX_ADOPT_CAP_STATE="$TMPDIR_ROOT/cmux-adopt-cap"  # FLY-1944 bounded birth adoption
export LEDGER_CONFLICT_STATE="$TMPDIR_ROOT/ledger-conflict.state"  # FLY-1446
export ROSTER_EPISODE_STATE="$TMPDIR_ROOT/roster-episodes.state"  # FLY-1446
export CMUX_LOG_EPISODE_STATE="$TMPDIR_ROOT/cmux-log-episodes.state"  # FLY-1596
export PREPARED_STALL_STATE="$TMPDIR_ROOT/prepared-stall.state"  # FLY-1884
export CMUX_ADDITIVE_ROUND_STATE="$TMPDIR_ROOT/cmux-additive-round.state"  # FLY-1884
export NODE_LEDGER="$TMPDIR_ROOT/cmux-node-ledger"  # FLY-2102: node presence is always on
export NODE_REGISTRY="$TMPDIR_ROOT/cmux-node-registry"  # FLY-2102
export NODE_STATUS_DIR="$TMPDIR_ROOT/cmux-node-status"  # FLY-2102
export CLEANUP_SNAPSHOT="$TMPDIR_ROOT/cmux-cleanup-snapshot"  # FLY-2102
export FLYWHEEL_CMUX_TMUX_GENERATION="tmux-test-generation"  # FLY-1272
export FLYWHEEL_CMUX_CLEANUP_DELAY=30
export FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP=300

# FLY-129 Phase 1: tests must not touch the real /tmp watcher lock.
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMPDIR_ROOT/watcher.lock"
# Never let unit fixtures reach the resident alert channel. Individual alert
# tests override FLYWHEEL_ALERT_BIN with their own capture executable.
export FLYWHEEL_CMUX_ALERT_BIN="/usr/bin/true"
# Production resolves cmux as an executable. The broad legacy harness uses a
# shell function whose in-process mutation trace is itself under assertion;
# keep that explicit seam synchronous. FLY-1944 timeout coverage below unsets
# the function and exercises a real fixture process group.
export FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS=1

# ════════════════════════════════════════════════════════════════
# Mocks for tmux and cmux
# ════════════════════════════════════════════════════════════════
MOCK_TMUX_WINDOWS=""       # lines of session|wid|wname
MOCK_PANE_DEAD=""          # lines of session:wname=0|1
MOCK_CMUX_WORKSPACES=""    # cmux list-workspaces output (legacy text)
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'  # FLY-129 Phase 3: cmux --json list-workspaces output
MOCK_CMUX_JSON_FAIL="0"    # FLY-129 Phase 3: 1 = simulate JSON failure (rc=1 from cmux)
MOCK_CMUX_JSON_INVALID="0" # FLY-129 Phase 3: 1 = return invalid JSON (parse failure)
MOCK_TMUX_SESSIONS=""      # list-sessions output
MOCK_TMUX_HOOKS=""         # captured set-hook invocations
MOCK_CMUX_OPS=""           # captured cmux operations
MOCK_TMUX_KILLED=""        # captured tmux kill-session targets
MOCK_TMUX_KILLED_WINDOWS="" # FLY-867: captured tmux kill-window targets
MOCK_PGREP_HIT="0"         # FLY-129 Phase 1: pgrep mock — 1 = watcher running, 0 = not
MOCK_MUTATOR_CENSUS=""     # lines "pid|command" for R6 lease fallback census
MOCK_MUTATOR_CENSUS_FAIL="0"
MOCK_MUTATOR_CENSUS_SEQ="" # per-call rows; __EMPTY__ represents a conclusive empty snapshot
MOCK_PROCESS_COMMANDS=""   # lines "pid|command" for raw owner candidate checks
MOCK_SHOW_HOOKS=""         # FLY-129 Phase 2: tmux show-hooks output — lines of "<hook>[idx] ..." per session
MOCK_CMUX_MUTATE_JSON="0"  # FLY-1272: opt-in mutation-faithful workspace model
MOCK_CMUX_MUTATE_SURFACES="0" # FLY-1605: opt-in mutation-faithful tab-title model
MOCK_PS_MODE=""             # FLY-1605: hermetic timezone-sensitive lstart seam
MOCK_TMUX_SERVER_PID="4242"
MOCK_TMUX_SOCKET_PATH="$TMPDIR_ROOT/mock-tmux.sock"
MOCK_PRIVATE_TMUX_SOCKET=""
MOCK_PRIVATE_TMUX_SESSION="1"
MOCK_PRIVATE_TMUX_CLIENTS="1"

# FLY-1272 P0: opt-in, file-backed tmux topology model. The linked-view
# state machine performs tmux reads inside command substitutions, so ordinary
# shell globals cannot faithfully carry mutations back to the parent shell.
# Files are the oracle here, matching the production process boundary.
MOCK_TOPOLOGY_MODE="0"
TOPO_SESSIONS="$TMPDIR_ROOT/topology.sessions" # name|session_id|group|owner|marker
TOPO_WINDOWS="$TMPDIR_ROOT/topology.windows"   # session|window_id|name|active|pane_dead
TOPO_JOURNAL="$TMPDIR_ROOT/topology.journal"

topo_reset() {
  : > "$TOPO_SESSIONS"
  : > "$TOPO_WINDOWS"
  : > "$TOPO_JOURNAL"
  echo 100 > "$TMPDIR_ROOT/topology.next-session"
  echo 1000 > "$TMPDIR_ROOT/topology.next-window"
}

topo_add_session() {
  local name="$1" sid="$2" group="${3:-}" owner="${4:-}" marker="${5:-}"
  printf '%s|%s|%s|%s|%s\n' "$name" "$sid" "$group" "$owner" "$marker" >> "$TOPO_SESSIONS"
}

topo_add_window() {
  local session="$1" wid="$2" name="$3" active="${4:-0}" dead="${5:-0}"
  printf '%s|%s|%s|%s|%s\n' "$session" "$wid" "$name" "$active" "$dead" >> "$TOPO_WINDOWS"
}

topo_session_exists() {
  awk -F'|' -v s="$1" '$1 == s { found=1 } END { exit(found ? 0 : 1) }' "$TOPO_SESSIONS"
}

topo_session_field() {
  local name="$1" field="$2"
  awk -F'|' -v s="$name" -v f="$field" '$1 == s { print $f; exit }' "$TOPO_SESSIONS"
}

topo_set_session_field() {
  local name="$1" field="$2" value="$3" tmp="$TOPO_SESSIONS.tmp"
  awk -F'|' -v OFS='|' -v s="$name" -v f="$field" -v v="$value" '$1 == s { $f=v } { print }' "$TOPO_SESSIONS" > "$tmp"
  mv "$tmp" "$TOPO_SESSIONS"
}

topo_alloc_id() {
  local file="$1" prefix="$2" n
  n=$(cat "$file")
  echo $((n + 1)) > "$file"
  printf '%s%s' "$prefix" "$n"
}

topo_target_parts() {
  local clean="${1#=}"
  TOPO_TARGET_SESSION="${clean%%:*}"
  TOPO_TARGET_WINDOW=""
  [[ "$clean" == *:* ]] && TOPO_TARGET_WINDOW="${clean#*:}"
  TOPO_TARGET_WINDOW="${TOPO_TARGET_WINDOW#=}"
}

topo_window_row() {
  local session="$1" target="$2"
  awk -F'|' -v s="$session" -v t="$target" '$1 == s && ($2 == t || $3 == t) { print; exit }' "$TOPO_WINDOWS"
}

topo_remove_session() {
  local session="$1" tmp
  tmp="$TOPO_SESSIONS.tmp"; awk -F'|' -v s="$session" '$1 != s' "$TOPO_SESSIONS" > "$tmp"; mv "$tmp" "$TOPO_SESSIONS"
  tmp="$TOPO_WINDOWS.tmp"; awk -F'|' -v s="$session" '$1 != s' "$TOPO_WINDOWS" > "$tmp"; mv "$tmp" "$TOPO_WINDOWS"
}

topo_tmux() {
  local command="$1"; shift
  printf '%s %s\n' "$command" "$*" >> "$TOPO_JOURNAL"
  case "$command" in
    list-sessions)
      [[ "${MOCK_TMUX_LIST_FAIL:-0}" == "1" ]] && return 1
      local fmt='#{session_name}' filter="" session name sid group owner marker grouped
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -F) fmt="$2"; shift 2 ;;
          -f) filter="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      while IFS='|' read -r name sid group owner marker; do
        [[ -z "$name" ]] && continue
        if [[ -n "$filter" ]]; then
          session=$(printf '%s' "$filter" | sed -n 's/.*session_name},\([^}]*\)}.*/\1/p')
          [[ -n "$session" && "$name" != "$session" ]] && continue
        fi
        [[ -n "$group" ]] && grouped=1 || grouped=0
        case "$fmt" in
          '#{session_name}') printf '%s\n' "$name" ;;
          '#{session_group}') printf '%s\n' "$group" ;;
          '#{session_id}') printf '%s\n' "$sid" ;;
          '#{session_id}|#{session_name}|#{session_grouped}|#{session_group}|#{@flywheel_cmux_owner}|#{@flywheel_cmux_placeholder}')
            printf '%s|%s|%s|%s|%s|%s\n' "$sid" "$name" "$grouped" "$group" "$owner" "$marker" ;;
          *) printf '%s\n' "$name" ;;
        esac
      done < "$TOPO_SESSIONS"
      ;;
    list-windows)
      [[ "${MOCK_TMUX_LISTWINDOWS_FAIL:-0}" == "1" ]] && return 1
      local target="" fmt='#{session_name}|#{window_id}|#{window_name}'
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) target="${2#=}"; shift 2 ;;
          -F) fmt="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      target="${target%:}"
      topo_session_exists "$target" || return 1
      local session wid wname active dead
      while IFS='|' read -r session wid wname active dead; do
        [[ "$session" != "$target" ]] && continue
        case "$fmt" in
          '#{window_id}') printf '%s\n' "$wid" ;;
          '#{window_name}') printf '%s\n' "$wname" ;;
          '#{window_id}|#{window_name}') printf '%s|%s\n' "$wid" "$wname" ;;
          '#{window_id}|#{window_name}|#{window_active}|#{pane_dead}') printf '%s|%s|%s|%s\n' "$wid" "$wname" "$active" "$dead" ;;
          '#{session_name}|#{window_id}|#{window_name}|#{pane_dead}') printf '%s|%s|%s|%s\n' "$session" "$wid" "$wname" "$dead" ;;
          *) printf '%s|%s|%s\n' "$session" "$wid" "$wname" ;;
        esac
      done < "$TOPO_WINDOWS"
      ;;
    has-session)
      local target=""
      while [[ $# -gt 0 ]]; do
        case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
      done
      topo_session_exists "$target"
      ;;
    new-session)
      local name="" grouped_source="" window_name="zsh" sid wid group=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -s) name="$2"; shift 2 ;;
          -t) grouped_source="${2#=}"; shift 2 ;;
          -n) window_name="$2"; shift 2 ;;
          -d|-P) shift ;;
          -F) shift 2 ;;
          *) shift ;;
        esac
      done
      [[ -n "$name" ]] || return 1
      topo_session_exists "$name" && return 1
      sid=$(topo_alloc_id "$TMPDIR_ROOT/topology.next-session" '$')
      if [[ -n "$grouped_source" ]]; then
        topo_session_exists "$grouped_source" || return 1
        group="$grouped_source"
        topo_add_session "$name" "$sid" "$group"
        : > "$TOPO_WINDOWS.tmp"
        awk -F'|' -v OFS='|' -v src="$grouped_source" -v dst="$name" '$1 == src { $1=dst; print }' "$TOPO_WINDOWS" >> "$TOPO_WINDOWS.tmp"
        cat "$TOPO_WINDOWS.tmp" >> "$TOPO_WINDOWS"; rm -f "$TOPO_WINDOWS.tmp"
      else
        wid=$(topo_alloc_id "$TMPDIR_ROOT/topology.next-window" '@')
        topo_add_session "$name" "$sid"
        topo_add_window "$name" "$wid" "$window_name" 1 0
      fi
      ;;
    set-option)
      local target="" option="" value=""
      while [[ $# -gt 0 ]]; do
        case "$1" in -t) target="${2#=}"; shift 2 ;; @*) option="$1"; value="$2"; shift 2 ;; *) shift ;; esac
      done
      target="${target%:}"
      topo_session_exists "$target" || return 1
      case "$option" in @flywheel_cmux_owner) topo_set_session_field "$target" 4 "$value" ;; @flywheel_cmux_placeholder) topo_set_session_field "$target" 5 "$value" ;; esac
      if [[ -n "${MOCK_TMUX_GENERATION_FLIP_AFTER_SET_OPTION:-}" ]]; then
        printf '%s' "$MOCK_TMUX_GENERATION_FLIP_AFTER_SET_OPTION" > "$TMPDIR_ROOT/tmux-generation.override"
      fi
      ;;
    show-options)
      local target="" option=""
      while [[ $# -gt 0 ]]; do
        case "$1" in -t) target="${2#=}"; shift 2 ;; -v) shift ;; @*) option="$1"; shift ;; *) shift ;; esac
      done
      target="${target%:}"
      topo_session_exists "$target" || return 1
      case "$option" in @flywheel_cmux_owner) topo_session_field "$target" 4 ;; @flywheel_cmux_placeholder) topo_session_field "$target" 5 ;; esac
      ;;
    display-message)
      [[ "${MOCK_TMUX_DISPLAY_FAIL:-0}" == "1" ]] && return 1
      local target="" fmt="" row session wid wname active dead sid group owner marker grouped
      while [[ $# -gt 0 ]]; do
        case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
      done
      case "$fmt" in
        '#{pid}') printf '%s\n' "$MOCK_TMUX_SERVER_PID"; return 0 ;;
        '#{socket_path}') printf '%s\n' "$MOCK_TMUX_SOCKET_PATH"; return 0 ;;
      esac
      topo_target_parts "$target"; session="$TOPO_TARGET_SESSION"
      if ! topo_session_exists "$session"; then
        if [[ "$session" == "${MOCK_TMUX_GENERATION_FLIP_ON_MISSING_SESSION:-}" ]]; then
          printf '%s' "${MOCK_TMUX_GENERATION_FLIP_VALUE:-tmux-generation-b}" \
            > "$TMPDIR_ROOT/tmux-generation.override"
        fi
        return 1
      fi
      sid=$(topo_session_field "$session" 2); group=$(topo_session_field "$session" 3); owner=$(topo_session_field "$session" 4); marker=$(topo_session_field "$session" 5)
      [[ -n "$group" ]] && grouped=1 || grouped=0
      if [[ -n "$TOPO_TARGET_WINDOW" ]]; then
        row=$(topo_window_row "$session" "$TOPO_TARGET_WINDOW")
        # tmux 3.5a resolves a vanished id to the session's active window.
        if [[ -z "$row" ]]; then
          row=$(awk -F'|' -v s="$session" '$1 == s && $4 == 1 { print; exit }' "$TOPO_WINDOWS")
        fi
      else
        row=$(awk -F'|' -v s="$session" '$1 == s && $4 == 1 { print; exit }' "$TOPO_WINDOWS")
      fi
      IFS='|' read -r _ wid wname active dead <<< "$row"
      case "$fmt" in
        '#{pane_dead}') printf '%s\n' "$dead" ;;
        '#{window_name}') printf '%s\n' "$wname" ;;
        '#{window_name}|#{pane_dead}') printf '%s|%s\n' "$wname" "$dead" ;;
        '#{session_id}') printf '%s\n' "$sid" ;;
        '#{session_grouped}') printf '%s\n' "$grouped" ;;
        '#{session_group}') printf '%s\n' "$group" ;;
        '#{window_id}') printf '%s\n' "$wid" ;;
        '#{window_id}|#{pane_dead}') printf '%s|%s\n' "$wid" "$dead" ;;
        '#{session_id}|#{session_grouped}|#{window_id}|#{@flywheel_cmux_owner}|#{@flywheel_cmux_placeholder}') printf '%s|%s|%s|%s|%s\n' "$sid" "$grouped" "$wid" "$owner" "$marker" ;;
        *) printf '%s\n' "$wname" ;;
      esac
      if [[ "$fmt" == '#{session_id}|#{session_grouped}|#{window_id}|#{@flywheel_cmux_owner}|#{@flywheel_cmux_placeholder}' \
          && "$session" == "${MOCK_TMUX_GENERATION_FLIP_AFTER_SNAPSHOT_SESSION:-}" ]]; then
        printf '%s' "${MOCK_TMUX_GENERATION_FLIP_VALUE:-tmux-generation-b}" \
          > "$TMPDIR_ROOT/tmux-generation.override"
      fi
      if [[ "$fmt" == '#{window_name}|#{pane_dead}' \
          && -n "${MOCK_TMUX_REUSE_SESSION_AFTER_WINDOW_PROBE:-}" ]]; then
        local reuse_name="${MOCK_TMUX_REUSE_SESSION_AFTER_WINDOW_PROBE%%|*}"
        local reuse_sid="${MOCK_TMUX_REUSE_SESSION_AFTER_WINDOW_PROBE#*|}"
        if [[ "$session" == "$reuse_name" ]]; then
          topo_set_session_field "$session" 2 "$reuse_sid"
          MOCK_TMUX_REUSE_SESSION_AFTER_WINDOW_PROBE=""
        fi
      fi
      ;;
    link-window)
      [[ "${MOCK_TOPO_LINK_FAIL:-0}" == "1" ]] && return 1
      local source="" target="" row dst src_session src_window
      while [[ $# -gt 0 ]]; do
        case "$1" in -s) source="$2"; shift 2 ;; -t) target="$2"; shift 2 ;; *) shift ;; esac
      done
      topo_target_parts "$source"; src_session="$TOPO_TARGET_SESSION"; src_window="$TOPO_TARGET_WINDOW"
      row=$(topo_window_row "$src_session" "$src_window") || return 1
      topo_target_parts "$target"; dst="$TOPO_TARGET_SESSION"
      topo_session_exists "$dst" || return 1
      IFS='|' read -r _ wid wname _ dead <<< "$row"
      topo_add_window "$dst" "$wid" "$wname" 0 "$dead"
      ;;
    select-window)
      [[ "${MOCK_TMUX_SELECT_FAIL:-0}" == "1" ]] && return 1
      local target="" tmp row session window
      while [[ $# -gt 0 ]]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
      topo_target_parts "$target"; session="$TOPO_TARGET_SESSION"; window="$TOPO_TARGET_WINDOW"
      row=$(topo_window_row "$session" "$window") || return 1
      window=$(printf '%s' "$row" | cut -d'|' -f2)
      MOCK_TMUX_SELECTS+="$target"$'\n'
      tmp="$TOPO_WINDOWS.tmp"
      awk -F'|' -v OFS='|' -v s="$session" -v w="$window" '$1 == s { $4=($2 == w ? 1 : 0) } { print }' "$TOPO_WINDOWS" > "$tmp"; mv "$tmp" "$TOPO_WINDOWS"
      ;;
    unlink-window)
      [[ "${MOCK_TOPO_UNLINK_FAIL:-0}" == "1" ]] && return 1
      local target="" row session window refs tmp
      while [[ $# -gt 0 ]]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
      topo_target_parts "$target"; session="$TOPO_TARGET_SESSION"; window="$TOPO_TARGET_WINDOW"
      row=$(topo_window_row "$session" "$window") || return 1
      window=$(printf '%s' "$row" | cut -d'|' -f2)
      refs=$(awk -F'|' -v w="$window" '$2 == w { n++ } END { print n+0 }' "$TOPO_WINDOWS")
      [[ "$refs" -le 1 ]] && return 1
      tmp="$TOPO_WINDOWS.tmp"; awk -F'|' -v s="$session" -v w="$window" '!($1 == s && $2 == w)' "$TOPO_WINDOWS" > "$tmp"; mv "$tmp" "$TOPO_WINDOWS"
      if ! awk -F'|' -v s="$session" '$1 == s { found=1 } END { exit(found ? 0 : 1) }' "$TOPO_WINDOWS"; then
        tmp="$TOPO_SESSIONS.tmp"; awk -F'|' -v s="$session" '$1 != s' "$TOPO_SESSIONS" > "$tmp"; mv "$tmp" "$TOPO_SESSIONS"
      fi
      ;;
    kill-window)
      local target="" row session window tmp
      while [[ $# -gt 0 ]]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
      topo_target_parts "$target"; session="$TOPO_TARGET_SESSION"; window="$TOPO_TARGET_WINDOW"
      row=$(topo_window_row "$session" "$window") || return 1
      window=$(printf '%s' "$row" | cut -d'|' -f2)
      MOCK_TMUX_KILLED_WINDOWS+="$target"$'\n'
      tmp="$TOPO_WINDOWS.tmp"; awk -F'|' -v w="$window" '$2 != w' "$TOPO_WINDOWS" > "$tmp"; mv "$tmp" "$TOPO_WINDOWS"
      ;;
    kill-session)
      local target=""; while [[ $# -gt 0 ]]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
      topo_session_exists "$target" || return 1
      MOCK_TMUX_KILLED+="=$target"$'\n'
      topo_remove_session "$target"
      ;;
    set-hook)
      MOCK_TMUX_HOOKS+="$*"$'\n'
      ;;
    show-hooks)
      printf '%s' "$MOCK_SHOW_HOOKS"
      ;;
    rename-session)
      [[ "${MOCK_TOPO_RENAME_FAIL:-0}" == "1" ]] && return 1
      local source="" target="" tmp
      while [[ $# -gt 0 ]]; do case "$1" in -t) source="${2#=}"; shift 2 ;; *) target="$1"; shift ;; esac; done
      topo_session_exists "$source" || return 1
      topo_session_exists "$target" && return 1
      tmp="$TOPO_SESSIONS.tmp"; awk -F'|' -v OFS='|' -v s="$source" -v t="$target" '$1 == s { $1=t } { print }' "$TOPO_SESSIONS" > "$tmp"; mv "$tmp" "$TOPO_SESSIONS"
      tmp="$TOPO_WINDOWS.tmp"; awk -F'|' -v OFS='|' -v s="$source" -v t="$target" '$1 == s { $1=t } { print }' "$TOPO_WINDOWS" > "$tmp"; mv "$tmp" "$TOPO_WINDOWS"
      [[ "${MOCK_TOPO_RENAME_OUTPUT_LOST:-0}" == "1" ]] && return 1
      return 0
      ;;
    list-clients)
      local target="" spec cnt_file n=0 val j=1
      while [[ $# -gt 0 ]]; do
        case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac
      done
      target="${target#=}"
      spec=$(echo "$MOCK_TMUX_CLIENTS" | awk -F= -v k="$target" '$1==k{print $2; f=1} END{if(!f) print "__ERR__"}')
      [[ "$spec" == "__ERR__" ]] && return 1
      cnt_file="$TMPDIR_ROOT/clients.$(echo "$target" | tr -c 'A-Za-z0-9_.-' '_').n"
      [[ -f "$cnt_file" ]] && n=$(cat "$cnt_file")
      n=$((n + 1)); echo "$n" > "$cnt_file"
      val=$(echo "$spec" | awk -F, -v i="$n" '{ if (i>NF) i=NF; print $i }')
      [[ "$val" == "ERR" ]] && return 1
      while [[ $j -le ${val:-0} ]]; do echo "client$j"; j=$((j + 1)); done
      return 0
      ;;
    *) return 0 ;;
  esac
}

# Pre-FLY-1272 tests describe tmux through MOCK_TMUX_* rows. Convert that
# description once per test into the independent, one-window topology that is
# now unconditional in production. Tests which exercise topology transitions
# directly continue to opt into MOCK_TOPOLOGY_MODE=1 and build their own rows.
seed_fixed_topology_fixture() {
  local seeded="$TMPDIR_ROOT/fixed-topology.seeded"
  [[ -e "$seeded" ]] && return 0
  : > "$seeded"

  local session sid=1 wid name active dead source title view_sid=1000
  while IFS= read -r session; do
    [[ -n "$session" && "$session" != cmux-* ]] || continue
    topo_session_exists "$session" || topo_add_session "$session" "\$$sid"
    sid=$((sid + 1))
  done < <({ printf '%s\n' "$MOCK_TMUX_SESSIONS"; printf '%s\n' "$MOCK_TMUX_WINDOWS" | cut -d'|' -f1; } | awk 'NF && !seen[$0]++')

  while IFS='|' read -r session wid name; do
    [[ -n "$session" && -n "$wid" && -n "$name" ]] || continue
    [[ "$session" != cmux-* ]] || continue
    topo_session_exists "$session" || { topo_add_session "$session" "\$$sid"; sid=$((sid + 1)); }
    active=0
    awk -F'|' -v s="$session" '$1 == s { found=1 } END { exit(found ? 0 : 1) }' "$TOPO_WINDOWS" || active=1
    dead=$(printf '%s\n' "$MOCK_PANE_DEAD" | awk -F= \
      -v k1="${session}:${wid}" -v k2="${session}:${name}" \
      '$1 == k1 || $1 == k2 { print $2; found=1; exit } END { if (!found) print "0" }')
    topo_add_window "$session" "$wid" "$name" "$active" "$dead"
  done <<< "$MOCK_TMUX_WINDOWS"

  while IFS= read -r session; do
    [[ "$session" == cmux-* ]] || continue
    title=${session#cmux-}
    IFS='|' read -r source wid name < <(printf '%s\n' "$MOCK_TMUX_WINDOWS" | awk -F'|' -v t="$title" '$3 == t { print; exit }')
    if [[ -z "$source" || -z "$wid" ]]; then
      source="runner-fixture"
      wid="@${view_sid}"
    fi
    topo_add_session "$session" "\$$view_sid" "" "$source" "0"
    view_sid=$((view_sid + 1))
    dead=$(printf '%s\n' "$MOCK_PANE_DEAD" | awk -F= \
      -v k1="${source}:${wid}" -v k2="${source}:${title}" \
      '$1 == k1 || $1 == k2 { print $2; found=1; exit } END { if (!found) print "0" }')
    topo_add_window "$session" "$wid" "$title" 1 "$dead"
  done <<< "$MOCK_TMUX_SESSIONS"
}

sync_fixed_topology_dynamics() {
  [[ "$MOCK_TOPOLOGY_MODE" == "compat" && -e "$TMPDIR_ROOT/fixed-topology.seeded" ]] || return 0
  local row session target dead tmp="$TOPO_WINDOWS.tmp"
  while IFS= read -r row; do
    [[ "$row" == *=* ]] || continue
    session=${row%%:*}
    target=${row#*:}; target=${target%%=*}
    dead=${row##*=}
    awk -F'|' -v OFS='|' -v s="$session" -v t="$target" -v d="$dead" \
      '$1 == s && ($2 == t || $3 == t) { $5=d } { print }' \
      "$TOPO_WINDOWS" > "$tmp"
    mv "$tmp" "$TOPO_WINDOWS"
  done <<< "$MOCK_PANE_DEAD"
}

tmux() {
  if [[ "${1:-}" == "-S" && -n "${MOCK_PRIVATE_TMUX_SOCKET:-}" ]]; then
    local private_socket="$2"
    shift 2
    [[ "$private_socket" == "$MOCK_PRIVATE_TMUX_SOCKET" ]] || return 1
    case "${1:-}" in
      has-session) [[ "$MOCK_PRIVATE_TMUX_SESSION" == 1 ]] ;;
      list-panes) printf '%%0|main|0|4242\n' ;;
      list-clients)
        local private_i=1
        while [[ "$private_i" -le "${MOCK_PRIVATE_TMUX_CLIENTS:-0}" ]]; do
          printf 'private-client-%s\n' "$private_i"
          private_i=$((private_i + 1))
        done
        ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [[ "${MOCK_TOPOLOGY_MODE:-0}" == "compat" ]]; then
    seed_fixed_topology_fixture
    sync_fixed_topology_dynamics
  fi
  if [[ "${MOCK_TOPOLOGY_MODE:-0}" == "1" || "${MOCK_TOPOLOGY_MODE:-0}" == "compat" ]]; then
    topo_tmux "$@"
    return $?
  fi
  case "$1" in
    list-windows)
      # FLY-293: simulate per-session list-windows failure (strict-inventory tests).
      [[ "${MOCK_TMUX_LISTWINDOWS_FAIL:-0}" == "1" ]] && return 1
      shift
      # args are like: -t session -F format
      local session="" fmt=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) session="$2"; shift 2 ;;
          -F) fmt="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      session="${session#=}"
      # FLY-129 Phase 8: honor common -F format strings used by callers.
      # The MOCK_TMUX_WINDOWS row is "session|window_id|window_name"; map
      # the format to the requested projection.
      case "$fmt" in
        '#{window_name}')
          echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" '$1 == s { print $3 }' || true
          ;;
        ''|'#{session_name}|#{window_id}|#{window_name}'|*)
          echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" '$1 == s' || true
          ;;
      esac
      ;;
    list-sessions)
      # FLY-293: simulate tmux server down / probe failure (fail-closed tests).
      [[ "${MOCK_TMUX_LIST_FAIL:-0}" == "1" ]] && return 1
      # Older fixtures populated only MOCK_TMUX_WINDOWS. Infer those source
      # sessions as real tmux would, while preserving explicitly listed
      # windowless/view sessions.
      { printf '%s\n' "$MOCK_TMUX_SESSIONS"; printf '%s\n' "$MOCK_TMUX_WINDOWS" | cut -d'|' -f1; } \
        | awk 'NF && !seen[$0]++'
      ;;
    has-session)
      # Parse the -t target properly (callers pass `has-session -t "=name"`).
      # FLY-169: the old `${2#=}` read "-t" literally, so linked_session_exists
      # always returned false. Only linked_session_exists calls this, and no
      # test exercised it before FLY-169, so correct parsing is safe.
      shift
      local target=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) target="${2#=}"; shift 2 ;;
          *) shift ;;
        esac
      done
      echo "$MOCK_TMUX_SESSIONS" | grep -qx "$target"
      ;;
    display-message)
      # FLY-867: simulate display-message failure (husk-reaper probe fail-closed test).
      [[ "${MOCK_TMUX_DISPLAY_FAIL:-0}" == "1" ]] && return 1
      # args: -p -t target format
      local target="" fmt=""
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -p|-F) shift ;;
          -t) target="$2"; shift 2 ;;
          *) fmt="$1"; shift ;;
        esac
      done
      # target like =session:=wname
      local clean="${target//=/}"
      local session="${clean%%:*}"
      local wname="${clean##*:}"
      local original_target="$wname"
      local resolved_id="" row="" dead=""
      case "$fmt" in
        '#{pid}') printf '%s\n' "$MOCK_TMUX_SERVER_PID"; return 0 ;;
        '#{socket_path}') printf '%s\n' "$MOCK_TMUX_SOCKET_PATH"; return 0 ;;
      esac
      if [[ "$wname" == @* ]]; then
        row=$(echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" -v w="$wname" \
          '$1 == s && $2 == w { print; exit }')
        # Legacy fixtures have no active bit; their first session row models
        # tmux 3.5a's vanished-id fallback to the current window.
        if [[ -z "$row" ]]; then
          row=$(echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" '$1 == s { print; exit }')
        fi
      else
        row=$(echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" -v w="$wname" \
          '$1 == s && $3 == w { print; exit }')
      fi
      if [[ -n "$row" ]]; then
        IFS='|' read -r _ resolved_id wname <<< "$row"
      elif [[ "$original_target" == @* ]]; then
        return 1
      else
        resolved_id="$original_target"
      fi
      dead=$(echo "$MOCK_PANE_DEAD" | awk -F= \
        -v k1="${session}:${original_target}" -v k2="${session}:${resolved_id}" -v k3="${session}:${wname}" \
        '$1 == k1 || $1 == k2 || $1 == k3 { print $2; found=1; exit } END { if (!found) print "1" }')
      case "$fmt" in
        '#{pane_dead}') printf '%s\n' "$dead" ;;
        '#{window_id}') printf '%s\n' "$resolved_id" ;;
        '#{window_name}') printf '%s\n' "$wname" ;;
        '#{window_id}|#{pane_dead}') printf '%s|%s\n' "$resolved_id" "$dead" ;;
        '#{window_name}|#{pane_dead}') printf '%s|%s\n' "$wname" "$dead" ;;
        *) printf '%s\n' "$dead" ;;
      esac
      ;;
    set-hook)
      MOCK_TMUX_HOOKS+="$*"$'\n'
      ;;
    show-hooks)
      # FLY-129 Phase 2: driven by MOCK_SHOW_HOOKS. Whole-output mock —
      # the function ignores -t <session> so tests just set the global.
      printf '%s' "$MOCK_SHOW_HOOKS"
      ;;
    kill-session)
      # tmux kill-session -t target → capture target
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) MOCK_TMUX_KILLED+="$2"$'\n'; shift 2 ;;
          *) shift ;;
        esac
      done
      ;;
    list-clients)
      # FLY-169: tmux list-clients -t '=<view_session>'.
      #   - session NOT in MOCK_TMUX_CLIENTS → rc=1 (tmux error / no session) →
      #     callers fail closed.
      #   - "vs=N"     → rc=0, N client lines (static).
      #   - "vs=N1,N2" → per-call sequence (for TOCTOU): 1st call N1, 2nd N2…
      #     clamped to the last value. Counter is per view_session, reset by
      #     reset_mocks.
      shift
      local lc_target=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) lc_target="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      local vs="${lc_target#=}"
      local spec
      spec=$(echo "$MOCK_TMUX_CLIENTS" | awk -F= -v k="$vs" '$1==k{print $2; f=1} END{if(!f) print "__ERR__"}')
      if [[ "$spec" == "__ERR__" ]]; then
        return 1   # session not mocked → tmux error
      fi
      local cnt_file="$TMPDIR_ROOT/clients.$(echo "$vs" | tr -c 'A-Za-z0-9_.-' '_').n"
      local n=0
      if [[ -f "$cnt_file" ]]; then n=$(cat "$cnt_file"); fi
      n=$((n + 1)); echo "$n" > "$cnt_file"
      local val
      val=$(echo "$spec" | awk -F, -v i="$n" '{ if (i>NF) i=NF; print $i }')
      local j=1
      while [[ $j -le ${val:-0} ]]; do echo "client$j"; j=$((j + 1)); done
      return 0
      ;;
    select-window)
      # FLY-169: capture select-window targets so tests can assert active-window
      # repair (heal) and the create-time ready gate.
      shift
      local sw_target=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) sw_target="$2"; MOCK_TMUX_SELECTS+="$2"$'\n'; shift 2 ;;
          *) shift ;;
        esac
      done
      # Honor MOCK_TMUX_SELECT_FAIL (for the §2.6 create-gate test).
      if [[ "${MOCK_TMUX_SELECT_FAIL:-0}" == "1" ]]; then return 1; fi
      # FLY-867 (mock fidelity): real tmux FAILS `select-window -t "=sess:=name"`
      # with "can't find window" when the name matches ≥2 windows (same-name
      # ambiguity — verified on an isolated tmux server). Only the `:=name`
      # target form is checked; `@id` (and other) targets keep default-success
      # (grouped view sessions share window objects, so id targets resolve).
      # 0/1 matches keep default-success so pre-FLY-867 fixtures (which often
      # omit MOCK_TMUX_WINDOWS entirely) are unaffected.
      local sw_win="${sw_target##*:}"
      if [[ "$sw_win" == =* && "$sw_win" != "$sw_target" ]]; then
        local sw_name="${sw_win#=}"
        local sw_count
        sw_count=$(echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v n="$sw_name" '$3 == n' | grep -c . || true)
        if [[ "$sw_count" -ge 2 ]]; then return 1; fi
      fi
      return 0
      ;;
    kill-window)
      # FLY-867: capture kill-window targets (husk reaper assertions).
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) MOCK_TMUX_KILLED_WINDOWS+="$2"$'\n'; shift 2 ;;
          *) shift ;;
        esac
      done
      ;;
    new-session)
      # FLY-169: faithfully register the -s session so linked_session_exists
      # reflects it afterward (mirrors production; the §2.6 create gate depends
      # on the linked session existing after new-session).
      shift
      local ns_name=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -s) ns_name="$2"; shift 2 ;;
          -t) shift 2 ;;
          *) shift ;;
        esac
      done
      if [[ -n "$ns_name" ]] && ! echo "$MOCK_TMUX_SESSIONS" | grep -qx "$ns_name"; then
        if [[ -n "$MOCK_TMUX_SESSIONS" ]]; then
          MOCK_TMUX_SESSIONS="${MOCK_TMUX_SESSIONS}"$'\n'"${ns_name}"
        else
          MOCK_TMUX_SESSIONS="$ns_name"
        fi
      fi
      ;;
    new-window)
      : ;;  # noop
    *)
      return 0 ;;
  esac
}

_fly1605_ps_mock() {
  if [[ "${MOCK_PS_MODE:-}" == "tz-sensitive-lstart" && "$*" == *"lstart="* ]]; then
    printf '%s|%s|%s\n' "${TZ:-<unset>}" "${LC_ALL:-<unset>}" "$*" >> "$TMPDIR_ROOT/ps.calls"
    case "${TZ:-<unset>}" in
      UTC) printf 'Sat Aug  1 16:45:06 2026\n' ;;
      Asia/Tokyo) printf 'Sun Aug  2 01:45:06 2026\n' ;;
      America/Denver) printf 'Sat Aug  1 10:45:06 2026\n' ;;
      *) printf 'Sat Aug  1 09:45:06 2026\n' ;;
    esac
    return 0
  fi
  command ps "$@"
}
eval "$(declare -f _fly1605_ps_mock | sed '1s/_fly1605_ps_mock/ps/')"

cmux() {
  # External-boundary trace used by load-budget tests. File-backed because
  # read calls often execute inside command substitutions/subshells.
  if [[ -n "${MOCK_CMUX_TRACE_FILE:-}" ]]; then
    printf '%s\n' "$*" >> "$MOCK_CMUX_TRACE_FILE"
  fi
  # FLY-129: cmux_call passes `--socket "$path"` first; skip those two args
  # so the rest of the test mock keeps working unchanged.
  if [[ "${1:-}" == "--socket" ]]; then
    shift 2
  fi
  # FLY-129 Phase 3: support `cmux --json list-workspaces` ordering.
  local json_mode=0
  if [[ "${1:-}" == "--json" ]]; then
    json_mode=1
    shift
  fi
  # FLY-1884: production identity reads request refs + immutable workspace
  # UUIDs in one snapshot. The mock payload already carries both fields; only
  # consume the global CLI option here so the command dispatch stays faithful.
  if [[ "${1:-}" == "--id-format" ]]; then
    [[ "${2:-}" == "both" ]] || return 1
    shift 2
  fi
  case "${1:-}" in
    list-workspaces)
      if (( json_mode == 1 )); then
        # FLY-254 CR-R3: optional identity flip "during" a JSON IPC. Writes
        # the new identity to a FILE (this mock often runs inside $(...)
        # subshells; cmux_socket_identity's test override reads the file) on
        # the MOCK_JSON_FLIP_AT-th list-workspaces call. Used to reproduce
        # the generation-flip-during-current_selected_ref race.
        if [[ -n "${MOCK_JSON_FLIP_IDENT:-}" ]]; then
          local jf_file="$TMPDIR_ROOT/jsoncalls.n" jf_n=0
          [[ -f "$jf_file" ]] && jf_n=$(cat "$jf_file")
          jf_n=$((jf_n + 1)); echo "$jf_n" > "$jf_file"
          if [[ "$jf_n" -ge "${MOCK_JSON_FLIP_AT:-1}" ]]; then
            printf '%s' "$MOCK_JSON_FLIP_IDENT" > "$TMPDIR_ROOT/mock-ident.override"
          fi
        fi
        if [[ "$MOCK_CMUX_JSON_FAIL" == "1" ]]; then
          return 1
        fi
        if [[ "$MOCK_CMUX_JSON_INVALID" == "1" ]]; then
          echo "not json"
        elif [[ -n "${MOCK_CMUX_JSON_SEQ_N:-}" ]]; then
          # FLY-254: per-call JSON sequence read from files
          # $TMPDIR_ROOT/wsjson.<i> (1..MOCK_CMUX_JSON_SEQ_N, clamped to the
          # last). File-based counter — list-workspaces runs inside $(...)
          # subshells. Used by the readiness-wait partial-restore tests.
          local wj_file="$TMPDIR_ROOT/wsjson.n" wj_n=0
          [[ -f "$wj_file" ]] && wj_n=$(cat "$wj_file")
          wj_n=$((wj_n + 1)); echo "$wj_n" > "$wj_file"
          (( wj_n > MOCK_CMUX_JSON_SEQ_N )) && wj_n=$MOCK_CMUX_JSON_SEQ_N
          cat "$TMPDIR_ROOT/wsjson.$wj_n"
        elif [[ -f "$TMPDIR_ROOT/fly1884-uuid.override" ]]; then
          printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
d["workspaces"][0]["id"]=open(sys.argv[1]).read()
print(json.dumps(d))
' "$TMPDIR_ROOT/fly1884-uuid.override"
        else
          echo "$MOCK_CMUX_WORKSPACES_JSON"
        fi
      else
        echo "$MOCK_CMUX_WORKSPACES"
      fi
      ;;
    close-workspace)
      MOCK_CMUX_OPS+="$*"$'\n'
      # FLY-685: simulate a cmux close-workspace mutation failure (revalidation
      # JSON succeeds but the close itself fails) to test marker requeue on an
      # unconfirmed close. NB: use an explicit `if` — a trailing `[[…]] && return`
      # would make the case arm exit 1 whenever the condition is FALSE.
      if [[ "${MOCK_CMUX_CLOSE_FAIL:-0}" == "1" ]]; then return 1; fi
      if [[ "${MOCK_CMUX_MUTATE_JSON:-0}" == "1" ]]; then
        local close_ref="" close_json
        shift
        while [[ $# -gt 0 ]]; do
          case "$1" in --workspace) close_ref="$2"; shift 2 ;; *) shift ;; esac
        done
        close_json=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
r=sys.argv[1]; d=json.load(sys.stdin)
d["workspaces"]=[w for w in d.get("workspaces",[]) if w.get("ref") != r]
print(json.dumps(d))' "$close_ref")
        MOCK_CMUX_WORKSPACES_JSON="$close_json"
        if [[ "${MOCK_CMUX_MUTATE_SURFACES:-0}" == "1" ]]; then
          MOCK_CMUX_SURFACES=$(printf '%s\n' "$MOCK_CMUX_SURFACES" \
            | awk -F';;' -v r="$close_ref" '$1 != r')
        fi
      fi
      ;;
    new-workspace)
      MOCK_CMUX_OPS+="$*"$'\n'
      if [[ "${MOCK_CMUX_MUTATE_JSON:-0}" == "1" ]]; then
        local next_n next_ref next_uuid next_surface_uuid new_json create_command="" create_title="__NULL__"
        shift
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --command) create_command="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ "${MOCK_CMUX_NEW_WORKSPACE_TITLE_FROM_COMMAND:-0}" == "1" ]]; then
          create_title="$create_command"
        fi
        next_n=$(cat "$TMPDIR_ROOT/cmux.next-ref" 2>/dev/null || echo 100)
        next_ref="workspace:${next_n}"
        next_uuid="${MOCK_CMUX_NEXT_UUID:-00000000-0000-4000-8000-$(printf '%012d' "$next_n")}"
        next_surface_uuid="00000000-0000-4000-8001-$(printf '%012d' "$next_n")"
        echo $((next_n + 1)) > "$TMPDIR_ROOT/cmux.next-ref"
        new_json=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
title=None if sys.argv[2] == "__NULL__" else sys.argv[2]
d.setdefault("workspaces",[]).append({"ref":sys.argv[1],"title":title,"id":sys.argv[3]})
print(json.dumps(d))' "$next_ref" "$create_title" "$next_uuid")
        MOCK_CMUX_WORKSPACES_JSON="$new_json"
        # A successful terminal workspace create always has one terminal
        # surface. Keep that new object mutation-faithful automatically;
        # manually seeded surface fixtures remain opt-in below.
        MOCK_CMUX_MUTATE_SURFACES=1
        MOCK_CMUX_SURFACES+="${MOCK_CMUX_SURFACES:+$'\n'}${next_ref};;surface:${next_n};;terminal;;true;;${create_command};;${next_surface_uuid}"
        python3 - "$CMUX_SESSION_STATE" "$next_surface_uuid" "$create_command" <<'PY'
import json,sys
path,surface,command=sys.argv[1:]
try:
    with open(path,encoding="utf-8") as f: data=json.load(f)
except Exception:
    data={"windows":[]}
if not data.get("windows"):
    data["windows"]=[{"tabManager":{"workspaces":[]}}]
manager=data["windows"][0].setdefault("tabManager",{})
manager.setdefault("workspaces",[]).append({
  "focusedPanelId":surface,"processTitle":command,
  "panels":[{"type":"terminal","id":surface}]
})
with open(path,"w",encoding="utf-8") as f: json.dump(data,f)
PY
      fi
      ;;
    rename-workspace)
      MOCK_CMUX_OPS+="$*"$'\n'
      if [[ "${MOCK_CMUX_MUTATE_JSON:-0}" == "1" ]]; then
        local rename_ref="" rename_title="" rename_json
        shift
        while [[ $# -gt 0 ]]; do
          case "$1" in --workspace) rename_ref="$2"; shift 2 ;; *) rename_title="$1"; shift ;; esac
        done
        rename_json=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
r,t=sys.argv[1:3]; d=json.load(sys.stdin)
for w in d.get("workspaces",[]):
    if w.get("ref") == r: w["title"] = t
print(json.dumps(d))' "$rename_ref" "$rename_title")
        MOCK_CMUX_WORKSPACES_JSON="$rename_json"
      fi
      ;;
    rename-tab)
      # FLY-1550: tab rename is logged like the workspace rename so tests can
      # assert the founder-visible tab title is set alongside the workspace one.
      MOCK_CMUX_OPS+="$*"$'\n'
      # NB: explicit `if` — a trailing `[[…]] && return` would make this arm
      # exit 1 whenever the flag is unset (same trap as close-workspace above).
      if [[ "${MOCK_CMUX_RENAME_TAB_FAIL:-0}" == "1" ]]; then return 1; fi
      if [[ "${MOCK_CMUX_MUTATE_SURFACES:-0}" == "1" ]]; then
        local tab_ref="" tab_title="" tab_tmp="$TMPDIR_ROOT/cmux-surfaces.tmp"
        shift
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --workspace) tab_ref="$2"; shift 2 ;;
            *) tab_title="$1"; shift ;;
          esac
        done
        awk -F';;' -v OFS=';;' -v r="$tab_ref" -v t="$tab_title" \
          '$1 == r { $5=t } { print }' <<< "$MOCK_CMUX_SURFACES" > "$tab_tmp"
        MOCK_CMUX_SURFACES=$(cat "$tab_tmp")
        rm -f "$tab_tmp"
      fi
      ;;
    send|send-key|respawn-pane|set-status|clear-status|refresh-surfaces)
      # FLY-169: capture send / send-key / refresh-surfaces too (with their
      # --surface args) so tests can assert surface-scoped self-heal sends.
      MOCK_CMUX_OPS+="$*"$'\n'
      ;;
    select-workspace)
      # FLY-254: capture the focus mutation AND reflect it in the workspace
      # JSON selected flags, so current_selected_ref sees focus changes the
      # way real cmux reports them. Mutating globals is safe here:
      # select-workspace is always invoked via cmux_call directly (never
      # inside $(...)), so this runs in the main shell.
      # CR-R4: the ops line also records the identity observed AT MUTATION
      # TIME (ident=…) — ordering regression guard: any bookkeeping slipped
      # between the final stat and the select shows up as ident=B here.
      MOCK_CMUX_OPS+="$* ident=$(cmux_socket_identity)"$'\n'
      local sw_ref=""
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --workspace) sw_ref="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      if [[ -n "$sw_ref" ]]; then
        local sw_new
        sw_new=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import sys, json
ref = sys.argv[1]
d = json.load(sys.stdin)
for w in d.get("workspaces", []):
    w["selected"] = (w.get("ref") == ref)
print(json.dumps(d))' "$sw_ref" 2>/dev/null)
        [[ -n "$sw_new" ]] && MOCK_CMUX_WORKSPACES_JSON="$sw_new"
      fi
      # CR-R6 LOW: optional forced exit code — proves a REAL cmux rc (e.g. 99)
      # is never misread as a guard block.
      return "${MOCK_CMUX_SELECT_RC:-0}"
      ;;
    read-screen)
      # FLY-169: bare-shell gate reads the surface screen. MOCK_CMUX_READSCREEN
      # is the screen text (last non-empty line drives the prompt-sigil check).
      # FLY-254: MOCK_CMUX_READSCREEN_SEQ adds a per-call sequence — comma-
      # separated values, "FAIL" = rc=1, anything else = screen text; clamped
      # to the last value. Counter is FILE-based because read-screen is invoked
      # inside $(...) subshells (same pattern as the list-clients counters and
      # FLY-242's panedead counters).
      if [[ -n "${MOCK_CMUX_READSCREEN_SEQ:-}" ]]; then
        local rs_file="$TMPDIR_ROOT/readscreen.n" rs_n=0
        [[ -f "$rs_file" ]] && rs_n=$(cat "$rs_file")
        rs_n=$((rs_n + 1)); echo "$rs_n" > "$rs_file"
        local rs_v
        rs_v=$(echo "$MOCK_CMUX_READSCREEN_SEQ" | awk -F, -v i="$rs_n" '{ if (i>NF) i=NF; print $i }')
        if [[ "$rs_v" == "FAIL" ]]; then return 1; fi
        printf '%s\n' "$rs_v"
        return 0
      fi
      if [[ "${MOCK_CMUX_READSCREEN_FAIL:-0}" == "1" ]]; then return 1; fi
      printf '%s\n' "$MOCK_CMUX_READSCREEN"
      ;;
    list-pane-surfaces)
      # FLY-169: cmux --json list-pane-surfaces --workspace <ref>.
      #   MOCK_CMUX_SURFACES_FAIL=1    → cmux failure (rc=1)
      #   MOCK_CMUX_SURFACES_INVALID=1 → malformed JSON (parse must fail closed)
      #   else build {"surfaces":[{ref,type,selected,title}...]} from MOCK_CMUX_SURFACES
      #   lines formatted "wsref;;surfaceref;;type;;selected;;title"
      #   (selected="true"/""; title is optional for older fixtures).
      shift
      local lps_ws=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --workspace) lps_ws="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      if [[ "${MOCK_CMUX_SURFACES_FAIL:-0}" == "1" ]]; then return 1; fi
      if [[ "${MOCK_CMUX_SURFACES_INVALID:-0}" == "1" ]]; then
        echo "not json"
        return 0
      fi
      local lps_uuid
      lps_uuid=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
r=sys.argv[1]
for workspace in json.load(sys.stdin).get("workspaces",[]):
    if workspace.get("ref")==r:
        print(workspace.get("id", "")); break
' "$lps_ws" 2>/dev/null) || lps_uuid=""
      echo "$MOCK_CMUX_SURFACES" | awk -F';;' -v w="$lps_ws" -v u="$lps_uuid" '
        BEGIN { printf "{\"workspace_id\":\"%s\",\"surfaces\":[", u ; first=1 }
        $1==w { if(!first) printf "," ; first=0 ;
                sel = ($4=="true") ? "true" : "false" ;
                sid = ($6=="") ? $2 : $6 ;
                printf "{\"ref\":\"%s\",\"id\":\"%s\",\"type\":\"%s\",\"selected\":%s,\"title\":\"%s\"}", $2, sid, $3, sel, $5 }
        END { print "]}" }'
      ;;
    *) return 0 ;;
  esac
}

pgrep() {
  # FLY-129 Phase 1: drive sync_once's watcher-detection branch from tests.
  # FLY-825: if MOCK_PGREP_PIDS is set, print those PIDs (one per line, like
  # real pgrep -f) — wait_for_watcher_exit reads pgrep's stdout, not just its
  # rc. MOCK_KILL_CALLS/kill() below mutates MOCK_PGREP_PIDS to simulate a
  # process actually dying. Falls back to the legacy rc-only MOCK_PGREP_HIT
  # (no stdout) for existing sync_once tests that only check the exit code.
  [[ "${MOCK_PGREP_ERROR:-0}" == "1" ]] && return 2
  if [[ -n "${MOCK_PGREP_PIDS:-}" ]]; then
    printf '%s\n' $MOCK_PGREP_PIDS
    return 0
  fi
  [[ "${MOCK_PGREP_HIT:-0}" == "1" ]] && return 0
  return 1
}

kill() {
  # FLY-825: capture TERM/KILL calls for wait_for_watcher_exit tests — but ONLY
  # when a test explicitly opts in via MOCK_KILL_INTERCEPT=1. Defining `kill`
  # as a function unconditionally shadows the real builtin for the ENTIRE
  # script (bash resolves functions before builtins), which broke the
  # pre-existing FLY-177 "supervised takeover" test: its `kill "$fake_watcher"`
  # (a REAL `sleep 60 &` background process) silently no-op'd through this
  # mock instead of actually terminating the process, so
  # acquire_watcher_lock's real death-detection never fired and the test hung
  # (found live while running the suite). Default behavior must stay
  # byte-identical to the real builtin; only wait_for_watcher_exit's own tests
  # set MOCK_KILL_INTERCEPT=1, where every "pid" is a MOCK_PGREP_PIDS fake, not
  # a real OS process.
  if [[ "${MOCK_KILL_INTERCEPT:-0}" != "1" ]]; then
    command kill "$@"
    return $?
  fi
  # Default signal (bare `kill PID`, no flag) is treated as TERM. A PID listed
  # in MOCK_KILL_SURVIVES ignores TERM (stays in MOCK_PGREP_PIDS) but always
  # dies on KILL — models a process that needs the harder signal.
  local sig="TERM" pid="$1"
  case "$1" in
    -TERM) sig="TERM"; pid="$2" ;;
    -KILL) sig="KILL"; pid="$2" ;;
    -*) sig="${1#-}"; pid="$2" ;;
  esac
  MOCK_KILL_CALLS+="${sig} ${pid}"$'\n'
  if [[ "$sig" == "KILL" ]] && printf ' %s ' "$MOCK_KILL_ALWAYS_SURVIVES" | grep -q " $pid "; then
    return 0
  fi
  if [[ "$sig" == "TERM" ]] && printf ' %s ' "$MOCK_KILL_SURVIVES" | grep -q " $pid "; then
    return 0   # survives TERM — pid stays in MOCK_PGREP_PIDS
  fi
  MOCK_PGREP_PIDS=$(printf '%s\n' $MOCK_PGREP_PIDS | grep -vx "$pid" | tr '\n' ' ')
  MOCK_PGREP_PIDS="${MOCK_PGREP_PIDS% }"
  return 0
}

export -f tmux cmux ps pgrep kill

reset_mocks() {
  MOCK_TOPOLOGY_MODE="compat"
  MOCK_TOPO_LINK_FAIL="0"
  MOCK_TOPO_UNLINK_FAIL="0"
  MOCK_TOPO_RENAME_FAIL="0"
  MOCK_TOPO_RENAME_OUTPUT_LOST="0"
  MOCK_TMUX_GENERATION_FLIP_AFTER_SET_OPTION=""
  MOCK_TMUX_GENERATION_FLIP_AFTER_SNAPSHOT_SESSION=""
  MOCK_TMUX_GENERATION_FLIP_VALUE=""
  MOCK_TMUX_GENERATION_FLIP_ON_MISSING_SESSION=""
  MOCK_TMUX_GENERATION_SEQ=""
  MOCK_TMUX_REUSE_SESSION_AFTER_WINDOW_PROBE=""
  FLYWHEEL_CMUX_LINKED_VIEW="0"
  FLYWHEEL_CMUX_TMUX_GENERATION="tmux-test-generation"
  CMUX_WAL_BLOCKED_VIEWS=""
  CMUX_TITLE_TOPOLOGY_REFUSED_KEYS=""
  FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="test-incarnation"
  FLYWHEEL_CMUX_VIEW_HELPER=1
  FLYWHEEL_CMUX_VIEW_HELPER_BIN="$SCRIPT_DIR/flywheel-view-attach.sh"
  CMUX_ATTACH_BIRTH_CACHE_READY=0
  CMUX_ATTACH_BIRTH_CACHE_ROUND=""
  CMUX_ATTACH_BIRTH_CACHE_ROWS=""
  topo_reset
  MOCK_TMUX_WINDOWS=""
  MOCK_PANE_DEAD=""
  MOCK_CMUX_RENAME_TAB_FAIL="0"
  MOCK_CMUX_WORKSPACES=""
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  MOCK_CMUX_JSON_FAIL="0"
  MOCK_CMUX_JSON_INVALID="0"
  MOCK_TMUX_SESSIONS=""
  MOCK_TMUX_HOOKS=""
  MOCK_CMUX_OPS=""
  MOCK_CMUX_TRACE_FILE=""
  MOCK_TMUX_KILLED=""
  MOCK_TMUX_KILLED_WINDOWS=""
  MOCK_PGREP_HIT="0"
  MOCK_MUTATOR_CENSUS=""
  MOCK_MUTATOR_CENSUS_FAIL="0"
  MOCK_MUTATOR_CENSUS_SEQ=""
  MOCK_PROCESS_COMMANDS=""
  MOCK_PROCESS_GONE_PIDS=""
  MOCK_SHOW_HOOKS=""
  MOCK_CMUX_MUTATE_JSON="0"
  MOCK_CMUX_MUTATE_SURFACES="0"
  MOCK_CMUX_NEW_WORKSPACE_TITLE_FROM_COMMAND="0"
  MOCK_CMUX_NEXT_UUID=""
  MOCK_PS_MODE=""
  MOCK_TMUX_SERVER_PID="4242"
  MOCK_TMUX_SOCKET_PATH="$TMPDIR_ROOT/mock-tmux.sock"
  MOCK_PRIVATE_TMUX_SOCKET=""
  MOCK_PRIVATE_TMUX_SESSION="1"
  MOCK_PRIVATE_TMUX_CLIENTS="1"
  rm -f "$TMPDIR_ROOT/ps.calls"
  # FLY-293: tmux inventory failure knobs + orphan-pin reaper env/state.
  MOCK_TMUX_LIST_FAIL="0"        # 1 = tmux list-sessions fails (server down)
  MOCK_TMUX_LISTWINDOWS_FAIL="0" # 1 = tmux list-windows fails (per-session probe)
  ORPHAN_PIN_STATE="$TMPDIR_ROOT/orphan-pin.state"
  FLYWHEEL_CMUX_ORPHAN_REAPER=1
  FLYWHEEL_CMUX_ORPHAN_PIN_GRACE=300
  rm -f "$ORPHAN_PIN_STATE" 2>/dev/null
  ADOPTION_STATE="$TMPDIR_ROOT/adoption.state"
  rm -f "$ADOPTION_STATE" 2>/dev/null
  CMUX_ADOPT_CAP_STATE="$TMPDIR_ROOT/cmux-adopt-cap"
  printf '10\n' > "$CMUX_ADOPT_CAP_STATE"
  CMUX_ADOPTION_COUNT=0
  FLYWHEEL_CMUX_RESTORED_ADOPTION=1
  FLYWHEEL_CMUX_ADOPTION_GRACE=300
  FLYWHEEL_CMUX_ADOPTION_BUDGET=""
  RESTORED_BOOTSTRAP_PASS=0
  # FLY-685: close-request marker file.
  CLOSE_REQUEST_FILE="$TMPDIR_ROOT/close-requested"
  # FLY-867: husk-reaper state + knobs (default on, production-default grace).
  MOCK_TMUX_DISPLAY_FAIL="0"
  HUSK_STATE="$TMPDIR_ROOT/husk.state"
  FLYWHEEL_CMUX_HUSK_REAPER=1
  FLYWHEEL_CMUX_HUSK_GRACE=86400
  rm -f "$HUSK_STATE" 2>/dev/null
  MOCK_CMUX_CLOSE_FAIL="0"   # 1 = cmux close-workspace mutation fails (revalidation still passes)
  LAST_WORKSPACE_CLOSE_RC=0
  rm -f "$CLOSE_REQUEST_FILE" "${CLOSE_REQUEST_FILE}.processing" 2>/dev/null
  # FLY-169 mocks
  MOCK_TMUX_CLIENTS=""        # lines "view_session=N" or "view_session=N1,N2" (per-call seq)
  MOCK_TMUX_SELECTS=""        # captured select-window targets
  MOCK_TMUX_SELECT_FAIL="0"   # 1 = select-window returns rc=1 (create-gate test)
  MOCK_CMUX_SURFACES=""       # lines "wsref;;title;;surfaceref"
  MOCK_CMUX_SURFACES_FAIL="0" # 1 = list-pane-surfaces cmux failure
  MOCK_CMUX_SURFACES_INVALID="0" # 1 = list-pane-surfaces returns malformed JSON
  MOCK_CMUX_READSCREEN="user@host ~ %"   # bare-shell screen (prompt sigil) by default
  MOCK_CMUX_READSCREEN_FAIL="0"          # 1 = read-screen cmux failure
  CMUX_HEAL_ON_RECOVERY="0"
  # FLY-254 mocks
  MOCK_CMUX_READSCREEN_SEQ=""   # per-call read-screen sequence ("FAIL,text,…")
  MOCK_CMUX_JSON_SEQ_N=""       # per-call list-workspaces JSON files (wsjson.<i>)
  MOCK_SOCK_IDENT=""            # cmux_socket_identity override value
  MOCK_SOCK_PRESENT="0"         # cmux_socket_present override (1 = socket exists)
  MOCK_SLEEPS=0                 # sleep-mock call counter
  MOCK_SLEEP_ARGS=""            # sleep-mock recorded durations
  MOCK_SLEEP_HOOK=""            # eval'd on each mocked sleep (flip state mid-wait)
  HEAL_RENDER_ESCALATE=0
  ATTACH_HEAL_STATE="$TMPDIR_ROOT/attach-heal.state"
  FLYWHEEL_CMUX_ATTACH_RETRIES=""
  REOPEN_CONSUMED_THIS_TICK=0
  REOPEN_CACHE_IDENT=""         # FLY-254 CR-M6 in-process cache
  REOPEN_CACHE_STATE=""
  HEAL_SWEEP_GEN_IDENT=""       # FLY-254 CR-HIGH-2 generation pin
  HEAL_GEN_CHANGED=0            # FLY-254 CR-R2-HIGH-1 generation-changed latch
  MOCK_JSON_FLIP_IDENT=""       # FLY-254 CR-R3: identity flip during a JSON IPC
  MOCK_JSON_FLIP_AT=""
  MOCK_MKTEMP_HOOK=""           # FLY-254 CR-R5: eval'd at cmux_call_guarded's mktemp
  MOCK_CMUX_CALL_MKTEMP_HOOK="" # FLY-1364: eval'd at plain cmux_call's mktemp
  MOCK_CMUX_SELECT_RC=""        # FLY-254 CR-R6: force select-workspace exit code
  rm -f "$TMPDIR_ROOT"/jsoncalls.n "$TMPDIR_ROOT"/mock-ident.override \
    "$TMPDIR_ROOT"/tmux-generation.override "$TMPDIR_ROOT"/tmux-generation.n \
    "$TMPDIR_ROOT"/gmk.n 2>/dev/null
  rm -f "$TMPDIR_ROOT/mutator-census.n" 2>/dev/null
  # FLY-129 Phase 3: reset JSON transition state so per-test logging is clean.
  CMUX_JSON_LAST_STATE="unknown"
  rm -f "$EVENT_FILE" "$CLEANUP_PENDING" "$STALE_STATE" "$HEAL_STATE" "$ATTACH_HEAL_STATE" "$CREATE_STATE"
  # FLY-825
  FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS=""
  MOCK_PGREP_PIDS=""            # pgrep mock: space-separated PID list to echo
  MOCK_KILL_CALLS=""            # captured "SIGNAL PID" lines from the kill mock
  MOCK_KILL_SURVIVES=""         # space-separated PIDs that ignore TERM (still match pgrep after)
  MOCK_KILL_ALWAYS_SURVIVES=""  # space-separated PIDs that also survive mocked KILL
  MOCK_PGREP_ERROR="0"          # 1 = process census unavailable (not no matches)
  MOCK_KILL_INTERCEPT="0"       # 0 (default) = kill() delegates to the REAL builtin
                                 # (byte-compat with every pre-existing real-process test);
                                 # 1 = wait_for_watcher_exit tests opt in to recording-only mode
  rm -f "$TMPDIR_ROOT"/clients.*.n "$TMPDIR_ROOT"/fly1884-uuid.override
  rm -f "$CMUX_SOCK_IDENT_FILE" "$TMPDIR_ROOT"/readscreen.n "$TMPDIR_ROOT"/wsjson.n "$TMPDIR_ROOT"/wsjson.[0-9]* 2>/dev/null
  rm -f "$TMPDIR_ROOT/cmux.next-ref"
  rm -f "$TMPDIR_ROOT/fixed-topology.seeded" "$TMPDIR_ROOT/fixed-receipts.seeded"
  rm -rf "$VIEW_WAL_DIR"
  rm -f "$VIEW_LEDGER" "$KEEPER_INVENTORY" "$RESTORED_STATE" "$VIEW_ABSENT_STATE" "$FLYWHEEL_CMUX_MAINTENANCE_MARKER"
  printf '{"windows":[]}\n' > "$CMUX_SESSION_STATE"
  rm -rf "${KEEPER_INVENTORY}.lock"
  CMUX_QA_TEARDOWN_CLAIM="${FLYWHEEL_CMUX_MAINTENANCE_MARKER}.qa-teardown"
  CMUX_OPS_REBUILD_CLAIM="${FLYWHEEL_CMUX_MAINTENANCE_MARKER}.ops-rebuild"
  rm -f "$CMUX_QA_TEARDOWN_CLAIM"
  rm -f "$CMUX_OPS_REBUILD_CLAIM"
  rm -f "$LEDGER_CONFLICT_STATE"
  rm -f "$ROSTER_EPISODE_STATE"
  CMUX_LOG_EPISODE_STATE="$TMPDIR_ROOT/cmux-log-episodes.state"
  rm -f "$CMUX_LOG_EPISODE_STATE"
  PREPARED_STALL_STATE="$TMPDIR_ROOT/prepared-stall.state"
  CMUX_ADDITIVE_ROUND_STATE="$TMPDIR_ROOT/cmux-additive-round.state"
  CMUX_ADDITIVE_ROUND_ID=""
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=""
  FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES=""
  FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES=""
  rm -f "$PREPARED_STALL_STATE" "$CMUX_ADDITIVE_ROUND_STATE"
  rm -f "$NODE_LEDGER" "$NODE_REGISTRY" "$CLEANUP_SNAPSHOT"
  rm -rf "$NODE_STATUS_DIR"
  rm -f "$TMPDIR_ROOT/fly1364-alert-args"
  CMUX_CLEANUP_ALERT_LATCH=""
  CMUX_CLEANUP_ALERT_LATCH_COUNT=0
  CMUX_CLEANUP_ALERT_LATCH_GENERATION=""
  CMUX_CLEANUP_ALERT_SATURATION_WARNED=0
  DISMANTLE_OUTCOME=""
  DISMANTLE_REASON=""
  WATCHER_AUTHORITY_LOST=0
  WATCHER_AUTHORITY_FAILURE_STREAK=0
  WATCHER_PASS_ACTIVE=0
  WATCHER_RESYNC_REQUIRED=0
  QA_CLAIM_DEAD_SIGNATURE=""
  QA_CLAIM_DEAD_OBSERVATIONS=0
  OPS_CLAIM_DEAD_SIGNATURE=""
  OPS_CLAIM_DEAD_OBSERVATIONS=0
  OPS_REBUILD_CLAIM_LINE=""
  OPS_REBUILD_TARGETS=""
  OPS_REBUILD_TARGET_SPECS=""
  OPS_REBUILD_ACTIVE_TARGET=""
  OPS_REBUILD_REPORT_PATH=""
  CMUX_REBUILD_REPORT_DIR="$TMPDIR_ROOT/cmux-rebuild-reports"
  rm -rf "$CMUX_REBUILD_REPORT_DIR"
  rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
}

seed_complete_cleanup_snapshot_after() {
  local marker_epoch="$1"
  : > "$NODE_REGISTRY"
  printf 'snapshot|0|1|%s|complete\n' "$((marker_epoch + 1))" > "$CLEANUP_SNAPSHOT"
}

# Source the script (guarded — dispatcher won't run because BASH_SOURCE != $0)
source "$SCRIPT_DIR/flywheel-cmux-sync.sh"
eval "$(declare -f _snapshot_live_mutator_processes | sed '1s/_snapshot_live_mutator_processes/_production_snapshot_live_mutator_processes/')"

seed_fixed_receipt_fixture() {
  local generation="$1" seeded="$TMPDIR_ROOT/fixed-receipts.seeded" ref title
  [[ "$MOCK_TOPOLOGY_MODE" == "compat" && ! -e "$seeded" ]] || return 0
  : > "$seeded"
  while IFS='|' read -r ref title; do
    [[ -n "$ref" && -n "$title" ]] || continue
    printf '%s\n' "$MOCK_TMUX_WINDOWS" | awk -F'|' -v t="$title" \
      '$3 == t { found=1 } END { exit(found ? 0 : 1) }' || continue
    awk -F'|' -v r="$ref" '$3 == r { found=1 } END { exit(found ? 0 : 1) }' \
      "$VIEW_LEDGER" 2>/dev/null && continue
    printf 'committed|%s|%s|%s\n' "$generation" "$ref" "$title" >> "$VIEW_LEDGER"
  done < <(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,re,sys
attach=re.compile(r"^env -u TMUX tmux attach -t '\''=cmux-([^'\''\\n]+)'\''$")
for workspace in json.load(sys.stdin).get("workspaces", []):
    ref, title = workspace.get("ref"), workspace.get("title")
    match = attach.fullmatch(title) if isinstance(title, str) else None
    logical = match.group(1) if match else title
    if isinstance(ref, str) and isinstance(logical, str):
        print(f"{ref}|{logical}")
')
}

cmux_socket_identity() {
  local generation="${MOCK_SOCK_IDENT:-cmux-test-generation}"
  seed_fixed_receipt_fixture "$generation"
  printf '%s' "$generation"
}

# R6 lease tests are hermetic: a production watcher may be live on this host
# but owns a different lock namespace than the harness tempdir.
_snapshot_live_mutator_processes() {
  [[ "$MOCK_MUTATOR_CENSUS_FAIL" == "1" ]] && return 2
  if [[ -n "$MOCK_MUTATOR_CENSUS_SEQ" ]]; then
    local counter="$TMPDIR_ROOT/mutator-census.n" n=0 row
    [[ -f "$counter" ]] && n=$(cat "$counter")
    n=$((n + 1)); printf '%s\n' "$n" > "$counter"
    row=$(printf '%s\n' "$MOCK_MUTATOR_CENSUS_SEQ" | sed -n "${n}p")
    [[ -n "$row" ]] || row=$(printf '%s\n' "$MOCK_MUTATOR_CENSUS_SEQ" | tail -1)
    [[ "$row" == "__FAIL__" ]] && return 2
    [[ "$row" == "__EMPTY__" ]] && return 0
    printf '%s\n' "$row"
    return 0
  fi
  printf '%s' "$MOCK_MUTATOR_CENSUS"
}
cmux_process_command_for_pid() {
  local pid="$1" row
  if printf ' %s ' "$MOCK_PROCESS_GONE_PIDS" | grep -q " $pid "; then
    return 1
  fi
  row=$(printf '%s\n' "$MOCK_PROCESS_COMMANDS" | awk -F'|' -v p="$pid" '$1 == p { sub(/^[^|]*\|/, ""); print; exit }')
  [[ -n "$row" ]] || return 2
  printf '%s\n' "$row"
}

# Re-export mocks after sourcing (sourcing unsets them in some shells? defensive)
export -f tmux cmux ps pgrep kill

test_ensure_mutator_lease() {
  assert_or_reuse_owned_lease 2>/dev/null || acquire_mutator_lease qa_teardown
}

test_ledger_upsert() {
  test_ensure_mutator_lease || return 1
  _ledger_upsert "$@"
}

# ════════════════════════════════════════════════════════════════
# Test 1: register_session_hooks only registers for flywheel/runner-*
# ════════════════════════════════════════════════════════════════
echo "Test: register_session_hooks name filter"
reset_mocks
register_session_hooks "flywheel" >/dev/null
register_session_hooks "runner-geoforge3d" >/dev/null
register_session_hooks "unrelated-session" >/dev/null
register_session_hooks "cmux-worker-fly-102" >/dev/null

if echo "$MOCK_TMUX_HOOKS" | grep -q "flywheel"; then
  pass "registers on 'flywheel'"
else
  fail "missing hook for 'flywheel'"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "runner-geoforge3d"; then
  pass "registers on 'runner-geoforge3d'"
else
  fail "missing hook for 'runner-geoforge3d'"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "unrelated-session"; then
  fail "should not register on 'unrelated-session'"
else
  pass "skips 'unrelated-session'"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "cmux-worker-fly-102"; then
  fail "should not register on cmux-* linked session"
else
  pass "skips cmux-* linked session"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: register_session_hooks uses array index [500]
# ════════════════════════════════════════════════════════════════
echo "Test: hook uses array index [500]"
reset_mocks
register_session_hooks "flywheel" >/dev/null

if echo "$MOCK_TMUX_HOOKS" | grep -q 'after-new-window\[500\]'; then
  pass "after-new-window[500] used"
else
  fail "after-new-window[500] not found"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-exited\[500\]'; then
  pass "pane-exited[500] used"
else
  fail "pane-exited[500] not found"
fi
# FLY-110: pane-died MUST also be registered (in register_global_hooks).
# Production sets `remain-on-exit on` on Runner/Lead sessions, where tmux
# 3.5a fires `pane-died` (not `pane-exited`) when the pane process exits.
# In tmux 3.5a, pane-died only fires when registered globally — session-
# scoped registration is silently ignored by the hook dispatcher.
reset_mocks
register_global_hooks >/dev/null
if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-died\[500\]'; then
  pass "pane-died[500] registered globally (FLY-110 fix)"
else
  fail "pane-died[500] not registered globally — production path with remain-on-exit on will not fire (FLY-110)"
fi
# pane-died MUST NOT be registered session-scoped — that registration is
# silently dropped by tmux 3.5a's hook dispatcher.
reset_mocks
register_session_hooks "flywheel" >/dev/null
if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-died\[500\]'; then
  fail "pane-died[500] should not be registered session-scoped (tmux 3.5a drops it silently); register globally instead"
else
  pass "pane-died not registered session-scoped (correct — tmux 3.5a only fires global pane-died)"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: Hook command embeds format vars, not $(date ...)
# ════════════════════════════════════════════════════════════════
echo "Test: hook command does not embed shell-expanded timestamp"
reset_mocks
register_session_hooks "flywheel" >/dev/null

if echo "$MOCK_TMUX_HOOKS" | grep -q '#{session_name}'; then
  pass "hook uses #{session_name} format var"
else
  fail "hook missing #{session_name} (should use plain var, not #{hook_session_name} — see QA regression)"
fi
# #{hook_session_name} expands to EMPTY under run-shell -b in tmux 3.5a —
# QA-caught regression. Guard against its reintroduction.
if echo "$MOCK_TMUX_HOOKS" | grep -q '#{hook_session_name}\|#{hook_window_name}\|#{hook_window}[^_]'; then
  fail "hook uses #{hook_*} format var that expands to empty in tmux 3.5a"
else
  pass "hook avoids broken #{hook_*} format vars"
fi
# Make sure no numeric timestamp was baked in (would indicate shell expansion)
if echo "$MOCK_TMUX_HOOKS" | grep -qE '\|[0-9]{10}\|'; then
  fail "hook command contains baked-in timestamp (register-time expansion)"
else
  pass "no baked-in timestamp in hook command"
fi

# ════════════════════════════════════════════════════════════════
# Test 4: mark_for_cleanup is idempotent
# ════════════════════════════════════════════════════════════════
echo "Test: mark_for_cleanup idempotency"
reset_mocks
mark_for_cleanup "worker-fly-102" 1000
mark_for_cleanup "worker-fly-102" 1100  # duplicate
mark_for_cleanup "qa-fly-102" 1050

count=$(wc -l < "$CLEANUP_PENDING" | tr -d ' ')
if [[ "$count" == "2" ]]; then
  pass "duplicate mark_for_cleanup does not add second entry (got $count)"
else
  fail "expected 2 entries, got $count"
fi
# First timestamp retained (not overwritten)
first_ts=$(grep "^worker-fly-102|" "$CLEANUP_PENDING" | cut -d'|' -f2)
if [[ "$first_ts" == "1000" ]]; then
  pass "first-seen timestamp retained on duplicate"
else
  fail "timestamp changed on duplicate: got $first_ts"
fi

# ════════════════════════════════════════════════════════════════
# Test 5: process_pending_cleanups respects delay
# ════════════════════════════════════════════════════════════════
echo "Test: process_pending_cleanups — 30s delay"
reset_mocks
now=$(date +%s)
recent=$((now - 5))      # 5s ago
expired=$((now - 60))    # 60s ago
mark_for_cleanup "recent-win" "$recent"
mark_for_cleanup "expired-win" "$expired"
seed_complete_cleanup_snapshot_after "$now"

# No matching sessions, so is_pane_alive returns false for both
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=""

process_pending_cleanups >/dev/null

# "recent-win" should still be pending
if grep -q "^recent-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "recent entry preserved (< 30s)"
else
  fail "recent entry erroneously cleaned up"
fi
# "expired-win" should be cleaned (removed from pending)
if grep -q "^expired-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  fail "expired entry not cleaned up"
else
  pass "expired entry cleaned up (>= 30s)"
fi
# No tmux/workspace authority was present, so only the durable queue row moves.
[[ -z "$MOCK_CMUX_OPS" ]] && pass "unproven display state receives no mutation" \
  || fail "unproven display state was mutated: $MOCK_CMUX_OPS"

# ════════════════════════════════════════════════════════════════
# Test 6: process_pending_cleanups cancels on pane restart
# ════════════════════════════════════════════════════════════════
echo "Test: pane restart cancels pending cleanup"
reset_mocks
now=$(date +%s)
expired=$((now - 60))
mark_for_cleanup "restart-win" "$expired"

# Simulate pane came back alive
MOCK_TMUX_WINDOWS="flywheel|@1|restart-win"
MOCK_PANE_DEAD="flywheel:restart-win=0"

process_pending_cleanups >/dev/null

if grep -q "^restart-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  fail "pending entry should be dropped when pane alive"
else
  pass "pending entry dropped when pane alive"
fi
if echo "$MOCK_TMUX_KILLED" | grep -q "cmux-restart-win"; then
  fail "should not kill linked session when pane alive"
else
  pass "linked session untouched when pane alive"
fi

# ════════════════════════════════════════════════════════════════
# Test 7: is_pane_alive with remain-on-exit (window exists, pane dead)
# ════════════════════════════════════════════════════════════════
echo "Test: is_pane_alive respects #{pane_dead}"
reset_mocks
MOCK_TMUX_WINDOWS="flywheel|@1|dead-win"
MOCK_PANE_DEAD="flywheel:dead-win=1"

if is_pane_alive "dead-win"; then
  fail "is_pane_alive returned true for dead pane"
else
  pass "is_pane_alive returns false for dead pane despite window existing"
fi

MOCK_PANE_DEAD="flywheel:dead-win=0"
if is_pane_alive "dead-win"; then
  pass "is_pane_alive returns true for live pane"
else
  fail "is_pane_alive returned false for live pane"
fi

# Missing window → dead
MOCK_TMUX_WINDOWS=""
if is_pane_alive "ghost-win"; then
  fail "is_pane_alive returned true for missing window"
else
  pass "is_pane_alive returns false for missing window"
fi

# A strict A0B1 view is an independent lifetime holder. Removing the spawning
# runner session must not make its still-live watched pane look dead; once that
# pane actually dies, the same view must become cleanup-eligible.
reset_mocks
MOCK_TMUX_SESSIONS="cmux-FLY-1364-qa-live"
MOCK_PANE_DEAD="cmux-FLY-1364-qa-live:FLY-1364-qa-live=0"
if is_pane_alive "FLY-1364-qa-live"; then
  pass "strict sole-holder view keeps a live watched pane alive after its runner session exits"
else
  fail "strict sole-holder view was incorrectly tied to the spawning runner session"
fi
MOCK_PANE_DEAD="cmux-FLY-1364-qa-live:FLY-1364-qa-live=1"
if is_pane_alive "FLY-1364-qa-live"; then
  fail "dead strict-view pane must not suppress cleanup"
else
  pass "strict sole-holder view becomes cleanup-eligible only when the watched pane dies"
fi

reset_mocks
printf 'exited|cmux-FLY-1364-qa-live|FLY-1364-qa-live\n' > "$TMPDIR_ROOT/strict-view-exited"
_drain_file "$TMPDIR_ROOT/strict-view-exited"
if grep -q '^FLY-1364-qa-live|' "$CLEANUP_PENDING" 2>/dev/null; then
  pass "strict-view pane-died event enters the ordinary delayed cleanup path"
else
  fail "strict-view pane-died event was filtered before cleanup"
fi

# ════════════════════════════════════════════════════════════════
# Test 8: drain_events dispatches by event type + session filter
# ════════════════════════════════════════════════════════════════
echo "Test: drain_events dispatches correctly"
reset_mocks
# Pre-populate event file with mixed events
cat > "$EVENT_FILE" <<'EOF'
create|flywheel|@42|worker-fly-102
create|runner-geoforge3d|@43|runner-task-1
create|flywheel|@44|zsh
create|unrelated|@45|should-skip
exited|flywheel|worker-fly-102
exited|unrelated|should-skip
register|runner-new
register|not-a-runner
EOF
# Ensure workspace_exists_for returns false so create_workspace_for_window is called
MOCK_CMUX_WORKSPACES=""
# For register path: register_session_hooks will inspect name
MOCK_TMUX_SESSIONS=""
# FLY-867 (Fix B): creates now require a LIVE source pane — mark both create
# targets alive (the implicit pre-FLY-867 assumption, now explicit).
MOCK_TMUX_WINDOWS=$'flywheel|@42|worker-fly-102\nrunner-geoforge3d|@43|runner-task-1'
MOCK_PANE_DEAD=$'flywheel:@42=0\nrunner-geoforge3d:@43=0'
saved_create_workspace_for_window=$(declare -f create_workspace_for_window)
create_workspace_for_window() {
  MOCK_CMUX_OPS+="new-workspace --command env -u TMUX tmux attach -t '=${VIEW_PREFIX}${3}'"$'\n'
}

drain_events >/dev/null 2>"$TMPDIR_ROOT/drain-events-create.log"
eval "$saved_create_workspace_for_window"

# create events: should trigger new-workspace twice (worker-fly-102 + runner-task-1)
create_count=$(echo "$MOCK_CMUX_OPS" | grep -c "^new-workspace" || true)
if [[ "$create_count" == "2" ]]; then
  pass "drain_events creates workspaces for 2 valid sessions"
else
  fail "expected 2 new-workspace calls, got $create_count. Ops: $MOCK_CMUX_OPS Log: $(tr '\n' ';' < "$TMPDIR_ROOT/drain-events-create.log")"
fi
# FLY-756: the create-time attach command must run under `env -u TMUX` — a cmux
# surface that inherited $TMUX (cmux launched from within tmux) would otherwise
# nest-fail `tmux attach` ("sessions should be nested with care, unset $TMUX").
if echo "$MOCK_CMUX_OPS" | grep -q "^new-workspace --command env -u TMUX tmux attach"; then
  pass "FLY-756: new-workspace --command runs attach under env -u TMUX"
else
  fail "FLY-756: create attach missing env -u TMUX; got: $(echo "$MOCK_CMUX_OPS" | grep '^new-workspace' | head -1)"
fi
# zsh filtered
if echo "$MOCK_CMUX_OPS" | grep -q "zsh"; then
  fail "zsh window should be filtered"
else
  pass "zsh window filtered from create path"
fi
# unrelated session filtered
if echo "$MOCK_CMUX_OPS" | grep -q "should-skip"; then
  fail "unrelated session's window should be filtered"
else
  pass "unrelated session filtered from create path"
fi
# exited event → marks for cleanup
if grep -q "^worker-fly-102|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "exited event marks window for cleanup"
else
  fail "exited event did not mark for cleanup"
fi
# exited for unrelated session skipped
if grep -q "^should-skip|" "$CLEANUP_PENDING" 2>/dev/null; then
  fail "unrelated exited event should be skipped"
else
  pass "unrelated exited event skipped"
fi
# register event → hook registered for runner-new only
if echo "$MOCK_TMUX_HOOKS" | grep -q "runner-new"; then
  pass "register event → runner-new hook registered"
else
  fail "runner-new hook not registered"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "not-a-runner"; then
  fail "register event → not-a-runner should be filtered"
else
  pass "register event filters non-flywheel/runner-* sessions"
fi
# Event file consumed
if [[ -f "$EVENT_FILE" ]]; then
  fail "event file should be removed after drain"
else
  pass "event file consumed"
fi

# ════════════════════════════════════════════════════════════════
# Test 9: cleanup_stale_conservative uses 5-minute threshold
# ════════════════════════════════════════════════════════════════
echo "Test: cleanup_stale_conservative — 5min threshold"
reset_mocks
# linked session exists; its corresponding tmux window doesn't
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-orphan-win'
MOCK_PANE_DEAD="cmux-orphan-win:orphan-win=1"
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:3","title":"orphan-win"}]}'
MOCK_CMUX_MUTATE_JSON=1
test_ledger_upsert committed cmux-test-generation workspace:3 orphan-win

# First pass — marker gets recorded, no cleanup yet
cleanup_stale_conservative >/dev/null
if grep -q "^orphan-win|" "$STALE_STATE" 2>/dev/null; then
  pass "first-seen stale marker written"
else
  fail "stale marker not written"
fi
if echo "$MOCK_TMUX_KILLED" | grep -q "cmux-orphan-win"; then
  fail "should not cleanup on first detection"
else
  pass "first detection does not cleanup"
fi

# Simulate >5min later by rewriting marker in the past
now=$(date +%s)
past=$((now - 400))
printf 'orphan-win|%s\n' "$past" > "$STALE_STATE"

cleanup_stale_conservative >/dev/null
seed_complete_cleanup_snapshot_after "$now"
process_pending_cleanups >/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:3"; then
  pass "conservative cleanup closes the exact receipted workspace after 5min"
else
  fail "expected exact-ref close after 5min. Ops: $MOCK_CMUX_OPS"
fi

# ════════════════════════════════════════════════════════════════
# Test 10: cleanup_stale_conservative clears marker when pane alive
# ════════════════════════════════════════════════════════════════
echo "Test: cleanup_stale_conservative clears marker on pane-alive return"
reset_mocks
# Pane alive → marker should be cleared
MOCK_TMUX_WINDOWS="flywheel|@1|returned-win"
MOCK_PANE_DEAD="flywheel:returned-win=0"
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-returned-win'
MOCK_CMUX_WORKSPACES=""
now=$(date +%s)
past=$((now - 200))
printf 'returned-win|%s\n' "$past" > "$STALE_STATE"

cleanup_stale_conservative >/dev/null

if grep -q "^returned-win|" "$STALE_STATE" 2>/dev/null; then
  fail "marker should be cleared when pane alive"
else
  pass "marker cleared when pane alive"
fi

# ════════════════════════════════════════════════════════════════
# Test 11: cleanup_stale_conservative treats dead pane (remain-on-exit) as stale
# ════════════════════════════════════════════════════════════════
echo "Test: cleanup_stale_conservative — dead pane with window still listed"
reset_mocks
# remain-on-exit: window still in list-windows, but pane is dead → should mark stale
MOCK_TMUX_WINDOWS="flywheel|@1|dead-pane-win"
MOCK_PANE_DEAD="flywheel:dead-pane-win=1"
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-dead-pane-win'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:4","title":"dead-pane-win"}]}'
MOCK_CMUX_MUTATE_JSON=1
test_ledger_upsert committed cmux-test-generation workspace:4 dead-pane-win

# First pass: mark stale
cleanup_stale_conservative >/dev/null
if grep -q "^dead-pane-win|" "$STALE_STATE" 2>/dev/null; then
  pass "dead-pane window marked stale despite window existing (remain-on-exit path)"
else
  fail "dead-pane window not marked stale — event-loss fallback would leak"
fi

# Fast-forward the marker by 6 minutes → cleanup should fire
now=$(date +%s)
past=$((now - 400))
printf 'dead-pane-win|%s\n' "$past" > "$STALE_STATE"
cleanup_stale_conservative >/dev/null
seed_complete_cleanup_snapshot_after "$now"
process_pending_cleanups >/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:4"; then
  pass "dead-pane exact workspace cleaned up after threshold"
else
  fail "expected exact workspace cleanup after 5min. Ops: $MOCK_CMUX_OPS"
fi

# ════════════════════════════════════════════════════════════════
# Test 12: drain_events replays leftover .processing after a crash
# ════════════════════════════════════════════════════════════════
echo "Test: drain_events crash recovery replays .processing leftover"
reset_mocks
# Simulate prior crash: .processing holds an exited event, $EVENT_FILE doesn't exist.
printf 'exited|flywheel|crashed-win\n' > "${EVENT_FILE}.processing"
# No windows/sessions — is_pane_alive returns false → exited will mark for cleanup
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=""

drain_events >/dev/null

if grep -q "^crashed-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "leftover .processing event replayed (no event loss across crash)"
else
  fail "leftover .processing event lost"
fi
if [[ -f "${EVENT_FILE}.processing" ]]; then
  fail ".processing should be cleaned up after replay"
else
  pass ".processing cleaned after replay"
fi

# ════════════════════════════════════════════════════════════════
# Test 13: drain_events merges .processing with new events on recovery
# ════════════════════════════════════════════════════════════════
echo "Test: drain_events merges leftover + fresh events"
reset_mocks
# Leftover from prior crash + fresh event arrived since
printf 'exited|flywheel|old-win\n' > "${EVENT_FILE}.processing"
printf 'exited|flywheel|new-win\n' > "$EVENT_FILE"
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=""

drain_events >/dev/null

if grep -q "^old-win|" "$CLEANUP_PENDING" 2>/dev/null && grep -q "^new-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "both old (leftover) and new events processed"
else
  fail "expected both old-win and new-win in pending. Got: $(cat "$CLEANUP_PENDING" 2>/dev/null)"
fi

# ════════════════════════════════════════════════════════════════
# Integration: real tmux hook expansion
# ════════════════════════════════════════════════════════════════
# Regression guard for the tmux 3.5a hook var trap — QA found that
# #{hook_session_name} / #{hook_window_name} / #{hook_window} expand to EMPTY
# under `run-shell -b` for after-new-window / pane-exited, even though the
# man page lists them. This test fires the real hook command strings against
# a real tmux session and asserts the resulting event lines have non-empty
# fields. The pure-mock tests above cannot catch this because they stub tmux.
echo "Test: real tmux hook expansion (integration)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "  ⏭  tmux not available — skipping"
else
  # Sourced flywheel-cmux-sync.sh sets `set -euo pipefail`; disable errexit
  # here so non-zero exits from tmux operations don't abort the test script.
  set +e
  TMUX_INT_EVENT_FILE="$TMPDIR_ROOT/int-events"
  TMUX_INT_SESSION="flywheel-cmux-sync-test-$$"
  TMUX_INT_SOCKET="$TMPDIR_ROOT/tmux-hook-integration.sock"
  > "$TMUX_INT_EVENT_FILE"

  # Use an explicit private socket and bypass the mock function defined above.
  # The default Flywheel/user tmux server is outside this test's authority.
  command tmux -S "$TMUX_INT_SOCKET" kill-server 2>/dev/null
  # FLY-129 R2: some sandboxes (AppArmor / restricted /tmp / codex review env)
  # reject tmux's socket creation. Probe + skip gracefully instead of failing.
  if ! command tmux -S "$TMUX_INT_SOCKET" new-session -d -s "$TMUX_INT_SESSION" -n initial 2>/dev/null; then
    echo "  ⏭  tmux new-session failed (sandbox / restricted env) — skipping integration test"
  else

  # Exact hook command strings from register_session_hooks / register_global_hooks.
  command tmux -S "$TMUX_INT_SOCKET" set-hook -t "$TMUX_INT_SESSION" 'after-new-window[500]' \
    "run-shell -b 'echo \"create|#{session_name}|#{window_id}|#{window_name}\" >> $TMUX_INT_EVENT_FILE'" 2>/dev/null
  command tmux -S "$TMUX_INT_SOCKET" set-hook -t "$TMUX_INT_SESSION" 'pane-exited[500]' \
    "run-shell -b 'echo \"exited|#{session_name}|#{window_name}\" >> $TMUX_INT_EVENT_FILE'" 2>/dev/null

  # Trigger after-new-window.
  command tmux -S "$TMUX_INT_SOCKET" new-window -t "$TMUX_INT_SESSION:" -n int-test-win 2>/dev/null
  # Give run-shell -b a moment to flush.
  sleep 0.3

  create_line=$(grep '^create|' "$TMUX_INT_EVENT_FILE" 2>/dev/null | head -1)
  if [[ -z "$create_line" ]]; then
    fail "no create event written to event file"
  else
    IFS='|' read -r _etype sess wid wname <<< "$create_line"
    if [[ -n "$sess" && -n "$wid" && -n "$wname" ]]; then
      pass "create event fields non-empty (sess=$sess wid=$wid wname=$wname)"
    else
      fail "create event has empty fields: sess='$sess' wid='$wid' wname='$wname'"
    fi
    if [[ "$sess" == "$TMUX_INT_SESSION" ]]; then
      pass "session_name expands to the session where hook fired"
    else
      fail "expected session=$TMUX_INT_SESSION, got session=$sess"
    fi
    if [[ "$wname" == "int-test-win" ]]; then
      pass "window_name expands to the new window"
    else
      fail "expected window_name=int-test-win, got window_name=$wname"
    fi
  fi

  # Calibrate the probe against a private real tmux server. Some tmux versions
  # reject a vanished @id; 3.5a falls back to the active window. Both must make
  # the product reject the vanished id and accept the survivor.
  TMUX_INT_GONE_ID=$(command tmux -S "$TMUX_INT_SOCKET" display-message -p \
    -t "=$TMUX_INT_SESSION:initial" '#{window_id}')
  command tmux -S "$TMUX_INT_SOCKET" new-window -t "$TMUX_INT_SESSION:" -n fly1672-survivor 2>/dev/null
  TMUX_INT_LIVE_ID=$(command tmux -S "$TMUX_INT_SOCKET" display-message -p \
    -t "=$TMUX_INT_SESSION:fly1672-survivor" '#{window_id}')
  command tmux -S "$TMUX_INT_SOCKET" kill-window -t "=$TMUX_INT_SESSION:$TMUX_INT_GONE_ID" 2>/dev/null

  TMUX_INT_RAW_RC=0
  TMUX_INT_RAW_ID=$(command tmux -S "$TMUX_INT_SOCKET" -N display-message -p \
    -t "=$TMUX_INT_SESSION:$TMUX_INT_GONE_ID" '#{window_id}' 2>/dev/null) || TMUX_INT_RAW_RC=$?
  if [[ "$TMUX_INT_RAW_RC" -eq 0 && "$TMUX_INT_RAW_ID" != "$TMUX_INT_GONE_ID" ]]; then
    pass "real tmux calibrator: vanished @id falls back to $TMUX_INT_RAW_ID"
  elif [[ "$TMUX_INT_RAW_RC" -ne 0 ]]; then
    pass "real tmux calibrator: vanished @id is rejected by this tmux version"
  else
    fail "real tmux calibrator returned the vanished id itself: $TMUX_INT_RAW_ID"
  fi

  TMUX_INT_GONE_RC=0
  (
    tmux() { command tmux -S "$TMUX_INT_SOCKET" -N "$@"; }
    window_source_pane_alive "$TMUX_INT_SESSION" "$TMUX_INT_GONE_ID"
  ) || TMUX_INT_GONE_RC=$?
  TMUX_INT_LIVE_RC=0
  (
    tmux() { command tmux -S "$TMUX_INT_SOCKET" -N "$@"; }
    window_source_pane_alive "$TMUX_INT_SESSION" "$TMUX_INT_LIVE_ID"
  ) || TMUX_INT_LIVE_RC=$?
  if [[ "$TMUX_INT_GONE_RC" -ne 0 && "$TMUX_INT_LIVE_RC" -eq 0 ]]; then
    pass "real tmux liveness probe rejects the vanished id and accepts the live id"
  else
    fail "real tmux liveness identity mismatch gone_rc=$TMUX_INT_GONE_RC live_rc=$TMUX_INT_LIVE_RC"
  fi

  fi  # tmux new-session probe close
  command tmux -S "$TMUX_INT_SOCKET" kill-server 2>/dev/null || true
  TMUX_INT_SOCKET=""
fi

# ════════════════════════════════════════════════════════════════
# FLY-129: cmux IPC health check + cmux_call wrapper
# ════════════════════════════════════════════════════════════════

# Helper: probe whether AF_UNIX socket creation works in this environment.
# Some sandboxes (codex review env, certain CI setups) deny AF_UNIX bind.
# Tests requiring a real socket should skip gracefully when this returns 1.
_can_bind_af_unix() {
  command -v python3 >/dev/null 2>&1 || return 1
  local probe="$TMPDIR_ROOT/.afunix-probe.$$"
  rm -f "$probe"
  python3 - "$probe" >/dev/null 2>&1 <<'PY'
import socket, sys
try:
    s = socket.socket(socket.AF_UNIX)
    s.bind(sys.argv[1])
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
PY
  local rc=$?
  rm -f "$probe"
  [[ $rc -eq 0 ]]
}

# Helper: spawn a python Unix-socket listener (creates the socket file).
# Echoes the PID on stdout. Caller is responsible for kill + wait + rm.
#
# Important: redirect python stdout/stderr away from the command-substitution
# capture pipe. Otherwise the long-running background process inherits that
# pipe and `pid=$(_spawn_unix_socket ...)` won't return until python exits.
_spawn_unix_socket() {
  local path="$1"
  python3 - "$path" >/dev/null 2>&1 <<'PY' &
import socket, sys, time
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
s.listen(1)
time.sleep(60)
PY
  local pid=$!
  local deadline=$((SECONDS + 5))
  while [[ ! -S "$path" && $SECONDS -lt $deadline ]]; do
    sleep 0.05
  done
  if [[ ! -S "$path" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 1
  fi
  echo "$pid"
}

_kill_unix_socket() {
  local pid="$1" path="$2"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$path"
}

# Save / restore the global cmux mock so per-test overrides don't leak.
_SAVED_CMUX_MOCK=""
_save_cmux_mock() { _SAVED_CMUX_MOCK="$(declare -f cmux 2>/dev/null || true)"; }
_restore_cmux_mock() {
  unset -f cmux 2>/dev/null || true
  if [[ -n "$_SAVED_CMUX_MOCK" ]]; then
    eval "$_SAVED_CMUX_MOCK"
  fi
}

test_health_check_no_socket() {
  echo "▶ test_health_check_no_socket"
  local fake_socket="$TMPDIR_ROOT/no-such-socket"
  rm -f "$fake_socket"
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  if [[ $rc -eq 1 ]]; then pass "missing socket → rc=1"; else fail "expected rc=1, got $rc"; fi
}

test_health_check_auth_rejected() {
  echo "▶ test_health_check_auth_rejected"
  if ! _can_bind_af_unix; then
    echo "  (skipped: AF_UNIX bind unavailable in this environment)"
    return 0
  fi
  local fake_socket="$TMPDIR_ROOT/cmux-fake-auth.sock"
  rm -f "$fake_socket"
  local server_pid
  if ! server_pid=$(_spawn_unix_socket "$fake_socket"); then
    echo "  (skipped: could not bind AF_UNIX socket — sandbox or permission issue)"
    return 0
  fi
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    if [[ "$1" == "ping" ]]; then
      echo "ERROR: Access denied — only processes started inside cmux can connect" >&2
      return 141
    fi
    return 0
  }
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  _restore_cmux_mock
  _kill_unix_socket "$server_pid" "$fake_socket"
  if [[ $rc -eq 2 ]]; then pass "auth rejected → rc=2"; else fail "expected rc=2, got $rc"; fi
}

test_health_check_healthy() {
  echo "▶ test_health_check_healthy"
  if ! _can_bind_af_unix; then
    echo "  (skipped: AF_UNIX bind unavailable in this environment)"
    return 0
  fi
  local fake_socket="$TMPDIR_ROOT/cmux-fake-healthy.sock"
  rm -f "$fake_socket"
  local server_pid
  if ! server_pid=$(_spawn_unix_socket "$fake_socket"); then
    echo "  (skipped: could not bind AF_UNIX socket — sandbox or permission issue)"
    return 0
  fi
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    [[ "$1" == "ping" ]] && echo "PONG" && return 0
    return 0
  }
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  _restore_cmux_mock
  _kill_unix_socket "$server_pid" "$fake_socket"
  if [[ $rc -eq 0 ]]; then pass "healthy → rc=0"; else fail "expected rc=0, got $rc"; fi
}

test_health_check_transient_error() {
  echo "▶ test_health_check_transient_error"
  if ! _can_bind_af_unix; then
    echo "  (skipped: AF_UNIX bind unavailable in this environment)"
    return 0
  fi
  local fake_socket="$TMPDIR_ROOT/cmux-fake-transient.sock"
  rm -f "$fake_socket"
  local server_pid
  if ! server_pid=$(_spawn_unix_socket "$fake_socket"); then
    echo "  (skipped: could not bind AF_UNIX socket — sandbox or permission issue)"
    return 0
  fi
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    if [[ "$1" == "ping" ]]; then
      echo "Error: Failed to connect to socket" >&2
      return 1
    fi
    return 0
  }
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  _restore_cmux_mock
  _kill_unix_socket "$server_pid" "$fake_socket"
  if [[ $rc -eq 3 ]]; then pass "transient → rc=3"; else fail "expected rc=3, got $rc"; fi
}

test_cmux_call_stdout_passthrough() {
  echo "▶ test_cmux_call_stdout_passthrough"
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    echo "workspace:1  alpha"
    echo "workspace:2  beta"
    return 0
  }
  local out
  out=$(cmux_call list-workspaces 2>/dev/null)
  _restore_cmux_mock
  if [[ "$out" == *"workspace:1  alpha"* && "$out" == *"workspace:2  beta"* ]]; then
    pass "stdout preserved through cmux_call wrapper"
  else
    fail "stdout mangled: '$out'"
  fi
}

test_cmux_call_stderr_logged_not_in_stdout() {
  echo "▶ test_cmux_call_stderr_logged_not_in_stdout"
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    echo "fake-stdout-line"
    echo "fake-stderr-line" >&2
    return 7
  }
  local out err
  err=$(mktemp)
  out=$(cmux_call list-workspaces 2>"$err") || true
  local err_content
  err_content=$(cat "$err")
  rm -f "$err"
  _restore_cmux_mock
  if [[ "$out" == *"fake-stdout-line"* ]] \
     && [[ "$err_content" == *"fake-stderr-line"* ]] \
     && [[ "$out" != *"fake-stderr-line"* ]]; then
    pass "stdout passes through, stderr captured to log (not stdout)"
  else
    fail "out='$out' err='$err_content'"
  fi
}

test_fly1944_bounded_cmux_preserves_stdout_and_rc() {
  echo "▶ test_fly1944_bounded_cmux_preserves_stdout_and_rc"
  if ! declare -F _cmux_bounded_spawn >/dev/null 2>&1; then
    fail "FLY-1944 bounded cmux primitive is missing"
    return 0
  fi
  _save_cmux_mock
  cmux() {
    echo "bounded-stdout"
    echo "bounded-stderr" >&2
    return 23
  }
  local marker="$TMPDIR_ROOT/fly1944-bounded.rc.timeout"
  local err="$TMPDIR_ROOT/fly1944-bounded.rc.err"
  local out rc=0
  : > "$marker"
  out=$(_cmux_bounded_spawn 5 "$marker" ping 2>"$err") || rc=$?
  _restore_cmux_mock
  if [[ $rc -eq 23 && "$out" == "bounded-stdout" ]] \
     && grep -q "bounded-stderr" "$err" \
     && [[ ! -s "$marker" ]]; then
    pass "bounded cmux preserves stdout, stderr, and the native exit code"
  else
    fail "bounded cmux changed result: rc=$rc out='$out' err='$(cat "$err" 2>/dev/null)' marker='$(cat "$marker" 2>/dev/null)'"
  fi
}

test_fly1944_bounded_cmux_timeout_reaps_process_group() {
  echo "▶ test_fly1944_bounded_cmux_timeout_reaps_process_group"
  if ! declare -F _cmux_bounded_spawn >/dev/null 2>&1; then
    fail "FLY-1944 bounded cmux primitive is missing"
    return 0
  fi
  _save_cmux_mock
  local descendant_file="$TMPDIR_ROOT/fly1944-bounded.descendant"
  local fake_bin="$TMPDIR_ROOT/fly1944-bounded-bin"
  local original_path="$PATH"
  rm -f "$descendant_file"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/bin/bash' \
    'sleep 30 &' \
    'descendant=$!' \
    'printf '\''%s\n'\'' "$descendant" > "$FLYWHEEL_CMUX_TEST_DESCENDANT_FILE"' \
    'wait "$descendant"' > "$fake_bin/cmux"
  chmod +x "$fake_bin/cmux"
  unset -f cmux
  export FLYWHEEL_CMUX_TEST_DESCENDANT_FILE="$descendant_file"
  PATH="$fake_bin:$PATH"
  local marker="$TMPDIR_ROOT/fly1944-bounded.timeout"
  local rc=0 descendant="" attempt=0
  : > "$marker"
  FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS=0 \
    _cmux_bounded_spawn 1 "$marker" ping >/dev/null 2>&1 || rc=$?
  PATH="$original_path"
  unset FLYWHEEL_CMUX_TEST_DESCENDANT_FILE
  _restore_cmux_mock
  [[ -s "$descendant_file" ]] && descendant=$(cat "$descendant_file")
  while [[ -n "$descendant" ]] && kill -0 "$descendant" 2>/dev/null && (( attempt < 20 )); do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if [[ $rc -eq 124 && -s "$marker" ]] \
     && { [[ -z "$descendant" ]] || ! kill -0 "$descendant" 2>/dev/null; }; then
    pass "timeout returns 124 and reaps the cmux process group"
  else
    fail "bounded timeout cleanup failed: rc=$rc marker='$(cat "$marker" 2>/dev/null)' descendant=${descendant:-missing}"
  fi
}

test_fly2207_bounded_cmux_refreshes_watch_heartbeat() {
  echo "▶ test_fly2207_bounded_cmux_refreshes_watch_heartbeat"
  _save_cmux_mock
  local writes=0 rc=0
  watcher_write_heartbeat() { writes=$((writes + 1)); }
  cmux() { return 23; }
  FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS=1
  CMUX_WATCH_HEARTBEAT_ACTIVE=1
  for rc in 1 2 3; do
    _cmux_bounded_spawn 1 "$TMPDIR_ROOT/fly2207-heartbeat-$rc.timeout" ping >/dev/null 2>&1 || true
  done
  CMUX_WATCH_HEARTBEAT_ACTIVE=0
  _cmux_bounded_spawn 1 "$TMPDIR_ROOT/fly2207-heartbeat-once.timeout" ping >/dev/null 2>&1 || true
  unset CMUX_WATCH_HEARTBEAT_ACTIVE
  eval "$(declare -f watcher_write_heartbeat_real | sed '1s/watcher_write_heartbeat_real/watcher_write_heartbeat/')"
  _restore_cmux_mock
  if [[ "$writes" == "3" ]]; then
    pass "every bounded watch call exit refreshes heartbeat; one-shot calls stay inert"
  else
    fail "bounded watch heartbeat writes=$writes expected=3"
  fi
}

test_fly2207_cmux_timeout_cap() {
  echo "▶ test_fly2207_cmux_timeout_cap"
  local output ok=1
  output=$(FLYWHEEL_CMUX_PING_TIMEOUT=60 FLYWHEEL_CMUX_CALL_TIMEOUT=60 \
    /bin/bash -c 'source "$1"; printf "%s|%s\n" "$CMUX_PING_TIMEOUT_SECONDS" "$CMUX_CALL_TIMEOUT_SECONDS"' \
    _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" 2>&1)
  [[ "$output" == *$'60|60' ]] || ok=0
  output=$(FLYWHEEL_CMUX_PING_TIMEOUT=61 FLYWHEEL_CMUX_CALL_TIMEOUT=61 \
    /bin/bash -c 'source "$1"; printf "%s|%s\n" "$CMUX_PING_TIMEOUT_SECONDS" "$CMUX_CALL_TIMEOUT_SECONDS"' \
    _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" 2>&1)
  [[ "$output" == *$'10|20' \
      && "$output" == *"FLYWHEEL_CMUX_PING_TIMEOUT=61 exceeds 60s"* \
      && "$output" == *"FLYWHEEL_CMUX_CALL_TIMEOUT=61 exceeds 60s"* ]] || ok=0
  if [[ "$ok" == "1" ]]; then
    pass "PING and CALL accept 60s and clamp larger values to their defaults with warnings"
  else
    fail "timeout clamp contract mismatch output=[$output]"
  fi
}

test_fly2207_watch_heartbeat_covers_cold_start() {
  echo "▶ test_fly2207_watch_heartbeat_covers_cold_start"
  local watch_dispatch active_line main_line
  watch_dispatch=$(awk '/^  --watch\)/,/^    ;;$/' "$SCRIPT_DIR/flywheel-cmux-sync.sh")
  active_line=$(printf '%s\n' "$watch_dispatch" | grep -n '^    CMUX_WATCH_HEARTBEAT_ACTIVE=1$' | cut -d: -f1)
  main_line=$(printf '%s\n' "$watch_dispatch" | grep -n '^    watch_main$' | cut -d: -f1)
  if [[ "$active_line" =~ ^[0-9]+$ && "$main_line" =~ ^[0-9]+$ \
      && "$active_line" -lt "$main_line" ]]; then
    pass "watch heartbeat is active before watch_main cold-start reconciliation"
  else
    fail "watch dispatcher does not activate bounded-call heartbeat before watch_main"
  fi
}

echo ""
echo "═══ FLY-129: cmux IPC health check + cmux_call ═══"
test_health_check_no_socket
test_health_check_auth_rejected
test_health_check_healthy
test_health_check_transient_error
test_cmux_call_stdout_passthrough
test_cmux_call_stderr_logged_not_in_stdout
test_fly1944_bounded_cmux_preserves_stdout_and_rc
test_fly1944_bounded_cmux_timeout_reaps_process_group
eval "$(declare -f watcher_write_heartbeat | sed '1s/watcher_write_heartbeat/watcher_write_heartbeat_real/')"
test_fly2207_bounded_cmux_refreshes_watch_heartbeat
unset -f watcher_write_heartbeat_real
test_fly2207_cmux_timeout_cap
test_fly2207_watch_heartbeat_covers_cold_start

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 1: watcher lock + sync_once watcher detection
# ════════════════════════════════════════════════════════════════
#
# acquire_watcher_lock calls `exit 0` on already-running and on retry
# exhaustion. We must run it inside a subshell so the test runner survives.
# Subshells inherit BASH_VERSION 3.2 — fine for our $$ comparisons (we use $!
# parent PID, not BASHPID, which is bash-4 only).

run_acquire_subshell() {
  # Returns: exit code of the subshell. Captures stderr (log()).
  local out_file="$1"
  ( acquire_watcher_lock ) >/dev/null 2>"$out_file"
  return $?
}

REAP_TEST_HOLDER_PID=""
start_reap_mutex_holder() {
  local ready="$1" attempt=0
  rm -f "$ready" 2>/dev/null || true
  (
    exec 9>>"$WATCHER_REAP_MUTEX" || exit 2
    if command -v lockf >/dev/null 2>&1; then
      command lockf -s -t 0 9 || exit 2
    elif command -v flock >/dev/null 2>&1; then
      command flock -n 9 || exit 2
    else
      exit 2
    fi
    : > "$ready"
    command sleep 30
  ) &
  REAP_TEST_HOLDER_PID=$!
  while [[ ! -f "$ready" && "$attempt" -lt 100 ]]; do
    kill -0 "$REAP_TEST_HOLDER_PID" 2>/dev/null || break
    command sleep 0.01
    attempt=$((attempt + 1))
  done
  [[ -f "$ready" ]]
}

stop_reap_mutex_holder() {
  if [[ -n "$REAP_TEST_HOLDER_PID" ]]; then
    kill "$REAP_TEST_HOLDER_PID" 2>/dev/null || true
    wait "$REAP_TEST_HOLDER_PID" 2>/dev/null || true
  fi
  REAP_TEST_HOLDER_PID=""
}

test_lock_acquire_blocks_second() {
  echo "Test: lock_acquire_blocks_second"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "$$" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  MOCK_MUTATOR_CENSUS='4242|/bin/bash /tmp/flywheel-cmux-sync --watch'
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  if run_acquire_subshell "$stderr_file" && grep -q "already running" "$stderr_file"; then
    pass "second acquire sees alive owner, exits 0 with 'already running' log"
  else
    fail "expected exit 0 + 'watcher already running' (stderr: $(cat "$stderr_file"))"
  fi
  # Ensure the lock dir still contains our PID — no fresh dir was created.
  local pid_in_lock
  pid_in_lock=$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid" 2>/dev/null || echo "")
  if [[ "$pid_in_lock" == "$$" ]]; then
    pass "lock dir untouched (PID file still contains original owner)"
  else
    fail "lock dir was modified — pid_in_lock='$pid_in_lock' expected '$$'"
  fi
}

test_lock_acquire_stale_pid_clean() {
  echo "Test: lock_acquire_stale_pid_clean"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  # 999999 is virtually guaranteed not to be a live PID on macOS.
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  # We can't easily call acquire then watch the trap fire (subshell exits
  # cleanly via `return 0`). Run as subshell — the trap fires on exit and
  # clears the lock dir. Check the pid file mid-run is hard; instead verify
  # that no "already running" log was emitted and that the subshell exit
  # was 0 (acquire success).
  if run_acquire_subshell "$stderr_file"; then
    if ! grep -q "already running" "$stderr_file"; then
      pass "stale PID reaped, fresh acquire succeeded"
    else
      fail "stale-PID path took the 'already running' branch (stderr: $(cat "$stderr_file"))"
    fi
  else
    fail "stale-PID acquire path did not return 0 (stderr: $(cat "$stderr_file"))"
  fi
}

test_lock_release_only_owns() {
  echo "Test: lock_release_only_owns"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "99999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"  # not us
  release_watcher_lock
  if [[ -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "release_watcher_lock does NOT delete a dir owned by another PID"
  else
    fail "release_watcher_lock deleted a dir we didn't own — pid file said 99999, not $$"
  fi
}

test_lock_acquire_mkdir_fails_after_reap() {
  echo "Test: lock_acquire_mkdir_fails_after_reap (live reap owner stays fail-closed)"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  local stderr_file="$TMPDIR_ROOT/acq.stderr" ready="$TMPDIR_ROOT/reap-holder.ready"
  if ! start_reap_mutex_holder "$ready"; then
    fail "could not start a real kernel reap-mutex holder"
    stop_reap_mutex_holder
    return
  fi
  sleep() { :; }
  export -f sleep
  if run_acquire_subshell "$stderr_file"; then
    if grep -q "already running" "$stderr_file" && [[ -f "$WATCHER_REAP_MUTEX" ]]; then
      pass "verified live reap owner is preserved and watcher exits without stealing"
    else
      fail "live reap owner was not treated as busy (stderr: $(cat "$stderr_file"))"
    fi
  else
    fail "busy reap-mutex path did not exit 0 — got non-zero (stderr: $(cat "$stderr_file"))"
  fi
  unset -f sleep
  stop_reap_mutex_holder
}

test_lock_acquire_retries_bounded() {
  # Same setup as above, but assert that the subshell completes in bounded
  # time (no infinite loop). Our override of `sleep` makes this trivial; the
  # real safeguard is the `for attempt in 1 2 3` loop.
  echo "Test: lock_acquire_retries_bounded (does not infinite loop)"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  local ready="$TMPDIR_ROOT/reap-holder-bounded.ready"
  if ! start_reap_mutex_holder "$ready"; then
    fail "could not start a real kernel reap-mutex holder"
    stop_reap_mutex_holder
    return
  fi
  sleep() { :; }
  export -f sleep
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  local t_start t_end
  t_start=$(date +%s)
  run_acquire_subshell "$stderr_file" || true
  t_end=$(date +%s)
  if (( t_end - t_start < 5 )); then
    pass "subshell exited in <5s (no infinite loop)"
  else
    fail "subshell took $((t_end - t_start))s (suspected infinite loop)"
  fi
  unset -f sleep
  stop_reap_mutex_holder
}

test_fly1364_stale_reap_mutex_recovers() {
  echo "Test: FLY-1364 lease — a crashed reap mutex cannot pin every future mutator"
  reset_mocks
  mkdir -p "$WATCHER_REAP_MUTEX"
  local rc=0
  acquire_mutator_lease qa_teardown || rc=$?
  if [[ "$rc" -eq 0 && -f "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" ]]; then
    pass "legacy empty reap mutex is reclaimed after a conclusive no-mutator census"
  else
    fail "stale reap mutex still blocked mutators rc=$rc mutex=$([[ -e "$WATCHER_REAP_MUTEX" ]] && echo present || echo absent)"
  fi
  release_mutator_lease
}

test_fly1364_pid_only_upgrade_preserves_live_watcher_census() {
  echo "Test: FLY-1364 lease — pid-only upgrade never steals from a live watcher census"
  local variant stderr_file marker ok=1
  for variant in missing malformed; do
    reset_mocks
    mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
    marker="$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/original-$variant"
    : > "$marker"
    if [[ "$variant" == "malformed" ]]; then
      printf 'not-a-pid\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
    fi
    MOCK_MUTATOR_CENSUS='4242|/bin/bash /tmp/flywheel-cmux-sync --watch'
    stderr_file="$TMPDIR_ROOT/pid-only-$variant.stderr"
    sleep() { :; }
    export -f sleep
    run_acquire_subshell "$stderr_file" || ok=0
    unset -f sleep
    [[ -e "$marker" ]] || ok=0
  done
  if [[ "$ok" == "1" ]]; then
    pass "missing and malformed legacy pid records preserve a census-proven live watcher"
  else
    fail "pid-only upgrade replaced a live watcher lock"
  fi
}

test_fly1364_non_directory_lease_node_fails_closed() {
  echo "Test: FLY-1364 lease — non-directory and symlink lease nodes are preserved as unverifiable"
  reset_mocks
  printf 'foreign-node\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  local before rc=0
  before=$(shasum -a 256 "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" | awk '{ print $1 }')
  acquire_mutator_lease once >/dev/null 2>&1 || rc=$?
  if [[ "$rc" == "2" && -f "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" \
      && "$(shasum -a 256 "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" | awk '{ print $1 }')" == "$before" ]]; then
    pass "foreign file at the lease path authorizes zero deletion or replacement"
  else
    fail "non-directory lease node was removed or treated as free rc=$rc"
  fi

  reset_mocks
  local foreign_target="$TMPDIR_ROOT/foreign-lease-target" symlink_rc=0
  mkdir -p "$foreign_target"
  printf 'foreign-marker\n' > "$foreign_target/marker"
  ln -s "$foreign_target" "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  acquire_mutator_lease once >/dev/null 2>&1 || symlink_rc=$?
  if [[ "$symlink_rc" == "2" && -L "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" \
      && "$(cat "$foreign_target/marker")" == "foreign-marker" \
      && ! -e "$foreign_target/owner" ]]; then
    pass "directory symlink at the lease path authorizes zero traversal or replacement"
  else
    fail "symlink lease node was followed, removed, or treated as free rc=$symlink_rc"
  fi
}

test_once_detects_watcher() {
  # FLY-2048: --once must fail loud and name the lease-handover cleanup path
  # when --watch is running; a successful no-op is not an operator action.
  echo "Test: once_detects_watcher"
  reset_mocks
  MOCK_PGREP_HIT="1"
  local stderr_file="$TMPDIR_ROOT/once.stderr"
  ( sync_once ) >/dev/null 2>"$stderr_file"
  local rc=$?
  if [[ $rc -ne 0 ]] && grep -q -- "--converge-runners --handover" "$stderr_file"; then
    pass "watcher collision fails loud and suggests the handover convergence path"
  else
    fail "rc=$rc stderr=$(cat "$stderr_file")"
  fi
}

echo ""
echo "═══ FLY-129 Phase 1: watcher lock + --once watcher detect ═══"
test_lock_acquire_blocks_second
test_lock_acquire_stale_pid_clean
test_lock_release_only_owns
test_lock_acquire_mkdir_fails_after_reap
test_lock_acquire_retries_bounded
test_fly1364_stale_reap_mutex_recovers
test_fly1364_pid_only_upgrade_preserves_live_watcher_census
test_fly1364_non_directory_lease_node_fails_closed
test_once_detects_watcher

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 2: register_session_hooks idempotent + log silence
# ════════════════════════════════════════════════════════════════

test_hooks_present_silent() {
  echo "Test: hooks_present_silent (no re-register, no log spam)"
  reset_mocks
  # Both hooks already present at index [500] — Phase 2 should be silent.
  MOCK_SHOW_HOOKS=$'after-new-window[500] run-shell -b "..."\npane-exited[500] run-shell -b "..."\n'
  local stderr_file="$TMPDIR_ROOT/hooks.stderr"
  register_session_hooks "flywheel" 2>"$stderr_file"
  if [[ -z "$MOCK_TMUX_HOOKS" ]]; then
    pass "no tmux set-hook calls when both hooks already present"
  else
    fail "expected zero set-hook calls; got: $MOCK_TMUX_HOOKS"
  fi
  if ! grep -q "registered" "$stderr_file"; then
    pass "no '(re-)registered' log line emitted"
  else
    fail "expected silent; got log: $(cat "$stderr_file")"
  fi
}

test_hooks_missing_reregister() {
  echo "Test: hooks_missing_reregister (was 0/2)"
  reset_mocks
  MOCK_SHOW_HOOKS=""
  local stderr_file="$TMPDIR_ROOT/hooks.stderr"
  register_session_hooks "flywheel" 2>"$stderr_file"
  if echo "$MOCK_TMUX_HOOKS" | grep -q 'after-new-window\[500\]' \
     && echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-exited\[500\]'; then
    pass "both hooks re-registered when missing"
  else
    fail "missing one or both hooks; got: $MOCK_TMUX_HOOKS"
  fi
  if grep -q "was 0/2" "$stderr_file"; then
    pass "log emits 'was 0/2'"
  else
    fail "expected 'was 0/2'; got: $(cat "$stderr_file")"
  fi
}

test_hooks_partial_reregister() {
  echo "Test: hooks_partial_reregister (was 1/2)"
  reset_mocks
  # Only after-new-window present; pane-exited missing.
  MOCK_SHOW_HOOKS=$'after-new-window[500] run-shell -b "..."\n'
  local stderr_file="$TMPDIR_ROOT/hooks.stderr"
  register_session_hooks "flywheel" 2>"$stderr_file"
  # Only pane-exited should have been (re-)set; after-new-window untouched.
  if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-exited\[500\]'; then
    pass "missing hook (pane-exited) was set"
  else
    fail "pane-exited not set; got: $MOCK_TMUX_HOOKS"
  fi
  if echo "$MOCK_TMUX_HOOKS" | grep -q 'after-new-window\[500\]'; then
    fail "after-new-window should NOT be re-set (was already present)"
  else
    pass "after-new-window left alone (already present)"
  fi
  if grep -q "was 1/2" "$stderr_file"; then
    pass "log emits 'was 1/2'"
  else
    fail "expected 'was 1/2'; got: $(cat "$stderr_file")"
  fi
}

echo ""
echo "═══ FLY-129 Phase 2: register_session_hooks idempotent + log silence ═══"
test_hooks_present_silent
test_hooks_missing_reregister
test_hooks_partial_reregister

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 3: JSON-based reverse-index + fail-closed callers
# ════════════════════════════════════════════════════════════════

JSON_TWO_DUP='{"workspaces":[{"ref":"workspace:1","title":"foo"},{"ref":"workspace:29","title":"foo"}]}'
JSON_WHITESPACE_TITLE='{"workspaces":[{"ref":"workspace:7","title":"foo bar baz"}]}'
test_get_cmux_workspaces_json_fail_closed_rc_nonzero() {
  echo "Test: get_cmux_workspaces_json_fail_closed_rc_nonzero (R2-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  local stderr_file="$TMPDIR_ROOT/json.stderr"
  local out rc=0
  out=$(get_cmux_workspaces_json 2>"$stderr_file") || rc=$?
  if [[ $rc -ne 0 && -z "$out" ]]; then
    pass "rc=$rc + empty stdout on cmux failure"
  else
    fail "expected non-zero + empty stdout; rc=$rc out='$out'"
  fi
  if [[ $(grep -c "cmux mutation skipped" "$stderr_file") == "1" ]]; then
    pass "exactly one transition log emitted"
  else
    fail "expected 1 transition log; got: $(cat "$stderr_file")"
  fi
}

test_get_cmux_workspaces_json_fail_closed_invalid_json() {
  echo "Test: get_cmux_workspaces_json_fail_closed_invalid_json (R2-1)"
  reset_mocks
  MOCK_CMUX_JSON_INVALID="1"
  local stderr_file="$TMPDIR_ROOT/json.stderr"
  local rc=0
  get_cmux_workspaces_json >/dev/null 2>"$stderr_file" || rc=$?
  if [[ $rc -ne 0 ]] && grep -q "invalid JSON" "$stderr_file"; then
    pass "invalid JSON → rc!=0 + 'invalid JSON' log"
  else
    fail "rc=$rc stderr=$(cat "$stderr_file")"
  fi
}

test_get_cmux_workspaces_json_recover_logs_once() {
  echo "Test: get_cmux_workspaces_json_recover_logs_once (R2-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  local stderr_file="$TMPDIR_ROOT/json-recover.stderr"
  rm -f "$stderr_file"  # don't accumulate from prior tests
  # 5 consecutive failures — first emits log, next 4 are silent.
  for _ in 1 2 3 4 5; do
    get_cmux_workspaces_json >/dev/null 2>>"$stderr_file" || true
  done
  local fail_logs
  fail_logs=$(grep -c "cmux mutation skipped" "$stderr_file" || true)
  if [[ "$fail_logs" == "1" ]]; then
    pass "5 consecutive failures → exactly 1 transition log"
  else
    fail "expected 1 log, got $fail_logs"
  fi
  # Recovery → 1 line "recovered"
  MOCK_CMUX_JSON_FAIL="0"
  get_cmux_workspaces_json >/dev/null 2>>"$stderr_file"
  if grep -q "recovered" "$stderr_file"; then
    pass "recovery emits 'recovered' log"
  else
    fail "no 'recovered' log; stderr=$(cat "$stderr_file")"
  fi
}

test_reconcile_existing_workspaces_skips_tick_without_json() {
  echo "Test: reconcile_existing_workspaces skips the whole tick when JSON is unavailable"
  local calls="$TMPDIR_ROOT/reconcile-existing-json-gate" saved_windows saved_json saved_linked saved_dismantle saved_json_state
  saved_windows=$(declare -f get_tmux_agent_windows)
  saved_json=$(declare -f get_cmux_workspaces_json)
  saved_linked=$(declare -f linked_session_exists)
  saved_dismantle=$(declare -f dismantle_view_display)
  saved_json_state="$CMUX_JSON_LAST_STATE"
  : > "$calls"

  get_tmux_agent_windows() { printf 'runner-flywheel|@42|FLY-1807-json-gate\n'; }
  get_cmux_workspaces_json() { printf 'json\n' >> "$calls"; CMUX_JSON_LAST_STATE="fail"; return 2; }
  linked_session_exists() { printf 'linked\n' >> "$calls"; return 1; }
  dismantle_view_display() { printf 'dismantle\n' >> "$calls"; return 0; }

  CMUX_JSON_LAST_STATE="ok"
  reconcile_existing_workspaces

  eval "$saved_windows"
  eval "$saved_json"
  eval "$saved_linked"
  eval "$saved_dismantle"
  if [[ "$(cat "$calls")" == "json" && "$CMUX_JSON_LAST_STATE" == "ok" ]]; then
    pass "unreadable workspace JSON causes zero reconcile actions or latch changes"
  else
    fail "reconcile crossed the JSON gate: calls=$(tr '\n' ';' < "$calls") latch=$CMUX_JSON_LAST_STATE"
  fi
  CMUX_JSON_LAST_STATE="$saved_json_state"
}

test_workspace_refs_for_dup() {
  echo "Test: workspace_refs_for_dup (multi-line return)"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_TWO_DUP"
  local refs rc=0
  refs=$(workspace_refs_for "foo") || rc=$?
  if [[ $rc -eq 0 ]] && [[ "$refs" == *"workspace:1"* ]] && [[ "$refs" == *"workspace:29"* ]]; then
    pass "two refs returned, one per line"
  else
    fail "rc=$rc refs='$refs'"
  fi
}

test_workspace_refs_for_with_whitespace_title() {
  echo "Test: workspace_refs_for_with_whitespace_title"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_WHITESPACE_TITLE"
  local refs
  refs=$(workspace_refs_for "foo bar baz")
  if [[ "$refs" == "workspace:7" ]]; then
    pass "ref returned for title with spaces (JSON path)"
  else
    fail "expected 'workspace:7', got '$refs'"
  fi
}

test_workspace_refs_for_none() {
  echo "Test: workspace_refs_for_none"
  reset_mocks
  local refs rc=0
  refs=$(workspace_refs_for "nothing") || rc=$?
  if [[ $rc -eq 0 && -z "$refs" ]]; then
    pass "rc=0 + empty stdout for missing title"
  else
    fail "rc=$rc refs='$refs'"
  fi
}

test_workspace_refs_for_rc2_on_json_fail() {
  echo "Test: workspace_refs_for returns rc=2 on JSON failure (R3-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  local refs rc=0
  refs=$(workspace_refs_for "anything" 2>/dev/null) || rc=$?
  if [[ $rc -eq 2 && -z "$refs" ]]; then
    pass "rc=2 + empty stdout signals JSON-unavailable"
  else
    fail "expected rc=2 + empty; got rc=$rc refs='$refs'"
  fi
}

test_workspace_exists_for_tri_state() {
  echo "Test: workspace_exists_for tri-state (0=found, 1=missing, 2=unavailable)"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_TWO_DUP"
  local rc=0
  workspace_exists_for "foo" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 0 ]] && pass "rc=0 for found" || fail "expected 0, got $rc"
  rc=0
  workspace_exists_for "not-here" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 1 ]] && pass "rc=1 for missing" || fail "expected 1, got $rc"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  rc=0
  workspace_exists_for "anything" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 2 ]] && pass "rc=2 for JSON unavailable" || fail "expected 2, got $rc"
}

test_close_workspace_by_ref_dry_run() {
  echo "Test: close_workspace_by_ref dry-run skips cmux call but logs audit"
  reset_mocks
  local stderr_file="$TMPDIR_ROOT/close.stderr"
  FLYWHEEL_CMUX_DRY_RUN=1 close_workspace_by_ref "workspace:1" "test" 2>"$stderr_file"
  if [[ -z "$MOCK_CMUX_OPS" ]] && grep -q "audit.*dry_run=1" "$stderr_file"; then
    pass "no cmux ops + audit log shows dry_run=1"
  else
    fail "ops='$MOCK_CMUX_OPS' stderr='$(cat "$stderr_file")'"
  fi
}

test_close_workspace_by_ref_real() {
  echo "Test: close_workspace_by_ref real call + audit log"
  reset_mocks
  local stderr_file="$TMPDIR_ROOT/close.stderr"
  close_workspace_by_ref "workspace:7" "stale-foo" 2>"$stderr_file"
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:7" \
     && grep -q "audit.*reason=stale-foo" "$stderr_file"; then
    pass "1 cmux close call + audit log"
  else
    fail "ops='$MOCK_CMUX_OPS' stderr='$(cat "$stderr_file")'"
  fi
}

test_drain_handles_regex_metachars_in_name() {
  echo "Test: drain_stale_state_row handles regex metacharacters in name (Phase 5)"
  reset_mocks
  echo "foo.bar[1]|1700000000" > "$STALE_STATE"
  echo "other|1700000001" >> "$STALE_STATE"
  drain_stale_state_row "foo.bar[1]"
  # foo.bar[1] removed (literal match), other untouched (sed regex would have matched 'other' too if naive)
  if ! grep -q "foo.bar\[1\]" "$STALE_STATE" && grep -q "^other|" "$STALE_STATE"; then
    pass "literal-compare drain: foo.bar[1] removed, other preserved"
  else
    fail "STALE_STATE state: $(cat "$STALE_STATE")"
  fi
}

test_is_pane_alive_handles_regex_metachars() {
  # Codex R2 MEDIUM fix regression guard: window names with regex
  # metacharacters (`.`, `[`, `]`) must NOT cross-match in is_pane_alive.
  echo "Test: is_pane_alive uses literal-field compare for window name (Codex R2)"
  reset_mocks
  MOCK_TMUX_WINDOWS=$'flywheel|@1|foo-bar-1\nflywheel|@2|foo.bar[1]'
  # foo.bar[1] live; foo-bar-1 dead — opposite of what a naive regex match
  # would yield (where '.' / '[1]' wildcards would let them collide).
  MOCK_PANE_DEAD=$'flywheel:foo-bar-1=1\nflywheel:foo.bar[1]=0'
  local rc=0
  is_pane_alive "foo.bar[1]" || rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "is_pane_alive('foo.bar[1]') = alive (literal match found live pane)"
  else
    fail "expected alive (rc=0), got rc=$rc topology=[$(tr '\n' ';' < "$TOPO_WINDOWS")] sessions=[$(tr '\n' ';' < "$TOPO_SESSIONS")]"
  fi
  rc=0
  is_pane_alive "foo-bar-1" || rc=$?
  if [[ $rc -eq 1 ]]; then
    pass "is_pane_alive('foo-bar-1') = dead (NOT confused with foo.bar[1])"
  else
    fail "expected dead (rc=1), got rc=$rc — likely matched foo.bar[1] by regex"
  fi
}

echo ""
echo "═══ FLY-129 Phase 3+5: JSON reverse-index + fail-closed + STALE_STATE drain ═══"
test_get_cmux_workspaces_json_fail_closed_rc_nonzero
test_get_cmux_workspaces_json_fail_closed_invalid_json
test_get_cmux_workspaces_json_recover_logs_once
test_reconcile_existing_workspaces_skips_tick_without_json
test_workspace_refs_for_dup
test_workspace_refs_for_with_whitespace_title
test_workspace_refs_for_none
test_workspace_refs_for_rc2_on_json_fail
test_workspace_exists_for_tri_state
test_close_workspace_by_ref_dry_run
test_close_workspace_by_ref_real
test_drain_handles_regex_metachars_in_name
test_is_pane_alive_handles_regex_metachars

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 4: ghost reaper
# ════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 6: newest-wins
# ════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 7: cmux ping backoff + state-transition log (R2-2)
# ════════════════════════════════════════════════════════════════

test_next_sleep_seconds_table() {
  echo "Test: next_sleep_seconds backoff curve"
  local ok=1
  for entry in "0:15" "1:15" "2:30" "5:30" "6:60" "10:60" "11:300" "30:300" "50:300"; do
    local count="${entry%:*}" expected="${entry#*:}"
    local got
    got=$(next_sleep_seconds "$count")
    if [[ "$got" != "$expected" ]]; then
      fail "count=$count expected=$expected got=$got"
      ok=0
    fi
  done
  (( ok == 1 )) && pass "all backoff table entries match"
}

# Helper to drive cmux_health_check via a mock socket file. We force
# rc=3 (transient) by pointing CMUX_SOCKET_PATH at a real file that ping
# rejects — actually easier to just stub cmux_health_check directly in
# these tests.

test_health_silent_on_repeat_rc3_no_inner_warn() {
  echo "Test: health_silent_on_repeat_rc3 — no per-tick 'WARN: cmux ping' (R2-2)"
  reset_mocks
  # Stub cmux_health_check to return rc=3 + stash diag.
  cmux_health_check() { CMUX_HEALTH_LAST_DIAG="rc=3 (stubbed transient)"; return 3; }
  local stderr_file="$TMPDIR_ROOT/h.stderr"
  rm -f "$stderr_file"
  for _ in 1 2 3 4 5; do
    cmux_health_check_or_die 2>>"$stderr_file" || true
  done
  # Inner WARN must not appear (R2-2: that log was deleted)
  if grep -q "cmux ping failed transiently" "$stderr_file"; then
    fail "saw deprecated inner 'cmux ping failed transiently' log"
  else
    pass "no inner-WARN spam (R2-2 verified)"
  fi
  # State-machine transition log = exactly 1 line on first fail
  local trans
  trans=$(grep -c "cmux unhealthy" "$stderr_file" || true)
  if [[ "$trans" == "1" ]]; then
    pass "1 transition log over 5 consecutive rc=3 ticks"
  else
    fail "expected 1 transition log, got $trans"
  fi
  # Reset stub
  unset -f cmux_health_check
}

test_health_logs_on_recovery_from_rc3() {
  echo "Test: health_logs_on_recovery_from_rc3 + diag included"
  reset_mocks
  CMUX_HEALTH_LAST_RC=0
  CMUX_HEALTH_FAIL_SINCE=""
  CMUX_HEALTH_FAIL_COUNT=0
  local stderr_file="$TMPDIR_ROOT/h.stderr"
  rm -f "$stderr_file"
  # rc=3 enters fail state
  cmux_health_check() { CMUX_HEALTH_LAST_DIAG="rc=3 diag-from-test"; return 3; }
  cmux_health_check_or_die 2>>"$stderr_file" || true
  # rc=0 should emit recovery
  cmux_health_check() { return 0; }
  cmux_health_check_or_die 2>>"$stderr_file"
  if grep -q "cmux recovered" "$stderr_file"; then
    pass "recovery log emitted on rc=3 → rc=0"
  else
    fail "no recovery log; stderr=$(cat "$stderr_file")"
  fi
  unset -f cmux_health_check
}

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 8: H2 fix (Path A list_lead_refs + Path B pending invalidation)
# ════════════════════════════════════════════════════════════════

test_list_lead_refs_returns_only_flywheel() {
  echo "Test: list_lead_refs returns refs for flywheel session windows only"
  reset_mocks
  MOCK_TMUX_WINDOWS="flywheel|@1|ops-lead
flywheel|@2|product-lead
runner-foo|@3|runner-task"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"ops-lead"},{"ref":"workspace:2","title":"product-lead"},{"ref":"workspace:3","title":"runner-task"}]}'
  local refs
  refs=$(list_lead_refs)
  # ops-lead + product-lead should be present, runner-task should NOT.
  if echo "$refs" | grep -qx "workspace:1" \
     && echo "$refs" | grep -qx "workspace:2" \
     && ! echo "$refs" | grep -qx "workspace:3"; then
    pass "returns Lead refs only (no Runner refs)"
  else
    fail "got refs='$refs'"
  fi
}

test_json_missing_workspaces_key_treated_as_fail() {
  # Codex R1 MEDIUM fix: a parse-OK response without a "workspaces" array
  # (e.g. {"error":"foo"}) must be treated as JSON-unavailable, not as
  # "zero workspaces". Otherwise downstream callers blindly create.
  echo "Test: get_cmux_workspaces_json rejects valid JSON missing 'workspaces' key"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"error":"server problem"}'
  local rc=0
  get_cmux_workspaces_json >/dev/null 2>&1 || rc=$?
  if [[ $rc -ne 0 ]]; then
    pass "rc!=0 on JSON missing 'workspaces' array"
  else
    fail "expected non-zero; got rc=$rc"
  fi
}

echo ""
echo "═══ FLY-129 Phase 4: ghost reaper ═══"

echo ""
echo "═══ FLY-129 Phase 6: newest-wins ═══"

echo ""
echo "═══ FLY-129 Phase 7: cmux ping backoff + state-transition log (R2-2) ═══"
test_next_sleep_seconds_table
test_health_silent_on_repeat_rc3_no_inner_warn
test_health_logs_on_recovery_from_rc3

echo ""
echo "═══ FLY-129 Phase 8: H2 fix (list_lead_refs only — Path A) ═══"
test_list_lead_refs_returns_only_flywheel
test_json_missing_workspaces_key_treated_as_fail

# ════════════════════════════════════════════════════════════════
# FLY-169: event-driven cmux workspace attach self-heal
# Run with errexit ON to mirror production (`set -euo pipefail`) and prove the
# self_heal_one_workspace loop survives the deliberate rc=1/2 returns from
# self_heal_workspace_ref (R6-#1).
# ════════════════════════════════════════════════════════════════
echo ""
echo "═══ FLY-169: cmux attach self-heal ═══"
set -e   # deterministic errexit for this block (regardless of earlier set +e)

# Fixture: one Lead window "lead-a" with a live linked session + one workspace
# (workspace:1) titled "lead-a" (managed) with a selected terminal surface
# (surface:1). $1 = client spec for view session cmux-lead-a (e.g. "0","1","0,2").
# Detection keys on the 0-client STATE + managed workspace title, NOT the
# surface title (which is the live foreground process, not the create command).
fly169_setup_one() {
  reset_mocks
  MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
  MOCK_PANE_DEAD=$'flywheel:@1=0'   # FLY-280: @1 live → live-id select resolves it
  MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"}]}'
  MOCK_CMUX_SURFACES="workspace:1;;surface:1;;terminal;;true"
  MOCK_TMUX_CLIENTS="cmux-lead-a=${1}"
}

# Live-machine QA uses an isolated tmux server. The attach-command builder must
# preserve the byte-compatible production default while allowing one explicit,
# executable absolute-path wrapper; malformed overrides fail closed.
attach_wrapper="$TMPDIR_ROOT/fly1364-isolated-tmux"
printf '#!/bin/sh\nexit 0\n' > "$attach_wrapper"
chmod +x "$attach_wrapper"
default_attach=$(build_attach_command "cmux-lead-a" 2>/dev/null || true)
FLYWHEEL_CMUX_ATTACH_TMUX_BIN="$attach_wrapper"
isolated_attach=$(build_attach_command "cmux-lead-a" 2>/dev/null || true)
FLYWHEEL_CMUX_ATTACH_TMUX_BIN="$TMPDIR_ROOT/invalid'wrapper"
invalid_attach_rc=0
build_attach_command "cmux-lead-a" >/dev/null 2>&1 || invalid_attach_rc=$?
unset FLYWHEEL_CMUX_ATTACH_TMUX_BIN
if [[ "$default_attach" == "env -u TMUX '$FLYWHEEL_CMUX_VIEW_HELPER_BIN' 'cmux-lead-a'" ]] \
    && [[ "$isolated_attach" == "env -u TMUX FLYWHEEL_CMUX_ATTACH_TMUX_BIN='$attach_wrapper' '$FLYWHEEL_CMUX_VIEW_HELPER_BIN' 'cmux-lead-a'" ]] \
    && [[ "$invalid_attach_rc" != "0" ]]; then
  pass "attach command uses the reconnect helper and validates the isolated-server seam"
else
  fail "attach command seam mismatch default=[$default_attach] isolated=[$isolated_attach] invalid_rc=$invalid_attach_rc"
fi

# Test 1: 0-client → ONE atomic re-attach send (cmd + newline) scoped to the
# selected terminal surface, NO separate send-key, + select-window + refresh
fly169_setup_one 0
self_heal_one_workspace "lead-a"
expected_attach=$(build_attach_command "cmux-lead-a")
if echo "$MOCK_CMUX_OPS" | grep -qF "send --workspace workspace:1 --surface surface:1 $expected_attach"; then
  pass "0-client: atomic send scoped to --workspace + selected --surface with attach cmd (FLY-756: env -u TMUX)"
else
  fail "expected surface-scoped attach send; got: $MOCK_CMUX_OPS"
fi
if echo "$MOCK_CMUX_OPS" | grep -q "send-key"; then
  fail "atomic re-attach must NOT use a separate send-key (text→Enter gap); got: $MOCK_CMUX_OPS"
else
  pass "atomic: no separate send-key (newline embedded in the single send)"
fi
if echo "$MOCK_CMUX_OPS" | grep -q "refresh-surfaces"; then pass "refresh-surfaces after heal"; else fail "missing refresh-surfaces"; fi
if echo "$MOCK_TMUX_SELECTS" | grep -q "=cmux-lead-a:@1"; then pass "select-window points at LIVE agent window (FLY-280 by id)"; else fail "missing select-window by live id"; fi

# Test 2: client>0 (attached) → MUST NOT send (Claude-prompt safety), only select-window
fly169_setup_one 1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then
  fail "CRITICAL: must NOT send into an attached surface (Claude prompt risk); got: $MOCK_CMUX_OPS"
else
  pass "attached: no send (never types into Claude prompt)"
fi
if echo "$MOCK_TMUX_SELECTS" | grep -q "=cmux-lead-a:@1"; then pass "attached: select-window by live id only (safe)"; else fail "expected select-window by live id when attached"; fi
# FLY-280: attached branch now also repaints the Electron surface after re-point.
if echo "$MOCK_CMUX_OPS" | grep -q "refresh-surfaces"; then pass "attached: refresh-surfaces repaint after re-point (FLY-280)"; else fail "expected refresh-surfaces in attached branch"; fi

# Test 3: workspace has NO terminal surface (e.g. only a browser pane) → no send
fly169_setup_one 0
MOCK_CMUX_SURFACES="workspace:1;;surface:1;;browser;;true"
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must NOT send when no terminal surface"; else pass "no terminal surface: not touched"; fi
if [[ -z "$MOCK_TMUX_SELECTS" ]]; then pass "no terminal surface: no select-window (healed=0)"; else fail "unexpected select-window: $MOCK_TMUX_SELECTS"; fi

# Test 3a (CI Bash 5 + nounset): disabling strict views must still initialize
# the strict-only title set before the ordinary agent-window sweep reads it.
if (
  reset_mocks
  MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
  MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"}]}'
  MOCK_CMUX_SURFACES='workspace:1;;surface:1;;terminal;;true'
  MOCK_TMUX_CLIENTS='cmux-lead-a=1'
  self_heal_sweep_all >/dev/null
); then
  pass "strict-view rollback keeps the ordinary heal sweep nounset-safe"
else
  fail "strict-view rollback left the ordinary heal sweep with unbound strict-only state"
fi

# Test 3b (structural no-hijack): self_heal_sweep_all iterates agent windows and
# conclusive owned strict views only. A user's workspace with neither authority
# is never targeted, even if it's detached with a terminal surface.
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'   # only lead-a is an agent window
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-random-user-ws'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"random-user-ws","ref":"workspace:9"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:9;;surface:9;;terminal;;true'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=1\ncmux-random-user-ws=0'   # lead-a attached; random ws detached
self_heal_sweep_all
if echo "$MOCK_CMUX_OPS" | grep -q "workspace:9"; then
  fail "HIJACK: swept a non-agent-window user workspace (workspace:9)"
else
  pass "structural no-hijack: non-agent-window workspace never swept"
fi

# Test 4: multiple terminal surfaces, one selected → send targets the SELECTED one
fly169_setup_one 0
MOCK_CMUX_SURFACES=$'workspace:1;;surface:9;;terminal;;\nworkspace:1;;surface:7;;terminal;;true'
self_heal_one_workspace "lead-a"
expected_attach=$(build_attach_command "cmux-lead-a")
if echo "$MOCK_CMUX_OPS" | grep -qF -- "--surface surface:7 $expected_attach"; then
  pass "multi-surface: send targets the SELECTED terminal surface:7 (not surface:9)"
else
  fail "wrong surface targeted; got: $MOCK_CMUX_OPS"
fi

# Test 4b (Codex CR R3 HIGH): target view session has 0 clients, BUT the selected
# surface is attached to a DIFFERENT tmux session (read-screen shows a tmux
# status bar, not a prompt sigil) → bare-shell gate MUST block the send.
fly169_setup_one 0
MOCK_CMUX_READSCREEN='[cmux-other-lead:win* 1:claude  2:zsh     "host" 23:58 26-May-26'
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then
  fail "CRITICAL: surface attached to ANOTHER session (status bar) must NOT receive a send"
else
  pass "bare-shell gate: surface attached elsewhere (status bar) → no send"
fi

# Test 4c: read-screen failure → fail-closed, no send
fly169_setup_one 0
MOCK_CMUX_READSCREEN_FAIL=1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must fail-closed on read-screen failure"; else pass "read-screen failure → no send (fail-closed)"; fi

# Test 5: duplicate workspace refs (dup title) → iterate ALL, send to each intent ref
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:2"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:2;;surface:2;;terminal;;true'
MOCK_TMUX_CLIENTS="cmux-lead-a=0"
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1 --surface surface:1" \
   && echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:2 --surface surface:2"; then
  pass "dup refs: iterates all (no dedup-winner guess)"
else
  fail "expected sends to both dup refs; got: $MOCK_CMUX_OPS"
fi

# Test 6: tmux list-clients error → fail-closed, no send
fly169_setup_one 0
MOCK_TMUX_CLIENTS=""   # cmux-lead-a not mocked → list-clients rc=1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must fail-closed on list-clients error"; else pass "list-clients error: no send (fail-closed)"; fi

# Test 7: malformed list-pane-surfaces JSON → no send, no traceback
fly169_setup_one 0
MOCK_CMUX_SURFACES_INVALID=1
heal_out=$(self_heal_one_workspace "lead-a" 2>&1)
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must fail-closed on malformed surfaces JSON"; else pass "malformed JSON: no send"; fi
if echo "$heal_out" | grep -qi "traceback"; then fail "Python traceback leaked"; else pass "malformed JSON: no traceback"; fi

# Test 8: TOCTOU — first count 0, recheck before send flips to >0 → no send
fly169_setup_one 0
MOCK_TMUX_CLIENTS="cmux-lead-a=0,2"   # call1=0 (outer), call2=2 (recheck) → block send
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "TOCTOU: must NOT send when client appears before send"; else pass "TOCTOU recheck blocks send"; fi

# Test 8b: mid-loop TOCTOU (dup refs) — first ref sends, then client appears → 2nd ref not sent
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:2"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:2;;surface:2;;terminal;;true'
# FLY-1884: the guarded mutation repeats authority probes after read-screen,
# then makes its second client count the final tmux proof before send. Sequence:
# outer=0, ref1 GATE1=0, guard pre-screen=0, guard final=0 (send), ref2 GATE1=2.
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,0,0,2"
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1"; then pass "mid-loop: first ref sent"; else fail "first ref should send"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:2"; then fail "second ref must NOT send after client appears"; else pass "mid-loop: loop breaks before second ref"; fi

# Test 8d (FLY-756): PLAIN heal path gate→send race. The final 0-client guard
# now runs for plain heal too (previously escalated-only). A focus-triggered
# attach that lands BETWEEN GATE1 and the send is caught: GATE1=0 passes, the
# final guard re-reads clients as 1 → MUST NOT send, and rc=2 (client appeared)
# surfaces to the caller. This is the exact nested-attach injection race.
fly169_setup_one 0
MOCK_TMUX_CLIENTS="cmux-lead-a=0,1"   # GATE1=0 (pass) → FINAL-GUARD=1 (client raced in)
fr756=0
fr756_generation=$(cmux_socket_identity)
self_heal_workspace_ref "lead-a" "workspace:1" "$fr756_generation" || fr756=$?
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then
  fail "FLY-756: plain-path final guard must block send when a client appears after GATE1; got: $MOCK_CMUX_OPS"
else
  pass "FLY-756: plain-path gate→send race blocked by final 0-client guard (no send)"
fi
[[ "$fr756" == "2" ]] && pass "FLY-756: rc=2 (client appeared) surfaces to caller" || fail "FLY-756: expected rc=2, got $fr756"

# Test 8c (Codex CR R1+R4 HIGH — designed out): the re-attach is a SINGLE
# atomic send (cmd + embedded newline), so there is NO text→Enter gap at all.
# Assert exactly one send op and zero send-key ops on a normal heal.
fly169_setup_one 0
self_heal_one_workspace "lead-a"
SEND_N=$(echo "$MOCK_CMUX_OPS" | grep -c "^send --workspace workspace:1" || true)
SENDKEY_N=$(echo "$MOCK_CMUX_OPS" | grep -c "^send-key" || true)
if [[ "$SEND_N" == "1" && "$SENDKEY_N" == "0" ]]; then
  pass "atomic re-attach: exactly 1 send, 0 send-key (no text→Enter gap)"
else
  fail "expected 1 send + 0 send-key; got send=$SEND_N send-key=$SENDKEY_N. Ops: $MOCK_CMUX_OPS"
fi

# FLY-1944: a pane that remains a bare shell cannot receive unbounded attach
# injection, but it is not positive death evidence and must never be replaced.
fly169_setup_one 0
for _fly1884_attempt in 1 2 3 4 5; do self_heal_one_workspace "lead-a"; done
SEND_N=$(grep -c '^send --workspace workspace:1' <<< "$MOCK_CMUX_OPS" || true)
RESPAWN_N=$(grep -c '^respawn-pane --workspace workspace:1' <<< "$MOCK_CMUX_OPS" || true)
if [[ "$SEND_N" == 3 && "$RESPAWN_N" == 0 ]]; then
  pass "FLY-1944 bare attach recovery is bounded at three sends and never replaced"
else
  fail "FLY-1884 ordinary recovery budget drifted send=$SEND_N respawn=$RESPAWN_N ops=[$MOCK_CMUX_OPS]"
fi

# Exact cmux no-PTY failure is positive death evidence. FLY-1944 deliberately
# stops at durable classification + founder-visible status + one alert; the
# command-birth-preserving replacement primitive is tracked separately.
fly169_setup_one 0
MOCK_CMUX_READSCREEN='open terminal failed: not a terminal'
FLY1944_ALERTS=""
fly1944_saved_alert=$(declare -f flywheel_alert)
flywheel_alert() { FLY1944_ALERTS+="${FLY1944_ALERTS:+$'\n'}$*"; }
fly1944_generation=$(cmux_socket_identity)
fly1944_first=$(( $(date +%s) - 121 ))
printf '%s|workspace:1|lead-a|view|1|observing-no-pty|%s|%s|100-1\n' \
  "$fly1944_generation" "$fly1944_first" "$fly1944_first" > "$ATTACH_HEAL_STATE"
CMUX_ADDITIVE_ROUND_ID=100-2
self_heal_one_workspace "lead-a"
eval "$fly1944_saved_alert"
if [[ "$MOCK_CMUX_OPS" != *respawn-pane* && "$MOCK_CMUX_OPS" != *'send --workspace workspace:1'* \
    && "$MOCK_CMUX_OPS" != *new-workspace* && "$MOCK_CMUX_OPS" != *close-workspace* \
    && "$MOCK_CMUX_OPS" == *'连接失效 · no-pty · 仅上报'* \
    && "$(grep -c 'cmux_cleanup|attach-dead|generation=' <<< "$FLY1944_ALERTS" || true)" == 1 \
    && "$(awk -F'|' '$2 == "workspace:1" { print $6 }' "$ATTACH_HEAL_STATE")" == dead-no-pty ]]; then
  pass "FLY-1944 exact no-PTY failure is tagged and alerted once without replacement mutation"
else
  fail "FLY-1884 no-PTY report-only contract drifted ops=[$MOCK_CMUX_OPS] state=[$(cat "$ATTACH_HEAL_STATE" 2>/dev/null)] alerts=[$FLY1944_ALERTS]"
fi

# Test 9 / 17: linked session dead → skip (reconcile's job, not self-heal's)
fly169_setup_one 0
MOCK_TMUX_SESSIONS="flywheel"   # no cmux-lead-a → linked session dead
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -qE "send|close-workspace|new-workspace"; then
  fail "self-heal must not send/close/create on linked-dead (reconcile's job)"
else
  pass "linked-dead: self-heal no-ops (deferred to reconcile)"
fi
if echo "$MOCK_CMUX_OPS" | grep -qF '底层 session 不存在 · 等待重建'; then
  pass "linked-dead: founder-visible status names the missing tmux authority"
else
  fail "linked-dead: missing explicit founder-visible invalid state ops=[$MOCK_CMUX_OPS]"
fi

# Test 10: workspace_refs_for rc=2 (cmux JSON unavailable) → skip
fly169_setup_one 0
MOCK_CMUX_JSON_FAIL=1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must skip on workspace JSON rc=2"; else pass "JSON rc=2: no send (skip tick)"; fi

# Test 12: an incomplete independent-view build defers new-workspace.
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'   # lead-b not present → create proceeds to gate
MOCK_TOPO_LINK_FAIL=1
create_workspace_for_window "flywheel" "@1" "lead-b" >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -q "new-workspace"; then
  fail "must NOT new-workspace when independent topology construction fails"
else
  pass "create gate defers new-workspace on incomplete independent topology"
fi

# Test 13a: event wiring — 'create' event for an EXISTING workspace → self-heal
fly169_setup_one 0
printf 'create|flywheel|@1|lead-a\n' > "$TMPDIR_ROOT/ev169"
_drain_file "$TMPDIR_ROOT/ev169"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1 --surface surface:1"; then
  pass "wiring: create-event (existing ws) triggers self-heal"
else
  fail "create-exists wiring did not self-heal; got: $MOCK_CMUX_OPS"
fi

# Test 13b: event wiring — 'register' event → sweep that session → self-heal
fly169_setup_one 0
printf 'register|flywheel\n' > "$TMPDIR_ROOT/ev169"
_drain_file "$TMPDIR_ROOT/ev169"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1"; then
  pass "wiring: register-event sweeps session → self-heal"
else
  fail "register wiring did not self-heal; got: $MOCK_CMUX_OPS"
fi

# Test 13c: R6 periodic recovery — the existing 60s additive tick heals a
# detached managed attach exactly once. The 15s watch loop remains unchanged.
fly169_setup_one 0   # detached + heal-able workspace
sync_additive >/dev/null 2>&1 || true
PERIODIC_SEND_N=$(echo "$MOCK_CMUX_OPS" | grep -c '^send --workspace workspace:1 ' || true)
if [[ "$PERIODIC_SEND_N" == "1" ]]; then
  pass "periodic additive tick re-attaches one detached managed workspace"
else
  fail "expected exactly one periodic attach send, got $PERIODIC_SEND_N; ops: $MOCK_CMUX_OPS"
fi

# A strict view may remain as the watched window's sole holder after its source
# runner session is retired. The periodic sweep must still discover that owned
# exact-one-window view and heal its detached cmux surface.
reset_mocks
MOCK_TOPOLOGY_MODE=1
FLYWHEEL_CMUX_LINKED_VIEW=0
topo_add_session "flywheel" '$1'
topo_add_window "flywheel" "@1" "zsh" 1 0
topo_add_session "cmux-FLY-1404-design" '$1404' "" "runner-flywheel" "0"
topo_add_window "cmux-FLY-1404-design" "@1404" "FLY-1404-design" 1 0
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"}]}'
MOCK_CMUX_SURFACES="workspace:1404;;surface:1404;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-FLY-1404-design=0"
saved_sole_holder_identity=$(declare -f cmux_socket_identity)
MOCK_SOCK_IDENT='generation-sole-holder-fixture'
cmux_socket_identity() {
  if [[ -f "$TMPDIR_ROOT/mock-ident.override" ]]; then
    cat "$TMPDIR_ROOT/mock-ident.override"
  else
    printf '%s' "$MOCK_SOCK_IDENT"
  fi
}
HEAL_RECEIPT_GENERATION=$(cmux_socket_identity)
test_ledger_upsert committed "$HEAL_RECEIPT_GENERATION" workspace:1404 FLY-1404-design
sync_additive >/dev/null 2>&1 || true
SOLE_HOLDER_SEND_N=$(echo "$MOCK_CMUX_OPS" | grep -c '^send --workspace workspace:1404 ' || true)
if [[ "$SOLE_HOLDER_SEND_N" == "1" ]]; then
  pass "periodic additive tick heals a detached strict view after its source session retires"
else
  fail "sole-holder strict view was omitted from periodic heal; sends=$SOLE_HOLDER_SEND_N ops=[$MOCK_CMUX_OPS]"
fi

# A founder-owned same-title ref is not an attach-heal target. Exercise the
# production sweep with the source window STILL live: exact-ref authority must
# not depend on discovering the title only through a sole-holder strict view.
topo_add_session "runner-flywheel" '$2' "runner-flywheel"
topo_add_window "runner-flywheel" "@1404" "FLY-1404-design" 1 0
MOCK_CMUX_OPS=""
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"},{"title":"FLY-1404-design","ref":"workspace:999"}]}'
MOCK_CMUX_SURFACES=$'workspace:1404;;surface:1404;;terminal;;true\nworkspace:999;;surface:999;;terminal;;true'
self_heal_sweep_all
if echo "$MOCK_CMUX_OPS" | grep -q '^send --workspace workspace:1404 ' \
    && ! echo "$MOCK_CMUX_OPS" | grep -q '^send --workspace workspace:999 '; then
  pass "periodic strict heal with a live source injects only into its exact receipted workspace"
else
  fail "periodic strict heal with a live source touched a foreign same-title ref; ops=[$MOCK_CMUX_OPS]"
fi

# Exact workspace authority is not enough: the destination tmux session must
# also be a canonical Flywheel-owned strict view. A foreign same-name session
# with zero clients must never receive an attach command.
topo_reset
topo_add_session "runner-flywheel" '$2' "runner-flywheel"
topo_add_window "runner-flywheel" "@1404" "FLY-1404-design" 1 0
topo_add_session "cmux-FLY-1404-design" '$999' "" "foreign-owner" "0"
topo_add_window "cmux-FLY-1404-design" "@999" "FLY-1404-design" 1 0
MOCK_CMUX_OPS=""
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"}]}'
MOCK_CMUX_SURFACES="workspace:1404;;surface:1404;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-FLY-1404-design=0"
self_heal_sweep_all
if ! echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  pass "periodic strict heal refuses a foreign same-name destination view"
else
  fail "periodic strict heal injected into a foreign same-name view; ops=[$MOCK_CMUX_OPS]"
fi

# An allowed-looking owner marker is not enough when the sole destination
# window is not the receipted title. This models a stale/rebound canonical name.
topo_reset
topo_add_session "runner-flywheel" '$2' "runner-flywheel"
topo_add_window "runner-flywheel" "@1404" "FLY-1404-design" 1 0
topo_add_session "cmux-FLY-1404-design" '$998' "" "runner-foreign" "0"
topo_add_window "cmux-FLY-1404-design" "@998" "FLY-9999-foreign" 1 0
MOCK_CMUX_OPS=""
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"}]}'
MOCK_CMUX_SURFACES="workspace:1404;;surface:1404;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-FLY-1404-design=0"
self_heal_sweep_all
if ! echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  pass "periodic strict heal validates the exact destination window title"
else
  fail "periodic strict heal injected into an allowed-owner wrong-window view; ops=[$MOCK_CMUX_OPS]"
fi

# The early bare-shell proof is not mutation authority: the surface can attach
# to another foreground program while heal-state bookkeeping runs. The final
# guard immediately before `cmux send` must re-read the exact surface screen.
topo_reset
topo_add_session "runner-flywheel" '$2' "runner-flywheel"
topo_add_window "runner-flywheel" "@1404" "FLY-1404-design" 1 0
topo_add_session "cmux-FLY-1404-design" '$1404' "" "runner-flywheel" "0"
topo_add_window "cmux-FLY-1404-design" "@1404" "FLY-1404-design" 1 0
MOCK_CMUX_OPS=""
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"}]}'
MOCK_CMUX_SURFACES="workspace:1404;;surface:1404;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-FLY-1404-design=0"
MOCK_CMUX_READSCREEN_SEQ='annie@mac ~ %,[0] 0:zsh* | mac | 12:00'
rm -f "$TMPDIR_ROOT/readscreen.n"
self_heal_sweep_all
if ! echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  pass "periodic strict heal revalidates bare-shell foreground at the final injection guard"
else
  fail "foreground changed after the early gate but still received attach injection; ops=[$MOCK_CMUX_OPS]"
fi

# A canonical view name can be rebound after the early ownership proof. Model
# that race in heal-state bookkeeping and require the last-operation guard to
# reject the now-foreign destination shell.
topo_reset
topo_add_session "runner-flywheel" '$2' "runner-flywheel"
topo_add_window "runner-flywheel" "@1404" "FLY-1404-design" 1 0
topo_add_session "cmux-FLY-1404-design" '$1404' "" "runner-flywheel" "0"
topo_add_window "cmux-FLY-1404-design" "@1404" "FLY-1404-design" 1 0
MOCK_CMUX_OPS=""
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"}]}'
MOCK_CMUX_SURFACES="workspace:1404;;surface:1404;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-FLY-1404-design=0"
MOCK_CMUX_READSCREEN_SEQ=""
local_saved_heal_state=$(declare -f heal_state_log_once)
heal_state_log_once() {
  topo_set_session_field "cmux-FLY-1404-design" 4 "foreign-owner"
}
self_heal_sweep_all
eval "$local_saved_heal_state"
if ! echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  pass "periodic strict heal revalidates independently addressed view ownership at final guard"
else
  fail "rebound foreign view received attach injection; ops=[$MOCK_CMUX_OPS]"
fi

# The receipt is bound to an exact ref+title. If the cmux workspace title drifts
# during bookkeeping, the final guard must not let the old receipt authorize a
# send into the newly addressed tab.
topo_reset
topo_add_session "runner-flywheel" '$2' "runner-flywheel"
topo_add_window "runner-flywheel" "@1404" "FLY-1404-design" 1 0
topo_add_session "cmux-FLY-1404-design" '$1404' "" "runner-flywheel" "0"
topo_add_window "cmux-FLY-1404-design" "@1404" "FLY-1404-design" 1 0
MOCK_CMUX_OPS=""
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"}]}'
MOCK_CMUX_SURFACES="workspace:1404;;surface:1404;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-FLY-1404-design=0"
local_saved_heal_state=$(declare -f heal_state_log_once)
heal_state_log_once() {
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-drifted","ref":"workspace:1404"}]}'
}
self_heal_sweep_all
eval "$local_saved_heal_state"
if ! echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  pass "periodic strict heal revalidates the exact receipted workspace title at final guard"
else
  fail "title-drifted workspace received attach injection; ops=[$MOCK_CMUX_OPS]"
fi

# Likewise, a selected terminal can be replaced between the early probe and
# send. The original surface ref is not transferable authority.
topo_reset
topo_add_session "runner-flywheel" '$2' "runner-flywheel"
topo_add_window "runner-flywheel" "@1404" "FLY-1404-design" 1 0
topo_add_session "cmux-FLY-1404-design" '$1404' "" "runner-flywheel" "0"
topo_add_window "cmux-FLY-1404-design" "@1404" "FLY-1404-design" 1 0
MOCK_CMUX_OPS=""
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"FLY-1404-design","ref":"workspace:1404"}]}'
MOCK_CMUX_SURFACES="workspace:1404;;surface:1404;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-FLY-1404-design=0"
surface_counter="$TMPDIR_ROOT/final-surface.n"
rm -f "$surface_counter"
saved_surface_ref=$(declare -f workspace_terminal_surface_ref)
workspace_terminal_surface_ref() {
  local n=0
  [[ -f "$surface_counter" ]] && n=$(cat "$surface_counter")
  n=$((n + 1)); echo "$n" > "$surface_counter"
  if [[ "$n" == "1" ]]; then
    printf 'surface:1404\n'
  else
    printf 'surface:rebound\n'
  fi
}
self_heal_sweep_all
eval "$saved_surface_ref"
if ! echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  pass "periodic strict heal revalidates selected surface identity at final guard"
else
  fail "replaced terminal surface inherited stale attach authority; ops=[$MOCK_CMUX_OPS]"
fi

# The final zero-client probe is itself an IPC boundary. If cmux is replaced
# while that probe runs, an exact ref/title reused by the new app generation
# must not inherit the old receipt and receive an attach command.
fly169_setup_one 0
FLYWHEEL_CMUX_LINKED_VIEW=0
MOCK_SOCK_IDENT="generation-heal-a"
printf 'committed|generation-heal-a|workspace:1|lead-a\n' > "$VIEW_LEDGER"
fly1364_client_probe_count="$TMPDIR_ROOT/fly1364-client-probe.n"
fly1364_saved_client_count=$(declare -f view_session_client_count)
eval "$(declare -f view_session_client_count | sed '1s/view_session_client_count/view_session_client_count_impl/')"
view_session_client_count() {
  local out rc=0 n=0
  out=$(view_session_client_count_impl "$@") || rc=$?
  printf '%s' "$out"
  [[ -f "$fly1364_client_probe_count" ]] && n=$(cat "$fly1364_client_probe_count")
  n=$((n + 1)); printf '%s\n' "$n" > "$fly1364_client_probe_count"
  if [[ "$rc" == "0" && "$n" == "2" ]]; then
    printf 'generation-heal-b' > "$TMPDIR_ROOT/mock-ident.override"
  fi
  return "$rc"
}
self_heal_workspace_ref lead-a workspace:1 generation-heal-a >/dev/null 2>&1 || true
eval "$fly1364_saved_client_count"
unset -f view_session_client_count_impl
eval "$saved_sole_holder_identity"
if ! echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  pass "final attach client probe cannot transfer a receipt across cmux generations"
else
  fail "generation changed during final client probe but attach still sent; ops=[$MOCK_CMUX_OPS]"
fi

# Test 13d: an active client is never injected into by the periodic sweep.
fly169_setup_one 1
sync_additive >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  fail "CRITICAL: periodic heal must not inject into an active client; ops: $MOCK_CMUX_OPS"
else
  pass "periodic active-client guard emits zero attach injection"
fi

# Test 13e: uncertain JSON and uncertain client count remain zero-mutation at
# the periodic wiring boundary, not only in the ref-scoped primitive tests.
fly169_setup_one 0
MOCK_CMUX_JSON_FAIL=1
sync_additive >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  fail "periodic JSON uncertainty must fail closed; ops: $MOCK_CMUX_OPS"
else
  pass "periodic JSON uncertainty emits zero attach injection"
fi

fly169_setup_one 0
MOCK_TMUX_CLIENTS=""
sync_additive >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -qE '^send --workspace|^send-key'; then
  fail "periodic client-count uncertainty must fail closed; ops: $MOCK_CMUX_OPS"
else
  pass "periodic client-count uncertainty emits zero attach injection"
fi

# Test 15: cmux health-recovery sets one-shot flag (NOT per-tick)
fly169_setup_one 0
cmux_health_check() { return 0; }   # override: healthy (safe — Phase 7 health tests already ran)
CMUX_HEALTH_LAST_RC=1               # was unhealthy → recovery transition
CMUX_HEAL_ON_RECOVERY=0
cmux_health_check_or_die >/dev/null 2>&1 || true
[[ "$CMUX_HEAL_ON_RECOVERY" == "1" ]] && pass "health-recovery: sets one-shot heal flag" || fail "recovery flag not set"
CMUX_HEALTH_LAST_RC=0               # already healthy → no transition
CMUX_HEAL_ON_RECOVERY=0
cmux_health_check_or_die >/dev/null 2>&1 || true
[[ "$CMUX_HEAL_ON_RECOVERY" == "0" ]] && pass "health-recovery: no flag on steady healthy (not per-tick)" || fail "flag wrongly set when already healthy"

# Test 16: --once is a manual rescue path — sweeps + heals existing bare-zsh
fly169_setup_one 0
MOCK_PGREP_HIT=0   # no watcher running → sync_once proceeds
sync_once >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1 --surface surface:1"; then
  pass "--once: manual rescue sweeps + heals bare-zsh"
else
  fail "--once did not heal; got: $MOCK_CMUX_OPS"
fi

# Test 14: heal-state transition log (once) + clear on recovery
fly169_setup_one 0
rm -f "$HEAL_STATE"
self_heal_one_workspace "lead-a"                       # detached → logs once, writes HEAL_STATE row
if grep -q '^lead-a|' "$HEAL_STATE" 2>/dev/null; then pass "heal-state: row written on re-attach"; else fail "expected HEAL_STATE row for lead-a"; fi
MOCK_TMUX_CLIENTS="cmux-lead-a=1"                       # now attached
self_heal_one_workspace "lead-a"                       # attached branch → clears row
if grep -q '^lead-a|' "$HEAL_STATE" 2>/dev/null; then fail "HEAL_STATE row should be cleared on recovery"; else pass "heal-state: row cleared when re-attached"; fi

# Test 18: errexit safety (R6-#1) — first ref rc=1 must NOT abort the loop
# (this whole block runs under `set -e`; reaching here already exercises it,
# but assert explicitly that a no-intent first ref still lets a later ref heal).
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:2"}]}'
# workspace:1 has NO terminal surface (browser → rc=1 skip); workspace:2 does (rc=0)
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;browser;;true\nworkspace:2;;surface:2;;terminal;;true'
MOCK_TMUX_CLIENTS="cmux-lead-a=0"
self_heal_one_workspace "lead-a"   # under set -e: rc=1 from ref1 must not abort
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:2 --surface surface:2"; then
  pass "errexit-safe: rc=1 first ref does not abort; later ref still heals"
else
  fail "errexit/loop continuation failed; got: $MOCK_CMUX_OPS"
fi

# ════════════════════════════════════════════════════════════════
# FLY-177: CHURN ROOT CAUSE — self-heal sweep must not abort the watcher under
# `set -euo pipefail` when no agent window matches the target session.
#
# Bug: self_heal_sweep_session's loop body's final statement is
#   `[[ "$s" == "$target" && -n "$wname" ]] && self_heal_one_workspace "$wname"`
# When the LAST agent window does NOT belong to $target, the `[[ ]]` is false and
# the `while` loop's exit status is 1. It is called bare in _drain_file's
# `register)` arm under errexit, so that stray 1 aborted the watcher → launchd
# KeepAlive respawned it every ~30s. Production trigger: every `register|<session>`
# event for a `cmux-*` linked session (fired by session-created when the watcher
# creates a linked session — no agent window is ever in a cmux-* session) and for
# `flywheel` whenever a runner-* window sorts last. The churn began the instant
# runner-geoforge3d appeared (the log shows ~40min stable flywheel-only, then 30s
# churn from 15:56 onward when GEO-381's linked-session creation started firing
# register events). Reproduced under a subshell with production's errexit/pipefail.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-177 self_heal_sweep_session no-match returns 0 under errexit (no churn)"
reset_mocks
# flywheel + runner windows; the LAST entry (runner) is what makes the trailing
# `[[ s==target ]]` false for a cmux-* / flywheel target — exactly production.
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a\nrunner-geoforge3d|@8|GEO-381-x'
MOCK_TMUX_SESSIONS=$'flywheel\nrunner-geoforge3d'
sss_rc=0
( set -euo pipefail; self_heal_sweep_session "cmux-GEO-381-x" ) >/dev/null 2>&1 || sss_rc=$?
if [[ "$sss_rc" -eq 0 ]]; then
  pass "self_heal_sweep_session: no-match target returns 0 (no errexit abort)"
else
  fail "REGRESSION: self_heal_sweep_session returned $sss_rc on no-match → would churn watcher"
fi

echo "Test: FLY-177 register|cmux-* drain does not abort watcher under errexit (churn repro)"
reset_mocks
# Production churn repro: session-created on a cmux-* linked session drains through
# the register) arm → self_heal_sweep_session(non-agent target) → (pre-fix) rc=1
# → set -e abort → launchd respawn. The whole drain must survive errexit.
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a\nrunner-geoforge3d|@8|GEO-381-x'
MOCK_TMUX_SESSIONS=$'flywheel\nrunner-geoforge3d\ncmux-lead-a\ncmux-GEO-381-x'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"GEO-381-x","ref":"workspace:2"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:2;;surface:2;;terminal;;true'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=1\ncmux-GEO-381-x=1'
printf 'register|cmux-GEO-381-x\n' > "$TMPDIR_ROOT/ev177-churn"
drain_rc=0
( set -euo pipefail; _drain_file "$TMPDIR_ROOT/ev177-churn" ) >/dev/null 2>&1 || drain_rc=$?
if [[ "$drain_rc" -eq 0 ]]; then
  pass "register|cmux-* drain survives errexit (watcher would NOT respawn-churn)"
else
  fail "REGRESSION: _drain_file aborted (rc=$drain_rc) on register|cmux-* → 30s churn"
fi

# ════════════════════════════════════════════════════════════════
# FLY-177: _pid_is_watcher parsing — real function (deterministic cases)
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-177 _pid_is_watcher real parsing"
# Negative cases are deterministic everywhere: empty pid, and a live non-watcher
# (this test process — its command is bash/test-cmux-sync, not the watcher).
if ! _pid_is_watcher "" && ! _pid_is_watcher "$$"; then
  pass "_pid_is_watcher: false for empty pid and a live non-watcher process"
else
  fail "_pid_is_watcher: should be false for empty/non-watcher (got true)"
fi
# Positive case depends on `ps -o command=` reflecting `exec -a` argv0, which is
# environment-sensitive (sandboxes can hide it). Feature-detect: only assert if
# ps actually shows the spoofed argv; otherwise skip (Codex R1 flakiness note).
bash -c 'exec -a "flywheel-cmux-sync --watch" sleep 5' &
piw_pid=$!
sleep 0.4
piw_cmd=$(ps -o command= -p "$piw_pid" 2>/dev/null || true)
if [[ "$piw_cmd" == *flywheel-cmux-sync* && "$piw_cmd" == *--watch* ]]; then
  if _pid_is_watcher "$piw_pid"; then
    pass "_pid_is_watcher: true for a real watcher-like command"
  else
    fail "_pid_is_watcher: false-negative for watcher command '$piw_cmd'"
  fi
else
  echo "  ⏭  ps does not reflect exec -a argv here — skipping _pid_is_watcher positive case"
fi
kill "$piw_pid" 2>/dev/null

# ════════════════════════════════════════════════════════════════
# FLY-177: supervised blocking-acquire (FLYWHEEL_CMUX_SUPERVISED=1)
# Deterministic: override _pid_is_watcher to consult MOCK_WATCHER_PIDS so the
# lock state-machine is tested without depending on ps/exec -a (Codex R1).
# ════════════════════════════════════════════════════════════════
MOCK_WATCHER_PIDS=""
_pid_is_watcher() {
  local p="$1"
  [[ -z "$p" ]] && return 1
  case " ${MOCK_WATCHER_PIDS} " in *" $p "*) return 0 ;; *) return 1 ;; esac
}

echo "Test: FLY-177 supervised acquires immediately on free lock"
reset_mocks
rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
sup_err="$TMPDIR_ROOT/sup-free.err"
( FLYWHEEL_CMUX_SUPERVISED=1; acquire_watcher_lock ) >/dev/null 2>"$sup_err"
sup_rc=$?
if [[ $sup_rc -eq 0 ]] && ! grep -qE "waiting|already running" "$sup_err"; then
  pass "supervised: acquires immediately when lock free"
else
  fail "supervised free-lock: rc=$sup_rc err=$(cat "$sup_err" 2>/dev/null)"
fi

echo "Test: FLY-177 supervised reaps live NON-watcher owner (PID-reuse guard)"
reset_mocks
rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
sleep 30 & nonwatcher_pid=$!          # live, but NOT in MOCK_WATCHER_PIDS
MOCK_WATCHER_PIDS=""
mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
echo "$nonwatcher_pid" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
MOCK_PROCESS_COMMANDS="$nonwatcher_pid|sleep 30"
sup_err="$TMPDIR_ROOT/sup-nonwatcher.err"
SUPERVISED_WAIT_SECONDS=1
( FLYWHEEL_CMUX_SUPERVISED=1; acquire_watcher_lock ) >/dev/null 2>"$sup_err"
sup_rc=$?
SUPERVISED_WAIT_SECONDS=15
kill "$nonwatcher_pid" 2>/dev/null
if [[ $sup_rc -eq 0 ]] && grep -q "rebuilt stale/unverifiable mutator lease" "$sup_err"; then
  pass "supervised: live non-watcher owner reaped (no infinite wait)"
else
  fail "supervised non-watcher: rc=$sup_rc err=$(cat "$sup_err" 2>/dev/null)"
fi

echo "Test: FLY-177 supervised blocks for live watcher, takes over on its death"
reset_mocks
rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
sleep 60 & fake_watcher=$!
MOCK_WATCHER_PIDS="$fake_watcher"     # mark this live pid as a watcher
export MOCK_WATCHER_PIDS              # visible to the backgrounded subshell
mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
echo "$fake_watcher" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
MOCK_PROCESS_COMMANDS="$fake_watcher|/bin/bash /tmp/flywheel-cmux-sync --watch"
sup_err="$TMPDIR_ROOT/sup-block.err"
# Codex R2 LOW: marker distinguishes a genuine `acquire_watcher_lock` RETURN
# (→ `&& touch`) from any `exit 0` path inside acquire (which skips the `&&`).
sup_marker="$TMPDIR_ROOT/sup-takeover.marker"
rm -f "$sup_marker"
SUPERVISED_WAIT_SECONDS=1; export SUPERVISED_WAIT_SECONDS
( FLYWHEEL_CMUX_SUPERVISED=1; acquire_watcher_lock && touch "$sup_marker" ) >/dev/null 2>"$sup_err" &
acq_pid=$!
sleep 3
if kill -0 "$acq_pid" 2>/dev/null && grep -q "waiting" "$sup_err" && [[ ! -f "$sup_marker" ]]; then
  pass "supervised: blocks while a live watcher owns the lock (no exit-churn, not yet acquired)"
else
  alive="n"; kill -0 "$acq_pid" 2>/dev/null && alive="y"
  fail "supervised block: acq alive=$alive marker=$([[ -f "$sup_marker" ]] && echo y || echo n) err=$(cat "$sup_err" 2>/dev/null)"
  kill "$acq_pid" 2>/dev/null
fi
kill "$fake_watcher" 2>/dev/null   # owner dies → acquire should take over
took_over=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$acq_pid" 2>/dev/null; then took_over=1; break; fi
  sleep 1
done
SUPERVISED_WAIT_SECONDS=15; export SUPERVISED_WAIT_SECONDS
if [[ $took_over -eq 1 ]] && [[ -f "$sup_marker" ]]; then
  pass "supervised: takes over after lock owner dies (acquire returned → marker)"
else
  fail "supervised takeover: exited=$took_over marker=$([[ -f "$sup_marker" ]] && echo y || echo n)"
  kill "$acq_pid" 2>/dev/null
fi
wait "$acq_pid" 2>/dev/null
unset MOCK_WATCHER_PIDS

# ════════════════════════════════════════════════════════════════
# FLY-177: launchd wrapper — PATH resolution + exec (manage real PID)
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-177 launchd-minimal PATH resolves cmux + tmux"
if env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c '
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  command -v cmux >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1'; then
  pass "expanded PATH resolves cmux + tmux from minimal launchd env"
elif ! { [[ -x /opt/homebrew/bin/cmux ]] || [[ -x /usr/local/bin/cmux ]]; }; then
  echo "  ⏭  cmux not installed on host — skipping launchd PATH resolution test"
else
  fail "expanded PATH failed to resolve cmux/tmux from minimal env"
fi

echo "Test: FLY-177/1446 supervised autostart execs watcher + sets launchd PATH"
AUTOSTART_SH="$SCRIPT_DIR/flywheel-cmux-autostart.sh"
if grep -qE '^[[:space:]]*exec "\$SYNC_SCRIPT" --watch' "$AUTOSTART_SH" \
   && grep -q 'FLYWHEEL_CMUX_SUPERVISED' "$AUTOSTART_SH" \
   && grep -qE 'export PATH="/opt/homebrew/bin' "$AUTOSTART_SH"; then
  pass "autostart: supervised launchd path execs watcher + PATH expansion present"
else
  fail "autostart: missing supervised 'exec \$SYNC_SCRIPT --watch' or PATH expansion"
fi

set +e   # restore lenient mode before the FLY-254 section + summary

# ════════════════════════════════════════════════════════════════
# FLY-254: render-escalated reopen sweep
# ════════════════════════════════════════════════════════════════
# Test-only overrides. Socket identity/presence are pure-stat probes in prod;
# here they're driven by MOCK_ vars. `sleep` is mocked: counts calls and runs
# an optional hook so tests can flip state "during" a wait. This section runs
# LAST — overriding sleep cannot affect earlier tests.
# Identity override file takes precedence over the MOCK_ var: the cmux mock's
# JSON-flip hook runs inside $(...) subshells and can only signal the parent
# via a file (FLY-254 CR-R3 race tests).
eval "$(declare -f tmux_server_generation | sed '1s/tmux_server_generation/_production_tmux_server_generation/')"
cmux_socket_identity() {
  local generation
  if [[ -f "$TMPDIR_ROOT/mock-ident.override" ]]; then
    generation=$(cat "$TMPDIR_ROOT/mock-ident.override")
  else
    generation="${MOCK_SOCK_IDENT:-cmux-test-generation}"
  fi
  seed_fixed_receipt_fixture "$generation"
  printf '%s' "$generation"
}
tmux_server_generation() {
  if [[ -n "${MOCK_TMUX_GENERATION_SEQ:-}" ]]; then
    local count=0 value
    [[ -f "$TMPDIR_ROOT/tmux-generation.n" ]] && count=$(cat "$TMPDIR_ROOT/tmux-generation.n")
    count=$((count + 1))
    printf '%s\n' "$count" > "$TMPDIR_ROOT/tmux-generation.n"
    value=$(printf '%s\n' "$MOCK_TMUX_GENERATION_SEQ" | awk -F, -v n="$count" '{ if (n > NF) n=NF; print $n }')
    printf '%s\n' "$value"
    return 0
  fi
  if [[ -f "$TMPDIR_ROOT/tmux-generation.override" ]]; then
    cat "$TMPDIR_ROOT/tmux-generation.override"
  else
    printf '%s\n' "${FLYWHEEL_CMUX_TMUX_GENERATION:-tmux-test-generation}"
  fi
}
cmux_socket_present() { [[ "${MOCK_SOCK_PRESENT:-0}" == "1" ]]; }
sleep() { MOCK_SLEEPS=$((MOCK_SLEEPS + 1)); MOCK_SLEEP_ARGS+="${1:-} "; eval "${MOCK_SLEEP_HOOK:-}" || true; }
# CR-R5: mutation-boundary hook — fires ONLY for cmux_call_guarded's own
# mktemp (FUNCNAME survives the $(...) subshell), i.e. the last bookkeeping
# step before the actual cmux mutation. State changes must cross the subshell
# via files (mock-ident.override).
mktemp() {
  if [[ "${FUNCNAME[1]:-}" == "cmux_call_guarded" && -n "${MOCK_MKTEMP_HOOK:-}" ]]; then
    eval "$MOCK_MKTEMP_HOOK" || true
  elif [[ "${FUNCNAME[1]:-}" == "cmux_call" && -n "${MOCK_CMUX_CALL_MKTEMP_HOOK:-}" ]]; then
    eval "$MOCK_CMUX_CALL_MKTEMP_HOOK" || true
  fi
  command mktemp "$@"
}

# Standard escalation scenario: one Lead window 'lead-a' (ws workspace:7,
# unrendered surface), user's tab = workspace:1 ('home', selected).
setup_escalation_scenario() {
  reset_mocks
  MOCK_TMUX_WINDOWS="flywheel|@7|lead-a"
  MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
  MOCK_TMUX_CLIENTS="cmux-lead-a=0"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"}]}'
  MOCK_CMUX_SURFACES="workspace:7;;surface:7;;terminal;;true"
  MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %"
  export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=3
  unset FLYWHEEL_CMUX_REOPEN_SWEEP 2>/dev/null || true
}

echo "Test: FLY-254 escalation happy path (focus → render → full gates → send → restore)"
setup_escalation_scenario
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:7"; then
  pass "escalation focuses the broken workspace (select-workspace ws7)"
else fail "expected select-workspace ws7; ops: $MOCK_CMUX_OPS"; fi
expected_attach=$(build_attach_command "cmux-lead-a")
if echo "$MOCK_CMUX_OPS" | grep -qF "send --workspace workspace:7 --surface surface:7 $expected_attach"; then
  pass "atomic send fired after render + full gate re-run"
else fail "expected attach send to ws7; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  pass "focus restored to original tab (ws1)"
else fail "expected restore select-workspace ws1; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 R1-HIGH-1 race — client appears at the FINAL pre-send check"
setup_escalation_scenario
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,0,1"   # 4th client-count call (final ⑤) → 1
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "client appeared at final check but send still fired"
else pass "final pre-send 0-client re-check blocks the send (race closed)"; fi

echo "Test: FLY-254 R1-HIGH-1 drift — ref no longer resolves from wname after focus"
setup_escalation_scenario
MOCK_SLEEP_HOOK='MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"title\":\"home\",\"ref\":\"workspace:1\"},{\"title\":\"renamed\",\"ref\":\"workspace:7\",\"selected\":true}]}"'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "ref drifted (title renamed) after focus but send still fired"
else pass "fresh MANAGED re-check blocks send after title drift"; fi

echo "Test: FLY-254 render timeout — budget exhausted, summary log, sweep continues + restores"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL"   # clamped: every read fails — never renders
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=2
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "render never completed but send fired"
else pass "no send on render timeout (fail-closed)"; fi
if grep -q "render timeout" "$TMPDIR_ROOT/t254.log"; then
  pass "one summary log on render timeout"
else fail "expected 'render timeout' summary log"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  pass "focus still restored after timeout"
else fail "expected restore to ws1 after timeout; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 positively-not-a-shell after render → fail closed"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL,[0] 0:zsh* | mac | 12:00"   # renders into a status bar
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "non-shell screen after render but send fired"
else pass "bare-shell positive proof still gates the escalated send"; fi

echo "Test: FLY-254 focus snapshot fail-closed (no unique selected ref)"
setup_escalation_scenario
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:7"}]}'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace"; then
  fail "no restorable snapshot but focus mutation happened"
else pass "zero selected → zero focus mutations (fail-closed)"; fi
setup_escalation_scenario
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7","selected":true}]}'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace"; then
  fail "ambiguous (2x selected) snapshot but focus mutation happened"
else pass "multiple selected → zero focus mutations (fail-closed)"; fi

echo "Test: FLY-254 R2-M5 mid-sweep user intervention stops remaining escalation"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-lead-b'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=0\ncmux-lead-b=0'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"},{"title":"elsewhere","ref":"workspace:99"}]}'
MOCK_CMUX_SURFACES=$'workspace:7;;surface:7;;terminal;;true\nworkspace:8;;surface:8;;terminal;;true'
MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %,FAIL"
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=3
# User clicks ws99 during lead-a's render wait (sleep #1) — lead-b's pre-focus
# check must detect it, stop ALL remaining focus escalation, and never restore.
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -eq 1 ]] && MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"title\":\"home\",\"ref\":\"workspace:1\"},{\"title\":\"lead-a\",\"ref\":\"workspace:7\"},{\"title\":\"lead-b\",\"ref\":\"workspace:8\"},{\"title\":\"elsewhere\",\"ref\":\"workspace:99\",\"selected\":true}]}"'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:8"; then
  fail "user intervened but lead-b was still focused"
else pass "user intervention stops remaining focus escalation (no ws8 focus)"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "user intervened but focus was restored anyway (user's choice stomped)"
else pass "no restore after user intervention (user's selection wins)"; fi
if grep -q "user switched tabs" "$TMPDIR_ROOT/t254.log"; then
  pass "user-intervention transition logged"
else fail "expected 'user switched tabs' log"; fi

echo "Test: FLY-254 R3-M2 end-form — user switches AFTER the last forced focus"
setup_escalation_scenario
# Flip selected to ws99 during lead-a's render wait; lead-a still heals (its
# gates are client/shell-based), but the EPILOGUE must see selected≠last_forced
# and skip the restore.
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"elsewhere","ref":"workspace:99"}]}'
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -eq 1 ]] && MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"title\":\"home\",\"ref\":\"workspace:1\"},{\"title\":\"lead-a\",\"ref\":\"workspace:7\"},{\"title\":\"elsewhere\",\"ref\":\"workspace:99\",\"selected\":true}]}"'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "selected changed after last focus but restore fired (zero-restore violated)"
else pass "final selected re-check skips restore (end-form user switch)"; fi
if grep -q "keeping user's selection" "$TMPDIR_ROOT/t254.log"; then
  pass "epilogue logs the kept user selection"
else fail "expected 'keeping user's selection' log"; fi

echo "Test: FLY-254 generation state machine (three-field fixtures)"
reset_mocks
MOCK_SOCK_IDENT="11:22:333"
reopen_detector_check 2>"$TMPDIR_ROOT/t254.log"
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE" 2>/dev/null)" == "11:22:333|pending|0" ]]; then
  pass "missing file → arm identity|pending|0"
else fail "expected arm; file: $(cat "$CMUX_SOCK_IDENT_FILE" 2>/dev/null || echo '<none>')"; fi
if grep -q "cmux reopen detected" "$TMPDIR_ROOT/t254.log"; then
  pass "arm logs reopen detection"
else fail "expected reopen-detected log"; fi
# Churn immunity: same identity + done → detector must NOT re-arm.
echo "11:22:333|done|1" > "$CMUX_SOCK_IDENT_FILE"
reopen_detector_check 2>/dev/null
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|1" ]]; then
  pass "same identity + done → no re-arm (watcher churn immunity)"
else fail "done generation was re-armed: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
# Identity change → new pending generation.
MOCK_SOCK_IDENT="44:55:666"
reopen_detector_check 2>/dev/null
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "44:55:666|pending|0" ]]; then
  pass "identity change → new generation armed"
else fail "expected new arm; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi

echo "Test: FLY-254 consume — attempts increment before sweep, done after"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
echo "11:22:333|pending|0" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>/dev/null
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|1" ]]; then
  pass "consume: pending|0 → done|1 (normal completion)"
else fail "expected done|1; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
if [[ "$REOPEN_CONSUMED_THIS_TICK" == "1" ]]; then
  pass "REOPEN_CONSUMED_THIS_TICK set (recovery-sweep coalesce signal)"
else fail "expected REOPEN_CONSUMED_THIS_TICK=1"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "consume actually ran the escalated sweep (send fired)"
else fail "expected escalated sweep send; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 crash resume — pending|1 re-consumed; already-attached workspaces no-op"
setup_escalation_scenario
# lead-b is ALREADY attached (clients=1) — a resume must not focus or send it.
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-lead-b'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=0\ncmux-lead-b=1'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"}]}'
MOCK_CMUX_SURFACES=$'workspace:7;;surface:7;;terminal;;true\nworkspace:8;;surface:8;;terminal;;true'
MOCK_SOCK_IDENT="11:22:333"
echo "11:22:333|pending|1" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|2" ]]; then
  pass "crash resume: pending|1 → done|2"
else fail "expected done|2; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
if grep -q "resuming pending re-attach sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "resume logged"
else fail "expected resume log"; fi
if echo "$MOCK_CMUX_OPS" | grep -E "^(select-workspace|send|respawn-pane).*workspace:8" >/dev/null; then
  fail "resume pane-mutated the already-attached workspace (ws8): $MOCK_CMUX_OPS"
else pass "resume only clears recovery status on the already-attached workspace"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "resume healed the residual broken workspace (ws7)"
else fail "expected ws7 heal on resume; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 R3-HIGH-1 durable attempt budget — pending|3 never consumed"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
echo "11:22:333|pending|3" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "attempt budget exhausted but sweep still ran"
else pass "attempt budget exhausted → zero focus/send"; fi
if grep -q "attempt budget exhausted" "$TMPDIR_ROOT/t254.log"; then
  pass "give-up logged once"
else fail "expected budget-exhausted log"; fi
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|3" ]]; then
  pass "exhausted generation flipped to done (no further consumption)"
else fail "expected done|3; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi

echo "Test: FLY-254 malformed state file → fail-closed reset, no escalation"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
echo "garbage-no-pipes" > "$CMUX_SOCK_IDENT_FILE"
reopen_detector_check 2>"$TMPDIR_ROOT/t254.log"
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|0" ]]; then
  pass "malformed → reset to done (no escalation off corrupt state)"
else fail "expected reset to done|0; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
if grep -q "malformed generation state" "$TMPDIR_ROOT/t254.log"; then
  pass "malformed reset logged"
else fail "expected malformed log"; fi

echo "Test: FLY-254 attempt-write failure → zero escalation that round (fail-closed)"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
mkdir -p "$TMPDIR_ROOT/ro"
SAVED_IDENT_FILE="$CMUX_SOCK_IDENT_FILE"
CMUX_SOCK_IDENT_FILE="$TMPDIR_ROOT/ro/sock-ident"
echo "11:22:333|pending|0" > "$CMUX_SOCK_IDENT_FILE"
chmod 555 "$TMPDIR_ROOT/ro"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
chmod 755 "$TMPDIR_ROOT/ro"
CMUX_SOCK_IDENT_FILE="$SAVED_IDENT_FILE"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "attempt counter could not be persisted but sweep still ran"
else pass "unpersistable attempt counter → no escalated sweep (fail-closed)"; fi

echo "Test: FLY-254 R2-M4 readiness — partial set held stable must NOT early-exit"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"}]}' > "$TMPDIR_ROOT/wsjson.1"
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"}]}' > "$TMPDIR_ROOT/wsjson.2"
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"}]}' > "$TMPDIR_ROOT/wsjson.3"
MOCK_CMUX_JSON_SEQ_N=3
export FLYWHEEL_CMUX_READINESS_TICKS=5
reopen_readiness_wait 2>/dev/null
WS_READS=$(cat "$TMPDIR_ROOT/wsjson.n" 2>/dev/null || echo 0)
if [[ "$WS_READS" -ge 3 ]]; then
  pass "readiness waited past the stable partial set (expected-set check, $WS_READS reads)"
else fail "readiness early-exited on a stable PARTIAL set after $WS_READS reads"; fi

echo "Test: FLY-254 readiness budget exhausted → proceed + log missing names"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"}]}' > "$TMPDIR_ROOT/wsjson.1"
MOCK_CMUX_JSON_SEQ_N=1
export FLYWHEEL_CMUX_READINESS_TICKS=2
reopen_readiness_wait 2>"$TMPDIR_ROOT/t254.log"
if grep -q "readiness budget exhausted" "$TMPDIR_ROOT/t254.log" \
   && grep -q "lead-b" "$TMPDIR_ROOT/t254.log"; then
  pass "budget exhaustion logged with the missing window name"
else fail "expected exhausted+missing log; got: $(cat "$TMPDIR_ROOT/t254.log")"; fi

echo "Test: FLY-254 R2-HIGH-2 sliced sleeps — rc=1 socket reappearance wakes early"
reset_mocks
CMUX_HEALTH_LAST_RC=1
export FLYWHEEL_CMUX_SOCKET_PROBE_SLICE=3
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 2 ]] && MOCK_SOCK_PRESENT=1'
reopen_aware_sleep 30 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 2 ]]; then
  pass "rc=1: woke on socket reappearance after 2 slices (not 10)"
else fail "rc=1: expected 2 slices, got $MOCK_SLEEPS"; fi

echo "Test: FLY-254 R2-HIGH-2 sliced sleeps — rc=3 stale-socket identity change wakes early"
reset_mocks
CMUX_HEALTH_LAST_RC=3
echo "old:1:1|done|1" > "$CMUX_SOCK_IDENT_FILE"
MOCK_SOCK_IDENT="old:1:1"
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 2 ]] && MOCK_SOCK_IDENT="new:2:2"'
reopen_aware_sleep 30 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 2 ]]; then
  pass "rc=3: woke on identity change after 2 slices (stale-socket blind spot closed)"
else fail "rc=3: expected 2 slices, got $MOCK_SLEEPS"; fi

echo "Test: FLY-1944 healthy sleep is sliced to the <=3s event SLA"
reset_mocks
CMUX_HEALTH_LAST_RC=0
reopen_aware_sleep 15 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 5 && "$MOCK_SLEEP_ARGS" == "3 3 3 3 3 " ]]; then
  pass "rc=0: 15s cadence is five pure 3s event probes"
else fail "rc=0: expected five 3s slices, got sleeps=$MOCK_SLEEPS args='$MOCK_SLEEP_ARGS'"; fi

echo "Test: FLY-1944 event arrival wakes the healthy watcher before the next 15s scan"
reset_mocks
CMUX_HEALTH_LAST_RC=0
: > "$EVENT_FILE"
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 2 ]] && printf "%s\n" "create|runner-new|@42|new-pane" > "$EVENT_FILE"'
reopen_aware_sleep 15 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 2 ]]; then
  pass "healthy watcher wakes on a new event after 6s (well inside 1 minute)"
else fail "healthy event wake expected 2 slices, got $MOCK_SLEEPS"; fi

echo "Test: FLY-1944 unhealthy event backlog never shortens a backoff it cannot drain"
reset_mocks
CMUX_HEALTH_LAST_RC=1
printf '%s\n' 'create|runner-new|@42|new-pane' > "$EVENT_FILE"
reopen_aware_sleep 15 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 5 && "$MOCK_SLEEP_ARGS" == "3 3 3 3 3 " ]]; then
  pass "unhealthy watcher preserves the full backoff despite a pending event"
else fail "unhealthy backlog shortened sleep: sleeps=$MOCK_SLEEPS args='$MOCK_SLEEP_ARGS'"; fi

echo "Test: FLY-1944 socket recovery escapes the outer unhealthy backoff"
reset_mocks
CMUX_HEALTH_LAST_RC=1
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 2 ]] && MOCK_SOCK_PRESENT=1'
watcher_backoff_sleep 30 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 2 ]]; then
  pass "socket recovery returns to the scan after two slices"
else fail "socket recovery stayed inside the outer backoff: sleeps=$MOCK_SLEEPS"; fi

echo "Test: FLY-1944 long unhealthy backoff refreshes the heartbeat every 15s"
reset_mocks
CMUX_HEALTH_LAST_RC=1
HEARTBEAT_WRITES=0
eval "$(declare -f watcher_write_heartbeat | sed '1s/watcher_write_heartbeat/watcher_write_heartbeat_real/')"
watcher_write_heartbeat() { HEARTBEAT_WRITES=$((HEARTBEAT_WRITES + 1)); }
watcher_backoff_sleep 30 2>/dev/null
eval "$(declare -f watcher_write_heartbeat_real | sed '1s/watcher_write_heartbeat_real/watcher_write_heartbeat/')"
unset -f watcher_write_heartbeat_real
if [[ "$HEARTBEAT_WRITES" -eq 2 ]]; then
  pass "30s unhealthy backoff publishes two liveness heartbeats"
else fail "expected two backoff heartbeats, got $HEARTBEAT_WRITES"; fi

echo "Test: FLY-1944 heartbeat updates on scans and every 15 maintenance polls"
reset_mocks
rm -f "$WATCHER_HEARTBEAT_FILE"
watcher_write_heartbeat 7 scan
SCAN_HEARTBEAT=$(cat "$WATCHER_HEARTBEAT_FILE" 2>/dev/null || true)
rm -f "$WATCHER_HEARTBEAT_FILE"
WATCHER_MAINTENANCE_HEARTBEAT_POLLS=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
  watcher_maintenance_heartbeat_tick
done
BEFORE_FIFTEEN=$([[ -e "$WATCHER_HEARTBEAT_FILE" ]] && echo present || echo absent)
watcher_maintenance_heartbeat_tick
MAINT_HEARTBEAT=$(cat "$WATCHER_HEARTBEAT_FILE" 2>/dev/null || true)
if [[ "$SCAN_HEARTBEAT" == "$$|7|scan" && "$BEFORE_FIFTEEN" == "absent" \
    && "$MAINT_HEARTBEAT" == "$$|maintenance|park" ]]; then
  pass "heartbeat is scan-driven and maintenance-rate-limited to 15 polls"
else fail "heartbeat mismatch scan='$SCAN_HEARTBEAT' before=$BEFORE_FIFTEEN maintenance='$MAINT_HEARTBEAT'"; fi

echo "Test: FLY-254 retired reopen env cannot disable the sweep"
if FLYWHEEL_CMUX_REOPEN_SWEEP=0 reopen_sweep_enabled; then
  pass "retired reopen env is ignored"
else fail "retired reopen env still disabled the sweep"; fi
# Regression sentinel: escalation never fires from a plain (FLY-169) sweep,
# and the event-path heal stays fail-closed on read-screen failure.
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL"
self_heal_sweep_all 2>/dev/null   # NOT escalated
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "plain sweep escalated or sent on unreadable surface"
else pass "plain sweep: read-screen failure stays fail-closed (FLY-169 verbatim)"; fi

echo "Test: FLY-254 invalid env knobs fall back to defaults"
reset_mocks
V=$(validated_int_env TEST_KNOB "abc" 6 60 2>/dev/null)
[[ "$V" == "6" ]] && pass "non-numeric → default" || fail "non-numeric: got $V"
V=$(validated_int_env TEST_KNOB "0" 6 60 2>/dev/null)
[[ "$V" == "6" ]] && pass "zero → default" || fail "zero: got $V"
V=$(validated_int_env TEST_KNOB "999" 6 60 2>/dev/null)
[[ "$V" == "6" ]] && pass "over-max → default" || fail "over-max: got $V"
V=$(validated_int_env TEST_KNOB "08" 6 60 2>/dev/null)
[[ "$V" == "8" ]] && pass "leading zero → base-10 (no octal trap)" || fail "leading zero: got $V"

echo "Test: FLY-254 set -euo pipefail survival (sweep + consume return 0 on failure paths)"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL"
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=2
SURVIVED=$( (set -euo pipefail
  HEAL_RENDER_ESCALATE=1
  self_heal_sweep_all
  MOCK_SOCK_IDENT="11:22:333"
  echo "11:22:333|pending|3" > "$CMUX_SOCK_IDENT_FILE"
  consume_pending_reopen_sweep
  reopen_detector_check
  CMUX_HEALTH_LAST_RC=0
  reopen_aware_sleep 15
  echo SURVIVED) 2>/dev/null )
if [[ "$SURVIVED" == *SURVIVED* ]]; then
  pass "all FLY-254 entry points survive set -euo pipefail on failure paths"
else fail "a FLY-254 path killed the watcher under set -e"; fi

echo "Test: FLY-254 wiring structure (watch_loop coalesce + bootstrap replace + sliced sleep)"
SYNC_SH="$SCRIPT_DIR/flywheel-cmux-sync.sh"
if grep -q 'REOPEN_CONSUMED_THIS_TICK" != "1"' "$SYNC_SH"; then
  pass "watch_loop coalesces recovery sweep with the escalated consume"
else fail "missing recovery-sweep coalesce guard"; fi
if grep -q 'BOOTSTRAP_SKIP_HEAL_SWEEP=1 sync_additive_bootstrap' "$SYNC_SH"; then
  pass "bootstrap consume replaces the legacy bootstrap sweep when pending"
else fail "missing bootstrap replace wiring"; fi
if grep -q 'watcher_backoff_sleep "\$sleep_seconds"' "$SYNC_SH" \
    && awk '/^watcher_backoff_sleep\(\)/,/^}/' "$SYNC_SH" | grep -q 'reopen_aware_sleep'; then
  pass "watch_loop keeps reopen-aware sleep inside the maintenance-sliced backoff wrapper"
else fail "watch_loop bypasses reopen-aware or maintenance-aware sleep"; fi
if grep -q 'REOPEN_CACHE_STATE" == "pending"' "$SYNC_SH"; then
  pass "watch_loop consume is cache-gated (CR-M6: settled done = zero file IO)"
else fail "missing cache gate on the consume call"; fi
# CR-R1 L9: scan the FULL sync_once body (the old -A20 only saw 20 lines).
if ! awk '/^sync_once\(\)/,/^}$/' "$SYNC_SH" | grep -q 'reopen\|escalat\|HEAL_RENDER'; then
  pass "--once does not participate in escalation / generation consumption (full body)"
else fail "--once gained reopen behavior (must stay non-escalated)"; fi

echo "Test: FLY-254 bootstrap skip flag suppresses the legacy heal sweep"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ=""
MOCK_CMUX_READSCREEN="annie@mac ~ %"   # legacy heal WOULD send without the flag
BOOTSTRAP_SKIP_HEAL_SWEEP=1 sync_additive_bootstrap 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "skip flag set but bootstrap sweep still healed"
else pass "BOOTSTRAP_SKIP_HEAL_SWEEP=1 suppresses the bootstrap heal sweep"; fi
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ=""
MOCK_CMUX_READSCREEN="annie@mac ~ %"
sync_additive_bootstrap 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "without the flag the bootstrap heal sweep still heals (status quo)"
else fail "bootstrap sweep stopped healing; ops: $MOCK_CMUX_OPS"; fi

# ── FLY-254 Codex code review R1 findings — behavioral coverage ──

echo "Test: FLY-254 CR-HIGH-1 — already-readable escalated fast path hits the in-helper final guard"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="annie@mac ~ %"   # readable immediately — no focus needed
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,1"      # 3rd client read = the helper's final guard → 1
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "client appeared at the helper guard but the fast path still sent"
else pass "fast path blocked by the in-helper final 0-client guard"; fi

echo "Test: FLY-254 CR-HIGH-1 — client appearing during bookkeeping blocks the render-loop send"
setup_escalation_scenario
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,0,1"    # 4th read = in-helper guard after bookkeeping
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "client appeared during bookkeeping but send still fired"
else pass "render-loop send blocked by the in-helper final guard"; fi

echo "Test: FLY-254 CR-HIGH-2 — identity flip during readiness aborts the consume"
setup_escalation_scenario
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@9|lead-c'   # lead-c has no workspace → readiness waits
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
export FLYWHEEL_CMUX_READINESS_TICKS=2
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 1 ]] && MOCK_SOCK_IDENT="B:2:2"'
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "consume swept after the generation changed during readiness"
else pass "no sweep on a generation whose budget was never charged"; fi
if grep -q "generation changed during readiness" "$TMPDIR_ROOT/t254.log"; then
  pass "readiness-abort logged"
else fail "expected readiness-abort log"; fi
if grep -q "^A:1:1|pending|1$" "$CMUX_SOCK_IDENT_FILE"; then
  pass "old generation NOT marked done (next tick arms the new identity cleanly)"
else fail "file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
export FLYWHEEL_CMUX_READINESS_TICKS=5

echo "Test: FLY-254 CR-HIGH-2 — generation pin stops focus escalation mid-sweep"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-lead-b'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=0\ncmux-lead-b=0'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"}]}'
MOCK_CMUX_SURFACES=$'workspace:7;;surface:7;;terminal;;true\nworkspace:8;;surface:8;;terminal;;true'
MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %,FAIL"
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=3
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 1 ]] && MOCK_SOCK_IDENT="B:2:2"'   # flips during lead-a render wait
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:8"; then
  fail "generation changed mid-sweep but lead-b was still focused"
else pass "generation pin stops remaining focus escalation"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore fired after a mid-sweep generation change"
else pass "no restore after a mid-sweep generation change"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "mid-sweep abort logged"
else fail "expected mid-sweep abort log"; fi

echo "Test: FLY-254 CR-M3 — unwritable HEAL_STATE cannot kill the watcher"
setup_escalation_scenario
SAVED_HEAL_STATE="$HEAL_STATE"
HEAL_STATE="$TMPDIR_ROOT/healdir"
mkdir -p "$HEAL_STATE"
SURVIVED=$( (set -euo pipefail
  HEAL_RENDER_ESCALATE=1
  self_heal_sweep_all
  echo SURVIVED) 2>/dev/null )
HEAL_STATE="$SAVED_HEAL_STATE"
if [[ "$SURVIVED" == *SURVIVED* ]]; then
  pass "escalated sweep survives HEAL_STATE being a directory under set -e"
else fail "HEAL_STATE-as-directory killed the sweep"; fi

echo "Test: FLY-254 CR-M4 — arithmetic overflow / out-of-range attempts are malformed"
reset_mocks
MOCK_SOCK_IDENT="O:1:1"
echo "O:1:1|pending|99999999999999999999" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "overflow attempts field was consumed"
else pass "overflow attempts → not consumable"; fi
reopen_detector_check 2>/dev/null
if grep -q "^O:1:1|done|0$" "$CMUX_SOCK_IDENT_FILE"; then
  pass "detector resets the overflow state to done (fail-closed)"
else fail "file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
reset_mocks
MOCK_SOCK_IDENT="O:1:1"
echo "O:1:1|pending|4" > "$CMUX_SOCK_IDENT_FILE"   # beyond writer's representable set
consume_pending_reopen_sweep 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "attempts=4 (unrepresentable) was consumed"
else pass "attempts outside 0..3 → malformed, not consumable"; fi
V=$(validated_int_env TEST_KNOB "18446744073709551617" 6 60 2>/dev/null)
if [[ "$V" == "6" ]]; then
  pass "64-bit wrap value → default (lexical length cap)"
else fail "wrap value accepted: got $V"; fi

echo "Test: FLY-254 CR-M5 — malformed selected ref disables focus mutations"
setup_escalation_scenario
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"not-a-workspace-ref","selected":true},{"title":"lead-a","ref":"workspace:7"}]}'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace"; then
  fail "illegal selected ref accepted as a focus snapshot"
else pass "illegal selected ref → zero focus mutations (fail-closed)"; fi

echo "Test: FLY-254 CR-M6 — settled generation costs the healthy tick zero file IO"
reset_mocks
MOCK_SOCK_IDENT="S:1:1"
write_generation_state "S:1:1" done 1 2>/dev/null   # warms the in-process cache
rm -f "$CMUX_SOCK_IDENT_FILE"                        # remove the file entirely
reopen_detector_check 2>/dev/null                    # fast path must not read/recreate it
if [[ ! -f "$CMUX_SOCK_IDENT_FILE" ]]; then
  pass "detector fast path: zero file IO when identity matches the cache"
else fail "detector touched the state file on the steady-state fast path"; fi

echo "Test: FLY-254 CR-M6/L9 behavioral — persistent done-write failure cannot exceed the durable budget"
setup_escalation_scenario
MOCK_SOCK_IDENT="X:1:1"
echo "X:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# Wrap the writer: 'done' writes fail persistently; everything else is real.
eval "$(declare -f write_generation_state | sed '1s/write_generation_state/write_generation_state_real/')"
write_generation_state() {
  if [[ "$2" == "done" ]]; then return 1; fi
  write_generation_state_real "$@"
}
TOTAL_SWEEPS=0
for _round in 1 2 3 4 5; do
  # Simulate a watcher restart: cold cache + fresh per-call mock counters.
  REOPEN_CACHE_IDENT=""; REOPEN_CACHE_STATE=""
  rm -f "$TMPDIR_ROOT"/clients.*.n "$TMPDIR_ROOT"/readscreen.n
  MOCK_CMUX_OPS=""
  consume_pending_reopen_sweep 2>>"$TMPDIR_ROOT/t254.log"
  if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
    TOTAL_SWEEPS=$((TOTAL_SWEEPS + 1))
  fi
done
eval "$(declare -f write_generation_state_real | sed '1s/write_generation_state_real/write_generation_state/')"
unset -f write_generation_state_real
if [[ "$TOTAL_SWEEPS" -eq 3 ]]; then
  pass "exactly 3 sweeps across restarts under persistent done-write failure (durable cap)"
else fail "expected 3 sweeps under done-write failure, got $TOTAL_SWEEPS"; fi
if grep -q "attempt budget exhausted" "$TMPDIR_ROOT/t254.log"; then
  pass "give-up logged after budget exhaustion"
else fail "expected give-up log"; fi

echo "Test: FLY-254 CR-L8 — slice larger than total cannot oversleep"
reset_mocks
CMUX_HEALTH_LAST_RC=1
export FLYWHEEL_CMUX_SOCKET_PROBE_SLICE=60
reopen_aware_sleep 15 2>/dev/null
if [[ "$MOCK_SLEEP_ARGS" == "3 3 3 3 3 " ]]; then
  pass "event SLA caps a larger reopen slice at five 3s steps without oversleep"
else fail "oversleep: slept '$MOCK_SLEEP_ARGS' for a 15s request"; fi
export FLYWHEEL_CMUX_SOCKET_PROBE_SLICE=3

echo "Test: FLY-254 CR-M7 — probe structure (unrendered diagnostic + trap restore + ref validation)"
PROBE_SH="$SCRIPT_DIR/fly254-p0-probe.sh"
if grep -q 'Terminal surface not found' "$PROBE_SH" \
   && grep -q 'trap restore_focus EXIT' "$PROBE_SH" \
   && grep -q "trap 'exit 130' INT" "$PROBE_SH" \
   && grep -q 'is_ws_ref' "$PROBE_SH"; then
  pass "probe requires the unrendered diagnostic, arms restore-on-EXIT + terminating signal traps, validates refs"
else fail "probe missing diagnostic requirement / trap split / ref validation"; fi

echo "Test: FLY-254 CR-R2-HIGH-1 — single-workspace identity flip during render wait: zero send, zero restore"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %"   # would render fine — but the generation flips first
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 1 ]] && MOCK_SOCK_IDENT="B:2:2"'   # flips during the render wait
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:7"; then
  pass "focus happened on generation A (pre-flip)"
else fail "expected the initial ws7 focus; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "send landed on generation B (uncharged cross-generation send)"
else pass "no send after the generation flipped (post-render-wait re-check)"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore landed on generation B"
else pass "no restore after the generation flipped (latch suppresses epilogue)"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "mid-sweep generation flip logged"
else fail "expected mid-sweep flip log"; fi

echo "Test: FLY-254 CR-R2-M2 behavioral — TERM during probe polling terminates + restores exactly once"
# (TERM, not INT: background jobs in a non-interactive shell ignore SIGINT
# per POSIX — the INT trap is for interactive operator use and shares the
# exact same exit-via-EXIT-trap mechanism being tested here.)
mkdir -p "$TMPDIR_ROOT/fakebin"
FAKE_CMUX_LOG="$TMPDIR_ROOT/fakecmux.log"
> "$FAKE_CMUX_LOG"
cat > "$TMPDIR_ROOT/fakebin/cmux" <<FAKECMUX
#!/bin/bash
LOG="$FAKE_CMUX_LOG"
if [[ "\$1" == "--socket" ]]; then shift 2; fi
if [[ "\$1" == "--json" ]]; then shift; fi
case "\$1" in
  ping) echo PONG ;;
  list-workspaces)
    echo '{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"}]}' ;;
  read-screen)
    echo "Error: internal_error: ERROR: Terminal surface not found" >&2
    exit 1 ;;
  select-workspace)
    echo "select \$*" >> "\$LOG"
    echo OK ;;
  *) echo OK ;;
esac
FAKECMUX
chmod +x "$TMPDIR_ROOT/fakebin/cmux"
# A unix socket file so the probe's [[ -S ]] precheck passes. CR-R3 LOW:
# AF_UNIX bind is rejected in some sandboxes — capability-check and SKIP
# (matching the harness's existing real-tmux skip pattern) instead of
# failing the whole run.
if ! python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.bind('$TMPDIR_ROOT/fake.sock')" 2>/dev/null; then
  echo "  ⏭  AF_UNIX bind unavailable (sandbox/restricted env) — skipping probe signal test"
  rm -f "$TMPDIR_ROOT/fake.sock" 2>/dev/null
else
  CMUX_SOCKET_PATH="$TMPDIR_ROOT/fake.sock" PATH="$TMPDIR_ROOT/fakebin:$PATH" \
    /bin/bash "$SCRIPT_DIR/fly254-p0-probe.sh" > "$TMPDIR_ROOT/probe.out" 2>&1 &
  PROBE_PID=$!
  # Wait until the target focus is logged (probe is in its polling loop), then TERM.
  for _i in $(seq 1 50); do
    grep -q "workspace:7" "$FAKE_CMUX_LOG" 2>/dev/null && break
    command sleep 0.2
  done
  kill -TERM "$PROBE_PID" 2>/dev/null
  PROBE_RC=0
  wait "$PROBE_PID" || PROBE_RC=$?
  if [[ "$PROBE_RC" -eq 143 ]]; then
    pass "TERM terminates the probe (rc=143, no zombie polling)"
  else fail "expected rc=143 on TERM, got $PROBE_RC; out: $(tail -3 "$TMPDIR_ROOT/probe.out")"; fi
  RESTORES=$(grep -c "select-workspace --workspace workspace:1" "$FAKE_CMUX_LOG" 2>/dev/null)
  if [[ "$RESTORES" -eq 1 ]]; then
    pass "exactly one restore to the original tab on interrupt"
  else fail "expected 1 restore, got $RESTORES; log: $(cat "$FAKE_CMUX_LOG")"; fi
  if grep -q "RESULT: PASS" "$TMPDIR_ROOT/probe.out"; then
    fail "interrupted probe still reported PASS"
  else pass "no PASS verdict from an interrupted probe"; fi
  rm -f "$TMPDIR_ROOT/fake.sock"
fi

echo "Test: FLY-254 CR-R3-HIGH-1 — identity flip DURING the pre-focus selected-ref IPC"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# JSON call #4 is the pre-focus current_selected_ref (1=readiness, 2=sweep
# snapshot, 3=one_workspace refs, 4=pre-focus read). The flip lands while
# that IPC is in flight; the re-stat immediately before select-workspace
# must catch it — ZERO focus on generation B.
MOCK_JSON_FLIP_IDENT="B:2:2"
MOCK_JSON_FLIP_AT=4
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "focus/send landed on generation B (flip during pre-focus IPC); ops: $MOCK_CMUX_OPS"
else pass "pre-select re-stat blocks the focus after a flip during the JSON IPC"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the pre-focus IPC flip"
else fail "expected mid-sweep flip log"; fi

echo "Test: FLY-254 CR-R3-HIGH-1 — identity flip DURING the epilogue selected-ref IPC"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# JSON call #10 is the epilogue current_selected_ref (5-7 = render-loop reads,
# including the post-read-screen exact-title revalidation; 8 = exact birth
# token lookup used to preserve helper-reap attribution across heal; 9 = the
# final exact-title guard before the send mutation).
# The heal completes on A; the flip lands during the epilogue read; the
# pre-restore re-stat must skip the restore — generation B keeps its focus.
MOCK_JSON_FLIP_IDENT="B:2:2"
MOCK_JSON_FLIP_AT=10
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "heal completed on generation A before the flip"
else fail "expected the ws7 heal on A; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore landed on generation B (flip during epilogue IPC)"
else pass "pre-restore re-stat blocks the restore after a flip during the JSON IPC"; fi
if grep -q "generation changed before restore" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the epilogue IPC flip"
else fail "expected before-restore flip log"; fi

echo "Test: FLY-254 CR-R4-HIGH-1 — the final stat is the GENUINE last op before the restore mutation"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# Hook `log`: flip the identity the moment the restored-focus message is
# emitted. With the log AFTER the mutation the flip lands too late and the
# select mock records ident=A; a regression (log before select) would make
# the flip land first and the mock would record ident=B.
eval "$(declare -f log | sed '1s/^log/log_real_254/')"
log() {
  # CR-R5 M2 honesty fix: match BOTH message forms — against the pre-R4 code
  # ("restoring focus", emitted BEFORE the mutation) this hook flips first
  # and the select records ident=B → the test goes RED; against the fixed
  # code ("restored focus", after the mutation) it stays green.
  if [[ "$*" == *"restor"*"focus"* ]]; then
    printf '%s' "B:2:2" > "$TMPDIR_ROOT/mock-ident.override"
  fi
  log_real_254 "$@"
}
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
eval "$(declare -f log_real_254 | sed '1s/^log_real_254/log/')"
unset -f log_real_254
RESTORE_LINE=$(echo "$MOCK_CMUX_OPS" | grep "select-workspace --workspace workspace:1")
if [[ "$RESTORE_LINE" == *"ident=A:1:1"* ]]; then
  pass "restore mutation observed generation A (no bookkeeping between stat and select)"
else fail "restore observed the wrong generation: $RESTORE_LINE"; fi

# ── CR-R5 HIGH-1: the wrapper's own mktemp is the last bookkeeping step —
# the guard must run AFTER it. The hook below flips the identity exactly at
# the Nth guarded mktemp (guarded mktemps in the happy path: 1=pre-focus
# select, 2=send, 3=restore). Against the pre-R5 implementation (guards
# outside the wrapper) every one of these flips lands AFTER the guard and
# the mutation executes on B — red/green verified by stashing the fix.
MKTEMP_FLIP_HOOK='gn=0; [[ -f "$TMPDIR_ROOT/gmk.n" ]] && gn=$(cat "$TMPDIR_ROOT/gmk.n"); gn=$((gn+1)); echo "$gn" > "$TMPDIR_ROOT/gmk.n"; [[ "$gn" -ge "${MOCK_MKTEMP_FLIP_AT:-1}" ]] && printf "%s" "B:2:2" > "$TMPDIR_ROOT/mock-ident.override"'

echo "Test: FLY-254 CR-R5-HIGH-1 — identity flip at the wrapper's mktemp blocks the FOCUS"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_MKTEMP_FLIP_AT=1
MOCK_MKTEMP_HOOK="$MKTEMP_FLIP_HOOK"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "mutation executed on generation B (flip at the wrapper mktemp); ops: $MOCK_CMUX_OPS"
else pass "in-wrapper guard blocks the focus after a flip at the wrapper's mktemp"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the wrapper-boundary flip"
else fail "expected mid-sweep flip log"; fi

echo "Test: FLY-254 CR-R5-HIGH-1 — identity flip at the wrapper's mktemp blocks the SEND"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_MKTEMP_FLIP_AT=2   # 1=pre-focus select (passes on A), 2=the send
MOCK_MKTEMP_HOOK="$MKTEMP_FLIP_HOOK"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:7 ident=A:1:1"; then
  pass "focus executed on generation A (pre-flip)"
else fail "expected the ws7 focus on A; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "send executed on generation B (flip at the wrapper mktemp)"
else pass "in-wrapper guard blocks the send after a flip at the wrapper's mktemp"; fi

echo "Test: FLY-254 CR-R5-HIGH-1 — identity flip at the wrapper's mktemp blocks the RESTORE"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_MKTEMP_FLIP_AT=3   # 1=pre-focus select, 2=send, 3=the restore
MOCK_MKTEMP_HOOK="$MKTEMP_FLIP_HOOK"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "heal completed on generation A before the flip"
else fail "expected the ws7 heal on A; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore executed on generation B (flip at the wrapper mktemp)"
else pass "in-wrapper guard blocks the restore after a flip at the wrapper's mktemp"; fi
if grep -q "generation changed before restore" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the wrapper-boundary restore flip"
else fail "expected before-restore flip log"; fi

echo "Test: FLY-254 CR-R6-LOW — a real cmux exit code is never misread as a guard block"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_CMUX_SELECT_RC=99   # the old sentinel value, now a plain cmux failure
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
MOCK_CMUX_SELECT_RC=""
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  fail "cmux rc=99 was misread as a generation-change guard block"
else pass "cmux rc=99 handled as a plain select failure (GUARD_WAS_BLOCKED side channel)"; fi
if grep -q "WARN: cmux select-workspace failed (rc=99)" "$TMPDIR_ROOT/t254.log"; then
  pass "plain cmux failure logged through the wrapper's WARN path"
else fail "expected the wrapper WARN for rc=99; log: $(grep WARN "$TMPDIR_ROOT/t254.log" | head -2)"; fi

# ════════════════════════════════════════════════════════════════
# FLY-293: orphan cmux workspace-pin reaper
# ════════════════════════════════════════════════════════════════

# Standard fixture: one orphan managed pin + a live runner + a live Lead + a
# remain-on-exit dead-pin runner (window exists) + a ghost + a user tab + a
# non-managed direct-vendor tab. The orphan uses the vendor-neutral
# "{issueId}-runner-{family}-{model}-{slug}" producer shape.
_fly293_fixture() {
  reset_mocks
  MOCK_TMUX_SESSIONS=$'flywheel\nrunner-flywheel\ncmux-LEARN-142-claude-LEARN-141\ncmux-flywheel-flywheel-cos-lead'
  # flywheel session: Lead window + zsh. runner-flywheel: live runner + dead-pin runner.
  MOCK_TMUX_WINDOWS=$'flywheel|@0|zsh\nflywheel|@1|flywheel-flywheel-cos-lead\nrunner-flywheel|@2|LEARN-142-claude-LEARN-141\nrunner-flywheel|@3|FLY-999-claude-deadpin'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[
    {"ref":"workspace:36","title":"FLY-637-runner-codex-G-FLY-626-follow-up"},
    {"ref":"workspace:62","title":"LEARN-142-claude-LEARN-141"},
    {"ref":"workspace:23","title":"flywheel-flywheel-cos-lead"},
    {"ref":"workspace:99","title":"FLY-999-claude-deadpin"},
    {"ref":"workspace:10","title":"~"},
    {"ref":"workspace:5","title":"home"},
    {"ref":"workspace:7","title":"FLY-1-codex-x"}
  ]}'
  test_ensure_mutator_lease || return 1
  printf 'committed|cmux-test-generation|workspace:36|FLY-637-runner-codex-G-FLY-626-follow-up\n' > "$VIEW_LEDGER"
}

_fly2048_prepared_fixture() {
  reset_mocks
  MOCK_TMUX_SESSIONS='flywheel'
  MOCK_TMUX_WINDOWS='flywheel|@0|zsh'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[
    {"ref":"workspace:2048","id":"00000000-0000-4000-8000-000000002048","title":"FLY-2048-runner-codex-G-zombie"}
  ]}'
  test_ensure_mutator_lease || return 1
  printf 'prepared|cmux-test-generation|workspace:2048|FLY-2048-runner-codex-G-zombie|00000000-0000-4000-8000-000000002048\n' > "$VIEW_LEDGER"
}

test_fly2048_prepared_uuid_orphan_is_exactly_reaped() {
  echo "Test: FLY-2048 exact five-field prepared orphan enters the shared close path"
  _fly2048_prepared_fixture
  local refs rc=0
  refs=$(orphan_pin_refs) || rc=$?
  if [[ "$rc" == 0 && "$refs" == $'workspace:2048\tFLY-2048-runner-codex-G-zombie' ]]; then
    pass "exact prepared orphan enumerated"
  else
    fail "exact prepared orphan missing rc=$rc refs=[$refs]"
  fi
  reap_orphan_pins_oneshot >/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q '^close-workspace --workspace workspace:2048$' \
      && ! grep -q 'workspace:2048' "$VIEW_LEDGER" 2>/dev/null; then
    pass "exact prepared orphan closed and receipt removed"
  else
    fail "prepared orphan did not converge ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly2048_prepared_legacy_or_uuid_drift_stays_fail_closed() {
  echo "Test: FLY-2048 legacy prepared and UUID drift never authorize close"
  _fly2048_prepared_fixture
  printf 'prepared|cmux-test-generation|workspace:2048|FLY-2048-runner-codex-G-zombie\n' > "$VIEW_LEDGER"
  local legacy_refs drift_refs
  legacy_refs=$(orphan_pin_refs)
  _fly2048_prepared_fixture
  printf 'prepared|cmux-test-generation|workspace:2048|FLY-2048-runner-codex-G-zombie|00000000-0000-4000-8000-000000009999\n' > "$VIEW_LEDGER"
  drift_refs=$(orphan_pin_refs)
  if [[ -z "$legacy_refs" && -z "$drift_refs" && -z "$MOCK_CMUX_OPS" ]]; then
    pass "legacy prepared and UUID drift preserved"
  else
    fail "prepared fail-closed boundary drifted legacy=[$legacy_refs] uuid=[$drift_refs] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly2048_prepared_close_request_keeps_tristate_contract() {
  echo "Test: FLY-2048 prepared close-request uses exact close and preserves rc=1/rc=2 semantics"
  _fly2048_prepared_fixture
  printf 'FLY-2048-runner-codex-G-zombie\n' > "$CLOSE_REQUEST_FILE"
  process_close_requests
  local exact_closed=0
  echo "$MOCK_CMUX_OPS" | grep -q '^close-workspace --workspace workspace:2048$' && exact_closed=1

  _fly2048_prepared_fixture
  printf 'FLY-2048-runner-codex-G-zombie\n' > "$CLOSE_REQUEST_FILE"
  MOCK_TMUX_WINDOWS=$'flywheel|@0|zsh\nrunner-flywheel|@2048|FLY-2048-runner-codex-G-zombie'
  MOCK_TMUX_SESSIONS=$'flywheel\nrunner-flywheel'
  process_close_requests
  local live_requeued=0
  [[ -f "$CLOSE_REQUEST_FILE" ]] && live_requeued=1

  _fly2048_prepared_fixture
  printf 'FLY-2048-runner-codex-G-zombie\n' > "$CLOSE_REQUEST_FILE"
  MOCK_CMUX_CLOSE_FAIL=1
  process_close_requests
  if [[ "$exact_closed" == 1 && "$live_requeued" == 0 \
      && -f "$CLOSE_REQUEST_FILE" \
      && "$(cat "$CLOSE_REQUEST_FILE")" == 'FLY-2048-runner-codex-G-zombie' ]]; then
    pass "prepared marker closes exact orphan, drops live predicate skip, and requeues close uncertainty"
  else
    fail "prepared close-request tristate drifted closed=$exact_closed live_requeued=$live_requeued retry=[$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)]"
  fi
}

test_fly293_managed_title_gate() {
  echo "Test: is_managed_runner_title — source-accurate (legacy, model, and phase labels)"
  reset_mocks
  local ok=1
  # Legacy claude + vendor-neutral runner model labels + FLY-793 DAG workflow
  # phase labels (design/implement/qa), including bare-phase-at-end.
  for t in "FLY-637-claude-x" "LEARN-143-claude-LEARN-141" "TIDE-22-claude-round-2" "FLY-1-claude" \
           "FLY-1255-runner-codex-G-title" "FLY-9-runner-kimi-K-title" \
           "FLY-793-design-DAG workflow" "FLY-800-implement-LEARN-1" "TIDE-5-qa-round-2" "FLY-2-qa" \
           "FLY-1255-runner-codex-GPT-5-6-title" "FLY-9-runner-kimi-kimi-for-coding-title" \
           "FLY-793-implement-codex-G-title" \
           "FLY-1550-runner-claude-Fable-runner-lead-config" "FLY-1502-runner-claude-test-model-engineer" \
           "FLY-1548-implement-claude-Fable-thread-title"; do
    # FLY-1255 (Plan B): the gate keys on the fixed `runner`/phase PREFIX, not the
    # model segment — so BOTH the new short-code windows (`runner-codex-G`) and any
    # pre-deploy long-form windows (`runner-codex-GPT-5-6`) that coexist during a
    # rollout stay managed. The reaper never widens its kill radius by model.
    is_managed_runner_title "$t" || { fail "expected MANAGED: $t"; ok=0; }
  done
  # reverse sentinels — producer cannot emit these; must be non-managed.
  # Includes phase-label near-misses (boundary must be `-` or end, so
  # designer/implementation/qaX are NOT the phase labels).
  for t in "FLY-293-codex-foo" "FLY-293-gemini-notes" "FLY-1-cursor-x" "FLY-1-kimi-x" "FLY-1-agy-x" "FLY-1-runnerX-codex-x" \
           "flywheel-flywheel-cos-lead" "home" "notes" "FLY-293-claudette-x" "notes-FLY-1-claude" "FLY-637" \
           "FLY-1-designer-x" "FLY-1-implementation-x" "FLY-1-qaX" "FLY-1-designx" \
           "FLY-1550·tight" "lead · dashboard" "1550 · bare-number" "fly-1550 · lowercase" "· headless"; do
    if is_managed_runner_title "$t"; then fail "expected NON-managed: $t"; ok=0; fi
  done
  [[ "$ok" == "1" ]] && pass "managed gate matches claude|runner|design|implement|qa; rejects direct vendors / Lead / user tab / bare-id / near-misses"
}

test_fly293_orphan_pin_refs_identifies_only_orphan() {
  echo "Test: orphan_pin_refs identifies ONLY the fully-orphaned managed pin"
  _fly293_fixture
  local out rc=0
  out=$(orphan_pin_refs) || rc=$?
  if [[ $rc -ne 0 ]]; then fail "expected rc=0, got $rc"; return; fi
  # exactly one orphan: workspace:36
  if echo "$out" | grep -q "^workspace:36	FLY-637-runner-codex-G-FLY-626-follow-up$"; then
    pass "orphan workspace:36 identified"
  else
    fail "orphan:36 missing. out=[$out]"
  fi
  local n; n=$(echo "$out" | grep -c "^workspace:" || true)
  if [[ "$n" == "1" ]]; then pass "exactly 1 orphan (live runner/Lead, dead-pin, ghost, user tab, codex tab all excluded)"; else fail "expected 1 orphan, got $n. out=[$out]"; fi
  # explicit negatives
  echo "$out" | grep -q "workspace:62" && fail "live runner (62) wrongly orphaned" || pass "live runner kept"
  echo "$out" | grep -q "workspace:23" && fail "live Lead (23) wrongly orphaned" || pass "live Lead kept"
  echo "$out" | grep -q "workspace:99" && fail "dead-pin (99, FLY-720 boundary) wrongly orphaned" || pass "dead-pin window kept (FLY-720 boundary)"
  echo "$out" | grep -q "workspace:5" && fail "user tab (home) wrongly orphaned" || pass "user tab kept"
  echo "$out" | grep -q "workspace:7" && fail "non-managed vendor (codex) wrongly orphaned" || pass "non-managed vendor tab kept"
  echo "$out" | grep -q "workspace:10" && fail "ghost (~) wrongly in orphan set" || pass "ghost left to ghost reaper"
}

test_fly293_orphan_pin_refs_json_fail_rc2() {
  echo "Test: orphan_pin_refs rc=2 on cmux JSON unavailable"
  _fly293_fixture
  MOCK_CMUX_JSON_FAIL="1"
  local out rc=0
  out=$(orphan_pin_refs 2>/dev/null) || rc=$?
  if [[ $rc -eq 2 && -z "$out" ]]; then pass "cmux JSON down → rc=2, empty (fail-closed)"; else fail "rc=$rc out=[$out]"; fi
}

test_fly293_orphan_pin_refs_listsessions_fail_rc2() {
  echo "Test: orphan_pin_refs rc=2 on tmux list-sessions failure"
  _fly293_fixture
  MOCK_TMUX_LIST_FAIL="1"
  local out rc=0
  out=$(orphan_pin_refs 2>/dev/null) || rc=$?
  if [[ $rc -eq 2 && -z "$out" ]]; then pass "tmux list-sessions down → rc=2 (fail-closed)"; else fail "rc=$rc out=[$out]"; fi
}

test_fly293_orphan_pin_refs_listwindows_fail_rc2() {
  echo "Test: orphan_pin_refs rc=2 on tmux list-windows failure"
  _fly293_fixture
  MOCK_TMUX_LISTWINDOWS_FAIL="1"
  local out rc=0
  out=$(orphan_pin_refs 2>/dev/null) || rc=$?
  if [[ $rc -eq 2 && -z "$out" ]]; then pass "tmux list-windows down → rc=2 (fail-closed)"; else fail "rc=$rc out=[$out]"; fi
}

test_fly293_close_if_still_orphan_closes() {
  echo "Test: close_orphan_workspace_pin_if_still_orphan closes a still-orphan pin"
  _fly293_fixture
  close_orphan_workspace_pin_if_still_orphan "workspace:36" "FLY-637-runner-codex-G-FLY-626-follow-up"
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:36"; then
    pass "orphan closed via revalidating chokepoint"
  else fail "no close. ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_close_skips_malformed_ref() {
  echo "Test: close chokepoint skips malformed ref"
  _fly293_fixture
  close_orphan_workspace_pin_if_still_orphan "bogus-ref" "FLY-637-runner-codex-G-FLY-626-follow-up" 2>/dev/null
  if [[ -z "$MOCK_CMUX_OPS" ]]; then pass "malformed ref → no close"; else fail "ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_close_skips_title_drift() {
  echo "Test: close chokepoint skips when title drifted from the vetted title"
  _fly293_fixture
  close_orphan_workspace_pin_if_still_orphan "workspace:36" "FLY-637-claude-STALE-DIFFERENT" 2>/dev/null
  if [[ -z "$MOCK_CMUX_OPS" ]]; then pass "title drift → no close (TOCTOU guard)"; else fail "ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_close_skips_when_window_reappeared() {
  echo "Test: close chokepoint skips when a same-name window reappeared"
  _fly293_fixture
  # workspace:36's runner window came back alive between derive and close
  MOCK_TMUX_WINDOWS="$MOCK_TMUX_WINDOWS"$'\nrunner-flywheel|@4|FLY-637-runner-codex-G-FLY-626-follow-up'
  close_orphan_workspace_pin_if_still_orphan "workspace:36" "FLY-637-runner-codex-G-FLY-626-follow-up" 2>/dev/null
  if [[ -z "$MOCK_CMUX_OPS" ]]; then pass "window reappeared → no close (final revalidation)"; else fail "ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_reap_grace_first_seen_no_close() {
  echo "Test: reap first-sighting records grace, does NOT close"
  _fly293_fixture
  reap_orphan_workspace_pins
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace"; then fail "closed on first sighting"; else pass "no close on first sighting"; fi
  if grep -q "^workspace:36|" "$ORPHAN_PIN_STATE" 2>/dev/null; then pass "grace clock recorded for workspace:36"; else fail "no grace row. state=[$(cat "$ORPHAN_PIN_STATE" 2>/dev/null)]"; fi
  if echo "$MOCK_CMUX_OPS" | grep -q "refresh-surfaces"; then fail "refresh-surfaces called with 0 closes"; else pass "no refresh-surfaces (nothing closed)"; fi
}

test_fly293_reap_grace_met_closes_and_refreshes() {
  echo "Test: reap closes after grace met + calls refresh-surfaces"
  _fly293_fixture
  printf 'workspace:36|1|Rk9v\n' > "$ORPHAN_PIN_STATE"   # ancient first-seen (ts=1)
  reap_orphan_workspace_pins
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:36"; then pass "orphan closed after grace"; else fail "no close. ops=[$MOCK_CMUX_OPS]"; fi
  if echo "$MOCK_CMUX_OPS" | grep -q "refresh-surfaces"; then pass "refresh-surfaces called after close"; else fail "no refresh. ops=[$MOCK_CMUX_OPS]"; fi
  if grep -q "^workspace:36|" "$ORPHAN_PIN_STATE" 2>/dev/null; then fail "closed ref still in state"; else pass "closed ref dropped from state"; fi
}

test_fly293_reap_grace_cancel_when_recovered() {
  echo "Test: reap drops grace row when pin is no longer orphan"
  _fly293_fixture
  # pre-seed a grace row for a ref that is NOT orphan this pass (workspace:62 = live runner)
  printf 'workspace:62|1|eA==\n' > "$ORPHAN_PIN_STATE"
  reap_orphan_workspace_pins
  if grep -q "^workspace:62|" "$ORPHAN_PIN_STATE" 2>/dev/null; then fail "recovered ref still in state"; else pass "recovered ref's grace row dropped"; fi
  echo "$MOCK_CMUX_OPS" | grep -q "workspace:62" && fail "live runner closed!" || pass "live runner never closed"
}

test_fly293_reap_grace_ref_keyed_not_title() {
  echo "Test: grace is ref-keyed — same-title stale ref does NOT age a new ref (HIGH-3)"
  reset_mocks
  MOCK_TMUX_SESSIONS=$'flywheel\nrunner-flywheel'
  MOCK_TMUX_WINDOWS=$'flywheel|@0|zsh'
  # two orphan pins, SAME title, different refs (no window, no cmux- session)
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[
    {"ref":"workspace:40","title":"FLY-500-claude-x"},
    {"ref":"workspace:41","title":"FLY-500-claude-x"}
  ]}'
  test_ensure_mutator_lease || return 1
  printf 'committed|cmux-test-generation|workspace:40|FLY-500-claude-x\ncommitted|cmux-test-generation|workspace:41|FLY-500-claude-x\n' > "$VIEW_LEDGER"
  # workspace:40 already aged (ancient), workspace:41 unseen
  printf 'workspace:40|1|eA==\n' > "$ORPHAN_PIN_STATE"
  reap_orphan_workspace_pins
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:40"; then pass "aged ref (40) closed"; else fail "40 not closed. ops=[$MOCK_CMUX_OPS]"; fi
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:41"; then fail "new ref (41) wrongly aged by same-title 40 (title-keyed bug)"; else pass "new ref (41) NOT aged by same-title stale ref → grace is ref-keyed"; fi
}

test_fly293_reap_multiple_orphans() {
  echo "Test: reap closes multiple orphans in one pass (grace met)"
  reset_mocks
  MOCK_TMUX_SESSIONS=$'flywheel'
  MOCK_TMUX_WINDOWS=$'flywheel|@0|zsh'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[
    {"ref":"workspace:40","title":"FLY-500-claude-a"},
    {"ref":"workspace:41","title":"FLY-501-claude-b"}
  ]}'
  test_ensure_mutator_lease || return 1
  printf 'committed|cmux-test-generation|workspace:40|FLY-500-claude-a\ncommitted|cmux-test-generation|workspace:41|FLY-501-claude-b\n' > "$VIEW_LEDGER"
  printf 'workspace:40|1|eA==\nworkspace:41|1|eA==\n' > "$ORPHAN_PIN_STATE"
  reap_orphan_workspace_pins
  local n; n=$(echo "$MOCK_CMUX_OPS" | grep -c "^close-workspace --workspace workspace:4" || true)
  if [[ "$n" == "2" ]]; then pass "both orphans closed"; else fail "expected 2 closes, got $n. ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_reap_env_off_inert() {
  echo "Test: retired orphan-reaper env cannot disable periodic cleanup"
	_fly293_fixture
	printf 'workspace:36|1|eA==\n' > "$ORPHAN_PIN_STATE"   # would otherwise close
	FLYWHEEL_CMUX_ORPHAN_REAPER=0 reap_orphan_workspace_pins
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:36"; then
    pass "retired env is ignored and the orphan closes"
  else fail "retired env still blocked orphan cleanup ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_list_orphan_pins_readonly() {
  echo "Test: --list-orphan-pins is read-only (never closes)"
  _fly293_fixture
  local out; out=$(list_orphan_pins 2>/dev/null)
  if echo "$out" | grep -q "workspace:36"; then pass "list shows orphan workspace:36"; else fail "list missing orphan. out=[$out]"; fi
  if [[ -z "$MOCK_CMUX_OPS" ]]; then pass "list closed nothing (read-only)"; else fail "list mutated cmux! ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_reap_oneshot_no_grace() {
  echo "Test: --reap-orphan-pins closes immediately (no grace) + refresh"
  _fly293_fixture   # empty grace state → periodic would NOT close, but one-shot must
  reap_orphan_pins_oneshot >/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:36"; then pass "one-shot closed orphan without grace"; else fail "no close. ops=[$MOCK_CMUX_OPS]"; fi
  if echo "$MOCK_CMUX_OPS" | grep -q "refresh-surfaces"; then pass "one-shot refreshed after close"; else fail "no refresh"; fi
  # one-shot must NOT touch live/lead/deadpin/user/ghost
  local n; n=$(echo "$MOCK_CMUX_OPS" | grep -c "^close-workspace" || true)
  if [[ "$n" == "1" ]]; then pass "one-shot closed exactly the 1 orphan"; else fail "expected 1 close, got $n. ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_reap_oneshot_works_when_env_off() {
  echo "Test: --reap-orphan-pins is an explicit operator action (not env-gated)"
  _fly293_fixture
  FLYWHEEL_CMUX_ORPHAN_REAPER=0 reap_orphan_pins_oneshot >/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:36"; then pass "one-shot still works with reaper env off (operator override)"; else fail "one-shot blocked by env off. ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly293_gc_orphan_pin_state() {
  echo "Test: gc_orphan_pin_state_file drops rows whose ref is gone"
  _fly293_fixture
  # workspace:36 exists in JSON; workspace:9999 does not
  printf 'workspace:36|1|eA==\nworkspace:9999|1|eA==\n' > "$ORPHAN_PIN_STATE"
  gc_orphan_pin_state_file
  if grep -q "^workspace:36|" "$ORPHAN_PIN_STATE" && ! grep -q "^workspace:9999|" "$ORPHAN_PIN_STATE"; then
    pass "gc kept live ref, dropped dead ref"
  else fail "gc wrong. state=[$(cat "$ORPHAN_PIN_STATE")]"; fi
  # The retired env cannot disable GC.
	printf 'workspace:9999|1|eA==\n' > "$ORPHAN_PIN_STATE"
	FLYWHEEL_CMUX_ORPHAN_REAPER=0 gc_orphan_pin_state_file
  if ! grep -q "^workspace:9999|" "$ORPHAN_PIN_STATE"; then pass "retired env is ignored by GC"; else fail "retired env still blocked GC"; fi
}

# Codex code-review R1 MED-1/MED-2: reap must never abort the watcher under
# `set -euo pipefail` on a corrupt state row, a non-numeric grace env, or an
# unwritable state path. Run in a `( set -euo pipefail; ... )` subshell so a
# crash surfaces as a non-zero rc.
test_fly293_reap_corrupt_state_row_no_crash() {
  echo "Test: reap survives a corrupt (non-numeric) first_seen under set -e"
  _fly293_fixture
  printf 'workspace:36|NOTNUM|eA==\n' > "$ORPHAN_PIN_STATE"
  ( set -euo pipefail; reap_orphan_workspace_pins ) >/dev/null 2>&1
  local rc=$?
  [[ $rc -eq 0 ]] && pass "corrupt first_seen → rc=0 (watcher survives)" || fail "crashed rc=$rc"
  # row self-heals to a numeric clock and is NOT closed this tick
  _fly293_fixture
  printf 'workspace:36|NOTNUM|eA==\n' > "$ORPHAN_PIN_STATE"
  reap_orphan_workspace_pins
  if grep -q '^workspace:36|[0-9][0-9]*|' "$ORPHAN_PIN_STATE"; then pass "corrupt row healed to numeric clock"; else fail "not healed: [$(cat "$ORPHAN_PIN_STATE")]"; fi
  echo "$MOCK_CMUX_OPS" | grep -q "close-workspace" && fail "corrupt row wrongly closed this tick" || pass "corrupt row not closed (grace restarted)"
}

test_fly293_reap_nonnumeric_grace_no_crash() {
  echo "Test: reap survives a non-numeric FLYWHEEL_CMUX_ORPHAN_PIN_GRACE under set -e"
  _fly293_fixture
  printf 'workspace:36|1|eA==\n' > "$ORPHAN_PIN_STATE"
  ( set -euo pipefail; FLYWHEEL_CMUX_ORPHAN_PIN_GRACE=abc reap_orphan_workspace_pins ) >/dev/null 2>&1
  local rc=$?
  [[ $rc -eq 0 ]] && pass "non-numeric grace → rc=0 (falls back, watcher survives)" || fail "crashed rc=$rc"
}

test_fly293_reap_unwritable_state_no_crash() {
  echo "Test: reap fail-closed on an unwritable state path under set -e"
  _fly293_fixture
  ( set -euo pipefail; ORPHAN_PIN_STATE=/ reap_orphan_workspace_pins ) >/dev/null 2>&1
  local rc=$?
  [[ $rc -eq 0 ]] && pass "unwritable ORPHAN_PIN_STATE → rc=0 (skips, watcher survives)" || fail "crashed rc=$rc"
}

# Codex code-review R2 MED: lexical length caps before arithmetic — an all-digit
# but HUGE first_seen / grace overflows bash 3.2 64-bit arithmetic and can wrap
# to bypass grace's fail-closed protection.
test_fly293_reap_overflow_length_caps() {
  echo "Test: reap length-caps huge first_seen / grace (no 64-bit overflow bypass)"
  _fly293_fixture
  printf 'workspace:36|99999999999999999999|eA==\n' > "$ORPHAN_PIN_STATE"   # 20-digit corrupt clock
  reap_orphan_workspace_pins
  echo "$MOCK_CMUX_OPS" | grep -q "close-workspace" && fail "huge first_seen wrongly closed (overflow into close branch)" || pass "huge first_seen NOT closed (length cap → treated as first-seen)"
  if grep -qE '^workspace:36\|[0-9]{1,12}\|' "$ORPHAN_PIN_STATE"; then pass "huge first_seen re-clocked to a sane epoch"; else fail "not re-clocked: [$(cat "$ORPHAN_PIN_STATE")]"; fi
  # huge grace must be capped (not wrap-negative → premature close of a within-grace pin)
  _fly293_fixture
  local ts10; ts10=$(( $(date +%s) - 10 ))
  printf 'workspace:36|%s|eA==\n' "$ts10" > "$ORPHAN_PIN_STATE"           # 10s old → within any sane grace
  FLYWHEEL_CMUX_ORPHAN_PIN_GRACE=999999999999999 reap_orphan_workspace_pins
  echo "$MOCK_CMUX_OPS" | grep -q "close-workspace" && fail "huge grace overflow bypassed grace (10s-old pin closed)" || pass "huge grace capped→300; 10s-old pin NOT closed (grace intact)"
}

# ════════════════════════════════════════════════════════════════
# FLY-685: close_runner close-request marker → immediate pin removal
# ════════════════════════════════════════════════════════════════

test_fly685_close_request_closes_orphan_pin() {
  echo "Test: process_close_requests closes a fully-gone runner's pin (marker → chokepoint, no grace)"
  _fly293_fixture
  printf 'FLY-637-runner-codex-G-FLY-626-follow-up\n' > "$CLOSE_REQUEST_FILE"
  process_close_requests
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:36"; then pass "orphan pin closed immediately (no grace)"; else fail "no close. ops=[$MOCK_CMUX_OPS]"; fi
  if echo "$MOCK_CMUX_OPS" | grep -q "refresh-surfaces"; then pass "refresh-surfaces after close"; else fail "no refresh. ops=[$MOCK_CMUX_OPS]"; fi
  if [[ ! -f "$CLOSE_REQUEST_FILE" ]]; then pass "marker consumed (not requeued)"; else fail "marker lingered: [$(cat "$CLOSE_REQUEST_FILE")]"; fi
  # never touches a live runner / Lead / dead-pin / user tab
  local n; n=$(echo "$MOCK_CMUX_OPS" | grep -c "^close-workspace" || true)
  if [[ "$n" == "1" ]]; then pass "closed exactly the 1 targeted pin"; else fail "expected 1 close, got $n. ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly685_close_request_skips_live_runner_no_requeue() {
  echo "Test: process_close_requests does NOT close a same-title LIVE runner + drops the marker (no requeue)"
  _fly293_fixture
  printf 'LEARN-142-claude-LEARN-141\n' > "$CLOSE_REQUEST_FILE"   # live runner (window @2 present)
  process_close_requests
  echo "$MOCK_CMUX_OPS" | grep -q "close-workspace" && fail "live runner pin wrongly closed!" || pass "live runner pin NOT closed (chokepoint rc=1)"
  if [[ ! -f "$CLOSE_REQUEST_FILE" ]]; then pass "predicate-skip marker DROPPED (never requeued through a live runner)"; else fail "marker wrongly requeued: [$(cat "$CLOSE_REQUEST_FILE")]"; fi
}

test_fly685_close_request_requeues_on_json_unavailable() {
  echo "Test: process_close_requests requeues on cmux JSON unavailable (workspace_refs_for rc=2)"
  _fly293_fixture
  printf 'FLY-637-runner-codex-G-FLY-626-follow-up\n' > "$CLOSE_REQUEST_FILE"
  MOCK_CMUX_JSON_FAIL="1"
  process_close_requests
  echo "$MOCK_CMUX_OPS" | grep -q "close-workspace" && fail "closed despite JSON down" || pass "no close when JSON down"
  if grep -qxF "FLY-637-runner-codex-G-FLY-626-follow-up" "$CLOSE_REQUEST_FILE" 2>/dev/null; then pass "marker requeued for next tick"; else fail "marker not requeued: [$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)]"; fi
}

test_fly685_close_request_survives_set_e() {
  echo "Test: process_close_requests survives set -euo pipefail when JSON unavailable (FLY-694)"
  _fly293_fixture
  printf 'FLY-637-runner-codex-G-FLY-626-follow-up\n' > "$CLOSE_REQUEST_FILE"
  MOCK_CMUX_JSON_FAIL="1"
  local rc=0
  ( set -euo pipefail; process_close_requests ) || rc=$?
  if [[ $rc -eq 0 ]]; then pass "watcher survived set -e (rc=0)"; else fail "watcher died under set -e (rc=$rc)"; fi
  if grep -qxF "FLY-637-runner-codex-G-FLY-626-follow-up" "$CLOSE_REQUEST_FILE" 2>/dev/null; then pass "marker requeued under set -e"; else fail "marker lost under set -e: [$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)]"; fi
}

test_fly685_close_request_final_gate_rc2_requeue_rc1_drop() {
  echo "Test: process_close_requests requeues on final-gate UNCERTAINTY (rc=2), drops on predicate skip (rc=1)"
  # Overrides are scoped to subshells so the real functions survive for later tests.
  _fly293_fixture
  printf 'FLY-637-runner-codex-G-FLY-626-follow-up\n' > "$CLOSE_REQUEST_FILE"
  (
    workspace_refs_for() { printf 'workspace:36\n'; return 0; }
    close_orphan_workspace_pin_if_still_orphan() { return 2; }   # uncertain
    process_close_requests
  )
  if grep -qxF "FLY-637-runner-codex-G-FLY-626-follow-up" "$CLOSE_REQUEST_FILE" 2>/dev/null; then pass "final-gate rc=2 → marker requeued"; else fail "rc=2 not requeued: [$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)]"; fi
  _fly293_fixture
  printf 'FLY-637-runner-codex-G-FLY-626-follow-up\n' > "$CLOSE_REQUEST_FILE"
  (
    workspace_refs_for() { printf 'workspace:36\n'; return 0; }
    close_orphan_workspace_pin_if_still_orphan() { return 1; }   # predicate skip
    process_close_requests
  )
  if [[ ! -f "$CLOSE_REQUEST_FILE" ]]; then pass "final-gate rc=1 (predicate skip) → marker dropped"; else fail "rc=1 wrongly requeued: [$(cat "$CLOSE_REQUEST_FILE")]"; fi
}

test_fly685_chokepoint_rc2_on_uncertainty() {
  echo "Test: close_orphan_workspace_pin_if_still_orphan → rc=2 on uncertainty, rc=1 on predicate skip"
  _fly293_fixture
  local rc=0
  close_orphan_workspace_pin_if_still_orphan "workspace:36" "FLY-637-claude-STALE-DIFFERENT" 2>/dev/null || rc=$?
  if [[ $rc -eq 1 ]]; then pass "title drift → rc=1 (predicate skip)"; else fail "expected rc=1, got $rc"; fi
  MOCK_CMUX_JSON_FAIL="1"
  rc=0
  close_orphan_workspace_pin_if_still_orphan "workspace:36" "FLY-637-runner-codex-G-FLY-626-follow-up" 2>/dev/null || rc=$?
  if [[ $rc -eq 2 ]]; then pass "cmux JSON down → rc=2 (uncertain)"; else fail "expected rc=2, got $rc"; fi
}

test_fly685_close_request_input_hardening() {
  echo "Test: process_close_requests rejects malformed marker lines (empty / tab / overlong) — no close, no crash"
  _fly293_fixture
  {
    printf '\n'                                                    # empty line
    printf 'FLY-637-claude-FLY\t626\n'                             # embedded tab
    printf 'FLY-637-claude-%s\n' "$(head -c 250 < /dev/zero | tr '\0' 'x')"  # overlong (>200)
  } > "$CLOSE_REQUEST_FILE"
  local rc=0
  ( set -euo pipefail; process_close_requests ) || rc=$?
  if [[ $rc -eq 0 ]]; then pass "malformed input did not crash the watcher"; else fail "crashed on malformed input (rc=$rc)"; fi
  if [[ -z "$MOCK_CMUX_OPS" ]]; then pass "malformed lines → no cmux ops"; else fail "malformed line acted on: ops=[$MOCK_CMUX_OPS]"; fi
}

test_fly685_gc_close_request_drops_stale() {
  echo "Test: gc_close_request_file drops marker lines with no live workspace, keeps live ones"
  _fly293_fixture
  {
    printf 'FLY-637-runner-codex-G-FLY-626-follow-up\n'   # has workspace:36 → keep
    printf 'FLY-999-claude-NO-SUCH-PIN\n'         # no matching workspace → drop
  } > "$CLOSE_REQUEST_FILE"
  gc_close_request_file
  if grep -qxF "FLY-637-runner-codex-G-FLY-626-follow-up" "$CLOSE_REQUEST_FILE"; then pass "live-workspace line kept"; else fail "live line dropped: [$(cat "$CLOSE_REQUEST_FILE")]"; fi
  if grep -qxF "FLY-999-claude-NO-SUCH-PIN" "$CLOSE_REQUEST_FILE"; then fail "stale line not dropped"; else pass "stale line dropped"; fi
}

test_fly685_chokepoint_rc2_on_close_mutation_failure() {
  echo "Test: close_orphan_workspace_pin_if_still_orphan → rc=2 when the cmux close mutation itself fails (Codex code R1 MED)"
  _fly293_fixture
  MOCK_CMUX_CLOSE_FAIL="1"   # revalidation passes, but close-workspace fails
  local rc=0
  close_orphan_workspace_pin_if_still_orphan "workspace:36" "FLY-637-runner-codex-G-FLY-626-follow-up" 2>/dev/null || rc=$?
  if [[ $rc -eq 2 ]]; then pass "unconfirmed close (cmux mutation failed) → rc=2 (uncertain, retry)"; else fail "expected rc=2, got $rc"; fi
  # sanity: a confirmed close is still rc=0
  MOCK_CMUX_CLOSE_FAIL="0"
  rc=0
  close_orphan_workspace_pin_if_still_orphan "workspace:36" "FLY-637-runner-codex-G-FLY-626-follow-up" || rc=$?
  if [[ $rc -eq 0 ]]; then pass "confirmed close → rc=0"; else fail "expected rc=0, got $rc"; fi
}

test_fly685_close_request_requeues_on_close_mutation_failure() {
  echo "Test: process_close_requests requeues the marker when the cmux close mutation fails (not silently dropped)"
  _fly293_fixture
  printf 'FLY-637-runner-codex-G-FLY-626-follow-up\n' > "$CLOSE_REQUEST_FILE"
  MOCK_CMUX_CLOSE_FAIL="1"
  process_close_requests
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:36"; then pass "close attempted"; else fail "close not attempted. ops=[$MOCK_CMUX_OPS]"; fi
  if grep -qxF "FLY-637-runner-codex-G-FLY-626-follow-up" "$CLOSE_REQUEST_FILE" 2>/dev/null; then pass "marker REQUEUED on unconfirmed close (retries next tick, not 5-min fallback)"; else fail "marker dropped despite close failure: [$(cat "$CLOSE_REQUEST_FILE" 2>/dev/null)]"; fi
}

echo ""
echo "═══ FLY-293: orphan cmux workspace-pin reaper ═══"
test_fly2048_prepared_uuid_orphan_is_exactly_reaped
test_fly2048_prepared_legacy_or_uuid_drift_stays_fail_closed
test_fly2048_prepared_close_request_keeps_tristate_contract
test_fly293_managed_title_gate
test_fly293_orphan_pin_refs_identifies_only_orphan
test_fly293_orphan_pin_refs_json_fail_rc2
test_fly293_orphan_pin_refs_listsessions_fail_rc2
test_fly293_orphan_pin_refs_listwindows_fail_rc2
test_fly293_close_if_still_orphan_closes
test_fly293_close_skips_malformed_ref
test_fly293_close_skips_title_drift
test_fly293_close_skips_when_window_reappeared
test_fly293_reap_grace_first_seen_no_close
test_fly293_reap_grace_met_closes_and_refreshes
test_fly293_reap_grace_cancel_when_recovered
test_fly293_reap_grace_ref_keyed_not_title
test_fly293_reap_multiple_orphans
test_fly293_reap_env_off_inert
test_fly293_list_orphan_pins_readonly
test_fly293_reap_oneshot_no_grace
test_fly293_reap_oneshot_works_when_env_off
test_fly293_gc_orphan_pin_state
test_fly293_reap_corrupt_state_row_no_crash
test_fly293_reap_nonnumeric_grace_no_crash
test_fly293_reap_unwritable_state_no_crash
test_fly293_reap_overflow_length_caps

echo ""
echo "═══ FLY-685: close_runner close-request marker → immediate pin removal ═══"
test_fly685_close_request_closes_orphan_pin
test_fly685_close_request_skips_live_runner_no_requeue
test_fly685_close_request_requeues_on_json_unavailable
test_fly685_close_request_survives_set_e
test_fly685_close_request_final_gate_rc2_requeue_rc1_drop
test_fly685_chokepoint_rc2_on_uncertainty
test_fly685_close_request_input_hardening
test_fly685_gc_close_request_drops_stale
test_fly685_chokepoint_rc2_on_close_mutation_failure
test_fly685_close_request_requeues_on_close_mutation_failure

# ════════════════════════════════════════════════════════════════
# FLY-825: create-vs-create (drain_events + sync_additive same-tick
# race) + the orphan-watcher wait_for_watcher_exit helper.
# ════════════════════════════════════════════════════════════════

test_fly825_create_dedup_same_window_id() {
  echo "Test: create_workspace_for_window dedups a repeat call for the SAME (name, window_id) within TTL"
  reset_mocks
  MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  MOCK_TMUX_WINDOWS=$'flywheel|@1210|lead-a'
  MOCK_PANE_DEAD=$'flywheel:@1210=0'   # FLY-867: creates require a live source pane
  create_workspace_for_window "flywheel" "@1210" "lead-a" >/dev/null 2>&1 || true
  create_workspace_for_window "flywheel" "@1210" "lead-a" >/dev/null 2>&1 || true
  local n; n=$(echo "$MOCK_CMUX_OPS" | grep -c "new-workspace")
  if [[ "$n" -eq 1 ]]; then
    pass "same (name,id) called twice (drain_events + sync_additive sim) → only 1 new-workspace"
  else
    fail "expected 1 new-workspace call, got $n. ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly825_no_dedup_different_window_id() {
  echo "Test: a genuine restart (same name, FRESH window_id) is NOT suppressed"
  reset_mocks
  MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  # FLY-867: live source panes; ready gate is by-id so the same-name pair is fine.
  MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a\nflywheel|@2|lead-a'
  MOCK_PANE_DEAD=$'flywheel:@1=0\nflywheel:@2=0'
  create_workspace_for_window "flywheel" "@1" "lead-a" >/dev/null 2>&1 || true
  # A restarted source is reconciled onto a fresh independent view before
  # the create retry reaches this helper.
  topo_remove_session "cmux-lead-a"
  create_workspace_for_window "flywheel" "@2" "lead-a" >/dev/null 2>&1 || true
  local n; n=$(echo "$MOCK_CMUX_OPS" | grep -c "new-workspace")
  if [[ "$n" -eq 2 ]]; then
    pass "different window_id (real restart) → both creates proceed, not suppressed"
  else
    fail "expected 2 new-workspace calls (different ids must not be deduped), got $n. ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly825_ready_gate_failure_no_mark() {
  echo "Test: a deferred create (independent view build fails) does NOT burn the TTL"
  reset_mocks
  MOCK_TMUX_SESSIONS='flywheel'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-b'
  MOCK_PANE_DEAD=$'flywheel:@1=0'   # FLY-867: creates require a live source pane
  MOCK_TOPO_LINK_FAIL=1
  create_workspace_for_window "flywheel" "@1" "lead-b" >/dev/null 2>&1 || true
  if [[ -f "$CREATE_STATE" ]] && grep -q "^lead-b|@1|" "$CREATE_STATE"; then
    fail "deferred (not-ready) create wrongly wrote CREATE_STATE — would suppress the legitimate retry"
  else
    pass "deferred create does not write CREATE_STATE (next tick's retry is not suppressed)"
  fi
  # Retry with select-window now succeeding must proceed (not falsely deduped).
  MOCK_TOPO_LINK_FAIL=0
  create_workspace_for_window "flywheel" "@1" "lead-b" >/dev/null 2>&1 || true
  if echo "$MOCK_CMUX_OPS" | grep -q "new-workspace"; then
    pass "retry after ready-gate recovers actually creates (not suppressed by the earlier deferred attempt)"
  else
    fail "retry after recovery should have created; ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly825_create_recently_attempted_unit() {
  echo "Test: create_recently_attempted / create_mark_attempted unit behavior"
  reset_mocks
  create_mark_attempted "lead-a" "@1"
  if create_recently_attempted "lead-a" "@1"; then
    pass "mark then query (same name+id) → hit"
  else
    fail "expected hit right after marking"
  fi
  if create_recently_attempted "lead-a" "@2"; then
    fail "different window_id must NOT hit (dedup key includes window_id)"
  else
    pass "different window_id → miss (not falsely deduped)"
  fi
  if create_recently_attempted "lead-b" "@1"; then
    fail "different window_name must NOT hit"
  else
    pass "different window_name → miss"
  fi

  # TTL expiry: write a timestamp older than the TTL directly (no real sleep).
  reset_mocks
  local old_ts; old_ts=$(( $(date +%s) - 999 ))
  printf 'lead-a|@1|%s\n' "$old_ts" > "$CREATE_STATE"
  if create_recently_attempted "lead-a" "@1"; then
    fail "expired TTL row must miss"
  else
    pass "expired TTL row → miss (does not block a legitimate later recreate)"
  fi

  # Corrupt timestamp must fail open (miss), not crash.
  reset_mocks
  printf 'lead-a|@1|NOTNUM\n' > "$CREATE_STATE"
  local rc=0
  ( set -euo pipefail; create_recently_attempted "lead-a" "@1" ) >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 1 ]]; then
    pass "corrupt (non-numeric) timestamp → miss, no crash under set -e"
  else
    fail "corrupt timestamp: expected rc=1 (miss), got rc=$rc"
  fi

  # Future timestamp must fail open too (Codex R2 optional hardening).
  reset_mocks
  local future_ts; future_ts=$(( $(date +%s) + 999999 ))
  printf 'lead-a|@1|%s\n' "$future_ts" > "$CREATE_STATE"
  if create_recently_attempted "lead-a" "@1"; then
    fail "future timestamp must miss (fail-open), not suppress creates until wall clock catches up"
  else
    pass "future timestamp → miss (fail-open)"
  fi
}

test_fly825_dedup_seconds_env_validation() {
  echo "Test: _create_dedup_seconds falls back to 30 on bad env, no crash under set -e"
  reset_mocks
  local v
  v=$(FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS="" _create_dedup_seconds)
  [[ "$v" == "30" ]] && pass "empty env → default 30" || fail "empty env: expected 30, got $v"
  v=$(FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS="abc" _create_dedup_seconds)
  [[ "$v" == "30" ]] && pass "non-numeric env → default 30" || fail "non-numeric env: expected 30, got $v"
  v=$(FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS="999999999999999999" _create_dedup_seconds)
  [[ "$v" == "30" ]] && pass "overlong digit-only env → default 30 (length-cap, no 64-bit overflow)" || fail "overlong env: expected 30, got $v"
  v=$(FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS="45" _create_dedup_seconds)
  [[ "$v" == "45" ]] && pass "valid numeric env is honored" || fail "valid env: expected 45, got $v"
  local rc=0
  ( set -euo pipefail; FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS="abc" create_recently_attempted "lead-a" "@1" ) >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 1 ]] && pass "bad TTL env inside create_recently_attempted → miss, no watcher crash" || fail "expected rc=1, got rc=$rc"
}

test_fly825_gc_create_state_file() {
  echo "Test: gc_create_state_file drops expired/corrupt/future rows, keeps valid ones"
  reset_mocks
  local now; now=$(date +%s)
  local fresh=$((now - 1))
  local expired=$((now - 999))
  local future=$((now + 999999))
  printf 'lead-a|@1|%s\nlead-b|@2|%s\nlead-c|@3|%s\nlead-d|@4|NOTNUM\n' "$fresh" "$expired" "$future" > "$CREATE_STATE"
  gc_create_state_file
  if grep -q "^lead-a|@1|" "$CREATE_STATE"; then pass "gc keeps fresh row"; else fail "fresh row dropped: [$(cat "$CREATE_STATE")]"; fi
  if grep -q "^lead-b|@2|" "$CREATE_STATE"; then fail "gc must drop expired row"; else pass "gc drops expired row"; fi
  if grep -q "^lead-c|@3|" "$CREATE_STATE"; then fail "gc must drop future (corrupt) row"; else pass "gc drops future/corrupt-clock row"; fi
  if grep -q "^lead-d|@4|" "$CREATE_STATE"; then fail "gc must drop non-numeric row"; else pass "gc drops non-numeric row"; fi
}

test_fly825_wait_for_watcher_exit_no_process() {
  echo "Test: wait_for_watcher_exit returns immediately when no process matches"
  reset_mocks
  MOCK_PGREP_PIDS=""
  wait_for_watcher_exit
  if [[ "$MOCK_SLEEPS" -eq 0 && -z "$MOCK_KILL_CALLS" ]]; then
    pass "no matching process → immediate return, no sleep, no kill"
  else
    fail "expected 0 sleeps and no kill calls; sleeps=$MOCK_SLEEPS kills=[$MOCK_KILL_CALLS]"
  fi
}

test_fly825_wait_for_watcher_exit_term_then_kill() {
  echo "Test: wait_for_watcher_exit waits ~5s (10x0.5s) then TERM, then KILL if still alive"
  reset_mocks
  MOCK_PGREP_PIDS="4242"
  MOCK_PROCESS_COMMANDS="4242|/bin/bash /tmp/flywheel-cmux-sync.sh --watch"
  MOCK_KILL_SURVIVES="4242"   # ignores TERM — proves the KILL escalation path
  MOCK_KILL_INTERCEPT="1"     # "4242" is a fake pgrep PID, not a real process — opt in to recording
  wait_for_watcher_exit
  local half_second_sleeps; half_second_sleeps=$(echo "$MOCK_SLEEP_ARGS" | tr ' ' '\n' | grep -cx "0.5")
  if [[ "$half_second_sleeps" -eq 10 ]]; then
    pass "waits exactly 10 x 0.5s (true 5s) before escalating — not the 2.5s arithmetic bug Codex R1 caught"
  else
    fail "expected 10 half-second sleeps, got $half_second_sleeps (args=[$MOCK_SLEEP_ARGS])"
  fi
  if echo "$MOCK_KILL_CALLS" | grep -qx "TERM 4242"; then pass "TERM sent to the surviving pid"; else fail "no TERM sent; calls=[$MOCK_KILL_CALLS]"; fi
  if echo "$MOCK_KILL_CALLS" | grep -qx "KILL 4242"; then pass "KILL sent after pid survived TERM"; else fail "no KILL escalation; calls=[$MOCK_KILL_CALLS]"; fi
}

test_fly825_wait_for_watcher_exit_multiple_pids_logged_individually() {
  echo "Test: wait_for_watcher_exit kills multiple PIDs individually (not a blanket pkill)"
  reset_mocks
  MOCK_PGREP_PIDS="111 222"
  MOCK_PROCESS_COMMANDS=$'111|/bin/bash /tmp/flywheel-cmux-sync.sh --watch\n222|/bin/bash /opt/flywheel-cmux-sync --watch'
  MOCK_KILL_SURVIVES=""   # both die cleanly on TERM
  MOCK_KILL_INTERCEPT="1" # fake pgrep PIDs, not real processes — opt in to recording
  wait_for_watcher_exit
  if echo "$MOCK_KILL_CALLS" | grep -qx "TERM 111" && echo "$MOCK_KILL_CALLS" | grep -qx "TERM 222"; then
    pass "both PIDs get their own TERM call, logged individually"
  else
    fail "expected per-PID TERM; calls=[$MOCK_KILL_CALLS]"
  fi
  if echo "$MOCK_KILL_CALLS" | grep -qx "KILL 111" || echo "$MOCK_KILL_CALLS" | grep -qx "KILL 222"; then
    fail "must not escalate to KILL for PIDs that already died on TERM"
  else
    pass "no unnecessary KILL for PIDs that died cleanly on TERM"
  fi
}

test_fly1482_wait_for_watcher_exit_rejects_prompt_decoy() {
  echo "Test: FLY-1482 wait_for_watcher_exit never signals a Runner whose prompt mentions the watcher"
  reset_mocks
  MOCK_PGREP_PIDS="111 222"
  MOCK_PROCESS_COMMANDS=$'111|/bin/bash /tmp/flywheel-cmux-sync.sh --watch\n222|/opt/claude --prompt restart flywheel-cmux-sync --watch after QA'
  MOCK_KILL_INTERCEPT="1"
  wait_for_watcher_exit
  if grep -qx "TERM 111" <<< "$MOCK_KILL_CALLS" \
      && ! grep -qE '^(TERM|KILL) 222$' <<< "$MOCK_KILL_CALLS"; then
    pass "argv-shape verification signals the real watcher and rejects the prompt-only Runner candidate"
  else
    fail "prompt-only Runner received a signal; calls=[$MOCK_KILL_CALLS]"
  fi
}

test_fly1482_wait_for_watcher_exit_skips_vanished_candidate() {
  echo "Test: FLY-1482 wait_for_watcher_exit treats a pgrep-to-ps exit as absence"
  reset_mocks
  MOCK_PGREP_PIDS="111 222"
  MOCK_PROCESS_COMMANDS="111|/bin/bash /tmp/flywheel-cmux-sync.sh --watch"
  MOCK_PROCESS_GONE_PIDS="222"
  MOCK_KILL_INTERCEPT="1"
  local rc=0
  wait_for_watcher_exit || rc=$?
  if [[ "$rc" -eq 0 ]] && grep -qx "TERM 111" <<< "$MOCK_KILL_CALLS" \
      && ! grep -qE '^(TERM|KILL) 222$' <<< "$MOCK_KILL_CALLS"; then
    pass "a vanished candidate is skipped while the verified watcher still shuts down"
  else
    fail "vanished candidate poisoned census rc=$rc calls=[$MOCK_KILL_CALLS]"
  fi
}

test_fly1482_wait_for_watcher_exit_requires_conclusive_absence() {
  echo "Test: FLY-1482 wait_for_watcher_exit never greenlights a KILL survivor"
  reset_mocks
  MOCK_PGREP_PIDS="4242"
  MOCK_PROCESS_COMMANDS="4242|/bin/bash /tmp/flywheel-cmux-sync.sh --watch"
  MOCK_KILL_SURVIVES="4242"
  MOCK_KILL_ALWAYS_SURVIVES="4242"
  MOCK_KILL_INTERCEPT="1"
  FLYWHEEL_CMUX_EXIT_CONFIRM_POLLS=2
  FLYWHEEL_CMUX_EXIT_CONFIRM_INTERVAL=0
  local rc=0
  wait_for_watcher_exit >/dev/null 2>&1 || rc=$?
  unset FLYWHEEL_CMUX_EXIT_CONFIRM_POLLS FLYWHEEL_CMUX_EXIT_CONFIRM_INTERVAL
  if [[ "$rc" -ne 0 && "$MOCK_PGREP_PIDS" == "4242" \
      && "$(grep -c '^KILL 4242$' <<< "$MOCK_KILL_CALLS" || true)" == "1" ]]; then
    pass "post-KILL survivor returns non-zero, so fleet restart must skip bootstrap"
  else
    fail "KILL survivor falsely passed rc=$rc pids=[$MOCK_PGREP_PIDS] calls=[$MOCK_KILL_CALLS]"
  fi
}

echo ""
echo "═══ FLY-825: create-vs-create + orphan-watcher wait helper ═══"
test_fly825_create_dedup_same_window_id
test_fly825_no_dedup_different_window_id
test_fly825_ready_gate_failure_no_mark
test_fly825_create_recently_attempted_unit
test_fly825_dedup_seconds_env_validation
test_fly825_gc_create_state_file
test_fly825_wait_for_watcher_exit_no_process
test_fly825_wait_for_watcher_exit_term_then_kill
test_fly825_wait_for_watcher_exit_multiple_pids_logged_individually
test_fly1482_wait_for_watcher_exit_rejects_prompt_decoy
test_fly1482_wait_for_watcher_exit_skips_vanished_candidate
test_fly1482_wait_for_watcher_exit_requires_conclusive_absence


# ════════════════════════════════════════════════════════════════
# FLY-867: dead-tab closure — Fix A (ready-gate by window_id),
# Fix B (create husk-immunity), Fix C (dead-husk window reaper)
# ════════════════════════════════════════════════════════════════

test_fly867_fixA_create_by_id_survives_dup_name() {
  echo "Test: FLY-867 Fix A — dup-name LIVE windows: create proceeds via by-id ready gate"
  reset_mocks
  MOCK_TMUX_WINDOWS=$'runner-flywheel|@100|FLY-9852-claude-qa\nrunner-flywheel|@200|FLY-9852-claude-qa'
  MOCK_PANE_DEAD=$'runner-flywheel:@100=0\nrunner-flywheel:@200=0'
  MOCK_TMUX_SESSIONS=$'runner-flywheel'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  create_workspace_for_window "runner-flywheel" "@200" "FLY-9852-claude-qa" >/dev/null 2>&1 || true
  if echo "$MOCK_CMUX_OPS" | grep -q "new-workspace"; then
    pass "create proceeds despite same-name sibling (by-id ready gate)"
  else
    fail "create deferred — name-ambiguous ready gate still in place. selects=[$(echo "$MOCK_TMUX_SELECTS" | tr '\n' ' ')]"
  fi
}

test_fly867_fixB_create_skips_dead_husk() {
  echo "Test: FLY-867 Fix B — dead-husk window never gets a workspace (oscillation broken)"
  reset_mocks
  MOCK_TMUX_WINDOWS=$'runner-flywheel|@749|FLY-9808-claude-husk'
  MOCK_PANE_DEAD=$'runner-flywheel:@749=1'
  MOCK_TMUX_SESSIONS=$'runner-flywheel'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  create_workspace_for_window "runner-flywheel" "@749" "FLY-9808-claude-husk" >/dev/null 2>&1 || true
  if echo "$MOCK_CMUX_OPS" | grep -q "new-workspace"; then
    fail "dead husk got a workspace — CREATE-CLEANUP oscillation NOT broken. ops=[$MOCK_CMUX_OPS]"
  else
    pass "dead husk: create silently skipped (no cmux new-workspace)"
  fi
  # Deferred husk skip must NOT burn the FLY-825 TTL (guard sits above the mark).
  if [[ -f "$CREATE_STATE" ]] && grep -q "FLY-9808-claude-husk" "$CREATE_STATE"; then
    fail "husk skip wrongly burned the create-dedup TTL"
  else
    pass "husk skip does not burn the create-dedup TTL"
  fi
}

test_fly867_fixB_mixed_creates_live_only() {
  echo "Test: FLY-867 Fix B — mixed dead+live same name → exactly one create (the live wid)"
  reset_mocks
  MOCK_TMUX_WINDOWS=$'runner-flywheel|@7|FLY-9834-claude-qa\nrunner-flywheel|@9|FLY-9834-claude-qa'
  MOCK_PANE_DEAD=$'runner-flywheel:@7=1\nrunner-flywheel:@9=0'
  MOCK_TMUX_SESSIONS=$'runner-flywheel'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  create_workspace_for_window "runner-flywheel" "@7" "FLY-9834-claude-qa" >/dev/null 2>&1 || true
  create_workspace_for_window "runner-flywheel" "@9" "FLY-9834-claude-qa" >/dev/null 2>&1 || true
  local n; n=$(echo "$MOCK_CMUX_OPS" | grep -c "new-workspace")
  if [[ "$n" -eq 1 ]]; then
    pass "mixed dead+live same name → exactly 1 new-workspace (live only)"
  else
    fail "expected exactly 1 create, got $n. ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1672_window_probe_identity_and_failure_contracts() {
  echo "Test: FLY-1672 — liveness proves window identity and preserves failure directions"
  local observed legacy_missing=0 topology_missing=0 live=0 dead=0 unreadable=0
  reset_mocks
  MOCK_TMUX_WINDOWS=$'runner-fly1672|@1|FLY-1672-live\nrunner-fly1672|@2|FLY-1672-dead'
  MOCK_PANE_DEAD=$'runner-fly1672:@1=0\nrunner-fly1672:@2=1'
  MOCK_TMUX_SESSIONS='runner-fly1672'
  observed=$(tmux display-message -p -t '=runner-fly1672:@404' '#{window_id}|#{pane_dead}')
  window_source_pane_alive runner-fly1672 @404 || legacy_missing=$?
  window_source_pane_alive runner-fly1672 @1 || live=$?
  window_source_pane_alive runner-fly1672 @2 || dead=$?
  MOCK_TMUX_DISPLAY_FAIL=1
  window_source_pane_alive runner-fly1672 @1 || unreadable=$?

  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  topo_add_session runner-fly1672 '$1672'
  topo_add_window runner-fly1672 @1 FLY-1672-live 1 0
  window_source_pane_alive runner-fly1672 @404 || topology_missing=$?
  if [[ "$observed" == '@1|0' && "$legacy_missing" -ne 0 && "$topology_missing" -ne 0 \
      && "$live" -eq 0 && "$dead" -ne 0 && "$unreadable" -ne 0 ]]; then
    pass "both fallback models reject the wrong @id; live/dead/unreadable contracts hold"
  else
    fail "identity contract observed=[$observed] legacy=$legacy_missing topology=$topology_missing live=$live dead=$dead unreadable=$unreadable"
  fi
}

test_fly1672_event_backlog_does_not_starve_additive_create() {
  echo "Test: FLY-1672 — stale backlog drains while live event and additive witness create"
  reset_mocks
  MOCK_TMUX_WINDOWS=$'runner-fly1672|@1|FLY-1672-live\nrunner-fly1672|@2|FLY-1672-additive-witness'
  MOCK_PANE_DEAD=$'runner-fly1672:@1=0\nrunner-fly1672:@2=0'
  MOCK_TMUX_SESSIONS='runner-fly1672'
  : > "$EVENT_FILE"
  local i=1 stale live witness witness_in_events processing
  while [[ "$i" -le 8 ]]; do
    printf 'create|runner-fly1672|@gone-%s|FLY-1672-stale-%s\n' "$i" "$i" >> "$EVENT_FILE"
    i=$((i + 1))
  done
  printf 'create|runner-fly1672|@1|FLY-1672-live\n' >> "$EVENT_FILE"
  witness_in_events=$(grep -cF FLY-1672-additive-witness "$EVENT_FILE" || true)
  drain_events >/dev/null 2>&1
  [[ -e "${EVENT_FILE}.processing" ]] && processing=1 || processing=0
  sync_additive >/dev/null 2>&1
  stale=$(grep -c 'new-workspace.*FLY-1672-stale-' <<< "$MOCK_CMUX_OPS" || true)
  live=$(grep -c 'new-workspace.*cmux-FLY-1672-live' <<< "$MOCK_CMUX_OPS" || true)
  witness=$(grep -c 'new-workspace.*cmux-FLY-1672-additive-witness' <<< "$MOCK_CMUX_OPS" || true)
  if [[ "$stale" -eq 0 && "$live" -eq 1 && "$witness" -eq 1 \
      && "$witness_in_events" -eq 0 && "$processing" -eq 0 ]]; then
    pass "stale rows create nothing; event and event-free additive controls each create once"
  else
    fail "mixed drain stale=$stale live=$live witness=$witness witness_events=$witness_in_events processing=$processing ops=[$MOCK_CMUX_OPS]"
  fi
}

# FLY-867 Fix C (husk-window auto-reaper) — dropped to follow-up per lead
# (CRASH_PRESERVE forensics boundary; sidebar-visible fix is covered by A+B).


echo ""
echo "═══ FLY-867: dead-tab closure — husk-immune create + by-id gate + husk reaper ═══"
test_fly867_fixA_create_by_id_survives_dup_name
test_fly867_fixB_create_skips_dead_husk
test_fly867_fixB_mixed_creates_live_only
test_fly1672_window_probe_identity_and_failure_contracts
test_fly1672_event_backlog_does_not_starve_additive_create

# ════════════════════════════════════════════════════════════════
# FLY-1272 P0/P1: linked-view topology model + staging WAL
# ════════════════════════════════════════════════════════════════

test_fly1272_p0_topology_mock() {
  echo "Test: FLY-1272 P0 — file-backed topology models link/group/active/unlink semantics"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0

  tmux new-session -d -s "fwstage-p0" -n "__flywheel_placeholder__"
  tmux set-option -t "=fwstage-p0" @flywheel_cmux_owner "runner-flywheel"
  tmux set-option -t "=fwstage-p0" @flywheel_cmux_placeholder "1"
  tmux link-window -s "=runner-flywheel:@42" -t "=fwstage-p0:"
  tmux select-window -t "=fwstage-p0:@42"

  local active grouped owner refs rc=0
  active=$(tmux display-message -p -t "=fwstage-p0" '#{window_id}')
  grouped=$(tmux display-message -p -t "=fwstage-p0" '#{session_grouped}')
  owner=$(tmux show-options -v -t "=fwstage-p0" @flywheel_cmux_owner)
  refs=$(awk -F'|' '$2 == "@42" { n++ } END { print n+0 }' "$TOPO_WINDOWS")
  if [[ "$active" == "@42" && "$grouped" == "0" && "$owner" == "runner-flywheel" && "$refs" == "2" ]]; then
    pass "independent stage links the exact shared @id and selects it without grouping"
  else
    fail "bad linked topology: active=$active grouped=$grouped owner=$owner refs=$refs"
  fi

  tmux unlink-window -t "=fwstage-p0:@42" || rc=$?
  if [[ "$rc" -eq 0 ]] && topo_window_row "runner-flywheel" "@42" >/dev/null; then
    pass "unlink removes only the view reference and preserves the source window"
  else
    fail "unlink damaged source or unexpectedly failed (rc=$rc)"
  fi

  rc=0
  tmux unlink-window -t "=runner-flywheel:@42" || rc=$?
  if [[ "$rc" -ne 0 ]] && topo_window_row "runner-flywheel" "@42" >/dev/null; then
    pass "last-reference unlink is atomically refused"
  else
    fail "last-reference unlink must fail without deleting @42 (rc=$rc)"
  fi

  tmux new-session -d -t "runner-flywheel" -s "cmux-legacy"
  grouped=$(tmux display-message -p -t "=cmux-legacy" '#{session_grouped}')
  if [[ "$grouped" == "1" ]]; then
    pass "legacy grouped session remains distinguishable from linked topology"
  else
    fail "grouped topology oracle returned grouped=$grouped"
  fi
}

test_fly1272_p1_staging_wal_happy_path() {
  echo "Test: FLY-1272 P1 — staging WAL claims an exact single-window canonical view"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-happy"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0

  local rc=0
  create_or_replace_view_session "runner-flywheel" "@42" "FLY-1272-implement" || rc=$?
  local canonical="cmux-FLY-1272-implement" active grouped owner members stages wal_count
  active=$(tmux display-message -p -t "=$canonical" '#{window_id}' 2>/dev/null || true)
  grouped=$(tmux display-message -p -t "=$canonical" '#{session_grouped}' 2>/dev/null || true)
  owner=$(tmux show-options -v -t "=$canonical" @flywheel_cmux_owner 2>/dev/null || true)
  members=$(tmux list-windows -t "=$canonical" -F '#{window_id}' 2>/dev/null | sort | tr '\n' ' ')
  stages=$(awk -F'|' '$1 ~ /^fwstage-/ { n++ } END { print n+0 }' "$TOPO_SESSIONS")
  wal_count=$(find "$VIEW_WAL_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$rc" -eq 0 && "$active" == "@42" && "$grouped" == "0" \
        && "$owner" == "runner-flywheel" && "$members" == "@42 " \
        && "$stages" == "0" && "$wal_count" == "0" \
        && "${VIEW_BUILD_OUTCOME:-}" == "staging_ready" ]]; then
    pass "WAL build ends at canonical=session-id-preserving, independent, exact-one-window ready state"
  else
    fail "staging result rc=$rc active=$active grouped=$grouped owner=$owner members=[$members] stages=$stages wal=$wal_count outcome=${VIEW_BUILD_OUTCOME:-<unset>}"
  fi

  local create_line link_line claim_line
  create_line=$(grep -n '^new-session .*fwstage-nonce-happy' "$TOPO_JOURNAL" | head -1 | cut -d: -f1)
  link_line=$(grep -n '^link-window ' "$TOPO_JOURNAL" | head -1 | cut -d: -f1)
  claim_line=$(grep -n '^rename-session .*cmux-FLY-1272-implement' "$TOPO_JOURNAL" | head -1 | cut -d: -f1)
  if [[ -n "$create_line" && -n "$link_line" && -n "$claim_line" \
        && "$create_line" -lt "$link_line" && "$link_line" -lt "$claim_line" ]]; then
    pass "topology journal records stage → exact link → atomic canonical claim order"
  else
    fail "missing or reordered staging mutations: $(tr '\n' ';' < "$TOPO_JOURNAL")"
  fi
}

test_fly1364_view_build_generation_flip_before_stage_is_read_only() {
  echo "Test: FLY-1364 xhigh — generation replacement before stage creation is read-only"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-pre-stage-flip"
  MOCK_TMUX_GENERATION_SEQ="tmux-generation-a,tmux-generation-b"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-implement" 1 0
  local rc=0 wal mutations
  create_or_replace_view_session "runner-flywheel" "@42" "FLY-1364-implement" || rc=$?
  wal=$(_view_wal_path "cmux-FLY-1364-implement")
  mutations=$(grep -E '^(new-session|set-option|link-window|kill-window|select-window|rename-session) ' "$TOPO_JOURNAL" || true)
  if [[ "$rc" -ne 0 && -f "$wal" && -z "$mutations" ]] \
      && grep -Fq 'v1|tmux-generation-a|create_intent|' "$wal" \
      && ! topo_session_exists "fwstage-nonce-pre-stage-flip"; then
    pass "generation is re-pinned with exact source identity before the first tmux mutation"
  else
    fail "pre-stage generation flip mutated topology rc=$rc mutations=[$mutations] wal=[$(cat "$wal" 2>/dev/null)]"
  fi
}

test_fly1364_view_build_generation_flip_after_stage_mutation_stops() {
  echo "Test: FLY-1364 xhigh — generation replacement mid-build cannot link or claim"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-mid-build-flip"
  MOCK_TMUX_GENERATION_FLIP_AFTER_SET_OPTION="tmux-generation-b"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-implement" 1 0
  local rc=0 wal forbidden
  create_or_replace_view_session "runner-flywheel" "@42" "FLY-1364-implement" || rc=$?
  wal=$(_view_wal_path "cmux-FLY-1364-implement")
  forbidden=$(grep -E '^(link-window|kill-window|select-window|rename-session) ' "$TOPO_JOURNAL" || true)
  if [[ "$rc" -ne 0 && -f "$wal" && -z "$forbidden" ]] \
      && topo_session_exists "fwstage-nonce-mid-build-flip" \
      && ! topo_session_exists "cmux-FLY-1364-implement"; then
    pass "the next mutation boundary detects replacement and preserves recovery WAL"
  else
    fail "mid-build generation flip escaped guard rc=$rc forbidden=[$forbidden] wal=[$(cat "$wal" 2>/dev/null)]"
  fi
}

test_fly1272_p1_link_failure_recovers_owned_stage() {
  echo "Test: FLY-1272 P1 — link failure leaves WAL, recovery removes only the owned stage"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-link-fail"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  MOCK_TOPO_LINK_FAIL="1"
  local rc=0 wal
  create_or_replace_view_session "runner-flywheel" "@42" "FLY-1272-implement" || rc=$?
  wal=$(_view_wal_path "cmux-FLY-1272-implement")
  if [[ "$rc" -ne 0 && -f "$wal" ]] && topo_session_exists "fwstage-nonce-link-fail" \
      && topo_window_row "runner-flywheel" "@42" >/dev/null; then
    pass "failed mutation is durable and source @42 remains intact"
  else
    fail "link failure lost WAL/stage or damaged source (rc=$rc wal=$([[ -f "$wal" ]] && echo yes || echo no))"
  fi

  MOCK_TOPO_LINK_FAIL="0"
  rc=0
  recover_view_construction "cmux-FLY-1272-implement" || rc=$?
  if [[ "$rc" -eq 0 && ! -f "$wal" ]] \
      && ! topo_session_exists "fwstage-nonce-link-fail" \
      && topo_window_row "runner-flywheel" "@42" >/dev/null; then
    pass "recovery clears the proven-owned placeholder stage without touching source"
  else
    fail "recovery did not safely retire link_intent (rc=$rc)"
  fi
}

test_fly1272_p1_rename_output_lost_recovers_claim() {
  echo "Test: FLY-1272 P1 — rename executed/output lost is recognized by session_id"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-output-lost"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  MOCK_TOPO_RENAME_OUTPUT_LOST="1"
  local rc=0 wal
  create_or_replace_view_session "runner-flywheel" "@42" "FLY-1272-implement" || rc=$?
  wal=$(_view_wal_path "cmux-FLY-1272-implement")
  if [[ "$rc" -ne 0 && -f "$wal" ]] \
      && topo_session_exists "cmux-FLY-1272-implement" \
      && ! topo_session_exists "fwstage-nonce-output-lost"; then
    pass "output-loss crash shape retains claim_intent beside the renamed canonical"
  else
    fail "rename output-loss shape not modeled (rc=$rc)"
  fi

  MOCK_TOPO_RENAME_OUTPUT_LOST="0"
  rc=0
  recover_view_construction "cmux-FLY-1272-implement" || rc=$?
  if [[ "$rc" -eq 0 && ! -f "$wal" ]] \
      && _linked_view_matches "cmux-FLY-1272-implement" "@42" "runner-flywheel"; then
    pass "recovery accepts only the canonical with the WAL-recorded session_id and clears WAL"
  else
    fail "session-id claim recovery failed (rc=$rc)"
  fi
}

test_fly1272_p1_generation_mismatch_is_read_only() {
  echo "Test: FLY-1272 P1 — stale-generation WAL is retired with zero topology mutation"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  topo_add_session "fwstage-old-generation" '$2' "" "FLY-1272-implement" "1"
  topo_add_window "fwstage-old-generation" "@1000" "__flywheel_placeholder__" 1 0
  local wal
  wal=$(_view_wal_path "cmux-FLY-1272-implement")
  _write_view_wal "$wal" "old-generation" created "old-generation" \
    "cmux-FLY-1272-implement" "runner-flywheel" "@42" '$2' "@1000"
  : > "$TOPO_JOURNAL"
  local rc=0
  recover_view_construction "cmux-FLY-1272-implement" || rc=$?
  if [[ "$rc" -eq 0 && ! -f "$wal" ]] && topo_session_exists "fwstage-old-generation" \
      && ! grep -Eq '^(kill|unlink|rename|link|new)-' "$TOPO_JOURNAL"; then
    pass "generation mismatch retires only the impossible old-server WAL"
  else
    fail "stale-generation WAL was not safely retired (rc=$rc wal=$([[ -f "$wal" ]] && echo yes || echo no) journal=$(tr '\n' ';' < "$TOPO_JOURNAL"))"
  fi
}

test_fly1272_skip_rc_never_kills_watcher() {
  echo "Test: FLY-1272 review HIGH — transient durable-state skip never kills watcher under errexit"
  reset_mocks
  local bootstrap_marker="$TMPDIR_ROOT/fly1272-bootstrap-survived"
  local periodic_marker="$TMPDIR_ROOT/fly1272-periodic-survived"
  local reaper_marker="$TMPDIR_ROOT/fly1272-reaper-survived"
  local unsafe_after_skip="$TMPDIR_ROOT/fly1272-unsafe-after-skip"
  local bootstrap_rc=0 periodic_rc=0 reaper_rc=0

  (
    set -euo pipefail
    get_tmux_agent_windows() { printf '%s\n' 'runner-flywheel|@42|FLY-1272-implement'; }
    reconcile_existing_workspaces() { return 0; }
    prepare_linked_view_state() { return 1; }
    create_workspace_for_window() { : > "$unsafe_after_skip"; }
    self_heal_sweep_all() { : > "$unsafe_after_skip"; }
    sync_additive_bootstrap
    : > "$bootstrap_marker"
  )
  bootstrap_rc=$?

  (
    set -euo pipefail
    register_hooks_on_new_sessions() { return 0; }
    get_tmux_agent_windows() { printf '%s\n' 'runner-flywheel|@42|FLY-1272-implement'; }
    reconcile_existing_workspaces() { return 0; }
    prepare_linked_view_state() { return 1; }
    create_workspace_for_window() { : > "$unsafe_after_skip"; }
    cleanup_stale_conservative() { : > "$unsafe_after_skip"; }
    sync_additive
    : > "$periodic_marker"
  )
  periodic_rc=$?

  (
    set -euo pipefail
    reconcile_prepared_ledger() { return 1; }
    reap_ghost_workspaces
    : > "$reaper_marker"
  )
  reaper_rc=$?

  if [[ "$bootstrap_rc" -eq 0 && "$periodic_rc" -eq 0 && "$reaper_rc" -eq 0 \
      && -f "$bootstrap_marker" && -f "$periodic_marker" && -f "$reaper_marker" \
      && ! -e "$unsafe_after_skip" ]]; then
    pass "bootstrap, periodic, and ghost reconciliation defer safely without post-skip mutation"
  else
    fail "skip rc escaped or later mutation ran boot=$bootstrap_rc periodic=$periodic_rc reaper=$reaper_rc unsafe=$([[ -e "$unsafe_after_skip" ]] && echo yes || echo no)"
  fi
}

test_fly1272_p1_source_gone_collision_escrows_stage() {
  echo "Test: FLY-1272 P1 — source-gone claim collision escrows the proven stage"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1
  topo_add_session "fwstage-collision" '$2' "" "runner-flywheel" "0"
  topo_add_window "fwstage-collision" "@42" "FLY-1272-implement" 1 0
  topo_add_session "cmux-FLY-1272-implement" '$9' "" "founder-session" "0"
  topo_add_window "cmux-FLY-1272-implement" "@99" "founder-shell" 1 0
  local wal keeper rc=0
  wal=$(_view_wal_path "cmux-FLY-1272-implement")
  _write_view_wal "$wal" "tmux-test-generation" claim_intent collision \
    "cmux-FLY-1272-implement" "runner-flywheel" "@42" '$2' "@1000"
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }
  recover_view_construction "cmux-FLY-1272-implement" >/dev/null 2>&1 || rc=$?
  keeper=$(awk -F'|' '$6 == "committed" { print $3; exit }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  release_mutator_lease
  if [[ "$rc" -ne 0 && -f "$wal" && "$keeper" == fwkeeper-* ]] \
      && topo_session_exists "$keeper" && topo_session_exists "cmux-FLY-1272-implement" \
      && ! topo_session_exists "fwstage-collision"; then
    pass "foreign canonical is untouched; the sole-holder stage becomes an inventoried keeper"
  else
    fail "source-gone collision lost stage/canonical authority rc=$rc keeper=[$keeper] wal=$([[ -f "$wal" ]] && echo yes || echo no)"
  fi
}

test_fly1446_malformed_wals_quarantine_and_other_view_progresses() {
  echo "Test: FLY-1446 E2 — syntactic WAL corruption quarantines fail-loud without stalling another view"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  FLYWHEEL_CMUX_TEST_NONCE="fly1446-other"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@52" "FLY-1446-other" 1 0
  mkdir -p "$VIEW_WAL_DIR"

  printf 'bad\nsecond-line\n' > "$VIEW_WAL_DIR/multiline.wal"
  printf 'v1|g|create_intent|n|cmux-fields|runner-flywheel|@1|\n' > "$VIEW_WAL_DIR/fields.wal"
  local bad_prefix_path mismatch_path stale_path
  bad_prefix_path=$(_view_wal_path "not-a-cmux-view")
  printf 'v1|g|create_intent|n|not-a-cmux-view|runner-flywheel|@1||\n' > "$bad_prefix_path"
  mismatch_path="$VIEW_WAL_DIR/identity-mismatch.wal"
  printf 'v1|g|create_intent|n|cmux-identity-mismatch|runner-flywheel|@1||\n' > "$mismatch_path"
  stale_path=$(_view_wal_path "cmux-stale-valid")
  _write_view_wal "$stale_path" "old-generation" create_intent stale-valid \
    "cmux-stale-valid" "runner-flywheel" "@99" "" ""

  local alerts="$TMPDIR_ROOT/fly1446-wal-alerts" saved_alert rc=0 quarantine_count root_wals
  saved_alert=$(declare -f flywheel_alert)
  : > "$alerts"
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  recover_all_view_constructions || rc=$?
  recover_all_view_constructions || rc=$?
  eval "$saved_alert"

  test_ensure_mutator_lease
  create_workspace_for_window "runner-flywheel" "@52" "FLY-1446-other"
  quarantine_count=$(find "$VIEW_WAL_DIR/quarantine" -type f 2>/dev/null | wc -l | tr -d ' ')
  root_wals=$(find "$VIEW_WAL_DIR" -maxdepth 1 -name '*.wal' -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$rc" -eq 0 && "$quarantine_count" == "4" && "$root_wals" == "0" \
      && "$(grep -c 'wal-quarantined|' "$alerts" 2>/dev/null || true)" == "4" \
      && "$(grep -c 'new-workspace ' <<< "$MOCK_CMUX_OPS")" == "1" \
      && "$(grep -c 'FLY-1446-other' "$VIEW_LEDGER" 2>/dev/null || true)" == "1" ]]; then
    pass "four syntactic classes are quarantined/alerted once; a valid WAL and unrelated create progress in the same round"
  else
    fail "quarantine/progress mismatch rc=$rc quarantine=$quarantine_count root_wals=$root_wals alerts=[$(tr '\n' ';' < "$alerts")] ops=[$MOCK_CMUX_OPS]"
  fi

}

test_fly1446_collision_blocks_only_its_logical_view() {
  echo "Test: FLY-1446 E2 — known collision blocks one view while unrelated create progresses"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  FLYWHEEL_CMUX_TEST_NONCE="fly1446-unblocked"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1446-blocked" 1 0
  topo_add_window "runner-flywheel" "@43" "FLY-1446-unblocked" 0 0
  topo_add_session "fwstage-collision" '$2' "" "runner-flywheel" "0"
  topo_add_window "fwstage-collision" "@42" "FLY-1446-blocked" 1 0
  topo_add_session "cmux-FLY-1446-blocked" '$9' "" "founder-session" "0"
  topo_add_window "cmux-FLY-1446-blocked" "@99" "founder-shell" 1 0
  local wal rc=0
  wal=$(_view_wal_path "cmux-FLY-1446-blocked")
  _write_view_wal "$wal" "tmux-test-generation" claim_intent collision \
    "cmux-FLY-1446-blocked" "runner-flywheel" "@42" '$2' "@1000"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:42","title":null}]}'
  test_ledger_upsert prepared "cmux-generation-1" "workspace:42" "FLY-1446-blocked"

  recover_all_view_constructions || rc=$?
  reconcile_prepared_ledger || rc=$?
  repair_view_invariants || rc=$?
  repair_view_invariants || rc=$?
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1446-blocked"
  create_workspace_for_window "runner-flywheel" "@43" "FLY-1446-unblocked"

  if [[ "$rc" -eq 0 && -f "$wal" ]] \
      && cmux_wal_view_blocked "cmux-FLY-1446-blocked" \
      && ! grep -q 'rename-workspace --workspace workspace:42' <<< "$MOCK_CMUX_OPS" \
      && ! grep -q 'new-workspace .*cmux-FLY-1446-blocked' <<< "$MOCK_CMUX_OPS" \
      && grep -q 'new-workspace .*cmux-FLY-1446-unblocked' <<< "$MOCK_CMUX_OPS" \
      && grep -q 'FLY-1446-unblocked' "$VIEW_LEDGER"; then
    pass "collision WAL is preserved; ledger/repair/create mutations are blocked only for its logical view"
  else
    fail "collision block leaked rc=$rc blocked=[$CMUX_WAL_BLOCKED_VIEWS] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1446_wal_indeterminate_failures_still_abort() {
  echo "Test: FLY-1446 E2 — generation/read/rename/cleanup uncertainty remains fail-closed"
  local saved_generation saved_cat wal rc generation_ok=0 read_ok=0 rename_ok=0 cleanup_ok=0

  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1
  wal=$(_view_wal_path "cmux-generation-fail")
  _write_view_wal "$wal" "tmux-test-generation" create_intent generation-fail \
    "cmux-generation-fail" "runner-flywheel" "@42" "" ""
  saved_generation=$(declare -f tmux_server_generation)
  tmux_server_generation() { return 1; }
  rc=0; recover_all_view_constructions >/dev/null 2>&1 || rc=$?
  eval "$saved_generation"
  [[ "$rc" -ne 0 && -f "$wal" ]] && generation_ok=1

  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1
  wal=$(_view_wal_path "cmux-read-fail")
  _write_view_wal "$wal" "tmux-test-generation" create_intent read-fail \
    "cmux-read-fail" "runner-flywheel" "@42" "" ""
  FLY1446_UNREADABLE_WAL="$wal"
  cat() {
    [[ "${1:-}" == "$FLY1446_UNREADABLE_WAL" ]] && return 1
    command cat "$@"
  }
  rc=0; recover_all_view_constructions >/dev/null 2>&1 || rc=$?
  unset -f cat
  [[ "$rc" -ne 0 && -f "$wal" && ! -d "$VIEW_WAL_DIR/quarantine" ]] && read_ok=1

  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_TOPO_RENAME_FAIL=1
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1446-rename-fail" 1 0
  topo_add_session "fwstage-rename-fail" '$2' "" "runner-flywheel" "0"
  topo_add_window "fwstage-rename-fail" "@42" "FLY-1446-rename-fail" 1 0
  wal=$(_view_wal_path "cmux-FLY-1446-rename-fail")
  _write_view_wal "$wal" "tmux-test-generation" claim_intent rename-fail \
    "cmux-FLY-1446-rename-fail" "runner-flywheel" "@42" '$2' "@1000"
  rc=0; recover_all_view_constructions >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 && -f "$wal" ]] && topo_session_exists "fwstage-rename-fail" \
      && ! topo_session_exists "cmux-FLY-1446-rename-fail"; then
    rename_ok=1
  fi

  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_TOPO_UNLINK_FAIL=1
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1446-cleanup-fail" 1 0
  topo_add_session "fwstage-cleanup-fail" '$2' "" "runner-flywheel" "1"
  topo_add_window "fwstage-cleanup-fail" "@1000" "__flywheel_placeholder__" 1 0
  topo_add_window "fwstage-cleanup-fail" "@42" "FLY-1446-cleanup-fail" 0 0
  wal=$(_view_wal_path "cmux-FLY-1446-cleanup-fail")
  _write_view_wal "$wal" "tmux-test-generation" link_intent cleanup-fail \
    "cmux-FLY-1446-cleanup-fail" "runner-flywheel" "@42" '$2' "@1000"
  rc=0; recover_all_view_constructions >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 && -f "$wal" ]] && topo_session_exists "fwstage-cleanup-fail" \
      && topo_window_row "fwstage-cleanup-fail" "@42" >/dev/null; then
    cleanup_ok=1
  fi

  if [[ "$generation_ok$read_ok$rename_ok$cleanup_ok" == "1111" ]]; then
    pass "all non-syntactic uncertainty classes abort and preserve their evidence/topology"
  else
    fail "indeterminate contract drift generation=$generation_ok read=$read_ok rename=$rename_ok cleanup=$cleanup_ok"
  fi
}

test_fly1272_p3_create_uses_isolated_view_by_default() {
  echo "Test: FLY-1272 P3 — create path uses exact isolated view when A is enabled"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"
  FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-create-path"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  MOCK_CMUX_MUTATE_JSON="1"
  MOCK_SOCK_IDENT="cmux-generation-1"
  test_ensure_mutator_lease
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1272-implement"
  local grouped active members ledger_row
  grouped=$(tmux display-message -p -t "=cmux-FLY-1272-implement" '#{session_grouped}' 2>/dev/null || true)
  active=$(tmux display-message -p -t "=cmux-FLY-1272-implement" '#{window_id}' 2>/dev/null || true)
  members=$(tmux list-windows -t "=cmux-FLY-1272-implement" -F '#{window_id}' 2>/dev/null | tr '\n' ' ')
  ledger_row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$grouped" == "0" && "$active" == "@42" && "$members" == "@42 " ]] \
      && grep -q "new-workspace --command .*cmux-FLY-1272-implement" <<< "$MOCK_CMUX_OPS" \
      && [[ "$ledger_row" == "committed|cmux-generation-1|workspace:100|FLY-1272-implement|00000000-0000-4000-8000-000000000100" ]]; then
    pass "workspace attach target is isolated and its exact renamed ref is ledger-committed"
  else
    fail "create topology/ledger mismatch (grouped=$grouped active=$active members=[$members] ledger=[$ledger_row] ops=[$MOCK_CMUX_OPS])"
  fi
}

test_fly1272_p2_dismantle_linked_preserves_source() {
  echo "Test: FLY-1272 P2 — linked dismantle closes only ledger ref and unlinks only view reference"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  topo_add_session "cmux-FLY-1272-implement" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1272-implement" "@42" "FLY-1272-implement" 1 0
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"FLY-1272-implement"}]}'
  test_ledger_upsert committed "cmux-generation-1" "workspace:100" "FLY-1272-implement"
  local rc=0
  dismantle_view_display "FLY-1272-implement" "invariant-mismatch" || rc=$?
  if [[ "$rc" -eq 0 ]] && topo_window_row "runner-flywheel" "@42" >/dev/null \
      && ! topo_session_exists "cmux-FLY-1272-implement" \
      && grep -q 'close-workspace --workspace workspace:100' <<< "$MOCK_CMUX_OPS" \
      && ! grep -q '^kill-window\|^kill-session' "$TOPO_JOURNAL"; then
    pass "linked teardown preserves source @42 and never uses destructive tmux kill"
  else
    fail "linked teardown unsafe/incomplete rc=$rc journal=$(tr '\n' ';' < "$TOPO_JOURNAL")"
  fi
}

test_fly1272_p2_sole_holder_escrows_instead_of_destroying() {
  echo "Test: FLY-1272 P2 — last-reference unlink refusal escrows the live window"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  topo_add_session "cmux-FLY-1272-implement" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1272-implement" "@42" "FLY-1272-implement" 1 0
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"FLY-1272-implement"}]}'
  test_ledger_upsert committed "cmux-generation-1" "workspace:100" "FLY-1272-implement"
  local rc=0 keeper
  dismantle_view_display "FLY-1272-implement" "source-gone" || rc=$?
  keeper=$(awk -F'|' '$6 == "committed" { print $3; exit }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  if [[ "$rc" -eq 0 && "$keeper" == fwkeeper-* ]] \
      && topo_session_exists "$keeper" && topo_window_row "$keeper" "@42" >/dev/null \
      && ! grep -q '^kill-window\|^kill-session' "$TOPO_JOURNAL"; then
    pass "sole-holder @42 survives under an inventory-committed keeper"
  else
    fail "sole-holder was not safely escrowed rc=$rc keeper=[$keeper] journal=$(tr '\n' ';' < "$TOPO_JOURNAL")"
  fi
}

test_fly1272_p2_grouped_view_always_escrows() {
  echo "Test: FLY-1272 P2 — legacy grouped view is renamed to keeper, never unlinked"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  tmux new-session -d -t "runner-flywheel" -s "cmux-FLY-1272-implement"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"FLY-1272-implement"}]}'
  test_ledger_upsert committed "cmux-generation-1" "workspace:100" "FLY-1272-implement"
  local rc=0 keeper
  dismantle_view_display "FLY-1272-implement" "legacy-grouped" || rc=$?
  keeper=$(awk -F'|' '$6 == "committed" { print $3; exit }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  if [[ "$rc" -eq 0 && "$keeper" == fwkeeper-* ]] \
      && topo_session_exists "$keeper" && topo_window_row "runner-flywheel" "@42" >/dev/null \
      && ! grep -q '^unlink-window\|^kill-window\|^kill-session' "$TOPO_JOURNAL"; then
    pass "grouped display shell moved to keeper with shared source untouched"
  else
    fail "grouped teardown used unsafe mutation rc=$rc keeper=[$keeper] journal=$(tr '\n' ';' < "$TOPO_JOURNAL")"
  fi
}

test_fly1272_p2_foreign_same_title_is_untouched() {
  echo "Test: FLY-1272 P2 — B-foreign: A closes, B stays visible/unmodified, no substitute ref, keyed warning"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  topo_add_session "cmux-FLY-1272-implement" '$9' "" "founder-owned" "0"
  topo_add_window "cmux-FLY-1272-implement" "@99" "founder-shell" 1 0
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:900","title":"FLY-1272-implement"}]}'
  : > "$TOPO_JOURNAL"
  local rc=0
  dismantle_view_display "FLY-1272-implement" "collision" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]] && topo_session_exists "cmux-FLY-1272-implement" \
      && ! grep -Eq '^(close-workspace|unlink-window|rename-session|kill-window|kill-session)' "$TOPO_JOURNAL" \
      && ! grep -q 'close-workspace' <<< "$MOCK_CMUX_OPS"; then
    pass "A has no authority; B stays visible/unmodified, no substitute authority is invented, warning is emitted"
  else
    fail "foreign same-title object was mutated rc=$rc journal=$(tr '\n' ';' < "$TOPO_JOURNAL") ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1272_p4_grouped_husk_cannot_back_wrong_tab() {
  echo "Test: FLY-1272 P4 — grouped view pointing at husk is escrowed and rebuilt exact"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-invariant"; MOCK_CMUX_MUTATE_JSON=1; MOCK_SOCK_IDENT="cmux-generation-1"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 0 0
  topo_add_window "runner-flywheel" "@99" "FLY-1225-qa" 1 1
  tmux new-session -d -t "runner-flywheel" -s "cmux-FLY-1272-implement"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"FLY-1272-implement"}]}'
  test_ledger_upsert committed "cmux-generation-1" "workspace:100" "FLY-1272-implement"
  : > "$TOPO_JOURNAL"; MOCK_CMUX_OPS=""
  local rc=0 active members grouped keeper first_mutations
  refresh_linked_sessions || rc=$?
  first_mutations=$(grep -Ec '^(unlink-window|rename-session|kill-window|kill-session|link-window|new-session)' "$TOPO_JOURNAL" || true)
  refresh_linked_sessions || rc=$?
  active=$(tmux display-message -p -t "=cmux-FLY-1272-implement" '#{window_id}' 2>/dev/null || true)
  members=$(tmux list-windows -t "=cmux-FLY-1272-implement" -F '#{window_id}' 2>/dev/null | tr '\n' ' ')
  grouped=$(tmux display-message -p -t "=cmux-FLY-1272-implement" '#{session_grouped}' 2>/dev/null || true)
  keeper=$(awk -F'|' '$6 == "committed" { print $3; exit }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  if [[ "$rc" -eq 0 && "$first_mutations" == "0" && "$active" == "@42" && "$members" == "@42 " && "$grouped" == "0" \
      && "$keeper" == fwkeeper-* ]] && topo_window_row "runner-flywheel" "@99" >/dev/null; then
    pass "FLY-1272 tab topology is physically unable to fall back to FLY-1225 husk"
  else
    fail "invariant repair did not isolate target rc=$rc first_mutations=$first_mutations active=$active grouped=$grouped members=[$members] keeper=[$keeper]"
  fi
}

test_fly1272_p4_uncertain_source_snapshot_mutates_nothing() {
  echo "Test: FLY-1272 P4 — uncertain source inventory causes zero mutation"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"; MOCK_TMUX_LIST_FAIL="1"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  topo_add_session "cmux-FLY-1272-implement" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1272-implement" "@99" "FLY-1225-qa" 1 0
  : > "$TOPO_JOURNAL"
  local rc=0
  refresh_linked_sessions >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]] && ! grep -Eq '^(unlink-window|rename-session|kill-window|kill-session|link-window|new-session)' "$TOPO_JOURNAL"; then
    pass "inconclusive pass is fail-closed before the first topology mutation"
  else
    fail "uncertain pass mutated or falsely succeeded rc=$rc journal=$(tr '\n' ';' < "$TOPO_JOURNAL")"
  fi
}

test_fly1272_p3_prepared_ledger_recovers_exact_unnamed_ref() {
  echo "Test: FLY-1272 P3 — prepared ledger recovers only its exact unnamed ref"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1; MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":null},{"ref":"workspace:900","title":null}]}'
  local provisional
  provisional=$(build_attach_command 'cmux-FLY-1272-implement')
  MOCK_CMUX_SURFACES="workspace:100;;surface:100;;terminal;;true;;$provisional"
  test_ledger_upsert prepared "cmux-generation-1" "workspace:100" "FLY-1272-implement"
  local rc=0 row foreign_title
  reconcile_prepared_ledger || rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  foreign_title=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(w for w in d["workspaces"] if w["ref"]=="workspace:900")["title"])')
  if [[ "$rc" -eq 0 && "$row" == "committed|cmux-generation-1|workspace:100|FLY-1272-implement" \
      && "$foreign_title" == "None" ]] \
      && grep -q 'rename-workspace --workspace workspace:100 FLY-1272-implement' <<< "$MOCK_CMUX_OPS" \
      && ! grep -q 'workspace:900' <<< "$MOCK_CMUX_OPS"; then
    pass "prepared recovery promotes exact ref; unledgered unnamed workspace remains foreign"
  else
    fail "prepared recovery mismatch rc=$rc row=[$row] foreign=$foreign_title ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_prepared_recovery_repins_generation_at_rename() {
  echo "Test: FLY-1364 xhigh P1 — prepared recovery cannot rename a ref reused by a new cmux generation"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="generation-prepared-a"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":null}]}'
  test_ledger_upsert prepared "generation-prepared-a" "workspace:100" "FLY-1364-implement"
  # Plain cmux_call and cmux_call_guarded have different pre-mutation mktemp
  # boundaries. Flip at whichever boundary the implementation uses: the old
  # unguarded path renames in generation B, while the guarded path must observe
  # B before invoking cmux and preserve the generation-A prepared authority.
  MOCK_CMUX_CALL_MKTEMP_HOOK='printf %s generation-prepared-b > "$TMPDIR_ROOT/mock-ident.override"'
  MOCK_MKTEMP_HOOK='printf %s generation-prepared-b > "$TMPDIR_ROOT/mock-ident.override"'
  local rc=0
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == 'prepared|generation-prepared-a|workspace:100|FLY-1364-implement' \
      && "$(grep -c '^rename-workspace ' <<< "$MOCK_CMUX_OPS" || true)" == "0" ]]; then
    pass "prepared recovery blocks the rename when cmux generation changes at the mutation boundary"
  else
    fail "prepared recovery crossed generation rc=$rc ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_prepared_recovery_accepts_exact_provisional_attach_title() {
  echo "Test: FLY-1364 live regression — prepared recovery recognizes only its exact provisional attach title"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_SOCK_IDENT="generation-prepared-command"
  local provisional
  provisional=$(build_attach_command 'cmux-FLY-1364-implement')
  MOCK_CMUX_WORKSPACES_JSON=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"ref":"workspace:100","title":sys.argv[1]}]}))
' "$provisional")
  MOCK_CMUX_SURFACES="workspace:100;;surface:100;;terminal;;true;;$provisional"
  test_ledger_upsert prepared "generation-prepared-command" "workspace:100" "FLY-1364-implement"
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  if [[ "$(cat "$VIEW_LEDGER" 2>/dev/null)" == 'committed|generation-prepared-command|workspace:100|FLY-1364-implement' \
      && "$(grep -c '^rename-workspace --workspace workspace:100 FLY-1364-implement$' <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "prepared recovery promotes the byte-exact launch command and nothing broader"
  else
    fail "prepared provisional recovery drifted ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_prepared_default_title_recovers_with_uuid_receipt() {
  echo "Test: FLY-1884 B1 — UUID-bound prepared Terminal title recovers and commits"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_SOCK_IDENT="generation-fly1884"
  local uuid="11111111-1111-4111-8111-111111111111" title="FLY-1884-implement"
  MOCK_CMUX_WORKSPACES_JSON=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"id":sys.argv[1],"ref":"workspace:100","title":"Terminal 7"}]}))
' "$uuid")
  MOCK_CMUX_SURFACES="workspace:100;;surface:100;;terminal;;true;;Terminal 7"
  printf 'prepared|generation-fly1884|workspace:100|%s|%s\n' "$title" "$uuid" > "$VIEW_LEDGER"
  test_ensure_mutator_lease

  local rc=0 row workspace_title surface_title
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  workspace_title=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
print(json.load(sys.stdin)["workspaces"][0]["title"])
')
  surface_title=$(printf '%s\n' "$MOCK_CMUX_SURFACES" | awk -F';;' '$1=="workspace:100" { print $5 }')
  if [[ "$rc" -eq 0 \
      && "$row" == "committed|generation-fly1884|workspace:100|$title|$uuid" \
      && "$workspace_title" == "$title" && "$surface_title" == "$title" \
      && "$(grep -c '^rename-workspace --workspace workspace:100 FLY-1884-implement$' <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && "$(grep -c '^rename-tab --workspace workspace:100 FLY-1884-implement$' <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "UUID receipt re-drives both founder-visible titles and preserves UUID through commit"
  else
    fail "UUID default recovery mismatch rc=$rc row=[$row] workspace=[$workspace_title] surface=[$surface_title] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_legacy_default_title_never_gains_rename_authority() {
  echo "Test: FLY-1884 B1 — legacy four-field Terminal title remains read-only"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"id":"11111111-1111-4111-8111-111111111111","ref":"workspace:100","title":"Terminal 7"}]}'
  printf '%s\n' 'prepared|generation-fly1884|workspace:100|FLY-1884-implement' > "$VIEW_LEDGER"

  reconcile_prepared_ledger >/dev/null 2>&1 || true
  if [[ "$(cat "$VIEW_LEDGER")" == 'prepared|generation-fly1884|workspace:100|FLY-1884-implement' \
      && ! "$MOCK_CMUX_OPS" == *"rename-workspace"* \
      && ! "$MOCK_CMUX_OPS" == *"rename-tab"* ]]; then
    pass "legacy prepared authority cannot rename a default-title workspace"
  else
    fail "legacy default row mutated ledger=[$(cat "$VIEW_LEDGER")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_uuid_mismatch_and_ref_reuse_block_prepared_rename() {
  echo "Test: FLY-1884 B1 — UUID mismatch and ref reuse are zero-mutation"
  local expected="11111111-1111-4111-8111-111111111111"
  local replacement="22222222-2222-4222-8222-222222222222"
  local fixture label ok=1
  for label in same-ref-new-uuid same-uuid-other-ref canonical-new-uuid; do
    reset_mocks
    FLYWHEEL_CMUX_LINKED_VIEW=1
    MOCK_CMUX_MUTATE_JSON=1
    MOCK_SOCK_IDENT="generation-fly1884"
    case "$label" in
      same-ref-new-uuid)
        fixture=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"id":sys.argv[1],"ref":"workspace:100","title":"Terminal 7"}]}))
' "$replacement")
        ;;
      same-uuid-other-ref)
        fixture=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[
  {"id":sys.argv[1],"ref":"workspace:100","title":"Terminal 7"},
  {"id":sys.argv[2],"ref":"workspace:101","title":"Terminal 8"}
]}))
' "$replacement" "$expected")
        ;;
      canonical-new-uuid)
        fixture=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"id":sys.argv[1],"ref":"workspace:100","title":"FLY-1884-implement"}]}))
' "$replacement")
        MOCK_CMUX_SURFACES='workspace:100;;surface:100;;terminal;;true;;FLY-1884-implement'
        ;;
    esac
    MOCK_CMUX_WORKSPACES_JSON="$fixture"
    printf 'prepared|generation-fly1884|workspace:100|FLY-1884-implement|%s\n' "$expected" > "$VIEW_LEDGER"
    test_ensure_mutator_lease
    reconcile_prepared_ledger >/dev/null 2>&1 || true
    if [[ "$(cat "$VIEW_LEDGER")" != "prepared|generation-fly1884|workspace:100|FLY-1884-implement|$expected" \
        || "$MOCK_CMUX_OPS" == *"rename-workspace"* \
        || "$MOCK_CMUX_OPS" == *"rename-tab"* ]]; then
      fail "$label crossed UUID/ref authority ledger=[$(cat "$VIEW_LEDGER")] ops=[$MOCK_CMUX_OPS]"
      ok=0
    fi
  done
  [[ "$ok" == "1" ]] && pass "ref/UUID replacement cannot authorize rename or receipt promotion"
}

test_fly1884_authority_mismatch_releases_receipt_without_blocking_next_row() {
  echo "Test: FLY-1884 B3 — persistent UUID mismatch releases its slot and continues the batch"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_SOCK_IDENT="generation-fly1884"
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=1
  FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES=5
  CMUX_ADDITIVE_ROUND_ID="100-5"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"id":"22222222-2222-4222-8222-222222222222","ref":"workspace:100","title":"Terminal 7"},{"id":"33333333-3333-4333-8333-333333333333","ref":"workspace:101","title":"Terminal 8"}]}'
  MOCK_CMUX_SURFACES=$'workspace:100;;surface:100;;terminal;;true;;Terminal 7\nworkspace:101;;surface:101;;terminal;;true;;Terminal 8'
  printf '%s\n' \
    'prepared|generation-fly1884|workspace:100|FLY-1884-implement|11111111-1111-4111-8111-111111111111' \
    'prepared|generation-fly1884|workspace:101|FLY-1884-qa|33333333-3333-4333-8333-333333333333' > "$VIEW_LEDGER"
  printf '%s\n' 'authority|generation-fly1884|workspace:100|FLY-1884-implement|4|1|100-4' > "$PREPARED_STALL_STATE"
  local stub="$TMPDIR_ROOT/fly1884-authority-alert" args="$TMPDIR_ROOT/fly1884-authority-alert-args"
  printf '%s\n' '#!/bin/bash' 'printf "%s\\n" "$@" > "$FLYWHEEL_TEST_ALERT_ARGS"' > "$stub"
  chmod +x "$stub"
  FLYWHEEL_ALERT_BIN="$stub"
  FLYWHEEL_TEST_ALERT_ARGS="$args"
  export FLYWHEEL_ALERT_BIN FLYWHEEL_TEST_ALERT_ARGS
  test_ensure_mutator_lease

  reconcile_prepared_ledger >/dev/null 2>&1 || true
  if [[ "$(cat "$VIEW_LEDGER" 2>/dev/null || true)" == 'committed|generation-fly1884|workspace:101|FLY-1884-qa|33333333-3333-4333-8333-333333333333' \
      && "$MOCK_CMUX_OPS" != *'workspace:100'* \
      && "$MOCK_CMUX_OPS" == *'rename-workspace --workspace workspace:101 FLY-1884-qa'* \
      && "$(cat "$args" 2>/dev/null || true)" == *'prepared-authority-mismatch-released'* ]]; then
    pass "conclusive mismatch releases only its receipt and a later row still commits"
  else
    fail "authority mismatch batch handling drifted ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] ops=[$MOCK_CMUX_OPS] alert=[$(cat "$args" 2>/dev/null)]"
  fi
  unset FLYWHEEL_ALERT_BIN FLYWHEEL_TEST_ALERT_ARGS
}

test_fly1884_private_v2_no_pty_is_report_only() {
  echo "Test: FLY-1884 attach — private-v2 no-PTY surface is tagged and reported only"
  reset_mocks
  local title="growth-rafiki-lead" socket="$TMPDIR_ROOT/growth-rafiki.sock" canonical saved_derive saved_alert alerts=""
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_PRIVATE_TMUX_SOCKET="$socket"
  MOCK_PRIVATE_TMUX_CLIENTS=0
  MOCK_CMUX_READSCREEN='open terminal failed: not a terminal'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"id":"33333333-3333-4333-8333-333333333333","ref":"workspace:105","title":"growth-rafiki-lead"}]}'
  MOCK_CMUX_SURFACES='workspace:105;;surface:105;;terminal;;true;;shell'
  printf '%s\n' 'committed|generation-fly1884|workspace:105|growth-rafiki-lead|33333333-3333-4333-8333-333333333333' > "$VIEW_LEDGER"
  canonical=$(build_lead_attach_command "$socket")
  saved_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=ok
    LEAD_ROSTER_ROWS="claude-private|growth/rafiki-lead|growth-rafiki-lead|$socket"
  }
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { alerts+="${alerts:+$'\n'}$*"; }

  local first
  first=$(( $(date +%s) - 121 ))
  printf 'generation-fly1884|workspace:105|%s|v2|1|observing-no-pty|%s|%s|100-1\n' \
    "$title" "$first" "$first" > "$ATTACH_HEAL_STATE"
  CMUX_ADDITIVE_ROUND_ID=100-2
  _v2_lead_heal_surface "generation-fly1884" "workspace:105" "$title" "$socket" "$canonical" || true
  eval "$saved_derive"
  eval "$saved_alert"
  if [[ "$MOCK_CMUX_OPS" != *respawn-pane* && "$MOCK_CMUX_OPS" != *'send --workspace workspace:105'* \
      && "$MOCK_CMUX_OPS" != *new-workspace* && "$MOCK_CMUX_OPS" != *close-workspace* \
      && "$MOCK_CMUX_OPS" == *'连接失效 · no-pty · 仅上报'* \
      && "$alerts" == *'class=no-pty'* ]]; then
    pass "private-v2 no-PTY remains visible without replacement mutation"
  else
    fail "private-v2 no-PTY report-only contract drifted ops=[$MOCK_CMUX_OPS] alerts=[$alerts]"
  fi
}

test_fly1884_committed_uuid_mismatch_blocks_close() {
  echo "Test: FLY-1884 B1 — committed receipt cannot close a reused ref with a new UUID"
  reset_mocks
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"id":"22222222-2222-4222-8222-222222222222","ref":"workspace:100","title":"FLY-1884-implement"}]}'
  printf '%s\n' 'committed|generation-fly1884|workspace:100|FLY-1884-implement|11111111-1111-4111-8111-111111111111' > "$VIEW_LEDGER"
  test_ensure_mutator_lease

  close_ledger_workspace_ref "generation-fly1884" "workspace:100" \
    "FLY-1884-implement" "fly1884-uuid-mismatch" >/dev/null 2>&1 || true
  if [[ "$(cat "$VIEW_LEDGER")" == 'committed|generation-fly1884|workspace:100|FLY-1884-implement|11111111-1111-4111-8111-111111111111' \
      && ! "$MOCK_CMUX_OPS" == *"close-workspace"* ]]; then
    pass "destructive close re-reads immutable identity and preserves a replacement workspace"
  else
    fail "committed UUID mismatch crossed close authority ledger=[$(cat "$VIEW_LEDGER")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_uuid_is_rechecked_before_tab_rename() {
  echo "Test: FLY-1884 B1 — UUID replacement between workspace and tab rename blocks tab mutation"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_SOCK_IDENT="generation-fly1884"
  local expected="11111111-1111-4111-8111-111111111111"
  local title="FLY-1884-implement"
  MOCK_CMUX_WORKSPACES_JSON=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"id":sys.argv[1],"ref":"workspace:100","title":"Terminal 7"}]}))
' "$expected")
  MOCK_CMUX_SURFACES="workspace:100;;surface:100;;terminal;;true;;Terminal 7"
  printf 'prepared|generation-fly1884|workspace:100|%s|%s\n' "$title" "$expected" > "$VIEW_LEDGER"
  test_ensure_mutator_lease
  MOCK_MKTEMP_HOOK='n_file="$TMPDIR_ROOT/fly1884-guard.n"; n=0; [[ -f "$n_file" ]] && n=$(cat "$n_file"); n=$((n+1)); printf "%s" "$n" > "$n_file"; if [[ "$n" -eq 2 ]]; then printf "%s" "22222222-2222-4222-8222-222222222222" > "$TMPDIR_ROOT/fly1884-uuid.override"; fi'

  reconcile_prepared_ledger >/dev/null 2>&1 || true
  if [[ "$(cat "$VIEW_LEDGER")" == "prepared|generation-fly1884|workspace:100|$title|$expected" \
      && "$(grep -c '^rename-workspace --workspace workspace:100 FLY-1884-implement$' <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && "$(grep -c '^rename-tab ' <<< "$MOCK_CMUX_OPS" || true)" == "0" ]]; then
    pass "tab rename re-reads immutable identity and preserves prepared recovery on replacement"
  else
    fail "tab mutation was not UUID-fenced ledger=[$(cat "$VIEW_LEDGER")] json=[$MOCK_CMUX_WORKSPACES_JSON] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_unreceipted_default_rollback_requires_exact_uuid() {
  echo "Test: FLY-1884 B1 — unreceipted Terminal rollback requires exact UUID"
  local expected="11111111-1111-4111-8111-111111111111"
  local replacement="22222222-2222-4222-8222-222222222222"
  local rc=0 ok=1

  reset_mocks
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"id":sys.argv[1],"ref":"workspace:100","title":"Terminal 7"}]}))
' "$expected")
  rollback_unreceipted_workspace "generation-fly1884" "workspace:100" "provisional" "$expected" || rc=$?
  [[ "$rc" -eq 0 && "$MOCK_CMUX_OPS" == *"close-workspace --workspace workspace:100"* ]] || ok=0

  reset_mocks
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON=$(python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"id":sys.argv[1],"ref":"workspace:100","title":"Terminal 7"}]}))
' "$replacement")
  rc=0
  rollback_unreceipted_workspace "generation-fly1884" "workspace:100" "provisional" "$expected" || rc=$?
  [[ "$rc" -ne 0 && ! "$MOCK_CMUX_OPS" == *"close-workspace"* ]] || ok=0

  if [[ "$ok" == "1" ]]; then
    pass "rollback closes only the self-created UUID and preserves a reused ref"
  else
    fail "rollback UUID fence mismatch rc=$rc ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_managed_view_command_variants_are_upgrade_safe() {
  echo "Test: FLY-2102 — the retired view-helper flag cannot restore the legacy producer"
  reset_mocks
  local view="cmux-FLY-1884-qa" helper="$SCRIPT_DIR/flywheel-view-attach.sh"
  local wrapper="$TMPDIR_ROOT/fly1884-isolated-tmux" current retired_value current_qa retired_value_qa parsed ok=1
  printf '%s\n' '#!/bin/bash' 'exit 0' > "$wrapper"
  chmod +x "$wrapper"

  current=$(build_attach_command "$view" 2>/dev/null || true)
  FLYWHEEL_CMUX_VIEW_HELPER=0
  retired_value=$(build_attach_command "$view" 2>/dev/null || true)
  FLYWHEEL_CMUX_VIEW_HELPER=1
  FLYWHEEL_CMUX_ATTACH_TMUX_BIN="$wrapper"
  current_qa=$(build_attach_command "$view" 2>/dev/null || true)
  FLYWHEEL_CMUX_VIEW_HELPER=0
  retired_value_qa=$(build_attach_command "$view" 2>/dev/null || true)
  FLYWHEEL_CMUX_VIEW_HELPER=1

  [[ "$current" == "env -u TMUX '$helper' '$view'" ]] || ok=0
  [[ "$retired_value" == "$current" ]] || ok=0
  [[ "$current_qa" == "env -u TMUX FLYWHEEL_CMUX_ATTACH_TMUX_BIN='$wrapper' '$helper' '$view'" ]] || ok=0
  [[ "$retired_value_qa" == "$current_qa" ]] || ok=0
  for parsed in "$current" "$retired_value" "$current_qa" "$retired_value_qa"; do
    [[ "$(managed_view_command_parse "$parsed" 2>/dev/null || true)" == "$view" ]] || ok=0
  done
  [[ "$(managed_view_command_variants "$view" 2>/dev/null | grep -c . || true)" == "4" ]] || ok=0
  managed_view_command_parse "$current extra" >/dev/null 2>&1 && ok=0
  unset FLYWHEEL_CMUX_ATTACH_TMUX_BIN
  if [[ "$ok" == "1" ]]; then
    pass "FLYWHEEL_CMUX_VIEW_HELPER=0 still emits the reconnect-helper command"
  else
    fail "retired flag changed producer current=[$current] retired=[$retired_value] current_qa=[$current_qa] retired_qa=[$retired_value_qa]"
  fi
}

test_fly1944_inventory_carrier_classification_is_batched() {
  echo "Test: FLY-1944 round-5 — inventory carrier classification uses one Python process per snapshot"
  reset_mocks
  local real_python count_bin count_file wrapper view title canonical tokenized variants saved_get
  local candidates records calls ok=1
  real_python=$(command -v python3)
  count_bin="$TMPDIR_ROOT/fly1944-count-python-bin"
  count_file="$TMPDIR_ROOT/fly1944-python-count"
  wrapper="$count_bin/python3"
  mkdir -p "$count_bin"
  printf '%s\n' \
    '#!/bin/bash' \
    'printf x >> "$FLYWHEEL_TEST_PYTHON_COUNT"' \
    'exec "$FLYWHEEL_TEST_REAL_PYTHON" "$@"' > "$wrapper"
  chmod +x "$wrapper"
  FLYWHEEL_TEST_PYTHON_COUNT="$count_file"
  FLYWHEEL_TEST_REAL_PYTHON="$real_python"
  export FLYWHEEL_TEST_PYTHON_COUNT FLYWHEEL_TEST_REAL_PYTHON

  view="cmux-FLY-1944-implement"
  title="FLY-1944-implement"
  canonical=$(build_attach_command "$view")
  tokenized=$(build_attach_command "$view" 'fwtok1-00000000000000000000000000000000')
  variants=$(managed_view_command_variants "$view")
  MOCK_CMUX_WORKSPACES_JSON=$(
    "$real_python" -c 'import json,sys
title,canonical=sys.argv[1:]
rows=[{"ref":"workspace:1","title":title,"pinned":True}]
rows += [{"ref":f"workspace:{i}","title":canonical} for i in range(2, 38)]
rows.append({"ref":"workspace:99","title":"founder notes"})
print(json.dumps({"workspaces":rows}))' "$title" "$canonical"
  )
  # Earlier UUID-race fixtures intentionally leave this override behind; it
  # would add a Python call inside the cmux mock before this classifier runs.
  rm -f "$TMPDIR_ROOT/fly1884-uuid.override"

  : > "$count_file"
  candidates=$(PATH="$count_bin:$PATH" workspace_title_candidates \
    "$MOCK_CMUX_WORKSPACES_JSON" "$title" "$canonical") || ok=0
  calls=$(wc -c < "$count_file" | tr -d ' ')
  [[ "$calls" == 1 && "$(printf '%s\n' "$candidates" | grep -c . || true)" == 37 ]] || ok=0

  : > "$count_file"
  PATH="$count_bin:$PATH" _managed_view_command_in_variants "$tokenized" "$variants" || ok=0
  calls=$(wc -c < "$count_file" | tr -d ' ')
  [[ "$calls" == 1 ]] || ok=0

  : > "$count_file"
  # get_cmux_workspaces_json deliberately spends one separate Python process
  # validating CLI JSON. Stub that already-tested boundary so this assertion
  # counts only stock_workspace_records' classifier, the round-5 hot path.
  saved_get=$(declare -f get_cmux_workspaces_json)
  get_cmux_workspaces_json() { printf '%s' "$MOCK_CMUX_WORKSPACES_JSON"; }
  records=$(PATH="$count_bin:$PATH" stock_workspace_records) || ok=0
  eval "$saved_get"
  calls=$(wc -c < "$count_file" | tr -d ' ')
  [[ "$calls" == 1 && "$records" == *$'R\tambiguous-normalized-title\tmultiple\tFLY-1944-implement\t'* ]] || ok=0

  unset FLYWHEEL_TEST_PYTHON_COUNT FLYWHEEL_TEST_REAL_PYTHON
  if [[ "$ok" == 1 ]]; then
    pass "candidate, equivalent-command, and stock scans each classify their complete input in one interpreter"
  else
    fail "carrier classification fanned out calls=[$calls] candidates=[$(printf '%s\n' "$candidates" | grep -c . || true)] records=[$records]"
  fi
}

test_fly1944_v2_adoption_cap_still_heals_deferred_lead() {
  echo "Test: FLY-1944 round-5 — a capped v2 adoption still heals its existing surface"
  reset_mocks
  local trace="$TMPDIR_ROOT/fly1944-capped-lead-heal.trace" rc=0
  : > "$trace"
  FLYWHEEL_TEST_BIRTH_TARGET_B64=$(printf '%s' '/tmp/fly1944-lead.sock' | base64 | tr -d '\n')
  export FLYWHEEL_TEST_BIRTH_TARGET_B64
  (
    cmux_socket_identity() { printf 'generation-fly1944\n'; }
    get_cmux_workspaces_json() { printf '{"workspaces":[]}\n'; }
    workspace_title_candidates() { printf 'birth|workspace:1944|0|0|1944\n'; }
    cmux_attach_birth_records() {
      printf 'workspace:1944|00000000-0000-4000-8000-000000001944|dGl0bGU=|surface:1944|lead|%s|\n' "$FLYWHEEL_TEST_BIRTH_TARGET_B64"
    }
    workspace_birth_candidate_rows() { :; }
    select_title_keeper() { printf 'birth|workspace:1944\n'; }
    ledger_candidate_receipt_state() { printf 'prepared\n'; }
    _v2_lead_adopt_birth() { return 3; }
    _v2_lead_prepare_and_name() { printf 'prepare\n' >> "$trace"; }
    _v2_lead_cleanup_duplicates() { printf 'duplicates\n' >> "$trace"; }
    _v2_lead_heal_surface() { printf 'heal\n' >> "$trace"; }
    ensure_v2_lead_workspace 'growth-fly1944-lead' '/tmp/fly1944-lead.sock'
  ) || rc=$?
  unset FLYWHEEL_TEST_BIRTH_TARGET_B64
  if [[ "$rc" == 0 && "$(cat "$trace")" == heal ]]; then
    pass "the rollout cap defers authority mutation but not the existing Lead's repair path"
  else
    fail "capped adoption aborted the Lead reconcile rc=$rc trace=[$(cat "$trace")]"
  fi
}

test_fly1944_failed_v2_adoption_refunds_shared_slot() {
  echo "Test: FLY-1944 round-5 — a failed v2 adoption cannot starve the shared pass budget"
  reset_mocks
  local result
  FLYWHEEL_TEST_BIRTH_TARGET_B64=$(printf '%s' '/tmp/fly1944-lead.sock' | base64 | tr -d '\n')
  export FLYWHEEL_TEST_BIRTH_TARGET_B64
  result=$(
    cmux_socket_identity() { printf 'generation-fly1944\n'; }
    get_cmux_workspaces_json() { printf '{"workspaces":[]}\n'; }
    workspace_title_candidates() { printf 'birth|workspace:1944|0|0|1944\n'; }
    cmux_attach_birth_records() {
      printf 'workspace:1944|00000000-0000-4000-8000-000000001944|dGl0bGU=|surface:1944|lead|%s|\n' "$FLYWHEEL_TEST_BIRTH_TARGET_B64"
    }
    workspace_birth_candidate_rows() { :; }
    select_title_keeper() { printf 'birth|workspace:1944\n'; }
    ledger_candidate_receipt_state() { printf 'prepared\n'; }
    _v2_lead_adopt_birth() { CMUX_ADOPTION_COUNT=$((CMUX_ADOPTION_COUNT + 1)); return 1; }
    CMUX_ADOPTION_COUNT=4
    local rc=0
    ensure_v2_lead_workspace 'growth-fly1944-lead' '/tmp/fly1944-lead.sock' \
      >/dev/null 2>&1 || rc=$?
    printf '%s|%s\n' "$rc" "$CMUX_ADOPTION_COUNT"
  )
  unset FLYWHEEL_TEST_BIRTH_TARGET_B64
  if [[ "$result" == '1|4' ]]; then
    pass "a failed tuple stays retryable without consuming another Lead's adoption slot"
  else
    fail "failed adoption leaked its slot result=[$result]"
  fi
}

test_fly1944_adoption_cap_requires_current_owner() {
  echo "Test: FLY-1944 round-5 — the adoption valve rejects a foreign owner"
  reset_mocks
  local rc=0
  (
    stat() { printf '999999\n'; }
    cmux_adoption_limit >/dev/null
  ) || rc=$?
  if [[ "$rc" != 0 ]]; then
    pass "a foreign-owned cap file grants no rollout authority"
  else
    fail "foreign ownership was accepted by the adoption valve"
  fi
}

test_fly1884_missing_view_helper_defers_create_without_receipt() {
  echo "Test: FLY-1884 P0-B — missing reconnect helper fails closed before create authority"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_VIEW_HELPER_BIN="$TMPDIR_ROOT/missing-view-helper"
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_TOPOLOGY_MODE=1
  topo_add_session runner-flywheel '$1884'
  topo_add_window runner-flywheel @1884 FLY-1884-qa 1 0
  topo_add_session cmux-FLY-1884-qa '$2884' "" runner-flywheel 0
  topo_add_window cmux-FLY-1884-qa @1884 FLY-1884-qa 1 0
  test_ensure_mutator_lease

  create_workspace_for_window runner-flywheel @1884 FLY-1884-qa >/dev/null 2>&1 || true
  if [[ ! "$MOCK_CMUX_OPS" == *"new-workspace"* && ! -e "$VIEW_LEDGER" ]]; then
    pass "helper absence creates neither a broken tab nor prepared authority"
  else
    fail "missing helper crossed create boundary ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1884_upgrade_windows_accept_legacy_attach_surfaces() {
  echo "Test: FLY-1884 P0-B — legacy raw/workspace/surface crash windows converge after upgrade"
  local title="FLY-1884-qa" view="cmux-FLY-1884-qa"
  local old="env -u TMUX tmux attach -t '=cmux-FLY-1884-qa'" rc=0 ok=1

  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_MUTATE_JSON=1; MOCK_CMUX_MUTATE_SURFACES=1; MOCK_TOPOLOGY_MODE=1
  topo_add_session runner-flywheel '$1884'; topo_add_window runner-flywheel @1884 "$title" 1 0
  topo_add_session "$view" '$2884' "" runner-flywheel 0; topo_add_window "$view" @1884 "$title" 1 0
  MOCK_CMUX_WORKSPACES_JSON=$(python3 -c 'import json,sys; print(json.dumps({"workspaces":[{"ref":"workspace:1884","title":sys.argv[1]}]}))' "$old")
  MOCK_CMUX_SURFACES="workspace:1884;;surface:1884;;terminal;;true;;$old"
  test_ensure_mutator_lease
  reconcile_workspace_titles "runner-flywheel|@1884|$title" >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 0 && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|generation-fly1884|workspace:1884|$title" ]] || ok=0

  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1884\",\"title\":\"$title\"}]}"
  MOCK_CMUX_SURFACES="workspace:1884;;surface:1884;;terminal;;true;;$old"
  test_ledger_upsert prepared generation-fly1884 workspace:1884 "$title"
  rc=0
  complete_title_migration workspace:1884 "$title" generation-fly1884 \
    "$(managed_view_command_variants "$view" 2>/dev/null || true)" >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 0 && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|generation-fly1884|workspace:1884|$title" ]] || ok=0

  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_MUTATE_JSON=1; MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_CMUX_WORKSPACES_JSON=$(python3 -c 'import json,sys; print(json.dumps({"workspaces":[{"ref":"workspace:1884","title":sys.argv[1]}]}))' "$old")
  MOCK_CMUX_SURFACES="workspace:1884;;surface:1884;;terminal;;true;;$old"
  test_ledger_upsert prepared generation-fly1884 workspace:1884 "$title"
  rc=0
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 0 && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|generation-fly1884|workspace:1884|$title" ]] || ok=0

  if [[ "$ok" == "1" ]]; then
    pass "old raw workspace, old surface, and old prepared receipt all converge under the new producer"
  else
    fail "upgrade crash window failed rc=$rc ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_additive_round_ids_persist_and_advance() {
  echo "Test: FLY-1884 B2/B3 — additive round IDs persist and advance within one epoch"
  reset_mocks
  test_ensure_mutator_lease
  local first second persisted
  begin_cmux_additive_round || true
  first="$CMUX_ADDITIVE_ROUND_ID"
  CMUX_ADDITIVE_ROUND_ID=""
  begin_cmux_additive_round || true
  second="$CMUX_ADDITIVE_ROUND_ID"
  persisted=$(tr '|' '-' < "$CMUX_ADDITIVE_ROUND_STATE" 2>/dev/null || true)
  if [[ "$first" == [0-9]*-[0-9]* && "$second" == [0-9]*-[0-9]* \
      && "$first" != "$second" && "$persisted" == "$second" ]]; then
    pass "the durable epoch/sequence pair gives every additive pass a distinct ID"
  else
    fail "round IDs did not advance first=[$first] second=[$second] state=[$persisted]"
  fi
}

test_fly1884_prepared_absent_requires_distinct_aged_rounds() {
  echo "Test: FLY-1884 B2 — absent prepared receipt needs aged, distinct additive rounds"
  reset_mocks
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=1
  FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES=3
  printf '%s\n' 'prepared|generation-fly1884|workspace:52|FLY-1884-qa' > "$VIEW_LEDGER"
  printf '%s\n' 'absent|generation-fly1884|workspace:52|FLY-1884-qa|1|1|100-1' > "$PREPARED_STALL_STATE"
  test_ensure_mutator_lease

  CMUX_ADDITIVE_ROUND_ID="100-1"
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  local same_round next_round final_round
  same_round=$(cat "$PREPARED_STALL_STATE" 2>/dev/null || true)
  CMUX_ADDITIVE_ROUND_ID="100-2"
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  next_round=$(cat "$PREPARED_STALL_STATE" 2>/dev/null || true)
  CMUX_ADDITIVE_ROUND_ID="100-3"
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  final_round=$(cat "$PREPARED_STALL_STATE" 2>/dev/null || true)

  if [[ "$same_round" == 'absent|generation-fly1884|workspace:52|FLY-1884-qa|1|1|100-1' \
      && "$next_round" == 'absent|generation-fly1884|workspace:52|FLY-1884-qa|2|1|100-2' \
      && -z "$(cat "$VIEW_LEDGER" 2>/dev/null || true)" && -z "$final_round" \
      && -z "$MOCK_CMUX_OPS" ]]; then
    pass "same-round retries dedup; the third aged observation releases only the receipt"
  else
    fail "absent round contract drifted same=[$same_round] next=[$next_round] final=[$final_round] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_prepared_absent_min_age_and_reappearance_reset() {
  echo "Test: FLY-1884 B2 — minimum age blocks release and ref reappearance clears absent evidence"
  reset_mocks
  MOCK_SOCK_IDENT="generation-fly1884"
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=120
  FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES=3
  printf '%s\n' 'prepared|generation-fly1884|workspace:52|FLY-1884-qa' > "$VIEW_LEDGER"
  local now
  now=$(date +%s)
  printf 'absent|generation-fly1884|workspace:52|FLY-1884-qa|2|%s|100-1\n' "$now" > "$PREPARED_STALL_STATE"
  CMUX_ADDITIVE_ROUND_ID="100-2"
  test_ensure_mutator_lease
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  local too_young
  too_young=$(cat "$PREPARED_STALL_STATE" 2>/dev/null || true)

  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"id":"11111111-1111-4111-8111-111111111111","ref":"workspace:52","title":"founder-shell"}]}'
  CMUX_ADDITIVE_ROUND_ID="100-3"
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  if [[ "$too_young" == "absent|generation-fly1884|workspace:52|FLY-1884-qa|2|$now|100-2" \
      && "$(grep -c '^absent|' "$PREPARED_STALL_STATE" 2>/dev/null || true)" == "0" \
      && -n "$(cat "$VIEW_LEDGER" 2>/dev/null || true)" ]]; then
    pass "age is an independent gate and any exact-ref reappearance resets absent evidence"
  else
    fail "absent age/reset drifted young=[$too_young] sidecar=[$(cat "$PREPARED_STALL_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1884_prepared_stall_identity_includes_title() {
  echo "Test: FLY-1884 B2/B3 — same ref with a new title never inherits a round count"
  reset_mocks
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=120
  CMUX_ADDITIVE_ROUND_ID="100-1"
  test_ensure_mutator_lease
  _prepared_stall_observe absent generation-fly1884 workspace:52 FLY-1884-qa >/dev/null 2>&1 || true
  _prepared_stall_observe absent generation-fly1884 workspace:52 FLY-1884-design >/dev/null 2>&1 || true
  if [[ "$(grep -c '^absent|generation-fly1884|workspace:52|' "$PREPARED_STALL_STATE" 2>/dev/null || true)" == "2" \
      && "$(grep -c '|0|[0-9][0-9]*|100-1$' "$PREPARED_STALL_STATE" 2>/dev/null || true)" == "2" ]]; then
    pass "stall identity is the full kind/generation/ref/title tuple"
  else
    fail "stall tuples aliased sidecar=[$(cat "$PREPARED_STALL_STATE" 2>/dev/null)]"
  fi
}

test_fly1884_prepared_drift_release_preserves_workspace_and_alerts() {
  echo "Test: FLY-1884 B3 — persistent drift releases only the receipt and emits one episode alert"
  reset_mocks
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"id":"11111111-1111-4111-8111-111111111111","ref":"workspace:59","title":"founder-shell"}]}'
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=1
  FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES=5
  CMUX_ADDITIVE_ROUND_ID="100-5"
  printf '%s\n' 'prepared|generation-fly1884|workspace:59|FLY-1884-implement' > "$VIEW_LEDGER"
  printf '%s\n' 'drift|generation-fly1884|workspace:59|FLY-1884-implement|4|1|100-4' > "$PREPARED_STALL_STATE"
  local stub="$TMPDIR_ROOT/fly1884-alert-stub" args="$TMPDIR_ROOT/fly1884-alert-args"
  printf '%s\n' '#!/bin/bash' 'printf "%s\\n" "$@" > "$FLYWHEEL_TEST_ALERT_ARGS"' > "$stub"
  chmod +x "$stub"
  FLYWHEEL_ALERT_BIN="$stub"
  FLYWHEEL_TEST_ALERT_ARGS="$args"
  export FLYWHEEL_ALERT_BIN FLYWHEEL_TEST_ALERT_ARGS
  test_ensure_mutator_lease
  reconcile_prepared_ledger >/dev/null 2>&1 || true

  if [[ -z "$(cat "$VIEW_LEDGER" 2>/dev/null || true)" \
      && -z "$(cat "$PREPARED_STALL_STATE" 2>/dev/null || true)" \
      && -z "$MOCK_CMUX_OPS" \
      && "$(cat "$args" 2>/dev/null || true)" == *"prepared-drift-released"* ]]; then
    pass "drift release preserves the foreign workspace and makes the terminal disposition visible"
  else
    fail "drift release mismatch ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] sidecar=[$(cat "$PREPARED_STALL_STATE" 2>/dev/null)] ops=[$MOCK_CMUX_OPS] alert=[$(cat "$args" 2>/dev/null)]"
  fi
  unset FLYWHEEL_ALERT_BIN FLYWHEEL_TEST_ALERT_ARGS
}

test_fly1884_legacy_default_title_ages_without_mutation() {
  echo "Test: FLY-1884 B3 — legacy Terminal title ages out without gaining rename authority"
  reset_mocks
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"id":"11111111-1111-4111-8111-111111111111","ref":"workspace:92","title":"Terminal 37"}]}'
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=1
  FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES=1
  CMUX_ADDITIVE_ROUND_ID="100-1"
  printf '%s\n' 'prepared|generation-fly1884|workspace:92|FLY-1884-qa' > "$VIEW_LEDGER"
  printf '%s\n' 'drift|generation-fly1884|workspace:92|FLY-1884-qa|0|1|100-0' > "$PREPARED_STALL_STATE"
  test_ensure_mutator_lease
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  if [[ -z "$(cat "$VIEW_LEDGER" 2>/dev/null || true)" && -z "$MOCK_CMUX_OPS" ]]; then
    pass "legacy default-name deadlock releases its logical slot without touching the tab"
  else
    fail "legacy default acquired mutation authority ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1884_corrupt_prepared_stall_state_is_fail_safe() {
  echo "Test: FLY-1884 B2/B3 — corrupt stall state freezes receipt release"
  reset_mocks
  MOCK_SOCK_IDENT="generation-fly1884"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=1
  FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES=1
  CMUX_ADDITIVE_ROUND_ID="100-1"
  printf '%s\n' 'prepared|generation-fly1884|workspace:52|FLY-1884-qa' > "$VIEW_LEDGER"
  printf '%s\n' 'not-a-valid-row' > "$PREPARED_STALL_STATE"
  test_ensure_mutator_lease
  reconcile_prepared_ledger >/dev/null 2>&1 || true
  if [[ "$(cat "$VIEW_LEDGER")" == 'prepared|generation-fly1884|workspace:52|FLY-1884-qa' \
      && "$(cat "$PREPARED_STALL_STATE")" == 'not-a-valid-row' && -z "$MOCK_CMUX_OPS" ]]; then
    pass "malformed observation state cannot authorize GC or workspace mutation"
  else
    fail "corrupt sidecar failed open ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] sidecar=[$(cat "$PREPARED_STALL_STATE" 2>/dev/null)] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1272_p3_ghost_reaper_never_closes_unledgered_ref() {
  echo "Test: FLY-1272 P3 — new-mode ghost reaper leaves unledgered refs untouched"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1; MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:900","title":null}]}'
  reap_ghost_workspaces
  if ! grep -q 'close-workspace' <<< "$MOCK_CMUX_OPS"; then
    pass "title-null without prepared authority leaks safely instead of being guessed-owned"
  else
    fail "unledgered ghost was destructively reaped ops=[$MOCK_CMUX_OPS]"
  fi
}

_fly1272_attachment_fixture() {
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"; FLYWHEEL_CMUX_TEST_NONCE="nonce-attachment"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 1 0
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  test_ensure_mutator_lease
}

test_fly1272_p3_orphan_client_attach_failure_alerts_exact_ref() {
  echo "Test: FLY-1272 P3 — pre-existing orphan client + new attach failure never false-greens"
  _fly1272_attachment_fixture
  MOCK_TMUX_CLIENTS='cmux-FLY-1272-implement=1,1,1,1'
  local log_file="$TMPDIR_ROOT/attachment-orphan.log" row
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1272-implement" 2>"$log_file"
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$row" == 'committed|cmux-generation-1|workspace:100|FLY-1272-implement|00000000-0000-4000-8000-000000000100' ]] \
      && grep -q 'attachment_unverified generation=cmux-generation-1 ref=workspace:100 title=FLY-1272-implement reason=client-baseline-ambiguous' "$log_file"; then
    pass "orphan-client ambiguity retains exact authority and emits the keyed binding alert"
  else
    fail "orphan-client regression false-green row=[$row] log=[$(cat "$log_file" 2>/dev/null)]"
  fi
}

test_fly1272_p3_post_create_client_read_failure_variants() {
  echo "Test: FLY-1272 P3 — attach failure + post-create read failure (pre=0 and nonzero variants) retains ref"
  local pre spec log_file row ok=1
  for pre in 0 2; do
    _fly1272_attachment_fixture
    FLYWHEEL_CMUX_TEST_NONCE="nonce-post-read-${pre}"
    spec="${pre},ERR"
    MOCK_TMUX_CLIENTS="cmux-FLY-1272-implement=${spec}"
    log_file="$TMPDIR_ROOT/attachment-post-${pre}.log"
    create_workspace_for_window "runner-flywheel" "@42" "FLY-1272-implement" 2>"$log_file"
    row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
    [[ "$row" == 'committed|cmux-generation-1|workspace:100|FLY-1272-implement|00000000-0000-4000-8000-000000000100' ]] || ok=0
    grep -q 'attachment_unverified generation=cmux-generation-1 ref=workspace:100 title=FLY-1272-implement reason=client-baseline-ambiguous' "$log_file" || ok=0
  done
  [[ "$ok" == "1" ]] \
    && pass "both pre-count variants retain the committed ref and emit the exact keyed alert" \
    || fail "post-create client-read variant lost authority or alert"
}

test_fly1272_p3_unreadable_pre_capture_positive_post_is_unverified() {
  echo "Test: FLY-1272 P3 — unreadable pre-capture + positive post-count stays unverified"
  _fly1272_attachment_fixture
  MOCK_TMUX_CLIENTS='cmux-FLY-1272-implement=ERR,1'
  local log_file="$TMPDIR_ROOT/attachment-pre-unreadable.log"
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1272-implement" 2>"$log_file"
  if grep -q 'attachment_unverified generation=cmux-generation-1 ref=workspace:100 title=FLY-1272-implement reason=client-baseline-ambiguous' "$log_file"; then
    pass "a positive post-count cannot erase an unreadable pre-capture"
  else
    fail "unreadable pre-capture was falsely reported attached log=[$(cat "$log_file" 2>/dev/null)]"
  fi
}

test_fly1272_p5_bootstrap_converges_once_then_is_quiet() {
  echo "Test: FLY-1272 P5 — bootstrap converges grouped husk drift, second pass is mutation-free"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_TEST_NONCE="nonce-bootstrap"; MOCK_CMUX_MUTATE_JSON=1; MOCK_SOCK_IDENT="cmux-generation-1"
  BOOTSTRAP_SKIP_HEAL_SWEEP=1
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1272-implement" 0 0
  topo_add_window "runner-flywheel" "@99" "FLY-1225-qa" 1 1
  tmux new-session -d -t "runner-flywheel" -s "cmux-FLY-1272-implement"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"FLY-1272-implement"}]}'
  echo 101 > "$TMPDIR_ROOT/cmux.next-ref"
  test_ledger_upsert committed "cmux-generation-1" "workspace:100" "FLY-1272-implement"
  local rc=0 active members row first_new_count third_mutations
  : > "$TOPO_JOURNAL"; MOCK_CMUX_OPS=""
  sync_additive_bootstrap || rc=$?
  if grep -Eq '^(unlink-window|rename-session|kill-session|kill-window|link-window|new-session)' "$TOPO_JOURNAL"; then
    fail "first conclusive bootstrap mutated before the cross-tick latch"
  else
    pass "first conclusive bootstrap arms the mismatch latch without mutation"
  fi
  sync_additive_bootstrap || rc=$?
  active=$(tmux display-message -p -t "=cmux-FLY-1272-implement" '#{window_id}' 2>/dev/null || true)
  members=$(tmux list-windows -t "=cmux-FLY-1272-implement" -F '#{window_id}' 2>/dev/null | tr '\n' ' ')
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  first_new_count=$(grep -c '^new-workspace' <<< "$MOCK_CMUX_OPS" || true)
  : > "$TOPO_JOURNAL"; MOCK_CMUX_OPS=""
  sync_additive_bootstrap || rc=$?
  third_mutations=$(grep -Ec '^(new-session|link-window|unlink-window|rename-session|kill-session|kill-window)' "$TOPO_JOURNAL" || true)
  if [[ "$rc" -eq 0 && "$active" == "@42" && "$members" == "@42 " \
      && "$row" == "committed|cmux-generation-1|workspace:101|FLY-1272-implement|00000000-0000-4000-8000-000000000101" \
      && "$first_new_count" == "1" && "$third_mutations" == "0" ]] \
      && ! grep -q '^new-workspace' <<< "$MOCK_CMUX_OPS"; then
    pass "bootstrap reaches exact topology/ref authority on pass two; pass three emits no mutation"
  else
    fail "bootstrap convergence/idempotence mismatch rc=$rc active=$active members=[$members] row=[$row] first_new=$first_new_count third_tmux=$third_mutations third_ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1272_p2_keeper_inventory_reconciliation() {
  echo "Test: FLY-1272 P2 — keeper inventory rebuild/promote/GC is identity-bound"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1
  topo_add_session "fwkeeper-2-cmux-FLY-1272-implement" '$2' "" "runner-flywheel" "0"
  topo_add_window "fwkeeper-2-cmux-FLY-1272-implement" "@42" "FLY-1272-implement" 1 0
  printf 'tmux-test-generation|$3|fwkeeper-3-old|runner-old|@9|committed|1\n' > "$KEEPER_INVENTORY"
  printf 'malformed-row\n' >> "$KEEPER_INVENTORY"
  local rc=0 rebuilt malformed stale
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }
  reconcile_keeper_inventory || rc=$?
  rebuilt=$(awk -F'|' '$2 == "$2" { print $1 "|" $2 "|" $3 "|" $4 "|" $5 "|" $6 }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  malformed=$(grep -c '^malformed-row$' "$KEEPER_INVENTORY" 2>/dev/null || true)
  stale=$(grep -c 'fwkeeper-3-old' "$KEEPER_INVENTORY" 2>/dev/null || true)
  if [[ "$rc" -eq 0 && "$rebuilt" == 'tmux-test-generation|$2|fwkeeper-2-cmux-FLY-1272-implement|runner-flywheel|@42|committed' \
      && "$malformed" == "1" && "$stale" == "0" ]]; then
    pass "live keeper is reconstructed, missing committed identity is GCed, malformed row is non-authoritative and preserved"
  else
    fail "inventory reconcile rc=$rc rebuilt=[$rebuilt] malformed=$malformed stale=$stale rows=[$(cat "$KEEPER_INVENTORY" 2>/dev/null)]"
  fi
}

test_fly1596_dismantle_proves_tmux_before_consuming_receipt() {
  echo "Test: FLY-1596 Fix 1 — tmux refusal preserves the cmux row and exact receipt"
  reset_mocks
  MOCK_TOPOLOGY_MODE="1"; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1596-implement" 1 0
  tmux new-session -d -t "runner-flywheel" -s "cmux-FLY-1596-implement"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-implement"}]}'
  test_ledger_upsert committed "cmux-generation-1" "workspace:1596" "FLY-1596-implement"
  MOCK_TOPO_RENAME_FAIL=1
  MOCK_CMUX_OPS=""
  local rc=0 ledger_row workspace_count

  dismantle_view_display "FLY-1596-implement" "view-invariant-mismatch" \
    >/dev/null 2>&1 || rc=$?
  ledger_row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  workspace_count=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
print(sum(1 for w in json.load(sys.stdin)["workspaces"] if w.get("ref") == "workspace:1596"))
')

  if [[ "$rc" -ne 0 \
      && "$DISMANTLE_OUTCOME" == "tmux-partial-recoverable" \
      && -n "$DISMANTLE_REASON" \
      && "$ledger_row" == "committed|cmux-generation-1|workspace:1596|FLY-1596-implement" \
      && "$workspace_count" == "1" \
      && ! "$MOCK_CMUX_OPS" =~ close-workspace ]]; then
    pass "tmux-side failure is named and leaves the visible row plus receipt available for retry"
  else
    fail "dismantle consumed authority before tmux proof rc=$rc outcome=[$DISMANTLE_OUTCOME] reason=[$DISMANTLE_REASON] ledger=[$ledger_row] workspaces=$workspace_count ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1596_inventory_requires_lease_and_recovers_residual_lock() {
  echo "Test: FLY-1596 Fix 1 — keeper inventory is lease-bound and recovers its crash lock"
  reset_mocks
  local unleased_rc=0 leased_rc=0 log_file="$TMPDIR_ROOT/fly1596-inventory.log"
  _inventory_upsert tmux-test-generation '$51' fwkeeper-51 owner '@51' committed \
    >/dev/null 2>&1 || unleased_rc=$?
  rm -f "$KEEPER_INVENTORY"
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }
  mkdir -p "${KEEPER_INVENTORY}.lock"

  _inventory_upsert tmux-test-generation '$52' fwkeeper-52 owner '@52' committed \
    >/dev/null 2>"$log_file" || leased_rc=$?
  release_mutator_lease

  if [[ "$unleased_rc" -ne 0 && "$leased_rc" -eq 0 \
      && "$(cat "$KEEPER_INVENTORY" 2>/dev/null || true)" == 'tmux-test-generation|$52|fwkeeper-52|owner|@52|committed|'* \
      && ! -d "${KEEPER_INVENTORY}.lock" \
      && "$(cat "$log_file")" == *"[audit] reaped stale keeper inventory lock"* ]]; then
    pass "unleased inventory writes fail closed; the verified sole writer reaps a crash residue"
  else
    fail "inventory lease/lock contract mismatch unleased_rc=$unleased_rc leased_rc=$leased_rc row=[$(cat "$KEEPER_INVENTORY" 2>/dev/null)] lock=$([[ -d "${KEEPER_INVENTORY}.lock" ]] && echo present || echo absent) log=[$(cat "$log_file" 2>/dev/null)]"
  fi
}

test_fly1596_inventory_reconciles_production_generation_token() {
  echo "Test: FLY-1596 QA rework — keeper inventory reads and writes one production-generation token"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  local saved_tmux_generation="$FLYWHEEL_CMUX_TMUX_GENERATION" rc=0 row
  local production_tmux_generation='/private/tmp/tmux-501/default|51104|Wed Aug  5 07:00:00 2026'
  local expected_inventory_generation
  expected_inventory_generation="sha256:$(printf '%s' "$production_tmux_generation" | shasum -a 256 | awk '{print $1}')"
  FLYWHEEL_CMUX_TMUX_GENERATION="$production_tmux_generation"
  topo_add_session fwkeeper-52-cmux-FLY-1596-implement '$52' '' owner 0
  topo_add_window fwkeeper-52-cmux-FLY-1596-implement '@52' FLY-1596-implement 1 0
  printf '%s|$52|fwkeeper-52-cmux-FLY-1596-implement|owner|@52|prepared|1\n' \
    "$expected_inventory_generation" > "$KEEPER_INVENTORY"
  test_ensure_mutator_lease || {
    FLYWHEEL_CMUX_TMUX_GENERATION="$saved_tmux_generation"
    fail "cannot acquire fixture mutator lease"
    return
  }

  reconcile_keeper_inventory >/dev/null 2>&1 || rc=$?
  row=$(cat "$KEEPER_INVENTORY" 2>/dev/null || true)
  release_mutator_lease
  FLYWHEEL_CMUX_TMUX_GENERATION="$saved_tmux_generation"
  if [[ "$rc" -eq 0 \
      && "$row" == "$expected_inventory_generation|"'$52|fwkeeper-52-cmux-FLY-1596-implement|owner|@52|committed|'* ]]; then
    pass "production generation is tokenized consistently across inventory reconciliation"
  else
    fail "production inventory reconciliation mismatch rc=$rc row=[$row] expected_generation=[$expected_inventory_generation]"
  fi
}

test_fly1596_inventory_crash_boundaries_converge_under_next_lease_holder() {
  echo "Test: FLY-1596 Fix 1 — inventory crash boundaries converge under the next lease holder"
  reset_mocks
  local base_inventory="$KEEPER_INVENTORY" base_lock="$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  local point case_dir child_rc rc row ok=1
  for point in after-inner-mkdir after-inventory-tmp-write after-inventory-mv after-lock-rmdir; do
    case_dir="$TMPDIR_ROOT/fly1596-inventory-crash-$point"
    mkdir -p "$case_dir"
    child_rc=0
    KEEPER_INVENTORY="$case_dir/keeper-inventory" \
    FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$case_dir/watcher.lock" \
    FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="child-$point" \
    FLYWHEEL_CMUX_INVENTORY_CRASH_AT="$point" \
      /bin/bash -c 'source "$1"; acquire_mutator_lease once; _inventory_upsert gen "$2" keeper owner @42 committed' \
        _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" '$42' >/dev/null 2>&1 || child_rc=$?
    [[ "$child_rc" == "137" ]] || ok=0

    KEEPER_INVENTORY="$case_dir/keeper-inventory"
    FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$case_dir/watcher.lock"
    WATCHER_LOCK_DIR="$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
    WATCHER_REAP_MUTEX="${WATCHER_LOCK_DIR}.reap"
    FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="test-incarnation"
    MUTATOR_LEASE_NONCE=""; MUTATOR_LEASE_INCARNATION=""; MUTATOR_LEASE_MODE=""
    rc=0
    acquire_mutator_lease qa_teardown || rc=$?
    _inventory_upsert gen '$42' keeper owner '@42' committed || rc=$?
    row=$(cat "$KEEPER_INVENTORY" 2>/dev/null || true)
    if [[ "$rc" -ne 0 || "$row" != 'gen|$42|keeper|owner|@42|committed|'* \
        || -d "${KEEPER_INVENTORY}.lock" ]]; then
      ok=0
    fi
    release_mutator_lease
  done
  KEEPER_INVENTORY="$base_inventory"
  FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$base_lock"
  WATCHER_LOCK_DIR="$base_lock"
  WATCHER_REAP_MUTEX="${base_lock}.reap"
  unset FLYWHEEL_CMUX_INVENTORY_CRASH_AT
  if [[ "$ok" == "1" ]]; then
    pass "lock/temp/replace/release crash points converge without duplicate authority"
  else
    fail "one or more inventory crash points did not SIGKILL and recover cleanly"
  fi
}

test_fly1596_restored_marker_parser_is_strict_and_tri_state() {
  echo "Test: FLY-1596 Fix 2 — restored marker parser is strict and tri-state"
  reset_mocks
  local title="FLY-1596-restored" generation="cmux-generation-1" ref="workspace:1596"
  local title_b64 orig_b64 fingerprint epoch valid_rc=0 malformed_rc=0
  title_b64=$(printf '%s' "$title" | base64 | tr -d '\n')
  orig_b64=$(printf 'none|%s|%s|%s' "$generation" "$ref" "$title" | base64 | tr -d '\n')
  fingerprint=$(printf '%064d' 0)
  epoch=$(date +%s)
  printf 'restoredv1|W1|%s|%s|%s|%s|%s|%s\n' \
    "$generation" "$ref" "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  restored_inflight_state "$generation" "$ref" "$title" || valid_rc=$?
  printf 'restoredv1|W1|too|few\n' > "$RESTORED_STATE"
  restored_inflight_state "$generation" "$ref" "$title" || malformed_rc=$?
  if [[ "$valid_rc" -eq 0 && "$malformed_rc" -eq 2 ]]; then
    pass "valid exact markers block with rc=0; malformed state fails closed with rc=2"
  else
    fail "restored parser tri-state mismatch valid_rc=$valid_rc malformed_rc=$malformed_rc"
  fi
}

test_fly1596_restored_inflight_blocks_ordinary_close_and_dismantle() {
  echo "Test: FLY-1596 Fix 2 — restored in-flight authority blocks ordinary consumers"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1; MOCK_CMUX_MUTATE_JSON=1
  local title="FLY-1596-restored" generation="cmux-generation-1" ref="workspace:1596"
  local title_b64 orig_b64 fingerprint epoch close_rc=0 dismantle_rc=0 row
  title_b64=$(printf '%s' "$title" | base64 | tr -d '\n')
  orig_b64=$(printf 'none|%s|%s|%s' "$generation" "$ref" "$title" | base64 | tr -d '\n')
  fingerprint=$(printf '%064d' 0)
  epoch=$(date +%s)
  printf 'restoredv1|W1|%s|%s|%s|%s|%s|%s\n' \
    "$generation" "$ref" "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-restored"}]}'
  test_ledger_upsert committed "$generation" "$ref" "$title"
  close_ledger_workspace_ref "$generation" "$ref" "$title" ordinary-consumer || close_rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)

  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "$title" 1 0
  tmux new-session -d -t runner-flywheel -s "cmux-$title"
  : > "$TOPO_JOURNAL"
  dismantle_view_display "$title" view-invariant-mismatch || dismantle_rc=$?
  if [[ "$close_rc" -ne 0 && "$dismantle_rc" -ne 0 \
      && "$row" == "committed|$generation|$ref|$title" \
      && "$DISMANTLE_OUTCOME" == preflight-refused \
      && "$DISMANTLE_REASON" == restored-inflight \
      && -z "$MOCK_CMUX_OPS" \
      && ! -s "$TOPO_JOURNAL" ]]; then
    pass "ordinary close and dismantle preserve an in-flight restored transaction byte-for-byte"
  else
    fail "restored consumer gate mismatch close_rc=$close_rc dismantle_rc=$dismantle_rc row=[$row] outcome=$DISMANTLE_OUTCOME reason=$DISMANTLE_REASON ops=[$MOCK_CMUX_OPS] journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1596_restored_ledger_cas_preserves_reused_current_ref() {
  echo "Test: FLY-1596 Fix 2 — restored ledger CAS is generation-scoped"
  reset_mocks
  local title="FLY-1596-restored" old="cmux-generation-old" current="cmux-generation-1" ref="workspace:1596"
  local title_b64 orig_b64 fingerprint epoch delete_rc=0 restore_rc=0 current_row old_row
  title_b64=$(printf '%s' "$title" | base64 | tr -d '\n')
  fingerprint=$(printf '%064d' 0)
  epoch=$(date +%s)
  orig_b64=$(printf 'none|%s|%s|%s' "$old" "$ref" "$title" | base64 | tr -d '\n')
  printf 'restoredv1|W1|%s|%s|%s|%s|%s|%s\n' \
    "$old" "$ref" "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  printf '%s\n' \
    "committed|$old|$ref|$title" \
    "committed|$current|$ref|FLY-1596-current" > "$VIEW_LEDGER"
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }
  _restored_ledger_cas delete W1 "$old" "$ref" "$title" "$fingerprint" || delete_rc=$?
  current_row=$(grep "^committed|$current|$ref|FLY-1596-current$" "$VIEW_LEDGER" 2>/dev/null || true)
  old_row=$(grep "|$old|$ref|" "$VIEW_LEDGER" 2>/dev/null || true)

  orig_b64=$(printf 'prepared|%s|%s|%s' "$old" "$ref" "$title" | base64 | tr -d '\n')
  printf 'restoredv1|W1p|%s|%s|%s|%s|%s|%s\n' \
    "$old" "$ref" "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  printf 'committed|%s|%s|%s\n' "$old" "$ref" "$title" >> "$VIEW_LEDGER"
  _restored_ledger_cas restore-prepared W1p "$old" "$ref" "$title" "$fingerprint" || restore_rc=$?
  release_mutator_lease
  if [[ "$delete_rc" -eq 0 && "$restore_rc" -eq 0 && -z "$old_row" \
      && -n "$current_row" \
      && "$(grep -c "^prepared|$old|$ref|$title$" "$VIEW_LEDGER" || true)" == "1" \
      && "$(grep -c "^committed|$current|$ref|FLY-1596-current$" "$VIEW_LEDGER" || true)" == "1" ]]; then
    pass "delete/restore touch only the marker-authorized old-generation tuple"
  else
    fail "restored CAS mismatch delete_rc=$delete_rc restore_rc=$restore_rc old_before=[$old_row] current=[$current_row] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1596_w1_two_pass_adoption_closes_restored_row() {
  echo "Test: FLY-1596 Fix 2 — W1 two-pass adoption closes the restored row"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_RESTORED_ADOPTION=1; MOCK_CMUX_MUTATE_JSON=1
  local title="FLY-1596-implement" generation="cmux-generation-1" ref="workspace:1596"
  local first_marker first_ledger first_ops rc=0
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-implement"}]}'
  MOCK_CMUX_SURFACES="workspace:1596;;surface:1;;terminal;;true;;$title"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$title" 1 0
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }

  adopt_restored_workspaces live || rc=$?
  first_marker=$(cat "$RESTORED_STATE" 2>/dev/null || true)
  first_ledger=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  first_ops="$MOCK_CMUX_OPS"
  adopt_restored_workspaces live || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$first_marker" == restoredv1'|'W1'|'* \
      && -z "$first_ledger" && -z "$first_ops" \
      && "$(cat "$RESTORED_STATE" 2>/dev/null || true)" == "" \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null || true)" == "" \
      && "$MOCK_CMUX_WORKSPACES_JSON" == '{"workspaces": []}' \
      && "$(grep -c '^close-workspace --workspace workspace:1596$' <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "first pass persists evidence only; second pass closes via a synthetic committed receipt"
  else
    fail "W1 adoption mismatch rc=$rc first_marker=[$first_marker] first_ledger=[$first_ledger] first_ops=[$first_ops] marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] json=[$MOCK_CMUX_WORKSPACES_JSON] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1596_restored_adoption_accepts_production_lead_titles() {
  echo "Test: FLY-1596 Fix 2 — restored adoption includes production Lead titles"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_RESTORED_ADOPTION=1; MOCK_CMUX_MUTATE_JSON=1
  local title="flywheel-flywheel-cos-lead" generation="cmux-generation-1" ref="workspace:60"
  local first_marker original_derive rc=0
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=ok
    LEAD_ROSTER_ROWS="claude-tmux|com.flywheel.lead.cos|flywheel-flywheel-cos-lead"
  }
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:60","title":"flywheel-flywheel-cos-lead"}]}'
  MOCK_CMUX_SURFACES="workspace:60;;surface:60;;terminal;;true;;$title"
  topo_add_session flywheel '$1'
  topo_add_window flywheel '@60' "$title" 1 0
  test_ensure_mutator_lease || { eval "$original_derive"; fail "cannot acquire fixture mutator lease"; return; }

  adopt_restored_workspaces live || rc=$?
  first_marker=$(cat "$RESTORED_STATE" 2>/dev/null || true)
  adopt_restored_workspaces live || rc=$?
  release_mutator_lease
  eval "$original_derive"
  if [[ "$rc" -eq 0 && "$first_marker" == restoredv1'|'W1'|'* \
      && ! -s "$RESTORED_STATE" && ! -s "$VIEW_LEDGER" \
      && "$MOCK_CMUX_WORKSPACES_JSON" == '{"workspaces": []}' \
      && "$(grep -c '^close-workspace --workspace workspace:60$' <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "the exact lowercase Lead title follows the same two-pass adoption transaction"
  else
    fail "production Lead adoption mismatch rc=$rc first=[$first_marker] marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] json=[$MOCK_CMUX_WORKSPACES_JSON] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1596_restored_adoption_rejects_unrostered_live_titles() {
  echo "Test: FLY-1596 Fix 2 — restored adoption rejects unrostered live titles"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_RESTORED_ADOPTION=1; MOCK_CMUX_MUTATE_JSON=1
  local title="founder-scratch" generation="cmux-generation-1"
  local before original_derive rc=0
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=ok
    LEAD_ROSTER_ROWS="claude-tmux|com.flywheel.lead.cos|flywheel-flywheel-cos-lead"
  }
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:61","title":"founder-scratch"}]}'
  MOCK_CMUX_SURFACES="workspace:61;;surface:61;;terminal;;true;;$title"
  topo_add_session flywheel '$1'
  topo_add_window flywheel '@61' "$title" 1 0
  before="$MOCK_CMUX_WORKSPACES_JSON"
  test_ensure_mutator_lease || { eval "$original_derive"; fail "cannot acquire fixture mutator lease"; return; }

  adopt_restored_workspaces live || rc=$?
  release_mutator_lease
  eval "$original_derive"
  if [[ "$rc" -eq 0 && ! -s "$RESTORED_STATE" && ! -s "$VIEW_LEDGER" \
      && "$MOCK_CMUX_WORKSPACES_JSON" == "$before" && -z "$MOCK_CMUX_OPS" ]]; then
    pass "a live title needs runner grammar or exact Lead-roster authority before adoption"
  else
    fail "unrostered title received authority rc=$rc marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] json=[$MOCK_CMUX_WORKSPACES_JSON] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1596_dead_discovery_roster_failure_is_nonfatal() {
  echo "Test: FLY-1596 Fix 2 — dead discovery degrades on roster failure"
  reset_mocks
  FLYWHEEL_CMUX_RESTORED_ADOPTION=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  local original_derive rc=0
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() { LEAD_ROSTER_STATE=unavailable; return 1; }
  test_ensure_mutator_lease || { eval "$original_derive"; fail "cannot acquire fixture mutator lease"; return; }

  adopt_restored_workspaces dead discover-only || rc=$?
  release_mutator_lease
  eval "$original_derive"
  if [[ "$rc" -eq 0 && ! -s "$RESTORED_STATE" && ! -s "$VIEW_LEDGER" ]]; then
    pass "an underivable Lead roster skips dead candidates without deferring the watcher pass"
  else
    fail "roster failure escaped dead discovery rc=$rc marker=[$(cat "$RESTORED_STATE" 2>/dev/null)]"
  fi
}

test_fly1596_restored_fingerprint_ignores_focus_state() {
  echo "Test: FLY-1596 Fix 2 — restored fingerprint ignores cmux focus state"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_RESTORED_ADOPTION=1; MOCK_CMUX_MUTATE_JSON=1
  local title="FLY-1596-implement" generation="cmux-generation-1" rc=0 first
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-implement","pinned":false,"selected":false}]}'
  MOCK_CMUX_SURFACES="workspace:1596;;surface:1;;terminal;;true;;$title"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$title" 1 0
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }

  adopt_restored_workspaces live || rc=$?
  first=$(cat "$RESTORED_STATE" 2>/dev/null || true)
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-implement","pinned":true,"selected":true}]}'
  adopt_restored_workspaces live || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$first" == restoredv1'|'W1'|'* \
      && ! -s "$RESTORED_STATE" && ! -s "$VIEW_LEDGER" \
      && "$MOCK_CMUX_WORKSPACES_JSON" == '{"workspaces": []}' ]]; then
    pass "focus and pin presentation changes cannot starve the two-pass adoption latch"
  else
    fail "focus drift changed restored authority rc=$rc first=[$first] marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] json=[$MOCK_CMUX_WORKSPACES_JSON]"
  fi
}

test_fly1596_raw_attach_title_never_enters_restored_inflight() {
  echo "Test: FLY-1596 Fix 2 — raw attach titles stay outside restored authority"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_RESTORED_ADOPTION=1; MOCK_CMUX_MUTATE_JSON=1
  local title="FLY-1596-implement" generation="cmux-generation-1" canonical before rc=0 ops_rc=0
  MOCK_SOCK_IDENT="$generation"
  canonical=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON=$(printf '{"workspaces":[{"ref":"workspace:1596","title":"%s"}]}' "$canonical")
  MOCK_CMUX_SURFACES="workspace:1596;;surface:1;;terminal;;true;;~"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$title" 1 0
  before="$MOCK_CMUX_WORKSPACES_JSON"
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }

  adopt_restored_workspaces live || rc=$?
  FLYWHEEL_CMUX_OPS_REPROBE_SECONDS=0 \
    _ops_adopt_restored_candidate W1 "$generation" workspace:1596 "$title" none || ops_rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$ops_rc" -eq 1 && ! -s "$RESTORED_STATE" && ! -s "$VIEW_LEDGER" \
      && "$MOCK_CMUX_WORKSPACES_JSON" == "$before" && -z "$MOCK_CMUX_OPS" ]]; then
    pass "raw rows remain available to title reconciliation and both adoption paths refuse them"
  else
    fail "raw row entered restored authority rc=$rc ops_rc=$ops_rc marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1596_one_restored_action_failure_does_not_abort_later_markers() {
  echo "Test: FLY-1596 Fix 2 — one restored action failure is tuple-local"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_RESTORED_ADOPTION=1
  local blocked="FLY-1596-implement" later="FLY-1596-qa"
  local generation="cmux-generation-1" old_generation="cmux-generation-old"
  local blocked_ref="workspace:1596" later_ref="workspace:1597"
  local blocked_fingerprint later_fingerprint blocked_b64 later_b64 blocked_orig later_orig epoch
  local saved_upsert rc=0 remaining
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-implement"}]}'
  MOCK_CMUX_SURFACES="workspace:1596;;surface:1;;terminal;;true;;$blocked"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$blocked" 1 0
  _restored_candidate_probe W1 "$generation" "$blocked_ref" "$blocked" || {
    fail "cannot derive blocked-marker fixture fingerprint"; return;
  }
  blocked_fingerprint="$RESTORED_PROBE_FINGERPRINT"
  later_fingerprint=$(printf '%064d' 7)
  blocked_b64=$(_restored_b64 "$blocked"); later_b64=$(_restored_b64 "$later")
  blocked_orig=$(_restored_b64 "none|$generation|$blocked_ref|$blocked")
  later_orig=$(_restored_b64 "none|$old_generation|$later_ref|$later")
  epoch=$(date +%s)
  printf 'restoredv1|W1|%s|%s|%s|%s|%s|%s\n' \
    "$generation" "$blocked_ref" "$blocked_b64" "$blocked_orig" "$blocked_fingerprint" "$epoch" > "$RESTORED_STATE"
  printf 'restoredv1|W1|%s|%s|%s|%s|%s|%s\n' \
    "$old_generation" "$later_ref" "$later_b64" "$later_orig" "$later_fingerprint" "$epoch" >> "$RESTORED_STATE"
  saved_upsert=$(declare -f _ledger_upsert)
  _ledger_upsert() { return 1; }
  test_ensure_mutator_lease || { eval "$saved_upsert"; fail "cannot acquire fixture mutator lease"; return; }
  recover_restored_transactions || rc=$?
  release_mutator_lease
  eval "$saved_upsert"
  remaining=$(_restored_parse_records 2>/dev/null || true)
  if [[ "$rc" -eq 0 && "$remaining" == *$'W1\tcmux-generation-1\tworkspace:1596\tFLY-1596-implement'* \
      && "$remaining" != *"$later"* ]]; then
    pass "the failed tuple stays durable while a later independently-actionable marker converges"
  else
    fail "tuple-local recovery mismatch rc=$rc remaining=[$remaining]"
  fi
}

test_fly1596_flag_off_aborts_synthetic_receipt_without_close() {
  echo "Test: retired restored-adoption env cannot disable adoption"
  if FLYWHEEL_CMUX_RESTORED_ADOPTION=0 restored_adoption_enabled; then
    pass "retired restored-adoption env is ignored"
  else
    fail "retired restored-adoption env still disabled adoption"
  fi
}

test_fly1596_w1p_promotes_then_closes_drifted_prepared_row() {
  echo "Test: FLY-1596 Fix 2 — W1p promotes then closes through the committed choke"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_RESTORED_ADOPTION=1; MOCK_CMUX_MUTATE_JSON=1
  local title="FLY-1596-implement" generation="cmux-generation-1" ref="workspace:1596" rc=0 first
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-implement"}]}'
  MOCK_CMUX_SURFACES="workspace:1596;;surface:1;;terminal;;true;;${title}:5"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$title" 1 0
  test_ledger_upsert prepared "$generation" "$ref" "$title"
  adopt_restored_workspaces live || rc=$?
  first=$(cat "$RESTORED_STATE" 2>/dev/null || true)
  adopt_restored_workspaces live || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$first" == restoredv1'|'W1p'|'* \
      && ! -s "$RESTORED_STATE" && ! -s "$VIEW_LEDGER" \
      && "$MOCK_CMUX_WORKSPACES_JSON" == '{"workspaces": []}' \
      && "$(grep -c '^close-workspace --workspace workspace:1596$' <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "prepared drift is marked first, promoted once, then closed by exact committed authority"
  else
    fail "W1p adoption mismatch rc=$rc first=[$first] marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] json=[$MOCK_CMUX_WORKSPACES_JSON] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1596_w1dead_is_roster_only_and_leaves_runner_stock() {
  echo "Test: FLY-1596 Fix 2 — W1-dead authority is roster-only"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  FLYWHEEL_CMUX_RESTORED_ADOPTION=1; FLYWHEEL_CMUX_ADOPTION_GRACE=0; MOCK_CMUX_MUTATE_JSON=1
  local lead="FLY-1596-qa" runner="FLY-1596-runner" generation="cmux-generation-1" rc=0
  local original_derive first
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=ok
    LEAD_ROSTER_ROWS="claude-tmux|com.flywheel.lead.test|FLY-1596-qa"
  }
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-qa"},{"ref":"workspace:1597","title":"FLY-1596-runner"}]}'
  MOCK_CMUX_SURFACES="workspace:1596;;surface:1;;terminal;;true;;$lead
workspace:1597;;surface:2;;terminal;;true;;$runner"
  test_ensure_mutator_lease || { eval "$original_derive"; fail "cannot acquire fixture mutator lease"; return; }
  adopt_restored_workspaces dead || rc=$?
  first=$(cat "$RESTORED_STATE" 2>/dev/null || true)
  adopt_restored_workspaces dead || rc=$?
  release_mutator_lease
  eval "$original_derive"
  if [[ "$rc" -eq 0 && "$first" == *'|W1dead|'* && "$first" != *"$(_restored_b64 "$runner")"* \
      && ! -s "$RESTORED_STATE" && ! -s "$VIEW_LEDGER" \
      && "$MOCK_CMUX_WORKSPACES_JSON" == '{"workspaces": [{"ref": "workspace:1597", "title": "FLY-1596-runner"}]}' ]]; then
    pass "dead lead row closes after roster proof; runner grammar receives no new close authority"
  else
    fail "W1dead roster boundary mismatch rc=$rc first=[$first] marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] json=[$MOCK_CMUX_WORKSPACES_JSON] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1596_all_normal_receipt_consumers_skip_restored_inflight() {
  echo "Test: FLY-1596 Fix 2 — all normal receipt consumers skip restored in-flight tuples"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  local title="FLY-1596-implement" generation="cmux-generation-1" ref="workspace:1596"
  local title_b64 orig_b64 fingerprint epoch canonical before rc=0
  MOCK_SOCK_IDENT="$generation"
  canonical=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1596","title":"FLY-1596-implement"}]}'
  MOCK_CMUX_SURFACES="workspace:1596;;surface:1;;terminal;;true;;$canonical"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$title" 1 0
  topo_add_session "cmux-$title" '$2' "" runner-flywheel 0
  topo_add_window "cmux-$title" '@42' "$title" 1 0
  test_ledger_upsert prepared "$generation" "$ref" "$title"
  title_b64=$(printf '%s' "$title" | base64 | tr -d '\n')
  orig_b64=$(printf 'prepared|%s|%s|%s' "$generation" "$ref" "$title" | base64 | tr -d '\n')
  fingerprint=$(printf '%064d' 0)
  epoch=$(date +%s)
  printf 'restoredv1|W1p|%s|%s|%s|%s|%s|%s\n' \
    "$generation" "$ref" "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  before=$(cat "$VIEW_LEDGER")
  : > "$TOPO_JOURNAL"; MOCK_CMUX_OPS=""
  complete_title_migration "$ref" "$title" "$generation" "$canonical" >/dev/null 2>&1 || true
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  reconcile_workspace_titles "runner-flywheel|@42|$title" >/dev/null 2>&1 || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$(cat "$VIEW_LEDGER")" == "$before" \
      && -z "$MOCK_CMUX_OPS" ]] \
      && ! grep -Eq '^(new-session|link-window|unlink-window|rename-session|kill-session|kill-window|set-option|select-window)' "$TOPO_JOURNAL"; then
    pass "prepared recovery, title completion, and title reconcile perform zero mutation on in-flight authority"
  else
    fail "normal consumer exclusion mismatch rc=$rc before=[$before] ledger=[$(cat "$VIEW_LEDGER")] ops=[$MOCK_CMUX_OPS] journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1596_recovery_decision_table_is_total_and_preserves_phase_invariants() {
  echo "Test: FLY-1596 Fix 2 — recovery decision table is total and phase-safe"
  reset_mocks
  local cases line relation kind ledger presence flag evidence readiness expected observed ok=1
  cases=$'inconclusive|W1|none|present|on|stable|ready|0\nunknown|W1|none|present|on|stable|ready|1\nstale|W1|none|present|on|stable|ready|2\nstale|W1|committed|present|on|stable|ready|3\nstale|W1p|committed|present|on|stable|ready|4\nstale|W1p|prepared|present|on|stable|ready|5\nstale|W1|prepared|present|on|stable|ready|6\ncurrent|W1|none|present|on|stable|not-ready|6.5\ncurrent|W1|none|present|on|stable|ready|7\ncurrent|W1|none|present|off|drift|ready|8\ncurrent|W1|none|absent|off|drift|ready|9\ncurrent|W1|committed|present|on|stable|ready|10\ncurrent|W1|committed|present|off|drift|ready|11\ncurrent|W1|committed|absent|off|drift|ready|12\ncurrent|W1p|prepared|present|on|stable|ready|13\ncurrent|W1p|prepared|present|off|drift|ready|14\ncurrent|W1p|committed|present|on|stable|ready|15\ncurrent|W1p|committed|present|off|drift|ready|16\ncurrent|W1p|committed|absent|off|drift|ready|17\ncurrent|W1p|none|absent|on|drift|ready|18\ncurrent|W1p|none|present|on|stable|ready|19\ncurrent|W1|conflict|present|on|stable|ready|20'
  while IFS='|' read -r relation kind ledger presence flag evidence readiness expected; do
    observed=$(_restored_recovery_decision "$relation" "$kind" "$ledger" "$presence" "$flag" "$evidence" "$readiness")
    [[ "${observed%%|*}" == "$expected" && "$(wc -l <<< "$observed" | tr -d ' ')" == "1" ]] || ok=0
  done <<< "$cases"

  local state action
  for kind in W1 W1dead W1p; do
    for state in none prepared committed conflict; do
      for presence in present absent; do
        for flag in on off; do
          for evidence in stable drift; do
            for readiness in not-ready ready; do
              observed=$(_restored_recovery_decision current "$kind" "$state" "$presence" "$flag" "$evidence" "$readiness")
              [[ -n "${observed%%|*}" && "$observed" == *'|'* ]] || ok=0
              action=${observed#*|}
              [[ "$kind" == W1p || "$action" != cas-restore-marker ]] || ok=0
              [[ "$kind" != W1p || "$action" != cas-delete-marker ]] || ok=0
            done
          done
        done
      done
    done
  done
  if [[ "$ok" == "1" ]]; then
    pass "all 21 rows are reachable; concrete state products map once without illegal phase rollback"
  else
    fail "restored recovery table coverage or phase invariant failed"
  fi
}

test_fly1596_adoption_budget_meets_five_minute_restart_bound() {
  echo "Test: FLY-1596 Fix 2 — 15-title adoption budget meets the five-minute bound"
  reset_mocks
  local normal bootstrap action_passes total_seconds
  normal=$(restored_action_budget 15 0)
  bootstrap=$(restored_action_budget 15 1)
  action_passes=$(((15 + normal - 1) / normal))
  total_seconds=$(((1 + action_passes) * 60))
  if [[ "$normal" == "5" && "$bootstrap" == "10" && "$total_seconds" -lt 300 ]]; then
    pass "15 titles converge after one latch plus $action_passes action passes (${total_seconds}s); bootstrap budget=$bootstrap"
  else
    fail "adoption budget mismatch normal=$normal bootstrap=$bootstrap passes=$action_passes seconds=$total_seconds"
  fi
}

fly1944_seed_session_birth() {
  local surface="$1" command="$2"
  python3 - "$CMUX_SESSION_STATE" "$surface" "$command" <<'PY'
import json,sys
path,surface,command=sys.argv[1:]
data={"windows":[{"tabManager":{"workspaces":[{
  "focusedPanelId":surface,"processTitle":command,
  "panels":[{"type":"terminal","id":surface}]
}]}}]}
with open(path,"w",encoding="utf-8") as f: json.dump(data,f)
PY
}

_fly1596_setup_healthy_sidebar_fixture() {
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  local title="${1:-FLY-1596-implement}" source="${2:-runner-flywheel}" private_socket="${3:-}"
  local generation="cmux-generation-1"
  local workspace_uuid="00000000-0000-4000-8000-000000001596"
  local surface_uuid="00000000-0000-4000-8000-000000002596" birth_command
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON=$(printf '%s' "$title" | python3 -c '
import json,sys
print(json.dumps({"workspaces":[{"ref":"workspace:1596","id":sys.argv[1],"title":sys.stdin.read()}]}))
' "$workspace_uuid")
  MOCK_CMUX_SURFACES="workspace:1596;;$surface_uuid;;terminal;;true;;$title"
  if [[ -n "$private_socket" ]]; then
    birth_command=$(build_lead_attach_command "$private_socket")
  else
    birth_command=$(build_attach_command "cmux-$title")
  fi
  fly1944_seed_session_birth "$surface_uuid" "$birth_command"
  MOCK_CMUX_READSCREEN=$'⚡ FLY-1596-implement\n[cmux attached]'
  topo_add_session "$source" '$1'
  topo_add_window "$source" '@42' "$title" 1 0
  topo_add_session "cmux-$title" '$2' "" "$source" 0
  topo_add_window "cmux-$title" '@42' "$title" 1 0
  MOCK_TMUX_CLIENTS="cmux-$title=1"
  test_ledger_upsert committed "$generation" workspace:1596 "$title" "$workspace_uuid"
}

test_fly1596_sidebar_judge_passes_only_complete_live_terminal_state() {
  echo "Test: FLY-1596 Fix 4 — sidebar judge passes the complete live terminal state"
  _fly1596_setup_healthy_sidebar_fixture
  local rc=0
  verify_sidebar_targets "FLY-1596-implement" || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$VERIFY_SIDEBAR_REPORT" == *'PASS FLY-1596-implement'* ]]; then
    pass "stable row/view/pane/client/receipt state passes the read-only judge"
  else
    fail "healthy sidebar judge mismatch rc=$rc report=[$VERIFY_SIDEBAR_REPORT]"
  fi
}

test_fly1944_sidebar_judge_marks_birthless_identity_unattributable() {
  echo "Test: FLY-1944 round-3 — birthless live workspace identity is observational, not a hard failure"
  _fly1596_setup_healthy_sidebar_fixture
  printf '%s\n' '{"windows":[]}' > "$CMUX_SESSION_STATE"
  local rc=0
  verify_sidebar_targets "FLY-1596-implement" || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 \
      && "$VERIFY_SIDEBAR_REPORT" == *'WARN FLY-1596-implement rule=receipt-uuid-unattributable'* \
      && "$VERIFY_SIDEBAR_REPORT" == *'PASS FLY-1596-implement'* \
      && "$VERIFY_SIDEBAR_REPORT" != *'FAIL FLY-1596-implement rule=receipt-uuid'* ]]; then
    pass "missing birth evidence stays visible without inventing destructive authority"
  else
    fail "birthless receipt judge mismatch rc=$rc report=[$VERIFY_SIDEBAR_REPORT]"
  fi
}

test_fly1596_sidebar_judge_ignores_live_screen_bytes_for_snapshot_stability() {
  echo "Test: FLY-1596 Fix 4 — live screen content is not cross-pass drift evidence"
  _fly1596_setup_healthy_sidebar_fixture
  local rc=0
  MOCK_CMUX_READSCREEN_SEQ='⚡ tick-one,⚡ tick-two'
  verify_sidebar_targets "FLY-1596-implement" || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$VERIFY_SIDEBAR_REPORT" == *'PASS FLY-1596-implement'* ]]; then
    pass "two non-bare renders may differ while structural authority remains stable"
  else
    fail "live screen drift manufactured an inconclusive judge rc=$rc report=[$VERIFY_SIDEBAR_REPORT]"
  fi
}

test_fly1596_sidebar_judge_localizes_render_unavailability() {
  echo "Test: FLY-1596 Fix 4 — sidebar judge localizes render unavailability"
  _fly1596_setup_healthy_sidebar_fixture
  local rc=0
  MOCK_CMUX_READSCREEN_FAIL=1
  verify_sidebar_targets "FLY-1596-implement" || rc=$?
  release_mutator_lease
  if [[ "$rc" -eq 1 && "$VERIFY_SIDEBAR_REPORT" == *'rule=render observed=unavailable'* ]]; then
    pass "an unreadable pane is a stable per-title FAIL rather than a fleet-wide inconclusive result"
  else
    fail "render failure escaped its title rc=$rc report=[$VERIFY_SIDEBAR_REPORT]"
  fi
}

test_fly1596_sidebar_judge_fails_missing_roster_lead() {
  echo "Test: FLY-1596 Fix 4 — sidebar judge fails a missing roster Lead"
  reset_mocks
  local title="growth-rafiki-lead" original_derive rc=0
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=ok
    LEAD_ROSTER_ROWS="claude-tmux|com.flywheel.lead.rafiki|growth-rafiki-lead"
  }
  MOCK_SOCK_IDENT="cmux-generation-1"
  verify_sidebar_targets "$title" || rc=$?
  eval "$original_derive"
  if [[ "$rc" -eq 1 && "$VERIFY_SIDEBAR_REPORT" == *'rule=roster-lead-absent'* ]]; then
    pass "exit 0 cannot call a loaded-but-missing Lead complete"
  else
    fail "missing roster Lead false-passed rc=$rc report=[$VERIFY_SIDEBAR_REPORT]"
  fi
}

test_fly1596_sidebar_judge_is_inconclusive_when_roster_derivation_fails() {
  echo "Test: FLY-1596 Fix 4 — global judge remains fail-closed without roster authority"
  _fly1596_setup_healthy_sidebar_fixture
  local title="FLY-1596-implement" original_derive subject_rc=0 judge_rc=0 report caveats
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() { LEAD_ROSTER_STATE=unavailable; return 1; }

  OPS_VERIFY_TARGETS="$title"
  _resolve_sidebar_subjects >/dev/null 2>&1 || subject_rc=$?
  caveats="$VERIFY_SIDEBAR_CAVEATS"
  verify_sidebar_targets "$title" >/dev/null 2>&1 || judge_rc=$?
  report="$VERIFY_SIDEBAR_REPORT"

  eval "$original_derive"
  release_mutator_lease
  if [[ "$subject_rc" -eq 0 && "$caveats" == *'roster-authority-unavailable'* \
      && "$judge_rc" -eq 2 && "$report" != *'PASS '* ]]; then
    pass "explicit runner resolution records a caveat while the global judge stays inconclusive"
  else
    fail "roster authority split mismatch subject_rc=$subject_rc caveats=[$caveats] judge_rc=$judge_rc report=[$report]"
  fi
}

test_fly1596_verify_sidebar_renders_roster_inconclusive_text_and_json() {
  echo "Test: FLY-1596 Fix 4 closeout — roster failures render named INCONCLUSIVE output"
  _fly1596_setup_healthy_sidebar_fixture
  local original_derive text_rc=0 json_rc=0 text_output json_output json_ok=0
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=indeterminate
    LEAD_ROSTER_ROWS=""
    LEAD_ROSTER_REASONS="roster-authority-unavailable: missing manifest flywheel-codex-infra-bot-lead"
    return 1
  }

  text_output=$(run_verify_sidebar 2>&1) || text_rc=$?
  json_output=$(run_verify_sidebar --json 2>/dev/null) || json_rc=$?
  if printf '%s' "$json_output" | python3 -c '
import json,sys
d=json.load(sys.stdin)
reason="roster-authority-unavailable: missing manifest flywheel-codex-infra-bot-lead"
assert d["status"] == "inconclusive"
assert d["exit_code"] == 2
assert d["reasons"] == [reason]
assert d["caveats"] == []
'; then
    json_ok=1
  fi

  eval "$original_derive"
  release_mutator_lease
  if [[ "$text_rc" -eq 2 && "$json_rc" -eq 2 && "$json_ok" -eq 1 \
      && "$text_output" == *'INCONCLUSIVE'* \
      && "$text_output" == *'missing manifest flywheel-codex-infra-bot-lead'* ]]; then
    pass "exit 2 is non-empty in both modes and names the missing authority"
  else
    fail "inconclusive renderer mismatch text_rc=$text_rc json_rc=$json_rc json_ok=$json_ok text=[$text_output] json=[$json_output]"
  fi
}

test_fly1596_verify_sidebar_target_local_authority_matrix() {
  echo "Test: FLY-1596 Fix 4 closeout — explicit targets use target-local Lead authority"
  local title="growth-rafiki-lead" unrelated="flywheel-codex-infra-bot-lead"
  local saved_loaded saved_wrapper saved_tmux_generation
  local text_rc=0 json_rc=0 absent_rc=0 own_rc=0 global_rc=0 drift_rc=0
  local text_output json_output absent_output own_output global_output drift_output json_ok=0
  local target_manifest="$FLYWHEEL_MANIFEST_DIR/${title}.json"
  local target_socket
  local drift_counter="$TMPDIR_ROOT/fly1596-target-authority-drift.n" n
  saved_loaded=$(declare -f lead_job_loaded)
  saved_wrapper=$(declare -f lead_plist_wrapper_basename)
  saved_tmux_generation=$(declare -f tmux_server_generation)
  lead_job_loaded() { return 0; }
  lead_plist_wrapper_basename() { printf '%s\n' flywheel-lead-wrapper-v2.sh; }
  target_socket=$(derive_lead_socket "growth/rafiki-lead" "${FLYWHEEL_LEAD_STATE_DIR:-$HOME/.flywheel}")

  _fly1596_setup_healthy_sidebar_fixture "$title" flywheel "$target_socket"
  MOCK_PRIVATE_TMUX_SOCKET="$target_socket"
  command rm -rf "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${title}.plist"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${unrelated}.plist"
  printf '{"projectName":"growth","leadId":"rafiki-lead","leadBackend":{"backendId":"claude-code"},"socketPath":"%s"}\n' "$target_socket" > "$target_manifest"
  text_output=$(run_verify_sidebar --target "$title" 2>&1) || text_rc=$?
  json_output=$(run_verify_sidebar --target "$title" --json 2>/dev/null) || json_rc=$?
  if printf '%s' "$json_output" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["status"] == "pass" and d["exit_code"] == 0
assert d["reasons"] == []
assert d["caveats"] == ["roster-authority-unavailable: missing manifest flywheel-codex-infra-bot-lead"]
'; then
    json_ok=1
  fi

  reset_mocks
  command rm -rf "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${title}.plist"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${unrelated}.plist"
  printf '{"projectName":"growth","leadId":"rafiki-lead","leadBackend":{"backendId":"claude-code"},"socketPath":"%s"}\n' "$target_socket" > "$target_manifest"
  MOCK_SOCK_IDENT="cmux-generation-1"
  absent_output=$(run_verify_sidebar --target "$title" 2>&1) || absent_rc=$?

  reset_mocks
  command rm -rf "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${title}.plist"
  MOCK_SOCK_IDENT="cmux-generation-1"
  own_output=$(run_verify_sidebar --target "$title" 2>&1) || own_rc=$?

  _fly1596_setup_healthy_sidebar_fixture "$title" flywheel "$target_socket"
  command rm -rf "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${title}.plist"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${unrelated}.plist"
  printf '{"projectName":"growth","leadId":"rafiki-lead","leadBackend":{"backendId":"claude-code"},"socketPath":"%s"}\n' "$target_socket" > "$target_manifest"
  global_output=$(run_verify_sidebar 2>&1) || global_rc=$?

  _fly1596_setup_healthy_sidebar_fixture "$title" flywheel "$target_socket"
  command rm -rf "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  : > "$FLYWHEEL_LEAD_PLIST_DIR/com.flywheel.lead.${title}.plist"
  printf '{"projectName":"growth","leadId":"rafiki-lead","leadBackend":{"backendId":"claude-code"},"socketPath":"%s"}\n' "$target_socket" > "$target_manifest"
  : > "$drift_counter"
  tmux_server_generation() {
    n=$(wc -l < "$drift_counter" | tr -d ' ')
    printf 'x\n' >> "$drift_counter"
    if [[ "$n" -eq 1 ]]; then
      printf '{"projectName":"growth","leadId":"rafiki-lead","leadBackend":{"backendId":"claude-code"},"socketPath":"%s","revision":2}\n' "$target_socket" > "$target_manifest"
    fi
    printf '%s\n' tmux-test-generation
  }
  drift_output=$(run_verify_sidebar --target "$title" 2>&1) || drift_rc=$?

  eval "$saved_loaded"
  eval "$saved_wrapper"
  eval "$saved_tmux_generation"
  command rm -rf "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  mkdir -p "$FLYWHEEL_LEAD_PLIST_DIR" "$FLYWHEEL_MANIFEST_DIR"
  release_mutator_lease
  if [[ "$text_rc" -eq 0 && "$json_rc" -eq 0 && "$json_ok" -eq 1 \
      && "$text_output" == *"PASS $title"* \
      && "$text_output" == *"CAVEAT roster-authority-unavailable: missing manifest $unrelated"* \
      && "$absent_rc" -eq 1 && "$absent_output" == *'rule=v2-row expected=one-named observed=named:0,mapped:0'* \
      && "$own_rc" -eq 2 && "$own_output" == *"target-authority-unavailable: missing manifest $title"* \
      && "$global_rc" -eq 2 && "$global_output" == *"roster-authority-unavailable: missing manifest $unrelated"* \
      && "$drift_rc" -eq 2 && "$drift_output" == *'snapshot-drift'* ]]; then
    pass "the five-cell target/global authority matrix is fail-closed without unrelated-roster coupling"
  else
    fail "target authority matrix mismatch text=$text_rc json=$json_rc json_ok=$json_ok absent=$absent_rc own=$own_rc global=$global_rc drift=$drift_rc text=[$text_output] absent_out=[$absent_output] own_out=[$own_output] global_out=[$global_output] drift_out=[$drift_output]"
  fi
}

test_fly1596_verify_sidebar_rejects_unknown_runner_target() {
  echo "Test: FLY-1596 QA R3 — explicit runner targets require independent evidence"
  reset_mocks
  local title="FLY-1596-implement-typo" text_rc=0 json_rc=0
  local text_output json_output json_ok=0
  MOCK_SOCK_IDENT="cmux-generation-1"

  text_output=$(run_verify_sidebar --target "$title" 2>&1) || text_rc=$?
  json_output=$(run_verify_sidebar --target "$title" --json 2>/dev/null) || json_rc=$?
  if printf '%s' "$json_output" | python3 -c '
import json,sys
d=json.load(sys.stdin)
reason="target-unknown: no independent runner evidence FLY-1596-implement-typo"
assert d["status"] == "inconclusive" and d["exit_code"] == 2
assert d["reasons"] == [reason] and d["caveats"] == []
'; then
    json_ok=1
  fi

  if [[ "$text_rc" -eq 2 && "$json_rc" -eq 2 && "$json_ok" -eq 1 \
      && "$text_output" == *"INCONCLUSIVE target-unknown: no independent runner evidence $title"* ]]; then
    pass "argv runner grammar cannot make an unknown title PASS absent"
  else
    fail "unknown runner target escaped text_rc=$text_rc json_rc=$json_rc json_ok=$json_ok text=[$text_output] json=[$json_output]"
  fi
}

test_fly1596_sidebar_judge_rejects_each_false_pass_family() {
  echo "Test: FLY-1596 Fix 4 — sidebar judge rejects false-pass families"
  local rc missing grouped grouped_report clients receipt marker malformed ok=1 title="FLY-1596-implement"
  local title_b64 orig_b64 fingerprint epoch

  _fly1596_setup_healthy_sidebar_fixture
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; missing=$rc
  release_mutator_lease

  _fly1596_setup_healthy_sidebar_fixture
  topo_set_session_field "cmux-$title" 3 runner-flywheel
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; grouped=$rc
  grouped_report="$VERIFY_SIDEBAR_REPORT"
  release_mutator_lease

  _fly1596_setup_healthy_sidebar_fixture
  MOCK_TMUX_CLIENTS="cmux-$title=0"
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; clients=$rc
  release_mutator_lease

  _fly1596_setup_healthy_sidebar_fixture
  printf 'prepared|cmux-generation-1|workspace:1596|%s\n' "$title" > "$VIEW_LEDGER"
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; receipt=$rc
  release_mutator_lease

  _fly1596_setup_healthy_sidebar_fixture
  title_b64=$(printf '%s' "$title" | base64 | tr -d '\n')
  orig_b64=$(printf 'none|cmux-generation-1|workspace:1596|%s' "$title" | base64 | tr -d '\n')
  fingerprint=$(printf '%064d' 0); epoch=$(date +%s)
  printf 'restoredv1|W1|cmux-generation-1|workspace:1596|%s|%s|%s|%s\n' \
    "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; marker=$rc
  printf 'malformed\n' > "$RESTORED_STATE"
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; malformed=$rc
  release_mutator_lease

  [[ "$missing" == 1 && "$grouped" == 1 && "$clients" == 1 \
      && "$receipt" == 1 && "$marker" == 1 && "$malformed" == 2 \
      && "$grouped_report" == *'rule=client-count observed=not-measured'* \
      && "$grouped_report" != *'rule=client-count observed=0'* ]] || ok=0
  if [[ "$ok" == "1" ]]; then
    pass "missing row, grouped topology, zero client, bad receipt, marker, and malformed state all fail distinctly"
  else
    fail "sidebar false-pass matrix mismatch missing=$missing grouped=$grouped clients=$clients receipt=$receipt marker=$marker malformed=$malformed grouped_report=[$grouped_report]"
  fi
}

test_fly1596_sidebar_judge_covers_stale_markers_render_and_roster_drift() {
  echo "Test: FLY-1596 Fix 4 — stale markers, bare render, and roster drift cannot false-pass"
  local title="FLY-1596-implement" title_b64 orig_b64 fingerprint epoch rc=0 stale bare drift dead
  local saved_roster calls="$TMPDIR_ROOT/fly1596-roster-calls"

  _fly1596_setup_healthy_sidebar_fixture
  title_b64=$(printf '%s' "$title" | base64 | tr -d '\n')
  orig_b64=$(printf 'none|old-generation|workspace:999|%s' "$title" | base64 | tr -d '\n')
  fingerprint=$(printf '%064d' 0); epoch=$(date +%s)
  printf 'restoredv1|W1|old-generation|workspace:999|%s|%s|%s|%s\n' \
    "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; stale=$rc
  release_mutator_lease

  _fly1596_setup_healthy_sidebar_fixture
  MOCK_CMUX_READSCREEN='user@host ~ %'
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; bare=$rc
  release_mutator_lease

  _fly1596_setup_healthy_sidebar_fixture
  saved_roster=$(declare -f derive_lead_roster)
  : > "$calls"
  derive_lead_roster() {
    local n=0
    [[ -f "$calls" ]] && n=$(wc -l < "$calls" | tr -d ' ')
    echo x >> "$calls"
    LEAD_ROSTER_STATE=ok
    if (( n == 0 )); then
      LEAD_ROSTER_ROWS='claude-tmux|com.flywheel.lead.a|FLY-1596-a'
    else
      LEAD_ROSTER_ROWS='claude-tmux|com.flywheel.lead.b|FLY-1596-b'
    fi
  }
  rc=0; verify_sidebar_targets "$title" >/dev/null 2>&1 || rc=$?; drift=$rc
  eval "$saved_roster"
  release_mutator_lease

  reset_mocks
  MOCK_SOCK_IDENT=cmux-generation-1
  saved_roster=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=ok
    LEAD_ROSTER_ROWS='claude-tmux|com.flywheel.lead.dead|FLY-1596-dead'
  }
  title_b64=$(printf '%s' FLY-1596-dead | base64 | tr -d '\n')
  orig_b64=$(printf 'none|old-generation|workspace:998|FLY-1596-dead' | base64 | tr -d '\n')
  printf 'restoredv1|W1dead|old-generation|workspace:998|%s|%s|%s|%s\n' \
    "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  rc=0; verify_sidebar_targets FLY-1596-dead >/dev/null 2>&1 || rc=$?; dead=$rc
  eval "$saved_roster"

  if [[ "$stale" == 1 && "$bare" == 1 && "$drift" == 2 && "$dead" == 1 ]]; then
    pass "current/stale/dead restored markers fail, bare shells fail, and same-generation roster drift is inconclusive"
  else
    fail "expanded sidebar judge mismatch stale=$stale bare=$bare drift=$drift dead=$dead"
  fi
}

test_fly1596_rebuild_parser_rejects_before_any_ipc() {
  echo "Test: FLY-1596 Fix 3 — rebuild argv validation is complete before IPC"
  reset_mocks
  local calls="$TMPDIR_ROOT/fly1596-parser-ipc" rc=0 valid_rc=0
  local saved_roster saved_snapshot saved_cmux saved_lease
  : > "$calls"
  saved_roster=$(declare -f derive_lead_roster)
  saved_snapshot=$(declare -f strict_agent_window_snapshot)
  saved_cmux=$(declare -f get_cmux_workspaces_json)
  saved_lease=$(declare -f acquire_mutator_lease)
  derive_lead_roster() { echo roster >> "$calls"; return 1; }
  strict_agent_window_snapshot() { echo tmux >> "$calls"; return 2; }
  get_cmux_workspaces_json() { echo cmux >> "$calls"; return 1; }
  acquire_mutator_lease() { echo lease >> "$calls"; return 1; }

  parse_rebuild_views_args --target FLY-1596-implement --target FLY-1596-implement \
    --execute --handover >/dev/null 2>&1 || rc=$?
  parse_rebuild_views_args --target 'bad|title' >/dev/null 2>&1 || true
  parse_rebuild_views_args --all-leads --target FLY-1596-implement >/dev/null 2>&1 || true
  parse_rebuild_views_args --target FLY-1596-implement --execute --handover \
    >/dev/null 2>&1 || valid_rc=$?

  eval "$saved_roster"; eval "$saved_snapshot"; eval "$saved_cmux"; eval "$saved_lease"
  if [[ "$rc" -ne 0 && "$valid_rc" -eq 0 && ! -s "$calls" \
      && "$OPS_REBUILD_TARGET_SPECS" == 'FLY-1596-implement|' \
      && "$OPS_REBUILD_EXECUTE" == 1 && "$OPS_REBUILD_HANDOVER" == 1 ]]; then
    pass "duplicate/conflicting/unsafe argv fail lexically; a valid target+handover parses without IPC"
  else
    fail "rebuild parser crossed its lexical boundary rc=$rc valid_rc=$valid_rc calls=[$(tr '\n' ';' < "$calls")] specs=[$OPS_REBUILD_TARGET_SPECS]"
  fi
}

test_fly1596_ops_resolution_falls_back_to_live_leads_when_roster_is_partial() {
  echo "Test: FLY-1596 Fix 3/4 — rebuild fallback stays usable but verification requires roster authority"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  local title="growth-rafiki-lead" generation="cmux-generation-1" original_derive rc=0 verify_rc=0
  local workspace_uuid="00000000-0000-4000-8000-000000001596"
  local surface_uuid="00000000-0000-4000-8000-000000002596" birth_command
  original_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() { LEAD_ROSTER_STATE=unavailable; return 1; }
  MOCK_SOCK_IDENT="$generation"
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1596\",\"id\":\"$workspace_uuid\",\"title\":\"growth-rafiki-lead\"}]}"
  MOCK_CMUX_SURFACES="workspace:1596;;$surface_uuid;;terminal;;true;;$title"
  birth_command=$(build_attach_command "cmux-$title")
  fly1944_seed_session_birth "$surface_uuid" "$birth_command"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$title" 1 0

  parse_rebuild_views_args --all-leads || rc=$?
  resolve_rebuild_targets || rc=$?
  OPS_VERIFY_TARGETS="$title"
  _resolve_sidebar_subjects || verify_rc=$?
  eval "$original_derive"
  if [[ "$rc" -eq 0 && "$verify_rc" -eq 2 \
      && "$OPS_REBUILD_RESOLVED" == "$title||runner-flywheel|@42|workspace:1596|W1|"* ]]; then
    pass "live Lead titles keep rebuild planning operable while verification stays inconclusive"
  else
    fail "partial roster boundary mismatch rc=$rc verify_rc=$verify_rc resolved=[$OPS_REBUILD_RESOLVED]"
  fi
}

test_fly1596_ops_claim_is_self_bound_and_qa_exclusive() {
  echo "Test: FLY-1596 Fix 3 — ops handover claim is self-bound and QA-exclusive"
  reset_mocks
  local incarnation rc_qa=0 rc_self=0 rc_foreign=0
  incarnation=$(_process_incarnation "$$") || { fail "cannot derive fixture incarnation"; return; }
  printf '%s|%s|qa_teardown|qa-nonce\n' "$$" "$incarnation" > "$CMUX_QA_TEARDOWN_CLAIM"
  publish_ops_rebuild_claim >/dev/null 2>&1 || rc_qa=$?
  rm -f "$CMUX_QA_TEARDOWN_CLAIM"
  publish_ops_rebuild_claim >/dev/null 2>&1 || rc_self=$?
  maintenance_entry_allowed ops_rebuild >/dev/null 2>&1 || rc_self=$?
  printf '999999|foreign|ops_rebuild|foreign-nonce\n' > "$CMUX_OPS_REBUILD_CLAIM"
  maintenance_entry_allowed ops_rebuild >/dev/null 2>&1 || rc_foreign=$?
  release_ops_rebuild_claim >/dev/null 2>&1 || true

  if [[ "$rc_qa" -ne 0 && "$rc_self" -eq 0 && "$rc_foreign" -ne 0 \
      && -f "$CMUX_OPS_REBUILD_CLAIM" ]]; then
    pass "QA wins first-claim ordering; only the byte-exact ops owner receives the maintenance exception"
  else
    fail "ops claim authority mismatch qa=$rc_qa self=$rc_self foreign=$rc_foreign claim=[$(cat "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null)]"
  fi
}

test_fly1596_ops_mode_is_a_known_mutator_everywhere() {
  echo "Test: FLY-1596 Fix 3 — ops rebuild is enumerated by lease, census, and teardown"
  reset_mocks
  local lease_rc=0 census_rc=0 owner_mode teardown_modes
  acquire_mutator_lease ops_rebuild || lease_rc=$?
  owner_mode=$(cut -d'|' -f3 "$WATCHER_LOCK_DIR/owner" 2>/dev/null || true)
  cmux_mutator_command_matches '/bin/bash /tmp/flywheel-cmux-sync.sh --rebuild-views --target FLY-1596-implement --execute' \
    || census_rc=$?
  teardown_modes=$(sed -n '/case "$CMUX_OWNER_MODE"/,/esac/p' "$SCRIPT_DIR/test-teardown.sh")
  release_mutator_lease
  if [[ "$lease_rc" -eq 0 && "$census_rc" -eq 0 && "$owner_mode" == ops_rebuild \
      && "$teardown_modes" == *ops_rebuild* ]]; then
    pass "no process census or teardown grammar can misclassify a live ops mutator"
  else
    fail "ops mode enumeration incomplete lease=$lease_rc census=$census_rc owner=$owner_mode teardown=[$teardown_modes]"
  fi
}

test_fly1596_ops_create_bypass_is_exact_and_lease_bound() {
  echo "Test: FLY-1596 Fix 3 — create TTL bypass requires the exact leased ops target"
  reset_mocks
  local unleased=0 wrong=0 exact=0
  OPS_REBUILD_TARGETS='FLY-1596-implement|workspace:1596|runner-flywheel|@42'
  OPS_REBUILD_ACTIVE_TARGET='FLY-1596-implement|workspace:1596|runner-flywheel|@42'
  ops_rebuild_authorizes_create runner-flywheel @42 FLY-1596-implement || unleased=$?
  acquire_mutator_lease ops_rebuild >/dev/null 2>&1 || true
  ops_rebuild_authorizes_create runner-flywheel @43 FLY-1596-implement || wrong=$?
  ops_rebuild_authorizes_create runner-flywheel @42 FLY-1596-implement || exact=$?
  release_mutator_lease
  if [[ "$unleased" -ne 0 && "$wrong" -ne 0 && "$exact" -eq 0 ]]; then
    pass "resident and neighboring targets retain the TTL; only the exact ops tuple can bypass it"
  else
    fail "ops create bypass widened unleased=$unleased wrong=$wrong exact=$exact"
  fi
}

test_fly1596_rebuild_dry_run_and_exact_ref_are_read_only() {
  echo "Test: FLY-1596 Fix 3 — semantic dry-run and bad exact-ref remain read-only"
  _fly1596_setup_healthy_sidebar_fixture
  release_mutator_lease
  : > "$TOPO_JOURNAL"; MOCK_CMUX_OPS=""
  local dry_rc=0 exact_rc=0 mutation_count report_count
  run_rebuild_views --target FLY-1596-implement >/dev/null 2>&1 || dry_rc=$?
  run_rebuild_views --target FLY-1596-implement=workspace:999 >/dev/null 2>&1 || exact_rc=$?
  mutation_count=$(grep -Ec '^(new-session|link-window|unlink-window|rename-session|kill-window|kill-session)' "$TOPO_JOURNAL" || true)
  report_count=$(find "$CMUX_REBUILD_REPORT_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$dry_rc" -eq 0 && "$exact_rc" -ne 0 && "$mutation_count" == 0 \
      && -z "$MOCK_CMUX_OPS" && ! -d "$WATCHER_LOCK_DIR" \
      && ! -e "$CMUX_OPS_REBUILD_CLAIM" && "$report_count" == 0 ]]; then
    pass "phase-B planning reads truth but creates no lease/claim/report and rejects an unreachable exact ref"
  else
    fail "dry-run boundary mismatch dry=$dry_rc exact=$exact_rc mutations=$mutation_count ops=[$MOCK_CMUX_OPS] lock=$([[ -d "$WATCHER_LOCK_DIR" ]] && echo yes || echo no) reports=$report_count"
  fi
}

test_fly1596_rebuild_executes_grouped_to_verified_a1_and_preserves_out_of_scope_marker() {
  echo "Test: FLY-1596 Fix 3 — production generation converges one grouped target and preserves unrelated in-flight state"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1; FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1; MOCK_CMUX_MUTATE_SURFACES=1; MOCK_SOCK_IDENT=cmux-generation-1
  FLYWHEEL_CMUX_OPS_REPROBE_SECONDS=0
  local title=FLY-1596-implement other=FLY-1596-other title_b64 orig_b64 fingerprint epoch rc=0
  local saved_tmux_generation="$FLYWHEEL_CMUX_TMUX_GENERATION" saved_derive
  local production_tmux_generation='/private/tmp/tmux-501/default|51104|Wed Aug  5 07:00:00 2026'
  local expected_inventory_generation inventory_generation
  local workspace_uuid="00000000-0000-4000-8000-000000001596"
  local surface_uuid="00000000-0000-4000-8000-000000002596" birth_command
  expected_inventory_generation="sha256:$(printf '%s' "$production_tmux_generation" | shasum -a 256 | awk '{print $1}')"
  FLYWHEEL_CMUX_TMUX_GENERATION="$production_tmux_generation"
  topo_add_session runner-flywheel '$1'
  topo_add_window runner-flywheel '@42' "$title" 1 0
  tmux new-session -d -t runner-flywheel -s "cmux-$title"
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1596\",\"id\":\"$workspace_uuid\",\"title\":\"FLY-1596-implement\"}]}"
  MOCK_CMUX_SURFACES="workspace:1596;;$surface_uuid;;terminal;;true;;$title"
  birth_command=$(build_attach_command "cmux-$title")
  fly1944_seed_session_birth "$surface_uuid" "$birth_command"
  MOCK_CMUX_READSCREEN=$'⚡ FLY-1596-implement\n[cmux attached]'
  MOCK_TMUX_CLIENTS="cmux-$title=1"
  test_ledger_upsert committed cmux-generation-1 workspace:1596 "$title" "$workspace_uuid"
  release_mutator_lease
  printf '%s|%s|%s\n' "$title" '@42' "$(date +%s)" > "$CREATE_STATE"
  title_b64=$(printf '%s' "$other" | base64 | tr -d '\n')
  orig_b64=$(printf 'none|old-generation|workspace:999|%s' "$other" | base64 | tr -d '\n')
  fingerprint=$(printf '%064d' 0); epoch=$(date +%s)
  printf 'restoredv1|W1|old-generation|workspace:999|%s|%s|%s|%s\n' \
    "$title_b64" "$orig_b64" "$fingerprint" "$epoch" > "$RESTORED_STATE"
  local marker_before
  marker_before=$(cat "$RESTORED_STATE")
  saved_derive=$(declare -f derive_lead_roster)
  derive_lead_roster() {
    LEAD_ROSTER_STATE=indeterminate
    LEAD_ROSTER_ROWS=""
    LEAD_ROSTER_REASONS="roster-authority-unavailable: missing manifest unrelated-lead"
    return 1
  }

  run_rebuild_views --target "$title=workspace:1596" --execute >/dev/null 2>&1 || rc=$?
  eval "$saved_derive"
  inventory_generation=$(awk -F'|' '$6 == "committed" { print $1; exit }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  FLYWHEEL_CMUX_TMUX_GENERATION="$saved_tmux_generation"
  if [[ "$rc" -eq 0 && "$VERIFY_SIDEBAR_REPORT" == *"PASS $title"* \
      && "$inventory_generation" == "$expected_inventory_generation" \
      && "$(cat "$RESTORED_STATE")" == "$marker_before" \
      && "$(awk -F'|' -v t="$title" '$1 == "committed" && $2 == "cmux-generation-1" && $3 ~ /^workspace:[0-9]+$/ && $4 == t { n++ } END { print n+0 }' "$VIEW_LEDGER")" == 1 \
      && ! -d "$WATCHER_LOCK_DIR" && -n "$OPS_REBUILD_REPORT_PATH" \
      && -f "$OPS_REBUILD_REPORT_PATH" ]]; then
    pass "grouped receipt is retired, TTL is bypassed only for the target, A1 verifies, and target-B marker bytes survive"
  else
    fail "ops grouped convergence mismatch rc=$rc verify=[$VERIFY_SIDEBAR_REPORT] inventory_generation=[$inventory_generation] expected_inventory_generation=[$expected_inventory_generation] marker=[$(cat "$RESTORED_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] report=[$OPS_REBUILD_REPORT_PATH] ops=[$MOCK_CMUX_OPS]"
  fi
  unset FLYWHEEL_CMUX_OPS_REPROBE_SECONDS
}

test_fly1596_handover_yields_then_revalidates_before_mutation() {
  echo "Test: FLY-1596 Fix 3 — handover waits for watcher yield and revalidates after lease acquisition"
  local rc_ok=0 rc_drift=0 sleeps_ok claim_ok drift_ops drift_ledger

  _fly1596_setup_healthy_sidebar_fixture
  release_mutator_lease
  acquire_mutator_lease watch >/dev/null 2>&1 || { fail "cannot create watcher lease fixture"; return; }
  MOCK_SLEEP_HOOK='rm -rf "$WATCHER_LOCK_DIR"; MUTATOR_LEASE_NONCE=""; MUTATOR_LEASE_INCARNATION=""; MUTATOR_LEASE_MODE=""; MOCK_SLEEP_HOOK=""'
  run_rebuild_views --target FLY-1596-implement --execute --handover >/dev/null 2>&1 || rc_ok=$?
  sleeps_ok="$MOCK_SLEEPS"
  claim_ok=0
  [[ ! -e "$CMUX_OPS_REBUILD_CLAIM" && ! -d "$WATCHER_LOCK_DIR" ]] && claim_ok=1

  _fly1596_setup_healthy_sidebar_fixture
  release_mutator_lease
  acquire_mutator_lease watch >/dev/null 2>&1 || { fail "cannot create drift watcher lease fixture"; return; }
  MOCK_CMUX_OPS=""
  MOCK_SLEEP_HOOK='MOCK_CMUX_WORKSPACES_JSON='"'"'{"workspaces":[]}'"'"'; rm -rf "$WATCHER_LOCK_DIR"; MUTATOR_LEASE_NONCE=""; MUTATOR_LEASE_INCARNATION=""; MUTATOR_LEASE_MODE=""; MOCK_SLEEP_HOOK=""'
  run_rebuild_views --target FLY-1596-implement --execute --handover >/dev/null 2>&1 || rc_drift=$?
  drift_ops="$MOCK_CMUX_OPS"
  drift_ledger=$(cat "$VIEW_LEDGER" 2>/dev/null || true)

  if [[ "$rc_ok" -eq 0 && "$sleeps_ok" -ge 1 && "$claim_ok" == 1 \
      && "$rc_drift" -ne 0 && -z "$drift_ops" \
      && "$drift_ledger" == 'committed|cmux-generation-1|workspace:1596|FLY-1596-implement|00000000-0000-4000-8000-000000001596' \
      && ! -e "$CMUX_OPS_REBUILD_CLAIM" && ! -d "$WATCHER_LOCK_DIR" ]]; then
    pass "watcher-held lease yields to the self claim; handoff drift aborts before cmux or ledger mutation"
  else
    fail "handover contract mismatch ok=$rc_ok sleeps=$sleeps_ok claim=$claim_ok drift=$rc_drift ops=[$drift_ops] ledger=[$drift_ledger]"
  fi
}

test_fly1596_log_episodes_are_bounded_stateful_and_reversible() {
  echo "Test: FLY-1596 Fix 5 — log episodes emit transitions, summarize repeats, and support byte-compat mode"
  reset_mocks
  test_ensure_mutator_lease || { fail "cannot acquire log episode fixture lease"; return; }
  local log_file="$TMPDIR_ROOT/fly1596-log-episodes.log" first_count changed_count summary_count suppressed
  local zero_file="$TMPDIR_ROOT/fly1596-log-episodes-zero.log" zero_count rows
  : > "$log_file"
  FLYWHEEL_CMUX_LOG_REPEAT_SECONDS=3600
  log_cmux_episode view-invariant-mismatch FLY-1596-implement evidence-a \
    'Invariant mismatch: cmux-FLY-1596-implement grouped=1' 2>>"$log_file"
  log_cmux_episode view-invariant-mismatch FLY-1596-implement evidence-a \
    'Invariant mismatch: cmux-FLY-1596-implement grouped=1' 2>>"$log_file"
  log_cmux_episode view-invariant-mismatch FLY-1596-implement evidence-a \
    'Invariant mismatch: cmux-FLY-1596-implement grouped=1' 2>>"$log_file"
  first_count=$(grep -cF 'Invariant mismatch: cmux-FLY-1596-implement grouped=1' "$log_file" || true)
  suppressed=$(awk -F'|' '$1 == "view-invariant-mismatch" && $2 == "FLY-1596-implement" { print $5 }' "$CMUX_LOG_EPISODE_STATE")

  log_cmux_episode view-invariant-mismatch FLY-1596-implement evidence-b \
    'Invariant mismatch: cmux-FLY-1596-implement grouped=0 active=@99' 2>>"$log_file"
  changed_count=$(grep -cF 'grouped=0 active=@99' "$log_file" || true)
  awk -F'|' -v OFS='|' '{ $4=1; $5=2; print }' "$CMUX_LOG_EPISODE_STATE" > "${CMUX_LOG_EPISODE_STATE}.old"
  mv "${CMUX_LOG_EPISODE_STATE}.old" "$CMUX_LOG_EPISODE_STATE"
  log_cmux_episode view-invariant-mismatch FLY-1596-implement evidence-b \
    'Invariant mismatch: cmux-FLY-1596-implement grouped=0 active=@99' 2>>"$log_file"
  summary_count=$(grep -cF '(suppressed 2 repeats)' "$log_file" || true)

  log_cmux_episode legacy-grouped-refused FLY-1596-implement missing-receipt \
    'WARN: legacy grouped migration refused for FLY-1596-implement; no exact receipt' 2>>"$log_file"
  rows=$(wc -l < "$CMUX_LOG_EPISODE_STATE" | tr -d ' ')
  clear_cmux_log_episodes_for_title FLY-1596-implement

  : > "$zero_file"
  FLYWHEEL_CMUX_LOG_REPEAT_SECONDS=0
  log_cmux_episode view-invariant-mismatch FLY-1596-zero same 'Invariant mismatch: zero' 2>>"$zero_file"
  log_cmux_episode view-invariant-mismatch FLY-1596-zero same 'Invariant mismatch: zero' 2>>"$zero_file"
  zero_count=$(grep -cF 'Invariant mismatch: zero' "$zero_file" || true)
  release_mutator_lease
  unset FLYWHEEL_CMUX_LOG_REPEAT_SECONDS

  if [[ "$first_count" == 1 && "$suppressed" == 2 && "$changed_count" == 1 \
      && "$summary_count" == 1 && "$rows" == 2 && ! -s "$CMUX_LOG_EPISODE_STATE" \
      && "$zero_count" == 2 ]]; then
    pass "first/change/hourly-summary stay visible, per-kind rows are bounded, healthy clears, and repeat=0 logs every call"
  else
    fail "log episode contract mismatch first=$first_count suppressed=$suppressed changed=$changed_count summary=$summary_count rows=$rows state=[$(cat "$CMUX_LOG_EPISODE_STATE" 2>/dev/null)] zero=$zero_count"
  fi
}

test_fly1272_p1_generalized_mutator_lease() {
  echo "Test: FLY-1272 P1 — generalized mutator lease records incarnation/mode/nonce and releases owner-only"
  reset_mocks
  local rc=0 owner saved_nonce
  acquire_mutator_lease once || rc=$?
  owner=$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" 2>/dev/null || true)
  saved_nonce="${MUTATOR_LEASE_NONCE:-}"
  if [[ "$rc" -eq 0 && "$(awk -F'|' '{print NF}' <<< "$owner")" == "4" \
      && "$(cut -d'|' -f3 <<< "$owner")" == "once" ]] \
      && assert_or_reuse_owned_lease; then
    pass "lease identity is externally verifiable and nested prologue reuses its own lease"
  else
    fail "lease record/reuse mismatch rc=$rc owner=[$owner]"
  fi
  MUTATOR_LEASE_NONCE="not-the-owner"
  release_mutator_lease
  if [[ -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "wrong nonce cannot release another owner's lease"
  else
    fail "wrong nonce removed the mutator lease"
  fi
  MUTATOR_LEASE_NONCE="$saved_nonce"
  release_mutator_lease
  [[ ! -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]] \
    && pass "matching pid+incarnation+nonce releases lease" \
    || fail "matching owner failed to release lease"
}

test_fly1272_p1_probe_lease_fail_closed_on_malformed_record() {
  echo "Test: FLY-1272 P1 — read-only lease probe rejects malformed/stale-present state"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf 'truncated\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  : > "$TOPO_JOURNAL"
  local rc=0
  probe_mutator_lease || rc=$?
  if [[ "$rc" -ne 0 && -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "probe never steals or clears an unprovable lease"
  else
    fail "malformed lease probe returned success or mutated lock rc=$rc"
  fi
}

test_fly1272_maintenance_marker_blocks_oneshot_without_locking() {
  echo "Test: FLY-1272 P1 — maintenance marker makes one-shot release its lease without mutation"
  reset_mocks
  touch "$CMUX_MAINTENANCE_MARKER"
  local rc=0 mutation_probe="$TMPDIR_ROOT/maintenance-mutation"
  maintenance_mutator_probe() { touch "$mutation_probe"; }
  run_mutator_once once maintenance_mutator_probe || rc=$?
  unset -f maintenance_mutator_probe
  if [[ "$rc" -eq 0 && ! -e "$mutation_probe" && ! -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "maintenance window is non-holding for one-shot mutators"
  else
    fail "maintenance one-shot gate held lease or invoked mutation rc=$rc mutation=$([[ -e "$mutation_probe" ]] && echo yes || echo no)"
  fi
}

test_fly1482_qa_claim_blocks_oneshot_without_mutation() {
  echo "Test: FLY-1482 — QA yield claim makes one-shot release without mutation"
  reset_mocks
  printf '%s|%s|qa_teardown|claim-nonce\n' "$$" "$FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE" \
    > "$CMUX_QA_TEARDOWN_CLAIM"
  local rc=0 mutation_probe="$TMPDIR_ROOT/claim-mutation"
  fly1482_claim_mutation_probe() { touch "$mutation_probe"; }
  run_mutator_once once fly1482_claim_mutation_probe || rc=$?
  unset -f fly1482_claim_mutation_probe
  if [[ "$rc" -eq 0 && ! -e "$mutation_probe" \
      && ! -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" && -f "$CMUX_QA_TEARDOWN_CLAIM" ]]; then
    pass "one-shot observes the unified maintenance predicate and never consumes the QA claim"
  else
    fail "claim gate mutated or retained lease rc=$rc mutation=$([[ -e "$mutation_probe" ]] && echo yes || echo no)"
  fi
}

test_fly1482_stale_claim_reap_is_fenced_and_two_observation() {
  echo "Test: FLY-1482 — dead QA claim needs two observations and a free kernel fence"
  reset_mocks
  printf '999999|dead-incarnation|qa_teardown|dead-claim\n' > "$CMUX_QA_TEARDOWN_CLAIM"
  local first_rc=0 second_rc=0
  _reap_stale_qa_teardown_claim || first_rc=$?
  [[ -f "$CMUX_QA_TEARDOWN_CLAIM" ]] || first_rc=99
  _reap_stale_qa_teardown_claim || second_rc=$?
  if [[ "$first_rc" -eq 1 && "$second_rc" -eq 0 && ! -e "$CMUX_QA_TEARDOWN_CLAIM" ]]; then
    pass "one dead observation preserves; the second free-fence observation reaps"
  else
    fail "stale claim decision mismatch first=$first_rc second=$second_rc present=$([[ -e "$CMUX_QA_TEARDOWN_CLAIM" ]] && echo yes || echo no)"
  fi
}

test_fly1482_malformed_claim_fails_closed() {
  echo "Test: FLY-1482 — malformed QA claim remains parked and operator-visible"
  reset_mocks
  printf 'malformed\n' > "$CMUX_QA_TEARDOWN_CLAIM"
  local rc=0 log_file="$TMPDIR_ROOT/malformed-qa-claim.log"
  _reap_stale_qa_teardown_claim 2>"$log_file" || rc=$?
  if [[ "$rc" -eq 2 && -f "$CMUX_QA_TEARDOWN_CLAIM" \
      && "$(cat "$log_file")" == *"malformed"* ]]; then
    pass "malformed claim authorizes zero deletion and emits a fail-closed warning"
  else
    fail "malformed claim was not preserved rc=$rc log=[$(cat "$log_file")]"
  fi
}

test_fly1482_owner_and_self_verification_share_timezone_stable_identity() {
  echo "Test: FLY-1482 — outward owner and inward self-verification cannot disagree across TZ"
  reset_mocks
  FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE=""
  MOCK_PS_MODE="tz-sensitive-lstart"
  eval "$(declare -f _fly1605_ps_mock | sed '1s/_fly1605_ps_mock/ps/')"
  local acquire_rc=0 external_rc=0 self_rc=0
  TZ=Asia/Tokyo acquire_mutator_lease watch || acquire_rc=$?
  TZ=America/Denver _read_mutator_owner || external_rc=$?
  if [[ "$external_rc" -eq 0 ]]; then
    TZ=America/Denver _owner_process_matches || external_rc=$?
  fi
  TZ=America/Denver mutator_lease_owned_by_self || self_rc=$?
  release_mutator_lease
  if [[ "$acquire_rc" -eq 0 && "$external_rc" -eq 0 && "$self_rc" -eq 0 ]]; then
    pass "the same UTC-pinned identity proves both external liveness and internal authority"
  else
    fail "ownership predicates diverged acquire=$acquire_rc external=$external_rc self=$self_rc"
  fi
}

test_fly1482_watcher_authority_loss_exits_on_third_pass() {
  echo "Test: FLY-1482 — watcher exits fail-loud after three mid-pass authority-loss passes"
  reset_mocks
  local rc=0 log_file="$TMPDIR_ROOT/watcher-authority-loss.log" survived="$TMPDIR_ROOT/watcher-survived"
  (
    acquire_mutator_lease watch
    for i in 1 2 3; do
      # Each pass starts with valid authority, then loses it before its first
      # mutation. This is the production contradiction FLY-1482 must heal;
      # testing only a bad pass-start would miss loss inside a long reconcile.
      printf '%s|%s|watch|%s\n' "$$" "$MUTATOR_LEASE_INCARNATION" "$MUTATOR_LEASE_NONCE" \
        > "$WATCHER_LOCK_DIR/owner"
      watcher_begin_pass
      printf '%s|wrong-incarnation|watch|%s\n' "$$" "$MUTATOR_LEASE_NONCE" \
        > "$WATCHER_LOCK_DIR/owner"
      assert_or_reuse_owned_lease || true
      watcher_finish_pass
    done
    : > "$survived"
  ) 2>"$log_file" || rc=$?
  if [[ "$rc" -ne 0 && ! -e "$survived" \
      && "$(grep -c 'watcher lease verification failed for pass' "$log_file" 2>/dev/null || true)" == "3" \
      && "$(cat "$log_file")" == *"FATAL"* ]]; then
    pass "bad lease is observable on each pass and triggers supervised replacement at the fixed threshold"
  else
    fail "authority-loss threshold mismatch rc=$rc survived=$([[ -e "$survived" ]] && echo yes || echo no) log=[$(cat "$log_file")]"
  fi
}

test_fly1482_midpass_authority_loss_preserves_unreceipted_workspace() {
  echo "Test: FLY-1482 — mid-pass lease loss preserves an unreceipted workspace for recovery"
  _fly1364_legacy_create_fixture
  release_mutator_lease
  acquire_mutator_lease watch
  WATCHER_PASS_ACTIVE=1
  local saved_upsert remaining rc=0 log_file="$TMPDIR_ROOT/unreceipted-authority-loss.log"
  saved_upsert=$(declare -f _ledger_upsert)
  eval "$(declare -f _ledger_upsert | sed '1s/_ledger_upsert/_ledger_upsert_impl/')"
  _ledger_upsert() {
    printf '%s|wrong-incarnation|watch|%s\n' "$$" "$MUTATOR_LEASE_NONCE" \
      > "$WATCHER_LOCK_DIR/owner"
    _ledger_upsert_impl "$@"
  }
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1364-implement" \
    > /dev/null 2>"$log_file" || rc=$?
  eval "$saved_upsert"
  unset -f _ledger_upsert_impl
  WATCHER_PASS_ACTIVE=0
  remaining=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c \
    'import json,sys; print(len(json.load(sys.stdin).get("workspaces", [])))')
  if [[ "$rc" -eq 0 && "$remaining" == "1" && "$WATCHER_AUTHORITY_LOST" == "1" \
      && "$(grep -c '^close-workspace ' <<< "$MOCK_CMUX_OPS" || true)" == "0" \
      && "$(cat "$log_file")" == *"preserving exact unreceipted workspace"* ]]; then
    pass "authority loss aborts the pass without rolling back a workspace the watcher no longer owns"
  else
    fail "authority-loss preservation mismatch rc=$rc remaining=$remaining latch=$WATCHER_AUTHORITY_LOST ops=[$MOCK_CMUX_OPS] log=[$(cat "$log_file")]"
  fi
}

test_fly1482_clean_pass_resets_authority_streak() {
  echo "Test: FLY-1482 — only a complete clean pass resets the authority-loss streak"
  reset_mocks
  acquire_mutator_lease watch
  WATCHER_AUTHORITY_FAILURE_STREAK=1
  watcher_begin_pass && watcher_finish_pass
  local after_clean="$WATCHER_AUTHORITY_FAILURE_STREAK"
  printf '%s|wrong-incarnation|watch|%s\n' "$$" "$MUTATOR_LEASE_NONCE" > "$WATCHER_LOCK_DIR/owner"
  watcher_begin_pass || true
  watcher_finish_pass
  local after_failure="$WATCHER_AUTHORITY_FAILURE_STREAK"
  if [[ "$after_clean" == "0" && "$after_failure" == "1" ]]; then
    pass "failure → clean → failure restarts the streak at one"
  else
    fail "streak reset mismatch clean=$after_clean failure=$after_failure"
  fi
}

test_fly1482_authority_latch_stops_inner_batch_loops() {
  echo "Test: FLY-1482 — authority loss stops the current event and additive batches"
  reset_mocks
  local trace="$TMPDIR_ROOT/fly1482-authority-trace"
  printf 'create|runner-flywheel|@1|FLY-1482-one\ncreate|runner-flywheel|@2|FLY-1482-two\n' > "$EVENT_FILE"
  : > "$trace"
  WATCHER_AUTHORITY_LOST=0
  workspace_exists_for() { return 1; }
  create_workspace_for_window() {
    printf 'create:%s\n' "$3" >> "$trace"
    WATCHER_AUTHORITY_LOST=1
  }
  drain_events
  local event_creates event_tail replay_creates
  event_creates=$(grep -c '^create:' "$trace" 2>/dev/null || true)
  event_tail=$(cat "${EVENT_FILE}.processing" 2>/dev/null || true)
  WATCHER_AUTHORITY_LOST=0
  create_workspace_for_window() { printf 'replay:%s\n' "$3" >> "$trace"; }
  drain_events
  replay_creates=$(grep -c '^replay:' "$trace" 2>/dev/null || true)

  printf 'FLY-1482-clean-one|1\nFLY-1482-clean-two|2\nFLY-1482-clean-three|3\n' > "$CLEANUP_PENDING"
  WATCHER_AUTHORITY_LOST=0
  date() { printf '100\n'; }
  is_pane_alive() { return 1; }
  CLEANUP_DELAY_SECONDS=0
  seed_complete_cleanup_snapshot_after 100
  cleanup_workspace_for() {
    printf 'cleanup:%s\n' "$1" >> "$trace"
    WATCHER_AUTHORITY_LOST=1
  }
  process_pending_cleanups
  local cleanup_calls cleanup_tail
  cleanup_calls=$(grep -c '^cleanup:' "$trace" 2>/dev/null || true)
  cleanup_tail=$(cat "$CLEANUP_PENDING" 2>/dev/null || true)

  printf 'FLY-1482-close-one\nFLY-1482-close-two\nFLY-1482-close-three\n' > "$CLOSE_REQUEST_FILE"
  WATCHER_AUTHORITY_LOST=0
  is_managed_runner_title() { return 0; }
  workspace_refs_for() { printf 'workspace:1482\n'; }
  close_orphan_workspace_pin_if_still_orphan() {
    printf 'close:%s\n' "$2" >> "$trace"
    WATCHER_AUTHORITY_LOST=1
  }
  cmux_call() { printf 'close-tail-mutation\n' >> "$trace"; }
  process_close_requests
  local close_calls close_tail close_tail_mutations
  close_calls=$(grep -c '^close:' "$trace" 2>/dev/null || true)
  close_tail=$(cat "${CLOSE_REQUEST_FILE}.processing" 2>/dev/null || true)
  close_tail_mutations=$(grep -c '^close-tail-mutation$' "$trace" 2>/dev/null || true)

  : > "$trace"
  TRACE_FILE="$trace" FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMPDIR_ROOT/no-maintenance" \
    /bin/bash -c '
      source "$1"
      WATCHER_AUTHORITY_LOST=0
      reconcile_roster_read_phase() { :; }
      register_hooks_on_new_sessions() { :; }
      get_tmux_agent_windows() {
        printf "runner-flywheel|@1|FLY-1482-one\nrunner-flywheel|@2|FLY-1482-two\n"
      }
      prepare_linked_view_state() { return 0; }
      refresh_linked_sessions_tail() { return 0; }
      advance_attach_reap_state() { :; }
      discover_orphan_attach_helpers() { :; }
      reconcile_existing_workspaces() { :; }
      reconcile_workspace_titles() { :; }
      workspace_exists_for() { return 1; }
      create_workspace_for_window() {
        printf "create:%s\n" "$3" >> "$TRACE_FILE"
        WATCHER_AUTHORITY_LOST=1
      }
      self_heal_sweep_all() { printf "tail-mutation\n" >> "$TRACE_FILE"; }
      cleanup_stale_conservative() { printf "tail-mutation\n" >> "$TRACE_FILE"; }
      reap_ghost_workspaces() { printf "tail-mutation\n" >> "$TRACE_FILE"; }
      reap_unledgered_stock_workspaces() { printf "tail-mutation\n" >> "$TRACE_FILE"; }
      reap_orphan_workspace_pins() { :; }
      sync_additive
    ' _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" >/dev/null 2>&1
  local additive_creates tail_mutations
  additive_creates=$(grep -c '^create:' "$trace" 2>/dev/null || true)
  tail_mutations=$(grep -c '^tail-mutation$' "$trace" 2>/dev/null || true)
  if [[ "$event_creates" == "1" \
    && "$event_tail" == 'create|runner-flywheel|@2|FLY-1482-two' \
    && "$replay_creates" == "1" \
    && ! -e "${EVENT_FILE}.processing" \
    && "$cleanup_calls" == "1" \
    && "$cleanup_tail" == $'FLY-1482-clean-one|1\nFLY-1482-clean-two|2\nFLY-1482-clean-three|3' \
    && "$close_calls" == "1" \
    && "$close_tail" == $'FLY-1482-close-one\nFLY-1482-close-two\nFLY-1482-close-three' \
    && "$close_tail_mutations" == "0" \
    && "$additive_creates" == "1" \
    && "$tail_mutations" == "0" ]]; then
    pass "latched authority loss defers durable queue tails and prevents later batch mutations"
  else
    fail "authority latch lost work event=$event_creates event_tail=[$event_tail] replay=$replay_creates cleanup=$cleanup_calls cleanup_tail=[$cleanup_tail] close=$close_calls close_tail=[$close_tail] close_tail_mutations=$close_tail_mutations additive=$additive_creates tail=$tail_mutations trace=[$(cat "$trace")]"
  fi
}

test_fly1482_claim_reap_errors_are_not_mislabelled_malformed() {
  echo "Test: FLY-1482 — reap infrastructure errors are not reported as malformed claims"
  reset_mocks
  printf '%s|%s|qa_teardown|claim-nonce\n' "$$" "$FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE" \
    > "$CMUX_QA_TEARDOWN_CLAIM"
  local malformed_alerts=0 rc=0
  _acquire_reap_mutex() { return 2; }
  _alert_malformed_qa_teardown_claim() { malformed_alerts=$((malformed_alerts + 1)); }
  _reap_stale_qa_teardown_claim || rc=$?
  if [[ "$rc" -eq 2 && "$malformed_alerts" == "0" ]]; then
    pass "mutex/fence uncertainty stays distinct from malformed claim evidence"
  else
    fail "reap error was misclassified rc=$rc malformed_alerts=$malformed_alerts"
  fi
}

test_fly1364_ledger_writer_requires_verified_mutator_lease() {
  echo "Test: FLY-1364 Fix B — ledger writer refuses mutation without verified global lease"
  reset_mocks
  local rc=0
  _ledger_upsert committed "cmux-generation-1" "workspace:100" "FLY-1364-implement" || rc=$?
  if [[ "$rc" -ne 0 && ! -e "$VIEW_LEDGER" ]]; then
    pass "unleased ledger write is rejected without creating authority state"
  else
    fail "unleased ledger write mutated authority rc=$rc ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_ledger_writer_reaps_inner_lock_only_with_verified_lease() {
  echo "Test: FLY-1364 Fix B — verified global lease authorizes stale inner-lock recovery"
  reset_mocks
  local rc=0
  acquire_mutator_lease qa_teardown || rc=$?
  mkdir -p "${VIEW_LEDGER}.lock"
  : > "${VIEW_LEDGER}.lock/owner"
  _ledger_upsert committed "cmux-generation-1" "workspace:100" "FLY-1364-implement" || rc=$?
  local row
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$rc" -eq 0 && "$row" == "committed|cmux-generation-1|workspace:100|FLY-1364-implement" \
      && ! -d "${VIEW_LEDGER}.lock" ]]; then
    pass "lease holder reaps malformed residual inner lock and commits atomically"
  else
    fail "lease-authorized inner-lock recovery failed rc=$rc row=[$row] lock=$([[ -d "${VIEW_LEDGER}.lock" ]] && echo present || echo absent)"
  fi
}

test_fly1446_ledger_title_rows_include_rename_lag_prepared() {
  echo "Test: FLY-1446 E1 — ledger title lookup sees prepared and committed authority"
  reset_mocks
  printf '%s\n' \
    'prepared|cmux-generation-1|workspace:100|FLY-1446-rename-lag' \
    'committed|cmux-generation-1|workspace:101|FLY-1446-rename-lag' \
    'committed|cmux-generation-2|workspace:102|FLY-1446-rename-lag' \
    'prepared|cmux-generation-1|workspace:103|other-title' \
    'malformed-row' > "$VIEW_LEDGER"
  local rows
  rows=$(ledger_rows_for_title "cmux-generation-1" "FLY-1446-rename-lag")
  if [[ "$rows" == $'prepared|cmux-generation-1|workspace:100|FLY-1446-rename-lag\ncommitted|cmux-generation-1|workspace:101|FLY-1446-rename-lag' ]]; then
    pass "strict title lookup exposes both states and excludes other generations/titles/malformed rows"
  else
    fail "ledger title lookup mismatch rows=[$rows]"
  fi
}

test_fly1446_rename_lag_retry_never_creates_second_workspace() {
  echo "Test: FLY-1446 E1 — rename-lag retry is stopped by the prepared ledger row"
  _fly1364_legacy_create_fixture
  local saved_guard first_row first_creates second_row second_creates
  saved_guard=$(declare -f _prepared_rename_guard)
  _prepared_rename_guard() { return 1; }
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1364-implement"
  eval "$saved_guard"
  first_row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  first_creates=$(grep -c '^new-workspace ' <<< "$MOCK_CMUX_OPS" || true)

  # Model the next 60s scan, outside the short process-local create TTL. The
  # durable prepared receipt—not FLY-825's 30s same-tick latch—must stop it.
  rm -f "$CREATE_STATE"
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1364-implement"
  second_row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  second_creates=$(grep -c '^new-workspace ' <<< "$MOCK_CMUX_OPS" || true)
  if [[ "$first_row" == 'prepared|cmux-generation-1|workspace:100|FLY-1364-implement|00000000-0000-4000-8000-000000000100' \
      && "$second_row" == "$first_row" && "$first_creates" == "1" && "$second_creates" == "1" ]]; then
    pass "a hidden/provisional first workspace remains the sole create while reconcile owns its rename"
  else
    fail "rename-lag duplicated workspace first=[$first_row/$first_creates] second=[$second_row/$second_creates] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1446_ledger_transaction_rejects_title_conflict_inside_lock() {
  echo "Test: FLY-1446 E1 — ledger transaction enforces one ref per generation/title"
  reset_mocks
  test_ensure_mutator_lease
  local alerts="$TMPDIR_ROOT/fly1446-ledger-conflict-alerts" saved_alert saved_crash rc=0 rows
  saved_alert=$(declare -f flywheel_alert)
  saved_crash=$(declare -f _ledger_maybe_crash)
  : > "$alerts"
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  _ledger_maybe_crash() {
    if [[ "$1" == "after-owner-mv" && ! -f "$TMPDIR_ROOT/fly1446-conflict-injected" ]]; then
      printf '%s\n' 'prepared|cmux-generation-1|workspace:100|FLY-1446-rename-lag' > "$VIEW_LEDGER"
      touch "$TMPDIR_ROOT/fly1446-conflict-injected"
    fi
    return 0
  }
  _ledger_upsert committed "cmux-generation-1" "workspace:101" "FLY-1446-rename-lag" || rc=$?
  eval "$saved_crash"
  eval "$saved_alert"
  rows=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$rc" -ne 0 \
      && "$rows" == 'prepared|cmux-generation-1|workspace:100|FLY-1446-rename-lag' \
      && "$(grep -c 'ledger-title-conflict|FLY-1446-rename-lag|e1' "$alerts" || true)" == "1" \
      && ! -d "${VIEW_LEDGER}.lock" ]]; then
    pass "conflicting ref is rejected under the transaction lock, alerted once, and leaves the winner intact"
  else
    fail "ledger uniqueness mismatch rc=$rc rows=[$rows] alerts=[$(cat "$alerts")] lock=$([[ -d "${VIEW_LEDGER}.lock" ]] && echo present || echo absent)"
  fi
}

test_fly1446_prepared_loser_cleanup_is_exact_and_guarded() {
  echo "Test: FLY-1446 E1 — historical prepared loser closes only with complete exact-ref evidence"
  reset_mocks
  MOCK_CMUX_MUTATE_JSON=1; MOCK_SOCK_IDENT="cmux-generation-1"
  test_ensure_mutator_lease
  printf '%s\n' \
    'committed|cmux-generation-1|workspace:100|FLY-1446-rename-lag' \
    'prepared|cmux-generation-1|workspace:101|FLY-1446-rename-lag' > "$VIEW_LEDGER"
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:100\",\"title\":\"FLY-1446-rename-lag\"},{\"ref\":\"workspace:101\",\"title\":\"env -u TMUX tmux attach -t '=cmux-FLY-1446-rename-lag'\"}]}"
  local alerts="$TMPDIR_ROOT/fly1446-loser-alerts" saved_alert rc=0 rows
  saved_alert=$(declare -f flywheel_alert)
  : > "$alerts"
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  reconcile_prepared_ledger || rc=$?
  eval "$saved_alert"
  rows=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$rc" -eq 0 \
      && "$rows" == 'committed|cmux-generation-1|workspace:100|FLY-1446-rename-lag' \
      && "$(grep -c '^close-workspace --workspace workspace:101$' <<< "$MOCK_CMUX_OPS" || true)" == "1" ]] \
      && grep -q 'ledger-prepared-loser-closed|FLY-1446-rename-lag|workspace:101' "$alerts"; then
    pass "exact prepared loser is closed and its row removed while the committed owner survives"
  else
    fail "prepared loser did not converge rc=$rc rows=[$rows] ops=[$MOCK_CMUX_OPS] alerts=[$(cat "$alerts")]"
  fi

  reset_mocks
  MOCK_CMUX_MUTATE_JSON=1; MOCK_SOCK_IDENT="cmux-generation-1"
  test_ensure_mutator_lease
  printf '%s\n' \
    'committed|cmux-generation-1|workspace:100|FLY-1446-rename-lag' \
    'prepared|cmux-generation-1|workspace:101|FLY-1446-rename-lag' > "$VIEW_LEDGER"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"FLY-1446-rename-lag"},{"ref":"workspace:101","title":"founder-foreign"}]}'
  rc=0
  reconcile_prepared_ledger || rc=$?
  if [[ "$rc" -eq 0 && "$(wc -l < "$VIEW_LEDGER" | tr -d ' ')" == "2" \
      && "$MOCK_CMUX_OPS" != *'close-workspace'* ]]; then
    pass "title drift at the loser ref authorizes zero close and preserves both receipts"
  else
    fail "prepared loser guard closed on incomplete evidence rc=$rc ledger=[$(cat "$VIEW_LEDGER")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1446_historical_double_committed_alerts_without_mutation() {
  echo "Test: FLY-1446 E1 — historical double-committed title is alert-only"
  reset_mocks
  MOCK_CMUX_MUTATE_JSON=1; MOCK_SOCK_IDENT="cmux-generation-1"
  test_ensure_mutator_lease
  printf '%s\n' \
    'committed|cmux-generation-1|workspace:100|FLY-1446-duplicate' \
    'committed|cmux-generation-1|workspace:101|FLY-1446-duplicate' > "$VIEW_LEDGER"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"drifted"},{"ref":"workspace:101","title":"FLY-1446-duplicate"}]}'
  local alerts="$TMPDIR_ROOT/fly1446-double-committed-alerts" saved_alert rc=0 before after
  saved_alert=$(declare -f flywheel_alert)
  : > "$alerts"
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  before=$(cat "$VIEW_LEDGER")
  reconcile_prepared_ledger || rc=$?
  after=$(cat "$VIEW_LEDGER")
  eval "$saved_alert"
  if [[ "$rc" -eq 0 && "$after" == "$before" && -z "$MOCK_CMUX_OPS" \
      && "$(grep -c 'ledger-title-conflict|FLY-1446-duplicate|e1' "$alerts" || true)" == "1" ]]; then
    pass "ambiguous historical owners are preserved byte-for-byte and page for manual disposition"
  else
    fail "historical duplicate mutated or stayed silent rc=$rc before=[$before] after=[$after] ops=[$MOCK_CMUX_OPS] alerts=[$(cat "$alerts")]"
  fi
}

_fly1364_legacy_create_fixture() {
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_TMUX_WINDOWS='runner-flywheel|@42|FLY-1364-implement'
  MOCK_PANE_DEAD='runner-flywheel:@42=0'
  MOCK_TMUX_SESSIONS='runner-flywheel'
  acquire_mutator_lease qa_teardown
}

test_fly1364_a0b1_create_records_prepared_then_committed_receipt() {
  echo "Test: FLY-1364 Fix B — A0B1 create records prepared → committed exact-ref receipt"
  _fly1364_legacy_create_fixture
  local trace="$TMPDIR_ROOT/fly1364-ledger-trace" row rc=0
  : > "$trace"
  (
    eval "$(declare -f _ledger_upsert | sed '1s/_ledger_upsert/_ledger_upsert_impl/')"
    _ledger_upsert() {
      printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" >> "$trace"
      _ledger_upsert_impl "$@"
    }
    create_workspace_for_window "runner-flywheel" "@42" "FLY-1364-implement"
  ) || rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$rc" -eq 0 \
      && "$(sed -n '1p' "$trace" 2>/dev/null)" == "prepared|cmux-generation-1|workspace:100|FLY-1364-implement" \
      && "$(sed -n '2p' "$trace" 2>/dev/null)" == "committed|cmux-generation-1|workspace:100|FLY-1364-implement" \
      && "$(wc -l < "$trace" 2>/dev/null | tr -d ' ')" == "2" \
      && "$row" == "committed|cmux-generation-1|workspace:100|FLY-1364-implement|00000000-0000-4000-8000-000000000100" ]]; then
    pass "A0B1 create transitions exact ref from prepared to one committed row"
  else
    fail "A0B1 receipt sequence mismatch rc=$rc trace=[$(tr '\n' ';' < "$trace" 2>/dev/null)] row=[$row]"
  fi
}

test_fly1364_a0b1_create_accepts_exact_provisional_attach_title() {
  echo "Test: FLY-1364 live regression — exact create command is valid provisional rename authority"
  _fly1364_legacy_create_fixture
  MOCK_CMUX_NEW_WORKSPACE_TITLE_FROM_COMMAND=1
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1364-implement"
  local row title
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  title=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
print(json.load(sys.stdin)["workspaces"][0]["title"])
')
  if [[ "$row" == 'committed|cmux-generation-1|workspace:100|FLY-1364-implement|00000000-0000-4000-8000-000000000100' \
      && "$title" == 'FLY-1364-implement' \
      && "$(grep -c '^rename-workspace --workspace workspace:100 FLY-1364-implement$' <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "the byte-exact launch command may transition its prepared ref to the managed title"
  else
    fail "exact provisional attach title did not converge row=[$row] title=[$title] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_a0b1_create_uses_independent_view_by_default() {
  echo "Test: FLY-1364 fixture 1393 — redispatch creates an independent sole-window view"
  reset_mocks
  local fixture="$SCRIPT_DIR/__tests__/fixtures/fly1364/fly-1393-redispatch.json"
  local fixture_row session wid title dead expected_view deadline
  fixture_row=$(python3 - "$fixture" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
w = d["tmux_windows"][0]
e = d["expected"]
print("|".join([w["session"], w["id"], w["title"], str(w["pane_dead"]).lower(), e["strict_view"], str(e["create_within_seconds"])]))
PY
  )
  IFS='|' read -r session wid title dead expected_view deadline <<< "$fixture_row"
  MOCK_TOPOLOGY_MODE="1"
  FLYWHEEL_CMUX_LINKED_VIEW=0
  FLYWHEEL_CMUX_TEST_NONCE="nonce-r6-a0b1"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  topo_add_session "$session" '$1'
  topo_add_window "$session" "$wid" "$title" 1 "$([[ "$dead" == true ]] && echo 1 || echo 0)"
  MOCK_CMUX_WORKSPACES_JSON=$(_fly1364_fixture_workspace_json fly-1393-redispatch.json)
  test_ensure_mutator_lease

  create_workspace_for_window "$session" "$wid" "$title"

  local grouped active owner members ledger_row
  grouped=$(tmux display-message -p -t "=$expected_view" '#{session_grouped}' 2>/dev/null || true)
  active=$(tmux display-message -p -t "=$expected_view" '#{window_id}' 2>/dev/null || true)
  owner=$(tmux show-options -v -t "=$expected_view:" @flywheel_cmux_owner 2>/dev/null || true)
  members=$(tmux list-windows -t "=$expected_view" -F '#{window_id}' 2>/dev/null | tr '\n' ' ')
  ledger_row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$deadline" == "60" && "$grouped" == "0" && "$active" == "$wid" && "$owner" == "$session" \
      && "$members" == "$wid " \
      && "$ledger_row" == "committed|cmux-generation-1|workspace:100|$title|00000000-0000-4000-8000-000000000100" ]]; then
    pass "1393 fixture drives redispatch creation, exact receipt, and strict view expectation"
  else
    fail "1393 fixture mismatch deadline=$deadline grouped=$grouped active=$active owner=[$owner] members=[$members] ledger=[$ledger_row]"
  fi
}

test_fly1364_first_receipt_failure_rolls_back_exact_unnamed_ref() {
  echo "Test: FLY-1364 Fix B — first receipt failure rolls back only the new exact provisional ref"
  _fly1364_legacy_create_fixture
  MOCK_CMUX_NEW_WORKSPACE_TITLE_FROM_COMMAND=1
  local blocked_parent="$TMPDIR_ROOT/fly1364-ledger-parent" rc=0
  : > "$blocked_parent"
  VIEW_LEDGER="$blocked_parent/view-ledger"
  create_workspace_for_window "runner-flywheel" "@42" "FLY-1364-implement" >/dev/null 2>&1 || rc=$?
  local remaining
  remaining=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("workspaces", [])))')
  if [[ "$rc" -eq 0 && "$remaining" == "0" \
      && "$(grep -c '^close-workspace --workspace workspace:100$' <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && ! -e "$VIEW_LEDGER" ]]; then
    pass "unreceipted workspace is closed by exact ref before it can become a ghost"
  else
    fail "first-write rollback failed rc=$rc remaining=$remaining ops=[$MOCK_CMUX_OPS]"
  fi
  VIEW_LEDGER="$TMPDIR_ROOT/view-ledger"
}

test_fly1364_create_snapshot_is_generation_bound_before_ref_diff() {
  echo "Test: FLY-1364 xhigh P1 — pre-create ref snapshot cannot cross a restart with ref reuse"
  _fly1364_legacy_create_fixture
  MOCK_CMUX_JSON_SEQ_N=2
  MOCK_JSON_FLIP_IDENT="cmux-generation-2"
  MOCK_JSON_FLIP_AT=1
  printf '%s\n' '{"workspaces":[{"ref":"workspace:2","title":"old-generation-tab"}]}' > "$TMPDIR_ROOT/wsjson.1"
  printf '%s\n' '{"workspaces":[{"ref":"workspace:1","title":"founder-tab"},{"ref":"workspace:2","title":null}]}' > "$TMPDIR_ROOT/wsjson.2"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"founder-tab"}]}'
  printf '2\n' > "$TMPDIR_ROOT/cmux.next-ref"

  create_workspace_for_window "runner-flywheel" "@42" "FLY-1364-implement" >/dev/null 2>&1 || true

  if [[ -z "$MOCK_CMUX_OPS" && ! -e "$VIEW_LEDGER" ]]; then
    pass "generation change during raw-before capture aborts before create or receipt authority"
  else
    fail "cross-generation ref swap minted or mutated authority ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_rollback_guard_repins_after_inventory_probe() {
  echo "Test: FLY-1364 xhigh P1 — rollback refuses a reused unnamed ref after generation flip"
  reset_mocks
  MOCK_SOCK_IDENT="generation-rollback-a"
  MOCK_JSON_FLIP_IDENT="generation-rollback-b"
  MOCK_JSON_FLIP_AT=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:77","title":null}]}'

  rollback_unreceipted_workspace "generation-rollback-a" "workspace:77" >/dev/null 2>&1 || true

  if [[ -z "$MOCK_CMUX_OPS" \
      && "$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["workspaces"]))')" == "1" ]]; then
    pass "post-inventory generation pin preserves the new-generation unnamed ref"
  else
    fail "rollback authority crossed generation boundary ops=[$MOCK_CMUX_OPS] json=[$MOCK_CMUX_WORKSPACES_JSON]"
  fi
}

test_fly1364_ledger_crash_windows_recover_under_next_lease_holder() {
  echo "Test: FLY-1364 Fix B — every ledger crash window is recoverable by the next verified lease holder"
  reset_mocks
  local base_ledger="$VIEW_LEDGER" base_lock="$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  local point case_dir child_rc rc row ok=1
  for point in after-inner-mkdir after-owner-tmp-write after-owner-mv \
      after-ledger-tmp-write after-ledger-mv after-lock-owner-remove; do
    case_dir="$TMPDIR_ROOT/ledger-crash-$point"
    mkdir -p "$case_dir"
    child_rc=0
    VIEW_LEDGER="$case_dir/view-ledger" \
    FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$case_dir/watcher.lock" \
    FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="child-$point" \
    FLYWHEEL_CMUX_LEDGER_CRASH_AT="$point" \
      /bin/bash -c 'source "$1"; acquire_mutator_lease once; _ledger_upsert committed gen workspace:100 title' \
        _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" >/dev/null 2>&1 || child_rc=$?
    [[ "$child_rc" == "137" ]] || ok=0

    VIEW_LEDGER="$case_dir/view-ledger"
    FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$case_dir/watcher.lock"
    WATCHER_LOCK_DIR="$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
    WATCHER_REAP_MUTEX="${WATCHER_LOCK_DIR}.reap"
    FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="test-incarnation"
    MUTATOR_LEASE_NONCE=""; MUTATOR_LEASE_INCARNATION=""; MUTATOR_LEASE_MODE=""
    rc=0
    acquire_mutator_lease qa_teardown || rc=$?
    _ledger_upsert committed gen workspace:100 title || rc=$?
    row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
    [[ "$rc" -eq 0 && "$row" == "committed|gen|workspace:100|title" \
        && ! -d "${VIEW_LEDGER}.lock" ]] || ok=0
    release_mutator_lease
  done
  VIEW_LEDGER="$base_ledger"
  FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$base_lock"
  WATCHER_LOCK_DIR="$base_lock"
  WATCHER_REAP_MUTEX="${base_lock}.reap"
  unset FLYWHEEL_CMUX_LEDGER_CRASH_AT
  if [[ "$ok" == "1" ]]; then
    pass "mkdir/owner/tmp/mv/release crash points all converge on the next valid lease"
  else
    fail "one or more ledger crash points did not SIGKILL and recover cleanly"
  fi
}

test_fly1364_unledgered_zero_ref_converges_only_view_shell() {
  echo "Test: FLY-1364 Fix A' — conclusively zero same-title refs converges only the residual view shell"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-implement" 1 0
  tmux new-session -d -t "runner-flywheel" -s "cmux-FLY-1364-implement"
  : > "$TOPO_JOURNAL"
  local rc=0 keeper
  test_ensure_mutator_lease || { fail "cannot acquire fixture mutator lease"; return; }
  dismantle_view_display "FLY-1364-implement" "manual-tab-already-closed" || rc=$?
  keeper=$(awk -F'|' '$6 == "committed" { print $3; exit }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  release_mutator_lease
  if [[ "$rc" -eq 0 && "$keeper" == fwkeeper-* ]] \
      && ! topo_session_exists "cmux-FLY-1364-implement" \
      && topo_session_exists "$keeper" \
      && ! grep -q 'close-workspace' <<< "$MOCK_CMUX_OPS"; then
    pass "zero-ref branch performs no cmux mutation and removes the reentry anchor via guarded shell escrow"
  else
    fail "zero-ref residual shell did not converge rc=$rc keeper=[$keeper] journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_escrow_repins_generation_before_owner_mutation() {
  echo "Test: FLY-1364 xhigh P1 — escrow cannot set ownership on a same-name session from a new tmux generation"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-implement" 1 0
  tmux new-session -d -t "runner-flywheel" -s "cmux-FLY-1364-implement"
  : > "$TOPO_JOURNAL"
  local rc=0
  FLYWHEEL_CMUX_TMUX_GENERATION='tmux-generation-a'
  MOCK_TMUX_GENERATION_FLIP_AFTER_SNAPSHOT_SESSION='cmux-FLY-1364-implement'
  MOCK_TMUX_GENERATION_FLIP_VALUE='tmux-generation-b'
  escrow_view_session "cmux-FLY-1364-implement" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 && -z "$(grep -E '^(set-option|rename-session) ' "$TOPO_JOURNAL" || true)" \
      ]] && topo_session_exists "cmux-FLY-1364-implement"; then
    pass "generation change after the ownership snapshot blocks the first tmux mutation"
  else
    fail "escrow mutated a replacement generation rc=$rc journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1364_escrow_repins_generation_before_rename() {
  echo "Test: FLY-1364 xhigh P1 — escrow cannot rename after tmux generation changes following owner persistence"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-implement" 1 0
  tmux new-session -d -t "runner-flywheel" -s "cmux-FLY-1364-implement"
  : > "$TOPO_JOURNAL"
  local rc=0
  FLYWHEEL_CMUX_TMUX_GENERATION='tmux-generation-a'
  MOCK_TMUX_GENERATION_FLIP_AFTER_SET_OPTION='tmux-generation-b'
  escrow_view_session "cmux-FLY-1364-implement" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 \
      && "$(grep -c '^set-option ' "$TOPO_JOURNAL" || true)" == "1" \
      && "$(grep -c '^rename-session ' "$TOPO_JOURNAL" || true)" == "0" \
      ]] && topo_session_exists "cmux-FLY-1364-implement"; then
    pass "generation change after owner persistence blocks the keeper rename"
  else
    fail "escrow rename crossed generation rc=$rc journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1364_unlink_revalidates_exact_tmux_session_id() {
  echo "Test: FLY-1364 xhigh P1 — direct unlink cannot target a same-name replacement session"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_SOCK_IDENT='cmux-generation-1'
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-implement" 1 0
  topo_add_session "cmux-FLY-1364-implement" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1364-implement" "@42" "FLY-1364-implement" 1 0
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":"FLY-1364-implement"}]}'
  test_ledger_upsert committed 'cmux-generation-1' 'workspace:100' 'FLY-1364-implement'
  local rc=0
  MOCK_TMUX_REUSE_SESSION_AFTER_WINDOW_PROBE='cmux-FLY-1364-implement|$99'
  : > "$TOPO_JOURNAL"
  dismantle_view_display "FLY-1364-implement" "session-reuse" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 \
      && "$(grep -c '^unlink-window ' "$TOPO_JOURNAL" || true)" == "0" \
      && "$(topo_session_field 'cmux-FLY-1364-implement' 2)" == '$99' ]]; then
    pass "session-id drift after ownership proof blocks direct unlink"
  else
    fail "unlink targeted a replacement session rc=$rc journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")] topology=[$(cat "$TOPO_SESSIONS")]"
  fi
}

test_fly1364_wal_recovery_unlink_repins_tmux_generation() {
  echo "Test: FLY-1364 xhigh R12 — WAL stage unlink cannot cross a tmux restart"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_TMUX_GENERATION='tmux-generation-a'
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-implement" 1 0
  topo_add_session "fwstage-r12-unlink" '$2' "" "runner-flywheel" "1"
  topo_add_window "fwstage-r12-unlink" "@1000" "__flywheel_placeholder__" 0 0
  topo_add_window "fwstage-r12-unlink" "@42" "FLY-1364-implement" 1 0
  local wal rc=0
  wal=$(_view_wal_path "cmux-FLY-1364-implement")
  _write_view_wal "$wal" 'tmux-generation-a' linked r12-unlink \
    'cmux-FLY-1364-implement' 'runner-flywheel' '@42' '$2' '@1000'
  MOCK_TMUX_GENERATION_FLIP_AFTER_SNAPSHOT_SESSION='fwstage-r12-unlink'
  MOCK_TMUX_GENERATION_FLIP_VALUE='tmux-generation-b'
  : > "$TOPO_JOURNAL"
  recover_view_construction 'cmux-FLY-1364-implement' >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 && -f "$wal" ]] \
      && topo_session_exists 'fwstage-r12-unlink' \
      && ! grep -Eq '^(unlink-window|kill-session) ' "$TOPO_JOURNAL"; then
    pass "WAL unlink authority is generation-pinned at the mutation boundary"
  else
    fail "WAL recovery mutated a replacement generation rc=$rc wal=$([[ -f "$wal" ]] && echo yes || echo no) journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1364_wal_recovery_create_intent_kill_repins_tmux_generation() {
  echo "Test: FLY-1364 xhigh R12 — create-intent cleanup cannot kill a replacement stage"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_TMUX_GENERATION='tmux-generation-a'
  topo_add_session "fwstage-r12-create" '$8'
  topo_add_window "fwstage-r12-create" "@1000" "__flywheel_placeholder__" 1 0
  local wal rc=0
  wal=$(_view_wal_path "cmux-FLY-1364-create")
  _write_view_wal "$wal" 'tmux-generation-a' create_intent r12-create \
    'cmux-FLY-1364-create' 'runner-flywheel' '@42' '' ''
  MOCK_TMUX_GENERATION_FLIP_AFTER_SNAPSHOT_SESSION='fwstage-r12-create'
  MOCK_TMUX_GENERATION_FLIP_VALUE='tmux-generation-b'
  : > "$TOPO_JOURNAL"
  recover_view_construction 'cmux-FLY-1364-create' >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 && -f "$wal" ]] \
      && topo_session_exists 'fwstage-r12-create' \
      && ! grep -q '^kill-session ' "$TOPO_JOURNAL"; then
    pass "create-intent recovery revalidates the exact generation/session before kill"
  else
    fail "create-intent killed a replacement stage rc=$rc wal=$([[ -f "$wal" ]] && echo yes || echo no) journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1364_wal_recovery_claim_rename_repins_tmux_generation() {
  echo "Test: FLY-1364 xhigh R12 — claim-intent rename cannot bind a replacement stage"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_TMUX_GENERATION='tmux-generation-a'
  topo_add_session "runner-flywheel" '$1'
  topo_add_window "runner-flywheel" "@42" "FLY-1364-claim" 1 0
  topo_add_session "fwstage-r12-claim" '$7' "" "runner-flywheel" "0"
  topo_add_window "fwstage-r12-claim" "@42" "FLY-1364-claim" 1 0
  local wal rc=0
  wal=$(_view_wal_path "cmux-FLY-1364-claim")
  _write_view_wal "$wal" 'tmux-generation-a' claim_intent r12-claim \
    'cmux-FLY-1364-claim' 'runner-flywheel' '@42' '$7' '@1000'
  MOCK_TMUX_GENERATION_FLIP_AFTER_SNAPSHOT_SESSION='fwstage-r12-claim'
  MOCK_TMUX_GENERATION_FLIP_VALUE='tmux-generation-b'
  : > "$TOPO_JOURNAL"
  recover_view_construction 'cmux-FLY-1364-claim' >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 && -f "$wal" ]] \
      && topo_session_exists 'fwstage-r12-claim' \
      && ! topo_session_exists 'cmux-FLY-1364-claim' \
      && ! grep -q '^rename-session ' "$TOPO_JOURNAL"; then
    pass "claim rename authority is generation/session-pinned immediately before mutation"
  else
    fail "claim rename crossed tmux generation rc=$rc wal=$([[ -f "$wal" ]] && echo yes || echo no) journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1364_wal_source_gone_escrow_keeps_original_identity() {
  echo "Test: FLY-1364 xhigh R13 — source-gone escrow cannot adopt a replacement WAL stage"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_TMUX_GENERATION='tmux-generation-a'
  topo_add_session "fwstage-r13-source-gone" '$13' "" "runner-gone" "0"
  topo_add_window "fwstage-r13-source-gone" "@42" "FLY-1364-source-gone" 1 0
  local wal rc=0
  wal=$(_view_wal_path 'cmux-FLY-1364-source-gone')
  _write_view_wal "$wal" 'tmux-generation-a' linked r13-source-gone \
    'cmux-FLY-1364-source-gone' 'runner-gone' '@42' '$13' '@1000'
  test_ensure_mutator_lease
  MOCK_TMUX_GENERATION_FLIP_ON_MISSING_SESSION='runner-gone'
  MOCK_TMUX_GENERATION_FLIP_VALUE='tmux-generation-b'
  : > "$TOPO_JOURNAL"
  recover_view_construction 'cmux-FLY-1364-source-gone' >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 && -f "$wal" ]] \
      && topo_session_exists 'fwstage-r13-source-gone' \
      && ! grep -q '^rename-session ' "$TOPO_JOURNAL"; then
    pass "source-loss escrow preserves the WAL generation/SID instead of minting fresh authority"
  else
    fail "source-gone recovery escrowed a replacement stage rc=$rc wal=$([[ -f "$wal" ]] && echo yes || echo no) journal=[$(tr '\n' ';' < "$TOPO_JOURNAL")]"
  fi
}

test_fly1364_unledgered_json_uncertain_is_zero_mutation() {
  echo "Test: FLY-1364 Fix A' — unavailable workspace JSON fails closed before view-shell mutation"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_JSON_FAIL=1
  topo_add_session "cmux-FLY-1364-implement" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1364-implement" "@42" "FLY-1364-implement" 1 0
  : > "$TOPO_JOURNAL"
  local rc=0 log_file="$TMPDIR_ROOT/fly1364-unledgered-uncertain.log"
  dismantle_view_display "FLY-1364-implement" "uncertain" 2>"$log_file" || rc=$?
  if [[ "$rc" -ne 0 && ! -s "$TOPO_JOURNAL" && -z "$MOCK_CMUX_OPS" ]] \
      && topo_session_exists "cmux-FLY-1364-implement" \
      && grep -q 'reason=workspace-json-unavailable' "$log_file"; then
    pass "JSON uncertainty preserves every cmux/tmux object"
  else
    fail "uncertain cleanup mutated, falsely succeeded, or skipped evidence rc=$rc log=[$(cat "$log_file")] journal=[$(cat "$TOPO_JOURNAL")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_unledgered_present_ref_logs_operator_evidence_without_mutation() {
  echo "Test: FLY-1364 Fix A' — present same-title ref is preserved with operator-grade evidence"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:900","title":"FLY-1364-implement"}]}'
  topo_add_session "cmux-FLY-1364-implement" '$9' "" "founder-owned" "0"
  topo_add_window "cmux-FLY-1364-implement" "@99" "founder-shell" 1 0
  printf 'FLY-1364-implement|123\n' > "$STALE_STATE"
  : > "$TOPO_JOURNAL"
  local rc=0 log_file="$TMPDIR_ROOT/fly1364-unledgered-evidence.log"
  dismantle_view_display "FLY-1364-implement" "collision" 2>"$log_file" || rc=$?
  if [[ "$rc" -ne 0 && -z "$MOCK_CMUX_OPS" \
      && "$(cat "$log_file")" == *"generation=cmux-generation-1"* \
      && "$(cat "$log_file")" == *"refs=workspace:900"* \
      && "$(cat "$log_file")" == *"view_exists=1"* \
      && "$(cat "$log_file")" == *"owner=founder-owned"* \
      && "$(cat "$log_file")" == *"stale_state=1"* ]] \
      && topo_session_exists "cmux-FLY-1364-implement" \
      && ! grep -Eq '^(unlink-window|rename-session|kill-window|kill-session|link-window|new-session)' "$TOPO_JOURNAL"; then
    pass "foreign ref remains untouched and the warning carries generation/ref/view/owner/stale evidence"
  else
    fail "foreign evidence/mutation contract mismatch rc=$rc log=[$(cat "$log_file")] journal=[$(cat "$TOPO_JOURNAL")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_run_mutator_once_rebuilds_malformed_lease_and_continues() {
  echo "Test: FLY-1364 R6 — one-shot mutator rebuilds a malformed lease and runs the same cycle"
  reset_mocks
  acquire_mutator_lease qa_teardown
  local busy_log="$TMPDIR_ROOT/fly1364-lease-busy.log" malformed_log="$TMPDIR_ROOT/fly1364-lease-malformed.log"
  local mutation_probe="$TMPDIR_ROOT/fly1364-mutator-probe" rc=0
  fly1364_mutation_probe() { : > "$mutation_probe"; }
  run_mutator_once once fly1364_mutation_probe 2>"$busy_log" || rc=$?
  release_mutator_lease
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf 'malformed\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  run_mutator_once once fly1364_mutation_probe 2>"$malformed_log" || rc=$?
  unset -f fly1364_mutation_probe
  if [[ "$rc" -eq 0 && -e "$mutation_probe" \
      && "$(cat "$busy_log")" == *"already running"* \
      && "$(cat "$busy_log")" == *"owner pid=$$ mode=qa_teardown"* \
      && "$(cat "$busy_log")" != *"MALFORMED"* \
      && "$(cat "$malformed_log")" == *"rebuilt stale/unverifiable mutator lease"* \
      && "$(cat "$malformed_log")" != *"manual inspection required"* \
      && "$(cat "$malformed_log")" != *"already running"* \
      && ! -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "busy remains a quiet while a conclusively ownerless malformed lease is rebuilt and executed"
  else
    fail "malformed lease did not safely rebuild-and-continue rc=$rc busy=[$(cat "$busy_log")] malformed=[$(cat "$malformed_log")] mutation=$([[ -e "$mutation_probe" ]] && echo yes || echo no) lock=$([[ -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]] && echo present || echo absent)"
  fi
}

test_fly1364_watcher_start_rebuilds_malformed_lease() {
  echo "Test: FLY-1364 R6 — watcher start rebuilds a conclusively ownerless malformed lease"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf 'broken-owner\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  local log_file="$TMPDIR_ROOT/fly1364-watcher-malformed.log" owner_copy="$TMPDIR_ROOT/fly1364-watcher-owner" rc=0
  ( FLYWHEEL_CMUX_SUPERVISED=0; acquire_watcher_lock; cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" > "$owner_copy" ) 2>"$log_file" || rc=$?
  if [[ "$rc" -eq 0 && "$(cat "$log_file")" == *"rebuilt stale/unverifiable mutator lease"* \
      && "$(cat "$log_file")" != *"already running"* \
      && "$(awk -F'|' '{print NF}' "$owner_copy" 2>/dev/null)" == "4" \
      && "$(cut -d'|' -f3 "$owner_copy" 2>/dev/null)" == "watch" \
      && ! -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "watcher takes one verified lease after rebuilding the stale malformed record"
  else
    fail "watcher did not rebuild malformed lease rc=$rc owner=[$(cat "$owner_copy" 2>/dev/null)] log=[$(cat "$log_file")] lock=$([[ -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]] && echo present || echo absent)"
  fi
}

test_fly1364_malformed_lease_preserves_live_mutator() {
  echo "Test: FLY-1364 R6 — malformed owner never steals from a live cmux mutator"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf 'broken-owner\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  MOCK_MUTATOR_CENSUS='4242|/bin/bash /tmp/flywheel-cmux-sync.sh --watch'
  local before after rc=0
  before=$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner")
  acquire_mutator_lease once >/dev/null 2>&1 || rc=$?
  after=$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" 2>/dev/null || true)
  if [[ "$rc" -eq 1 && "$after" == "$before" && -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "live process census keeps the malformed lease busy and byte-preserved"
  else
    fail "live mutator was not protected rc=$rc before=[$before] after=[$after]"
  fi
}

test_fly1364_malformed_lease_fails_closed_when_census_unavailable() {
  echo "Test: FLY-1364 R6 — process-table failure preserves malformed lease and alerts"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf 'broken-owner\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  MOCK_MUTATOR_CENSUS_FAIL=1
  local rc=0 log_file="$TMPDIR_ROOT/fly1364-census-unavailable.log"
  acquire_mutator_lease once 2>"$log_file" || rc=$?
  if [[ "$rc" -eq 2 && -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" \
      && "$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner")" == "broken-owner" \
      && "$(cat "$log_file")" == *"reason=process-census-unavailable"* ]]; then
    pass "unverifiable process truth authorizes zero lease mutation"
  else
    fail "census failure did not fail closed rc=$rc log=[$(cat "$log_file")]"
  fi
}

test_fly1364_malformed_lease_fails_closed_when_census_drifts() {
  echo "Test: FLY-1364 xhigh R12 — two-snapshot census drift preserves the lease"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf 'broken-owner\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  MOCK_MUTATOR_CENSUS_SEQ=$'__EMPTY__\n4242|/bin/bash /tmp/flywheel-cmux-sync --watch'
  local rc=0 log_file="$TMPDIR_ROOT/fly1364-census-drift.log"
  acquire_mutator_lease once 2>"$log_file" || rc=$?
  if [[ "$rc" -eq 2 && -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" \
      && "$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner")" == 'broken-owner' \
      && "$(cat "$log_file")" == *'reason=process-census-changed'* ]]; then
    pass "a drifting census authorizes zero quarantine or lease replacement"
  else
    fail "census drift did not fail closed rc=$rc log=[$(cat "$log_file")] owner=[$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" 2>/dev/null)]"
  fi
}

test_fly1364_real_census_filters_invocation_tree_and_shell_prose() {
  echo "Test: FLY-1364 review HIGH — production census excludes its invocation tree/prose and keeps flagged interpreters"
  reset_mocks
  local own_pid="$$" child_pid=91001 grandchild_pid=91002 live_pid=92000 flagged_pid=92001 prose_pid=93000 out
  ps() {
    printf '%s %s /bin/bash /opt/flywheel-cmux-sync.sh --once fly1364-own-root\n' "$own_pid" "$PPID"
    printf '%s %s /bin/bash -e /opt/flywheel-cmux-sync.sh --once fly1364-own-child\n' "$child_pid" "$own_pid"
    printf '%s %s /bin/bash /opt/flywheel-cmux-sync.sh --watch fly1364-own-grandchild\n' "$grandchild_pid" "$child_pid"
    printf '%s 1 /bin/bash /opt/flywheel-cmux-sync.sh --watch\n' "$live_pid"
    printf '%s 1 /bin/bash -euxo pipefail /opt/flywheel-cmux-sync.sh --once\n' "$flagged_pid"
    printf '%s 1 /bin/bash -lc echo flywheel-cmux-sync.sh --watch\n' "$prose_pid"
  }
  out="$(_production_snapshot_live_mutator_processes)"
  unset -f ps
  if [[ "$out" == "$live_pid|/bin/bash /opt/flywheel-cmux-sync.sh --watch"$'\n'"$flagged_pid|/bin/bash -euxo pipefail /opt/flywheel-cmux-sync.sh --once" ]]; then
    pass "independent direct/flagged mutators survive while own descendants and -c prose do not"
  else
    fail "production census lost a flagged mutator or retained its own tree/shell prose: [$out]"
  fi
}

test_fly1364_real_census_excludes_command_substitution_processes() {
  echo "Test: FLY-1364 review HIGH — real ps census does not count its command-substitution shell"
  reset_mocks
  local marker="fly1364-real-census-$$-$RANDOM" out rc=0
  out="$(
    /bin/bash -c '
      source "$1"
      set +e
      first="$(_snapshot_live_mutator_processes)"; first_rc=$?
      second="$(_snapshot_live_mutator_processes)"; second_rc=$?
      printf "%s|%s\n%s\n%s\n" "$first_rc" "$second_rc" "$first" "$second"
    ' flywheel-cmux-sync.sh "$SCRIPT_DIR/flywheel-cmux-sync.sh" --once "$marker"
  )" || rc=$?
  if [[ "${out%%$'\n'*}" == "2|2" ]]; then
    pass "host process table is unavailable; deterministic production-filter case remains authoritative"
  elif [[ "$rc" -eq 0 && "${out%%$'\n'*}" == "0|0" && "$out" != *"$marker"* ]]; then
    pass "two real snapshots exclude every marker-bearing invocation descendant"
  else
    fail "real census counted or failed on its own process tree rc=$rc out=[$out]"
  fi
}

test_fly1364_lease_rebuild_crash_windows_converge() {
  echo "Test: FLY-1364 xhigh R12 — every global lease rebuild crash window converges"
  reset_mocks
  local base_lock="$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" point case_dir child_rc rc owner stale ok=1
  for point in after-quarantine-rename after-lease-dir-create \
      after-owner-publication after-owner-readback; do
    case_dir="$TMPDIR_ROOT/lease-crash-$point"
    mkdir -p "$case_dir/watcher.lock"
    printf 'broken-owner\n' > "$case_dir/watcher.lock/owner"
    child_rc=0
    FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$case_dir/watcher.lock" \
    FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="crashed-$point" \
    FLYWHEEL_CMUX_LEASE_CRASH_AT="$point" \
      /bin/bash -c '
        source "$1"
        _snapshot_live_mutator_processes() { return 0; }
        acquire_mutator_lease once
      ' _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" >/dev/null 2>&1 || child_rc=$?
    [[ "$child_rc" -eq 137 ]] || ok=0

    FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$case_dir/watcher.lock"
    WATCHER_LOCK_DIR="$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
    WATCHER_REAP_MUTEX="${WATCHER_LOCK_DIR}.reap"
    MUTATOR_LEASE_NONCE=""; MUTATOR_LEASE_INCARNATION=""; MUTATOR_LEASE_MODE=""
    MOCK_MUTATOR_CENSUS=""; MOCK_MUTATOR_CENSUS_SEQ=""
    rm -f "$TMPDIR_ROOT/mutator-census.n"
    rc=0
    acquire_mutator_lease qa_teardown || rc=$?
    owner=$(cat "$WATCHER_LOCK_DIR/owner" 2>/dev/null || true)
    stale=$(find "$case_dir" -maxdepth 1 -name 'watcher.lock.stale.*' -print 2>/dev/null)
    [[ "$rc" -eq 0 && "${owner%%|*}" == "$$" && -z "$stale" ]] || ok=0
    release_mutator_lease
  done
  FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$base_lock"
  WATCHER_LOCK_DIR="$base_lock"
  WATCHER_REAP_MUTEX="${base_lock}.reap"
  unset FLYWHEEL_CMUX_LEASE_CRASH_AT
  if [[ "$ok" == "1" ]]; then
    pass "quarantine/create/publish/readback crashes leave one recoverable owner and no stale quarantine"
  else
    fail "one or more global lease crash windows did not SIGKILL and converge"
  fi
}

test_fly1364_live_raw_owner_pid_with_unreadable_command_fails_closed() {
  echo "Test: FLY-1364 R6 — live raw owner pid with unreadable command is unverifiable, not stale"
  reset_mocks
  local live_pid
  /bin/sleep 30 & live_pid=$!
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf '%s|truncated\n' "$live_pid" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  local rc=0
  acquire_mutator_lease once >/dev/null 2>&1 || rc=$?
  command kill "$live_pid" 2>/dev/null || true
  if [[ "$rc" -eq 2 && -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "live-but-unreadable candidate remains fail-closed"
  else
    fail "unreadable live candidate was stolen rc=$rc"
  fi
}

test_fly1364_stale_generation_absent_ref_is_gced_without_current_rows() {
  echo "Test: FLY-1364 Fix F — stale-generation absent ref is GCed even with no current-generation rows"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="generation-current"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  test_ensure_mutator_lease
  printf 'committed|generation-old|workspace:90|FLY-1364-implement\n' > "$VIEW_LEDGER"
  local rc=0 log_file="$TMPDIR_ROOT/fly1364-stale-absent.log"
  reconcile_prepared_ledger 2>"$log_file" || rc=$?
  if [[ "$rc" -eq 0 && ! -s "$VIEW_LEDGER" \
      && "$(cat "$log_file")" == *"GC stale-generation ledger"* \
      && "$(cat "$log_file")" == *"ref=workspace:90"* ]]; then
    pass "stale absent receipt is collected independently of the current-generation pass"
  else
    fail "stale absent receipt leaked rc=$rc ledger=[$(cat "$VIEW_LEDGER")] log=[$(cat "$log_file")]"
  fi
}

test_fly1364_stale_generation_present_ref_is_preserved_without_migration() {
  echo "Test: FLY-1364 Fix F — stale-generation present ref is preserved and never migrated"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="generation-current"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:90","title":"FLY-1364-implement"}]}'
  test_ensure_mutator_lease
  printf 'committed|generation-old|workspace:90|FLY-1364-implement\n' > "$VIEW_LEDGER"
  local rc=0 row log_file="$TMPDIR_ROOT/fly1364-stale-present.log"
  reconcile_prepared_ledger 2>"$log_file" || rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$rc" -eq 0 && "$row" == 'committed|generation-old|workspace:90|FLY-1364-implement' \
      && "$(cat "$log_file")" == *"preserving stale-generation ledger"* \
      && "$(cat "$log_file")" == *"observed=FLY-1364-implement"* \
      && ! "$row" == *"generation-current"* \
      && ! "$MOCK_CMUX_OPS" == *"rename-workspace"* ]]; then
    pass "cross-generation ref reuse cannot silently upgrade authority"
  else
    fail "stale present ref migrated or lost rc=$rc row=[$row] log=[$(cat "$log_file")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_stale_prepared_unnamed_ref_is_not_renamed() {
  echo "Test: FLY-1364 Fix F — stale prepared row cannot rename a current unnamed foreign ref"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="generation-current"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:90","title":null}]}'
  test_ensure_mutator_lease
  printf 'prepared|generation-old|workspace:90|FLY-1364-implement\n' > "$VIEW_LEDGER"
  local rc=0
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 \
      && "$(cat "$VIEW_LEDGER")" == 'prepared|generation-old|workspace:90|FLY-1364-implement' \
      && ! "$MOCK_CMUX_OPS" == *"rename-workspace"* ]]; then
    pass "old prepared authority remains inert against a current-generation unnamed ref"
  else
    fail "stale prepared row mutated current object rc=$rc ledger=[$(cat "$VIEW_LEDGER")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_stale_generation_pass_aborts_on_midpass_generation_flip() {
  echo "Test: FLY-1364 Fix F — generation flip during stale pass preserves old authority"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="generation-current"
  MOCK_JSON_FLIP_IDENT="generation-next"
  MOCK_JSON_FLIP_AT=1
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  test_ensure_mutator_lease
  printf 'committed|generation-old|workspace:90|FLY-1364-implement\n' > "$VIEW_LEDGER"
  local rc=0
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 \
      && "$(cat "$VIEW_LEDGER")" == 'committed|generation-old|workspace:90|FLY-1364-implement' ]]; then
    pass "mid-pass cmux generation change fails closed before stale-row GC"
  else
    fail "generation flip did not stop stale mutation rc=$rc ledger=[$(cat "$VIEW_LEDGER")]"
  fi
}

test_fly1364_alert_library_forwards_exact_argv_and_fails_open() {
  echo "Test: FLY-1364 Fix D — shared alert library forwards exact argv and fails open"
  reset_mocks
  local stub="$TMPDIR_ROOT/fly1364-alert-stub" args="$TMPDIR_ROOT/fly1364-alert-args" rc=0
  printf '%s\n' '#!/bin/bash' 'printf "%s\\n" "$@" > "$FLYWHEEL_TEST_ALERT_ARGS"' 'exit "${FLYWHEEL_TEST_ALERT_RC:-0}"' > "$stub"
  chmod +x "$stub"
  FLYWHEEL_ALERT_BIN="$stub"
  FLYWHEEL_TEST_ALERT_ARGS="$args"
  export FLYWHEEL_ALERT_BIN FLYWHEEL_TEST_ALERT_ARGS
  flywheel_alert cmux_cleanup severe 'cleanup title' 'cleanup body' 'cleanup signature' || rc=$?
  local expected
  expected=$(printf '%s\n' --project flywheel --lead flywheel-eng-lead --kind cmux_cleanup --severity severe --title 'cleanup title' --body 'cleanup body' --signature 'cleanup signature')
  if [[ "$rc" -eq 0 && "$(cat "$args" 2>/dev/null)" == "$expected" ]]; then
    pass "shared library preserves every lead-alert argument byte"
  else
    fail "shared library argv mismatch rc=$rc args=[$(cat "$args" 2>/dev/null)]"
  fi
  FLYWHEEL_TEST_ALERT_RC=9
  export FLYWHEEL_TEST_ALERT_RC
  rc=0
  flywheel_alert cmux_cleanup warning title body signature >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    pass "alert executable failure remains a fail-open sidecar"
  else
    fail "alert executable failure leaked into host rc=$rc"
  fi
  local stdin_capture="$TMPDIR_ROOT/fly1364-alert-stdin" loop_seen=""
  printf '%s\n' \
    '#!/bin/bash' \
    'if IFS= read -r stolen; then printf "%s\n" "$stolen" >> "$FLYWHEEL_TEST_ALERT_STDIN"; fi' > "$stub"
  : > "$stdin_capture"
  FLYWHEEL_TEST_ALERT_STDIN="$stdin_capture"
  unset FLYWHEEL_TEST_ALERT_RC
  export FLYWHEEL_TEST_ALERT_STDIN
  while IFS= read -r row; do
    loop_seen+="$row,"
    flywheel_alert cmux_cleanup warning title body signature
  done <<< $'first\nsecond'
  if [[ "$loop_seen" == "first,second," && "$(cat "$stdin_capture")" == "" ]]; then
    pass "alert delivery cannot consume a caller's loop input"
  else
    fail "alert delivery inherited loop stdin rows=[$loop_seen] stolen=[$(cat "$stdin_capture" 2>/dev/null)]"
  fi
  unset FLYWHEEL_TEST_ALERT_RC FLYWHEEL_ALERT_BIN FLYWHEEL_TEST_ALERT_ARGS FLYWHEEL_TEST_ALERT_STDIN
}

test_fly1364_optional_alert_library_missing_is_noop() {
  echo "Test: FLY-1364 Fix D — missing deployed alert library warns once and installs a no-op"
  reset_mocks
  local deploy="$TMPDIR_ROOT/fly1364-deployed" source_tree="$TMPDIR_ROOT/fly1364-source"
  local stdout="$TMPDIR_ROOT/fly1364-missing.stdout"
  local stderr="$TMPDIR_ROOT/fly1364-missing.stderr" rc=0
  mkdir -p "$deploy" "$source_tree/lib"
  cp "$SCRIPT_DIR/flywheel-cmux-sync.sh" "$source_tree/flywheel-cmux-sync.sh"
  ln -s "$SCRIPT_DIR/lib/cmux-mutator-process-census.sh" \
    "$source_tree/lib/cmux-mutator-process-census.sh"
  ln -s "$source_tree/flywheel-cmux-sync.sh" "$deploy/flywheel-cmux-sync"
  /bin/bash -c 'source "$1"; flywheel_alert cmux_cleanup warning title body signature; printf host-ok' _ \
    "$deploy/flywheel-cmux-sync" >"$stdout" 2>"$stderr" || rc=$?
  if [[ "$rc" -eq 0 && "$(cat "$stdout")" == "host-ok" \
      && "$(grep -c 'optional alert library unavailable' "$stderr" || true)" == "1" ]]; then
    pass "missing library changes neither stdout nor rc and emits one diagnostic"
  else
    fail "missing-library fallback drift rc=$rc stdout=[$(cat "$stdout")] stderr=[$(cat "$stderr")]"
  fi
}

_fly1364_fixture_workspace_json() {
  python3 -c 'import json,sys; json.dump(json.load(open(sys.argv[1]))["workspace_json"], sys.stdout)' \
    "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1"
}

_fly1364_fixture_unit_workspace_json() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
target = data["expected"]["adopt_after_two_passes"][0]
workspace = next(w for w in data["workspace_json"]["workspaces"] if w["ref"] == target)
json.dump({"workspaces": [workspace]}, sys.stdout)
PY
}

_fly1364_fixture_workspace_row() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" <<'PY'
import json, sys
workspace = json.load(open(sys.argv[1]))["workspace_json"]["workspaces"][0]
print(f'{workspace["ref"]}|{workspace["title"]}')
PY
}

_fly1364_fixture_expected_adoption_refs() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" <<'PY'
import json, sys
for ref in json.load(open(sys.argv[1]))["expected"]["adopt_after_two_passes"]:
    print(ref)
PY
}

_fly1364_fixture_unit_adoption_ref() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["expected"]["adopt_after_two_passes"][0])
PY
}

_fly1364_fixture_expected_preserve_refs() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" <<'PY'
import json, sys
for ref in json.load(open(sys.argv[1])).get("controls", {}).get("workspace_refs", []):
    print(ref)
PY
}

_fly1364_fixture_expected_alert_reasons() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" <<'PY'
import json, sys
for reason in json.load(open(sys.argv[1]))["expected"].get("alert_reasons", []):
    print(reason)
PY
}

_fly1364_fixture_expected_number() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" "$2" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["expected"].get(sys.argv[2], -1))
PY
}

_fly1364_fixture_controls() {
  python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$1" <<'PY'
import json, sys
for control in json.load(open(sys.argv[1])).get("controls", {}).get("invalid_titles", []):
    print(control)
PY
}

_fly1364_load_fixture_topology() {
  local fixture="$1" mode="${2:-full}" rows kind a b c d e _f _g
  rows=$(python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$fixture" "$mode" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
mode = sys.argv[2]
raw_sessions = data["tmux_sessions"]
sessions = []
for index, raw in enumerate(raw_sessions, 1):
    item = {"name": raw} if isinstance(raw, str) else dict(raw)
    item.setdefault("id", f"$fixture{index}")
    item.setdefault("group", "")
    item.setdefault("owner", "")
    item.setdefault("marker", "")
    sessions.append(item)
names = [item["name"] for item in sessions]
assert len(names) == len(set(names))
selected = {"flywheel"} if mode == "unit" else set(names)
for item in sessions:
    if item["name"] not in selected:
        continue
    assert all("|" not in str(item[key]) for key in ("name", "id", "group", "owner", "marker"))
    print("S", item["name"], item["id"], item["group"], item["owner"], item["marker"], sep="|")
seen = set()
for window in data["tmux_windows"]:
    session = window["session"]
    assert session in set(names)
    if session not in selected:
        continue
    assert all("|" not in str(window[key]) for key in ("id", "title"))
    active = window.get("active", 0 if session in seen else 1)
    seen.add(session)
    dead = 1 if window["pane_dead"] else 0
    print("W", session, window["id"], window["title"], active, dead, sep="|")
PY
  ) || return 1
  while IFS='|' read -r kind a b c d e _f _g; do
    case "$kind" in
      S) topo_add_session "$a" "$b" "$c" "$d" "$e" ;;
      W) topo_add_window "$a" "$b" "$c" "$d" "$e" ;;
      *) return 1 ;;
    esac
  done <<< "$rows"
}

_fly1364_load_fixture_initial_state() {
  local fixture="$1" rows kind value
  rows=$(python3 - "$SCRIPT_DIR/__tests__/fixtures/fly1364/$fixture" <<'PY'
import json, sys
initial = json.load(open(sys.argv[1])).get("initial", {})
for row in initial.get("ledger", []):
    print("L|" + row)
for row in initial.get("adoption", []):
    print("A|" + row)
PY
  ) || return 1
  while IFS='|' read -r kind value; do
    [[ -z "$kind" ]] && continue
    case "$kind" in
      L) printf '%s\n' "$value" >> "$VIEW_LEDGER" ;;
      A) printf '%s\n' "$value" >> "$ADOPTION_STATE" ;;
      *) return 1 ;;
    esac
  done <<< "$rows"
}

_fly1364_fixture_base() {
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  FLYWHEEL_CMUX_ADOPTION_GRACE=0
  MOCK_SOCK_IDENT="generation-stock"
  MOCK_CMUX_MUTATE_JSON=1
}

_fly1364_stock_fixture() {
  local fixture="$1"
  _fly1364_fixture_base
  _fly1364_load_fixture_topology "$fixture" unit || return 1
  MOCK_CMUX_WORKSPACES_JSON=$(_fly1364_fixture_unit_workspace_json "$fixture")
  test_ensure_mutator_lease
}

_fly1364_full_fixture() {
  local fixture="$1"
  _fly1364_fixture_base
  _fly1364_load_fixture_topology "$fixture" full || return 1
  _fly1364_load_fixture_initial_state "$fixture" || return 1
  MOCK_CMUX_WORKSPACES_JSON=$(_fly1364_fixture_workspace_json "$fixture")
  test_ensure_mutator_lease
}

test_fly1364_stock_fixture_contracts() {
  echo "Test: FLY-1364 R6 fixtures — four production scenarios carry executable state and provenance"
  local dir="$SCRIPT_DIR/__tests__/fixtures/fly1364" count ok=1
  count=$(find "$dir" -maxdepth 1 -type f -name 'fly-*.json' | wc -l | tr -d ' ')
  [[ "$count" == "4" ]] || ok=0
  python3 - "$dir" <<'PY' || ok=0
import glob, json, os, sys
expected = {
    "fly-1385-closed-stock.json",
    "fly-1393-redispatch.json",
    "fly-1404-attach-exited.json",
    "fly-1402-closed-ghost.json",
}
paths = glob.glob(os.path.join(sys.argv[1], "*.json"))
assert {os.path.basename(p) for p in paths} == expected
for path in paths:
    data = json.load(open(path))
    assert data["scenario"] and data["provenance"]
    assert isinstance(data["workspace_json"]["workspaces"], list)
    assert isinstance(data["tmux_sessions"], list)
    assert isinstance(data["tmux_windows"], list)
    assert isinstance(data["expected"], dict)
    assert set(data.get("initial", {})) == {"ledger", "adoption"}
    assert all(isinstance(data["initial"][key], list) for key in ("ledger", "adoption"))
    names = [s if isinstance(s, str) else s["name"] for s in data["tmux_sessions"]]
    sessions = set(names)
    assert len(sessions) == len(names)
    assert all(w["session"] in sessions for w in data["tmux_windows"])
    assert all(isinstance(w["pane_dead"], bool) for w in data["tmux_windows"])
    if "adopt_after_two_passes" in data["expected"]:
        refs = {w["ref"] for w in data["workspace_json"]["workspaces"]}
        assert set(data["expected"]["adopt_after_two_passes"]) <= refs
        assert set(data["expected"]["preserve_refs"]) <= refs
        assert data["expected"]["minimum_adopt_count"] <= len(data["expected"]["adopt_after_two_passes"])
        assert isinstance(data["expected"]["keeper_count"], int)
        assert data["expected"]["alert_reasons"]
    if "controls" in data:
        controls = data["controls"]
        assert set(controls) == {"workspace_refs", "invalid_titles"}
        assert all(isinstance(controls[key], list) for key in controls)
        assert all(isinstance(c, str) for key in controls for c in controls[key])
        assert set(controls["workspace_refs"]) == set(data["expected"].get("preserve_refs", []))
    if os.path.basename(path) == "fly-1404-attach-exited.json":
        view = data["expected"]["view_session"]
        generation = data["expected"]["receipt_generation"]
        refs = data["workspace_json"]["workspaces"]
        assert len(refs) == 1
        sessions_by_name = {s if isinstance(s, str) else s["name"]: s for s in data["tmux_sessions"]}
        assert isinstance(sessions_by_name[view], dict)
        assert sessions_by_name[view]["owner"] == "runner-flywheel"
        assert sessions_by_name[view]["marker"] == "0"
        assert any(w["session"] == view and w["id"] == "@1404" for w in data["tmux_windows"])
        assert data["initial"]["ledger"] == [
            f'committed|{generation}|{refs[0]["ref"]}|{refs[0]["title"]}'
        ]
PY
  if [[ "$ok" == "1" ]]; then
    pass "1385/1393/1404/1402 fixtures are parseable and provenance-marked"
  else
    fail "four-scenario fixture contract is incomplete"
  fi
}

test_fly1364_complete_stock_fixtures_drive_terminal_state() {
  echo "Test: FLY-1364 fixtures 1385/1402 — complete incident state drives cleanup and controls"
  local fixture expected preserve reasons minimum keeper_expected first_ops alerts saved_alert
  local ref reason actual_remaining expected_remaining keeper_actual ok
  for fixture in fly-1385-closed-stock.json fly-1402-closed-ghost.json; do
    expected=$(_fly1364_fixture_expected_adoption_refs "$fixture")
    preserve=$(_fly1364_fixture_expected_preserve_refs "$fixture")
    reasons=$(_fly1364_fixture_expected_alert_reasons "$fixture")
    minimum=$(_fly1364_fixture_expected_number "$fixture" minimum_adopt_count)
    keeper_expected=$(_fly1364_fixture_expected_number "$fixture" keeper_count)
    if [[ "$minimum" -lt 1 || "$(printf '%s\n' "$expected" | sed '/^$/d' | wc -l | tr -d ' ')" -lt "$minimum" \
        || -z "$preserve" || -z "$reasons" || "$keeper_expected" -lt 0 ]]; then
      fail "$fixture does not encode complete adopted/preserved/alert/terminal expectations"
      continue
    fi
    _fly1364_full_fixture "$fixture"
    alerts="$TMPDIR_ROOT/${fixture}.alerts"
    : > "$alerts"
    saved_alert=$(declare -f flywheel_alert)
    flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
    reap_unledgered_stock_workspaces
    first_ops="$MOCK_CMUX_OPS"
    reap_unledgered_stock_workspaces
    eval "$saved_alert"
    ok=1
    [[ -z "$first_ops" ]] || ok=0
    while IFS= read -r ref; do
      [[ -z "$ref" ]] && continue
      [[ "$(grep -c "^close-workspace --workspace $ref$" <<< "$MOCK_CMUX_OPS" || true)" == "1" ]] || ok=0
    done <<< "$expected"
    actual_remaining=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c 'import json,sys; print("\n".join(sorted(w["ref"] for w in json.load(sys.stdin)["workspaces"])))')
    expected_remaining=$(printf '%s\n' "$preserve" | sed '/^$/d' | sort)
    [[ "$actual_remaining" == "$expected_remaining" ]] || ok=0
    while IFS= read -r reason; do
      [[ -z "$reason" ]] && continue
      grep -q "reason=$reason" "$alerts" || ok=0
    done <<< "$reasons"
    if [[ -f "$KEEPER_INVENTORY" ]]; then
      keeper_actual=$(awk -F'|' '$6 == "committed" { n++ } END { print n+0 }' "$KEEPER_INVENTORY")
    else
      keeper_actual=0
    fi
    [[ "$keeper_actual" == "$keeper_expected" && ! -s "$VIEW_LEDGER" && ! -s "$ADOPTION_STATE" ]] || ok=0
    if [[ "$ok" == "1" ]]; then
      pass "$fixture derives exact closes, preserved controls, alerts, and terminal authority from JSON"
    else
      fail "$fixture terminal mismatch ops=[$MOCK_CMUX_OPS] remaining=[$actual_remaining] preserve=[$expected_remaining] alerts=[$(tr '\n' ';' < "$alerts")] keeper=$keeper_actual/$keeper_expected ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] adoption=[$(cat "$ADOPTION_STATE" 2>/dev/null)]"
    fi
  done
}

test_fly1364_raw_attach_normalization_is_exact() {
  echo "Test: FLY-1364 R6 raw title — only the evidenced canonical attach grammar normalizes"
  if ! type normalize_stock_workspace_title >/dev/null 2>&1; then
    fail "normalize_stock_workspace_title is not implemented"
    return
  fi
  local canonical out="" bad ok=1
  IFS='|' read -r _ canonical <<< "$(_fly1364_fixture_workspace_row fly-1402-closed-ghost.json)"
  out=$(normalize_stock_workspace_title "$canonical" 2>/dev/null || true)
  [[ "$out" == "FLY-1402-qa-retest" ]] || ok=0
  while IFS= read -r bad; do
    if normalize_stock_workspace_title "$bad" >/dev/null 2>&1; then ok=0; fi
  done < <(_fly1364_fixture_controls fly-1402-closed-ghost.json)
  if [[ "$ok" == "1" ]]; then
    pass "canonical raw attach normalizes; user/extra-token/malformed variants fail closed"
  else
    fail "raw attach grammar widened or rejected its evidenced canonical form"
  fi
}

test_fly1364_raw_attach_blocks_unledgered_view_teardown() {
  echo "Test: FLY-1364 R6 raw title — pre-adoption workspace blocks normalized view teardown"
  _fly1364_stock_fixture fly-1402-closed-ghost.json
  local workspace_ref raw normalized rc=0 saved_alert
  IFS='|' read -r workspace_ref raw <<< "$(_fly1364_fixture_workspace_row fly-1402-closed-ghost.json)"
  normalized=$(normalize_stock_workspace_title "$raw") || {
    fail "fixture raw title did not normalize"
    return
  }
  topo_add_session "cmux-$normalized" '$1402' "" "runner-flywheel" "0"
  topo_add_window "cmux-$normalized" "@1402" "$normalized" 1 1
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { return 0; }
  : > "$TOPO_JOURNAL"
  dismantle_view_display "$normalized" "pre-adoption" || rc=$?
  eval "$saved_alert"
  if [[ "$rc" -ne 0 && -z "$MOCK_CMUX_OPS" ]] \
      && topo_session_exists "cmux-$normalized" \
      && ! grep -Eq '^(unlink-window|rename-session|kill-window|kill-session|link-window|new-session)' "$TOPO_JOURNAL"; then
    pass "raw-attach stock preserves its view until an exact receipt authorizes teardown"
  else
    fail "raw-attach stock allowed pre-receipt teardown rc=$rc ops=[$MOCK_CMUX_OPS] topology=[$(cat "$TOPO_SESSIONS")] journal=[$(cat "$TOPO_JOURNAL")]"
  fi
}

test_fly1364_stock_adoption_two_pass_exact_close() {
  echo "Test: FLY-1364 R6 stock adoption — two identical passes receipt then exact-close an ordinary dead tab"
  if ! type reap_unledgered_stock_workspaces >/dev/null 2>&1; then
    fail "reap_unledgered_stock_workspaces is not implemented"
    return
  fi
  _fly1364_stock_fixture fly-1385-closed-stock.json
  local workspace_ref workspace_title expected_refs trace="$TMPDIR_ROOT/stock-adoption-trace"
  local saved_close first_ops first_state
  IFS='|' read -r workspace_ref workspace_title <<< "$(_fly1364_fixture_workspace_row fly-1385-closed-stock.json)"
  expected_refs=$(_fly1364_fixture_unit_adoption_ref fly-1385-closed-stock.json)
  : > "$trace"
  saved_close=$(declare -f close_ledger_workspace_ref)
  eval "$(declare -f close_ledger_workspace_ref | sed '1s/close_ledger_workspace_ref/close_ledger_workspace_ref_impl/')"
  close_ledger_workspace_ref() {
    ledger_committed_ref "$1" "$2" "$3" && printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$trace"
    close_ledger_workspace_ref_impl "$@"
  }
  reap_unledgered_stock_workspaces
  first_ops="$MOCK_CMUX_OPS"
  first_state=$(cat "$ADOPTION_STATE" 2>/dev/null || true)
  reap_unledgered_stock_workspaces
  eval "$saved_close"
  if [[ -z "$first_ops" && -n "$first_state" && ! -s "$ADOPTION_STATE" \
      && "$expected_refs" == "$workspace_ref" \
      && "$(cat "$trace")" == "generation-stock|$workspace_ref|$workspace_title" \
      && "$(grep -c "^close-workspace --workspace $workspace_ref$" <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && ! -s "$VIEW_LEDGER" ]]; then
    pass "first pass only persists evidence; second adopts and exact-closes under ledger authority"
  else
    fail "ordinary adoption mismatch first_ops=[$first_ops] state=[$(cat "$ADOPTION_STATE" 2>/dev/null)] trace=[$(cat "$trace")] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly2048_operator_adopts_legacy_prepared_stock() {
  echo "Test: FLY-2048 operator convergence adopts an exact legacy prepared orphan"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  local workspace_ref workspace_title
  IFS='|' read -r workspace_ref workspace_title <<< "$(_fly1364_fixture_workspace_row fly-1385-closed-stock.json)"
  test_ledger_upsert prepared generation-stock "$workspace_ref" "$workspace_title"
  FLYWHEEL_CMUX_STOCK_ALLOW_LEGACY_PREPARED=1 reap_unledgered_stock_workspaces
  FLYWHEEL_CMUX_STOCK_ALLOW_LEGACY_PREPARED=1 reap_unledgered_stock_workspaces
  if [[ "$(grep -c "^close-workspace --workspace $workspace_ref$" <<< "$MOCK_CMUX_OPS" || true)" == 1 \
      && ! -s "$VIEW_LEDGER" && ! -s "$ADOPTION_STATE" ]]; then
    pass "two exact stock observations promote and close legacy prepared authority"
  else
    fail "legacy prepared stock stayed visible ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] adoption=[$(cat "$ADOPTION_STATE" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_malformed_duplicate_is_not_candidate() {
  echo "Test: FLY-1364 R6 stock adoption — malformed same-title duplicates block every candidate"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[
    {"ref":"workspace:1385","title":"FLY-1385-qa-retest"},
    {"ref":"bad-ref","title":"FLY-1385-qa-retest"}
  ]}'
  local saved_alert
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { return 0; }
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  eval "$saved_alert"
  if [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" && ! -s "$ADOPTION_STATE" ]]; then
    pass "malformed duplicate keeps the normalized title entirely outside adoption"
  else
    fail "malformed duplicate leaked a valid adoption candidate ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] adoption=[$(cat "$ADOPTION_STATE" 2>/dev/null)]"
  fi
}

test_fly1364_once_heals_quiet_strict_sole_holder() {
  echo "Test: FLY-1364 fixture 1404 — exited attach is repaired without source churn"
  reset_mocks
  local fixture="$SCRIPT_DIR/__tests__/fixtures/fly1364/fly-1404-attach-exited.json"
  local fixture_row session wid title dead workspace_ref workspace_title view surface_ref screen clients deadline generation
  fixture_row=$(python3 - "$fixture" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
w = next(w for w in d["tmux_windows"] if w["session"] == "runner-flywheel")
ws = d["workspace_json"]["workspaces"][0]
s = d["surface"]
e = d["expected"]
print("|".join([w["session"], w["id"], w["title"], str(w["pane_dead"]).lower(), ws["ref"], ws["title"], e["view_session"], s["ref"], s["screen"], str(s["view_clients"]), str(e["periodic_attach_heal_within_seconds"]), e["receipt_generation"]]))
PY
  )
  IFS='|' read -r session wid title dead workspace_ref workspace_title view surface_ref screen clients deadline generation <<< "$fixture_row"
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="$generation"
  _fly1364_load_fixture_topology fly-1404-attach-exited.json full || {
    fail "1404 fixture topology did not load"
    return
  }
  _fly1364_load_fixture_initial_state fly-1404-attach-exited.json || {
    fail "1404 fixture authority did not load"
    return
  }
  MOCK_CMUX_WORKSPACES_JSON=$(_fly1364_fixture_workspace_json fly-1404-attach-exited.json)
  MOCK_CMUX_SURFACES="$workspace_ref;;$surface_ref;;terminal;;true"
  MOCK_CMUX_READSCREEN="$screen"
  MOCK_TMUX_CLIENTS="$view=$clients"
  sync_once >/dev/null 2>&1 || true
  if [[ "$deadline" == "60" \
      && "$(grep -c "^send --workspace $workspace_ref " <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "1404 fixture drives the detached-screen/client state into attach repair"
  else
    fail "1404 fixture heal mismatch deadline=$deadline screen=[$screen] clients=$clients ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_raw_attach_stock_adoption() {
  echo "Test: FLY-1364 R6 stock adoption — evidenced raw attach title is receipted byte-for-byte then closed"
  if ! type reap_unledgered_stock_workspaces >/dev/null 2>&1; then
    fail "reap_unledgered_stock_workspaces is not implemented"
    return
  fi
  _fly1364_stock_fixture fly-1402-closed-ghost.json
  local workspace_ref raw expected_refs trace="$TMPDIR_ROOT/raw-adoption-trace" saved_close
  IFS='|' read -r workspace_ref raw <<< "$(_fly1364_fixture_workspace_row fly-1402-closed-ghost.json)"
  expected_refs=$(_fly1364_fixture_unit_adoption_ref fly-1402-closed-ghost.json)
  : > "$trace"
  saved_close=$(declare -f close_ledger_workspace_ref)
  eval "$(declare -f close_ledger_workspace_ref | sed '1s/close_ledger_workspace_ref/close_ledger_workspace_ref_impl/')"
  close_ledger_workspace_ref() {
    ledger_committed_ref "$1" "$2" "$3" && printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$trace"
    close_ledger_workspace_ref_impl "$@"
  }
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  eval "$saved_close"
  if [[ "$expected_refs" == "$workspace_ref" \
      && "$(cat "$trace")" == "generation-stock|$workspace_ref|$raw" \
      && "$(grep -c "^close-workspace --workspace $workspace_ref$" <<< "$MOCK_CMUX_OPS" || true)" == "1" ]]; then
    pass "raw title retains byte identity through committed receipt and exact close"
  else
    fail "raw adoption mismatch trace=[$(cat "$trace")] ops=[$MOCK_CMUX_OPS]"
  fi
}

test_fly1364_stock_adoption_preserves_live_sole_holder() {
  echo "Test: FLY-1364 R6 stock adoption — live independent sole-holder view is never a cleanup candidate"
  if ! type reap_unledgered_stock_workspaces >/dev/null 2>&1; then
    fail "reap_unledgered_stock_workspaces is not implemented"
    return
  fi
  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-1385-qa-retest" 1 0
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  if [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" ]]; then
    pass "live sole-holder survives with zero receipt and zero close"
  else
    fail "live sole-holder was adopted or mutated ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_once_preserves_live_strict_sole_holder() {
  echo "Test: FLY-1364 R6 one-shot cleanup — a live strict view remains authoritative after its source retires"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-1385-qa-retest" 1 0
  test_ledger_upsert committed generation-stock workspace:1385 FLY-1385-qa-retest
  cleanup_stale_workspaces
  if [[ -z "$MOCK_CMUX_OPS" \
      && "$(cat "$VIEW_LEDGER")" == 'committed|generation-stock|workspace:1385|FLY-1385-qa-retest' ]] \
      && topo_session_exists "cmux-FLY-1385-qa-retest"; then
    pass "one-shot cleanup preserves the live sole-holder workspace, receipt, and strict view"
  else
    fail "one-shot cleanup destroyed a live sole-holder ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] topology=[$(cat "$TOPO_SESSIONS")]"
  fi
}

test_fly1364_stock_adoption_rejects_foreign_or_drifted_dead_view() {
  echo "Test: FLY-1364 R6 stock adoption — foreign ownership and drifted topology are preservation-only"
  local foreign_ok=0 drifted_ok=0 grouped_foreign_ok=0 grouped_drift_ok=0 saved_alert
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { return 0; }

  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "" "foreign-owner" "0"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-1385-qa-retest" 1 1
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" ]] && foreign_ok=1

  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-1385-qa-retest" 1 1
  topo_add_window "cmux-FLY-1385-qa-retest" "@9999" "foreign-extra" 0 1
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" ]] && drifted_ok=1

  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "user-session"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-1385-qa-retest" 1 1
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" ]] && grouped_foreign_ok=1

  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "runner-flywheel"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-9999-foreign" 1 1
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" ]] && grouped_drift_ok=1
  eval "$saved_alert"

  if [[ "$foreign_ok" == "1" && "$drifted_ok" == "1" \
      && "$grouped_foreign_ok" == "1" && "$grouped_drift_ok" == "1" ]]; then
    pass "unproven independent or legacy-grouped dead views never become cleanup authority"
  else
    fail "stock adoption touched an unproven view foreign_ok=$foreign_ok drifted_ok=$drifted_ok grouped_foreign_ok=$grouped_foreign_ok grouped_drift_ok=$grouped_drift_ok ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_fingerprint_ignores_unrelated_churn() {
  echo "Test: FLY-1364 R6 stock adoption — unrelated runner churn cannot restart a candidate grace period"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  reap_unledgered_stock_workspaces
  topo_add_session "runner-unrelated" '$77'
  topo_add_window "runner-unrelated" "@77" "FLY-777-unrelated" 1 0
  reap_unledgered_stock_workspaces
  if [[ "$(grep -c '^close-workspace --workspace workspace:1385$' <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && ! -s "$ADOPTION_STATE" && ! -s "$VIEW_LEDGER" ]]; then
    pass "candidate converges across unrelated session and window churn"
  else
    fail "unrelated churn restarted stock grace ops=[$MOCK_CMUX_OPS] adoption=[$(cat "$ADOPTION_STATE" 2>/dev/null)] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_alerts_on_unreadable_topology() {
  echo "Test: FLY-1364 R6 stock adoption — unreadable topology preserves stock and emits one refusal alert"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  MOCK_TMUX_LIST_FAIL=1
  local alerts="$TMPDIR_ROOT/adoption-topology-alerts" saved_alert
  : > "$alerts"
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  reap_unledgered_stock_workspaces
  eval "$saved_alert"
  if [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" \
      && "$(grep -c '^cmux_cleanup|' "$alerts" || true)" == "1" \
      && "$(cat "$alerts")" == *'reason=topology-inventory-unreadable'* ]]; then
    pass "topology uncertainty is zero-mutation and operator-visible"
  else
    fail "topology uncertainty was silent or mutated state alerts=[$(cat "$alerts")] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_accepts_owned_dead_view() {
  echo "Test: FLY-1364 R6 stock adoption — proven owned dead view permits exact-ref cleanup"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-1385-qa-retest" 1 1
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  local keeper canonical_exists=0
  keeper=$(awk -F'|' '$6 == "committed" { print $3; exit }' "$KEEPER_INVENTORY" 2>/dev/null || true)
  topo_session_exists "cmux-FLY-1385-qa-retest" && canonical_exists=1
  if [[ "$(grep -c '^close-workspace --workspace workspace:1385$' <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && "$canonical_exists" == "0" && "$keeper" == fwkeeper-* ]]; then
    pass "owned dead stock closes exact ref and moves the sole-holder shell to an inventoried keeper"
  else
    fail "owned-dead convergence mismatch keeper=[$keeper] ops=[$MOCK_CMUX_OPS] topology=[$(cat "$TOPO_SESSIONS")]"
  fi
}

test_fly1364_stock_adoption_rejects_markerless_grouped_dead_view() {
  echo "Test: FLY-1364 R6 ownership — a markerless grouped dead view cannot mint cleanup authority"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  topo_add_session "cmux-FLY-1385-qa-retest" '$2' "runner-flywheel"
  topo_add_window "cmux-FLY-1385-qa-retest" "@1385" "FLY-1385-qa-retest" 1 1
  MOCK_CMUX_SURFACES="workspace:1385;;surface:1385;;terminal;;true;;env -u TMUX tmux attach -t '=cmux-FLY-1385-qa-retest'"
  local alerts="$TMPDIR_ROOT/markerless-grouped-alerts" saved_alert
  : > "$alerts"
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  eval "$saved_alert"
  local canonical_exists=0
  topo_session_exists "cmux-FLY-1385-qa-retest" && canonical_exists=1
  if [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" \
      && "$canonical_exists" == "1" \
      && "$(grep -c '^cmux_cleanup|' "$alerts" || true)" == "1" \
      && "$(cat "$alerts")" == *'reason=foreign-or-unproven-view'* ]]; then
    pass "markerless grouped stock is preserved and refusal is operator-visible"
  else
    fail "markerless grouped stock gained inferred authority alerts=[$(cat "$alerts")] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] topology=[$(cat "$TOPO_SESSIONS")]"
  fi
}

test_fly1364_receipted_legacy_grouped_view_migrates() {
  echo "Test: FLY-1364 R6 upgrade — an already-receipted grouped view migrates without inferred authority"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="generation-upgrade"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1364","title":"FLY-1364-qa-retest"}]}'
  MOCK_CMUX_SURFACES="workspace:1364;;surface:1364;;terminal;;true;;env -u TMUX tmux attach -t '=cmux-FLY-1364-qa-retest'"
  topo_add_session "runner-flywheel" '$1' "runner-flywheel"
  topo_add_window "runner-flywheel" "@1364" "FLY-1364-qa-retest" 1 0
  topo_add_session "cmux-FLY-1364-qa-retest" '$2' "runner-flywheel"
  topo_add_window "cmux-FLY-1364-qa-retest" "@1364" "FLY-1364-qa-retest" 1 0
  test_ensure_mutator_lease
  test_ledger_upsert committed generation-upgrade workspace:1364 FLY-1364-qa-retest
  local saved_alert
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { return 0; }
  repair_view_invariants
  repair_view_invariants
  eval "$saved_alert"
  local grouped owner active members snapshot
  snapshot=$(_view_session_snapshot "cmux-FLY-1364-qa-retest" 2>/dev/null || true)
  IFS='|' read -r _ grouped active owner _ members <<< "$snapshot"
  if [[ "$(grep -c '^close-workspace --workspace workspace:1364$' <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && "$grouped" == "0" && "$active" == "@1364" \
      && "$owner" == "runner-flywheel" && "$members" == "@1364" ]]; then
    pass "receipted grouped display is retired and rebuilt as an independent exact view"
  else
    fail "legacy grouped live migration did not converge snapshot=[$snapshot] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_legacy_grouped_backfill_refuses_foreign_same_title_ref() {
  echo "Test: FLY-1364 R6 upgrade — title equality alone cannot receipt a founder workspace"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="generation-upgrade-foreign"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:999","title":"FLY-1364-qa-retest"}]}'
  # Surface title is the mutable foreground command, not immutable creation
  # provenance. Even an exact canonical attach title must not mint authority.
  MOCK_CMUX_SURFACES="workspace:999;;surface:999;;terminal;;true;;env -u TMUX tmux attach -t '=cmux-FLY-1364-qa-retest'"
  topo_add_session "runner-flywheel" '$1' "runner-flywheel"
  topo_add_window "runner-flywheel" "@1364" "FLY-1364-qa-retest" 1 0
  topo_add_session "cmux-FLY-1364-qa-retest" '$2' "runner-flywheel"
  topo_add_window "cmux-FLY-1364-qa-retest" "@1364" "FLY-1364-qa-retest" 1 0
  test_ensure_mutator_lease
  local alerts="$TMPDIR_ROOT/grouped-foreign-alerts" saved_alert
  : > "$alerts"
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  repair_view_invariants
  repair_view_invariants
  eval "$saved_alert"
  if [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" \
      && -s "$alerts" && "$(cat "$alerts")" == *'reason=missing-exact-receipt'* \
      && "$(_view_session_snapshot "cmux-FLY-1364-qa-retest")" == *'|1|@1364|||'* ]]; then
    pass "foreign same-title ref is preserved without receipt or view mutation"
  else
    fail "title-only grouped backfill gained authority alerts=[$(cat "$alerts")] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_ledger_receipt_does_not_authorize_foreign_view_shell() {
  echo "Test: FLY-1364 view teardown — workspace receipt cannot authorize a foreign same-name tmux session"
  local kind rc canonical ok=1
  for kind in independent grouped; do
    reset_mocks
    MOCK_TOPOLOGY_MODE=1
    MOCK_CMUX_MUTATE_JSON=1
    FLYWHEEL_CMUX_LINKED_VIEW=0
    MOCK_SOCK_IDENT="generation-view-ownership"
    MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1364","title":"FLY-1364-qa-retest"}]}'
    if [[ "$kind" == "independent" ]]; then
      topo_add_session "cmux-FLY-1364-qa-retest" '$8' "" "foreign-owner" "0"
    else
      topo_add_session "cmux-FLY-1364-qa-retest" '$8' "user-session"
    fi
    topo_add_window "cmux-FLY-1364-qa-retest" "@1364" "FLY-1364-qa-retest" 1 1
    test_ledger_upsert committed generation-view-ownership workspace:1364 FLY-1364-qa-retest
    : > "$TOPO_JOURNAL"
    rc=0
    dismantle_view_display FLY-1364-qa-retest ledgered-foreign-view || rc=$?
    canonical=0; topo_session_exists "cmux-FLY-1364-qa-retest" && canonical=1
    [[ "$rc" != "0" && "$canonical" == "1" \
        && ! "$(cat "$TOPO_JOURNAL")" == *'rename-session'* \
        && ! "$(cat "$TOPO_JOURNAL")" == *'unlink-window'* ]] || ok=0
  done
  if [[ "$ok" == "1" ]]; then
    pass "ledgered foreign independent and grouped sessions remain byte-topology untouched"
  else
    fail "workspace authority leaked into foreign tmux-session authority"
  fi
}

test_fly1364_strict_view_probe_uncertainty_never_authorizes_cleanup() {
  echo "Test: FLY-1364 view lifetime — strict sole-holder probe uncertainty preserves the view"
  reset_mocks
  MOCK_TOPOLOGY_MODE=1
  FLYWHEEL_CMUX_LINKED_VIEW=0
  MOCK_SOCK_IDENT="generation-liveness"
  topo_add_session "cmux-FLY-1364-qa-retest" '$2' "" "runner-flywheel" "0"
  topo_add_window "cmux-FLY-1364-qa-retest" "@1364" "FLY-1364-qa-retest" 1 0
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1364","title":"FLY-1364-qa-retest"}]}'
  test_ledger_upsert committed generation-liveness workspace:1364 FLY-1364-qa-retest
  printf 'FLY-1364-qa-retest|1\n' > "$CLEANUP_PENDING"
  MOCK_TMUX_DISPLAY_FAIL=1
  local pane_rc=0
  is_pane_alive "FLY-1364-qa-retest" || pane_rc=$?
  process_pending_cleanups
  if [[ "$pane_rc" == "2" && -z "$MOCK_CMUX_OPS" \
      && -s "$CLEANUP_PENDING" ]] && topo_session_exists "cmux-FLY-1364-qa-retest"; then
    pass "uncertain strict-view liveness is tri-state and cleanup stays pending"
  else
    fail "strict-view uncertainty was treated as death rc=$pane_rc ops=[$MOCK_CMUX_OPS] pending=[$(cat "$CLEANUP_PENDING" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_revalidates_source_reappearance() {
  echo "Test: FLY-1364 R6 stock adoption — source reappearance between passes cancels authority"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  reap_unledgered_stock_workspaces
  topo_add_session "runner-flywheel" '$9'
  topo_add_window "runner-flywheel" "@1385" "FLY-1385-qa-retest" 1 0
  reap_unledgered_stock_workspaces
  if [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" ]]; then
    pass "fresh source evidence cancels the pending adoption without mutation"
  else
    fail "source reappearance did not cancel adoption ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_final_guard_revalidates_source_reappearance() {
  echo "Test: FLY-1364 R6 stock adoption — source reappearance after receipt blocks the close mutation"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  reap_unledgered_stock_workspaces
  local saved_upsert
  saved_upsert=$(declare -f _ledger_upsert)
  eval "$(declare -f _ledger_upsert | sed '1s/_ledger_upsert/_ledger_upsert_impl/')"
  _ledger_upsert() {
    local rc=0
    _ledger_upsert_impl "$@" || rc=$?
    if [[ "$rc" == "0" && "${1:-}" == "committed" ]]; then
      topo_add_session "runner-flywheel" '$9'
      topo_add_window "runner-flywheel" "@1385" "FLY-1385-qa-retest" 1 0
    fi
    return "$rc"
  }
  reap_unledgered_stock_workspaces
  eval "$saved_upsert"
  unset -f _ledger_upsert_impl
  if [[ -z "$MOCK_CMUX_OPS" \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == 'committed|generation-stock|workspace:1385|FLY-1385-qa-retest' ]]; then
    pass "last-operation stock guard preserves the ref when a live source returns after receipting"
  else
    fail "post-receipt source race crossed close guard ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_final_guard_repins_generation() {
  echo "Test: FLY-1364 xhigh P1 — stock close refuses an exact ref reused by a new cmux generation"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  reap_unledgered_stock_workspaces
  local saved_candidate
  local candidate_count="$TMPDIR_ROOT/fly1364-stock-candidate.n"
  saved_candidate=$(declare -f _stock_candidate_still_matches)
  eval "$(declare -f _stock_candidate_still_matches | sed '1s/_stock_candidate_still_matches/_stock_candidate_still_matches_impl/')"
  _stock_candidate_still_matches() {
    local rc=0 n=0
    _stock_candidate_still_matches_impl "$@" || rc=$?
    [[ -f "$candidate_count" ]] && n=$(cat "$candidate_count")
    n=$((n + 1)); printf '%s\n' "$n" > "$candidate_count"
    if [[ "$rc" == "0" && "$n" == "2" ]]; then
      printf 'generation-stock-reopened' > "$TMPDIR_ROOT/mock-ident.override"
    fi
    return "$rc"
  }
  reap_unledgered_stock_workspaces
  eval "$saved_candidate"
  unset -f _stock_candidate_still_matches_impl
  if [[ -z "$MOCK_CMUX_OPS" \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == 'committed|generation-stock|workspace:1385|FLY-1385-qa-retest' ]]; then
    pass "last-operation stock guard refuses close after generation replacement"
  else
    fail "stock receipt crossed a generation boundary ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_does_not_accelerate_existing_receipt() {
  echo "Test: FLY-1364 R6 stock adoption — an existing normal receipt stays on the prior orphan grace path"
  _fly1364_stock_fixture fly-1385-closed-stock.json
  test_ledger_upsert committed generation-stock workspace:1385 FLY-1385-qa-retest
  reap_unledgered_stock_workspaces
  if [[ -z "$MOCK_CMUX_OPS" \
      && "$(cat "$VIEW_LEDGER")" == 'committed|generation-stock|workspace:1385|FLY-1385-qa-retest' ]]; then
    pass "stock adoption leaves pre-existing ledger authority untouched"
  else
    fail "stock adoption accelerated or rewrote existing authority ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1364_stock_adoption_ambiguity_alert_is_latched() {
  echo "Test: FLY-1364 R6 stock adoption — duplicate normalized refs refuse cleanup and page once per process"
  if ! type reap_unledgered_stock_workspaces >/dev/null 2>&1; then
    fail "reap_unledgered_stock_workspaces is not implemented"
    return
  fi
  _fly1364_stock_fixture fly-1385-closed-stock.json
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[
    {"ref":"workspace:1","title":"FLY-1385-qa-retest"},
    {"ref":"workspace:2","title":"env -u TMUX tmux attach -t '\''=cmux-FLY-1385-qa-retest'\''"}
  ]}'
  local alerts="$TMPDIR_ROOT/adoption-alerts" saved_alert
  saved_alert=$(declare -f flywheel_alert)
  : > "$alerts"
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  reap_unledgered_stock_workspaces
  reap_unledgered_stock_workspaces
  if [[ -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" \
      && "$(grep -c '^cmux_cleanup|' "$alerts" || true)" == "1" \
      && "$(cat "$alerts")" == *'reason=ambiguous-normalized-title'* ]]; then
    pass "ambiguous stock is preserved and its identical refusal alert is process-latched"
  else
    fail "ambiguity/latch mismatch alerts=[$(cat "$alerts")] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
  eval "$saved_alert"
}

test_fly1364_cleanup_alert_latch_resets_per_generation() {
  echo "Test: FLY-1364 alerts — saturation is bounded, visible, and resets on generation change"
  reset_mocks
  local alerts="$TMPDIR_ROOT/cleanup-latch-alerts" log="$TMPDIR_ROOT/cleanup-latch-log" i saved_alert
  saved_alert=$(declare -f flywheel_alert)
  : > "$alerts"; : > "$log"
  flywheel_alert() { printf '%s\n' "$5" >> "$alerts"; return 0; }
  for i in $(seq 1 65); do
    _alert_cmux_cleanup "title" "body" "cmux_cleanup|test|generation=generation-a|episode=$i"
  done 2> "$log"
  _alert_cmux_cleanup "title" "body" "cmux_cleanup|test|generation=generation-b|episode=1" 2>> "$log"
  if [[ "$(wc -l < "$alerts" | tr -d ' ')" == "65" \
      && "$(grep -c 'cleanup alert latch saturated' "$log" || true)" == "1" \
      && "$(tail -1 "$alerts")" == *'generation=generation-b|'* ]]; then
    pass "alert latch warns once at its cap and a new cmux generation re-arms delivery"
  else
    fail "alert saturation stayed silent or permanent count=$(wc -l < "$alerts" | tr -d ' ') log=[$(cat "$log")]"
  fi
  eval "$saved_alert"
}

test_fly1364_cleanup_episode_signatures_cover_each_refusal_class() {
  echo "Test: FLY-1364 Fix D — cleanup episode signatures cover every approved refusal class"
  local saved_alert alerts="$TMPDIR_ROOT/fly1364-episode-signatures" rc=0 ok=1
  saved_alert=$(declare -f flywheel_alert)
  : > "$alerts"
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }

  reset_mocks
  MOCK_SOCK_IDENT=episode-generation
  MOCK_CMUX_JSON_FAIL=1
  dismantle_view_display episode-title uncertain >/dev/null 2>&1 || true

  reset_mocks
  MOCK_SOCK_IDENT=episode-generation
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:8","title":"episode-title"},{"ref":"workspace:7","title":"episode-title"}]}'
  dismantle_view_display episode-title present >/dev/null 2>&1 || true

  reset_mocks
  MALFORMED_LEASE_ALERTED_SIG=""
  MOCK_MUTATOR_CENSUS_FAIL=1
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  printf 'episode-malformed-owner\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
  fly1364_noop_mutator() { return 0; }
  run_mutator_once once fly1364_noop_mutator >/dev/null 2>&1 || true
  unset -f fly1364_noop_mutator

  reset_mocks
  MOCK_SOCK_IDENT=generation-current
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:90","title":"stale-title"}]}'
  test_ensure_mutator_lease
  printf 'committed|generation-old|workspace:90|stale-title\n' > "$VIEW_LEDGER"
  reconcile_prepared_ledger >/dev/null 2>&1 || true

  _fly1364_legacy_create_fixture
  local blocked_parent="$TMPDIR_ROOT/fly1364-alert-ledger-parent" saved_rollback base_ledger="$VIEW_LEDGER"
  : > "$blocked_parent"
  VIEW_LEDGER="$blocked_parent/view-ledger"
  saved_rollback=$(declare -f rollback_unreceipted_workspace)
  rollback_unreceipted_workspace() { return 1; }
  create_workspace_for_window runner-flywheel @42 FLY-1364-implement >/dev/null 2>&1 || true
  eval "$saved_rollback"
  VIEW_LEDGER="$base_ledger"

  reset_mocks
  test_ensure_mutator_lease
  mkdir -p "${VIEW_LEDGER}.lock"
  printf '123|process-start\n' > "${VIEW_LEDGER}.lock/owner"
  rm() {
    if [[ "$*" == "-rf ${VIEW_LEDGER}.lock" ]]; then return 1; fi
    command rm "$@"
  }
  _ledger_upsert committed generation-current workspace:44 inner-title >/dev/null 2>&1 || true
  unset -f rm
  command rm -rf "${VIEW_LEDGER}.lock"

  eval "$saved_alert"
  local refs_hash owner_hash
  refs_hash=$(_cmux_alert_hash $'workspace:7\nworkspace:8')
  owner_hash=$(_cmux_alert_hash 'episode-malformed-owner')
  grep -Fq "cmux_cleanup|cmux_cleanup|generation=episode-generation|title=episode-title|refs_sha256=$(_cmux_alert_hash '__unavailable__')|reason=workspace-json-unavailable" "$alerts" || ok=0
  grep -Fq "cmux_cleanup|cmux_cleanup|generation=episode-generation|title=episode-title|refs_sha256=$refs_hash|reason=present-same-title-ref" "$alerts" || ok=0
  grep -Fq "cmux_cleanup|cmux_cleanup|lease-malformed|owner_sha256=$owner_hash" "$alerts" || ok=0
  grep -Fq 'cmux_cleanup|cmux_cleanup|stale-generation|old=generation-old|current=generation-current|ref=workspace:90|observed=stale-title' "$alerts" || ok=0
  grep -Fq 'cmux_cleanup|cmux_cleanup|rollback|generation=cmux-generation-1|ref=workspace:100' "$alerts" || ok=0
  grep -Fq 'cmux_cleanup|cmux_cleanup|ledger-inner-lock|owner=123|process-start' "$alerts" || ok=0
  if [[ "$ok" == "1" ]]; then
    pass "uncertain/present/malformed/stale/rollback/inner-lock episodes use stable evidence keys"
  else
    fail "one or more cleanup episode signatures drifted: [$(tr '\n' ';' < "$alerts")]"
  fi
}

echo ""
echo "═══ FLY-1272: linked-view topology + staging WAL ═══"
test_fly1272_p0_topology_mock
test_fly1272_p1_staging_wal_happy_path
test_fly1364_view_build_generation_flip_before_stage_is_read_only
test_fly1364_view_build_generation_flip_after_stage_mutation_stops
test_fly1272_p1_link_failure_recovers_owned_stage
test_fly1272_p1_rename_output_lost_recovers_claim
test_fly1272_p1_generation_mismatch_is_read_only
test_fly1272_skip_rc_never_kills_watcher
test_fly1272_p1_source_gone_collision_escrows_stage
test_fly1446_malformed_wals_quarantine_and_other_view_progresses
test_fly1446_collision_blocks_only_its_logical_view
test_fly1446_wal_indeterminate_failures_still_abort
test_fly1272_p3_create_uses_isolated_view_by_default
test_fly1272_p2_dismantle_linked_preserves_source
test_fly1272_p2_sole_holder_escrows_instead_of_destroying
test_fly1272_p2_grouped_view_always_escrows
test_fly1272_p2_keeper_inventory_reconciliation
test_fly1596_dismantle_proves_tmux_before_consuming_receipt
test_fly1596_inventory_requires_lease_and_recovers_residual_lock
test_fly1596_inventory_reconciles_production_generation_token
test_fly1596_inventory_crash_boundaries_converge_under_next_lease_holder
test_fly1596_restored_marker_parser_is_strict_and_tri_state
test_fly1596_restored_inflight_blocks_ordinary_close_and_dismantle
test_fly1596_restored_ledger_cas_preserves_reused_current_ref
test_fly1596_w1_two_pass_adoption_closes_restored_row
test_fly1596_restored_adoption_accepts_production_lead_titles
test_fly1596_restored_adoption_rejects_unrostered_live_titles
test_fly1596_dead_discovery_roster_failure_is_nonfatal
test_fly1596_restored_fingerprint_ignores_focus_state
test_fly1596_raw_attach_title_never_enters_restored_inflight
test_fly1596_one_restored_action_failure_does_not_abort_later_markers
test_fly1596_flag_off_aborts_synthetic_receipt_without_close
test_fly1596_w1p_promotes_then_closes_drifted_prepared_row
test_fly1596_w1dead_is_roster_only_and_leaves_runner_stock
test_fly1596_all_normal_receipt_consumers_skip_restored_inflight
test_fly1596_recovery_decision_table_is_total_and_preserves_phase_invariants
test_fly1596_adoption_budget_meets_five_minute_restart_bound
test_fly1596_sidebar_judge_passes_only_complete_live_terminal_state
test_fly1944_sidebar_judge_marks_birthless_identity_unattributable
test_fly1596_sidebar_judge_ignores_live_screen_bytes_for_snapshot_stability
test_fly1596_sidebar_judge_localizes_render_unavailability
test_fly1596_sidebar_judge_fails_missing_roster_lead
test_fly1596_sidebar_judge_is_inconclusive_when_roster_derivation_fails
test_fly1596_verify_sidebar_renders_roster_inconclusive_text_and_json
test_fly1596_verify_sidebar_target_local_authority_matrix
test_fly1596_verify_sidebar_rejects_unknown_runner_target
test_fly1596_sidebar_judge_rejects_each_false_pass_family
test_fly1596_sidebar_judge_covers_stale_markers_render_and_roster_drift
test_fly1596_rebuild_parser_rejects_before_any_ipc
test_fly1596_ops_resolution_falls_back_to_live_leads_when_roster_is_partial
test_fly1596_ops_claim_is_self_bound_and_qa_exclusive
test_fly1596_ops_mode_is_a_known_mutator_everywhere
test_fly1596_ops_create_bypass_is_exact_and_lease_bound
test_fly1596_rebuild_dry_run_and_exact_ref_are_read_only
test_fly1596_rebuild_executes_grouped_to_verified_a1_and_preserves_out_of_scope_marker
test_fly1596_handover_yields_then_revalidates_before_mutation
test_fly1596_log_episodes_are_bounded_stateful_and_reversible
test_fly1272_p2_foreign_same_title_is_untouched
test_fly1272_p4_grouped_husk_cannot_back_wrong_tab
test_fly1272_p4_uncertain_source_snapshot_mutates_nothing
test_fly1272_p3_prepared_ledger_recovers_exact_unnamed_ref
test_fly1272_p3_ghost_reaper_never_closes_unledgered_ref
test_fly1272_p3_orphan_client_attach_failure_alerts_exact_ref
test_fly1272_p3_post_create_client_read_failure_variants
test_fly1272_p3_unreadable_pre_capture_positive_post_is_unverified
test_fly1272_p5_bootstrap_converges_once_then_is_quiet
test_fly1272_p1_generalized_mutator_lease
test_fly1272_p1_probe_lease_fail_closed_on_malformed_record
test_fly1272_maintenance_marker_blocks_oneshot_without_locking
test_fly1482_qa_claim_blocks_oneshot_without_mutation
test_fly1482_stale_claim_reap_is_fenced_and_two_observation
test_fly1482_malformed_claim_fails_closed
test_fly1482_owner_and_self_verification_share_timezone_stable_identity
test_fly1482_watcher_authority_loss_exits_on_third_pass
test_fly1482_clean_pass_resets_authority_streak

echo ""
echo "═══ FLY-1364: ledger authority + A0B1 create symmetry ═══"
test_fly1364_ledger_writer_requires_verified_mutator_lease
test_fly1364_ledger_writer_reaps_inner_lock_only_with_verified_lease
test_fly1446_ledger_title_rows_include_rename_lag_prepared
test_fly1446_rename_lag_retry_never_creates_second_workspace
test_fly1446_ledger_transaction_rejects_title_conflict_inside_lock
test_fly1446_prepared_loser_cleanup_is_exact_and_guarded
test_fly1446_historical_double_committed_alerts_without_mutation
test_fly1364_a0b1_create_records_prepared_then_committed_receipt
test_fly1364_a0b1_create_accepts_exact_provisional_attach_title
test_fly1364_a0b1_create_uses_independent_view_by_default
test_fly1364_first_receipt_failure_rolls_back_exact_unnamed_ref
test_fly1482_midpass_authority_loss_preserves_unreceipted_workspace
test_fly1364_prepared_recovery_repins_generation_at_rename
test_fly1364_prepared_recovery_accepts_exact_provisional_attach_title
test_fly1884_prepared_default_title_recovers_with_uuid_receipt
test_fly1884_legacy_default_title_never_gains_rename_authority
test_fly1884_uuid_mismatch_and_ref_reuse_block_prepared_rename
test_fly1884_authority_mismatch_releases_receipt_without_blocking_next_row
test_fly1884_private_v2_no_pty_is_report_only
test_fly1884_committed_uuid_mismatch_blocks_close
test_fly1884_uuid_is_rechecked_before_tab_rename
test_fly1884_unreceipted_default_rollback_requires_exact_uuid
test_fly1884_managed_view_command_variants_are_upgrade_safe
test_fly1944_inventory_carrier_classification_is_batched
test_fly1944_v2_adoption_cap_still_heals_deferred_lead
test_fly1944_failed_v2_adoption_refunds_shared_slot
test_fly1944_adoption_cap_requires_current_owner
test_fly1884_missing_view_helper_defers_create_without_receipt
test_fly1884_upgrade_windows_accept_legacy_attach_surfaces
test_fly1884_additive_round_ids_persist_and_advance
test_fly1884_prepared_absent_requires_distinct_aged_rounds
test_fly1884_prepared_absent_min_age_and_reappearance_reset
test_fly1884_prepared_stall_identity_includes_title
test_fly1884_prepared_drift_release_preserves_workspace_and_alerts
test_fly1884_legacy_default_title_ages_without_mutation
test_fly1884_corrupt_prepared_stall_state_is_fail_safe
test_fly1364_create_snapshot_is_generation_bound_before_ref_diff
test_fly1364_rollback_guard_repins_after_inventory_probe
test_fly1364_ledger_crash_windows_recover_under_next_lease_holder
test_fly1364_unledgered_zero_ref_converges_only_view_shell
test_fly1364_escrow_repins_generation_before_owner_mutation
test_fly1364_escrow_repins_generation_before_rename
test_fly1364_unlink_revalidates_exact_tmux_session_id
test_fly1364_wal_recovery_unlink_repins_tmux_generation
test_fly1364_wal_recovery_create_intent_kill_repins_tmux_generation
test_fly1364_wal_recovery_claim_rename_repins_tmux_generation
test_fly1364_wal_source_gone_escrow_keeps_original_identity
test_fly1364_unledgered_json_uncertain_is_zero_mutation
test_fly1364_unledgered_present_ref_logs_operator_evidence_without_mutation
test_fly1364_run_mutator_once_rebuilds_malformed_lease_and_continues
test_fly1364_watcher_start_rebuilds_malformed_lease
test_fly1364_malformed_lease_preserves_live_mutator
test_fly1364_malformed_lease_fails_closed_when_census_unavailable
test_fly1364_malformed_lease_fails_closed_when_census_drifts
test_fly1364_real_census_filters_invocation_tree_and_shell_prose
test_fly1364_real_census_excludes_command_substitution_processes
test_fly1364_lease_rebuild_crash_windows_converge
test_fly1364_live_raw_owner_pid_with_unreadable_command_fails_closed
test_fly1364_stale_generation_absent_ref_is_gced_without_current_rows
test_fly1364_stale_generation_present_ref_is_preserved_without_migration
test_fly1364_stale_prepared_unnamed_ref_is_not_renamed
test_fly1364_stale_generation_pass_aborts_on_midpass_generation_flip
test_fly1364_alert_library_forwards_exact_argv_and_fails_open
test_fly1364_optional_alert_library_missing_is_noop
test_fly1364_stock_fixture_contracts
test_fly1364_complete_stock_fixtures_drive_terminal_state
test_fly1364_raw_attach_normalization_is_exact
test_fly1364_raw_attach_blocks_unledgered_view_teardown
test_fly1364_stock_adoption_two_pass_exact_close
test_fly2048_operator_adopts_legacy_prepared_stock
test_fly1364_stock_adoption_malformed_duplicate_is_not_candidate
test_fly1364_once_heals_quiet_strict_sole_holder
test_fly1364_raw_attach_stock_adoption
test_fly1364_stock_adoption_preserves_live_sole_holder
test_fly1364_once_preserves_live_strict_sole_holder
test_fly1364_stock_adoption_rejects_foreign_or_drifted_dead_view
test_fly1364_stock_adoption_fingerprint_ignores_unrelated_churn
test_fly1364_stock_adoption_alerts_on_unreadable_topology
test_fly1364_stock_adoption_accepts_owned_dead_view
test_fly1364_stock_adoption_rejects_markerless_grouped_dead_view
test_fly1364_receipted_legacy_grouped_view_migrates
test_fly1364_legacy_grouped_backfill_refuses_foreign_same_title_ref
test_fly1364_ledger_receipt_does_not_authorize_foreign_view_shell
test_fly1364_strict_view_probe_uncertainty_never_authorizes_cleanup
test_fly1364_stock_adoption_revalidates_source_reappearance
test_fly1364_stock_adoption_final_guard_revalidates_source_reappearance
test_fly1364_stock_adoption_final_guard_repins_generation
test_fly1364_stock_adoption_does_not_accelerate_existing_receipt
test_fly1364_stock_adoption_ambiguity_alert_is_latched
test_fly1364_cleanup_alert_latch_resets_per_generation
test_fly1364_cleanup_episode_signatures_cover_each_refusal_class

# ════════════════════════════════════════════════════════════════
test_fly1550_tab_rename_is_recoverable_state() {
  echo "Test: FLY-1550 — a failed tab rename preserves the prepared row; the next pass converges both titles"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:100","title":null}]}'
  local provisional
  provisional=$(build_attach_command 'cmux-FLY-1550-runner-claude-Fable-runner-lead-config')
  MOCK_CMUX_SURFACES="workspace:100;;surface:100;;terminal;;true;;$provisional"
  test_ledger_upsert prepared "cmux-generation-1" "workspace:100" "FLY-1550-runner-claude-Fable-runner-lead-config"
  # Pass 1: workspace rename succeeds, tab rename FAILS → the row must stay
  # prepared (recoverable), never committed with a half-named pair.
  MOCK_CMUX_RENAME_TAB_FAIL="1"
  local rc=0 row
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  if [[ "$row" == "prepared|cmux-generation-1|workspace:100|FLY-1550-runner-claude-Fable-runner-lead-config" ]]; then
    pass "tab-rename failure preserves the prepared row"
  else
    fail "row after failed tab rename: [$row] (rc=$rc)"
  fi
  # Pass 2: tab rename now succeeds — this is the crash-between-renames shape
  # too (workspace already carries the title, the row is still prepared). The
  # reconcile must re-drive the tab rename idempotently and only then commit.
  MOCK_CMUX_RENAME_TAB_FAIL="0"
  MOCK_CMUX_OPS=""
  rc=0
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  local ok=1
  [[ "$rc" -eq 0 && "$row" == "committed|cmux-generation-1|workspace:100|FLY-1550-runner-claude-Fable-runner-lead-config" ]] || { fail "row did not converge to committed: [$row] rc=$rc"; ok=0; }
  echo "$MOCK_CMUX_OPS" | grep -qF "rename-tab --workspace workspace:100 FLY-1550-runner-claude-Fable-runner-lead-config" || { fail "convergence pass did not re-drive rename-tab. ops=[$MOCK_CMUX_OPS]"; ok=0; }
  [[ "$ok" == "1" ]] && pass "next pass re-drives the tab rename and commits — the title pair cannot diverge durably"
}

test_fly1550_attach_command_grammar_holds() {
  echo "Test: FLY-1550 — the canonical attach grammar accepts a managed window title"
  reset_mocks
  local cmd rc=0 view="cmux-FLY-1550-runner-claude-Fable-runner-lead-config"
  cmd=$(build_attach_command "$view") || rc=$?
  if [[ "$rc" -eq 0 && "$(managed_view_command_parse "$cmd" 2>/dev/null || true)" == "$view" ]]; then
    pass "attach command stays byte-canonical around the managed title"
  else
    fail "attach grammar broke for the managed title rc=$rc cmd=[$cmd]"
  fi
  rc=0
  build_attach_command "cmux-FLY-1550-bad'quote" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    pass "single-quote titles still refused (launcher strips them before tmux)"
  else
    fail "quoted title crossed the attach boundary"
  fi
}

echo ""
echo "═══ FLY-1550: managed Runner workspace titles ═══"
test_fly1550_tab_rename_is_recoverable_state
test_fly1550_attach_command_grammar_holds

# ════════════════════════════════════════════════════════════════
# FLY-1605: timezone-stable process identities
# ════════════════════════════════════════════════════════════════

test_fly1605_process_incarnation_is_timezone_stable() {
  echo "Test: FLY-1605 — process incarnation pins ps rendering to UTC/C"
  reset_mocks
  FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE=""
  MOCK_PS_MODE="tz-sensitive-lstart"
  eval "$(declare -f _fly1605_ps_mock | sed '1s/_fly1605_ps_mock/ps/')"
  local tokyo denver
  tokyo=$(TZ=Asia/Tokyo _process_incarnation 4242)
  denver=$(TZ=America/Denver _process_incarnation 4242)
  if [[ "$tokyo" == "$denver" && "$tokyo" == "Sat Aug  1 16:45:06 2026" ]] \
      && [[ "$(grep -c '^UTC|C|' "$TMPDIR_ROOT/ps.calls" 2>/dev/null || true)" == "2" ]]; then
    pass "process incarnation is invariant across ambient timezone changes"
  else
    fail "process incarnation drifted: tokyo=[$tokyo] denver=[$denver] calls=[$(cat "$TMPDIR_ROOT/ps.calls" 2>/dev/null)]"
  fi
}

test_fly1605_tmux_generation_is_timezone_stable() {
  echo "Test: FLY-1605 — tmux generation pins ps rendering to UTC/C"
  reset_mocks
  FLYWHEEL_CMUX_TMUX_GENERATION=""
  MOCK_PS_MODE="tz-sensitive-lstart"
  local tokyo denver expected
  expected="${MOCK_TMUX_SOCKET_PATH}|${MOCK_TMUX_SERVER_PID}|Sat Aug  1 16:45:06 2026"
  eval "$(declare -f _fly1605_ps_mock | sed '1s/_fly1605_ps_mock/ps/')"
  tokyo=$(TZ=Asia/Tokyo _production_tmux_server_generation)
  denver=$(TZ=America/Denver _production_tmux_server_generation)
  if [[ "$tokyo" == "$expected" && "$denver" == "$expected" ]] \
      && [[ "$(grep -c '^UTC|C|' "$TMPDIR_ROOT/ps.calls" 2>/dev/null || true)" == "2" ]]; then
    pass "tmux generation is invariant across ambient timezone changes"
  else
    fail "tmux generation drifted: tokyo=[$tokyo] denver=[$denver] calls=[$(cat "$TMPDIR_ROOT/ps.calls" 2>/dev/null)]"
  fi
}

test_fly1605_ledger_survives_timezone_change() {
  echo "Test: FLY-1605 — an acquired mutator lease remains valid after timezone change"
  reset_mocks
  FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE=""
  MOCK_PS_MODE="tz-sensitive-lstart"
  eval "$(declare -f _fly1605_ps_mock | sed '1s/_fly1605_ps_mock/ps/')"
  local acquire_rc=0 write_rc=0 row
  TZ=Asia/Tokyo acquire_mutator_lease qa_teardown || acquire_rc=$?
  TZ=America/Denver _ledger_upsert prepared "cmux-generation-1" "workspace:1605" "FLY-1605-design-claude" \
    >/dev/null 2>&1 || write_rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  release_mutator_lease
  if [[ "$acquire_rc" -eq 0 && "$write_rc" -eq 0 \
      && "$row" == "prepared|cmux-generation-1|workspace:1605|FLY-1605-design-claude" ]]; then
    pass "ledger mutation keeps the verified lease across timezone changes"
  else
    fail "timezone switch invalidated lease: acquire=$acquire_rc write=$write_rc row=[$row]"
  fi
}

test_fly1605_prepared_title_migration_renames_tab_and_commits() {
  echo "Test: FLY-1605 — prepared named workspace migrates the tab with explicit ref before commit"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" raw rc=0 row surface before_ledger
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$title\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;$raw"
  test_ledger_upsert prepared "cmux-generation-1" "workspace:1605" "$title"
  before_ledger=$(cat "$VIEW_LEDGER")
  MOCK_CMUX_OPS=""
  complete_title_migration "workspace:1605" "$title" "cmux-generation-1" "$raw" \
    >/dev/null 2>&1 || rc=$?
  row=$(cat "$VIEW_LEDGER" 2>/dev/null || true)
  surface=$(printf '%s\n' "$MOCK_CMUX_SURFACES" | awk -F';;' '{print $5}')
  local ok=1
  [[ "$rc" -eq 0 && "$row" == "committed|cmux-generation-1|workspace:1605|$title" ]] \
    || { fail "prepared migration did not commit rc=$rc row=[$row]"; ok=0; }
  [[ "$surface" == "$title" ]] \
    || { fail "tab readback did not converge surface=[$surface]"; ok=0; }
  [[ "$(grep -cF "rename-tab --workspace workspace:1605 $title" <<< "$MOCK_CMUX_OPS" || true)" == "1" ]] \
    || { fail "missing explicit-ref rename-tab op=[$MOCK_CMUX_OPS]"; ok=0; }
  [[ "$ok" == "1" ]] && pass "prepared migration renames the exact tab, reads it back, then commits"

  MOCK_CMUX_OPS=""
  before_ledger=$(cat "$VIEW_LEDGER")
  rc=0
  complete_title_migration "workspace:1605" "$title" "cmux-generation-1" "$raw" \
    >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" && "$(cat "$VIEW_LEDGER")" == "$before_ledger" ]]; then
    pass "second migration pass is mutation-free and ledger-byte-idempotent"
  else
    fail "second pass was not idempotent rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_prepared_title_migration_refuses_foreign_surface() {
  echo "Test: FLY-1605 — foreign surface title preserves prepared authority without mutation"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" raw before rc=0
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$title\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;npm run dev"
  test_ledger_upsert prepared "cmux-generation-1" "workspace:1605" "$title"
  before=$(cat "$VIEW_LEDGER")
  MOCK_CMUX_OPS=""
  complete_title_migration "workspace:1605" "$title" "cmux-generation-1" "$raw" \
    >/dev/null 2>&1 || rc=$?
  if declare -F complete_title_migration >/dev/null \
      && [[ "$rc" -ne 0 && -z "$MOCK_CMUX_OPS" && "$(cat "$VIEW_LEDGER")" == "$before" ]]; then
    pass "foreign surface is read-only and leaves the prepared receipt byte-identical"
  else
    fail "foreign surface crossed migration guard rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_prepared_recovery_uses_shared_surface_guard() {
  echo "Test: FLY-1605 — prepared-ledger recovery preserves a foreign surface without failing the pass"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" before rc=0
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$title\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;npm run dev"
  test_ledger_upsert prepared "cmux-generation-1" "workspace:1605" "$title"
  before=$(cat "$VIEW_LEDGER")
  MOCK_CMUX_OPS=""
  reconcile_prepared_ledger >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" && "$(cat "$VIEW_LEDGER")" == "$before" ]]; then
    pass "shared recovery guard preserves foreign surface and prepared receipt without failing the pass"
  else
    fail "recovery blocked the pass or bypassed the shared guard rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_prepared_surface_drift_does_not_block_additive_pass() {
  echo "Test: FLY-1605 — one preserved prepared surface drift cannot wedge the additive pass"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  local title="FLY-1605-design-claude" before trace rc=0
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$title\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;npm run dev"
  test_ledger_upsert prepared "cmux-generation-1" "workspace:1605" "$title"
  before=$(cat "$VIEW_LEDGER")
  trace="$TMPDIR_ROOT/fly1605-prepared-drift-additive.trace"
  : > "$trace"

  (
    reconcile_roster_read_phase() { :; }
    register_hooks_on_new_sessions() { :; }
    get_tmux_agent_windows() { printf 'runner-flywheel|@1605|FLY-1605-design-claude\n'; }
    reconcile_keeper_inventory() { return 0; }
    repair_view_invariants() { return 0; }
    reconcile_existing_workspaces() { printf 'existing\n' >> "$trace"; }
    reconcile_workspace_titles() { printf 'titles\n' >> "$trace"; }
    workspace_exists_for() { printf 'exists\n' >> "$trace"; return 1; }
    create_workspace_for_window() { printf 'create\n' >> "$trace"; }
    self_heal_sweep_all() { printf 'heal\n' >> "$trace"; }
    reap_ghost_workspaces() { printf 'ghost\n' >> "$trace"; }
    reap_unledgered_stock_workspaces() { printf 'stock\n' >> "$trace"; }
    reap_orphan_workspace_pins() { printf 'pins\n' >> "$trace"; }
    cleanup_stale_conservative() { printf 'cleanup\n' >> "$trace"; }
    sync_additive
  ) >/dev/null 2>&1 || rc=$?

  local expected="existing titles exists create heal ghost stock pins cleanup" item ok=1
  [[ "$rc" -eq 0 ]] || { fail "prepared surface drift escaped as additive rc=$rc"; ok=0; }
  [[ "$(cat "$VIEW_LEDGER")" == "$before" ]] \
    || { fail "prepared surface drift changed receipt ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"; ok=0; }
  for item in $expected; do
    grep -qxF "$item" "$trace" \
      || { fail "prepared surface drift skipped downstream $item trace=[$(tr '\n' ';' < "$trace")]"; ok=0; }
  done
  [[ "$ok" == "1" ]] && pass "prepared surface drift stays read-only while the additive pipeline continues"
}

fly1605_seed_strict_managed_window() {
  local source="$1" wid="$2" title="$3"
  MOCK_TOPOLOGY_MODE="1"
  topo_reset
  topo_add_session "$source" '$1605'
  topo_add_window "$source" "$wid" "$title" 1 0
  topo_add_session "cmux-$title" '$2605' "" "$source" "0"
  topo_add_window "cmux-$title" "$wid" "$title" 1 0
}

test_fly1672_title_reconcile_refuses_vanished_source_id() {
  echo "Test: FLY-1672 — title reconcile gives a vanished source id zero authority"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT=cmux-generation-1
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  MOCK_TOPOLOGY_MODE=1
  local source=runner-fly1672 gone=@1672 live=@1 title=FLY-1672-design-claude
  local raw roster before rc=0
  topo_add_session "$source" '$1672'
  topo_add_window "$source" "$live" FLY-1672-current-window 1 0
  topo_add_session "cmux-$title" '$2672' '' "$source" 0
  topo_add_window "cmux-$title" "$gone" "$title" 1 0
  roster="$source|$gone|$title"
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1672\",\"title\":\"$raw\"}]}"
  MOCK_CMUX_SURFACES="workspace:1672;;surface:1672;;terminal;;true;;$raw"
  printf 'committed|cmux-generation-1|workspace:other|other-title\n' > "$VIEW_LEDGER"
  before=$(cat "$VIEW_LEDGER")
  test_ensure_mutator_lease
  MOCK_CMUX_OPS=''
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" && "$(cat "$VIEW_LEDGER")" == "$before" ]]; then
    pass "vanished source preserves the stock candidate and ledger byte-for-byte"
  else
    fail "vanished source inherited title authority rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_named_stock_adoption_is_receipt_only_and_idempotent() {
  echo "Test: FLY-1605 — exact managed named stock receives authority without cmux mutation"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  local title="FLY-1605-design-claude" roster before rc=0
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$title\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;$title"
  test_ensure_mutator_lease
  MOCK_CMUX_OPS=""
  if declare -F reconcile_workspace_titles >/dev/null; then
    reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  else
    rc=127
  fi
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|cmux-generation-1|workspace:1605|$title" ]]; then
    pass "named stock is authorized, receipted, and committed without a rename"
  else
    fail "named stock did not converge receipt-only rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi

  before=$(cat "$VIEW_LEDGER" 2>/dev/null)
  MOCK_CMUX_OPS=""
  rc=0
  if declare -F reconcile_workspace_titles >/dev/null; then
    reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  else
    rc=127
  fi
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "$before" ]]; then
    pass "named stock second pass is cmux-mutation-free and ledger-byte-idempotent"
  else
    fail "named stock second pass mutated rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_steady_state_stays_within_cmux_ipc_budget() {
  echo "Test: FLY-1605 — converged title reconciliation stays within the steady-state cmux IPC budget"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  local title="FLY-1605-design-claude" roster trace before rc=0 calls ws_reads surface_reads
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$title\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;$title"
  test_ledger_upsert committed "cmux-generation-1" "workspace:1605" "$title"
  before=$(cat "$VIEW_LEDGER")
  trace="$TMPDIR_ROOT/fly1605-steady-ipc.trace"
  : > "$trace"
  MOCK_CMUX_TRACE_FILE="$trace"
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  MOCK_CMUX_TRACE_FILE=""
  calls=$(grep -Ec '(^| )list-(workspaces|pane-surfaces)( |$)' "$trace" || true)
  ws_reads=$(grep -Ec '(^| )list-workspaces( |$)' "$trace" || true)
  surface_reads=$(grep -Ec '(^| )list-pane-surfaces( |$)' "$trace" || true)
  if [[ "$rc" -eq 0 && "$calls" -le 3 && "$ws_reads" -ge 1 && "$surface_reads" -ge 1 \
      && -z "$MOCK_CMUX_OPS" && "$(cat "$VIEW_LEDGER")" == "$before" ]]; then
    pass "converged reconciliation uses at most 3 cmux reads and remains mutation-free"
  else
    fail "steady-state IPC budget exceeded rc=$rc calls=$calls workspaces=$ws_reads surfaces=$surface_reads ops=[$MOCK_CMUX_OPS] trace=[$(tr '\n' ';' < "$trace")]"
  fi
}

test_fly1605_topology_refusal_warns_only_on_transition() {
  echo "Test: FLY-1605 — topology refusal warning fires only on refusal transitions"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  local title="FLY-1605-design-claude" roster log_file rc=0 warnings
  roster="runner-flywheel|@1605|$title"
  log_file="$TMPDIR_ROOT/fly1605-topology-refusal.log"
  : > "$log_file"

  # The first refused observation is actionable; an unchanged periodic sweep
  # is not. Keep this on the public reconciliation seam so a mutation back to
  # per-sweep logging fails the regression test.
  reconcile_workspace_titles "$roster" >/dev/null 2>>"$log_file" || rc=$?
  reconcile_workspace_titles "$roster" >/dev/null 2>>"$log_file" || rc=$?
  warnings=$(grep -cF "title stock topology proof refused source=runner-flywheel wid=@1605 title=$title" "$log_file" || true)
  if [[ "$rc" -eq 0 && "$warnings" == "1" ]]; then
    pass "unchanged refused topology emits one transition warning"
  else
    fail "unchanged refused topology spammed warnings rc=$rc count=$warnings log=[$(cat "$log_file")]"
  fi

  # A conclusive authorized sweep clears the refusal latch. A later topology
  # regression is a fresh transition and must be visible again.
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  reconcile_workspace_titles "$roster" >/dev/null 2>>"$log_file" || rc=$?
  topo_reset
  reconcile_workspace_titles "$roster" >/dev/null 2>>"$log_file" || rc=$?
  warnings=$(grep -cF "title stock topology proof refused source=runner-flywheel wid=@1605 title=$title" "$log_file" || true)
  if [[ "$rc" -eq 0 && "$warnings" == "2" ]]; then
    pass "authorized recovery re-arms the next topology refusal warning"
  else
    fail "topology transition warning did not re-arm rc=$rc count=$warnings log=[$(cat "$log_file")]"
  fi
}

test_fly1605_title_matching_is_prefix_isolated() {
  echo "Test: FLY-1605 — exact attach titles isolate neighboring issue prefixes"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-160-design-claude" neighbor="FLY-1605-design-claude"
  local raw neighbor_raw roster neighbor_after rc=0
  fly1605_seed_strict_managed_window "runner-flywheel" "@160" "$title"
  roster="runner-flywheel|@160|$title"
  raw=$(build_attach_command "cmux-$title")
  neighbor_raw=$(build_attach_command "cmux-$neighbor")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:160\",\"title\":\"$raw\"},{\"ref\":\"workspace:1605\",\"title\":\"$neighbor_raw\"}]}"
  MOCK_CMUX_SURFACES="workspace:160;;surface:160;;terminal;;true;;$raw
workspace:1605;;surface:1605;;terminal;;true;;$neighbor_raw"
  test_ensure_mutator_lease
  MOCK_CMUX_OPS=""
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  neighbor_after=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
print(next(w["title"] for w in json.load(sys.stdin)["workspaces"]
           if w.get("ref") == "workspace:1605"))
')
  if [[ "$rc" -eq 0 \
      && "$(grep -cF "rename-workspace --workspace workspace:160 $title" <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && "$MOCK_CMUX_OPS" != *"workspace:1605"* \
      && "$neighbor_after" == "$neighbor_raw" \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|cmux-generation-1|workspace:160|$title" ]]; then
    pass "FLY-160 migration does not consume the FLY-1605 workspace"
  else
    fail "neighboring prefix lost isolation rc=$rc neighbor=[$neighbor_after] ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_ambiguous_surface_inventory_fails_closed() {
  echo "Test: FLY-1605 — unreadable or ambiguous surface inventory fails closed"
  local mode title="FLY-1605-design-claude" raw roster log_file rc warnings ok=1
  for mode in rc invalid multiple; do
    reset_mocks
    FLYWHEEL_CMUX_LINKED_VIEW=1
    MOCK_SOCK_IDENT="cmux-generation-1"
    fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
    roster="runner-flywheel|@1605|$title"
    raw=$(build_attach_command "cmux-$title")
    MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$raw\"}]}"
    MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;$raw"
    case "$mode" in
      rc) MOCK_CMUX_SURFACES_FAIL=1 ;;
      invalid) MOCK_CMUX_SURFACES_INVALID=1 ;;
      multiple)
        MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;$raw
workspace:1605;;surface:2605;;terminal;;false;;$raw"
        ;;
    esac
    test_ensure_mutator_lease
    MOCK_CMUX_OPS=""
    log_file="$TMPDIR_ROOT/fly1605-surface-$mode.log"
    rc=0
    reconcile_workspace_titles "$roster" >/dev/null 2>"$log_file" || rc=$?
    warnings=$(grep -c "WARN:" "$log_file" || true)
    if [[ "$rc" -ne 0 || -n "$MOCK_CMUX_OPS" || -s "$VIEW_LEDGER" || "$warnings" -lt 1 ]]; then
      fail "surface $mode did not fail closed rc=$rc warnings=$warnings ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
      ok=0
    fi
  done
  [[ "$ok" == "1" ]] && pass "surface rc, JSON, and cardinality failures preserve stock without authority"
}

test_fly1605_raw_stock_with_foreign_surface_has_zero_authority() {
  echo "Test: FLY-1605 — raw workspace with a foreign surface receives no authority"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  local title="FLY-1605-design-claude" raw roster rc=0
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$raw\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;npm run founder-console"
  test_ensure_mutator_lease
  MOCK_CMUX_OPS=""
  if declare -F reconcile_workspace_titles >/dev/null; then
    reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  else
    rc=127
  fi
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" && ! -s "$VIEW_LEDGER" ]]; then
    pass "foreign surface blocks stock receipt minting and every cmux mutation"
  else
    fail "foreign surface gained authority rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_raw_duplicates_converge_through_guarded_close() {
  echo "Test: FLY-1944 round-3 — raw duplicates migrate the winner but preserve the loser report-only"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" raw roster before rc=0 saved_liveness
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:100\",\"title\":\"$raw\"},{\"ref\":\"workspace:99\",\"title\":\"$raw\"}]}"
  MOCK_CMUX_SURFACES="workspace:99;;surface:99;;terminal;;true;;$raw
workspace:100;;surface:100;;terminal;;true;;$raw"
  test_ensure_mutator_lease
  saved_liveness=$(declare -f workspace_attach_liveness)
  workspace_attach_liveness() {
    [[ "$1" == workspace:99 ]] && printf 'live\n' || printf 'dead\n'
  }
  MOCK_CMUX_OPS=""
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  eval "$saved_liveness"
  local ok=1
  [[ "$rc" -eq 0 \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|cmux-generation-1|workspace:99|$title" ]] \
    || { fail "raw winner did not commit rc=$rc ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"; ok=0; }
  grep -qF "rename-workspace --workspace workspace:99 $title" <<< "$MOCK_CMUX_OPS" \
    || { fail "numeric-min winner was not renamed explicitly ops=[$MOCK_CMUX_OPS]"; ok=0; }
  grep -qF "rename-tab --workspace workspace:99 $title" <<< "$MOCK_CMUX_OPS" \
    || { fail "winner tab was not renamed explicitly ops=[$MOCK_CMUX_OPS]"; ok=0; }
  if grep -qF "close-workspace --workspace workspace:100" <<< "$MOCK_CMUX_OPS"; then
    fail "single-sample raw loser crossed the report-only fence ops=[$MOCK_CMUX_OPS]"; ok=0
  fi
  [[ "$ok" == "1" ]] && pass "raw duplicates choose and finish the numeric-min winner without destructive cleanup"

  before=$(cat "$VIEW_LEDGER" 2>/dev/null)
  MOCK_CMUX_OPS=""
  rc=0
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "$before" ]]; then
    pass "raw duplicate convergence is cmux-mutation-free and ledger-byte-idempotent on the second pass"
  else
    fail "raw duplicate second pass mutated rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_named_keeper_closes_raw_extra_after_tab_ready() {
  echo "Test: FLY-1944 round-3 — named keeper finishes its tab while raw extra stays report-only"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" raw roster rc=0 saved_liveness
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:200\",\"title\":\"$title\"},{\"ref\":\"workspace:100\",\"title\":\"$raw\"}]}"
  MOCK_CMUX_SURFACES="workspace:200;;surface:200;;terminal;;true;;$raw
workspace:100;;surface:100;;terminal;;true;;$raw"
  test_ensure_mutator_lease
  saved_liveness=$(declare -f workspace_attach_liveness)
  workspace_attach_liveness() {
    [[ "$1" == workspace:200 ]] && printf 'live\n' || printf 'dead\n'
  }
  MOCK_CMUX_OPS=""
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  eval "$saved_liveness"
  local tab_line close_line ok=1
  tab_line=$(grep -nF "rename-tab --workspace workspace:200 $title" <<< "$MOCK_CMUX_OPS" | cut -d: -f1 || true)
  close_line=$(grep -nF "close-workspace --workspace workspace:100" <<< "$MOCK_CMUX_OPS" | cut -d: -f1 || true)
  [[ "$rc" -eq 0 && -n "$tab_line" && -z "$close_line" ]] \
    || { fail "mixed stock crossed report-only duplicate fence rc=$rc ops=[$MOCK_CMUX_OPS]"; ok=0; }
  [[ "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|cmux-generation-1|workspace:200|$title" ]] \
    || { fail "named keeper receipt is not committed ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"; ok=0; }
  [[ "$ok" == "1" ]] && pass "named keeper reaches committed readback without closing the raw extra"
}

test_fly1605_generation_flip_blocks_stock_rename() {
  echo "Test: FLY-1605 — generation flip at guarded stock rename preserves prepared state"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" raw roster rc=0
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:1605\",\"title\":\"$raw\"}]}"
  MOCK_CMUX_SURFACES="workspace:1605;;surface:1605;;terminal;;true;;$raw"
  test_ensure_mutator_lease
  MOCK_MKTEMP_HOOK='printf %s cmux-generation-2 > "$TMPDIR_ROOT/mock-ident.override"'
  MOCK_CMUX_OPS=""
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 && -z "$MOCK_CMUX_OPS" \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "prepared|cmux-generation-1|workspace:1605|$title" ]]; then
    pass "final generation guard blocks rename and leaves a recoverable prepared receipt"
  else
    fail "generation flip crossed stock guard rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_report_only_preserves_raw_extra_and_alerts() {
  echo "Test: FLY-1944 round-3 — duplicate report-only path preserves the raw extra and alerts"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" raw roster rc=0 remaining saved_liveness saved_alert alerts
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:200\",\"title\":\"$title\"},{\"ref\":\"workspace:100\",\"title\":\"$raw\"}]}"
  MOCK_CMUX_SURFACES="workspace:200;;surface:200;;terminal;;true;;$title
workspace:100;;surface:100;;terminal;;true;;$raw"
  test_ensure_mutator_lease
  saved_liveness=$(declare -f workspace_attach_liveness)
  workspace_attach_liveness() {
    [[ "$1" == workspace:200 ]] && printf 'live\n' || printf 'dead\n'
  }
  alerts="$TMPDIR_ROOT/fly1605-report-only-alerts"
  : > "$alerts"
  saved_alert=$(declare -f flywheel_alert)
  flywheel_alert() { printf '%s|%s\n' "$1" "$5" >> "$alerts"; return 0; }
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  eval "$saved_alert"
  eval "$saved_liveness"
  remaining=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import json,sys
print(sum(1 for w in json.load(sys.stdin)["workspaces"] if w.get("ref") == "workspace:100"))
')
  if [[ "$rc" -eq 0 && "$remaining" == "1" \
      && "$(cat "$VIEW_LEDGER" 2>/dev/null)" == "committed|cmux-generation-1|workspace:200|$title" \
      && "$MOCK_CMUX_OPS" != *'close-workspace --workspace workspace:100'* \
      && "$(cat "$alerts")" == "cmux_cleanup|cmux_cleanup|view-duplicate-report-only|title=$title|keeper=workspace:200|sibling=workspace:100" ]]; then
    pass "duplicate report-only path preserves the extra, attempts no close, and emits the keyed alert"
  else
    fail "report-only duplicate drifted rc=$rc remaining=$remaining ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)] alerts=[$(cat "$alerts")]"
  fi
}

test_fly1605_winner_order_ignores_stale_receipt_and_prefers_pin() {
  echo "Test: FLY-1605 — winner order ignores stale receipts and prefers pinned over selected"
  reset_mocks
  FLYWHEEL_CMUX_LINKED_VIEW=1
  MOCK_SOCK_IDENT="cmux-generation-1"
  MOCK_CMUX_MUTATE_JSON=1
  MOCK_CMUX_MUTATE_SURFACES=1
  local title="FLY-1605-design-claude" raw roster rc=0 saved_liveness
  fly1605_seed_strict_managed_window "runner-flywheel" "@1605" "$title"
  roster="runner-flywheel|@1605|$title"
  raw=$(build_attach_command "cmux-$title")
  MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"ref\":\"workspace:99\",\"title\":\"$raw\"},{\"ref\":\"workspace:100\",\"title\":\"$raw\",\"selected\":true},{\"ref\":\"workspace:101\",\"title\":\"$raw\",\"pinned\":true}]}"
  MOCK_CMUX_SURFACES="workspace:99;;surface:99;;terminal;;true;;$raw
workspace:100;;surface:100;;terminal;;true;;$raw
workspace:101;;surface:101;;terminal;;true;;$raw"
  test_ledger_upsert committed "cmux-generation-stale" "workspace:99" "$title"
  saved_liveness=$(declare -f workspace_attach_liveness)
  workspace_attach_liveness() {
    [[ "$1" == workspace:101 ]] && printf 'live\n' || printf 'dead\n'
  }
  MOCK_CMUX_OPS=""
  reconcile_workspace_titles "$roster" >/dev/null 2>&1 || rc=$?
  eval "$saved_liveness"
  if [[ "$rc" -eq 0 \
      && "$(grep -cF "rename-workspace --workspace workspace:101 $title" <<< "$MOCK_CMUX_OPS" || true)" == "1" \
      && "$(grep -c '^close-workspace --workspace workspace:' <<< "$MOCK_CMUX_OPS" || true)" == "0" ]]; then
    pass "current-generation ordering chooses the pinned candidate and preserves siblings report-only"
  else
    fail "winner ordering drifted rc=$rc ops=[$MOCK_CMUX_OPS] ledger=[$(cat "$VIEW_LEDGER" 2>/dev/null)]"
  fi
}

test_fly1605_title_reconcile_mounts_after_refresh_before_create() {
  echo "Test: FLY-1605 — bootstrap/additive/once mount title reconcile after refresh and before create"
  reset_mocks
  local mode trace expected ok=1
  for mode in bootstrap additive once; do
    trace="$TMPDIR_ROOT/fly1605-mount-$mode.trace"
    : > "$trace"
    TRACE_FILE="$trace" PASS_MODE="$mode" REFRESH_RC=0 \
      FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMPDIR_ROOT/no-maintenance" \
      /bin/bash -c '
        source "$1"
        reconcile_roster_read_phase() { printf "roster\n" >> "$TRACE_FILE"; }
        register_hooks_on_new_sessions() { :; }
        get_tmux_agent_windows() { printf "runner-flywheel|@1605|FLY-1605-design-claude\n"; }
        prepare_linked_view_state() { printf "refresh\n" >> "$TRACE_FILE"; return "$REFRESH_RC"; }
        refresh_linked_sessions_tail() { :; }
        advance_attach_reap_state() { :; }
        discover_orphan_attach_helpers() { :; }
        reconcile_existing_workspaces() { printf "existing\n" >> "$TRACE_FILE"; }
        reconcile_workspace_titles() { printf "titles:%s\n" "$1" >> "$TRACE_FILE"; }
        workspace_exists_for() { printf "exists\n" >> "$TRACE_FILE"; return 1; }
        create_workspace_for_window() { printf "create:%s|%s|%s\n" "$1" "$2" "$3" >> "$TRACE_FILE"; }
        self_heal_sweep_all() { printf "heal\n" >> "$TRACE_FILE"; }
        cleanup_stale_conservative() { :; }
        cleanup_stale_workspaces() { :; }
        reap_ghost_workspaces() { :; }
        reap_unledgered_stock_workspaces() { :; }
        reap_orphan_workspace_pins() { :; }
        pgrep() { return 1; }
        case "$PASS_MODE" in
          bootstrap) sync_additive_bootstrap ;;
          additive) sync_additive ;;
          once) sync_once ;;
        esac
      ' _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" >/dev/null 2>&1 || ok=0
    expected=$(awk '
      $0 == "refresh" { refresh=NR }
      /^titles:runner-flywheel\|@1605\|FLY-1605-design-claude$/ { title=NR }
      /^create:runner-flywheel\|@1605\|FLY-1605-design-claude$/ { create=NR }
      END { print (refresh > 0 && title > refresh && create > title) ? "yes" : "no" }
    ' "$trace")
    [[ "$expected" == "yes" ]] || { fail "$mode title reconcile ordering drifted trace=[$(tr '\n' ';' < "$trace")]"; ok=0; }

    : > "$trace"
    TRACE_FILE="$trace" PASS_MODE="$mode" REFRESH_RC=1 \
      FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMPDIR_ROOT/no-maintenance" \
      /bin/bash -c '
        source "$1"
        reconcile_roster_read_phase() { :; }
        register_hooks_on_new_sessions() { :; }
        get_tmux_agent_windows() { printf "runner-flywheel|@1605|FLY-1605-design-claude\n"; }
        prepare_linked_view_state() { printf "refresh\n" >> "$TRACE_FILE"; return "$REFRESH_RC"; }
        refresh_linked_sessions_tail() { :; }
        advance_attach_reap_state() { :; }
        discover_orphan_attach_helpers() { :; }
        reconcile_existing_workspaces() { printf "existing\n" >> "$TRACE_FILE"; }
        reconcile_workspace_titles() { printf "titles\n" >> "$TRACE_FILE"; }
        workspace_exists_for() { printf "exists\n" >> "$TRACE_FILE"; return 1; }
        create_workspace_for_window() { printf "create\n" >> "$TRACE_FILE"; }
        self_heal_sweep_all() { :; }
        cleanup_stale_conservative() { :; }
        cleanup_stale_workspaces() { :; }
        reap_ghost_workspaces() { :; }
        reap_unledgered_stock_workspaces() { :; }
        reap_orphan_workspace_pins() { :; }
        pgrep() { return 1; }
        case "$PASS_MODE" in
          bootstrap) sync_additive_bootstrap ;;
          additive) sync_additive ;;
          once) sync_once ;;
        esac
      ' _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" >/dev/null 2>&1 || ok=0
    if grep -Eq '^(titles|create|exists)' "$trace"; then
      fail "$mode crossed an inconclusive refresh trace=[$(tr '\n' ';' < "$trace")]"
      ok=0
    fi
  done
  [[ "$ok" == "1" ]] && pass "all three passes reuse the captured roster only after conclusive refresh and before create"
}

test_fly2048_cleanup_mounts_between_wal_pre_and_refresh_tail() {
  echo "Test: FLY-2048 — Lead/hooks stay first; cleanup runs after WAL pre and before refresh tail"
  reset_mocks
  local mode trace verdict ok=1
  for mode in bootstrap additive; do
    trace="$TMPDIR_ROOT/fly2048-order-$mode.trace"
    : > "$trace"
    TRACE_FILE="$trace" PASS_MODE="$mode" \
      FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMPDIR_ROOT/no-maintenance" \
      /bin/bash -c '
        source "$1"
        reconcile_roster_read_phase() { printf "roster\n" >> "$TRACE_FILE"; }
        cmux_attach_birth_cache_prime() { printf "birth\n" >> "$TRACE_FILE"; }
        reconcile_v2_lead_workspaces() { printf "lead\n" >> "$TRACE_FILE"; }
        register_hooks_on_new_sessions() { printf "hooks\n" >> "$TRACE_FILE"; }
        prepare_linked_view_state() { printf "pre:%s\n" "$1" >> "$TRACE_FILE"; }
        advance_attach_reap_state() { printf "advance\n" >> "$TRACE_FILE"; }
        discover_orphan_attach_helpers() { printf "discover\n" >> "$TRACE_FILE"; }
        reap_orphan_workspace_pins() { printf "pins\n" >> "$TRACE_FILE"; }
        refresh_linked_sessions_tail() {
          printf "tail:bootstrap=%s\n" "${RESTORED_BOOTSTRAP_PASS:-0}" >> "$TRACE_FILE"
          return 1
        }
        refresh_linked_sessions() { printf "legacy-refresh\n" >> "$TRACE_FILE"; return 1; }
        get_tmux_agent_windows() { printf "runner-flywheel|@2048|FLY-2048-implement\n"; }
        reconcile_existing_workspaces() { printf "existing\n" >> "$TRACE_FILE"; }
        reconcile_workspace_titles() { printf "titles\n" >> "$TRACE_FILE"; }
        workspace_exists_for() { printf "exists\n" >> "$TRACE_FILE"; return 1; }
        create_workspace_for_window() { printf "create\n" >> "$TRACE_FILE"; }
        self_heal_sweep_all() { :; }
        cleanup_stale_conservative() { :; }
        reap_ghost_workspaces() { :; }
        reap_unledgered_stock_workspaces() { :; }
        case "$PASS_MODE" in
          bootstrap) sync_additive_bootstrap ;;
          additive) sync_additive ;;
        esac
      ' _ "$SCRIPT_DIR/flywheel-cmux-sync.sh" >/dev/null 2>&1 || ok=0
    verdict=$(awk -v mode="$mode" '
      $0=="lead" {lead=NR}
      $0=="hooks" {hooks=NR}
      $0=="pre:pre" {pre=NR}
      $0=="advance" {advance=NR}
      $0=="discover" {discover=NR}
      $0=="pins" {pins=NR}
      /^tail:bootstrap=/ {tail=NR; flag=$0}
      END {
        prefix=(lead>0 && pre>lead && (mode!="additive" || hooks>lead && pre>hooks))
        cleanup=(advance>pre && discover>advance && pins>discover && tail>pins)
        expected=(mode=="bootstrap" ? "tail:bootstrap=1" : "tail:bootstrap=0")
        print (prefix && cleanup && flag==expected) ? "yes" : "no"
      }
    ' "$trace")
    if [[ "$verdict" != yes ]] || grep -Eq '^(legacy-refresh|existing|titles|exists|create)$' "$trace"; then
      fail "$mode split ordering drifted trace=[$(tr '\n' ';' < "$trace")]"
      ok=0
    fi
  done
  [[ "$ok" == 1 ]] && pass "cleanup is reachable before heavy refresh failure without moving Lead/hooks or bootstrap budget"
}

test_fly1605_ambiguous_legacy_tmux_generation_preserves_wal() {
  echo "Test: FLY-1605 — same socket+pid legacy generations preserve and block WAL recovery"
  reset_mocks
  local current="$TMPDIR_ROOT/tmux.sock|4242|Sat Aug  1 16:45:06 2026"
  local old view source wid wal before rc label ok=1
  FLYWHEEL_CMUX_TMUX_GENERATION="$current"
  source="runner-flywheel"
  wid="@1605"
  mkdir -p "$VIEW_WAL_DIR"
  for label in timezone-render pid-reuse; do
    view="cmux-FLY-1605-${label}"
    case "$label" in
      timezone-render) old="$TMPDIR_ROOT/tmux.sock|4242|Sun Aug  2 01:45:06 2026" ;;
      pid-reuse) old="$TMPDIR_ROOT/tmux.sock|4242|Fri Jul 31 16:45:06 2026" ;;
    esac
    wal=$(_view_wal_path "$view")
    printf 'v1|%s|create_intent|fly1605-%s|%s|%s|%s||\n' \
      "$old" "$label" "$view" "$source" "$wid" > "$wal"
    before=$(cat "$wal")
    CMUX_WAL_BLOCKED_VIEWS=""
    rc=0
    recover_all_view_constructions >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -eq 0 && -f "$wal" && "$(cat "$wal")" == "$before" ]] \
        && cmux_wal_view_blocked "$view"; then
      :
    else
      fail "$label ambiguity did not preserve+block rc=$rc wal=[$(cat "$wal" 2>/dev/null)] blocked=[$CMUX_WAL_BLOCKED_VIEWS]"
      ok=0
    fi
  done
  [[ "$ok" == "1" ]] && pass "timezone drift and true PID reuse are both preserved byte-for-byte without recovery authority"
}

echo ""
echo "═══ FLY-1605: timezone-stable process identities ═══"
test_fly1605_process_incarnation_is_timezone_stable
test_fly1605_tmux_generation_is_timezone_stable
test_fly1605_ledger_survives_timezone_change
test_fly1605_prepared_title_migration_renames_tab_and_commits
test_fly1605_prepared_title_migration_refuses_foreign_surface
test_fly1605_prepared_recovery_uses_shared_surface_guard
test_fly1605_prepared_surface_drift_does_not_block_additive_pass
test_fly1672_title_reconcile_refuses_vanished_source_id
test_fly1605_named_stock_adoption_is_receipt_only_and_idempotent
test_fly1605_steady_state_stays_within_cmux_ipc_budget
test_fly1605_topology_refusal_warns_only_on_transition
test_fly1605_title_matching_is_prefix_isolated
test_fly1605_ambiguous_surface_inventory_fails_closed
test_fly1605_raw_stock_with_foreign_surface_has_zero_authority
test_fly1605_raw_duplicates_converge_through_guarded_close
test_fly1605_named_keeper_closes_raw_extra_after_tab_ready
test_fly1605_generation_flip_blocks_stock_rename
test_fly1605_report_only_preserves_raw_extra_and_alerts
test_fly1605_winner_order_ignores_stale_receipt_and_prefers_pin
test_fly1605_title_reconcile_mounts_after_refresh_before_create
test_fly2048_cleanup_mounts_between_wal_pre_and_refresh_tail
test_fly1605_ambiguous_legacy_tmux_generation_preserves_wal

echo ""
echo "═══ FLY-1482: authority-loss review regressions ═══"
test_fly1482_authority_latch_stops_inner_batch_loops
test_fly1482_claim_reap_errors_are_not_mislabelled_malformed

echo ""
echo "═══ FLY-1887: diskless read parity ═══"

cmux_source="$SCRIPT_DIR/flywheel-cmux-sync.sh"
here_string_count=$(grep -c '<<<' "$cmux_source" || true)
if [[ "$here_string_count" == "0" ]]; then
  pass "production watcher contains no disk-writing Bash here-strings"
else
  fail "production watcher still contains $here_string_count Bash here-string(s)"
fi

read_a=""; read_b=""; read_c=""; read_rc=1
IFS='|' read -r read_a read_b read_c < <(printf '%s\n' 'a|b|')
read_rc=$?
if [[ "$read_rc" == "0" && "$read_a" == "a" && "$read_b" == "b" && -z "$read_c" ]]; then
  pass "process substitution preserves top-level read rc=0 and a trailing empty field"
else
  fail "top-level read parity drifted rc=$read_rc fields=[$read_a][$read_b][$read_c]"
fi

empty_iterations=0
while IFS= read -r read_row; do
  empty_iterations=$((empty_iterations + 1))
done < <(printf '%s\n' "")
if [[ "$empty_iterations" == "1" ]]; then
  pass "an empty command-substitution payload still produces one loop iteration"
else
  fail "empty payload produced $empty_iterations loop iterations"
fi

touch "$TMPDIR_ROOT/matching.json"
saved_pwd="$PWD"
cd "$TMPDIR_ROOT" || exit 1
IFS= read -r glob_literal < <(printf '%s\n' '*.json')
cd "$saved_pwd" || exit 1
if [[ "$glob_literal" == '*.json' ]]; then
  pass "a cwd-matching glob remains literal"
else
  fail "glob literal expanded or changed: [$glob_literal]"
fi

IFS= read -r backslash_literal < <(printf '%s\n' 'path\with\backslashes')
if [[ "$backslash_literal" == 'path\with\backslashes' ]]; then
  pass "read -r preserves backslashes byte-for-byte"
else
  fail "backslash input changed: [$backslash_literal]"
fi

IFS='|' read -r delim_a delim_b delim_rest < <(printf '%s\n' 'left|middle|right|tail')
if [[ "$delim_a" == "left" && "$delim_b" == "middle" && "$delim_rest" == 'right|tail' ]]; then
  pass "the final read field preserves remaining delimiters"
else
  fail "delimiter parsing drifted: [$delim_a][$delim_b][$delim_rest]"
fi

set +e   # restore lenient mode for the summary

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════
echo ""
echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -eq 0 ]]; then
  echo "✅ All tests passed"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
