#!/usr/bin/env bash
# FLY-516: hermetic unit tests for scripts/lib/bridge-port.sh.
#
# The lib is sourceable and all real IO (lsof / kill / curl / sleep) goes
# through overridable seams, so these tests inject deterministic behavior and
# never touch a real port, process, or the network. Sleep is a no-op seam →
# zero wall-clock waiting.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="${SCRIPT_DIR}/../lib/bridge-port.sh"

if [[ ! -f "$LIB" ]]; then
  echo "[TEST] ✗ lib not found: $LIB"; exit 1
fi
# shellcheck source=../lib/bridge-port.sh
source "$LIB"

# ── Injectable seam state ───────────────────────────────────────────────────
# Listener sequence: each _bp_listeners call pops the next element (last one
# sticks). An element is a (possibly empty) space-separated PID list.
#
# bp_port_listeners pipes (_bp_listeners | awk), which runs the seam in a
# SUBSHELL — so the pop index and the kill/sleep logs MUST be file-backed to
# survive subshells (a parent-shell variable would never see the mutation).
TMP="$(mktemp -d "${TMPDIR:-/tmp}/bport.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
IDXFILE="$TMP/idx"; KILLFILE="$TMP/kill"; SLEEPFILE="$TMP/sleep"
CURLIDXFILE="$TMP/curlidx"; NOWFILE="$TMP/now"
SEQ=(); CURL_BODY=""; CURL_RC=0
# CURL_SEQ: optional sequence of /health bodies popped one per probe (rc 0). When
# empty, _bp_curl falls back to CURL_BODY/CURL_RC. Lets a test return e.g.
# shutting_down then healthy across the grace re-probe.
CURL_SEQ=()
# FREE_AFTER overrides SEQ for the reclaim tests: the port stays occupied until
# the given signal token ("-TERM" / "-KILL") appears in the kill log, then frees.
# "never" = unkillable. Empty = use SEQ. This models reclaim semantics robustly,
# independent of how many times the poll re-reads the listener.
FREE_AFTER=""

reset_seam() { SEQ=(); FREE_AFTER=""; CURL_BODY=""; CURL_RC=0; CURL_SEQ=(); echo 0 > "$IDXFILE"; echo 0 > "$CURLIDXFILE"; : > "$KILLFILE"; echo 0 > "$SLEEPFILE"; echo 1000 > "$NOWFILE"; }
kill_log()   { cat "$KILLFILE" 2>/dev/null; }
sleep_count(){ cat "$SLEEPFILE" 2>/dev/null || echo 0; }
set_now()    { echo "$1" > "$NOWFILE"; }

_bp_listeners() {
  if [[ -n "$FREE_AFTER" ]]; then
    if [[ "$FREE_AFTER" != "never" ]] && grep -q -- "$FREE_AFTER" "$KILLFILE" 2>/dev/null; then
      printf '\n'
    else
      printf '18909\n'
    fi
    return 0
  fi
  local n=${#SEQ[@]}
  (( n == 0 )) && { printf '\n'; return 0; }
  local i; i="$(cat "$IDXFILE" 2>/dev/null || echo 0)"
  (( i >= n )) && i=$(( n - 1 ))
  echo $(( $(cat "$IDXFILE" 2>/dev/null || echo 0) + 1 )) > "$IDXFILE"
  printf '%s\n' "${SEQ[$i]}"
}
_bp_kill()  { printf '|%s' "$*" >> "$KILLFILE"; return 0; }
_bp_sleep() { echo $(( $(cat "$SLEEPFILE" 2>/dev/null || echo 0) + 1 )) > "$SLEEPFILE"; return 0; }
_bp_curl()  {
  local n=${#CURL_SEQ[@]}
  if (( n > 0 )); then
    local i; i="$(cat "$CURLIDXFILE" 2>/dev/null || echo 0)"
    (( i >= n )) && i=$(( n - 1 ))
    echo $(( i + 1 )) > "$CURLIDXFILE"
    printf '%s' "${CURL_SEQ[$i]}"; return 0
  fi
  printf '%s' "$CURL_BODY"; return "$CURL_RC"
}
_bp_now()   { cat "$NOWFILE" 2>/dev/null || echo 0; }

# ── T1: bp_port_is_free ─────────────────────────────────────────────────────
reset_seam; SEQ=("")
if bp_port_is_free 9876; then pass "T1 empty listeners → free"; else fail "T1 expected free"; fi
reset_seam; SEQ=("18909")
if bp_port_is_free 9876; then fail "T1b expected occupied"; else pass "T1b non-empty listeners → occupied"; fi

# ── T2: bp_port_listeners strips blanks ─────────────────────────────────────
reset_seam; SEQ=("18909 18934")
out="$(bp_port_listeners 9876)"
if [[ "$out" == *"18909"* && "$out" == *"18934"* ]]; then pass "T2 lists pids"; else fail "T2 got '$out'"; fi
reset_seam; SEQ=("")
out="$(bp_port_listeners 9876)"
if [[ -z "$out" ]]; then pass "T2b empty → empty"; else fail "T2b got '$out'"; fi

# ── T3: bp_wait_port_free ───────────────────────────────────────────────────
# occupied, occupied, then free → returns 0; no real sleep.
reset_seam; SEQ=("123" "123" "")
if bp_wait_port_free 9876 10 1; then pass "T3 frees on 3rd poll → rc0"; else fail "T3 expected rc0"; fi
if (( $(sleep_count) > 0 )); then pass "T3b used seam sleep (no real wait), count=$(sleep_count)"; else fail "T3b expected seam sleeps"; fi
# always occupied within timeout → rc1.
reset_seam; SEQ=("123")
if bp_wait_port_free 9876 3 1; then fail "T3c expected rc1 (still occupied)"; else pass "T3c never frees → rc1"; fi
# timeout 0 + already free → rc0 immediately.
reset_seam; SEQ=("")
if bp_wait_port_free 9876 0 1; then pass "T3d timeout0 + free → rc0"; else fail "T3d expected rc0"; fi

# ── T4: bp_reclaim_port ─────────────────────────────────────────────────────
# already free → rc0, no kill.
reset_seam; SEQ=("")
if bp_reclaim_port 9876 5 5 && [[ -z "$(kill_log)" ]]; then pass "T4 already free → rc0, no kill"; else fail "T4 kill_log='$(kill_log)'"; fi
# TERM frees it → rc0, only -TERM sent (no -KILL).
reset_seam; FREE_AFTER="-TERM"
if bp_reclaim_port 9876 5 5; then
  kl="$(kill_log)"; if [[ "$kl" == *"-TERM"* && "$kl" != *"-KILL"* ]]; then pass "T4b TERM frees → rc0, no KILL"; else fail "T4b kill_log='$kl'"; fi
else fail "T4b expected rc0"; fi
# TERM ineffective → escalate to KILL → frees → rc0, -KILL sent.
reset_seam; FREE_AFTER="-KILL"
if bp_reclaim_port 9876 2 5; then
  if [[ "$(kill_log)" == *"-KILL"* ]]; then pass "T4c escalates to KILL → rc0"; else fail "T4c expected KILL, log='$(kill_log)'"; fi
else fail "T4c expected rc0"; fi
# never frees even after KILL → rc1.
reset_seam; FREE_AFTER="never"
if bp_reclaim_port 9876 2 2; then fail "T4d expected rc1 (unkillable)"; else pass "T4d unkillable → rc1"; fi

# ── T5: bp_probe_health ─────────────────────────────────────────────────────
reset_seam; CURL_RC=0; CURL_BODY='{"ok":true,"shuttingDown":false,"sessions_count":0}'
if [[ "$(bp_probe_health http://localhost:9876)" == "healthy" ]]; then pass "T5 ok+!shuttingDown → healthy"; else fail "T5 expected healthy"; fi
reset_seam; CURL_RC=0; CURL_BODY='{"ok":false,"shuttingDown":true,"sessions_count":0}'
if [[ "$(bp_probe_health http://localhost:9876)" == "shutting_down" ]]; then pass "T5b shuttingDown → shutting_down"; else fail "T5b expected shutting_down"; fi
reset_seam; CURL_RC=7; CURL_BODY=''   # curl connection-refused
if [[ "$(bp_probe_health http://localhost:9876)" == "down" ]]; then pass "T5c curl fail → down"; else fail "T5c expected down"; fi
reset_seam; CURL_RC=0; CURL_BODY='not json'
if [[ "$(bp_probe_health http://localhost:9876)" == "down" ]]; then pass "T5d garbage body → down"; else fail "T5d expected down"; fi
# HIGH-1 (Codex R1): legacy /health = valid JSON, ok present, NO shuttingDown field.
reset_seam; CURL_RC=0; CURL_BODY='{"ok":true,"uptime":12,"sessions_count":0}'
if [[ "$(bp_probe_health http://localhost:9876)" == "legacy" ]]; then pass "T5e legacy (no shuttingDown field) → legacy, NOT healthy"; else fail "T5e expected legacy, got '$(bp_probe_health http://localhost:9876)'"; fi

# ── T6: bp_ensure_port_for_start (the wrapper decision tree) ────────────────
# free → bind.
reset_seam; SEQ=("")
if [[ "$(bp_ensure_port_for_start 9876 http://localhost:9876 25 5 5)" == "bind" ]]; then pass "T6 free → bind"; else fail "T6 expected bind"; fi
# held + healthy → already-healthy (no kill).
reset_seam; SEQ=("18909"); CURL_BODY='{"ok":true,"shuttingDown":false}'
out="$(bp_ensure_port_for_start 9876 http://localhost:9876 25 5 5)"
if [[ "$out" == "already-healthy" && -z "$(kill_log)" ]]; then pass "T6b held+healthy → already-healthy, no kill"; else fail "T6b out='$out' kill='$(kill_log)'"; fi
# held + shutting_down, frees during grace → bind (no kill — respects drain).
reset_seam; SEQ=("18909" ""); CURL_BODY='{"ok":false,"shuttingDown":true}'
out="$(bp_ensure_port_for_start 9876 http://localhost:9876 25 5 5)"
if [[ "$out" == "bind" && -z "$(kill_log)" ]]; then pass "T6c shutting_down frees in grace → bind, no kill"; else fail "T6c out='$out' kill='$(kill_log)'"; fi
# held + down, never frees on its own, KILL reclaims → bind (KILL sent).
reset_seam; FREE_AFTER="-KILL"; CURL_BODY='{"ok":false}'
out="$(bp_ensure_port_for_start 9876 http://localhost:9876 2 1 5)"
if [[ "$out" == "bind" && "$(kill_log)" == *"-KILL"* ]]; then pass "T6d down+unyielding → reclaim(KILL) → bind"; else fail "T6d out='$out' kill='$(kill_log)'"; fi
# held + down, unkillable → stuck.
reset_seam; FREE_AFTER="never"; CURL_BODY='{"ok":false}'
out="$(bp_ensure_port_for_start 9876 http://localhost:9876 2 1 1)"
if [[ "$out" == "stuck" ]]; then pass "T6e down+unkillable → stuck"; else fail "T6e expected stuck, got '$out'"; fi
# held, a healthy Bridge claims the port DURING the grace → re-probe → already-healthy (no kill).
reset_seam; FREE_AFTER="never"; CURL_SEQ=('{"ok":false,"shuttingDown":true}' '{"ok":true,"shuttingDown":false}')
out="$(bp_ensure_port_for_start 9876 http://localhost:9876 2 1 1)"
if [[ "$out" == "already-healthy" && -z "$(kill_log)" ]]; then pass "T6f re-probe healthy after grace → already-healthy, no kill"; else fail "T6f out='$out' kill='$(kill_log)'"; fi
# HIGH-1 (Codex R1): legacy Bridge holding the port (ok:true, no shuttingDown) must
# NOT be treated as already-healthy. Stuck legacy (never frees) → reclaim via KILL.
reset_seam; FREE_AFTER="never"; CURL_BODY='{"ok":true,"uptime":99}'
out="$(bp_ensure_port_for_start 9876 http://localhost:9876 2 1 1)"
if [[ "$out" == "stuck" ]]; then pass "T6g legacy stuck (ok:true,no field) → NOT already-healthy → reclaim→stuck"; else fail "T6g out='$out' (must not be already-healthy)"; fi
# Healthy legacy that yields to SIGTERM (graceful restart) → bind via TERM, no KILL.
reset_seam; FREE_AFTER="-TERM"; CURL_BODY='{"ok":true,"uptime":99}'
out="$(bp_ensure_port_for_start 9876 http://localhost:9876 2 1 5)"
if [[ "$out" == "bind" && "$(kill_log)" == *"-TERM"* && "$(kill_log)" != *"-KILL"* ]]; then pass "T6h legacy yields to TERM → bind (clean restart), no KILL"; else fail "T6h out='$out' kill='$(kill_log)'"; fi

# ── T7: bp_port_from_url ────────────────────────────────────────────────────
[[ "$(bp_port_from_url http://localhost:9876)" == "9876" ]] && pass "T7 explicit port" || fail "T7"
[[ "$(bp_port_from_url http://127.0.0.1:12345/health)" == "12345" ]] && pass "T7b port+path" || fail "T7b got '$(bp_port_from_url http://127.0.0.1:12345/health)'"
[[ "$(bp_port_from_url http://localhost)" == "9876" ]] && pass "T7c no port → default 9876" || fail "T7c"

# ── T8: bp_record_start_and_check_crashloop ─────────────────────────────────
reset_seam; MARK="$TMP/starts"; : > "$MARK"
set_now 1000; bp_record_start_and_check_crashloop "$MARK" 60 3 && r1=ok || r1=loop
set_now 1010; bp_record_start_and_check_crashloop "$MARK" 60 3 && r2=ok || r2=loop
set_now 1020; bp_record_start_and_check_crashloop "$MARK" 60 3 && r3=ok || r3=loop
if [[ "$r1" == "ok" && "$r2" == "ok" && "$r3" == "loop" ]]; then pass "T8 3 starts in 60s → crash-loop on 3rd"; else fail "T8 r1=$r1 r2=$r2 r3=$r3"; fi
# Spread out beyond the window → old entries pruned, never trips.
reset_seam; MARK="$TMP/starts2"; : > "$MARK"
set_now 1000; bp_record_start_and_check_crashloop "$MARK" 60 3 && s1=ok || s1=loop
set_now 2000; bp_record_start_and_check_crashloop "$MARK" 60 3 && s2=ok || s2=loop
set_now 3000; bp_record_start_and_check_crashloop "$MARK" 60 3 && s3=ok || s3=loop
if [[ "$s1" == "ok" && "$s2" == "ok" && "$s3" == "ok" ]]; then pass "T8b spread-out starts pruned → never loops"; else fail "T8b s1=$s1 s2=$s2 s3=$s3"; fi

# ── T9 (FLY-1082): bp_check_dirty_marker — the three boot shapes ────────────
# First boot: no marker file at all → "none".
MARKER="$TMP/bridge-running-marker.json"
rm -f "$MARKER"
[[ "$(bp_check_dirty_marker "$MARKER")" == "none" ]] && pass "T9 first boot (no marker) → none" || fail "T9 got '$(bp_check_dirty_marker "$MARKER")'"
# Clean SIGTERM shutdown: state=clean → "clean" (no page).
printf '{"pid":111,"bootTs":1000,"state":"clean"}' > "$MARKER"
[[ "$(bp_check_dirty_marker "$MARKER")" == "clean" ]] && pass "T9b clean shutdown → clean" || fail "T9b got '$(bp_check_dirty_marker "$MARKER")'"
# kill -9 shape: state=running survives → "dirty <pid> <bootTs>".
printf '{"pid":111,"bootTs":1000,"state":"running"}' > "$MARKER"
[[ "$(bp_check_dirty_marker "$MARKER")" == "dirty 111 1000" ]] && pass "T9c kill -9 (running marker) → dirty w/ prev evidence" || fail "T9c got '$(bp_check_dirty_marker "$MARKER")'"
# Garbage marker / non-numeric fields → fail-open "none" (never a startup gate).
printf 'not json' > "$MARKER"
[[ "$(bp_check_dirty_marker "$MARKER")" == "none" ]] && pass "T9d garbage marker → none (fail-open)" || fail "T9d got '$(bp_check_dirty_marker "$MARKER")'"
printf '{"pid":"x","bootTs":1000,"state":"running"}' > "$MARKER"
[[ "$(bp_check_dirty_marker "$MARKER")" == "none" ]] && pass "T9e non-numeric pid → none (fail-open)" || fail "T9e got '$(bp_check_dirty_marker "$MARKER")'"

# ── T10 (FLY-1082): bp_record_dirty_and_check_streak — crash-loop copy gate ─
reset_seam; DMARK="$TMP/dirty-exits"; : > "$DMARK"
set_now 1000; bp_record_dirty_and_check_streak "$DMARK" 600 3 && d1=ok || d1=loop
set_now 1100; bp_record_dirty_and_check_streak "$DMARK" 600 3 && d2=ok || d2=loop
set_now 1200; bp_record_dirty_and_check_streak "$DMARK" 600 3 && d3=ok || d3=loop
if [[ "$d1" == "ok" && "$d2" == "ok" && "$d3" == "loop" ]]; then pass "T10 3 dirty boots in 10min → crash-loop copy"; else fail "T10 d1=$d1 d2=$d2 d3=$d3"; fi
reset_seam; DMARK="$TMP/dirty-exits2"; : > "$DMARK"
set_now 1000; bp_record_dirty_and_check_streak "$DMARK" 600 3 && e1=ok || e1=loop
set_now 5000; bp_record_dirty_and_check_streak "$DMARK" 600 3 && e2=ok || e2=loop
set_now 9000; bp_record_dirty_and_check_streak "$DMARK" 600 3 && e3=ok || e3=loop
if [[ "$e1" == "ok" && "$e2" == "ok" && "$e3" == "ok" ]]; then pass "T10b spread-out dirty boots pruned → normal copy"; else fail "T10b e1=$e1 e2=$e2 e3=$e3"; fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "bridge-port: PASSED=$PASSED FAILED=$FAILED"
(( FAILED == 0 ))
