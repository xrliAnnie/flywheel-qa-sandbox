#!/bin/bash
# FLY-2274: the six reviewed phase-b Homebrew/link assertions.
set -Eeuo pipefail

CURRENT_ITEM="initialization"
phase_b_failed() {
  local rc=$?
  trap - ERR
  printf 'phase-b-link: FAIL item=%s rc=%s\n' "$CURRENT_ITEM" "$rc" >&2
  exit "$rc"
}
trap phase_b_failed ERR

CURRENT_ITEM="brew-link"
/opt/homebrew/bin/brew link tmux

CURRENT_ITEM="brew-pin"
/opt/homebrew/bin/brew pin tmux

CURRENT_ITEM="realpath"
test "$(python3 -c 'import os; print(os.path.realpath("/opt/homebrew/bin/tmux"))')" \
  = '/opt/homebrew/Cellar/tmux/3.7c/bin/tmux'

CURRENT_ITEM="version"
test "$(/opt/homebrew/bin/tmux -V)" = 'tmux 3.7c'

CURRENT_ITEM="architecture"
file -b /opt/homebrew/Cellar/tmux/3.7c/bin/tmux | grep -F arm64

CURRENT_ITEM="pinned"
/opt/homebrew/bin/brew list --pinned | grep -Fx tmux

trap - ERR
printf '{"status":"pass","items":6}\n'
