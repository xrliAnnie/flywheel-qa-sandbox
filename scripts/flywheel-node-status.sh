#!/bin/bash
# Render one Flywheel node state file inside a cmux workspace.
#
# The status file is written atomically by the cmux reconciler. This helper is
# intentionally read-only: it has no authority over runner lifecycle, tmux, or
# the cmux workspace. Keeping the reader separate lets the workspace survive
# normal state changes without embedding volatile status text in its launch
# command. It also gives remote-control, parked, waiting-for-rebirth, and recent
# terminal nodes the same stable visible surface.
#
# Polling is bounded and dependency-free. A temporarily missing file produces
# an explicit waiting message instead of a blank terminal, and the next tick
# naturally observes an atomic replacement. Exact absolute-path validation
# keeps persisted cmux commands deterministic and rejects shell-shaped input.
set -u

if [[ $# -ne 1 || "$1" != /* ]]; then
  echo "Usage: flywheel-node-status <absolute-status-file>" >&2
  exit 64
fi
STATUS_FILE="$1"
case "$STATUS_FILE" in *"'"*|*$'\n'*|*$'\r'*) echo "[node-status] unsafe status path" >&2; exit 64 ;; esac

stopping=0
trap 'stopping=1' INT TERM HUP
while [[ "$stopping" == "0" ]]; do
  clear 2>/dev/null || printf '\033[2J\033[H'
  if [[ -r "$STATUS_FILE" ]]; then
    cat "$STATUS_FILE"
  else
    printf '[flywheel] 节点状态暂不可用 — 等待状态同步…\n'
  fi
  [[ "$stopping" == "0" ]] || break
  sleep 2
done
