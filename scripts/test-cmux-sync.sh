#!/bin/bash
# FLY-102: Tests for flywheel-cmux-sync.sh event-signaled polling logic.
# Runs: /bin/bash scripts/test-cmux-sync.sh
#
# FLY-129 Phase 1 (R2-8): explicit `#!/bin/bash` (not `/usr/bin/env bash`).
# Production cmux watcher runs under macOS `/bin/bash` 3.2; Homebrew bash 4+
# would mask bash-3.2-incompatible constructs (declare -A, BASHPID, etc.).
# The preflight assertion below catches Homebrew-bash invocations.

case "${BASH_VERSION:-}" in
  3.2*) ;;
  *)
    echo "test-cmux-sync.sh requires /bin/bash 3.2 (macOS system bash)" >&2
    echo "  detected: BASH_VERSION=${BASH_VERSION:-<unset>}" >&2
    echo "  run as: /bin/bash $0" >&2
    exit 1
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

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# Isolate file-based state in a tempdir
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export EVENT_FILE="$TMPDIR_ROOT/events"
export CLEANUP_PENDING="$TMPDIR_ROOT/cleanup-pending"
export STALE_STATE="$TMPDIR_ROOT/stale.state"
export FLYWHEEL_CMUX_CLEANUP_DELAY=30
export FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP=300

# FLY-129 Phase 1: tests must not touch the real /tmp watcher lock.
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMPDIR_ROOT/watcher.lock"

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
MOCK_PGREP_HIT="0"         # FLY-129 Phase 1: pgrep mock — 1 = watcher running, 0 = not
MOCK_SHOW_HOOKS=""         # FLY-129 Phase 2: tmux show-hooks output — lines of "<hook>[idx] ..." per session

tmux() {
  case "$1" in
    list-windows)
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
      echo "$MOCK_TMUX_SESSIONS"
      ;;
    has-session)
      local target="${2#=}"
      echo "$MOCK_TMUX_SESSIONS" | grep -qx "$target"
      ;;
    display-message)
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
      echo "$MOCK_PANE_DEAD" | awk -F= -v k="${session}:${wname}" '$1 == k { print $2; found=1 } END { if (!found) print "1" }'
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
    new-session|select-window|new-window)
      : ;;  # noop
    *)
      return 0 ;;
  esac
}

cmux() {
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
  case "${1:-}" in
    list-workspaces)
      if (( json_mode == 1 )); then
        if [[ "$MOCK_CMUX_JSON_FAIL" == "1" ]]; then
          return 1
        fi
        if [[ "$MOCK_CMUX_JSON_INVALID" == "1" ]]; then
          echo "not json"
        else
          echo "$MOCK_CMUX_WORKSPACES_JSON"
        fi
      else
        echo "$MOCK_CMUX_WORKSPACES"
      fi
      ;;
    close-workspace|new-workspace|rename-workspace)
      MOCK_CMUX_OPS+="$*"$'\n'
      ;;
    *) return 0 ;;
  esac
}

pgrep() {
  # FLY-129 Phase 1: drive sync_once's watcher-detection branch from tests.
  # Real pgrep returns 0 if any match, 1 if none. Honor MOCK_PGREP_HIT.
  [[ "${MOCK_PGREP_HIT:-0}" == "1" ]] && return 0
  return 1
}

export -f tmux cmux pgrep

reset_mocks() {
  MOCK_TMUX_WINDOWS=""
  MOCK_PANE_DEAD=""
  MOCK_CMUX_WORKSPACES=""
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  MOCK_CMUX_JSON_FAIL="0"
  MOCK_CMUX_JSON_INVALID="0"
  MOCK_TMUX_SESSIONS=""
  MOCK_TMUX_HOOKS=""
  MOCK_CMUX_OPS=""
  MOCK_TMUX_KILLED=""
  MOCK_PGREP_HIT="0"
  MOCK_SHOW_HOOKS=""
  # FLY-129 Phase 3: reset JSON transition state so per-test logging is clean.
  CMUX_JSON_LAST_STATE="unknown"
  rm -f "$EVENT_FILE" "$CLEANUP_PENDING" "$STALE_STATE"
  rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
}

# Source the script (guarded — dispatcher won't run because BASH_SOURCE != $0)
source "$SCRIPT_DIR/flywheel-cmux-sync.sh"

# Re-export mocks after sourcing (sourcing unsets them in some shells? defensive)
export -f tmux cmux

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
# kill-session called for expired-win's linked session
if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-expired-win"; then
  pass "linked session cmux-expired-win killed"
else
  fail "expected kill-session =cmux-expired-win. Got: $MOCK_TMUX_KILLED"
fi

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

drain_events >/dev/null

# create events: should trigger new-workspace twice (worker-fly-102 + runner-task-1)
create_count=$(echo "$MOCK_CMUX_OPS" | grep -c "^new-workspace" || true)
if [[ "$create_count" == "2" ]]; then
  pass "drain_events creates workspaces for 2 valid sessions"
else
  fail "expected 2 new-workspace calls, got $create_count. Ops: $MOCK_CMUX_OPS"
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
MOCK_CMUX_WORKSPACES="  workspace:3  orphan-win"

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
if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-orphan-win"; then
  pass "conservative cleanup fires after 5min"
else
  fail "expected kill-session =cmux-orphan-win. Got: $MOCK_TMUX_KILLED"
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
MOCK_CMUX_WORKSPACES=""

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
if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-dead-pane-win"; then
  pass "dead-pane window cleaned up after threshold (closes event-loss leak)"
else
  fail "expected cleanup of dead-pane-win after 5min. Got: $MOCK_TMUX_KILLED"
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
  > "$TMUX_INT_EVENT_FILE"

  # Use `command tmux` throughout to bypass the mock function defined above.
  command tmux kill-session -t "$TMUX_INT_SESSION" 2>/dev/null
  # FLY-129 R2: some sandboxes (AppArmor / restricted /tmp / codex review env)
  # reject tmux's socket creation. Probe + skip gracefully instead of failing.
  if ! command tmux new-session -d -s "$TMUX_INT_SESSION" -n initial 2>/dev/null; then
    echo "  ⏭  tmux new-session failed (sandbox / restricted env) — skipping integration test"
  else

  # Exact hook command strings from register_session_hooks / register_global_hooks.
  command tmux set-hook -t "$TMUX_INT_SESSION" 'after-new-window[500]' \
    "run-shell -b 'echo \"create|#{session_name}|#{window_id}|#{window_name}\" >> $TMUX_INT_EVENT_FILE'" 2>/dev/null
  command tmux set-hook -t "$TMUX_INT_SESSION" 'pane-exited[500]' \
    "run-shell -b 'echo \"exited|#{session_name}|#{window_name}\" >> $TMUX_INT_EVENT_FILE'" 2>/dev/null

  # Trigger after-new-window.
  command tmux new-window -t "$TMUX_INT_SESSION:" -n int-test-win 2>/dev/null
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

  command tmux kill-session -t "$TMUX_INT_SESSION" 2>/dev/null || true
  fi  # tmux new-session probe close
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

echo ""
echo "═══ FLY-129: cmux IPC health check + cmux_call ═══"
test_health_check_no_socket
test_health_check_auth_rejected
test_health_check_healthy
test_health_check_transient_error
test_cmux_call_stdout_passthrough
test_cmux_call_stderr_logged_not_in_stdout

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

test_lock_acquire_blocks_second() {
  echo "Test: lock_acquire_blocks_second"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "$$" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  if run_acquire_subshell "$stderr_file" && grep -q "watcher already running" "$stderr_file"; then
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
  # R2-3: after reaping stale lock, mkdir of the lock dir can fail if a
  # contender slips in. We can't reliably orchestrate a real race in a unit
  # test, so we simulate: pre-create $WATCHER_REAP_MUTEX so the first
  # iteration's `mkdir reap_mutex` fails → sleep 1 → next iteration. Across
  # 3 attempts we exhaust and exit 0. This validates BOTH the
  # mkdir-of-reap-mutex failure branch AND the bounded retry loop.
  echo "Test: lock_acquire_mkdir_fails_after_reap (R2-3 retry exhaustion)"
  reset_mocks
  # Pre-stale the lock dir with a dead PID so we'd want to reap...
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  # ...but a contender holds the reap mutex the whole time.
  mkdir -p "$WATCHER_REAP_MUTEX"
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  # Override sleep to no-op so this test doesn't take 3 real seconds.
  sleep() { :; }
  export -f sleep
  if run_acquire_subshell "$stderr_file"; then
    if grep -q "exhausted retries" "$stderr_file"; then
      pass "3 attempts exhausted, exit 0 + 'exhausted retries' log"
    else
      fail "did not log 'exhausted retries' (stderr: $(cat "$stderr_file"))"
    fi
  else
    fail "exhaustion path did not exit 0 — got non-zero (stderr: $(cat "$stderr_file"))"
  fi
  unset -f sleep
  rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
}

test_lock_acquire_retries_bounded() {
  # Same setup as above, but assert that the subshell completes in bounded
  # time (no infinite loop). Our override of `sleep` makes this trivial; the
  # real safeguard is the `for attempt in 1 2 3` loop.
  echo "Test: lock_acquire_retries_bounded (does not infinite loop)"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  mkdir -p "$WATCHER_REAP_MUTEX"
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
  rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
}

test_once_detects_watcher() {
  # Research §3.3 Option b: --once must short-circuit when --watch is running.
  echo "Test: once_detects_watcher"
  reset_mocks
  MOCK_PGREP_HIT="1"
  local stderr_file="$TMPDIR_ROOT/once.stderr"
  # sync_once contains `exit 0` on the detect branch → run in subshell.
  ( sync_once ) >/dev/null 2>"$stderr_file"
  local rc=$?
  if [[ $rc -eq 0 ]] && grep -q -- "--refresh" "$stderr_file"; then
    pass "subshell exit 0 + stderr suggests --refresh"
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
JSON_GHOST_MIXED='{"workspaces":[{"ref":"workspace:10","title":null},{"ref":"workspace:11","title":"~"},{"ref":"workspace:12","title":""},{"ref":"workspace:13","title":"keep-me"}]}'

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

test_get_ghost_workspace_refs_mixed_titles() {
  echo "Test: get_ghost_workspace_refs collects null/empty/tilde"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_GHOST_MIXED"
  local refs
  refs=$(get_ghost_workspace_refs)
  # workspace:13 has title "keep-me", should NOT appear. Others should.
  local expected_count=0
  for r in workspace:10 workspace:11 workspace:12; do
    if echo "$refs" | grep -qx "$r"; then
      expected_count=$((expected_count + 1))
    fi
  done
  if [[ $expected_count -eq 3 ]] && ! echo "$refs" | grep -qx "workspace:13"; then
    pass "3 ghost refs returned, non-ghost excluded"
  else
    fail "refs=$refs (expected workspace:10/11/12 only)"
  fi
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

test_cleanup_workspace_for_handles_dup() {
  echo "Test: cleanup_workspace_for closes ALL dup refs"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_TWO_DUP"
  cleanup_workspace_for "foo" 2>/dev/null
  local close_count
  close_count=$(echo "$MOCK_CMUX_OPS" | grep -c "^close-workspace" || true)
  if [[ "$close_count" == "2" ]]; then
    pass "both dup refs closed (workspace:1 + workspace:29)"
  else
    fail "expected 2 closes, got $close_count. Ops: $MOCK_CMUX_OPS"
  fi
}

test_cleanup_workspace_for_json_unavailable_still_kills_linked_session_and_drains_state() {
  echo "Test: cleanup_workspace_for JSON unavailable — skips cmux close, runs local cleanup (R4-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  # Pre-seed STALE_STATE so drain has something to remove.
  echo "foo|1700000000" > "$STALE_STATE"
  local stderr_file="$TMPDIR_ROOT/cleanup.stderr"
  cleanup_workspace_for "foo" 2>"$stderr_file"
  # 1. NO cmux close (JSON was unavailable).
  if [[ -z "$MOCK_CMUX_OPS" ]]; then
    pass "no cmux close calls"
  else
    fail "unexpected cmux ops: $MOCK_CMUX_OPS"
  fi
  # 2. WARN log emitted ("cmux JSON unavailable").
  if grep -q "cmux JSON unavailable" "$stderr_file"; then
    pass "log emits 'cmux JSON unavailable'"
  else
    fail "missing JSON-unavailable warn; stderr=$(cat "$stderr_file")"
  fi
  # 3. tmux kill-session was called (unconditional).
  if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-foo"; then
    pass "tmux kill-session called unconditionally"
  else
    fail "no kill-session for cmux-foo; killed=$MOCK_TMUX_KILLED"
  fi
  # 4. STALE_STATE row drained.
  if ! grep -q "^foo|" "$STALE_STATE" 2>/dev/null; then
    pass "STALE_STATE row drained unconditionally"
  else
    fail "STALE_STATE still contains foo: $(cat "$STALE_STATE")"
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
    fail "expected alive (rc=0), got rc=$rc"
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
test_workspace_refs_for_dup
test_workspace_refs_for_with_whitespace_title
test_workspace_refs_for_none
test_workspace_refs_for_rc2_on_json_fail
test_workspace_exists_for_tri_state
test_get_ghost_workspace_refs_mixed_titles
test_close_workspace_by_ref_dry_run
test_close_workspace_by_ref_real
test_cleanup_workspace_for_handles_dup
test_cleanup_workspace_for_json_unavailable_still_kills_linked_session_and_drains_state
test_drain_handles_regex_metachars_in_name
test_is_pane_alive_handles_regex_metachars

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 4: ghost reaper
# ════════════════════════════════════════════════════════════════

test_reap_ghost_workspaces_closes_only_ghosts() {
  echo "Test: reap_ghost_workspaces closes null/empty/'~' titles only"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_GHOST_MIXED"
  reap_ghost_workspaces
  local close_count
  close_count=$(echo "$MOCK_CMUX_OPS" | grep -c "^close-workspace" || true)
  if [[ "$close_count" == "3" ]]; then
    pass "3 ghost workspaces closed (workspace:10/11/12)"
  else
    fail "expected 3 closes, got $close_count. Ops: $MOCK_CMUX_OPS"
  fi
  if echo "$MOCK_CMUX_OPS" | grep -q "workspace:13"; then
    fail "non-ghost workspace:13 (title=keep-me) should NOT be closed"
  else
    pass "non-ghost workspace:13 left alone"
  fi
}

test_reap_ghost_skips_on_json_fail() {
  echo "Test: reap_ghost_workspaces no-ops on JSON failure"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  reap_ghost_workspaces 2>/dev/null
  if [[ -z "$MOCK_CMUX_OPS" ]]; then
    pass "no closes attempted when JSON unavailable"
  else
    fail "unexpected ops on JSON failure: $MOCK_CMUX_OPS"
  fi
}

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 6: dedup newest-wins
# ════════════════════════════════════════════════════════════════

test_dedup_keeps_newest_workspace_n() {
  echo "Test: dedup_workspaces_by_title keeps highest workspace:N"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"foo"},{"ref":"workspace:29","title":"foo"}]}'
  dedup_workspaces_by_title 2>/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:1" \
     && ! echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:29"; then
    pass "closed workspace:1, kept workspace:29 (newest-N wins)"
  else
    fail "ops: $MOCK_CMUX_OPS"
  fi
}

test_dedup_prefers_pinned_over_newest() {
  echo "Test: dedup_workspaces_by_title prefers pinned over newest-N"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"foo","pinned":true},{"ref":"workspace:29","title":"foo","pinned":false}]}'
  dedup_workspaces_by_title 2>/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:29" \
     && ! echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:1"; then
    pass "closed workspace:29 (un-pinned), kept workspace:1 (pinned)"
  else
    fail "ops: $MOCK_CMUX_OPS"
  fi
}

test_dedup_prefers_selected_over_newest() {
  echo "Test: dedup_workspaces_by_title prefers selected over newest-N"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"foo","selected":true},{"ref":"workspace:29","title":"foo"}]}'
  dedup_workspaces_by_title 2>/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:29" \
     && ! echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:1"; then
    pass "closed workspace:29 (unselected), kept workspace:1 (selected)"
  else
    fail "ops: $MOCK_CMUX_OPS"
  fi
}

test_dedup_logs_and_skips_malformed_ref() {
  echo "Test: dedup logs + skips malformed ref"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:abc","title":"foo"},{"ref":"workspace:5","title":"foo"}]}'
  local stderr_file="$TMPDIR_ROOT/dedup.stderr"
  dedup_workspaces_by_title 2>"$stderr_file"
  # workspace:abc is malformed; workspace:5 is the only valid → no dedup needed.
  if grep -q "malformed ref" "$stderr_file"; then
    pass "malformed ref logged"
  else
    fail "no malformed-ref log; stderr=$(cat "$stderr_file")"
  fi
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace"; then
    fail "should NOT close anything (only one valid ref): $MOCK_CMUX_OPS"
  else
    pass "no close attempted (only one valid ref in dup group)"
  fi
}

test_dedup_skips_on_json_fail() {
  echo "Test: dedup_workspaces_by_title no-ops on JSON failure"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  dedup_workspaces_by_title 2>/dev/null
  if [[ -z "$MOCK_CMUX_OPS" ]]; then
    pass "no closes attempted on JSON failure (R2-6 fail-closed)"
  else
    fail "unexpected ops: $MOCK_CMUX_OPS"
  fi
}

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
test_reap_ghost_workspaces_closes_only_ghosts
test_reap_ghost_skips_on_json_fail

echo ""
echo "═══ FLY-129 Phase 6: dedup newest-wins ═══"
test_dedup_keeps_newest_workspace_n
test_dedup_prefers_pinned_over_newest
test_dedup_prefers_selected_over_newest
test_dedup_logs_and_skips_malformed_ref
test_dedup_skips_on_json_fail

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
