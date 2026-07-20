#!/bin/bash
# FLY-1389 P0-b/P0-c: packages/teamlead/scripts/lib/resume-recovery.sh —
# the crash-classification pure function claude-lead.sh sources, plus the
# resume transcript diagnostic (log-only, never deletes).
#
# Incident (529 Room, 2026-07-20): a stale session-id made every
# `claude --resume` fail deterministically in 10-15s. The old heuristic only
# counted resume failures with DURATION < 10, so 10-15s failures fell into
# the else branch, RESET the counter, and the fresh-start fallback never
# fired — the Lead resumed the poisoned session 9 times, 0 successes.
#
# All scenarios drive FAKE durations through the pure function — zero real
# sleeps. Includes an automated mutation guard: a copy of the lib with the
# window reverted to the old `< 10` MUST flip the 12s-crash scenario
# (proves this suite is sensitive to the exact judgment that caused the
# incident, FLY-1285 discipline).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${TESTS_DIR}/../lib/resume-recovery.sh"
if [[ ! -f "$LIB" ]]; then
  echo "FATAL: ${LIB} missing — implement resume-recovery.sh first" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$LIB"
for fn in resume_recovery_decide resume_transcript_diagnose; do
  type "$fn" >/dev/null 2>&1 || { echo "FATAL: ${fn} not defined in ${LIB}" >&2; exit 1; }
done

SB="$(mktemp -d /tmp/fly1389-resume-XXXXXX)"
trap 'rm -rf "$SB"' EXIT

# Drive a sequence of (is_resume,duration) crash events through the decide
# function, carrying counters exactly like the supervisor loop does.
# Prints "action=<last-action> fail=<n> crash=<n>".
run_sequence() {
  local fail_count=0 crash_count=0 threshold=3 action="" out
  local ev
  for ev in "$@"; do
    local is_resume="${ev%%:*}" duration="${ev#*:}"
    crash_count=$((crash_count + 1))   # supervisor increments before deciding
    out="$(resume_recovery_decide "$is_resume" "$duration" "$fail_count" "$threshold" "$crash_count")"
    action="${out%% *}"
    local rest="${out#* }"
    fail_count="${rest%% *}"
    crash_count="${rest##* }"
  done
  echo "action=${action} fail=${fail_count} crash=${crash_count}"
}

# ── S1: THE incident — deterministic resume failures at 12s must reach the
# fresh-start fallback on the 3rd failure ──
R="$(run_sequence 1:12 1:12 1:12)"
if [[ "$R" == "action=delete_session fail=0 crash=3" ]]; then
  pass "S1: three 12s resume failures → delete_session (incident scenario now converges)"
else
  fail "S1: 12s resume failures must count toward fresh-start" "$R"
fi

# ── S2: classic quick-exit (<10s) still converges at the 3rd failure ──
R="$(run_sequence 1:5 1:5 1:5)"
if [[ "$R" == "action=delete_session fail=0 crash=3" ]]; then
  pass "S2: three 5s resume failures → delete_session (legacy quick-exit preserved)"
else
  fail "S2: quick-exit convergence" "$R"
fi

# ── S3: two short resume failures then a fresh-start crash → counter resets ──
R="$(run_sequence 1:12 1:12 0:12)"
if [[ "$R" == "action=reset_resume_fail fail=0 crash=3" ]]; then
  pass "S3: fresh-start crash resets the resume-failure counter"
else
  fail "S3: fresh-start reset" "$R"
fi

# ── S4: healthy long run (>60s) resets BOTH counters ──
R="$(run_sequence 1:12 1:12 1:120)"
if [[ "$R" == "action=reset_resume_fail fail=0 crash=1" ]]; then
  pass "S4: >60s run resets resume-failure count AND crash count"
else
  fail "S4: long-run reset" "$R"
fi

# ── S5: boundary — exactly 60s is NOT a resume failure (window is <60) and
# NOT a crash-count reset (reset is >60). Preceding crashes make the crash
# counter distinguishable from the reset value. ──
R="$(run_sequence 0:5 0:5 1:60)"
if [[ "$R" == "action=reset_resume_fail fail=0 crash=3" ]]; then
  pass "S5: exactly 60s → not a resume failure, crash count NOT reset"
else
  fail "S5: 60s boundary" "$R"
fi

# ── S6: 59s resume failure IS counted (window boundary inclusive below 60) ──
R="$(run_sequence 1:59)"
if [[ "$R" == "action=count_resume_fail fail=1 crash=1" ]]; then
  pass "S6: 59s resume failure counts (1/3)"
else
  fail "S6: 59s should count" "$R"
fi

# ── S7: crash count accumulates across short crashes (backoff escalation) ──
R="$(run_sequence 0:5 0:5 0:5 0:5)"
if [[ "$R" == *"crash=4"* ]]; then
  pass "S7: short crashes accumulate crash count (backoff escalates)"
else
  fail "S7: crash accumulation" "$R"
fi

# ── S8: MUTATION GUARD — revert the window to the old '< 10' and S1 must
# flip (proves the suite pins the exact judgment that caused the incident) ──
MUT="$SB/resume-recovery-mutated.sh"
sed 's/RESUME_FAIL_WINDOW_SECONDS=60/RESUME_FAIL_WINDOW_SECONDS=10/' "$LIB" > "$MUT"
MUT_R="$(
  # shellcheck source=/dev/null
  source "$MUT"
  run_sequence 1:12 1:12 1:12
)"
if [[ "$MUT_R" != "action=delete_session fail=0 crash=3" ]]; then
  pass "S8: mutation guard — old <10 window makes S1 diverge ($MUT_R)"
else
  fail "S8: mutation guard vacuous" "reverting the window did not change the verdict — suite is not sensitive"
fi

# ── D1: transcript diagnostic — present ──
FAKE_CFG="$SB/claude-config"
WS="$SB/lead-workspace"
mkdir -p "$WS"
WS_PHYS="$(cd "$WS" && pwd -P)"
SLUG="$(printf '%s' "$WS_PHYS" | tr '/.' '--')"
SID="a13ca2cd-0000-4000-8000-000000000000"
mkdir -p "$FAKE_CFG/projects/$SLUG"
touch "$FAKE_CFG/projects/$SLUG/$SID.jsonl"
OUT="$(resume_transcript_diagnose "$FAKE_CFG" "$WS" "$SID")"
if [[ "$OUT" == *"transcript present"* && "$OUT" == *"$SID.jsonl"* ]]; then
  pass "D1: present transcript → 'present' diagnostic with full path"
else
  fail "D1: present diagnostic" "$OUT"
fi

# ── D2: transcript diagnostic — absent; MUST NOT delete anything ──
SID2="b13ca2cd-0000-4000-8000-000000000000"
BEFORE="$(find "$SB" | sort)"
OUT="$(resume_transcript_diagnose "$FAKE_CFG" "$WS" "$SID2")"
AFTER="$(find "$SB" | sort)"
if [[ "$OUT" == *"MISSING"* && "$BEFORE" == "$AFTER" ]]; then
  pass "D2: absent transcript → 'MISSING' diagnostic, zero filesystem side effects"
else
  fail "D2: absent diagnostic must be log-only" "$OUT"
fi

# ── D3: non-UUID session id → skip note, no error, no side effects ──
OUT="$(resume_transcript_diagnose "$FAKE_CFG" "$WS" "not-a-uuid")"
RC=$?
if [[ "$RC" -eq 0 && "$OUT" == *"not a UUID"* ]]; then
  pass "D3: non-UUID session id → skip diagnostic (rc=0)"
else
  fail "D3: non-UUID handling" "rc=$RC out=$OUT"
fi

# ── D4: default config dir — empty first arg falls back to \$HOME/.claude ──
FH="$SB/fakehome"
mkdir -p "$FH/.claude/projects/$SLUG"
touch "$FH/.claude/projects/$SLUG/$SID.jsonl"
OUT="$(HOME="$FH" resume_transcript_diagnose "" "$WS" "$SID")"
if [[ "$OUT" == *"transcript present"* && "$OUT" == *"$FH/.claude/projects"* ]]; then
  pass "D4: empty config-dir arg falls back to \$HOME/.claude"
else
  fail "D4: default config dir" "$OUT"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
