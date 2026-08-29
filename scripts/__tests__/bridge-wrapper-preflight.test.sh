#!/usr/bin/env bash
# FLY-516: hermetic tests for bp_launcher_preflight — the flywheel-bridge-wrapper.sh
# orchestration (crash-loop alert + port decision + fail-loud routing). Seams for
# lsof/kill/curl/sleep/now are injected; the fail-loud seam is captured so we can
# assert WHICH alert fired without touching meta-alert.sh / Discord.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="${SCRIPT_DIR}/../lib/bridge-port.sh"
# shellcheck source=../lib/bridge-port.sh
source "$LIB"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wpre.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
KILLFILE="$TMP/kill"; SLEEPFILE="$TMP/sleep"; NOWFILE="$TMP/now"; ALERTFILE="$TMP/alert"
SEQ=(); FREE_AFTER=""; CURL_BODY=""; CURL_RC=0

reset_seam() {
  SEQ=(); FREE_AFTER=""; CURL_BODY=""; CURL_RC=0
  : > "$KILLFILE"; echo 0 > "$SLEEPFILE"; echo 1000 > "$NOWFILE"; : > "$ALERTFILE"
}
alerts() { cat "$ALERTFILE" 2>/dev/null; }

_bp_listeners() {
  if [[ -n "$FREE_AFTER" ]]; then
    if [[ "$FREE_AFTER" != "never" ]] && grep -q -- "$FREE_AFTER" "$KILLFILE" 2>/dev/null; then printf '\n'; else printf '18909\n'; fi
    return 0
  fi
  (( ${#SEQ[@]} == 0 )) && { printf '\n'; return 0; }
  # static single-value seam is enough here (FREE_AFTER drives the dynamic cases)
  printf '%s\n' "${SEQ[0]}"
}
_bp_kill()  { printf '|%s' "$*" >> "$KILLFILE"; return 0; }
_bp_sleep() { echo $(( $(cat "$SLEEPFILE" 2>/dev/null || echo 0) + 1 )) > "$SLEEPFILE"; return 0; }
_bp_curl()  { printf '%s' "$CURL_BODY"; return "$CURL_RC"; }
_bp_now()   { cat "$NOWFILE" 2>/dev/null || echo 0; }
# Capture which fail-loud reasons fired. Codex R2 HIGH: ALSO echo to STDOUT to
# mimic the production override (which calls `log` → stdout). If the lib failed to
# redirect bp_fail_loud's stdout to stderr, this line would contaminate the
# captured verdict and the exact `== "stuck"`/`"bind"` asserts below would fail —
# so this seam guards the stdout-isolation contract, not just "did it alert".
bp_fail_loud() { printf '%s\n' "$1" >> "$ALERTFILE"; echo "[FAIL-LOUD-STDOUT] $1"; }

MARK="$TMP/starts"

# ── P1: free port, single start → bind, no alert ────────────────────────────
reset_seam; : > "$MARK"; SEQ=("")
out="$(bp_launcher_preflight 9876 http://localhost:9876 "$MARK" 60 3 25 5 5)"
if [[ "$out" == "bind" && -z "$(alerts)" ]]; then pass "P1 free → bind, no alert"; else fail "P1 out='$out' alerts='$(alerts)'"; fi

# ── P2: healthy Bridge already serving → already-healthy, no alert ──────────
reset_seam; : > "$MARK"; SEQ=("18909"); CURL_BODY='{"ok":true,"shuttingDown":false}'
out="$(bp_launcher_preflight 9876 http://localhost:9876 "$MARK" 60 3 25 5 5)"
if [[ "$out" == "already-healthy" && -z "$(alerts)" ]]; then pass "P2 healthy → already-healthy, no alert"; else fail "P2 out='$out' alerts='$(alerts)'"; fi

# ── P3: down + unkillable → stuck + bridge_port_stuck alert ─────────────────
reset_seam; : > "$MARK"; FREE_AFTER="never"; CURL_BODY='{"ok":false}'
out="$(bp_launcher_preflight 9876 http://localhost:9876 "$MARK" 60 3 2 1 1)"
if [[ "$out" == "stuck" && "$(alerts)" == *"bridge_port_stuck"* ]]; then pass "P3 stuck → stuck + port_stuck alert"; else fail "P3 out='$out' alerts='$(alerts)'"; fi

# ── P4: zombie reclaimed by KILL → bind, no stuck alert ────────────────────
reset_seam; : > "$MARK"; FREE_AFTER="-KILL"; CURL_BODY='{"ok":false,"shuttingDown":true}'
out="$(bp_launcher_preflight 9876 http://localhost:9876 "$MARK" 60 3 2 1 5)"
if [[ "$out" == "bind" && "$(alerts)" != *"bridge_port_stuck"* ]]; then pass "P4 zombie reclaimed → bind, no stuck alert"; else fail "P4 out='$out' alerts='$(alerts)'"; fi

# ── P5: crash-loop (3 starts in 60s) → still binds, but fires crash_loop alert ─
# Each call records a start at the injected NOW; on the 3rd within the window the
# crash-loop alert must fire WITHOUT blocking the bind.
reset_seam; : > "$MARK"; SEQ=("")
echo 1000 > "$NOWFILE"; bp_launcher_preflight 9876 http://localhost:9876 "$MARK" 60 3 25 5 5 >/dev/null
echo 1010 > "$NOWFILE"; bp_launcher_preflight 9876 http://localhost:9876 "$MARK" 60 3 25 5 5 >/dev/null
echo 1020 > "$NOWFILE"; out="$(bp_launcher_preflight 9876 http://localhost:9876 "$MARK" 60 3 25 5 5)"
if [[ "$out" == "bind" && "$(alerts)" == *"bridge_crash_loop"* ]]; then pass "P5 crash-loop → bind (non-blocking) + crash_loop alert"; else fail "P5 out='$out' alerts='$(alerts)'"; fi

echo ""
echo "bridge-wrapper-preflight: PASSED=$PASSED FAILED=$FAILED"
(( FAILED == 0 ))
