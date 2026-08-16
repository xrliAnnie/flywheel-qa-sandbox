#!/bin/bash
# FLY-1285 QA: verify the rescue library against a REAL tmux server.
#
# Why this file exists: tmux-server-rescue.test.sh is fully hermetic — it stubs
# tmux, ps and lsof. That proves the classification logic given assumed platform
# behavior, but it cannot catch a wrong assumption ABOUT the platform. These
# cases assert the two platform predicates the whole design rests on:
#
#   1. that a real daemonized tmux server is recognized as a server candidate
#   2. that a real server is recognized as the owner of a given socket path
#
# If either predicate is blind, candidatePids is always empty and every verdict
# collapses to reachable|dead — and `dead` is the ONE verdict that authorizes a
# server-starting create. That is precisely the FLY-1285 incident.
#
# SAFETY: sockets live under a private dir; the default Flywheel socket is never
# touched. Every spawned server is SIGCONT'd and killed on exit.
set -uo pipefail
export FLYWHEEL_TMUX_RESCUE_ALERT_BIN="/usr/bin/true"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../lib/tmux-server-rescue.sh"

if ! command -v tmux >/dev/null 2>&1; then
  echo "[SKIP] tmux not installed; real-tmux predicates cannot be verified"
  exit 0
fi
if ! command -v lsof >/dev/null 2>&1; then
  echo "[SKIP] lsof not installed; real-tmux predicates cannot be verified"
  exit 0
fi
if ! ps axww -o uid= -o pid= -o ppid= -o command= >/dev/null 2>&1; then
  echo "[SKIP] process inspection is unavailable; real-tmux classification cannot be verified"
  exit 0
fi

# The full suite must run on both macOS and Linux CI. The macOS-only
# /tmp -> /private/tmp normalization case gets its own Darwin-scoped root below.
PORTABLE_TMP="${TMPDIR:-/tmp}"
[ -d "$PORTABLE_TMP" ] || PORTABLE_TMP=/tmp
BASE="$(mktemp -d "$PORTABLE_TMP/fly1285-realtmux.XXXXXX")" || exit 1
SYM_BASE=""

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "  ✓ $*"; }
fail() { FAILED=$((FAILED + 1)); echo "  ✗ $*" >&2; }

SPAWNED=""
cleanup() {
  # Reap every server whose argv references this run's private base dir. This has
  # to catch servers the library itself spawned (the hijack case), not just the
  # ones we started — and it must run BEFORE the base dir is removed, otherwise
  # the sockets vanish and the servers survive as unkillable-by-socket orphans.
  # Match on the unique base DIRECTORY NAME, not the full path: the symlinked
  # case runs servers whose argv says /tmp/... while $BASE says /private/tmp/...
  local extra base_name
  base_name="${BASE##*/}"
  extra="$(ps axww -o pid=,command= 2>/dev/null | grep -F "$base_name" | grep -v grep | awk '{print $1}')"
  for p in $SPAWNED $extra; do
    kill -CONT "$p" 2>/dev/null
    kill -9 "$p" 2>/dev/null
  done
  rm -rf "$BASE"
  [ -z "$SYM_BASE" ] || rm -rf "$SYM_BASE"
}
trap cleanup EXIT

# shellcheck source=../lib/tmux-server-rescue.sh
source "$LIB"

server_pid_on() { tmux -S "$1" display-message -p '#{pid}' 2>/dev/null; }
socket_inode() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%i' "$1"
  else
    stat -c '%i' "$1"
  fi
}

start_server() { # <socket> -> echoes pid
  local sock="$1" pid
  tmux -S "$sock" new-session -d -s live 'sleep 120' 2>/dev/null
  pid="$(server_pid_on "$sock")"
  printf '%s' "$pid"
}

echo "[TEST] policy-enforce keeps a server alive after its last business session exits"
SOCK_KEEP="$BASE/keepalive-on.sock"
PID_KEEP="$(start_server "$SOCK_KEEP")"
SPAWNED="$SPAWNED $PID_KEEP"
POLICY_KEEP="$(tmux_socket_policy_enforce "$SOCK_KEEP")"
POLICY_KEEP_RC=$?
PID_KEEP_AFTER_POLICY="$(server_pid_on "$SOCK_KEEP")"
OPTION_KEEP="$(tmux -S "$SOCK_KEEP" show-options -sv exit-empty 2>/dev/null)"
tmux -S "$SOCK_KEEP" kill-session -t =live 2>/dev/null
sleep 0.2
PID_KEEP_AFTER_KILL="$(server_pid_on "$SOCK_KEEP")"
if [ "$POLICY_KEEP_RC" -eq 0 ] \
  && [ "$(_tmux_rescue_json_field "$POLICY_KEEP" action)" = "policy_enforced" ] \
  && [ "$PID_KEEP_AFTER_POLICY" = "$PID_KEEP" ] \
  && [ "$OPTION_KEEP" = "off" ] \
  && tmux -S "$SOCK_KEEP" has-session -t =flywheel-keepalive 2>/dev/null \
  && [ "$PID_KEEP_AFTER_KILL" = "$PID_KEEP" ]; then
  pass "exit-empty off plus the sentinel preserve the same server generation"
else
  fail "keepalive policy failed: rc=$POLICY_KEEP_RC out=$POLICY_KEEP pid=$PID_KEEP/$PID_KEEP_AFTER_POLICY/$PID_KEEP_AFTER_KILL option=$OPTION_KEEP"
fi

echo "[TEST] a real daemonized tmux server is recognized as a server candidate"
SOCK_A="$BASE/recognize.sock"
PID_A="$(start_server "$SOCK_A")"
SPAWNED="$SPAWNED $PID_A"
if [ -z "$PID_A" ]; then
  fail "could not start an isolated tmux server; environment cannot host this test"
else
  # ppid==1 is the daemonized-server precondition the scan relies on
  PPID_A="$(ps -o ppid= -p "$PID_A" 2>/dev/null | tr -d ' ')"
  [ "$PPID_A" = "1" ] || echo "    (note: server ppid=$PPID_A, expected 1)"
  # Capture the scan output BEFORE grepping. Piping the scan straight into
  # `grep -q` makes grep exit on first match, SIGPIPEs the scan's while-loop,
  # and `set -o pipefail` then reports the whole pipeline as rc=141 — a false
  # "blind scan" verdict even when the pid is present.
  SCAN_OUT="$(_tmux_rescue_server_pids)"
  if printf '%s\n' "$SCAN_OUT" | grep -qx "$PID_A"; then
    pass "server scan sees the live server (pid=$PID_A)"
  else
    fail "server scan is BLIND to a real tmux server (pid=$PID_A, command: $(ps -p "$PID_A" -o command= 2>/dev/null))"
  fi
fi

echo "[TEST] a real server is recognized as the owner of its socket"
if _tmux_rescue_pid_has_socket "$PID_A" "$(_tmux_rescue_normalize_socket "$SOCK_A")"; then
  pass "lsof ownership predicate matches the real socket path"
else
  fail "lsof ownership predicate does NOT match; lsof reports: $(lsof -a -p "$PID_A" -U -Fn 2>/dev/null | grep '^n' | head -1)"
fi

echo "[TEST] ownership survives a socket path that traverses a symlink"
# /tmp is a symlink to /private/tmp on macOS. The library normalizes the request
# to /private/tmp/... while lsof reports the path as tmux bound it. An exact
# string compare between the two silently returns "not the owner" — which is
# read as positive proof of absence, not as missing evidence.
if [ "$(uname -s)" = "Darwin" ]; then
  SYM_BASE="$(mktemp -d /tmp/fly1285-realtmux-symlink.XXXXXX)" || exit 1
  SOCK_SYM="$SYM_BASE/symlinked.sock"
  PID_SYM="$(start_server "$SOCK_SYM")"
  SPAWNED="$SPAWNED $PID_SYM"
  if [ -n "$PID_SYM" ]; then
    if _tmux_rescue_pid_has_socket "$PID_SYM" "$(_tmux_rescue_normalize_socket "$SOCK_SYM")"; then
      pass "ownership predicate is robust to /tmp -> /private/tmp normalization"
    else
      fail "ownership predicate breaks on a symlinked socket path (normalized=$(_tmux_rescue_normalize_socket "$SOCK_SYM") vs lsof=$(lsof -a -p "$PID_SYM" -U -Fn 2>/dev/null | grep '^n' | head -1))"
    fi
  fi
else
  echo "  (skip: /tmp -> /private/tmp normalization is macOS-only)"
fi

echo "[TEST] a reachable server yields the reachable verdict with no orphan candidates"
V="$(tmux_socket_inspect "$SOCK_A")"
if [ "$(_tmux_rescue_json_field "$V" verdict)" = "reachable" ] \
  && [ "$(_tmux_rescue_json_field "$V" reachablePid)" = "$PID_A" ]; then
  pass "reachable verdict binds the real server generation"
else
  fail "reachable verdict wrong: $V"
fi

echo "[TEST] a killed server's stale socket is proven dead and replaced"
SOCK_D="$BASE/dead.sock"
PID_D="$(start_server "$SOCK_D")"
SPAWNED="$SPAWNED $PID_D"
DEAD_INODE_BEFORE="$(socket_inode "$SOCK_D")"
kill -9 "$PID_D"
for _ in $(seq 1 100); do
  kill -0 "$PID_D" 2>/dev/null || break
  sleep 0.05
done
if [ ! -S "$SOCK_D" ]; then
  fail "SIGKILL did not leave the stale socket inode required by this regression"
else
  VD="$(tmux_socket_inspect "$SOCK_D")"
  VERDICT_D="$(_tmux_rescue_json_field "$VD" verdict)"
  ENS_D="$(tmux_socket_ensure "$SOCK_D" \
    --verify tmux -S "$SOCK_D" has-session -t =live \
    --create tmux -S "$SOCK_D" new-session -Ad -s live)"
  ENS_D_RC=$?
  DEAD_INODE_AFTER="$(socket_inode "$SOCK_D" 2>/dev/null || echo GONE)"
  PID_D_AFTER="$(server_pid_on "$SOCK_D")"
  VD_AFTER="$(tmux_socket_inspect "$SOCK_D")"
  SPAWNED="$SPAWNED $PID_D_AFTER"
  if [ "$VERDICT_D" = "dead" ] \
    && [ "$ENS_D_RC" -eq 0 ] \
    && [ "$(_tmux_rescue_json_field "$ENS_D" action)" = "created" ] \
    && [ -n "$PID_D_AFTER" ] \
    && [ "$PID_D_AFTER" != "$PID_D" ] \
    && [ "$(_tmux_rescue_json_field "$VD_AFTER" verdict)" = "reachable" ] \
    && [ "$(_tmux_rescue_json_field "$VD_AFTER" reachablePid)" = "$PID_D_AFTER" ] \
    && _tmux_rescue_pid_has_socket "$PID_D_AFTER" "$(_tmux_rescue_normalize_socket "$SOCK_D")"; then
    pass "zero-owner stale inode classifies dead and the path is rebound to a verified server"
  else
    fail "dead-server cleanup regressed: before=$VD ensure=$ENS_D_RC/$ENS_D after=$VD_AFTER inode=$DEAD_INODE_BEFORE->$DEAD_INODE_AFTER pid=$PID_D->$PID_D_AFTER"
  fi
fi

echo "[TEST] THE INCIDENT: a live-but-saturated server must hold, never be replaced"
# Reproduce FLY-1285: SIGSTOP the server so it stops accepting, then fill the
# 128-deep listen backlog so connect() is refused. tmux then reports "no server
# running" even though the server is alive — and an unguarded new-session would
# unlink the socket and fork a second server, orphaning every window.
SOCK_S="$BASE/saturated.sock"
PID_S="$(start_server "$SOCK_S")"
SPAWNED="$SPAWNED $PID_S"
INODE_BEFORE="$(socket_inode "$SOCK_S")"
kill -STOP "$PID_S"
/usr/bin/python3 - "$SOCK_S" "$BASE/filled" <<'PY' &
import socket, sys, time
sock_path, report = sys.argv[1], sys.argv[2]
held = []
for _ in range(400):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(0.25)
    try:
        s.connect(sock_path)
        held.append(s)
    except Exception:
        break
with open(report, "w") as fh:
    fh.write(str(len(held)))
time.sleep(120)   # hold the queue saturated while the library inspects
PY
FILLER_PID=$!
SPAWNED="$SPAWNED $FILLER_PID"
for _ in $(seq 1 100); do [ -s "$BASE/filled" ] && break; sleep 0.1; done

VS="$(tmux_socket_inspect "$SOCK_S")"
VERDICT_S="$(_tmux_rescue_json_field "$VS" verdict)"
if [ "$VERDICT_S" = "saturated" ]; then
  pass "live-but-unreachable server classifies as saturated"
else
  fail "saturated server misclassified as '$VERDICT_S' (a 'dead' verdict authorizes a replacing create): $VS"
fi

ENS="$(tmux_socket_ensure "$SOCK_S" \
  --verify tmux -S "$SOCK_S" has-session -t =live \
  --create tmux -S "$SOCK_S" new-session -Ad -s live)"
ENS_RC=$?
INODE_AFTER="$(socket_inode "$SOCK_S" 2>/dev/null || echo GONE)"
kill -CONT "$PID_S" 2>/dev/null
if [ "$ENS_RC" -eq 2 ] && [ "$INODE_BEFORE" = "$INODE_AFTER" ]; then
  pass "ensure holds (rc=2) and the live server's socket is never replaced"
else
  fail "FLY-1285 REPRODUCED: ensure rc=$ENS_RC (want 2), socket inode $INODE_BEFORE -> $INODE_AFTER, result: $ENS"
fi

echo
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
