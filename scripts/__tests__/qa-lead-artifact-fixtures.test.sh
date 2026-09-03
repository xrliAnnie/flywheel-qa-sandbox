#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-artifacts.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
FIXTURES="$ROOT/scripts/__tests__/fixtures/fly2301"
passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }
log() { printf '[fixture] %s\n' "$*" >&2; }

# shellcheck source=../lib/qa-multilead.sh
source "$ROOT/scripts/lib/qa-multilead.sh"
# shellcheck source=../lib/qa-lead-artifacts.sh
source "$ROOT/scripts/lib/qa-lead-artifacts.sh"

expected_env='{"DISCORD_GUILD_ID":"guild-1","BRIDGE_URL":"http://localhost:4242","AGENT_SOURCE":"/tmp/flywheel-test-slot-7/test-identity.md","TEAMLEAD_API_TOKEN":"","FLYWHEEL_PROJECTS_FILE":"/tmp/flywheel-test-slot-7/q/7/projects.json","TEAMLEAD_DB_PATH":"/tmp/flywheel-test-slot-7/teamlead.db","FLYWHEEL_STATE_DIR":"/tmp/flywheel-test-slot-7/q/7","FLYWHEEL_WRAPPER_ENV_FILE":"/tmp/flywheel-test-slot-7/q/7/.env","FLYWHEEL_DELIVERY_SECRET_PATH":"/tmp/flywheel-test-slot-7/state/delivery-secret","LEAD_WORKSPACE":"/tmp/flywheel-test-slot-7/lead-workspace"}'
actual_env=$(qa_slot_launch_env_json \
  'DISCORD_GUILD_ID=guild-1' \
  'BRIDGE_URL=http://localhost:4242' \
  'AGENT_SOURCE=/tmp/flywheel-test-slot-7/test-identity.md' \
  'TEAMLEAD_API_TOKEN=' \
  'FLYWHEEL_PROJECTS_FILE=/tmp/flywheel-test-slot-7/q/7/projects.json' \
  'TEAMLEAD_DB_PATH=/tmp/flywheel-test-slot-7/teamlead.db' \
  'FLYWHEEL_STATE_DIR=/tmp/flywheel-test-slot-7/q/7' \
  'FLYWHEEL_WRAPPER_ENV_FILE=/tmp/flywheel-test-slot-7/q/7/.env' \
  'FLYWHEEL_DELIVERY_SECRET_PATH=/tmp/flywheel-test-slot-7/state/delivery-secret' \
  'LEAD_WORKSPACE=/tmp/flywheel-test-slot-7/lead-workspace')
if [[ "$actual_env" == "$expected_env" ]]; then
  pass "Claude launch environment remains byte-identical to the frozen baseline"
else
  fail "Claude launch environment byte baseline"
fi

env_file="$TMP/.env"
if qa_lead_write_env "$env_file" TEST_BOT_TOKEN_7 "tok'en with spaces" \
    && cmp -s "$FIXTURES/claude-lead.env" "$env_file"; then
  pass "Claude wrapper environment remains byte-identical to the frozen baseline"
else
  fail "Claude wrapper environment byte baseline"
fi

manifest="$TMP/manifest.json"
if qa_lead_write_manifest "$manifest" flywheel-test-7 \
    /tmp/flywheel-test-slot-7/project-slot-7 test-slot-7 \
    /tmp/flywheel-test-slot-7/q/7/projects.json \
    /tmp/flywheel-test-slot-7/lead-workspace '' "$actual_env" \
    && cmp -s "$FIXTURES/claude-lead-manifest.json" "$manifest"; then
  pass "Claude per-Lead manifest remains byte-identical to the frozen baseline"
else
  fail "Claude per-Lead manifest byte baseline"
fi

launch_manifest="$TMP/launch-manifest.json"
if qa_lead_write_launch_manifest "$launch_manifest" 1234 deadbeef main slot \
    '' '' '[]' launchd-v2 \
    /tmp/flywheel-test-slot-7/launchd-leads.json \
    com.flywheel.qa.lead.slot-7.flywheel-test-7 /tmp/flywheel-test-7.sock \
    && cmp -s "$FIXTURES/claude-launch-manifest.json" "$launch_manifest"; then
  pass "Claude launch manifest remains byte-identical to the frozen baseline"
else
  fail "Claude launch manifest byte baseline"
fi

stdout_json="$TMP/stdout.json"
if qa_lead_render_stdout_json \
    7 slot false '' 4242 flywheel-test-7 test-slot-7 channel-7 TEST_BOT_TOKEN_7 \
    1234 /tmp/flywheel-test-slot-7/launchd/flywheel-test-7/pid launchd-v2 \
    com.flywheel.qa.lead.slot-7.flywheel-test-7 /tmp/flywheel-test-7.sock \
    /tmp/flywheel-test-slot-7/launchd-leads.json /tmp/flywheel-test-slot-7 main \
    xrliAnnie/flywheel-qa-sandbox /tmp/flywheel-test-slot-7/project-slot-7 \
    qa-slot-7 deadbeef origin/main /tmp/flywheel-test-slot-7/teamlead.db \
    /tmp/flywheel-test-slot-7/bridge.log /tmp/flywheel-test-slot-7/bridge-launch.json \
    /tmp/flywheel-test-slot-7/lead.log /tmp/flywheel-test-slot-7/flywheel-projects.json \
    /tmp/flywheel-test-slot-7/launch-manifest.json '' '' '' '[]' '' \
    > "$stdout_json" \
    && cmp -s "$FIXTURES/claude-stdout.json" "$stdout_json"; then
  pass "Claude deploy stdout remains byte-identical to the frozen baseline"
else
  fail "Claude deploy stdout byte baseline"
fi

launch_log=$(qa_lead_log_launchd_label \
  com.flywheel.qa.lead.slot-7.flywheel-test-7 /tmp/flywheel-test-7.sock)
extra_log=$(qa_lead_log_extra_pid flywheel-test-8 5678)
if [[ "$launch_log" == 'Lead launchd label: com.flywheel.qa.lead.slot-7.flywheel-test-7; private socket: /tmp/flywheel-test-7.sock' ]] \
    && [[ "$extra_log" == 'Extra Lead flywheel-test-8 background PID: 5678' ]]; then
  pass "Claude Lead log lines remain byte-identical to the frozen baseline"
else
  fail "Claude Lead log line byte baseline"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
