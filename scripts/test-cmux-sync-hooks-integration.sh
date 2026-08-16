#!/usr/bin/env bash
# FLY-110: Real-tmux integration tests for flywheel-cmux-sync.sh hook registration.
#
# Why this file exists:
#   scripts/test-cmux-sync.sh exercises the script with mock tmux/cmux
#   functions. Mocks cannot detect *which* tmux hook event the real tmux
#   server actually fires when a pane process exits. FLY-110 root cause was
#   exactly that — `pane-exited` hook registered, but tmux 3.5a fires
#   `pane-died` (not `pane-exited`) when the pane has `remain-on-exit on`
#   set, so the cleanup event path silently never ran in production.
#
# This script runs an *isolated* tmux server via an exact socket path under
# its private temp root, so it does not touch the developer's or
# CI runner's main tmux server. The shim function `tmux()` redirects all
# `tmux` calls to that isolated socket, including calls made from
# functions sourced from `flywheel-cmux-sync.sh`.
#
# Scenarios (each in an independent fixture):
#   A: program exits + remain-on-exit ON  (production main path)
#      → expect pane-died to write "exited|<sess>|<wname>" to EVENT_FILE
#         with correct window_name (window stays around because of
#         remain-on-exit, so #{window_name} resolves correctly).
#   B: program exits + remain-on-exit OFF (legacy / off-mode)
#      → expect pane-exited to write "exited|..." to EVENT_FILE.
#         NOTE: when remain-on-exit is OFF, the window is destroyed when
#         the pane exits, and tmux 3.5a's #{window_name} fallback can
#         resolve to the next active window rather than the dead pane's
#         original window. We assert only that an exited event was
#         written, not its specific window_name. Production does not
#         use this configuration.
#   C: production cleanup path — natural exit (A) followed by Bridge's
#      kill-window on the now-dead pane → exactly one raw "exited|..."
#      hook line is written for the target window in tmux 3.5a; the
#      subsequent kill-window contributes no additional event. (This is
#      a raw hook output test; mark_for_cleanup idempotency under
#      repeated events is covered separately by the mock unit test in
#      scripts/test-cmux-sync.sh.)
#
# Out-of-scope (not asserted): kill-window / kill-pane on a LIVE pane
# with remain-on-exit ON. Empirically tmux 3.5a fires neither pane-died
# nor pane-exited for that path. Production never executes that path
# (Bridge close-tmux runs only after Runner status is non-running, by
# which point the pane has already died naturally). The 5-min
# conservative polling fallback covers the rare corner case.
#
# Skips cleanly if:
#   - `tmux` not installed (e.g. minimal container)
#   - the isolated tmux server cannot start (e.g. sandbox with no socket
#     creation permission — Codex sandbox reproduces this)
#
# Runs: bash scripts/test-cmux-sync-hooks-integration.sh
set -uo pipefail

PASS=0
FAIL=0
SKIP=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  • SKIP: $1"; SKIP=$((SKIP + 1)); }

# ── Pre-flight ────────────────────────────────────────────────────────

if ! command -v tmux >/dev/null 2>&1; then
  skip "tmux not installed; skipping all hook integration scenarios"
  echo
  echo "Skipped (tmux missing): $SKIP"
  exit 0
fi

TMUX_VERSION=$(tmux -V 2>/dev/null || echo "tmux unknown")
echo "tmux version: $TMUX_VERSION"

# FLY-60 W4b + FLY-110: tmux 3.5+ is the production target (macOS Lead /
# Runner machines run 3.5a). Some scenarios in this file exercise
# behavior that differs between tmux 3.4 (e.g. Ubuntu CI default) and
# 3.5+: pane-exited / window-unlinked hook firing semantics + format
# var availability. Detect 3.5+ once here so individual scenarios can
# skip cleanly when running on older tmux.
TMUX_MAJOR_MINOR=$(echo "$TMUX_VERSION" | sed -E 's/^tmux ([0-9]+\.[0-9]+).*/\1/')
TMUX_IS_35_PLUS=0
case "$TMUX_MAJOR_MINOR" in
  3.5*|3.6*|3.7*|3.8*|3.9*|[4-9].*|[1-9][0-9]*.*)
    TMUX_IS_35_PLUS=1
    ;;
esac
echo "tmux 3.5+: $TMUX_IS_35_PLUS"

TMPDIR_ROOT=$(mktemp -d -t fly110.XXXXXX)
TMUX_SOCKET="$TMPDIR_ROOT/tmux-hooks-integration.sock"
export TMUX_SOCKET
EVENT_FILE_BASE="$TMPDIR_ROOT/events"
# Process-table reads are intentionally denied by the managed test sandbox.
# Production leaves this unset and leases use the kernel-reported start time.
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="hooks-integration-$$"
export FLYWHEEL_CMUX_TMUX_GENERATION="hooks-integration-generation"
VIEW_WAL_DIR="$TMPDIR_ROOT/view-wal"
VIEW_LEDGER="$TMPDIR_ROOT/view-ledger"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMPDIR_ROOT/watcher.lock"

cleanup() {
  # Best-effort cleanup. Never fail the script in cleanup.
  command tmux -S "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

# Verify the isolated tmux server can actually start AND respond.
# Sandbox / restricted environments (e.g. some CI sandboxes) reject socket
# creation with "Operation not permitted". On macOS we have observed cases
# where `tmux new-session` exits with status 0 yet still prints
# "Operation not permitted" to stderr — the socket file is created but
# subsequent commands fail. So we don't trust exit status alone:
#   1. Capture stderr unconditionally.
#   2. Skip if stderr mentions a permission error.
#   3. Skip if `has-session` or `list-sessions` cannot find the just-
#      created session, which would mean the server isn't actually
#      reachable on that socket.
maybe_skip() {
  local reason="$1"
  skip "$reason"
  echo
  echo "Skipped (isolated tmux unavailable): $SKIP"
  exit 0
}

command tmux -S "$TMUX_SOCKET" new-session -d -s _preflight -n init "sleep 5" 2>"$TMPDIR_ROOT/preflight.err"
preflight_exit=$?

if [[ $preflight_exit -ne 0 ]]; then
  if grep -qE "Operation not permitted|permission denied" "$TMPDIR_ROOT/preflight.err" 2>/dev/null; then
    maybe_skip "isolated tmux server cannot start (Operation not permitted) — restricted sandbox"
  fi
  maybe_skip "isolated tmux server failed to start: $(head -1 "$TMPDIR_ROOT/preflight.err" 2>/dev/null)"
fi

# Even on exit 0, the stderr may contain a permission error (observed on
# some macOS sandboxes — socket file creation rejected, command still
# returns 0). Treat that as a skip.
if grep -qE "Operation not permitted|permission denied" "$TMPDIR_ROOT/preflight.err" 2>/dev/null; then
  maybe_skip "isolated tmux server stderr reports permission error: $(head -1 "$TMPDIR_ROOT/preflight.err")"
fi

# Server may have started but be unreachable on this socket — verify by
# asking it about its own session.
if ! command tmux -S "$TMUX_SOCKET" has-session -t _preflight 2>/dev/null; then
  maybe_skip "isolated tmux server is not reachable on socket $TMUX_SOCKET"
fi

# Pre-flight passed — clean up the probe session and proceed.
command tmux -S "$TMUX_SOCKET" kill-server 2>/dev/null || true

# ── tmux shim — redirects all `tmux` calls in this shell + sourced
# ── functions to the isolated socket. Defined BEFORE sourcing
# ── flywheel-cmux-sync.sh so register_session_hooks calls our shim,
# ── not the real tmux binary against the default socket.
tmux() { command tmux -S "$TMUX_SOCKET" "$@"; }
export -f tmux

# Source script (guarded by BASH_SOURCE check, so the main case dispatcher
# does not run). EVENT_FILE will be set per-scenario.
# Note: flywheel-cmux-sync.sh runs `set -euo pipefail` at the top, which
# leaks into our shell on source. We drop -e immediately afterwards so a
# tmux kill-server on a non-existent server (returns non-zero, intentional)
# does not abort the test harness. The harness keeps -uo pipefail for
# unbound-var safety + pipe error propagation.
# shellcheck disable=SC1090
source "$SCRIPT_DIR/flywheel-cmux-sync.sh"
set +e
set -uo pipefail

# ── Helpers ───────────────────────────────────────────────────────────

# Wait up to N seconds for EVENT_FILE to contain a line matching pattern.
# Returns 0 on match, 1 on timeout.
wait_for_event() {
  local pattern="$1" budget_secs="${2:-10}"
  local end=$(($(date +%s) + budget_secs))
  while [[ $(date +%s) -lt $end ]]; do
    if [[ -f "$EVENT_FILE" ]] && grep -q "$pattern" "$EVENT_FILE" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

dump_events() {
  echo "    EVENT_FILE contents:"
  if [[ -f "$EVENT_FILE" ]]; then
    sed 's/^/      /' "$EVENT_FILE"
  else
    echo "      (file does not exist)"
  fi
}

reset_scenario() {
  local name="$1"
  EVENT_FILE="${EVENT_FILE_BASE}.${name}"
  rm -f "$EVENT_FILE"
  # Kill any leftover isolated server windows from a previous scenario.
  command tmux -S "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -f "$VIEW_LEDGER"
  rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
}

setup_session() {
  # Create runner-test-fly110 session (matches register_session_hooks
  # `^flywheel$|^runner-` filter so hooks get registered) and install
  # both the session-scoped hooks (after-new-window, pane-exited) and
  # the global hooks (session-created, pane-died) on it.
  #
  # Calling register_global_hooks is essential because pane-died only
  # fires when registered globally in tmux 3.5a (FLY-110 finding).
  local session="runner-test-fly110"
  tmux new-session -d -s "$session" -n init "sleep 60" 2>/dev/null
  register_global_hooks  >/dev/null
  register_session_hooks "$session" >/dev/null
  echo "$session"
}

# ── Scenario A: program exits + remain-on-exit ON (production main path) ──

echo
echo "── Scenario A: program exits + remain-on-exit ON (production main path) ──"
if [[ "$TMUX_IS_35_PLUS" != "1" ]]; then
  skip "Scenario A requires tmux 3.5+ pane-died semantics (current: $TMUX_VERSION); production runs 3.5a"
else
  reset_scenario "A"
  session=$(setup_session)
  window="A-target"

  # Turn on remain-on-exit BEFORE the short-lived command can exit.
  # Codex R3 non-blocking guidance: avoid scenario A flakiness on slow CI hosts.
  # Use sleep that is long enough for set-option to land first.
  tmux new-window -t "${session}:" -n "$window" "sleep 1" 2>/dev/null
  tmux set-option -t "${session}:${window}" remain-on-exit on 2>/dev/null

  # Wait up to 10s for the event to land. sleep 1 will exit shortly,
  # pane-died hook should fire, drain-time hook writes "exited|..." line.
  # (We're not running drain_events here — just verifying the raw hook output.)
  if wait_for_event "^exited|.*${window}\$" 10; then
    pass "Scenario A: pane-died fired and wrote 'exited|...|${window}'"
  else
    fail "Scenario A: no exited event within 10s — pane-died hook did not fire"
    dump_events
  fi
fi

# ── Scenario B: program exits + remain-on-exit OFF (legacy / off-mode) ──

echo
echo "── Scenario B: program exits + remain-on-exit OFF (legacy/off-mode path) ──"
if [[ "$TMUX_IS_35_PLUS" != "1" ]]; then
  skip "Scenario B requires tmux 3.5+ (current: $TMUX_VERSION); production runs 3.5a so behavior is verified there"
else
  reset_scenario "B"
  session=$(setup_session)
  window="B-target"

  tmux new-window -t "${session}:" -n "$window" "sleep 1" 2>/dev/null
  # Explicitly leave remain-on-exit at default (off).

  # B's assertion is intentionally relaxed to "any exited event was written"
  # (not "with this window_name"). When remain-on-exit is off, the window is
  # destroyed at the same time pane-exited fires, and tmux 3.5a's
  # #{window_name} expansion can resolve to the next active window. This is
  # acceptable because production sets remain-on-exit on, so this code path
  # is exercised only by legacy / future-refactor configurations.
  if wait_for_event "^exited|" 10; then
    pass "Scenario B: pane-exited fired (any exited event accepted; window_name flaky when window destroyed)"
  else
    fail "Scenario B: no exited event within 10s — pane-exited hook did not fire"
    dump_events
  fi
fi

# ── Scenario C: production cleanup path (A then kill-window on dead pane) ──
#
# Models the real Bridge close-tmux flow: Runner program exits naturally
# (pane-died fires once), then Bridge calls killTmuxWindow on the now-
# dead pane.
#
# This is a RAW HOOK OUTPUT test — it inspects EVENT_FILE only and does
# not invoke drain_events / mark_for_cleanup. We assert two things:
#   1. The natural-exit pane-died writes one "exited|..." line for the
#      target window (smoke-tests the same path as Scenario A but in the
#      cleanup-workflow context).
#   2. The subsequent kill-window on the now-dead pane writes NO
#      additional "exited|..." lines for the target window in tmux 3.5a
#      — i.e. the hook count for this window stays exactly 1 across the
#      kill-window. (mark_for_cleanup idempotency under repeated events
#      is covered separately by the mock unit test in test-cmux-sync.sh.)

echo
echo "── Scenario C: production cleanup path (natural exit then kill-window) ──"
if [[ "$TMUX_IS_35_PLUS" != "1" ]]; then
  skip "Scenario C requires tmux 3.5+ pane-died semantics (current: $TMUX_VERSION); production runs 3.5a"
  skip "Scenario C phase 2 — gated with phase 1"
else
  reset_scenario "C"
  session=$(setup_session)
  window="C-target"

  tmux new-window -t "${session}:" -n "$window" "sleep 1" 2>/dev/null
  tmux set-option -t "${session}:${window}" remain-on-exit on 2>/dev/null

  # Phase 1: wait for natural-exit pane-died.
  phase1_pass=0
  if wait_for_event "^exited|.*${window}\$" 10; then
    pass "Scenario C: natural exit pane-died fired with correct window_name"
    phase1_pass=1
  else
    fail "Scenario C: no natural-exit pane-died event within 10s"
    dump_events
  fi

  # Phase 2: simulate Bridge kill-window on the now-dead pane.
  # Skipping when phase 1 didn't observe the natural-exit event avoids
  # reporting a misleading "0 -> 0" pass when nothing happened to begin
  # with.
  if [[ "$phase1_pass" == "1" ]]; then
    event_count_before=$(grep -c "^exited|.*${window}\$" "$EVENT_FILE" 2>/dev/null || echo 0)
    tmux kill-window -t "${session}:${window}" 2>/dev/null
    sleep 1
    event_count_after=$(grep -c "^exited|.*${window}\$" "$EVENT_FILE" 2>/dev/null || echo 0)
    delta=$((event_count_after - event_count_before))
    if [[ "$delta" -eq 0 ]]; then
      pass "Scenario C: kill-window on dead pane emits no extra event (count: $event_count_before -> $event_count_after)"
    else
      fail "Scenario C: kill-window on dead pane emitted $delta extra event(s) for $window (expected 0)"
      dump_events
    fi
  else
    skip "Scenario C phase 2 (kill-window) — phase 1 did not produce a baseline event"
  fi
fi

# ── Scenario D: FLY-60 W4b — kill-window on a LIVE pane fires window-unlinked
# (the path Bridge takes via runPostShipFinalization → postMergeTmuxCleanup →
# killTmuxWindow). pane-died does NOT detect this; window-unlinked is the
# only signal we get for the post-merge force-kill case.
#
# Verifies:
#   1. window-unlinked global hook is registered.
#   2. `tmux kill-window` on a LIVE pane writes a keyed
#      `unlinked|sn=<src_session>|wn=<win_name>` row to EVENT_FILE.
#   3. The destroyed window's name is captured via `#{hook_window_name}`
#      (NOT `#{window_name}` which would resolve to the session's current
#      window, e.g. `zsh`). Per W4a empirical evidence at
#      doc/qa/reports/v1.25.0-FLY-60-evidence/w4a-tmux-hook-empirical-test.md.

if [[ "$TMUX_IS_35_PLUS" != "1" ]]; then
  skip "Scenario D requires tmux 3.5+ for window-unlinked + #{hook_window_name} (current: $TMUX_VERSION); production runs 3.5a"
else
  reset_scenario "D"
  session=$(setup_session)
  window="D-victim"

  # Create the victim window with a long-running command so kill-window
  # kills a LIVE pane (the post-W2-W3 production scenario).
  tmux new-window -t "${session}:" -n "$window" "sleep 60" 2>/dev/null
  sleep 0.5

  # Force-kill via tmux kill-window (simulates Bridge's killTmuxWindow).
  tmux kill-window -t "${session}:${window}" 2>/dev/null

  # Assert: a keyed `unlinked|sn=<session>|wn=<window>` row appears within 10s.
  if wait_for_event "^unlinked\\|sn=${session}\\|wn=${window}\$" 10; then
    pass "Scenario D: kill-window fires window-unlinked with correct hook_window_name"
  else
    fail "Scenario D: no window-unlinked event matching window=${window} within 10s"
    dump_events
  fi

  # Negative assertion: confirm `#{window_name}` was NOT used (which W4a
  # proved would resolve to the session's CURRENT window, e.g. zsh,
  # instead of the destroyed window name). If a future tmux change made
  # #{window_name} work for window-unlinked, we'd see `unlinked|sn=...|wn=zsh`
  # rows. The current implementation must use #{hook_window_name}.
  if grep -q "^unlinked|sn=${session}|wn=zsh\$" "$EVENT_FILE" 2>/dev/null; then
    fail "Scenario D: unexpected wn=zsh row — hook may be using #{window_name} instead of #{hook_window_name}"
    dump_events
  else
    pass "Scenario D: no wn=zsh false-positive (hook_window_name correctly used)"
  fi
fi

# ── FLY-129 Phase 1: concurrent watcher lock acquire (R2-4) ───────────
#
# Why an integration test (not a mock unit test):
#   bash 3.2 has no $BASHPID, so subshells `( ... ) &` inside a single
#   parent share `$$`. A mock-based concurrency assertion would compare
#   two identical PIDs and pass trivially. The real concurrency property —
#   "exactly one process wins the lock, the other observes alive owner
#   and exits 0" — requires two independent `/bin/bash -c` children with
#   distinct kernel PIDs.

echo
echo "── FLY-129 Phase 1: concurrent watcher lock acquire ──"

INT_LOCK_DIR="/tmp/fly129-int-lock.$$"
INT_LOCK_PIDFILE="${INT_LOCK_DIR}/pid"
SYNC_SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/flywheel-cmux-sync.sh"

# Stale lock with dead PID — both contenders should observe + try to reap.
rm -rf "$INT_LOCK_DIR" "${INT_LOCK_DIR}.reap"
mkdir -p "$INT_LOCK_DIR"
echo "999999" > "$INT_LOCK_PIDFILE"

LOG_A="/tmp/fly129-int-a.$$.log"
LOG_B="/tmp/fly129-int-b.$$.log"
rm -f "$LOG_A" "$LOG_B"

# Spawn inline — must NOT wrap in `$(spawn_child)` because that creates a
# subshell whose `$!` resolves to the subshell PID, not the bash -c child PID.
# We need the actual `/bin/bash -c` child PID to assert which contender won.
/bin/bash -c "
  export FLYWHEEL_CMUX_WATCHER_LOCK_DIR='$INT_LOCK_DIR'
  source '$SYNC_SCRIPT_PATH'
  _snapshot_live_mutator_processes() { return 0; }
  acquire_watcher_lock
  echo \"acquired by \$\$\" > '$LOG_A'
  sleep 60
" &
PID_A=$!

/bin/bash -c "
  export FLYWHEEL_CMUX_WATCHER_LOCK_DIR='$INT_LOCK_DIR'
  source '$SYNC_SCRIPT_PATH'
  _snapshot_live_mutator_processes() { return 0; }
  acquire_watcher_lock
  echo \"acquired by \$\$\" > '$LOG_B'
  sleep 60
" &
PID_B=$!

# Let both children race through acquire.
sleep 2

# Exactly one should still be alive (the lock winner). The other should
# have exited 0 after observing the alive owner via post-mutex re-verify.
ALIVE_A=0; ALIVE_B=0
kill -0 "$PID_A" 2>/dev/null && ALIVE_A=1
kill -0 "$PID_B" 2>/dev/null && ALIVE_B=1

if (( ALIVE_A + ALIVE_B == 1 )); then
  pass "integration_lock_concurrent_stale_reap: exactly one contender survives"
else
  fail "integration_lock_concurrent_stale_reap: expected 1 survivor, got ALIVE_A=$ALIVE_A ALIVE_B=$ALIVE_B"
fi

PID_IN_LOCK=$(cat "$INT_LOCK_PIDFILE" 2>/dev/null || echo "")
WINNER_PID=""
(( ALIVE_A == 1 )) && WINNER_PID="$PID_A"
(( ALIVE_B == 1 )) && WINNER_PID="$PID_B"

if [[ -n "$WINNER_PID" && "$PID_IN_LOCK" == "$WINNER_PID" ]]; then
  pass "lock pid file contains winner's child PID ($PID_IN_LOCK)"
elif [[ "$PID_IN_LOCK" == "$$" ]]; then
  fail "lock pid file is PARENT \$\$ — bash-3.2 subshell trap (assertion not allowed)"
else
  fail "lock pid file ('$PID_IN_LOCK') does not match winner PID ('$WINNER_PID')"
fi

# Note: we do NOT assert that `kill -TERM <winner>` triggers the EXIT trap
# within a short window. On bash 3.2 (macOS system bash), signals delivered
# while the shell is waiting on an external command (`sleep`) are queued
# until that command returns. The trap WILL fire eventually (when sleep
# returns), and in production the next watcher autostart's reap path
# handles any stale lock dir if the trap hasn't yet run. Asserting trap
# timing here would just measure the bash-3.2 signal-deferral quirk.
#
# Instead, separately verify that release_watcher_lock IS called on a
# normal exit (covered by the test_lock_acquire_stale_pid_clean unit
# test in scripts/test-cmux-sync.sh, where the subshell's normal exit
# fires the trap).

# Cleanup: kill both children and reset state.
kill -TERM "$PID_A" "$PID_B" 2>/dev/null || true
# Give signals a moment to land. Best-effort.
sleep 1
rm -rf "$INT_LOCK_DIR" "${INT_LOCK_DIR}.reap" "$LOG_A" "$LOG_B"

# ── Scenario F (FLY-1272): real isolated single-window linked view ─────
echo
echo "── Scenario F (FLY-1272): linked view cannot fall through to sibling husk ──"
reset_scenario "F1272"
FLYWHEEL_CMUX_LINKED_VIEW=1
source_session="runner-test-fly1272"
view_title="FLY-1272-implement"
tmux new-session -d -s "$source_session" -n "$view_title" "sleep 60" 2>/dev/null
tmux new-window -d -t "${source_session}:" -n "FLY-1225-qa" "sleep 60" 2>/dev/null
source_wid=$(tmux list-windows -t "=$source_session" -F '#{window_id}|#{window_name}' \
  | awk -F'|' -v n="$view_title" '$2 == n { print $1; exit }')
f1272_rc=0
create_or_replace_view_session "$source_session" "$source_wid" "$view_title" || f1272_rc=$?
view_session="cmux-${view_title}"
f1272_grouped=$(tmux display-message -p -t "=$view_session:" '#{session_grouped}' 2>/dev/null || true)
f1272_members=$(tmux list-windows -t "=$view_session" -F '#{window_id}' 2>/dev/null | tr '\n' ' ')
f1272_owner=$(tmux show-options -v -t "=$view_session:" @flywheel_cmux_owner 2>/dev/null || true)
tmux kill-session -t "=$source_session" 2>/dev/null || true
f1272_after=$(tmux list-windows -t "=$view_session" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
if [[ "$f1272_rc" -eq 0 && "$f1272_grouped" == "0" \
    && "$f1272_members" == "$source_wid " && "$f1272_owner" == "$source_session" \
    && "$f1272_after" == "$source_wid|$view_title" ]]; then
  pass "Scenario F: real tmux view holds only the intended @id after its multi-window source dies"
else
  fail "Scenario F: topology rc=$f1272_rc grouped=$f1272_grouped members=[$f1272_members] owner=[$f1272_owner] after=[$f1272_after]"
fi

# ── Scenario E (FLY-293): orphan-pin reaper against REAL tmux inventory ──
#
# Proves the safety-critical detection predicate on a real tmux server (the
# part mocks can get subtly wrong): a live runner (real window + real linked
# cmux- session) is KEPT; a fully-orphaned managed pin (NO window, NO linked
# session) is the only thing reaped; non-managed titles (Lead / user tab) are
# kept; and a real tmux-server-down makes orphan_pin_refs fail-closed (rc=2,
# no false orphans). cmux is mocked (no real cmux in CI); tmux is the real
# isolated server via the shim. Does NOT need tmux 3.5+ (basic list/kill only).
echo
echo "── Scenario E (FLY-293): orphan-pin reaper (real tmux inventory) ──"
reset_scenario "E293"
# Linked-view creation remains independently switchable, while cleanup now
# always requires an exact receipt.
FLYWHEEL_CMUX_LINKED_VIEW=0
# LIVE runner: real window + real grouped linked cmux- session → must be KEPT.
tmux new-session -d -s "runner-test-fly293" -n "FLY-100-claude-alive" "sleep 60" 2>/dev/null
tmux new-session -d -t "runner-test-fly293" -s "cmux-FLY-100-claude-alive" 2>/dev/null
# FLY-777-claude-orphan: intentionally NO window and NO cmux- session = orphan.

# Mock cmux (no real cmux binary in CI): controlled workspace JSON referencing
# the real tmux state, and capture close-workspace / refresh-surfaces.
FLY293_OPS=""
cmux() {
  [[ "${1:-}" == "--socket" ]] && shift 2
  [[ "${1:-}" == "--json" ]] && shift
  case "${1:-}" in
    list-workspaces)
      cat <<'FLY293JSON'
{"workspaces":[
  {"ref":"workspace:1","title":"FLY-100-claude-alive"},
  {"ref":"workspace:2","title":"FLY-777-claude-orphan"},
  {"ref":"workspace:3","title":"home"},
  {"ref":"workspace:4","title":"flywheel-flywheel-cos-lead"}
]}
FLY293JSON
      ;;
    close-workspace|refresh-surfaces) FLY293_OPS+="$*"$'\n' ;;
  esac
  return 0
}
export -f cmux

cmux_socket_identity() { printf '%s' 'hooks-integration-cmux-generation'; }
acquire_mutator_lease reaper
printf '%s\n' \
  'committed|hooks-integration-cmux-generation|workspace:1|FLY-100-claude-alive' \
  'committed|hooks-integration-cmux-generation|workspace:2|FLY-777-claude-orphan' \
  > "$VIEW_LEDGER"

d293_out=$(orphan_pin_refs)
if echo "$d293_out" | grep -q "^workspace:2	FLY-777-claude-orphan$" \
   && [[ "$(echo "$d293_out" | grep -c '^workspace:')" == "1" ]]; then
  pass "Scenario E: real-tmux orphan detection — only FLY-777 orphan (live runner + Lead + user tab kept)"
else
  fail "Scenario E: orphan_pin_refs wrong. out=[$d293_out]"
fi

FLY293_OPS=""
reap_orphan_pins_oneshot >/dev/null 2>&1
if echo "$FLY293_OPS" | grep -q "close-workspace --workspace workspace:2" \
   && ! echo "$FLY293_OPS" | grep -q "workspace:1"; then
  pass "Scenario E: one-shot reaped orphan (workspace:2), never touched live runner (workspace:1)"
else
  fail "Scenario E: reap wrong. ops=[$FLY293_OPS]"
fi

# Fail-closed against a REAL tmux failure: kill the isolated server → the real
# `tmux list-sessions` inside orphan_pin_refs fails → rc=2, no false orphans.
command tmux -S "$TMUX_SOCKET" kill-server 2>/dev/null || true
d293_fc_out=$(orphan_pin_refs 2>/dev/null); d293_fc_rc=$?
if [[ $d293_fc_rc -eq 2 && -z "$d293_fc_out" ]]; then
  pass "Scenario E: real tmux server down → orphan_pin_refs rc=2 (fail-closed, zero false orphans)"
else
  fail "Scenario E: expected rc=2 on tmux-down, got rc=$d293_fc_rc out=[$d293_fc_out]"
fi
unset -f cmux cmux_socket_identity 2>/dev/null || true

# ── Summary ───────────────────────────────────────────────────────────

echo
echo "════════════════════════════════════════"
echo "  Passed:  $PASS"
echo "  Failed:  $FAIL"
echo "  Skipped: $SKIP"
echo "════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
