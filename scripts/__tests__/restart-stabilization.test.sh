#!/usr/bin/env bash
# FLY-270 (R2#4): tests for the self-ship stabilization window in
# restart-services.sh::wait_for_idle. restart-services.sh is not sourceable
# (top-level git/lock/network), so — following the same convention as
# test-restart-services.sh — we copy the two units under test verbatim and assert
# the contract: self-ship-only; first-0 starts it; TWO consecutive 0s required;
# any non-zero resets; non-self-ship keeps the single-0 fast path.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/stab.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ── Copy of restart-services.sh::_self_ship_active (keep in sync) ────────────
_self_ship_active() {
    local d="${SELF_SHIP_PENDING_DIR:-${HOME}/.flywheel/self-ship-pending.d}"
    local f
    shopt -s nullglob
    for f in "$d"/*.json; do shopt -u nullglob; return 0; done
    shopt -u nullglob
    return 1
}

# ── Copy of the wait_for_idle streak core (count seq injected; -1 = health-fail).
# Echoes the 1-based sample index at which it returns 0, or "timeout". (keep in sync)
simulate_wait_for_idle() {
    local counts=("$@")
    local consecutive_failures=0 max_consecutive_failures=3 zero_streak=0 required_zeros=1
    _self_ship_active && required_zeros=2
    local i=0 count
    for count in "${counts[@]}"; do
        i=$((i + 1))
        if (( count < 0 )); then
            consecutive_failures=$((consecutive_failures + 1))
            (( consecutive_failures >= max_consecutive_failures )) && { echo "$i"; return 0; }
            zero_streak=0
        else
            consecutive_failures=0
            if (( count == 0 )); then
                zero_streak=$((zero_streak + 1))
                (( zero_streak >= required_zeros )) && { echo "$i"; return 0; }
            else
                zero_streak=0
            fi
        fi
    done
    echo "timeout"
}

# ── T1: _self_ship_active false on empty/missing dir ────────────────────────
export SELF_SHIP_PENDING_DIR="${TMP}/pending.d"; mkdir -p "$SELF_SHIP_PENDING_DIR"
if _self_ship_active; then fail "T1 active on empty dir"; else pass "T1 not active when no markers"; fi
echo '{}' > "${SELF_SHIP_PENDING_DIR}/m.json"
if _self_ship_active; then pass "T1b active when a marker is present"; else fail "T1b not active despite marker"; fi

# ── T2: non-self-ship → returns on the FIRST 0 (fast path) ──────────────────
rm -f "${SELF_SHIP_PENDING_DIR}"/*.json
r="$(simulate_wait_for_idle 2 1 0 0)"
if [[ "$r" == "3" ]]; then pass "T2 non-self-ship returns on first 0 (idx 3)"; else fail "T2 expected idx3, got $r"; fi

# ── T3: self-ship → needs TWO consecutive 0s ────────────────────────────────
echo '{}' > "${SELF_SHIP_PENDING_DIR}/m.json"
r="$(simulate_wait_for_idle 2 0 0)"   # counts: 2,0,0 → 0 at idx2 (streak1), 0 at idx3 (streak2) → return idx3
if [[ "$r" == "3" ]]; then pass "T3 self-ship requires two consecutive 0s (returns idx3)"; else fail "T3 expected idx3, got $r"; fi

# ── T4: self-ship → a non-zero between zeros RESETS the streak ──────────────
r="$(simulate_wait_for_idle 0 1 0 0)"  # counts: 0(streak1),1(reset),0(streak1),0(streak2)→idx4
if [[ "$r" == "4" ]]; then pass "T4 non-zero between 0s resets streak (returns idx4)"; else fail "T4 expected idx4, got $r"; fi

# ── T5: self-ship single 0 then timeout → does NOT return early ─────────────
r="$(simulate_wait_for_idle 0 1 1)"    # only one 0 then non-zero → never two consecutive → timeout
if [[ "$r" == "timeout" ]]; then pass "T5 self-ship single 0 never triggers (timeout)"; else fail "T5 expected timeout, got $r"; fi

# ── T6: 3 consecutive health failures → treat as down (returns) regardless ──
r="$(simulate_wait_for_idle -1 -1 -1)"
if [[ "$r" == "3" ]]; then pass "T6 3 consecutive health-fails → bridge-down short-circuit (idx3)"; else fail "T6 expected idx3, got $r"; fi

echo ""
echo "restart-stabilization: PASSED=$PASSED FAILED=$FAILED"
[[ "$FAILED" -eq 0 ]]
