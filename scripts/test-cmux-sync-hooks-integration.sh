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
# This script runs an *isolated* tmux server via a custom socket name
# (`tmux -L flywheel-cmux-test`) so it does not touch the developer's or
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

TMUX_SOCKET="flywheel-cmux-test-$$"
TMPDIR_ROOT=$(mktemp -d -t fly110.XXXXXX)
EVENT_FILE_BASE="$TMPDIR_ROOT/events"

cleanup() {
  # Best-effort cleanup. Never fail the script in cleanup.
  command tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
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

command tmux -L "$TMUX_SOCKET" new-session -d -s _preflight -n init "sleep 5" 2>"$TMPDIR_ROOT/preflight.err"
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
if ! command tmux -L "$TMUX_SOCKET" has-session -t _preflight 2>/dev/null; then
  maybe_skip "isolated tmux server is not reachable on socket $TMUX_SOCKET"
fi

# Pre-flight passed — clean up the probe session and proceed.
command tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true

# ── tmux shim — redirects all `tmux` calls in this shell + sourced
# ── functions to the isolated socket. Defined BEFORE sourcing
# ── flywheel-cmux-sync.sh so register_session_hooks calls our shim,
# ── not the real tmux binary against the default socket.
tmux() { command tmux -L "$TMUX_SOCKET" "$@"; }
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
  command tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
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

# ── Scenario B: program exits + remain-on-exit OFF (legacy / off-mode) ──

echo
echo "── Scenario B: program exits + remain-on-exit OFF (legacy/off-mode path) ──"
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
