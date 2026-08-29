#!/usr/bin/env bash
# FLY-516: hermetic tests for the restart-services.sh stop_bridge port-release
# contract (bp_confirm_port_released). restart-services.sh itself is not
# sourceable (top-level git/lock/network — see restart-stabilization.test.sh), so
# we test the shared lib function it calls, with lsof/kill/sleep + the fail-loud
# seam injected. Asserts: frees on poll → released, no alert; reclaim frees →
# released, no alert; stays bound → stuck + bridge_port_stuck alert.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../lib/bridge-port.sh
source "${SCRIPT_DIR}/../lib/bridge-port.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/stopbr.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
IDXFILE="$TMP/idx"; KILLFILE="$TMP/kill"; SLEEPFILE="$TMP/sleep"; ALERTFILE="$TMP/alert"
SEQ=(); FREE_AFTER=""
reset_seam() { SEQ=(); FREE_AFTER=""; echo 0 > "$IDXFILE"; : > "$KILLFILE"; echo 0 > "$SLEEPFILE"; : > "$ALERTFILE"; }
alerts() { cat "$ALERTFILE" 2>/dev/null; }

_bp_listeners() {
  if [[ -n "$FREE_AFTER" ]]; then
    if [[ "$FREE_AFTER" != "never" ]] && grep -q -- "$FREE_AFTER" "$KILLFILE" 2>/dev/null; then printf '\n'; else printf '18909\n'; fi
    return 0
  fi
  local n=${#SEQ[@]}; (( n == 0 )) && { printf '\n'; return 0; }
  local i; i="$(cat "$IDXFILE" 2>/dev/null || echo 0)"; (( i >= n )) && i=$(( n - 1 ))
  echo $(( $(cat "$IDXFILE" 2>/dev/null || echo 0) + 1 )) > "$IDXFILE"
  printf '%s\n' "${SEQ[$i]}"
}
_bp_kill()  { printf '|%s' "$*" >> "$KILLFILE"; return 0; }
_bp_sleep() { echo $(( $(cat "$SLEEPFILE" 2>/dev/null || echo 0) + 1 )) > "$SLEEPFILE"; return 0; }
# Codex R2 HIGH: ALSO echo to STDOUT to mimic the production override (`log` →
# stdout). If the lib didn't redirect bp_fail_loud's stdout to stderr, this would
# contaminate bp_confirm_port_released's captured verdict ("FAIL-LOUD…\nstuck"),
# breaking the exact `== "stuck"` checks → fail-closed silently turns fail-open.
bp_fail_loud() { printf '%s\n' "$1" >> "$ALERTFILE"; echo "[FAIL-LOUD-STDOUT] $1"; }

# ── S1: port already free on first poll → released, no alert ────────────────
reset_seam; SEQ=("")
out="$(bp_confirm_port_released 9876 10 5 5)"
if [[ "$out" == "released" && -z "$(alerts)" ]]; then pass "S1 free on poll → released, no alert"; else fail "S1 out='$out' alerts='$(alerts)'"; fi

# ── S2: bound after kill, frees within the poll window → released, no alert ──
reset_seam; SEQ=("18909" "18909" "")
out="$(bp_confirm_port_released 9876 10 5 5)"
if [[ "$out" == "released" && -z "$(alerts)" ]]; then pass "S2 frees during poll → released, no alert"; else fail "S2 out='$out' alerts='$(alerts)'"; fi

# ── S3: poll fails, reclaim (KILL) frees → released, no alert ───────────────
reset_seam; FREE_AFTER="-KILL"
out="$(bp_confirm_port_released 9876 2 1 5)"
if [[ "$out" == "released" && "$(cat "$KILLFILE")" == *"-KILL"* && -z "$(alerts)" ]]; then pass "S3 reclaim(KILL) frees → released, no alert"; else fail "S3 out='$out' kill='$(cat "$KILLFILE")' alerts='$(alerts)'"; fi

# ── S4: never frees, reclaim fails → stuck + bridge_port_stuck alert ────────
reset_seam; FREE_AFTER="never"
out="$(bp_confirm_port_released 9876 2 1 1)"
if [[ "$out" == "stuck" && "$(alerts)" == *"bridge_port_stuck"* ]]; then pass "S4 unrecoverable → stuck + alert"; else fail "S4 out='$out' alerts='$(alerts)'"; fi

# ── S5: stop_bridge fail-closed mapping (Codex R1 HIGH-2) ────────────────────
# Mirrors restart-services.sh stop_bridge tail: "stuck" → return 1 (abort deploy),
# anything else → return 0 (proceed). The deploy guards this with `if ! stop_bridge`.
stop_bridge_tail() {
  if [[ "$(bp_confirm_port_released "$1" "$2" "$3" "$4")" == "stuck" ]]; then return 1; fi
  return 0
}
reset_seam; SEQ=("")
if stop_bridge_tail 9876 10 5 5; then pass "S5 released → stop_bridge returns 0 (deploy proceeds)"; else fail "S5 expected rc0"; fi
reset_seam; FREE_AFTER="never"
if stop_bridge_tail 9876 2 1 1; then fail "S5b expected rc1 (fail-closed)"; else pass "S5b stuck → stop_bridge returns 1 (deploy aborts)"; fi

echo ""
echo "restart-stop-bridge-portfree: PASSED=$PASSED FAILED=$FAILED"
(( FAILED == 0 ))
