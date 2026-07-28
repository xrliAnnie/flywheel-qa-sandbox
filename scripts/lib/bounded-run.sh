#!/usr/bin/env bash
# Run a command with a hard time bound, then make sure nothing it started
# outlives it. Executable, not sourced: callers are launchd-supervised wrappers,
# and a `source` would couple them to this file's shell state and path layout.
#
# FLY-1501 QA. The restart brake's "brake is missing" alert has to be delivered
# from inside a launch path, which makes both failure directions unacceptable:
#   * unbounded — a hung osascript inside meta-alert.sh pins the wrapper, so
#     launchd never retries the service once the brake is restored;
#   * detached — launchd kills a job's remaining process group on exit unless
#     AbandonProcessGroup is set (none of these plists set it), so a
#     backgrounded notifier can die before writing its marker, which restores
#     the silence the alert exists to remove.
# Bounded-and-synchronous is the only shape that satisfies both.
#
# Usage: bounded-run.sh <timeout_seconds> <command> [args...]
# Exit:  the command's status, or 124 if it was killed on timeout.
#        A caller that treats delivery as best-effort should append `|| true`.
set -uo pipefail

DEFAULT_TIMEOUT_S=15

if [ "$#" -lt 2 ]; then
  echo "usage: bounded-run.sh <timeout_seconds> <command> [args...]" >&2
  exit 2
fi

timeout_s="$1"
shift

# A malformed bound must not silently disable the bound. `sleep` rejecting its
# argument would end the watchdog early and leave the caller blocked forever, so
# anything that is not a positive integer falls back to the default.
case "$timeout_s" in
  '' | *[!0-9]*) timeout_s="$DEFAULT_TIMEOUT_S" ;;
  0) timeout_s="$DEFAULT_TIMEOUT_S" ;;
esac

# Job control puts the child in its own process group, so the watchdog can take
# down the whole tree. Killing only the direct child would orphan its
# descendants — meta-alert.sh's osascript is exactly such a descendant.
set -m

"$@" &
child_pid=$!

terminate_tree() {
  # Negative PID targets the process group. Fall back to the bare pid in case
  # the group is already gone.
  kill -TERM -- "-${child_pid}" 2>/dev/null ||
    kill -TERM "$child_pid" 2>/dev/null || true
  # Give it a moment to leave, then insist.
  sleep 1
  kill -KILL -- "-${child_pid}" 2>/dev/null ||
    kill -KILL "$child_pid" 2>/dev/null || true
}

( sleep "$timeout_s" && terminate_tree ) >/dev/null 2>&1 &
watchdog_pid=$!

wait "$child_pid" 2>/dev/null
status=$?

# Reap the watchdog and its own sleep, so this helper leaves nothing behind.
kill -TERM -- "-${watchdog_pid}" 2>/dev/null ||
  kill -TERM "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true

# 143/137 here mean the watchdog fired; report the conventional timeout status.
if [ "$status" -eq 143 ] || [ "$status" -eq 137 ]; then
  exit 124
fi
exit "$status"
