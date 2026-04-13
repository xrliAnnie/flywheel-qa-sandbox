#!/usr/bin/env bash
# FLY-102: Tests for flywheel-cmux-sync.sh event-signaled polling logic.
# Runs: bash scripts/test-cmux-sync.sh
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

# ════════════════════════════════════════════════════════════════
# Mocks for tmux and cmux
# ════════════════════════════════════════════════════════════════
MOCK_TMUX_WINDOWS=""       # lines of session|wid|wname
MOCK_PANE_DEAD=""          # lines of session:wname=0|1
MOCK_CMUX_WORKSPACES=""    # cmux list-workspaces output
MOCK_TMUX_SESSIONS=""      # list-sessions output
MOCK_TMUX_HOOKS=""         # captured set-hook invocations
MOCK_CMUX_OPS=""           # captured cmux operations
MOCK_TMUX_KILLED=""        # captured tmux kill-session targets

tmux() {
  case "$1" in
    list-windows)
      shift
      # args are like: -t session -F format
      local session=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) session="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" '$1 == s' || true
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
  case "$1" in
    list-workspaces)
      echo "$MOCK_CMUX_WORKSPACES"
      ;;
    close-workspace|new-workspace|rename-workspace)
      MOCK_CMUX_OPS+="$*"$'\n'
      ;;
    *) return 0 ;;
  esac
}

export -f tmux cmux

reset_mocks() {
  MOCK_TMUX_WINDOWS=""
  MOCK_PANE_DEAD=""
  MOCK_CMUX_WORKSPACES=""
  MOCK_TMUX_SESSIONS=""
  MOCK_TMUX_HOOKS=""
  MOCK_CMUX_OPS=""
  MOCK_TMUX_KILLED=""
  rm -f "$EVENT_FILE" "$CLEANUP_PENDING" "$STALE_STATE"
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

# ════════════════════════════════════════════════════════════════
# Test 3: Hook command embeds format vars, not $(date ...)
# ════════════════════════════════════════════════════════════════
echo "Test: hook command does not embed shell-expanded timestamp"
reset_mocks
register_session_hooks "flywheel" >/dev/null

if echo "$MOCK_TMUX_HOOKS" | grep -q '#{hook_session_name}'; then
  pass "hook uses #{hook_session_name} format var"
else
  fail "hook missing #{hook_session_name}"
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
