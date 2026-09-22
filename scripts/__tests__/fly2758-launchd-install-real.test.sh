#!/usr/bin/env bash
# FLY-2758: Darwin-only real launchd rehearsal for supervisor.sh's darwin
# install path, on an isolated throwaway label.
#
# Production failure (three shuttles, 2026-09-19..21): `flywheel-lead.sh
# install` booted the live Raya Lead out and bootstrapped the same label
# immediately; launchd was still tearing the service down and answered
# `Bootstrap failed: 5: Input/output error`, which left no carrier loaded.
#
#   control : bootout → immediate raw bootstrap on a slow-exiting service
#             (the pre-fix sequence) — recorded, expected to fail;
#   fix     : _sup_darwin_install on the running service must wait for the
#             label to leave the domain and come back with a new pid.
#
# The probe label is com.flywheel.fly2758-eio-probe-<pid> under a fixture
# launchd dir; it is always booted out and removed on exit.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/supervisor.sh"

if [[ "$(uname -s)" != Darwin ]] || ! command -v launchctl >/dev/null 2>&1; then
  printf '[SKIP] FLY-2758 real launchd rehearsal requires Darwin with launchctl\n'
  exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

SANDBOX="$(mktemp -d -t fly2758-launchd.XXXXXX)"
NAME="fly2758-eio-probe-$$"
LABEL="com.flywheel.$NAME"
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$LABEL"
LDIR="$SANDBOX/launchd"
PLIST="$LDIR/$LABEL.plist"
SLOW="$SANDBOX/slow.sh"
mkdir -p "$LDIR"
# A KeepAlive service that, like the Codex TUI Lead, needs several seconds to
# shut down after SIGTERM.
cat > "$SLOW" <<'SH'
#!/bin/bash
trap 'sleep 6; exit 0' TERM
while :; do sleep 1; done
SH
chmod +x "$SLOW"

label_absent() {
  local out rc=0
  out="$(launchctl print "$TARGET" 2>&1)" || rc=$?
  [ "$rc" -ne 0 ] && grep -qiE 'could not find service|no such process' <<<"$out"
}
wait_absent() { # <attempts>
  local i
  for (( i = 0; i < $1; i++ )); do label_absent && return 0; sleep 1; done
  return 1
}
running_pid() { # prints the pid once launchd reports one (≤15s), else empty
  local i out pid
  for (( i = 0; i < 15; i++ )); do
    out="$(launchctl print "$TARGET" 2>/dev/null || true)"
    pid="$(printf '%s\n' "$out" | awk '$1 == "pid" && $2 == "=" {print $3; exit}')"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && grep -qE '^[[:space:]]*state = running[[:space:]]*$' <<<"$out"; then
      printf '%s\n' "$pid"; return 0
    fi
    sleep 1
  done
  return 1
}
cleanup() {
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  wait_absent 40 || printf '[WARN] probe label %s still loaded after cleanup\n' "$LABEL" >&2
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

if ! label_absent; then
  fail "probe label $LABEL is unexpectedly present before the rehearsal"
  exit 1
fi

# shellcheck source=../lib/supervisor.sh
source "$LIB"
SPEC="$(jq -nc --arg name "$NAME" --arg exec "/bin/bash $SLOW" --arg out "$SANDBOX/probe.log" \
  '{name:$name,kind:"service",exec:$exec,keepAlive:true,throttleInterval:30,stdout:$out}')"
real_install() {
  FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LDIR" \
    FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 supervisor_install "$SPEC"
}

# Phase 1: first install on an absent label.
if real_install >"$SANDBOX/install1.out" 2>&1 && pid1="$(running_pid)"; then
  pass "first install bootstraps the probe (pid=$pid1)"
else
  fail "first install failed: $(cat "$SANDBOX/install1.out")"
  exit 1
fi

# Phase 2: control — the pre-fix sequence. bootout returns while the service is
# still exiting; an immediate raw bootstrap of the same label is what the
# production shuttle did.
launchctl bootout "$TARGET" >/dev/null 2>&1 || true
control_rc=0
control_err="$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1 >/dev/null)" || control_rc=$?
if (( control_rc != 0 )); then
  pass "control: immediate bootstrap after bootout fails on this host (rc=$control_rc: $control_err)"
  if wait_absent 40 && real_install >"$SANDBOX/install2.out" 2>&1 && pid2="$(running_pid)"; then
    pass "probe brought back for the fixed-path rehearsal (pid=$pid2)"
  else
    fail "could not bring the probe back after the control: $(cat "$SANDBOX/install2.out" 2>/dev/null)"
    exit 1
  fi
else
  printf '[INFO] control: launchd accepted the immediate bootstrap on this host; race not reproduced\n'
  if pid2="$(running_pid)"; then
    pass "probe is running after the control (pid=$pid2)"
  else
    fail "probe not running after the control"
    exit 1
  fi
fi

# Phase 3: the fixed install path on a RUNNING service must survive the
# teardown window and come back with a fresh pid, exactly one running instance.
start=$(date +%s)
if real_install >"$SANDBOX/install3.out" 2>&1; then
  elapsed=$(( $(date +%s) - start ))
  pid3="$(running_pid || true)"
  if [[ -n "$pid3" && "$pid3" != "$pid2" ]] \
    && [ "$(launchctl print "$TARGET" 2>/dev/null | grep -cE '^[[:space:]]*state = running[[:space:]]*$')" -eq 1 ]; then
    pass "install on a running service waits out teardown and restarts it (old=$pid2 new=$pid3 ${elapsed}s)"
  else
    fail "install returned 0 but the service is not cleanly running (old=$pid2 new=${pid3:-none})"
  fi
  if grep -q 'Input/output error' "$SANDBOX/install3.out"; then
    fail "fixed install still hit EIO: $(cat "$SANDBOX/install3.out")"
  else
    pass "fixed install produced no EIO"
  fi
else
  fail "install on a running service failed: $(cat "$SANDBOX/install3.out")"
fi

# Phase 4: teardown leaves nothing behind.
launchctl bootout "$TARGET" >/dev/null 2>&1 || true
if wait_absent 40; then pass "probe label removed after the rehearsal"; else fail "probe label still loaded"; fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
