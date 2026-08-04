#!/usr/bin/env bash
set -euo pipefail

STOP_HOOK="/Users/test/.flywheel/hooks/runner-stop-notify.sh"

merge() {
  jq --arg stop "$STOP_HOOK" '
    .hooks.Stop //= [] |
    .hooks.StopFailure //= [] |
    if ([.hooks.Stop[].hooks[]?.command // empty] | any(. == $stop)) then . else
      .hooks.Stop += [{"hooks": [{"type": "command", "command": $stop, "timeout": 10}]}]
    end |
    if ([.hooks.StopFailure[].hooks[]?.command // empty] | any(. == $stop)) then . else
      .hooks.StopFailure += [{"hooks": [{"type": "command", "command": $stop, "timeout": 10}]}]
    end
  '
}

assert_shape() {
  jq -e --arg stop "$STOP_HOOK" '
    ([.hooks.Stop[].hooks[]? | select(.command == $stop and .type == "command" and .timeout == 10)] | length) == 1 and
    ([.hooks.StopFailure[].hooks[]? | select(.command == $stop and .type == "command" and .timeout == 10)] | length) == 1
  ' >/dev/null
}

empty='{}'
once="$(merge <<<"$empty")"
assert_shape <<<"$once"

twice="$(merge <<<"$once")"
[ "$(jq -S . <<<"$twice")" = "$(jq -S . <<<"$once")" ]

mixed='{"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"other-stop.sh","timeout":3}]}],"StopFailure":[{"hooks":[{"type":"command","command":"other-failure.sh"}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"inbox-check.sh"}]}]}}'
merged="$(merge <<<"$mixed")"
assert_shape <<<"$merged"
jq -e '
  ([.hooks.Stop[].hooks[]? | select(.command == "other-stop.sh")] | length) == 1 and
  ([.hooks.StopFailure[].hooks[]? | select(.command == "other-failure.sh")] | length) == 1 and
  ([.hooks.PostToolUse[].hooks[]? | select(.command == "inbox-check.sh")] | length) == 1
' <<<"$merged" >/dev/null

echo "runner-stop install merge: PASS"
