#!/bin/bash
# FLY-1272 QA — incident replay on a REAL tmux server, with a positive control.
#
# Why this file exists (independent QA, not a re-run of the implementer's suite):
#   scripts/test-cmux-sync-hooks-integration.sh Scenario F already asserts the
#   NEW linked view holds only the intended @id. What it never does is show that
#   the same measurement CATCHES THE REPORTED BUG. A clean reading from a ruler
#   that was never shown to hit a known positive is not evidence — it can equally
#   mean the harness never reproduced the incident at all.
#
#   So this script measures BOTH topologies with ONE ruler:
#     the ruler = what the cmux tab actually renders for view session V, i.e.
#     `display-message -p -t "=V:" '#{window_name}'` (the view's active window)
#
#   CONTROL (A=0, legacy grouped view — `new-session -t <source>`):
#     the view named cmux-FLY-1259-implement MUST be observed rendering the
#     sibling FLY-1225 husk window. That is Annie's 2026-07-14 incident, and it
#     proves the ruler can see the defect.
#   SUBJECT (A=1, linked view — the real create_or_replace_view_session):
#     the same ruler on the same fixture must be structurally unable to render
#     the sibling: the husk window is not a member of the view at all.
#
# Isolation: a private tmux socket (`tmux -L`), never the production server.
#   Memory/FLY-1282 note: we never kill the last window of a shared server —
#   this server is ours alone and is killed wholesale on exit.
#
# Runs: /bin/bash engineering/doc/.../qa/qa-fly1272-incident-replay.sh
set -uo pipefail

case "${BASH_VERSION:-}" in
  3.2*) ;;
  *)
    # flywheel-cmux-sync.sh is a bash-3.2 (macOS /bin/bash) program. Sourcing it
    # under bash 4+ would mask 3.2 incompatibilities — fail closed, never pass.
    echo "qa-fly1272-incident-replay.sh requires /bin/bash 3.2 (macOS system bash)" >&2
    echo "  detected: BASH_VERSION=${BASH_VERSION:-<unset>}" >&2
    echo "  run as: /bin/bash $0" >&2
    exit 1
    ;;
esac

PASS=0
FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/../../../../scripts" && pwd)"
TMUX_SOCKET="fly1272-qa-$$"
TMPDIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1272qa.XXXXXX")"

cleanup() {
  command tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux not installed"; exit 0
fi

# Preflight: prove the isolated server is actually reachable before asserting
# anything on it (a dead server would make every 'clean' reading vacuous).
command tmux -L "$TMUX_SOCKET" new-session -d -s _preflight -n init "sleep 30" 2>/dev/null
if ! command tmux -L "$TMUX_SOCKET" has-session -t _preflight 2>/dev/null; then
  echo "SKIP: isolated tmux server unreachable on socket $TMUX_SOCKET"; exit 0
fi
command tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true

# Redirect every tmux call — including those inside the sourced production
# functions — onto the isolated socket.
tmux() { command tmux -L "$TMUX_SOCKET" "$@"; }

export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1272-qa-$$"
export FLYWHEEL_CMUX_TMUX_GENERATION="fly1272-qa-generation"
export FLYWHEEL_CMUX_STATE_DIR="$TMPDIR_ROOT/state"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMPDIR_ROOT/lock"
mkdir -p "$FLYWHEEL_CMUX_STATE_DIR"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/flywheel-cmux-sync.sh"

# flywheel-cmux-sync.sh is a program, not a library: its `set -euo pipefail`
# lands in THIS shell on source. Several assertions below deliberately run tmux
# commands that MUST fail (that failure is the evidence), so -e would abort the
# harness mid-proof and report a false red. Drop -e; every rc is captured
# explicitly instead.
set +e

# The incident fixture, both times identical:
#   ONE runner tmux session holding TWO windows —
#     FLY-1259-implement : the real Codex runner (what the tab claims to be)
#     FLY-1225-qa        : the weekly-limit Claude husk (what Annie actually saw)
SRC="runner-51418c98"
CODEX_WIN="FLY-1259-implement"
HUSK_WIN="FLY-1225-qa"

build_fixture() {
  tmux kill-server 2>/dev/null || true
  sleep 0.2
  tmux new-session -d -s "$SRC" -n "$CODEX_WIN" "sleep 120" 2>/dev/null
  tmux new-window -d -t "${SRC}:" -n "$HUSK_WIN" "sleep 120" 2>/dev/null
  CODEX_WID=$(tmux list-windows -t "=$SRC" -F '#{window_id}|#{window_name}' \
    | awk -F'|' -v n="$CODEX_WIN" '$2 == n { print $1; exit }')
  HUSK_WID=$(tmux list-windows -t "=$SRC" -F '#{window_id}|#{window_name}' \
    | awk -F'|' -v n="$HUSK_WIN" '$2 == n { print $1; exit }')
}

# THE RULER — what the tab renders = the view session's active window name.
rendered_window() {
  tmux display-message -p -t "=$1:" '#{window_name}' 2>/dev/null || true
}

echo "══ FLY-1272 incident replay (real tmux, isolated socket $TMUX_SOCKET) ══"
echo
echo "── CONTROL (A=0 legacy grouped view): the ruler must SEE the incident ──"

build_fixture
VIEW="cmux-${CODEX_WIN}"
# The legacy create path, verbatim from flywheel-cmux-sync.sh (lines 2871/3142):
# a grouped session shares EVERY window of the source.
tmux new-session -d -t "$SRC" -s "$VIEW" 2>/dev/null
ctrl_grouped=$(tmux display-message -p -t "=$VIEW:" '#{session_grouped}' 2>/dev/null || true)
ctrl_members=$(tmux list-windows -t "=$VIEW" -F '#{window_name}' 2>/dev/null | sort | tr '\n' ',')

# Drift the grouped view's pointer onto the sibling husk — exactly what a
# session-group does when any client selects another window in the group.
tmux select-window -t "=${VIEW}:${HUSK_WID}" 2>/dev/null
ctrl_rendered=$(rendered_window "$VIEW")

if [[ "$ctrl_grouped" == "1" && "$ctrl_rendered" == "$HUSK_WIN" ]]; then
  pass "CONTROL reproduced Annie's incident: tab '$VIEW' renders '$ctrl_rendered' (the FLY-1225 husk)"
  echo "      → the ruler CAN see the defect; a clean subject reading is now meaningful"
else
  fail "CONTROL did NOT reproduce the incident (grouped=$ctrl_grouped rendered=[$ctrl_rendered])"
  echo "      → ruler unproven: STOP. A clean subject reading would prove nothing."
fi

if [[ "$ctrl_members" == "${HUSK_WIN},${CODEX_WIN}," ]]; then
  pass "CONTROL root cause: grouped view holds BOTH windows [${ctrl_members%,}] — the husk is reachable"
else
  fail "CONTROL membership unexpected: [$ctrl_members]"
fi

echo
echo "── SUBJECT (A=1 linked view, real create_or_replace_view_session) ──"

build_fixture
export FLYWHEEL_CMUX_LINKED_VIEW=1
export FLYWHEEL_CMUX_VIEW_INVARIANT=1
rc=0
create_or_replace_view_session "$SRC" "$CODEX_WID" "$CODEX_WIN" || rc=$?
VIEW="cmux-${CODEX_WIN}"
sub_grouped=$(tmux display-message -p -t "=$VIEW:" '#{session_grouped}' 2>/dev/null || true)
sub_members=$(tmux list-windows -t "=$VIEW" -F '#{window_id}' 2>/dev/null | tr '\n' ' ')
sub_rendered=$(rendered_window "$VIEW")

if [[ "$rc" -eq 0 && "$sub_grouped" == "0" && "$sub_members" == "$CODEX_WID " ]]; then
  pass "SUBJECT topology: view holds EXACTLY the Codex window ($CODEX_WID), grouped=0"
else
  fail "SUBJECT topology wrong (rc=$rc grouped=$sub_grouped members=[$sub_members])"
fi

if [[ "$sub_rendered" == "$CODEX_WIN" ]]; then
  pass "SUBJECT ruler: tab '$VIEW' renders '$sub_rendered' — the session it is named for"
else
  fail "SUBJECT ruler: tab renders [$sub_rendered], expected $CODEX_WIN"
fi

# The decisive assertion: apply the SAME drift that broke the control. The husk
# is not a member of this view, so tmux itself must reject the retarget — the
# tab cannot be pointed at another issue's window even on request.
drift_rc=0
tmux select-window -t "=${VIEW}:${HUSK_WID}" 2>/dev/null || drift_rc=$?
drift_rendered=$(rendered_window "$VIEW")
if [[ "$drift_rc" -ne 0 && "$drift_rendered" == "$CODEX_WIN" ]]; then
  pass "SUBJECT drift-immune: the exact select-window that broke CONTROL is REJECTED by tmux (rc=$drift_rc); tab stays on '$drift_rendered'"
else
  fail "SUBJECT drift not rejected (rc=$drift_rc rendered=[$drift_rendered]) — the incident is NOT structurally fixed"
fi

# Husk semantics (§2.8): the Codex window dies → the tab may show its OWN dead
# pane or close, but must never fall through to the sibling.
#
# NOTE (anti-vacuity): "does not render the husk" is trivially true when the view
# never existed. Without the precondition below, this assertion passes even when
# the linked builder refused outright — proven by running this harness with
# FLYWHEEL_CMUX_LINKED_VIEW=0, where it was the one subject check that stayed
# green for no reason. Gate it on the view having actually rendered its own
# window first, so a build failure can never be scored as husk-immunity.
before_kill=$(rendered_window "$VIEW")
tmux kill-window -t "=${SRC}:${CODEX_WID}" 2>/dev/null
sleep 0.3
after_rendered=$(rendered_window "$VIEW")
if [[ "$before_kill" != "$CODEX_WIN" ]]; then
  fail "SUBJECT husk-immunity UNTESTABLE: view was not rendering '$CODEX_WIN' before the kill (was [${before_kill:-<absent>}])"
elif [[ "$after_rendered" != "$HUSK_WIN" ]]; then
  pass "SUBJECT after its window dies: tab shows [${after_rendered:-<view gone>}], never the sibling husk"
else
  fail "SUBJECT fell through to the husk after its own window died: [$after_rendered]"
fi

echo
echo "── SUBJECT: sole-holder safety (plan §2.1 — display teardown must not kill a live runner) ──"

build_fixture
rc=0
create_or_replace_view_session "$SRC" "$CODEX_WID" "$CODEX_WIN" || rc=$?
VIEW="cmux-${CODEX_WIN}"
# Kill the SOURCE session. The linked view is now the sole holder of the live
# runner window; tmux must refuse to unlink it rather than destroy the window.
tmux kill-session -t "=$SRC" 2>/dev/null
sleep 0.3
unlink_rc=0
tmux unlink-window -t "=${VIEW}:${CODEX_WID}" 2>/dev/null || unlink_rc=$?
survivor=$(tmux list-windows -t "=$VIEW" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
pane_cmd=$(tmux display-message -p -t "=${VIEW}:${CODEX_WID}" '#{pane_current_command}' 2>/dev/null || true)
if [[ "$unlink_rc" -ne 0 && "$survivor" == "$CODEX_WID|$CODEX_WIN" && -n "$pane_cmd" ]]; then
  pass "sole-holder: tmux REFUSED the unlink; runner window + live pane ($pane_cmd) survived"
else
  fail "sole-holder broken (unlink_rc=$unlink_rc survivor=[$survivor] pane=[$pane_cmd])"
fi

echo
echo "════════════════════════════════════════"
echo "  Passed: $PASS   Failed: $FAIL"
echo "════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] || exit 1
