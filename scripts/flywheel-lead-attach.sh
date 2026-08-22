#!/bin/bash
# FLY-1663 display-only helper: keep one cmux surface attached to one private
# Lead server across launchd kickstarts. It never starts, stops, or judges the
# Lead; launchd remains the sole lifecycle owner.
#
# Why this is a loop instead of a one-shot `tmux attach`: a cmux workspace is
# durable across Lead kickstarts, while the private tmux server deliberately is
# not. When launchd replaces that server, tmux disconnects the client and a
# one-shot command would leave the founder staring at a dead login shell. This
# helper waits two seconds and attaches again. It has no process census, PID
# file, lease, lock, timeout budget, or restart decision; its only observable
# side effect is one display client. TERM/HUP/INT from cmux stops the loop, so
# closing the workspace does not leave a background reconnect process behind.
set -u

if [[ $# -ne 1 && $# -ne 2 ]]; then
  printf 'Usage: flywheel-lead-attach <absolute-socket-path> [fwtok1-<32hex>]\n' >&2
  exit 64
fi
SOCKET_PATH="$1"
TOKEN="${2:-}"
case "$SOCKET_PATH" in
  /*) ;;
  *) printf '[lead-attach] absolute socket path required\n' >&2; exit 64 ;;
esac
case "$SOCKET_PATH" in
  *"'"*|*$'\n'*|*$'\r'*) printf '[lead-attach] unsafe socket path\n' >&2; exit 64 ;;
esac
if [[ -n "$TOKEN" && ! "$TOKEN" =~ ^fwtok1-[0-9a-f]{32}$ ]]; then
  printf '[lead-attach] invalid instance token\n' >&2
  exit 64
fi

unset TMUX TMUX_PANE
stopping=0
trap 'stopping=1' INT TERM HUP
while [[ "$stopping" == "0" ]]; do
  tmux -S "$SOCKET_PATH" attach-session -t "=main" || true
  [[ "$stopping" == "0" ]] || break
  sleep 2
done
