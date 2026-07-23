#!/usr/bin/env bash
# Capture only the slot-1 process command column; never capture process env.
set -euo pipefail

output="${1:?usage: capture-slot-processes.sh OUTPUT}"
slot_plugin="/tmp/flywheel-test-slot-1/claude-config/plugins/"
repo_path="/Users/xiaorongli/Dev/flywheel-FLY-1439/"
tmp="${output}.$$"
trap 'rm -f "$tmp"' EXIT

{
  printf '[tmux]\n'
  tmux list-windows -t flywheel \
    -F '#{session_name}:#{window_id} name=#{window_name} pane_pid=#{pane_pid}' |
    grep -E 'test-slot-1|fly1439-slot-bridge' || true
  printf '[processes]\n'
  ps axww -o pid=,ppid=,command= |
    awk -v plugin="$slot_plugin" -v repo="$repo_path" '
      (index($0, plugin) || index($0, repo)) &&
      !/capture-slot-processes[.]sh/ &&
      !/awk -v plugin=/
    '
} >"$tmp"

mv "$tmp" "$output"
trap - EXIT
