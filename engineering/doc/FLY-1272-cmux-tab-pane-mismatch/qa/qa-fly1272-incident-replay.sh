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
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMPDIR_ROOT/lock"

# The view WAL is the production watcher's DURABLE AUTHORITY. Redirect it into
# our temp dir via the knob the script actually reads: VIEW_WAL_DIR
# (flywheel-cmux-sync.sh:64). An earlier draft exported FLYWHEEL_CMUX_STATE_DIR,
# which NOTHING reads — a variable that merely looks like isolation. That draft
# wrote WAL records into the live ~/.flywheel/state/cmux-view-wal, where a crash
# mid-run could leave a record the production watcher would act on.
export VIEW_WAL_DIR="$TMPDIR_ROOT/cmux-view-wal"
mkdir -p "$VIEW_WAL_DIR"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/flywheel-cmux-sync.sh"

# flywheel-cmux-sync.sh is a program, not a library: its `set -euo pipefail`
# lands in THIS shell on source. Several assertions below deliberately run tmux
# commands that MUST fail (that failure is the evidence), so -e would abort the
# harness mid-proof and report a false red. Drop -e; every rc is captured
# explicitly instead.
set +e

# PROVE the WAL redirect actually took effect, rather than trusting that an
# env var with an isolating-looking name isolates anything (it did not, once).
# Ask the production script itself where it would write, and refuse to run if
# that path is not inside our temp dir.
_probe_wal=$(_view_wal_path "cmux-fly1272-isolation-probe" 2>/dev/null)
case "$_probe_wal" in
  "$TMPDIR_ROOT"/*)
    echo "  · WAL isolation verified: production writes would land in $TMPDIR_ROOT"
    ;;
  *)
    echo "FATAL: view WAL would be written to [$_probe_wal] — OUTSIDE the QA temp dir." >&2
    echo "  Refusing to run: this harness must never write the production watcher's" >&2
    echo "  durable authority. Check the VIEW_WAL_DIR knob in flywheel-cmux-sync.sh." >&2
    exit 1
    ;;
esac

# The incident fixture, both times identical:
#   ONE runner tmux session holding TWO windows —
#     FLY-1259-implement : the real Codex runner (what the tab claims to be)
#     FLY-1225-qa        : the weekly-limit Claude husk (what Annie actually saw)
SRC="runner-51418c98"
CODEX_WIN="FLY-1259-implement"
HUSK_WIN="FLY-1225-qa"

# Build the fixture and PROVE it built. This box runs at load ~10; a fixed
# sleep after kill-server is not a synchronisation primitive. If new-session
# lands while the old server is still dying, the fixture silently does not
# exist and every downstream assertion fails for an environmental reason —
# a red for the wrong reason, which is as useless as a vacuous green. So:
# bounded retry on the observable postcondition (session present, exactly the
# two windows, both ids resolved), and a hard UNTESTABLE stop if it never
# materialises. Never let a flaky fixture masquerade as a verdict.
build_fixture() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    tmux kill-server 2>/dev/null || true
    # Wait for the server to actually be gone rather than assuming it is.
    local gone
    for gone in 1 2 3 4 5 6 7 8 9 10; do
      tmux list-sessions >/dev/null 2>&1 || break
      sleep 0.2
    done
    tmux new-session -d -s "$SRC" -n "$CODEX_WIN" "sleep 120" 2>/dev/null
    tmux new-window -d -t "${SRC}:" -n "$HUSK_WIN" "sleep 120" 2>/dev/null
    CODEX_WID=$(tmux list-windows -t "=$SRC" -F '#{window_id}|#{window_name}' 2>/dev/null \
      | awk -F'|' -v n="$CODEX_WIN" '$2 == n { print $1; exit }')
    HUSK_WID=$(tmux list-windows -t "=$SRC" -F '#{window_id}|#{window_name}' 2>/dev/null \
      | awk -F'|' -v n="$HUSK_WIN" '$2 == n { print $1; exit }')
    local count
    count=$(tmux list-windows -t "=$SRC" -F '#{window_id}' 2>/dev/null | grep -c . )
    if [[ -n "$CODEX_WID" && -n "$HUSK_WID" && "$CODEX_WID" != "$HUSK_WID" && "$count" == "2" ]]; then
      return 0
    fi
    sleep 0.5
  done
  echo "FATAL: fixture did not build after 10 attempts (codex=[${CODEX_WID:-}] husk=[${HUSK_WID:-}])." >&2
  echo "  Refusing to report any verdict from a fixture that does not exist." >&2
  exit 1
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
# Capture the kill rc: if the kill silently fails the window never died, the tab
# still shows the Codex session, and "did not render the husk" would score a PASS
# for a scenario that never happened (verified: kill_rc=1 → assertion PASS).
kill_rc=0
tmux kill-window -t "=${SRC}:${CODEX_WID}" 2>/dev/null || kill_rc=$?
sleep 0.3
after_rendered=$(rendered_window "$VIEW")
if [[ "$before_kill" != "$CODEX_WIN" ]]; then
  fail "SUBJECT husk-immunity UNTESTABLE: view was not rendering '$CODEX_WIN' before the kill (was [${before_kill:-<absent>}])"
elif [[ "$kill_rc" -ne 0 ]]; then
  fail "SUBJECT husk-immunity UNTESTABLE: kill-window failed (rc=$kill_rc) — the target window never died, so this scenario did not run"
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
echo "── §2.8 premise: remain-on-exit is a WINDOW option (the fact the fix rests on) ──"
#
# plan §2.8 justifies the TmuxAdapter change with a claim about tmux behaviour:
# the old pre-spawn `set-option -t "=<session>:"` lands on whatever window is
# current at spawn time, NOT on the runner window created afterwards. FLY-1285's
# lesson is that platform predicates must be verified on the real platform, so
# this asserts the claim against the real tmux rather than trusting the doc.
# (This lives here, in a committed artifact, so the report's claim is
# reproducible — an earlier draft verified it only in a throwaway probe.)
tmux kill-server 2>/dev/null || true
# Same discipline as build_fixture: wait for the observable state, not a guess.
for _gone in 1 2 3 4 5 6 7 8 9 10; do
  tmux list-sessions >/dev/null 2>&1 || break
  sleep 0.2
done
roe_ready=no
for _try in 1 2 3 4 5; do
  tmux new-session -d -s roe -n existing "sleep 60" 2>/dev/null
  tmux has-session -t "=roe" 2>/dev/null && { roe_ready=yes; break; }
  sleep 0.3
done
if [[ "$roe_ready" != "yes" ]]; then
  fail "§2.8 UNTESTABLE: could not create the probe session (environment, not the fix)"
else
# OLD FORM, in the original order: session-target set-option BEFORE new-window.
tmux set-option -t "=roe:" remain-on-exit on 2>/dev/null
new_wid=$(tmux new-window -d -t "=roe:" -P -F '#{window_id}' -n runner "sleep 60" 2>/dev/null)
old_on_existing=$(tmux show-options -w -v -t "=roe:existing" remain-on-exit 2>/dev/null)
old_runner_read_rc=0
old_on_runner=$(tmux show-options -w -v -t "=roe:$new_wid" remain-on-exit 2>/dev/null) || old_runner_read_rc=$?
#
# Anti-vacuity for this NEGATIVE assertion ("the runner window did NOT get it").
# Measured tmux 3.5a semantics (real server, this machine):
#   unset option              -> rc=0, empty output
#   option set to on          -> rc=0, "on"
#   BOGUS window in real sess -> rc=0, and SILENTLY returns another window's
#                                value (tmux falls back to the current window)
#   bogus session             -> rc=1
# So an rc check cannot separate "unset" from "read went wrong" — rc is 0 for
# both, and a mistargeted read returns a plausible WRONG value rather than
# failing. Two independent discriminators instead:
#   (a) the target window must actually exist (else we may be reading a
#       fallback window and calling it evidence);
#   (b) a positive control: the same reader must return "on" for the window the
#       old form DID hit — proving this ruler can see "on" at all, so an empty
#       reading is a real unset rather than a broken read.
#   (c) rc==0 on THIS read. Not sufficient (see above) but necessary: (a) and
#       (b) qualify the target and the ruler, yet neither proves this
#       particular call succeeded — a transient rc=1 with empty output would
#       otherwise still score a pass.
runner_exists=no
tmux list-windows -t "=roe" -F '#{window_id}' 2>/dev/null | grep -qx "$new_wid" && runner_exists=yes
if [[ "$runner_exists" != "yes" ]]; then
  fail "§2.8 premise UNTESTABLE: runner window [$new_wid] does not exist — any option read would silently fall back to another window"
elif [[ "$old_runner_read_rc" -ne 0 ]]; then
  fail "§2.8 premise UNTESTABLE: the runner-window option read itself failed (rc=$old_runner_read_rc) — an empty value proves nothing"
elif [[ "$old_on_existing" != "on" ]]; then
  fail "§2.8 premise UNTESTABLE: positive control failed — reader did not see 'on' on the window the old form targeted (got [$old_on_existing]); an empty runner reading would prove nothing"
elif [[ "$old_on_runner" != "on" ]]; then
  pass "§2.8 premise TRUE: old form set the pre-existing window (on, reader proven) and left the existing runner window [$new_wid] unset [${old_on_runner:-<unset>}]"
else
  fail "§2.8 premise NOT reproduced (existing=[$old_on_existing] runner=[$old_on_runner]) — the fix's rationale needs re-checking on this tmux"
fi

# NEW FORM: window-scoped to the exact @id, as TmuxAdapter now does post-create.
tmux set-option -w -t "=roe:$new_wid" remain-on-exit on 2>/dev/null
new_on_runner=$(tmux show-options -w -v -t "=roe:$new_wid" remain-on-exit 2>/dev/null)
if [[ "$new_on_runner" == "on" ]]; then
  pass "§2.8 fix form: window-scoped set-option puts remain-on-exit=on on the exact runner window ($new_wid)"
else
  fail "§2.8 fix form failed: runner window remain-on-exit=[$new_on_runner]"
fi

# Behavioural end: with the option on, a window whose process exits stays as a
# husk (pane_dead=1) instead of vanishing — the E3 semantics §2.8 restores.
#
# Ordering matters. An earlier draft spawned `sh -c 'exit 0'` and set the option
# afterwards — the process could die before the set-option landed, which is
# exactly the post-create race plan.md:104 names. That made the result
# scheduling-dependent: a flaky red, or a green that proved nothing. Instead the
# pane waits on a release file, so we can prove the option is on BEFORE the
# process is allowed to exit. This measures husk semantics, not the race.
release="$TMPDIR_ROOT/husk-release"
husk_wid=$(tmux new-window -d -t "=roe:" -P -F '#{window_id}' -n husktest \
  "sh -c 'while [ ! -f \"$release\" ]; do sleep 0.05; done; exit 0'" 2>/dev/null)
tmux set-option -w -t "=roe:$husk_wid" remain-on-exit on 2>/dev/null
husk_opt=$(tmux show-options -w -v -t "=roe:$husk_wid" remain-on-exit 2>/dev/null)
husk_alive_before=$(tmux display-message -p -t "=roe:$husk_wid" '#{pane_dead}' 2>/dev/null || echo "")
if [[ "$husk_opt" != "on" || "$husk_alive_before" != "0" ]]; then
  fail "§2.8 husk semantics UNTESTABLE: could not arm the pane before exit (option=[$husk_opt] pane_dead_before=[$husk_alive_before])"
else
  # Option proven on and pane proven still alive → now let it exit.
  : > "$release"
  husk_dead=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    husk_dead=$(tmux display-message -p -t "=roe:$husk_wid" '#{pane_dead}' 2>/dev/null || echo "<window destroyed>")
    [[ "$husk_dead" == "1" || "$husk_dead" == "<window destroyed>" ]] && break
    sleep 0.1
  done
  if [[ "$husk_dead" == "1" ]]; then
    pass "§2.8 husk semantics: pane armed with remain-on-exit=on BEFORE exit → window survives as a dead pane (pane_dead=1)"
  else
    fail "§2.8 husk semantics: expected pane_dead=1, got [$husk_dead]"
  fi
fi
fi

echo
echo "════════════════════════════════════════"
echo "  Passed: $PASS   Failed: $FAIL"
echo "════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] || exit 1
