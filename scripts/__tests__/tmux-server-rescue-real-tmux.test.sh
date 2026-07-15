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

# Use a /private-rooted base so path normalization is the identity. This mirrors
# the production default socket (/private/tmp/tmux-<uid>/default), which tmux
# itself resolves to a /private path.
BASE="$(mktemp -d /private/tmp/fly1285-realtmux.XXXXXX)" || exit 1

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
}
trap cleanup EXIT

# shellcheck source=../lib/tmux-server-rescue.sh
source "$LIB"

server_pid_on() { tmux -S "$1" display-message -p '#{pid}' 2>/dev/null; }

start_server() { # <socket> -> echoes pid
  local sock="$1" pid
  tmux -S "$sock" new-session -d -s live 2>/dev/null
  pid="$(server_pid_on "$sock")"
  SPAWNED="$SPAWNED $pid"
  printf '%s' "$pid"
}

echo "[TEST] a real daemonized tmux server is recognized as a server candidate"
SOCK_A="$BASE/recognize.sock"
PID_A="$(start_server "$SOCK_A")"
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
SYM_BASE="/tmp/${BASE#/private/tmp/}"
if [ -e "$SYM_BASE" ]; then
  SOCK_SYM="$SYM_BASE/symlinked.sock"
  PID_SYM="$(start_server "$SOCK_SYM")"
  if [ -n "$PID_SYM" ]; then
    if _tmux_rescue_pid_has_socket "$PID_SYM" "$(_tmux_rescue_normalize_socket "$SOCK_SYM")"; then
      pass "ownership predicate is robust to /tmp -> /private/tmp normalization"
    else
      fail "ownership predicate breaks on a symlinked socket path (normalized=$(_tmux_rescue_normalize_socket "$SOCK_SYM") vs lsof=$(lsof -a -p "$PID_SYM" -U -Fn 2>/dev/null | grep '^n' | head -1))"
    fi
  fi
else
  echo "  (skip: $SYM_BASE not reachable via symlink)"
fi

echo "[TEST] a reachable server yields the reachable verdict with no orphan candidates"
V="$(tmux_socket_inspect "$SOCK_A")"
if [ "$(_tmux_rescue_json_field "$V" verdict)" = "reachable" ] \
  && [ "$(_tmux_rescue_json_field "$V" reachablePid)" = "$PID_A" ]; then
  pass "reachable verdict binds the real server generation"
else
  fail "reachable verdict wrong: $V"
fi

echo "[TEST] THE INCIDENT: a live-but-saturated server must hold, never be replaced"
# Reproduce FLY-1285: SIGSTOP the server so it stops accepting, then fill the
# 128-deep listen backlog so connect() is refused. tmux then reports "no server
# running" even though the server is alive — and an unguarded new-session would
# unlink the socket and fork a second server, orphaning every window.
SOCK_S="$BASE/saturated.sock"
PID_S="$(start_server "$SOCK_S")"
INODE_BEFORE="$(stat -f '%i' "$SOCK_S" 2>/dev/null || stat -c '%i' "$SOCK_S" 2>/dev/null)"
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
INODE_AFTER="$(stat -f '%i' "$SOCK_S" 2>/dev/null || stat -c '%i' "$SOCK_S" 2>/dev/null || echo GONE)"
kill -CONT "$PID_S" 2>/dev/null
if [ "$ENS_RC" -eq 2 ] && [ "$INODE_BEFORE" = "$INODE_AFTER" ]; then
  pass "ensure holds (rc=2) and the live server's socket is never replaced"
else
  fail "FLY-1285 REPRODUCED: ensure rc=$ENS_RC (want 2), socket inode $INODE_BEFORE -> $INODE_AFTER, result: $ENS"
fi

echo
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
