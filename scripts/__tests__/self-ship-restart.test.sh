#!/usr/bin/env bash
# FLY-270: tests for the self-ship handoff script (scripts/self-ship-restart.sh).
# launchctl is stubbed via SELF_SHIP_LAUNCHCTL so nothing touches the real domain.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ssr.XXXXXX")"
export SELF_SHIP_PENDING_DIR="${TMP}/pending.d"
export SELF_SHIP_BLOCKED_DIR="${TMP}/blocked.d"
export SELF_SHIP_TMP_DIR="${TMP}/tmp"
export SELF_SHIP_LOCK_DIR="${TMP}/lock.d"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# Stub launchctl: records calls; "loaded" governed by env LC_LOADED.
LC_LOG="${TMP}/launchctl.log"
cat > "${TMP}/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$LC_LOG"
case "$1" in
  print)     [[ "${LC_LOADED:-1}" == "1" ]] && exit 0 || exit 1 ;;
  kickstart)
    # Fail the test if -k is ever passed (must NEVER terminate a running updater).
    for a in "$@"; do [[ "$a" == "-k" ]] && { echo "FORBIDDEN -k" >> "$LC_LOG"; exit 99; }; done
    [[ "${LC_KICKSTART_FAIL:-0}" == "1" ]] && exit 1   # simulate disabled/non-startable job
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "${TMP}/launchctl"
export SELF_SHIP_LAUNCHCTL="${TMP}/launchctl"
export LC_LOG

run() { bash "${SCRIPT_DIR}/self-ship-restart.sh" "$@"; }

# ── T1: non-40hex target → fail-close (rc 64), no marker ────────────────────
: > "$LC_LOG"
if run --target-sha "deadbeef" >/dev/null 2>&1; then fail "T1 accepted bad sha"; else
  [[ "$(find "$SELF_SHIP_PENDING_DIR" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')" == "0" ]] \
    && pass "T1 bad sha fail-close, no marker created" || fail "T1 marker created for bad sha"
fi

# ── T2: missing --target-sha → fail-close ───────────────────────────────────
if run --pr 270 >/dev/null 2>&1; then fail "T2 ran without target-sha"; else pass "T2 missing target-sha fail-close"; fi

# ── T3: updater NOT loaded → fail-loud (rc 69), no enqueue ──────────────────
: > "$LC_LOG"
LC_LOADED=0 run --target-sha "$SHA" --pr 270 >/dev/null 2>&1; rc=$?
if [[ "$rc" == "69" ]]; then pass "T3 updater-not-loaded → fail-loud rc69"; else fail "T3 expected rc69, got $rc"; fi
if [[ "$(find "$SELF_SHIP_PENDING_DIR" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')" == "0" ]]; then pass "T3b no marker enqueued when updater not loaded"; else fail "T3b marker enqueued despite updater not loaded"; fi

# ── T4: dry-run → no marker, no kickstart, rc0 ──────────────────────────────
: > "$LC_LOG"
run --target-sha "$SHA" --pr 270 --dry-run >/dev/null 2>&1; rc=$?
if [[ "$rc" == "0" ]]; then pass "T4 dry-run rc0"; else fail "T4 dry-run rc=$rc"; fi
if ! grep -q "kickstart" "$LC_LOG"; then pass "T4b dry-run did not kickstart"; else fail "T4b dry-run kickstarted"; fi
if [[ "$(find "$SELF_SHIP_PENDING_DIR" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')" == "0" ]]; then pass "T4c dry-run created no marker"; else fail "T4c dry-run created a marker"; fi

# ── T5: happy path → exactly one marker, kickstart WITHOUT -k, rc0 ──────────
: > "$LC_LOG"
run --target-sha "$SHA" --pr 270 >/dev/null 2>&1; rc=$?
if [[ "$rc" == "0" ]]; then pass "T5 handoff rc0"; else fail "T5 handoff rc=$rc"; fi
n="$(find "$SELF_SHIP_PENDING_DIR" -name '*.json' | wc -l | tr -d ' ')"
if [[ "$n" == "1" ]]; then pass "T5b exactly one durable marker enqueued"; else fail "T5b expected 1 marker, got $n"; fi
mfile="$(find "$SELF_SHIP_PENDING_DIR" -name '*.json' | head -1)"
if [[ "$(jq -r .targetSha "$mfile")" == "$SHA" ]]; then pass "T5c marker carries canonical target sha"; else fail "T5c wrong target sha in marker"; fi
if grep -q "kickstart" "$LC_LOG" && ! grep -q "FORBIDDEN -k" "$LC_LOG"; then pass "T5d kickstart issued WITHOUT -k (never kills a running updater)"; else fail "T5d kickstart missing or used -k"; fi

# ── T6: kickstart fails (job loaded but disabled) → handoff FAIL-CLOSE (non-zero)
#        so the Runner does NOT emit a successful session_completed (R1 HIGH-2) ──
: > "$LC_LOG"
rm -rf "$SELF_SHIP_PENDING_DIR"; ssq_init_dirs 2>/dev/null || mkdir -p "$SELF_SHIP_PENDING_DIR"
LC_KICKSTART_FAIL=1 run --target-sha "$SHA" --pr 270 >/dev/null 2>&1; rc=$?
if [[ "$rc" != "0" ]]; then pass "T6 kickstart failure → handoff non-zero (fail-close, no success)"; else fail "T6 handoff returned 0 despite kickstart failure"; fi

echo ""
echo "self-ship-restart: PASSED=$PASSED FAILED=$FAILED"
[[ "$FAILED" -eq 0 ]]
