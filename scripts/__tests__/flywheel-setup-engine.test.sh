#!/bin/bash
# FLY-648 WI-A: flywheel-setup.sh step-engine + setup-state journal.
#
# Hermetic: fixture state dirs under mktemp; the engine is exercised by SOURCING
# flywheel-setup.sh (FLYWHEEL_SETUP_SOURCED=1 — provision-fleet-host.sh idiom)
# and driving setup_main_loop with test-defined steps. No network, no real
# ~/.flywheel.
#
# Covers (plan §3.1 + R1#6 journal safety envelope):
#   E1  fresh run executes steps in order, marks done with evidence
#   E2  resume: re-run skips done steps (verify+skip), continues from first pending
#   E3  fail-closed: a failing step stops the run (non-zero), later steps untouched
#   E4  journal atomicity + 0600 + zero secrets
#   E5  concurrent second instance fails loud (lock)
#   E6  symlinked state file rejected
#   E7  done only after evidence: done step whose live evidence vanished re-runs
#   E8  group/world-writable state dir rejected
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"
[ -f "$SETUP" ] || { echo "ERROR: $SETUP missing"; exit 1; }

SANDBOX="$(mktemp -d -t fly648-engine-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# run_engine <state-dir> <steps...> — subshell: source the engine, define fake
# steps whose behavior is table-driven via files in the sandbox, run the loop.
# A step 'x' runs step_run_x; done-verification runs step_verify_x when defined.
run_engine() {
  local sdir="$1"; shift
  local steps=("$@")
  (
    export FLYWHEEL_SETUP_SOURCED=1
    export HOME="$SANDBOX/home"
    # shellcheck source=../flywheel-setup.sh
    source "$SETUP" || exit 97
    FLYWHEEL_SETUP_STATE_DIR="$sdir"
    STEP_IDS=("${steps[@]}")
    # table-driven fake steps: marker files record execution order.
    step_run_alpha()  { echo alpha >> "$SANDBOX/order.log"; setup_mark_done alpha '{"proof":"a"}'; }
    step_run_beta()   { echo beta >> "$SANDBOX/order.log"; setup_mark_done beta '{"proof":"b"}'; }
    step_run_gamma()  { echo gamma >> "$SANDBOX/order.log"; setup_mark_done gamma '{"proof":"c"}'; }
    step_run_boom()   { echo boom >> "$SANDBOX/order.log"; echo "boom exploded" >&2; return 1; }
    # beta's done-ness is backed by a live artifact: verify fails if it vanished.
    step_verify_beta() { [ -f "$SANDBOX/beta-artifact" ]; }
    setup_main_loop
  )
}

H="$SANDBOX/home"; mkdir -p "$H"

# ── E1: fresh run executes in order + journal has done + evidence ──
S1="$SANDBOX/state1"; mkdir -p "$S1"
: > "$SANDBOX/order.log"; touch "$SANDBOX/beta-artifact"
run_engine "$S1" alpha beta gamma >/dev/null 2>&1
E1_RC=$?
ORDER="$(tr '\n' ' ' < "$SANDBOX/order.log")"
ST="$S1/setup-state.json"
if [ "$E1_RC" -eq 0 ] && [ "$ORDER" = "alpha beta gamma " ] \
   && [ "$(jq -r '.steps.alpha.status' "$ST" 2>/dev/null)" = "done" ] \
   && [ "$(jq -r '.steps.beta.evidence.proof' "$ST" 2>/dev/null)" = "b" ]; then
  pass "E1 fresh run: ordered execution + journal done + evidence"
else
  fail "E1 rc=$E1_RC order='$ORDER' state=$(cat "$ST" 2>/dev/null)"
fi

# ── E2: resume skips done steps ──
: > "$SANDBOX/order.log"
run_engine "$S1" alpha beta gamma >/dev/null 2>&1
E2_RC=$?
ORDER="$(tr '\n' ' ' < "$SANDBOX/order.log")"
if [ "$E2_RC" -eq 0 ] && [ -z "$(tr -d ' \n' < "$SANDBOX/order.log")" ]; then
  pass "E2 resume: all-done run re-executes nothing (verify+skip)"
else
  fail "E2 rc=$E2_RC re-ran: '$ORDER'"
fi

# ── E3: fail-closed — failing step stops run, later steps untouched ──
S3="$SANDBOX/state3"; mkdir -p "$S3"
: > "$SANDBOX/order.log"
run_engine "$S3" alpha boom gamma >/dev/null 2>&1
E3_RC=$?
ORDER="$(tr '\n' ' ' < "$SANDBOX/order.log")"
ST3="$S3/setup-state.json"
if [ "$E3_RC" -ne 0 ] && [ "$ORDER" = "alpha boom " ] \
   && [ "$(jq -r '.steps.alpha.status' "$ST3" 2>/dev/null)" = "done" ] \
   && [ "$(jq -r '.steps.boom.status // "pending"' "$ST3" 2>/dev/null)" != "done" ]; then
  pass "E3 fail-closed: stops at failing step, gamma never ran, journal keeps alpha"
else
  fail "E3 rc=$E3_RC order='$ORDER' state=$(cat "$ST3" 2>/dev/null)"
fi

# ── E3b: resume after failure continues FROM the failed step ──
: > "$SANDBOX/order.log"
run_engine "$S3" alpha beta gamma >/dev/null 2>&1  # boom replaced by fixed beta
E3B_RC=$?
ORDER="$(tr '\n' ' ' < "$SANDBOX/order.log")"
if [ "$E3B_RC" -eq 0 ] && [ "$ORDER" = "beta gamma " ]; then
  pass "E3b resume-after-failure: continues from first pending (alpha skipped)"
else
  fail "E3b rc=$E3B_RC order='$ORDER'"
fi

# ── E4: journal file is 0600 + contains no secret-looking values ──
PERMS="$(stat -c '%a' "$ST" 2>/dev/null || stat -f '%Lp' "$ST" 2>/dev/null)"
if [ "$PERMS" = "600" ] \
   && bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$ST'" >/dev/null 2>&1; then
  pass "E4 journal 0600 + passes secret scan"
else
  fail "E4 perms=$PERMS"
fi

# ── E5: second concurrent instance fails loud (lock) ──
S5="$SANDBOX/state5"; mkdir -p "$S5"
mkdir -p "$S5/setup.lock.d"   # simulate a live instance holding the lock
OUT5="$(run_engine "$S5" alpha 2>&1)"
E5_RC=$?
if [ "$E5_RC" -ne 0 ] && grep -qi "another\|lock" <<<"$OUT5"; then
  pass "E5 concurrent second instance fails loud on lock"
else
  fail "E5 rc=$E5_RC out: $(head -3 <<<"$OUT5")"
fi

# ── E6: symlinked state file rejected ──
S6="$SANDBOX/state6"; mkdir -p "$S6"
touch "$SANDBOX/evil-target"
ln -s "$SANDBOX/evil-target" "$S6/setup-state.json"
OUT6="$(run_engine "$S6" alpha 2>&1)"
E6_RC=$?
if [ "$E6_RC" -ne 0 ] && grep -qi "symlink" <<<"$OUT6"; then
  pass "E6 symlinked setup-state.json rejected"
else
  fail "E6 rc=$E6_RC out: $(head -3 <<<"$OUT6")"
fi

# ── E7: done step whose live evidence vanished re-runs (not trusted) ──
rm -f "$SANDBOX/beta-artifact"     # beta was done in S1, artifact now gone
: > "$SANDBOX/order.log"
touch_gamma_before="$(jq -r '.steps.gamma.status' "$ST")"
run_engine "$S1" alpha beta gamma >/dev/null 2>&1
E7_RC=$?
ORDER="$(tr '\n' ' ' < "$SANDBOX/order.log")"
if [ "$E7_RC" -eq 0 ] && [ "$ORDER" = "beta " ] && [ "$touch_gamma_before" = "done" ]; then
  pass "E7 done-with-vanished-evidence re-runs that step only"
else
  fail "E7 rc=$E7_RC order='$ORDER'"
fi

# ── E8: group/world-writable state dir rejected ──
S8="$SANDBOX/state8"; mkdir -p "$S8"; chmod 777 "$S8"
OUT8="$(run_engine "$S8" alpha 2>&1)"
E8_RC=$?
chmod 755 "$S8"
if [ "$E8_RC" -ne 0 ] && grep -qi "writable" <<<"$OUT8"; then
  pass "E8 group/world-writable state dir rejected"
else
  fail "E8 rc=$E8_RC out: $(head -3 <<<"$OUT8")"
fi

echo ""
echo "flywheel-setup-engine.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
