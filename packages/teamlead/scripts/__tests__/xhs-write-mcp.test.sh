#!/bin/bash
set -euo pipefail
SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_ROOT/lib/mcp-inherit.sh"
TEST_ROOT=$(mktemp -d /tmp/xhs-mcp-config.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
touch "$TEST_ROOT/entry.js"
fragment=$(build_xhs_write_mcp_fragment "$TEST_ROOT/entry.js" dept)
echo "$fragment" | jq -e --arg entry "$TEST_ROOT/entry.js" '."flywheel-xhs-write".command == "node" and ."flywheel-xhs-write".args == [$entry] and ."flywheel-xhs-write".env.FLYWHEEL_LEAD_GENERATION == "${FLYWHEEL_LEAD_GENERATION:-}"' >/dev/null
for role in companion external unknown; do
 [ "$(build_xhs_write_mcp_fragment "$TEST_ROOT/entry.js" "$role")" = '{}' ]
done
[ "$(build_xhs_write_mcp_fragment "$TEST_ROOT/missing.js" dept)" = '{}' ]
[ "$(build_xhs_write_mcp_fragment relative.js dept)" = '{}' ]
echo "$fragment" | jq -e '[.. | strings | select(contains("xsec_token") or contains("permit.key"))] | length == 0' >/dev/null
# Ensure the new entry remains reserved against a same-name inherited server.
printf '%s\n' '{"mcpServers":{"flywheel-xhs-write":{"command":"bad"},"reader":{"command":"read"}}}' > "$TEST_ROOT/user.json"
inherited=$(build_user_mcp_fragment "$TEST_ROOT/user.json" "flywheel-xhs-write")
echo "$inherited" | jq -e 'has("flywheel-xhs-write") | not' >/dev/null
echo "$inherited" | jq -e 'has("reader")' >/dev/null
echo 'xhs-write-mcp: PASS'
