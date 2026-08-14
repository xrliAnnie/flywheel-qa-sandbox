#!/bin/bash
# FLY-1751: reclaim a Lead's previous session batches after /clear.
# Session birth is always fail-open; adoption requires every identity anchor.
set -uo pipefail

input="$(head -c 65536 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0

parsed="$(printf '%s' "$input" | jq -er '
  select(.hook_event_name == "SessionStart")
  | [.source, .agent_type]
  | select(all(.[]; type == "string" and length > 0))
  | @tsv
' 2>/dev/null || true)"
[ -n "$parsed" ] || exit 0

IFS=$'\t' read -r source agent_type <<< "$parsed"
[ "$source" = "clear" ] || exit 0

lead_id="${LEAD_ID:-}"
flywheel_lead_id="${FLYWHEEL_LEAD_ID:-}"
[ -n "$lead_id" ] || exit 0
[ "$agent_type" = "$lead_id" ] || exit 0
[ "$lead_id" = "$flywheel_lead_id" ] || exit 0

comm_cli="${FLYWHEEL_COMM_CLI:-}"
[ -n "$comm_cli" ] && [ -f "$comm_cli" ] || exit 0
[ -n "${FLYWHEEL_COMM_DB:-}" ] || exit 0

output=""
rc=0
output="$(node "$comm_cli" adopt-inflight \
  --recipient "$lead_id" --kind lead 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  printf '[session-start-adopt-inflight] adopt-inflight failed (exit %s): %s\n' \
    "$rc" "$output" >&2
  exit 0
fi

adopted="$(printf '%s\n' "$output" \
  | sed -n 's/^adopted: \([0-9][0-9]*\)$/\1/p' \
  | head -1)"
if [ -z "$adopted" ]; then
  [ -z "$output" ] || printf \
    '[session-start-adopt-inflight] unexpected adopt-inflight output: %s\n' \
    "$output" >&2
  exit 0
fi

if [ "$adopted" -gt 0 ]; then
  printf '[adopt-inflight] 已把上一现场的 %s 条在途消息重新排队，稍后将重投本会话（注意 [lead-instruction <id>] 幂等：已处理过的指令不要重做）\n' \
    "$adopted"
fi
exit 0
