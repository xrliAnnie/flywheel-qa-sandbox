#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flywheel-mqb-shell.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

export FLYWHEEL_DIR="$ROOT"
export MQB_ENV_FILE="$TEST_DIR/.env"
export MQB_MARKER_FILE="$TEST_DIR/state/mailbox-queue-deploy-barrier.json"
export MQB_CLI="$ROOT/packages/teamlead/dist/bridge/mailbox-queue-deploy-barrier-cli.js"
export MQB_ACK_PROBE="$ROOT/packages/teamlead/dist/bridge/mailbox-queue-ack-readiness-probe.js"
printf 'OTHER=1\n' > "$MQB_ENV_FILE"

# shellcheck source=../lib/mailbox-queue-deploy-barrier.sh
source "$ROOT/scripts/lib/mailbox-queue-deploy-barrier.sh"

fail() { echo "not ok - $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

[[ -f "$MQB_CLI" ]] || fail "built barrier CLI missing"
mqb_begin "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
[[ "$MQB_OWNED" == "true" && -n "$MQB_TOKEN" ]] \
    || fail "deploy did not acquire durable ownership"
grep -q '^FLYWHEEL_MAILBOX_QUEUE=0$' "$MQB_ENV_FILE" \
    || fail "begin did not persist OFF"
[[ "${FLYWHEEL_MAILBOX_QUEUE:-}" == "0" ]] \
    || fail "begin did not pin child Bridge env OFF"
pass "begin persists OFF and exports it before Bridge launch"

mqb_mark_ready "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "fresh_leads=2;ack_tools=ready"
jq -e '(.phase == "ready") and (.readinessEvidence | contains("ack_tools=ready"))' \
    "$MQB_MARKER_FILE" >/dev/null \
    || fail "ready evidence not durable"
pass "all-ready evidence is durable"

mqb_operator_off "test emergency rollback"
jq -e '.phase == "operator_override"' "$MQB_MARKER_FILE" >/dev/null \
    || fail "operator OFF did not invalidate ownership"
[[ "$(jq -r '.ownershipToken' "$MQB_MARKER_FILE")" != "$MQB_TOKEN" ]] \
    || fail "operator OFF retained deploy ownership token"
pass "OFF-to-OFF operator rollback revokes deployment ownership"

mqb_probe_ack_tools >/dev/null
pass "both production MCP entries advertise their batch ACK tools"

RESTART="$ROOT/scripts/restart-services.sh"
begin_line=$(grep -n 'mqb_begin "\$CURRENT_HEAD"' "$RESTART" | cut -d: -f1)
bridge_line=$(grep -n '^        start_bridge$' "$RESTART" | tail -1 | cut -d: -f1)
lead_line=$(grep -n 'lead_result=$(do_restart_all_leads stagger)' "$RESTART" | tail -1 | cut -d: -f1)
release_line=$(grep -n 'mqb_release_via_bridge "\$CURRENT_HEAD"' "$RESTART" | cut -d: -f1)
deployed_line=$(grep -n 'echo "\$CURRENT_HEAD" > "\$DEPLOYED_SHA_FILE"' "$RESTART" | tail -1 | cut -d: -f1)
[[ "$begin_line" -lt "$bridge_line" && "$bridge_line" -lt "$lead_line" \
    && "$lead_line" -lt "$release_line" && "$release_line" -lt "$deployed_line" ]] \
    || fail "restart ordering does not enforce OFF -> Bridge -> Leads -> release -> deployed-sha"
pass "production deploy order has zero pre-readiness ON window"

echo "All mailbox queue deploy barrier shell tests passed."
