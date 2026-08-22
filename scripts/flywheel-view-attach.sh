#!/bin/bash
# Keep one cmux surface attached across Flywheel view-session rebuilds.
#
# This process is deliberately only a display carrier. The authoritative tmux
# session belongs to the runner lifecycle, and this helper must never create,
# rename, or destroy it. cmux can therefore keep the same workspace command
# alive while the mirror session disappears and is recreated under the same
# exact name. A missing target is rendered as a visible waiting state; a clean
# detach is retried after a short delay. The exact-name form (`=name`) prevents
# tmux prefix matching from attaching a founder tab to the wrong runner.
#
# FLYWHEEL_CMUX_ATTACH_TMUX_BIN is an installation/test seam. Production uses
# the system tmux selected by PATH; a deployment may pin an absolute binary so
# the persisted cmux command remains independent of the launching shell's PATH.
set -u

if [[ $# -ne 1 && $# -ne 2 ]]; then
  echo "Usage: flywheel-view-attach <view-session-name> [fwtok1-<32hex>]" >&2
  exit 64
fi
SESSION="$1"
TOKEN="${2:-}"
case "$SESSION" in cmux-*) ;; *) echo "[view-attach] refusing non-view session" >&2; exit 64 ;; esac
case "$SESSION" in *"'"*|*$'\n'*|*$'\r'*) echo "[view-attach] unsafe session name" >&2; exit 64 ;; esac
if [[ -n "$TOKEN" && ! "$TOKEN" =~ ^fwtok1-[0-9a-f]{32}$ ]]; then
  echo "[view-attach] invalid instance token" >&2
  exit 64
fi

TMUX_BIN="${FLYWHEEL_CMUX_ATTACH_TMUX_BIN:-tmux}"
unset TMUX TMUX_PANE
stopping=0
trap 'stopping=1' INT TERM HUP
while [[ "$stopping" == "0" ]]; do
  if "$TMUX_BIN" has-session -t "=${SESSION}" 2>/dev/null; then
    "$TMUX_BIN" attach-session -t "=${SESSION}" || true
  else
    clear 2>/dev/null || printf '\033[2J\033[H'
    printf '[flywheel] 视图 %s 暂不存在 — 已断开,等待重建后自动重连…\n' "$SESSION"
  fi
  [[ "$stopping" == "0" ]] || break
  sleep 2
done
