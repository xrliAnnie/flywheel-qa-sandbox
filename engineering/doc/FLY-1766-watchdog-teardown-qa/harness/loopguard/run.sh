#!/usr/bin/env bash
# FLY-1766 QA A1: real-process proof that BridgeEventLoopGuard turns a wedged
# main loop into a SIGKILL (= launchd-restartable crash).
set -uo pipefail
SP="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$SP/frozen-838/node_modules/.bin/tsx"
run() {
  local mode="$1"; shift
  local log="/tmp/qa1766-loopguard-$mode.log"; : > "$log"
  local out; out="$(mktemp)"
  ( cd "$SP/frozen-838" && env "$@" TMPDIR=/tmp/ "$TSX" "$SP/loopguard/child.ts" "$mode" "$log" >"$out" 2>&1 )
  local rc=$?
  local sig="-"
  (( rc > 128 )) && sig="$(kill -l $(( rc - 128 )) 2>/dev/null || echo "?")"
  printf '%-11s | rc=%-3s signal=%-8s | stdout=%s | guardlog=%s\n' \
    "$mode" "$rc" "$sig" "$(tr '\n' ' ' < "$out")" "$(tr '\n' ' ' < "$log" | cut -c1-160)"
  rm -f "$out"
}
run stall
run healthy
run killswitch FLYWHEEL_BRIDGE_LOOP_GUARD=0
