#!/usr/bin/env bash
# FLY-2271: hermetic contract for restarting a loaded quota-monitor whose
# completed-tick marker does not describe the live process and disk build.
set -euo pipefail

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/restart-quota-monitor.sh"

if [[ ! -r "$LIB" ]]; then
  printf 'RED: missing %s\n' "$LIB" >&2
  exit 1
fi
# shellcheck source=../lib/restart-quota-monitor.sh
source "$LIB"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*" >&2; }
expect_state() {
  local want="$1" label="$2"
  if [[ "$QUOTA_MONITOR_RESTART_STATE" == "$want" ]]; then pass "$label"; else
    fail "$label (want=$want got=$QUOTA_MONITOR_RESTART_STATE detail=$QUOTA_MONITOR_RESTART_DETAIL)"
  fi
}

SHA_A="$(printf 'a%.0s' {1..64})"
SHA_B="$(printf 'b%.0s' {1..64})"
LAUNCH_LOG="$ROOT/launch.log"

reset_world() {
  : > "$LAUNCH_LOG"
  JOB_LOADED=1
  RUNTIME_FAIL=0
  DISK_SHA="$SHA_A"
  PID_READABLE=1
  PID_VALUE=100
  START_VALUE="Mon Sep  2 12:00:00 2026"
  PROCESS_ALIVE=1
  MARKER_TRUSTED=1
  MARKER_SHA="$SHA_A"
  MARKER_PID=100
  MARKER_START="$START_VALUE"
  MARKER_COMPLETED=1700000000500
  KICK_MODE=new
  KICK_RC=0
  SLEEP_COUNT=0
  DRY_RUN=false
  QUOTA_MONITOR_RESTART_STATE=""
  QUOTA_MONITOR_RESTART_DETAIL=""
}

_rqm_runtime_sha() { (( RUNTIME_FAIL == 0 )) && printf '%s\n' "$DISK_SHA"; }
_rqm_launchctl() {
  printf '%s\n' "$*" >> "$LAUNCH_LOG"
  if [[ "$1" == "print" ]]; then (( JOB_LOADED == 1 )); return; fi
  (( KICK_RC == 0 )) || return "$KICK_RC"
  case "$KICK_MODE" in
    new)
      PID_VALUE=200; START_VALUE="Mon Sep  2 12:01:00 2026"; PROCESS_ALIVE=1 ;;
    same) ;;
    dead)
      PID_VALUE=200; START_VALUE="Mon Sep  2 12:01:00 2026"; PROCESS_ALIVE=0 ;;
    fresh-marker)
      PID_READABLE=1; PID_VALUE=200; START_VALUE="Mon Sep  2 12:01:00 2026"; PROCESS_ALIVE=1
      MARKER_TRUSTED=1; MARKER_SHA="$DISK_SHA"; MARKER_PID=200; MARKER_START="$START_VALUE"; MARKER_COMPLETED=1700000000900 ;;
    stale-marker)
      PID_READABLE=1; PID_VALUE=200; START_VALUE="Mon Sep  2 12:01:00 2026"; PROCESS_ALIVE=1
      MARKER_TRUSTED=1; MARKER_SHA="$DISK_SHA"; MARKER_PID=200; MARKER_START="$START_VALUE"; MARKER_COMPLETED=1700000000300 ;;
  esac
}
_rqm_read_pidfile() {
  (( PID_READABLE == 1 )) || return 7
  printf '%s|%s\n' "$PID_VALUE" "$START_VALUE"
}
_rqm_marker_is_trusted() { (( MARKER_TRUSTED == 1 )); }
_rqm_marker_field() {
  case "$1" in
    runtimeTreeSha256) printf '%s\n' "$MARKER_SHA" ;;
    pid) printf '%s\n' "$MARKER_PID" ;;
    processStartTime) printf '%s\n' "$MARKER_START" ;;
    completedAt) printf '%s\n' "$MARKER_COMPLETED" ;;
  esac
}
_rqm_process_start_time() { (( PROCESS_ALIVE == 1 )) && printf '%s\n' "$START_VALUE"; }
_rqm_now_ms() { printf '%s\n' 1700000000400; }
_rqm_sleep() { SLEEP_COUNT=$((SLEEP_COUNT + 1)); }

printf 'Test: exact marker + pidfile + live process + disk hash is current\n'
reset_world
restart_quota_monitor
expect_state current "matching three-way witness is left running"
[[ "$(cat "$LAUNCH_LOG")" == print* ]] || fail "current path made a mutating launchctl call"

printf 'Test: mismatched runtime hash kickstarts once and proves a new live tuple\n'
reset_world
MARKER_SHA="$SHA_B"
restart_quota_monitor
expect_state restarted "stale runtime is restarted"
[[ "$(grep -c '^kickstart -k ' "$LAUNCH_LOG" || true)" == 1 ]] || fail "expected one kickstart"

printf 'Test: an unloaded job is never bootstrapped here\n'
reset_world
JOB_LOADED=0
RUNTIME_FAIL=1
restart_quota_monitor
expect_state not_loaded "domain absence is delegated to non-Lead convergence"
! grep -q '^kickstart ' "$LAUNCH_LOG" || fail "unloaded job was kickstarted"

printf 'Test: missing or mismatched markers force restart without an age exemption\n'
reset_world
MARKER_TRUSTED=0
restart_quota_monitor
expect_state restarted "missing marker forces restart"
reset_world
MARKER_PID=999
restart_quota_monitor
expect_state restarted "marker for another pid forces restart"

printf 'Test: unreadable pidfile remains errexit-safe and needs a fresh post-kick marker\n'
reset_world
PID_READABLE=0
KICK_MODE=fresh-marker
restart_quota_monitor
expect_state restarted "unknown old tuple accepts only a fresh post-kick marker"
reset_world
PID_READABLE=0
KICK_MODE=stale-marker
restart_quota_monitor
expect_state degraded "pre-kick marker cannot prove replacement"
[[ "$SLEEP_COUNT" == 60 ]] || fail "stale-marker path did not exhaust the bounded wait"

printf 'Test: an unchanged or dead post-kick tuple degrades after 30 seconds\n'
reset_world
MARKER_SHA="$SHA_B"
KICK_MODE=same
restart_quota_monitor
expect_state degraded "unchanged tuple is not reported restarted"
[[ "$SLEEP_COUNT" == 60 ]] || fail "unchanged tuple did not exhaust the bounded wait"
reset_world
MARKER_SHA="$SHA_B"
KICK_MODE=dead
restart_quota_monitor
expect_state degraded "dead replacement tuple is rejected"

printf 'Test: runtime hash failure is unverifiable and dry-run is non-mutating\n'
reset_world
RUNTIME_FAIL=1
restart_quota_monitor
expect_state unverifiable "missing disk hash refuses mutation"
[[ $(wc -l < "$LAUNCH_LOG") -eq 1 && "$(cat "$LAUNCH_LOG")" == print* ]] \
  || fail "unverifiable path made more than the domain probe"
reset_world
MARKER_SHA="$SHA_B"
DRY_RUN=true
restart_quota_monitor
expect_state planned "dry-run reports the needed restart"
! grep -q '^kickstart ' "$LAUNCH_LOG" || fail "dry-run performed kickstart"
reset_world
MARKER_SHA="$SHA_B"
KICK_RC=9
restart_quota_monitor
if [[ "$QUOTA_MONITOR_RESTART_STATE" == degraded && "$QUOTA_MONITOR_RESTART_DETAIL" == *"rc=9"* ]]; then
  pass "kickstart failure is non-fatal and retains its exit code"
else
  fail "kickstart failure lost its exit code ($QUOTA_MONITOR_RESTART_DETAIL)"
fi

printf 'Test: the shared Node record reader enforces owner-only regular bounded JSON\n'
PIDFILE="$ROOT/pid.json"
MARKER="$ROOT/marker.json"
printf '{"pid":100,"processStartTime":"start"}\n' > "$PIDFILE"
printf '{"runtimeTreeSha256":"%s","pid":100,"processStartTime":"start","completedAt":5}\n' "$SHA_A" > "$MARKER"
chmod 600 "$PIDFILE" "$MARKER"
[[ "$(_rqm_read_record "$PIDFILE" pid processStartTime)" == '100|start' ]] \
  && [[ "$(_rqm_read_record "$MARKER" runtimeTreeSha256 pid processStartTime completedAt)" == "$SHA_A|100|start|5" ]] \
  && pass "valid pidfile and marker records are parsed"
chmod 644 "$PIDFILE"
if _rqm_read_record "$PIDFILE" pid processStartTime >/dev/null 2>&1; then fail "0644 pidfile accepted"; else pass "unsafe mode rejected"; fi
rm -f "$PIDFILE"
ln -s "$MARKER" "$PIDFILE"
if _rqm_read_record "$PIDFILE" pid processStartTime >/dev/null 2>&1; then fail "symlink pidfile accepted"; else pass "symlink rejected"; fi
rm -f "$PIDFILE"
printf 'not-json\n' > "$PIDFILE"; chmod 600 "$PIDFILE"
if _rqm_read_record "$PIDFILE" pid processStartTime >/dev/null 2>&1; then fail "malformed JSON accepted"; else pass "malformed JSON rejected"; fi
printf '{"pid":100}\n' > "$PIDFILE"; chmod 600 "$PIDFILE"
if _rqm_read_record "$PIDFILE" pid processStartTime >/dev/null 2>&1; then fail "partial pidfile accepted"; else pass "missing field rejected"; fi
dd if=/dev/zero of="$PIDFILE" bs=1024 count=65 >/dev/null 2>&1; chmod 600 "$PIDFILE"
if _rqm_read_record "$PIDFILE" pid processStartTime >/dev/null 2>&1; then fail "oversized pidfile accepted"; else pass "oversized record rejected"; fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
